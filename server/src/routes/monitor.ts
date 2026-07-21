import os from 'os';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canAccessProject, currentUser, requireAuth } from '../auth';
import {
  listDeployments,
  listProjects,
  listServices,
  openAlertCountsByService,
  uptimePercent,
} from '../db';
import { explainExitCode } from '../deploy/diagnose';
import { diskUsageByService, hostDisk } from '../disk';
import { docker, dockerAvailable } from '../docker/client';
import {
  configuredReplicas,
  fetchLogsTail,
  getRuntime,
  getStats,
  replicaName,
} from '../docker/containers';
import { ProjectRow, ServiceRow } from '../types';

/** Proyectos visibles para el usuario de la petición (admin: todos). */
function accessibleProjects(req: any): ProjectRow[] {
  const user = currentUser(req)!;
  return listProjects().filter((p) => canAccessProject(user, p.id));
}

export async function monitorRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /**
   * Vista global: estado en vivo de todos los servicios de todos los proyectos
   * accesibles, con métricas, alertas, último despliegue y uso de disco.
   */
  app.get('/api/monitor/overview', async (req) => {
    const dockerUp = await dockerAvailable();
    const projects = accessibleProjects(req);
    const disk = dockerUp ? await diskUsageByService().catch(() => null) : null;

    const services: any[] = [];
    for (const project of projects) {
      const alertCounts = openAlertCountsByService(project.id);
      for (const service of listServices(project.id)) {
        const cfg = service.config as any;
        const total = configuredReplicas(service);
        let running = 0;
        let restartCount = 0;
        let firstState = 'unknown';
        let startedAt: string | null = null;
        let exitCode: number | null = null;
        let stats: { cpuPercent: number; memUsage: number; memLimit: number } | null = null;

        if (dockerUp) {
          firstState = 'not_created';
          for (let i = 1; i <= total; i++) {
            const name = replicaName(project, service, i);
            let runtime;
            try {
              runtime = await getRuntime(name);
            } catch {
              continue;
            }
            if (i === 1) {
              firstState = runtime.state;
              startedAt = runtime.startedAt;
              exitCode = runtime.exitCode;
            }
            restartCount += runtime.restartCount;
            if (runtime.state !== 'running') continue;
            running += 1;
            const s = await getStats(name);
            if (s) {
              if (!stats) stats = { cpuPercent: 0, memUsage: 0, memLimit: s.memLimit };
              stats.cpuPercent = Math.round((stats.cpuPercent + s.cpuPercent) * 10) / 10;
              stats.memUsage += s.memUsage;
            }
          }
        }

        const state = running > 0 ? (running === total ? 'running' : firstState === 'running' ? 'running' : firstState) : firstState;
        const lastDeploy = listDeployments(service.id, 1)[0] ?? null;
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
          uptime24h: uptimePercent(service.id, 24),
        });
      }
    }

    return {
      docker: dockerUp,
      host: {
        cpus: os.cpus().length,
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
  app.get('/api/monitor/logs/search', async (req, reply) => {
    const params = z
      .object({
        q: z.string().trim().min(2, 'Escribe al menos 2 caracteres').max(200),
        tail: z.coerce.number().int().min(50).max(1000).default(400),
        projectId: z.string().trim().optional(),
      })
      .parse(req.query);
    if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });

    const needle = params.q.toLowerCase();
    const MAX_RESULTS = 300;
    const results: any[] = [];
    let scanned = 0;

    const projects = accessibleProjects(req).filter((p) => !params.projectId || p.id === params.projectId);
    for (const project of projects) {
      for (const service of listServices(project.id)) {
        const total = configuredReplicas(service);
        for (let i = 1; i <= total; i++) {
          const name = replicaName(project, service, i);
          let runtime;
          try {
            runtime = await getRuntime(name);
          } catch {
            continue;
          }
          if (runtime.state === 'not_created') continue;
          scanned += 1;
          try {
            const lines = await fetchLogsTail(name, params.tail);
            for (const entry of lines) {
              if (!entry.line.toLowerCase().includes(needle)) continue;
              results.push({
                serviceId: service.id,
                serviceName: service.name,
                projectId: project.id,
                projectName: project.name,
                replica: total > 1 ? i : null,
                ts: entry.ts,
                line: entry.line.slice(0, 600),
              });
              if (results.length >= MAX_RESULTS) break;
            }
          } catch {
            /* contenedor sin logs accesibles */
          }
          if (results.length >= MAX_RESULTS) break;
        }
        if (results.length >= MAX_RESULTS) break;
      }
      if (results.length >= MAX_RESULTS) break;
    }

    results.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
    return { results, scanned, truncated: results.length >= MAX_RESULTS };
  });

  /** Desglose de disco por servicio (y del host/Docker para administradores). */
  app.get('/api/monitor/disk', async (req, reply) => {
    if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });
    const user = currentUser(req)!;
    const usage = await diskUsageByService();
    const services: any[] = [];
    for (const project of accessibleProjects(req)) {
      for (const service of listServices(project.id)) {
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
}
