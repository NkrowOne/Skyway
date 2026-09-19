import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth';
import { checkDomain, getServerIp } from '../domains';
import { rateLimit } from '../ratelimit';

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Tope de comprobaciones de DNS por usuario y minuto. Cada una consulta al
 * resolutor (y, sin IP configurada, a un servicio externo): sin tope, el panel
 * servía de proxy para sondear dominios ajenos a granel.
 */
const CHECKS_POR_MINUTO = 30;

export async function domainRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/domains/server-ip', async () => getServerIp());

  app.post('/api/domains/check', { preHandler: rateLimit({ max: CHECKS_POR_MINUTO, windowMs: 60_000 }) }, async (req, reply) => {
    const body = z.object({ domain: z.string().trim().toLowerCase().max(253) }).parse(req.body);
    if (!DOMAIN_RE.test(body.domain)) {
      return reply.code(400).send({ error: `"${body.domain}" no parece un dominio válido (ej: app.midominio.com)` });
    }
    return { check: await checkDomain(body.domain) };
  });
}
