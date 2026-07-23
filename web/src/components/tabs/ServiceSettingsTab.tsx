import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronRight, Cpu, Globe, HardDrive, Plus, X } from 'lucide-react';
import { api } from '../../api';
import { GithubConnector, Service } from '../../types';
import { cx } from '../../utils';
import DomainsEditor from '../DomainsEditor';
import { ModuleLogo, moduleKind } from '../ModuleIcon';
import { Button, ConfirmModal, CopyButton, EditorBar, Field, useFlash, useToast } from '../ui';

/** Card de sección: el icono anota el título a escala de texto, sin caja. */
function SectionCard({
  icon,
  iconClass,
  title,
  description,
  children,
  className,
}: {
  icon: React.ReactNode;
  iconClass: string;
  title: string;
  description: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('rounded-xl border border-line bg-bg p-4', className)}>
      <div className="mb-3.5">
        <h3 className="flex items-center gap-2 text-[13px] font-semibold">
          <span aria-hidden className={cx('[&>svg]:block', iconClass)}>
            {icon}
          </span>
          {title}
        </h3>
        <p className="mt-1 text-[11px] text-subtle">{description}</p>
      </div>
      {children}
    </section>
  );
}

interface FormState {
  name: string;
  repoUrl: string;
  connectorId: string;
  branch: string;
  rootDir: string;
  dockerfilePath: string;
  startCmd: string;
  port: string;
  version: string;
  image: string;
  domains: string[];
  hostPort: string;
  cpus: string;
  memoryMb: string;
  diskMb: string;
  alertsMuted: boolean;
  autoDeploy: boolean;
  healthcheckPath: string;
  replicas: string;
  volumePaths: string[];
}

function formFromService(service: Service): FormState {
  const cfg = service.config;
  const isImage = service.type === 'image';
  return {
    name: service.name,
    repoUrl: cfg.repoUrl ?? '',
    connectorId: cfg.connectorId ?? '',
    branch: cfg.branch ?? 'main',
    rootDir: cfg.rootDir ?? '',
    dockerfilePath: cfg.dockerfilePath ?? '',
    startCmd: cfg.startCmd ?? '',
    port: isImage ? (cfg.port ? String(cfg.port) : '') : String(cfg.port ?? 3000),
    version: cfg.version ?? '',
    image: cfg.image ?? '',
    domains: cfg.domains ?? [],
    hostPort: cfg.hostPort ? String(cfg.hostPort) : '',
    cpus: cfg.cpus ? String(cfg.cpus) : '',
    memoryMb: cfg.memoryMb ? String(cfg.memoryMb) : '',
    diskMb: cfg.diskMb ? String(cfg.diskMb) : '',
    alertsMuted: !!(cfg as any).alertsMuted,
    // Opt-out: ausente = activado (solo `false` lo desactiva).
    autoDeploy: (cfg as any).autoDeploy !== false,
    healthcheckPath: cfg.healthcheckPath ?? '',
    replicas: String((cfg as any).replicas ?? 1),
    volumePaths: ((cfg as any).volumes ?? []).map((v: { containerPath: string }) => v.containerPath),
  };
}

