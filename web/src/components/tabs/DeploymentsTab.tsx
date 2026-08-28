import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, History, Lightbulb, RotateCcw, ScrollText, XCircle } from 'lucide-react';
import { api, openStream } from '../../api';
import { Deployment, Diagnosis } from '../../types';
import { cx, DEPLOY_STATUS_LABEL, DEPLOY_TRIGGER_LABEL, fmtDuration, isActiveDeploy, timeAgo } from '../../utils';
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

/** Barra de estado y progreso discreta y profesional */
function DeployProgress({ deployment }: { deployment: Deployment }) {
  const isLive = isActiveDeploy(deployment.status);

  let currentStep = 0;
  if (deployment.status === 'queued') currentStep = 1;
  else if (deployment.status === 'building') currentStep = 2;
  else if (deployment.status === 'deploying') currentStep = 3;
  else if (deployment.status === 'success') currentStep = 4;
  else if (deployment.status === 'failed' || deployment.status === 'canceled') currentStep = -1;

  // Estado completado con éxito: barra ultra-discreta de 1 línea
  if (deployment.status === 'success') {
    return (
      <div className="flex items-center justify-between rounded-lg border border-line/60 bg-surface2/30 px-3 py-1.5 text-xs">
        <span className="flex items-center gap-1.5 font-medium text-ok text-xs">
          <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-ok/20 text-ok">
            <Check size={9} strokeWidth={3} />
          </span>
          Despliegue completado
        </span>
        <div className="flex items-center gap-2 font-mono text-micro text-subtle">
          <span>4/4 etapas</span>
          {deployment.finished_at && (
            <span>· {fmtDuration(deployment.finished_at - deployment.created_at)}</span>
          )}
        </div>
      </div>
    );
  }

  // Estado fallido o cancelado
  if (deployment.status === 'failed' || deployment.status === 'canceled') {
    return (
      <div className="flex items-center justify-between rounded-lg border border-err/30 bg-err/[.07] px-3 py-1.5 text-xs text-err">
        <span className="flex items-center gap-1.5 font-medium text-xs">
          <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-err/20 text-err font-bold text-micro">
            ✕
          </span>
          {deployment.status === 'canceled' ? 'Despliegue cancelado' : 'Despliegue interrumpido con errores'}
        </span>
        {deployment.finished_at && (
          <span className="font-mono text-micro text-subtle">
            {fmtDuration(deployment.finished_at - deployment.created_at)}
          </span>
        )}
      </div>
    );
  }

  // Estado en vivo (queued, building, deploying): barra de progreso comedida de 2px
  return (
    <div className="rounded-lg border border-line/80 bg-surface2/50 px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2 pb-1.5">
        <div className="flex items-center gap-2">
          <div className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
            <svg className="h-3.5 w-3.5 animate-spin text-warn" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
          </div>
          <span className="font-medium text-txt text-xs">
            {deployment.status === 'queued'
              ? 'En cola de ejecución…'
              : deployment.status === 'building'
                ? 'Compilando y empaquetando…'
                : 'Iniciando contenedor y validando salud…'}
          </span>
        </div>
        <span className="font-mono text-micro font-semibold text-warn">
          Etapa {currentStep}/4
        </span>
      </div>

      {/* Barra fina de 2px */}
      <div className="h-1 w-full overflow-hidden rounded-full bg-surface">
        <div
          className="h-full rounded-full bg-gradient-to-r from-acc to-warn transition-all duration-300 animate-pulse"
          style={{ width: currentStep === 1 ? '25%' : currentStep === 2 ? '60%' : '88%' }}
        />
      </div>

      {/* Mini etapas compactas */}
      <div className="mt-1.5 flex items-center justify-between text-micro text-subtle font-mono">
        <span className={cx(currentStep >= 1 ? (currentStep === 1 ? 'text-warn font-semibold' : 'text-ok') : 'text-subtle')}>
          1. Cola
        </span>
        <span className={cx(currentStep >= 2 ? (currentStep === 2 ? 'text-warn font-semibold' : 'text-ok') : 'text-subtle')}>
          2. Compilación
        </span>
        <span className={cx(currentStep >= 3 ? (currentStep === 3 ? 'text-warn font-semibold' : 'text-ok') : 'text-subtle')}>
          3. Despliegue
        </span>
        <span className={cx(currentStep >= 4 ? 'text-ok' : 'text-subtle')}>
          4. Activo
        </span>
      </div>
    </div>
  );
}

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
    <div className="mb-2.5 rounded-r-lg border-l-2 border-warn/40 bg-warn/[.06] p-3 text-xs">
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
  const [streamLines, setStreamLines] = useState<string[]>([]);
  const isLive = isActiveDeploy(deployment.status);
  const queryClient = useQueryClient();

  const logsQuery = useQuery({
    queryKey: ['deploymentLogs', deployment.id],
    queryFn: () =>
      api.get<{ buildLogs: string; runtimeLogs: string | null }>(`/deployments/${deployment.id}/logs`),
    enabled: !isLive,
  });

  useEffect(() => {
    if (!isLive) return;
    setStreamLines([]);
    const pending: string[] = [];
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (!pending.length) return;
      const incoming = pending.splice(0);
      setStreamLines((prev) => {
        const next = prev.length ? prev.concat(incoming) : incoming;
        return next.length > 8_000 ? next.slice(next.length - 8_000) : next;
      });
    };
    const es = openStream(`/deployments/${deployment.id}/logs/stream`);
    es.addEventListener('snapshot', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data);
      pending.length = 0;
      if (raf) cancelAnimationFrame(raf);
      setStreamLines(data.logs ? data.logs.split('\n').filter(Boolean) : []);
    });
    es.addEventListener('log', (ev) => {
      pending.push(JSON.parse((ev as MessageEvent).data).line);
      if (!raf) raf = requestAnimationFrame(flush);
    });
    es.addEventListener('done', () => {
      queryClient.invalidateQueries({ queryKey: ['deployments', deployment.service_id] });
      queryClient.invalidateQueries({ queryKey: ['service', deployment.service_id] });
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      es.close();
    });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      es.close();
    };
  }, [deployment.id, isLive, deployment.service_id, queryClient]);

  const lines = useMemo(() => {
    if (isLive) return streamLines;
    if (logsQuery.data) {
      const b = logsQuery.data.buildLogs ? logsQuery.data.buildLogs.split('\n').filter(Boolean) : [];
      const r = logsQuery.data.runtimeLogs
        ? logsQuery.data.runtimeLogs
            .split('\n')
            .filter(Boolean)
            .map((l) => (l.includes('[runtime]') ? l : `[runtime] ${l}`))
        : [];
      return [...b, ...r];
    }
    return deployment.logs ? deployment.logs.split('\n').filter(Boolean) : [];
  }, [isLive, streamLines, logsQuery.data, deployment.logs]);

  return (
    <LogViewer
      lines={lines}
      toolbar
      title={deployment.id}
      downloadName={`deploy-${deployment.id}.txt`}
      className="h-[min(52vh,420px)] overflow-hidden rounded-lg border border-line"
    />
  );
}

