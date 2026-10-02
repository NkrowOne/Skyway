import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  clearAuthCookie,
  clearLoginFailures,
  currentUser,
  loginBlocked,
  recordLoginFailure,
  requireSession,
  setAuthCookie,
  signToken,
} from '../auth';
import { audit } from '../audit';
import { countUsers, createUser, getUser, getUserByEmail, getWorkspace, updateUserPassword } from '../db';
import { UserRow } from '../types';
import { decoyPasswordHash, hashPasswordAsync, verifyPasswordAsync } from '../util';

const credentialsSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
});

/** Vista pública del usuario para la sesión: incluye su workspace (owner/member). */
function publicUser(user: UserRow) {
  const workspace = user.workspace_id ? getWorkspace(user.workspace_id) : undefined;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    workspaceId: user.workspace_id,
    workspaceName: workspace?.name ?? null,
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/auth/me', async (req) => {
    const needsSetup = countUsers() === 0;
    const user = currentUser(req);
    return {
      needsSetup,
      user: user ? publicUser(user) : null,
    };
  });

  app.post('/api/auth/setup', async (req, reply) => {
    if (countUsers() > 0) {
      return reply.code(403).send({ error: 'Skyway ya está configurado' });
    }
    const body = credentialsSchema.parse(req.body);
    const passwordHash = await hashPasswordAsync(body.password);
    // Se vuelve a comprobar tras el `await`: dos peticiones de setup simultáneas
    // pasaban ambas la guarda de arriba y creaban dos administradores.
    if (countUsers() > 0) {
      return reply.code(403).send({ error: 'Skyway ya está configurado' });
    }
    // El primer usuario es siempre el administrador del servidor.
    const user = createUser(body.email.toLowerCase(), passwordHash, 'admin');
    setAuthCookie(reply, signToken(user.id), req.protocol === 'https');
    audit(req, 'setup', { type: 'user', id: user.id, detail: user.email }, user.email);
    return { user: publicUser(user) };
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (loginBlocked(req.ip)) {
      audit(req, 'login_blocked', { type: 'ip', id: req.ip });
      return reply.code(429).send({ error: 'Demasiados intentos fallidos. Espera 15 minutos.' });
    }
    const body = credentialsSchema.parse(req.body);
    const user = getUserByEmail(body.email.toLowerCase());
    // Sin usuario se verifica igualmente contra un hash señuelo: así la respuesta
    // tarda lo mismo exista o no el email y el tiempo no delata qué cuentas hay.
    const ok = await verifyPasswordAsync(body.password, user?.password_hash ?? decoyPasswordHash());
    if (!user || !ok) {
      recordLoginFailure(req.ip);
      audit(req, 'login_failed', { type: 'user', id: body.email.toLowerCase() });
      return reply.code(401).send({ error: 'Credenciales incorrectas' });
    }
    clearLoginFailures(req.ip);
    setAuthCookie(reply, signToken(user.id), req.protocol === 'https');
    audit(req, 'login', { type: 'user', id: user.id, detail: user.email }, user.email);
    return { user: publicUser(user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    audit(req, 'logout');
    clearAuthCookie(reply);
    return { ok: true };
  });

  app.register(async (secured) => {
    // Cambiar contraseña exige sesión de navegador, no un token de API.
    secured.addHook('preHandler', requireSession);

    secured.post('/api/auth/password', async (req, reply) => {
      const body = z
        .object({
          current: z.string().min(1, 'Contraseña actual requerida'),
          next: z.string().min(8, 'La nueva contraseña debe tener al menos 8 caracteres'),
        })
        .parse(req.body);
      const user = currentUser(req)!;
      if (!(await verifyPasswordAsync(body.current, user.password_hash))) {
        return reply.code(401).send({ error: 'La contraseña actual no es correcta' });
      }
      const nextHash = await hashPasswordAsync(body.next);
      // La cuenta pudo borrarse mientras se calculaba el hash.
      if (!getUser(user.id)) return reply.code(401).send({ error: 'No autenticado' });
      updateUserPassword(user.id, nextHash);
      // El bump de epoch invalida las cookies previas; renovamos la del solicitante.
      setAuthCookie(reply, signToken(user.id), req.protocol === 'https');
      audit(req, 'password_changed', { type: 'user', id: user.id });
      return { ok: true };
    });
  });
}
