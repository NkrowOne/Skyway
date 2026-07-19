import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireAdmin } from '../auth';
import { audit } from '../audit';
import {
  countAdmins,
  countApiTokens,
  countPasskeys,
  createUser,
  deleteUser,
  getProject,
  getUser,
  getUserByEmail,
  listUserProjectIds,
  listUsers,
  setUserProjects,
  updateUserPassword,
  updateUserRole,
} from '../db';
import { hashPassword } from '../util';

const roleSchema = z.enum(['admin', 'member']);

const createSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
  role: roleSchema.default('member'),
  projectIds: z.array(z.string()).default([]),
});

const patchSchema = z.object({
  role: roleSchema.optional(),
  projectIds: z.array(z.string()).optional(),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').optional(),
});

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  app.get('/api/users', async () => {
    return {
      users: listUsers().map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        created_at: u.created_at,
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
    const user = createUser(email, hashPassword(body.password), body.role);
    if (body.role === 'member') setUserProjects(user.id, body.projectIds);
    audit(req, 'user_created', { type: 'user', id: user.id, detail: `${email} (${body.role})` });
    reply.code(201);
    return { user: { id: user.id, email: user.email, role: user.role, created_at: user.created_at } };
  });

  app.patch('/api/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = getUser(id);
    if (!target) return reply.code(404).send({ error: 'Usuario no encontrado' });
    const me = currentUser(req)!;
    const body = patchSchema.parse(req.body);

    if (body.role && body.role !== target.role) {
      if (target.id === me.id) return reply.code(400).send({ error: 'No puedes cambiar tu propio rol' });
      if (target.role === 'admin' && countAdmins() <= 1) {
        return reply.code(400).send({ error: 'Debe quedar al menos un administrador' });
      }
      updateUserRole(id, body.role);
      // Un admin no necesita asignaciones; al degradar empieza sin workspaces salvo que se envíen.
      if (body.role === 'admin') setUserProjects(id, []);
    }

    if (body.projectIds) {
      for (const pid of body.projectIds) {
        if (!getProject(pid)) return reply.code(400).send({ error: `Proyecto desconocido: ${pid}` });
      }
      setUserProjects(id, body.projectIds);
    }

    if (body.password) {
      updateUserPassword(id, hashPassword(body.password));
      audit(req, 'user_password_reset', { type: 'user', id, detail: target.email });
    }

    audit(req, 'user_updated', { type: 'user', id, detail: target.email });
    const updated = getUser(id)!;
    return {
      user: {
        id: updated.id,
        email: updated.email,
        role: updated.role,
        created_at: updated.created_at,
        projectIds: listUserProjectIds(id),
      },
    };
  });

  app.delete('/api/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = getUser(id);
    if (!target) return reply.code(404).send({ error: 'Usuario no encontrado' });
    const me = currentUser(req)!;
    if (target.id === me.id) return reply.code(400).send({ error: 'No puedes eliminar tu propia cuenta' });
    if (target.role === 'admin' && countAdmins() <= 1) {
      return reply.code(400).send({ error: 'Debe quedar al menos un administrador' });
    }
    deleteUser(id); // cascada: workspaces, passkeys y tokens del usuario
    audit(req, 'user_deleted', { type: 'user', id, detail: target.email });
    return { ok: true };
  });
}