export default function ServiceSettingsTab({
  service,
  projectId,
  onChanged,
  onDeleted,
  onNeedsRedeploy,
}: {
  service: Service;
  projectId: string;
  onChanged: () => void;
  onDeleted: () => void;
  /** Aviso al panel de que hay cambios guardados que solo surten efecto al redesplegar. */
  onNeedsRedeploy?: () => void;
}) {
  const toast = useToast();
  const isGit = service.type === 'git';
  const isImage = service.type === 'image';
  const isDb = service.type === 'database';
  const hasDomains = isGit || isImage;
  const cfg = service.config;

  const [baseline, setBaseline] = useState<FormState>(() => formFromService(service));
  const [form, setForm] = useState<FormState>(baseline);
  const [newVolumePath, setNewVolumePath] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteVolumes, setDeleteVolumes] = useState(false);

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(baseline), [form, baseline]);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const connectors = useQuery({
    queryKey: ['connectors', projectId],
    queryFn: () => api.get<{ connectors: GithubConnector[]; hasGlobalToken: boolean }>(`/projects/${projectId}/connectors`),
    enabled: isGit,
    staleTime: 30_000,
  });
  const connectorList = connectors.data?.connectors ?? [];
  // Conector borrado pero aún referenciado: se muestra para poder quitarlo. Solo
  // se da por colgante con la lista cargada; si no, un guardado lo borraría sin querer.
  const danglingConnector = !!connectors.data && !!form.connectorId && !connectorList.some((c) => c.id === form.connectorId);

  const [saved, flashSaved] = useFlash();
  const save = useMutation({
    mutationFn: () => {
      const config: Record<string, unknown> = {
        hostPort: form.hostPort ? Number(form.hostPort) : null,
        cpus: form.cpus ? Number(form.cpus) : null,
        memoryMb: form.memoryMb ? Number(form.memoryMb) : null,
        diskMb: form.diskMb ? Number(form.diskMb) : null,
        alertsMuted: form.alertsMuted,
        ...(!isDb
          ? {
              healthcheckPath: form.healthcheckPath.trim() || null,
              volumes: form.volumePaths.map((p) => ({ containerPath: p })),
              replicas: Math.max(1, Number(form.replicas) || 1),
            }
          : {}),
      };
      if (isGit) {
        Object.assign(config, {
          // Un id colgante (conector borrado) se limpia al guardar: el servidor lo rechazaría.
          connectorId: danglingConnector ? null : form.connectorId || null,
          repoUrl: form.repoUrl.trim(),
          branch: form.branch.trim() || 'main',
          rootDir: form.rootDir.trim() || null,
          dockerfilePath: form.dockerfilePath.trim() || null,
          startCmd: form.startCmd.trim() || null,
          port: Number(form.port) || 3000,
          domains: form.domains,
          autoDeploy: form.autoDeploy,
        });
      } else if (isImage) {
        Object.assign(config, {
          image: form.image.trim() || cfg.image,
          startCmd: form.startCmd.trim() || null,
          port: form.port ? Number(form.port) : null,
          domains: form.domains,
        });
      } else {
        Object.assign(config, { version: form.version.trim() || cfg.version });
      }
      return api.patch<{ service: Service; needsRedeploy: boolean }>(`/services/${service.id}`, { name: form.name, config });
    },
    onSuccess: (data) => {
      setBaseline(form);
      flashSaved();
      toast(data.needsRedeploy ? 'Guardado. Redespliega para aplicar los cambios.' : 'Guardado y aplicado.', 'ok');
      if (data.needsRedeploy) onNeedsRedeploy?.();
      onChanged();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/services/${service.id}?volumes=${deleteVolumes}`),
    onSuccess: () => {
      toast('Servicio eliminado', 'ok');
      onDeleted();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const addVolume = () => {
    const p = newVolumePath.trim();
    if (p.startsWith('/') && !form.volumePaths.includes(p)) {
      set('volumePaths', [...form.volumePaths, p]);
      setNewVolumePath('');
    }
  };

  const webhookUrl = `${window.location.origin}/api/webhooks/github/${service.id}`;
  const replicasN = Number(form.replicas) || 1;

  return (
    <>
      <div className="flex flex-col gap-3.5 p-4 pb-0 sm:px-5">
        <SectionCard
          icon={<ModuleLogo kind={moduleKind(service)} size={14} />}
          iconClass="text-txt"
          title="General"
          description="Origen, build y arranque del servicio"
        >
          <div className="flex flex-col gap-3">
            <Field label="Nombre">
              <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} />
            </Field>

            {isGit ? (
              <>
                <Field label="Repositorio">
                  <input className="input font-mono text-xs" value={form.repoUrl} onChange={(e) => set('repoUrl', e.target.value)} />
                </Field>
                {(connectorList.length > 0 || danglingConnector) && (
                  <Field
                    label="Cuenta de GitHub para clonar"
                    hint="Conector del proyecto (repos del cliente) o el token global del servidor"
                    error={danglingConnector ? 'El conector elegido ya no existe: se usará el token global hasta que elijas otro' : null}
                  >
                    <select className="input" value={form.connectorId} onChange={(e) => set('connectorId', e.target.value)}>
                      <option value="">Token global del servidor</option>
                      {connectorList.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} · @{c.gh_login}
                        </option>
                      ))}
                      {danglingConnector && (
                        <option value={form.connectorId} disabled>
                          (conector eliminado)
                        </option>
                      )}
                    </select>
                  </Field>
                )}
                <div className="grid grid-cols-2 gap-2.5">
                  <Field label="Rama">
                    <input className="input" value={form.branch} onChange={(e) => set('branch', e.target.value)} />
                  </Field>
                  <Field label="Puerto interno">
                    <input className="input tnum" type="number" value={form.port} onChange={(e) => set('port', e.target.value)} />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <Field label="Directorio raíz" hint="vacío = raíz del repo">
                    <input className="input" placeholder="apps/api" value={form.rootDir} onChange={(e) => set('rootDir', e.target.value)} />
                  </Field>
                  <Field label="Dockerfile" hint="vacío = Dockerfile">
                    <input className="input" placeholder="Dockerfile" value={form.dockerfilePath} onChange={(e) => set('dockerfilePath', e.target.value)} />
                  </Field>
                </div>
                <Field label="Comando de arranque" hint="Opcional: sobreescribe el CMD de la imagen">
                  <input
                    className="input font-mono text-xs"
                    value={form.startCmd}
                    onChange={(e) => set('startCmd', e.target.value)}
                    placeholder="npm run start"
                  />
                </Field>
                <Field
                  label="Ruta de healthcheck"
                  hint="Opcional, ej: /health. Si responde 2xx la nueva versión se considera sana: despliegues sin corte con marcha atrás automática."
                >
                  <input
                    className="input font-mono text-xs"
                    value={form.healthcheckPath}
                    onChange={(e) => set('healthcheckPath', e.target.value)}
                    placeholder="/health"
                  />
                </Field>
              </>
            ) : isImage ? (
              <>
                <Field label="Imagen" hint="Cambiarla requiere redesplegar">
                  <input className="input font-mono text-xs" value={form.image} onChange={(e) => set('image', e.target.value)} />
                </Field>
                <div className="grid grid-cols-2 gap-2.5">
                  <Field label="Puerto interno" hint="vacío = sin HTTP">
                    <input className="input tnum" type="number" value={form.port} onChange={(e) => set('port', e.target.value)} />
                  </Field>
                  <Field label="Comando de arranque" hint="opcional">
                    <input className="input font-mono text-xs" value={form.startCmd} onChange={(e) => set('startCmd', e.target.value)} />
                  </Field>
                </div>
                <Field label="Ruta de healthcheck" hint="Opcional, ej: /healthz. Activa despliegues validados con marcha atrás automática.">
                  <input
                    className="input font-mono text-xs"
                    value={form.healthcheckPath}
                    onChange={(e) => set('healthcheckPath', e.target.value)}
                    placeholder="/healthz"
                  />
                </Field>
              </>
            ) : (
              <Field label="Versión de la imagen" hint={`Imagen: ${cfg.template}`}>
                <input className="input font-mono text-xs" value={form.version} onChange={(e) => set('version', e.target.value)} />
              </Field>
            )}
          </div>
        </SectionCard>

        {hasDomains && (
          <SectionCard
            icon={<Globe size={14} />}
            iconClass="text-info"
            title="Dominios"
            description="Traefik enruta 80/443 con TLS automático si está configurado"
          >
            <DomainsEditor domains={form.domains} onChange={(d) => set('domains', d)} slug={service.slug} />
          </SectionCard>
        )}

        {!isDb && (
          <SectionCard
            icon={<HardDrive size={14} />}
            iconClass="text-warn"
            title="Volúmenes persistentes"
            description="Rutas que sobreviven a los redespliegues"
          >
            <div className="flex flex-col gap-2">
              {form.volumePaths.map((p) => (
                <div key={p} className="flex items-center justify-between rounded-lg border border-line bg-surface px-3 py-2">
                  <span className="font-mono text-xs">{p}</span>
                  <button
                    onClick={() => set('volumePaths', form.volumePaths.filter((x) => x !== p))}
                    className="rounded p-0.5 text-subtle transition-colors hover:text-err"
                    title="Quitar"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
              <div className="flex gap-2">
                <input
                  className="input flex-1 font-mono text-xs"
                  placeholder="/app/uploads"
                  value={newVolumePath}
                  onChange={(e) => setNewVolumePath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addVolume();
                    }
                  }}
                />
                <Button size="sm" variant="secondary" className="h-9" onClick={addVolume}>
                  <Plus size={13} />
                </Button>
              </div>
              <p className="text-[11px] text-subtle">
                Ojo: con volúmenes el despliegue deja de ser de corte cero (no pueden convivir dos instancias escribiendo a la
                vez). Quitar una ruta no borra el volumen de Docker.
              </p>
            </div>
          </SectionCard>
        )}

        <SectionCard
          icon={<Cpu size={14} />}
          iconClass="text-acc-soft"
          title={isDb ? 'Recursos y red' : 'Recursos y réplicas'}
          description="Los límites se aplican en caliente, sin reiniciar"
        >
          <div className={cx('grid gap-2.5 grid-cols-2', isDb ? 'sm:grid-cols-4' : 'sm:grid-cols-5')}>
            <Field label="CPUs" hint="vacío = sin límite">
              <input className="input tnum" type="number" step="0.1" min="0.1" placeholder="1.5" value={form.cpus} onChange={(e) => set('cpus', e.target.value)} />
            </Field>
            <Field label="RAM (MB)" hint="vacío = sin límite">
              <input className="input tnum" type="number" min="32" placeholder="512" value={form.memoryMb} onChange={(e) => set('memoryMb', e.target.value)} />
            </Field>
            <Field label="Disco (MB)" hint="espacio asignado: avisa al superarlo">
              <input className="input tnum" type="number" min="64" placeholder="2048" value={form.diskMb} onChange={(e) => set('diskMb', e.target.value)} />
            </Field>
            <Field label="Puerto público" hint="expone TCP en el host">
              <input className="input tnum" type="number" placeholder={isGit ? '8080' : '5432'} value={form.hostPort} onChange={(e) => set('hostPort', e.target.value)} />
            </Field>
            {!isDb && (
              <Field label="Réplicas" hint="copias en balanceo">
                <input className="input tnum" type="number" min="1" max="10" value={form.replicas} onChange={(e) => set('replicas', e.target.value)} />
              </Field>
            )}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-subtle">
            El espacio asignado (volúmenes + escritura del contenedor) es orientativo: Docker no corta el disco en seco,
            pero Skyway lo vigila y te alerta al superarlo. Consúltalo en Monitor.
          </p>
          {!isDb && replicasN > 1 && (
            <p className="mt-2.5 rounded-lg border border-acc/30 bg-acc/[.08] px-3 py-2.5 text-xs text-sub">
              Con {replicasN} réplicas el tráfico se reparte y los despliegues son rodantes: siempre queda una sirviendo.
              Requiere servicio <strong className="text-txt">sin volúmenes ni puerto público</strong>
              {(form.volumePaths.length > 0 || form.hostPort) && (
                <span className="text-err"> — ahora mismo lo incumples: quítalos antes de guardar</span>
              )}
              .
            </p>
          )}
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-[13px] text-sub">
            <input
              type="checkbox"
              checked={form.alertsMuted}
              onChange={(e) => set('alertsMuted', e.target.checked)}
              className="h-[15px] w-[15px] accent-acc"
            />
            Silenciar alertas de este servicio
          </label>
        </SectionCard>

        {isGit && (
          <SectionCard
            icon={<ModuleLogo kind="github" size={14} />}
            iconClass="text-txt"
            title="Auto-deploy"
            description="Despliega solo al detectar un commit nuevo en la rama"
          >
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-surface px-3 py-2.5">
              <input
                type="checkbox"
                checked={form.autoDeploy}
                onChange={(e) => set('autoDeploy', e.target.checked)}
                className="mt-0.5 h-[15px] w-[15px] shrink-0 accent-acc"
              />
              <span className="text-[13px]">
                <span className="font-medium">Auto-desplegar al hacer push a <span className="font-mono">{form.branch}</span></span>
                <span className="mt-1 block text-[11px] leading-relaxed text-subtle">
                  Skyway vigila la rama y redespliega al detectar un commit nuevo, sin tocar GitHub (usa el mismo acceso con el
                  que clona: va bien para repos privados o servidores sin dominio). El interruptor manda sobre las dos vías
                  —sondeo y webhook—: apágalo y ningún push desplegará.
                </span>
              </span>
            </label>

            <details className="group mt-2.5">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-subtle transition-colors hover:text-sub">
                <ChevronRight size={12} className="shrink-0 text-subtle transition-transform group-open:rotate-90" />
                ¿Lo quieres instantáneo? Configura además el webhook de GitHub
              </summary>
              <div className="details-body mt-2 flex flex-col gap-2 text-xs">
                <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2">
                  <span className="shrink-0 text-subtle">URL</span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-mono text-[11px]">{webhookUrl}</span>
                    <CopyButton value={webhookUrl} />
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2">
                  <span className="text-subtle">Secreto</span>
                  <span className="flex items-center gap-1.5">
                    <span className="font-mono text-[11px]">••••••••••••</span>
                    <CopyButton value={cfg.webhookSecret ?? ''} />
                  </span>
                </div>
                <p className="text-[11px] text-subtle">
                  En GitHub: Settings → Webhooks → Add webhook. Content type <span className="font-mono">application/json</span>{' '}
                  (no <span className="font-mono">x-www-form-urlencoded</span>), evento <span className="font-mono">push</span>.
                  Despliega en el acto; requiere que GitHub alcance tu servidor (dominio público). Obedece el interruptor de
                  arriba y no se pisa con el sondeo: nunca se despliega dos veces el mismo commit.
                </p>
              </div>
            </details>
          </SectionCard>
        )}

        <section className="mb-3.5 rounded-xl border border-err/30 bg-err/[.06] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-[13px] font-semibold text-err">Zona de peligro</h3>
              <p className="mt-0.5 text-[11px] text-sub">Elimina el servicio y su contenedor. Los volúmenes solo si lo marcas.</p>
            </div>
            <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>
              Eliminar servicio
            </Button>
          </div>
        </section>
      </div>

      <EditorBar
        dirty={dirty}
        saving={save.isPending}
        saved={saved}
        onSave={() => save.mutate()}
        onDiscard={() => setForm(baseline)}
      />

      <ConfirmModal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => remove.mutate()}
        loading={remove.isPending}
        title={`Eliminar "${service.name}"`}
        message="Se detendrá y eliminará el contenedor de este servicio."
      >
        <label className="mt-3 flex items-center gap-2 text-sm text-sub">
          <input type="checkbox" checked={deleteVolumes} onChange={(e) => setDeleteVolumes(e.target.checked)} className="accent-acc" />
          Eliminar también el volumen de datos
        </label>
      </ConfirmModal>
    </>
  );
}
