import dns from 'dns';
import { getSetting } from './db';

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Cuánto vale una detección: la IP pública de un servidor no cambia a menudo. */
const DETECTED_TTL_MS = 3600_000;
/**
 * Cuánto se recuerda que NO se pudo detectar. Sin esto, cada comprobación de
 * dominio de un servidor sin salida a esos proveedores pagaba dos peticiones
 * de 5 s de espera antes de responder.
 */
const FAILED_TTL_MS = 60_000;

let detectedIp: { ip: string | null; ts: number } | null = null;
/** Detección en vuelo: N comprobaciones a la vez comparten UNA salida a internet. */
let detecting: Promise<string | null> | null = null;

async function detectPublicIp(): Promise<string | null> {
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip']) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const ip = (await res.text()).trim();
      if (IPV4_RE.test(ip)) return ip;
    } catch {
      /* siguiente proveedor */
    }
  }
  return null;
}

/**
 * IP pública del servidor: la configurada en Ajustes tiene prioridad;
 * si no, se autodetecta (cacheada 1 h; un fallo, 1 min).
 */
export async function getServerIp(): Promise<{ ip: string | null; source: 'configurada' | 'detectada' | null }> {
  const configured = getSetting('serverIp');
  if (configured && IPV4_RE.test(configured)) {
    return { ip: configured, source: 'configurada' };
  }
  if (detectedIp && Date.now() - detectedIp.ts < (detectedIp.ip ? DETECTED_TTL_MS : FAILED_TTL_MS)) {
    return detectedIp.ip ? { ip: detectedIp.ip, source: 'detectada' } : { ip: null, source: null };
  }
  if (!detecting) {
    detecting = detectPublicIp()
      .then((ip) => {
        detectedIp = { ip, ts: Date.now() };
        return ip;
      })
      .finally(() => {
        detecting = null;
      });
  }
  const ip = await detecting;
  return ip ? { ip, source: 'detectada' } : { ip: null, source: null };
}

/**
 * Resolutor propio con plazo corto: el de Node espera hasta 5 s por intento y
 * reintenta cuatro veces, así que un DNS que no contesta tenía la comprobación
 * (y su plaza en el limitador) colgada cerca de medio minuto.
 */
const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });

export interface DomainCheck {
  domain: string;
  /**
   * `cloudflare_proxy`: resuelve a direcciones del proxy de Cloudflare (nube
   * naranja) y no se ha podido comprobar a dónde entrega el tráfico (la zona
   * no está en el token de Cloudflare o quien pregunta no es administrador).
   * No es un error: con el proxy, desde fuera solo se ven las IP de
   * Cloudflare. `cloudflare_flexible`: pasa por el proxy y apunta a este
   * servidor, pero Cloudflare entra en un bucle de redirecciones porque el
   * modo SSL/TLS de la zona es «Flexible».
   */
  status: 'ok' | 'wrong_ip' | 'cloudflare_proxy' | 'cloudflare_flexible' | 'no_record' | 'unknown';
  resolvedIps: string[];
  expectedIp: string | null;
  message: string;
  /** Comprobado con la API de Cloudflare: apunta a este servidor con el proxy activo. */
  viaCloudflare?: boolean;
}

/**
 * Lo que dice la API de Cloudflare de un nombre (`verificarEnCloudflare`): sus
 * registros llevan a este servidor (con el proxy o sin él), llevan a otro
 * sitio (`detalle`, legible) o no se puede saber (null).
 */
export type VerificacionCloudflare = { estado: 'aqui'; proxied: boolean } | { estado: 'otro'; detalle: string } | null;

export interface OpcionesComprobacion {
  /**
   * Comprueba con la API de Cloudflare a dónde lleva un nombre y si tiene el
   * proxy. Lo pasa la ruta solo para el administrador: usa el token del
   * operador.
   */
  verificar?: (domain: string) => Promise<VerificacionCloudflare>;
  /** Detecta el bucle del modo «Flexible» (por defecto, `bucleFlexible`; las pruebas lo sustituyen). */
  sondear?: (domain: string) => Promise<boolean>;
}

/**
 * Rangos IPv4 publicados por Cloudflare para su proxy
 * (https://www.cloudflare.com/ips-v4). Lista fija a propósito: consultarla en
 * cada comprobación añadiría una salida a internet y un punto de fallo, y
 * cambia muy de tarde en tarde.
 */
