import os from 'os';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canAccessProjectRow, currentUser, requireAuth } from '../auth';
import {
  hostMetricsRange,
  latestDeploymentsByService,
  listProjects,
  listServicesForProjects,
  openAlertCountsByService,
  uptimePercentBatch,
} from '../db';
import { explainExitCode } from '../deploy/diagnose';
import { diskUsageByService, hostDisk } from '../disk';
import { bucketHostMetrics } from '../metrics';
import { docker, dockerAvailable } from '../docker/client';
import {
  aggregateReplicaState,
  configuredReplicas,
  fetchLogsTail,
  replicaName,
} from '../docker/containers';
import { dockerSnapshot } from '../docker/sampler';
import { rateLimit } from '../ratelimit';
import { ContainerState, ProjectRow, ServiceRow } from '../types';

/** Proyectos visibles para el usuario de la petición (admin: todos). */
function accessibleProjects(req: any): ProjectRow[] {
  const user = currentUser(req)!;
  return listProjects().filter((p) => canAccessProjectRow(user, p));
}

/**
 * Antigüedad tolerada de la foto de Docker en las vistas de Monitor. La página
 * se refresca cada 60 s, así que unos segundos de retraso no se notan y a
 * cambio comparte muestreo con el resto del panel.
 */
const OVERVIEW_MAX_AGE_MS = 5000;

/** Núcleos del host: no cambian en caliente, y `os.cpus()` construye la lista entera en cada llamada. */
const HOST_CPUS = os.cpus().length;

/**
 * Búsqueda en logs: tope por usuario y minuto, plazo total y contenedores
 * consultados a la vez. Cada búsqueda pide la cola de log de TODOS los
 * contenedores accesibles, y el socket de Docker atiende en serie: sin acotar,
 * dos personas buscando a la vez ya frenaban el panel entero.
 */
const BUSQUEDAS_POR_MINUTO = 10;
const BUSQUEDA_PLAZO_MS = 15_000;
const BUSQUEDA_CONCURRENCIA = 4;

/** Ejecuta las tareas con un tope de concurrencia, conservando el orden. */
async function pooled<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      out[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Espera a `work` como mucho `ms`; al vencer, `onFail`. Nunca rechaza: quien
 * busca prefiere un contenedor sin resultado a quedarse colgado, porque el
 * cliente de Docker no impone ningún tope propio.
 */
function withTimeout<T>(work: Promise<T>, ms: number, onFail: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(onFail()), Math.max(1, ms));
    timer.unref();
    work.then(finish, () => finish(onFail()));
  });
}

