import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BellRing, Check } from 'lucide-react';
import { api } from '../api';
import { Button, Spinner, useToast } from '../components/ui';
import { Alert } from '../types';
import { ALERT_TYPE_LABEL, cx, fmtDateTime, SEVERITY_LABEL, SEVERITY_STYLE } from '../utils';

export default function AlertsPage() {
  const [openOnly, setOpenOnly] = useState(true);
  const toast = useToast();
  const queryClient = useQueryClient();

  const alerts = useQuery({
    queryKey: ['alerts', 'page', openOnly],
    queryFn: () => api.get<{ alerts: Alert[]; unread: number }>(`/alerts?limit=100&open=${openOnly}`),
    refetchInterval: 15_000,
  });

  const resolve = useMutation({
    mutationFn: (id: string) => api.post(`/alerts/${id}/resolve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
      toast('Alerta resuelta', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const list = alerts.data?.alerts ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <BellRing size={22} className="text-acc" />
          <div>
            <h1 className="text-xl font-semibold">Alertas</h1>
            <p className="text-sm text-sub">
              Caídas, bucles de reinicio, CPU/RAM altas y despliegues fallidos de todos los proyectos
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant={openOnly ? 'primary' : 'outline'} onClick={() => setOpenOnly(true)}>
            Activas
          </Button>
          <Button size="sm" variant={!openOnly ? 'primary' : 'outline'} onClick={() => setOpenOnly(false)}>
            Historial
          </Button>
        </div>
      </div>

      <p className="text-xs text-sub">
        Las alertas se recuperan solas cuando la causa desaparece (p. ej. el servicio vuelve a estar activo). Configura
        Discord, Telegram o un webhook en{' '}
        <Link to="/settings" className="text-acc hover:underline">
          Ajustes → Alertas y notificaciones
        </Link>{' '}
        para recibirlas fuera del panel.
      </p>

      {alerts.isLoading && <Spinner label="Cargando alertas..." />}

      {!alerts.isLoading && list.length === 0 && (
        <div className="card flex flex-col items-center gap-2 py-16 text-center text-sm text-sub">
          <Check size={26} className="text-ok" />
          {openOnly ? 'No hay alertas activas. Todo en orden.' : 'Sin alertas registradas todavía.'}
        </div>
      )}

      <div className="space-y-3">
        {list.map((a) => (
          <div key={a.id} className={cx('card p-4', !a.resolved_at && a.severity === 'critical' && 'border-err/40')}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={cx('rounded-full border px-2 py-0.5 text-[11px]', SEVERITY_STYLE[a.severity])}>
                {SEVERITY_LABEL[a.severity]}
              </span>
              <span className="rounded-full border border-line bg-panel2 px-2 py-0.5 text-[11px] text-sub">
                {ALERT_TYPE_LABEL[a.type] ?? a.type}
              </span>
              <span className="text-sm font-medium">{a.title}</span>
              <span className="ml-auto text-xs text-sub">{fmtDateTime(a.ts)}</span>
            </div>
            <p className="mt-2 text-sm text-sub">{a.message}</p>
            {a.explanation && (
              <p className="mt-2 rounded-lg border border-line bg-panel2 px-3 py-2 text-xs text-sub">
                💡 {a.explanation}
              </p>
            )}
            <div className="mt-3 flex items-center gap-2">
              {a.project_id && (
                <Link
                  to={`/projects/${a.project_id}${a.service_id ? `?s=${a.service_id}` : ''}`}
                  className="text-xs text-acc hover:underline"
                >
                  Ir al servicio →
                </Link>
              )}
              {a.resolved_at ? (
                <span className="ml-auto text-xs text-ok">Resuelta {fmtDateTime(a.resolved_at)}</span>
              ) : (
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => resolve.mutate(a.id)}>
                  Marcar resuelta
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
