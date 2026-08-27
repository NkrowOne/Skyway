import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ExternalLink, Hammer, MoveHorizontal, Play, RefreshCw, Rocket, Square, Terminal, X } from 'lucide-react';
import { api } from '../api';
import { useLatch, useLocalStorage, useMediaQuery } from '../hooks';
import { MetricPoint } from '../pages/Project';
import { Deployment, DbOverview, MetricsSnapshot, Project, Runtime, Service } from '../types';
import { cx, DEPLOY_STATUS_LABEL, isActiveDeploy, STATE_LABEL, STATE_PULSE, STATE_TONE } from '../utils';
import { ModuleChip, moduleKind } from './ModuleIcon';
import DeploymentsTab from './tabs/DeploymentsTab';
import { Button, ConfirmModal, Skeleton, Spinner, StatusBadge, Tabs, useToast } from './ui';

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
  latestMetrics,
  historyRef,
  closing = false,
  onClose,
}: {
  serviceId: string;
  projectId: string;
  projectName: string;
  latestMetrics: MetricsSnapshot | null;
  historyRef: React.MutableRefObject<Map<string, MetricPoint[]>>;
  /** El padre mantiene el drawer montado mientras se despide (usePresence). */
  closing?: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState('deployments');
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
  useEffect(() => {
    setPendingRedeploy(false);
    setTargetDeploymentId(null);
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
  // Esc cierra el drawer, salvo que haya un modal/paleta abierto por encima.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
    refetchInterval: 4000,
  });

  useEffect(() => {
    if (!detail.data || pestanaFijada.current === serviceId) return;
    pestanaFijada.current = serviceId;
    if (detail.data.dbConsole) setTab('db');
  }, [serviceId, detail.data]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['service', serviceId] });
    queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    queryClient.invalidateQueries({ queryKey: ['deployments', serviceId] });
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
      toast(force ? 'Reconstruyendo desde cero…' : 'Despliegue iniciado', 'ok');
      setPendingRedeploy(false);
      setTab('deployments');
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
    'flex flex-col bg-surface',
    fullscreen
      ? // Móvil: entra y sale como una página apilada (push de navegación).
        cx('fixed inset-0 z-40', closing ? 'push-out' : 'push-in')
      : cx(
          'min-h-0 shrink-0 overflow-hidden border-l border-line shadow-drawer transition-[width,opacity] duration-[220ms] ease-[cubic-bezier(.25,.8,.3,1)]',
          closing ? 'opacity-0' : 'drawer-in',
        ),
  );
  // La anchura anima de 0 al objetivo al entrar y de vuelta a 0 al salir: el canvas hace sitio en el mismo gesto.
  const targetWidth = wide ? 'min(840px, calc(100vw - 64px))' : 'min(600px, calc(100vw - 64px))';
  const asideStyle = fullscreen ? undefined : { width: entered && !closing ? targetWidth : 0 };

  if (!detail.data) {
    return (
      <aside className={asideCls} style={asideStyle} aria-busy>
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
  const state = latestMetrics?.services[serviceId]?.state ?? runtime.state;
  const replicas = latestMetrics?.services[serviceId]?.replicas;
  const isRunning = state === 'running' || state === 'restarting';
  const hasBackups = service.type === 'database' && BACKUP_TEMPLATES.includes(service.config.template);
  const hasDbConsole = !!detail.data.dbConsole;
  const tabs = [
    { key: 'deployments', label: 'Despliegues' },
    ...(hasDbConsole ? [{ key: 'db', label: 'Consultas' }] : []),
    { key: 'variables', label: 'Variables' },
    ...(hasBackups ? [{ key: 'backups', label: 'Backups' }] : []),
    { key: 'files', label: 'Archivos' },
    { key: 'metrics', label: 'Métricas' },
    { key: 'logs', label: 'Logs' },
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
    <aside className={asideCls} style={asideStyle} role="complementary" aria-label={`Servicio ${service.name}`}>
      {fullscreen && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
          <button
            onClick={onClose}
            className="press flex min-h-10 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-sub hover:bg-surface2 hover:text-txt"
          >
            <ChevronLeft size={15} /> {projectName}
          </button>
          <button
            onClick={onClose}
            className="press ml-auto flex min-h-10 min-w-10 items-center justify-center rounded-lg leading-none text-subtle hover:bg-surface2 hover:text-txt"
            title="Cerrar (esc)"
          >
            <X size={17} />
          </button>
        </div>
      )}

      <div className={cx('shrink-0', fullscreen ? 'px-3.5 pt-4' : 'px-5 pt-[18px]')}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <ModuleChip kind={moduleKind(service)} size={fullscreen ? 40 : 38} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-base font-[650] tracking-[-.01em]">{service.name}</h2>
                <StatusBadge
                  tone={STATE_TONE[state]}
                  label={STATE_LABEL[state]}
                  pulse={STATE_PULSE[state]}
                  replicas={replicas}
                  className="px-[9px] py-0.5"
                />
                {activeDeployment && (
                  <span className="badge-in inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap rounded-full border border-warn/35 bg-warn/[.1] px-[9px] py-0.5 text-[11px] font-medium text-warn">
                    <span className="pulse-soft h-[5px] w-[5px] rounded-full bg-warn" />
                    {DEPLOY_STATUS_LABEL[activeDeployment.status]}
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate font-mono text-[11px] text-subtle">{subtitle}</p>
            </div>
          </div>
          {!fullscreen && (
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                onClick={() => setWide(!wide)}
                className="press rounded-lg p-[7px] leading-none text-subtle hover:bg-surface2 hover:text-txt"
                title="Cambiar ancho del panel"
              >
                <MoveHorizontal size={15} />
              </button>
              <button
                onClick={onClose}
                className="press rounded-lg p-[7px] leading-none text-subtle hover:bg-surface2 hover:text-txt"
                title="Cerrar (esc)"
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
              >
                <RefreshCw size={fullscreen ? 16 : 13} /> {!fullscreen && 'Reiniciar'}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className={cx(fullscreen && 'h-11 min-w-11 px-0')}
                onClick={() => setConfirmVerb('stop')}
                loading={action.isPending && confirmVerb === 'stop'}
                title="Detener"
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
          {domain && !fullscreen && (
            <a
              href={`http://${domain}`}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex min-w-0 max-w-[190px] items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-sub transition-colors duration-150 hover:bg-surface2 hover:text-txt"
            >
              <ExternalLink size={12} className="shrink-0" />
              <span className="truncate">{domain}</span>
            </a>
          )}
        </div>

        {pendingRedeploy && (
          <div className="tab-in mt-3.5 flex flex-col gap-2 rounded-lg border border-acc/30 bg-acc/[.08] px-3 py-2.5 text-xs sm:flex-row sm:items-center sm:gap-2.5 sm:py-2">
            <span className="flex min-w-0 flex-1 items-start gap-2.5 sm:items-center">
              <Rocket size={14} className="mt-px shrink-0 text-acc-soft sm:mt-0" />
              <span className="text-sub">
                <span className="font-medium text-txt">Cambios guardados sin aplicar.</span> Se activan al desplegar de nuevo.
              </span>
            </span>
            <Button
              size="sm"
              variant="secondary"
              className="w-full shrink-0 sm:w-auto"
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
          onChange={setTab}
          className={cx('mt-3.5', fullscreen ? '-mx-3.5 px-3.5' : '-mx-5 px-5')}
        />
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain" role="tabpanel">
        {/* h-full (no min-h-full): da altura DEFINIDA a la pestaña de Logs, cuyo visor
            usa flex-1 para llenar y scrollear por dentro; con min-height no resolvía y
            el log crecía sin fin. Las pestañas de documento (despliegues, métricas…)
            desbordan hacia el scroll del cuerpo igual que antes (sus hijos no llevan min-h-0). */}
        <div key={tab} className="tab-in flex h-full flex-col">
          {/* La pestaña activa (salvo Despliegues) se carga bajo demanda; Suspense
              solo muestra el spinner la 1ª vez que se abre una pestaña diferida. */}
          <Suspense fallback={<div className="flex flex-1 items-center justify-center p-8"><Spinner /></div>}>
            {tab === 'deployments' && (
              <DeploymentsTab
                serviceId={serviceId}
                serviceType={service.type}
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
                onSaved={invalidate}
                onDeploy={() => deploy.mutate(undefined)}
                onNeedsRedeploy={() => setPendingRedeploy(true)}
              />
            )}
            {tab === 'backups' && <BackupsTab serviceId={serviceId} service={service} onChanged={invalidate} />}
            {tab === 'files' && <FilesTab serviceId={serviceId} />}
            {tab === 'metrics' && <MetricsTab serviceId={serviceId} service={service} latest={latestMetrics} historyRef={historyRef} />}
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
        title={`Reiniciar "${service.name}"`}
        message="El servicio quedará unos segundos sin responder mientras vuelve a arrancar."
        confirmLabel="Reiniciar"
        confirmVariant="primary"
      />
      <ConfirmModal
        open={confirmVerb === 'stop'}
        onClose={() => setConfirmVerb(null)}
        onConfirm={() => action.mutate('stop')}
        loading={action.isPending}
        title={`Detener "${service.name}"`}
        message="El servicio dejará de estar disponible hasta que lo vuelvas a iniciar."
        confirmLabel="Detener"
        confirmVariant="danger"
      />
    </aside>
  );
}
