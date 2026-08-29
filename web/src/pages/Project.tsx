import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BellRing, Database, FileText, KeyRound, Layers, Pencil, Plus, RefreshCw, Search, Signal, Trash2, X } from 'lucide-react';
import { ApiError, api, openStream } from '../api';
import { useLatch, usePresence } from '../hooks';
import { Button, Chip, ConfirmModal, CopyButton, EmptyState, ErrorState, Field, Modal, Skeleton, useToast } from '../components/ui';
import { ModuleLogo } from '../components/ModuleIcon';
import ServiceCard from '../components/ServiceCard';
import type { ImportReport } from '../components/RailwayImportModal';
import { useGithubReturnNotice } from '../components/useGithubReturn';
import { ActiveDeploy, Me, MetricsSnapshot, Project, Service } from '../types';
import { CMD_K_LABEL, cx, isActiveDeploy } from '../utils';

// Carga diferida: el drawer del servicio (con sus 8 pestañas y modales) y los
// modales de cabecera solo se descargan al abrirlos, no al entrar al proyecto.
const ServiceDrawer = lazy(() => import('../components/ServiceDrawer'));
const NewServiceModal = lazy(() => import('../components/NewServiceModal'));
const SharedVarsModal = lazy(() => import('../components/SharedVarsModal'));
const GithubModal = lazy(() => import('../components/GithubModal'));
const StatusPageModal = lazy(() => import('../components/StatusPageModal'));
const ImportReportView = lazy(() => import('../components/RailwayImportModal').then((m) => ({ default: m.ImportReportView })));

export interface MetricPoint {
  ts: number;
  cpu: number;
  mem: number;
  memLimit: number;
  rx: number;
  tx: number;
}

const HISTORY_LIMIT = 120;

/**
 * Stream del proyecto: métricas en vivo e historial por servicio, y los avisos
 * de despliegue.
 *
 * Las dos cosas viajan por la MISMA conexión a propósito. El navegador solo
 * abre seis conexiones por host en HTTP/1.1 —un túnel SSH, por ejemplo— y esta
 * página ya gasta una en los logs del despliegue abierto y otra en los del
 * contenedor: separar métricas y despliegues dejaba el panel a un paso de
 * quedarse sin hueco para las peticiones normales.
 */
function useProjectStream(projectId: string | undefined, onDeploySettled: () => void) {
  const [latest, setLatest] = useState<MetricsSnapshot | null>(null);
  const [deploys, setDeploys] = useState<Record<string, ActiveDeploy>>({});
  const [live, setLive] = useState(false);
  const historyRef = useRef<Map<string, MetricPoint[]>>(new Map());
  // El callback cambia de identidad en cada render; la ref evita reabrir el SSE.
  const settledRef = useRef(onDeploySettled);
  settledRef.current = onDeploySettled;

  useEffect(() => {
    if (!projectId) return;
    historyRef.current = new Map();
    setDeploys({});
    setLive(false);

    const es = openStream(`/projects/${projectId}/metrics/stream`);

    es.addEventListener('metrics', (ev) => {
      const snap: MetricsSnapshot = JSON.parse((ev as MessageEvent).data);
      setLatest(snap);
      for (const [serviceId, entry] of Object.entries(snap.services)) {
        if (!entry.stats) continue;
        const arr = historyRef.current.get(serviceId) ?? [];
        arr.push({
          ts: snap.ts,
          cpu: entry.stats.cpuPercent,
          mem: entry.stats.memUsage,
          memLimit: entry.stats.memLimit,
          rx: entry.stats.netRx,
          tx: entry.stats.netTx,
        });
        if (arr.length > HISTORY_LIMIT) arr.shift();
        historyRef.current.set(serviceId, arr);
      }
    });

    // Estado inicial de los despliegues vivos, al conectar.
    es.addEventListener('deploys', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { deploys: ActiveDeploy[] };
      setDeploys(Object.fromEntries(data.deploys.map((d) => [d.serviceId, d])));
      setLive(true);
    });

    // Cambios de fase, en el instante en que ocurren (no esperan al temporizador).
    es.addEventListener('deploy', (ev) => {
      const item = JSON.parse((ev as MessageEvent).data) as ActiveDeploy;
      const running = isActiveDeploy(item.status);
      setDeploys((prev) => {
        const next = { ...prev };
        if (running) next[item.serviceId] = item;
        else delete next[item.serviceId];
        return next;
      });
      // Al terminar cambian el contenedor y sus métricas: se refresca el proyecto.
      if (!running) settledRef.current();
    });

    es.onerror = () => {
      /* EventSource reintenta solo */
    };
    return () => es.close();
  }, [projectId]);

  return { latest, historyRef, deploys, live };
}

