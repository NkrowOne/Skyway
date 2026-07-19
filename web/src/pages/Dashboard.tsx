import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Boxes, Building2, FolderOpen, Plus, TrainFront } from 'lucide-react';
import { api } from '../api';
import RailwayImportModal from '../components/RailwayImportModal';
import { Button, Field, Modal, Skeleton, useToast } from '../components/ui';
import { Me, Project } from '../types';
import { cx, timeAgo } from '../utils';

function ProjectCard({ project }: { project: Project }) {
  return (
    <Link to={`/projects/${project.id}`} className="card card-hover block p-5">
      <div className="flex items-start justify-between gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-acc/[.16] text-acc-soft">
          <Boxes size={17} />
        </span>
        <span className="inline-flex items-center rounded-full bg-surface2 px-[9px] py-[3px] text-[11px] font-medium text-sub tnum">
          {project.serviceCount === 1 ? '1 servicio' : `${project.serviceCount ?? 0} servicios`}
        </span>
      </div>
      <h3 className="mt-3.5 text-[15px] font-semibold tracking-[-.01em]">{project.name}</h3>
      <p className="mt-1 text-xs text-sub">
        <span className="font-mono text-[11px] text-subtle">{project.slug}</span>
      </p>
      <p className="mt-3 text-[11px] text-subtle">Creado {timeAgo(project.created_at)}</p>
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
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  const [filter, setFilter] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const toast = useToast();

  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: Project[] }>('/projects'),
  });

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), staleTime: 60_000 });
  const isAdmin = me.data?.user?.role === 'admin';

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
  const visible = filter === null ? all : all.filter((p) => (filter === '' ? !p.client : p.client === filter));

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
        : 'border-line bg-surface text-sub hover:border-[color-mix(in_oklab,#6e56cf_40%,var(--color-line))] hover:text-txt',
    );

  return (
    <div className="mx-auto max-w-[1120px] px-4 py-7 sm:px-6 sm:py-10">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold leading-[30px] tracking-[-.02em]">Proyectos</h1>
          <p className="mt-1.5 text-sm text-sub">Cada proyecto agrupa servicios que comparten una red privada</p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setImportOpen(true)} title="Migra un proyecto desde Railway">
              <TrainFront size={15} /> <span className="hidden sm:inline">Importar de Railway</span>
              <span className="sm:hidden">Importar</span>
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> Nuevo proyecto
            </Button>
          </div>
        )}
      </div>

      {clients.length > 0 && (
        <div className="-mx-4 mb-7 flex items-center gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0">
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

      {projects.isLoading && <DashboardSkeleton />}

      {projects.data && all.length === 0 && (
        <div className="card flex flex-col items-center gap-3 py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-acc/[.14] text-acc-soft">
            <FolderOpen size={22} />
          </span>
          <p className="text-sm text-sub">Aún no tienes proyectos. Crea el primero para empezar a desplegar.</p>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={15} /> Crear proyecto
          </Button>
        </div>
      )}

      {clients.length === 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
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
              <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
                {list.map((p) => (
                  <ProjectCard key={p.id} project={p} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <RailwayImportModal open={importOpen} onClose={() => setImportOpen(false)} />

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
          <Field label="Empresa / cliente (opcional)" hint="Agrupa los proyectos por empresa en el panel">
            <input className="input" list="clients-list" value={client} onChange={(e) => setClient(e.target.value)} placeholder="Acme S.L." />
            <datalist id="clients-list">
              {clients.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
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
