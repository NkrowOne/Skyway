import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, ExternalLink, Hammer, MoveHorizontal, Play, RefreshCw, Rocket, ScrollText, Square, Terminal, X } from 'lucide-react';
import { api } from '../api';
import { useLatch, useLocalStorage, useMediaQuery } from '../hooks';
import { MetricPoint } from '../pages/Project';
import { useServiceLiveReplicas, useServiceLiveState } from '../livemetrics';
import { Deployment, DbOverview, Project, Runtime, Service } from '../types';
import { cx, DEPLOY_STATUS_LABEL, isActiveDeploy, serviceStatus, timeAgo } from '../utils';
import { ModuleChip, moduleKind } from './ModuleIcon';
import DeploymentsTab from './tabs/DeploymentsTab';
import { Button, ConfirmModal, ErrorState, Skeleton, Spinner, StatusBadge, Tabs, useToast } from './ui';

// La pestaña de Despliegues (por defecto) viaja con el drawer; el resto de pestañas
// y el terminal se cargan al abrirlos, para no descargar las 8 pestañas de una vez.
const ExecModal = lazy(() => import('./ExecModal'));
const BackupsTab = lazy(() => import('./tabs/BackupsTab'));
const DbConsoleTab = lazy(() => import('./tabs/DbConsoleTab'));
const FilesTab = lazy(() => import('./tabs/FilesTab'));
const LogsTab = lazy(() => import('./tabs/LogsTab'));
const MetricsTab = lazy(() => import('./tabs/MetricsTab'));
const ServiceSettingsTab = lazy(() => import('./tabs/ServiceSettingsTab'));
const VariablesTab = lazy(() => import('./tabs/VariablesTab'));

const BACKUP_TEMPLATES = ['postgres', 'mysql', 'mongo'];

