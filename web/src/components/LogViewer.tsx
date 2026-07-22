import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Check,
  Copy,
  Download,
  Hash,
  Maximize2,
  Minimize2,
  Search,
  WrapText,
  X,
} from 'lucide-react';
import { cx, stripAnsi } from '../utils';

type Level = 'err' | 'warn' | 'plain';
type LevelFilter = 'all' | 'err' | 'warn';

/** Heurística de niveles: error/fatal/panic → err; warn → warn; resto neutro. */
function detectLevel(line: string): Level {
  const l = line.toLowerCase();
  if (l.includes('error') || l.includes(' err ') || l.includes('fatal') || l.includes('panic') || l.includes('[error]'))
    return 'err';
  if (l.includes('warn')) return 'warn';
  return 'plain';
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
        'press flex h-8 w-8 items-center justify-center rounded-lg leading-none disabled:opacity-40',
        active ? 'bg-acc/[.16] text-acc-soft' : 'text-subtle hover:bg-surface2 hover:text-txt',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Consola de logs profesional. Un mismo primitivo para logs de servicio y de
 * despliegue, incrustado o a pantalla completa:
 *  · autoscroll inteligente (sigue el final salvo que el usuario suba);
 *  · filtro por texto (resaltado) y por nivel (error/aviso, con contadores);
 *  · numeración de línea en canalón fijo, ajuste de línea, copia y descarga;
 *  · cuerpo virtualizado (content-visibility) que aguanta buffers enormes;
 *  · botón de maximizar que promueve la MISMA consola a pantalla completa.
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
}: {
  lines: string[];
  className?: string;
  /** Barra de herramientas pro (filtro, niveles, numeración, ajuste, saltos, copiar, descargar). */
  toolbar?: boolean;
  /** Sin borde/radio propio: para incrustar bajo otra cabecera. */
  bare?: boolean;
  replicas?: number;
  downloadName?: string;
  statusNote?: string | null;
  /** Título del cromo de la consola (p. ej. «Build & deploy», «Logs en vivo»). */
  title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Caché incremental del procesado: los logs crecen por el final, así que
  // reprocesar TODO el buffer en cada línea nueva (stripAnsi + nivel) ahogaba el
  // móvil. Aquí se reutiliza lo ya procesado y solo se procesa la cola nueva.
  const procRef = useRef<{ src: string[] | null; rows: { text: string; lvl: Level }[] }>({ src: null, rows: [] });
  const scrollRaf = useRef(0);
  // Última posición de scroll: al maximizar/restaurar el cuerpo se reubica, así
  // que se restaura aquí para no perder el sitio de lectura (si no vamos al final).
  const lastTopRef = useRef(0);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState('');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [wrap, setWrap] = useState(true);
  const [gutter, setGutter] = useState(true);
  const [copied, setCopied] = useState(false);
  const [maximized, setMaximized] = useState(false);

  // Los builds reales (npm, docker…) emiten colores ANSI: se limpian una vez aquí
  // y filtro, niveles, copia y descarga trabajan ya sobre texto legible. El
  // procesado es INCREMENTAL: en el caso normal (llega una ráfaga por el final)
  // se reutiliza lo ya calculado y solo se procesa lo nuevo —clave para que el
  // móvil no se congele con buffers grandes—; solo se reprocesa entero al arrancar,
  // cambiar de servicio o recortar el buffer por el frente.
  const rows = useMemo(() => {
    const process = (raw: string) => ({ text: stripAnsi(raw), lvl: detectLevel(raw) as Level });
    const prev = procRef.current;
    const isAppend =
      !!prev.src &&
      prev.src.length > 0 &&
      lines.length >= prev.src.length &&
      lines[0] === prev.src[0] &&
      lines[prev.src.length - 1] === prev.src[prev.src.length - 1];
    const result = isAppend ? prev.rows.concat(lines.slice(prev.src!.length).map(process)) : lines.map(process);
    procRef.current = { src: lines, rows: result };
    return result;
  }, [lines]);

  const counts = useMemo(() => {
    let err = 0;
    let warn = 0;
    for (const r of rows) {
      if (r.lvl === 'err') err++;
      else if (r.lvl === 'warn') warn++;
    }
    return { err, warn };
  }, [rows]);

  // Se conserva el índice original (1-based) para el canalón: al filtrar por
  // nivel o texto los números siguen apuntando a la posición real en el flujo.
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const out: { n: number; text: string; lvl: Level }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (level !== 'all' && r.lvl !== level) continue;
      if (q && !r.text.toLowerCase().includes(q)) continue;
      out.push({ n: i + 1, text: r.text, lvl: r.lvl });
    }
    return out;
  }, [rows, filter, level]);

  useEffect(() => {
    if (!follow) return;
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    // Con content-visibility la altura de las filas fuera de pantalla es una
    // estimación; se reaplica un frame después para clavar el fondo real cuando
    // llega un lote grande (p. ej. el snapshot de un despliegue).
    const raf = requestAnimationFrame(() => {
      if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, follow]);

  // Al maximizar/restaurar el nodo se reubica: si veníamos siguiendo, al final;
  // si el usuario había subido a leer, se recupera su posición (no se salta arriba).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = follow ? el.scrollHeight : lastTopRef.current;
  }, [maximized]); // eslint-disable-line react-hooks/exhaustive-deps

  // A pantalla completa: bloquea el scroll del fondo, marca el resto de la app
  // como inerte (foco atrapado + fuera del árbol de accesibilidad), cierra con
  // Esc, da foco al diálogo y devuelve el foco al disparador al salir.
  useEffect(() => {
    if (!maximized) return;
    const root = document.getElementById('root');
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // El diálogo vive en document.body (portal), fuera de #root, así que inertar
    // #root contiene el foco y el lector de pantalla sin tocar el diálogo.
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

  // El scroll táctil dispara este evento decenas de veces por gesto; sin acotar,
  // cada uno forzaba layout + un posible re-render del buffer entero. Se limita a
  // una lectura por frame (y se cancela al desmontar).
  const onScroll = () => {
    if (scrollRaf.current) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0;
      const el = ref.current;
      if (!el) return;
      lastTopRef.current = el.scrollTop;
      setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
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
      el.scrollTop = el.scrollHeight;
    }
  };

  const plainText = () => visible.map((v) => v.text).join('\n');

  const copyAll = () => {
    navigator.clipboard.writeText(plainText()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const download = () => {
    const blob = new Blob([plainText()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName ?? `logs-${new Date().toISOString().slice(0, 19)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const nf = new Intl.NumberFormat('es');
  const filtering = level !== 'all' || filter.trim().length > 0;
  const showChrome = toolbar || !!title || maximized;

  const levelChip = (key: LevelFilter, label: string, n?: number, tone?: 'err' | 'warn') => (
    <button
      type="button"
      onClick={() => setLevel(key)}
      aria-pressed={level === key}
      className={cx(
        'flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium transition-colors duration-150',
        level === key
          ? tone === 'err'
            ? 'bg-err/[.16] text-err'
            : tone === 'warn'
              ? 'bg-warn/[.16] text-warn'
              : 'bg-acc/[.16] text-acc-soft'
          : 'text-subtle hover:bg-surface2 hover:text-txt',
      )}
    >
      {tone && <span className={cx('h-[6px] w-[6px] rounded-full', tone === 'err' ? 'bg-err' : 'bg-warn')} />}
      {label}
      {n !== undefined && n > 0 && <span className="tnum opacity-80">{nf.format(n)}</span>}
    </button>
  );

  const shell = (
    <section
      className={cx(
        'log-shell relative flex min-h-0 flex-col overflow-hidden bg-term',
        maximized ? 'h-full rounded-none' : cx(!bare && 'rounded-lg border border-line', className),
      )}
      style={{ '--log-line-h': maximized ? '22px' : '21px' } as React.CSSProperties}
    >
      {showChrome && (
        <div className="flex shrink-0 items-center gap-2.5 border-b border-line bg-term2 px-3 py-2">
          <span className="flex min-w-0 items-center gap-2">
            {title && (
              <span className="truncate font-mono text-[10.5px] font-medium uppercase tracking-[.09em] text-sub">
                {title}
              </span>
            )}
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-subtle">
              <span
                className={cx('h-[6px] w-[6px] rounded-full', follow ? 'pulse-soft bg-ok' : 'bg-subtle')}
                title={follow ? 'En vivo' : 'En pausa (has subido)'}
              />
              <span className="tnum">{nf.format(rows.length)}</span>
              <span className="hidden sm:inline">líneas</span>
              {replicas > 1 && <span className="hidden text-subtle sm:inline">· réplica 1/{replicas}</span>}
            </span>
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
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

      {toolbar && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line bg-term2 px-2.5 py-2">
          <div className="flex h-8 min-w-[150px] flex-1 items-center gap-2 rounded-lg border border-line bg-term px-2.5 focus-within:border-acc">
            <Search size={13} className="shrink-0 text-subtle" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filtrar… (p. ej. error, ECONNREFUSED, /api)"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent font-mono text-xs text-txt outline-none placeholder:text-subtle"
            />
            {filter && (
              <button
                type="button"
                onClick={() => setFilter('')}
                className="press shrink-0 text-subtle hover:text-txt"
                title="Limpiar filtro"
                aria-label="Limpiar filtro"
              >
                <X size={13} />
              </button>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-term p-0.5">
            {levelChip('all', 'Todo')}
            {levelChip('err', 'Errores', counts.err, 'err')}
            {levelChip('warn', 'Avisos', counts.warn, 'warn')}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
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
            <ToolButton title="Copiar líneas visibles" onClick={copyAll} disabled={visible.length === 0}>
              {copied ? <Check size={14} className="pop-in text-ok" /> : <Copy size={14} />}
            </ToolButton>
            <ToolButton title="Descargar" onClick={download} disabled={visible.length === 0}>
              <Download size={14} />
            </ToolButton>
          </div>
        </div>
      )}

      {toolbar && (
        <p className="flex shrink-0 flex-wrap items-center gap-x-2 border-b border-line bg-term2 px-3 py-1.5 text-[11px] text-subtle">
          {statusNote ? (
            <span className="text-warn">{statusNote}</span>
          ) : (
            <>
              <span>
                <span className="tnum text-sub">{nf.format(visible.length)}</span>
                {filtering ? ` de ${nf.format(rows.length)} líneas` : ' líneas'}
              </span>
              <span className="text-line">·</span>
              <span>
                <span className="text-err">error</span> y <span className="text-warn">warn</span> resaltados
              </span>
            </>
          )}
        </p>
      )}

      <div className={cx('relative min-h-0', showChrome || toolbar ? 'flex-1' : 'h-full')}>
        <div
          ref={ref}
          onScroll={onScroll}
          className={cx(
            // overscroll-contain: al llegar al borde, el scroll no salta al panel
            // de detrás (en móvil eso «atrapaba» el gesto y parecía un bloqueo).
            'h-full overscroll-contain font-mono text-[12.5px] leading-[1.65] text-txt/90',
            maximized && 'text-[13px] leading-[1.7]',
            wrap ? 'overflow-y-auto overflow-x-hidden' : 'overflow-auto',
          )}
          role="log"
          // Sin anuncios en vivo: un flujo rápido saturaría al lector de pantalla.
          // El indicador «En vivo», el contador y copiar/descargar dan el contenido.
          aria-live="off"
          aria-label="Salida de registro"
        >
          {visible.length === 0 ? (
            <span className="block px-3 py-3 text-subtle">
              {filtering ? 'Ninguna línea coincide con el filtro.' : 'Sin logs todavía…'}
            </span>
          ) : (
            visible.map((v) => (
              <div
                key={v.n}
                className={cx(
                  'log-row flex',
                  wrap ? 'w-full' : 'w-max min-w-full',
                  v.lvl === 'err' && 'log-row-err',
                  v.lvl === 'warn' && 'log-row-warn',
                )}
              >
                {gutter && (
                  <span className="log-gutter tnum select-none px-2.5 text-right text-[11px] tabular-nums" style={{ minWidth: '3.5ch' }}>
                    {v.n}
                  </span>
                )}
                <span className={cx('py-[1px] pr-3', gutter ? 'pl-2' : 'pl-3', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>
                  {highlight(v.text, filter.trim())}
                </span>
              </div>
            ))
          )}
        </div>

        {follow
          ? (toolbar || maximized) && (
              <span className="badge-in pointer-events-none absolute bottom-2.5 right-3 inline-flex items-center gap-[5px] rounded-full border border-ok/35 bg-[color-mix(in_oklab,var(--color-ok)_16%,var(--color-term))] px-2.5 py-[3px] text-[11px] font-medium text-ok shadow-lvl1">
                <span className="pulse-soft h-[5px] w-[5px] rounded-full bg-current" />
                En vivo
              </span>
            )
          : (
            <button
              type="button"
              onClick={() => jump('bottom')}
              className="badge-in press absolute bottom-2.5 right-3 inline-flex items-center gap-1 rounded-full border border-line bg-surface2 px-3 py-1 text-xs text-sub shadow-lvl1 hover:text-txt"
            >
              <ArrowDownToLine size={12} /> Seguir el final
            </button>
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
        aria-label={title ? `${title} — pantalla completa` : 'Consola de logs a pantalla completa'}
        tabIndex={-1}
        className="console-in fixed inset-0 z-[70] flex flex-col bg-term p-0 outline-none sm:p-3"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setMaximized(false);
        }}
      >
        <div className="flex min-h-0 flex-1 overflow-hidden sm:rounded-2xl sm:border sm:border-line sm:shadow-lvl3">
          {shell}
        </div>
      </div>,
      document.body,
    );
  }

  return shell;
}
