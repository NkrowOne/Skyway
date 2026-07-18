import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Boxes, FolderOpen, Plus } from 'lucide-react';
import { api } from '../api';
import { Button, Field, Modal, Spinner, useToast } from '../components/ui';
import { Project } from '../types';
import { timeAgo } from '../utils';

export default function Dashboard() {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const queryClient = useQueryClient();
  const toast = useToast();

  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: Project[] }>('/projects'),
  });

  const create = useMutation({
    mutationFn: () => api.post<{ project: Project }>('/projects', { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setCreateOpen(false);
      setName('');
      toast('Proyecto creado', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Proyectos</h1>
          <p className="mt-1 text-sm text-sub">Cada proyecto agrupa servicios que comparten una red privada</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus size={15} /> Nuevo proyecto
        </Button>
      </div>

      {projects.isLoading && <Spinner label="Cargando proyectos..." />}

      {projects.data && projects.data.projects.length === 0 && (
        <div className="card flex flex-col items-center gap-3 py-16 text-center">
          <FolderOpen size={32} className="text-sub/50" />
          <p className="text-sm text-sub">Aún no tienes proyectos. Crea el primero para empezar a desplegar.</p>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={15} /> Crear proyecto
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects.data?.projects.map((p) => (
          <Link
            key={p.id}
            to={`/projects/${p.id}`}
            className="card group p-5 transition-all hover:border-acc/50 hover:shadow-lg hover:shadow-acc/5"
          >
            <div className="flex items-start justify-between">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-acc/15 text-acc">
                <Boxes size={17} />
              </span>
              <span className="text-xs text-sub">{timeAgo(p.created_at)}</span>
            </div>
            <h2 className="mt-3 font-medium group-hover:text-acc">{p.name}</h2>
            <p className="mt-1 text-xs text-sub">
              {p.serviceCount === 1 ? '1 servicio' : `${p.serviceCount ?? 0} servicios`} · {p.slug}
            </p>
          </Link>
        ))}
      </div>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Nuevo proyecto">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
          className="space-y-4"
        >
          <Field label="Nombre" hint="Ej: mi-saas, blog personal...">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
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
