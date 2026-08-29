import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, Plus, RefreshCw, Settings2, ShieldAlert, Trash2 } from 'lucide-react';
import { api } from '../api';
import { GithubAppStatus, GithubConnector, GithubInstallation } from '../types';
import { timeAgo } from '../utils';
import { ModuleLogo } from './ModuleIcon';
import { Button, Chip, ConfirmModal, Field, Modal, Skeleton, useToast } from './ui';
import { useCreateGithubApp } from './useGithubApp';

/**
 * Conexiones de GitHub del proyecto.
 *
 * El camino principal es la GitHub App: se pulsa un botón, GitHub pregunta qué
 * repos dejar ver y se vuelve conectado. No caduca, no hay nada que copiar y el
 * webhook de despliegue queda puesto de fábrica. El token personal sigue
 * disponible, plegado, para quien lo necesite (GitHub Enterprise, cuentas donde
 * no se puede instalar una App), pero ya no es lo primero que se ve.
 */
export default function GithubModal({
  open,
  onClose,
  projectId,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [addingToken, setAddingToken] = useState(false);
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const createApp = useCreateGithubApp();
  const [appOrg, setAppOrg] = useState('');
  const [orgOpen, setOrgOpen] = useState(false);
  const [toDelete, setToDelete] = useState<{ kind: 'app' | 'pat'; id: string; label: string } | null>(null);

  const appStatus = useQuery({
    queryKey: ['githubApp'],
    queryFn: () => api.get<GithubAppStatus>('/github/app'),
    enabled: open,
    staleTime: 30_000,
  });

  const installations = useQuery({
    queryKey: ['githubInstallations', projectId],
    queryFn: () =>
      api.get<{ appConfigured: boolean; installations: GithubInstallation[] }>(
        `/projects/${projectId}/github/installations`,
      ),
    enabled: open,
  });

  const connectors = useQuery({
    queryKey: ['connectors', projectId],
    queryFn: () => api.get<{ connectors: GithubConnector[]; hasGlobalToken: boolean }>(`/projects/${projectId}/connectors`),
    enabled: open,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['githubInstallations', projectId] });
    queryClient.invalidateQueries({ queryKey: ['connectors', projectId] });
  };

  const createConnector = useMutation({
    mutationFn: () =>
      api.post<{ connector: GithubConnector; warning: string | null }>(`/projects/${projectId}/connectors`, {
        name: name.trim(),
        token: token.trim(),
      }),
    onSuccess: (res) => {
      setAddingToken(false);
      setName('');
      setToken('');
      toast(`Conector @${res.connector.gh_login} conectado`, 'ok');
      if (res.warning) toast(res.warning, 'info');
      invalidate();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const removeConnection = useMutation({
    mutationFn: (target: { kind: 'app' | 'pat'; id: string }) =>
      api.del(target.kind === 'app' ? `/github/installations/${target.id}` : `/connectors/${target.id}`),
    onSuccess: () => {
      setToDelete(null);
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

  const apps = installations.data?.installations ?? [];
  const pats = connectors.data?.connectors ?? [];
  const appConfigured = appStatus.data?.configured ?? false;
  const canConfigureApp = appStatus.data?.canConfigure ?? false;
  const loading = installations.isLoading || connectors.isLoading || appStatus.isLoading;

  // Navegación de página completa a propósito: el salto a GitHub es un flujo
  // OAuth, no una petición fetch (y volvemos por el mismo camino).
  const connectAccount = () => {
    window.location.href = `/api/github/app/install?projectId=${encodeURIComponent(projectId)}`;
  };

  return (
    <>
      <Modal open={open} onClose={() => { if (!toDelete) onClose(); }} title="GitHub" wide>
        <p className="text-xs text-sub">
          Conecta las cuentas de GitHub cuyos repositorios se pueden desplegar en este proyecto. Quien tenga acceso al
          workspace podrá elegir sus repos al crear servicios.
        </p>

        {loading ? (
          <div className="mt-4 flex flex-col gap-2" aria-busy>
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        ) : (
          <>
            {/* --- GitHub App: el camino recomendado --- */}
            <div className="mt-4">
              {appConfigured ? (
                <>
                  {apps.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-line bg-bg px-4 py-6 text-center">
                      <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-surface2 text-txt">
                        <ModuleLogo kind="github" size={20} />
                      </span>
                      <p className="mt-3 text-sm font-medium">Conecta tu cuenta de GitHub</p>
                      <p className="mx-auto mt-1 max-w-md text-xs text-sub">
                        Eliges en GitHub qué repositorios ve Skyway. La conexión no caduca y los despliegues automáticos
                        quedan activados al instante, sin configurar ningún webhook.
                      </p>
                      <Button className="mt-4" onClick={connectAccount}>
                        <ModuleLogo kind="github" size={14} /> Conectar con GitHub
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {apps.map((inst) => (
                        <div
                          key={inst.id}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-bg px-3.5 py-2.5"
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="shrink-0 text-txt">
                              <ModuleLogo kind="github" size={18} />
                            </span>
                            <div className="min-w-0">
                              <p className="flex flex-wrap items-center gap-1.5 truncate text-sm font-medium">
                                @{inst.accountLogin}
                                {inst.suspended ? (
                                  <span className="inline-flex items-center gap-1 rounded-md border border-err/25 bg-err/10 px-1.5 py-px text-micro font-medium text-err">
                                    <ShieldAlert size={9} /> suspendida
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 rounded-md border border-ok/25 bg-ok/10 px-1.5 py-px text-micro font-medium text-ok">
                                    <CheckCircle2 size={9} /> sin caducidad
                                  </span>
                                )}
                                {!inst.projectId && (
                                  <span className="rounded-md border border-line bg-surface2 px-1.5 py-px text-micro text-sub">del servidor</span>
                                )}
                              </p>
                              <p className="mt-px text-xs text-subtle">
                                {inst.repoSelection === 'all' ? 'todos los repos de la cuenta' : 'solo los repos elegidos'} ·
                                conectada por {inst.createdBy} · {timeAgo(inst.createdAt)}
                                {inst.lastUsedAt ? ` · último despliegue ${timeAgo(inst.lastUsedAt)}` : ' · sin usar'}
                              </p>
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-0.5">
                            {inst.manageUrl && (
                              <a
                                href={inst.manageUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="rounded-md p-1.5 text-subtle transition-colors hover:bg-surface2 hover:text-txt"
                                title="Elegir repositorios en GitHub"
                              >
                                <Settings2 size={14} />
                              </a>
                            )}
                            <button
                              onClick={() => syncInstallation.mutate(inst.id)}
                              className="rounded-md p-1.5 text-subtle transition-colors hover:bg-surface2 hover:text-txt"
                              title="Actualizar estado desde GitHub"
                            >
                              <RefreshCw size={14} />
                            </button>
                            <button
                              onClick={() => setToDelete({ kind: 'app', id: inst.id, label: `@${inst.accountLogin}` })}
                              className="rounded-md p-1.5 text-subtle transition-colors hover:bg-err/[.12] hover:text-err"
                              title="Quitar conexión"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      ))}
                      <div className="flex justify-end">
                        <Button size="sm" variant="secondary" onClick={connectAccount}>
                          <Plus size={13} /> Conectar otra cuenta
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="rounded-xl border border-dashed border-line bg-bg px-4 py-6 text-center">
                  <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-surface2 text-txt">
                    <ModuleLogo kind="github" size={20} />
                  </span>
                  {canConfigureApp ? (
                    <>
                      {/* El botón va aquí, no un enlace a Ajustes: este es el momento
                          en que hace falta la App, y mandar a buscarla a otra página
                          es donde la gente se rendía y se quedaba con los tokens. */}
                      <p className="mt-3 text-sm font-medium">Conecta GitHub sin tokens</p>
                      <p className="mx-auto mt-1 max-w-md text-xs text-sub">
                        Primero se crea la App de este servidor: se hace una sola vez y GitHub abre un formulario ya
                        relleno, solo hay que confirmarlo. Después, cada cuenta —la tuya o la de un cliente— se conecta
                        con un clic, elige qué repositorios ve Skyway y no caduca nunca.
                      </p>
                      <Button className="mt-4" onClick={() => createApp.create(appOrg)} loading={createApp.pending}>
                        <ModuleLogo kind="github" size={14} /> Crear la App en GitHub
                      </Button>
                      <div className="mt-3 text-xs text-subtle">
                        {orgOpen ? (
                          <div className="mx-auto flex max-w-xs items-center gap-2">
                            <input
                              className="input h-8 text-xs"
                              placeholder="mi-organizacion"
                              value={appOrg}
                              onChange={(e) => setAppOrg(e.target.value)}
                              aria-label="Organización de GitHub"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                setOrgOpen(false);
                                setAppOrg('');
                              }}
                              className="shrink-0 hover:text-txt"
                            >
                              cancelar
                            </button>
                          </div>
                        ) : (
                          <>
                            Se creará en tu cuenta personal.{' '}
                            <button type="button" onClick={() => setOrgOpen(true)} className="font-medium text-acc-soft hover:underline">
                              ¿En una organización?
                            </button>
                          </>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="mt-3 text-sm font-medium">Este servidor aún no tiene GitHub App</p>
                      <p className="mx-auto mt-1 max-w-md text-xs text-sub">
                        Pídele al administrador que la cree y podrás conectar repositorios sin tokens. Mientras tanto,
                        usa un token personal.
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* --- Tokens personales: el camino de antes, secundario --- */}
            <details className="group mt-4" open={pats.length > 0 && !appConfigured}>
              <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-sub hover:text-txt">
                <KeyRound size={13} />
                Tokens personales
                {pats.length > 0 && <span className="rounded-md border border-line bg-surface2 px-1.5 py-px text-micro">{pats.length}</span>}
              </summary>

              <p className="mt-2 text-xs text-subtle">
                Alternativa para cuentas donde no se puede instalar una App. Caducan y dan acceso a todo lo que ve esa
                cuenta, así que la App es preferible cuando esté disponible.
              </p>

              {pats.length > 0 && (
                <div className="mt-2 flex flex-col gap-2">
                  {pats.map((c) => (
                    <div
                      key={c.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg px-3.5 py-2.5"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="shrink-0 text-subtle">
                          <KeyRound size={16} />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {c.name} <span className="font-mono text-xs text-sub">@{c.gh_login}</span>
                          </p>
                          <p className="mt-px text-xs text-subtle">
                            {c.token_type === 'fine-grained' ? 'token fine-grained' : c.token_type === 'classic' ? 'token clásico' : 'token'} ·
                            conectado por {c.created_by} · {timeAgo(c.created_at)}
                            {c.last_used_at ? ` · último despliegue ${timeAgo(c.last_used_at)}` : ' · sin usar'}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => setToDelete({ kind: 'pat', id: c.id, label: `${c.name} (@${c.gh_login})` })}
                        className="rounded-md p-1.5 text-subtle transition-colors hover:bg-err/[.12] hover:text-err"
                        title="Eliminar conector"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {addingToken ? (
                <form
                  className="mt-3 space-y-3 rounded-lg border border-line bg-bg p-3.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (name.trim() && token.trim().length >= 10 && !createConnector.isPending) createConnector.mutate();
                  }}
                >
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Nombre" hint="de quién es la cuenta: «GitHub de Acme»">
                      <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
                    </Field>
                    <Field
                      label="Token de acceso personal"
                      hint="github.com → Settings → Developer settings → Tokens (permiso «repo» o solo lectura de los repos)"
                    >
                      <input
                        className="input font-mono text-xs"
                        type="password"
                        placeholder="ghp_... o github_pat_..."
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                      />
                    </Field>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button type="button" size="sm" variant="ghost" onClick={() => setAddingToken(false)}>
                      Cancelar
                    </Button>
                    <Button type="submit" size="sm" loading={createConnector.isPending} disabled={!name.trim() || token.trim().length < 10}>
                      Verificar y conectar
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="mt-3 flex justify-end">
                  <Button size="sm" variant="ghost" onClick={() => setAddingToken(true)}>
                    <Plus size={13} /> Añadir token
                  </Button>
                </div>
              )}
            </details>

            {apps.length === 0 && pats.length === 0 && connectors.data && !connectors.data.hasGlobalToken && (
              <p className="mt-4 rounded-lg border border-warn/30 bg-warn/[.07] px-3 py-2 text-xs text-sub">
                Sin ninguna conexión solo se pueden clonar repositorios públicos.
              </p>
            )}
          </>
        )}
      </Modal>

      <ConfirmModal
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && removeConnection.mutate(toDelete)}
        title="Quitar conexión de GitHub"
        message={
          toDelete?.kind === 'app'
            ? `Los servicios que usen ${toDelete.label} pasarán a clonar con el token global del servidor en el próximo despliegue; si el repo es privado y ese token no lo ve, el despliegue fallará. La App seguirá instalada en GitHub: quítala allí si además quieres revocar el acceso.`
            : `Los servicios que usen «${toDelete?.label}» pasarán a clonar con el token global del servidor en el próximo despliegue; si el repo es privado y ese token no lo ve, el despliegue fallará.`
        }
        loading={removeConnection.isPending}
      />
    </>
  );
}
