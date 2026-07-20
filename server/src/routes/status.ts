import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertProjectAccess, requireAdmin, requireAuth } from '../auth';
import { audit } from '../audit';
import {
  getProject,
  getProjectByStatusToken,
  listAlerts,
  listServices,
  setProjectStatusPage,
  uptimeDaily,
  uptimePercent,
} from '../db';
import { dockerAvailable } from '../docker/client';
import { configuredReplicas, getRuntime, replicaName } from '../docker/containers';
import { ProjectRow } from '../types';
import { randomToken } from '../util';

type PublicState = 'operational' | 'degraded' | 'down' | 'unknown';

/** Estado presentable a un cliente a partir del estado del contenedor. */
function publicState(state: string, running: number, total: number): PublicState {
  if (running > 0 && running < total) return 'degraded';
  if (state === 'running') return 'operational';
  if (state === 'restarting' || state === 'paused') return 'degraded';
  if (state === 'exited' || state === 'dead') return 'down';
  return 'unknown';
}

/** La página es pública: se cachea unos segundos para no castigar a Docker. */
const cache = new Map<string, { ts: number; payload: any }>();
const CACHE_MS = 10_000;

async function buildStatusPayload(project: ProjectRow): Promise<any> {
  const dockerUp = await dockerAvailable();
  const services: any[] = [];

  for (const service of listServices(project.id)) {
    const total = configuredReplicas(service);
    let running = 0;
    let firstState = 'unknown';
    if (dockerUp) {
      firstState = 'not_created';
      for (let i = 1; i <= total; i++) {
        try {
          const runtime = await getRuntime(replicaName(project, service, i));
          if (i === 1) firstState = runtime.state;
          if (runtime.state === 'running') running += 1;
        } catch {
          /* réplica ilocalizable */
        }
      }
    }
    // Un servicio nunca desplegado no es un componente visible para el cliente.
    if (firstState === 'not_created') continue;

    const daily = uptimeDaily(service.id, 90);
    const byDay = new Map(daily.map((d) => [d.day, d]));
    const today = Math.floor(Date.now() / 86_400_000);
    const days: { date: number; pct: number | null }[] = [];
    for (let d = today - 89; d <= today; d++) {
      const row = byDay.get(d);
      days.push({
        date: d * 86_400_000,
        pct: row && row.total > 0 ? Math.round((row.up / row.total) * 10000) / 100 : null,
      });
    }

    services.push({
      name: service.name,
      type: service.type,
      state: publicState(firstState, running, total),
      uptime24h: uptimePercent(service.id, 24),
      uptime7d: uptimePercent(service.id, 7 * 24),
      uptime90d: uptimePercent(service.id, 90 * 24),
      days,
    });
  }

  const overall: PublicState = services.some((s) => s.state === 'down')
    ? 'down'
    : services.some((s) => s.state === 'degraded')
      ? 'degraded'
      : services.every((s) => s.state === 'operational') && services.length > 0
        ? 'operational'
        : 'unknown';

  // Incidencias: alertas de caída/bucle del proyecto — abiertas y las resueltas
  // de los últimos 7 días. Solo título, mensaje y fechas (sin detalles internos).
  const incidentTypes = new Set(['service_down', 'crash_loop']);
  const incidents = listAlerts({ limit: 100, projectIds: [project.id] })
    .filter((a) => incidentTypes.has(a.type))
    .filter((a) => !a.resolved_at || Date.now() - a.resolved_at < 7 * 86_400_000)
    .slice(0, 20)
    .map((a) => ({
      id: a.id,
      title: a.title,
      startedAt: a.ts,
      resolvedAt: a.resolved_at,
      severity: a.severity,
    }));

  return {
    project: { name: project.name, client: project.client },
    overall,
    services,
    incidents,
    generatedAt: Date.now(),
  };
}

export async function statusRoutes(app: FastifyInstance): Promise<void> {
  /** Página de estado pública (sin autenticación): datos mínimos y cacheados. */
  app.get('/api/public/status/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!/^[a-f0-9]{16,128}$/i.test(token)) return reply.code(404).send({ error: 'Página de estado no encontrada' });
    const project = getProjectByStatusToken(token);
    if (!project) return reply.code(404).send({ error: 'Página de estado no encontrada' });

    const hit = cache.get(token);
    if (hit && Date.now() - hit.ts < CACHE_MS) return hit.payload;
    const payload = await buildStatusPayload(project);
    cache.set(token, { ts: Date.now(), payload });
    if (cache.size > 500) cache.clear();
    return payload;
  });

  app.register(async (secured) => {
    secured.addHook('preHandler', requireAuth);

    /** Configuración de la página de estado del proyecto (visible para sus miembros). */
    secured.get('/api/projects/:id/status-page', async (req, reply) => {
      const { id } = req.params as { id: string };
      const project = getProject(id);
      if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });
      if (!assertProjectAccess(req, reply, id)) return reply;
      return {
        enabled: !!project.status_enabled,
        token: project.status_enabled ? project.status_token : null,
      };
    });

    /** Activa o desactiva la página pública (crea el token la primera vez). */
    secured.post('/api/projects/:id/status-page', { preHandler: requireAdmin }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const project = getProject(id);
      if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });
      const body = z.object({ enabled: z.boolean() }).parse(req.body);
      const token = project.status_token ?? randomToken(20);
      setProjectStatusPage(id, body.enabled, token);
      cache.delete(token);
      audit(req, 'status_page_updated', {
        type: 'project',
        id,
        detail: `${project.name}: ${body.enabled ? 'activada' : 'desactivada'}`,
      });
      return { enabled: body.enabled, token: body.enabled ? token : null };
    });

    /** Rota el token: el enlace anterior deja de funcionar al instante. */
    secured.post('/api/projects/:id/status-page/rotate', { preHandler: requireAdmin }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const project = getProject(id);
      if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });
      if (project.status_token) cache.delete(project.status_token);
      const token = randomToken(20);
      setProjectStatusPage(id, !!project.status_enabled, token);
      audit(req, 'status_page_rotated', { type: 'project', id, detail: project.name });
      return { enabled: !!project.status_enabled, token: project.status_enabled ? token : null };
    });
  });
}
