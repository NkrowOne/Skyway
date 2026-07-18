import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Database, GitBranch, Package } from 'lucide-react';
import { api } from '../api';
import { DbTemplate, Deployment, Service } from '../types';
import { cx } from '../utils';
import { Button, Field, Modal, useToast } from './ui';

type Step = 'pick' | 'git' | 'database' | 'image';

export default function NewServiceModal({
  open,
  onClose,
  projectId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: (serviceId: string) => void;
}) {
  const toast = useToast();
  const [step, setStep] = useState<Step>('pick');
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [port, setPort] = useState('3000');
  const [rootDir, setRootDir] = useState('');
  const [template, setTemplate] = useState<string | null>(null);
  const [image, setImage] = useState('');
  const [imagePort, setImagePort] = useState('');

  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.get<{ templates: DbTemplate[] }>('/templates'),
    enabled: open,
    staleTime: Infinity,
  });

  const reset = () => {
    setStep('pick');
    setName('');
    setRepoUrl('');
    setBranch('main');
    setPort('3000');
    setRootDir('');
    setTemplate(null);
    setImage('');
    setImagePort('');
  };

  const close = () => {
    reset();
    onClose();
  };

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ service: Service; deployment: Deployment }>(`/projects/${projectId}/services`, body),
    onSuccess: (data) => {
      toast('Servicio creado: desplegando...', 'ok');
      reset();
      onCreated(data.service.id);
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const submitGit = (e: React.FormEvent) => {
    e.preventDefault();
    const inferredName = name.trim() || repoUrl.split('/').filter(Boolean).pop()?.replace(/\.git$/, '') || 'app';
    create.mutate({
      type: 'git',
      name: inferredName,
      repoUrl: repoUrl.trim(),
      branch: branch.trim() || 'main',
      port: Number(port) || 3000,
      ...(rootDir.trim() ? { rootDir: rootDir.trim() } : {}),
    });
  };

  const submitDb = (tpl: DbTemplate) => {
    create.mutate({ type: 'database', template: tpl.key });
  };

  return (
    <Modal open={open} onClose={close} title="Nuevo servicio" wide>
      {step === 'pick' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <button
            onClick={() => setStep('git')}
            className="card group flex flex-col items-start gap-3 border-line p-5 text-left transition-all hover:border-acc/60"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-acc/15 text-acc">
              <GitBranch size={18} />
            </span>
            <div>
              <h3 className="text-sm font-medium group-hover:text-acc">Repositorio de GitHub</h3>
              <p className="mt-1 text-xs text-sub">
                Clona, construye (Dockerfile o Nixpacks) y despliega automáticamente
              </p>
            </div>
          </button>
          <button
            onClick={() => setStep('database')}
            className="card group flex flex-col items-start gap-3 border-line p-5 text-left transition-all hover:border-acc2/60"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-acc2/10 text-acc2">
              <Database size={18} />
            </span>
            <div>
              <h3 className="text-sm font-medium group-hover:text-acc2">Base de datos</h3>
              <p className="mt-1 text-xs text-sub">PostgreSQL, Redis, MySQL, MongoDB o MinIO listos para usar</p>
            </div>
          </button>
          <button
            onClick={() => setStep('image')}
            className="card group flex flex-col items-start gap-3 border-line p-5 text-left transition-all hover:border-warn/60"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-warn/10 text-warn">
              <Package size={18} />
            </span>
            <div>
              <h3 className="text-sm font-medium group-hover:text-warn">Imagen Docker</h3>
              <p className="mt-1 text-xs text-sub">Cualquier imagen pública: n8n, Plausible, Uptime Kuma...</p>
            </div>
          </button>
        </div>
      )}

      {step === 'image' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const inferred = name.trim() || image.split('/').pop()?.split(':')[0] || 'servicio';
            create.mutate({
              type: 'image',
              name: inferred,
              image: image.trim(),
              ...(imagePort ? { port: Number(imagePort) } : {}),
            });
          }}
          className="space-y-4"
        >
          <Field label="Imagen" hint="De Docker Hub, ghcr.io, etc. Incluye el tag si no quieres :latest">
            <input
              className="input font-mono"
              placeholder="n8nio/n8n:latest"
              value={image}
              onChange={(e) => setImage(e.target.value)}
              required
              autoFocus
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Nombre (opcional)">
              <input className="input" placeholder="se infiere de la imagen" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Puerto interno (opcional)" hint="Si sirve HTTP y quieres ponerle dominio">
              <input className="input" type="number" placeholder="5678" value={imagePort} onChange={(e) => setImagePort(e.target.value)} />
            </Field>
          </div>
          <div className="flex justify-between pt-1">
            <Button type="button" variant="ghost" onClick={() => setStep('pick')}>
              Atrás
            </Button>
            <Button type="submit" loading={create.isPending}>
              Crear y desplegar
            </Button>
          </div>
        </form>
      )}

      {step === 'git' && (
        <form onSubmit={submitGit} className="space-y-4">
          <Field label="Repositorio" hint="URL completa o atajo owner/repo. Para repos privados configura un token en Ajustes.">
            <input
              className="input font-mono"
              placeholder="https://github.com/usuario/mi-app"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              required
              autoFocus
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Rama">
              <input className="input" value={branch} onChange={(e) => setBranch(e.target.value)} />
            </Field>
            <Field label="Puerto de la app" hint="Puerto interno que escucha tu aplicación">
              <input className="input" type="number" value={port} onChange={(e) => setPort(e.target.value)} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Nombre (opcional)">
              <input className="input" placeholder="se infiere del repo" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Directorio raíz (opcional)" hint="Para monorepos, ej: apps/api">
              <input className="input" placeholder="." value={rootDir} onChange={(e) => setRootDir(e.target.value)} />
            </Field>
          </div>
          <div className="flex justify-between pt-1">
            <Button type="button" variant="ghost" onClick={() => setStep('pick')}>
              Atrás
            </Button>
            <Button type="submit" loading={create.isPending}>
              Crear y desplegar
            </Button>
          </div>
        </form>
      )}

      {step === 'database' && (
        <div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {templates.data?.templates.map((tpl) => (
              <button
                key={tpl.key}
                disabled={create.isPending}
                onClick={() => {
                  setTemplate(tpl.key);
                  submitDb(tpl);
                }}
                className={cx(
                  'card flex items-center gap-3 p-4 text-left transition-all hover:border-acc2/60 disabled:opacity-60',
                  template === tpl.key && create.isPending && 'border-acc2/70',
                )}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-acc2/10 text-acc2">
                  <Database size={16} />
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-medium">{tpl.label}</h3>
                  <p className="truncate text-xs text-sub">
                    {tpl.description} · <span className="font-mono">{tpl.image}:{tpl.defaultVersion}</span>
                  </p>
                </div>
              </button>
            ))}
          </div>
          <div className="mt-4 flex justify-between">
            <Button type="button" variant="ghost" onClick={() => setStep('pick')}>
              Atrás
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
