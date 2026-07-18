import { FastifyInstance } from 'fastify';
import { auditSystem } from '../audit';
import { getService } from '../db';
import { triggerDeploy } from '../deploy/deployer';
import { markManualAction } from '../monitor';
import { GitConfig } from '../types';
import { hmacSha256, safeEqual } from '../util';

/**
 * Webhook de GitHub para auto-deploy en push.
 * Configura en GitHub: URL /api/webhooks/github/<serviceId>, content type JSON,
 * secreto = webhookSecret del servicio.
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.register(async (scope) => {
    // Parser propio que conserva el cuerpo crudo para verificar la firma HMAC.
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      (req as any).rawBody = body;
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    });

    scope.post('/api/webhooks/github/:serviceId', async (req, reply) => {
      const { serviceId } = req.params as { serviceId: string };
      const service = getService(serviceId);
      if (!service || service.type !== 'git') {
        return reply.code(404).send({ error: 'Servicio no encontrado' });
      }
      const cfg = service.config as GitConfig;

      const signature = req.headers['x-hub-signature-256'] as string | undefined;
      const rawBody = (req as any).rawBody as string | undefined;
      if (!signature || !rawBody || !cfg.webhookSecret) {
        return reply.code(401).send({ error: 'Firma requerida' });
      }
      const expected = `sha256=${hmacSha256(cfg.webhookSecret, rawBody)}`;
      if (!safeEqual(signature, expected)) {
        return reply.code(401).send({ error: 'Firma inválida' });
      }

      const event = req.headers['x-github-event'];
      if (event === 'ping') return { ok: true, pong: true };
      if (event !== 'push') return { ok: true, ignored: `evento ${event}` };

      const payload = req.body as any;
      const expectedRef = `refs/heads/${cfg.branch || 'main'}`;
      if (payload?.ref !== expectedRef) {
        return { ok: true, ignored: `ref ${payload?.ref} (se espera ${expectedRef})` };
      }

      const commit = (payload?.head_commit?.id as string | undefined)?.slice(0, 7);
      auditSystem('webhook_push', `${service.name}${commit ? ` @ ${commit}` : ''}`);
      markManualAction(service.id);
      const deployment = triggerDeploy(service.id, 'webhook');
      return { ok: true, deployment: { id: deployment.id, status: deployment.status } };
    });
  });
}
