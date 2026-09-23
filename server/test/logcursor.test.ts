import { describe, expect, it } from 'vitest';
import { compareCursor, countStrictlyBefore, normalizeCursor } from '../src/docker/logcursor';

describe('cursores de log (sello RFC3339Nano de Docker)', () => {
  it('normaliza la fracción a nueve cifras', () => {
    expect(normalizeCursor('2026-09-20T10:00:00Z')).toBe('2026-09-20T10:00:00.000000000Z');
    expect(normalizeCursor('2026-09-20T10:00:00.1Z')).toBe('2026-09-20T10:00:00.100000000Z');
    expect(normalizeCursor('2026-09-20T10:00:00.123456789Z')).toBe('2026-09-20T10:00:00.123456789Z');
    // Lo que no es un sello se deja como está.
    expect(normalizeCursor('hola')).toBe('hola');
  });

  it('ordena cronológicamente aunque Docker recorte los ceros finales', () => {
    // Como texto crudo, «.1Z» quedaba DESPUÉS de «.1000001Z» (la Z va detrás del 0).
    expect(compareCursor('2026-09-20T10:00:00.1Z', '2026-09-20T10:00:00.1000001Z')).toBeLessThan(0);
    expect(compareCursor('2026-09-20T10:00:00.5Z', '2026-09-20T10:00:00.123Z')).toBeGreaterThan(0);
    expect(compareCursor('2026-09-20T10:00:00.5Z', '2026-09-20T10:00:00.500Z')).toBe(0);
    expect(compareCursor('2026-09-20T09:59:59.999999999Z', '2026-09-20T10:00:00Z')).toBeLessThan(0);
  });

  it('cuenta solo las líneas estrictamente anteriores al ancla', () => {
    const lines = [
      { cursor: '2026-09-20T10:00:00.1Z', line: 'a' },
      { cursor: '2026-09-20T10:00:00.2Z', line: 'b' },
      { cursor: '2026-09-20T10:00:00.3Z', line: 'c' }, // el ancla
      { cursor: '2026-09-20T10:00:00.4Z', line: 'd' }, // mismo segundo, posterior
    ];
    expect(countStrictlyBefore(lines, '2026-09-20T10:00:00.3Z')).toBe(2);
    // Ancla anterior a todo: nada.
    expect(countStrictlyBefore(lines, '2026-09-20T09:00:00Z')).toBe(0);
    // Ancla posterior a todo: todas.
    expect(countStrictlyBefore(lines, '2026-09-20T11:00:00Z')).toBe(4);
    // Una línea sin cursor en la cola no se puede situar: no cuenta.
    expect(countStrictlyBefore([...lines.slice(0, 2), { cursor: null, line: 'x' }], '2026-09-20T10:00:00.3Z')).toBe(2);
    expect(countStrictlyBefore([], '2026-09-20T10:00:00Z')).toBe(0);
  });
});
