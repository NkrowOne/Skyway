import { useEffect, useMemo, useRef, useState, memo } from 'react';
import { Table2 } from 'lucide-react';
import { cx, fmtAxisTime, fmtStamp } from '../utils';

/**
 * La firma de las métricas de Skyway: la BANDA. Cada punto muestra la media del
 * periodo (línea) y su pico (borde superior de la banda translúcida). El hueco
 * entre ambos delata la irregularidad —un servicio que va al 20 % de media pero
 * pica al 100 % no es lo mismo que uno plano al 20 %—, y es justo el matiz que
 * una sola línea de media esconde.
 */

export interface BandPoint {
  t: number;
  avg: number | null;
  max: number | null;
}

// Geometría fija de las gráficas, fuera de los componentes: declarada dentro,
// cada render creaba un objeto nuevo y los `useMemo` que usan los márgenes no
// podían tenerla como dependencia estable.
const H = 176;
const PAD_LINE = { top: 12, right: 12, bottom: 22, left: 46 };
const PAD_BARS = { top: 16, right: 12, bottom: 22, left: 46 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const unit = v / pow;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return nice * pow;
}

/** Segmentos contiguos de puntos válidos: rompe la línea en los huecos (servicio parado). */
function contiguous<T extends { valid: boolean }>(nodes: T[]): T[][] {
  const segs: T[][] = [];
  let cur: T[] = [];
  for (const n of nodes) {
    if (n.valid) cur.push(n);
    else if (cur.length) {
      segs.push(cur);
      cur = [];
    }
  }
  if (cur.length) segs.push(cur);
  return segs;
}

/**
 * Ancho real del contenedor, para usarlo como ancho del viewBox. Con un ancho
 * fijo de 560 el SVG se escalaba ×0.6 en un móvil de 360 px y los rótulos de
 * 9 px quedaban en 5: ilegibles. Dibujando a las unidades reales del
 * contenedor el texto se pinta a su tamaño y solo las series se adaptan.
 * `fallback` es lo que se usa hasta la primera medida (y sin ResizeObserver).
 */
export function useElementWidth<T extends HTMLElement>(fallback: number): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, Math.max(200, width)];
}

/**
 * Al soltar el dedo el puntero «sale» del SVG y el tooltip se borraba justo
 * cuando por fin se podía leer. En táctil se conserva hasta el siguiente toque.
 */
export const leaveUnlessTouch = (clear: () => void) => (e: React.PointerEvent) => {
  if (e.pointerType !== 'touch') clear();
};

