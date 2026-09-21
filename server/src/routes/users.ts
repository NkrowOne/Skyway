import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireAdmin, setAuthCookie, signToken } from '../auth';
import { audit } from '../audit';
import {
  countAdmins,
  countApiTokens,
  countPasskeys,
  countWorkspaceMembers,
  createUser,
  deleteUser,
  getProject,
  getUser,
  getUserByEmail,
  getWorkspace,
  listUserProjectIds,
  listUsers,
  projectsBelongToWorkspace,
  setUserProjects,
  transaction,
  updateUserPassword,
  updateUserRole,
  updateUserWorkspace,
} from '../db';
import { workspaceQuotaSummary } from '../quota';
import { UserRole } from '../types';
import { hashPasswordAsync } from '../util';

// Crear desde aquí (nivel plataforma): admin o miembro. Los propietarios se
// crean desde «Cuentas y clientes», donde llevan su workspace.
const createRoleSchema = z.enum(['admin', 'member']);
// Editar acepta también 'owner' para no romper la edición de propietarios ya
// existentes; ascender A propietario se hace desde su workspace.
const patchRoleSchema = z.enum(['admin', 'owner', 'member']);

const createSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
  role: createRoleSchema.default('member'),
  projectIds: z.array(z.string()).default([]),
  /** Cuenta de cliente del miembro (null = sin cuenta). Un administrador no lleva ninguna. */
  workspaceId: z.string().max(60).nullable().optional(),
});

const patchSchema = z.object({
  role: patchRoleSchema.optional(),
  projectIds: z.array(z.string()).optional(),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').optional(),
  /** Mover a otra cuenta (o a ninguna, con null). Es la única vía para cambiar de cuenta. */
  workspaceId: z.string().max(60).nullable().optional(),
});

/**
 * Comprueba que un usuario con el rol dado puede vivir en esa cuenta con esos
 * proyectos. Devuelve el mensaje de error (y el código) o null si todo vale.
 * La regla es una sola para el alta y para el cambio de cuenta.
 */
