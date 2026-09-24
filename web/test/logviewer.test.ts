import { describe, expect, it } from 'vitest';
import { advanceView, CHUNK, createViewState, diffLines, ViewOptions } from '../src/components/LogViewer';

const OPTS: ViewOptions = { defaultStage: 'all', q: '', level: 'all', stage: 'all', tsFormat: 'time', tick: 0 };

describe('diffLines (relación entre dos versiones del buffer)', () => {
  it('sin recorte: solo líneas nuevas al final', () => {
    expect(diffLines(['a', 'b'], ['a', 'b', 'c'])).toEqual({ front: 0, kept: 2 });
    expect(diffLines(['a', 'b'], ['a', 'b'])).toEqual({ front: 0, kept: 2 });
  });

  it('recorte por delante con líneas nuevas al final', () => {
    expect(diffLines(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual({ front: -1, kept: 2 });
    expect(diffLines(['a', 'b', 'c'], ['c'])).toEqual({ front: -2, kept: 1 });
  });

  it('historial cargado por delante (con o sin líneas nuevas al final)', () => {
    expect(diffLines(['a', 'b'], ['x', 'y', 'a', 'b'])).toEqual({ front: 2, kept: 2 });
    expect(diffLines(['a', 'b'], ['x', 'a', 'b', 'c'])).toEqual({ front: 1, kept: 2 });
  });

  it('otra fuente: nada en común', () => {
    expect(diffLines(['a', 'b'], ['c', 'd'])).toEqual({ front: 0, kept: 0 });
    expect(diffLines(['a', 'b', 'c'], ['a', 'c'])).toEqual({ front: 0, kept: 0 });
    expect(diffLines([], ['a'])).toEqual({ front: 0, kept: 0 });
    expect(diffLines(['a'], [])).toEqual({ front: 0, kept: 0 });
  });

  it('las líneas repetidas no confunden el recorte', () => {
    // El buffer empieza con dos líneas en blanco iguales: el primer candidato (0) no casa, el segundo (1) sí.
    expect(diffLines(['', '', 'a'], ['', 'a', 'b'])).toEqual({ front: -1, kept: 2 });
  });

  it('un log de líneas idénticas no se convierte en un barrido cuadrático', () => {
    const prev = Array.from({ length: 5000 }, () => 'x');
    const cur = Array.from({ length: 5000 }, () => 'x');
    const t = performance.now();
    const d = diffLines(prev, cur);
    expect(d.kept).toBeGreaterThan(0);
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe('advanceView (modelo incremental del visor)', () => {
  const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `línea ${from + i}`);

  it('numera desde 1 y agrupa en bloques', () => {
    const st = createViewState();
    const m = advanceView(st, lines(0, 100), OPTS);
    expect(m.rows).toHaveLength(100);
    expect(m.visible.map((v) => v.id - m.origin)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(m.chunks.map((c) => c.rows.length)).toEqual([CHUNK, CHUNK, 100 - 2 * CHUNK]);
  });

  it('una ráfaga al final conserva filas, objetos visibles y bloques anteriores', () => {
    const st = createViewState();
    const a = advanceView(st, lines(0, 100), OPTS);
    const b = advanceView(st, lines(0, 130), OPTS);
    expect(b.rows.slice(0, 100)).toEqual(a.rows);
    // Mismos objetos visibles para las filas que ya estaban.
    expect(b.visible[0]).toBe(a.visible[0]);
    expect(b.visible[99]).toBe(a.visible[99]);
    // Los dos primeros bloques son los mismos objetos; el tercero se ha rellenado con la misma clave.
    expect(b.chunks[0]).toBe(a.chunks[0]);
    expect(b.chunks[1]).toBe(a.chunks[1]);
    expect(b.chunks[2].key).toBe(a.chunks[2].key);
    // Tenía 4 filas (100 − 2·48) y recibe las 30 nuevas.
    expect(b.chunks[2].rows).toHaveLength(100 - 2 * CHUNK + 30);
    expect(b.chunks.reduce((n, c) => n + c.rows.length, 0)).toBe(130);
    expect(b.delta).toEqual({ front: 0, kept: 100 });
    expect(b.appended).toBe(30);
  });

  it('un recorte por delante mantiene la numeración absoluta y las claves de bloque', () => {
    const st = createViewState();
    const a = advanceView(st, lines(0, 100), OPTS);
    // Se recortan 60 y entran 10 nuevas.
    const b = advanceView(st, lines(60, 110), OPTS);
    expect(b.delta).toEqual({ front: -60, kept: 40 });
    expect(b.visible[0].id - b.origin).toBe(61);
    expect(b.visible[b.visible.length - 1].id - b.origin).toBe(110);
    // El bloque que sobrevive a medias conserva su clave con menos filas.
    expect(b.chunks[0].key).toBe(a.chunks[1].key);
    expect(b.chunks[0].rows[0].id - b.origin).toBe(61);
    expect(b.partialCut).toBe(60 - CHUNK);
    expect(b.prevFirstChunkKey).toBe(a.chunks[0].key);
    expect(b.counts).toEqual({ err: 0, warn: 0 });
    // Con el buffer lleno la longitud no cambia: lo que entra por detrás se cuenta aparte.
    expect(b.appended).toBe(10);
  });

  it('el historial por delante renumera desde 1 y deja los bloques anteriores intactos', () => {
    const st = createViewState();
    const a = advanceView(st, lines(400, 500), OPTS);
    const b = advanceView(st, lines(0, 500), OPTS);
    expect(b.delta).toEqual({ front: 400, kept: 100 });
    expect(b.visible[0].id - b.origin).toBe(1);
    expect(b.visible[400].id - b.origin).toBe(401);
    // Las filas que ya estaban son los mismos objetos y sus bloques también.
    expect(b.visible[400]).toBe(a.visible[0]);
    expect(b.chunks[b.chunks.length - 1]).toBe(a.chunks[a.chunks.length - 1]);
    expect(b.prevFirstChunkKey).toBe(a.chunks[0].key);
    // Los bloques nuevos van delante.
    expect(b.chunks.indexOf(a.chunks[0])).toBe(Math.ceil(400 / CHUNK));
  });

  it('otra fuente: se empieza de cero', () => {
    const st = createViewState();
    advanceView(st, lines(0, 10), OPTS);
    const b = advanceView(st, ['x', 'y'], OPTS);
    expect(b.rows).toHaveLength(2);
    expect(b.visible.map((v) => v.id - b.origin)).toEqual([1, 2]);
    expect(b.delta).toEqual({ front: 0, kept: 0 });
  });

  it('el filtro se aplica de forma incremental igual que de cero', () => {
    const st = createViewState();
    const src = ['ok 1', 'ERROR uno', 'ok 2', 'warn dos', 'ok 3'];
    const opts: ViewOptions = { ...OPTS, level: 'err' };
    advanceView(st, src, opts);
    const grown = src.concat(['error tres', 'ok 4']);
    const inc = advanceView(st, grown, opts);
    const fresh = advanceView(createViewState(), grown, opts);
    expect(inc.visible.map((v) => v.row.cleanText)).toEqual(['ERROR uno', 'error tres']);
    expect(inc.visible.map((v) => v.id - inc.origin)).toEqual(fresh.visible.map((v) => v.id - fresh.origin));
    expect(inc.counts).toEqual({ err: 2, warn: 1 });
    // La búsqueda no distingue mayúsculas y escapa los metacaracteres.
    const q = advanceView(st, grown, { ...OPTS, q: 'error' });
    expect(q.visible).toHaveLength(2);
    const dot = advanceView(st, ['a.b', 'axb'], { ...OPTS, q: 'a.b' });
    expect(dot.visible.map((v) => v.row.cleanText)).toEqual(['a.b']);
  });

  it('con las mismas líneas y el mismo filtro devuelve el mismo modelo', () => {
    const st = createViewState();
    const src = lines(0, 5);
    const a = advanceView(st, src, OPTS);
    expect(advanceView(st, src, OPTS)).toBe(a);
  });
});
