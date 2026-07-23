import os from 'os';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertProjectAccess, requireAuth } from '../auth';
import { getProject, getService, listServices } from '../db';
import { dockerAvailable } from '../docker/client';
import {
  configuredReplicas,
  containerName,
  fetchLogsBefore,
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

    // Cola inicial del vivo (primer pintado). El historial más antiguo se pagina
    // aparte con «Cargar más» (GET .../logs/history), no reabriendo el stream. Se
    // acota para no ahogar al móvil; un valor inválido cae al de por defecto.
    const { tail } = z.object({ tail: z.coerce.number().int().min(50).max(2000).catch(200) }).parse(req.query);

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
        stopStream = await followLogs(
          name,
          (raw) => {
            // followLogs entrega «<timestamp> <línea>»: se separa el timestamp de
            // Docker (cursor de «Cargar más») y se envía la línea limpia para mostrar.
            const idx = raw.indexOf(' ');
            const ts = idx > 0 ? raw.slice(0, idx) : null;
            const line = idx > 0 ? raw.slice(idx + 1) : raw;
            channel.send('log', { line, ts });
          },
          tail,
        );
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

  /** Historial de logs hacia atrás: bloque de líneas ANTERIORES a `before`, para
   *  el botón «Cargar más» del visor. Se pagina bajo demanda (no arrastra todo). */
  app.get('/api/services/:id/logs/history', async (req, reply) => {
    const { id } = req.params as { id: string };
    const service = getService(id);
    const project = service ? getProject(service.project_id) : undefined;
    if (!service || !project) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, project.id)) return reply;

    const { before, limit } = z
      .object({ before: z.string().min(1), limit: z.coerce.number().int().min(1).max(500).catch(200) })
      .parse(req.query);

    if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });
    const name = containerName(project, service);
    const runtime = await getRuntime(name);
    if (runtime.state === 'not_created') return reply.send({ lines: [], reachedStart: true });
    try {
      return reply.send(await fetchLogsBefore(name, before, limit));
    } catch {
      return reply.send({ lines: [], reachedStart: false });
    }
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
