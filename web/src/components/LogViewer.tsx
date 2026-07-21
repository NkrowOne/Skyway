import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpToLine, Check, Copy, Download, Search, WrapText } from 'lucide-react';
import { cx, stripAnsi } from '../utils';

/** Heurística de niveles: líneas con error→err, warn→warn. */
function levelClass(line: string): string | undefined {
  const l = line.toLowerCase();
  if (l.includes('error') || l.includes(' err ') || l.includes('fatal')) return 'text-err';
  if (l.includes('warn')) return 'text-warn';
  return undefined;
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
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'press rounded-lg p-[7px] leading-none disabled:opacity-40',
        active ? 'bg-acc/[.14] text-acc-soft' : 'text-subtle hover:bg-surface2 hover:text-txt',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Visor de logs con autoscroll inteligente (sigue el final salvo que el usuario
 * suba) y, en modo `toolbar`, filtro, ajuste de línea, saltos, copia y descarga.
 */
export default function LogViewer({
  lines,
  className,
  toolbar = false,
  bare = false,
  replicas = 1,
  downloadName,
  statusNote,
}: {
  lines: string[];
  className?: string;
  /** Muestra la barra de herramientas pro (filtro, wrap, saltos, copiar, descargar). */
  toolbar?: boolean;
  /** Sin borde/radio propio: para incrustar bajo una cabecera de terminal. */
  bare?: boolean;
  replicas?: number;
  downloadName?: string;
  statusNote?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState('');
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);

  // Los builds reales (npm, docker…) emiten colores ANSI: se limpian una vez aquí
  // y filtro, copia y descarga trabajan ya sobre texto legible.
  const clean = useMemo(() => lines.map(stripAnsi), [lines]);

  const visible = useMemo(() => {
    if (!filter.trim()) return clean;
    const q = filter.toLowerCase();
    return clean.filter((l) => l.toLowerCase().includes(q));
  }, [clean, filter]);

  useEffect(() => {
    if (follow && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [visible, follow]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

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

  const copyAll = () => {
    navigator.clipboard.writeText(visible.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const download = () => {
    const blob = new Blob([visible.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName ?? `logs-${new Date().toISOString().slice(0, 19)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const fmtCount = new Intl.NumberFormat('es').format(visible.length);

  return (
    <div className={cx('flex min-h-0 flex-col gap-2.5', className)}>
      {toolbar && (
        <>
          <div className="flex items-center gap-1">
            <div className="mr-1 flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-bg px-2.5 py-1.5 focus-within:border-acc">
              <Search size={13} className="shrink-0 text-subtle" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filtrar líneas… (p. ej. error, /api)"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent font-mono text-xs text-txt outline-none placeholder:text-subtle"
              />
            </div>
            <ToolButton title="Ajuste de línea" onClick={() => setWrap(!wrap)} active={wrap}>
              <WrapText size={14} />
            </ToolButton>
            <ToolButton title="Ir al inicio" onClick={() => jump('top')}>
              <ArrowUpToLine size={14} />
            </ToolButton>
            <ToolButton title="Ir al final" onClick={() => jump('bottom')}>
              <ArrowDownToLine size={14} />
            </ToolButton>
            <ToolButton title="Copiar logs visibles" onClick={copyAll} disabled={visible.length === 0}>
              {copied ? <Check size={14} className="pop-in text-ok" /> : <Copy size={14} />}
            </ToolButton>
            <ToolButton title="Descargar" onClick={download} disabled={visible.length === 0}>
              <Download size={14} />
            </ToolButton>
          </div>
          <p className="text-[11px] text-subtle">
            {statusNote ?? (
              <>
                <span className="tnum">{fmtCount}</span> líneas{filter.trim() && ' (filtradas)'}
                {replicas > 1 && <> · réplica 1 de {replicas}</>} · <span className="text-err">error</span> y{' '}
                <span className="text-warn">warn</span> coloreados
              </>
            )}
          </p>
        </>
      )}

      <div className={cx('relative min-h-0', toolbar ? 'flex-1' : '')}>
        <div
          ref={ref}
          onScroll={onScroll}
          className={cx(
            'overflow-y-auto bg-term p-3 font-mono text-[11.5px] leading-[1.7] text-txt/[.88]',
            !bare && 'rounded-lg border border-line',
            toolbar ? 'absolute inset-0' : 'h-full',
          )}
        >
          {visible.length === 0 ? (
            <span className="text-subtle">{filter.trim() ? 'Ninguna línea coincide con el filtro.' : 'Sin logs todavía…'}</span>
          ) : (
            visible.map((line, i) => (
              <div key={i} className={cx(wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre', levelClass(line))}>
                {line}
              </div>
            ))
          )}
        </div>
        {follow ? (
          toolbar && (
            <span className="badge-in pointer-events-none absolute bottom-2.5 right-3 inline-flex items-center gap-[5px] rounded-full border border-ok/35 bg-[color-mix(in_oklab,var(--color-ok)_16%,oklch(14%_0.01_280))] px-2.5 py-[3px] text-[11px] font-medium text-ok">
              <span className="pulse-soft h-[5px] w-[5px] rounded-full bg-current" />
              Siguiendo
            </span>
          )
        ) : (
          <button
            onClick={() => jump('bottom')}
            className="badge-in press absolute bottom-2.5 right-3 rounded-full border border-line bg-surface2 px-3 py-1 text-xs text-sub shadow-lvl1 hover:text-txt"
          >
            ↓ Seguir
          </button>
        )}
      </div>
    </div>
  );
}
