import dns from 'dns';
import net from 'net';
import { parse as parseDomain } from 'tldts';
import { getSetting } from './db';
import { tlsEnabled } from './tls';

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
   * `cloudflare_proxy`: resuelve a direcciones del proxy de Cloudflare (nube
   * naranja) y no se ha podido comprobar a dónde entrega el tráfico (la zona
   * no está en el token de Cloudflare o quien pregunta no es administrador).
   * No es un error: con el proxy, desde fuera solo se ven las IP de
   * Cloudflare. `cloudflare_flexible`: pasa por el proxy y apunta a este
   * servidor, pero Cloudflare entra en un bucle de redirecciones porque el
   * modo SSL/TLS de la zona es «Flexible». `caa`: el dominio apunta aquí,
   * pero un registro CAA no autoriza a Let's Encrypt y el certificado no se
   * puede emitir.
   */
  status: 'ok' | 'wrong_ip' | 'cloudflare_proxy' | 'cloudflare_flexible' | 'no_record' | 'caa' | 'unknown';
  resolvedIps: string[];
  /** AAAA publicados (IPv6). Solo los rellena `checkDomain`. */
  resolvedIpv6?: string[];
  expectedIp: string | null;
  /** Zona en la que hay que crear el registro y su nombre dentro de ella («@» para el propio dominio). */
  zone?: string | null;
  name?: string | null;
  /** Con `caa`: qué nombre publica el CAA que lo impide y a quién autoriza. */
  caa?: CaaBloqueo | null;
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

/**
 * Rangos IPv6 publicados por Cloudflare (https://www.cloudflare.com/ips-v6).
 * La comprobación del DNS solo mira IPv4; estos, junto a los IPv4, son los
 * que Traefik considera de Cloudflare en el 443 para respetar su
 * X-Forwarded-For (docker-compose.yml; una prueba comprueba que coinciden).
 */
export const CLOUDFLARE_IPV6 = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
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

/** Lo que, además del A, mira `clasificarDns` cuando el A ya es el del servidor. */
export interface ExtrasDns {
  /** AAAA publicados del dominio (vacío si no tiene o no se pudieron consultar). */
  resolvedIpv6?: string[];
  /** IPv6 del servidor indicada en Ajustes (`getServerIpv6`), o null. */
  serverIpv6?: string | null;
}

/**
 * Diagnóstico de un dominio a partir de lo que resuelve, sin red: separado de
 * `checkDomain` para poder probar cada caso sin un resolutor de verdad.
 *
 * Con el A del servidor, todavía no está bien si hay otro A además del suyo
 * (el del hosting anterior, que un importador de zona añade y no sustituye:
 * el tráfico se reparte) o un AAAA que no es la IPv6 del servidor (los
 * visitantes con IPv6 siguen llegando al sitio anterior y Let's Encrypt, que
 * prueba antes por IPv6, valida contra él y no emite). Con el proxy de
 * Cloudflare el AAAA es de Cloudflare, así que solo se mira sin él.
 */
export function clasificarDns(domain: string, resolvedIps: string[], expectedIp: string | null, extras: ExtrasDns = {}): DomainCheck {
  const resolvedIpv6 = extras.resolvedIpv6;
  const conV6 = resolvedIpv6 ? { resolvedIpv6 } : {};
  if (expectedIp && resolvedIps.includes(expectedIp)) {
    const otrasIpv4 = resolvedIps.filter((v4) => v4 !== expectedIp);
    if (otrasIpv4.length > 0) {
      return {
        domain,
        status: 'wrong_ip',
        resolvedIps,
        ...conV6,
        expectedIp,
        message: `El dominio apunta a este servidor (${expectedIp}) y también a ${otrasIpv4.join(', ')}: el tráfico se reparte entre los dos; elimina el registro A que no es de este servidor.`,
      };
    }
    const ipv6 = extras.serverIpv6 ?? null;
    const ajenas = (resolvedIpv6 ?? []).filter((v6) => !ipv6 || !mismaIpv6(v6, ipv6));
    if (ajenas.length > 0) {
      return {
        domain,
        status: 'wrong_ip',
        resolvedIps,
        ...conV6,
        expectedIp,
        message:
          `El registro A apunta a este servidor, pero el dominio tiene también una dirección IPv6 (${ajenas.join(', ')}) que no es de este servidor: ` +
          'elimina ese registro AAAA o los visitantes con IPv6 y Let\'s Encrypt seguirán llegando allí' +
          (ipv6 ? '.' : ' (si es la IPv6 de este servidor, indícala en Ajustes → Dominios).'),
      };
    }
    return {
      domain,
      status: 'ok',
      resolvedIps,
      ...conV6,
      expectedIp,
      message: 'El dominio apunta a este servidor.',
    };
  }

  // Antes que la IP esperada: que el registro pasa por Cloudflare se sabe
  // aunque no se conozca la IP de este servidor, y el mensaje genérico de
  // «apunta a otra IP» llevaba a corregir un registro que quizá está bien.
  if (resolvedIps.length > 0 && resolvedIps.every(esIpDeCloudflare)) {
    return { domain, status: 'cloudflare_proxy', resolvedIps, ...conV6, expectedIp, message: MENSAJE_PROXY_CLOUDFLARE };
  }

  if (!expectedIp) {
    return {
      domain,
      status: 'unknown',
      resolvedIps,
      ...conV6,
      expectedIp,
      message: `No se conoce la IP de este servidor para compararla con ${resolvedIps.join(', ')}: configúrala en Ajustes → Dominios.`,
    };
  }

  return {
    domain,
    status: 'wrong_ip',
    resolvedIps,
    ...conV6,
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
  if (tlsEnabled() && (await sondear(base.domain).catch(() => false))) {
    return { ...base, status: 'cloudflare_flexible', viaCloudflare: true, message: MENSAJE_FLEXIBLE };
  }
  return { ...base, status: 'ok', viaCloudflare: true, message: MENSAJE_PROXY_AQUI };
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

/**
 * Comprueba si un dominio ya apunta a este servidor, con diagnóstico legible.
 * Con `opts.verificar` (administrador), un nombre con el proxy de Cloudflare
 * se comprueba además con su API (`completarConCloudflare`). Con el dominio
 * ya correcto y Let's Encrypt configurado, mira también el CAA: si no
 * autoriza a Let's Encrypt, el certificado no se puede emitir.
 */
export async function checkDomain(domain: string, opts: OpcionesComprobacion = {}): Promise<DomainCheck> {
  const { ip: expectedIp } = await getServerIp();
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
        message: 'El dominio aún no tiene un registro DNS.',
      };
    }
    return {
      ...base,
      status: 'unknown',
      resolvedIps: [],
      resolvedIpv6,
      message: `No se ha podido consultar el DNS (${err?.code || err?.message}).`,
    };
  }
  const resolvedIpv6 = (await aaaa) ?? [];

  const check = await completarConCloudflare(
    { ...base, ...clasificarDns(domain, resolvedIps, expectedIp, { resolvedIpv6, serverIpv6: getServerIpv6() }) },
    opts,
  );
  // El CAA solo importa si hay que emitir certificado.
  if (check.status !== 'ok' || !tlsEnabled()) return check;
  const caa = await caaQueImpide(domain);
  if (!caa) return check;
  return {
    ...check,
    caa,
    status: 'caa',
    message:
      `El dominio apunta a este servidor, pero el registro CAA de ${caa.name} solo autoriza a ${caa.issuers.join(', ')} y Let's Encrypt no podrá emitir el certificado: ` +
      `añade en ${caa.name} el registro CAA 0 issue "letsencrypt.org".`,
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
