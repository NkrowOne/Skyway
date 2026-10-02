import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canAccessProject, currentUser, requireAuth } from '../auth';
import {
  countUnreadAlerts,
  getAlert,
  listAlerts,
  listUserProjectIds,
  listWorkspaceProjects,
  markAlertsRead,
  resolveAlert,
} from '../db';
import { UserRow } from '../types';

/**
 * undefined = sin restricción (admin); lista = solo esos proyectos. Replica la
 * regla de `canAccessProject`: el propietario ve TODOS los proyectos de su
 * workspace, el miembro solo los asignados. A los propietarios no se les escriben
 * filas en `user_projects`, así que consultar solo esa tabla dejaba su campana y
 * su página de alertas siempre vacías.
 */
function alertScope(user: UserRow): string[] | undefined {
  if (user.role === 'admin') return undefined;
  const ids = new Set(listUserProjectIds(user.id));
  if (user.role === 'owner' && user.workspace_id) {
    for (const project of listWorkspaceProjects(user.workspace_id)) ids.add(project.id);
  }
  return [...ids];
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
