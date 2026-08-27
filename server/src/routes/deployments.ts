import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assertProjectAccess, requireAuth } from '../auth';
import { audit } from '../audit';
import { getDeployment, getProject, getService, listDeployments } from '../db';
import { cancelDeployment, triggerDeploy } from '../deploy/deployer';
import { dockerAvailable } from '../docker/client';
import { containerName, fetchLogsText, findContainer } from '../docker/containers';
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

  /** Devuelve el desglose estructurado de logs de un despliegue (Build, Deploy y Runtime). */
  app.get('/api/deployments/:id/logs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const deployment = getDeployment(id);
    if (!deployment) return reply.code(404).send({ error: 'Despliegue no encontrado' });
    if (!serviceAccess(req, reply, deployment.service_id)) return reply;

    const service = getService(deployment.service_id);
    const project = service ? getProject(service.project_id) : undefined;
    let runtimeLogs = deployment.runtime_logs ?? null;
    let isLiveRuntime = false;

    // Si el contenedor actual de este servicio pertenece a este despliegue,
    // podemos consultar sus logs de ejecución en vivo desde Docker.
    if (project && service && (await dockerAvailable())) {
      const cName = containerName(project, service);
      const info = await findContainer(cName);
      if (info && info.Config?.Labels?.['skyway.deployment'] === deployment.id) {
        isLiveRuntime = info.State.Running;
        try {
          const liveText = await fetchLogsText(cName, 2000, true);
          if (liveText) runtimeLogs = liveText;
        } catch {
          /* usar runtimeLogs archivado */
        }
      }
    }

    return {
      deploymentId: deployment.id,
      status: deployment.status,
      buildLogs: deployment.logs || '',
      runtimeLogs,
      isLiveRuntime,
      createdAt: deployment.created_at,
      finishedAt: deployment.finished_at,
    };
  });

  /** Descarga el log completo de un despliegue (build + deploy + runtime). */
  app.get('/api/deployments/:id/logs/download', async (req, reply) => {
    const { id } = req.params as { id: string };
    const deployment = getDeployment(id);
    if (!deployment) return reply.code(404).send({ error: 'Despliegue no encontrado' });
    if (!serviceAccess(req, reply, deployment.service_id)) return reply;

    const service = getService(deployment.service_id);
    const project = service ? getProject(service.project_id) : undefined;
    let runtimeLogs = deployment.runtime_logs || '';

    if (project && service && (await dockerAvailable())) {
      const cName = containerName(project, service);
      const info = await findContainer(cName);
      if (info && info.Config?.Labels?.['skyway.deployment'] === deployment.id) {
        try {
          const liveText = await fetchLogsText(cName, 'all', true);
          if (liveText) runtimeLogs = liveText;
        } catch {
          /* usar archivado */
        }
      }
    }

    const stamp = new Date(deployment.created_at).toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const serviceSlug = service?.slug ?? 'servicio';

    let fullText = `=== SKYWAY DEPLOYMENT LOG ===\n`;
    fullText += `Deployment ID: ${deployment.id}\n`;
    fullText += `Service: ${service?.name ?? deployment.service_id} (${serviceSlug})\n`;
    fullText += `Trigger: ${deployment.trigger}\n`;
    fullText += `Status: ${deployment.status}\n`;
    if (deployment.commit_sha) fullText += `Commit: ${deployment.commit_sha} - ${deployment.commit_msg ?? ''}\n`;
    fullText += `Date: ${new Date(deployment.created_at).toISOString()}\n`;
    fullText += `==========================================\n\n`;

    fullText += `--- BUILD & DEPLOY LOGS ---\n`;
    fullText += (deployment.logs || 'Sin logs de build.') + '\n\n';

    if (runtimeLogs) {
      fullText += `--- RUNTIME / APPLICATION LOGS ---\n`;
      fullText += runtimeLogs + '\n';
    }

    reply.header('Content-Type', 'text/plain; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="deploy-${serviceSlug}-${deployment.id}-${stamp}.txt"`);
    return fullText;
  });
}
