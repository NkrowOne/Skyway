import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUpToLine,
  Check,
  Clock,
  Copy,
  Download,
  Hash,
  Maximize2,
  Minimize2,
  Search,
  Trash2,
  WrapText,
  X,
} from 'lucide-react';
import { cx, stripAnsi } from '../utils';

export type Level = 'err' | 'warn' | 'plain';
export type LevelFilter = 'all' | 'err' | 'warn';
export type LogStage = 'all' | 'build' | 'deploy' | 'runtime' | 'sys';
export type TimestampFormat = 'time' | 'datetime' | 'utc' | 'relative';

/** Formateador de miles reutilizable (locale fija). */
const NF = new Intl.NumberFormat('es');

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
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const time = d.toLocaleTimeString('es-ES', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `${day}/${month} ${time}`;
  }
  // format === 'time' (default)
  if (ts) {
    return new Date(ts).toLocaleTimeString('es-ES', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }
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

/** Badge de fase estilo Railway. */
function StageBadge({ stage }: { stage: LogStage }) {
  if (stage === 'all') return null;
  const color =
    stage === 'build'
      ? 'bg-sky-500/15 text-sky-400 border border-sky-500/25'
      : stage === 'deploy'
        ? 'bg-purple-500/15 text-purple-400 border border-purple-500/25'
        : stage === 'runtime'
          ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25'
          : 'bg-zinc-500/15 text-zinc-400 border border-zinc-500/25';
  return (
    <span className={cx('log-stage-badge mr-1.5 shrink-0 uppercase', color)}>
      {stage === 'sys' ? 'SYS' : stage}
    </span>
  );
}

/**
 * Fila de log individual memoizada: ultra-rápida y ligera.
 */
const LogRow = memo(function LogRow({
  n,
  text,
  tsString,
  tsTooltip,
  stage,
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
  stage: LogStage;
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
          className="log-gutter tnum select-none px-2 text-right text-[11px] tabular-nums"
          style={{ minWidth: '3.8ch' }}
        >
          {n}
        </span>
      )}
      {showTs && (
        <span
          className={cx(
            'log-ts tnum shrink-0 select-none px-2 text-[11px] tabular-nums transition-colors hover:text-txt',
            !tsString && 'opacity-0',
          )}
          title={tsTooltip}
          style={{ minWidth: tsString && tsString.length > 10 ? '14ch' : '8.5ch' }}
        >
          {tsString || '00:00:00'}
        </span>
      )}
      <span
        className={cx(
          'flex flex-1 items-baseline py-[1px] pr-3',
          !gutter && !showTs ? 'pl-3' : 'pl-1.5',
          wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
        )}
      >
        <StageBadge stage={stage} />
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
        'press flex h-7.5 w-7.5 sm:h-8 sm:w-8 items-center justify-center rounded-lg leading-none disabled:opacity-40 transition-colors',
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
 */
export default function LogViewer({
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
  reachedStart = false,
  onDownload,
  onFollowChange,
  tailAnchor = false,
  stageFilter: controlledStageFilter,
  onStageFilterChange,
  defaultStage = 'all',
  extraHeaderLeft,
  extraHeaderRight,
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
  reachedStart?: boolean;
  onDownload?: () => void;
  onFollowChange?: (follow: boolean) => void;
  tailAnchor?: boolean;
  stageFilter?: LogStage;
  onStageFilterChange?: (stage: LogStage) => void;
  defaultStage?: LogStage;
  extraHeaderLeft?: React.ReactNode;
  extraHeaderRight?: React.ReactNode;
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

  const [follow, setFollow] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [filter, setFilter] = useState('');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [internalStage, setInternalStage] = useState<LogStage>(defaultStage);
  const [wrap, setWrap] = useState(true);
  const [gutter, setGutter] = useState(true);
  const [showTs, setShowTs] = useState(true);
  const [tsFormat, setTsFormat] = useState<TimestampFormat>('time');
  const [tsMenuOpen, setTsMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [clearedUntil, setClearedUntil] = useState<number>(0);

  const stage = controlledStageFilter ?? internalStage;

  // Procesado memoizado O(1) de líneas
  const rows = useMemo(() => {
    const prev = procRef.current;
    const next = new Map<string, ParsedRow>();
    const effectiveLines = clearedUntil > 0 ? lines.slice(clearedUntil) : lines;
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
  }, [rows, filter, level, stage, tsFormat]);

  // Bloques virtualizados para alto rendimiento
  const chunks = useMemo(() => {
    const out: { key: number; rows: typeof visible }[] = [];
    for (let i = 0; i < visible.length; i += CHUNK) {
      const slice = visible.slice(i, i + CHUNK);
      out.push({ key: slice[0].n, rows: slice });
    }
    return out;
  }, [visible]);

  // Función robusta multi-frame para asegurar que SIEMPRE empieza y queda anclado en la parte inferior
  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      if (ref.current) {
        ref.current.scrollTop = ref.current.scrollHeight;
        const raf2 = requestAnimationFrame(() => {
          if (ref.current) {
            ref.current.scrollTop = ref.current.scrollHeight;
            setTimeout(() => {
              if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
            }, 50);
          }
        });
      }
    });
  }, []);

  // Al montar, al cambiar filtros o al recibir líneas mientras follow=true: siempre ir al final
  useEffect(() => {
    if (follow) {
      unreadCountRef.current = 0;
      setUnreadCount(0);
      scrollToBottom();
    } else {
      unreadCountRef.current += 1;
      setUnreadCount(unreadCountRef.current);
    }
  }, [visible.length, follow, scrollToBottom]);

  // Si cambia el filtro o fase, reiniciar a follow y saltar abajo
  useEffect(() => {
    setFollow(true);
    unreadCountRef.current = 0;
    setUnreadCount(0);
    scrollToBottom();
  }, [stage, level, filter, scrollToBottom]);

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

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (follow) scrollToBottom();
    else el.scrollTop = lastTopRef.current;
  }, [maximized, follow, scrollToBottom]);

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
    if (scrollRaf.current) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0;
      const el = ref.current;
      if (!el) return;
      lastTopRef.current = el.scrollTop;
      const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 45;
      setFollow(isAtBottom);
      if (isAtBottom) {
        unreadCountRef.current = 0;
        setUnreadCount(0);
      }
      if (el.scrollTop < 120 && el.scrollHeight - el.clientHeight > 200) triggerLoadOlder();
    });
  };

  useEffect(() => () => {
    if (scrollRaf.current) cancelAnimationFrame(scrollRaf.current);
  }, []);

  const jump = (to: 'top' | 'bottom') => {
    const el = ref.current;
    if (!el) return;
    if (to === 'top') {
      setFollow(false);
      el.scrollTop = 0;
    } else {
      setFollow(true);
      unreadCountRef.current = 0;
      setUnreadCount(0);
      scrollToBottom();
    }
  };

  const plainText = (includeTimestamps = showTs) => {
    return visible
      .map((v) => (includeTimestamps && v.tsString ? `${v.tsString} ${v.row.cleanText}` : v.row.cleanText))
      .join('\n');
  };

  const copyAll = () => {
    navigator.clipboard.writeText(plainText(showTs)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  const download = () => {
    const blob = new Blob([plainText(true)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName ?? `logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
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
        'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors duration-150',
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
        'log-shell relative flex min-h-0 h-full w-full flex-col overflow-hidden bg-term',
        maximized ? 'rounded-none' : cx(!bare && 'rounded-xl border border-line shadow-sm', className),
      )}
      style={{ '--log-line-h': maximized ? '23px' : '22px' } as React.CSSProperties}
    >
      {showChrome && (
        <div className="flex shrink-0 items-center justify-between gap-2.5 border-b border-line bg-term2 px-3 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            {extraHeaderLeft}
            {title && (
              <span className="truncate font-mono text-[11px] font-semibold uppercase tracking-[.08em] text-sub">
                {title}
              </span>
            )}
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-subtle">
              {!toolbar && (
                <span
                  className={cx('h-[6px] w-[6px] rounded-full', follow ? 'pulse-soft bg-ok' : 'bg-subtle')}
                  title={follow ? 'En vivo' : 'En pausa'}
                />
              )}
              <span className="tnum font-medium text-txt/80">{NF.format(rows.length)}</span>
              <span className="hidden sm:inline">líneas</span>
              {replicas > 1 && <span className="hidden text-subtle sm:inline">· {replicas} réplicas</span>}
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
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Buscar en los logs…"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent font-mono text-xs text-txt outline-none placeholder:text-subtle"
              />
              {filter && (
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-subtle tabular-nums font-mono">
                    {visible.length} match{visible.length === 1 ? '' : 'es'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setFilter('')}
                    className="press shrink-0 text-subtle hover:text-txt"
                    title="Limpiar filtro"
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
            {/* Selector de formato de fechas */}
            <div className="relative">
              <ToolButton
                title={showTs ? `Fechas: ${tsFormat} (clic para opciones)` : 'Mostrar marcas de tiempo'}
                onClick={() => setTsMenuOpen((o) => !o)}
                active={showTs}
              >
                <Clock size={14} />
              </ToolButton>
              {tsMenuOpen && (
                <div
                  className="absolute right-0 top-full z-40 mt-1 min-w-[185px] rounded-xl border border-line bg-surface p-1.5 shadow-modal"
                  onMouseLeave={() => setTsMenuOpen(false)}
                >
                  <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-subtle">
                    Marcas de tiempo
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setShowTs((s) => !s);
                      setTsMenuOpen(false);
                    }}
                    className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-surface2"
                  >
                    <span>Mostrar fechas</span>
                    {showTs && <Check size={12} className="text-acc" />}
                  </button>
                  <div className="my-1 border-t border-line" />
                  {(
                    [
                      { key: 'time', label: 'Hora (HH:mm:ss)' },
                      { key: 'datetime', label: 'Fecha + Hora (DD/MM HH:mm)' },
                      { key: 'utc', label: 'Hora UTC' },
                      { key: 'relative', label: 'Tiempo relativo' },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => {
                        setTsFormat(opt.key);
                        setShowTs(true);
                        setTsMenuOpen(false);
                      }}
                      className={cx(
                        'flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs',
                        tsFormat === opt.key && showTs ? 'bg-acc/10 font-semibold text-acc-soft' : 'hover:bg-surface2',
                      )}
                    >
                      <span>{opt.label}</span>
                      {tsFormat === opt.key && showTs && <Check size={12} className="text-acc" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <ToolButton title="Numerar líneas" onClick={() => setGutter((g) => !g)} active={gutter}>
              <Hash size={14} />
            </ToolButton>
            <ToolButton title="Ajuste de línea" onClick={() => setWrap((w) => !w)} active={wrap}>
              <WrapText size={14} />
            </ToolButton>
            <ToolButton title="Ir al inicio" onClick={() => jump('top')}>
              <ArrowUpToLine size={14} />
            </ToolButton>
            <ToolButton title="Ir al final" onClick={() => jump('bottom')}>
              <ArrowDownToLine size={14} />
            </ToolButton>
            <ToolButton title="Copiar texto visible" onClick={copyAll} disabled={visible.length === 0}>
              {copied ? <Check size={14} className="pop-in text-ok" /> : <Copy size={14} />}
            </ToolButton>
            <ToolButton
              title={onDownload ? 'Descargar log completo' : 'Descargar log'}
              onClick={onDownload ?? download}
              disabled={!onDownload && visible.length === 0}
            >
              <Download size={14} />
            </ToolButton>
            {clearedUntil === 0 && (
              <ToolButton title="Limpiar vista actual" onClick={clearBuffer} disabled={visible.length === 0}>
                <Trash2 size={13} />
              </ToolButton>
            )}
            {clearedUntil > 0 && (
              <button
                type="button"
                onClick={() => setClearedUntil(0)}
                className="press flex h-7 items-center rounded-md bg-surface2 px-2 text-[11px] text-sub hover:text-txt"
                title="Restaurar líneas ocultas"
              >
                Restaurar ({clearedUntil})
              </button>
            )}
          </div>
        </div>
      )}

      {toolbar && (
        <div className="flex shrink-0 items-center justify-between gap-2.5 border-b border-line bg-term2 px-3 py-1.5 text-[11px] text-subtle">
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
            {statusNote ? (
              <span className="text-warn font-medium">{statusNote}</span>
            ) : (
              <>
                <span>
                  <span className="tnum font-medium text-txt/90">{NF.format(visible.length)}</span>
                  {filtering ? ` de ${NF.format(rows.length)} líneas filtradas` : ' líneas'}
                </span>
                {counts.err > 0 && (
                  <>
                    <span className="text-line">·</span>
                    <span className="text-err font-medium">{counts.err} errores</span>
                  </>
                )}
                {counts.warn > 0 && (
                  <>
                    <span className="text-line">·</span>
                    <span className="text-warn font-medium">{counts.warn} avisos</span>
                  </>
                )}
              </>
            )}
          </span>

          {follow ? (
            <span className="badge-in inline-flex shrink-0 items-center gap-1.5 rounded-full border border-ok/25 bg-[color-mix(in_oklab,var(--color-ok)_12%,var(--color-term2))] px-2.5 py-0.5 text-[10.5px] font-medium text-ok">
              <span className="pulse-soft h-[5px] w-[5px] rounded-full bg-current" />
              En vivo
            </span>
          ) : (
            <button
              type="button"
              onClick={() => jump('bottom')}
              className="press badge-in inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface2 px-2.5 py-0.5 text-[10.5px] font-medium text-sub hover:text-txt"
            >
              <ArrowDownToLine size={11} /> Seguir al final
            </button>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1 w-full overflow-hidden">
        <div
          ref={ref}
          onScroll={onScroll}
          className={cx(
            'log-body h-full w-full font-mono text-[12.5px] leading-[1.65] text-txt/90',
            maximized && 'text-[13px] leading-[1.7]',
            wrap ? 'overflow-y-scroll overflow-x-hidden' : 'overflow-scroll',
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
            <div className="flex h-full min-h-[140px] items-center justify-center p-6 text-center text-xs text-subtle font-sans">
              {filtering ? 'Ninguna línea coincide con los filtros aplicados.' : 'Sin logs todavía…'}
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
                    stage={v.row.stage}
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
                <span className="rounded-full bg-acc px-1.5 py-0.2 text-[10px] font-bold text-white">
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
        className="console-in fixed inset-0 z-50 flex flex-col bg-bg p-3 outline-none sm:p-5"
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