function HistoryChartImpl({
  title,
  points,
  hours,
  color,
  format,
  threshold,
  fixedMax,
}: {
  title: string;
  points: BandPoint[];
  hours: number;
  color: string;
  format: (v: number) => string;
  /** Línea de umbral (límite de CPU/RAM, cuota de disco). */
  threshold?: { value: number; label: string } | null;
  fixedMax?: number;
}) {
  const [wrapRef, W] = useElementWidth<HTMLDivElement>(560);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  const hasData = points.some((p) => p.avg !== null);
  const n = Math.max(points.length, 2);
  const innerW = W - PAD_LINE.left - PAD_LINE.right;
  const innerH = H - PAD_LINE.top - PAD_LINE.bottom;

  const max = useMemo(() => {
    if (fixedMax) return fixedMax;
    const peak = Math.max(
      1e-9,
      ...points.map((p) => p.max ?? 0),
      threshold ? threshold.value : 0,
    );
    return niceMax(peak);
  }, [points, threshold, fixedMax]);

  const nodes = useMemo(
    () =>
      points.map((p, i) => {
        const x = PAD_LINE.left + (i / (n - 1)) * innerW;
        const valid = p.avg !== null && p.max !== null;
        const avgY = PAD_LINE.top + innerH - (Math.min(p.avg ?? 0, max) / max) * innerH;
        const maxY = PAD_LINE.top + innerH - (Math.min(p.max ?? 0, max) / max) * innerH;
        return { i, t: p.t, avg: p.avg, max: p.max, valid, x, avgY, maxY };
      }),
    [points, n, innerW, innerH, max],
  );

  const segs = useMemo(() => contiguous(nodes), [nodes]);
  // Trazados SVG por tramo, serializados una sola vez por serie: cada movimiento
  // del puntero re-renderiza (hover) y antes volvía a pasar todos los puntos por
  // toFixed en cada pasada. El color se aplica al pintar, no en las cadenas.
  const paths = useMemo(
    () =>
      segs.map((seg) => {
        const top = seg.map((nd) => `${nd.x.toFixed(1)},${nd.maxY.toFixed(1)}`);
        const bottom = [...seg].reverse().map((nd) => `${nd.x.toFixed(1)},${nd.avgY.toFixed(1)}`);
        return {
          seg,
          band: seg.length > 1 ? `M${top.join('L')}L${bottom.join('L')}Z` : '',
          line: seg.map((nd, k) => `${k === 0 ? 'M' : 'L'}${nd.x.toFixed(1)},${nd.avgY.toFixed(1)}`).join(''),
          peak: seg.map((nd, k) => `${k === 0 ? 'M' : 'L'}${nd.x.toFixed(1)},${nd.maxY.toFixed(1)}`).join(''),
        };
      }),
    [segs],
  );
  const gridYs = [0.25, 0.5, 0.75, 1].map((f) => ({ y: PAD_LINE.top + innerH * (1 - f), v: max * f }));
  const thY = threshold ? PAD_LINE.top + innerH - (Math.min(threshold.value, max) / max) * innerH : null;

  // Puntero, no ratón: el mismo manejador sirve para dedo y lápiz.
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!svgRef.current || nodes.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestD = Infinity;
    nodes.forEach((nd) => {
      const d = Math.abs(nd.x - px);
      if (d < bestD) {
        bestD = d;
        best = nd.i;
      }
    });
    setHover(best);
  };

  const hoveredNode = hover !== null ? nodes[hover] : null;
  const hoverValid = hoveredNode?.valid ?? false;

  return (
    <div ref={wrapRef} className="rounded-xl border border-line bg-bg p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-sub">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} aria-hidden />
          {title}
        </h3>
        <button
          onClick={() => setTable((t) => !t)}
          className={cx(
            'press tap flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro transition-colors',
            table ? 'bg-surface2 text-txt' : 'text-subtle hover:text-txt',
          )}
          title={table ? 'Ver gráfica' : 'Ver como tabla'}
          aria-pressed={table}
        >
          <Table2 size={11} /> Tabla
        </button>
      </div>

      {!hasData ? (
        <div className="flex h-[140px] items-center justify-center text-xs text-subtle">
          Sin datos de consumo en este periodo.
        </div>
      ) : table ? (
        <div className="max-h-[176px] overflow-y-auto rounded-lg border border-line">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface text-subtle">
              <tr>
                <th className="px-2.5 py-1.5 font-medium">Momento</th>
                <th className="px-2.5 py-1.5 text-right font-medium">Media</th>
                <th className="px-2.5 py-1.5 text-right font-medium">Pico</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {points
                .filter((p) => p.avg !== null)
                .map((p) => (
                  <tr key={p.t} className="border-t border-line/60">
                    <td className="px-2.5 py-1 text-sub">{fmtStamp(p.t, hours)}</td>
                    <td className="px-2.5 py-1 text-right text-txt">{format(p.avg!)}</td>
                    <td className="px-2.5 py-1 text-right text-sub">{format(p.max ?? 0)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          {/* touch-pan-y: el dedo recorre la serie sin que el navegador lo tome
              por un gesto horizontal, y el scroll vertical de la página sigue vivo. */}
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="block w-full touch-pan-y"
            style={{ height: H }}
            onPointerMove={onMove}
            onPointerDown={onMove}
            onPointerLeave={leaveUnlessTouch(() => setHover(null))}
          >
            {gridYs.map((g, i) => (
              <g key={i}>
                <line x1={PAD_LINE.left} x2={W - PAD_LINE.right} y1={g.y} y2={g.y} stroke="var(--color-line)" strokeWidth="1" opacity="0.5" />
                <text x={PAD_LINE.left - 6} y={g.y + 3} textAnchor="end" fontSize="9" fill="var(--color-subtle)" fontFamily="ui-monospace, monospace">
                  {format(g.v)}
                </text>
              </g>
            ))}

            {/* Banda media→pico y línea de media, por tramos (los huecos se cortan). */}
            {paths.map(({ seg, band, line, peak }, si) => (
              <g key={si}>
                {band && <path d={band} fill={color} opacity={0.12} className="chart-area" />}
                {seg.length > 1 && <path d={peak} fill="none" stroke={color} strokeWidth="1" opacity="0.4" strokeLinejoin="round" />}
                <path
                  d={line}
                  fill="none"
                  stroke={color}
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  pathLength={1}
                  className="chart-line"
                />
                {/* Un solo punto aislado no dibuja línea: un círculo lo hace visible. */}
                {seg.length === 1 && <circle cx={seg[0].x} cy={seg[0].avgY} r="2.5" fill={color} />}
              </g>
            ))}

            {thY !== null && threshold && (
              <>
                <line x1={PAD_LINE.left} x2={W - PAD_LINE.right} y1={thY} y2={thY} stroke="var(--color-subtle)" strokeWidth="1" strokeDasharray="4,3" />
                <text x={W - PAD_LINE.right} y={thY - 4} textAnchor="end" fontSize="9" fill="var(--color-subtle)" fontFamily="ui-monospace, monospace">
                  {threshold.label}
                </text>
              </>
            )}

            <line x1={PAD_LINE.left} x2={W - PAD_LINE.right} y1={H - PAD_LINE.bottom} y2={H - PAD_LINE.bottom} stroke="var(--color-line)" strokeWidth="1" />
            <text x={PAD_LINE.left} y={H - 6} fontSize="9" fill="var(--color-subtle)" fontFamily="ui-monospace, monospace">
              {points.length > 0 ? fmtAxisTime(points[0].t, hours) : ''}
            </text>
            <text x={W - PAD_LINE.right} y={H - 6} textAnchor="end" fontSize="9" fill="var(--color-subtle)" fontFamily="ui-monospace, monospace">
              {points.length > 0 ? fmtAxisTime(points[points.length - 1].t, hours) : ''}
            </text>

            {hoveredNode && (
              <>
                <line x1={hoveredNode.x} x2={hoveredNode.x} y1={PAD_LINE.top} y2={H - PAD_LINE.bottom} stroke="var(--color-sub)" strokeWidth="1" strokeDasharray="3,3" opacity="0.7" />
                {hoverValid && (
                  <>
                    <circle cx={hoveredNode.x} cy={hoveredNode.maxY} r="3" fill={color} opacity="0.5" stroke="var(--color-surface)" strokeWidth="1.5" />
                    <circle cx={hoveredNode.x} cy={hoveredNode.avgY} r="4" fill={color} stroke="var(--color-surface)" strokeWidth="2" />
                  </>
                )}
              </>
            )}
          </svg>

          {hoveredNode && (
            <div
              className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 rounded-md border border-line bg-surface2 px-2 py-1 text-xs text-txt shadow-lvl1"
              style={{ left: `${(hoveredNode.x / W) * 100}%` }}
            >
              {hoverValid ? (
                <>
                  <span className="tnum font-semibold">{format(hoveredNode.avg!)}</span>
                  <span className="tnum text-subtle"> · pico {format(hoveredNode.max ?? 0)}</span>
                </>
              ) : (
                <span className="text-subtle">sin datos</span>
              )}
              <span className="mt-0.5 block text-micro text-subtle">{fmtStamp(hoveredNode.t, hours)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Tráfico de red por periodo, divergente sobre una línea central: enviado hacia
 * arriba, recibido hacia abajo, ambos en la misma escala para que se comparen de
 * un vistazo. Muestra bytes TRANSFERIDOS por cubo, no el contador acumulado.
 */
export interface NetPoint {
  t: number;
  rx: number;
  tx: number;
}

function NetBarsImpl({
  points,
  hours,
  format,
}: {
  points: NetPoint[];
  hours: number;
  format: (v: number) => string;
}) {
  const [wrapRef, W] = useElementWidth<HTMLDivElement>(560);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);

  const rxColor = 'var(--color-ok)';
  const txColor = 'var(--color-info)';
  const hasData = points.some((p) => p.rx > 0 || p.tx > 0);
  const innerW = W - PAD_BARS.left - PAD_BARS.right;
  const innerH = H - PAD_BARS.top - PAD_BARS.bottom;
  const mid = PAD_BARS.top + innerH / 2;
  const half = innerH / 2;

  const max = useMemo(() => {
    const peak = Math.max(1e-9, ...points.flatMap((p) => [p.rx, p.tx]));
    return niceMax(peak);
  }, [points]);

  const n = points.length;
  const slot = n > 0 ? innerW / n : innerW;
  const barW = Math.min(24, Math.max(2, slot - 3)); // ≤24px, con hueco entre columnas

  // Columna bajo el puntero, en el SVG entero: así el dedo puede recorrer las
  // barras arrastrando (en táctil los pointerenter de cada rect no se disparan).
  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.floor((x - PAD_BARS.left) / slot);
    if (i >= 0 && i < n) setHover(i);
    else if (e.pointerType !== 'touch') setHover(null);
  };

  return (
    <div ref={wrapRef} className="rounded-xl border border-line bg-bg p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-sub">Red — tráfico transferido</h3>
        <div className="flex items-center gap-2.5">
          <span className="flex items-center gap-1 text-micro text-subtle">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: txColor }} aria-hidden /> ↑ enviado
          </span>
          <span className="flex items-center gap-1 text-micro text-subtle">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: rxColor }} aria-hidden /> ↓ recibido
          </span>
          <button
            onClick={() => setTable((t) => !t)}
            className={cx(
              'press tap flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro transition-colors',
              table ? 'bg-surface2 text-txt' : 'text-subtle hover:text-txt',
            )}
            title={table ? 'Ver gráfica' : 'Ver como tabla'}
            aria-pressed={table}
          >
            <Table2 size={11} /> Tabla
          </button>
        </div>
      </div>

      {!hasData ? (
        <div className="flex h-[140px] items-center justify-center text-xs text-subtle">Sin tráfico de red en este periodo.</div>
      ) : table ? (
        <div className="max-h-[176px] overflow-y-auto rounded-lg border border-line">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface text-subtle">
              <tr>
                <th className="px-2.5 py-1.5 font-medium">Momento</th>
                <th className="px-2.5 py-1.5 text-right font-medium">↓ Recibido</th>
                <th className="px-2.5 py-1.5 text-right font-medium">↑ Enviado</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {points.map((p) => (
                <tr key={p.t} className="border-t border-line/60">
                  <td className="px-2.5 py-1 text-sub">{fmtStamp(p.t, hours)}</td>
                  <td className="px-2.5 py-1 text-right text-txt">{format(p.rx)}</td>
                  <td className="px-2.5 py-1 text-right text-sub">{format(p.tx)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="block w-full touch-pan-y"
            style={{ height: H }}
            onPointerMove={pick}
            onPointerDown={pick}
            onPointerLeave={leaveUnlessTouch(() => setHover(null))}
          >
            {[0.5, 1].map((f, i) => (
              <g key={i}>
                <line x1={PAD_BARS.left} x2={W - PAD_BARS.right} y1={mid - half * f} y2={mid - half * f} stroke="var(--color-line)" strokeWidth="1" opacity="0.4" />
                <line x1={PAD_BARS.left} x2={W - PAD_BARS.right} y1={mid + half * f} y2={mid + half * f} stroke="var(--color-line)" strokeWidth="1" opacity="0.4" />
                <text x={PAD_BARS.left - 6} y={mid - half * f + 3} textAnchor="end" fontSize="9" fill="var(--color-subtle)" fontFamily="ui-monospace, monospace">
                  {format(max * f)}
                </text>
                <text x={PAD_BARS.left - 6} y={mid + half * f + 3} textAnchor="end" fontSize="9" fill="var(--color-subtle)" fontFamily="ui-monospace, monospace">
                  {format(max * f)}
                </text>
              </g>
            ))}

            {points.map((p, i) => {
              const cx0 = PAD_BARS.left + slot * i + slot / 2;
              const txH = (Math.min(p.tx, max) / max) * half;
              const rxH = (Math.min(p.rx, max) / max) * half;
              const active = hover === i;
              return (
                <g key={p.t} opacity={hover !== null && !active ? 0.45 : 1} style={{ transition: 'opacity .12s' }}>
                  {p.tx > 0 &&<rect x={cx0 - barW / 2} y={mid - txH} width={barW} height={Math.max(0.5, txH)} rx={Math.min(3, barW / 2)} fill={txColor} />}
                  {p.rx > 0 && <rect x={cx0 - barW / 2} y={mid} width={barW} height={Math.max(0.5, rxH)} rx={Math.min(3, barW / 2)} fill={rxColor} />}
                </g>
              );
            })}

            <line x1={PAD_BARS.left} x2={W - PAD_BARS.right} y1={mid} y2={mid} stroke="var(--color-line)" strokeWidth="1" />
            <text x={PAD_BARS.left} y={H - 6} fontSize="9" fill="var(--color-subtle)" fontFamily="ui-monospace, monospace">
              {points.length > 0 ? fmtAxisTime(points[0].t, hours) : ''}
            </text>
            <text x={W - PAD_BARS.right} y={H - 6} textAnchor="end" fontSize="9" fill="var(--color-subtle)" fontFamily="ui-monospace, monospace">
              {points.length > 0 ? fmtAxisTime(points[points.length - 1].t, hours) : ''}
            </text>
          </svg>

          {hover !== null && points[hover] && (
            <div
              className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 rounded-md border border-line bg-surface2 px-2 py-1 text-xs text-txt shadow-lvl1"
              style={{ left: `${((PAD_BARS.left + slot * hover + slot / 2) / W) * 100}%` }}
            >
              <span className="tnum block">
                <span style={{ color: txColor }}>↑</span> {format(points[hover].tx)}
              </span>
              <span className="tnum block">
                <span style={{ color: rxColor }}>↓</span> {format(points[hover].rx)}
              </span>
              <span className="mt-0.5 block text-micro text-subtle">{fmtStamp(points[hover].t, hours)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/*
 * Memoizadas: el panel del servicio se repinta con cada foto de métricas
 * (~2,5 s) y las gráficas del histórico reserializaban todos sus trazados SVG
 * sin que sus datos hubieran cambiado. Quien las use debe pasar `points`,
 * `threshold` y `format` estables (useMemo / constantes de módulo).
 */
export const HistoryChart = memo(HistoryChartImpl);
export const NetBars = memo(NetBarsImpl);
