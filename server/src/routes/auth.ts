import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clearAuthCookie, setAuthCookie, signToken, userIdFromRequest } from '../auth';
import { countUsers, createUser, getUser, getUserByEmail } from '../db';
import { hashPassword, verifyPassword } from '../util';

const credentialsSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/auth/me', async (req) => {
    const needsSetup = countUsers() === 0;
    const userId = userIdFromRequest(req);
    const user = userId ? getUser(userId) : undefined;
    return {
      needsSetup,
      user: user ? { id: user.id, email: user.email } : null,
    };
  });

  app.post('/api/auth/setup', async (req, reply) => {
    if (countUsers() > 0) {
      return reply.code(403).send({ error: 'Skyway ya está configurado' });
    }
    const body = credentialsSchema.parse(req.body);
    const user = createUser(body.email.toLowerCase(), hashPassword(body.password));
    setAuthCookie(reply, signToken(user.id), req.protocol === 'https');
    return { user: { id: user.id, email: user.email } };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = credentialsSchema.parse(req.body);
    const user = getUserByEmail(body.email.toLowerCase());
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      return reply.code(401).send({ error: 'Credenciales incorrectas' });
    }
    setAuthCookie(reply, signToken(user.id), req.protocol === 'https');
    return { user: { id: user.id, email: user.email } };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    clearAuthCookie(reply);
    return { ok: true };
  });
}
