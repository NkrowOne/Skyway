import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, Plus, RefreshCw, Settings2, ShieldAlert, Trash2, Zap } from 'lucide-react';
import { api } from '../api';
import { GithubAppStatus, GithubInstallation } from '../types';
import { timeAgo } from '../utils';
import { ModuleLogo } from './ModuleIcon';
import { Button, ConfirmModal, CopyButton, Field, Skeleton, useToast } from './ui';
import { useCreateGithubApp } from './useGithubApp';

/**
 * Alta y gestión de la GitHub App del servidor.
 *
 * La App se crea con el «flujo de manifiesto»: el navegador manda a github.com
 * un formulario con todo relleno —permisos, URL del webhook, retorno— y GitHub
 * devuelve el código que aquí se canjea por las credenciales. El administrador
 * no copia ni pega nada, y al terminar el webhook de despliegue ya está puesto
 * para todos los repos que se conecten después.
 */

export default function GithubAppPanel() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [org, setOrg] = useState('');
  const createApp = useCreateGithubApp();
  const [disconnecting, setDisconnecting] = useState(false);
  const [toRemove, setToRemove] = useState<GithubInstallation | null>(null);

  const status = useQuery({
    queryKey: ['githubApp'],
    queryFn: () => api.get<GithubAppStatus>('/github/app'),
  });

  const installations = useQuery({
    queryKey: ['githubInstallations', 'all'],
    queryFn: () => api.get<{ appConfigured: boolean; installations: GithubInstallation[] }>('/github/installations'),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['githubApp'] });
    queryClient.invalidateQueries({ queryKey: ['githubInstallations'] });
  };

  const disconnect = useMutation({
    mutationFn: () => api.post('/github/app/disconnect'),
    onSuccess: () => {
      setDisconnecting(false);
      toast('GitHub App desenlazada de este servidor', 'ok');
      invalidate();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const removeInstallation = useMutation({
    mutationFn: (id: string) => api.del(`/github/installations/${id}`),
    onSuccess: () => {
      setToRemove(null);
      toast('Conexión eliminada', 'ok');
      invalidate();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const syncInstallation = useMutation({
    mutationFn: (id: string) => api.post(`/github/installations/${id}/sync`),
    onSuccess: () => {
      toast('Conexión actualizada desde GitHub', 'ok');
      invalidate();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  if (status.isLoading) return <Skeleton className="h-24 w-full rounded-lg" />;

  const app = status.data?.app ?? null;
  const list = installations.data?.installations ?? [];

  if (!app) {
    return (
      <div className="rounded-xl border border-dashed border-line bg-bg p-5">
        <p className="text-sm font-medium">Crea la GitHub App de este servidor</p>
        <p className="mt-1.5 max-w-xl text-xs text-sub">
          Es la forma recomendada de conectar repositorios: se instala una vez por cuenta, no caduca, solo ve los
          repositorios que se le indiquen y deja el webhook de despliegue puesto —los push salen al momento, sin
          configurar nada por servicio—. GitHub abrirá un formulario ya relleno; solo hay que confirmarlo.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field
            label="Organización (opcional)"
            hint="Vacío = la App se crea en tu cuenta personal. Con nombre, en esa organización (necesitas ser propietario)."
          >
            <input className="input" placeholder="mi-organizacion" value={org} onChange={(e) => setOrg(e.target.value)} />
          </Field>
          <Button onClick={() => createApp.create(org)} loading={createApp.pending}>
            <ModuleLogo kind="github" size={14} /> Crear la App en GitHub
          </Button>
        </div>
        <p className="mt-3 flex items-start gap-1.5 text-[11px] text-subtle">
          <Zap size={12} className="mt-px shrink-0 text-acc-soft" />
          Permisos que pide: leer el contenido y los metadatos de los repositorios, y recibir el evento «push». Ninguno
          de escritura: Skyway nunca empuja a GitHub.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-bg px-3.5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="shrink-0 text-txt">
            <ModuleLogo kind="github" size={18} />
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate text-sm font-medium">
              {app.name}
              <span className="inline-flex items-center gap-1 rounded-full bg-ok/[.14] px-1.5 py-px text-[10px] font-semibold text-ok">
                <CheckCircle2 size={9} /> activa
              </span>
            </p>
            <a
              href={app.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-px inline-flex items-center gap-1 text-[11px] text-subtle hover:text-txt hover:underline"
            >
              {app.htmlUrl.replace(/^https:\/\//, '')} <ExternalLink size={10} />
            </a>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => { window.location.href = '/api/github/app/install'; }}>
            <Plus size={13} /> Conectar cuenta
          </Button>
          <Button size="sm" variant="ghost" className="text-err hover:bg-err/[.1]" onClick={() => setDisconnecting(true)}>
            <Trash2 size={13} /> Desenlazar
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-subtle">
        <span>URL del webhook (ya configurada en la App):</span>
        <span className="rounded-md border border-line bg-surface px-1.5 py-px font-mono text-[11px] text-sub">
          {status.data?.webhookUrl}
        </span>
        <CopyButton value={status.data?.webhookUrl ?? ''} className="p-0.5" title="Copiar URL del webhook" />
      </div>

      <div className="mt-4 border-t border-line pt-4">
        <h3 className="text-xs font-semibold">Cuentas conectadas</h3>
        <p className="mt-1 text-[11px] text-subtle">
          Instalaciones de la App. Las marcadas «del servidor» las conectaste tú y sirven para todos los proyectos; el
          resto las conectó cada cliente en su proyecto.
        </p>
        {list.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-line px-3.5 py-3.5 text-center text-xs text-subtle">
            Ninguna cuenta conectada todavía.
          </p>
        ) : (
          <div className="mt-3 overflow-hidden rounded-lg border border-line">
            {list.map((inst) => (
              <div key={inst.id} className="flex items-center gap-3 border-b border-line/60 bg-bg px-3.5 py-2 text-xs last:border-b-0">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 truncate">
                    <span className="font-medium">@{inst.accountLogin}</span>
                    <span className="text-subtle">{inst.accountType === 'Organization' ? 'organización' : 'cuenta'}</span>
                    {inst.projectName ? (
                      <span className="text-sub">· {inst.projectName}</span>
                    ) : (
                      <span className="rounded-full bg-surface2 px-1.5 py-px text-[10px] text-sub">del servidor</span>
                    )}
                    {inst.suspended && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-err/[.12] px-1.5 py-px text-[10px] font-medium text-err">
                        <ShieldAlert size={9} /> suspendida
                      </span>
                    )}
                  </p>
                  <p className="mt-px truncate text-[11px] text-subtle">
                    {inst.repoSelection === 'all' ? 'todos los repos' : 'repos elegidos'} · conectada por {inst.createdBy} ·{' '}
                    {timeAgo(inst.createdAt)}
                    {inst.lastUsedAt ? ` · último despliegue ${timeAgo(inst.lastUsedAt)}` : ' · sin usar'}
                  </p>
                </div>
                {inst.manageUrl && (
                  <a
                    href={inst.manageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md p-1 text-subtle transition-colors hover:bg-surface2 hover:text-txt"
                    title="Elegir repositorios en GitHub"
                  >
                    <Settings2 size={13} />
                  </a>
                )}
                <button
                  onClick={() => syncInstallation.mutate(inst.id)}
                  className="rounded-md p-1 text-subtle transition-colors hover:bg-surface2 hover:text-txt"
                  title="Actualizar desde GitHub"
                >
                  <RefreshCw size={13} />
                </button>
                <button
                  onClick={() => setToRemove(inst)}
                  className="rounded-md p-1 text-subtle transition-colors hover:bg-err/10 hover:text-err"
                  title="Quitar conexión"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmModal
        open={disconnecting}
        onClose={() => setDisconnecting(false)}
        onConfirm={() => disconnect.mutate()}
        title="Desenlazar la GitHub App"
        message="Skyway olvidará las credenciales de la App: los servicios que clonen con ella pasarán al token global en el próximo despliegue y los push dejarán de desplegar solos. La App seguirá existiendo en GitHub; bórrala allí si además quieres revocarla."
        confirmLabel="Desenlazar"
        loading={disconnect.isPending}
      />

      <ConfirmModal
        open={!!toRemove}
        onClose={() => setToRemove(null)}
        onConfirm={() => toRemove && removeInstallation.mutate(toRemove.id)}
        title="Quitar conexión"
        message={`Los servicios que usen @${toRemove?.accountLogin} pasarán al token global en el próximo despliegue. La App seguirá instalada en GitHub.`}
        confirmLabel="Quitar"
        loading={removeInstallation.isPending}
      />
    </>
  );
}