export const CLOUDFLARE_IPV4 = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
] as const;

/** Una IPv4 como entero sin signo, o null si no es una IPv4 válida. */
function ipv4ANumero(ip: string): number | null {
  if (!IPV4_RE.test(ip)) return null;
  const partes = ip.split('.').map(Number);
  if (partes.some((p) => p > 255)) return null;
  return ((partes[0] << 24) | (partes[1] << 16) | (partes[2] << 8) | partes[3]) >>> 0;
}

/** ¿Está la IPv4 dentro del bloque CIDR (`a.b.c.d/n`)? */
export function ipEnCidr(ip: string, cidr: string): boolean {
  const [red, bitsTexto] = cidr.split('/');
  const bits = Number(bitsTexto);
  const n = ipv4ANumero(ip.trim());
  const base = ipv4ANumero(red);
  if (n === null || base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  // `<< 32` no desplaza nada en JavaScript: el /0 se trata aparte.
  const mascara = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((n & mascara) >>> 0) === ((base & mascara) >>> 0);
}

/** ¿Es una dirección del proxy de Cloudflare? */
export function esIpDeCloudflare(ip: string): boolean {
  return CLOUDFLARE_IPV4.some((cidr) => ipEnCidr(ip, cidr));
}

/*
 * Una frase por estado: el panel ya muestra la etiqueta y el registro que hay
 * que crear, y los detalles del modo SSL/TLS los explica aparte (y la FAQ).
 * El proxy de Cloudflare es la forma recomendada de servir una web: con él,
 * lo único que no se puede hacer desde fuera es ver a dónde lleva.
 */
const MENSAJE_PROXY_CLOUDFLARE =
  'El registro pasa por el proxy de Cloudflare: desde aquí no se puede comprobar a dónde lleva el tráfico. Si la web abre, está bien configurado.';
const MENSAJE_PROXY_AQUI = 'El dominio apunta a este servidor a través del proxy de Cloudflare.';
const MENSAJE_PROXY_RECIEN_ACTIVADO =
  'El dominio apunta a este servidor con el proxy de Cloudflare activado; desde fuera puede tardar unos minutos en verse.';
const MENSAJE_PROXY_RECIEN_QUITADO =
  'El dominio apunta a este servidor sin el proxy de Cloudflare; desde fuera puede tardar unos minutos en verse.';
const MENSAJE_FLEXIBLE =
  'Cloudflare entra en un bucle de redirecciones porque el modo SSL/TLS de la zona es «Flexible». Cámbialo a «Completo (estricto)» en Cloudflare → SSL/TLS.';

/**
 * Diagnóstico de un dominio a partir de lo que resuelve, sin red: separado de
 * `checkDomain` para poder probar cada caso sin un resolutor de verdad.
 */
export function clasificarDns(domain: string, resolvedIps: string[], expectedIp: string | null): DomainCheck {
  if (expectedIp && resolvedIps.includes(expectedIp)) {
    return {
      domain,
      status: 'ok',
      resolvedIps,
      expectedIp,
      message: 'El dominio apunta a este servidor.',
    };
  }

  // Antes que la IP esperada: que el registro pasa por Cloudflare se sabe
  // aunque no se conozca la IP de este servidor, y el mensaje genérico de
  // «apunta a otra IP» llevaba a corregir un registro que quizá está bien.
  if (resolvedIps.length > 0 && resolvedIps.every(esIpDeCloudflare)) {
    return { domain, status: 'cloudflare_proxy', resolvedIps, expectedIp, message: MENSAJE_PROXY_CLOUDFLARE };
  }

  if (!expectedIp) {
    return {
      domain,
      status: 'unknown',
      resolvedIps,
      expectedIp,
      message: `No se conoce la IP de este servidor para compararla con ${resolvedIps.join(', ')}: configúrala en Ajustes → Dominios.`,
    };
  }

  return {
    domain,
    status: 'wrong_ip',
    resolvedIps,
    expectedIp,
    message: `El dominio apunta a ${resolvedIps.join(', ')} en lugar de ${expectedIp}.`,
  };
}

/**
 * ¿Entra Cloudflare en un bucle con este dominio? Con el modo SSL/TLS
 * «Flexible», Cloudflare pide la web a este servidor por HTTP y Traefik la
 * redirige a HTTPS, así que el navegador vuelve a pedir la misma dirección sin
 * fin. Se pide la portada por HTTPS (a través de Cloudflare) sin seguir
 * redirecciones: el bucle es una redirección a esa misma dirección. Cualquier
 * otra respuesta (también un error, un desafío contra bots o un certificado
 * que aún se está emitiendo) no lo es.
 */
export async function bucleFlexible(domain: string): Promise<boolean> {
  const url = `https://${domain}/`;
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(6000),
      headers: { 'user-agent': 'Skyway (comprobación del dominio)' },
    });
    await res.body?.cancel().catch(() => undefined);
    if (![301, 302, 303, 307, 308].includes(res.status)) return false;
    const location = res.headers.get('location');
    if (!location) return false;
    const destino = new URL(location, url);
    return (
      destino.protocol === 'https:' &&
      destino.hostname === domain &&
      (destino.port === '' || destino.port === '443') &&
      destino.pathname === '/' &&
      destino.search === ''
    );
  } catch {
    return false;
  }
}

