import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Fingerprint, KeyRound, Pencil, Plus, Shield, Trash2, Users2 } from 'lucide-react';
import { api } from '../api';
import { Button, ConfirmModal, Field, Modal, useToast } from '../components/ui';
import { Me, Project, UserRole, UserSummary } from '../types';
import { cx, timeAgo } from '../utils';

interface Draft {
  id?: string;
  email: string;
  password: string;
  role: UserRole;
  projectIds: string[];
}

const EMPTY: Draft = { email: '', password: '', role: 'member', projectIds: [] };

function RoleChip({ role }: { role: UserRole }) {
  if (role === 'admin')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-acc/[.15] px-2 py-0.5 text-micro font-semibold text-acc-soft">
        <Shield size={9} /> admin
      </span>
    );
  if (role === 'owner')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-acc/[.12] px-2 py-0.5 text-micro font-semibold text-acc-soft">
        propietario
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-txt/[.08] px-2 py-0.5 text-micro font-semibold text-sub">
      miembro
    </span>
  );
}

export default function UsersPage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me') });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ users: UserSummary[] }>('/users') });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<{ projects: Project[] }>('/projects') });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [toDelete, setToDelete] = useState<UserSummary | null>(null);
  const isEdit = !!draft?.id;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const save = useMutation({
    mutationFn: async () => {
      const d = draft!;
      if (d.id) {
        return api.patch(`/users/${d.id}`, {
          role: d.role,
          projectIds: d.role === 'member' ? d.projectIds : [],
          ...(d.password ? { password: d.password } : {}),
        });
      }
      return api.post('/users', {
        email: d.email.trim(),
        password: d.password,
        role: d.role,
        projectIds: d.role === 'member' ? d.projectIds : [],
      });
    },
    onSuccess: () => {
      toast(isEdit ? 'Usuario actualizado' : 'Usuario creado', 'ok');
      setDraft(null);
      invalidate();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/users/${id}`),
    onSuccess: () => {
      toast('Usuario eliminado', 'ok');
      setToDelete(null);
      invalidate();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const projectName = (id: string) => projects.data?.projects.find((p) => p.id === id)?.name ?? id;
  const toggleProject = (id: string) =>
    setDraft((d) =>
      d ? { ...d, projectIds: d.projectIds.includes(id) ? d.projectIds.filter((p) => p !== id) : [...d.projectIds, id] } : d,
    );

  const list = users.data?.users ?? [];

  return (
    <div className="mx-auto flex max-w-[880px] flex-col gap-5 px-4 py-7 sm:px-6 sm:py-10">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Usuarios</h1>
          <p className="mt-1.5 text-sm text-sub">
            Administradores con control total del servidor, y miembros limitados a los workspaces de su cliente
          </p>
        </div>
        <Button onClick={() => setDraft({ ...EMPTY })}>
          <Plus size={14} /> Nuevo usuario
        </Button>
      </div>

      <div className="card overflow-hidden">
        {list.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-subtle">
            {users.isLoading ? 'Cargando…' : 'Todavía no hay usuarios.'}
          </p>
        )}
        {list.map((u, i) => (
          <div
            key={u.id}
            className={cx('flex flex-wrap items-center gap-3 px-4 py-3.5 sm:flex-nowrap', i > 0 && 'border-t border-line')}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium">{u.email}</span>
                <RoleChip role={u.role} />
                {u.id === me.data?.user?.id && (
                  <span className="rounded-full border border-line px-2 py-0.5 text-micro text-subtle">tú</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-subtle">
                <span className="flex items-center gap-1">
                  <Boxes size={11} />
                  {u.role === 'admin'
                    ? 'todos los workspaces'
                    : u.role === 'owner'
                      ? `propietario de ${u.workspaceName ?? 'su cuenta'}`
                      : u.projectIds.length === 0
                        ? u.workspaceName
                          ? `${u.workspaceName}: sin proyectos`
                          : 'sin proyectos asignados'
                        : u.projectIds.map(projectName).join(', ')}
                </span>
                <span className="flex items-center gap-1">
                  <Fingerprint size={11} /> {u.passkeys} passkey{u.passkeys === 1 ? '' : 's'}
                </span>
                <span className="flex items-center gap-1">
                  <KeyRound size={11} /> {u.tokens} token{u.tokens === 1 ? '' : 's'}
                </span>
                <span>alta {timeAgo(u.created_at)}</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                onClick={() => setDraft({ id: u.id, email: u.email, password: '', role: u.role, projectIds: u.projectIds })}
                className="rounded-md p-1.5 text-subtle transition-colors hover:bg-surface2 hover:text-txt"
                title="Editar usuario"
              >
                <Pencil size={14} />
              </button>
              <button
                onClick={() => setToDelete(u)}
                disabled={u.id === me.data?.user?.id}
                className="rounded-md p-1.5 text-subtle transition-colors hover:bg-err/[.12] hover:text-err disabled:opacity-30"
                title={u.id === me.data?.user?.id ? 'No puedes eliminarte a ti mismo' : 'Eliminar usuario'}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <p className="flex items-center gap-1.5 text-xs text-subtle">
        <Users2 size={12} /> Los miembros solo ven y operan sus workspaces: nada de ajustes del servidor, seguridad, otros proyectos ni
        gestión de usuarios.
      </p>

      <Modal open={!!draft} onClose={() => setDraft(null)} title={isEdit ? `Editar ${draft?.email}` : 'Nuevo usuario'}>
        {draft && (
          <div className="flex flex-col gap-3.5">
            {!isEdit && (
              <Field label="Email">
                <input
                  className="input"
                  type="email"
                  value={draft.email}
                  onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                  autoFocus
                />
              </Field>
            )}
            <Field
              label={isEdit ? 'Nueva contraseña' : 'Contraseña'}
              hint={isEdit ? 'vacío = no cambiarla' : 'mínimo 8 caracteres; pídele que la cambie al entrar'}
            >
              <input
                className="input"
                type="password"
                value={draft.password}
                onChange={(e) => setDraft({ ...draft, password: e.target.value })}
              />
            </Field>
            <Field label="Rol">
              <div className="grid grid-cols-2 gap-2">
                {(['member', 'admin'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setDraft({ ...draft, role: r })}
                    disabled={isEdit && draft.id === me.data?.user?.id}
                    className={cx(
                      'rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50',
                      draft.role === r ? 'border-acc bg-acc/[.10]' : 'border-line bg-bg hover:border-subtle',
                    )}
                  >
                    <p className="text-sm font-semibold">{r === 'admin' ? 'Administrador' : 'Miembro'}</p>
                    <p className="mt-0.5 text-xs leading-snug text-subtle">
                      {r === 'admin' ? 'Control total: servidor, usuarios y todos los workspaces' : 'Solo los workspaces que le asignes'}
                    </p>
                  </button>
                ))}
              </div>
            </Field>
            {draft.role === 'member' && (
              <Field label="Workspaces con acceso" hint={projects.data?.projects.length ? undefined : 'aún no hay proyectos creados'}>
                <div className="flex max-h-44 flex-col gap-1 overflow-y-auto rounded-lg border border-line bg-bg p-2">
                  {(projects.data?.projects ?? []).map((p) => (
                    <label key={p.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface2">
                      <input
                        type="checkbox"
                        checked={draft.projectIds.includes(p.id)}
                        onChange={() => toggleProject(p.id)}
                        className="accent-acc"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                      {p.client && <span className="shrink-0 text-xs text-subtle">{p.client}</span>}
                    </label>
                  ))}
                </div>
              </Field>
            )}
            <div className="mt-1.5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancelar
              </Button>
              <Button
                onClick={() => save.mutate()}
                loading={save.isPending}
                disabled={isEdit ? false : !draft.email.trim() || draft.password.length < 8}
              >
                {isEdit ? 'Guardar cambios' : 'Crear usuario'}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
        title="Eliminar usuario"
        message={`«${toDelete?.email}» perderá el acceso al momento; sus passkeys y tokens se revocan. Sus workspaces y servicios no se tocan.`}
        loading={remove.isPending}
      />
    </div>
  );
}
