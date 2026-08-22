import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api } from '../api';
import { DbTemplate, Deployment, GithubRepo, RailwayTemplatePlan, Service, Stack } from '../types';
import { cx } from '../utils';
import {
  GithubRepoPicker,
  GithubSource,
  GithubSourceSelect,
  NO_SOURCE,
  useGithubBranches,
  useGithubSources,
} from './GithubSource';
import { ModuleKind, ModuleLogo, isModuleKind, moduleFg, moduleKind } from './ModuleIcon';
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

type Step = 'pick' | 'git' | 'database' | 'image' | 'stack';

/** Logo real por plantilla de BD (las no mapeadas caen en genérico). */
const TEMPLATE_KIND: Record<string, ModuleKind> = {
  postgres: 'postgres',
  redis: 'redis',
  mysql: 'mysql',
  mongo: 'mongo',
  minio: 'minio',
};

/**
 * El catálogo de pilas manda claves de logo como texto. Una clave que este
 * bundle no conozca (servidor más nuevo que la web) no puede reventar la
 * página: cae en el icono genérico.
 */
const asKind = (icon: string): ModuleKind => (isModuleKind(icon) ? icon : 'generic');

/** Misma normalización que hace el servidor, para que la vista previa no mienta. */
const slugPreview = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');

export default function NewServiceModal({
  open,
  onClose,
  projectId,
  onCreated,
  onStackCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: (serviceId: string) => void;
  onStackCreated?: () => void;
}) {
  const toast = useToast();
  const [step, setStep] = useState<Step>('pick');
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  // Vacío a propósito: si no se toca, el primer despliegue lo detecta del EXPOSE
  // de la imagen. Precargar «3000» hacía imposible NO elegir puerto.
  const [port, setPort] = useState('');
  const [rootDir, setRootDir] = useState('');
  const [template, setTemplate] = useState<string | null>(null);
  const [image, setImage] = useState('');
  const [imagePort, setImagePort] = useState('');
  const [source, setSource] = useState<GithubSource>(NO_SOURCE);
  const [repoFilter, setRepoFilter] = useState('');
  const [stackKey, setStackKey] = useState<string | null>(null);
  const [tplInput, setTplInput] = useState('');
  const [tplPlan, setTplPlan] = useState<RailwayTemplatePlan | null>(null);
  const [stackPrefix, setStackPrefix] = useState('');
  const [stackDomain, setStackDomain] = useState('');

  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.get<{ templates: DbTemplate[] }>('/templates'),
    enabled: open,
    staleTime: Infinity,
  });

  const stacks = useQuery({
    queryKey: ['stacks'],
    queryFn: () => api.get<{ stacks: Stack[] }>('/stacks'),
    enabled: open,
    staleTime: Infinity,
  });

  // Cuentas de GitHub del proyecto: instalaciones de la App y tokens personales.
  const sources = useGithubSources(projectId, open);
  const hasSources = sources.installations.length > 0 || sources.connectors.length > 0;

  // Con una cuenta elegida, el repo se escoge de su lista en vez de pegar la URL.
  const selectedRepo = repoUrl.replace(/^https:\/\/github\.com\//, '');
  const branches = useGithubBranches(source, selectedRepo, open && step === 'git');

  const reset = () => {
    setStep('pick');
    setName('');
    setRepoUrl('');
    setBranch('main');
    setPort('');
    setRootDir('');
    setTemplate(null);
    setImage('');
    setImagePort('');
    setSource(NO_SOURCE);
    setRepoFilter('');
    setStackKey(null);
    setStackPrefix('');
    setStackDomain('');
    setTplInput('');
    setTplPlan(null);
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

  const createStack = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ services: Service[] }>(`/projects/${projectId}/stacks`, body),
    onSuccess: (data) => {
      toast(`Pila creada: desplegando ${data.services.length} servicios...`, 'ok');
      reset();
      onStackCreated ? onStackCreated() : onClose();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const selectedStack = stacks.data?.stacks.find((s) => s.key === stackKey) ?? null;

  // Plantillas del catálogo público de Railway, instaladas dentro del proyecto.
  const previewTemplate = useMutation({
    mutationFn: (template: string) =>
      api.post<{ plan: RailwayTemplatePlan }>('/railway-templates/preview', { template }),
    onSuccess: (data) => {
      setTplPlan(data.plan);
      setStackPrefix(data.plan.prefix);
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const createTemplate = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ services: Service[]; notes: string[] }>(`/projects/${projectId}/railway-templates`, body),
    onSuccess: (data) => {
      toast(`Plantilla instalada: desplegando ${data.services.length} servicios...`, 'ok');
      reset();
      onStackCreated ? onStackCreated() : onClose();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  /** Logo de un servicio de plantilla: por imagen, o el de GitHub si viene de repo. */
  const templateKind = (svc: { kind: string; image: string }): ModuleKind =>
    svc.kind === 'git' ? 'github' : moduleKind({ type: 'image', config: { image: svc.image } as any });

  const submitStack = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedStack) return;
    createStack.mutate({
      stack: selectedStack.key,
      ...(stackPrefix.trim() ? { prefix: stackPrefix.trim() } : {}),
      ...(stackDomain.trim() ? { domain: stackDomain.trim().toLowerCase() } : {}),
    });
  };

  const submitGit = (e: React.FormEvent) => {
    e.preventDefault();
    const inferredName = name.trim() || repoUrl.split('/').filter(Boolean).pop()?.replace(/\.git$/, '') || 'app';
    create.mutate({
      type: 'git',
      name: inferredName,
      repoUrl: repoUrl.trim(),
      branch: branch.trim() || 'main',
      ...(port.trim() ? { port: Number(port) } : {}),
      ...(rootDir.trim() ? { rootDir: rootDir.trim() } : {}),
      ...(source.kind === 'app' ? { githubInstallationId: source.id } : {}),
      ...(source.kind === 'pat' ? { connectorId: source.id } : {}),
    });
  };

  const pickRepo = (r: GithubRepo) => {
    setRepoUrl(`https://github.com/${r.fullName}`);
    setBranch(r.defaultBranch);
  };

  const submitDb = (tpl: DbTemplate) => {
    create.mutate({ type: 'database', template: tpl.key });
  };

  return (
    <Modal open={open} onClose={close} title="Nuevo servicio" wide>
      {step === 'pick' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            onClick={() => setStep('stack')}
            className="card group flex flex-col items-start gap-3 border-line p-5 text-left transition-all hover:border-ok/60"
          >
            <LogoRow kinds={['supabase', 'wordpress', 'n8n', 'ghost']} size={19} />
            <div>
              <h3 className="text-sm font-medium group-hover:text-ok">Aplicación completa</h3>
              <p className="mt-1 text-xs text-sub">
                Supabase, WordPress, Ghost, n8n o Metabase con todos sus servicios y su base de datos
              </p>
            </div>
          </button>
          <button
            onClick={() => setStep('image')}
            className="card group flex flex-col items-start gap-3 border-line p-5 text-left transition-all hover:border-warn/60"
          >
            <LogoRow kinds={['docker']} size={24} />
            <div>
              <h3 className="text-sm font-medium group-hover:text-warn">Imagen Docker</h3>
              <p className="mt-1 text-xs text-sub">Cualquier imagen pública: Plausible, Uptime Kuma, Grafana...</p>
            </div>
          </button>
        </div>
      )}

      {step === 'stack' && !selectedStack && !tplPlan && (
        <div>
          {stacks.isLoading && <Spinner label="Cargando aplicaciones…" />}
          {stacks.isError && (
            <p className="px-2.5 py-4 text-center text-xs text-err">{(stacks.error as Error).message}</p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {stacks.data?.stacks.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => {
                  setStackKey(s.key);
                  setStackPrefix(s.defaultPrefix);
                }}
                className="card group flex flex-col items-start gap-3 p-4 text-left transition-all hover:border-ok/60"
              >
                <LogoRow kinds={s.logos.map(asKind)} size={19} />
                <div className="min-w-0">
                  <h3 className="text-sm font-medium group-hover:text-ok">{s.label}</h3>
                  <p className="mt-1 text-xs text-sub">{s.description}</p>
                  <p className="mt-1.5 text-[11px] text-subtle">
                    {s.services.length === 1 ? '1 servicio' : `${s.services.length} servicios`} ·{' '}
                    {Math.round(s.memoryHintMb / 1024)} GB de RAM recomendados
                  </p>
                </div>
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              previewTemplate.mutate(tplInput.trim());
            }}
            className="mt-5 rounded-lg border border-line bg-bg p-3"
          >
            <p className="text-xs text-sub">
              ¿No está la que buscas? Instala cualquier plantilla del catálogo de Railway en este proyecto.
            </p>
            <div className="mt-2 flex gap-2">
              <input
                className="input flex-1 font-mono text-xs"
                placeholder="https://railway.com/new/template/supabase"
                value={tplInput}
                onChange={(e) => setTplInput(e.target.value)}
              />
              <Button type="submit" variant="ghost" loading={previewTemplate.isPending} disabled={!tplInput.trim()}>
                Ver qué crea
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-subtle">
              Skyway traduce su cableado: los dominios internos de Railway pasan a los de aquí y lo que no tenga
              equivalente se te dice antes de crear nada.
            </p>
          </form>

          <div className="mt-4 flex justify-between">
            <Button type="button" variant="ghost" onClick={() => setStep('pick')}>
              Atrás
            </Button>
          </div>
        </div>
      )}

      {step === 'stack' && tplPlan && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createTemplate.mutate({
              template: tplPlan.code,
              ...(stackPrefix.trim() ? { prefix: stackPrefix.trim() } : {}),
              ...(stackDomain.trim() ? { domain: stackDomain.trim().toLowerCase() } : {}),
            });
          }}
          className="space-y-4"
        >
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium">{tplPlan.name}</h3>
              <p className="mt-0.5 text-xs text-sub">{tplPlan.description || 'Plantilla del catálogo de Railway'}</p>
            </div>
            <a
              href={`https://railway.com/new/template/${tplPlan.code}`}
              target="_blank"
              rel="noreferrer"
              className="flex shrink-0 items-center gap-1 text-[11px] text-sub hover:text-txt"
            >
              En Railway <ExternalLink size={11} />
            </a>
          </div>

          <div className="rounded-lg border border-line bg-bg p-1.5">
            {[...tplPlan.services]
              .sort((a, b) => a.stage - b.stage || a.slug.localeCompare(b.slug))
              .map((svc) => (
                <div
                  key={svc.slug}
                  className="flex flex-col gap-0.5 px-2.5 py-[7px] sm:flex-row sm:items-center sm:gap-2.5"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span className="shrink-0" style={{ color: moduleFg(templateKind(svc)) }}>
                      <ModuleLogo kind={templateKind(svc)} size={15} />
                    </span>
                    <span className="truncate font-mono text-[11px] sm:w-32 sm:shrink-0">
                      {slugPreview(stackPrefix) || tplPlan.prefix}
                      {svc.slug.slice(tplPlan.prefix.length)}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1 truncate pl-[25px] font-mono text-[11px] text-subtle sm:pl-0">
                    {svc.image}
                  </span>
                  {svc.public && (
                    <span className="ml-[25px] w-fit shrink-0 rounded-full bg-surface2 px-1.5 py-0.5 text-[10px] text-sub sm:ml-0">
                      entrada pública
                    </span>
                  )}
                </div>
              ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Prefijo de los servicios">
              <input
                className="input font-mono"
                value={stackPrefix}
                onChange={(e) => setStackPrefix(e.target.value)}
                placeholder={tplPlan.prefix}
              />
            </Field>
            <Field label="Dominio (opcional)" hint="Va al servicio de entrada de la plantilla">
              <input
                className="input font-mono"
                placeholder="app.midominio.com"
                value={stackDomain}
                onChange={(e) => setStackDomain(e.target.value)}
              />
            </Field>
          </div>

          {(tplPlan.warnings.length > 0 || tplPlan.services.some((s) => s.notes.length > 0)) && (
            <ul className="space-y-1 text-[11px] text-subtle">
              {tplPlan.warnings.map((w) => (
                <li key={w} className="flex gap-1.5">
                  <span aria-hidden>·</span>
                  <span>{w}</span>
                </li>
              ))}
              {tplPlan.services.flatMap((s) =>
                s.notes.map((n) => (
                  <li key={`${s.slug}-${n}`} className="flex gap-1.5">
                    <span aria-hidden>·</span>
                    <span>
                      <span className="font-mono">{s.templateName}</span>: {n}
                    </span>
                  </li>
                )),
              )}
            </ul>
          )}

          <div className="flex justify-between pt-1">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setTplPlan(null);
                setStackDomain('');
              }}
            >
              Atrás
            </Button>
            <Button type="submit" loading={createTemplate.isPending}>
              Crear y desplegar {tplPlan.services.length} servicios
            </Button>
          </div>
        </form>
      )}

      {step === 'stack' && selectedStack && (
        <form onSubmit={submitStack} className="space-y-4">
          <div className="flex items-start gap-3">
            <span style={{ color: moduleFg(asKind(selectedStack.icon)) }}>
              <ModuleLogo kind={asKind(selectedStack.icon)} size={26} />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium">{selectedStack.label}</h3>
              <p className="mt-0.5 text-xs text-sub">{selectedStack.description}</p>
            </div>
            <a
              href={selectedStack.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="flex shrink-0 items-center gap-1 text-[11px] text-sub hover:text-txt"
            >
              Documentación <ExternalLink size={11} />
            </a>
          </div>

          <div className="rounded-lg border border-line bg-bg p-1.5">
            {selectedStack.services.map((svc) => (
              <div
                key={svc.key}
                className="flex flex-col gap-0.5 px-2.5 py-[7px] sm:flex-row sm:items-center sm:gap-2.5"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="shrink-0" style={{ color: moduleFg(asKind(svc.icon)) }}>
                    <ModuleLogo kind={asKind(svc.icon)} size={15} />
                  </span>
                  <span className="truncate font-mono text-[11px] sm:w-28 sm:shrink-0">
                    {slugPreview(stackPrefix) || selectedStack.defaultPrefix}-{svc.key}
                  </span>
                </span>
                <span className="min-w-0 flex-1 truncate pl-[25px] text-[11px] text-sub sm:pl-0">
                  {svc.description}
                </span>
                {svc.public && (
                  <span className="ml-[25px] w-fit shrink-0 rounded-full bg-surface2 px-1.5 py-0.5 text-[10px] text-sub sm:ml-0">
                    entrada pública
                  </span>
                )}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Prefijo de los servicios" hint="Da nombre a cada servicio de la pila">
              <input
                className="input font-mono"
                value={stackPrefix}
                onChange={(e) => setStackPrefix(e.target.value)}
                placeholder={selectedStack.defaultPrefix}
              />
            </Field>
            <Field
              label="Dominio (opcional)"
              hint="Sin dominio la pila solo es accesible dentro del proyecto; puedes añadirlo después"
            >
              <input
                className="input font-mono"
                placeholder="app.midominio.com"
                value={stackDomain}
                onChange={(e) => setStackDomain(e.target.value)}
              />
            </Field>
          </div>

          <ul className="space-y-1 text-[11px] text-subtle">
            {selectedStack.notes.map((note) => (
              <li key={note} className="flex gap-1.5">
                <span aria-hidden>·</span>
                <span>{note}</span>
              </li>
            ))}
          </ul>

          <div className="flex justify-between pt-1">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setStackKey(null);
                setStackDomain('');
              }}
            >
              Atrás
            </Button>
            <Button type="submit" loading={createStack.isPending}>
              Crear y desplegar {selectedStack.services.length} servicios
            </Button>
          </div>
        </form>
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
          {hasSources ? (
            <Field
              label="Cuenta de GitHub"
              hint="Eliges el repo de la cuenta conectada; «URL manual» clona con el token global del servidor"
            >
              <GithubSourceSelect
                sources={sources}
                value={source}
                onChange={(next) => {
                  setSource(next);
                  // Al cambiar de cuenta, el repo elegido deja de tener sentido.
                  setRepoUrl('');
                  setRepoFilter('');
                  setBranch('main');
                }}
              />
            </Field>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-line bg-bg px-3.5 py-3">
              <p className="min-w-0 flex-1 text-[11px] text-sub">
                Sin cuenta de GitHub conectada solo se pueden clonar repositorios públicos. Conéctala y eliges tus repos
                privados de una lista, sin pegar URLs ni tokens.
              </p>
              {sources.appConfigured && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    window.location.href = `/api/github/app/install?projectId=${encodeURIComponent(projectId)}`;
                  }}
                >
                  <ModuleLogo kind="github" size={13} /> Conectar con GitHub
                </Button>
              )}
            </div>
          )}

          {source.kind !== 'none' ? (
            <Field label="Repositorio" hint={selectedRepo ? undefined : 'Elige un repo de la cuenta conectada'}>
              <GithubRepoPicker
                source={source}
                selected={selectedRepo}
                filter={repoFilter}
                onFilter={setRepoFilter}
                onPick={pickRepo}
                enabled={open && step === 'git'}
              />
            </Field>
          ) : (
            <Field
              label="Repositorio"
              hint="URL completa o atajo owner/repo. Para repos privados conecta una cuenta de GitHub o usa el token de Ajustes."
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
              {source.kind !== 'none' && (branches.data?.branches.length ?? 0) > 0 ? (
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
            <Field label="Puerto de la app" hint="Vacío = se detecta del EXPOSE de la imagen (y si no lo declara, 3000)">
              <input
                className="input"
                type="number"
                placeholder="automático"
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
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
