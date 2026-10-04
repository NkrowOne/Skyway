/**
 * ¿Hay TLS automático de verdad?
 *
 * El correo de Let's Encrypt que se escribe en Ajustes → Dominios solo decide
 * las etiquetas que Skyway pone a los contenedores (router HTTPS y redirección
 * 301 a https). El correo con el que Traefik se registra en Let's Encrypt es
 * OTRO: lo recibe Traefik al arrancar (`LETSENCRYPT_EMAIL` del `.env`, ver
 * docker-compose.yml). Con el `.env` vacío Traefik se quedaba con un correo de
 * `example.com`, que Let's Encrypt rechaza al registrar la cuenta: no se emitía
 * ningún certificado y aun así cada dominio redirigía a HTTPS con el
 * certificado por defecto de Traefik, mientras el panel y el informe de
 * seguridad decían que TLS estaba activo.
 *
 * Aquí se lee el correo REAL de Traefik (`docker inspect` de su contenedor, el
 * mismo método que usa el instalador de Mailway) y TLS deja de contar como
 * activo solo si ese correo es de un dominio que Let's Encrypt rechaza. Un
 * correo VACÍO no bloquea: Traefik (lego) registra entonces la cuenta sin
 * contacto, que Let's Encrypt acepta, y los certificados se emiten igual. Si no
 * se puede saber (Traefik con otro nombre, configurado por fichero, Docker sin
 * responder), se confía en el ajuste, como antes.
 */
import { getSetting } from './db';
import { dockerQuery } from './docker/client';

/** Contenedor de Traefik del docker-compose de Skyway. */
const TRAEFIK_CONTAINER = process.env.SKYWAY_TRAEFIK_CONTAINER || 'skyway-traefik';
/** El resolutor de certificados que usan las etiquetas (`tls.certresolver=le`). */
const RESOLVER = 'le';
/** Cada cuánto se vuelve a mirar: el correo solo cambia al recrear Traefik. */
const TTL_MS = 60_000;

export type TraefikAcmeStatus = 'ok' | 'missing' | 'invalid' | 'unknown';

export interface TraefikAcmeState {
  /**
   * ok: correo válido · missing: vacío (la cuenta se registra sin contacto y los
   * certificados se emiten igual) · invalid: de un dominio que Let's Encrypt
   * rechaza (no hay certificados) · unknown: no se ha podido leer.
   */
  status: TraefikAcmeStatus;
  /** Correo que tiene Traefik (null si no se ha podido leer o está vacío). */
  email: string | null;
  checkedAt: number | null;
}

let state: TraefikAcmeState = { status: 'unknown', email: null, checkedAt: null };
let inflight: Promise<TraefikAcmeState> | null = null;

/**
 * Dominios de correo que Let's Encrypt no acepta como contacto: los de ejemplo
 * (RFC 2606) y los dominios de nivel superior reservados. Es la lista que
 * aplica su servidor (Boulder) al registrar la cuenta.
 */
const FORBIDDEN_MAIL_DOMAIN = /(^|\.)(example\.(com|net|org)|example|invalid|localhost|test|local)$/i;

/** Estado del correo a partir de su valor (función pura, para las pruebas). */
export function classifyAcmeEmail(email: string | null): TraefikAcmeStatus {
  const value = (email ?? '').trim();
  if (!value) return 'missing';
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return 'invalid';
  return FORBIDDEN_MAIL_DOMAIN.test(value.slice(at + 1)) ? 'invalid' : 'ok';
}

/**
 * Correo del resolutor en la línea de órdenes o en el entorno de Traefik;
 * undefined si no aparece (configuración por fichero, otro nombre de resolutor). Las
 * opciones de Traefik no distinguen mayúsculas, así que tampoco se distinguen aquí.
 */
export function acmeEmailFromTraefik(args: readonly string[], env: readonly string[]): string | undefined {
  const flag = `--certificatesresolvers.${RESOLVER}.acme.email`;
  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === flag) return ''; // sin valor: Traefik lo toma vacío
    if (lower.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  const envName = `TRAEFIK_CERTIFICATESRESOLVERS_${RESOLVER.toUpperCase()}_ACME_EMAIL`;
  for (const entry of env) {
    const eq = entry.indexOf('=');
    if (eq > 0 && entry.slice(0, eq).toUpperCase() === envName) return entry.slice(eq + 1);
  }
  return undefined;
}

/** Vuelve a leer el correo de Traefik (como mucho una lectura a la vez). Nunca lanza. */
export function refreshTraefikAcme(opts: { force?: boolean } = {}): Promise<TraefikAcmeState> {
  if (!opts.force && state.checkedAt !== null && Date.now() - state.checkedAt < TTL_MS) return Promise.resolve(state);
  if (inflight) return inflight;
  inflight = (async () => {
    let next: TraefikAcmeState;
    try {
      const info = await dockerQuery.getContainer(TRAEFIK_CONTAINER).inspect();
      const args = [...((info.Config?.Cmd as string[] | null) ?? []), ...((info.Args as string[] | null) ?? [])];
      const email = acmeEmailFromTraefik(args, (info.Config?.Env as string[] | null) ?? []);
      next =
        email === undefined
          ? { status: 'unknown', email: null, checkedAt: Date.now() }
          : { status: classifyAcmeEmail(email), email: email.trim() || null, checkedAt: Date.now() };
    } catch {
      // Sin Docker o sin ese contenedor: no se sabe, y se confía en el ajuste.
      next = { status: 'unknown', email: null, checkedAt: Date.now() };
    }
    state = next;
    return next;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Último estado conocido del correo de Traefik (lo refresca en segundo plano si caducó). */
export function traefikAcmeState(): TraefikAcmeState {
  if (state.checkedAt === null || Date.now() - state.checkedAt >= TTL_MS) void refreshTraefikAcme();
  return state;
}

/**
 * Traefik tiene un correo que Let's Encrypt rechaza: aunque el ajuste esté
 * puesto, no se emitirán certificados. Sin correo NO cuenta: Let's Encrypt
 * acepta cuentas sin contacto, y quitar el HTTPS de todas las webs por eso
 * dejaba en HTTP plano lo que sí tenía certificado.
 */
export function tlsBlocked(): boolean {
  if (!getSetting('letsencryptEmail')) return false;
  return traefikAcmeState().status === 'invalid';
}

/**
 * TLS automático efectivo: el ajuste del panel Y un correo válido en Traefik.
 * Decide las etiquetas HTTPS y la redirección a https, el esquema de las URL
 * públicas que se inyectan y lo que cuentan el panel y el informe de seguridad.
 */
export function tlsEnabled(): boolean {
  return !!getSetting('letsencryptEmail') && !tlsBlocked();
}

/** Solo para las pruebas: fija el estado sin preguntar a Docker. */
export function setTraefikAcmeStateForTests(next: TraefikAcmeState | null): void {
  state = next ?? { status: 'unknown', email: null, checkedAt: null };
}
