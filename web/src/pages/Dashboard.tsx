import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Boxes, Building2, FolderOpen, Plus, TrainFront } from 'lucide-react';
import { api } from '../api';
import RailwayImportModal from '../components/RailwayImportModal';
import { Button, Field, Modal, Spinner, useToast } from '../components/ui';
import { Project } from '../types';
import { cx, timeAgo } from '../utils';

function ProjectCard({ project }: { project: Project }) {
  return (
    <Link
      to={`/projects/${project.id}`}
      className="card group p-5 transition-all hover:border-acc/50 hover:shadow-lg hover:shadow-acc/5"
    >
      <div className="flex items-start justify-between">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-acc/15 text-acc">
          <Boxes size={17} />
        </span>
        <span className="text-xs text-sub">{timeAgo(project.created_at)}</span>
      </div>
      <h2 className="mt-3 font-medium group-hover:text-acc">{project.name}</h2>
      <p className="mt-1 text-xs text-sub">
        {project.serviceCount === 1 ? '1 servicio' : `${project.serviceCount ?? 0} servicios`} · {project.slug}
      </p>
    </Link>
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
  const existingClients = clients;
  const visible = filter === null ? all : all.filter((p) => (filter === '' ? !p.client : p.client === filter));

  const grouped = useMemo(() => {
    const groups = new Map<string, Project[]>();
    for (const p of visible) {
      const key = p.client ?? '';
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    return [...groups.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  }, [visible]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Proyectos</h1>
          <p className="mt-1 text-sm text-sub">Cada proyecto agrupa servicios que comparten una red privada</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)} title="Migra un proyecto desde Railway">
            <TrainFront size={15} /> Importar de Railway
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={15} /> Nuevo proyecto
          </Button>
        </div>
      </div>

      {clients.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <button
            onClick={() => setFilter(null)}
            className={cx(
              'rounded-full border px-3 py-1 text-xs transition-colors',
              filter === null ? 'border-acc/60 bg-acc/15 text-acc' : 'border-line bg-panel2 text-sub hover:text-txt',
            )}
          >
            Todas
          </button>
          {clients.map((c) => (
            <button
              key={c}
              onClick={() => setFilter(filter === c ? null : c)}
              className={cx(
                'flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors',
                filter === c ? 'border-acc/60 bg-acc/15 text-acc' : 'border-line bg-panel2 text-sub hover:text-txt',
              )}
            >
              <Building2 size={11} /> {c}
            </button>
          ))}
        </div>
      )}

      {projects.isLoading && <Spinner label="Cargando proyectos..." />}

      {projects.data && all.length === 0 && (
        <div className="card flex flex-col items-center gap-3 py-16 text-center">
          <FolderOpen size={32} className="text-sub/50" />
          <p className="text-sm text-sub">Aún no tienes proyectos. Crea el primero para empezar a desplegar.</p>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={15} /> Crear proyecto
          </Button>
        </div>
      )}

      {clients.length === 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      ) : (
        <div className="space-y-7">
          {grouped.map(([clientName, list]) => (
            <section key={clientName || '_none'}>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-sub">
                <Building2 size={14} className="text-acc" />
                {clientName || 'Sin empresa'}
                <span className="text-xs text-sub/60">({list.length})</span>
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
              {existingClients.map((c) => (
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
