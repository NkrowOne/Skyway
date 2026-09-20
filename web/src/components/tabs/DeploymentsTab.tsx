import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Check, ChevronDown, History, LifeBuoy, Lightbulb, RotateCcw, ScrollText, XCircle } from 'lucide-react';
import { api, openStream } from '../../api';
import { Deployment, Diagnosis } from '../../types';
import { cx, DEPLOY_STATUS_LABEL, DEPLOY_TRIGGER_LABEL, EMPTY_LIST, fmtDuration, isActiveDeploy, ServiceStatusKind, timeAgo } from '../../utils';
import LogViewer from '../LogViewer';
import { ConfirmModal, EmptyState, ErrorState, Skeleton, useToast } from '../ui';

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
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-line/60 bg-surface2/30 px-3 py-1.5 text-xs">
        <span className="flex items-center gap-1.5 text-xs font-medium text-ok">
          <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-ok/20 text-ok">
            <Check size={9} strokeWidth={3} />
          </span>
          Despliegue completado
          {deployment.finished_at && <span className="font-normal text-subtle">· {timeAgo(deployment.finished_at)}</span>}
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
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-err/30 bg-err/[.07] px-3 py-1.5 text-xs text-err">
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

      {/* Progreso por etapas: lo que de verdad se sabe. Antes la anchura salía
          de unos porcentajes inventados (25/60/88 %) y parpadeaba sin parar. */}
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-surface"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={currentStep}
        aria-label={`Etapa ${currentStep} de 4`}
      >
        <div
          className="h-full rounded-full bg-warn transition-[width] duration-[--dur-3]"
          style={{ width: `${(currentStep / 4) * 100}%` }}
        />
      </div>

      {/* Mini etapas compactas. En el drawer de un móvil (~330px) las cuatro no
          caben en una línea sin pisarse: se envuelven con un poco de aire. */}
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-micro text-subtle font-mono">
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
function DiagnosisCard({ raw, serviceId }: { raw: string | null; serviceId: string }) {
  // Se parsea una vez por texto, no en cada repintado del acordeón.
  const diagnosis = useMemo<Diagnosis | null>(() => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Diagnosis;
    } catch {
      return null;
    }
  }, [raw]);
  if (!diagnosis) return null;
  return (
    <div className="rounded-lg border border-warn/30 bg-warn/[.06] p-3 text-xs">
      <p className="flex items-center gap-1.5 font-semibold text-warn">
        <Lightbulb size={13} /> {diagnosis.title}
      </p>
      <p className="mt-1.5 text-sub">{diagnosis.cause}</p>
      <p className="mt-1.5">
        <span className="font-semibold text-ok">Cómo arreglarlo: </span>
        <span className="text-sub">{diagnosis.fix}</span>
      </p>
      {/* El asistente cruza este diagnóstico con los logs de ejecución y la
          FAQ: es el siguiente paso cuando el arreglo de arriba no basta. */}
      <Link
        to={`/help?service=${encodeURIComponent(serviceId)}&q=${encodeURIComponent('Mi despliegue falla')}`}
        className="tap mt-2.5 inline-flex items-center gap-1.5 font-semibold text-acc-soft hover:underline max-sm:mt-3 max-sm:min-h-10"
      >
        <LifeBuoy size={12} aria-hidden /> Preguntar al asistente →
      </Link>
    </div>
  );
}

/**
 * Marca una línea de ejecución como `[runtime]` DETRÁS del sello de tiempo de
 * Docker. Delante, el visor no encontraba el sello (busca «AAAA-MM-DD» al
 * principio) y la columna de hora salía vacía con el ISO pegado al texto.
 */
function tagRuntime(line: string): string {
  if (line.includes('[runtime]')) return line;
  const idx = line.indexOf(' ');
  if (idx >= 20 && line[4] === '-' && Number.isFinite(Date.parse(line.slice(0, idx)))) {
    return `${line.slice(0, idx)} [runtime] ${line.slice(idx + 1)}`;
  }
  return `[runtime] ${line}`;
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
      flush();
      queryClient.invalidateQueries({ queryKey: ['deployments', deployment.service_id] });
      queryClient.invalidateQueries({ queryKey: ['service', deployment.service_id] });
      queryClient.invalidateQueries({ queryKey: ['deploymentLogs', deployment.id] });
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
      const r = logsQuery.data.runtimeLogs ? logsQuery.data.runtimeLogs.split('\n').filter(Boolean).map(tagRuntime) : [];
      return [...b, ...r];
    }
    /*
     * Justo al terminar el despliegue, mientras llega el log archivado, se
     * sigue enseñando lo que se estuvo viendo en directo: antes la consola se
     * vaciaba unos segundos y volvía a llenarse, y parecía que se había
     * perdido el registro.
     */
    if (streamLines.length > 0) return streamLines;
    return deployment.logs ? deployment.logs.split('\n').filter(Boolean) : [];
  }, [isLive, streamLines, logsQuery.data, deployment.logs]);

  return (
    <LogViewer
      lines={lines}
      toolbar
      title={deployment.id}
      state={isLive || lines.length > 0 ? 'ready' : logsQuery.isLoading ? 'loading' : logsQuery.isError ? 'error' : 'ready'}
      onRetry={() => logsQuery.refetch()}
      emptyMessage={isLive ? 'Esperando la primera línea del build…' : 'Este despliegue no dejó ningún registro.'}
      downloadName={`deploy-${deployment.id}.txt`}
      className="h-[min(52dvh,420px)] overflow-hidden rounded-lg border border-line"
    />
  );
}

