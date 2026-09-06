import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Archive, CheckCircle2, Cpu, Lightbulb, MemoryStick, Power, RefreshCw, Rocket } from 'lucide-react';
import { api } from '../api';
import { Button, Chip, ErrorState, Segmented, Skeleton, useToast } from '../components/ui';
import { Alert } from '../types';
import { ALERT_TYPE_LABEL, cx, fmtDateTime, SEVERITY_LABEL } from '../utils';

/** Color del nivel en la línea de contexto (el riel y el icono ya lo llevan). */
const SEVERITY_TEXT: Record<string, string> = {
  critical: 'text-err',
  warning: 'text-warn',
  info: 'text-info',
};

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
        /*
         * La gravedad se dice DOS veces: el riel de color y el icono teñido.
         * Antes eran cuatro —riel, icono, píldora y fondo rojizo— y una lista
         * de alertas críticas quedaba en un bloque rojo donde ya no destacaba
         * ninguna.
         */
        'relative overflow-hidden rounded-xl border border-line bg-surface p-4 transition-opacity',
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
          </div>
          {/* El nivel viaja con el tipo, en la línea de contexto: es un dato
              más de la alerta, no una etiqueta que compita con el título. */}
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-subtle">
            {!resolved && <span className={cx('font-semibold', SEVERITY_TEXT[alert.severity])}>{SEVERITY_LABEL[alert.severity]}</span>}
            {!resolved && <span className="text-line">·</span>}
            <span>{ALERT_TYPE_LABEL[alert.type] ?? alert.type}</span>
            <span className="text-line">·</span>
            <span className="tnum">{fmtDateTime(alert.ts)}</span>
          </p>
          <p className="mt-2 text-sm leading-relaxed text-sub">{alert.message}</p>
          {alert.explanation && (
            <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-warn/25 bg-warn/[.05] px-3 py-2 text-xs text-sub">
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
    <div className="mx-auto flex max-w-[880px] flex-col gap-4 px-4 py-7 sm:px-6 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Alertas</h1>
          <p className="mt-1.5 text-sm text-sub">
            Caídas, bucles de reinicio, CPU/RAM altas y despliegues fallidos de todos los proyectos
          </p>
        </div>
        <Segmented
          label="Alertas activas o historial"
          value={openOnly ? 'open' : 'all'}
          onChange={(k) => setOpenOnly(k === 'open')}
          options={[
            {
              key: 'open',
              label: 'Activas',
              badge: activeCount > 0 ? <Chip size="sm" tone="err">{activeCount}</Chip> : undefined,
            },
            { key: 'all', label: 'Historial' },
          ]}
        />
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

      {current.isError && (
        <div className="card">
          <ErrorState
            title="No se han podido cargar las alertas"
            error={current.error}
            onRetry={() => current.refetch()}
            retrying={current.isFetching}
          />
        </div>
      )}

      {!current.isLoading && !current.isError && list.length === 0 && (
        <div className="card flex flex-col items-center gap-3 py-16 text-center text-sm text-sub">
          {/* Verde solo cuando de verdad se sabe que no hay nada que mirar. */}
          <span aria-hidden className="pulse-soft h-2.5 w-2.5 rounded-full bg-ok" />
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
