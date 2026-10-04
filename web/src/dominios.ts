/**
 * Dominios tal como los escribe una persona y como los guarda el servidor.
 *
 * El servidor guarda los dominios en ASCII (punycode: «panadería.es» es
 * «xn--panadera-i2a.es»), que es lo que entienden Traefik y el DNS. Aquí se
 * hace la misma normalización antes de añadirlos (sin esquema, ruta ni
 * puerto: se pega a menudo la URL de la web) y la inversa para enseñarlos
 * como se escriben.
 */

/** Nombre de host (RFC 1123) en minúsculas: la misma regla que el servidor. */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Forma ASCII de lo escrito («https://Panadería.es/tienda» →
 * «xn--panadera-i2a.es»), o '' si no es un dominio con al menos un punto.
 */
export function normalizarDominio(raw: string): string {
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
