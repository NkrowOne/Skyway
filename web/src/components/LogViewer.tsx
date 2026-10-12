import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown,
  ArrowUpToLine,
  Check,
  CircleHelp,
  Clock,
  Copy,
  Download,
  Hash,
  LocateFixed,
  Maximize2,
  Minimize2,
  Pause,
  Play,
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
export type TimestampFormat = 'datetime' | 'time' | 'utc' | 'relative';

/** Formateador de miles reutilizable (locale fija). */
const NF = new Intl.NumberFormat('es');

/*
 * Formateadores de fecha fijos. `toLocaleString` construye uno nuevo en cada
 * llamada, y aquí se formatea una vez por línea pintada.
 */
const TIME_FMT = new Intl.DateTimeFormat('es-ES', { hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const DAY_FMT = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short' });
const UTC_TIME_FMT = new Intl.DateTimeFormat('es-ES', {
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'UTC',
});
const UTC_DAY_FMT = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', timeZone: 'UTC' });
const FULL_FMT = new Intl.DateTimeFormat('es-ES', { dateStyle: 'full', timeStyle: 'long' });

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
/**
 * Alto fijo de la franja de «Cargar líneas anteriores». Al ser fijo, el techo
 * del lienzo se conoce sin medir nada: antes se medía en cada render con
 * `getBoundingClientRect`, y en el móvil cada ráfaga forzaba una maquetación
 * completa de la consola.
 */
const BANNER_H = 44;

/* ───────────────────────── Análisis de cada línea ────────────────────────── */

/*
 * Nivel declarado por la propia línea: JSON (`"level":"error"`, pino con
 * `"level":50`), logfmt (`level=warn`) o una etiqueta al principio
 * (`ERROR`, `[warn]`, `npm WARN`). Manda sobre la heurística: «INFO: 0
 * errores» no es un error aunque diga «errores».
 */
const LEVEL_JSON = /"(?:level|severity|lvl|levelname|loglevel|log\.level)"\s*:\s*"?([A-Za-z]+|\d{2})\b/;
const LEVEL_KV = /(?:^|[\s,;])(?:level|lvl|severity)=["']?([A-Za-z]+)/i;
const LEVEL_TAG =
  /^.{0,48}?(?:\b(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRIT|CRITICAL|PANIC|EMERG|ALERT|SEVERE)\b|\[(trace|debug|info|notice|warn|warning|error|err|fatal|crit|critical|panic|emerg|alert)\])/;
/*
 * Heurística para el texto libre, con palabras completas: «errorHandler» o
 * «ERROR_LOG» no son errores. `\b` no basta: trata «-», «.», «/» y «@» como
 * separadores, y un `npm install` sano se llenaba de «errores» por paquetes
 * como `http-errors@2.0.0` o `node_modules/error-ex`. Sin lookbehind, que
 * Safari anterior a la 16.4 no entiende.
 */
const WORD_START = '(?:^|[^\\w.@/-])';
const WORD_END = '(?=$|[^\\w@/.-]|\\.(?![\\w-]))';
const ERR_HINT = new RegExp(`${WORD_START}(?:errors?|fatal|panic|exception|traceback|uncaught)${WORD_END}|✖|❌|✗`, 'i');
/** TypeError, ValueError, NullPointerException…: sin límite de palabra delante. */
const ERR_CLASS = /[A-Z][a-zA-Z]*(?:Error|Exception)\b/;
const ERR_NONE = /\b(?:0|no|zero|sin|without)\s+(?:errors?|errores|exceptions?)\b/i;
const WARN_HINT = new RegExp(`${WORD_START}(?:warn|warning|warnings|deprecated|deprecation)${WORD_END}|⚠`, 'i');
const WARN_NONE = /\b(?:0|no|zero|sin|without)\s+(?:warnings?|avisos)\b/i;

function levelFromWord(word: string): Level {
  if (/^\d+$/.test(word)) {
    // Escala numérica de pino/bunyan: 40 aviso, 50 error, 60 fatal.
    const n = Number(word);
    return n >= 50 ? 'err' : n >= 40 ? 'warn' : 'plain';
  }
  const w = word.toLowerCase();
  if (w.startsWith('warn')) return 'warn';
  if (
    w === 'error' ||
    w === 'err' ||
    w === 'fatal' ||
    w.startsWith('crit') ||
    w === 'panic' ||
    w.startsWith('emerg') ||
    w === 'alert' ||
    w === 'severe'
  ) {
    return 'err';
  }
  return 'plain';
}

export function detectLevel(text: string): Level {
  const declared = LEVEL_JSON.exec(text) ?? LEVEL_KV.exec(text);
  if (declared) return levelFromWord(declared[1]);
  const tag = LEVEL_TAG.exec(text);
  if (tag) return levelFromWord(tag[1] ?? tag[2]);
  if ((ERR_HINT.test(text) || ERR_CLASS.test(text)) && !ERR_NONE.test(text)) return 'err';
  if (WARN_HINT.test(text) && !WARN_NONE.test(text)) return 'warn';
  return 'plain';
}

export interface ParsedRow {
  raw: string;
  cleanText: string;
  /** Instante de la línea (ms), si trae un sello con fecha. */
  ts: number | null;
  /** Sello solo con hora (HH:mm:ss) de registros antiguos, que no traen fecha. */
  clock: string | null;
  lvl: Level;
}

/**
 * Sello ISO de Docker o del servidor al principio de la línea (fracción de 0
 * a 9 cifras). Solo con zona (`Z` o desfase): uno sin zona puede ser UTC o la
 * hora local del contenedor, y leerlo como hora del navegador la desplazaba;
 * se deja en el texto tal cual lo escribió la aplicación.
 */
const ISO_HEAD = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:[.,](\d{1,9}))?(Z|[+-]\d{2}:?\d{2})(?=\s|$)/;
const CLOCK_HEAD = /^(\d{2}:\d{2}:\d{2})(?:\.\d+)?\s/;

/** Parsea una línea de log: sello de tiempo (ISO/Docker o la hora sola de los registros antiguos) y nivel. */
export function parseRawLine(raw: string): ParsedRow {
  let text = (raw.includes('\u001b') ? stripAnsi(raw) : raw).trimEnd();
  let ts: number | null = null;
  let clock: string | null = null;

  const c0 = text.charCodeAt(0);
  if (c0 >= 48 && c0 <= 57) {
    const m = ISO_HEAD.exec(text);
    if (m) {
      /*
       * Se normaliza antes de `Date.parse`: Safari no entiende el espacio en
       * vez de la «T», ni más de tres cifras de fracción (Docker da nueve).
       */
      const ms = (m[3] ?? '').padEnd(3, '0').slice(0, 3);
      const zone = m[4] === 'Z' || m[4].includes(':') ? m[4] : `${m[4].slice(0, 3)}:${m[4].slice(3)}`;
      const t = Date.parse(`${m[1]}T${m[2]}.${ms}${zone}`);
      if (Number.isFinite(t)) {
        ts = t;
        text = text.slice(m[0].length).trimStart();
      }
    } else {
      const k = CLOCK_HEAD.exec(text);
      if (k) {
        clock = k[1];
        text = text.slice(k[0].length).trimStart();
      }
    }
  }

  // Barras de progreso (`\r`): de cada línea solo cuenta lo último que se pintó.
  const cr = text.lastIndexOf('\r');
  if (cr >= 0) text = text.slice(cr + 1);

  return { raw, cleanText: text, ts, clock, lvl: detectLevel(text) };
}

/* ───────────────────────── Marcas de tiempo ──────────────────────────────── */

/** «12 oct»: algunas versiones de ICU añaden un punto a la abreviatura. */
function dayLabel(fmt: Intl.DateTimeFormat, d: Date): string {
  return fmt.format(d).replace('.', '');
}

export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 5) return 'ahora';
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86_400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86_400)} d`;
}

function formatTs(ts: number, format: TimestampFormat): string {
  const d = new Date(ts);
  switch (format) {
    case 'time':
      return TIME_FMT.format(d);
    case 'utc':
      return `${dayLabel(UTC_DAY_FMT, d)} ${UTC_TIME_FMT.format(d)}`;
    case 'relative':
      return relativeTime(ts);
    default:
      return `${dayLabel(DAY_FMT, d)} ${TIME_FMT.format(d)}`;
  }
}

/** Anchura de la columna de hora por formato, en caracteres. */
const TS_CH: Record<TimestampFormat, number> = { datetime: 16, time: 8, utc: 16, relative: 11 };

/*
 * Texto de la hora por fila y formato, calculado solo para las filas que se
 * pintan y una sola vez. Antes se formateaban las catorce mil del buffer (y
 * su tooltip con tres fechas más) en cada cambio de filtro: era lo que dejaba
 * el móvil sin responder al cambiar de pestaña. El relativo cambia con el
 * reloj y no se guarda.
 */
const TS_CACHE = new WeakMap<ParsedRow, Partial<Record<TimestampFormat, string>>>();
export function tsText(r: ParsedRow, format: TimestampFormat): string {
  if (r.ts === null) return r.clock ?? '';
  if (format === 'relative') return relativeTime(r.ts);
  let c = TS_CACHE.get(r);
  if (!c) {
    c = {};
    TS_CACHE.set(r, c);
  }
  let s = c[format];
  if (s === undefined) {
    s = formatTs(r.ts, format);
    c[format] = s;
  }
  return s;
}

/* ───────────────────────── Búsqueda ──────────────────────────────────────── */

/**
 * Consulta de búsqueda con la sintaxis habitual de los visores de logs
 * (Railway, Papertrail, Datadog): palabras sueltas (todas), «"frase exacta"»,
 * «-excluir», «OR» entre alternativas, «/expresión regular/» y
 * «level:error» / «level:warn». Sin distinguir mayúsculas.
 */
export interface LogQuery {
  active: boolean;
  test: (text: string, lvl: Level) => boolean;
  /**
   * Expresiones de lo buscado, una por término positivo (globales, sin
   * distinguir mayúsculas). Van por separado: unidas en una sola, un `\1` de
   * un término apuntaba al grupo de otro y el resaltado no casaba con el filtro.
   */
  marks: readonly RegExp[];
  /** Aviso para quien busca, si algo no se ha podido interpretar. */
  error: string | null;
}

interface Term {
  neg: boolean;
  re: RegExp | null;
  lvl: Level | null;
}

const NO_MARKS: readonly RegExp[] = [];
const EMPTY_QUERY: LogQuery = { active: false, test: () => true, marks: NO_MARKS, error: null };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const literal = (s: string) => new RegExp(escapeRe(s), 'i');

function levelKeyword(v: string): Level | null {
  const w = v.toLowerCase();
  if (w === 'error' || w === 'errors' || w === 'err' || w === 'errores') return 'err';
  if (w === 'warn' || w === 'warning' || w === 'warnings' || w === 'aviso' || w === 'avisos') return 'warn';
  return null;
}

/** Barra de cierre de una expresión regular: la siguiente sin escapar que va seguida de espacio o del final. */
function regexEnd(src: string, from: number): number {
  for (let j = from + 1; j < src.length; j++) {
    if (src[j] === '\\') {
      j++;
      continue;
    }
    if (src[j] === '/' && (j + 1 === src.length || /\s/.test(src[j + 1]))) return j;
  }
  return -1;
}

export function parseQuery(input: string): LogQuery {
  const src = input.trim();
  if (!src) return EMPTY_QUERY;
  const alts: Term[][] = [[]];
  const marks: RegExp[] = [];
  let error: string | null = null;
  const n = src.length;
  let i = 0;
  while (i < n) {
    if (/\s/.test(src[i])) {
      i++;
      continue;
    }
    // «OR» en mayúsculas y como palabra suelta separa alternativas.
    if (src.startsWith('OR', i) && (i + 2 === n || /\s/.test(src[i + 2]))) {
      if (alts[alts.length - 1].length) alts.push([]);
      i += 2;
      continue;
    }
    let neg = false;
    if (src[i] === '-' && i + 1 < n && !/\s/.test(src[i + 1])) {
      neg = true;
      i++;
    }
    let re: RegExp | null = null;
    let lvl: Level | null = null;
    if (src[i] === '"') {
      const end = src.indexOf('"', i + 1);
      const body = end < 0 ? src.slice(i + 1) : src.slice(i + 1, end);
      i = end < 0 ? n : end + 1;
      if (!body) continue;
      re = literal(body);
    } else if (src[i] === '/') {
      const end = regexEnd(src, i);
      if (end > i + 1) {
        const body = src.slice(i + 1, end);
        i = end + 1;
        try {
          re = new RegExp(body, 'i');
        } catch {
          error = 'La expresión regular no es válida: se busca como texto.';
          re = literal(body);
        }
      }
    }
    if (!re) {
      let j = i;
      while (j < n && !/\s/.test(src[j])) j++;
      const word = src.slice(i, j);
      i = j;
      if (!word) continue;
      const kv = /^@?(?:level|nivel):(\w+)$/i.exec(word);
      lvl = kv ? levelKeyword(kv[1]) : null;
      if (!lvl) re = literal(word);
    }
    alts[alts.length - 1].push({ neg, re, lvl });
    if (!neg && re) marks.push(new RegExp(re.source, 'gi'));
  }
  const groups = alts.filter((a) => a.length > 0);
  if (!groups.length) return error ? { ...EMPTY_QUERY, error } : EMPTY_QUERY;

  const hit = (t: Term, text: string, lvl: Level) => (t.lvl ? lvl === t.lvl : t.re!.test(text));
  return {
    active: true,
    test: (text, lvl) => groups.some((g) => g.every((t) => hit(t, text, lvl) !== t.neg)),
    marks: marks.length ? marks : NO_MARKS,
    error,
  };
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

/**
 * Lo que se enseña mientras se lee sin seguir el final. Las líneas nuevas se
 * siguen recibiendo, pero no entran en la vista hasta reanudar: lo que se
 * está leyendo no se mueve y, con la vista quieta, no hay nada que repintar
 * (en el móvil, una consola que no paraba de crecer bajo el dedo era lo que
 * la dejaba sin respuesta). Sí entra el historial que se carga por delante, y
 * lo que el buffer recorta por delante sale también de la vista.
 */
export function freezeLines(frozen: readonly string[], lines: readonly string[]): readonly string[] {
  if (frozen === lines) return frozen;
  const d = diffLines(frozen, lines);
  if (d.kept === 0) return lines;
  if (d.front > 0) return lines.slice(0, d.front + d.kept);
  if (d.front < 0) return lines.slice(0, d.kept);
  return frozen;
}

export interface VisibleRow {
  /**
   * Identidad estable de la fila desde que se abrió el visor: no cambia al
   * recortar por delante ni al cargar historial. El número que se pinta es
   * `id - origin`.
   */
  id: number;
  row: ParsedRow;
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
  /** Texto buscado, ya recortado (sintaxis de `parseQuery`). */
  q: string;
  level: LevelFilter;
}

export interface ViewModel {
  lines: readonly string[];
  key: string;
  /** Cambia cada vez que se empieza de cero (otra fuente): los ids dejan de valer. */
  gen: number;
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
  /** Filas visibles añadidas al FINAL en este paso. */
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
      key: '',
      gen: 0,
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
  return `${o.q}\u0000${o.level}`;
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

function makeMatcher(o: ViewOptions): (r: ParsedRow) => boolean {
  const { level } = o;
  const query = parseQuery(o.q);
  if (!query.active) return level === 'all' ? () => true : (r) => r.lvl === level;
  return (r) => (level === 'all' || r.lvl === level) && query.test(r.cleanText, r.lvl);
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
  if (prev.lines === lines && prev.key === key) return prev;

  const sameLines = prev.lines === lines;
  const delta: LinesDelta = sameLines ? { front: 0, kept: prev.rows.length } : diffLines(prev.lines, lines);
  const reset = !sameLines && delta.kept === 0;
  const cache = state.cache;
  const parse = (raw: string): ParsedRow => {
    let r = cache.get(raw);
    if (!r) {
      r = parseRawLine(raw);
      cache.set(raw, r);
    }
    return r;
  };

  let rows: ParsedRow[];
  let firstId: number;
  let origin: number;
  let counts: Counts;
  let gen = prev.gen;
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
    gen++;
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
  const mk = (i: number): VisibleRow => ({ id: firstId + i, row: rows[i] });

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
    key,
    gen,
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

/** Índice del bloque que contiene la fila `id` (los bloques van en orden de id), o -1. */
function chunkIndexOf(chunks: Chunk[], id: number): number {
  let a = 0;
  let b = chunks.length - 1;
  while (a <= b) {
    const m = (a + b) >> 1;
    const rows = chunks[m].rows;
    if (id < rows[0].id) b = m - 1;
    else if (id > rows[rows.length - 1].id) a = m + 1;
    else return rows.some((v) => v.id === id) ? m : -1;
  }
  return -1;
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
  /** Bloques con alto medido (los que han servido para calibrar `lineH`). */
  measuredCount: number;
  /** Alto de la franja de «Cargar líneas anteriores» (0 si no está). */
  bannerTop: number;
  /**
   * Distancia del techo del contenido del scroller al punto 0 de `offsets`:
   * la franja más la corrección del gesto (`padAdj`).
   */
  canvasTop: number;
}

const EMPTY_LAYOUT: Layout = {
  offsets: [0],
  total: 0,
  lineH: DEFAULT_LINE_H,
  measuredCount: 0,
  index: new Map(),
  start: 0,
  end: -1,
  bannerTop: 0,
  canvasTop: 0,
};

/**
 * Alto medido de un bloque, con las filas que tenía al medirlo: un bloque que
 * conserva su clave pero cambia de filas (el último al llegar líneas, el
 * primero al recortar) ya no mide lo mismo, y su medida vieja descuadraba el
 * relleno de arriba.
 */
type Heights = Map<number, { rows: VisibleRow[]; h: number }>;

function measured(heights: Heights, c: Chunk): number | undefined {
  const m = heights.get(c.key);
  return m && m.rows === c.rows ? m.h : undefined;
}

/**
 * `fixedLineH`: alto de línea con el que estimar, o null para calibrarlo con
 * los bloques medidos. Mientras se lee se deja fijo: recalibrarlo cambiaba la
 * estimación de todos los bloques de arriba a la vez, el relleno superior con
 * ellos, y el texto saltaba bajo el dedo.
 */
function computeLayout(
  chunks: Chunk[],
  heights: Heights,
  estLines: (c: Chunk) => number,
  fixedLineH: number | null,
  fallbackLineH: number,
): Layout {
  const n = chunks.length;
  let lineH = fixedLineH ?? fallbackLineH;
  let measuredCount = 0;
  if (fixedLineH === null) {
    let px = 0;
    let ln = 0;
    for (const c of chunks) {
      const h = measured(heights, c);
      if (h !== undefined) {
        px += h;
        ln += estLines(c);
        measuredCount++;
      }
    }
    if (ln > 0 && px > 0) lineH = px / ln;
  }
  const offsets = new Array<number>(n + 1);
  const index = new Map<number, number>();
  let off = 0;
  for (let i = 0; i < n; i++) {
    const c = chunks[i];
    offsets[i] = off;
    index.set(c.key, i);
    const h = measured(heights, c);
    off += h !== undefined ? h : estLines(c) * lineH;
  }
  offsets[n] = off;
  // Medidas de bloques que ya no existen: se podan cuando abultan.
  if (heights.size > n + 256) {
    for (const k of heights.keys()) if (!index.has(k)) heights.delete(k);
  }
  return { offsets, total: off, lineH, measuredCount, index, start: 0, end: -1, bannerTop: 0, canvasTop: 0 };
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

/**
 * Desplazamiento del lienzo: relleno superior y, si la corrección del gesto
 * lo deja por debajo de cero, margen negativo. Recortarlo a cero perdía esa
 * parte y el texto saltaba igualmente junto al principio.
 */
function canvasOffset(top: number): { paddingTop: number; marginTop: number } {
  return top >= 0 ? { paddingTop: top, marginTop: 0 } : { paddingTop: 0, marginTop: top };
}

function applyCanvasOffset(canvas: HTMLElement | null, top: number): void {
  if (!canvas) return;
  const o = canvasOffset(top);
  canvas.style.paddingTop = `${o.paddingTop}px`;
  canvas.style.marginTop = `${o.marginTop}px`;
}

/* ───────────────────────── Preferencias de vista ─────────────────────────── */

interface ViewPrefs {
  wrap: boolean;
  gutter: boolean;
  showTs: boolean;
  tsFormat: TimestampFormat;
}

const PREFS_KEY = 'skyway.logs.vista';
const TS_FORMATS: readonly TimestampFormat[] = ['datetime', 'time', 'utc', 'relative'];

/**
 * La vista se recuerda en este navegador: antes cada consola nueva volvía a
 * los valores de fábrica y había que reconfigurarla cada vez. En el móvil la
 * numeración arranca apagada: la anchura es para el texto.
 */
function isNarrow(): boolean {
  try {
    return window.matchMedia('(max-width: 639px)').matches;
  } catch {
    return false;
  }
}

function loadPrefs(): ViewPrefs {
  const base: ViewPrefs = { wrap: true, gutter: !isNarrow(), showTs: true, tsFormat: 'datetime' };
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return base;
    const p = JSON.parse(raw) as Partial<ViewPrefs>;
    return {
      wrap: typeof p.wrap === 'boolean' ? p.wrap : base.wrap,
      gutter: typeof p.gutter === 'boolean' ? p.gutter : base.gutter,
      showTs: typeof p.showTs === 'boolean' ? p.showTs : base.showTs,
      tsFormat: TS_FORMATS.includes(p.tsFormat as TimestampFormat) ? (p.tsFormat as TimestampFormat) : base.tsFormat,
    };
  } catch {
    return base;
  }
}

/* ───────────────────────── Filas ─────────────────────────────────────────── */

/**
 * Tramos `[inicio, fin)` de la línea que casan con alguno de los términos,
 * ordenados y fundidos donde se solapan.
 */
export function markRanges(line: string, marks: readonly RegExp[]): [number, number][] {
  const found: [number, number][] = [];
  for (const re of marks) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(line)) && guard++ < 200) {
      if (m[0].length === 0) {
        // Una expresión que casa con la cadena vacía no avanzaría nunca.
        re.lastIndex++;
        continue;
      }
      found.push([m.index, m.index + m[0].length]);
    }
  }
  if (found.length < 2) return found;
  found.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [found[0]];
  for (let i = 1; i < found.length; i++) {
    const last = out[out.length - 1];
    if (found[i][0] <= last[1]) last[1] = Math.max(last[1], found[i][1]);
    else out.push(found[i]);
  }
  return out;
}

/** Resalta todas las coincidencias de la búsqueda en la línea. */
function highlight(line: string, marks: readonly RegExp[]): React.ReactNode {
  if (!marks.length || !line) return line;
  const ranges = markRanges(line, marks);
  if (!ranges.length) return line;
  const out: React.ReactNode[] = [];
  let last = 0;
  ranges.forEach(([a, b], key) => {
    if (a > last) out.push(line.slice(last, a));
    out.push(
      <mark key={key} className="log-mark">
        {line.slice(a, b)}
      </mark>,
    );
    last = b;
  });
  if (last < line.length) out.push(line.slice(last));
  return out;
}

const LogRow = memo(function LogRow({
  id,
  n,
  row,
  tsFormat,
  tick,
  wrap,
  gutter,
  showTs,
  marks,
  selected,
}: {
  id: number;
  n: number;
  row: ParsedRow;
  tsFormat: TimestampFormat;
  /** Solo cambia con el formato relativo: obliga a repintar «hace 5 s». */
  tick: number;
  wrap: boolean;
  gutter: boolean;
  showTs: boolean;
  marks: readonly RegExp[];
  selected: boolean;
}) {
  void tick;
  const ts = showTs ? tsText(row, tsFormat) : '';
  return (
    <div
      data-id={id}
      className={cx(
        'log-row flex w-full items-baseline',
        row.lvl === 'err' && 'log-row-err',
        row.lvl === 'warn' && 'log-row-warn',
        selected && 'log-row-sel',
      )}
    >
      {gutter && <span className="log-gutter tnum select-none px-2 text-right text-xs tabular-nums">{n}</span>}
      {showTs && <span className={cx('log-ts tnum shrink-0 select-none px-2 text-xs', !ts && 'opacity-0')}>{ts || '00:00:00'}</span>}
      <span
        className={cx(
          'log-text min-w-0 flex-1 py-px pr-3',
          !gutter && !showTs ? 'pl-3' : 'pl-1',
          wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
        )}
      >
        {highlight(row.cleanText, marks)}
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
  tsFormat,
  tick,
  wrap,
  gutter,
  showTs,
  marks,
  selectedId,
  onMeasure,
}: {
  chunkKey: number;
  rows: VisibleRow[];
  origin: number;
  tsFormat: TimestampFormat;
  tick: number;
  wrap: boolean;
  gutter: boolean;
  showTs: boolean;
  marks: readonly RegExp[];
  /** Solo la del bloque que la contiene: así una selección no repinta los demás. */
  selectedId: number | null;
  onMeasure: (key: number, el: HTMLDivElement | null) => void;
}) {
  const refCb = useCallback((el: HTMLDivElement | null) => onMeasure(chunkKey, el), [chunkKey, onMeasure]);
  return (
    <div ref={refCb} className="log-chunk">
      {rows.map((v) => (
        <LogRow
          key={v.id}
          id={v.id}
          n={v.id - origin}
          row={v.row}
          tsFormat={tsFormat}
          tick={tick}
          wrap={wrap}
          gutter={gutter}
          showTs={showTs}
          marks={marks}
          selected={v.id === selectedId}
        />
      ))}
    </div>
  );
});

/* ───────────────────────── Detalle de una línea ──────────────────────────── */

/** JSON legible si la línea es un objeto JSON (con o sin el prefijo de réplica `[rN]`). */
function prettyJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0 || start > 8 || !text.endsWith('}')) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start));
    return value && typeof value === 'object' ? JSON.stringify(value, null, 2) : null;
  } catch {
    return null;
  }
}

const LEVEL_BADGE: Record<Level, { label: string; cls: string } | null> = {
  err: { label: 'Error', cls: 'bg-err/15 text-err' },
  warn: { label: 'Aviso', cls: 'bg-warn/15 text-warn' },
  plain: null,
};

function LineDetail({
  n,
  row,
  canShowContext,
  onShowContext,
  onClose,
}: {
  n: number;
  row: ParsedRow;
  canShowContext: boolean;
  onShowContext: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const pretty = useMemo(() => prettyJson(row.cleanText), [row]);
  const badge = LEVEL_BADGE[row.lvl];
  const date = row.ts !== null ? new Date(row.ts) : null;

  const copy = (text: string, what: string) => {
    void copyToClipboard(text).then((ok) =>
      toast(ok ? `${what} copiado al portapapeles.` : 'No se ha podido copiar al portapapeles.', ok ? 'ok' : 'err'),
    );
  };

  return (
    <div
      className="log-sheet absolute inset-x-0 bottom-0 z-30 flex max-h-[72%] flex-col border-t border-line bg-surface font-sans shadow-modal"
      role="dialog"
      aria-label={`Detalle de la línea ${n}`}
    >
      <div className="flex items-start justify-between gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-xs font-semibold text-txt">
            {badge && <span className={cx('rounded px-1.5 py-0.5 text-micro font-semibold', badge.cls)}>{badge.label}</span>}
            <span>Línea {NF.format(n)}</span>
          </p>
          {date ? (
            <>
              <p className="mt-1 text-xs text-sub first-letter:uppercase">{FULL_FMT.format(date)}</p>
              <p className="mt-0.5 break-all font-mono text-micro text-subtle">
                {date.toISOString()} · {relativeTime(date.getTime())}
              </p>
            </>
          ) : (
            row.clock && <p className="mt-1 text-xs text-sub">Hora registrada: {row.clock}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="press -mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-subtle hover:bg-surface2 hover:text-txt sm:h-8 sm:w-8"
          title="Cerrar (Esc)"
          aria-label="Cerrar el detalle"
        >
          <X size={15} />
        </button>
      </div>
      <pre className="min-h-0 flex-1 select-text overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[12.5px] leading-[1.6] text-txt">
        {pretty ?? (row.cleanText || ' ')}
      </pre>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2">
        <button
          type="button"
          onClick={() => copy(row.cleanText, 'Texto')}
          className="press flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface2/60 px-2.5 text-xs font-medium text-sub hover:text-txt sm:h-8"
        >
          <Copy size={13} aria-hidden /> Copiar línea
        </button>
        {pretty && (
          <button
            type="button"
            onClick={() => copy(pretty, 'JSON')}
            className="press flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface2/60 px-2.5 text-xs font-medium text-sub hover:text-txt sm:h-8"
          >
            <Copy size={13} aria-hidden /> Copiar JSON
          </button>
        )}
        {canShowContext && (
          <button
            type="button"
            onClick={onShowContext}
            className="press flex h-9 items-center gap-1.5 rounded-lg border border-acc/40 bg-acc/10 px-2.5 text-xs font-semibold text-acc-soft hover:bg-acc/15 sm:h-8"
            title="Quitar los filtros y mostrar las líneas de alrededor"
          >
            <LocateFixed size={13} aria-hidden /> Ver en contexto
          </button>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── Ayuda de búsqueda ─────────────────────────────── */

const SEARCH_EXAMPLES: { q: string; desc: string }[] = [
  { q: 'timeout redis', desc: 'Líneas con las dos palabras' },
  { q: '"connection refused"', desc: 'El texto exacto' },
  { q: 'error -healthcheck', desc: 'Sin las que contienen una palabra' },
  { q: 'timeout OR refused', desc: 'Cualquiera de las dos' },
  { q: '/5\\d\\d/', desc: 'Expresión regular (aquí, códigos 5xx)' },
  { q: 'level:error', desc: 'Solo errores (también level:warn)' },
];

function ToolButton({
  title,
  onClick,
  active,
  disabled,
  className,
  children,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
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
        // 36px con el pulgar, 32px con ratón.
        'press flex h-9 w-9 shrink-0 items-center justify-center rounded-lg leading-none transition-colors disabled:opacity-40 sm:h-8 sm:w-8',
        active ? 'bg-acc/[.16] text-acc-soft' : 'text-subtle hover:bg-surface2 hover:text-txt',
        className,
      )}
    >
      {children}
    </button>
  );
}

/* ───────────────────────── Visor ─────────────────────────────────────────── */

/**
 * Consola de logs: búsqueda con sintaxis, filtro por nivel, fecha y hora en
 * cada línea, detalle de una línea al tocarla y seguimiento en vivo que se
 * pausa al subir a leer.
 *
 * Solo pinta los bloques de filas que caen cerca del hueco visible; el resto
 * es relleno de su alto (medido si ya se pintó, estimado si no). Con catorce
 * mil filas en el DOM el navegador del móvil no daba abasto; con unas
 * trescientas, el gesto de scroll va a la velocidad del dedo.
 *
 * Va en `memo`: la pestaña que lo aloja se re-renderiza con cada sondeo de
 * despliegues aunque no haya líneas nuevas.
 */
function LogViewerImpl({
  lines,
  className,
  toolbar = true,
  live = false,
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
  state = 'ready',
  onRetry,
  emptyMessage,
}: {
  lines: readonly string[];
  className?: string;
  toolbar?: boolean;
  /**
   * La fuente sigue escribiendo (stream abierto). Solo entonces se habla de
   * «En vivo» y se ofrece pausar: antes un log archivado decía «En vivo» solo
   * por estar al final.
   */
  live?: boolean;
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
  /**
   * Qué le pasa a la fuente de los logs: cargando, con error o lista. Una
   * consola vacía no dice lo mismo en cada caso.
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
  const searchRef = useRef<HTMLInputElement>(null);

  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState('');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [prefs, setPrefs] = useState<ViewPrefs>(loadPrefs);
  const [narrow] = useState(isNarrow);
  const { wrap, gutter, showTs, tsFormat } = prefs;
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  /*
   * Alto disponible para los menús: la consola recorta lo que se sale de ella
   * y, incrustada en un despliegue, mide poco. El menú se ajusta a lo que
   * queda debajo del botón y, si no cabe, se desplaza dentro.
   */
  const shellRef = useRef<HTMLElement>(null);
  const [menuMaxH, setMenuMaxH] = useState<number | undefined>(undefined);
  const fitMenu = (anchor: HTMLElement) => {
    const shell = shellRef.current;
    if (shell) setMenuMaxH(Math.max(150, shell.getBoundingClientRect().bottom - anchor.getBoundingClientRect().bottom - 14));
  };
  const [copied, setCopied] = useState(false);
  // Se limpia al desmontar: el temporizador tocaba estado de un visor ya cerrado.
  const copiedTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const [maximized, setMaximized] = useState(false);
  /** Líneas que había al pulsar «Limpiar la vista»: se ocultan las que sigan en el buffer. */
  const [cleared, setCleared] = useState<readonly string[] | null>(null);
  /** Línea abierta en el detalle (con la generación del modelo en que se eligió). */
  const [picked, setPicked] = useState<{ gen: number; id: number } | null>(null);
  /** Línea a la que saltar al quitar los filtros («Ver en contexto»). */
  const [jumpId, setJumpId] = useState<number | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* almacenamiento bloqueado: la vista vale para esta sesión */
    }
  }, [prefs]);
  const setPref = <K extends keyof ViewPrefs>(key: K, value: ViewPrefs[K]) => setPrefs((p) => ({ ...p, [key]: value }));

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
  const query = useMemo(() => parseQuery(q), [q]);

  /*
   * «Limpiar la vista» oculta las líneas que había entonces, buscándolas por
   * contenido. Antes guardaba un índice, y con el buffer lleno (recorta por
   * delante y no crece) ese índice apuntaba siempre al final: la consola se
   * quedaba vacía para siempre. Si ya no queda ninguna, o la fuente es otra,
   * se ve todo.
   */
  const effectiveLines = useMemo(() => {
    if (!cleared) return lines;
    const d = diffLines(cleared, lines);
    if (d.kept === 0) return lines;
    return lines.slice(Math.max(0, d.front) + d.kept);
  }, [lines, cleared]);
  const hiddenCount = lines.length - effectiveLines.length;

  /*
   * El seguimiento vive también en una ref, actualizada en el mismo instante
   * del scroll (no al siguiente render): así ningún salto programado al fondo
   * pisa un gesto del dedo que acaba de empezar, y el tramo de bloques que se
   * pinta se decide con el dato de este mismo frame.
   */
  const followRef = useRef(true);
  /** Pausa pedida con el botón: volver al fondo con el dedo no la quita. */
  const pinnedRef = useRef(false);
  /** Se seguía el final al abrir el detalle: al cerrarlo se reanuda. */
  const resumeOnCloseRef = useRef(false);

  /* ── Vista congelada mientras se lee (ver `freezeLines`) ── */
  const frozenRef = useRef<readonly string[] | null>(null);
  const shownRef = useRef<readonly string[]>(EMPTY_LINES);
  let shown: readonly string[];
  if (follow) {
    frozenRef.current = null;
    shown = effectiveLines;
  } else {
    shown = freezeLines(frozenRef.current ?? shownRef.current, effectiveLines);
    frozenRef.current = shown;
  }
  shownRef.current = shown;
  const pendingNew = follow ? 0 : Math.max(0, effectiveLines.length - shown.length);

  const viewRef = useRef<ViewState | null>(null);
  if (!viewRef.current) viewRef.current = createViewState();
  const view = viewRef.current;
  const model = useMemo(() => advanceView(view, shown, { q, level }), [view, shown, q, level]);
  const { rows, counts, visible, chunks, origin } = model;

  /*
   * Recorte por delante mientras se lee (buffer lleno): se apunta, ANTES de
   * pintar, qué línea está arriba del todo y a qué altura, para dejarla
   * exactamente ahí después. La estimación por alto medio de línea derivaba
   * unos píxeles en cada tanda y, con la aplicación escribiendo sin parar, lo
   * que se estaba leyendo se iba moviendo solo.
   */
  const anchorRef = useRef<{ id: number; top: number } | null>(null);
  const anchoredModelRef = useRef<ViewModel | null>(null);
  if (anchoredModelRef.current !== model) {
    anchoredModelRef.current = model;
    anchorRef.current = null;
    const body = ref.current;
    const canvas = canvasRef.current;
    if (!followRef.current && model.delta && model.delta.front < 0 && body && canvas) {
      const top = body.getBoundingClientRect().top;
      for (const node of canvas.querySelectorAll<HTMLElement>('[data-id]')) {
        const r = node.getBoundingClientRect();
        if (r.bottom > top + 1) {
          anchorRef.current = { id: Number(node.dataset.id), top: r.top - top };
          break;
        }
      }
    }
  }

  const selected = useMemo(() => {
    if (!picked || picked.gen !== model.gen) return null;
    const i = picked.id - model.firstId;
    return i >= 0 && i < model.rows.length ? { id: picked.id, n: picked.id - model.origin, row: model.rows[i] } : null;
  }, [picked, model]);
  const selectedId = selected?.id ?? null;
  const sheetOpenRef = useRef(false);
  sheetOpenRef.current = selected !== null;

  /*
   * En iOS, escribir `scrollTop` mientras hay un dedo en la pantalla —o durante
   * la inercia justo después— cancela el gesto. Mientras dura el gesto no se
   * escribe el scroll; cuando se asienta, si toca seguir, se va al fondo.
   */
  const gestureRef = useRef(false);
  const settleTimerRef = useRef(0);
  const pendingBottomRef = useRef(false);

  /* ── Ventana de pintado ── */
  /** Alto real de cada bloque pintado alguna vez, por clave. */
  const heightsRef = useRef<Heights>(new Map());
  /** Bloques del último render, para saber con qué filas se mide cada clave. */
  const chunksRef = useRef<Chunk[]>([]);
  /** Líneas visuales estimadas por bloque (para su ancho de columna). */
  const linesCacheRef = useRef(new Map<number, { rows: VisibleRow[]; n: number }>());
  /** Caracteres por línea de texto con ajuste de línea; 0 = sin ajuste o sin medir. */
  const colsRef = useRef(0);
  const scrollTopRef = useRef(0);
  const viewportRef = useRef(0);
  const layoutRef = useRef<Layout>(EMPTY_LAYOUT);
  const prevLayoutRef = useRef<Layout>(EMPTY_LAYOUT);
  const [layoutTick, setLayoutTick] = useState(0);
  const relayout = useCallback(() => setLayoutTick((n) => n + 1), []);
  /** Alto de línea calibrado mientras se seguía el final; fijo mientras se lee. */
  const lineHRef = useRef(DEFAULT_LINE_H);
  /**
   * Las medidas se han tirado (ajuste de línea, pantalla completa, otra
   * anchura): se recalibra aunque se esté leyendo, hasta medir algún bloque.
   */
  const recalibrateRef = useRef(true);
  /**
   * Píxeles que se le quitan (o añaden) al relleno superior mientras dura un
   * gesto, en vez de mover el scroll: ver `keepPlace`.
   */
  const padAdjRef = useRef(0);

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

  const hasBanner = canLoadOlder || (startReached && visible.length > 0);
  chunksRef.current = chunks;
  const calibrate = followRef.current || recalibrateRef.current;
  const layout = computeLayout(chunks, heightsRef.current, estLines, calibrate ? null : lineHRef.current, maximized ? 23 : DEFAULT_LINE_H);
  lineHRef.current = layout.lineH;
  if (calibrate && layout.measuredCount > 0) recalibrateRef.current = false;
  // Con la corrección del gesto el contenido se desplaza como lo haría con
  // una franja de arriba más alta o más baja: cuenta en el techo del lienzo.
  layout.bannerTop = hasBanner ? BANNER_H : 0;
  layout.canvasTop = layout.bannerTop + padAdjRef.current;
  const [start, end] = computeRange(layout.offsets, followRef.current, scrollTopRef.current - layout.canvasTop, viewportRef.current || 600);
  layout.start = start;
  layout.end = end;
  const canvasShift = canvasOffset(layout.offsets[start] + padAdjRef.current);
  prevLayoutRef.current = layoutRef.current;
  layoutRef.current = layout;

  /*
   * Medición de bloques con un único ResizeObserver. Un bloque entero por
   * encima del hueco que cambia de alto movería lo que se está leyendo: se
   * compensa con `keepPlace` (en el scroll o, con el dedo en la pantalla, en
   * el relleno superior).
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
      const idx = lay.index.get(key);
      const rows = idx !== undefined ? chunksRef.current[idx]?.rows : undefined;
      if (idx === undefined || !rows) continue;
      const old = heights.get(key);
      if (old && old.rows === rows && Math.abs(old.h - h) < 0.5) continue;
      heights.set(key, { rows, h });
      const used = lay.offsets[idx + 1] - lay.offsets[idx];
      if (Math.abs(h - used) < 0.5) continue;
      /*
       * Siguiendo el final no hay nada que compensar (manda el fondo), pero sí
       * hay que calibrar el alto de línea con las primeras medidas. Antes no
       * se recalculaba nada hasta el primer gesto: el log seguía estimado con
       * el alto por defecto y, al empezar a subir, se recalibraba de golpe.
       * Con miles de líneas el contenido encogía miles de píxeles bajo el dedo
       * y la vista volvía casi al final: el scroll parecía bloqueado.
       */
      if (followRef.current) {
        if (recalibrateRef.current || lay.measuredCount < 4) dirty = true;
        continue;
      }
      if (lay.offsets[idx + 1] + lay.canvasTop <= scrollTopRef.current + 1) shift += h - used;
      dirty = true;
    }
    if (shift && el) keepPlaceRef.current(shift);
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
    // Con todo por medir, la corrección del gesto ya no se refiere a nada.
    recalibrateRef.current = true;
    // Y `measureCols` vuelve a medir los bloques pintados aunque la anchura
    // no cambie: si no, se quedaban sin medida hasta que algo los moviera.
    colsRef.current = -1;
    if (padAdjRef.current) {
      padAdjRef.current = 0;
      relayout();
    }
  }, [wrap, maximized, relayout]);

  /*
   * Caracteres por línea (anchura de la columna de texto / anchura de un
   * carácter). Se mide solo cuando puede cambiar —anchura del hueco, ajuste,
   * numeración, hora, pantalla completa—, no en cada render: era una
   * maquetación forzada por ráfaga. Si cambia, las medidas anteriores ya no
   * valen y los bloques pintados se vuelven a medir aquí mismo.
   */
  const measureCols = useCallback(() => {
    const canvas = canvasRef.current;
    const probe = probeRef.current;
    let cols = 0;
    if (wrap && canvas && probe) {
      const span = canvas.querySelector<HTMLElement>('.log-text');
      const charW = probe.getBoundingClientRect().width / PROBE.length;
      if (span && charW > 0) {
        const cs = window.getComputedStyle(span);
        const inner = span.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        cols = Math.max(1, Math.floor(inner / charW));
      }
    }
    if (cols === colsRef.current) return;
    colsRef.current = cols;
    linesCacheRef.current.clear();
    padAdjRef.current = 0;
    recalibrateRef.current = true;
    const heights = heightsRef.current;
    heights.clear();
    const rowsByKey = new Map(chunksRef.current.map((c) => [c.key, c.rows]));
    for (const [key, node] of keyElRef.current) {
      const h = node.getBoundingClientRect().height;
      const rows = rowsByKey.get(key);
      if (h > 0 && rows) heights.set(key, { rows, h });
    }
    relayout();
  }, [wrap, relayout]);

  const hasRows = visible.length > 0;
  useLayoutEffect(() => {
    measureCols();
  }, [measureCols, gutter, showTs, tsFormat, maximized, hasRows]);

  /*
   * Posición escrita por el propio visor. El evento de scroll que provoca
   * llega DESPUÉS, y para entonces el alto total puede haber cambiado: visto
   * desde ese evento el fondo ya no era el fondo y el seguimiento se apagaba
   * solo. Un evento que trae exactamente la posición escrita no es un gesto.
   */
  const programmaticTopRef = useRef(-1);
  const writeScrollTop = useCallback((el: HTMLDivElement, value: number) => {
    el.scrollTop = value;
    // Se lee de vuelta: el navegador recorta al máximo posible.
    programmaticTopRef.current = el.scrollTop;
    scrollTopRef.current = programmaticTopRef.current;
  }, []);

  /*
   * El contenido de encima de lo que se lee ha crecido `delta` píxeles (un
   * bloque recién pintado mide distinto de lo estimado, historial cargado…) y
   * lo de debajo se ha desplazado: se devuelve a su sitio. Sin dedo en la
   * pantalla, moviendo el scroll. Con el dedo —o con la inercia de después—
   * no: en iOS escribir el scroll corta el gesto, y antes simplemente no se
   * compensaba y el texto saltaba bajo el dedo, que se notaba como un scroll
   * bloqueado. Se quita del relleno superior, que no toca el scroll, y se
   * pasa al scroll cuando el gesto se asienta.
   */
  const keepPlace = useCallback((delta: number) => {
    const el = ref.current;
    if (!el || Math.abs(delta) < 0.5) return;
    if (!gestureRef.current) {
      // Escritura directa, no `writeScrollTop`: si la compensación deja la
      // vista junto al fondo, el evento de scroll debe poder reanudar el directo.
      el.scrollTop += delta;
      scrollTopRef.current = el.scrollTop;
      return;
    }
    const lay = layoutRef.current;
    padAdjRef.current -= delta;
    lay.canvasTop = lay.bannerTop + padAdjRef.current;
    applyCanvasOffset(canvasRef.current, (lay.offsets[lay.start] ?? 0) + padAdjRef.current);
  }, []);
  const keepPlaceRef = useRef(keepPlace);
  keepPlaceRef.current = keepPlace;

  /** Pasa la corrección del relleno al scroll, ya sin gesto. */
  const foldPadAdj = useCallback(() => {
    const adj = padAdjRef.current;
    if (!adj) return;
    padAdjRef.current = 0;
    const el = ref.current;
    const lay = layoutRef.current;
    lay.canvasTop = lay.bannerTop;
    applyCanvasOffset(canvasRef.current, lay.offsets[lay.start] ?? 0);
    // Siguiendo el final no hay nada que conservar: manda el fondo.
    if (el && !followRef.current) writeScrollTop(el, el.scrollTop - adj);
    relayout();
  }, [writeScrollTop, relayout]);

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
   * líneas nuevas caía con el dedo aún en juego y iOS lo ignoraba.
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
      foldPadAdj();
      if (followRef.current && pendingBottomRef.current) {
        pendingBottomRef.current = false;
        scrollToBottom();
      } else if (ref.current) {
        maybeLoadOlder(ref.current);
      }
    }, 180);
  }, [scrollToBottom, maybeLoadOlder, foldPadAdj]);
  useEffect(
    () => () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    },
    [],
  );

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
      /*
       * Aquí sí se mueve el scroll aunque haya gesto: el historial entra
       * junto al principio, donde no hay relleno que quitar, y sin moverlo se
       * perdía el sitio de lectura. Solo llega con el gesto ya asentado o en
       * uno nuevo que acaba de empezar.
       */
      if (idx !== undefined && idx > 0) writeScrollTop(el, el.scrollTop + lay.offsets[idx]);
    } else if (d.front < 0 && model.chunks.length) {
      const a = anchorRef.current;
      const node = a ? canvasRef.current?.querySelector<HTMLElement>(`[data-id="${a.id}"]`) : null;
      if (a && node) {
        const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top - a.top;
        keepPlace(delta);
        /*
         * El primer bloque, recortado, ya mide lo que mide en pantalla: se
         * anota para que el observador no lo compense una segunda vez.
         */
        const first = model.chunks[0];
        const firstEl = keyElRef.current.get(first.key);
        if (firstEl) heightsRef.current.set(first.key, { rows: first.rows, h: firstEl.getBoundingClientRect().height });
        relayout();
      } else {
        const prevLay = prevLayoutRef.current;
        const j = prevLay.index.get(model.chunks[0].key);
        const removed = (j !== undefined ? prevLay.offsets[j] : 0) + model.partialCut * lay.lineH;
        if (removed > 0) {
          keepPlace(-Math.min(removed, el.scrollTop));
          relayout();
        }
      }
    }
  }, [model, relayout, keepPlace, writeScrollTop]);

  /*
   * Siguiendo el final, el fondo se garantiza cuando cambia lo pintado: líneas
   * nuevas o una estimación de alto sustituida por su medida.
   */
  useLayoutEffect(() => {
    syncScrollable();
    if (followRef.current) scrollToBottom();
  }, [model, layoutTick, maximized, syncScrollable, scrollToBottom]);

  // Si el hueco cambia de tamaño (acordeón, teclado del móvil, giro) y se
  // estaba siguiendo, el fondo sigue siendo el fondo; si no, se recalcula qué
  // se pinta. Un cambio de anchura cambia además los caracteres por línea.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastW = el.clientWidth;
    viewportRef.current = el.clientHeight;
    const ro = new ResizeObserver(() => {
      viewportRef.current = el.clientHeight;
      if (el.clientWidth !== lastW) {
        lastW = el.clientWidth;
        measureCols();
      }
      syncScrollable();
      if (followRef.current) scrollToBottom();
      else relayout();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [maximized, scrollToBottom, syncScrollable, relayout, measureCols]);

  const startFollowing = useCallback(() => {
    pinnedRef.current = false;
    resumeOnCloseRef.current = false;
    followRef.current = true;
    setFollow(true);
    scrollToBottom();
  }, [scrollToBottom]);

  const pause = useCallback(() => {
    pinnedRef.current = true;
    followRef.current = false;
    setFollow(false);
  }, []);

  /*
   * Al cambiar la búsqueda o el nivel se vuelve al final, salvo que el
   * cambio venga de «Ver en contexto», que quita los filtros para saltar a
   * una línea concreta. La marca la consume este mismo efecto cuando ve los
   * filtros ya quitados (la búsqueda llega en diferido, en otro render): si
   * la quitara el salto, este efecto corría después en el mismo commit y
   * mandaba la vista al final.
   */
  const jumpPendingRef = useRef(false);
  useEffect(() => {
    if (jumpPendingRef.current) {
      if (q === '' && level === 'all') jumpPendingRef.current = false;
      return;
    }
    startFollowing();
  }, [level, q, startFollowing]);

  // Otra fuente (otro despliegue, otra pestaña, la vista limpiada): se empieza
  // por lo último, aunque en la anterior se estuviera leyendo más arriba.
  const genRef = useRef(model.gen);
  useEffect(() => {
    if (genRef.current === model.gen) return;
    genRef.current = model.gen;
    if (!jumpPendingRef.current) startFollowing();
  }, [model.gen, startFollowing]);

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
    else writeScrollTop(el, lastTopRef.current);
  }, [maximized, scrollToBottom, writeScrollTop]);

  const closeDetail = useCallback(() => {
    setPicked(null);
    if (resumeOnCloseRef.current) startFollowing();
  }, [startFollowing]);
  const closeDetailRef = useRef(closeDetail);
  closeDetailRef.current = closeDetail;

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
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      // Primero se cierra el detalle de la línea; con otro Esc, la pantalla completa.
      if (sheetOpenRef.current) closeDetailRef.current();
      else setMaximized(false);
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

  /*
   * La línea elegida queda a la vista por encima del detalle, que ocupa la
   * parte de abajo de la consola.
   */
  useLayoutEffect(() => {
    if (selectedId === null) return;
    const el = ref.current;
    const node = canvasRef.current?.querySelector<HTMLElement>(`[data-id="${selectedId}"]`);
    const sheet = el?.parentElement?.querySelector<HTMLElement>('.log-sheet');
    if (!el || !node || !sheet) return;
    const overlap = node.getBoundingClientRect().bottom - sheet.getBoundingClientRect().top + 8;
    if (overlap > 0) writeScrollTop(el, el.scrollTop + overlap);
    // Solo al abrir: después manda quien lee.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  /*
   * «Ver en contexto», en dos tiempos: primero se lleva el tramo pintado al
   * bloque que contiene la línea (sin filtros, puede estar a miles de filas)
   * y, ya pintada, se coloca a un tercio del alto.
   */
  const jumpTriesRef = useRef(0);
  useLayoutEffect(() => {
    if (jumpId === null || q !== '' || level !== 'all') return;
    const el = ref.current;
    const finish = () => {
      jumpTriesRef.current = 0;
      setJumpId(null);
    };
    if (!el) return finish();
    // Un cuarto por debajo del techo: la mitad de abajo la ocupa el detalle.
    const place = () => {
      const node = canvasRef.current?.querySelector<HTMLElement>(`[data-id="${jumpId}"]`);
      if (!node) return false;
      const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientHeight / 4;
      if (Math.abs(delta) > 2) writeScrollTop(el, Math.max(0, el.scrollTop + delta));
      return true;
    };
    if (place()) {
      // Los bloques recién pintados se miden y ajustan su alto en el frame
      // siguiente: una segunda colocación deja la línea donde se quería.
      requestAnimationFrame(() => {
        place();
        relayout();
      });
      return finish();
    }
    const idx = chunkIndexOf(model.chunks, jumpId);
    if (idx < 0 || ++jumpTriesRef.current > 3) return finish();
    writeScrollTop(el, layoutRef.current.offsets[idx] + layoutRef.current.canvasTop);
    relayout();
  }, [jumpId, model, q, level, layoutTick, relayout, writeScrollTop]);

  const showInContext = (id: number) => {
    foldPadAdj();
    jumpPendingRef.current = true;
    jumpTriesRef.current = 0;
    resumeOnCloseRef.current = false;
    pause();
    setFilter('');
    setLevel('all');
    setJumpId(id);
  };

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
    // Volver al fondo con el dedo reanuda, salvo una pausa pedida con el botón.
    if (!programmatic) followRef.current = el.scrollHeight - top - el.clientHeight < 45 && !pinnedRef.current;
    // Scroll con el dedo levantado = inercia: el gesto sigue vivo hasta que pare.
    if (gestureRef.current) settleSoon();
    if (scrollRaf.current) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0;
      const node = ref.current;
      if (!node) return;
      setFollow(followRef.current);
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

  useEffect(
    () => () => {
      if (scrollRaf.current) cancelAnimationFrame(scrollRaf.current);
    },
    [],
  );

  const jumpToTop = () => {
    const el = ref.current;
    if (!el) return;
    foldPadAdj();
    followRef.current = false;
    setFollow(false);
    writeScrollTop(el, 0);
    relayout();
  };

  /*
   * Tocar una línea abre su detalle. Un clic que termina una selección de
   * texto no cuenta: en el escritorio se sigue pudiendo seleccionar y copiar
   * a mano. Mientras el detalle está abierto la vista se queda quieta.
   */
  const onCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    const node = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
    if (!node) return;
    const id = Number(node.dataset.id);
    if (!Number.isFinite(id)) return;
    if (selectedId === id) {
      closeDetail();
      return;
    }
    if (selectedId === null) resumeOnCloseRef.current = followRef.current;
    if (followRef.current) pause();
    setPicked({ gen: model.gen, id });
  };

  const plainText = (format: TimestampFormat | 'iso' | null) =>
    visible
      .map((v) => {
        const r = v.row;
        if (!format) return r.cleanText;
        const ts = format === 'iso' ? (r.ts !== null ? new Date(r.ts).toISOString() : r.clock ?? '') : tsText(r, format);
        return ts ? `${ts} ${r.cleanText}` : r.cleanText;
      })
      .join('\n');

  const copyAll = () => {
    if (visible.length === 0) return;
    const count = visible.length;
    void copyToClipboard(plainText(showTs ? tsFormat : null)).then((ok) => {
      if (ok) {
        setCopied(true);
        window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1400);
        toast(`Se han copiado ${NF.format(count)} líneas al portapapeles.`, 'ok');
      } else {
        toast('No se ha podido copiar al portapapeles. Selecciona el texto y cópialo manualmente.', 'err');
      }
    });
  };

  const download = () => {
    const blob = new Blob([plainText('iso')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName ?? `logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    a.click();
    // En diferido: revocar en el acto puede abortar la descarga en Firefox.
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const runDownload = onDownload ?? download;

  const filtering = level !== 'all' || query.active;
  // Ancho del canalón según el mayor número de línea que se pinta (mínimo tres cifras).
  const maxLineNo = visible.length ? visible[visible.length - 1].id - origin : 0;
  const gutterCh = Math.max(3, String(maxLineNo).length) + 0.8;
  useLayoutEffect(() => {
    measureCols();
  }, [gutterCh, measureCols]);

  const levelChip = (key: LevelFilter, label: string, n?: number, tone?: 'err' | 'warn') => (
    <button
      type="button"
      onClick={() => setLevel(key)}
      aria-pressed={level === key}
      className={cx(
        'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors duration-150 max-sm:h-8',
        level === key
          ? tone === 'err'
            ? 'bg-err/[.18] font-semibold text-err'
            : tone === 'warn'
              ? 'bg-warn/[.18] font-semibold text-warn'
              : 'bg-acc/[.18] font-semibold text-acc-soft'
          : 'text-subtle hover:bg-surface2 hover:text-txt',
      )}
    >
      {tone && <span className={cx('h-[5px] w-[5px] rounded-full', tone === 'err' ? 'bg-err' : 'bg-warn')} />}
      {label}
      {n !== undefined && n > 0 && <span className="tnum font-mono opacity-85">{NF.format(n)}</span>}
    </button>
  );

  const levelChips = (
    <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-line bg-term p-0.5">
      {levelChip('all', 'Todo')}
      {levelChip('err', 'Errores', counts.err, 'err')}
      {levelChip('warn', 'Avisos', counts.warn, 'warn')}
    </div>
  );

  // En vivo: el estado es a la vez el botón. Siguiendo dice «En vivo» y
  // pausa; en pausa dice lo que hace al pulsarlo y cuántas líneas esperan.
  const liveControl = live ? (
    <button
      type="button"
      onClick={follow ? pause : startFollowing}
      aria-pressed={!follow}
      title={follow ? 'Pausar la vista (las líneas nuevas se siguen recibiendo)' : 'Reanudar y mostrar lo último'}
      className={cx(
        'press flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition-colors sm:h-8',
        follow ? 'text-ok hover:bg-ok/10' : 'bg-warn/[.14] text-warn hover:bg-warn/20',
      )}
    >
      {follow ? (
        <>
          <span className="pulse-soft h-2 w-2 rounded-full bg-ok" aria-hidden />
          En vivo
          <Pause size={12} className="opacity-60 max-sm:hidden" aria-hidden />
        </>
      ) : (
        <>
          <Play size={12} aria-hidden />
          Reanudar
          {pendingNew > 0 && <span className="tnum font-mono">+{pendingNew > 999 ? '999+' : NF.format(pendingNew)}</span>}
        </>
      )}
    </button>
  ) : null;

  const lineCount = (
    <span className="hidden min-w-0 truncate text-xs text-subtle sm:inline">
      {filtering ? (
        <>
          <span className="tnum font-medium text-txt/90">{NF.format(visible.length)}</span> de{' '}
          <span className="tnum">{NF.format(rows.length)}</span> líneas
        </>
      ) : (
        <>
          <span className="tnum font-medium text-txt/80">{NF.format(rows.length)}</span> líneas
        </>
      )}
      {replicas > 1 && <span title="Las líneas de cada réplica llevan su prefijo [rN]"> · {replicas} réplicas</span>}
    </span>
  );

  const shell = (
    <section
      ref={shellRef}
      className={cx(
        'log-shell relative flex min-h-0 w-full flex-col overflow-hidden bg-term',
        maximized ? 'rounded-none' : cx('rounded-xl border border-line shadow-sm', className),
      )}
      style={{ '--gutter-ch': gutterCh, '--ts-ch': TS_CH[tsFormat] } as React.CSSProperties}
      onKeyDown={(e) => {
        const typing = (e.target as HTMLElement).tagName === 'INPUT';
        // Ctrl/⌘+F o «/» con el foco dentro de la consola buscan AQUÍ, no en la página.
        if (toolbar && (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') || (e.key === '/' && !typing))) {
          e.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
          return;
        }
        if (e.key === 'Escape' && !maximized) {
          if (selected) {
            e.stopPropagation();
            closeDetail();
          } else if (typing && filter) {
            e.stopPropagation();
            setFilter('');
          }
        }
      }}
    >
      {toolbar && (
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-line bg-term2 px-2 py-2 sm:px-2.5">
          {/* Fila 1: búsqueda, con el nivel al lado (escritorio) o el control de vivo (móvil). */}
          <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
            {/* `relative`: la ayuda se ancla a la caja de búsqueda y nunca se sale de la consola. */}
            <div className="relative flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-term px-2.5 focus-within:border-acc sm:h-8">
              <Search size={13} className="shrink-0 text-subtle" aria-hidden />
              <input
                ref={searchRef}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={narrow ? 'Buscar' : 'Buscar: palabras, "frase", -excluir'}
                aria-label="Buscar en el registro"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                enterKeyHint="search"
                // El 16px del móvil lo pone la regla global anti-zoom de iOS; aquí solo el escritorio.
                className="min-w-0 flex-1 bg-transparent font-mono text-txt outline-none placeholder:font-sans placeholder:text-subtle sm:text-xs"
              />
              {filter && (
                <>
                  <span className="shrink-0 font-mono text-micro tabular-nums text-subtle" aria-live="polite">
                    {NF.format(visible.length)}
                    <span className="max-sm:hidden"> {visible.length === 1 ? 'coincidencia' : 'coincidencias'}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setFilter('')}
                    className="press -mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-subtle hover:text-txt"
                    title="Borrar la búsqueda"
                    aria-label="Borrar la búsqueda"
                  >
                    <X size={13} />
                  </button>
                </>
              )}
              <button
                  type="button"
                  onClick={(e) => {
                    fitMenu(e.currentTarget);
                    setHelpOpen((o) => !o);
                  }}
                  aria-expanded={helpOpen}
                  className={cx(
                    'press -mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded',
                    helpOpen ? 'text-acc-soft' : 'text-subtle hover:text-txt',
                  )}
                  title="Cómo buscar"
                  aria-label="Cómo buscar"
                >
                  <CircleHelp size={14} />
                </button>
                <Menu open={helpOpen} onClose={() => setHelpOpen(false)} align="right" className="w-[min(340px,100%)]">
                  <div className="overflow-y-auto overscroll-contain px-1.5 py-1 font-sans" style={{ maxHeight: menuMaxH }}>
                    <p className="px-1 pb-1 eyebrow text-subtle">Cómo buscar</p>
                    {SEARCH_EXAMPLES.map((ex) => (
                      <button
                        key={ex.q}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setFilter(ex.q);
                          setHelpOpen(false);
                          searchRef.current?.focus();
                        }}
                        className="flex min-h-9 w-full items-baseline justify-between gap-3 rounded-lg px-1.5 py-1.5 text-left hover:bg-surface2"
                      >
                        <code className="shrink-0 font-mono text-xs text-acc-soft">{ex.q}</code>
                        <span className="min-w-0 text-right text-xs text-sub">{ex.desc}</span>
                      </button>
                    ))}
                    <p className="mt-1.5 border-t border-line px-1 pt-2 text-xs leading-5 text-sub">
                      Toca una línea para ver su fecha completa, copiarla o verla en contexto. Al subir a leer, la vista se
                      pausa; «Reanudar» vuelve a lo último.
                    </p>
                    <p className="mt-1 px-1 pb-1 text-xs text-subtle max-sm:hidden">
                      Atajos: «/» o Ctrl+F para buscar; Esc para cerrar.
                    </p>
                  </div>
                </Menu>
            </div>
            <div className="max-sm:hidden">{levelChips}</div>
            {liveControl && <div className="sm:hidden">{liveControl}</div>}
          </div>
          {query.error && <p className="px-1 text-xs text-warn">{query.error}</p>}

          {/* Fila 2: nivel (móvil) o estado (escritorio), y las acciones. */}
          <div className="flex min-w-0 items-center justify-between gap-1.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="sm:hidden">{levelChips}</div>
              {maximized && title && <span className="hidden truncate font-mono text-xs text-sub sm:inline">{title}</span>}
              {liveControl && <div className="max-sm:hidden">{liveControl}</div>}
              {lineCount}
            </div>
            <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
              <button
                type="button"
                onClick={copyAll}
                disabled={visible.length === 0}
                className="press hidden h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-sub transition-colors hover:bg-surface2 hover:text-txt disabled:opacity-40 sm:flex"
                title={filtering ? 'Copiar las líneas filtradas' : 'Copiar las líneas al portapapeles'}
              >
                {copied ? <Check size={14} className="pop-in text-ok" aria-hidden /> : <Copy size={14} aria-hidden />}
                <span>{copied ? 'Copiado' : 'Copiar'}</span>
              </button>
              <button
                type="button"
                onClick={runDownload}
                disabled={!onDownload && visible.length === 0}
                className="press hidden h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-sub transition-colors hover:bg-surface2 hover:text-txt disabled:opacity-40 sm:flex"
                title={onDownload ? 'Descargar el registro completo' : 'Descargar el registro'}
              >
                <Download size={14} aria-hidden />
                <span>Descargar</span>
              </button>
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => {
                    fitMenu(e.currentTarget);
                    setViewMenuOpen((o) => !o);
                  }}
                  aria-expanded={viewMenuOpen}
                  className={cx(
                    'press flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors max-sm:w-9 max-sm:justify-center max-sm:px-0 sm:h-8',
                    viewMenuOpen ? 'bg-surface2 text-txt' : 'text-sub hover:bg-surface2 hover:text-txt',
                  )}
                  title="Opciones del registro"
                  aria-label="Opciones del registro"
                >
                  <SlidersHorizontal size={14} aria-hidden />
                  <span className="max-sm:hidden">Vista</span>
                </button>
                <Menu open={viewMenuOpen} onClose={() => setViewMenuOpen(false)} align="right" className="w-[264px]">
                  <div className="overflow-y-auto overscroll-contain" style={{ maxHeight: menuMaxH }}>
                    {/* En el móvil la fila no da para todo: copiar y descargar viven aquí. */}
                    <div className="grid grid-cols-2 gap-1 p-1 sm:hidden">
                      <button
                        type="button"
                        onClick={() => {
                          copyAll();
                          setViewMenuOpen(false);
                        }}
                        disabled={visible.length === 0}
                        className="press flex h-10 items-center justify-center gap-1.5 rounded-lg border border-line bg-surface2/60 text-xs font-medium text-sub disabled:opacity-40"
                      >
                        <Copy size={14} aria-hidden /> Copiar
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          runDownload();
                          setViewMenuOpen(false);
                        }}
                        className="press flex h-10 items-center justify-center gap-1.5 rounded-lg border border-line bg-surface2/60 text-xs font-medium text-sub"
                      >
                        <Download size={14} aria-hidden /> Descargar
                      </button>
                    </div>
                    <p className="px-2.5 py-1 eyebrow text-subtle">Vista</p>
                    <MenuItem icon={<Clock size={14} />} active={showTs} onClick={() => setPref('showTs', !showTs)}>
                      <span className="flex items-center justify-between gap-2">
                        Fecha y hora
                        {showTs && <Check size={13} className="shrink-0 text-acc-soft" />}
                      </span>
                    </MenuItem>
                    {/* El formato solo aparece cuando la fecha está puesta:
                        elegir entre formatos de algo oculto no significa nada. */}
                    {showTs && (
                      <div className="mx-1 mb-1 grid grid-cols-4 gap-0.5 rounded-lg border border-line bg-surface2/50 p-0.5" role="group" aria-label="Formato de la fecha">
                        {(
                          [
                            { key: 'datetime', label: 'Fecha', title: 'Fecha y hora local (12 oct 14:03:22)' },
                            { key: 'time', label: 'Hora', title: 'Solo la hora local' },
                            { key: 'utc', label: 'UTC', title: 'Fecha y hora en UTC' },
                            { key: 'relative', label: 'Hace', title: 'Tiempo transcurrido (hace 5 min)' },
                          ] as const
                        ).map((opt) => (
                          <button
                            key={opt.key}
                            type="button"
                            onClick={() => setPref('tsFormat', opt.key)}
                            aria-pressed={tsFormat === opt.key}
                            title={opt.title}
                            className={cx(
                              'press h-8 rounded-md text-xs font-medium transition-colors',
                              tsFormat === opt.key ? 'bg-surface font-semibold text-txt shadow-lvl1' : 'text-subtle hover:text-txt',
                            )}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    )}
                    <MenuItem icon={<WrapText size={14} />} active={wrap} onClick={() => setPref('wrap', !wrap)}>
                      <span className="flex items-center justify-between gap-2">
                        Ajuste de línea
                        {wrap && <Check size={13} className="shrink-0 text-acc-soft" />}
                      </span>
                    </MenuItem>
                    <MenuItem icon={<Hash size={14} />} active={gutter} onClick={() => setPref('gutter', !gutter)}>
                      <span className="flex items-center justify-between gap-2">
                        Numerar líneas
                        {gutter && <Check size={13} className="shrink-0 text-acc-soft" />}
                      </span>
                    </MenuItem>

                    <div className="my-1 border-t border-line" />

                    <MenuItem
                      icon={<ArrowUpToLine size={14} />}
                      onClick={() => {
                        jumpToTop();
                        setViewMenuOpen(false);
                      }}
                    >
                      Ir al principio
                    </MenuItem>
                    {hiddenCount === 0 ? (
                      <MenuItem
                        icon={<Trash2 size={14} />}
                        onClick={() => {
                          setCleared(lines);
                          setViewMenuOpen(false);
                        }}
                        className={cx(visible.length === 0 && 'pointer-events-none opacity-40')}
                      >
                        Limpiar la vista
                      </MenuItem>
                    ) : (
                      <MenuItem icon={<Trash2 size={14} />} onClick={() => setCleared(null)}>
                        Restaurar {NF.format(hiddenCount)} líneas ocultas
                      </MenuItem>
                    )}
                  </div>
                </Menu>
              </div>
              <ToolButton
                title={maximized ? 'Restaurar (Esc)' : 'Pantalla completa'}
                onClick={() => setMaximized((m) => !m)}
                className={cx(maximized && 'max-sm:hidden')}
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
        </div>
      )}

      {/* Solo cuando hay algo que contar: un aviso del servidor o de la fuente. */}
      {statusNote && (
        <div className="shrink-0 border-b border-line bg-term2 px-3 py-1.5 text-xs font-medium text-warn">{statusNote}</div>
      )}

      <div className="relative min-h-0 w-full flex-1 overflow-hidden">
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

          {hasBanner && (
            <div className="flex items-center justify-center font-sans" style={{ height: BANNER_H }}>
              {canLoadOlder ? (
                <button
                  type="button"
                  onClick={triggerLoadOlder}
                  disabled={loadingOlder}
                  className="press inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-term2 px-3 text-xs text-sub hover:text-txt disabled:opacity-50"
                >
                  {loadingOlder ? 'Cargando líneas anteriores…' : 'Cargar líneas anteriores'}
                </button>
              ) : (
                <span className="eyebrow text-subtle">Principio del registro</span>
              )}
            </div>
          )}

          {visible.length === 0 ? (
            <div className="flex h-full min-h-[140px] items-center justify-center p-6 text-center font-sans">
              {state === 'loading' ? (
                <Spinner label="Cargando el registro…" />
              ) : state === 'error' ? (
                <ErrorState compact title="No se ha podido cargar el registro" onRetry={onRetry} />
              ) : (
                <span className="max-w-sm text-balance text-xs leading-5 text-subtle">
                  {filtering ? 'Ninguna línea coincide con la búsqueda.' : emptyMessage ?? 'No hay registros disponibles.'}
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
              onClick={onCanvasClick}
              className={cx('log-canvas', wrap ? 'w-full' : 'w-max min-w-full')}
              style={{
                ...canvasShift,
                paddingBottom: Math.max(0, layout.total - layout.offsets[end + 1]),
              }}
            >
              {chunks.slice(start, end + 1).map((c) => {
                const first = c.rows[0].id;
                const last = c.rows[c.rows.length - 1].id;
                return (
                  <LogChunk
                    key={c.key}
                    chunkKey={c.key}
                    rows={c.rows}
                    origin={origin}
                    tsFormat={tsFormat}
                    tick={tsFormat === 'relative' ? tick : 0}
                    wrap={wrap}
                    gutter={gutter}
                    showTs={showTs}
                    marks={query.marks}
                    selectedId={selectedId !== null && selectedId >= first && selectedId <= last ? selectedId : null}
                    onMeasure={onMeasure}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* Volver al final cuando se ha subido a leer: al alcance del pulgar. */}
        {!follow && !selected && visible.length > 0 && (
          <div className="pop-in absolute bottom-3 right-4 z-20">
            <button
              type="button"
              onClick={startFollowing}
              className="press flex items-center gap-2 rounded-full border border-line bg-surface/95 px-3 py-1.5 text-xs font-semibold text-txt shadow-modal backdrop-blur-md hover:bg-surface2 max-sm:min-h-10"
            >
              <ArrowDown size={13} className="text-acc" />
              <span>Ir al final</span>
              {pendingNew > 0 && (
                <span className="rounded-full bg-acc px-1.5 py-0.5 text-micro font-bold text-white">
                  +{pendingNew > 999 ? '999+' : NF.format(pendingNew)}
                </span>
              )}
            </button>
          </div>
        )}

        {selected && (
          <LineDetail
            key={selected.id}
            n={selected.n}
            row={selected.row}
            canShowContext={filtering}
            onShowContext={() => showInContext(selected.id)}
            onClose={closeDetail}
          />
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
        <div className="h-full w-full overflow-hidden rounded-xl border border-line shadow-modal">{shell}</div>
      </div>,
      document.body,
    );
  }

  return shell;
}

const LogViewer = memo(LogViewerImpl);
export default LogViewer;
