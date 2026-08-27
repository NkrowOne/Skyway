import { lazy, Suspense, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BellRing, Boxes, Building2, FolderKanban, Plus, Search, TrainFront, Zap } from 'lucide-react';
import { api } from '../api';
import { useLatch } from '../hooks';
import { Button, Field, Modal, Skeleton, useToast } from '../components/ui';
import { DeploySweep } from '../components/DeployBadge';
import { ModuleBadge, ModuleLogo, moduleKind } from '../components/ModuleIcon';

// El asistente de importación de Railway solo se abre desde un botón: se carga
// (React.lazy) en su 1ª apertura, no al entrar al panel.
const RailwayImportModal = lazy(() => import('../components/RailwayImportModal'));
import { Me, Project, ProjectServiceSummary } from '../types';
import { cx, timeAgo } from '../utils';

const MONOGRAM_GRADIENTS = [
  'from-indigo-500/25 to-purple-600/25 text-indigo-300 border-indigo-500/35 shadow-[0_0_12px_-3px_rgba(99,102,241,0.2)]',
  'from-cyan-500/25 to-blue-600/25 text-cyan-300 border-cyan-500/35 shadow-[0_0_12px_-3px_rgba(6,182,212,0.2)]',
  'from-emerald-500/25 to-teal-600/25 text-emerald-300 border-emerald-500/35 shadow-[0_0_12px_-3px_rgba(16,185,129,0.2)]',
  'from-violet-500/25 to-fuchsia-600/25 text-violet-300 border-violet-500/35 shadow-[0_0_12px_-3px_rgba(139,92,246,0.2)]',
  'from-amber-500/25 to-orange-600/25 text-amber-300 border-amber-500/35 shadow-[0_0_12px_-3px_rgba(245,158,11,0.2)]',
  'from-rose-500/25 to-pink-600/25 text-rose-300 border-rose-500/35 shadow-[0_0_12px_-3px_rgba(244,63,94,0.2)]',
  'from-sky-500/25 to-indigo-600/25 text-sky-300 border-sky-500/35 shadow-[0_0_12px_-3px_rgba(14,165,233,0.2)]',
];

function getMonogramTheme(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return MONOGRAM_GRADIENTS[Math.abs(hash) % MONOGRAM_GRADIENTS.length];
}

/**
 * Monograma del proyecto: dos letras con gradiente vivo exclusivo por proyecto
 */
