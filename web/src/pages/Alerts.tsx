import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Archive, CheckCircle2, Cpu, Lightbulb, MemoryStick, Power, RefreshCw, Rocket } from 'lucide-react';
import { api } from '../api';
import { Button, Skeleton, StatusBadge, useToast } from '../components/ui';
import { Alert } from '../types';
import { ALERT_TYPE_LABEL, cx, fmtDateTime, SEVERITY_LABEL, SEVERITY_TONE } from '../utils';

const TYPE_ICON: Record<string, typeof Rocket> = {
  deploy_failed: Rocket,
  cpu_high: Cpu,
  mem_high: MemoryStick,
  service_down: Power,
  crash_loop: RefreshCw,
  backup_failed: Archive,
};

function AlertCard({ alert, onResolve, resolving }: { alert: Alert; onResolve: () => void; resolving: boolean }) {
  const resolved = !!alert.resolved_at;
  const Icon = TYPE_ICON[alert.type] ?? Rocket;
  const tone: 'err' | 'warn' | 'info' | 'neutral' = resolved
    ? 'neutral'
    : alert.severity === 'critical'
      ? 'err'
      : alert.severity === 'warning'
        ? 'warn'
        : 'info';
  // El riel de severidad (un filo a la izquierda) codifica la gravedad en forma,
  // no en una caja anidada. El chip la lleva también al icono.
  const rail = { err: 'bg-err', warn: 'bg-warn', info: 'bg-info', neutral: 'bg-line' }[tone];
  const chip = {
    err: 'bg-err/[.14] text-err',
    warn: 'bg-warn/[.14] text-warn',
    info: 'bg-info/[.14] text-info',
    neutral: 'bg-surface2 text-subtle',
  }[tone];

  return (
    <div
      className={cx(
        'relative overflow-hidden rounded-xl border border-line bg-surface py-4 pl-[18px] pr-[18px] transition-opacity',
        !resolved && tone === 'err' && 'bg-err/[.035]',
        resolved && 'opacity-[.7]',
      )}
    >
      <span aria-hidden className={cx('absolute inset-y-0 left-0 w-[3px]', rail)} />
      <div className="flex items-start gap-3">
        <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]', chip)}>
          <Icon size={16} strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate text-sm font-semibold">{alert.title}</span>
            {!resolved && (
              <StatusBadge
                tone={SEVERITY_TONE[alert.severity]}
                label={SEVERITY_LABEL[alert.severity]}
                dot={false}
                className="px-2 py-0.5 text-micro font-semibold uppercase tracking-[.03em]"
              />
            )}
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-subtle">
            <span>{ALERT_TYPE_LABEL[alert.type] ?? alert.type}</span>
            <span className="text-line">·</span>
            <span className="tnum">{fmtDateTime(alert.ts)}</span>
          </p>
          <p className="mt-2 text-sm leading-relaxed text-sub">{alert.message}</p>
          {alert.explanation && (
            <div className="mt-2.5 flex items-start gap-2 rounded-r-md border-l-2 border-warn/40 bg-warn/[.05] py-2 pl-2.5 pr-3 text-xs text-sub">
              <Lightbulb size={13} className="mt-px shrink-0 text-warn" />
              <p className="leading-relaxed">{alert.explanation}</p>
            </div>
          )}
          <div className="mt-3 flex items-center gap-3">
            {alert.project_id && (
              <Link
                to={`/projects/${alert.project_id}${alert.service_id ? `?s=${alert.service_id}` : ''}`}
                className="text-xs font-semibold text-acc-soft hover:underline"
              >
                Ir al servicio →
              </Link>
            )}
            {resolved ? (
              <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-ok">
                <CheckCircle2 size={12} /> Resuelta {fmtDateTime(alert.resolved_at!)}
              </span>
            ) : (
              <Button size="sm" variant="ghost" className="ml-auto h-[30px]" onClick={onResolve} loading={resolving}>
                Marcar resuelta
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AlertsPage() {
  const [openOnly, setOpenOnly] = useState(true);
  const toast = useToast();
  const queryClient = useQueryClient();

  // Las activas se consultan siempre: alimentan el contador del control segmentado.
  const active = useQuery({
    queryKey: ['alerts', 'page', true],
    queryFn: () => api.get<{ alerts: Alert[]; unread: number }>(`/alerts?limit=100&open=true`),
    refetchInterval: 15_000,
  });
  const history = useQuery({
    queryKey: ['alerts', 'page', false],
    queryFn: () => api.get<{ alerts: Alert[]; unread: number }>(`/alerts?limit=100&open=false`),
    refetchInterval: 15_000,
    enabled: !openOnly,
  });

  const resolve = useMutation({
    mutationFn: (id: string) => api.post(`/alerts/${id}/resolve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast('Alerta resuelta', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const current = openOnly ? active : history;
  const list = current.data?.alerts ?? [];
  const activeCount = active.data?.alerts.length ?? 0;

  return (
    <div className="mx-auto flex max-w-[880px] flex-col gap-[18px] px-4 py-7 sm:px-6 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Alertas</h1>
          <p className="mt-1.5 text-sm text-sub">
            Caídas, bucles de reinicio, CPU/RAM altas y despliegues fallidos de todos los proyectos
          </p>
        </div>
        <div role="tablist" className="inline-flex gap-0.5 rounded-lg border border-line bg-bg p-[3px]">
          <button
            role="tab"
            aria-selected={openOnly}
            onClick={() => setOpenOnly(true)}
            className={cx(
              'rounded-[7px] px-3.5 py-[5px] text-xs transition-colors duration-150',
              openOnly ? 'bg-surface2 font-semibold text-txt' : 'text-sub hover:text-txt',
            )}
          >
            Activas
            {activeCount > 0 && (
              <span className="ml-1.5 inline-flex h-4 min-w-4 translate-y-px items-center justify-center rounded-full bg-err/[.18] px-1 text-micro font-bold text-err">
                {activeCount}
              </span>
            )}
          </button>
          <button
            role="tab"
            aria-selected={!openOnly}
            onClick={() => setOpenOnly(false)}
            className={cx(
              'rounded-[7px] px-3.5 py-[5px] text-xs transition-colors duration-150',
              !openOnly ? 'bg-surface2 font-semibold text-txt' : 'text-sub hover:text-txt',
            )}
          >
            Historial
          </button>
        </div>
      </div>

      <p className="text-xs text-subtle">
        Las alertas se recuperan solas cuando la causa desaparece. Configura Discord, Telegram o un webhook en{' '}
        <Link to="/settings" className="text-acc-soft hover:underline">
          Ajustes → Alertas y notificaciones
        </Link>{' '}
        para recibirlas fuera del panel.
      </p>

      {current.isLoading && (
        <div aria-busy className="flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      )}

      {!current.isLoading && list.length === 0 && (
        <div className="card flex flex-col items-center gap-3 py-16 text-center text-sm text-sub">
          {/* El mismo dot de estado del sistema que en la topbar: verde y respirando. */}
          <span
            aria-hidden
            className="pulse-soft h-2.5 w-2.5 rounded-full bg-ok"
          />
          {openOnly ? 'No hay alertas activas. Todo en orden.' : 'Sin alertas registradas todavía.'}
        </div>
      )}

      {/* La clave por vista relanza el escalonado al cambiar Activas ↔ Historial. */}
      <div key={String(openOnly)} className="stagger flex flex-col gap-3">
        {list.map((a) => (
          <AlertCard key={a.id} alert={a} onResolve={() => resolve.mutate(a.id)} resolving={resolve.isPending} />
        ))}
      </div>
    </div>
  );
}
