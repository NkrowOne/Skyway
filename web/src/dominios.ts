/**
 * Reglas puras de los dominios de un servicio, para el editor de dominios y
 * las tarjetas: qué dominio es el principal, la pareja con o sin www que se
 * añade con cada dominio propio y cada cuánto se vuelve a comprobar el DNS.
 *
 * El orden y la pareja son copia de `server/src/dominioprincipal.ts` (el
 * servidor guarda la lista así, completa las parejas y calcula PUBLIC_URL con
 * la misma regla): si cambia allí, cambia aquí. `test/dominios.test.ts`
 * compara las dos copias.
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
 * correcto, o false si ya no se repite. `transcurridoMs` es el tiempo desde
 * que se empezó a comprobar y `dominios` cuántos se comprueban a la vez en el
 * editor: con varios, el intervalo se alarga para que entre todos no pasen de
 * `CUPO_AUTOMATICO` peticiones por minuto y el servidor no responda 429.
 */
export function intervaloComprobacion(estado: string | undefined, transcurridoMs: number, dominios: number): number | false {
  if (estado === 'ok') return false;
  if (transcurridoMs >= LIMITE_MS) return false;
  const base = transcurridoMs < FASE_RAPIDA_MS ? RAPIDO_MS : LENTO_MS;
  const minimoPorCupo = Math.ceil((Math.max(1, dominios) * 60_000) / CUPO_AUTOMATICO);
  return Math.max(base, minimoPorCupo);
}
