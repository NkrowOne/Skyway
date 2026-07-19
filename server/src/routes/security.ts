import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, rotateJwtSecret, setAuthCookie, signToken, userIdFromRequest } from '../auth';
import { audit } from '../audit';
import { config } from '../config';
import { countFailedLogins, listAudit } from '../db';
import { securityFindings } from '../security';

export async function securityRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/security', async () => {
    const { findings, score, grade } = await securityFindings();
    const failed24h = countFailedLogins(24 * 3600 * 1000);
    return {
      score,
      grade,
      findings,
      failedLogins24h: failed24h.count,
      jwtFromEnv: !!config.jwtSecretEnv,
    };
  });

  app.get('/api/audit', async (req) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).optional(),
        action: z.string().trim().optional(),
      })
      .parse(req.query);
    return { entries: listAudit({ limit: query.limit, action: query.action || undefined }) };
  });

  /** Invalida todas las sesiones (rota el secreto JWT) y renueva la del solicitante. */
  app.post('/api/security/rotate-sessions', async (req, reply) => {
    if (config.jwtSecretEnv) {
      return reply.code(400).send({
        error: 'JWT_SECRET viene de una variable de entorno: cámbialo ahí y reinicia Skyway para invalidar sesiones.',
      });
    }
    const userId = userIdFromRequest(req)!;
    rotateJwtSecret();
    setAuthCookie(reply, signToken(userId), req.protocol === 'https');
    audit(req, 'sessions_rotated', { type: 'user', id: userId });
    return { ok: true };
  });
}
