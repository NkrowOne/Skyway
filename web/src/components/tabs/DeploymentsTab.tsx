import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Lightbulb, RotateCcw, XCircle } from 'lucide-react';
import { api, openStream } from '../../api';
import { Deployment, Diagnosis } from '../../types';
import { cx, DEPLOY_STATUS_LABEL, DEPLOY_STATUS_STYLE, fmtDuration, isActiveDeploy, timeAgo } from '../../utils';
import LogViewer from '../LogViewer';
import { Button, Spinner, useToast } from '../ui';

const TRIGGER_LABEL: Record<string, string> = {
  initial: 'creación',
  manual: 'manual',
  webhook: 'push',
  rollback: 'rollback',
  import: 'importación',
};

/** Explicación del fallo generada por el servidor (qué pasó y cómo arreglarlo). */
function DiagnosisCard({ raw }: { raw: string | null }) {
  if (!raw) return null;
  let diagnosis: Diagnosis;
  try {
    diagnosis = JSON.parse(raw);
  } catch {
    return null;
  }
  return (
    <div className="mb-2 rounded-lg border border-warn/30 bg-warn/5 p-3 text-xs">
      <p className="flex items-center gap-1.5 font-medium text-warn">
        <Lightbulb size={13} /> {diagnosis.title}
      </p>
      <p className="mt-1.5 text-sub">{diagnosis.cause}</p>
      <p className="mt-1.5">
        <span className="font-medium text-ok">Cómo arreglarlo: </span>
        <span className="text-sub">{diagnosis.fix}</span>
      </p>
    </div>
  );
}

/** Logs de un despliegue: histórico + streaming en vivo si está activo. */
function DeploymentLogs({ deployment }: { deployment: Deployment }) {
  const [lines, setLines] = useState<string[]>([]);
  const queryClient = useQueryClient();

  useEffect(() => {
    setLines([]);
    const es = openStream(`/deployments/${deployment.id}/logs/stream`);
    es.addEventListener('snapshot', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data);
      setLines(data.logs ? data.logs.split('\n').filter(Boolean) : []);
    });
    es.addEventListener('log', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data);
      setLines((prev) => [...prev.slice(-3000), data.line]);
    });
    es.addEventListener('done', () => {
      queryClient.invalidateQueries({ queryKey: ['deployments', deployment.service_id] });
      queryClient.invalidateQueries({ queryKey: ['service', deployment.service_id] });
      es.close();
    });
    es.onerror = () => {
      /* si el despliegue terminó, el servidor cierra el stream */
    };
    return () => es.close();
  }, [deployment.id]);

  return <LogViewer lines={lines} className="h-64" />;
}

export default function DeploymentsTab({ serviceId, serviceType }: { serviceId: string; serviceType: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const toast = useToast();
  const queryClient = useQueryClient();

  const deployments = useQuery({
    queryKey: ['deployments', serviceId],
    queryFn: () => api.get<{ deployments: Deployment[] }>(`/services/${serviceId}/deployments`),
    refetchInterval: 4000,
  });

  const rollback = useMutation({
    mutationFn: (deploymentId: string) => api.post<{ deployment: Deployment }>(`/deployments/${deploymentId}/rollback`),
    onSuccess: (data) => {
      toast('Rollback iniciado', 'ok');
      setOpenId(data.deployment.id);
      queryClient.invalidateQueries({ queryKey: ['deployments', serviceId] });
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const cancel = useMutation({
    mutationFn: (deploymentId: string) => api.post(`/deployments/${deploymentId}/cancel`),
    onSuccess: () => {
      toast('Despliegue cancelado', 'ok');
      queryClient.invalidateQueries({ queryKey: ['deployments', serviceId] });
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const list = deployments.data?.deployments ?? [];

  // Abre automáticamente el despliegue activo más reciente.
  useEffect(() => {
    if (openId === null && list.length > 0) {
      const active = list.find((d) => isActiveDeploy(d.status));
      setOpenId(active ? active.id : list[0].id);
    }
  }, [list.length]);

  if (deployments.isLoading) return <Spinner label="Cargando despliegues..." />;

  if (list.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-sub">
        <History size={24} className="text-sub/50" />
        Aún no hay despliegues
      </div>
    );
  }

  return (
    <div className="space-y-2 p-4">
      {list.map((d, idx) => (
        <div key={d.id} className="card overflow-hidden">
          <button
            onClick={() => setOpenId(openId === d.id ? null : d.id)}
            className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left hover:bg-panel2/50"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className={cx('shrink-0 rounded-full border px-2 py-0.5 text-[11px]', DEPLOY_STATUS_STYLE[d.status])}>
                {DEPLOY_STATUS_LABEL[d.status]}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {d.commit_msg || (d.trigger === 'rollback' ? 'Rollback de imagen' : serviceType === 'database' ? 'Despliegue de base de datos' : 'Despliegue')}
                </p>
                <p className="text-xs text-sub">
                  {TRIGGER_LABEL[d.trigger] ?? d.trigger}
                  {d.commit_sha && <span className="ml-1.5 font-mono">{d.commit_sha.slice(0, 7)}</span>}
                  <span className="ml-1.5">{timeAgo(d.created_at)}</span>
                  {d.finished_at && <span className="ml-1.5">· {fmtDuration(d.finished_at - d.created_at)}</span>}
                </p>
              </div>
            </div>
            {isActiveDeploy(d.status) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  cancel.mutate(d.id);
                }}
                title="Cancelar despliegue"
              >
                <XCircle size={13} className="text-err" />
              </Button>
            )}
            {idx !== 0 && d.status === 'success' && serviceType === 'git' && (
              <Button
                size="sm"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  rollback.mutate(d.id);
                }}
                title="Volver a esta versión"
              >
                <RotateCcw size={13} />
              </Button>
            )}
          </button>
          {openId === d.id && (
            <div className="border-t border-line p-3">
              {d.error && <p className="mb-2 rounded-lg border border-err/30 bg-err/10 px-3 py-2 text-xs text-err">{d.error}</p>}
              <DiagnosisCard raw={d.diagnosis} />
              <DeploymentLogs deployment={d} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
