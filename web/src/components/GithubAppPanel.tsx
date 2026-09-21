import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, Plus, RefreshCw, Settings2, ShieldAlert, Trash2, Zap } from 'lucide-react';
import { api } from '../api';
import { GithubAppStatus, GithubInstallation } from '../types';
import { timeAgo } from '../utils';
import { ModuleLogo } from './ModuleIcon';
import { Button, Chip, ConfirmModal, CopyButton, EmptyState, Field, Skeleton, useToast } from './ui';
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
      toast('Se ha desenlazado la GitHub App de este servidor', 'ok');
      invalidate();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const removeInstallation = useMutation({
    mutationFn: (id: string) => api.del(`/github/installations/${id}`),
    onSuccess: () => {
      setToRemove(null);
      toast('Se ha eliminado la cuenta de GitHub', 'ok');
      invalidate();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const syncInstallation = useMutation({
    mutationFn: (id: string) => api.post(`/github/installations/${id}/sync`),
    onSuccess: () => {
      toast('Se ha actualizado la cuenta desde GitHub', 'ok');
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
        <p className="text-sm font-medium">Crear la GitHub App de este servidor</p>
        <p className="mt-1.5 max-w-xl text-xs text-sub">
          GitHub abrirá un formulario con los datos ya cumplimentados; solo es necesario confirmarlo.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field
            label="Organización (opcional)"
            hint="Si se deja vacío, la App se crea en su cuenta personal. Si indica un nombre, se crea en esa organización (es necesario ser propietario)."
          >
            <input
              className="input"
              placeholder="mi-organizacion"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
          <Button onClick={() => createApp.create(org)} loading={createApp.pending}>
            <ModuleLogo kind="github" size={14} /> Crear la App en GitHub
          </Button>
        </div>
        <p className="mt-3 flex items-start gap-1.5 text-xs text-subtle">
          <Zap size={12} className="mt-px shrink-0 text-acc-soft" />
          Permisos solicitados: lectura del contenido y de los metadatos de los repositorios, y recepción del evento «push».
          No se solicita ningún permiso de escritura: Skyway nunca envía cambios a GitHub.
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
              <Chip size="sm" tone="ok" icon={<CheckCircle2 size={9} aria-hidden />}>
                activa
              </Chip>
            </p>
            <a
              href={app.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-px inline-flex items-center gap-1 text-xs text-subtle hover:text-txt hover:underline"
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

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-subtle">
        <span>URL del webhook (ya configurada en la App):</span>
        <span className="rounded-md border border-line bg-surface px-1.5 py-px font-mono text-xs text-sub">
          {status.data?.webhookUrl}
        </span>
        <CopyButton value={status.data?.webhookUrl ?? ''} className="max-sm:p-2.5 sm:p-0.5" title="Copiar URL del webhook" />
      </div>

      <div className="mt-4 border-t border-line pt-4">
        <h3 className="text-xs font-semibold">Cuentas conectadas</h3>
        <p className="mt-1 text-xs text-subtle">
          Las marcadas como «del servidor» están disponibles para todos los proyectos; el resto las conectó cada cliente en su proyecto.
        </p>
        {list.length === 0 ? (
          <div className="mt-3 rounded-lg border border-dashed border-line">
            <EmptyState
              compact
              icon={<ModuleLogo kind="github" size={22} />}
              title="Ninguna cuenta conectada"
              description="Conecte una cuenta u organización de GitHub para desplegar sus repositorios desde el panel."
            />
          </div>
        ) : (
          <div className="mt-3 overflow-hidden rounded-lg border border-line">
            {list.map((inst) => (
              <div key={inst.id} className="flex items-center gap-3 border-b border-line/60 bg-bg px-3.5 py-2 text-xs last:border-b-0 max-sm:gap-1.5">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 truncate">
                    <span className="font-medium">@{inst.accountLogin}</span>
                    <span className="text-subtle">{inst.accountType === 'Organization' ? 'organización' : 'cuenta'}</span>
                    {inst.projectName ? (
                      <span className="text-sub">· {inst.projectName}</span>
                    ) : (
                      <Chip size="sm">del servidor</Chip>
                    )}
                    {inst.suspended && (
                      <Chip size="sm" tone="err" icon={<ShieldAlert size={9} aria-hidden />}>
                        suspendida
                      </Chip>
                    )}
                  </p>
                  <p className="mt-px truncate text-xs text-subtle">
                    {inst.repoSelection === 'all' ? 'todos los repositorios' : 'repositorios seleccionados'} · conectada por {inst.createdBy} ·{' '}
                    {timeAgo(inst.createdAt)}
                    {inst.lastUsedAt ? ` · último despliegue ${timeAgo(inst.lastUsedAt)}` : ' · sin usar'}
                  </p>
                </div>
                {inst.manageUrl && (
                  <a
                    href={inst.manageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="press rounded-md p-1 text-subtle transition-colors hover:bg-surface2 hover:text-txt max-sm:p-2.5"
                    title="Seleccionar repositorios en GitHub"
                    aria-label={`Seleccionar repositorios de @${inst.accountLogin} en GitHub`}
                  >
                    <Settings2 size={13} />
                  </a>
                )}
                <button
                  onClick={() => syncInstallation.mutate(inst.id)}
                  className="press rounded-md p-1 text-subtle transition-colors hover:bg-surface2 hover:text-txt max-sm:p-2.5"
                  title="Actualizar desde GitHub"
                  aria-label={`Actualizar @${inst.accountLogin} desde GitHub`}
                >
                  <RefreshCw size={13} />
                </button>
                <button
                  onClick={() => setToRemove(inst)}
                  className="press rounded-md p-1 text-subtle transition-colors hover:bg-err/10 hover:text-err max-sm:p-2.5"
                  title="Eliminar cuenta"
                  aria-label={`Eliminar la cuenta @${inst.accountLogin}`}
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
        message="Se eliminarán las credenciales de la App en Skyway: los servicios que clonen con ella pasarán a usar el token global en el próximo despliegue y los push dejarán de desplegar automáticamente. La App seguirá existiendo en GitHub; elimínela allí si además desea revocarla."
        confirmLabel="Desenlazar"
        loading={disconnect.isPending}
      />

      <ConfirmModal
        open={!!toRemove}
        onClose={() => setToRemove(null)}
        onConfirm={() => toRemove && removeInstallation.mutate(toRemove.id)}
        title="Eliminar cuenta de GitHub"
        message={`Los servicios que usen @${toRemove?.accountLogin} pasarán a usar el token global en el próximo despliegue. La App seguirá instalada en GitHub.`}
        confirmLabel="Eliminar"
        loading={removeInstallation.isPending}
      />
    </>
  );
}
