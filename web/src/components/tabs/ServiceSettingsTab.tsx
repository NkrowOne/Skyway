import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, Sparkles, X } from 'lucide-react';
import { api } from '../../api';
import { Service } from '../../types';
import { Button, ConfirmModal, CopyButton, Field, useToast } from '../ui';

interface SettingsData {
  settings: { rootDomain: string | null };
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
  const cfg = service.config;

  const [name, setName] = useState(service.name);
  const [repoUrl, setRepoUrl] = useState(cfg.repoUrl ?? '');
  const [branch, setBranch] = useState(cfg.branch ?? 'main');
  const [rootDir, setRootDir] = useState(cfg.rootDir ?? '');
  const [dockerfilePath, setDockerfilePath] = useState(cfg.dockerfilePath ?? '');
  const [startCmd, setStartCmd] = useState(cfg.startCmd ?? '');
  const [port, setPort] = useState(String(cfg.port ?? 3000));
  const [version, setVersion] = useState(cfg.version ?? '');
  const [domains, setDomains] = useState<string[]>(cfg.domains ?? []);
  const [newDomain, setNewDomain] = useState('');
  const [hostPort, setHostPort] = useState(cfg.hostPort ? String(cfg.hostPort) : '');
  const [cpus, setCpus] = useState(cfg.cpus ? String(cfg.cpus) : '');
  const [memoryMb, setMemoryMb] = useState(cfg.memoryMb ? String(cfg.memoryMb) : '');
  const [alertsMuted, setAlertsMuted] = useState(!!(cfg as any).alertsMuted);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteVolumes, setDeleteVolumes] = useState(false);

  const globalSettings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<SettingsData>('/settings'),
  });

  const save = useMutation({
    mutationFn: () => {
      const config: Record<string, unknown> = {
        hostPort: hostPort ? Number(hostPort) : null,
        cpus: cpus ? Number(cpus) : null,
        memoryMb: memoryMb ? Number(memoryMb) : null,
        alertsMuted,
      };
      if (isGit) {
        Object.assign(config, {
          repoUrl: repoUrl.trim(),
          branch: branch.trim() || 'main',
          rootDir: rootDir.trim() || null,
          dockerfilePath: dockerfilePath.trim() || null,
          startCmd: startCmd.trim() || null,
          port: Number(port) || 3000,
          domains,
        });
      } else {
        Object.assign(config, { version: version.trim() || cfg.version });
      }
      return api.patch<{ service: Service; needsRedeploy: boolean }>(`/services/${service.id}`, { name, config });
    },
    onSuccess: (data) => {
      toast(
        data.needsRedeploy ? 'Guardado. Redespliega para aplicar los cambios.' : 'Guardado y aplicado.',
        'ok',
      );
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

  const rootDomain = globalSettings.data?.settings.rootDomain;
  const webhookUrl = `${window.location.origin}/api/webhooks/github/${service.id}`;

  const addDomain = (d: string) => {
    const domain = d.trim().toLowerCase();
    if (domain && !domains.includes(domain)) setDomains([...domains, domain]);
    setNewDomain('');
  };

  return (
    <div className="space-y-6 p-4">
      <section className="space-y-4">
        <Field label="Nombre">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        {isGit ? (
          <>
            <Field label="Repositorio">
              <input className="input font-mono text-xs" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Rama">
                <input className="input" value={branch} onChange={(e) => setBranch(e.target.value)} />
              </Field>
              <Field label="Puerto interno">
                <input className="input" type="number" value={port} onChange={(e) => setPort(e.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Directorio raíz" hint="vacío = raíz del repo">
                <input className="input" value={rootDir} onChange={(e) => setRootDir(e.target.value)} />
              </Field>
              <Field label="Dockerfile" hint="vacío = Dockerfile">
                <input className="input" value={dockerfilePath} onChange={(e) => setDockerfilePath(e.target.value)} />
              </Field>
            </div>
            <Field label="Comando de arranque" hint="Opcional: sobreescribe el CMD de la imagen">
              <input className="input font-mono text-xs" value={startCmd} onChange={(e) => setStartCmd(e.target.value)} placeholder="npm run start" />
            </Field>
          </>
        ) : (
          <Field label="Versión de la imagen" hint={`Imagen: ${cfg.template}`}>
            <input className="input font-mono" value={version} onChange={(e) => setVersion(e.target.value)} />
          </Field>
        )}
      </section>

      {isGit && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-sub">Dominios</h3>
          <div className="space-y-2">
            {domains.map((d) => (
              <div key={d} className="flex items-center justify-between rounded-lg border border-line bg-panel2 px-3 py-2">
                <span className="font-mono text-xs">{d}</span>
                <button onClick={() => setDomains(domains.filter((x) => x !== d))} className="text-sub hover:text-err">
                  <X size={13} />
                </button>
              </div>
            ))}
            <div className="flex gap-2">
              <input
                className="input flex-1 font-mono text-xs"
                placeholder="app.midominio.com"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addDomain(newDomain);
                  }
                }}
              />
              <Button size="sm" variant="outline" onClick={() => addDomain(newDomain)}>
                <Plus size={13} />
              </Button>
              {rootDomain && (
                <Button
                  size="sm"
                  variant="outline"
                  title="Generar subdominio automático"
                  onClick={() => addDomain(`${service.slug}.${rootDomain}`)}
                >
                  <Sparkles size={13} /> Generar
                </Button>
              )}
            </div>
            <p className="text-xs text-sub/80">
              El tráfico llega a través de Traefik (puertos 80/443). Apunta el DNS del dominio a la IP de tu servidor.
            </p>
          </div>
        </section>
      )}

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-sub">Recursos y red</h3>
        <div className="grid grid-cols-3 gap-3">
          <Field label="CPUs" hint="vacío = sin límite">
            <input className="input" type="number" step="0.1" min="0.1" placeholder="1.5" value={cpus} onChange={(e) => setCpus(e.target.value)} />
          </Field>
          <Field label="RAM (MB)" hint="vacío = sin límite">
            <input className="input" type="number" min="32" placeholder="512" value={memoryMb} onChange={(e) => setMemoryMb(e.target.value)} />
          </Field>
          <Field label="Puerto público" hint="expone TCP en el host">
            <input className="input" type="number" placeholder={isGit ? '8080' : '5432'} value={hostPort} onChange={(e) => setHostPort(e.target.value)} />
          </Field>
        </div>
        <p className="mt-1.5 text-xs text-sub/80">
          Los límites de CPU/RAM se aplican en caliente si el contenedor está activo.
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm text-sub">
          <input type="checkbox" checked={alertsMuted} onChange={(e) => setAlertsMuted(e.target.checked)} className="accent-acc" />
          Silenciar alertas de este servicio (caídas, CPU/RAM, despliegues fallidos)
        </label>
      </section>

      {isGit && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-sub">Auto-deploy (webhook de GitHub)</h3>
          <div className="card space-y-2 p-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sub">URL</span>
              <span className="flex min-w-0 items-center gap-1">
                <span className="truncate font-mono">{webhookUrl}</span>
                <CopyButton value={webhookUrl} />
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sub">Secreto</span>
              <span className="flex items-center gap-1">
                <span className="font-mono">••••••••</span>
                <CopyButton value={cfg.webhookSecret ?? ''} />
              </span>
            </div>
            <p className="text-sub/80">
              En GitHub: Settings → Webhooks → Add webhook. Content type <span className="font-mono">application/json</span>,
              evento <span className="font-mono">push</span>. Cada push a <span className="font-mono">{branch}</span> desplegará automáticamente.
            </p>
          </div>
        </section>
      )}

      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          Guardar cambios
        </Button>
      </div>

      <section className="rounded-xl border border-err/30 bg-err/5 p-4">
        <h3 className="text-sm font-medium text-err">Zona de peligro</h3>
        <p className="mt-1 text-xs text-sub">Elimina el servicio y su contenedor. Los volúmenes solo se borran si lo marcas.</p>
        <Button variant="danger" size="sm" className="mt-3" onClick={() => setDeleteOpen(true)}>
          Eliminar servicio
        </Button>
      </section>

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
    </div>
  );
}
