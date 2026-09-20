import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronRight, Cpu, FileText, Globe, HardDrive, Network, Plus, X } from 'lucide-react';
import { api } from '../../api';
import { DbTemplate, Service } from '../../types';
import { cx } from '../../utils';
import DomainsEditor from '../DomainsEditor';
import {
  GithubSource,
  GithubSourceSelect,
  NO_SOURCE,
  RepoAccessHint,
  sourceFromConfig,
  sourceStillConnected,
  sourceToConfig,
  useGithubSources,
} from '../GithubSource';
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
  /** Opcional: si el título ya lo dice todo, una descripción solo repite. */
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('rounded-xl border border-line bg-bg p-4', className)}>
      <div className="mb-3.5">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <span aria-hidden className={cx('[&>svg]:block', iconClass)}>
            {icon}
          </span>
          {title}
        </h3>
        {description && <p className="mt-1 text-xs text-subtle">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/**
 * Lo que se toca una vez en la vida (Dockerfile, comandos, healthcheck) va
 * plegado: mezclado con el nombre y la rama convertía «General» en doce campos
 * seguidos donde lo frecuente costaba lo mismo de encontrar que lo raro.
 */
function Avanzado({ children, resumen }: { children: React.ReactNode; resumen: string }) {
  return (
    <details className="animate-details group rounded-lg border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm text-sub transition-colors hover:text-txt">
        <ChevronRight size={13} className="shrink-0 text-subtle transition-transform group-open:rotate-90" />
        <span className="font-medium">Avanzado</span>
        <span className="min-w-0 flex-1 truncate text-xs text-subtle">{resumen}</span>
      </summary>
      <div className="details-body flex flex-col gap-3 border-t border-line px-3 py-3">{children}</div>
    </details>
  );
}

interface FormState {
  name: string;
  repoUrl: string;
  /** Cuenta de GitHub con la que clonar: instalación de la App o token personal. */
  source: GithubSource;
  branch: string;
  rootDir: string;
  dockerfilePath: string;
  builder: 'auto' | 'dockerfile' | 'nixpacks';
  startCmd: string;
  buildCmd: string;
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
  autoImportEnv: boolean;
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
    source: sourceFromConfig(cfg),
    branch: cfg.branch ?? 'main',
    rootDir: cfg.rootDir ?? '',
    dockerfilePath: cfg.dockerfilePath ?? '',
    builder: cfg.builder ?? 'auto',
    startCmd: cfg.startCmd ?? '',
    buildCmd: (cfg as any).buildCmd ?? '',
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
    autoImportEnv: cfg.autoImportEnv !== false,
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
  onDirtyChange,
}: {
  service: Service;
  projectId: string;
  onChanged: () => void;
  onDeleted: () => void;
  /** Aviso al panel de que hay cambios guardados que solo surten efecto al redesplegar. */
  onNeedsRedeploy?: () => void;
  /** Avisa al panel de si hay cambios sin guardar, para que pida confirmación al cerrar o cambiar de pestaña. */
  onDirtyChange?: (dirty: boolean) => void;
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

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  // Si el servicio cambia por fuera (otro usuario, un despliegue que fija el
  // puerto detectado) y aquí no hay nada sin guardar, el formulario se pone al
  // día. Con cambios a medias no se pisa lo que se está escribiendo.
  useEffect(() => {
    if (dirty) return;
    const fresh = formFromService(service);
    if (JSON.stringify(fresh) === JSON.stringify(baseline)) return;
    setBaseline(fresh);
    setForm(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service]);

  const sources = useGithubSources(projectId, isGit);
  const hasSources = sources.installations.length > 0 || sources.connectors.length > 0;
  // Cuenta desconectada pero aún referenciada: hay que verlo para poder cambiarla.
  // Solo se da por colgante con las listas ya cargadas; si no, guardar mientras
  // las consultas están en vuelo la borraría sin querer.
  const danglingSource = !sources.isLoading && !sourceStillConnected(form.source, sources);

  // El puerto interno de una base de datos lo fija su plantilla, no el
  // formulario: hay que preguntarlo para poder anunciar la dirección completa.
  const dbTemplates = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.get<{ templates: DbTemplate[] }>('/templates'),
    enabled: isDb,
    staleTime: 300_000,
  });

  /**
   * Dirección del servicio dentro de la red del proyecto: el alias de red es su
   * slug (`runContainer` en `docker/containers.ts`). Se toma de la configuración
   * guardada y no del formulario, porque un puerto a medio escribir todavía no
   * es la dirección por la que se llega.
   */
  const internalPort = isDb
    ? dbTemplates.data?.templates.find((t) => t.key === cfg.template)?.port
    : cfg.port;
  const internalAddress = internalPort ? `${service.slug}:${internalPort}` : service.slug;

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
          // Un id colgante (cuenta desconectada) se limpia al guardar: el servidor lo rechazaría.
          ...sourceToConfig(danglingSource ? NO_SOURCE : form.source),
          repoUrl: form.repoUrl.trim(),
          branch: form.branch.trim() || 'main',
          rootDir: form.rootDir.trim() || null,
          dockerfilePath: form.dockerfilePath.trim() || null,
          builder: form.builder,
          startCmd: form.startCmd.trim() || null,
          buildCmd: form.buildCmd.trim() || null,
          port: Number(form.port) || 3000,
          domains: form.domains,
          autoDeploy: form.autoDeploy,
          autoImportEnv: form.autoImportEnv,
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
      toast(data.needsRedeploy ? 'Cambios guardados. Es necesario volver a desplegar para aplicarlos.' : 'Cambios guardados y aplicados.', 'ok');
      if (data.needsRedeploy) onNeedsRedeploy?.();
      onChanged();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/services/${service.id}?volumes=${deleteVolumes}`),
    onSuccess: () => {
      toast('Servicio eliminado.', 'ok');
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
          description="Origen, compilación y arranque del servicio"
        >
          <div className="flex flex-col gap-3">
            <Field label="Nombre">
              <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} />
            </Field>

            {isGit ? (
              <>
                <Field label="Repositorio">
                  <input
                    className="input font-mono sm:text-xs"
                    value={form.repoUrl}
                    onChange={(e) => set('repoUrl', e.target.value)}
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  {/* Solo cuando cambia algo: el repo guardado ya se sabe que clona (o no) por sus despliegues. */}
                  <RepoAccessHint
                    source={danglingSource ? NO_SOURCE : form.source}
                    repo={form.repoUrl}
                    projectId={projectId}
                    enabled={dirty && (form.repoUrl !== baseline.repoUrl || form.source !== baseline.source)}
                  />
                </Field>
                {(hasSources || danglingSource) && (
                  <Field
                    label="Cuenta de GitHub para clonar"
                    hint="Cuenta conectada al proyecto (App o token), o el token global del servidor"
                    error={
                      danglingSource
                        ? 'La cuenta asociada a este servicio ya no está conectada. Se usará el token global hasta que se seleccione otra.'
                        : null
                    }
                  >
                    <GithubSourceSelect
                      sources={sources}
                      value={danglingSource ? NO_SOURCE : form.source}
                      onChange={(next) => set('source', next)}
                    />
                  </Field>
                )}
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <Field label="Rama">
                    <input className="input" value={form.branch} onChange={(e) => set('branch', e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                  </Field>
                  <Field label="Puerto interno">
                    <input className="input tnum" type="number" inputMode="numeric" value={form.port} onChange={(e) => set('port', e.target.value)} />
                  </Field>
                </div>
                <Avanzado resumen="Directorio, Dockerfile, constructor, comandos y healthcheck">
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <Field label="Directorio raíz" hint="Vacío: raíz del repositorio">
                      <input className="input" placeholder="apps/api" value={form.rootDir} onChange={(e) => set('rootDir', e.target.value)} />
                    </Field>
                    <Field label="Dockerfile" hint="Vacío: Dockerfile">
                      <input className="input" placeholder="Dockerfile" value={form.dockerfilePath} onChange={(e) => set('dockerfilePath', e.target.value)} />
                    </Field>
                  </div>
                  <Field label="Constructor" hint="Automático: Dockerfile si existe; en caso contrario, Nixpacks.">
                    <select className="input" value={form.builder} onChange={(e) => set('builder', e.target.value as FormState['builder'])}>
                      <option value="auto">Automático (recomendado)</option>
                      <option value="dockerfile">Dockerfile del repositorio</option>
                      <option value="nixpacks">Nixpacks</option>
                    </select>
                  </Field>
                  <Field label="Comando de arranque" hint="Opcional. Sobrescribe el CMD de la imagen.">
                    <input
                      className="input font-mono text-xs"
                      value={form.startCmd}
                      onChange={(e) => set('startCmd', e.target.value)}
                      placeholder="npm run start"
                    />
                  </Field>
                  <Field label="Comando de compilación" hint="Solo se aplica sin Dockerfile (Nixpacks); con Dockerfile prevalece el Dockerfile.">
                    <input
                      className="input font-mono text-xs"
                      value={form.buildCmd}
                      onChange={(e) => set('buildCmd', e.target.value)}
                      placeholder="npm run build"
                    />
                  </Field>
                  <Field
                    label="Ruta de healthcheck"
                    hint="Opcional, por ejemplo /health. Si responde 2xx, la nueva versión se considera correcta: despliegues sin interrupción con reversión automática."
                  >
                    <input
                      className="input font-mono text-xs"
                      value={form.healthcheckPath}
                      onChange={(e) => set('healthcheckPath', e.target.value)}
                      placeholder="/health"
                    />
                  </Field>
                </Avanzado>
              </>
            ) : isImage ? (
              <>
                <Field label="Imagen" hint="Al cambiarla es necesario volver a desplegar">
                  <input className="input font-mono text-xs" value={form.image} onChange={(e) => set('image', e.target.value)} />
                </Field>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <Field label="Puerto interno" hint="Vacío: sin HTTP">
                    <input className="input tnum" type="number" inputMode="numeric" value={form.port} onChange={(e) => set('port', e.target.value)} />
                  </Field>
                  <Field label="Comando de arranque" hint="Opcional">
                    <input className="input font-mono text-xs" value={form.startCmd} onChange={(e) => set('startCmd', e.target.value)} />
                  </Field>
                </div>
                <Field label="Ruta de healthcheck" hint="Opcional, por ejemplo /healthz. Activa despliegues validados con reversión automática.">
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

        {isGit && (
          <SectionCard icon={<ModuleLogo kind="github" size={14} />} iconClass="text-txt" title="Despliegue automático">
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-surface px-3 py-2.5">
              <input
                type="checkbox"
                checked={form.autoDeploy}
                onChange={(e) => set('autoDeploy', e.target.checked)}
                className="mt-0.5 h-[15px] w-[15px] shrink-0 accent-acc max-sm:h-4 max-sm:w-4"
              />
              <span className="text-sm">
                <span className="font-medium">Desplegar automáticamente al hacer push a <span className="font-mono">{form.branch}</span></span>
                <span className="mt-1 block text-xs leading-relaxed text-subtle">
                  La rama se comprueba cada pocos minutos. Si está desactivado, ningún push inicia un despliegue.
                </span>
              </span>
            </label>

            <details className="group mt-2.5">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-subtle transition-colors hover:text-sub">
                <ChevronRight size={12} className="shrink-0 text-subtle transition-transform group-open:rotate-90" />
                Despliegue inmediato: configurar el webhook de GitHub
              </summary>
              <div className="details-body mt-2 flex flex-col gap-2 text-xs">
                <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2">
                  <span className="shrink-0 text-subtle">URL</span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-mono text-xs">{webhookUrl}</span>
                    <CopyButton value={webhookUrl} />
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2">
                  <span className="text-subtle">Secreto</span>
                  <span className="flex items-center gap-1.5">
                    <span className="font-mono text-xs">••••••••••••</span>
                    <CopyButton value={cfg.webhookSecret ?? ''} />
                  </span>
                </div>
                <ol className="list-decimal space-y-1 pl-5 text-xs text-subtle">
                  <li>
                    En el repositorio: <span className="font-mono">Settings → Webhooks → Add webhook</span>.
                  </li>
                  <li>
                    Introduzca la URL y el secreto; tipo de contenido <span className="font-mono">application/json</span>.
                  </li>
                  <li>
                    Evento: solo <span className="font-mono">push</span>.
                  </li>
                </ol>
              </div>
            </details>
          </SectionCard>
        )}

        {isGit && (
          <SectionCard icon={<FileText size={14} />} iconClass="text-sub" title="Variables del repositorio">
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-surface px-3 py-2.5">
              <input
                type="checkbox"
                checked={form.autoImportEnv}
                onChange={(e) => set('autoImportEnv', e.target.checked)}
                className="mt-0.5 h-[15px] w-[15px] shrink-0 accent-acc max-sm:h-4 max-sm:w-4"
              />
              <span className="text-sm">
                <span className="font-medium">Importar las variables del .env del repositorio al desplegar</span>
                <span className="mt-1 block text-xs leading-relaxed text-subtle">
                  Lee <span className="font-mono">.env.example</span>, <span className="font-mono">.env</span> y similares al
                  clonar y crea las variables que falten. No sobrescribe las variables existentes; las que no tienen valor se
                  indican en la pestaña «Variables».
                </span>
              </span>
            </label>
          </SectionCard>
        )}

        {hasDomains && (
          <SectionCard icon={<Globe size={14} />} iconClass="text-info" title="Dominios">
            {/* Se mira form.port y no cfg.port a propósito: el aviso tiene que salir
                en cuanto se vacía el puerto, antes de guardar, que es cuando
                todavía se puede uno echar atrás. Es la contrapartida del «vacío =
                sin HTTP» del campo de arriba, que invita a dejarlo en blanco sin
                contar que eso deja el dominio de adorno. */}
            {isImage && form.domains.length > 0 && !form.port.trim() && (
              <p className="mb-3 rounded-lg border border-warn/30 bg-warn/[.06] px-3 py-2 text-xs text-warn">
                Sin puerto interno el dominio no funciona: responderá 404 con un certificado que no le corresponde. Indique
                el puerto de escucha en el campo anterior o retire el dominio si el servicio no atiende HTTP.
              </p>
            )}
            <DomainsEditor domains={form.domains} onChange={(d) => set('domains', d)} slug={service.slug} />
          </SectionCard>
        )}

        <SectionCard
          icon={<Network size={14} />}
          iconClass="text-ok"
          title="Dirección interna"
          description="Dirección por la que acceden los demás servicios del proyecto sin salir a Internet"
        >
          <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-mono text-xs">{internalAddress}</span>
              <CopyButton value={internalAddress} />
            </span>
            {!internalPort && <span className="shrink-0 text-xs text-subtle">Sin puerto HTTP</span>}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-subtle">
            Utilice esta dirección en las variables de los demás servicios del proyecto: el dominio público enruta el tráfico a través de Internet.
          </p>
          {/* El puerto público es la otra cara de la misma pregunta —por dónde se
              llega al servicio—, así que vive aquí y no entre los límites de CPU y RAM. */}
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <Field label="Puerto público" hint="Vacío: solo red interna">
              <input className="input tnum" type="number" inputMode="numeric" placeholder={isGit ? '8080' : '5432'} value={form.hostPort} onChange={(e) => set('hostPort', e.target.value)} />
            </Field>
          </div>
        </SectionCard>

        <SectionCard
          icon={<Cpu size={14} />}
          iconClass="text-acc-soft"
          title="Recursos"
          description="Los límites se aplican de inmediato, sin reiniciar el servicio"
        >
          <div className={cx('grid gap-2.5 grid-cols-2', isDb ? 'sm:grid-cols-3' : 'sm:grid-cols-4')}>
            <Field label="CPU" hint="Vacío: sin límite">
              <input className="input tnum" type="number" inputMode="decimal" step="0.1" min="0.1" placeholder="1.5" value={form.cpus} onChange={(e) => set('cpus', e.target.value)} />
            </Field>
            <Field label="RAM (MB)" hint="Vacío: sin límite">
              <input className="input tnum" type="number" inputMode="numeric" min="32" placeholder="512" value={form.memoryMb} onChange={(e) => set('memoryMb', e.target.value)} />
            </Field>
            <Field label="Disco (MB)" hint="No limita el uso: genera un aviso al superarlo.">
              <input className="input tnum" type="number" inputMode="numeric" min="64" placeholder="2048" value={form.diskMb} onChange={(e) => set('diskMb', e.target.value)} />
            </Field>
            {!isDb && (
              <Field label="Réplicas" hint="Instancias con balanceo de carga">
                <input className="input tnum" type="number" inputMode="numeric" min="1" max="10" value={form.replicas} onChange={(e) => set('replicas', e.target.value)} />
              </Field>
            )}
          </div>
          {!isDb && replicasN > 1 && (
            <p className="mt-2.5 rounded-lg border border-acc/30 bg-acc/[.08] px-3 py-2.5 text-xs text-sub">
              Con {replicasN} réplicas el tráfico se distribuye y los despliegues son progresivos: siempre queda una réplica en servicio.
              Requiere un servicio <strong className="text-txt">sin volúmenes ni puerto público</strong>
              {(form.volumePaths.length > 0 || form.hostPort) && (
                <span className="text-err"> — esta condición no se cumple actualmente: retírelos antes de guardar</span>
              )}
              .
            </p>
          )}
          {/* En móvil el rótulo entero es el objetivo táctil: 40 px de alto, no los 15 de la casilla. */}
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-sub max-sm:min-h-10">
            <input
              type="checkbox"
              checked={form.alertsMuted}
              onChange={(e) => set('alertsMuted', e.target.checked)}
              className="h-[15px] w-[15px] accent-acc max-sm:h-4 max-sm:w-4"
            />
            Silenciar alertas de este servicio
          </label>
        </SectionCard>

        {!isDb && (
          <SectionCard
            icon={<HardDrive size={14} />}
            iconClass="text-warn"
            title="Volúmenes persistentes"
            description="Rutas cuyo contenido se conserva entre despliegues"
          >
            <div className="flex flex-col gap-2">
              {form.volumePaths.map((p) => (
                <div key={p} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2 max-sm:py-1">
                  <span className="min-w-0 truncate font-mono text-xs">{p}</span>
                  <button
                    onClick={() => set('volumePaths', form.volumePaths.filter((x) => x !== p))}
                    className="press shrink-0 rounded p-0.5 text-subtle transition-colors hover:text-err max-sm:p-2"
                    title="Quitar"
                    aria-label={`Quitar el volumen ${p}`}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
              <div className="flex gap-2">
                <input
                  className="input min-w-0 flex-1 font-mono sm:text-xs"
                  placeholder="/app/uploads"
                  value={newVolumePath}
                  onChange={(e) => setNewVolumePath(e.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addVolume();
                    }
                  }}
                />
                <Button size="sm" variant="secondary" className="h-9" onClick={addVolume} aria-label="Añadir volumen">
                  <Plus size={13} />
                </Button>
              </div>
              <p className="text-xs text-subtle">
                Con volúmenes, el despliegue implica una breve interrupción. Quitar una ruta no elimina los datos.
              </p>
            </div>
          </SectionCard>
        )}

        {/*
          * Sin fondo rojo permanente: un panel de alarma que está siempre
          * puesto deja de avisar de nada. El borde marca el límite y el color
          * de verdad lo llevan el botón y su confirmación.
          */}
        <section className="mb-3.5 rounded-xl border border-err/30 bg-bg p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-err">Zona de peligro</h3>
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
        title={`Eliminar «${service.name}»`}
        message="Se detendrá y se eliminará el contenedor de este servicio."
      >
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-sub max-sm:min-h-10">
          <input type="checkbox" checked={deleteVolumes} onChange={(e) => setDeleteVolumes(e.target.checked)} className="accent-acc max-sm:h-4 max-sm:w-4" />
          Eliminar también el volumen de datos
        </label>
      </ConfirmModal>
    </>
  );
}
