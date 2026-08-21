import os from 'os';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertProjectAccess, requireAuth } from '../auth';
import { activeDeploymentsByProject, getProject, getService, listServices } from '../db';
import { dockerSnapshot } from '../docker/sampler';
import { onDeployFeed, toDeployFeedItem } from '../events';
import { dockerAvailable } from '../docker/client';
import {
  configuredReplicas,
  containerName,
  fetchLogsBefore,
  fetchLogsText,
  followLogs,
  getRuntime,
} from '../docker/containers';
import { sseInit } from '../sse';

/**
 * Antigüedad que tolera el stream de métricas. Va por debajo del intervalo del
 * temporizador para que cada ciclo traiga datos nuevos —lo cual solo se cumple
 * porque la foto se fecha al empezar a muestrear y no al terminar; si no, un
 * muestreo de un segundo se serviría dos veces y el refresco real sería de
 * 5 s—. Aun así es el muestreador quien decide si hay que preguntar a Docker:
 * con varias pestañas abiertas, todas comparten la misma foto.
 */
const SAMPLE_MAX_AGE_MS = 2000;
const METRICS_TICK_MS = 2500;

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

    // Los despliegues viajan por este mismo stream: el panel de proyecto
    // necesita las dos cosas a la vez y el navegador solo abre seis conexiones
    // por host en HTTP/1.1 (un túnel SSH, sin ir más lejos). El aviso de
    // despliegue sigue siendo instantáneo —sale del bus, no del temporizador—.
    const unsubscribe = onDeployFeed((item) => {
      if (item.projectId === id) channel.send('deploy', item);
    });
    channel.onClose(unsubscribe);
    channel.send('deploys', {
      deploys: Object.values(activeDeploymentsByProject(id)).map((d) => toDeployFeedItem(d, id)),
    });

    let ticking = false;
    const tick = async (): Promise<void> => {
      // Sin esta guarda, un ciclo que tarde más que el intervalo apila ciclos
      // encima —y cada uno tarda más que el anterior—. Con muchos servicios es
      // lo que convierte el panel en una máquina de martillear a Docker.
      if (channel.closed || ticking) return;
      ticking = true;
      try {
        const snap = await dockerSnapshot(SAMPLE_MAX_AGE_MS);
        if (channel.closed) return;
        if (!snap.docker) {
          channel.send('metrics', { ts: snap.at, docker: false, services: {} });
          return;
        }
        const services: Record<string, unknown> = {};
        for (const s of listServices(id)) {
          const sample = snap.byService.get(s.id);
          services[s.id] = {
            state: sample?.state ?? 'not_created',
            stats: sample?.stats ?? null,
            replicas: sample?.replicas ?? { running: 0, total: configuredReplicas(s) },
          };
        }
        const load = os.loadavg()[0];
        channel.send('metrics', {
          ts: snap.at,
          docker: true,
          host: {
            cpus: os.cpus().length,
            load: Math.round(load * 100) / 100,
            totalMem: os.totalmem(),
            freeMem: os.freemem(),
          },
          services,
        });
      } catch (err: any) {
        req.log.warn(`stream de métricas: ${err?.message || err}`);
      } finally {
        ticking = false;
      }
    };

    void tick();
    const interval = setInterval(tick, METRICS_TICK_MS);
    channel.onClose(() => clearInterval(interval));
  });
}
