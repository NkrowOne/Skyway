import { useMemo, useState } from 'react';
import { Table2 } from 'lucide-react';
import { cx } from '../utils';

/**
 * Gráficas de facturación y uso, en el lenguaje de las de Skyway: marcas finas,
 * extremos redondeados anclados a la base, rejilla recesiva, hover con tooltip,
 * leyenda para ≥2 series y vista de tabla. Colores de los tokens de marca.
 */

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const unit = v / pow;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return nice * pow;
}

export interface SeriesPoint {
  t: number;
  value: number;
}

/** Barras de un solo valor por cubo en el tiempo (uso por día): CPU·h, RAM·h… */
export function UsageBars({
  title,
  points,
  color,
  format,
  labelFor,
}: {
  title: string;
  points: SeriesPoint[];
  color: string;
  format: (v: number) => string;
  /** Etiqueta del eje temporal para un instante. */
  labelFor: (t: number) => string;
}) {
  const W = 560;
  const H = 176;
  const PAD = { top: 12, right: 12, bottom: 22, left: 52 };
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const total = useMemo(() => points.reduce((a, p) => a + p.value, 0), [points]);
  const max = useMemo(() => niceMax(Math.max(1e-9, ...points.map((p) => p.value))), [points]);
  const hasData = points.some((p) => p.value > 0);
  const n = points.length;
  const slot = n > 0 ? innerW / n : innerW;
  const barW = Math.min(26, Math.max(2, slot - 3));
  const gridYs = [0.25, 0.5, 0.75, 1].map((f) => ({ y: PAD.top + innerH * (1 - f), v: max * f }));

  return (
    <div className="rounded-xl border border-line bg-bg p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-sub">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: color }} aria-hidden />
          {title}
        </h3>
        <div className="flex items-center gap-2.5">
          <span className="tnum text-xs text-subtle">total {format(total)}</span>
          <button
            onClick={() => setTable((t) => !t)}
            className={cx('press flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro transition-colors', table ? 'bg-surface2 text-txt' : 'text-subtle hover:text-txt')}
            aria-pressed={table}
            title={table ? 'Ver gráfica' : 'Ver como tabla'}
          >
            <Table2 size={11} /> Tabla
          </button>
        </div>
      </div>

      {!hasData ? (
        <div className="flex h-[140px] items-center justify-center text-xs text-subtle">Sin consumo en este periodo.</div>
      ) : table ? (
        <div className="max-h-[176px] overflow-y-auto rounded-lg border border-line">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface text-subtle">
              <tr>
                <th className="px-2.5 py-1.5 font-medium">Momento</th>
                <th className="px-2.5 py-1.5 text-right font-medium">Consumo</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {points.filter((p) => p.value > 0).map((p) => (
                <tr key={p.t} className="border-t border-line/60">
                  <td className="px-2.5 py-1 text-sub">{labelFor(p.t)}</td>
                  <td className="px-2.5 py-1 text-right text-txt">{format(p.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" onPointerLeave={() => setHover(null)}>
            {gridYs.map((g, i) => (
              <g key={i}>
                <line x1={PAD.left} x2={W - PAD.right} y1={g.y} y2={g.y} stroke="var(--color-line)" strokeWidth="1" opacity="0.5" />
                <text x={PAD.left - 6} y={g.y + 3} textAnchor="end" fontSize="9" fill="var(--color-subtle)" fontFamily="ui-monospace, monospace">
                  {format(g.v)}
                </text>
              </g>
            ))}
            {points.map((p, i) => {
              const cx0 = PAD.left + slot * i + slot / 2;
              const h = (Math.min(p.value, max) / max) * innerH;
              const active = hover === i;
              return (
                <g key={p.t} opacity={hover !== null && !active ? 0.45 : 1} style={{ transition: 'opacity .12s' }}>
                  <rect x={cx0 - slot / 2} y={PAD.top} width={slot} height={innerH} fill="transparent" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} />
                  {p.value > 0 && (
                    <rect x={cx0 - barW / 2} y={PAD.top + innerH - h} width={barW} height={Math.max(0.5, h)} rx={Math.min(3, barW / 2)} fill={color} />
                  )}
                </g>
              );
            })}
            <line x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} stroke="var(--color-line)" strokeWidth="1" />
            <text x={PAD.left} y={H - 6} fontSize="9" fill="var(--color-subtle)" fontFamily="ui-monospace, monospace">
              {points.length > 0 ? labelFor(points[0].t) : ''}
            </text>
            <text x={W - PAD.right} y={H - 6} textAnchor="end" fontSize="9" fill="var(--color-subtle)" fontFamily="ui-monospace, monospace">
              {points.length > 0 ? labelFor(points[points.length - 1].t) : ''}
            </text>
          </svg>
          {hover !== null && points[hover] && (
            <div
              className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 rounded-md border border-line bg-surface2 px-2 py-1 text-xs text-txt shadow-lvl1"
              style={{ left: `${((PAD.left + slot * hover + slot / 2) / W) * 100}%` }}
            >
              <span className="tnum font-semibold">{format(points[hover].value)}</span>
              <span className="mt-0.5 block text-micro text-subtle">{labelFor(points[hover].t)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export interface RevenuePoint {
  t: number;
  invoiced: number;
  paid: number;
}

/** Ingresos por mes: cobrado (verde) apilado bajo lo pendiente (violeta). */
export function RevenueBars({ points, format, labelFor }: { points: RevenuePoint[]; format: (cents: number) => string; labelFor: (t: number) => string }) {
  const W = 620;
  const H = 200;
  const PAD = { top: 14, right: 12, bottom: 24, left: 64 };
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const paidColor = 'var(--color-ok)';
  // Pendiente es un estado, no una marca: va en el color de aviso.
  const pendColor = 'var(--color-warn)';

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const max = useMemo(() => niceMax(Math.max(1e-9, ...points.map((p) => p.invoiced))), [points]);
  const hasData = points.some((p) => p.invoiced > 0);
  const n = points.length;
  const slot = n > 0 ? innerW / n : innerW;
  const barW = Math.min(34, Math.max(3, slot - 4));
  const gridYs = [0.25, 0.5, 0.75, 1].map((f) => ({ y: PAD.top + innerH * (1 - f), v: max * f }));

  return (
    <div className="rounded-xl border border-line bg-bg p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-sub">Ingresos por mes</h3>
        <div className="flex items-center gap-2.5">
          <span className="flex items-center gap-1 text-micro text-subtle">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: paidColor }} aria-hidden /> cobrado
          </span>
          <span className="flex items-center gap-1 text-micro text-subtle">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: pendColor }} aria-hidden /> pendiente
          </span>
          <button
            onClick={() => setTable((t) => !t)}
            className={cx('press flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro transition-colors', table ? 'bg-surface2 text-txt' : 'text-subtle hover:text-txt')}
            aria-pressed={table}
            title={table ? 'Ver gráfica' : 'Ver como tabla'}
          >
            <Table2 size={11} /> Tabla
          </button>
        </div>
      </div>

      {!hasData ? (
        <div className="flex h-[160px] items-center justify-center text-xs text-subtle">Sin facturación en este periodo.</div>
      ) : table ? (
        <div className="max-h-[200px] overflow-y-auto rounded-lg border border-line">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface text-subtle">
              <tr>
                <th className="px-2.5 py-1.5 font-medium">Mes</th>
                <th className="px-2.5 py-1.5 text-right font-medium">Facturado</th>
                <th className="px-2.5 py-1.5 text-right font-medium">Cobrado</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {points.map((p) => (
                <tr key={p.t} className="border-t border-line/60">
                  <td className="px-2.5 py-1 text-sub">{labelFor(p.t)}</td>
                  <td className="px-2.5 py-1 text-right text-txt">{format(p.invoiced)}</td>
                  <td className="px-2.5 py-1 text-right text-sub">{format(p.paid)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" onPointerLeave={() => setHover(null)}>
            {gridYs.map((g, i) => (
              <g key={i}>
                <line x1={PAD.left} x2={W - PAD.right} y1={g.y} y2={g.y} stroke="var(--color-line)" strokeWidth="1" opacity="0.5" />
                <text x={PAD.left - 6} y={g.y + 3} textAnchor="end" fontSize="9" fill="var(--color-subtle)" fontFamily="ui-monospace, monospace">
                  {format(g.v)}
                </text>
              </g>
            ))}
            {points.map((p, i) => {
              const cx0 = PAD.left + slot * i + slot / 2;
              const paidH = (Math.min(p.paid, max) / max) * innerH;
              const pending = Math.max(0, p.invoiced - p.paid);
              const pendH = (Math.min(pending, max) / max) * innerH;
              const active = hover === i;
              const base = PAD.top + innerH;
              return (
                <g key={p.t} opacity={hover !== null && !active ? 0.45 : 1} style={{ transition: 'opacity .12s' }}>
                  <rect x={cx0 - slot / 2} y={PAD.top} width={slot} height={innerH} fill="transparent" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} />
                  {p.paid > 0 && <rect x={cx0 - barW / 2} y={base - paidH} width={barW} height={Math.max(0.5, paidH)} rx={Math.min(3, barW / 2)} fill={paidColor} />}
                  {/* 2px de hueco de superficie entre segmentos apilados */}
                  {pending > 0 && <rect x={cx0 - barW / 2} y={base - paidH - pendH - (p.paid > 0 ? 2 : 0)} width={barW} height={Math.max(0.5, pendH)} rx={Math.min(3, barW / 2)} fill={pendColor} />}
                </g>
              );
            })}
            <line x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} stroke="var(--color-line)" strokeWidth="1" />
            <text x={PAD.left} y={H - 7} fontSize="9" fill="var(--color-subtle)" fontFamily="ui-monospace, monospace">
              {points.length > 0 ? labelFor(points[0].t) : ''}
            </text>
            <text x={W - PAD.right} y={H - 7} textAnchor="end" fontSize="9" fill="var(--color-subtle)" fontFamily="ui-monospace, monospace">
              {points.length > 0 ? labelFor(points[points.length - 1].t) : ''}
            </text>
          </svg>
          {hover !== null && points[hover] && (
            <div
              className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 rounded-md border border-line bg-surface2 px-2 py-1.5 text-xs text-txt shadow-lvl1"
              style={{ left: `${((PAD.left + slot * hover + slot / 2) / W) * 100}%` }}
            >
              <span className="mb-0.5 block text-micro font-semibold text-subtle">{labelFor(points[hover].t)}</span>
              <span className="tnum block">
                <span style={{ color: pendColor }}>■</span> facturado {format(points[hover].invoiced)}
              </span>
              <span className="tnum block">
                <span style={{ color: paidColor }}>■</span> cobrado {format(points[hover].paid)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
