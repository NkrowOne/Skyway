import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth';
import { checkDomain, getServerIp } from '../domains';

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export async function domainRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/domains/server-ip', async () => getServerIp());

  app.post('/api/domains/check', async (req, reply) => {
    const body = z.object({ domain: z.string().trim().toLowerCase().max(253) }).parse(req.body);
    if (!DOMAIN_RE.test(body.domain)) {
      return reply.code(400).send({ error: `"${body.domain}" no parece un dominio válido (ej: app.midominio.com)` });
    }
    return { check: await checkDomain(body.domain) };
  });
}
