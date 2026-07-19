import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canAccessProject, currentUser, requireAuth } from '../auth';
import { countUnreadAlerts, getAlert, listAlerts, listUserProjectIds, markAlertsRead, resolveAlert } from '../db';
import { UserRow } from '../types';

/** undefined = sin restricción (admin); lista = solo esos workspaces (member). */
function alertScope(user: UserRow): string[] | undefined {
  return user.role === 'admin' ? undefined : listUserProjectIds(user.id);
}

export async function alertRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/alerts', async (req) => {
    const user = currentUser(req)!;
    const projectIds = alertScope(user);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).optional(),
        open: z.enum(['true', 'false']).optional(),
      })
      .parse(req.query);
    return {
      alerts: listAlerts({ limit: query.limit, openOnly: query.open === 'true', projectIds }),
      unread: countUnreadAlerts(projectIds),
    };
  });

  app.post('/api/alerts/read-all', async (req) => {
    markAlertsRead(alertScope(currentUser(req)!));
    return { ok: true };
  });

  app.post('/api/alerts/:id/resolve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const alert = getAlert(id);
    if (!alert) return reply.code(404).send({ error: 'Alerta no encontrada o ya resuelta' });
    const user = currentUser(req)!;
    if (user.role !== 'admin' && (!alert.project_id || !canAccessProject(user, alert.project_id))) {
      return reply.code(403).send({ error: 'No tienes acceso a esta alerta' });
    }
    if (!resolveAlert(id)) return reply.code(404).send({ error: 'Alerta no encontrada o ya resuelta' });
    return { ok: true };
  });
}
