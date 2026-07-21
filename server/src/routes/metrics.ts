import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertProjectAccess, requireAuth } from '../auth';
import { getProject, getService, serviceMetricsRange } from '../db';
import { bucketServiceMetrics } from '../metrics';

const rangeSchema = z.object({
  hours: z.coerce.number().int().min(1).max(24 * 90).default(24),
});

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /**
   * Histórico de consumo de un servicio (CPU/RAM/red/disco) agrupado por cubos
   * según la ventana pedida (`?hours=`): media y pico por cubo, y bytes de red
   * del periodo. Los datos los alimenta el monitor cada 30 s.
   */
  app.get('/api/services/:id/metrics/history', async (req, reply) => {
    const { id } = req.params as { id: string };
    const service = getService(id);
    const project = service ? getProject(service.project_id) : undefined;
    if (!service || !project) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, project.id)) return reply;

    const { hours } = rangeSchema.parse(req.query);
    const points = bucketServiceMetrics(serviceMetricsRange(id, hours), hours);
    return { hours, points };
  });
}