export default function ServiceDrawer({
  serviceId,
  projectId,
  projectName,
  historyRef,
  closing = false,
  initialTab = null,
  onClose,
}: {
  serviceId: string;
  projectId: string;
  projectName: string;
  historyRef: React.MutableRefObject<Map<string, MetricPoint[]>>;
  /** El padre mantiene el drawer montado mientras se despide (usePresence). */
  closing?: boolean;
  /** Pestaña pedida en la URL (`?tab=`): manda sobre la elección por defecto. */
  initialTab?: string | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState(initialTab ?? 'deployments');
  // Estado y réplicas en vivo por suscripción propia: el drawer ya no recibe la
  // foto entera y no se repinta —con su pestaña abierta— en cada tick del stream.
  const liveState = useServiceLiveState(serviceId);
  const liveReplicas = useServiceLiveReplicas(serviceId);
  /**
   * Al abrir una base de datos se entra por Consultas. «Despliegues» en un
   * Postgres de plantilla solo dice que se hizo un `pull`: a una base se viene
   * a consultarla. Solo se decide una vez por servicio; a partir de ahí manda
   * la pestaña que elija quien lo esté usando.
   */
  const pestanaFijada = useRef<string | null>(null);
  const [execOpen, setExecOpen] = useState(false);
  // El terminal (ExecModal) se descarga en su 1ª apertura; el cerrojo lo mantiene
  // montado luego para conservar su animación de cierre.
  const execLatched = useLatch(execOpen);
  // Detener/reiniciar cortan el servicio: confirmamos para evitar clics accidentales.
  const [confirmVerb, setConfirmVerb] = useState<'stop' | 'restart' | null>(null);
  // Cambios guardados (ajustes o variables) que solo surten efecto al redesplegar.
  // Un aviso persistente vale más que un toast fugaz. Se limpia al desplegar o cambiar de servicio.
  const [pendingRedeploy, setPendingRedeploy] = useState(false);
  const [targetDeploymentId, setTargetDeploymentId] = useState<string | null>(null);
  const [isTabDirty, setIsTabDirty] = useState(false);
  const [pendingTabChange, setPendingTabChange] = useState<string | null>(null);
  const [pendingClose, setPendingClose] = useState(false);

  useEffect(() => {
    setPendingRedeploy(false);
    setTargetDeploymentId(null);
    setIsTabDirty(false);
    setPendingTabChange(null);
    setPendingClose(false);
  }, [serviceId]);
  const [wide, setWide] = useLocalStorage('skyway.drawerWide', false);
  const fullscreen = useMediaQuery('(max-width: 899px)');
  const toast = useToast();
  const queryClient = useQueryClient();
  // Dos fases de anchura (0 → objetivo) para que el canvas haga sitio con la misma transición.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleAttemptClose = useCallback(() => {
    if (isTabDirty) {
      setPendingClose(true);
      return;
    }
    onClose();
  }, [isTabDirty, onClose]);

  const handleTabChange = (nextTab: string) => {
    if (nextTab === tab) return;
    if (isTabDirty) {
      setPendingTabChange(nextTab);
      return;
    }
    setTab(nextTab);
  };

  const asideRef = useRef<HTMLElement>(null);
  // Esc cierra el drawer, salvo que haya un modal/paleta abierto por encima o cambios sin guardar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // A pantalla completa el propio drawer es un `role="dialog"`: no cuenta
      // como «algo abierto encima» o Esc nunca lo cerraba en tableta con teclado.
      const dialogo = [...document.querySelectorAll('[role="dialog"]')].some((el) => el !== asideRef.current);
      if (dialogo) return;
      handleAttemptClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleAttemptClose]);

  // Aviso del navegador si el usuario recarga la página con cambios sin guardar
  useEffect(() => {
    if (!isTabDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isTabDirty]);

  const detail = useQuery({
    queryKey: ['service', serviceId],
    queryFn: () =>
      api.get<{
        service: Service;
        project: Project;
        runtime: Runtime;
        latestDeployment: Deployment | null;
        /** Motor de la consola de consultas, o null si este servicio no tiene. */
        dbConsole: DbOverview['engine'] | null;
      }>(`/services/${serviceId}`),
    // El estado vivo del contenedor ya llega por el stream de métricas del
    // proyecto (livemetrics); esto solo refresca el último despliegue y la
    // configuración, y a 4 s sumaba tres sondeos con el panel abierto.
    refetchInterval: 8000,
  });

  useEffect(() => {
    if (!detail.data || pestanaFijada.current === serviceId) return;
    pestanaFijada.current = serviceId;
    // Con una pestaña pedida por URL no se pisa: quien llega desde un enlace
    // a «Variables» de una base de datos quiere Variables, no Consultas.
    if (detail.data.dbConsole && !initialTab) setTab('db');
  }, [serviceId, detail.data, initialTab]);

  // Un enlace a otra pestaña del MISMO servicio no remonta el drawer (la clave
  // es el id): se atiende aquí, con el mismo cuidado por los cambios sin guardar.
  useEffect(() => {
    if (!initialTab || initialTab === tab) return;
    if (isTabDirty) setPendingTabChange(initialTab);
    else setTab(initialTab);
    // Solo reacciona al enlace: `tab` e `isTabDirty` cambian por otras vías y
    // no deben volver a forzar la pestaña pedida.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['service', serviceId] });
    queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    queryClient.invalidateQueries({ queryKey: ['projects'] });
    queryClient.invalidateQueries({ queryKey: ['deployments', serviceId] });
    queryClient.invalidateQueries({ queryKey: ['alerts'] });
  };

  /**
   * Despliegue. Sin `force`, si el commit y la configuración de build no han
   * cambiado se reutiliza la imagen ya construida (que es lo que se quiere al
   * redesplegar por variables); con `force` se recompila desde cero, para
   * cuando lo que cambió está fuera del repo (imagen base, un paquete).
   */
  const deploy = useMutation({
    mutationFn: (force?: boolean) =>
      api.post<{ deployment: Deployment }>(`/services/${serviceId}/deploy`, force ? { force: true } : {}),
    onSuccess: (_data, force) => {
      toast(force ? 'Reconstruyendo la imagen desde cero…' : 'Despliegue iniciado.', 'ok');
      setPendingRedeploy(false);
      // Solo si no hay nada a medias: el salto a Despliegues desmontaba una
      // pestaña con cambios sin guardar y se perdían sin preguntar.
      if (!isTabDirty) setTab('deployments');
      invalidate();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const action = useMutation({
    mutationFn: (verb: 'start' | 'stop' | 'restart') => api.post(`/services/${serviceId}/${verb}`),
    onSuccess: () => {
      setConfirmVerb(null);
      invalidate();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const asideCls = cx(
    'lit lit-alto flex flex-col bg-surface [--lit-fin:200px]',
    fullscreen
      ? // Móvil: entra y sale como una página apilada (push de navegación).
        cx('fixed inset-0 z-40', closing ? 'push-out' : 'push-in')
      : cx(
          'min-h-0 shrink-0 overflow-hidden border-l border-line shadow-drawer transition-[width,opacity] duration-[220ms] ease-[cubic-bezier(.25,.8,.3,1)]',
          closing ? 'drawer-out' : 'drawer-in',
        ),
  );
  // La anchura anima de 0 al objetivo al entrar y de vuelta a 0 al salir: el canvas hace sitio en el mismo gesto.
  /*
   * El ancho se limita también en proporción, no solo en píxeles: con
   * `calc(100vw - 64px)` un drawer amplio se comía 836 de 900 y dejaba el
   * lienzo en 64px. Como la preferencia se guarda, bastaba haberlo ensanchado
   * una vez en un monitor grande para encontrárselo así en el portátil.
   */
  const targetWidth = wide ? 'min(840px, 62vw)' : 'min(600px, 50vw, calc(100vw - 64px))';
  const asideStyle = fullscreen ? undefined : { width: entered && !closing ? targetWidth : 0 };

  /*
   * La barra de cierre se pinta en las tres ramas, no solo en la de éxito.
   * Por debajo de 900px el drawer es un `fixed inset-0` que tapa hasta la
   * barra superior: si la petición tarda o falla y esta barra no está, en un
   * teléfono no hay forma de volver —no hay Esc ni velo que tocar.
   */
  const barraDeCierre = fullscreen && (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
      <button
        onClick={handleAttemptClose}
        className="press flex min-h-10 items-center gap-1.5 rounded-lg px-2.5 text-sm text-sub hover:bg-surface2 hover:text-txt"
      >
        <ChevronLeft size={15} /> {projectName}
      </button>
      <button
        onClick={handleAttemptClose}
        className="press ml-auto flex min-h-10 min-w-10 items-center justify-center rounded-lg leading-none text-subtle hover:bg-surface2 hover:text-txt"
        title="Cerrar (Esc)"
        aria-label="Cerrar"
      >
        <X size={17} />
      </button>
    </div>
  );

  if (!detail.data && detail.isError) {
    return (
      <aside className={asideCls} style={asideStyle}>
        {barraDeCierre}
        <div className="flex h-full items-center justify-center p-5">
          <ErrorState
            title="No se ha podido cargar el servicio"
            error={detail.error}
            onRetry={() => detail.refetch()}
            retrying={detail.isFetching}
          />
        </div>
      </aside>
    );
  }

  if (!detail.data) {
    return (
      <aside className={asideCls} style={asideStyle} aria-busy>
        {barraDeCierre}
        <div className="border-b border-line p-5">
          <div className="flex items-center gap-3">
            <Skeleton className="h-[38px] w-[38px] rounded-[10px]" />
            <div>
              <Skeleton className="h-4 w-36" />
              <Skeleton className="mt-1.5 h-3 w-52" />
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-24" />
          </div>
        </div>
        <div className="space-y-2.5 p-5">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      </aside>
    );
  }

  const { service, runtime } = detail.data;
  // Con un despliegue vivo, el estado del contenedor sigue siendo el de la
  // versión ANTERIOR (sigue sirviendo): la fase del despliegue va aparte, en su
  // propia chapa, para no confundir «Activo» con «ya está la versión nueva».
  const activeDeployment =
    detail.data.latestDeployment && isActiveDeploy(detail.data.latestDeployment.status)
      ? detail.data.latestDeployment
      : null;
  const state = liveState ?? runtime.state;
  const replicas = liveReplicas ?? undefined;
  const isRunning = state === 'running' || state === 'restarting';
  // «Detenido» (gris, lo paró alguien) y «Caído» (rojo, se murió solo) son
  // cosas distintas y aquí, con el porqué a mano, se separan.
  const status = serviceStatus(state, { exitCode: runtime.exitCode, stoppedAt: service.stopped_at });
  const hasBackups = service.type === 'database' && BACKUP_TEMPLATES.includes(service.config.template);
  const hasDbConsole = !!detail.data.dbConsole;
  // Por frecuencia de uso: lo que se abre a diario va a la izquierda, donde
  // en el móvil se ve sin desplazar la fila. Los logs estaban los penúltimos.
  const tabs = [
    ...(hasDbConsole ? [{ key: 'db', label: 'Consultas' }] : []),
    { key: 'deployments', label: 'Despliegues' },
    { key: 'logs', label: 'Logs' },
    { key: 'variables', label: 'Variables' },
    ...(hasBackups ? [{ key: 'backups', label: 'Backups' }] : []),
    { key: 'metrics', label: 'Métricas' },
    { key: 'files', label: 'Archivos' },
    { key: 'settings', label: 'Ajustes' },
  ];
  const domain = service.type !== 'database' ? service.config.domains?.[0] : undefined;
  const subtitle =
    service.type === 'git'
      ? `${service.config.repoUrl.replace(/^https?:\/\/(www\.)?/, '')} · ${service.config.branch}`
      : service.type === 'image'
        ? `${service.config.image} · host interno: ${service.slug}`
        : `${service.config.template}:${service.config.version} · host interno: ${service.slug}`;

  return (
    <aside
      ref={asideRef}
      className={asideCls}
      style={asideStyle}
      role={fullscreen ? 'dialog' : 'complementary'}
      aria-modal={fullscreen || undefined}
      aria-label={`Servicio ${service.name}`}
    >
      {barraDeCierre}

      <div className={cx('shrink-0', fullscreen ? 'px-3.5 pt-4' : 'px-5 pt-4')}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <ModuleChip kind={moduleKind(service)} size={fullscreen ? 40 : 38} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-base font-semibold">{service.name}</h2>
                <StatusBadge
                  pill
                  tone={status.tone}
                  label={status.label}
                  pulse={status.pulse}
                  title={status.detail}
                  replicas={replicas}
                />
                {activeDeployment && (
                  <span className="badge-in inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-warn/35 bg-warn/[.1] px-2 py-0.5 text-xs font-medium text-warn">
                    <span className="pulse-soft h-[5px] w-[5px] rounded-full bg-warn" />
                    {DEPLOY_STATUS_LABEL[activeDeployment.status]}
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate font-mono text-xs text-subtle">{subtitle}</p>
            </div>
          </div>
          {!fullscreen && (
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={() => setWide(!wide)}
                className="press rounded-lg p-1.5 leading-none text-subtle hover:bg-surface2 hover:text-txt"
                title="Cambiar ancho del panel"
                aria-label="Cambiar ancho del panel"
              >
                <MoveHorizontal size={15} />
              </button>
              <button
                type="button"
                onClick={handleAttemptClose}
                className="press rounded-lg p-1.5 leading-none text-subtle hover:bg-surface2 hover:text-txt"
                title="Cerrar (Esc)" aria-label="Cerrar (Esc)"
              >
                <X size={15} />
              </button>
            </div>
          )}
        </div>

        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className={cx(fullscreen && 'h-11 flex-1')}
            onClick={() => deploy.mutate(undefined)}
            loading={deploy.isPending}
          >
            <Rocket size={13} /> Desplegar
          </Button>
          {service.type === 'git' && (
            <Button
              size="sm"
              variant="secondary"
              className={cx(fullscreen && 'h-11 min-w-11 px-0')}
              onClick={() => deploy.mutate(true)}
              title="Reconstruir la imagen desde cero, sin reutilizar la del commit ya construido"
              aria-label="Reconstruir"
            >
              <Hammer size={fullscreen ? 16 : 13} /> {!fullscreen && 'Reconstruir'}
            </Button>
          )}
          {isRunning ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                className={cx(fullscreen && 'h-11 min-w-11 px-0')}
                onClick={() => setConfirmVerb('restart')}
                loading={action.isPending && confirmVerb === 'restart'}
                title="Reiniciar"
                aria-label="Reiniciar"
              >
                <RefreshCw size={fullscreen ? 16 : 13} /> {!fullscreen && 'Reiniciar'}
              </Button>
              {/* Detener corta el servicio: va separado de Reiniciar, que
                  estaba pegado a él y se pulsaba por error. */}
              <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-line" />
              <Button
                size="sm"
                variant="secondary"
                className={cx(fullscreen && 'h-11 min-w-11 px-0')}
                onClick={() => setConfirmVerb('stop')}
                loading={action.isPending && confirmVerb === 'stop'}
                title="Detener"
                aria-label="Detener"
              >
                <Square size={fullscreen ? 16 : 13} /> {!fullscreen && 'Detener'}
              </Button>
            </>
          ) : (
            state !== 'not_created' && (
              <Button
                size="sm"
                variant="secondary"
                className={cx(fullscreen && 'h-11 px-4')}
                onClick={() => action.mutate('start')}
                loading={action.isPending}
              >
                <Play size={13} /> Iniciar
              </Button>
            )
          )}
          {isRunning && (
            <Button
              size="sm"
              variant="ghost"
              className={cx(fullscreen && 'h-11 min-w-11 border border-line px-0')}
              onClick={() => setExecOpen(true)}
              title="Ejecutar comando en el contenedor"
            >
              <Terminal size={fullscreen ? 16 : 13} />
            </Button>
          )}
          {domain && (
            <a
              href={`http://${domain}`}
              target="_blank"
              rel="noreferrer"
              // En móvil se muestra también, en su propia fila: era la única
              // forma de abrir el sitio desde el panel y ahí no estaba.
              className={cx(
                'inline-flex min-w-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-sub transition-colors duration-150 hover:bg-surface2 hover:text-txt',
                fullscreen ? 'h-11 w-full border border-line' : 'ml-auto max-w-[190px]',
              )}
              title={`Abrir ${domain}`}
            >
              <ExternalLink size={12} className="shrink-0" />
              <span className="truncate">{domain}</span>
            </a>
          )}
        </div>

        {/*
          * El estado también se cuenta en una línea, no solo en una chapa: un
          * servicio parado se lee como parado, con su motivo y su salida.
          */}
        {status.kind === 'stopped' && state !== 'created' && !activeDeployment && (
          <div className="tab-in mt-3.5 flex items-center gap-2.5 rounded-xl border border-line bg-surface2/60 px-3 py-2 text-xs text-sub">
            <Square size={13} className="shrink-0 text-subtle" aria-hidden />
            <span className="min-w-0 leading-snug">
              <span className="font-semibold text-txt">Detenido</span>
              {service.stopped_at ? ` desde el panel ${timeAgo(service.stopped_at)}` : status.detail ? ` · ${status.detail}` : ''}.
              {' '}No atenderá peticiones hasta que se inicie.
            </span>
          </div>
        )}
        {status.kind === 'down' && !activeDeployment && (
          <div className="tab-in mt-3.5 flex items-center gap-2.5 rounded-xl border border-err/35 bg-err/[.07] px-3 py-2 text-xs text-sub">
            <AlertTriangle size={13} className="shrink-0 text-err" aria-hidden />
            <span className="min-w-0 flex-1 leading-snug">
              <span className="font-semibold text-err">Caído</span>
              {status.detail ? ` · ${status.detail}` : ''}. El error suele encontrarse al final del registro.
            </span>
            <button
              type="button"
              onClick={() => handleTabChange('logs')}
              className="press flex h-9 shrink-0 items-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-xs font-medium text-txt hover:bg-surface2 sm:h-7 sm:px-2"
            >
              <ScrollText size={12} aria-hidden /> Ver registro
            </button>
          </div>
        )}

        {pendingRedeploy && (
          <div className="tab-in mt-3.5 flex flex-col gap-2.5 rounded-xl border border-acc/35 bg-acc/[.09] p-3 text-xs sm:flex-row sm:items-center sm:gap-3 shadow-sm">
            <span className="flex min-w-0 flex-1 items-center gap-2.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-acc/20 text-acc">
                <Rocket size={14} />
              </span>
              <span className="text-sub leading-snug">
                <span className="font-semibold text-txt">Cambios guardados sin aplicar.</span> Se aplicarán en el próximo despliegue.
              </span>
            </span>
            <Button
              size="sm"
              variant="primary"
              className="w-full shrink-0 sm:w-auto font-semibold shadow-md text-xs px-3"
              onClick={() => deploy.mutate(undefined)}
              loading={deploy.isPending}
            >
              Desplegar ahora
            </Button>
          </div>
        )}

        <Tabs
          tabs={tabs}
          active={tab}
          onChange={handleTabChange}
          className={cx('mt-3.5', fullscreen ? '-mx-3.5 px-3.5' : '-mx-5 px-5')}
        />
      </div>

      <div
        // La clave por pestaña remonta el panel al cambiar: sin ella se
        // conservaba la posición de scroll de la anterior y se entraba en la
        // siguiente a media altura, sin motivo aparente.
        key={tab}
        className={cx(
          'relative min-h-0 flex-1 overscroll-contain',
          tab === 'logs' ? 'overflow-hidden flex flex-col' : 'overflow-y-auto',
          // A pantalla completa el panel llega hasta el borde inferior: la
          // última fila de cada pestaña quedaba debajo de la barra de gestos.
          fullscreen && 'pb-[env(safe-area-inset-bottom)]',
        )}
        role="tabpanel"
        aria-label={tabs.find((t) => t.key === tab)?.label}
      >
        {/* En Logs, el visor ocupa el 100% del alto disponible y scrollea por dentro.
            En pestañas de documento (despliegues, variables, métricas…) el tabpanel scrollea externamente. */}
        <div key={tab} className="tab-in flex h-full flex-col min-h-0">
          {/* La pestaña activa (salvo Despliegues) se carga bajo demanda; Suspense
              solo muestra el spinner la 1ª vez que se abre una pestaña diferida. */}
          <Suspense fallback={<div className="flex flex-1 items-center justify-center p-8"><Spinner /></div>}>
            {tab === 'deployments' && (
              <DeploymentsTab
                serviceId={serviceId}
                serviceType={service.type}
                serviceStatus={status.kind}
                onNavigateToLogs={(depId) => {
                  setTargetDeploymentId(depId);
                  setTab('logs');
                }}
              />
            )}
            {tab === 'db' && <DbConsoleTab serviceId={serviceId} />}
            {tab === 'variables' && (
              <VariablesTab
                serviceId={serviceId}
                serviceType={service.type}
                envImport={service.config.envImport ?? null}
                projectId={projectId}
                onSaved={() => {
                  invalidate();
                  setPendingRedeploy(true);
                  setIsTabDirty(false);
                }}
                onDeploy={() => deploy.mutate(undefined)}
                onNeedsRedeploy={() => setPendingRedeploy(true)}
                onDirtyChange={setIsTabDirty}
              />
            )}
            {tab === 'backups' && <BackupsTab serviceId={serviceId} service={service} onChanged={invalidate} />}
            {tab === 'files' && <FilesTab serviceId={serviceId} />}
            {tab === 'metrics' && <MetricsTab serviceId={serviceId} service={service} historyRef={historyRef} />}
            {tab === 'logs' && (
              <LogsTab
                serviceId={serviceId}
                replicas={(service.config as any).replicas ?? 1}
                initialDeploymentId={targetDeploymentId}
              />
            )}
            {tab === 'settings' && (
              <ServiceSettingsTab
                service={service}
                projectId={projectId}
                onChanged={invalidate}
                onNeedsRedeploy={() => setPendingRedeploy(true)}
                onDirtyChange={setIsTabDirty}
                onDeleted={() => {
                  invalidate();
                  onClose();
                }}
              />
            )}
          </Suspense>
        </div>
      </div>

      {execLatched && (
        <Suspense fallback={null}>
          <ExecModal open={execOpen} onClose={() => setExecOpen(false)} serviceId={serviceId} serviceName={service.name} />
        </Suspense>
      )}

      {/* Dos modales con contenido fijo: el texto no cambia mientras uno se desvanece al cerrar. */}
      <ConfirmModal
        open={confirmVerb === 'restart'}
        onClose={() => setConfirmVerb(null)}
        onConfirm={() => action.mutate('restart')}
        loading={action.isPending}
        title={`Reiniciar «${service.name}»`}
        message="El servicio dejará de responder durante unos segundos mientras vuelve a arrancar."
        confirmLabel="Reiniciar"
        confirmVariant="primary"
      />
      <ConfirmModal
        open={confirmVerb === 'stop'}
        onClose={() => setConfirmVerb(null)}
        onConfirm={() => action.mutate('stop')}
        loading={action.isPending}
        title={`Detener «${service.name}»`}
        message="El servicio dejará de estar disponible hasta que se vuelva a iniciar."
        confirmLabel="Detener"
        confirmVariant="danger"
      />
      <ConfirmModal
        open={!!pendingTabChange || pendingClose}
        onClose={() => {
          setPendingTabChange(null);
          setPendingClose(false);
        }}
        onConfirm={() => {
          setIsTabDirty(false);
          const nextT = pendingTabChange;
          const shouldClose = pendingClose;
          setPendingTabChange(null);
          setPendingClose(false);
          if (nextT) setTab(nextT);
          if (shouldClose) onClose();
        }}
        title="Descartar los cambios sin guardar"
        // Genérico: los cambios pueden venir de Variables o de Ajustes, y el
        // texto hablaba siempre de variables de entorno.
        message="Hay cambios sin guardar en esta pestaña. Si sale ahora, se perderán."
        confirmLabel="Descartar y salir"
        confirmVariant="danger"
      />
    </aside>
  );
}
