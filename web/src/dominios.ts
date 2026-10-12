/**
 * Reglas puras de los dominios de un servicio, para el editor de dominios y
 * las tarjetas: qué dominio es el principal, la pareja con o sin www que se
 * añade con cada dominio propio y cada cuánto se vuelve a comprobar el DNS.
 *
 * El orden y la pareja son copia de `server/src/dominioprincipal.ts` (el
 * servidor guarda la lista así, completa las parejas y calcula PUBLIC_URL con
 * la misma regla): si cambia allí, cambia aquí. `test/dominios.test.ts`
 * compara las dos copias.
 *
 * También, cómo se pasa a dominio lo que escribe una persona y cómo se enseña
 * lo que guarda el servidor.
 *
 * El servidor guarda los dominios en ASCII (punycode: «panadería.es» es
 * «xn--panadera-i2a.es»), que es lo que entienden Traefik y el DNS. Aquí se
 * hace la misma normalización antes de añadirlos (sin esquema, ruta ni
 * puerto: se pega a menudo la URL de la web) y la inversa para enseñarlos
 * como se escriben.
 */

/** Forma canónica de un dominio para compararlo. */
export function normalizarDominio(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

/** ¿Es el subdominio que genera la plataforma (`<slug>.<dominio raíz>`)? `www.<raíz>` no cuenta. */
export function esSubdominioGenerado(domain: string, rootDomain: string | null | undefined): boolean {
  const raiz = rootDomain ? normalizarDominio(rootDomain) : '';
  if (!raiz) return false;
  const d = normalizarDominio(domain);
  if (!d.endsWith(`.${raiz}`)) return false;
  const etiqueta = d.slice(0, -raiz.length - 1);
  return etiqueta.length > 0 && !etiqueta.includes('.') && etiqueta !== 'www';
}

/**
 * Orden del dominio principal: primero un dominio propio con www, después el
 * resto de dominios propios en el orden guardado y al final el subdominio
 * generado, salvo que sea el único. Sin repetidos.
 */
export function ordenarDominios(domains: readonly string[], rootDomain?: string | null): string[] {
  const vistos = new Set<string>();
  const www: string[] = [];
  const propios: string[] = [];
  const generados: string[] = [];
  for (const raw of domains) {
    const d = normalizarDominio(raw ?? '');
    if (!d || vistos.has(d)) continue;
    vistos.add(d);
    if (esSubdominioGenerado(d, rootDomain)) generados.push(d);
    else if (d.startsWith('www.')) www.push(d);
    else propios.push(d);
  }
  return [...www, ...propios, ...generados];
}

/** Dominio principal (la dirección pública de la web), o null sin dominios. */
export function dominioPrincipal(domains: readonly string[] | null | undefined, rootDomain?: string | null): string | null {
  return ordenarDominios(domains ?? [], rootDomain)[0] ?? null;
}

/**
 * Sufijos públicos de dos niveles más habituales: en ellos el dominio que se
 * registra tiene tres etiquetas (`tienda.com.es`, `shop.co.uk`). Lista corta a
 * propósito: un sufijo que falte solo hace que no se añada la pareja con www,
 * nunca que se añada una incorrecta en un dominio de dos etiquetas.
 */
const SUFIJOS_DOS_NIVELES = new Set([
  // España
  'com.es', 'org.es', 'nom.es', 'gob.es', 'edu.es',
  // Latinoamérica
  'com.mx', 'org.mx', 'net.mx', 'gob.mx', 'edu.mx',
  'com.ar', 'org.ar', 'net.ar', 'gob.ar',
  'com.co', 'org.co', 'net.co', 'gov.co', 'edu.co',
  'com.pe', 'org.pe', 'net.pe', 'gob.pe',
  'com.br', 'org.br', 'net.br',
  'com.uy', 'com.py', 'com.bo', 'com.ec', 'com.ve', 'com.do', 'com.gt', 'com.sv', 'com.hn', 'com.ni', 'com.pa', 'co.cr',
  // Europa y resto
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'ac.uk', 'gov.uk',
  'com.pt', 'org.pt',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'co.za', 'co.jp', 'co.in', 'co.il', 'com.tr', 'com.cn', 'com.hk', 'com.sg',
]);

/** Dominio registrable (`ejemplo.com`, `ejemplo.com.es`) de un nombre, o null si es un sufijo. */
function dominioRegistrable(domain: string): string | null {
  const partes = domain.split('.');
  if (partes.length < 2) return null;
  const etiquetas = SUFIJOS_DOS_NIVELES.has(partes.slice(-2).join('.')) ? 3 : 2;
  if (partes.length < etiquetas) return null;
  return partes.slice(-etiquetas).join('.');
}

export interface ParejaWww {
  /** Dominio de la lista al que le falta su pareja. */
  domain: string;
  /** La pareja que falta. */
  falta: string;
  /** `www`: falta la versión con www; `raiz`: falta la versión sin www. */
  tipo: 'www' | 'raiz';
}

/**
 * La pareja con o sin www de un dominio propio: `ejemplo.com` ↔
 * `www.ejemplo.com`. Solo para el dominio registrable y su www; un subdominio
 * más profundo (`app.ejemplo.com`) y el subdominio generado no tienen pareja.
 */
export function parejaWww(domain: string, rootDomain?: string | null): { falta: string; tipo: 'www' | 'raiz' } | null {
  const d = normalizarDominio(domain);
  const raiz = rootDomain ? normalizarDominio(rootDomain) : '';
  // Lo que cuelga del dominio raíz de la plataforma lo gestiona el operador.
  if (raiz && (d === raiz || d.endsWith(`.${raiz}`))) return null;
  const registrable = dominioRegistrable(d);
  if (!registrable) return null;
  if (d === registrable) return { falta: `www.${d}`, tipo: 'www' };
  if (d === `www.${registrable}`) return { falta: registrable, tipo: 'raiz' };
  return null;
}

/**
 * La lista con la pareja con o sin www de cada dominio (o solo de `nuevos`),
 * salvo los de `sinPareja`, en el orden del dominio principal. Cada pareja va
 * detrás de su dominio antes de ordenar. Misma regla que el servidor.
 */
export function completarParejasWww(
  domains: readonly string[],
  opts: { rootDomain?: string | null; nuevos?: Iterable<string>; sinPareja?: Iterable<string> } = {},
): { domains: string[]; anadidos: string[] } {
  const lista = [...new Set(domains.map((d) => normalizarDominio(d ?? '')).filter(Boolean))];
  const presentes = new Set(lista);
  const nuevos = opts.nuevos ? new Set([...opts.nuevos].map(normalizarDominio)) : null;
  const sinPareja = new Set([...(opts.sinPareja ?? [])].map(normalizarDominio));
  const anadidos: string[] = [];
  const conParejas: string[] = [];
  for (const d of lista) {
    conParejas.push(d);
    if (nuevos && !nuevos.has(d)) continue;
    if (sinPareja.has(d)) continue;
    const pareja = parejaWww(d, opts.rootDomain);
    if (!pareja || presentes.has(pareja.falta)) continue;
    presentes.add(pareja.falta);
    anadidos.push(pareja.falta);
    conParejas.push(pareja.falta);
  }
  return { domains: ordenarDominios(conParejas, opts.rootDomain), anadidos };
}

/** Renuncias a la pareja que se guardan: solo dominios de la lista a los que les falta. Misma regla que el servidor. */
export function limpiarSinPareja(sinPareja: Iterable<string>, domains: readonly string[], rootDomain?: string | null): string[] {
  const presentes = new Set(domains.map((d) => normalizarDominio(d ?? '')));
  const out: string[] = [];
  for (const raw of sinPareja) {
    const d = normalizarDominio(raw ?? '');
    if (!presentes.has(d) || out.includes(d)) continue;
    const pareja = parejaWww(d, rootDomain);
    if (pareja && !presentes.has(pareja.falta)) out.push(d);
  }
  return out;
}

/** Dominios de la lista a los que les falta su pareja con o sin www, en el orden de la lista. */
export function parejasWwwPendientes(domains: readonly string[], rootDomain?: string | null): ParejaWww[] {
  const presentes = new Set(domains.map(normalizarDominio));
  const out: ParejaWww[] = [];
  for (const domain of domains) {
    const pareja = parejaWww(domain, rootDomain);
    if (pareja && !presentes.has(pareja.falta) && !out.some((p) => p.falta === pareja.falta)) {
      out.push({ domain: normalizarDominio(domain), ...pareja });
    }
  }
  return out;
}

/**
 * Comprobaciones por minuto que puede gastar la repetición automática. El
 * servidor admite 30 por usuario y minuto (`CHECKS_POR_MINUTO` en
 * routes/domains.ts); el resto queda para el botón de comprobar y para otra
 * pestaña abierta con el mismo usuario.
 */
const CUPO_AUTOMATICO = 20;
const RAPIDO_MS = 15_000;
const LENTO_MS = 60_000;
/** Durante cuánto se comprueba cada 15 s tras añadir o abrir el dominio. */
const FASE_RAPIDA_MS = 2 * 60_000;
/** Pasado este tiempo deja de repetirse: queda el botón de comprobar. */
const LIMITE_MS = 30 * 60_000;

/**
 * Cada cuánto se repite la comprobación del DNS de un dominio que aún no está
 * correcto, o false si ya no se repite. No se repite con el DNS correcto
 * (`ok`) ni con un registro con el proxy de Cloudflare que no se puede
 * verificar (`cloudflare_proxy`): esperar no lo cambia. El bucle del modo
 * «Flexible» (`cloudflare_flexible`) sí: se corrige en Cloudflare y la
 * siguiente comprobación ya es correcta.
 *
 * `transcurridoMs` es el tiempo desde que se empezó a comprobar y `dominios`
 * cuántos se comprueban a la vez en el editor: con varios, el intervalo se
 * alarga para que entre todos no pasen de `CUPO_AUTOMATICO` peticiones por
 * minuto y el servidor no responda 429.
 */
export function intervaloComprobacion(estado: string | undefined, transcurridoMs: number, dominios: number): number | false {
  if (estado === 'ok' || estado === 'cloudflare_proxy') return false;
  if (transcurridoMs >= LIMITE_MS) return false;
  const base = transcurridoMs < FASE_RAPIDA_MS ? RAPIDO_MS : LENTO_MS;
  const minimoPorCupo = Math.ceil((Math.max(1, dominios) * 60_000) / CUPO_AUTOMATICO);
  return Math.max(base, minimoPorCupo);
}

/** Nombre de host (RFC 1123) en minúsculas: la misma regla que el servidor. */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Forma ASCII de lo escrito («https://Panadería.es/tienda» →
 * «xn--panadera-i2a.es»), o '' si no es un dominio con al menos un punto.
 */
export function normalizarEntradaDominio(raw: string): string {
  let host = raw.trim();
  if (!host) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    const nombre = host.split(/[/?#]/)[0];
    // Sin esquema, «info@cliente.es» es un correo y «cliente.es\x» no es un
    // dominio: la URL los convertiría en cliente.es en silencio, y el
    // servidor los rechaza.
    if (/[@\\]/.test(nombre)) return '';
    host = `http://${nombre}`;
  }
  let ascii: string;
  try {
    // La URL convierte a punycode y a minúsculas, y quita el puerto.
    ascii = new URL(host).hostname;
  } catch {
    return '';
  }
  ascii = ascii.replace(/\.$/, '');
  return HOSTNAME.test(ascii) && ascii.includes('.') ? ascii : '';
}

/**
 * Nombre de un registro tal como se escribe en el panel DNS de su zona: «@»
 * para la propia zona y la parte relativa para un subdominio («www» en
 * caa.es). Los paneles como IONOS u OVH añaden la zona a lo que se escribe:
 * «caa.es» en la zona caa.es crearía caa.es.caa.es. null si el nombre no está
 * dentro de la zona.
 */
export function nombreEnZona(nombre: string, zona: string): string | null {
  const n = nombre.trim().toLowerCase().replace(/\.$/, '');
  const z = zona.trim().toLowerCase().replace(/\.$/, '');
  if (!n || !z) return null;
  if (n === z) return '@';
  return n.endsWith(`.${z}`) ? n.slice(0, -(z.length + 1)) : null;
}

/* Punycode (RFC 3492): solo la decodificación, para enseñar el dominio. */
const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;

function adaptar(delta: number, puntos: number, primera: boolean): number {
  let d = primera ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / puntos);
  let k = 0;
  while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
    d = Math.floor(d / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW));
}

