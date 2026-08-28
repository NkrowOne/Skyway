import { lazy, Suspense, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BellRing, Boxes, Building2, ChevronRight, FolderKanban, Plus, Search, TrainFront, X, Zap } from 'lucide-react';
import { api } from '../api';
import { useLatch } from '../hooks';
import { Button, Chip, Field, Modal, PageHeader, Skeleton, useToast } from '../components/ui';
import { DeploySweep } from '../components/DeployBadge';
import { ModuleBadge, ModuleLogo, moduleKind } from '../components/ModuleIcon';

// El asistente de importación de Railway solo se abre desde un botón: se carga
// (React.lazy) en su 1ª apertura, no al entrar al panel.
const RailwayImportModal = lazy(() => import('../components/RailwayImportModal'));
import { Me, Project, ProjectServiceSummary } from '../types';
import { cx, timeAgo } from '../utils';

/**
 * Monograma del proyecto: dos iniciales en monoespaciada sobre superficie
 * neutra. Antes cada proyecto recibía uno de siete degradados de color con
 * resplandor propio; identificaba menos de lo que decoraba, y el color de la
 * interfaz está reservado para decir en qué estado está algo.
 */
function Monogram({ name }: { name: string }) {
  const words = name.trim().split(/[\s\-_]+/).filter(Boolean);
  const initials = (words.length >= 2 ? words[0][0] + words[1][0] : name.trim().slice(0, 2)).toUpperCase();
  return (
    <span className="flex h-9 w-9 shrink-0 select-none items-center justify-center rounded-lg border border-line bg-surface2 font-mono text-xs font-semibold tracking-[.06em] text-sub">
      {initials}
    </span>
  );
}

/**
 * Mini-resumen visual con los logos y nombres de los servicios del proyecto
 */
function ServiceStack({ services }: { services?: ProjectServiceSummary[] }) {
  if (!services || services.length === 0) {
    return (
      <p className="mt-3 text-xs text-subtle">Sin servicios todavía</p>
    );
  }

  const maxVisible = 4;
  const visible = services.slice(0, maxVisible);
  const remaining = services.length - maxVisible;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {visible.map((s) => {
        const kind = moduleKind(s);
        return <ModuleBadge key={s.id} kind={kind} name={s.name} />;
      })}
      {remaining > 0 && (
        <Chip size="sm" title={`${remaining} servicio${remaining > 1 ? 's' : ''} más`}>
          +{remaining}
        </Chip>
      )}
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const alerts = project.openAlerts ?? 0;
  const deploying = project.activeDeploys ?? 0;
  return (
    <Link
      to={`/projects/${project.id}`}
      className="group card card-hover relative flex flex-col justify-between p-4"
    >
      {/* La misma cinta que la tarjeta del servicio: el aviso de «hay una versión saliendo» */}
      {deploying > 0 && <DeploySweep />}
      <div>
        <div className="flex items-start justify-between gap-2">
          <Monogram name={project.name} />
          <div className="flex items-center gap-2 text-xs">
            {deploying > 0 && (
              <Chip tone="warn" dot pulse>
                {deploying === 1 ? 'desplegando' : `${deploying} desplegando`}
              </Chip>
            )}
            {alerts > 0 && (
              <Chip tone="err" icon={<BellRing size={10} />} title={alerts === 1 ? '1 alerta abierta' : `${alerts} alertas abiertas`}>
                {alerts}
              </Chip>
            )}
            <span className="tnum font-mono text-xs text-subtle">
              {project.serviceCount === 1 ? '1 servicio' : `${project.serviceCount ?? 0} servicios`}
            </span>
          </div>
        </div>

        <h3 className="mt-3 truncate text-base font-semibold text-txt">{project.name}</h3>
        <p className="mt-0.5 truncate font-mono text-xs text-subtle">{project.slug}</p>

        {/* Mini resumen visual de la pila de servicios */}
        <ServiceStack services={project.services} />
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-xs text-subtle">
        <span className="truncate">
          {project.lastDeployAt ? `Último despliegue ${timeAgo(project.lastDeployAt)}` : 'Sin despliegues todavía'}
        </span>
        <ChevronRight size={14} className="shrink-0 transition-colors duration-[--dur-1] group-hover:text-txt" />
      </div>
    </Link>
  );
}

