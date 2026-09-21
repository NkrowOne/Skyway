import { useMemo, useState } from 'react';
import { useLatched } from '../hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Fingerprint, KeyRound, Pencil, Plus, Shield, Trash2 } from 'lucide-react';
import { api } from '../api';
import { Button, Chip, ConfirmModal, EmptyState, ErrorState, Field, Modal, Skeleton, useToast } from '../components/ui';
import { Me, Project, UserRole, UserSummary, Workspace } from '../types';
import { cx, timeAgo } from '../utils';

interface Draft {
  id?: string;
  email: string;
  password: string;
  role: UserRole;
  /** Cuenta de cliente del miembro; null = sin cuenta. Los administradores no llevan. */
  workspaceId: string | null;
  projectIds: string[];
}

const EMPTY: Draft = { email: '', password: '', role: 'member', workspaceId: null, projectIds: [] };

function RoleChip({ role }: { role: UserRole }) {
  if (role === 'admin')
    return (
      <Chip size="sm" tone="info" icon={<Shield size={9} aria-hidden />}>
        administrador
      </Chip>
    );
  if (role === 'owner') return <Chip size="sm" tone="info">propietario</Chip>;
  return <Chip size="sm">miembro</Chip>;
}

export default function UsersPage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), staleTime: 60_000 });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ users: UserSummary[] }>('/users') });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<{ projects: Project[] }>('/projects') });
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: () => api.get<{ workspaces: Workspace[] }>('/workspaces') });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [toDelete, setToDelete] = useState<UserSummary | null>(null);
  const toDeleteShown = useLatched(toDelete);
  const isEdit = !!draft?.id;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const save = useMutation({
    mutationFn: async () => {
      const d = draft!;
      // La cuenta viaja solo para miembros: un administrador no lleva ninguna y
      // un propietario se gestiona desde su cuenta.
      const cuenta = d.role === 'member' ? { workspaceId: d.workspaceId } : {};
      if (d.id) {
        return api.patch(`/users/${d.id}`, {
          role: d.role,
          ...cuenta,
          projectIds: d.role === 'member' ? d.projectIds : [],
          ...(d.password ? { password: d.password } : {}),
        });
      }
      return api.post('/users', {
        email: d.email.trim(),
        password: d.password,
        role: d.role,
        ...cuenta,
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
  // Cambiar de cuenta descarta las asignaciones: pertenecen a la cuenta anterior.
  const changeWorkspace = (workspaceId: string | null) =>
    setDraft((d) => (d && d.workspaceId !== workspaceId ? { ...d, workspaceId, projectIds: [] } : d));
  // Con cuenta, solo sus proyectos; sin cuenta (usuarios antiguos), todos.
  const assignableProjects = useMemo(() => {
    const all = projects.data?.projects ?? [];
    return draft?.workspaceId ? all.filter((p) => p.workspace_id === draft.workspaceId) : all;
  }, [projects.data?.projects, draft?.workspaceId]);
  const workspaceList = useMemo(
    () => [...(workspaces.data?.workspaces ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'es')),
    [workspaces.data?.workspaces],
  );

  // Alfabético por email (copia: la caché de react-query no se muta).
  const list = useMemo(
    () => [...(users.data?.users ?? [])].sort((a, b) => a.email.localeCompare(b.email, 'es')),
    [users.data?.users],
  );

  return (
    <div className="mx-auto flex max-w-[880px] flex-col gap-5 px-4 py-7 sm:px-6 sm:py-10">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-2xl font-semibold">
            Usuarios
            {list.length > 0 && <Chip>{list.length}</Chip>}
          </h1>
          <p className="mt-1.5 text-sm text-sub">
            Administradores con control total del servidor y miembros limitados a su cuenta de cliente
          </p>
        </div>
        <Button onClick={() => setDraft({ ...EMPTY })}>
          <Plus size={14} /> Nuevo usuario
        </Button>
      </div>

      <div className="card overflow-hidden">
        {/* Excluyentes: error, carga, vacío o lista. Antes el error y el «vacío»
            podían pintarse a la vez. */}
        {users.isError ? (
          <ErrorState
            compact
            title="No se han podido cargar los usuarios"
            error={users.error}
            onRetry={() => users.refetch()}
            retrying={users.isFetching}
          />
        ) : users.isLoading ? (
          <div className="flex flex-col gap-3 p-4" aria-busy>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            compact
            title="Todavía no hay usuarios"
            description="Cree el primero para dar acceso al panel."
            action={<Button size="sm" onClick={() => setDraft({ ...EMPTY })}><Plus size={13} /> Nuevo usuario</Button>}
          />
        ) : (
        list.map((u, i) => (
          <div
            key={u.id}
            className={cx('flex flex-wrap items-center gap-3 px-4 py-3.5 sm:flex-nowrap', i > 0 && 'border-t border-line')}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium">{u.email}</span>
                <RoleChip role={u.role} />
                {u.id === me.data?.user?.id && (
                  <Chip size="sm">usted</Chip>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-subtle">
                <span className="flex items-center gap-1">
                  <Boxes size={11} />
                  {u.role === 'admin'
                    ? 'todas las cuentas'
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
                onClick={() =>
                  setDraft({ id: u.id, email: u.email, password: '', role: u.role, workspaceId: u.workspaceId ?? null, projectIds: u.projectIds })
                }
                className="rounded-md p-1.5 text-subtle transition-colors hover:bg-surface2 hover:text-txt max-sm:p-2.5"
                title="Editar usuario"
                aria-label="Editar usuario"
              >
                <Pencil size={14} />
              </button>
              <button
                onClick={() => setToDelete(u)}
                disabled={u.id === me.data?.user?.id}
                className="rounded-md p-1.5 text-subtle transition-colors hover:bg-err/[.12] hover:text-err disabled:opacity-30 max-sm:p-2.5"
                title={u.id === me.data?.user?.id ? 'No es posible eliminar su propio usuario' : 'Eliminar usuario'}
                aria-label="Eliminar usuario"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))
        )}
      </div>

      <Modal open={!!draft} onClose={() => setDraft(null)} title={isEdit ? `Editar ${draft?.email}` : 'Nuevo usuario'}>
        {draft && (
          <div className="flex flex-col gap-3.5">
            {!isEdit && (
              <Field label="Correo electrónico">
                <input
                  className="input"
                  type="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  value={draft.email}
                  onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                  autoFocus
                />
              </Field>
            )}
            <Field
              label={isEdit ? 'Nueva contraseña' : 'Contraseña'}
              hint={isEdit ? 'Si se deja vacío, la contraseña no cambia' : 'Mínimo 8 caracteres; se recomienda que el usuario la cambie al iniciar sesión'}
            >
              <input
                className="input"
                type="password"
                value={draft.password}
                onChange={(e) => setDraft({ ...draft, password: e.target.value })}
              />
            </Field>
            <Field label="Rol" group>
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
                      {r === 'admin' ? 'Control total: servidor, usuarios y todas las cuentas' : 'Solo los proyectos que se le asignen'}
                    </p>
                  </button>
                ))}
              </div>
            </Field>
            {draft.role === 'member' && (
              <Field
                label="Cuenta de cliente"
                hint={
                  isEdit && draft.workspaceId !== (list.find((u) => u.id === draft.id)?.workspaceId ?? null)
                    ? 'Al cambiar de cuenta se retiran los proyectos asignados; seleccione los de la cuenta nueva.'
                    : 'Los proyectos disponibles son los de la cuenta seleccionada.'
                }
              >
                <select
                  className="input"
                  value={draft.workspaceId ?? ''}
                  onChange={(e) => changeWorkspace(e.target.value || null)}
                  disabled={workspaces.isLoading}
                >
                  <option value="">Sin cuenta</option>
                  {workspaceList.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {draft.role === 'member' && (
              <Field
                label="Proyectos con acceso"
                hint={
                  assignableProjects.length
                    ? undefined
                    : draft.workspaceId
                      ? 'La cuenta seleccionada todavía no tiene proyectos'
                      : 'Todavía no hay proyectos creados'
                }
                group
              >
                <div className="flex max-h-44 flex-col gap-1 overflow-y-auto rounded-lg border border-line bg-bg p-2">
                  {assignableProjects.map((p) => (
                    <label key={p.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface2">
                      <input
                        type="checkbox"
                        checked={draft.projectIds.includes(p.id)}
                        onChange={() => toggleProject(p.id)}
                        className="h-4 w-4 shrink-0 accent-acc"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                      {!draft.workspaceId && p.client && <span className="shrink-0 text-xs text-subtle">{p.client}</span>}
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
        message={`«${toDeleteShown?.email ?? ''}» perderá el acceso de inmediato y sus passkeys y tokens se revocarán. Sus proyectos y servicios no se modifican.`}
        loading={remove.isPending}
      />
    </div>
  );
}