function digito(c: number): number {
  if (c >= 48 && c <= 57) return c - 22; // 0-9 → 26-35
  if (c >= 65 && c <= 90) return c - 65; // A-Z
  if (c >= 97 && c <= 122) return c - 97; // a-z
  return BASE;
}

/** Una etiqueta punycode (sin «xn--») a Unicode; null si no es válida. */
function decodificarEtiqueta(entrada: string): string | null {
  const salida: number[] = [];
  const separador = entrada.lastIndexOf('-');
  for (let j = 0; j < Math.max(separador, 0); j++) {
    if (entrada.charCodeAt(j) >= 0x80) return null;
    salida.push(entrada.charCodeAt(j));
  }
  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  let i = 0;
  for (let indice = separador > 0 ? separador + 1 : 0; indice < entrada.length; ) {
    const anterior = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (indice >= entrada.length) return null;
      const d = digito(entrada.charCodeAt(indice++));
      if (d >= BASE) return null;
      i += d * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (d < t) break;
      w *= BASE - t;
      if (w > 0x7fffffff) return null;
    }
    const total = salida.length + 1;
    bias = adaptar(i - anterior, total, anterior === 0);
    n += Math.floor(i / total);
    i %= total;
    if (n > 0x10ffff) return null;
    salida.splice(i++, 0, n);
  }
  return String.fromCodePoint(...salida);
}

/**
 * Forma legible de un dominio guardado en ASCII («xn--panadera-i2a.es» →
 * «panadería.es»). Si alguna etiqueta no es punycode válido, devuelve el
 * dominio tal cual.
 */
export function dominioUnicode(ascii: string): string {
  const etiquetas = ascii.split('.');
  const out: string[] = [];
  for (const e of etiquetas) {
    if (!/^xn--/i.test(e)) {
      out.push(e);
      continue;
    }
    const u = decodificarEtiqueta(e.slice(4));
    if (u === null) return ascii;
    out.push(u);
  }
  return out.join('.');
}
