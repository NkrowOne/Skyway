import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Lightbulb, RotateCcw, XCircle } from 'lucide-react';
import { api, openStream } from '../../api';
import { Deployment, Diagnosis } from '../../types';
import { cx, DEPLOY_STATUS_LABEL, fmtDuration, isActiveDeploy, timeAgo } from '../../utils';
import LogViewer from '../LogViewer';
import { CopyButton, Skeleton, useToast } from '../ui';

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
    <div className="mb-2.5 rounded-lg border border-warn/30 bg-warn/[.06] p-3 text-xs">
      <p className="flex items-center gap-1.5 font-semibold text-warn">
        <Lightbulb size={13} /> {diagnosis.title}
      </p>
      <p className="mt-1.5 text-sub">{diagnosis.cause}</p>
      <p className="mt-1.5">
        <span className="font-semibold text-ok">Cómo arreglarlo: </span>
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

  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex items-center justify-between bg-surface2 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[.08em] text-subtle">Build &amp; deploy</span>
        <CopyButton value={lines.join('\n')} title="Copiar logs" className="-my-0.5" />
      </div>
      <LogViewer lines={lines} bare className="h-[232px]" />
    </div>
  );
}

/**
 * Pill de estado del despliegue: el vigente en verde, el histórico en gris.
 * Cada transición (En cola → Construyendo → Activo) entra con un pop mínimo.
 */
function DeployPill({ deployment, isCurrent, isLatest }: { deployment: Deployment; isCurrent: boolean; isLatest: boolean }) {
  const active = isActiveDeploy(deployment.status);
  const label = isCurrent ? 'Activo' : DEPLOY_STATUS_LABEL[deployment.status];
  const cls = active
    ? 'bg-warn/[.13] text-warn pulse-soft'
    : isCurrent
      ? 'bg-ok/[.14] text-ok'
      : deployment.status === 'failed' && isLatest
        ? 'bg-err/[.14] text-err'
        : 'bg-surface2 text-sub';
  return (
    <span
      key={label}
      className={cx('badge-in inline-flex shrink-0 items-center rounded-full px-2.5 py-[3px] text-[11px] font-semibold', cls)}
    >
      {label}
    </span>
  );
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
  // El despliegue "vigente": el éxito más reciente (la versión que sirve ahora).
  const currentId = list.find((d) => d.status === 'success')?.id ?? null;

  // Abre automáticamente el despliegue activo más reciente.
  useEffect(() => {
    if (openId === null && list.length > 0) {
      const active = list.find((d) => isActiveDeploy(d.status));
      setOpenId(active ? active.id : list[0].id);
    }
  }, [list.length]);

  if (deployments.isLoading) {
    return (
      <div aria-busy className="flex flex-col gap-2.5 p-4 sm:px-5">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (list.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-sub">
        <History size={24} className="text-subtle" />
        Aún no hay despliegues
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5 p-4 sm:px-5">
      {list.map((d, idx) => (
        <div
          key={d.id}
          className={cx(
            'overflow-hidden rounded-xl border bg-bg',
            openId === d.id ? 'border-[color-mix(in_oklab,#6e56cf_30%,var(--color-line))]' : 'border-line',
          )}
        >
          <button
            onClick={() => setOpenId(openId === d.id ? null : d.id)}
            className="flex w-full items-center justify-between gap-2 px-3.5 py-3 text-left transition-colors duration-150 hover:bg-surface2"
          >
            <div className="flex min-w-0 items-center gap-3">
              <DeployPill deployment={d} isCurrent={d.id === currentId} isLatest={idx === 0} />
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium">
                  {d.commit_msg ||
                    (d.trigger === 'rollback'
                      ? 'Rollback de imagen'
                      : serviceType === 'database'
                        ? 'Despliegue de base de datos'
                        : 'Despliegue')}
                </p>
                <p className="mt-0.5 truncate font-mono text-[11px] text-subtle">
                  {TRIGGER_LABEL[d.trigger] ?? d.trigger}
                  {d.commit_sha && <> · {d.commit_sha.slice(0, 7)}</>}
                  <> · {timeAgo(d.created_at)}</>
                  {d.finished_at && <> · {fmtDuration(d.finished_at - d.created_at)}</>}
                </p>
              </div>
            </div>
            <span className="flex shrink-0 items-center gap-0.5">
              {isActiveDeploy(d.status) && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    cancel.mutate(d.id);
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && cancel.mutate(d.id)}
                  className="press rounded-lg p-1.5 leading-none text-err/80 hover:bg-surface2 hover:text-err"
                  title="Cancelar despliegue"
                >
                  <XCircle size={14} />
                </span>
              )}
              {idx !== 0 && d.status === 'success' && serviceType === 'git' && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    rollback.mutate(d.id);
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && rollback.mutate(d.id)}
                  className="press rounded-lg p-1.5 leading-none text-subtle hover:bg-surface2 hover:text-txt"
                  title="Volver a esta versión"
                >
                  <RotateCcw size={13} />
                </span>
              )}
            </span>
          </button>
          {openId === d.id && (
            <div className="tab-in border-t border-line p-3">
              {d.error && (
                <p className="mb-2.5 rounded-lg border border-err/35 bg-err/[.08] px-3 py-2.5 text-xs text-err">{d.error}</p>
              )}
              <DiagnosisCard raw={d.diagnosis} />
              <DeploymentLogs deployment={d} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
