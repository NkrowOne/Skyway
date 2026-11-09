/**
 * Certificado comodín del dominio raíz (opcional).
 *
 * Cada nombre de un servicio pedía su propio certificado a Let's Encrypt por
 * HTTP-01 (resolutor `le`), y el límite es de 50 certificados nuevos por
 * dominio registrado cada 7 días: pasar decenas de servicios a un dominio raíz
 * nuevo lo agotaba, y cada servicio nuevo esperaba a su certificado para tener
 * HTTPS. Con el resolutor `lecomodin` (reto DNS-01 de Cloudflare, ver
 * docker-compose.yml), Skyway publica en su proveedor HTTP un router que pide
 * UN certificado para `rootDomain` y `*.rootDomain`, y los subdominios
 * generados (`esSubdominioGenerado`: un nivel bajo el dominio raíz, salvo www)
 * se sirven con él: en `traefikLabels` van en su propio router, con TLS y sin
 * resolutor, así que no piden uno por nombre. Los dominios propios siguen con
 * `le`.
 *
 * Cómo lo hace Traefik 3.7 (comprobado en su código: la documentación solo dice
 * que el certificado se elige en el saludo TLS y que «cada dominio genera una
 * petición»):
 *  - El certificado de cada conexión se elige por SNI entre todos los del
 *    almacén `default`, vengan del resolutor que vengan, sin mirar el router
 *    (`GetBestCertificate`). Entre los que encajan gana el primero en orden
 *    lexicográfico inverso de sus nombres, así que uno emitido para el nombre
 *    (`tienda.raiz`) va antes que el comodín (`*.raiz,raiz`). El comodín cubre
 *    un solo nivel.
 *  - Un router con `certResolver` no pide certificado para un nombre que ya
 *    cubre otro del almacén, comodín incluido (`getUncheckedDomains`), aunque
 *    haya caducado. Pero solo si ese certificado ya está cargado cuando Traefik
 *    lee el router: mientras se emite el comodín (el reto DNS-01 tarda un par de
 *    minutos) o justo tras reiniciar Traefik, un router con `le` pediría uno
 *    por nombre. Por eso los generados van sin resolutor y no con `le`.
 *
 * Disponible si Traefik tiene el resolutor con reto DNS y el token de
 * Cloudflare en su entorno: Skyway lo lee de su contenedor (`docker inspect`,
 * como el correo de Let's Encrypt en tls.ts) o, si no se puede, lo declara el
 * operador con `SKYWAY_TRAEFIK_WILDCARD=1`. Sin token todo sigue como siempre.
 */
import crypto from 'crypto';
import { getSetting } from './db';
import { esSubdominioGenerado, normalizarDominio } from './dominioprincipal';
import type { TraefikRouterSkyway } from './redirecciones';
import { leerTraefik, tlsEnabled } from './tls';

/** Nombre del resolutor en el Traefik del docker-compose.yml. */
export const RESOLUTOR_COMODIN = 'lecomodin';
/** Ajuste del panel: '1' si el administrador lo ha activado. */
export const AJUSTE_COMODIN = 'wildcardCert';
/**
 * Variables en las que lego (el cliente ACME de Traefik) busca el token de API
 * de Cloudflare, también con el sufijo `_FILE`. La clave global
 * (`CF_API_KEY` + `CF_API_EMAIL`) no cuenta a propósito: da acceso a toda la
 * cuenta, y para esto basta un token limitado a la zona del dominio raíz.
 */
const VARIABLES_TOKEN = ['CF_DNS_API_TOKEN', 'CLOUDFLARE_DNS_API_TOKEN'];
/** Cada cuánto se vuelve a mirar: el resolutor y el token solo cambian al recrear Traefik. */
const TTL_MS = 60_000;
/**
 * Ruta de la regla del router que pide el certificado. El router solo existe
 * para eso (Traefik toma los nombres de `tls.domains`, no de la regla), así que
 * su regla no debe atender peticiones reales: con `Host(raíz)` a secas, la raíz
 * respondería 418 (`noop@internal`) en vez del 404 de siempre, y contaría como
 * nombre propio de Skyway frente a las rutas de Mailway (`mezclarConfiguracion`).
 */
const RUTA_COMODIN = '/.well-known/skyway-comodin';
/** Nombre de host completo en minúsculas: va dentro de una regla de Traefik. */
const HOST_RE = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Lo que se ve en el contenedor de Traefik: `ok` (resolutor con reto DNS y, con
 * Cloudflare, token), `sin_token` (resolutor de Cloudflare sin token) o
 * `sin_resolutor`.
 */
