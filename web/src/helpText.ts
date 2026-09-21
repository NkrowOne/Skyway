/*
 * Texto del asistente y búsqueda de la FAQ: funciones puras, sin DOM, para que
 * se puedan probar con vitest en Node y la página solo tenga que pintarlas.
 */

/** Tramo de una línea: texto plano o **negrita**. */
export interface RichSpan {
  text: string;
  bold: boolean;
}

/** Bloque de la respuesta: un párrafo (sus líneas) o una lista con viñetas. */
export type RichBlock = { kind: 'p'; lines: RichSpan[][] } | { kind: 'ul'; items: RichSpan[][] };

/** Parte una línea por `**…**` en tramos normales y en negrita. */
export function parseInline(line: string): RichSpan[] {
  const out: RichSpan[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const m of line.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ text: line.slice(last, idx), bold: false });
    out.push({ text: m[1], bold: true });
    last = idx + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last), bold: false });
  return out;
}

/**
 * El asistente responde en un Markdown mínimo: párrafos separados por una
 * línea en blanco, listas con «- » y negritas con `**`. Nada más: no se
 * interpreta HTML y cualquier otra cosa se pinta tal cual.
 */
export function parseRichText(text: string): RichBlock[] {
  const blocks: RichBlock[] = [];
  for (const raw of text.split(/\n{2,}/)) {
    const lines = raw
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;
    // Una lista puede venir pegada a su frase introductoria («Esto puede
    // ayudarte:\n- …»): el encabezado sale como párrafo y las viñetas como lista.
    let i = 0;
    while (i < lines.length) {
      if (/^\s*- /.test(lines[i])) {
        const items: RichSpan[][] = [];
        while (i < lines.length && /^\s*- /.test(lines[i])) {
          items.push(parseInline(lines[i].replace(/^\s*- /, '')));
          i += 1;
        }
        blocks.push({ kind: 'ul', items });
      } else {
        const para: RichSpan[][] = [];
        while (i < lines.length && !/^\s*- /.test(lines[i])) {
          para.push(parseInline(lines[i].trim()));
          i += 1;
        }
        blocks.push({ kind: 'p', lines: para });
      }
    }
  }
  return blocks;
}

/** Minúsculas y sin acentos: «Dominios» y «dominio» casan con «dómino». */
export function normalizeSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** ¿Casa la búsqueda con alguno de los textos? Cada palabra debe aparecer en alguno. */
export function matchesSearch(query: string, ...fields: (string | string[] | undefined)[]): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  const haystack = normalizeSearch(
    fields
      .flatMap((f) => (Array.isArray(f) ? f : f ? [f] : []))
      .join(' '),
  );
  return q.split(/\s+/).every((word) => haystack.includes(word));
}

/** Valor enmascarado para la vista previa: la longitud se insinúa, el contenido no. */
export function maskValue(value: string): string {
  if (!value) return '';
  return '•'.repeat(Math.min(Math.max(value.length, 4), 14));
}
