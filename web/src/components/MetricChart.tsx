import { useMemo, useRef, useState } from 'react';

interface Point {
  ts: number;
  value: number;
}

/**
 * Gráfica de área de una sola serie (SVG puro):
 * línea 2px, relleno sutil, rejilla recesiva, crosshair + tooltip al pasar el ratón.
 * Sin leyenda: el título nombra la serie.
 */
export default function MetricChart({
  title,
  points,
  color,
  format,
  fixedMax,
}: {
  title: string;
  points: Point[];
  color: string;
  format: (v: number) => string;
  fixedMax?: number;
}) {
  const W = 480;
  const H = 140;
  const PAD = { top: 10, right: 8, bottom: 18, left: 8 };
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const { path, area, max, xs, ys } = useMemo(() => {
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const rawMax = fixedMax ?? Math.max(1e-9, ...points.map((p) => p.value));
    const max = fixedMax ?? niceMax(rawMax);
    const n = Math.max(points.length, 2);
    const xs = points.map((_, i) => PAD.left + (i / (n - 1)) * innerW);
    const ys = points.map((p) => PAD.top + innerH - (Math.min(p.value, max) / max) * innerH);
    let path = '';
    points.forEach((_, i) => {
      path += `${i === 0 ? 'M' : 'L'}${xs[i].toFixed(1)},${ys[i].toFixed(1)}`;
    });
    const baseline = PAD.top + innerH;
    const area =
      points.length > 1
        ? `${path}L${xs[xs.length - 1].toFixed(1)},${baseline}L${xs[0].toFixed(1)},${baseline}Z`
        : '';
    return { path, area, max, xs, ys };
  }, [points, fixedMax]);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (points.length === 0 || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDist = Infinity;
    xs.forEach((px, i) => {
      const d = Math.abs(px - x);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    setHover(best);
  };

  const gridYs = [0.25, 0.5, 0.75].map((f) => PAD.top + (H - PAD.top - PAD.bottom) * (1 - f));
  const current = points.length > 0 ? points[points.length - 1].value : null;
  const hovered = hover !== null && points[hover] ? points[hover] : null;

  return (
    <div className="card relative p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-sub">{title}</h3>
        <span className="text-sm text-txt">{current !== null ? format(current) : '—'}</span>
      </div>
      {points.length < 2 ? (
        <div className="flex h-[140px] items-center justify-center text-xs text-sub/60">
          Recopilando datos...
        </div>
      ) : (
        <div className="relative">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="block w-full"
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {gridYs.map((y, i) => (
              <line key={i} x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke="#262a35" strokeWidth="1" />
            ))}
            <line x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} stroke="#2b303c" strokeWidth="1" />
            {area && <path d={area} fill={color} opacity="0.12" />}
            <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {hovered && hover !== null && (
              <>
                <line x1={xs[hover]} x2={xs[hover]} y1={PAD.top} y2={H - PAD.bottom} stroke="#9aa0b0" strokeWidth="1" strokeDasharray="3,3" />
                <circle cx={xs[hover]} cy={ys[hover]} r="4" fill={color} stroke="#12141a" strokeWidth="2" />
              </>
            )}
            <text x={PAD.left} y={H - 5} fontSize="9" fill="#9aa0b0">
              {points.length > 0 ? fmtTime(points[0].ts) : ''}
            </text>
            <text x={W - PAD.right} y={H - 5} fontSize="9" fill="#9aa0b0" textAnchor="end">
              {points.length > 0 ? fmtTime(points[points.length - 1].ts) : ''}
            </text>
            <text x={W - PAD.right} y={PAD.top + 4} fontSize="9" fill="#9aa0b0" textAnchor="end">
              {format(max)}
            </text>
          </svg>
          {hovered && hover !== null && (
            <div
              className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 rounded-md border border-line bg-panel2 px-2 py-1 text-[11px] text-txt shadow-lg"
              style={{ left: `${(xs[hover] / W) * 100}%` }}
            >
              {format(hovered.value)} · {fmtTime(hovered.ts)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function niceMax(v: number): number {
  const pow = 10 ** Math.floor(Math.log10(v));
  const unit = v / pow;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return nice * pow;
}