export type ResolutorComodin = 'ok' | 'sin_token' | 'sin_resolutor';

export interface EstadoComodin {
  /** `desconocido` si no se ha podido leer el contenedor de Traefik. */
  resolutor: ResolutorComodin | 'desconocido';
  checkedAt: number | null;
}

let estado: EstadoComodin = { resolutor: 'desconocido', checkedAt: null };
let enCurso: Promise<EstadoComodin> | null = null;

/**
 * El resolutor del comodín según la línea de órdenes y el entorno de Traefik
 * (función pura, para las pruebas). Las opciones de Traefik no distinguen
 * mayúsculas, como en `acmeEmailFromTraefik`; los nombres de las variables del
 * token, sí (lego solo lee esos). Del token solo se mira si tiene valor: nunca
 * se guarda, se registra ni se devuelve.
 */
export function resolutorComodinDesdeTraefik(args: readonly string[], env: readonly string[]): ResolutorComodin {
  const flag = `--certificatesresolvers.${RESOLUTOR_COMODIN}.acme.dnschallenge.provider`;
  let proveedor: string | undefined;
  for (const arg of args) {
    if (arg.toLowerCase().startsWith(`${flag}=`)) proveedor = arg.slice(flag.length + 1).trim().toLowerCase();
  }
  const variables = new Map<string, string>();
  for (const entry of env) {
    const eq = entry.indexOf('=');
    if (eq > 0) variables.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  if (proveedor === undefined) {
    const nombre = `TRAEFIK_CERTIFICATESRESOLVERS_${RESOLUTOR_COMODIN.toUpperCase()}_ACME_DNSCHALLENGE_PROVIDER`;
    for (const [clave, valor] of variables) if (clave.toUpperCase() === nombre) proveedor = valor.trim().toLowerCase();
  }
  if (!proveedor) return 'sin_resolutor';
  // Con otro proveedor de DNS no se sabe qué variables lee: se confía en quien lo configuró.
  if (proveedor !== 'cloudflare') return 'ok';
  const conValor = (nombre: string) => (variables.get(nombre) ?? '').trim() !== '';
  return VARIABLES_TOKEN.some((v) => conValor(v) || conValor(`${v}_FILE`)) ? 'ok' : 'sin_token';
}

/** Vuelve a mirar el contenedor de Traefik (como mucho una lectura a la vez). Nunca lanza. */
export function refreshTraefikComodin(opts: { force?: boolean } = {}): Promise<EstadoComodin> {
  if (!opts.force && estado.checkedAt !== null && Date.now() - estado.checkedAt < TTL_MS) return Promise.resolve(estado);
  if (enCurso) return enCurso;
  enCurso = (async () => {
    const traefik = await leerTraefik();
    const next: EstadoComodin = {
      resolutor: traefik ? resolutorComodinDesdeTraefik(traefik.args, traefik.env) : 'desconocido',
      checkedAt: Date.now(),
    };
    estado = next;
    return next;
  })().finally(() => {
    enCurso = null;
  });
  return enCurso;
}

/** Último estado conocido (lo refresca en segundo plano si caducó). */
export function estadoComodin(): EstadoComodin {
  if (estado.checkedAt === null || Date.now() - estado.checkedAt >= TTL_MS) void refreshTraefikComodin();
  return estado;
}

/** `SKYWAY_TRAEFIK_WILDCARD=1`: el operador declara que su Traefik tiene el resolutor y el token. */
export function comodinDeclarado(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.SKYWAY_TRAEFIK_WILDCARD ?? '').trim());
}

/**
 * ¿Se puede activar? Lo dice el contenedor de Traefik; la declaración solo
 * cuenta cuando no se le puede preguntar (Traefik configurado por fichero o en
 * otro contenedor): lo que se ve en él manda sobre lo que se declara.
 */
export function comodinDisponible(e: EstadoComodin = estadoComodin()): boolean {
  return e.resolutor === 'ok' || (e.resolutor === 'desconocido' && comodinDeclarado());
}

/** El dominio raíz de los ajustes si es un nombre válido, normalizado; si no, null. */
function dominioRaiz(): string | null {
  const raiz = normalizarDominio(getSetting('rootDomain') ?? '');
  return HOST_RE.test(raiz) ? raiz : null;
}

