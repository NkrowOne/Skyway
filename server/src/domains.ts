import dns from 'dns';
import net from 'net';
import { parse as parseDomain } from 'tldts';
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
 * IPv6 pública del servidor, si el administrador la ha indicado en Ajustes.
 * No se autodetecta: muchos servidores tienen IPv6 sin que Traefik escuche en
 * ella, y dar por buena una detectada aprobaría un AAAA que no funciona.
 */
export function getServerIpv6(): string | null {
  const v = getSetting('serverIpv6')?.trim().toLowerCase();
  return v && esIpv6Publicable(v) ? v : null;
}

/**
 * IPv6 que puede ir en un registro AAAA. `net.isIPv6` admite también el
 * identificador de zona («fe80::1%eth0»), que solo tiene sentido dentro de la
 * máquina: ningún DNS lo publica y la URL que la canoniza no lo acepta.
 */
export function esIpv6Publicable(v: string): boolean {
  return net.isIPv6(v) && !v.includes('%');
}

/** Misma dirección IPv6 escrita de dos formas («2001:db8::1» y «2001:0db8:0:0::1»). */
export function mismaIpv6(a: string, b: string): boolean {
  if (!esIpv6Publicable(a) || !esIpv6Publicable(b)) return false;
  // La URL deja la dirección en su forma canónica (minúsculas, ceros comprimidos).
  const canonica = (ip: string) => new URL(`http://[${ip}]`).hostname;
  try {
    return canonica(a) === canonica(b);
  } catch {
    // Una forma que la URL no entiende no es la dirección del servidor; sin
    // esto, la comprobación del dominio respondía 500.
    return false;
  }
}

/**
 * Resolutor propio con plazo corto: el de Node espera hasta 5 s por intento y
 * reintenta cuatro veces, así que un DNS que no contesta tenía la comprobación
 * (y su plaza en el limitador) colgada cerca de medio minuto.
 */
const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });

/** «No existe» frente a «no se pudo consultar»: solo lo primero es una respuesta. */
function sinRegistros(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'ENOTFOUND' || code === 'ENODATA';
}

/**
 * Zona DNS del dominio y nombre del registro dentro de ella, según la lista
 * de sufijos públicos: www.panaderia.com.es → zona panaderia.com.es, nombre
 * «www» (no com.es, como daba tomar las dos últimas etiquetas). Con un sufijo
 * privado (github.io, duckdns.org…) la zona es la del usuario dentro del
 * proveedor. null si no se puede saber (una IP, un sufijo desconocido).
 */
export function zonaDns(domain: string): { zone: string; name: string } | null {
  const d = domain.trim().toLowerCase().replace(/\.$/, '');
  const p = parseDomain(d, { allowPrivateDomains: true });
  if (p.isIp || !p.domain || !p.publicSuffix) return null;
  return { zone: p.domain, name: p.subdomain ? p.subdomain : '@' };
}

export interface DomainCheck {
  domain: string;
  /**
   * `caa`: el dominio apunta aquí, pero un registro CAA no autoriza a Let's
   * Encrypt y el certificado no se puede emitir.
   */
  status: 'ok' | 'wrong_ip' | 'no_record' | 'caa' | 'unknown';
  resolvedIps: string[];
  /** AAAA publicados (IPv6). */
  resolvedIpv6: string[];
  expectedIp: string | null;
  /** Zona en la que hay que crear el registro y su nombre dentro de ella («@» para el propio dominio). */
  zone: string | null;
  name: string | null;
  /** Con `caa`: qué nombre publica el CAA que lo impide y a quién autoriza. */
  caa: CaaBloqueo | null;
  message: string;
}

/**
 * AAAA del dominio, o null si no se pudo consultar (eso no debe convertir un
 * dominio correcto en uno con error).
 */
async function consultarAaaa(domain: string): Promise<string[] | null> {
  try {
    return await resolver.resolve6(domain);
  } catch (err) {
    return sinRegistros(err) ? [] : null;
  }
}

/** Lo que dice el CAA que se aplica a un nombre: quién lo publica y si autoriza a Let's Encrypt. */
export interface CaaBloqueo {
  /** Nombre que publica el CAA aplicable (el propio o el padre más cercano que tenga). */
  name: string;
  /** Autoridades que autoriza (`issue`), para el mensaje. */
  issuers: string[];
}

/**
 * ¿Impide un CAA que Let's Encrypt emita el certificado del nombre? Se busca
 * el conjunto CAA más cercano subiendo por los padres (RFC 8659 §3): el del
 * propio nombre o, si no tiene, el del primer padre que tenga alguno. Si ese
 * conjunto tiene etiquetas `issue` y ninguna es `letsencrypt.org`, Let's
 * Encrypt no emite; sin `issue` (solo `iodef` o `issuewild`) no hay
 * restricción para un nombre sin comodín. Un CAA que no se pudo consultar no
 * se da por bloqueo: devuelve null, igual que sin CAA.
 */
export async function caaQueImpide(domain: string): Promise<CaaBloqueo | null> {
  const etiquetas = domain.trim().toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  // Sin bajar al TLD: ningún registro de un TLD restringe a sus dominios en la práctica.
  for (let i = 0; i < etiquetas.length - 1; i++) {
    const nombre = etiquetas.slice(i).join('.');
    let registros: Awaited<ReturnType<typeof resolver.resolveCaa>>;
    try {
      registros = await resolver.resolveCaa(nombre);
    } catch (err) {
      if (sinRegistros(err)) continue;
      return null;
    }
    if (registros.length === 0) continue;
    const issue = registros
      .map((r) => (typeof r.issue === 'string' ? r.issue : null))
      .filter((v): v is string => v !== null)
      .map((v) => v.split(';')[0].trim().toLowerCase());
    if (issue.length === 0 || issue.includes('letsencrypt.org')) return null;
    return { name: nombre, issuers: issue.map((v) => v || '(ninguna)') };
  }
  return null;
}

