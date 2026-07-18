import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Building2, ChevronRight, FileText, KeyRound, Pencil, Plus, Trash2, X } from 'lucide-react';
import { api, openStream } from '../api';
import { Button, ConfirmModal, Field, Modal, Spinner, useToast } from '../components/ui';
import NewServiceModal from '../components/NewServiceModal';
import { ImportReport, ImportReportView } from '../components/RailwayImportModal';
import ServiceCard from '../components/ServiceCard';
import ServiceDrawer from '../components/ServiceDrawer';
import SharedVarsModal from '../components/SharedVarsModal';
import { MetricsSnapshot, Project, Service } from '../types';

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

  if (project.isLoading) return <Spinner label="Cargando proyecto..." />;
  if (project.isError || !project.data) {
    return <div className="p-8 text-center text-sm text-sub">Proyecto no encontrado</div>;
  }

  const { project: proj, services, alertCounts } = project.data;
  const selected = services.find((s) => s.id === selectedId) ?? null;

  const openService = (id: string | null) => {
    if (id) setSearchParams({ s: id });
    else setSearchParams({});
  };

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-sm text-sub">
              <Link to="/" className="hover:text-txt">
                Proyectos
              </Link>
              <ChevronRight size={14} />
              <span className="text-txt">{proj.name}</span>
              {proj.client && (
                <span className="ml-1 flex items-center gap-1 rounded-full border border-line bg-panel2 px-2 py-0.5 text-[11px] text-sub">
                  <Building2 size={10} /> {proj.client}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-sub">
              Red privada: <span className="font-mono">skyway-{proj.slug}</span> — los servicios se ven entre sí por su nombre
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditName(proj.name);
                setEditClient(proj.client ?? '');
                setEditOpen(true);
              }}
              title="Renombrar / empresa"
            >
              <Pencil size={14} />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDeleteOpen(true)} title="Eliminar proyecto">
              <Trash2 size={14} />
            </Button>
            <Button variant="outline" onClick={() => setSharedOpen(true)} title="Variables compartidas del proyecto">
              <KeyRound size={14} /> Variables compartidas
            </Button>
            <Button onClick={() => setNewOpen(true)}>
              <Plus size={15} /> Nuevo servicio
            </Button>
          </div>
        </div>

        {importReport.data?.report && (
          <div className="mb-4 flex items-center justify-between rounded-xl border border-acc/40 bg-acc/10 px-4 py-2.5 text-sm">
            <span className="flex items-center gap-2 text-acc">
              <FileText size={15} />
              Proyecto importado de Railway: consulta el informe con los comandos de copia de datos y pasos pendientes.
            </span>
            <span className="flex items-center gap-1">
              <Button size="sm" variant="outline" onClick={() => setReportOpen(true)}>
                Ver informe
              </Button>
              <button
                onClick={() => dismissReport.mutate()}
                className="rounded-md p-1.5 text-sub hover:bg-panel2 hover:text-txt"
                title="Descartar informe"
              >
                <X size={14} />
              </button>
            </span>
          </div>
        )}

        {services.length === 0 ? (
          <div className="card flex flex-col items-center gap-3 py-20 text-center">
            <p className="text-sm text-sub">
              Este proyecto está vacío. Despliega un repositorio de GitHub o añade una base de datos.
            </p>
            <Button onClick={() => setNewOpen(true)}>
              <Plus size={15} /> Añadir servicio
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
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
      </div>

      {selected && (
        <ServiceDrawer
          key={selected.id}
          serviceId={selected.id}
          projectId={proj.id}
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
