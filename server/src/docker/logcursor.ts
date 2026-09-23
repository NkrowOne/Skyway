/**
 * Cursores de log: el sello RFC3339 que Docker antepone a cada línea con
 * `timestamps: true`. Sirve de identidad de la línea (deduplicar) y de punto
 * de corte para paginar hacia atrás. Aquí vive solo lo puro, sin Docker, para
 * poder probarlo.
 */

export interface CursorLine {
  cursor: string | null;
  line: string;
}

const RFC3339 = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Sello normalizado a nueve decimales. Docker escribe los sellos con
 * `RFC3339Nano`, que RECORTA los ceros finales: «…00.5Z» y «…00.123Z» se
 * comparan bien como texto, pero «…00.1Z» frente a «…00.1000001Z» no (la «Z»
 * ordena después del «0» y el sello más antiguo pasaba por más nuevo). Con la
 * fracción rellena, la comparación de texto vuelve a ser la cronológica.
 */
export function normalizeCursor(cursor: string): string {
  const m = RFC3339.exec(cursor);
  if (!m) return cursor;
  return `${m[1]}.${(m[2] ?? '').padEnd(9, '0')}${m[3]}`;
}

/** Orden cronológico de dos cursores: negativo si `a` es anterior a `b`. */
export function compareCursor(a: string, b: string): number {
  const na = normalizeCursor(a);
  const nb = normalizeCursor(b);
  // Misma zona (Docker siempre escribe en UTC, «Z»): el texto ya ordena.
  if (na.endsWith('Z') && nb.endsWith('Z')) return na < nb ? -1 : na > nb ? 1 : 0;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta < tb ? -1 : 1;
  return na < nb ? -1 : na > nb ? 1 : 0;
}

/**
 * Cuántas líneas del principio de `lines` (en orden cronológico) son
 * ESTRICTAMENTE anteriores al cursor dado. Se recorre desde el final porque el
 * solape con el ancla suele ser corto. Una línea sin cursor en la cola cuenta
 * como no anterior (no hay forma de situarla).
 */
export function countStrictlyBefore(lines: readonly CursorLine[], before: string): number {
  let i = lines.length;
  while (i > 0) {
    const c = lines[i - 1].cursor;
    if (c !== null && compareCursor(c, before) < 0) break;
    i--;
  }
  return i;
}
