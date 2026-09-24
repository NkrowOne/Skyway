import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown,
  ArrowUpToLine,
  ChevronsDown,
  Check,
  Clock,
  Copy,
  Download,
  Hash,
  Maximize2,
  Minimize2,
  Search,
  SlidersHorizontal,
  Trash2,
  WrapText,
  X,
} from 'lucide-react';
import { copyToClipboard, cx, stripAnsi } from '../utils';
import { ErrorState, Menu, MenuItem, Spinner, useToast } from './ui';

export type Level = 'err' | 'warn' | 'plain';
export type LevelFilter = 'all' | 'err' | 'warn';
export type LogStage = 'all' | 'build' | 'deploy' | 'runtime' | 'sys';
export type TimestampFormat = 'time' | 'datetime' | 'utc' | 'relative';

/** Formateador de miles reutilizable (locale fija). */
const NF = new Intl.NumberFormat('es');

/*
 * Formateadores de hora fijos. `toLocaleTimeString` construye uno nuevo en
 * cada llamada y aquí se llama una vez por línea visible cada vez que entra
 * una ráfaga: con quince mil líneas en vivo eran quince mil instancias por frame.
 */
const TIME_FMT = new Intl.DateTimeFormat('es-ES', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const DATETIME_FMT = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: '2-digit' });

/**
 * Filas por bloque. El bloque es la unidad que se pinta o se sustituye por un
 * hueco de su alto, y la que se mide.
 */
export const CHUNK = 48;
/**
 * Píxeles que se pintan de más por encima y por debajo del hueco visible: el
 * margen para que un gesto rápido no llegue a una zona todavía en blanco.
 */
const OVERSCAN_PX = 800;
/** Alto de una línea visual hasta que se calibra con los bloques medidos. */
const DEFAULT_LINE_H = 22;
/** Texto de la sonda que mide la anchura de un carácter de la monoespaciada. */
const PROBE = '0000000000000000000000000000000000000000';

/** Heurística de niveles: error/fatal/panic → err; warn → warn; resto neutro. */
function detectLevel(line: string): Level {
  const l = line.toLowerCase();
  if (
    l.includes('error') ||
    l.includes(' err ') ||
    l.includes('fatal') ||
    l.includes('panic') ||
    l.includes('[error]') ||
    l.includes('level=error') ||
    l.includes('"level":"error"')
  ) {
    return 'err';
  }
  if (
    l.includes('warn') ||
    l.includes('warning') ||
    l.includes('[warn]') ||
    l.includes('level=warn') ||
    l.includes('"level":"warn"')
  ) {
    return 'warn';
  }
  return 'plain';
}

export interface ParsedRow {
  raw: string;
  cleanText: string;
  ts: number | null;
  iso: string | null;
  stage: LogStage;
  lvl: Level;
}

/** Parsea una línea de log extrayendo timestamp (ISO/Docker/RFC3339/legacy), fase y nivel. */
export function parseRawLine(raw: string, defaultStage: LogStage = 'all'): ParsedRow {
  let text = stripAnsi(raw).trimEnd();
  let ts: number | null = null;
  let iso: string | null = null;
  let stage: LogStage = defaultStage;

  // 1. Detección de timestamp ISO de Docker (2026-08-27T19:24:12.123456789Z o 2026-08-27 19:24:12)
  const spaceIdx = text.indexOf(' ');
  if (spaceIdx >= 19 && text[4] === '-' && text[7] === '-' && (text[10] === 'T' || text[10] === ' ')) {
    const candidate = text.slice(0, spaceIdx);
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) {
      ts = parsed;
      iso = candidate;
      text = text.slice(spaceIdx + 1).trimStart();
    }
  } else if (spaceIdx >= 8 && spaceIdx <= 12 && /^\d{2}:\d{2}:\d{2}/.test(text)) {
    // Sello legacy HH:mm:ss
    iso = text.slice(0, spaceIdx);
    text = text.slice(spaceIdx + 1).trimStart();
  }

  // 2. Detección de fase explícita ([build], [deploy], [runtime], [sys])
  const lower = text.toLowerCase();
  if (lower.startsWith('[build]') || lower.startsWith('build:')) {
    stage = 'build';
    text = text.replace(/^\[build\]\s*|^build:\s*/i, '');
  } else if (lower.startsWith('[deploy]') || lower.startsWith('deploy:')) {
    stage = 'deploy';
    text = text.replace(/^\[deploy\]\s*|^deploy:\s*/i, '');
  } else if (lower.startsWith('[runtime]') || lower.startsWith('runtime:')) {
    stage = 'runtime';
    text = text.replace(/^\[runtime\]\s*|^runtime:\s*/i, '');
  } else if (lower.startsWith('[sys]') || lower.startsWith('[system]') || lower.startsWith('system:')) {
    stage = 'sys';
    text = text.replace(/^\[(sys|system)\]\s*|^(sys|system):\s*/i, '');
  }

  const lvl = detectLevel(text);

  return {
    raw,
    cleanText: text,
    ts,
    iso,
    stage,
    lvl,
  };
}

/** Formatea una marca de tiempo según el formato seleccionado. */
function formatTimestamp(ts: number | null, iso: string | null, format: TimestampFormat): string {
  if (!ts && iso) {
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed)) ts = parsed;
  }
  if (!ts && !iso) return '';
  if (format === 'relative' && ts) {
    const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diff < 10) return '<10s';
    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
  }
  if (format === 'utc' && ts) {
    return new Date(ts).toISOString().slice(11, 19) + ' UTC';
  }
  if (format === 'datetime' && ts) {
    const d = new Date(ts);
    return `${DATETIME_FMT.format(d)} ${TIME_FMT.format(d)}`;
  }
  // format === 'time' (default)
  if (ts) return TIME_FMT.format(new Date(ts));
  return iso ? iso.slice(0, 8) : '';
}

/** Tooltip con información temporal completa para el hover. */
function timestampTooltip(ts: number | null, iso: string | null): string | undefined {
  if (!ts && !iso) return undefined;
  if (ts) {
    const d = new Date(ts);
    return `Fecha local: ${d.toLocaleString('es-ES')}\nISO: ${d.toISOString()}\nUTC: ${d.toUTCString()}`;
  }
  return `Hora: ${iso}`;
}

/*
 * Hora y tooltip de cada fila, calculados una sola vez por fila y formato. Con
 * catorce mil filas en el buffer, formatearlas todas con `Intl` en cada ráfaga
 * era el coste que dejaba el hilo principal del móvil sin responder. El
 * formato relativo cambia con el reloj y no se cachea.
 */
const TS_CACHE = new WeakMap<ParsedRow, { by: Partial<Record<TimestampFormat, string>>; tip?: string; tipDone: boolean }>();
function tsEntry(r: ParsedRow) {
  let c = TS_CACHE.get(r);
  if (!c) {
    c = { by: {}, tipDone: false };
    TS_CACHE.set(r, c);
  }
  return c;
}
function tsStringCached(r: ParsedRow, format: TimestampFormat): string {
  if (format === 'relative') return formatTimestamp(r.ts, r.iso, format);
  const c = tsEntry(r);
  let s = c.by[format];
  if (s === undefined) {
    s = formatTimestamp(r.ts, r.iso, format);
    c.by[format] = s;
  }
  return s;
}
function tsTooltipCached(r: ParsedRow): string | undefined {
  const c = tsEntry(r);
  if (!c.tipDone) {
    c.tip = timestampTooltip(r.ts, r.iso);
    c.tipDone = true;
  }
  return c.tip;
}

/* ───────────────────────── Modelo incremental del buffer ─────────────────── */

/**
 * Relación entre dos versiones del buffer de líneas.
 *
 * - `front < 0`: se han recortado `-front` líneas por delante (buffer lleno).
 * - `front > 0`: se han añadido `front` líneas por delante (historial cargado).
 * - `kept`: líneas de la versión anterior que siguen (un sufijo si `front < 0`,
 *   todas si `front >= 0`). `kept === 0` significa otra fuente: se empieza de cero.
 *
 * Las líneas nuevas al final son `cur.length - max(front, 0) - kept`.
 */
export interface LinesDelta {
  front: number;
  kept: number;
}

const NO_OVERLAP: LinesDelta = { front: 0, kept: 0 };