/**
 * Completa la comprobación con lo que dice la API de Cloudflare (solo si
 * quien pregunta puede usarla: `verificar`). Es la que manda sobre el proxy:
 * el DNS público tarda unos minutos en reflejar que se ha activado o quitado,
 * y de ella depende qué botón se ofrece.
 * - Resuelve a este servidor: si el registro ya tiene el proxy (recién
 *   activado), se indica (`viaCloudflare`).
 * - Resuelve al proxy de Cloudflare: si lleva a este servidor, está bien,
 *   salvo que Cloudflare entre en el bucle del modo «Flexible» (solo con
 *   HTTPS: sin él, este servidor no redirige); si el registro ya no tiene el
 *   proxy (recién quitado), también está bien; si lleva a otro sitio, es una
 *   IP equivocada.
 * Si no se puede saber, se queda como estaba.
 */
export async function completarConCloudflare(base: DomainCheck, opts: OpcionesComprobacion = {}): Promise<DomainCheck> {
  if (!opts.verificar || !base.expectedIp) return base;
  if (base.status !== 'cloudflare_proxy' && base.status !== 'ok') return base;
  const verificacion = await opts.verificar(base.domain).catch(() => null);
  if (base.status === 'ok') {
    return verificacion?.estado === 'aqui' && verificacion.proxied
      ? { ...base, viaCloudflare: true, message: MENSAJE_PROXY_RECIEN_ACTIVADO }
      : base;
  }
  if (!verificacion) return base;
  if (verificacion.estado === 'otro') {
    return {
      ...base,
      status: 'wrong_ip',
      message: `En Cloudflare, ${base.domain} tiene ${verificacion.detalle} en lugar de un registro A hacia ${base.expectedIp}.`,
    };
  }
  if (!verificacion.proxied) return { ...base, status: 'ok', message: MENSAJE_PROXY_RECIEN_QUITADO };
  const sondear = opts.sondear ?? bucleFlexible;
  if (getSetting('letsencryptEmail') && (await sondear(base.domain).catch(() => false))) {
    return { ...base, status: 'cloudflare_flexible', viaCloudflare: true, message: MENSAJE_FLEXIBLE };
  }
  return { ...base, status: 'ok', viaCloudflare: true, message: MENSAJE_PROXY_AQUI };
}

/**
 * Comprueba si un dominio ya apunta a este servidor, con diagnóstico legible.
 * Con `opts.verificar` (administrador), un nombre con el proxy de Cloudflare
 * se comprueba además con su API (`completarConCloudflare`).
 */
export async function checkDomain(domain: string, opts: OpcionesComprobacion = {}): Promise<DomainCheck> {
  const { ip: expectedIp } = await getServerIp();

  let resolvedIps: string[] = [];
  try {
    resolvedIps = await resolver.resolve4(domain);
  } catch (err: any) {
    if (err?.code === 'ENOTFOUND' || err?.code === 'ENODATA') {
      return {
        domain,
        status: 'no_record',
        resolvedIps: [],
        expectedIp,
        message: 'El dominio aún no tiene un registro DNS.',
      };
    }
    return {
      domain,
      status: 'unknown',
      resolvedIps: [],
      expectedIp,
      message: `No se ha podido consultar el DNS (${err?.code || err?.message}).`,
    };
  }

  return completarConCloudflare(clasificarDns(domain, resolvedIps, expectedIp), opts);
}
