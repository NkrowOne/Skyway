import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireAuth } from '../auth';
import { accessibleService, ask, scanIssues } from '../help/assistant';
import { FAQ, FAQ_CATEGORIES } from '../help/faq';
import { rateLimit } from '../ratelimit';

/**
 * Peticiones por minuto y usuario al asistente y al análisis de problemas: cada
 * una puede leer logs de Docker (el análisis, los de hasta 60 servicios).
 */
const PREGUNTAS_POR_MINUTO = 30;

const askSchema = z.object({
  question: z.string().trim().min(1, 'Introduzca una pregunta').max(500, 'La pregunta no puede superar los 500 caracteres'),
  serviceId: z.string().trim().min(1).optional(),
});

/**
 * Centro de ayuda: FAQ, asistente determinista y detección de problemas.
 * Todo es de solo lectura, así que no se audita; el acceso a un servicio se
 * comprueba con la misma regla que el resto del panel y, si no se ve, se
 * responde 404 (no 403) para no confirmar que el id existe.
 */
export async function helpRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/help/faq', async () => ({ categories: FAQ_CATEGORIES, entries: FAQ }));

  app.post('/api/help/ask', { preHandler: rateLimit({ max: PREGUNTAS_POR_MINUTO, windowMs: 60_000 }) }, async (req, reply) => {
    const body = askSchema.parse(req.body);
    if (body.serviceId && !accessibleService(currentUser(req)!, body.serviceId)) {
      return reply.code(404).send({ error: 'Servicio no encontrado' });
    }
    return ask({ question: body.question, serviceId: body.serviceId, req });
  });

  app.get('/api/help/issues', { preHandler: rateLimit({ max: PREGUNTAS_POR_MINUTO, windowMs: 60_000 }) }, async (req, reply) => {
    const q = z.object({ serviceId: z.string().trim().min(1).optional() }).parse(req.query);
    const result = await scanIssues(currentUser(req)!, q.serviceId);
    if (!result) return reply.code(404).send({ error: 'Servicio no encontrado' });
    return result;
  });
}
