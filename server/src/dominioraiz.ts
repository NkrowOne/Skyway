/**
 * Dominio raíz de los subdominios que la plataforma genera para los servicios
 * (`<slug>.<dominio raíz>`) y dominios raíz anteriores.
 *
 * Cambiar el dominio raíz en Ajustes no mueve ningún servicio: los que tienen
 * un subdominio del anterior (`web.apps.midominio.com`) lo conservan, y sigue
 * funcionando mientras su registro comodín apunte aquí. Antes, ese nombre
 * dejaba de contar como generado en cuanto cambiaba el ajuste: en un servicio
 * que también tiene un dominio propio podía pasar a ser el dominio principal
 * (PUBLIC_URL, canónicas, enlaces absolutos) en el siguiente despliegue, justo
 * durante el traslado. Por eso el raíz que se sustituye pasa a la lista de
 * anteriores y sus subdominios se siguen tratando como generados
 * (`dominioprincipal.ts`) hasta que se mueven con «Cambiar de dominio»
 * (`domainmigration.ts` ofrece el raíz anterior como dominio actual) y la
 * administración lo quita de la lista.
 */
import { getSetting, listServiceDomains, setSetting } from './db';
import { normalizarDominio } from './dominioprincipal';

/** Clave de Ajustes: los dominios raíz anteriores, del más reciente al más antiguo, en JSON. */
export const SETTING_RAICES_ANTERIORES = 'rootDomainAnteriores';

/**
 * Tope de la lista. Cada cambio del dominio raíz añade uno; si está llena, el
 * cambio se rechaza en vez de olvidar el más antiguo, que cambiaría en
 * silencio la dirección pública de los servicios que aún lo usan.
 */
export const MAX_RAICES_ANTERIORES = 10;

/** Nombre de host (RFC 1123) en minúsculas: la misma regla que `domainSchema`. */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** ¿Es `host` el dominio `raiz` o un subdominio suyo? */
function cuelgaDe(host: string, raiz: string): boolean {
  return host === raiz || host.endsWith(`.${raiz}`);
}

/** El dominio raíz actual, normalizado, o null si no hay. */
export function dominioRaiz(): string | null {
  return normalizarDominio(getSetting('rootDomain') ?? '') || null;
}

/**
 * Los dominios raíz anteriores, del más reciente al más antiguo: normalizados,
 * sin repetidos, sin el actual y solo nombres válidos (lo que no se pueda leer
 * se descarta, y la siguiente escritura lo limpia).
 */
export function raicesAnteriores(): string[] {
  let guardada: unknown = null;
  try {
    guardada = JSON.parse(getSetting(SETTING_RAICES_ANTERIORES) ?? 'null');
  } catch {
    guardada = null;
  }
  if (!Array.isArray(guardada)) return [];
  const actual = dominioRaiz();
  const out: string[] = [];
  for (const raw of guardada) {
    const d = typeof raw === 'string' ? normalizarDominio(raw) : '';
    if (d && HOSTNAME.test(d) && d !== actual && !out.includes(d)) out.push(d);
  }
  return out.slice(0, MAX_RAICES_ANTERIORES);
}

/**
 * Los dominios raíz cuyos subdominios de un nivel cuentan como generados: el
 * actual y los anteriores. Es lo que se pasa a la regla del dominio principal
 * y de la pareja con o sin www (`dominioprincipal.ts`).
 */
export function raicesGeneradas(): string[] {
  const actual = dominioRaiz();
  return actual ? [actual, ...raicesAnteriores()] : raicesAnteriores();
}

/**
 * La lista de anteriores tras cambiar el dominio raíz de `anterior` a `nuevo`,
 * sin guardar nada: el que se sustituye entra el primero (si no estaba vacío)
 * y el nuevo sale si estaba, de modo que volver a un dominio raíz anterior lo
 * quita de la lista. Puede pasar de `MAX_RAICES_ANTERIORES`: lo decide quien
 * guarda.
 */
export function anterioresTrasCambio(anterior: string | null, nuevo: string | null): string[] {
  const viejo = normalizarDominio(anterior ?? '');
  const siguiente = normalizarDominio(nuevo ?? '');
  const lista = raicesAnteriores().filter((d) => d !== viejo && d !== siguiente);
  if (viejo && viejo !== siguiente && HOSTNAME.test(viejo)) lista.unshift(viejo);
  return lista;
}

/** Guarda la lista normalizada, sin repetidos ni nombres no válidos y con el tope; vacía, borra el ajuste. */
export function guardarRaicesAnteriores(lista: readonly string[]): void {
  const limpia = [...new Set(lista.map(normalizarDominio))].filter((d) => HOSTNAME.test(d)).slice(0, MAX_RAICES_ANTERIORES);
  setSetting(SETTING_RAICES_ANTERIORES, limpia.length > 0 ? JSON.stringify(limpia) : null);
}

/** Quita un dominio raíz anterior de la lista. false si no estaba. */
export function quitarRaizAnterior(dominio: string): boolean {
  const d = normalizarDominio(dominio);
  const lista = raicesAnteriores();
  if (!lista.includes(d)) return false;
  guardarRaicesAnteriores(lista.filter((x) => x !== d));
  return true;
}

/**
 * Cada dominio raíz anterior con el número de servicios que aún tienen algún
 * nombre que cuelga de él (también uno que se sigue sirviendo sin redirigir
 * tras «Cambiar de dominio»). Con 0, quitarlo de la lista ya no cambia el
 * dominio principal de ningún servicio.
 */
export function usoRaicesAnteriores(): { domain: string; services: number }[] {
  const anteriores = raicesAnteriores();
  if (anteriores.length === 0) return [];
  const servicios = listServiceDomains();
  return anteriores.map((raiz) => ({
    domain: raiz,
    services: servicios.filter((s) => s.domains.some((d) => cuelgaDe(normalizarDominio(d), raiz))).length,
  }));
}