function workspaceBlocker(
  role: UserRole,
  workspaceId: string | null,
  projectIds: string[] | undefined,
  opts: { countsAsNewMember: boolean },
): { code: number; error: string } | null {
  if (role === 'admin' && workspaceId) {
    return { code: 400, error: 'Un administrador no pertenece a ninguna cuenta de cliente.' };
  }
  if (role === 'owner' && !workspaceId) {
    return { code: 400, error: 'Un propietario necesita una cuenta de cliente.' };
  }
  if (!workspaceId) return null;
  const ws = getWorkspace(workspaceId);
  if (!ws) return { code: 400, error: 'Cuenta de cliente desconocida.' };
  if (opts.countsAsNewMember) {
    const summary = workspaceQuotaSummary(ws);
    if (countWorkspaceMembers(workspaceId) >= summary.quota.maxMembers) {
      return {
        code: 409,
        error: `La cuenta «${ws.name}» ha alcanzado su límite de ${summary.quota.maxMembers} usuarios. Amplíe la cuota antes de añadir más.`,
      };
    }
  }
  if (projectIds && projectIds.length > 0) {
    const check = projectsBelongToWorkspace(projectIds, workspaceId);
    if (!check.ok) return { code: 400, error: 'Solo es posible asignar proyectos de la cuenta del usuario.' };
  }
  return null;
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  app.get('/api/users', async () => {
    return {
      users: listUsers().map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        created_at: u.created_at,
        workspaceId: u.workspace_id,
        workspaceName: u.workspace_id ? getWorkspace(u.workspace_id)?.name ?? null : null,
        projectIds: listUserProjectIds(u.id),
        passkeys: countPasskeys(u.id),
        tokens: countApiTokens(u.id),
      })),
    };
  });

  app.post('/api/users', async (req, reply) => {
    const body = createSchema.parse(req.body);
    const email = body.email.toLowerCase();
    if (getUserByEmail(email)) return reply.code(409).send({ error: 'Ya existe un usuario con ese email' });
    for (const pid of body.projectIds) {
      if (!getProject(pid)) return reply.code(400).send({ error: `Proyecto desconocido: ${pid}` });
    }
    const workspaceId = body.workspaceId ?? null;
    const blocker = workspaceBlocker(body.role, workspaceId, body.projectIds, { countsAsNewMember: true });
    if (blocker) return reply.code(blocker.code).send({ error: blocker.error });
    const passwordHash = await hashPasswordAsync(body.password);
    // Se repite la comprobación tras el `await`: otra petición pudo crear el mismo
    // email mientras se calculaba el hash, y el UNIQUE de la tabla daría un 500.
    if (getUserByEmail(email)) return reply.code(409).send({ error: 'Ya existe un usuario con ese email' });
    const user = transaction(() => {
      const created = createUser(email, passwordHash, body.role, workspaceId);
      if (body.role === 'member') setUserProjects(created.id, body.projectIds);
      return created;
    });
    audit(req, 'user_created', {
      type: 'user',
      id: user.id,
      detail: `${email} (${body.role})${workspaceId ? ` en ${getWorkspace(workspaceId)?.name ?? workspaceId}` : ''}`,
    });
    reply.code(201);
    return { user: { id: user.id, email: user.email, role: user.role, created_at: user.created_at, workspaceId } };
  });

  app.patch('/api/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = getUser(id);
    if (!target) return reply.code(404).send({ error: 'Usuario no encontrado' });
    const me = currentUser(req)!;
    const body = patchSchema.parse(req.body);

    // --- Validación COMPLETA antes de tocar nada (evita mutaciones parciales en un 400) ---
    const roleChange = body.role && body.role !== target.role ? body.role : null;
    if (roleChange) {
      if (target.id === me.id) return reply.code(400).send({ error: 'No es posible cambiar su propio rol' });
      if (target.role === 'admin' && countAdmins() <= 1) {
        return reply.code(400).send({ error: 'Debe quedar al menos un administrador' });
      }
      // Ascender A propietario necesita un workspace: se hace desde «Cuentas y clientes».
      if (roleChange === 'owner') {
        return reply.code(400).send({ error: 'Los propietarios se gestionan desde «Cuentas y clientes».' });
      }
    }
    if (body.projectIds) {
      for (const pid of body.projectIds) {
        if (!getProject(pid)) return reply.code(400).send({ error: `Proyecto desconocido: ${pid}` });
      }
    }
    const effectiveRole = roleChange ?? target.role;
    // Cuenta de destino: la enviada, o la actual (ninguna si pasa a administrador).
    // Enviar una cuenta para un administrador no se ignora: es un error de la petición.
    const currentWorkspace = target.workspace_id ?? null;
    const nextWorkspace =
      body.workspaceId !== undefined ? body.workspaceId : effectiveRole === 'admin' ? null : currentWorkspace;
    const workspaceChange = nextWorkspace !== currentWorkspace;
    if (workspaceChange && target.id === me.id) {
      return reply.code(400).send({ error: 'No es posible cambiar su propia cuenta' });
    }
    // Al cambiar de cuenta, las asignaciones antiguas dejan de tener sentido: o
    // llegan proyectos de la cuenta nueva en la misma petición, o se vacían.
    const nextProjectIds = workspaceChange ? body.projectIds ?? [] : body.projectIds;
    const blocker = workspaceBlocker(effectiveRole, nextWorkspace, nextProjectIds, {
      countsAsNewMember: workspaceChange && nextWorkspace !== null,
    });
    if (blocker) return reply.code(blocker.code).send({ error: blocker.error });

    // El hash se calcula ANTES de la transacción (es asíncrono y no puede ir dentro).
    const passwordHash = body.password ? await hashPasswordAsync(body.password) : null;
    // El usuario pudo borrarse mientras se calculaba el hash.
    if (!getUser(id)) return reply.code(404).send({ error: 'Usuario no encontrado' });

    // --- Mutaciones atómicas: todo o nada ---
    transaction(() => {
      if (roleChange) updateUserRole(id, roleChange);
      if (workspaceChange) updateUserWorkspace(id, nextWorkspace);
      // Un admin no tiene asignaciones; un miembro recibe las enviadas (si las hay).
      if (effectiveRole === 'admin') setUserProjects(id, []);
      else if (nextProjectIds) setUserProjects(id, nextProjectIds);
      if (passwordHash) updateUserPassword(id, passwordHash);
    });
    if (workspaceChange) {
      const nombre = (wid: string | null) => (wid ? getWorkspace(wid)?.name ?? wid : 'sin cuenta');
      audit(req, 'user_workspace_changed', {
        type: 'user',
        id,
        detail: `${target.email}: de ${nombre(currentWorkspace)} a ${nombre(nextWorkspace)}`,
      });
    }

    if (passwordHash) {
      audit(req, 'user_password_reset', { type: 'user', id, detail: target.email });
      // Cambiar la contraseña sube el epoch y corta las cookies previas del
      // usuario. Si el administrador se la cambia a SÍ MISMO, sin renovar la suya
      // la siguiente petición le devolvía al login sin explicación.
      if (target.id === me.id && req.authMethod === 'cookie') {
        setAuthCookie(reply, signToken(id), req.protocol === 'https');
      }
    }
    audit(req, 'user_updated', { type: 'user', id, detail: target.email });
    const updated = getUser(id)!;
    return {
      user: {
        id: updated.id,
        email: updated.email,
        role: updated.role,
        created_at: updated.created_at,
        workspaceId: updated.workspace_id ?? null,
        projectIds: listUserProjectIds(id),
      },
    };
  });

  app.delete('/api/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = getUser(id);
    if (!target) return reply.code(404).send({ error: 'Usuario no encontrado' });
    const me = currentUser(req)!;
    if (target.id === me.id) return reply.code(400).send({ error: 'No es posible eliminar su propia cuenta' });
    if (target.role === 'admin' && countAdmins() <= 1) {
      return reply.code(400).send({ error: 'Debe quedar al menos un administrador' });
    }
    deleteUser(id); // cascada: workspaces, passkeys y tokens del usuario
    audit(req, 'user_deleted', { type: 'user', id, detail: target.email });
    return { ok: true };
  });
}
