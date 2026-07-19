import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assertProjectAccess, requireAuth } from '../auth';
import { audit } from '../audit';
import { getDeployment, getService, listDeployments } from '../db';
import { cancelDeployment, triggerDeploy } from '../deploy/deployer';
import { onDeploy } from '../events';
import { markManualAction } from '../monitor';
import { sseInit } from '../sse';

const ACTIVE = new Set(['queued', 'building', 'deploying']);

/** Acceso al workspace dueño del servicio del despliegue (404 si el servicio ya no existe). */
function serviceAccess(req: FastifyRequest, reply: FastifyReply, serviceId: string): boolean {
  const service = getService(serviceId);
  if (!service) {
    reply.code(404).send({ error: 'Servicio no encontrado' });
    return false;
  }
  return assertProjectAccess(req, reply, service.project_id);
}

export async function deploymentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/services/:id/deployments', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!serviceAccess(req, reply, id)) return reply;
    return { deployments: listDeployments(id, 25) };
  });

  app.get('/api/deployments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const deployment = getDeployment(id);
    if (!deployment) return reply.code(404).send({ error: 'Despliegue no encontrado' });
    if (!serviceAccess(req, reply, deployment.service_id)) return reply;
    return { deployment };
  });

  app.post('/api/deployments/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const deployment = getDeployment(id);
    if (!deployment) return reply.code(404).send({ error: 'Despliegue no encontrado' });
    if (!serviceAccess(req, reply, deployment.service_id)) return reply;
    if (!ACTIVE.has(deployment.status)) {
      return reply.code(400).send({ error: 'El despliegue ya terminó' });
    }
    if (!cancelDeployment(id)) {
      return reply.code(409).send({ error: 'No se pudo cancelar (puede haber terminado justo ahora)' });
    }
    audit(req, 'deployment_canceled', { type: 'deployment', id, detail: deployment.service_id });
    return { ok: true };
  });

  app.post('/api/deployments/:id/rollback', async (req, reply) => {
    const { id } = req.params as { id: string };
    const deployment = getDeployment(id);
    if (!deployment) return reply.code(404).send({ error: 'Despliegue no encontrado' });
    if (!serviceAccess(req, reply, deployment.service_id)) return reply;
    if (deployment.status !== 'success' || !deployment.image_tag) {
      return reply.code(400).send({ error: 'Solo se puede hacer rollback a un despliegue exitoso' });
    }
    const service = getService(deployment.service_id);
    if (!service) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (service.type !== 'git') {
      return reply.code(400).send({ error: 'Solo los servicios de repositorio soportan rollback (los de imagen fija se redespliegan directamente)' });
    }
    markManualAction(service.id);
    audit(req, 'service_rollback', { type: 'service', id: service.id, detail: `${service.name} → ${deployment.image_tag}` });
    const rollback = triggerDeploy(service.id, 'rollback', { imageTag: deployment.image_tag });
    reply.code(202);
    return { deployment: rollback };
  });

  /** Logs de build/deploy en vivo (SSE). Reproduce el histórico y sigue en directo. */
  app.get('/api/deployments/:id/logs/stream', async (req, reply) => {
    const { id } = req.params as { id: string };
    const deployment = getDeployment(id);
    if (!deployment) return reply.code(404).send({ error: 'Despliegue no encontrado' });
    if (!serviceAccess(req, reply, deployment.service_id)) return reply;

    const channel = sseInit(reply);

    const unsubscribe = onDeploy(id, (ev) => {
      if (ev.type === 'log') channel.send('log', { line: ev.line });
      else if (ev.type === 'status') channel.send('status', { status: ev.status });
      else if (ev.type === 'done') {
        channel.send('done', { status: ev.status, error: ev.error ?? null });
        setTimeout(() => channel.close(), 100);
      }
    });
    channel.onClose(unsubscribe);

    channel.send('snapshot', { logs: deployment.logs, status: deployment.status });
    if (!ACTIVE.has(deployment.status)) {
      channel.send('done', { status: deployment.status, error: deployment.error });
      setTimeout(() => channel.close(), 100);
    }
  });
}