function DashboardSkeleton() {
  return (
    <div aria-busy className="space-y-4">
      <div className="flex items-center gap-3">
        <Skeleton className="h-4 w-32" />
        <div className="h-px flex-1 bg-line" />
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card p-5">
            <div className="flex items-start justify-between">
              <Skeleton className="h-9 w-9 rounded-[10px]" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
            <Skeleton className="mt-4 h-4 w-2/3" />
            <Skeleton className="mt-2 h-3 w-1/2" />
            <Skeleton className="mt-4 h-3 w-2/5" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const importLatched = useLatch(importOpen);
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  const [filter, setFilter] = useState<string | null>(null);
  const [projectQuery, setProjectQuery] = useState('');
  const queryClient = useQueryClient();
  const toast = useToast();

  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: Project[] }>('/projects'),
    // El panel general anuncia los despliegues en marcha: sin refresco, un
    // push que sale mientras estás aquí no se vería hasta cambiar de página.
    refetchInterval: 8000,
  });

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), staleTime: 60_000 });
  const isAdmin = me.data?.user?.role === 'admin';
  // El propietario también crea proyectos (en su workspace, asignado por el servidor).
  const isManager = isAdmin || me.data?.user?.role === 'owner';

  const create = useMutation({
    mutationFn: () => api.post<{ project: Project }>('/projects', { name, ...(client.trim() ? { client } : {}) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setCreateOpen(false);
      setName('');
      setClient('');
      toast('Proyecto creado', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const all = projects.data?.projects ?? [];
  const clients = useMemo(
    () => [...new Set(all.map((p) => p.client).filter((c): c is string => !!c))].sort(),
    [all],
  );

  const totalProjects = all.length;
  const totalServices = all.reduce((sum, p) => sum + (p.serviceCount ?? 0), 0);
  const totalDeploying = all.reduce((sum, p) => sum + (p.activeDeploys ?? 0), 0);
  const totalAlerts = all.reduce((sum, p) => sum + (p.openAlerts ?? 0), 0);

  const visible = useMemo(() => {
    let list = filter === null ? all : all.filter((p) => (filter === '' ? !p.client : p.client === filter));
    if (projectQuery.trim()) {
      const q = projectQuery.toLowerCase().trim();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.slug.toLowerCase().includes(q) ||
          (p.services ?? []).some((s) => s.name.toLowerCase().includes(q)),
      );
    }
    return list;
  }, [all, filter, projectQuery]);

  const grouped = useMemo(() => {
    const groups = new Map<string, Project[]>();
    for (const p of visible) {
      const key = p.client ?? '';
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    return [...groups.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  }, [visible]);

  return (
    <div className="mx-auto max-w-[1120px] px-4 py-7 sm:px-6 sm:py-10">
      <PageHeader
        className="mb-7"
        title="Proyectos"
        description="Cada proyecto agrupa servicios que comparten una red privada."
        actions={
          isManager && (
            <>
              {isAdmin && (
                <Button variant="secondary" onClick={() => setImportOpen(true)} title="Migra un proyecto desde Railway">
                  <TrainFront size={15} /> <span className="hidden sm:inline">Importar de Railway</span>
                  <span className="sm:hidden">Importar</span>
                </Button>
              )}
              <Button onClick={() => setCreateOpen(true)}>
                <Plus size={15} /> Nuevo proyecto
              </Button>
            </>
          )
        }
      />

      {totalProjects > 0 && (
        <div className="-mt-4 mb-6 flex flex-wrap items-center gap-1.5">
          <Chip icon={<FolderKanban size={11} />}>
            <span className="tnum font-semibold text-txt">{totalProjects}</span> proyectos
          </Chip>
          <Chip icon={<Boxes size={11} />}>
            <span className="tnum font-semibold text-txt">{totalServices}</span> servicios
          </Chip>
          {totalDeploying > 0 && (
            <Chip tone="warn" dot pulse>
              <span className="tnum">{totalDeploying}</span> desplegando
            </Chip>
          )}
          {totalAlerts > 0 && (
            <Chip tone="err" icon={<BellRing size={11} />}>
              <span className="tnum">{totalAlerts}</span> {totalAlerts === 1 ? 'alerta' : 'alertas'}
            </Chip>
          )}
        </div>
      )}

      {/* Buscador en tiempo real y filtros por cliente/empresa */}
      {all.length > 0 && (
        <div className="mb-7 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full max-w-sm">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle pointer-events-none" />
            <input
              type="text"
              value={projectQuery}
              onChange={(e) => setProjectQuery(e.target.value)}
              placeholder="Buscar proyecto o servicio..."
              className="input pl-9 pr-8"
            />
            {projectQuery && (
              <button
                onClick={() => setProjectQuery('')}
                className="press absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-subtle hover:text-txt"
                title="Limpiar búsqueda"
                aria-label="Limpiar búsqueda"
              >
                <X size={13} />
              </button>
            )}
          </div>

          {clients.length > 0 && (
            <div className="-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0">
              <Chip tone="info" active={filter === null} onClick={() => setFilter(null)}>
                Todas <span className="tnum opacity-70">{all.length}</span>
              </Chip>
              {clients.map((c) => {
                const count = all.filter((p) => p.client === c).length;
                return (
                  <Chip
                    key={c}
                    tone="info"
                    active={filter === c}
                    onClick={() => setFilter(filter === c ? null : c)}
                    icon={<Building2 size={11} />}
                  >
                    {c} <span className="tnum opacity-70">{count}</span>
                  </Chip>
                );
              })}
            </div>
          )}
        </div>
      )}

      {projects.isLoading && <DashboardSkeleton />}

      {projects.data && all.length === 0 && (
        <div className="card flex flex-col items-center gap-3 py-16 text-center">
          {/* Plataforma de lanzamiento vacía: dibujo propio, en el trazo de la casa. */}
          <svg width="120" height="72" viewBox="0 0 120 72" fill="none" aria-hidden className="text-line">
            <path d="M18 60h84" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M44 60v-6h20v6" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            <path
              d="M54 54c-3-14 0-26 6-32 6 6 9 18 6 32"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <circle cx="60" cy="34" r="3" fill="var(--color-acc)" />
            <path d="M76 30c8-8 16-13 26-16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="4 5" />
            <circle cx="30" cy="18" r="1.3" fill="currentColor" />
            <circle cx="94" cy="42" r="1.3" fill="currentColor" />
            <circle cx="106" cy="10" r="1.6" fill="var(--color-acc-soft)" opacity=".7" />
          </svg>
          {isAdmin ? (
            <>
              <p className="text-sm text-sub">Aún no tienes proyectos. Crea el primero para empezar a desplegar.</p>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus size={15} /> Crear proyecto
              </Button>
            </>
          ) : (
            <p className="text-sm text-sub">Aún no tienes workspaces asignados. Pide a un administrador que te dé acceso.</p>
          )}
        </div>
      )}

      {clients.length === 0 ? (
        <div className="stagger grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
          {visible.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-9">
          {grouped.map(([clientName, list]) => (
            <section key={clientName || '_none'}>
              <div className="mb-3.5 flex items-center gap-3">
                <h2 className="eyebrow text-sub">
                  {clientName || 'Sin empresa'}
                </h2>
                <span className="text-xs text-subtle tnum">
                  {list.length === 1 ? '1 proyecto' : `${list.length} proyectos`}
                </span>
                <div className="h-px flex-1 bg-line" />
              </div>
              <div className="stagger grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
                {list.map((p) => (
                  <ProjectCard key={p.id} project={p} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {importLatched && (
        <Suspense fallback={null}>
          <RailwayImportModal open={importOpen} onClose={() => setImportOpen(false)} />
        </Suspense>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Nuevo proyecto">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
          className="space-y-4"
        >
          <Field label="Nombre" hint="Ej: web corporativa, api interna...">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
          </Field>
          {isAdmin && (
            <Field label="Empresa / cliente (opcional)" hint="Asigna el proyecto a la cuenta de ese cliente (crea la cuenta si no existe)">
              <input className="input" list="clients-list" value={client} onChange={(e) => setClient(e.target.value)} placeholder="Acme S.L." />
              <datalist id="clients-list">
                {clients.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={() => setCreateOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={create.isPending}>
              Crear
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
