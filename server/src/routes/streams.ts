import os from 'os';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertProjectAccess, requireAuth } from '../auth';
import { activeDeploymentsByProject, getProject, getService, listServices } from '../db';
import { onDeployFeed, toDeployFeedItem } from '../events';
import { dockerAvailable } from '../docker/client';
import {
  configuredReplicas,
  containerName,
  fetchLogsBefore,
  fetchLogsText,
  followLogs,
  getRuntime,
  getStats,
  replicaName,
} from '../docker/containers';
import { sseInit } from '../sse';

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Logs de ejecución del contenedor en vivo (SSE), con reintento si aún no existe. */
  app.get('/api/services/:id/logs/stream', async (req, reply) => {
    const { id } = req.params as { id: string };
    const service = getService(id);
    const project = service ? getProject(service.project_id) : undefined;
    if (!service || !project) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, project.id)) return reply;

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
        // Cada línea viaja con su cursor (sello de tiempo); el visor lo oculta
        // pero lo usa como punto de partida para pedir líneas más antiguas.
        stopStream = await followLogs(name, (row) => channel.send('log', row));
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

  /**
   * Página hacia atrás en los logs de ejecución: devuelve líneas ANTERIORES al
   * cursor dado, para que el visor cargue historial al subir. Fuera del stream
   * en vivo por ser puntual (una petición por «cargar anteriores»).
   */
  app.get('/api/services/:id/logs/tail', async (req, reply) => {
    const { id } = req.params as { id: string };
    const service = getService(id);
    const project = service ? getProject(service.project_id) : undefined;
    if (!service || !project) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, project.id)) return reply;

    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(1000).default(300),
        before: z.string().min(1).max(40).optional(),
      })
      .parse(req.query);

    if (!(await dockerAvailable())) return { lines: [], hasMore: false };
    const name = containerName(project, service);
    const runtime = await getRuntime(name);
    if (runtime.state === 'not_created') return { lines: [], hasMore: false };

    const lines = await fetchLogsBefore(name, q.limit, q.before ?? null);
    // Si Docker devuelve la página completa es que probablemente hay más atrás.
    return { lines, hasMore: lines.length >= q.limit };
  });

  /**
   * Descarga íntegra de los logs de ejecución (todo el buffer del contenedor,
   * no solo lo que el visor tiene en memoria). Se sirve como adjunto de texto.
   */
  app.get('/api/services/:id/logs/download', async (req, reply) => {
    const { id } = req.params as { id: string };
    const service = getService(id);
    const project = service ? getProject(service.project_id) : undefined;
    if (!service || !project) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, project.id)) return reply;

    const q = z.object({ timestamps: z.string().optional() }).parse(req.query);

    if (!(await dockerAvailable())) return reply.code(409).send({ error: 'Docker no está disponible' });
    const name = containerName(project, service);
    const runtime = await getRuntime(name);
    if (runtime.state === 'not_created') return reply.code(409).send({ error: 'El contenedor aún no existe' });

    const text = await fetchLogsText(name, 'all', q.timestamps === '1');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="logs-${service.slug}-${stamp}.txt"`);
    return text;
  });

  /**
   * Despliegues del proyecto en vivo (SSE). A diferencia del stream de logs de
   * UN despliegue, este avisa al panel entero en el instante en que arranca o
   * cambia de fase cualquiera: así la rejilla de servicios puede anunciar que
   * hay una versión nueva saliendo sin que nadie tenga abierto ese servicio.
   */
  app.get('/api/projects/:id/deploys/stream', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = getProject(id);
    if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    if (!assertProjectAccess(req, reply, id)) return reply;

    const channel = sseInit(reply);
    // El bus es global: se filtra por proyecto antes de escribir en el socket.
    const unsubscribe = onDeployFeed((item) => {
      if (item.projectId !== id) return;
      channel.send('deploy', item);
    });
    channel.onClose(unsubscribe);

    // Estado inicial: lo que ya estuviera en marcha antes de abrir el stream,
    // con la misma forma que los eventos para que el cliente no distinga.
    channel.send('snapshot', {
      deploys: Object.values(activeDeploymentsByProject(id)).map((d) => toDeployFeedItem(d, id)),
    });
  });

  /** Métricas en vivo de todos los servicios de un proyecto (SSE). */
  app.get('/api/projects/:id/metrics/stream', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = getProject(id);
    if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    if (!assertProjectAccess(req, reply, id)) return reply;

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
          const total = configuredReplicas(s);
          let running = 0;
          let aggregated: { cpuPercent: number; memUsage: number; memLimit: number; netRx: number; netTx: number } | null = null;
          let firstState: string = 'not_created';
          for (let i = 1; i <= total; i++) {
            const name = replicaName(project, s, i);
            const runtime = await getRuntime(name);
            if (i === 1) firstState = runtime.state;
            if (runtime.state !== 'running') continue;
            running += 1;
            const stats = await getStats(name);
            if (stats) {
              if (!aggregated) aggregated = { cpuPercent: 0, memUsage: 0, memLimit: 0, netRx: 0, netTx: 0 };
              aggregated.cpuPercent = Math.round((aggregated.cpuPercent + stats.cpuPercent) * 10) / 10;
              aggregated.memUsage += stats.memUsage;
              // El límite se suma por réplica: si no, el % de RAM agregado
              // supera el 100% con el servicio perfectamente sano.
              aggregated.memLimit += stats.memLimit;
              aggregated.netRx += stats.netRx;
              aggregated.netTx += stats.netTx;
            }
          }
          const state = running === total && total > 0 ? 'running' : running > 0 ? firstState === 'running' ? 'running' : firstState : firstState;
          return [s.id, { state, stats: aggregated, replicas: { running, total } }] as const;
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
