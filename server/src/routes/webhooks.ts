import { FastifyInstance } from 'fastify';
import { auditSystem } from '../audit';
import { noteAutoDeployBaseline } from '../autodeploy';
import { getService, lastBuiltCommitSha } from '../db';
import { getStripeWebhookSecret } from '../company';
import { verifyStripeSignature } from '../stripe';
import { markInvoicePaidByStripeSession } from './billing';
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

      // Borrado de rama (git push --delete): no hay nada que construir.
      if (payload?.deleted === true) {
        return { ok: true, ignored: 'rama eliminada' };
      }

      // La opción de auto-deploy manda en AMBOS caminos (sondeo y webhook): si el
      // usuario la desactiva, un push no despliega. Ausente = activado (opt-out).
      if (cfg.autoDeploy === false) {
        return { ok: true, ignored: 'auto-deploy desactivado en este servicio' };
      }

      // Cabeza del push (sha completo). Si ya se construyó ese commit —por el
      // sondeo, un deploy manual o un webhook anterior— no se repite.
      const head = (payload?.after as string | undefined) || (payload?.head_commit?.id as string | undefined) || null;
      if (head && head === lastBuiltCommitSha(service.id)) {
        return { ok: true, ignored: `commit ${head.slice(0, 7)} ya desplegado` };
      }

      // Sincroniza la línea base del sondeo para que no vuelva a encolar este commit.
      if (head) noteAutoDeployBaseline(service.id, head);

      const commit = head?.slice(0, 7);
      auditSystem('webhook_push', `${service.name}${commit ? ` @ ${commit}` : ''}`);
      markManualAction(service.id);
      const deployment = triggerDeploy(service.id, 'webhook');
      return { ok: true, deployment: { id: deployment.id, status: deployment.status } };
    });

    /**
     * Webhook de Stripe: al completarse el pago de una factura, se marca como
     * pagada. La firma se verifica con el secreto del endpoint (HMAC + tiempo);
     * sin firma válida, 401. Configura la URL /api/webhooks/stripe en Stripe.
     */
    scope.post('/api/webhooks/stripe', async (req, reply) => {
      const secret = getStripeWebhookSecret();
      if (!secret) return reply.code(400).send({ error: 'Webhook de Stripe no configurado' });
      const rawBody = (req as any).rawBody as string | undefined;
      const sig = req.headers['stripe-signature'] as string | undefined;
      if (!rawBody || !verifyStripeSignature(rawBody, sig, secret)) {
        return reply.code(401).send({ error: 'Firma inválida' });
      }
      const event = req.body as any;
      // `completed` cubre el pago inmediato (tarjeta); `async_payment_succeeded`
      // cubre los métodos diferidos (p. ej. SEPA) que liquidan después de cerrar
      // la sesión. En AMBOS exigimos payment_status === 'paid': la sesión puede
      // cerrarse («complete») sin que el cobro esté aún liquidado.
      if (event?.type === 'checkout.session.completed' || event?.type === 'checkout.session.async_payment_succeeded') {
        const session = event.data?.object;
        const sessionId = session?.id as string | undefined;
        if (sessionId && session?.payment_status === 'paid') {
          if (markInvoicePaidByStripeSession(sessionId)) auditSystem('invoice_paid_stripe', sessionId);
        }
      }
      return { received: true };
    });
  });
}
