import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Cpu, Globe, HardDrive, Plus, X } from 'lucide-react';
import { api } from '../../api';
import { Service } from '../../types';
import { cx } from '../../utils';
import DomainsEditor from '../DomainsEditor';
import { ModuleLogo, moduleKind } from '../ModuleIcon';
import { Button, ConfirmModal, CopyButton, Field, useFlash, useToast } from '../ui';

/** Card de sección con cabecera icono-chip + título + descripción. */
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
      <div className="mb-3.5 flex items-center gap-2.5">
        <span className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', iconClass)}>{icon}</span>
        <div>
          <h3 className="text-[13px] font-semibold">{title}</h3>
          <p className="mt-px text-[11px] text-subtle">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

interface FormState {
  name: string;
  repoUrl: string;
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
}: {
  service: Service;
  projectId: string;
  onChanged: () => void;
  onDeleted: () => void;
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
          repoUrl: form.repoUrl.trim(),
          branch: form.branch.trim() || 'main',
          rootDir: form.rootDir.trim() || null,
          dockerfilePath: form.dockerfilePath.trim() || null,
          startCmd: form.startCmd.trim() || null,
          port: Number(form.port) || 3000,
          domains: form.domains,
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
          iconClass="bg-txt/[.09] text-txt"
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
                    <input className="input" value={form.rootDir} onChange={(e) => set('rootDir', e.target.value)} />
                  </Field>
                  <Field label="Dockerfile" hint="vacío = Dockerfile">
                    <input className="input" value={form.dockerfilePath} onChange={(e) => set('dockerfilePath', e.target.value)} />
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
            iconClass="bg-info/[.14] text-info"
            title="Dominios"
            description="Traefik enruta 80/443 con TLS automático si está configurado"
          >
            <DomainsEditor domains={form.domains} onChange={(d) => set('domains', d)} slug={service.slug} />
          </SectionCard>
        )}

        {!isDb && (
          <SectionCard
            icon={<HardDrive size={14} />}
            iconClass="bg-warn/[.13] text-warn"
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
          iconClass="bg-acc/[.15] text-acc-soft"
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
            <p className="mt-2.5 rounded-lg border border-acc/25 bg-acc/[.07] px-3 py-2.5 text-xs text-sub">
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
            iconClass="bg-txt/[.09] text-txt"
            title="Auto-deploy"
            description="Webhook de GitHub — cada push a la rama despliega"
          >
            <div className="flex flex-col gap-2 text-xs">
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
                En GitHub: Settings → Webhooks → Add webhook. Content type <span className="font-mono">application/json</span>,
                evento <span className="font-mono">push</span>. Cada push a <span className="font-mono">{form.branch}</span>{' '}
                desplegará automáticamente.
              </p>
            </div>
          </SectionCard>
        )}

        <section className="mb-3.5 rounded-xl border border-err/30 bg-err/[.04] p-4">
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

      <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-line bg-surface/[.92] px-4 py-2.5 backdrop-blur-lg sm:px-5">
        {dirty ? (
          <span className="flex items-center gap-[7px] text-xs text-warn">
            <span className="pulse-soft h-1.5 w-1.5 rounded-full bg-current" />
            Tienes cambios sin guardar
          </span>
        ) : (
          <span className="text-xs text-subtle">Sin cambios</span>
        )}
        <div className="flex items-center gap-2">
          {dirty && (
            <Button variant="ghost" size="sm" onClick={() => setForm(baseline)}>
              Descartar
            </Button>
          )}
          <Button size="sm" onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty} success={saved && !dirty}>
            Guardar cambios
          </Button>
        </div>
      </div>

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