/** Comprueba si un dominio ya apunta a este servidor, con diagnóstico legible. */
export async function checkDomain(domain: string): Promise<DomainCheck> {
  const { ip: expectedIp } = await getServerIp();
  const ipv6 = getServerIpv6();
  const zona = zonaDns(domain);
  const base = { domain, expectedIp, zone: zona?.zone ?? null, name: zona?.name ?? null, caa: null };

  let resolvedIps: string[] = [];
  const aaaa = consultarAaaa(domain);
  try {
    resolvedIps = await resolver.resolve4(domain);
  } catch (err: any) {
    const resolvedIpv6 = (await aaaa) ?? [];
    if (sinRegistros(err)) {
      return {
        ...base,
        status: 'no_record',
        resolvedIps: [],
        resolvedIpv6,
        message:
          'Aún no existe registro DNS para este dominio (o no se ha propagado). Crea el registro en tu proveedor de DNS y vuelve a comprobarlo: la propagación tarda de minutos a unas horas.',
      };
    }
    return {
      ...base,
      status: 'unknown',
      resolvedIps: [],
      resolvedIpv6,
      message: `No se pudo consultar el DNS (${err?.code || err?.message}). Vuelve a intentarlo en unos instantes.`,
    };
  }
  const resolvedIpv6 = (await aaaa) ?? [];

  if (!expectedIp) {
    return {
      ...base,
      status: 'unknown',
      resolvedIps,
      resolvedIpv6,
      message: `El dominio resuelve a ${resolvedIps.join(', ')}. No se pudo determinar la IP de este servidor: configúrala en Ajustes → Dominios para verificarla automáticamente.`,
    };
  }

  if (!resolvedIps.includes(expectedIp)) {
    return {
      ...base,
      status: 'wrong_ip',
      resolvedIps,
      resolvedIpv6,
      message: `El dominio apunta a ${resolvedIps.join(', ')} y este servidor es ${expectedIp}. Si utilizas Cloudflare u otro proxy intermedio, puede ser normal (comprueba que el proxy apunta a este servidor). En caso contrario, corrige el registro A.`,
    };
  }

  // Un A de más (el del hosting anterior, que un importador de zona no
  // sustituye): el tráfico se reparte entre los dos y Let's Encrypt falla a ratos.
  const otrasIpv4 = resolvedIps.filter((v4) => v4 !== expectedIp);
  if (otrasIpv4.length > 0) {
    return {
      ...base,
      status: 'wrong_ip',
      resolvedIps,
      resolvedIpv6,
      message:
        `El dominio apunta a este servidor (${expectedIp}) y también a ${otrasIpv4.join(', ')}: el tráfico se reparte entre los dos. ` +
        'Elimina el registro A que no es de este servidor.',
    };
  }

  // Un AAAA que no es de este servidor (el del hosting anterior, olvidado al
  // cambiar el A): los visitantes con IPv6 siguen llegando allí y Let's
  // Encrypt, que prueba antes por IPv6, valida contra él y no emite.
  const ajenas = resolvedIpv6.filter((v6) => !ipv6 || !mismaIpv6(v6, ipv6));
  if (ajenas.length > 0) {
    return {
      ...base,
      status: 'wrong_ip',
      resolvedIps,
      resolvedIpv6,
      message:
        `El registro A apunta a este servidor, pero el dominio tiene también una dirección IPv6 (${ajenas.join(', ')}) que no es de este servidor: ` +
        'elimina ese registro AAAA o los visitantes con IPv6 y Let\'s Encrypt seguirán llegando allí.' +
        (ipv6 ? '' : ' Si es la IPv6 de este servidor, indícala en Ajustes → Dominios.'),
    };
  }

  // El CAA solo importa si hay que emitir certificado.
  const caa = getSetting('letsencryptEmail') ? await caaQueImpide(domain) : null;
  if (caa) {
    return {
      ...base,
      caa,
      status: 'caa',
      resolvedIps,
      resolvedIpv6,
      message:
        `El dominio apunta a este servidor, pero el registro CAA de ${caa.name} solo autoriza a ${caa.issuers.join(', ')} y Let's Encrypt no podrá emitir el certificado. ` +
        `Añade en ${caa.name} el registro CAA 0 issue "letsencrypt.org".`,
    };
  }

  return {
    ...base,
    status: 'ok',
    resolvedIps,
    resolvedIpv6,
    message: 'El dominio apunta a este servidor. El tráfico entrará por Traefik y, con Let\'s Encrypt configurado, el certificado se emite automáticamente en la primera visita.',
  };
}

/** Destinos MX de un dominio y si se pudo consultar. */
export interface ConsultaMx {
  /** Destinos en minúsculas y sin punto final; vacío si no tiene MX (o solo el MX nulo de RFC 7505). */
  hosts: string[];
  /** false si el DNS no respondió: entonces `hosts` no dice nada. */
  ok: boolean;
}

/** MX publicados de un dominio (para saber, antes de darlo de alta, dónde recibe hoy el correo). */
export async function consultarMx(domain: string): Promise<ConsultaMx> {
  try {
    const mx = await resolver.resolveMx(domain);
    const hosts = mx
      .sort((a, b) => a.priority - b.priority)
      .map((m) => m.exchange.trim().toLowerCase().replace(/\.$/, ''))
      .filter((h) => h && h !== '.');
    return { hosts: [...new Set(hosts)], ok: true };
  } catch (err) {
    return sinRegistros(err) ? { hosts: [], ok: true } : { hosts: [], ok: false };
  }
}
