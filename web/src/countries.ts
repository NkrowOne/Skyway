/**
 * Países del destinatario de la factura, en ISO 3166-1 alfa-2. Espejo de
 * `server/src/countries.ts`: el panel solo necesita la lista para el selector y
 * el nombre para mostrarlo; el servidor es quien valida y normaliza lo que llega.
 */
export const DEFAULT_COUNTRY = 'ES';

export const COUNTRY_NAMES: Record<string, string> = {
  ES: 'España',
  DE: 'Alemania', AT: 'Austria', BE: 'Bélgica', BG: 'Bulgaria', CY: 'Chipre',
  HR: 'Croacia', DK: 'Dinamarca', SK: 'Eslovaquia', SI: 'Eslovenia', EE: 'Estonia',
  FI: 'Finlandia', FR: 'Francia', GR: 'Grecia', HU: 'Hungría', IE: 'Irlanda',
  IT: 'Italia', LV: 'Letonia', LT: 'Lituania', LU: 'Luxemburgo', MT: 'Malta',
  NL: 'Países Bajos', PL: 'Polonia', PT: 'Portugal', CZ: 'Chequia', RO: 'Rumanía',
  SE: 'Suecia',
  GB: 'Reino Unido', CH: 'Suiza', NO: 'Noruega', AD: 'Andorra', US: 'Estados Unidos',
  CA: 'Canadá', MX: 'México', AR: 'Argentina', CL: 'Chile', CO: 'Colombia',
  BR: 'Brasil', MA: 'Marruecos',
};

/** España primero (el caso normal); el resto por nombre. */
export const COUNTRY_OPTIONS: { code: string; name: string }[] = [
  { code: DEFAULT_COUNTRY, name: COUNTRY_NAMES[DEFAULT_COUNTRY] },
  ...Object.entries(COUNTRY_NAMES)
    .filter(([code]) => code !== DEFAULT_COUNTRY)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es')),
];

export function countryName(code: string | null | undefined): string {
  if (!code) return COUNTRY_NAMES[DEFAULT_COUNTRY];
  const iso = code.trim().toUpperCase();
  return COUNTRY_NAMES[iso] ?? iso;
}
