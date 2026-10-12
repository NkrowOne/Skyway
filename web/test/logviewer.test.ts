import { describe, expect, it } from 'vitest';
import {
  advanceView,
  CHUNK,
  createViewState,
  detectLevel,
  diffLines,
  freezeLines,
  parseQuery,
  parseRawLine,
  tsText,
  ViewOptions,
} from '../src/components/LogViewer';

const OPTS: ViewOptions = { q: '', level: 'all' };

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

describe('freezeLines (vista quieta mientras se lee)', () => {
  const L = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `l${from + i}`);

  it('las líneas nuevas al final se quedan fuera y la vista es el mismo array', () => {
    const frozen = L(0, 10);
    const grown = frozen.concat(L(10, 15));
    expect(freezeLines(frozen, grown)).toBe(frozen);
  });

  it('el historial cargado por delante sí entra, sin las nuevas del final', () => {
    const frozen = L(10, 20);
    const cur = L(0, 25);
    expect(freezeLines(frozen, cur)).toEqual(L(0, 20));
  });

  it('lo que el buffer recorta por delante sale también de la vista', () => {
    const frozen = L(0, 10);
    const cur = L(4, 30);
    expect(freezeLines(frozen, cur)).toEqual(L(4, 10));
  });

  it('otra fuente sustituye la vista y aplicarlo dos veces no cambia nada', () => {
    const cur = ['x', 'y'];
    expect(freezeLines(L(0, 3), cur)).toBe(cur);
    const once = freezeLines(L(10, 20), L(0, 25));
    expect(freezeLines(once, L(0, 25))).toBe(once);
  });
});

describe('parseQuery (sintaxis de búsqueda)', () => {
  const t = (q: string, text: string, lvl: 'err' | 'warn' | 'plain' = 'plain') => parseQuery(q).test(text, lvl);

  it('palabras sueltas: todas, sin distinguir mayúsculas', () => {
    expect(t('redis timeout', 'Redis connection TIMEOUT')).toBe(true);
    expect(t('redis timeout', 'redis ok')).toBe(false);
  });

  it('frase exacta, exclusión y OR', () => {
    expect(t('"connection refused"', 'ECONN: connection refused')).toBe(true);
    expect(t('"connection refused"', 'refused connection')).toBe(false);
    expect(t('error -healthcheck', 'error en healthcheck')).toBe(false);
    expect(t('error -healthcheck', 'error en la base')).toBe(true);
    expect(t('timeout OR refused', 'refused')).toBe(true);
    expect(t('timeout OR refused', 'nada')).toBe(false);
  });

  it('expresión regular entre barras; una ruta no es una expresión', () => {
    expect(t('/5\\d\\d/', 'GET / 503')).toBe(true);
    expect(t('/5\\d\\d/', 'GET / 404')).toBe(false);
    expect(t('/api/users', 'GET /api/users 200')).toBe(true);
    expect(t('/api/users', 'GET /api/orders users')).toBe(false);
  });

  it('una expresión no válida se busca como texto y avisa', () => {
    const q = parseQuery('/a(b/');
    expect(q.error).not.toBeNull();
    expect(q.test('xa(by', 'plain')).toBe(true);
  });

  it('level:error y level:warn filtran por nivel', () => {
    expect(t('level:error', 'algo', 'err')).toBe(true);
    expect(t('level:error', 'algo', 'warn')).toBe(false);
    expect(t('@level:warn db', 'db lenta', 'warn')).toBe(true);
  });

  it('resalta los términos positivos, no los excluidos', () => {
    const q = parseQuery('redis -debug "a.b"');
    expect('x redis a.b debug'.match(q.mark!)).toEqual(['redis', 'a.b']);
    expect(parseQuery('').active).toBe(false);
  });
});

describe('parseRawLine y detectLevel', () => {
  it('extrae el sello ISO de Docker (nanosegundos) y deja el texto', () => {
    const r = parseRawLine('2026-10-12T12:03:22.123456789Z [r2] hola');
    expect(r.ts).toBe(Date.UTC(2026, 9, 12, 12, 3, 22, 123));
    expect(r.cleanText).toBe('[r2] hola');
    expect(tsText(r, 'utc')).toMatch(/^12 oct\.? 12:03:22$/);
  });

  it('los registros antiguos con solo la hora la conservan sin inventar fecha', () => {
    const r = parseRawLine('12:03:22 Clonando el repositorio');
    expect(r.ts).toBeNull();
    expect(r.clock).toBe('12:03:22');
    expect(tsText(r, 'datetime')).toBe('12:03:22');
  });

  it('de una barra de progreso queda lo último que se pintó', () => {
    expect(parseRawLine('2026-10-12T12:03:22Z 10%\r55%\r100%').cleanText).toBe('100%');
  });

  it('el nivel declarado manda sobre la heurística', () => {
    expect(detectLevel('{"level":"error","msg":"x"}')).toBe('err');
    expect(detectLevel('{"level":50,"msg":"x"}')).toBe('err');
    expect(detectLevel('level=warn msg="disco al 90%"')).toBe('warn');
    expect(detectLevel('INFO: 0 errors found')).toBe('plain');
    expect(detectLevel('npm ERR! code 1')).toBe('err');
    expect(detectLevel('[warn] deprecated option')).toBe('warn');
  });

  it('heurística con palabras completas', () => {
    expect(detectLevel('TypeError: x is undefined')).toBe('err');
    expect(detectLevel('Traceback (most recent call last):')).toBe('err');
    expect(detectLevel('✖ Error: el contenedor no arranca')).toBe('err');
    expect(detectLevel('⚠ No se pudo borrar el directorio')).toBe('warn');
    expect(detectLevel('registered errorHandler middleware')).toBe('plain');
    expect(detectLevel('Compiled with 0 errors')).toBe('plain');
  });
});
