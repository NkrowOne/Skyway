import { describe, expect, it } from 'vitest';
import { findFrontCut, ParsedRow } from '../src/components/LogViewer';

const row = (text: string): ParsedRow => ({ raw: text, cleanText: text, ts: null, iso: null, stage: 'all', lvl: 'plain' });

describe('findFrontCut (recorte por delante del buffer de logs)', () => {
  const a = row('a');
  const b = row('b');
  const c = row('c');
  const d = row('d');
  const blank = row('');

  it('sin recorte: solo líneas nuevas al final', () => {
    expect(findFrontCut([a, b], [a, b, c])).toBe(0);
    expect(findFrontCut([a, b], [a, b])).toBe(0);
  });

  it('recorte por delante con líneas nuevas al final', () => {
    expect(findFrontCut([a, b, c], [b, c, d])).toBe(1);
    expect(findFrontCut([a, b, c], [c])).toBe(2);
  });

  it('otra fuente o historial cargado por delante: -1', () => {
    expect(findFrontCut([a, b], [d, a, b])).toBe(-1);
    expect(findFrontCut([a, b], [c, d])).toBe(-1);
    expect(findFrontCut([a, b, c], [a, c])).toBe(-1);
  });

  it('las líneas repetidas comparten objeto y no confunden el recorte', () => {
    // El buffer empieza con dos líneas en blanco iguales: el primer candidato (0) no casa, el segundo (1) sí.
    expect(findFrontCut([blank, blank, a], [blank, a, b])).toBe(1);
  });

  it('un log de líneas idénticas no se convierte en un barrido cuadrático', () => {
    const prev = Array.from({ length: 5000 }, () => blank);
    const cur = Array.from({ length: 5000 }, () => blank);
    const t = performance.now();
    const cut = findFrontCut(prev, cur);
    expect(cut).toBeGreaterThanOrEqual(-1);
    expect(performance.now() - t).toBeLessThan(200);
  });
});
