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
