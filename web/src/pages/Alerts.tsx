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

/** Icono desnudo por tipo, en el tono de la severidad (apagado si está resuelta). */
function AlertIcon({ alert }: { alert: Alert }) {
  const Icon = TYPE_ICON[alert.type] ?? Rocket;
  const cls = alert.resolved_at
    ? 'text-subtle'
    : alert.severity === 'critical'
      ? 'text-err'
      : alert.severity === 'warning'
        ? 'text-warn'
        : 'text-info';
  return <Icon size={16} strokeWidth={1.75} className={cx('mt-0.5 shrink-0', cls)} />;
}

function AlertCard({ alert, onResolve, resolving }: { alert: Alert; onResolve: () => void; resolving: boolean }) {
  const resolved = !!alert.resolved_at;
  return (
    <div
      className={cx(
        'rounded-xl border bg-surface px-[18px] py-4',
        !resolved && alert.severity === 'critical'
          ? 'border-[color-mix(in_oklab,var(--color-err)_35%,var(--color-line))]'
          : 'border-line',
        resolved && 'opacity-[.65]',
      )}
    >
      <div className="flex items-start gap-3">
        <AlertIcon alert={alert} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{alert.title}</span>
            {!resolved && (
              <StatusBadge
                tone={SEVERITY_TONE[alert.severity]}
                label={SEVERITY_LABEL[alert.severity]}
                dot={false}
                className="px-[9px] py-0.5 text-[10px] font-semibold"
              />
            )}
            <span className="inline-flex items-center rounded-full bg-surface2 px-[9px] py-0.5 text-[10px] text-sub">
              {ALERT_TYPE_LABEL[alert.type] ?? alert.type}
            </span>
            <span className="ml-auto font-mono text-[11px] text-subtle">{fmtDateTime(alert.ts)}</span>
          </div>
          <p className="mt-1.5 text-[13px] text-sub">{alert.message}</p>
          {alert.explanation && (
            <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-line bg-bg px-3 py-2.5 text-xs text-sub">
              <Lightbulb size={13} className="mt-px shrink-0 text-warn" />
              <p>{alert.explanation}</p>
            </div>
          )}
          <div className="mt-2.5 flex items-center gap-2">
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
          <h1 className="text-2xl font-semibold tracking-[-.02em]">Alertas</h1>
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
              <span className="ml-1.5 inline-flex h-4 min-w-4 translate-y-px items-center justify-center rounded-full bg-err/[.18] px-1 text-[10px] font-bold text-err">
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
            className="pulse-soft h-2.5 w-2.5 rounded-full bg-ok shadow-[0_0_12px_color-mix(in_oklab,var(--color-ok)_60%,transparent)]"
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