/**
 * Pill de estado del despliegue: píldora sobria con spinner de progreso si está activo.
 */
/**
 * Qué dice la píldora de la versión vigente según cómo esté el contenedor.
 * «En producción» en verde con el servicio parado era mentir dos veces: la
 * versión estará lista, pero no está sirviendo nada.
 */
function currentPill(kind: ServiceStatusKind | undefined): { label: string; cls: string; dot: string } {
  switch (kind) {
    case 'stopped':
      return { label: 'Detenido', cls: 'border-line bg-surface2 text-sub', dot: 'bg-subtle' };
    case 'down':
      return { label: 'Caído', cls: 'border-err/25 bg-err/10 text-err', dot: 'bg-err' };
    case 'none':
      return { label: 'Sin contenedor', cls: 'border-line bg-surface2 text-sub', dot: 'bg-subtle' };
    default:
      return { label: 'En producción', cls: 'border-ok/25 bg-ok/10 text-ok', dot: 'bg-ok' };
  }
}

function DeployPill({
  deployment,
  isCurrent,
  serviceKind,
}: {
  deployment: Deployment;
  isCurrent: boolean;
  serviceKind?: ServiceStatusKind;
}) {
  const active = isActiveDeploy(deployment.status);
  // «Activo» ya significa «el contenedor está en marcha» en la chapa de estado
  // del servicio, a dos centímetros de aquí. Aquí lo que se dice es otra cosa:
  // que esta es la versión que se está sirviendo (o la que se serviría).
  const current = isCurrent ? currentPill(serviceKind) : null;
  const label = current ? current.label : DEPLOY_STATUS_LABEL[deployment.status];
  const dot = active
    ? 'bg-warn'
    : current
      ? current.dot
      : deployment.status === 'failed'
        ? 'bg-err'
        : 'bg-subtle';
  return (
    <span
      key={label}
      className={cx(
        'badge-in inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs font-medium transition-colors',
        // El estado es lo que se viene a mirar a esta lista: «Completado»,
        // «Fallido» y «Cancelado» compartían el mismo gris.
        active
          ? 'border-warn/25 bg-warn/10 text-warn'
          : current
            ? current.cls
            : deployment.status === 'failed'
              ? 'border-err/25 bg-err/10 text-err'
              : 'border-line bg-surface2 text-sub',
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
  serviceStatus,
  onNavigateToLogs,
}: {
  serviceId: string;
  serviceType: string;
  /** Cómo está el contenedor ahora: decide qué dice la píldora de la versión vigente. */
  serviceStatus?: ServiceStatusKind;
  onNavigateToLogs?: (deploymentId: string) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  // Volver a una versión anterior es un cambio en producción: como el resto de
  // acciones de ese calado, pasa por una confirmación.
  const [rollbackTo, setRollbackTo] = useState<Deployment | null>(null);
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
    // Rápido solo mientras hay uno saliendo (el `done` del stream ya invalida
    // esta consulta); con todo quieto, cada 4 s no aporta nada.
    refetchInterval: (q) => (q.state.data?.deployments.some((d) => isActiveDeploy(d.status)) ? 3000 : 15_000),
  });

  const rollback = useMutation({
    mutationFn: (deploymentId: string) => api.post<{ deployment: Deployment }>(`/deployments/${deploymentId}/rollback`),
    onSuccess: (data) => {
      toast('Volviendo a la versión anterior…', 'ok');
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
  // EMPTY_LIST y no `[]`: un literal nuevo por render invalidaba el memo de abajo.
  const list = deployments.data?.deployments ?? EMPTY_LIST;
  // El despliegue "vigente": el éxito más reciente (la versión que sirve ahora).
  const currentId = list.find((d) => d.status === 'success')?.id ?? null;
  // El más reciente en el tiempo: sirve para teñir en rojo un último intento fallido.
  const latestId = list[0]?.id ?? null;

  /*
   * Orden: primero LO QUE ESTÁ SALIENDO y debajo el histórico del más nuevo al
   * más viejo, tal cual. Antes se subía el vigente al segundo puesto, y un
   * intento fallido de hace un minuto quedaba por debajo de la versión de la
   * semana pasada: justo lo que se venía a mirar, escondido. La píldora «En
   * producción» ya dice cuál sirve.
   */
  const ordered = useMemo(() => {
    const running = list.filter((d) => isActiveDeploy(d.status));
    const runningIds = new Set(running.map((d) => d.id));
    return [...running, ...list.filter((d) => !runningIds.has(d.id))];
  }, [list]);

  const runningId = ordered.find((d) => isActiveDeploy(d.status))?.id ?? null;
  useEffect(() => {
    if (runningId) setOpenId(runningId);
  }, [runningId]);

  const firstId = ordered[0]?.id ?? null;
  useEffect(() => {
    if (openId === null && !runningId && firstId) setOpenId(firstId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstId]);

  if (deployments.isLoading) {
    return (
      <div aria-busy className="flex flex-col gap-2.5 p-4 sm:px-5">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (deployments.isError) {
    return (
      <ErrorState
        title="No se han podido cargar los despliegues"
        error={deployments.error}
        onRetry={() => deployments.refetch()}
        retrying={deployments.isFetching}
      />
    );
  }

  if (list.length === 0) {
    return (
      <EmptyState
        icon={<History />}
        title="Aún no hay despliegues"
        description="Aparecerán aquí con su registro completo."
      />
    );
  }

  return (
    <div className="flex flex-col gap-2.5 p-4 sm:px-5">
      <ConfirmModal
        open={!!rollbackTo}
        onClose={() => setRollbackTo(null)}
        onConfirm={() => {
          if (rollbackTo) rollback.mutate(rollbackTo.id);
          setRollbackTo(null);
        }}
        title="Volver a esta versión"
        message={`El servicio se redesplegará con la imagen de «${rollbackTo?.commit_msg || rollbackTo?.id.slice(0, 8) || ''}». Habrá un corte breve mientras arranca.`}
        confirmLabel="Volver a esta versión"
        confirmVariant="secondary"
        loading={rollback.isPending}
      />

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
            : isCurrent && serviceStatus === 'down'
              ? 'border-err/45'
              : isCurrent && (serviceStatus === 'up' || serviceStatus === 'transient' || !serviceStatus)
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
                <DeployPill deployment={d} isCurrent={d.id === currentId} serviceKind={serviceStatus} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {d.commit_msg ||
                      (d.trigger === 'rollback'
                        ? 'Vuelta a una versión anterior'
                        : serviceType === 'database'
                          ? 'Despliegue de base de datos'
                          : 'Despliegue')}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-xs text-subtle">
                    {DEPLOY_TRIGGER_LABEL[d.trigger] ?? d.trigger}
                    {d.commit_sha && <> · {d.commit_sha.slice(0, 7)}</>}
                    <>
                      {' · '}
                      <span title={new Date(d.created_at).toLocaleString('es')}>{timeAgo(d.created_at)}</span>
                    </>
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
                    // Con el pulgar, 40px; con ratón, lo justo.
                    className="press flex h-10 items-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-xs font-medium text-sub hover:bg-surface2 hover:text-txt sm:h-7 sm:px-2"
                    title="Ver logs completos en la consola"
                    aria-label="Ver logs completos en la consola"
                  >
                    <ScrollText size={12} aria-hidden />
                    <span className="hidden sm:inline">Logs</span>
                  </button>
                )}
                {active && (
                  <button
                    type="button"
                    onClick={() => cancel.mutate(d.id)}
                    disabled={cancel.isPending}
                    className="press flex h-10 w-10 items-center justify-center rounded-lg leading-none text-err/80 hover:bg-surface2 hover:text-err disabled:opacity-40 sm:h-7 sm:w-7"
                    title="Cancelar despliegue"
                    aria-label="Cancelar despliegue"
                  >
                    <XCircle size={14} aria-hidden />
                  </button>
                )}
                {d.id !== currentId && d.status === 'success' && serviceType === 'git' && (
                  /* Es un cambio en producción: separado de «Logs» para que no se pulse de paso. */
                  <>
                  <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-line" />
                  <button
                    type="button"
                    onClick={() => setRollbackTo(d)}
                    className="press flex h-10 w-10 items-center justify-center rounded-lg leading-none text-subtle hover:bg-surface2 hover:text-txt sm:h-7 sm:w-7"
                    title="Volver a esta versión"
                    aria-label="Volver a esta versión"
                  >
                    <RotateCcw size={13} aria-hidden />
                  </button>
                  </>
                )}
              </span>
            </div>
            {(open || closingId === d.id) && (
              <Collapse open={open}>
                {/* Primero el resumen (qué pasó, en qué etapa), después el
                    registro: el ojo baja de la conclusión al detalle, no al revés. */}
                <div className="flex flex-col gap-2.5 border-t border-line p-3">
                  <DeployProgress deployment={d} />
                  {d.error && (
                    <p className="rounded-lg border border-err/30 bg-err/[.08] px-3 py-2 text-xs text-err">{d.error}</p>
                  )}
                  <DiagnosisCard raw={d.diagnosis} serviceId={serviceId} />
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