export async function monitorRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /**
   * Vista global: estado en vivo de todos los servicios de todos los proyectos
   * accesibles, con métricas, alertas, último despliegue y uso de disco.
   */
  app.get('/api/monitor/overview', async (req) => {
    const projects = accessibleProjects(req);
    // Una sola foto para toda la vista: antes cada servicio pedía su inspect y
    // su stats por separado, y `stats` cuesta ~1 s por contenedor. Es la foto
    // quien dice si Docker respondía (ver la nota en websites.ts).
    const snap = await dockerSnapshot(OVERVIEW_MAX_AGE_MS, { stats: true });
    const dockerUp = snap.docker;
    const disk = dockerUp ? await diskUsageByService().catch(() => null) : null;

    // Servicios, último despliegue y disponibilidad de TODOS los proyectos en
    // tres consultas: la vista se sondea cada 6 s y antes eran dos por servicio
    // más una por proyecto.
    const servicesByProject = listServicesForProjects(projects.map((p) => p.id));
    const allServices = [...servicesByProject.values()].flat();
    const serviceIds = allServices.map((s) => s.id);
    const lastDeploys = latestDeploymentsByService(serviceIds);
    const uptime24h = uptimePercentBatch(serviceIds, 24);

    const services: any[] = [];
    for (const project of projects) {
      const alertCounts = openAlertCountsByService(project.id);
      for (const service of servicesByProject.get(project.id) ?? []) {
        const cfg = service.config as any;
        const total = configuredReplicas(service);
        let running = 0;
        let restartCount = 0;
        const states: ContainerState[] = [];
        let startedAt: string | null = null;
        let exitCode: number | null = null;
        let stats: { cpuPercent: number; memUsage: number; memLimit: number } | null = null;

        if (dockerUp) {
          const sample = snap.byService.get(service.id);
          for (let i = 1; i <= total; i++) {
            const replica = sample?.perReplica.find((r) => r.index === i);
            if (!replica || replica.unreachable) continue;
            const runtime = replica.runtime;
            states.push(runtime.state);
            restartCount += runtime.restartCount;
            if (runtime.state === 'running') {
              running += 1;
              if (!startedAt) startedAt = runtime.startedAt;
              const s = replica.stats;
              if (s) {
                if (!stats) stats = { cpuPercent: 0, memUsage: 0, memLimit: 0 };
                stats.cpuPercent = Math.round((stats.cpuPercent + s.cpuPercent) * 10) / 10;
                stats.memUsage += s.memUsage;
                // El límite también se suma: usar solo el de la primera
                // réplica pintaba >100% de RAM en servicios sanos.
                stats.memLimit += s.memLimit;
              }
            } else if (exitCode === null && runtime.exitCode !== null) {
              exitCode = runtime.exitCode;
            }
          }
        }

        const state = aggregateReplicaState(states);
        const lastDeploy = lastDeploys.get(service.id) ?? null;
        const du = disk?.get(service.id);
        const isDown = state === 'exited' || state === 'dead';

        services.push({
          id: service.id,
          projectId: project.id,
          projectName: project.name,
          client: project.client,
          name: service.name,
          slug: service.slug,
          type: service.type,
          template: service.type === 'database' ? cfg.template : undefined,
          image: service.type === 'image' ? cfg.image : undefined,
          domains: cfg.domains ?? [],
          state,
          startedAt,
          exitCode: isDown ? exitCode : null,
          exitExplanation: isDown && exitCode !== null ? explainExitCode(exitCode) : null,
          stoppedAt: service.stopped_at ?? null,
          restartCount,
          replicas: { running, total },
          stats,
          memoryMb: cfg.memoryMb ?? null,
          cpus: cfg.cpus ?? null,
          alerts: alertCounts[service.id] ?? 0,
          lastDeploy: lastDeploy
            ? { id: lastDeploy.id, status: lastDeploy.status, created_at: lastDeploy.created_at }
            : null,
          disk: du
            ? { totalBytes: du.totalBytes, quotaMb: du.quotaMb }
            : { totalBytes: null, quotaMb: cfg.diskMb ?? null },
          uptime24h: uptime24h.get(service.id) ?? null,
        });
      }
    }

    return {
      docker: dockerUp,
      host: {
        cpus: HOST_CPUS,
        load: Math.round(os.loadavg()[0] * 100) / 100,
        totalMem: os.totalmem(),
        freeMem: os.freemem(),
        disk: await hostDisk(),
      },
      services,
    };
  });

  /**
   * Busca un texto en las últimas líneas de log de todos los contenedores
   * accesibles: para depurar sin saber en qué servicio está el error.
   */
  app.get(
    '/api/monitor/logs/search',
    { preHandler: rateLimit({ max: BUSQUEDAS_POR_MINUTO, windowMs: 60_000 }) },
    async (req, reply) => {
      const params = z
        .object({
          q: z.string().trim().min(2, 'Introduzca al menos 2 caracteres').max(200),
          tail: z.coerce.number().int().min(50).max(1000).default(400),
          projectId: z.string().trim().optional(),
        })
        .parse(req.query);
      if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });

      const needle = params.q.toLowerCase();
      const MAX_RESULTS = 300;
      const results: any[] = [];
      let scanned = 0;
      let timedOut = false;
      const deadline = Date.now() + BUSQUEDA_PLAZO_MS;

      const projects = accessibleProjects(req).filter((p) => !params.projectId || p.id === params.projectId);
      const servicesByProject = listServicesForProjects(projects.map((p) => p.id));
      // Solo hace falta saber qué contenedores existen: la foto compartida basta.
      const logSnap = await dockerSnapshot(OVERVIEW_MAX_AGE_MS);

      // Primero la lista de contenedores a mirar; después se consultan con un
      // tope de concurrencia y un plazo total, y se corta en cuanto hay
      // resultados de sobra.
      const objetivos: { project: ProjectRow; service: ServiceRow; index: number; total: number; name: string }[] = [];
      for (const project of projects) {
        for (const service of servicesByProject.get(project.id) ?? []) {
          const total = configuredReplicas(service);
          for (let i = 1; i <= total; i++) {
            const replica = logSnap.byService.get(service.id)?.perReplica.find((r) => r.index === i);
            if (!replica || replica.unreachable) continue;
            if (replica.runtime.state === 'not_created') continue;
            objetivos.push({ project, service, index: i, total, name: replicaName(project, service, i) });
          }
        }
      }

      await pooled(
        objetivos.map(({ project, service, index, total, name }) => async () => {
          if (results.length >= MAX_RESULTS) return;
          const restante = deadline - Date.now();
          if (restante <= 0) {
            timedOut = true;
            return;
          }
          scanned += 1;
          // null = no contestó a tiempo o el contenedor no tiene logs accesibles.
          const lines = await withTimeout(fetchLogsTail(name, params.tail), restante, () => null);
          if (!lines) {
            if (Date.now() >= deadline) timedOut = true;
            return;
          }
          for (const entry of lines) {
            if (results.length >= MAX_RESULTS) break;
            if (!entry.line.toLowerCase().includes(needle)) continue;
            results.push({
              serviceId: service.id,
              serviceName: service.name,
              projectId: project.id,
              projectName: project.name,
              replica: total > 1 ? index : null,
              ts: entry.ts,
              line: entry.line.slice(0, 600),
            });
          }
        }),
        BUSQUEDA_CONCURRENCIA,
      );

      results.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
      // `truncated` también cuando venció el plazo: la lista no es completa.
      return { results, scanned, truncated: results.length >= MAX_RESULTS || timedOut, timedOut };
    },
  );

  /** Desglose de disco por servicio (y del host/Docker para administradores). */
  app.get('/api/monitor/disk', async (req, reply) => {
    if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });
    const user = currentUser(req)!;
    const usage = await diskUsageByService();
    const services: any[] = [];
    const projects = accessibleProjects(req);
    const servicesByProject = listServicesForProjects(projects.map((p) => p.id));
    for (const project of projects) {
      for (const service of servicesByProject.get(project.id) ?? []) {
        const du = usage.get(service.id);
        if (!du) continue;
        services.push({
          serviceId: service.id,
          name: service.name,
          type: service.type,
          projectId: project.id,
          projectName: project.name,
          totalBytes: du.totalBytes,
          containerBytes: du.containerBytes,
          logBytes: du.logBytes,
          volumes: du.volumes,
          quotaMb: du.quotaMb,
        });
      }
    }
    services.sort((a, b) => b.totalBytes - a.totalBytes);

    let dockerTotals: any = null;
    if (user.role === 'admin') {
      try {
        const df: any = await docker.df();
        const sum = (arr: any[], pick: (x: any) => number) => (arr || []).reduce((acc, x) => acc + (pick(x) || 0), 0);
        dockerTotals = {
          images: { count: (df.Images || []).length, size: df.LayersSize || sum(df.Images || [], (i) => i.Size) },
          containers: { count: (df.Containers || []).length, size: sum(df.Containers || [], (c) => c.SizeRw) },
          volumes: { count: (df.Volumes || []).length, size: sum(df.Volumes || [], (v) => Math.max(0, v.UsageData?.Size ?? 0)) },
          buildCache: { size: sum(df.BuildCache || [], (b) => b.Size) },
        };
      } catch {
        /* df no disponible */
      }
    }

    return { host: await hostDisk(), docker: dockerTotals, services };
  });

  /**
   * Histórico de carga, RAM y disco del host, agrupado por cubos según la
   * ventana (`?hours=`). Visible para cualquier usuario, igual que el resumen.
   */
  app.get('/api/monitor/host-history', async (req) => {
    const { hours } = z
      .object({ hours: z.coerce.number().int().min(1).max(24 * 90).default(24) })
      .parse(req.query);
    return { hours, points: bucketHostMetrics(hostMetricsRange(hours), hours) };
  });
}