function Monogram({ name }: { name: string }) {
  const words = name.trim().split(/[\s\-_]+/).filter(Boolean);
  const initials = (words.length >= 2 ? words[0][0] + words[1][0] : name.trim().slice(0, 2)).toUpperCase();
  const theme = getMonogramTheme(name);
  return (
    <span
      className={cx(
        'flex h-10 w-10 shrink-0 select-none items-center justify-center rounded-xl border bg-gradient-to-br font-mono text-[13px] font-bold tracking-[.04em] transition-all duration-200 group-hover:scale-105',
        theme,
      )}
    >
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
      <div className="mt-3 flex items-center gap-1.5 text-[11px] text-subtle">
        <span className="h-1.5 w-1.5 rounded-full bg-line" />
        <span>Sin servicios configurados</span>
      </div>
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
        <span
          className="inline-flex items-center rounded-lg border border-line/80 bg-surface2/70 px-2 py-0.5 text-[10.5px] font-semibold text-subtle"
          title={`${remaining} servicio${remaining > 1 ? 's' : ''} más`}
        >
          +{remaining} más
        </span>
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
      className="group card card-hover relative flex flex-col justify-between p-5 transition-all duration-200 border-line hover:border-acc/40 hover:shadow-lg hover:shadow-acc/5"
    >
      {/* La misma cinta que la tarjeta del servicio: el aviso de «hay una versión saliendo» */}
      {deploying > 0 && <DeploySweep />}
      <div>
        <div className="flex items-start justify-between gap-2">
          <Monogram name={project.name} />
          <div className="flex items-center gap-2 text-xs">
            {deploying > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-warn/30 bg-warn/10 px-2 py-0.5 text-[11px] font-medium text-warn">
                <span className="pulse-soft h-1.5 w-1.5 rounded-full bg-warn" />
                {deploying === 1 ? 'desplegando' : `${deploying} desplegando`}
              </span>
            )}
            {alerts > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-err/30 bg-err/10 px-2 py-0.5 text-[11px] font-semibold text-err">
                <BellRing size={10} /> {alerts}
              </span>
            )}
            <span className="font-mono text-[11px] text-subtle">
              {project.serviceCount === 1 ? '1 servicio' : `${project.serviceCount ?? 0} servicios`}
            </span>
          </div>
        </div>

        <h3 className="mt-3.5 text-[15px] font-semibold tracking-[-.01em] text-txt transition-colors group-hover:text-acc-soft">
          {project.name}
        </h3>
        <p className="mt-0.5 text-xs text-sub">
          <span className="font-mono text-[11px] text-subtle">{project.slug}</span>
        </p>

        {/* Mini resumen visual de la pila de servicios */}
        <ServiceStack services={project.services} />
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-line/50 pt-3 text-[11px] text-subtle">
        <span>
          {project.lastDeployAt ? `Último despliegue ${timeAgo(project.lastDeployAt)}` : 'Sin despliegues todavía'}
        </span>
        <span className="text-xs font-semibold text-subtle transition-all group-hover:translate-x-0.5 group-hover:text-txt">
          →
        </span>
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

  const chipCls = (active: boolean) =>
    cx(
      'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-[5px] text-xs transition-colors duration-150',
      active
        ? 'border-acc/55 bg-acc/[.16] font-medium text-acc-soft'
        : 'border-line bg-surface text-sub hover:border-[color-mix(in_oklab,var(--color-acc)_40%,var(--color-line))] hover:text-txt',
    );

  return (
    <div className="mx-auto max-w-[1120px] px-4 py-7 sm:px-6 sm:py-10">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold leading-[30px] tracking-[-.02em]">Proyectos</h1>
            {totalProjects > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface2/60 px-2.5 py-0.5 font-medium text-sub">
                  <FolderKanban size={11} className="text-acc" />
                  <strong className="text-txt">{totalProjects}</strong> proyectos
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface2/60 px-2.5 py-0.5 font-medium text-sub">
                  <Boxes size={11} className="text-info" />
                  <strong className="text-txt">{totalServices}</strong> servicios
                </span>
                {totalDeploying > 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-warn/30 bg-warn/10 px-2.5 py-0.5 font-semibold text-warn">
                    <span className="h-1.5 w-1.5 rounded-full bg-warn animate-pulse" />
                    {totalDeploying} desplegando
                  </span>
                )}
                {totalAlerts > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-err/30 bg-err/10 px-2.5 py-0.5 font-semibold text-err">
                    <BellRing size={11} /> {totalAlerts}
                  </span>
                )}
              </div>
            )}
          </div>
          <p className="mt-1.5 text-sm text-sub">Cada proyecto agrupa servicios que comparten una red privada</p>
        </div>
        {isManager && (
          <div className="flex items-center gap-2">
            {isAdmin && (
              <Button variant="secondary" onClick={() => setImportOpen(true)} title="Migra un proyecto desde Railway">
                <TrainFront size={15} /> <span className="hidden sm:inline">Importar de Railway</span>
                <span className="sm:hidden">Importar</span>
              </Button>
            )}
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> Nuevo proyecto
            </Button>
          </div>
        )}
      </div>

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
              className="h-9 w-full rounded-xl border border-line bg-surface/80 pl-9 pr-8 text-xs text-txt placeholder:text-subtle transition-colors focus:border-acc/60 focus:bg-surface focus:outline-none"
            />
            {projectQuery && (
              <button
                onClick={() => setProjectQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-subtle hover:text-txt"
                title="Limpiar búsqueda"
              >
                ✕
              </button>
            )}
          </div>

          {clients.length > 0 && (
            <div className="-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0">
              <button onClick={() => setFilter(null)} className={chipCls(filter === null)}>
                Todas <span className="opacity-70 tnum">{all.length}</span>
              </button>
              {clients.map((c) => {
                const count = all.filter((p) => p.client === c).length;
                return (
                  <button key={c} onClick={() => setFilter(filter === c ? null : c)} className={chipCls(filter === c)}>
                    <Building2 size={11} /> {c} <span className="opacity-60 tnum">{count}</span>
                  </button>
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
                <h2 className="text-xs font-semibold uppercase tracking-[.09em] text-sub">
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
