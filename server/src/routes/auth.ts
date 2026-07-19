import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  clearAuthCookie,
  clearLoginFailures,
  currentUser,
  loginBlocked,
  recordLoginFailure,
  requireAuth,
  setAuthCookie,
  signToken,
  userIdFromRequest,
} from '../auth';
import { audit } from '../audit';
import { countUsers, createUser, getUser, getUserByEmail, updateUserPassword } from '../db';
import { hashPassword, verifyPassword } from '../util';

const credentialsSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/auth/me', async (req) => {
    const needsSetup = countUsers() === 0;
    const user = currentUser(req);
    return {
      needsSetup,
      user: user ? { id: user.id, email: user.email, role: user.role } : null,
    };
  });

  app.post('/api/auth/setup', async (req, reply) => {
    if (countUsers() > 0) {
      return reply.code(403).send({ error: 'Skyway ya está configurado' });
    }
    const body = credentialsSchema.parse(req.body);
    // El primer usuario es siempre el administrador del servidor.
    const user = createUser(body.email.toLowerCase(), hashPassword(body.password), 'admin');
    setAuthCookie(reply, signToken(user.id), req.protocol === 'https');
    audit(req, 'setup', { type: 'user', id: user.id, detail: user.email }, user.email);
    return { user: { id: user.id, email: user.email, role: user.role } };
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (loginBlocked(req.ip)) {
      audit(req, 'login_blocked', { type: 'ip', id: req.ip });
      return reply.code(429).send({ error: 'Demasiados intentos fallidos. Espera 15 minutos.' });
    }
    const body = credentialsSchema.parse(req.body);
    const user = getUserByEmail(body.email.toLowerCase());
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      recordLoginFailure(req.ip);
      audit(req, 'login_failed', { type: 'user', id: body.email.toLowerCase() });
      return reply.code(401).send({ error: 'Credenciales incorrectas' });
    }
    clearLoginFailures(req.ip);
    setAuthCookie(reply, signToken(user.id), req.protocol === 'https');
    audit(req, 'login', { type: 'user', id: user.id, detail: user.email }, user.email);
    return { user: { id: user.id, email: user.email, role: user.role } };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    audit(req, 'logout');
    clearAuthCookie(reply);
    return { ok: true };
  });

  app.register(async (secured) => {
    secured.addHook('preHandler', requireAuth);

    secured.post('/api/auth/password', async (req, reply) => {
      const body = z
        .object({
          current: z.string().min(1, 'Contraseña actual requerida'),
          next: z.string().min(8, 'La nueva contraseña debe tener al menos 8 caracteres'),
        })
        .parse(req.body);
      const userId = userIdFromRequest(req)!;
      const user = getUser(userId)!;
      if (!verifyPassword(body.current, user.password_hash)) {
        return reply.code(401).send({ error: 'La contraseña actual no es correcta' });
      }
      updateUserPassword(userId, hashPassword(body.next));
      audit(req, 'password_changed', { type: 'user', id: userId });
      return { ok: true };
    });
  });
}