function CanvasSkeleton() {
  return (
    <div aria-busy className="flex-1 px-4 py-6 sm:px-7">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <Skeleton className="h-6 w-44" />
          <Skeleton className="mt-2.5 h-3.5 w-72" />
        </div>
        <div className="hidden gap-2 sm:flex">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-36" />
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card p-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2.5">
                <Skeleton className="h-9 w-9 rounded-[10px]" />
                <div>
                  <Skeleton className="h-3.5 w-24" />
                  <Skeleton className="mt-1.5 h-3 w-32" />
                </div>
              </div>
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <Skeleton className="mt-4 h-3 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  // Vuelta de github.com tras instalar la App en una cuenta.
  useGithubReturnNotice();
  const [newOpen, setNewOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteVolumes, setDeleteVolumes] = useState(false);
  const [sharedOpen, setSharedOpen] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editClient, setEditClient] = useState('');
  const [reportOpen, setReportOpen] = useState(false);

  const selectedId = searchParams.get('s');
  // Presencia del drawer: sigue montado durante su animación de despedida.
  const drawer = usePresence(!!selectedId, 240);
  const lastServiceRef = useRef<Service | null>(null);

  // Cerrojos de montaje: cada modal se descarga (React.lazy) en su 1ª apertura y,
  // una vez montado, permanece para conservar su animación de cierre.
  const newLatched = useLatch(newOpen);
  const sharedLatched = useLatch(sharedOpen);
  const githubLatched = useLatch(githubOpen);
  const statusLatched = useLatch(statusOpen);

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () =>
      api.get<{
        project: Project;
        services: Service[];
        docker: boolean;
        alertCounts: Record<string, number>;
        activeDeploys: Record<string, ActiveDeploy>;
      }>(`/projects/${projectId}`),
    refetchInterval: 4000,
    enabled: !!projectId,
  });

  const { latest, historyRef, deploys, live } = useProjectStream(projectId, () => {
    queryClient.invalidateQueries({ queryKey: ['project', projectId] });
  });

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), staleTime: 60_000 });
  const isAdmin = me.data?.user?.role === 'admin';

  const importReport = useQuery({
    queryKey: ['importReport', projectId],
    queryFn: () => api.get<{ report: ImportReport | null }>(`/projects/${projectId}/import-report`),
    enabled: !!projectId,
    staleTime: 60_000,
  });

  const dismissReport = useMutation({
    mutationFn: () => api.del(`/projects/${projectId}/import-report`),
    onSuccess: () => {
      setReportOpen(false);
      queryClient.invalidateQueries({ queryKey: ['importReport', projectId] });
    },
  });

  const removeProject = useMutation({
    mutationFn: () => api.del(`/projects/${projectId}?volumes=${deleteVolumes}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast('Proyecto eliminado', 'ok');
      navigate('/');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const deployAll = useMutation({
    mutationFn: () => api.post<{ count: number }>(`/projects/${projectId}/deploy-all`),
    onSuccess: (res) => {
      toast(`Desplegando ${res.count} servicio(s)...`, 'ok');
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const updateProject = useMutation({
    // Solo el admin reasigna de empresa/workspace; el propietario únicamente renombra.
    mutationFn: () => api.patch(`/projects/${projectId}`, { name: editName, ...(isAdmin ? { client: editClient } : {}) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setEditOpen(false);
      toast('Proyecto actualizado', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const [serviceQuery, setServiceQuery] = useState('');
  const [serviceTypeFilter, setServiceTypeFilter] = useState<'all' | 'git' | 'database' | 'image' | 'alerts'>('all');

  const services = project.data?.services ?? [];
  const alertCounts = project.data?.alertCounts ?? {};
  const activeDeploys = live ? deploys : project.data?.activeDeploys ?? {};

  const filteredServices = useMemo(() => {
    return services.filter((s) => {
      if (serviceTypeFilter === 'git' && s.type !== 'git') return false;
      if (serviceTypeFilter === 'database' && s.type !== 'database') return false;
      if (serviceTypeFilter === 'image' && s.type !== 'image') return false;
      if (serviceTypeFilter === 'alerts' && !(alertCounts?.[s.id] > 0)) return false;

      if (serviceQuery.trim()) {
        const q = serviceQuery.toLowerCase().trim();
        const matchName = s.name.toLowerCase().includes(q);
        const matchSlug = s.slug.toLowerCase().includes(q);
        const matchRepo = s.type === 'git' && (s.config?.repoUrl ?? '').toLowerCase().includes(q);
        const matchImage = s.type === 'image' && (s.config?.image ?? '').toLowerCase().includes(q);
        const matchTemplate = s.type === 'database' && (s.config?.template ?? '').toLowerCase().includes(q);
        if (!matchName && !matchSlug && !matchRepo && !matchImage && !matchTemplate) return false;
      }
      return true;
    });
  }, [services, serviceTypeFilter, serviceQuery, alertCounts]);

  if (project.isLoading) return <CanvasSkeleton />;
  if (project.isError || !project.data) {
    // Un 404 sí es «no existe»; cualquier otro fallo es de conexión, y decir
    // «no encontrado» hace pensar que el proyecto se ha perdido.
    if (project.error instanceof ApiError && project.error.status === 404) {
      return (
        <EmptyState
          title="Proyecto no encontrado"
          description="Puede que se haya eliminado o que el enlace ya no sea válido."
          action={
            <Link to="/" className="text-sm font-medium text-acc-soft hover:underline">
              Volver a proyectos
            </Link>
          }
        />
      );
    }
    return (
      <ErrorState
        title="No se ha podido cargar el proyecto"
        error={project.error}
        onRetry={() => project.refetch()}
        retrying={project.isFetching}
      />
    );
  }

  const { project: proj } = project.data;
  // Gestión de estructura (renombrar/eliminar): admin o propietario del workspace del proyecto.
  const isManager =
    isAdmin ||
    (me.data?.user?.role === 'owner' && !!me.data?.user?.workspaceId && proj.workspace_id === me.data?.user?.workspaceId);
  const selected = services.find((s) => s.id === selectedId) ?? null;
  if (selected) lastServiceRef.current = selected;
  // Durante la salida el drawer pinta el último servicio visto.
  const drawerService = selected ?? lastServiceRef.current;

  const openService = (id: string | null) => {
    if (id) setSearchParams({ s: id });
    else setSearchParams({});
  };

  const hasDeployables = services.some((s) => s.type !== 'database');

  // Conteo de métricas agregadas del proyecto
  const totalServices = services.length;
  const runningCount = services.filter((s) => (latest?.services[s.id]?.state ?? s.runtime?.state) === 'running').length;
  const alertServicesCount = services.filter((s) => (alertCounts?.[s.id] ?? 0) > 0).length;
  const deployServicesCount = Object.keys(activeDeploys).length;
  const gitCount = services.filter((s) => s.type === 'git').length;
  const dbCount = services.filter((s) => s.type === 'database').length;
  const imageCount = services.filter((s) => s.type === 'image').length;

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-7 sm:py-7">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">{proj.name}</h1>
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-sub">
              Red privada{' '}
              <span className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-px font-mono text-xs text-txt">
                skyway-{proj.slug}
              </span>
              <CopyButton value={`skyway-${proj.slug}`} className="-ml-0.5 p-0.5" title="Copiar nombre de la red" />
              <span className="hidden sm:inline">— los servicios se resuelven entre sí por nombre</span>
            </p>

            {/* Resumen de salud de infraestructura en tiempo real */}
            {totalServices > 0 && (
              <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs">
                <Chip tone={runningCount > 0 ? 'ok' : 'neutral'} dot>
                  <span className="tnum font-semibold">{runningCount}</span>/{totalServices} activos
                </Chip>
                {deployServicesCount > 0 && (
                  <Chip tone="warn" dot pulse>
                    <span className="tnum font-semibold">{deployServicesCount}</span> desplegando
                  </Chip>
                )}
                {alertServicesCount > 0 && (
                  <Chip tone="err" icon={<BellRing size={11} aria-hidden />}>
                    <span className="tnum font-semibold">{alertServicesCount}</span> con alertas
                  </Chip>
                )}
              </div>
            )}
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            {isManager && (
              <>
                <button
                  onClick={() => {
                    setEditName(proj.name);
                    setEditClient(proj.client ?? '');
                    setEditOpen(true);
                  }}
                  className="press rounded-lg p-2 leading-none text-sub hover:bg-surface2 hover:text-txt"
                  title={isAdmin ? 'Renombrar / empresa' : 'Renombrar'}
                >
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => setDeleteOpen(true)}
                  className="press rounded-lg p-2 leading-none text-sub hover:bg-surface2 hover:text-err"
                  title="Eliminar proyecto"
                >
                  <Trash2 size={14} />
                </button>
              </>
            )}
            <Button
              variant="secondary"
              size="sm"
              className="max-sm:h-11 max-sm:min-w-11"
              onClick={() => setStatusOpen(true)}
              title="Página de estado pública para el cliente"
            >
              <Signal size={13} /> <span className="hidden sm:inline">Página de estado</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="max-sm:h-11 max-sm:min-w-11"
              onClick={() => setGithubOpen(true)}
              title="Cuentas de GitHub cuyos repositorios se pueden desplegar aquí"
            >
              <ModuleLogo kind="github" size={13} /> <span className="hidden sm:inline">GitHub</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="max-sm:h-11 max-sm:min-w-11"
              onClick={() => setSharedOpen(true)}
              title="Variables compartidas del proyecto"
            >
              <KeyRound size={13} /> <span className="hidden sm:inline">Variables compartidas</span>
            </Button>
            {hasDeployables && (
              <Button
                variant="secondary"
                size="sm"
                className="max-sm:h-11 max-sm:min-w-11"
                onClick={() => deployAll.mutate()}
                loading={deployAll.isPending}
                title="Redespliega todos los servicios de repo e imagen"
              >
                <RefreshCw size={13} /> <span className="hidden sm:inline">Desplegar todo</span>
              </Button>
            )}
            <Button size="sm" className="max-sm:h-11 max-sm:flex-1" onClick={() => setNewOpen(true)}>
              <Plus size={14} /> Nuevo servicio
            </Button>
          </div>
        </div>

        {importReport.data?.report && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-acc/40 bg-acc/10 px-4 py-2.5 text-sm">
            <span className="flex items-center gap-2 text-acc-soft">
              <FileText size={15} className="shrink-0" />
              Proyecto importado de Railway: consulta el informe con los comandos de copia de datos y pasos pendientes.
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <Button size="sm" variant="secondary" onClick={() => setReportOpen(true)}>
                Ver informe
              </Button>
              <button
                onClick={() => dismissReport.mutate()}
                className="rounded-md p-1.5 text-sub hover:bg-surface2 hover:text-txt"
                title="Descartar informe"
              >
                <X size={14} />
              </button>
            </span>
          </div>
        )}

        {/* Barra de búsqueda y filtros de servicios */}
        {services.length > 2 && (
          <div className="mb-4 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-[200px] max-w-sm flex-1 items-center gap-2 rounded-xl border border-line/80 bg-surface px-3 py-1.5 shadow-sm focus-within:border-acc">
              <Search size={13} className="shrink-0 text-subtle" />
              <input
                value={serviceQuery}
                onChange={(e) => setServiceQuery(e.target.value)}
                placeholder="Buscar servicio por nombre, repo o imagen…"
                className="min-w-0 flex-1 bg-transparent text-xs text-txt outline-none placeholder:text-subtle"
              />
              {serviceQuery && (
                <button
                  type="button"
                  onClick={() => setServiceQuery('')}
                  className="text-subtle hover:text-txt"
                  title="Borrar búsqueda"
                >
                  <X size={12} />
                </button>
              )}
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => setServiceTypeFilter('all')}
                className={cx(
                  'rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
                  serviceTypeFilter === 'all'
                    ? 'border border-line bg-surface2 font-semibold text-txt shadow-sm'
                    : 'text-sub hover:bg-surface hover:text-txt',
                )}
              >
                Todos ({totalServices})
              </button>
              {gitCount > 0 && (
                <button
                  type="button"
                  onClick={() => setServiceTypeFilter('git')}
                  className={cx(
                    'flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
                    serviceTypeFilter === 'git'
                      ? 'border border-line bg-surface2 font-semibold text-txt shadow-sm'
                      : 'text-sub hover:bg-surface hover:text-txt',
                  )}
                >
                  <ModuleLogo kind="github" size={12} />
                  <span>Git ({gitCount})</span>
                </button>
              )}
              {dbCount > 0 && (
                <button
                  type="button"
                  onClick={() => setServiceTypeFilter('database')}
                  className={cx(
                    'flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
                    serviceTypeFilter === 'database'
                      ? 'border border-line bg-surface2 font-semibold text-txt shadow-sm'
                      : 'text-sub hover:bg-surface hover:text-txt',
                  )}
                >
                  <Database size={12} className="text-acc" />
                  <span>Bases de datos ({dbCount})</span>
                </button>
              )}
              {imageCount > 0 && (
                <button
                  type="button"
                  onClick={() => setServiceTypeFilter('image')}
                  className={cx(
                    'flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
                    serviceTypeFilter === 'image'
                      ? 'border border-line bg-surface2 font-semibold text-txt shadow-sm'
                      : 'text-sub hover:bg-surface hover:text-txt',
                  )}
                >
                  <Layers size={12} className="text-info" />
                  <span>Docker / Apps ({imageCount})</span>
                </button>
              )}
              {alertServicesCount > 0 && (
                <button
                  type="button"
                  onClick={() => setServiceTypeFilter('alerts')}
                  className={cx(
                    'flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
                    serviceTypeFilter === 'alerts'
                      ? 'border border-err/30 bg-err/15 font-semibold text-err shadow-sm'
                      : 'text-err/80 hover:bg-err/10 hover:text-err',
                  )}
                >
                  <BellRing size={11} />
                  <span>Alertas ({alertServicesCount})</span>
                </button>
              )}
            </div>
          </div>
        )}

        {services.length === 0 ? (
          <div className="card flex flex-col items-center gap-4 py-20 text-center">
            <svg width="120" height="72" viewBox="0 0 120 72" fill="none" aria-hidden className="text-line">
              <rect x="8" y="14" width="46" height="34" rx="8" stroke="currentColor" strokeWidth="2" />
              <rect x="66" y="24" width="46" height="34" rx="8" stroke="currentColor" strokeWidth="2" strokeDasharray="5 5" />
              <path d="M54 31h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <circle cx="21" cy="27" r="3" fill="var(--color-acc)" />
              <path d="M30 27h16M17 37h28" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <p className="max-w-sm text-sm text-sub">
              Este proyecto está vacío. Despliega un repositorio de GitHub, una aplicación completa
              (Supabase, WordPress…) o una base de datos.
            </p>
            <Button onClick={() => setNewOpen(true)}>
              <Plus size={15} /> Añadir servicio
            </Button>
          </div>
        ) : filteredServices.length === 0 ? (
          <div className="card flex flex-col items-center gap-3 py-16 text-center">
            <Search size={22} className="text-subtle" />
            <p className="text-sm font-medium text-txt">No se encontraron servicios</p>
            <p className="max-w-xs text-xs text-subtle">
              No hay servicios que coincidan con los filtros de búsqueda aplicados.
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setServiceQuery('');
                setServiceTypeFilter('all');
              }}
            >
              Limpiar búsqueda
            </Button>
          </div>
        ) : (
          <div className="stagger grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3.5">
            {filteredServices.map((s) => (
              <ServiceCard
                key={s.id}
                service={s}
                metrics={latest?.services[s.id] ?? null}
                alertCount={alertCounts?.[s.id] ?? 0}
                deploy={activeDeploys[s.id] ?? null}
                selected={s.id === selectedId}
                onClick={() => openService(s.id)}
              />
            ))}
          </div>
        )}

        {services.length > 0 && (
          <p className="mt-5 hidden text-xs text-subtle drawer:block">
            {selected ? (
              <>
                Pulsa <kbd className="kbd">esc</kbd> para cerrar el panel · <kbd className="kbd">{CMD_K_LABEL}</kbd> para buscar
              </>
            ) : (
              <>
                Abre un servicio para desplegar, ver logs y editar variables · <kbd className="kbd">{CMD_K_LABEL}</kbd> para buscar
              </>
            )}
          </p>
        )}
      </div>

      {drawer.mounted && drawerService && (
        <Suspense fallback={null}>
          <ServiceDrawer
            key={drawerService.id}
            serviceId={drawerService.id}
            projectId={proj.id}
            projectName={proj.name}
            latestMetrics={latest}
            historyRef={historyRef}
            closing={drawer.closing}
            onClose={() => openService(null)}
          />
        </Suspense>
      )}

      {newLatched && (
        <Suspense fallback={null}>
          <NewServiceModal
            open={newOpen}
            onClose={() => setNewOpen(false)}
            projectId={proj.id}
            onCreated={(serviceId) => {
              setNewOpen(false);
              queryClient.invalidateQueries({ queryKey: ['project', projectId] });
              openService(serviceId);
            }}
            onStackCreated={() => {
              // Una pila son varios servicios: se muestra la rejilla entera en
              // vez de abrir el panel de uno solo.
              setNewOpen(false);
              queryClient.invalidateQueries({ queryKey: ['project', projectId] });
            }}
          />
        </Suspense>
      )}

      {sharedLatched && (
        <Suspense fallback={null}>
          <SharedVarsModal open={sharedOpen} onClose={() => setSharedOpen(false)} projectId={proj.id} />
        </Suspense>
      )}

      {githubLatched && (
        <Suspense fallback={null}>
          <GithubModal open={githubOpen} onClose={() => setGithubOpen(false)} projectId={proj.id} />
        </Suspense>
      )}

      {statusLatched && (
        <Suspense fallback={null}>
          <StatusPageModal open={statusOpen} onClose={() => setStatusOpen(false)} projectId={proj.id} isAdmin={!!isAdmin} />
        </Suspense>
      )}

      {importReport.data?.report && (
        <Modal open={reportOpen} onClose={() => setReportOpen(false)} title="Informe de importación de Railway" wide>
          <Suspense fallback={<Skeleton className="h-40 w-full" />}>
            <ImportReportView report={importReport.data.report} />
          </Suspense>
          <div className="mt-4 flex justify-end">
            <Button variant="ghost" onClick={() => dismissReport.mutate()} loading={dismissReport.isPending}>
              Descartar informe
            </Button>
          </div>
        </Modal>
      )}

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Editar proyecto">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            updateProject.mutate();
          }}
        >
          <Field label="Nombre">
            <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} required />
          </Field>
          {isAdmin && (
            <Field label="Empresa / cliente" hint="Vacío = sin empresa. Reasigna el proyecto a la cuenta de ese cliente.">
              <input className="input" value={editClient} onChange={(e) => setEditClient(e.target.value)} placeholder="Acme S.L." />
            </Field>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={() => setEditOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={updateProject.isPending}>
              Guardar
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmModal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => removeProject.mutate()}
        loading={removeProject.isPending}
        title={`Eliminar "${proj.name}"`}
        message="Se detendrán y eliminarán todos los contenedores del proyecto. Esta acción no se puede deshacer."
      >
        <label className="mt-3 flex items-center gap-2 text-sm text-sub">
          <input
            type="checkbox"
            checked={deleteVolumes}
            onChange={(e) => setDeleteVolumes(e.target.checked)}
            className="accent-acc"
          />
          Eliminar también los volúmenes (datos de las bases de datos)
        </label>
      </ConfirmModal>
    </div>
  );
}
