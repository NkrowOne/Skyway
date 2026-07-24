/**
 * Países del destinatario de la factura, en código ISO 3166-1 alfa-2.
 *
 * Se guarda el CÓDIGO, no el nombre: es estable, cabe en dos caracteres y es lo
 * que pedirá cualquier declaración informativa el día que haga falta. El nombre
 * solo se usa para pintarlo (panel y PDF). La lista cubre la UE —donde el país
 * decide el régimen de IVA— más los destinos habituales de un negocio español;
 * cualquier otro código ISO válido se acepta igualmente y se muestra tal cual.
 */
export const DEFAULT_COUNTRY = 'ES';

export const COUNTRY_NAMES: Record<string, string> = {
  ES: 'España',
  // Unión Europea (resto): el país determina el régimen de IVA aplicable.
  DE: 'Alemania', AT: 'Austria', BE: 'Bélgica', BG: 'Bulgaria', CY: 'Chipre',
  HR: 'Croacia', DK: 'Dinamarca', SK: 'Eslovaquia', SI: 'Eslovenia', EE: 'Estonia',
  FI: 'Finlandia', FR: 'Francia', GR: 'Grecia', HU: 'Hungría', IE: 'Irlanda',
  IT: 'Italia', LV: 'Letonia', LT: 'Lituania', LU: 'Luxemburgo', MT: 'Malta',
  NL: 'Países Bajos', PL: 'Polonia', PT: 'Portugal', CZ: 'Chequia', RO: 'Rumanía',
  SE: 'Suecia',
  // Fuera de la UE, destinos habituales.
  GB: 'Reino Unido', CH: 'Suiza', NO: 'Noruega', AD: 'Andorra', US: 'Estados Unidos',
  CA: 'Canadá', MX: 'México', AR: 'Argentina', CL: 'Chile', CO: 'Colombia',
  BR: 'Brasil', MA: 'Marruecos',
};

/** Nombre del país para mostrar; si el código no está en la lista, el propio código. */
export function countryName(code: string | null | undefined): string {
  if (!code) return COUNTRY_NAMES[DEFAULT_COUNTRY];
  const iso = code.trim().toUpperCase();
  return COUNTRY_NAMES[iso] ?? iso;
}

/** Normaliza a un código alfa-2 en mayúsculas; vacío o inválido = España. */
export function normalizeCountry(code: string | null | undefined): string {
  const iso = (code ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(iso) ? iso : DEFAULT_COUNTRY;
}