/**
 * Pill de estado del despliegue: píldora sobria con spinner de progreso si está activo.
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
      className={cx(
        'badge-in inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium transition-colors',
        active ? 'bg-warn/10 text-warn border border-warn/25' : 'bg-surface2 text-sub border border-line',
      )}
    >
      {active ? (
        <svg className="h-3 w-3 animate-spin text-warn" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
      ) : (
        <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
      )}
      {label}
    </span>
  );
}

export default function DeploymentsTab({
  serviceId,
  serviceType,
  onNavigateToLogs,
}: {
  serviceId: string;
  serviceType: string;
  onNavigateToLogs?: (deploymentId: string) => void;
}) {
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

  // El servidor los envía en orden cronológico (el más reciente primero).
  const list = deployments.data?.deployments ?? [];
  // El despliegue "vigente": el éxito más reciente (la versión que sirve ahora).
  const currentId = list.find((d) => d.status === 'success')?.id ?? null;
  // El más reciente en el tiempo: sirve para teñir en rojo un último intento fallido.
  const latestId = list[0]?.id ?? null;

  // Orden: primero LO QUE ESTÁ SALIENDO, después el vigente («Activo»), y
  // debajo el histórico en orden cronológico.
  const running = list.filter((d) => isActiveDeploy(d.status));
  const runningIds = new Set(running.map((d) => d.id));
  const current = currentId ? list.find((d) => d.id === currentId) : undefined;
  const ordered = [
    ...running,
    ...(current && !runningIds.has(current.id) ? [current] : []),
    ...list.filter((d) => !runningIds.has(d.id) && d.id !== currentId),
  ];

  const runningId = running[0]?.id ?? null;
  useEffect(() => {
    if (runningId) setOpenId(runningId);
  }, [runningId]);

  useEffect(() => {
    if (openId === null && !runningId && ordered.length > 0) setOpenId(ordered[0].id);
  }, [ordered.length]);

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
      {ordered.map((d) => {
        const open = openId === d.id;
        const active = isActiveDeploy(d.status);
        const isCurrent = d.id === currentId;
        const isLatestFailed = d.id === latestId && d.status === 'failed';
        // El estado ya lo dice la píldora; al borde le basta con marcar lo que
        // pide atención. Antes competían cuatro mezclas de color a la vez.
        const tint = active
          ? 'border-warn/40 bg-warn/5'
          : isLatestFailed
            ? 'border-err/45 bg-err/5'
            : isCurrent
              ? 'border-ok/35'
              : open
                ? 'border-line2'
                : 'border-line';
        return (
          <div key={d.id} className={cx('relative overflow-hidden rounded-xl border bg-bg transition-colors duration-[--dur-3]', tint)}>
            <div className="flex items-center gap-1 pr-2">
              <button
                onClick={() => toggle(d.id)}
                aria-expanded={open}
                className="flex min-w-0 flex-1 items-center gap-3 px-3.5 py-3 text-left transition-colors duration-[--dur-1] hover:bg-txt/[.03]"
              >
                <DeployPill deployment={d} isCurrent={d.id === currentId} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {d.commit_msg ||
                      (d.trigger === 'rollback'
                        ? 'Rollback de imagen'
                        : serviceType === 'database'
                          ? 'Despliegue de base de datos'
                          : 'Despliegue')}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-xs text-subtle">
                    {DEPLOY_TRIGGER_LABEL[d.trigger] ?? d.trigger}
                    {d.commit_sha && <> · {d.commit_sha.slice(0, 7)}</>}
                    <> · {timeAgo(d.created_at)}</>
                    {d.finished_at && <> · {fmtDuration(d.finished_at - d.created_at)}</>}
                  </span>
                </span>
                <ChevronDown
                  size={14}
                  aria-hidden
                  className={cx('ml-auto shrink-0 text-subtle transition-transform duration-[--dur-2]', open && 'rotate-180')}
                />
              </button>
              <span className="flex shrink-0 items-center gap-1">
                {onNavigateToLogs && (
                  <button
                    type="button"
                    onClick={() => onNavigateToLogs(d.id)}
                    className="press flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-xs font-medium text-sub hover:bg-surface2 hover:text-txt"
                    title="Ver logs completos en la consola"
                  >
                    <ScrollText size={12} aria-hidden />
                    <span className="hidden sm:inline">Logs</span>
                  </button>
                )}
                {active && (
                  <button
                    type="button"
                    onClick={() => cancel.mutate(d.id)}
                    className="press rounded-lg p-1.5 leading-none text-err/80 hover:bg-surface2 hover:text-err"
                    title="Cancelar despliegue"
                    aria-label="Cancelar despliegue"
                  >
                    <XCircle size={14} aria-hidden />
                  </button>
                )}
                {d.id !== currentId && d.status === 'success' && serviceType === 'git' && (
                  <button
                    type="button"
                    onClick={() => rollback.mutate(d.id)}
                    className="press rounded-lg p-1.5 leading-none text-subtle hover:bg-surface2 hover:text-txt"
                    title="Volver a esta versión"
                    aria-label="Volver a esta versión"
                  >
                    <RotateCcw size={13} aria-hidden />
                  </button>
                )}
              </span>
            </div>
            {(open || closingId === d.id) && (
              <Collapse open={open}>
                <div className="border-t border-line p-3 flex flex-col gap-2.5">
                  {d.error && (
                    <p className="rounded-lg border-l-2 border-err/40 bg-err/[.08] px-3 py-2 text-xs text-err">{d.error}</p>
                  )}
                  <DiagnosisCard raw={d.diagnosis} />
                  <DeploymentLogs deployment={d} />
                  <DeployProgress deployment={d} />
                </div>
              </Collapse>
            )}
          </div>
        );
      })}
    </div>
  );
}
