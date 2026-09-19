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
  status: 'ok' | 'wrong_ip' | 'no_record' | 'unknown';
  resolvedIps: string[];
  expectedIp: string | null;
  message: string;
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
          'Aún no existe registro DNS para este dominio (o no ha propagado). Crea el registro en tu proveedor y vuelve a comprobar: la propagación tarda de minutos a unas horas.',
      };
    }
    return {
      domain,
      status: 'unknown',
      resolvedIps: [],
      expectedIp,
      message: `No se pudo consultar el DNS (${err?.code || err?.message}). Reintenta en un momento.`,
    };
  }

  if (!expectedIp) {
    return {
      domain,
      status: 'unknown',
      resolvedIps,
      expectedIp,
      message: `El dominio resuelve a ${resolvedIps.join(', ')}. No se pudo determinar la IP de este servidor: configúrala en Ajustes → Dominios para verificar automáticamente.`,
    };
  }

  if (resolvedIps.includes(expectedIp)) {
    return {
      domain,
      status: 'ok',
      resolvedIps,
      expectedIp,
      message: 'El dominio apunta a este servidor. El tráfico entrará por Traefik y, con Let\'s Encrypt configurado, el certificado se emite solo en la primera visita.',
    };
  }

  return {
    domain,
    status: 'wrong_ip',
    resolvedIps,
    expectedIp,
    message: `El dominio apunta a ${resolvedIps.join(', ')} y este servidor es ${expectedIp}. Si usas Cloudflare u otro proxy delante, puede ser normal (comprueba que el proxy apunte a este servidor). Si no, corrige el registro A.`,
  };
}
