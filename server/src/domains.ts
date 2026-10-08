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
   * naranja). No es un error: el proxy puede estar entregando el tráfico a
   * este servidor, pero desde fuera no se puede comprobar.
   */
  status: 'ok' | 'wrong_ip' | 'cloudflare_proxy' | 'no_record' | 'unknown';
  resolvedIps: string[];
  expectedIp: string | null;
  message: string;
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

const MENSAJE_PROXY_CLOUDFLARE =
  'El dominio resuelve a direcciones del proxy de Cloudflare (nube naranja): el registro pasa por el proxy y no es posible comprobar directamente si apunta a este servidor. ' +
  'Let\'s Encrypt solo puede validar el certificado a través del proxy (HTTP-01) si el modo SSL/TLS de Cloudflare es «Full (strict)» o «Full» y la opción «Always Use HTTPS» no bloquea la ruta /.well-known/acme-challenge. ' +
  'La opción más sencilla es cambiar el registro a «Solo DNS» (nube gris) en Cloudflare.';

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
      message: 'El dominio apunta a este servidor. El tráfico entrará por Traefik y, con Let\'s Encrypt configurado, el certificado se emite automáticamente en la primera visita.',
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
      message: `El dominio resuelve a ${resolvedIps.join(', ')}. No se pudo determinar la IP de este servidor: configúrala en Ajustes → Dominios para verificarla automáticamente.`,
    };
  }

  return {
    domain,
    status: 'wrong_ip',
    resolvedIps,
    expectedIp,
    message: `El dominio apunta a ${resolvedIps.join(', ')} y este servidor es ${expectedIp}. Si utilizas un proxy intermedio, puede ser normal (comprueba que el proxy apunta a este servidor). En caso contrario, corrige el registro A.`,
  };
}

/** Comprueba si un dominio ya apunta a este servidor, con diagnóstico legible. */
export async function checkDomain(domain: string): Promise<DomainCheck> {
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
        message:
          'Aún no existe registro DNS para este dominio (o no se ha propagado). Crea el registro en tu proveedor de DNS: la comprobación se repite automáticamente y la propagación tarda de minutos a unas horas.',
      };
    }
    return {
      domain,
      status: 'unknown',
      resolvedIps: [],
      expectedIp,
      message: `No se pudo consultar el DNS (${err?.code || err?.message}). Vuelve a intentarlo en unos instantes.`,
    };
  }

  return clasificarDns(domain, resolvedIps, expectedIp);
}
