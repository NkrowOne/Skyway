import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Lock, Search } from 'lucide-react';
import { api } from '../api';
import { DbTemplate, Deployment, GithubConnector, GithubRepo, Service } from '../types';
import { cx } from '../utils';
import { ModuleKind, ModuleLogo, moduleFg, moduleKind } from './ModuleIcon';
import { Button, Field, Modal, Spinner, useToast } from './ui';

/** Los logos reales de lo que vas a desplegar: informan, no decoran. */
function LogoRow({ kinds, size = 20 }: { kinds: ModuleKind[]; size?: number }) {
  return (
    <span className="flex h-8 items-center gap-2.5">
      {kinds.map((k) => (
        <span key={k} style={{ color: moduleFg(k) }}>
          <ModuleLogo kind={k} size={size} />
        </span>
      ))}
    </span>
  );
}

type Step = 'pick' | 'git' | 'database' | 'image';

/** Logo real por plantilla de BD (las no mapeadas caen en genérico). */
const TEMPLATE_KIND: Record<string, ModuleKind> = {
  postgres: 'postgres',
  redis: 'redis',
  mysql: 'mysql',
  mongo: 'mongo',
  minio: 'minio',
};

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
  const [connectorId, setConnectorId] = useState('');
  const [repoFilter, setRepoFilter] = useState('');

  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.get<{ templates: DbTemplate[] }>('/templates'),
    enabled: open,
    staleTime: Infinity,
  });

  const connectors = useQuery({
    queryKey: ['connectors', projectId],
    queryFn: () => api.get<{ connectors: GithubConnector[]; hasGlobalToken: boolean }>(`/projects/${projectId}/connectors`),
    enabled: open,
    staleTime: 30_000,
  });

  // Con un conector elegido, el repo se escoge de la cuenta conectada en vez de pegar la URL.
  const repos = useQuery({
    queryKey: ['connectorRepos', connectorId],
    queryFn: () => api.get<{ repos: GithubRepo[] }>(`/connectors/${connectorId}/repos`),
    enabled: open && step === 'git' && !!connectorId,
    staleTime: 60_000,
    retry: false,
  });

  const selectedRepo = repoUrl.replace(/^https:\/\/github\.com\//, '');
  const branches = useQuery({
    queryKey: ['connectorBranches', connectorId, selectedRepo],
    queryFn: () => api.get<{ branches: string[] }>(`/connectors/${connectorId}/branches?repo=${encodeURIComponent(selectedRepo)}`),
    enabled: open && step === 'git' && !!connectorId && /^[\w.-]+\/[\w.-]+$/.test(selectedRepo),
    staleTime: 60_000,
    retry: false,
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
    setConnectorId('');
    setRepoFilter('');
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
      ...(connectorId ? { connectorId } : {}),
    });
  };

  const pickRepo = (r: GithubRepo) => {
    setRepoUrl(`https://github.com/${r.fullName}`);
    setBranch(r.defaultBranch);
  };

  const filteredRepos = (repos.data?.repos ?? []).filter((r) =>
    r.fullName.toLowerCase().includes(repoFilter.trim().toLowerCase()),
  );

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
            <LogoRow kinds={['github']} size={24} />
            <div>
              <h3 className="text-sm font-medium group-hover:text-acc">Repositorio de GitHub</h3>
              <p className="mt-1 text-xs text-sub">
                Clona, construye (Dockerfile o Nixpacks) y despliega automáticamente
              </p>
            </div>
          </button>
          <button
            onClick={() => setStep('database')}
            className="card group flex flex-col items-start gap-3 border-line p-5 text-left transition-all hover:border-info/60"
          >
            <LogoRow kinds={['postgres', 'redis', 'mysql', 'mongo']} size={17} />
            <div>
              <h3 className="text-sm font-medium group-hover:text-info">Base de datos</h3>
              <p className="mt-1 text-xs text-sub">PostgreSQL, Redis, MySQL, MongoDB o MinIO listos para usar</p>
            </div>
          </button>
          <button
            onClick={() => setStep('image')}
            className="card group flex flex-col items-start gap-3 border-line p-5 text-left transition-all hover:border-warn/60"
          >
            <LogoRow kinds={['docker']} size={24} />
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
            <div className="relative">
              <input
                className="input pr-10 font-mono"
                placeholder="n8nio/n8n:latest"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                required
                autoFocus
              />
              {/* Reconocemos la imagen mientras escribes: su logo oficial lo confirma. */}
              {(() => {
                const kind = moduleKind({ type: 'image', config: { image } as any });
                if (kind === 'generic' || kind === 'docker') return null;
                return (
                  <span
                    key={kind}
                    className="badge-in pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"
                    style={{ color: moduleFg(kind) }}
                  >
                    <ModuleLogo kind={kind} size={16} />
                  </span>
                );
              })()}
            </div>
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
          {(connectors.data?.connectors.length ?? 0) > 0 && (
            <Field label="Cuenta de GitHub" hint="Con un conector eliges el repo de esa cuenta; «URL manual» clona con el token global del servidor">
              <select
                className="input"
                value={connectorId}
                onChange={(e) => {
                  setConnectorId(e.target.value);
                  // Al cambiar de cuenta, el repo elegido deja de tener sentido.
                  setRepoUrl('');
                  setRepoFilter('');
                  setBranch('main');
                }}
              >
                <option value="">URL manual (token global)</option>
                {connectors.data!.connectors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · @{c.gh_login}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {connectorId ? (
            <Field label="Repositorio" hint={selectedRepo ? undefined : 'Elige un repo de la cuenta conectada'}>
              <div className="rounded-lg border border-line bg-bg">
                <div className="flex items-center gap-2 border-b border-line px-3 py-2">
                  <Search size={13} className="shrink-0 text-subtle" />
                  <input
                    className="w-full bg-transparent text-xs outline-none placeholder:text-subtle"
                    placeholder="Filtrar repos…"
                    value={repoFilter}
                    onChange={(e) => setRepoFilter(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="max-h-44 overflow-y-auto p-1.5">
                  {repos.isLoading && <Spinner label="Cargando repos…" />}
                  {repos.isError && (
                    <p className="px-2.5 py-4 text-center text-xs text-err">{(repos.error as Error).message}</p>
                  )}
                  {repos.data && filteredRepos.length === 0 && (
                    <p className="px-2.5 py-4 text-center text-xs text-subtle">Sin repos que coincidan con «{repoFilter}»</p>
                  )}
                  {filteredRepos.map((r) => {
                    const active = selectedRepo === r.fullName;
                    return (
                      <button
                        key={r.fullName}
                        type="button"
                        onClick={() => pickRepo(r)}
                        className={cx(
                          'flex w-full items-center gap-2 rounded-md px-2.5 py-[7px] text-left transition-colors',
                          active ? 'bg-acc/[.14] shadow-[inset_2px_0_0_var(--color-acc)]' : 'hover:bg-surface2',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.fullName}</span>
                        {r.private && (
                          <span className="flex shrink-0 items-center gap-1 rounded-full bg-surface2 px-1.5 py-0.5 text-[10px] text-sub">
                            <Lock size={9} /> privado
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </Field>
          ) : (
            <Field
              label="Repositorio"
              hint="URL completa o atajo owner/repo. Para repos privados usa un conector del proyecto o el token de Ajustes."
            >
              <input
                className="input font-mono"
                placeholder="https://github.com/usuario/mi-app"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                required
                autoFocus
              />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Rama">
              {connectorId && (branches.data?.branches.length ?? 0) > 0 ? (
                <select className="input" value={branch} onChange={(e) => setBranch(e.target.value)}>
                  {branches.data!.branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="input" value={branch} onChange={(e) => setBranch(e.target.value)} />
              )}
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
            <Button type="submit" loading={create.isPending} disabled={!repoUrl.trim()}>
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
                  'card flex items-center gap-3 p-4 text-left transition-all hover:border-info/60 disabled:opacity-60',
                  template === tpl.key && create.isPending && 'border-info/70',
                )}
              >
                <span
                  className="shrink-0"
                  style={{ color: moduleFg(TEMPLATE_KIND[tpl.key] ?? 'generic') }}
                >
                  <ModuleLogo kind={TEMPLATE_KIND[tpl.key] ?? 'generic'} size={20} />
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-medium">{tpl.label}</h3>
                  <p className="truncate text-xs text-sub">{tpl.description}</p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-subtle">
                    {tpl.image}:{tpl.defaultVersion}
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
