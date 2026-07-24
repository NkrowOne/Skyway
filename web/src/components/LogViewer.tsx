import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Check,
  Copy,
  Download,
  Hash,
  Loader2,
  Maximize2,
  Minimize2,
  Search,
  WrapText,
  X,
} from 'lucide-react';
import { cx, stripAnsi } from '../utils';

type Level = 'err' | 'warn' | 'plain';
type LevelFilter = 'all' | 'err' | 'warn';

/** Formateador de miles reutilizable (locale fija): crearlo en cada render es caro
 *  y LogViewer re-renderiza por cada lote de líneas durante el streaming en vivo. */
const NF = new Intl.NumberFormat('es');

/** Filas agrupadas en tramos para virtualizar por bloque (ver index.css). */
const CHUNK = 64;

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

/**
 * Una fila de log, memoizada: cuando llegan líneas nuevas por el final, las
 * filas previas conservan sus props y React se salta su re-render (clave para
 * que el streaming no reconcilie todo el buffer). El resaltado se computa aquí.
 */
const LogRow = memo(function LogRow({
  n,
  text,
  lvl,
  wrap,
  gutter,
  query,
}: {
  n: number;
  text: string;
  lvl: Level;
  wrap: boolean;
  gutter: boolean;
  query: string;
}) {
  return (
    <div
      className={cx(
        'log-row flex',
        wrap ? 'w-full' : 'w-max min-w-full',
        lvl === 'err' && 'log-row-err',
        lvl === 'warn' && 'log-row-warn',
      )}
    >
      {gutter && (
        <span className="log-gutter tnum select-none px-2.5 text-right text-[11px] tabular-nums" style={{ minWidth: '3.5ch' }}>
          {n}
        </span>
      )}
      <span className={cx('py-[1px] pr-3', gutter ? 'pl-2' : 'pl-3', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>
        {highlight(text, query)}
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
  onLoadOlder,
  canLoadOlder = false,
  loadingOlder = false,
  reachedStart = false,
  onDownload,
  onFollowChange,
  tailAnchor = false,
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
  /** Si se pasa, activa la carga de historial al subir (paginación hacia atrás). */
  onLoadOlder?: () => void;
  /** Hay líneas más antiguas por cargar (muestra el botón y arma el auto-scroll). */
  canLoadOlder?: boolean;
  /** Una carga de historial está en curso. */
  loadingOlder?: boolean;
  /** Se ha llegado al principio del registro (no hay más historial). */
  reachedStart?: boolean;
  /** Descarga a medida (p. ej. el log completo desde el servidor); reemplaza a la local. */
  onDownload?: () => void;
  /** Notifica al contenedor si el visor sigue el final (para su política de recorte). */
  onFollowChange?: (follow: boolean) => void;
  /** Ancla el contenido al fondo cuando aún no llena la vista: el registro más
   *  nuevo queda abajo del todo (estilo terminal). Para los logs en vivo. */
  tailAnchor?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Caché del procesado por texto de línea: stripAnsi + nivel son funciones puras
  // de la línea, así que se memorizan y solo se computa lo nuevo. Se reconstruye
  // el mapa con las líneas vigentes en cada pasada (memoria acotada), lo que hace
  // el procesado O(n) barato y robusto tanto si el buffer crece por el final
  // (streaming) como por el frente (cargar historial) o se recorta —clave para
  // que el móvil no se ahogue con buffers grandes.
  const procRef = useRef(new Map<string, { text: string; lvl: Level }>());
  const scrollRaf = useRef(0);
  // Ancla para conservar el sitio de lectura al anteponer historial: alto y
  // scroll del cuerpo justo antes de pedir el tramo. Al llegar, se desplaza el
  // scroll por el alto EXACTO añadido por el frente (newScrollHeight − alto
  // guardado), así el contenido visible no se mueve sea cual sea la estimación
  // de alto de las filas nuevas fuera de pantalla.
  const anchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  // Evita re-disparar la carga de historial mientras una está en curso.
  const olderRequestedRef = useRef(false);
  // Detección de crecimiento por el frente (prepend) entre renders.
  const prevFirstRef = useRef<string | undefined>(undefined);
  const prevLenRef = useRef(0);
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
  // y filtro, niveles, copia y descarga trabajan ya sobre texto legible.
  const rows = useMemo(() => {
    const prev = procRef.current;
    const next = new Map<string, { text: string; lvl: Level }>();
    const result = lines.map((raw) => {
      let r = next.get(raw) ?? prev.get(raw);
      if (!r) r = { text: stripAnsi(raw), lvl: detectLevel(raw) };
      next.set(raw, r);
      return r;
    });
    procRef.current = next;
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

  // Se agrupan las filas en tramos: cada tramo lleva content-visibility (ver
  // index.css), de modo que el navegador evalúa la visibilidad de pocos bloques
  // en vez de miles de filas. La clave del tramo es el nº de su primera fila:
  // estable al añadir por el final (los tramos previos no se remontan).
  const chunks = useMemo(() => {
    const out: { key: number; rows: typeof visible }[] = [];
    for (let i = 0; i < visible.length; i += CHUNK) {
      const slice = visible.slice(i, i + CHUNK);
      out.push({ key: slice[0].n, rows: slice });
    }
    return out;
  }, [visible]);

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

  // Informa al contenedor de si seguimos el final: lo usa para no recortar el
  // frente del buffer (el historial que el usuario lee) mientras está arriba.
  useEffect(() => {
    onFollowChange?.(follow);
  }, [follow, onFollowChange]);

  // Rearma la carga de historial cuando termina la anterior.
  useEffect(() => {
    if (!loadingOlder) olderRequestedRef.current = false;
  }, [loadingOlder]);

  // Al anteponer historial (el buffer crece por el FRENTE) se conserva el punto
  // de lectura desplazando el scroll por el alto añadido arriba. Un append por el
  // final no cambia el frente y no ancla nada.
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

  // Guarda alto y scroll del cuerpo justo antes de pedir historial, para reponer
  // el sitio de lectura cuando el buffer crezca por el frente.
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
      // Scroll infinito hacia arriba: al acercarse al frente carga historial,
      // solo si hay recorrido real (si el log cabe en pantalla, se usa el botón).
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
      {n !== undefined && n > 0 && <span className="tnum opacity-80">{NF.format(n)}</span>}
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
              {/* Sin barra de indicaciones (consola sin `toolbar`), el punto vivo/pausa
                  vive aquí; con `toolbar`, el estado del flujo lo lleva el pie —evita
                  duplicar el indicador. */}
              {!toolbar && (
                <span
                  className={cx('h-[6px] w-[6px] rounded-full', follow ? 'pulse-soft bg-ok' : 'bg-subtle')}
                  title={follow ? 'En vivo' : 'En pausa (has subido)'}
                />
              )}
              <span className="tnum">{NF.format(rows.length)}</span>
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
            <ToolButton
              title={onDownload ? 'Descargar log completo' : 'Descargar'}
              onClick={onDownload ?? download}
              disabled={!onDownload && visible.length === 0}
            >
              <Download size={14} />
            </ToolButton>
          </div>
        </div>
      )}

      {toolbar && (
        <div className="flex shrink-0 items-center gap-2.5 border-b border-line bg-term2 px-3 py-2 text-[11px] text-subtle">
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
            {statusNote ? (
              <span className="text-warn">{statusNote}</span>
            ) : (
              <>
                <span>
                  <span className="tnum text-sub">{NF.format(visible.length)}</span>
                  {filtering ? ` de ${NF.format(rows.length)} líneas` : ' líneas'}
                </span>
                <span className="text-line">·</span>
                <span>
                  <span className="text-err">error</span> y <span className="text-warn">warn</span> resaltados
                </span>
              </>
            )}
          </span>
          {/* Estado del flujo. Antes flotaba sobre los logs y los tapaba; ahora se
              ancla al pie de las indicaciones, como cierre de la barra: «En vivo»
              mientras se sigue el final; si el usuario ha subido a leer, un botón
              sobrio para reengancharse. */}
          {follow ? (
            <span className="badge-in inline-flex shrink-0 items-center gap-1.5 rounded-full border border-ok/25 bg-[color-mix(in_oklab,var(--color-ok)_12%,var(--color-term2))] px-2.5 py-1 font-medium text-ok">
              <span className="pulse-soft h-[5px] w-[5px] rounded-full bg-current" />
              En vivo
            </span>
          ) : (
            <button
              type="button"
              onClick={() => jump('bottom')}
              className="press badge-in inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface2 px-2.5 py-1 font-medium text-sub hover:text-txt"
            >
              <ArrowDownToLine size={12} /> Seguir el final
            </button>
          )}
        </div>
      )}

      <div className={cx('relative min-h-0', showChrome || toolbar ? 'flex-1' : 'h-full')}>
        <div
          ref={ref}
          onScroll={onScroll}
          className={cx(
            // log-body: capa de composición propia + aislamiento de pintado, para que
            // el scroll de un panel ANCESTRO (o la barra de URL del móvil) traslade la
            // capa en vez de repintar miles de filas (lo que congelaba la página).
            // overscroll-contain: al llegar al borde, el scroll no salta al panel
            // de detrás (en móvil eso «atrapaba» el gesto y parecía un bloqueo).
            'log-body h-full overscroll-contain font-mono text-[12.5px] leading-[1.65] text-txt/90',
            maximized && 'text-[13px] leading-[1.7]',
            wrap ? 'overflow-y-auto overflow-x-hidden' : 'overflow-auto',
          )}
          role="log"
          // Sin anuncios en vivo: un flujo rápido saturaría al lector de pantalla.
          // El indicador «En vivo», el contador y copiar/descargar dan el contenido.
          aria-live="off"
          aria-label="Salida de registro"
        >
          {/* Ancla al fondo: con pocas líneas, el registro más nuevo queda abajo del
              todo (estilo terminal); con muchas, desborda y scrollea con normalidad. */}
          <div className={cx(tailAnchor && 'flex min-h-full flex-col justify-end')}>
          {onLoadOlder && (loadingOlder || canLoadOlder || reachedStart) && (
            <div className="flex items-center justify-center gap-2 border-b border-line/60 px-3 py-2 text-[11px] text-subtle">
              {loadingOlder ? (
                <>
                  <Loader2 size={13} className="animate-spin motion-reduce:animate-none" />
                  Cargando líneas anteriores…
                </>
              ) : canLoadOlder ? (
                <button
                  type="button"
                  onClick={triggerLoadOlder}
                  className="press inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface2 px-3 py-1 font-medium text-sub hover:text-txt"
                >
                  <ArrowUp size={12} /> Cargar líneas anteriores
                </button>
              ) : (
                <span className="inline-flex items-center gap-2 text-subtle">
                  <span className="h-px w-6 bg-line" /> Inicio del registro <span className="h-px w-6 bg-line" />
                </span>
              )}
            </div>
          )}
          {visible.length === 0 ? (
            <span className="block px-3 py-3 text-subtle">
              {filtering ? 'Ninguna línea coincide con el filtro.' : 'Sin logs todavía…'}
            </span>
          ) : (
            chunks.map((ch) => (
              <div key={ch.key} className="log-chunk" style={{ '--rows': ch.rows.length } as React.CSSProperties}>
                {ch.rows.map((v) => (
                  <LogRow key={v.n} n={v.n} text={v.text} lvl={v.lvl} wrap={wrap} gutter={gutter} query={filter.trim()} />
                ))}
              </div>
            ))
          )}
          </div>
        </div>

        {/* El estado del flujo (En vivo / Seguir el final) vive en la barra de
            indicaciones cuando hay `toolbar`, para no tapar los logs. Sin esa barra
            (consola mínima) se conserva aquí el botón flotante para reengancharse. */}
        {!toolbar && !follow && (
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
