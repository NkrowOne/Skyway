import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Lightbulb, RotateCcw, XCircle } from 'lucide-react';
import { api, openStream } from '../../api';
import { Deployment, Diagnosis } from '../../types';
import { cx, DEPLOY_STATUS_LABEL, fmtDuration, isActiveDeploy, timeAgo } from '../../utils';
import LogViewer from '../LogViewer';
import { Skeleton, useToast } from '../ui';

/**
 * Acordeón mantequilla: crece y se pliega animando grid-template-rows
 * (0fr ↔ 1fr), que sí sabe interpolar hasta la altura natural del contenido.
 * Monta en 0fr y crece al frame siguiente para que la apertura también anime.
 */
function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setGrown(open));
    return () => cancelAnimationFrame(raf);
  }, [open]);
  return (
    <div className={cx('collapse-grid', grown && open && 'collapse-open')}>
      <div>{children}</div>
    </div>
  );
}

const TRIGGER_LABEL: Record<string, string> = {
  initial: 'creación',
  manual: 'manual',
  webhook: 'push',
  autodeploy: 'auto-deploy',
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
    <div className="mb-2.5 rounded-r-lg border-l-2 border-warn bg-warn/[.06] p-3 text-xs">
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
    // Coalescencia por frame: los builds emiten ráfagas de líneas; agruparlas
    // evita un re-render por línea sobre un buffer que puede ser grande.
    const pending: string[] = [];
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (!pending.length) return;
      const incoming = pending.splice(0);
      setLines((prev) => {
        const next = prev.length ? prev.concat(incoming) : incoming;
        return next.length > 20_000 ? next.slice(next.length - 20_000) : next;
      });
    };
    const es = openStream(`/deployments/${deployment.id}/logs/stream`);
    es.addEventListener('snapshot', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data);
      pending.length = 0;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      setLines(data.logs ? data.logs.split('\n').filter(Boolean) : []);
    });
    es.addEventListener('log', (ev) => {
      pending.push(JSON.parse((ev as MessageEvent).data).line);
      if (!raf) raf = requestAnimationFrame(flush);
    });
    es.addEventListener('done', () => {
      queryClient.invalidateQueries({ queryKey: ['deployments', deployment.service_id] });
      queryClient.invalidateQueries({ queryKey: ['service', deployment.service_id] });
      es.close();
    });
    es.onerror = () => {
      /* si el despliegue terminó, el servidor cierra el stream */
    };
    return () => {
      if (raf) cancelAnimationFrame(raf);
      es.close();
    };
  }, [deployment.id]);

  return (
    <LogViewer
      lines={lines}
      toolbar
      title="Build & deploy"
      downloadName={`deploy-${deployment.id}.log`}
      // Altura acotada cómoda: el log no estira el panel; con muchas líneas
      // aparece su propio scroll (el cuerpo virtualiza, no pinta todo a la vez)
      // y al llegar al borde el scroll continúa en el panel.
      className="h-[min(56vh,460px)]"
    />
  );
}

/**
 * Pill de estado del despliegue: píldora sobria y neutra; el color lo lleva un
 * punto indicador, no todo el fondo. Así un «Fallido» marca en rojo solo el
 * punto —no tiñe la píldora entera— y el conjunto se lee limpio y profesional.
 * Cada transición (En cola → Construyendo → Activo) entra con un pop mínimo.
 */
function DeployPill({ deployment, isCurrent }: { deployment: Deployment; isCurrent: boolean }) {
  const active = isActiveDeploy(deployment.status);
  const label = isCurrent ? 'Activo' : DEPLOY_STATUS_LABEL[deployment.status];
  const dot = active
    ? 'bg-warn'
    : isCurrent
      ? 'bg-ok'
      : deployment.status === 'failed'
        ? 'bg-err'
        : 'bg-subtle';
  return (
    <span
      key={label}
      className="badge-in inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-surface2 px-2.5 py-[3px] text-[11px] font-medium text-sub"
    >
      <span className={cx('h-[5px] w-[5px] shrink-0 rounded-full', dot, active && 'pulse-soft')} />
      {label}
    </span>
  );
}

export default function DeploymentsTab({ serviceId, serviceType }: { serviceId: string; serviceType: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  // La tarjeta que se está plegando sigue montada hasta acabar su animación.
  const [closingId, setClosingId] = useState<string | null>(null);
  const closeTimer = useRef<number>();
  const toast = useToast();
  const queryClient = useQueryClient();

  const toggle = (id: string) => {
    const prev = openId;
    setOpenId(id === prev ? null : id);
    if (prev) {
      setClosingId(prev);
      window.clearTimeout(closeTimer.current);
      closeTimer.current = window.setTimeout(() => setClosingId(null), 340);
    }
  };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const deployments = useQuery({
    queryKey: ['deployments', serviceId],
    queryFn: () => api.get<{ deployments: Deployment[] }>(`/services/${serviceId}/deployments`),
    refetchInterval: 4000,
  });

  const rollback = useMutation({
    mutationFn: (deploymentId: string) => api.post<{ deployment: Deployment }>(`/deployments/${deploymentId}/rollback`),
    onSuccess: (data) => {
      toast('Rollback iniciado', 'ok');
      toggle(data.deployment.id);
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
      {list.map((d, idx) => {
        const open = openId === d.id;
        const active = isActiveDeploy(d.status);
        const isCurrent = d.id === currentId;
        // Lógica de énfasis: solo el estado VIGENTE lleva color de fondo.
        // El que sirve tráfico va en verde; el último intento, si falló, en rojo;
        // el que está en curso lleva borde ámbar y cometa de progreso.
        // El histórico queda neutro para que el color siempre signifique «ahora».
        const isLatestFailed = idx === 0 && d.status === 'failed';
        const tint = active
          ? 'border-[color-mix(in_oklab,var(--color-warn)_40%,var(--color-line))] bg-warn/[.04]'
          : isLatestFailed
            ? 'border-[color-mix(in_oklab,var(--color-err)_45%,var(--color-line))] bg-err/[.06]'
            : isCurrent
              ? 'border-[color-mix(in_oklab,var(--color-ok)_35%,var(--color-line))] bg-ok/[.05]'
              : open
                ? 'border-[color-mix(in_oklab,#6e56cf_30%,var(--color-line))] bg-bg'
                : 'border-line bg-bg';
        return (
        <div key={d.id} className={cx('relative overflow-hidden rounded-xl border transition-colors duration-300', tint)}>
          <button
            onClick={() => toggle(d.id)}
            className="flex w-full items-center justify-between gap-2 px-3.5 py-3 text-left transition-colors duration-150 hover:bg-txt/[.03]"
          >
            <div className="flex min-w-0 items-center gap-3">
              <DeployPill deployment={d} isCurrent={d.id === currentId} />
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
          {(open || closingId === d.id) && (
            <Collapse open={open}>
              <div className="border-t border-line p-3">
                {d.error && (
                  <p className="mb-2.5 rounded-r-lg border-l-2 border-err bg-err/[.08] px-3 py-2.5 text-xs text-err">{d.error}</p>
                )}
                <DiagnosisCard raw={d.diagnosis} />
                <DeploymentLogs deployment={d} />
              </div>
            </Collapse>
          )}
        </div>
        );
      })}
    </div>
  );
}