/**
 * Dominio raíz cuyo comodín está en uso, o null. Exige el ajuste, HTTPS
 * efectivo (sin él no hay routers seguros que servir) y un dominio raíz. Si
 * Traefik dice que no tiene el resolutor o el token, tampoco: el router del
 * comodín solo dejaría errores en su registro, y los subdominios generados,
 * sin resolutor, se quedarían con el certificado por defecto (con `le`, cada
 * uno tiene el suyo). Si no se le puede preguntar, se confía en el ajuste, como
 * con el correo de Let's Encrypt (tls.ts): solo se pudo activar estando
 * disponible.
 */
export function dominioComodin(): string | null {
  if (getSetting(AJUSTE_COMODIN) !== '1' || !tlsEnabled()) return null;
  const { resolutor } = estadoComodin();
  if (resolutor === 'sin_resolutor' || resolutor === 'sin_token') return null;
  return dominioRaiz();
}

/**
 * ¿Se sirve este nombre con el comodín? Los subdominios generados del dominio
 * raíz en uso: un solo nivel por debajo, salvo `www.<raíz>`, que es un dominio
 * propio del operador (`esSubdominioGenerado`). La raíz y lo que cuelga a más
 * de un nivel siguen con `le`.
 */
export function cubiertoPorComodin(host: string, raiz: string | null = dominioComodin()): boolean {
  return !!raiz && esSubdominioGenerado(host, raiz);
}

/**
 * Router del proveedor HTTP que pide el certificado de `rootDomain` y
 * `*.rootDomain` al resolutor `lecomodin` (`tls.domains`). Lleva la huella de
 * sus nombres, como los routers de los servicios, y prioridad 1 con una regla
 * que no atiende peticiones reales (`RUTA_COMODIN`). `{}` si no está en uso.
 */
export function configuracionTraefikComodin(): { http?: { routers: Record<string, TraefikRouterSkyway> } } {
  const raiz = dominioComodin();
  if (!raiz) return {};
  const comodin = `*.${raiz}`;
  const huella = crypto.createHash('sha256').update([raiz, comodin].sort().join(',')).digest('hex').slice(0, 8);
  return {
    http: {
      routers: {
        [`skyway-comodin-${huella}`]: {
          rule: `Host(\`${raiz}\`) && Path(\`${RUTA_COMODIN}\`)`,
          entryPoints: ['websecure'],
          priority: 1,
          service: 'noop@internal',
          tls: { certResolver: RESOLUTOR_COMODIN, domains: [{ main: raiz, sans: [comodin] }] },
        },
      },
    },
  };
}

/** Lo que necesita Ajustes para ofrecer la casilla y explicar su estado. */
export interface VistaComodin {
  /** Nombre del resolutor en Traefik (`lecomodin`). */
  resolver: string;
  resolutor: EstadoComodin['resolutor'];
  /** `SKYWAY_TRAEFIK_WILDCARD=1`. */
  declarado: boolean;
  /** Se puede activar (`comodinDisponible`). */
  disponible: boolean;
  /** Dominio raíz cuyo comodín se usa ahora mismo, o null. */
  enUso: string | null;
}

export function vistaComodin(e: EstadoComodin = estadoComodin()): VistaComodin {
  return {
    resolver: RESOLUTOR_COMODIN,
    resolutor: e.resolutor,
    declarado: comodinDeclarado(),
    disponible: comodinDisponible(e),
    enUso: dominioComodin(),
  };
}

/** Por qué no se puede activar, en una frase con lo que hay que hacer. */
export function motivoComodinNoDisponible(e: EstadoComodin): string {
  if (e.resolutor === 'sin_token') {
    return `Traefik tiene el resolutor «${RESOLUTOR_COMODIN}», pero no el token de Cloudflare. Define CF_DNS_API_TOKEN en el .env del servidor y ejecuta docker compose up -d traefik.`;
  }
  if (e.resolutor === 'sin_resolutor') {
    return `Traefik no tiene el resolutor «${RESOLUTOR_COMODIN}» (reto DNS-01 de Cloudflare). Actualiza Skyway con skyway update para obtener el docker-compose.yml actual, define CF_DNS_API_TOKEN en el .env del servidor y ejecuta docker compose up -d traefik.`;
  }
  return `No se ha podido comprobar si Traefik tiene el resolutor «${RESOLUTOR_COMODIN}». Si Traefik no está en el contenedor skyway-traefik, indica su nombre en SKYWAY_TRAEFIK_CONTAINER o declara el resolutor con SKYWAY_TRAEFIK_WILDCARD=1.`;
}

/** Solo para las pruebas: fija el estado sin preguntar a Docker. */
export function setEstadoComodinForTests(next: EstadoComodin | null): void {
  estado = next ?? { resolutor: 'desconocido', checkedAt: null };
}
