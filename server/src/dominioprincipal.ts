/**
 * Dominio principal de un servicio: el que se publica como su dirección
 * (`PUBLIC_URL`, `PUBLIC_DOMAIN`, `RAILWAY_PUBLIC_DOMAIN`, `self.public_url`
 * del manifiesto) cuando el servicio tiene varios.
 *
 * Antes era el primero de la lista tal como se guardó, y la lista se guarda
 * en el orden en que se añadieron: quien daba de alta `ejemplo.com` y después
 * `www.ejemplo.com` dejaba la URL pública en el dominio sin www, y con ella
 * la URL canónica, las redirecciones y la indexación de la web. La regla:
 *
 *  1. Un dominio propio con `www.`: es la forma que una web pública anuncia.
 *  2. El resto de dominios propios, en el orden en que se guardaron.
 *  3. El subdominio que genera la plataforma (`<slug>.<dominio raíz>`) al
 *     final, salvo que sea el único: es una dirección técnica, no la de la web.
 *
 * Sin dependencias a propósito (ni base de datos ni red): quien la llama pasa
 * el dominio raíz de los ajustes, y así se usa igual al guardar, al desplegar
 * y en las pruebas. La web tiene su copia de la regla en `web/src/dominios.ts`;
 * si cambia aquí, cambia allí.
 */

