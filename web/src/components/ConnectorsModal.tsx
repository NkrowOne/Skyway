import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { GithubConnector } from '../types';
import { timeAgo } from '../utils';
import { ModuleLogo } from './ModuleIcon';
import { Button, ConfirmModal, Field, Modal, useToast } from './ui';

/**
 * Conectores de GitHub del proyecto: cada cliente conecta su propia cuenta
 * (token) y así puede asignar sus repos a los servicios sin pasar por el
 * token global del administrador.
 */
export default function ConnectorsModal({
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
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [toDelete, setToDelete] = useState<GithubConnector | null>(null);

  const connectors = useQuery({
    queryKey: ['connectors', projectId],
    queryFn: () => api.get<{ connectors: GithubConnector[]; hasGlobalToken: boolean }>(`/projects/${projectId}/connectors`),
    enabled: open,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['connectors', projectId] });

  const create = useMutation({
    mutationFn: () =>
      api.post<{ connector: GithubConnector; warning: string | null }>(`/projects/${projectId}/connectors`, {
        name: name.trim(),
        token: token.trim(),
      }),
    onSuccess: (res) => {
      setAdding(false);
      setName('');
      setToken('');
      toast(`Conector @${res.connector.gh_login} conectado`, 'ok');
      if (res.warning) toast(res.warning, 'info');
      invalidate();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/connectors/${id}`),
    onSuccess: () => {
      setToDelete(null);
      toast('Conector eliminado', 'ok');
      invalidate();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const list = connectors.data?.connectors ?? [];

  return (
    <>
      {/* Con el confirm abierto encima, esc no debe cerrar también este modal. */}
      <Modal open={open} onClose={() => { if (!toDelete) onClose(); }} title="Conectores de GitHub" wide>
        <p className="text-xs text-sub">
          Conecta cuentas de GitHub a este proyecto: quien tenga acceso al workspace (tú o tu cliente) podrá elegir sus
          repos al crear servicios. El token se guarda en el servidor, no se muestra nunca, y solo se usa para listar
          repos y clonar al desplegar.
        </p>

        {list.length === 0 ? (
          <p className="mt-4 rounded-lg border border-dashed border-line bg-bg px-4 py-5 text-center text-xs text-subtle">
            {connectors.data?.hasGlobalToken
              ? 'Sin conectores. Los despliegues usan el token global del servidor; añade un conector para desplegar repos de otra cuenta.'
              : 'Sin conectores y sin token global: solo se pueden clonar repos públicos. Añade un conector para usar repos privados.'}
          </p>
        ) : (
          <div className="mt-4 flex flex-col gap-2">
            {list.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg px-3.5 py-2.5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="shrink-0 text-txt">
                    <ModuleLogo kind="github" size={18} />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {c.name} <span className="font-mono text-xs text-sub">@{c.gh_login}</span>
                    </p>
                    <p className="mt-px text-[11px] text-subtle">
                      {c.token_type === 'fine-grained' ? 'token fine-grained' : c.token_type === 'classic' ? 'token clásico' : 'token'} ·
                      conectado por {c.created_by} · {timeAgo(c.created_at)}
                      {c.last_used_at ? ` · último despliegue ${timeAgo(c.last_used_at)}` : ' · sin usar'}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setToDelete(c)}
                  className="rounded-md p-1.5 text-subtle transition-colors hover:bg-err/[.12] hover:text-err"
                  title="Eliminar conector"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        {adding ? (
          <form
            className="mt-4 space-y-3 rounded-lg border border-line bg-bg p-3.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && token.trim().length >= 10 && !create.isPending) create.mutate();
            }}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Nombre" hint="de quién es la cuenta: «GitHub de Acme»">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
              </Field>
              <Field
                label="Token de acceso personal"
                hint="github.com → Settings → Developer settings → Tokens (permiso «repo» o acceso de solo lectura a los repos)"
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
              <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Cancelar
              </Button>
              <Button type="submit" size="sm" loading={create.isPending} disabled={!name.trim() || token.trim().length < 10}>
                Verificar y conectar
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-4 flex justify-end">
            <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
              <Plus size={13} /> Añadir conector
            </Button>
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
        title="Eliminar conector"
        message={`Los servicios que usen «${toDelete?.name}» (@${toDelete?.gh_login}) pasarán a clonar con el token global del servidor en el próximo despliegue; si el repo es privado y ese token no lo ve, el despliegue fallará.`}
        loading={remove.isPending}
      />
    </>
  );
}
