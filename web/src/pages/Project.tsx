import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { FileText, KeyRound, Pencil, Plus, RefreshCw, Signal, Trash2, X } from 'lucide-react';
import { api, openStream } from '../api';
import { Button, ConfirmModal, CopyButton, Field, Modal, Skeleton, useToast } from '../components/ui';
import NewServiceModal from '../components/NewServiceModal';
import { ImportReport, ImportReportView } from '../components/RailwayImportModal';
import ServiceCard from '../components/ServiceCard';
import ServiceDrawer from '../components/ServiceDrawer';
import SharedVarsModal from '../components/SharedVarsModal';
import StatusPageModal from '../components/StatusPageModal';
import { Me, MetricsSnapshot, Project, Service } from '../types';

export interface MetricPoint {
  ts: number;
  cpu: number;
  mem: number;
  memLimit: number;
  rx: number;
  tx: number;
}

const HISTORY_LIMIT = 120;

/** Abre el stream SSE de métricas del proyecto y acumula histórico por servicio. */
function useProjectMetrics(projectId: string | undefined) {
  const [latest, setLatest] = useState<MetricsSnapshot | null>(null);
  const historyRef = useRef<Map<string, MetricPoint[]>>(new Map());

  useEffect(() => {
    if (!projectId) return;
    historyRef.current = new Map();
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
    es.onerror = () => {
      /* EventSource reintenta solo */
    };
    return () => es.close();
  }, [projectId]);

  return { latest, historyRef };
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
  const [newOpen, setNewOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteVolumes, setDeleteVolumes] = useState(false);
  const [sharedOpen, setSharedOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editClient, setEditClient] = useState('');
  const [reportOpen, setReportOpen] = useState(false);

  const selectedId = searchParams.get('s');

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () =>
      api.get<{ project: Project; services: Service[]; docker: boolean; alertCounts: Record<string, number> }>(
        `/projects/${projectId}`,
      ),
    refetchInterval: 4000,
    enabled: !!projectId,
  });

  const { latest, historyRef } = useProjectMetrics(projectId);

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
    mutationFn: () => api.patch(`/projects/${projectId}`, { name: editName, client: editClient }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setEditOpen(false);
      toast('Proyecto actualizado', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  if (project.isLoading) return <CanvasSkeleton />;
  if (project.isError || !project.data) {
    return <div className="p-8 text-center text-sm text-sub">Proyecto no encontrado</div>;
  }

  const { project: proj, services, alertCounts } = project.data;
  const selected = services.find((s) => s.id === selectedId) ?? null;

  const openService = (id: string | null) => {
    if (id) setSearchParams({ s: id });
    else setSearchParams({});
  };

  const hasDeployables = services.some((s) => s.type !== 'database');

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-7 sm:py-7">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-[-.015em]">{proj.name}</h1>
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-sub">
              Red privada{' '}
              <span className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-px font-mono text-[11px] text-txt">
                skyway-{proj.slug}
              </span>
              <CopyButton value={`skyway-${proj.slug}`} className="-ml-0.5 p-0.5" title="Copiar nombre de la red" />
              <span className="hidden sm:inline">— los servicios se resuelven entre sí por nombre</span>
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            {isAdmin && (
              <>
                <button
                  onClick={() => {
                    setEditName(proj.name);
                    setEditClient(proj.client ?? '');
                    setEditOpen(true);
                  }}
                  className="rounded-lg p-2 leading-none text-sub transition-colors duration-150 hover:bg-surface2 hover:text-txt"
                  title="Renombrar / empresa"
                >
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => setDeleteOpen(true)}
                  className="rounded-lg p-2 leading-none text-sub transition-colors duration-150 hover:bg-surface2 hover:text-err"
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

        {services.length === 0 ? (
          <div className="card flex flex-col items-center gap-4 py-20 text-center">
            <svg width="120" height="72" viewBox="0 0 120 72" fill="none" aria-hidden className="text-line">
              <rect x="8" y="14" width="46" height="34" rx="8" stroke="currentColor" strokeWidth="2" />
              <rect x="66" y="24" width="46" height="34" rx="8" stroke="currentColor" strokeWidth="2" strokeDasharray="5 5" />
              <path d="M54 31h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <circle cx="21" cy="27" r="3" fill="#6e56cf" />
              <path d="M30 27h16M17 37h28" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <p className="max-w-sm text-sm text-sub">
              Este proyecto está vacío. Despliega un repositorio de GitHub o añade una base de datos.
            </p>
            <Button onClick={() => setNewOpen(true)}>
              <Plus size={15} /> Añadir servicio
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3.5">
            {services.map((s) => (
              <ServiceCard
                key={s.id}
                service={s}
                metrics={latest?.services[s.id] ?? null}
                alertCount={alertCounts?.[s.id] ?? 0}
                selected={s.id === selectedId}
                onClick={() => openService(s.id)}
              />
            ))}
          </div>
        )}

        {services.length > 0 && (
          <p className="mt-5 hidden text-[11px] text-subtle drawer:block">
            Pulsa <kbd className="kbd">esc</kbd> para cerrar el panel · <kbd className="kbd">⌘K</kbd> para buscar
          </p>
        )}
      </div>

      {selected && (
        <ServiceDrawer
          key={selected.id}
          serviceId={selected.id}
          projectId={proj.id}
          projectName={proj.name}
          latestMetrics={latest}
          historyRef={historyRef}
          onClose={() => openService(null)}
        />
      )}

      <NewServiceModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        projectId={proj.id}
        onCreated={(serviceId) => {
          setNewOpen(false);
          queryClient.invalidateQueries({ queryKey: ['project', projectId] });
          openService(serviceId);
        }}
      />

      <SharedVarsModal open={sharedOpen} onClose={() => setSharedOpen(false)} projectId={proj.id} />

      <StatusPageModal open={statusOpen} onClose={() => setStatusOpen(false)} projectId={proj.id} isAdmin={!!isAdmin} />

      {importReport.data?.report && (
        <Modal open={reportOpen} onClose={() => setReportOpen(false)} title="Informe de importación de Railway" wide>
          <ImportReportView report={importReport.data.report} />
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
          <Field label="Empresa / cliente" hint="Vacío = sin empresa. Agrupa proyectos en el panel principal.">
            <input className="input" value={editClient} onChange={(e) => setEditClient(e.target.value)} placeholder="Acme S.L." />
          </Field>
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