/** Forma canónica de un dominio para compararlo: sin espacios, en minúsculas y sin el punto final. */
export function normalizarDominio(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * ¿Es el subdominio que genera la plataforma? Un único nivel bajo el dominio
 * raíz, como los que ofrece «Añadir subdominio». `www.<raíz>` no cuenta: es el
 * dominio propio del operador, no uno generado.
 */
export function esSubdominioGenerado(domain: string, rootDomain: string | null | undefined): boolean {
  const raiz = rootDomain ? normalizarDominio(rootDomain) : '';
  if (!raiz) return false;
  const d = normalizarDominio(domain);
  if (!d.endsWith(`.${raiz}`)) return false;
  const etiqueta = d.slice(0, -raiz.length - 1);
  return etiqueta.length > 0 && !etiqueta.includes('.') && etiqueta !== 'www';
}

/**
 * Los dominios en el orden de la regla, normalizados y sin repetidos (gana la
 * primera aparición). El orden relativo dentro de cada grupo se conserva, así
 * que aplicarla dos veces da lo mismo que una.
 */
export function ordenarDominios(domains: readonly string[], rootDomain?: string | null): string[] {
  const vistos = new Set<string>();
  const www: string[] = [];
  const propios: string[] = [];
  const generados: string[] = [];
  for (const raw of domains) {
    const d = normalizarDominio(String(raw ?? ''));
    if (!d || vistos.has(d)) continue;
    vistos.add(d);
    if (esSubdominioGenerado(d, rootDomain)) generados.push(d);
    else if (d.startsWith('www.')) www.push(d);
    else propios.push(d);
  }
  return [...www, ...propios, ...generados];
}

/** El dominio principal según la regla, o null si el servicio no tiene ninguno. */
export function dominioPrincipal(domains: readonly string[] | null | undefined, rootDomain?: string | null): string | null {
  return ordenarDominios(domains ?? [], rootDomain)[0] ?? null;
}

/* --------------------------- Pareja con o sin www --------------------------- */

/*
 * Una web pública responde con y sin www. Si solo se da de alta una de las
 * dos, quien escribe la otra en el navegador recibe un error de DNS o el 404
 * de Traefik. Por eso la pareja no es una sugerencia: al añadir un dominio
 * propio registrable (`ejemplo.com`) o su www, la otra mitad se añade con él,
 * salvo que se haya renunciado a ella de forma explícita (`dominiosSinPareja`
 * en la configuración del servicio).
 */

/**
 * Sufijos públicos de dos niveles más habituales: en ellos el dominio que se
 * registra tiene tres etiquetas (`tienda.com.es`, `shop.co.uk`). Lista corta a
 * propósito: un sufijo que falte solo hace que no se añada la pareja con www,
 * nunca que se añada una incorrecta en un dominio de dos etiquetas. Copia en
 * `web/src/dominios.ts`.
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

/**
 * La pareja con o sin www de un dominio propio: `ejemplo.com` ↔
 * `www.ejemplo.com`. Solo el dominio registrable y su www la tienen; un
 * subdominio más profundo (`app.ejemplo.com`) y lo que cuelga del dominio raíz
 * de la plataforma (el subdominio generado incluido), no.
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
 * Completa la pareja con o sin www de los dominios de una lista, en una sola
 * pasada: la pareja de una pareja es el dominio original, que ya está, así que
 * aplicarla dos veces da lo mismo que una y nunca crece más allá del doble.
 *
 * - `nuevos`: solo se completan estos (los que añade el cambio). Sin indicar,
 *   todos. Así, guardar otra cosa o reordenar no añade nada a un servicio
 *   antiguo al que le falta la pareja: el panel lo indica y se añade con un clic.
 * - `sinPareja`: dominios cuya pareja se ha descartado expresamente.
 * - `disponible`: si la pareja se puede asignar (la usa otro servicio, el
 *   panel, Mailway…). Si no, se omite sin error: el dominio pedido sí se
 *   guarda y el panel indica que falta su pareja.
 *
 * Devuelve la lista en el orden del dominio principal y las parejas añadidas.
 */
export function completarParejasWww(
  domains: readonly string[],
  opts: {
    rootDomain?: string | null;
    nuevos?: Iterable<string>;
    sinPareja?: Iterable<string>;
    disponible?: (domain: string) => boolean;
  } = {},
): { domains: string[]; anadidos: string[] } {
  // En el orden recibido (normalizados y sin repetidos): la regla del
  // dominio principal se aplica al final, con las parejas ya dentro.
  const lista = [...new Set(domains.map((d) => normalizarDominio(String(d ?? ''))).filter(Boolean))];
  const presentes = new Set(lista);
  const nuevos = opts.nuevos ? new Set([...opts.nuevos].map(normalizarDominio)) : null;
  const sinPareja = new Set([...(opts.sinPareja ?? [])].map(normalizarDominio));
  const anadidos: string[] = [];
  // Cada pareja va justo detrás de su dominio: al ordenar, la del primer
  // dominio propio sigue por delante de las de los siguientes.
  const conParejas: string[] = [];
  for (const d of lista) {
    conParejas.push(d);
    if (nuevos && !nuevos.has(d)) continue;
    if (sinPareja.has(d)) continue;
    const pareja = parejaWww(d, opts.rootDomain);
    if (!pareja || presentes.has(pareja.falta)) continue;
    if (opts.disponible && !opts.disponible(pareja.falta)) continue;
    presentes.add(pareja.falta);
    anadidos.push(pareja.falta);
    conParejas.push(pareja.falta);
  }
  return { domains: ordenarDominios(conParejas, opts.rootDomain), anadidos };
}

/**
 * La lista de renuncias a la pareja que se guarda: solo dominios de la lista
 * que tienen pareja y a los que de verdad les falta. Lo demás sobra (un
 * dominio que se ha quitado, o uno cuya pareja ya está), así que la lista
 * nunca es mayor que la de dominios.
 */
export function limpiarSinPareja(sinPareja: Iterable<string>, domains: readonly string[], rootDomain?: string | null): string[] {
  const presentes = new Set(domains.map((d) => normalizarDominio(String(d ?? ''))));
  const out: string[] = [];
  for (const raw of sinPareja) {
    const d = normalizarDominio(String(raw ?? ''));
    if (!presentes.has(d) || out.includes(d)) continue;
    const pareja = parejaWww(d, rootDomain);
    if (pareja && !presentes.has(pareja.falta)) out.push(d);
  }
  return out;
}
