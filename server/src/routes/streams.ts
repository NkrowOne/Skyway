import os from 'os';
import { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth';
import { getProject, getService, listServices } from '../db';
import { dockerAvailable } from '../docker/client';
import { containerName, followLogs, getRuntime, getStats } from '../docker/containers';
import { sseInit } from '../sse';

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Logs de ejecución del contenedor en vivo (SSE), con reintento si aún no existe. */
  app.get('/api/services/:id/logs/stream', async (req, reply) => {
    const { id } = req.params as { id: string };
    const service = getService(id);
    const project = service ? getProject(service.project_id) : undefined;
    if (!service || !project) return reply.code(404).send({ error: 'Servicio no encontrado' });

    const channel = sseInit(reply);
    const name = containerName(project, service);
    let stopStream: (() => void) | null = null;
    let retryTimer: NodeJS.Timeout | null = null;

    const attach = async (): Promise<void> => {
      if (channel.closed) return;
      if (!(await dockerAvailable())) {
        channel.send('notice', { message: 'Docker no está disponible' });
        retryTimer = setTimeout(attach, 5000);
        return;
      }
      const runtime = await getRuntime(name);
      if (runtime.state === 'not_created') {
        channel.send('notice', { message: 'El contenedor aún no existe. Esperando...' });
        retryTimer = setTimeout(attach, 3000);
        return;
      }
      try {
        channel.send('attached', { state: runtime.state });
        stopStream = await followLogs(name, (line) => channel.send('log', { line }));
      } catch {
        retryTimer = setTimeout(attach, 3000);
      }
    };

    channel.onClose(() => {
      if (retryTimer) clearTimeout(retryTimer);
      if (stopStream) stopStream();
    });

    void attach();
  });

  /** Métricas en vivo de todos los servicios de un proyecto (SSE). */
  app.get('/api/projects/:id/metrics/stream', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = getProject(id);
    if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });

    const channel = sseInit(reply);

    const tick = async (): Promise<void> => {
      if (channel.closed) return;
      const docker = await dockerAvailable();
      if (!docker) {
        channel.send('metrics', { ts: Date.now(), docker: false, services: {} });
        return;
      }
      const services = listServices(id);
      const entries = await Promise.all(
        services.map(async (s) => {
          const name = containerName(project, s);
          const runtime = await getRuntime(name);
          const stats = runtime.state === 'running' ? await getStats(name) : null;
          return [s.id, { state: runtime.state, stats }] as const;
        }),
      );
      const load = os.loadavg()[0];
      channel.send('metrics', {
        ts: Date.now(),
        docker: true,
        host: {
          cpus: os.cpus().length,
          load: Math.round(load * 100) / 100,
          totalMem: os.totalmem(),
          freeMem: os.freemem(),
        },
        services: Object.fromEntries(entries),
      });
    };

    void tick();
    const interval = setInterval(tick, 2500);
    channel.onClose(() => clearInterval(interval));
  });
}
