import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth';
import { countUnreadAlerts, listAlerts, markAlertsRead, resolveAlert } from '../db';

export async function alertRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/alerts', async (req) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).optional(),
        open: z.enum(['true', 'false']).optional(),
      })
      .parse(req.query);
    return {
      alerts: listAlerts({ limit: query.limit, openOnly: query.open === 'true' }),
      unread: countUnreadAlerts(),
    };
  });

  app.post('/api/alerts/read-all', async () => {
    markAlertsRead();
    return { ok: true };
  });

  app.post('/api/alerts/:id/resolve', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!resolveAlert(id)) return reply.code(404).send({ error: 'Alerta no encontrada o ya resuelta' });
    return { ok: true };
  });
}