/**
 * Cómo se ha transformado `prev` en `cur`. Se compara por igualdad de cadenas
 * (las mismas líneas suelen ser además los mismos objetos: la comparación es
 * un puntero). Con un tope de candidatos, un log de líneas idénticas no
 * convierte esto en un barrido cuadrático.
 */
export function diffLines(prev: readonly string[], cur: readonly string[]): LinesDelta {
  if (prev.length === 0 || cur.length === 0) return NO_OVERLAP;
  if (prev === cur) return { front: 0, kept: prev.length };

  // 1. Un sufijo de `prev` encabeza `cur`: nada recortado, o recorte por delante.
  const first = cur[0];
  let candidates = 0;
  for (let c = 0; c < prev.length; c++) {
    if (prev[c] !== first) continue;
    if (++candidates > 64) break;
    const kept = prev.length - c;
    if (kept > cur.length) continue;
    let ok = true;
    for (let i = 1; i < kept; i++) {
      if (prev[c + i] !== cur[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { front: c === 0 ? 0 : -c, kept };
  }

  // 2. `prev` entero aparece desplazado dentro de `cur`: historial por delante.
  if (cur.length > prev.length) {
    const head = prev[0];
    const maxShift = cur.length - prev.length;
    candidates = 0;
    for (let k = 1; k <= maxShift; k++) {
      if (cur[k] !== head) continue;
      if (++candidates > 64) break;
      let ok = true;
      for (let i = 1; i < prev.length; i++) {
        if (cur[k + i] !== prev[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { front: k, kept: prev.length };
    }
  }
  return NO_OVERLAP;
}

export interface VisibleRow {
  /**
   * Identidad estable de la fila desde que se abrió el visor: no cambia al
   * recortar por delante ni al cargar historial. El número que se pinta es
   * `id - origin`.
   */
  id: number;
  row: ParsedRow;
  tsString: string;
  tsTooltip?: string;
}

export interface Chunk {
  /** Clave estable del bloque (secuencia), independiente de las filas que contenga. */
  key: number;
  rows: VisibleRow[];
}

interface Counts {
  err: number;
  warn: number;
}

export interface ViewOptions {
  defaultStage: LogStage;
  /** Texto buscado, ya recortado. */
  q: string;
  level: LevelFilter;
  stage: LogStage;
  tsFormat: TimestampFormat;
  tick: number;
}

export interface ViewModel {
  lines: readonly string[];
  defaultStage: LogStage;
  key: string;
  rows: ParsedRow[];
  /** id de `rows[0]`; los ids son consecutivos. */
  firstId: number;
  /** El número de línea que se pinta es `id - origin`. */
  origin: number;
  counts: Counts;
  visible: VisibleRow[];
  chunks: Chunk[];
  /** Cambio del buffer respecto al paso anterior (null si solo cambió el filtro). */
  delta: LinesDelta | null;
  /** Clave del bloque que iba primero antes de este paso, para anclar el scroll. */
  prevFirstChunkKey: number | null;
  /** Filas visibles recortadas del primer bloque que sobrevive (recorte parcial). */
  partialCut: number;
  /**
   * Filas visibles añadidas al FINAL en este paso. Para el contador de no
   * leídas: con el buffer lleno cada ráfaga entra por detrás y sale por
   * delante, y la longitud no cambia.
   */
  appended: number;
}

export interface ViewState {
  model: ViewModel;
  /** Fila parseada por texto crudo: las líneas repetidas comparten objeto. */
  cache: Map<string, ParsedRow>;
  nextChunkKey: number;
}

const EMPTY_LINES: string[] = [];

export function createViewState(): ViewState {
  return {
    model: {
      lines: EMPTY_LINES,
      defaultStage: 'all',
      key: '',
      rows: [],
      firstId: 1,
      origin: 0,
      counts: { err: 0, warn: 0 },
      visible: [],
      chunks: [],
      delta: null,
      prevFirstChunkKey: null,
      partialCut: 0,
      appended: 0,
    },
    cache: new Map(),
    nextChunkKey: 1,
  };
}

function viewKey(o: ViewOptions): string {
  return `${o.q}\u0000${o.level}\u0000${o.stage}\u0000${o.tsFormat}\u0000${o.tsFormat === 'relative' ? o.tick : 0}`;
}

function countRange(rows: readonly ParsedRow[], from: number, to: number): Counts {
  let err = 0;
  let warn = 0;
  for (let i = from; i < to; i++) {
    const l = rows[i].lvl;
    if (l === 'err') err++;
    else if (l === 'warn') warn++;
  }
  return { err, warn };
}

/**
 * Filtro de filas. La búsqueda va con una expresión regular sin distinguir
 * mayúsculas: `toLowerCase()` por fila creaba catorce mil cadenas nuevas por
 * cada tecla pulsada.
 */
function makeMatcher(o: ViewOptions): (r: ParsedRow) => boolean {
  const { level, stage } = o;
  const re = o.q ? new RegExp(o.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  return (r) =>
    (level === 'all' || r.lvl === level) &&
    (stage === 'all' || r.stage === 'all' || r.stage === stage) &&
    (!re || re.test(r.cleanText));
}

function groupChunks(rows: VisibleRow[], state: ViewState): Chunk[] {
  const out: Chunk[] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push({ key: state.nextChunkKey++, rows: rows.slice(i, i + CHUNK) });
  return out;
}

/** Quita las filas con id anterior a `firstId`; el bloque que sobrevive a medias conserva su clave. */
function dropChunksBefore(chunks: Chunk[], firstId: number): { chunks: Chunk[]; partial: number } {
  let i = 0;
  while (i < chunks.length && chunks[i].rows[chunks[i].rows.length - 1].id < firstId) i++;
  const rest = chunks.slice(i);
  let partial = 0;
  if (rest.length && rest[0].rows[0].id < firstId) {
    const c = rest[0];
    while (partial < c.rows.length && c.rows[partial].id < firstId) partial++;
    rest[0] = { key: c.key, rows: c.rows.slice(partial) };
  }
  return { chunks: rest, partial };
}

/** Añade filas al final: primero se rellena el último bloque, después bloques nuevos. */
function appendChunks(chunks: Chunk[], tail: VisibleRow[], state: ViewState): Chunk[] {
  const out = chunks.slice();
  let from = 0;
  if (out.length) {
    const last = out[out.length - 1];
    const room = CHUNK - last.rows.length;
    if (room > 0) {
      const part = tail.slice(0, room);
      out[out.length - 1] = { key: last.key, rows: last.rows.concat(part) };
      from = part.length;
    }
  }
  for (let i = from; i < tail.length; i += CHUNK) out.push({ key: state.nextChunkKey++, rows: tail.slice(i, i + CHUNK) });
  return out;
}

/**
 * Un paso del modelo: del buffer anterior al nuevo, tocando solo lo que ha
 * cambiado. El buffer se transforma de tres maneras entre ráfagas —líneas
 * nuevas al final, recorte por delante cuando está lleno, historial cargado
 * por delante— y en las tres se conservan las filas, los objetos visibles y
 * los bloques ya calculados: una ráfaga de veinte líneas cuesta veinte
 * líneas, no las catorce mil del buffer. Solo un cambio de filtro o de
 * fuente recalcula todo.
 */
export function advanceView(state: ViewState, lines: readonly string[], opts: ViewOptions): ViewModel {
  const prev = state.model;
  const key = viewKey(opts);
  if (prev.lines === lines && prev.key === key && prev.defaultStage === opts.defaultStage) return prev;

  const sameLines = prev.lines === lines && prev.defaultStage === opts.defaultStage;
  const delta: LinesDelta = sameLines ? { front: 0, kept: prev.rows.length } : diffLines(prev.lines, lines);
  const reset = !sameLines && (delta.kept === 0 || prev.defaultStage !== opts.defaultStage);
  const cache = state.cache;
  const defaultStage = opts.defaultStage;
  const parse = (raw: string): ParsedRow => {
    let r = cache.get(raw);
    if (!r) {
      r = parseRawLine(raw, defaultStage);
      cache.set(raw, r);
    }
    return r;
  };

  let rows: ParsedRow[];
  let firstId: number;
  let origin: number;
  let counts: Counts;
  /** Índice en `rows` donde empiezan las filas nuevas del final. */
  let tailFrom: number;
  /** Filas nuevas por delante (historial). */
  let headCount = 0;

  if (sameLines) {
    rows = prev.rows;
    firstId = prev.firstId;
    origin = prev.origin;
    counts = prev.counts;
    tailFrom = rows.length;
  } else if (reset) {
    cache.clear();
    rows = new Array<ParsedRow>(lines.length);
    for (let i = 0; i < lines.length; i++) rows[i] = parse(lines[i]);
    firstId = 1;
    origin = 0;
    counts = countRange(rows, 0, rows.length);
    tailFrom = rows.length;
  } else if (delta.front < 0) {
    const cut = -delta.front;
    // La caché solo guarda lo que está en el buffer: sin esta poda crecía con
    // cada línea distinta que hubiera pasado por el visor.
    for (let i = 0; i < cut; i++) cache.delete(prev.rows[i].raw);
    rows = prev.rows.slice(cut);
    tailFrom = rows.length;
    for (let i = delta.kept; i < lines.length; i++) rows.push(parse(lines[i]));
    firstId = prev.firstId + cut;
    // La numeración es absoluta: una fila conserva su número aunque el buffer
    // se vacíe por delante.
    origin = prev.origin;
    const removed = countRange(prev.rows, 0, cut);
    const added = countRange(rows, tailFrom, rows.length);
    counts = { err: prev.counts.err - removed.err + added.err, warn: prev.counts.warn - removed.warn + added.warn };
  } else {
    headCount = delta.front;
    const head = new Array<ParsedRow>(headCount);
    for (let i = 0; i < headCount; i++) head[i] = parse(lines[i]);
    rows = headCount ? head.concat(prev.rows) : prev.rows.slice();
    tailFrom = rows.length;
    for (let i = headCount + delta.kept; i < lines.length; i++) rows.push(parse(lines[i]));
    firstId = prev.firstId - headCount;
    // Con historial por delante, la línea más antigua vuelve a ser la 1.
    origin = headCount ? firstId - 1 : prev.origin;
    const addedHead = countRange(rows, 0, headCount);
    const addedTail = countRange(rows, tailFrom, rows.length);
    counts = {
      err: prev.counts.err + addedHead.err + addedTail.err,
      warn: prev.counts.warn + addedHead.warn + addedTail.warn,
    };
  }

  const matches = makeMatcher(opts);
  const mk = (i: number): VisibleRow => {
    const r = rows[i];
    return { id: firstId + i, row: r, tsString: tsStringCached(r, opts.tsFormat), tsTooltip: tsTooltipCached(r) };
  };

  let visible: VisibleRow[];
  let chunks: Chunk[];
  let partialCut = 0;
  let appended = 0;
  if (reset || key !== prev.key) {
    visible = [];
    for (let i = 0; i < rows.length; i++) if (matches(rows[i])) visible.push(mk(i));
    chunks = groupChunks(visible, state);
  } else {
    visible = prev.visible;
    chunks = prev.chunks;
    if (delta.front < 0) {
      let drop = 0;
      while (drop < visible.length && visible[drop].id < firstId) drop++;
      if (drop > 0) {
        visible = visible.slice(drop);
        const d = dropChunksBefore(chunks, firstId);
        chunks = d.chunks;
        partialCut = d.partial;
      }
    } else if (headCount > 0) {
      const head: VisibleRow[] = [];
      for (let i = 0; i < headCount; i++) if (matches(rows[i])) head.push(mk(i));
      if (head.length) {
        visible = head.concat(visible);
        chunks = groupChunks(head, state).concat(chunks);
      }
    }
    if (tailFrom < rows.length) {
      const tail: VisibleRow[] = [];
      for (let i = tailFrom; i < rows.length; i++) if (matches(rows[i])) tail.push(mk(i));
      if (tail.length) {
        visible = visible.concat(tail);
        chunks = appendChunks(chunks, tail, state);
        appended = tail.length;
      }
    }
  }

  const next: ViewModel = {
    lines,
    defaultStage,
    key,
    rows,
    firstId,
    origin,
    counts,
    visible,
    chunks,
    delta: sameLines ? null : delta,
    prevFirstChunkKey: prev.chunks.length ? prev.chunks[0].key : null,
    partialCut,
    appended,
  };
  state.model = next;
  return next;
}

/* ───────────────────────── Ventana de pintado ────────────────────────────── */

/**
 * Posición de cada bloque en el lienzo. Los bloques ya medidos usan su alto
 * real; los demás, una estimación por número de líneas visuales.
 */
interface Layout {
  /** `offsets[i]` = techo del bloque i; `offsets[n]` = alto total. */
  offsets: number[];
  total: number;
  /** Alto de una línea visual, calibrado con los bloques medidos. */
  lineH: number;
  index: Map<number, number>;
  /** Tramo de bloques pintados en este render. */
  start: number;
  end: number;
  /** Distancia del techo del lienzo al techo del contenido del scroller. */
  canvasTop: number;
}

const EMPTY_LAYOUT: Layout = { offsets: [0], total: 0, lineH: DEFAULT_LINE_H, index: new Map(), start: 0, end: -1, canvasTop: 0 };

function computeLayout(chunks: Chunk[], heights: Map<number, number>, estLines: (c: Chunk) => number, fallbackLineH: number): Layout {
  const n = chunks.length;
  let px = 0;
  let ln = 0;
  for (const c of chunks) {
    const h = heights.get(c.key);
    if (h !== undefined) {
      px += h;
      ln += estLines(c);
    }
  }
  const lineH = ln > 0 && px > 0 ? px / ln : fallbackLineH;
  const offsets = new Array<number>(n + 1);
  const index = new Map<number, number>();
  let off = 0;
  for (let i = 0; i < n; i++) {
    const c = chunks[i];
    offsets[i] = off;
    index.set(c.key, i);
    const h = heights.get(c.key);
    off += h !== undefined ? h : estLines(c) * lineH;
  }
  offsets[n] = off;
  // Medidas de bloques que ya no existen: se podan cuando abultan.
  if (heights.size > n + 256) {
    for (const k of heights.keys()) if (!index.has(k)) heights.delete(k);
  }
  return { offsets, total: off, lineH, index, start: 0, end: -1, canvasTop: 0 };
}

/**
 * Qué bloques pintar. Siguiendo el final, el tramo se ancla al último bloque
 * (así una ráfaga nunca deja el fondo en blanco un frame); si no, se toma del
 * scroll actual con el margen de más.
 */
function computeRange(offsets: number[], following: boolean, top: number, viewport: number): [number, number] {
  const n = offsets.length - 1;
  if (n <= 0) return [0, -1];
  if (following) {
    let start = n - 1;
    const need = viewport + OVERSCAN_PX;
    while (start > 0 && offsets[n] - offsets[start] < need) start--;
    return [start, n - 1];
  }
  const lo = top - OVERSCAN_PX;
  const hi = top + viewport + OVERSCAN_PX;
  // Primer bloque cuyo fondo supera `lo`.
  let a = 0;
  let b = n;
  while (a < b) {
    const m = (a + b) >> 1;
    if (offsets[m + 1] <= lo) a = m + 1;
    else b = m;
  }
  const start = Math.min(a, n - 1);
  // Primer bloque cuyo techo llega a `hi`; el anterior cierra el tramo.
  a = start;
  b = n;
  while (a < b) {
    const m = (a + b) >> 1;
    if (offsets[m] < hi) a = m + 1;
    else b = m;
  }
  const end = Math.max(start, a - 1);
  return [start, end];
}

/* ───────────────────────── Filas ─────────────────────────────────────────── */

/** Resalta TODAS las coincidencias (sin distinguir mayúsculas) de `q` en la línea. */
function highlight(line: string, q: string): React.ReactNode {
  if (!q) return line;
  const lower = line.toLowerCase();
  const needle = q.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  for (;;) {
    const idx = lower.indexOf(needle, i);
    if (idx < 0) {
      out.push(line.slice(i));
      break;
    }
    if (idx > i) out.push(line.slice(i, idx));
    out.push(
      <mark key={key++} className="log-mark">
        {line.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
  }
  return out;
}

const LogRow = memo(function LogRow({
  n,
  text,
  tsString,
  tsTooltip,
  lvl,
  wrap,
  gutter,
  showTs,
  query,
}: {
  n: number;
  text: string;
  tsString: string;
  tsTooltip?: string;
  lvl: Level;
  wrap: boolean;
  gutter: boolean;
  showTs: boolean;
  query: string;
}) {
  return (
    <div
      className={cx(
        'log-row flex w-full items-baseline hover:bg-white/[.02]',
        lvl === 'err' && 'log-row-err',
        lvl === 'warn' && 'log-row-warn',
      )}
    >
      {gutter && (
        <span
          className="log-gutter tnum select-none px-2 text-right text-xs tabular-nums text-subtle/70"
          style={{ minWidth: 'calc(var(--gutter-ch, 3.8) * 1ch)' }}
        >
          {n}
        </span>
      )}
      {showTs && (
        <span
          className={cx(
            'log-ts tnum shrink-0 select-none px-2 text-xs tabular-nums text-subtle transition-colors hover:text-txt',
            !tsString && 'opacity-0',
          )}
          title={tsTooltip}
          style={{ minWidth: tsString && tsString.length > 10 ? '13ch' : '8ch' }}
        >
          {tsString || '00:00:00'}
        </span>
      )}
      <span
        className={cx(
          'flex flex-1 items-baseline py-px pr-3',
          !gutter && !showTs ? 'pl-3' : 'pl-1',
          wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
        )}
      >
        <span className="log-text min-w-0 flex-1">{highlight(text, query)}</span>
      </span>
    </div>
  );
});

/**
 * Un bloque de filas. Va en `memo` y recibe el mismo array mientras sus filas
 * no cambien: una ráfaga solo repinta el último bloque. Se registra para
 * medirse en cuanto se monta: su alto real sustituye a la estimación.
 */
const LogChunk = memo(function LogChunk({
  chunkKey,
  rows,
  origin,
  wrap,
  gutter,
  showTs,
  query,
  onMeasure,
}: {
  chunkKey: number;
  rows: VisibleRow[];
  origin: number;
  wrap: boolean;
  gutter: boolean;
  showTs: boolean;
  query: string;
  onMeasure: (key: number, el: HTMLDivElement | null) => void;
}) {
  const refCb = useCallback((el: HTMLDivElement | null) => onMeasure(chunkKey, el), [chunkKey, onMeasure]);
  return (
    <div ref={refCb} className="log-chunk">
      {rows.map((v) => (
        <LogRow
          key={v.id}
          n={v.id - origin}
          text={v.row.cleanText}
          tsString={v.tsString}
          tsTooltip={v.tsTooltip}
          lvl={v.row.lvl}
          wrap={wrap}
          gutter={gutter}
          showTs={showTs}
          query={query}
        />
      ))}
    </div>
  );
});

function ToolButton({
  title,
  onClick,
  active,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        // 36px con el pulgar, 32px con ratón. Antes pedía siete y medio, un paso
        // que la escala de Tailwind no tiene: por debajo de 640px estos ocho
        // botones se quedaban sin tamaño y los dimensionaba el icono.
        'press flex h-9 w-9 sm:h-8 sm:w-8 items-center justify-center rounded-lg leading-none disabled:opacity-40 transition-colors',
        active ? 'bg-acc/[.16] text-acc-soft' : 'text-subtle hover:bg-surface2 hover:text-txt',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Consola de logs con scroll al fondo garantizado, marcas de tiempo completas
 * y herramientas de búsqueda, copia y descarga.
 *
 * Solo pinta los bloques de filas que caen cerca del hueco visible; el resto
 * es relleno de su alto (medido si ya se pintó, estimado si no). Con catorce
 * mil filas en el DOM el navegador del móvil no daba abasto —aunque no las
 * maquetara, tenía que tenerlas—; con unas trescientas, el gesto de scroll
 * va a la velocidad del dedo.
 *
 * Va en `memo`: la pestaña que lo aloja se re-renderiza con cada sondeo de
 * despliegues aunque no haya líneas nuevas.
 */
function LogViewerImpl({
  lines,
  className,
  toolbar = false,
  bare = false,
  replicas = 1,
  downloadName,
  statusNote,
  title,
  onLoadOlder,
  canLoadOlder = false,
  loadingOlder = false,
  startReached = false,
  onDownload,
  onFollowChange,
  stageFilter: controlledStageFilter,
  defaultStage = 'all',
  extraHeaderLeft,
  extraHeaderRight,
  state = 'ready',
  onRetry,
  emptyMessage,
}: {
  lines: string[];
  className?: string;
  toolbar?: boolean;
  bare?: boolean;
  replicas?: number;
  downloadName?: string;
  statusNote?: string | null;
  title?: string;
  onLoadOlder?: () => void;
  canLoadOlder?: boolean;
  loadingOlder?: boolean;
  /** Ya no queda historial por delante: se dice, en vez de dejar de ofrecer el botón sin más. */
  startReached?: boolean;
  onDownload?: () => void;
  onFollowChange?: (follow: boolean) => void;
  stageFilter?: LogStage;
  defaultStage?: LogStage;
  extraHeaderLeft?: React.ReactNode;
  extraHeaderRight?: React.ReactNode;
  /**
   * Qué le pasa a la fuente de los logs. Sin esto, una consola vacía decía
   * «Sin logs todavía…» tanto si estaba cargando como si la petición había
   * fallado como si de verdad no había nada: tres situaciones distintas con
   * el mismo mensaje, y solo una de ellas cierta.
   */
  state?: 'loading' | 'error' | 'ready';
  onRetry?: () => void;
  /** Por qué no hay nada, cuando quien llama lo sabe («este despliegue no guardó salida…»). */
  emptyMessage?: string;
}) {
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const scrollRaf = useRef(0);
  const olderRequestedRef = useRef(false);
  const lastTopRef = useRef(0);
  const unreadCountRef = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const [follow, setFollow] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [filter, setFilter] = useState('');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [internalStage] = useState<LogStage>(defaultStage);
  const [wrap, setWrap] = useState(true);
  const [gutter, setGutter] = useState(true);
  const [showTs, setShowTs] = useState(true);
  const [tsFormat, setTsFormat] = useState<TimestampFormat>('time');
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Se limpia al desmontar: el temporizador tocaba estado de un visor ya cerrado.
  const copiedTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const [maximized, setMaximized] = useState(false);
  const [clearedUntil, setClearedUntil] = useState<number>(0);

  const stage = controlledStageFilter ?? internalStage;

  /*
   * «Limpiar la vista» guarda un índice absoluto. Si la fuente cambia (otro
   * despliegue, otra pestaña) o el padre recorta el buffer por delante, ese
   * índice apunta más allá del final y la consola se quedaba vacía para
   * siempre diciendo «Sin logs todavía…». Se olvida en cuanto deja de tener
   * sentido.
   */
  useEffect(() => {
    if (clearedUntil > 0 && lines.length < clearedUntil) setClearedUntil(0);
  }, [lines.length, clearedUntil]);

  // Tiempo relativo: sin un reloj, «hace 5 s» se quedaba congelado mientras
  // no llegaran líneas nuevas.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (tsFormat !== 'relative') return;
    const t = window.setInterval(() => setTick((n) => n + 1), 15_000);
    return () => window.clearInterval(t);
  }, [tsFormat]);

  /*
   * La búsqueda se aplica en diferido: la tecla pulsada aparece en el campo al
   * instante y el filtrado de miles de filas va detrás, sin retener el
   * teclado del móvil.
   */
  const deferredFilter = useDeferredValue(filter);
  const q = deferredFilter.trim();

  const effectiveLines = useMemo(
    () => (clearedUntil > 0 && clearedUntil <= lines.length ? lines.slice(clearedUntil) : lines),
    [lines, clearedUntil],
  );

  const viewRef = useRef<ViewState | null>(null);
  if (!viewRef.current) viewRef.current = createViewState();
  const view = viewRef.current;
  const model = useMemo(
    () => advanceView(view, effectiveLines, { defaultStage, q, level, stage, tsFormat, tick }),
    [view, effectiveLines, defaultStage, q, level, stage, tsFormat, tick],
  );
  const { rows, counts, visible, chunks, origin } = model;

  /*
   * El seguimiento vive también en una ref, actualizada en el mismo instante
   * del scroll (no al siguiente render): así ningún salto programado al fondo
   * pisa un gesto del dedo que acaba de empezar, y el tramo de bloques que se
   * pinta se decide con el dato de este mismo frame.
   */
  const followRef = useRef(true);
  /*
   * En iOS, escribir `scrollTop` mientras hay un dedo en la pantalla —o durante
   * la inercia justo después— cancela el gesto. Con líneas entrando sin parar,
   * el seguimiento mandaba al fondo cada pocos milisegundos y era imposible
   * arrastrar hacia arriba: el visor parecía bloqueado, y como en móvil ocupa
   * la pantalla entera, parecía bloqueada la web. Mientras dura el gesto no se
   * escribe el scroll; cuando se asienta, si toca seguir, se va al fondo.
   */
  const gestureRef = useRef(false);
  const settleTimerRef = useRef(0);
  const pendingBottomRef = useRef(false);

  /* ── Ventana de pintado ── */
  /** Alto real de cada bloque pintado alguna vez, por clave. */
  const heightsRef = useRef(new Map<number, number>());
  /** Líneas visuales estimadas por bloque (para su ancho de columna). */
  const linesCacheRef = useRef(new Map<number, { rows: VisibleRow[]; n: number }>());
  /** Caracteres por línea de texto con ajuste de línea; 0 = sin ajuste o sin medir. */
  const colsRef = useRef(0);
  const scrollTopRef = useRef(0);
  const viewportRef = useRef(0);
  const canvasTopRef = useRef(0);
  const layoutRef = useRef<Layout>(EMPTY_LAYOUT);
  const prevLayoutRef = useRef<Layout>(EMPTY_LAYOUT);
  const [, setLayoutTick] = useState(0);
  const relayout = useCallback(() => setLayoutTick((n) => n + 1), []);

  /*
   * Líneas visuales de un bloque. Con la monoespaciada y `break-all` el ajuste
   * de línea es exacto por número de caracteres, así que la estimación de un
   * bloque sin pintar casi nunca falla y el scroll no da saltos al medirlo.
   */
  const estLines = (c: Chunk): number => {
    const cols = colsRef.current;
    if (!wrap || cols <= 0) return c.rows.length;
    const cache = linesCacheRef.current;
    const hit = cache.get(c.key);
    if (hit && hit.rows === c.rows) return hit.n;
    let n = 0;
    for (const v of c.rows) {
      const len = v.row.cleanText.length;
      n += len <= cols ? 1 : Math.ceil(len / cols);
    }
    if (cache.size > chunks.length + 256) {
      for (const k of cache.keys()) if (!layoutRef.current.index.has(k)) cache.delete(k);
    }
    cache.set(c.key, { rows: c.rows, n });
    return n;
  };

  const layout = computeLayout(chunks, heightsRef.current, estLines, maximized ? 23 : DEFAULT_LINE_H);
  const [start, end] = computeRange(
    layout.offsets,
    followRef.current,
    scrollTopRef.current - canvasTopRef.current,
    viewportRef.current || 600,
  );
  layout.start = start;
  layout.end = end;
  layout.canvasTop = canvasTopRef.current;
  prevLayoutRef.current = layoutRef.current;
  layoutRef.current = layout;

  /*
   * Medición de bloques con un único ResizeObserver. Un bloque entero por
   * encima del hueco que cambia de alto movería lo que se está leyendo: se
   * compensa en el scroll, salvo con el dedo en la pantalla (en iOS cortaría
   * el gesto; el desvío es de píxeles y se asume).
   */
  const roRef = useRef<ResizeObserver | null>(null);
  const elKeyRef = useRef(new WeakMap<Element, number>());
  const keyElRef = useRef(new Map<number, Element>());
  const onResizeRef = useRef<(entries: ResizeObserverEntry[]) => void>(() => {});
  onResizeRef.current = (entries) => {
    const heights = heightsRef.current;
    const lay = layoutRef.current;
    const el = ref.current;
    let shift = 0;
    let dirty = false;
    for (const e of entries) {
      const key = elKeyRef.current.get(e.target);
      if (key === undefined) continue;
      const h = e.borderBoxSize && e.borderBoxSize.length ? e.borderBoxSize[0].blockSize : e.contentRect.height;
      if (h <= 0) continue;
      const old = heights.get(key);
      if (old !== undefined && Math.abs(old - h) < 0.5) continue;
      heights.set(key, h);
      const idx = lay.index.get(key);
      if (idx === undefined) continue;
      const used = lay.offsets[idx + 1] - lay.offsets[idx];
      if (Math.abs(h - used) < 0.5) continue;
      if (followRef.current) continue;
      if (lay.offsets[idx + 1] + lay.canvasTop <= scrollTopRef.current + 1) shift += h - used;
      dirty = true;
    }
    if (shift && el && !gestureRef.current) el.scrollTop += shift;
    if (dirty) relayout();
  };
  const onMeasure = useCallback((key: number, el: HTMLDivElement | null) => {
    if (typeof ResizeObserver === 'undefined') return;
    if (!roRef.current) roRef.current = new ResizeObserver((entries) => onResizeRef.current(entries));
    const ro = roRef.current;
    const prevEl = keyElRef.current.get(key);
    if (el) {
      if (prevEl && prevEl !== el) {
        ro.unobserve(prevEl);
        elKeyRef.current.delete(prevEl);
      }
      keyElRef.current.set(key, el);
      elKeyRef.current.set(el, key);
      ro.observe(el);
    } else if (prevEl) {
      ro.unobserve(prevEl);
      elKeyRef.current.delete(prevEl);
      keyElRef.current.delete(key);
    }
  }, []);
  useEffect(() => () => roRef.current?.disconnect(), []);

  // El ajuste de línea y el tamaño de letra cambian el alto de todo: se vuelve a medir.
  useLayoutEffect(() => {
    heightsRef.current.clear();
    linesCacheRef.current.clear();
  }, [wrap, maximized]);

  /*
   * Posición escrita por el propio visor. El evento de scroll que provoca
   * llega DESPUÉS, y para entonces el alto total puede haber cambiado (una
   * estimación de bloque sustituida por su medida): visto desde ese evento el
   * fondo ya no era el fondo, se daba por hecho que alguien había subido y el
   * seguimiento se apagaba solo. Un evento que trae exactamente la posición
   * escrita no es un gesto y no decide nada.
   */
  const programmaticTopRef = useRef(-1);
  const writeScrollTop = useCallback((el: HTMLDivElement, value: number) => {
    el.scrollTop = value;
    // Se lee de vuelta: el navegador recorta al máximo posible.
    programmaticTopRef.current = el.scrollTop;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (gestureRef.current) {
      pendingBottomRef.current = true;
      return;
    }
    writeScrollTop(el, el.scrollHeight);
    // Un segundo intento tras el layout: las filas nuevas pueden medir
    // distinto una vez pintadas (ajuste de línea). Solo si nadie se ha movido.
    requestAnimationFrame(() => {
      if (followRef.current && !gestureRef.current && ref.current) writeScrollTop(ref.current, ref.current.scrollHeight);
    });
  }, [writeScrollTop]);

  // El anclaje al cargar historial se calcula del modelo (bloques añadidos por
  // delante), no de una foto del alto: ver el efecto de anclaje más abajo.
  const triggerLoadOlder = () => {
    if (!onLoadOlder || loadingOlder || !canLoadOlder || olderRequestedRef.current) return;
    olderRequestedRef.current = true;
    onLoadOlder();
  };
  const triggerLoadOlderRef = useRef(triggerLoadOlder);
  triggerLoadOlderRef.current = triggerLoadOlder;

  /*
   * Historial al llegar arriba, pero solo con el gesto asentado: si se pedía
   * en plena inercia, el desplazamiento que recoloca la lectura sobre las
   * líneas nuevas caía con el dedo aún en juego, iOS lo ignoraba y el visor
   * se quedaba arriba pidiendo página tras página.
   */
  const maybeLoadOlder = useCallback((node: HTMLDivElement) => {
    if (gestureRef.current) return;
    if (node.scrollTop < 120 && node.scrollHeight - node.clientHeight > 200) triggerLoadOlderRef.current();
  }, []);

  const beginGesture = useCallback(() => {
    gestureRef.current = true;
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
  }, []);
  // El gesto se da por acabado cuando dejan de llegar eventos de scroll un
  // rato después de levantar el dedo (la inercia sigue emitiéndolos).
  const settleSoon = useCallback(() => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = 0;
      gestureRef.current = false;
      if (followRef.current && pendingBottomRef.current) {
        pendingBottomRef.current = false;
        scrollToBottom();
      } else if (ref.current) {
        maybeLoadOlder(ref.current);
      }
    }, 180);
  }, [scrollToBottom, maybeLoadOlder]);
  useEffect(() => () => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
  }, []);

  /*
   * `overscroll-behavior: contain` solo cuando hay algo que desplazar (ver
   * .log-body en index.css): un visor corto con ese contain se tragaba el
   * gesto en iOS y la página de detrás no se movía.
   */
  const syncScrollable = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const scrollable = String(el.scrollHeight > el.clientHeight + 1);
    if (el.dataset.scrollable !== scrollable) el.dataset.scrollable = scrollable;
  }, []);

  /*
   * Anclaje del scroll cuando el buffer cambia por delante y no se está
   * siguiendo el final: con historial cargado, la lectura se queda sobre las
   * mismas líneas (se baja lo que miden los bloques nuevos); con un recorte,
   * se sube lo que ha desaparecido por encima.
   */
  useLayoutEffect(() => {
    const el = ref.current;
    const d = model.delta;
    if (!el || !d || followRef.current || model.prevFirstChunkKey === null) return;
    const lay = layoutRef.current;
    if (d.front > 0) {
      const idx = lay.index.get(model.prevFirstChunkKey);
      if (idx !== undefined && idx > 0) el.scrollTop += lay.offsets[idx];
    } else if (d.front < 0 && model.chunks.length) {
      const prevLay = prevLayoutRef.current;
      const j = prevLay.index.get(model.chunks[0].key);
      const removed = (j !== undefined ? prevLay.offsets[j] : 0) + model.partialCut * lay.lineH;
      if (removed > 0) el.scrollTop = Math.max(0, el.scrollTop - removed);
    }
  }, [model]);

  /*
   * Geometría del hueco tras cada render: alto visible, techo del lienzo y
   * caracteres por línea (anchura de la sonda / anchura de la columna de
   * texto). Si cambian las columnas —giro, teclado, numeración o fechas
   * apagadas— las medidas anteriores ya no valen.
   */
  useLayoutEffect(() => {
    const body = ref.current;
    if (!body) return;
    viewportRef.current = body.clientHeight;
    const canvas = canvasRef.current;
    canvasTopRef.current = canvas
      ? canvas.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop
      : 0;
    let cols = 0;
    if (wrap && canvas && probeRef.current) {
      const span = canvas.querySelector<HTMLElement>('.log-text');
      const charW = probeRef.current.getBoundingClientRect().width / PROBE.length;
      if (span && charW > 0) cols = Math.max(1, Math.floor(span.clientWidth / charW));
    }
    if (cols !== colsRef.current) {
      colsRef.current = cols;
      linesCacheRef.current.clear();
      // Las medidas anteriores ya no valen; los bloques pintados se vuelven a
      // medir aquí mismo (el observador solo avisa si CAMBIAN de tamaño).
      const heights = heightsRef.current;
      heights.clear();
      for (const [key, node] of keyElRef.current) {
        const h = node.getBoundingClientRect().height;
        if (h > 0) heights.set(key, h);
      }
      relayout();
    }
    // Siguiendo el final, el fondo se garantiza en CADA render antes de pintar:
    // también cuando lo que cambia es una estimación de alto y no las líneas.
    if (followRef.current) scrollToBottom();
  });


  // Líneas nuevas: siguiendo, se limpia el contador; si no, se cuentan LÍNEAS
  // (no renders: una ráfaga de 300 líneas en un frame decía «+1»).
  useLayoutEffect(() => {
    if (followRef.current) {
      if (unreadCountRef.current !== 0) {
        unreadCountRef.current = 0;
        setUnreadCount(0);
      }
    } else if (model.appended > 0) {
      unreadCountRef.current += model.appended;
      setUnreadCount(unreadCountRef.current);
    }
    syncScrollable();
  }, [model, syncScrollable]);

  // El ajuste de línea cambia el alto del contenido sin cambiar el del hueco.
  useEffect(() => {
    syncScrollable();
  }, [wrap, maximized, syncScrollable]);

  // Si el hueco cambia de alto (acordeón, teclado del móvil, giro) y se estaba
  // siguiendo, el fondo sigue siendo el fondo; si no, se recalcula qué se pinta.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      viewportRef.current = el.clientHeight;
      syncScrollable();
      if (followRef.current) scrollToBottom();
      else relayout();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [maximized, scrollToBottom, syncScrollable, relayout]);

  const startFollowing = useCallback(() => {
    followRef.current = true;
    setFollow(true);
    unreadCountRef.current = 0;
    setUnreadCount(0);
    scrollToBottom();
  }, [scrollToBottom]);

  // Si cambia el filtro o fase, reiniciar a follow y saltar abajo
  useEffect(() => {
    startFollowing();
  }, [stage, level, q, startFollowing]);

  useEffect(() => {
    onFollowChange?.(follow);
  }, [follow, onFollowChange]);

  useEffect(() => {
    if (!loadingOlder) olderRequestedRef.current = false;
  }, [loadingOlder]);

  // Al entrar o salir de pantalla completa el nodo se vuelve a montar en otro
  // sitio y pierde su scroll: se recupera donde estaba (o al fondo, si seguía).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (followRef.current) scrollToBottom();
    else el.scrollTop = lastTopRef.current;
  }, [maximized, scrollToBottom]);

  useEffect(() => {
    if (!maximized) return;
    const root = document.getElementById('root');
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    root?.setAttribute('inert', '');
    root?.setAttribute('aria-hidden', 'true');
    overlayRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setMaximized(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.body.style.overflow = prevOverflow;
      root?.removeAttribute('inert');
      root?.removeAttribute('aria-hidden');
      window.removeEventListener('keydown', onKey, true);
      previouslyFocused?.focus?.();
    };
  }, [maximized]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    // La ref se decide YA, en el propio evento; el estado (que repinta) se
    // agrupa por frame.
    const top = el.scrollTop;
    lastTopRef.current = top;
    scrollTopRef.current = top;
    const programmatic = programmaticTopRef.current >= 0 && Math.abs(top - programmaticTopRef.current) < 1;
    programmaticTopRef.current = -1;
    if (!programmatic) followRef.current = el.scrollHeight - top - el.clientHeight < 45;
    // Scroll con el dedo levantado = inercia: el gesto sigue vivo hasta que pare.
    if (gestureRef.current) settleSoon();
    if (scrollRaf.current) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0;
      const node = ref.current;
      if (!node) return;
      setFollow(followRef.current);
      if (followRef.current && unreadCountRef.current !== 0) {
        unreadCountRef.current = 0;
        setUnreadCount(0);
      }
      if (!followRef.current) {
        // El hueco visible se acerca al borde de lo pintado: se mueve el tramo.
        const lay = layoutRef.current;
        const t = scrollTopRef.current;
        const vp = node.clientHeight;
        const lo = lay.offsets[lay.start] + lay.canvasTop;
        const hi = lay.offsets[lay.end + 1] + lay.canvasTop;
        const n = lay.offsets.length - 1;
        if ((lay.start > 0 && t - OVERSCAN_PX / 2 < lo) || (lay.end < n - 1 && t + vp + OVERSCAN_PX / 2 > hi)) relayout();
      }
      maybeLoadOlder(node);
    });
  };

  useEffect(() => () => {
    if (scrollRaf.current) cancelAnimationFrame(scrollRaf.current);
  }, []);

  const jump = (to: 'top' | 'bottom') => {
    const el = ref.current;
    if (!el) return;
    if (to === 'top') {
      followRef.current = false;
      setFollow(false);
      writeScrollTop(el, 0);
    } else {
      startFollowing();
    }
  };

  const plainText = (includeTimestamps = showTs) => {
    return visible
      .map((v) => (includeTimestamps && v.tsString ? `${v.tsString} ${v.row.cleanText}` : v.row.cleanText))
      .join('\n');
  };

  const copyAll = () => {
    if (visible.length === 0) return;
    const count = visible.length;
    void copyToClipboard(plainText(showTs)).then((ok) => {
      if (ok) {
        setCopied(true);
        window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1400);
        toast(`Se han copiado ${NF.format(count)} líneas al portapapeles.`, 'ok');
      } else {
        toast('No se ha podido copiar al portapapeles. Seleccione el texto y cópielo manualmente.', 'err');
      }
    });
  };

  const download = () => {
    const blob = new Blob([plainText(true)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName ?? `logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    a.click();
    // En diferido: revocar en el acto puede abortar la descarga en Firefox.
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const clearBuffer = () => {
    setClearedUntil(lines.length);
  };

  const filtering = level !== 'all' || stage !== 'all' || q.length > 0;
  const showChrome = toolbar || !!title || maximized || !!extraHeaderLeft || !!extraHeaderRight;
  // Ancho del canalón según el mayor número de línea que se pinta (mínimo tres cifras).
  const maxLineNo = visible.length ? visible[visible.length - 1].id - origin : 0;
  const gutterCh = Math.max(3, String(maxLineNo).length) + 0.8;

  const levelChip = (key: LevelFilter, label: string, n?: number, tone?: 'err' | 'warn') => (
    <button
      type="button"
      onClick={() => setLevel(key)}
      aria-pressed={level === key}
      className={cx(
        'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors duration-150 max-sm:h-9',
        level === key
          ? tone === 'err'
            ? 'bg-err/[.18] text-err font-semibold'
            : tone === 'warn'
              ? 'bg-warn/[.18] text-warn font-semibold'
              : 'bg-acc/[.18] text-acc-soft font-semibold'
          : 'text-subtle hover:bg-surface2 hover:text-txt',
      )}
    >
      {tone && <span className={cx('h-[5px] w-[5px] rounded-full', tone === 'err' ? 'bg-err' : 'bg-warn')} />}
      {label}
      {n !== undefined && n > 0 && <span className="tnum opacity-85 font-mono">{NF.format(n)}</span>}
    </button>
  );

  const shell = (
    <section
      className={cx(
        'log-shell relative flex min-h-0 w-full flex-col overflow-hidden bg-term',
        maximized ? 'rounded-none' : cx(!bare && 'rounded-xl border border-line shadow-sm', className),
      )}
      style={{ '--gutter-ch': gutterCh } as React.CSSProperties}
      onKeyDown={(e) => {
        // Ctrl/⌘+F con el foco dentro de la consola busca AQUÍ, no en la página:
        // el placeholder lo prometía y no había nada detrás.
        if (toolbar && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
        }
      }}
    >
      {showChrome && (
        <div className="flex shrink-0 items-center justify-between gap-2.5 border-b border-line bg-term2 px-3 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            {extraHeaderLeft}
            {title && (
              <span className="truncate font-mono eyebrow text-sub">
                {title}
              </span>
            )}
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-subtle">
              {!toolbar && (
                <span
                  className={cx('h-[6px] w-[6px] rounded-full', follow ? 'pulse-soft bg-ok' : 'bg-subtle')}
                  title={follow ? 'En vivo' : 'En pausa'}
                />
              )}
              <span className="tnum font-medium text-txt/80">{NF.format(rows.length)}</span>
              <span>líneas</span>
              {replicas > 1 && (
                <span className="hidden text-subtle sm:inline" title="Las líneas de cada réplica llevan su prefijo [rN]">
                  · {replicas} réplicas
                </span>
              )}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {extraHeaderRight}
            <ToolButton
              title={maximized ? 'Restaurar (Esc)' : 'Pantalla completa'}
              onClick={() => setMaximized((m) => !m)}
            >
              {maximized ? <Minimize2 size={15} /> : <Maximize2 size={14} />}
            </ToolButton>
            {maximized && (
              <ToolButton title="Cerrar (Esc)" onClick={() => setMaximized(false)}>
                <X size={16} />
              </ToolButton>
            )}
          </div>
        </div>
      )}

      {/* ── TOOLBAR LIMPIA Y RESPONSIVA (SIN CONFLICTOS DE ICONOS) ── */}
      {toolbar && (
        <div className="flex shrink-0 flex-col gap-2 border-b border-line bg-term2 px-2.5 py-2 sm:flex-row sm:items-center sm:justify-between">
          {/* Fila izquierda: Buscador + Filtros de nivel */}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 sm:gap-2">
            {/* Buscador interactivo */}
            <div className="flex h-8 min-w-[140px] flex-1 items-center gap-2 rounded-lg border border-line bg-term px-2.5 focus-within:border-acc">
              <Search size={13} className="shrink-0 text-subtle" />
              <input
                ref={searchRef}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Buscar en el registro"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                enterKeyHint="search"
                // El 16px del móvil lo pone la regla global anti-zoom de iOS; aquí solo el escritorio.
                className="min-w-0 flex-1 bg-transparent font-mono text-txt outline-none placeholder:text-subtle sm:text-xs"
              />
              {filter && (
                <div className="flex items-center gap-1">
                  <span className="text-micro text-subtle tabular-nums font-mono">
                    {NF.format(visible.length)} {visible.length === 1 ? 'coincidencia' : 'coincidencias'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setFilter('')}
                    className="press shrink-0 text-subtle hover:text-txt"
                    title="Limpiar filtro"
                    aria-label="Limpiar filtro"
                  >
                    <X size={12} />
                  </button>
                </div>
              )}
            </div>

            {/* Filtros de nivel */}
            <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-term p-0.5 border border-line">
              {levelChip('all', 'Todo')}
              {levelChip('err', 'Errores', counts.err, 'err')}
              {levelChip('warn', 'Avisos', counts.warn, 'warn')}
            </div>
          </div>

          {/* Fila derecha: Botones de acción sin solapamiento */}
          <div className="flex shrink-0 items-center justify-between sm:justify-end gap-1">
            {/* Lo que se usa a diario, con su nombre puesto: bajar al último
                error, copiar lo que se ve y llevarse el log. Lo demás vive en
                «Vista», que es donde se busca lo que se toca una vez. En el
                móvil «Al final» sobra: cuando no se sigue el final, el botón
                flotante ya lo ofrece, y la fila no da para cuatro rótulos. */}
            <button
              type="button"
              onClick={() => jump('bottom')}
              className="press hidden h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-sub transition-colors hover:bg-surface2 hover:text-txt sm:flex sm:h-8"
              title="Ir al final del registro"
            >
              {/* Distinto del icono de descargar: a 14px eran dos flechas iguales. */}
              <ChevronsDown size={14} aria-hidden />
              <span>Al final</span>
            </button>
            <button
              type="button"
              onClick={copyAll}
              disabled={visible.length === 0}
              className="press flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-sub transition-colors hover:bg-surface2 hover:text-txt disabled:opacity-40 sm:h-8"
              title="Copiar las líneas visibles al portapapeles"
            >
              {copied ? <Check size={14} className="pop-in text-ok" aria-hidden /> : <Copy size={14} aria-hidden />}
              <span>{copied ? 'Copiado' : 'Copiar'}</span>
            </button>
            <button
              type="button"
              onClick={onDownload ?? download}
              disabled={!onDownload && visible.length === 0}
              className="press flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-sub transition-colors hover:bg-surface2 hover:text-txt disabled:opacity-40 sm:h-8"
              title={onDownload ? 'Descargar el registro completo' : 'Descargar el registro'}
            >
              <Download size={14} aria-hidden />
              <span>Descargar</span>
            </button>

            <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-line" />

            <div className="relative">
              <button
                type="button"
                onClick={() => setViewMenuOpen((o) => !o)}
                aria-expanded={viewMenuOpen}
                className={cx(
                  'press flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors sm:h-8',
                  viewMenuOpen ? 'bg-surface2 text-txt' : 'text-sub hover:bg-surface2 hover:text-txt',
                )}
                title="Opciones de visualización del registro"
              >
                <SlidersHorizontal size={14} aria-hidden />
                <span>Vista</span>
              </button>
              <Menu open={viewMenuOpen} onClose={() => setViewMenuOpen(false)} align="right" className="w-[248px]">
                <div>
                  <p className="px-2.5 py-1 eyebrow text-subtle">Vista</p>
                  <MenuItem icon={<Hash size={14} />} active={gutter} onClick={() => setGutter((g) => !g)}>
                    <span className="flex items-center justify-between gap-2">
                      Numerar líneas
                      {gutter && <Check size={13} className="shrink-0 text-acc-soft" />}
                    </span>
                  </MenuItem>
                  <MenuItem icon={<WrapText size={14} />} active={wrap} onClick={() => setWrap((w) => !w)}>
                    <span className="flex items-center justify-between gap-2">
                      Ajuste de línea
                      {wrap && <Check size={13} className="shrink-0 text-acc-soft" />}
                    </span>
                  </MenuItem>
                  <MenuItem icon={<Clock size={14} />} active={showTs} onClick={() => setShowTs((v) => !v)}>
                    <span className="flex items-center justify-between gap-2">
                      Marcas de tiempo
                      {showTs && <Check size={13} className="shrink-0 text-acc-soft" />}
                    </span>
                  </MenuItem>
                  {/* El formato solo aparece cuando las fechas están puestas:
                      elegir entre cuatro formatos de algo oculto no significa nada. */}
                  {showTs && (
                    <div className="mb-1 ml-4 flex flex-col border-l border-line pl-1.5">
                      {(
                        [
                          { key: 'time', label: 'Hora (HH:mm:ss)' },
                          { key: 'datetime', label: 'Fecha y hora' },
                          { key: 'utc', label: 'Hora UTC' },
                          { key: 'relative', label: 'Tiempo relativo' },
                        ] as const
                      ).map((opt) => (
                        <MenuItem key={opt.key} active={tsFormat === opt.key} onClick={() => setTsFormat(opt.key)}>
                          <span className="flex items-center justify-between gap-2 text-xs">
                            {opt.label}
                            {tsFormat === opt.key && <Check size={13} className="shrink-0 text-acc-soft" />}
                          </span>
                        </MenuItem>
                      ))}
                    </div>
                  )}

                  <div className="my-1 border-t border-line" />

                  <MenuItem
                    icon={<ArrowUpToLine size={14} />}
                    onClick={() => {
                      jump('top');
                      setViewMenuOpen(false);
                    }}
                  >
                    Ir al principio
                  </MenuItem>
                  {clearedUntil === 0 ? (
                    <MenuItem
                      icon={<Trash2 size={14} />}
                      onClick={clearBuffer}
                      className={cx(visible.length === 0 && 'pointer-events-none opacity-40')}
                    >
                      Limpiar la vista
                    </MenuItem>
                  ) : (
                    <MenuItem icon={<Trash2 size={14} />} onClick={() => setClearedUntil(0)}>
                      Restaurar {NF.format(clearedUntil)} líneas ocultas
                    </MenuItem>
                  )}
                </div>
              </Menu>
            </div>
          </div>
        </div>
      )}

      {/* Solo aparece cuando tiene algo que contar: un aviso, un filtro activo
          o el seguimiento en vivo. Vacía era una franja de cromo sin función. */}
      {toolbar && (statusNote || filtering || follow) && (
        <div className="flex shrink-0 items-center justify-between gap-2.5 border-b border-line bg-term2 px-3 py-1.5 text-xs text-subtle">
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
            {statusNote ? (
              <span className="font-medium text-warn">{statusNote}</span>
            ) : filtering ? (
              <span>
                <span className="tnum font-medium text-txt/90">{NF.format(visible.length)}</span> de{' '}
                <span className="tnum">{NF.format(rows.length)}</span> líneas
              </span>
            ) : null}
          </span>

          {/* Con un aviso del servidor («Docker no está disponible») no se
              está en vivo de nada: las dos cosas a la vez se contradecían. */}
          {follow && !statusNote && (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-ok">
              <span className="pulse-soft h-1.5 w-1.5 rounded-full bg-ok" />
              En vivo
            </span>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1 w-full overflow-hidden">
        <div
          ref={ref}
          onScroll={onScroll}
          onTouchStart={beginGesture}
          onTouchEnd={settleSoon}
          onTouchCancel={settleSoon}
          className={cx(
            // Tamaño propio de terminal (fuera de la escala de la interfaz):
            // aquí manda la legibilidad de la monoespaciada, no la jerarquía.
            'log-body h-full w-full font-mono text-[12.5px] leading-[1.65] text-txt/90',
            maximized && 'text-[13.5px] leading-[1.7]',
            wrap ? 'overflow-y-auto overflow-x-hidden' : 'overflow-auto',
          )}
          role="log"
          tabIndex={0}
        >
          {/* Sonda: mide la anchura de un carácter con la letra y el tamaño de la consola. */}
          <span ref={probeRef} aria-hidden className="log-probe">
            {PROBE}
          </span>

          {canLoadOlder ? (
            <div className="flex justify-center p-2.5">
              <button
                type="button"
                onClick={triggerLoadOlder}
                disabled={loadingOlder}
                className="press inline-flex items-center gap-1.5 rounded-lg border border-line bg-term2 px-3 py-1 text-xs text-sub hover:text-txt disabled:opacity-50 max-sm:h-9"
              >
                {loadingOlder ? 'Cargando líneas anteriores…' : 'Cargar líneas anteriores'}
              </button>
            </div>
          ) : (
            startReached &&
            visible.length > 0 && (
              <div className="flex justify-center p-2.5 font-sans">
                <span className="eyebrow text-subtle">Principio del registro</span>
              </div>
            )
          )}

          {visible.length === 0 ? (
            <div className="flex h-full min-h-[140px] items-center justify-center p-6 text-center font-sans">
              {state === 'loading' ? (
                <Spinner label="Cargando el registro…" />
              ) : state === 'error' ? (
                <ErrorState compact title="No se ha podido cargar el registro" onRetry={onRetry} />
              ) : (
                <span className="max-w-sm text-balance text-xs leading-5 text-subtle">
                  {filtering ? 'Ninguna línea coincide con los filtros aplicados.' : emptyMessage ?? 'No hay registros disponibles.'}
                </span>
              )}
            </div>
          ) : (
            /* El lienzo: relleno arriba y abajo con el alto de los bloques que
               no se pintan, y en medio solo los del tramo visible. Sin ajuste
               de línea es tan ancho como la línea más larga, para que el
               canalón y las filas compartan anchura al desplazar de lado. */
            <div
              ref={canvasRef}
              className={cx('log-canvas', wrap ? 'w-full' : 'w-max min-w-full')}
              style={{
                paddingTop: layout.offsets[start],
                paddingBottom: Math.max(0, layout.total - layout.offsets[end + 1]),
              }}
            >
              {chunks.slice(start, end + 1).map((c) => (
                <LogChunk
                  key={c.key}
                  chunkKey={c.key}
                  rows={c.rows}
                  origin={origin}
                  wrap={wrap}
                  gutter={gutter}
                  showTs={showTs}
                  query={q}
                  onMeasure={onMeasure}
                />
              ))}
            </div>
          )}
        </div>

        {/* Botón flotante para volver al final si el usuario scrollea hacia arriba */}
        {!follow && visible.length > 0 && (
          <div className="absolute bottom-3 right-4 z-20 pop-in">
            <button
              type="button"
              onClick={() => jump('bottom')}
              className="press flex items-center gap-2 rounded-full border border-line bg-surface/95 px-3 py-1.5 text-xs font-semibold text-txt shadow-modal backdrop-blur-md hover:bg-surface2"
            >
              <ArrowDown size={13} className="text-acc" />
              <span>Ir al final</span>
              {unreadCount > 0 && (
                <span className="rounded-full bg-acc px-1.5 py-0.5 text-micro font-bold text-white">
                  +{unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>
          </div>
        )}
      </div>
    </section>
  );

  if (maximized) {
    return createPortal(
      <div
        ref={overlayRef}
        role="dialog"
        aria-modal="true"
        aria-label={title ? `${title} — pantalla completa` : 'Consola de registro'}
        tabIndex={-1}
        // El relleno inferior respeta la barra de gestos del móvil: si no, el
        // botón «Ir al final» y la última línea quedaban debajo de ella.
        className="console-in fixed inset-0 z-50 flex flex-col bg-bg p-3 pb-[max(12px,env(safe-area-inset-bottom))] outline-none sm:p-5"
      >
        <div className="h-full w-full overflow-hidden rounded-xl border border-line shadow-modal">
          {shell}
        </div>
      </div>,
      document.body,
    );
  }

  return shell;
}

const LogViewer = memo(LogViewerImpl);
export default LogViewer;
