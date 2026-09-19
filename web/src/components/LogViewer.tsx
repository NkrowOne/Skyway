import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { cx, stripAnsi } from '../utils';
import { ErrorState, Menu, MenuItem, Spinner } from './ui';

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

/** Filas agrupadas en tramos para virtualizar por bloque (ver index.css). */
const CHUNK = 48;

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
function parseRawLine(raw: string, defaultStage: LogStage = 'all'): ParsedRow {
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
        'log-row flex items-baseline hover:bg-white/[.02]',
        wrap ? 'w-full' : 'w-max min-w-full',
        lvl === 'err' && 'log-row-err',
        lvl === 'warn' && 'log-row-warn',
      )}
    >
      {gutter && (
        <span
          className="log-gutter tnum select-none px-2 text-right text-xs tabular-nums text-subtle/70"
          style={{ minWidth: '3.8ch' }}
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
        <span className="min-w-0 flex-1">{highlight(text, query)}</span>
      </span>
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
 * Consola de logs profesional estilo Railway con scroll al fondo garantizado,
 * soporte de marcas de tiempo completas y herramientas avanzadas.
 *
 * Va en `memo`: la pestaña que lo aloja se re-renderiza con cada sondeo de
 * despliegues aunque no haya líneas nuevas, y el visor arrastra miles de filas.
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
  const ref = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const procRef = useRef(new Map<string, ParsedRow>());
  const scrollRaf = useRef(0);
  const anchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const olderRequestedRef = useRef(false);
  const prevFirstRef = useRef<string | undefined>(undefined);
  const prevLenRef = useRef(0);
  const lastTopRef = useRef(0);
  const unreadCountRef = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const [follow, setFollow] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [filter, setFilter] = useState('');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [internalStage, setInternalStage] = useState<LogStage>(defaultStage);
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

  // Procesado memoizado O(1) de líneas
  const rows = useMemo(() => {
    const prev = procRef.current;
    const next = new Map<string, ParsedRow>();
    const effectiveLines = clearedUntil > 0 && clearedUntil <= lines.length ? lines.slice(clearedUntil) : lines;
    const result = effectiveLines.map((raw) => {
      let r = next.get(raw) ?? prev.get(raw);
      if (!r) r = parseRawLine(raw, defaultStage);
      next.set(raw, r);
      return r;
    });
    procRef.current = next;
    return result;
  }, [lines, clearedUntil, defaultStage]);

  const counts = useMemo(() => {
    let err = 0;
    let warn = 0;
    for (const r of rows) {
      if (r.lvl === 'err') err++;
      else if (r.lvl === 'warn') warn++;
    }
    return { err, warn };
  }, [rows]);

  // Filtrado de filas visibles
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const out: { n: number; row: ParsedRow; tsString: string; tsTooltip?: string }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (level !== 'all' && r.lvl !== level) continue;
      if (stage !== 'all' && r.stage !== 'all' && r.stage !== stage) continue;
      if (q && !r.cleanText.toLowerCase().includes(q)) continue;
      const tsString = formatTimestamp(r.ts, r.iso, tsFormat);
      const tsTooltip = timestampTooltip(r.ts, r.iso);
      out.push({ n: i + 1, row: r, tsString, tsTooltip });
    }
    return out;
    // `tick` solo refresca los relativos; no cambia qué filas se ven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filter, level, stage, tsFormat, tick]);

  // Bloques virtualizados para alto rendimiento
  const chunks = useMemo(() => {
    const out: { key: number; rows: typeof visible }[] = [];
    for (let i = 0; i < visible.length; i += CHUNK) {
      const slice = visible.slice(i, i + CHUNK);
      out.push({ key: slice[0].n, rows: slice });
    }
    return out;
  }, [visible]);

  /*
   * El seguimiento vive también en una ref, actualizada en el mismo instante
   * del scroll (no al siguiente render): así ningún salto programado al fondo
   * pisa un gesto del dedo que acaba de empezar.
   *
   * Antes había cinco intentos escalonados (dos frames y dos temporizadores
   * hasta 350 ms) sin comprobar nada: si subías justo después de que llegara
   * una línea, el último te devolvía abajo, el scroll detectaba «al fondo» y
   * se reactivaba el seguimiento. En el móvil, con el momentum, era imposible
   * quedarse leyendo arriba mientras entraba texto.
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
  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (gestureRef.current) {
      pendingBottomRef.current = true;
      return;
    }
    el.scrollTop = el.scrollHeight;
    // Un segundo intento tras el layout: las filas nuevas pueden medir
    // distinto una vez pintadas (ajuste de línea). Solo si nadie se ha movido.
    requestAnimationFrame(() => {
      if (followRef.current && !gestureRef.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    });
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
      }
    }, 180);
  }, [scrollToBottom]);
  useEffect(() => () => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
  }, []);

  // Al recibir líneas con el seguimiento activo, al fondo ANTES de pintar (sin parpadeo).
  const prevVisibleLenRef = useRef(0);
  useLayoutEffect(() => {
    const delta = visible.length - prevVisibleLenRef.current;
    prevVisibleLenRef.current = visible.length;
    if (followRef.current) {
      if (unreadCountRef.current !== 0) {
        unreadCountRef.current = 0;
        setUnreadCount(0);
      }
      scrollToBottom();
    } else if (delta > 0) {
      // Se cuentan LÍNEAS, no renders: una ráfaga de 300 líneas en un frame
      // decía «+1».
      unreadCountRef.current += delta;
      setUnreadCount(unreadCountRef.current);
    }
  }, [visible.length, scrollToBottom]);

  // Si el hueco cambia de alto (acordeón, teclado del móvil, giro) y se estaba
  // siguiendo, el fondo sigue siendo el fondo.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (followRef.current) scrollToBottom();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [maximized, scrollToBottom]);

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
  }, [stage, level, filter, startFollowing]);

  useEffect(() => {
    onFollowChange?.(follow);
  }, [follow, onFollowChange]);

  useEffect(() => {
    if (!loadingOlder) olderRequestedRef.current = false;
  }, [loadingOlder]);

  useLayoutEffect(() => {
    const first = lines[0];
    const grewFront =
      prevFirstRef.current !== undefined && first !== prevFirstRef.current && lines.length > prevLenRef.current;
    if (grewFront && anchorRef.current) {
      const el = ref.current;
      const a = anchorRef.current;
      if (el) el.scrollTop = a.scrollTop + (el.scrollHeight - a.scrollHeight);
      anchorRef.current = null;
    }
    prevFirstRef.current = first;
    prevLenRef.current = lines.length;
  }, [lines]);

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

  const captureAnchor = () => {
    const el = ref.current;
    if (el) anchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
  };

  const triggerLoadOlder = () => {
    if (!onLoadOlder || loadingOlder || !canLoadOlder || olderRequestedRef.current) return;
    olderRequestedRef.current = true;
    captureAnchor();
    onLoadOlder();
  };

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    // La ref se decide YA, en el propio evento; el estado (que repinta) se
    // agrupa por frame.
    lastTopRef.current = el.scrollTop;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 45;
    followRef.current = isAtBottom;
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
      if (node.scrollTop < 120 && node.scrollHeight - node.clientHeight > 200) triggerLoadOlder();
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
      el.scrollTop = 0;
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
    navigator.clipboard
      .writeText(plainText(showTs))
      .then(() => {
        setCopied(true);
        window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1400);
      })
      // Sin HTTPS o con el permiso denegado el portapapeles rechaza: antes era
      // un rechazo sin capturar y el check de «copiado» simplemente no salía.
      .catch(() => setCopied(false));
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

  const filtering = level !== 'all' || stage !== 'all' || filter.trim().length > 0;
  const showChrome = toolbar || !!title || maximized || !!extraHeaderLeft || !!extraHeaderRight;

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
      style={{ '--log-line-h': maximized ? '23px' : '22px' } as React.CSSProperties}
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
                placeholder="Buscar en los logs…"
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
                error y llevarse el log. Lo demás vive en «Vista», que es donde
                se busca lo que se toca una vez. Antes eran ocho iconos
                idénticos en fila y había que probarlos uno a uno. */}
            <button
              type="button"
              onClick={() => jump('bottom')}
              className="press flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-sub transition-colors hover:bg-surface2 hover:text-txt sm:h-8"
              title="Ir al final del registro"
            >
              {/* Distinto del icono de descargar: a 14px eran dos flechas iguales. */}
              <ChevronsDown size={14} aria-hidden />
              <span>Al final</span>
            </button>
            <button
              type="button"
              onClick={onDownload ?? download}
              disabled={!onDownload && visible.length === 0}
              className="press flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-sub transition-colors hover:bg-surface2 hover:text-txt disabled:opacity-40 sm:h-8"
              title={onDownload ? 'Descargar el log completo' : 'Descargar el log'}
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
                title="Cómo se ve el registro"
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
                    icon={copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
                    onClick={copyAll}
                    className={cx(visible.length === 0 && 'pointer-events-none opacity-40')}
                  >
                    Copiar lo que se ve
                  </MenuItem>
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
                      Restaurar {clearedUntil} líneas ocultas
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
          {canLoadOlder && (
            <div className="flex justify-center p-2.5">
              <button
                type="button"
                onClick={triggerLoadOlder}
                disabled={loadingOlder}
                className="press inline-flex items-center gap-1.5 rounded-lg border border-line bg-term2 px-3 py-1 text-xs text-sub hover:text-txt disabled:opacity-50"
              >
                {loadingOlder ? 'Cargando líneas anteriores…' : 'Cargar historial anterior ↑'}
              </button>
            </div>
          )}

          {visible.length === 0 ? (
            <div className="flex h-full min-h-[140px] items-center justify-center p-6 text-center font-sans">
              {state === 'loading' ? (
                <Spinner label="Cargando los logs…" />
              ) : state === 'error' ? (
                <ErrorState compact title="No se han podido cargar los logs" onRetry={onRetry} />
              ) : (
                <span className="max-w-sm text-balance text-xs leading-5 text-subtle">
                  {filtering ? 'Ninguna línea coincide con los filtros aplicados.' : emptyMessage ?? 'Sin logs todavía…'}
                </span>
              )}
            </div>
          ) : (
            chunks.map((c) => (
              <div
                key={c.key}
                className="log-chunk"
                style={{ '--rows': c.rows.length } as React.CSSProperties}
              >
                {c.rows.map((v) => (
                  <LogRow
                    key={v.n}
                    n={v.n}
                    text={v.row.cleanText}
                    tsString={v.tsString}
                    tsTooltip={v.tsTooltip}
                    lvl={v.row.lvl}
                    wrap={wrap}
                    gutter={gutter}
                    showTs={showTs}
                    query={filter}
                  />
                ))}
              </div>
            ))
          )}
        </div>

        {/* Botón flotante estilo Railway para volver al final si el usuario scrollea hacia arriba */}
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
        aria-label={title ? `${title} — pantalla completa` : 'Consola de logs'}
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
