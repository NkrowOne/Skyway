import { cx } from '../utils';

/**
 * Medidor de cuota: barra que enfrenta lo asignado con el techo del workspace.
 * El relleno se tiñe según lo lleno que está (violeta sereno → ámbar → rojo al
 * superarse) y anima su anchura, así un «live resize» del techo se ve moverse.
 * Es el elemento de firma de la gestión de cuentas.
 */
export function QuotaMeter({
  label,
  icon,
  used,
  ceiling,
  format = (n) => String(n),
  inheriting,
  hint,
}: {
  label: string;
  icon?: React.ReactNode;
  used: number;
  ceiling: number;
  format?: (n: number) => string;
  inheriting?: boolean;
  hint?: React.ReactNode;
}) {
  const ratio = ceiling > 0 ? used / ceiling : used > 0 ? 1.5 : 0;
  const over = used > ceiling + 1e-9;
  const pct = Math.max(used > 0 ? 3 : 0, Math.min(100, ratio * 100));
  const tone = over ? 'err' : ratio >= 0.9 ? 'warn' : 'acc';
  const fill =
    tone === 'err'
      ? 'bg-err'
      : tone === 'warn'
        ? 'bg-warn'
        : 'bg-gradient-to-r from-[#7d66d9] to-acc';

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-1.5 text-sm font-medium text-sub">
          {icon && <span className="text-subtle [&>svg]:block">{icon}</span>}
          {label}
          {inheriting && (
            <span className="rounded-full border border-line px-1.5 py-px text-micro font-normal text-subtle">del plan</span>
          )}
        </span>
        <span className={cx('tnum text-sm', over ? 'font-semibold text-err' : 'text-txt')}>
          {format(used)} <span className="text-subtle">/ {format(ceiling)}</span>
        </span>
      </div>
      <div className="relative h-2.5 overflow-hidden rounded-full bg-surface2 shadow-[inset_0_1px_2px_rgba(0,0,0,.35)]">
        <div
          className={cx('h-full rounded-full transition-[width] duration-500 ease-out', fill, over && 'quota-over')}
          style={{ width: `${pct}%` }}
        />
      </div>
      {(hint || over) && (
        <p className={cx('mt-1 text-xs', over ? 'text-err' : 'text-subtle')}>
          {over ? `Asignado por encima del techo · ${format(used - ceiling)} de más` : hint}
        </p>
      )}
    </div>
  );
}

/** Medidor compacto para las tarjetas del listado (sin etiquetas largas). */
export function MiniMeter({ label, used, ceiling, format = (n) => String(n) }: { label: string; used: number; ceiling: number; format?: (n: number) => string }) {
  const ratio = ceiling > 0 ? used / ceiling : used > 0 ? 1.5 : 0;
  const over = used > ceiling + 1e-9;
  const pct = Math.max(used > 0 ? 4 : 0, Math.min(100, ratio * 100));
  const fill = over ? 'bg-err' : ratio >= 0.9 ? 'bg-warn' : 'bg-acc';
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-micro font-medium uppercase tracking-[.06em] text-subtle">{label}</span>
        <span className={cx('tnum text-xs', over ? 'text-err' : 'text-sub')}>
          {format(used)}<span className="text-subtle">/{format(ceiling)}</span>
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface2">
        <div className={cx('h-full rounded-full transition-[width] duration-500 ease-out', fill)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
