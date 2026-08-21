import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertProjectAccess, requireAdmin, requireAuth } from '../auth';
import { audit } from '../audit';
import {
  getProject,
  getProjectByStatusToken,
  listProjectIncidents,
  listServices,
  setProjectStatusNotice,
  setProjectStatusPage,
  uptimeDaily,
  uptimePercent,
} from '../db';
import { dockerAvailable } from '../docker/client';
import { aggregateReplicaState, configuredReplicas } from '../docker/containers';
import { dockerSnapshot } from '../docker/sampler';
import { ContainerState, ProjectRow } from '../types';
import { randomToken } from '../util';

type PublicState = 'operational' | 'degraded' | 'down' | 'unknown';

/** Estado presentable a un cliente a partir del estado agregado del servicio. */
function publicState(state: ContainerState, running: number, total: number): PublicState {
  if (running > 0 && running < total) return 'degraded';
  if (state === 'running') return 'operational';
  if (state === 'restarting' || state === 'paused' || state === 'removing') return 'degraded';
  if (state === 'exited' || state === 'dead') return 'down';
  return 'unknown';
}

/** La página es pública: se cachea unos segundos para no castigar a Docker. */
const cache = new Map<string, { ts: number; payload: any }>();
const CACHE_MS = 10_000;
const CACHE_MAX = 500;

async function buildStatusPayload(project: ProjectRow): Promise<any> {
  const dockerUp = await dockerAvailable();
  // Una sola foto de Docker para toda la vista.
  const snap = await dockerSnapshot(5000);
  const services: any[] = [];

  for (const service of listServices(project.id)) {
    const total = configuredReplicas(service);
    let running = 0;
    const states: ContainerState[] = [];
    if (dockerUp) {
      for (const replica of snap.byService.get(service.id)?.perReplica ?? []) {
        if (replica.unreachable) continue; // réplica ilocalizable
        states.push(replica.runtime.state);
        if (replica.runtime.state === 'running') running += 1;
      }
    }
    const aggState = aggregateReplicaState(states);

    const uptime24h = uptimePercent(service.id, 24);
    const uptime90d = uptimePercent(service.id, 90 * 24);
    // Un servicio nunca desplegado no es un componente visible para el
    // cliente. Con Docker caído el estado es 'unknown': el histórico de
    // uptime distingue lo nunca desplegado (sin muestras) de lo real.
    if (aggState === 'not_created') continue;
    if (aggState === 'unknown' && uptime24h === null && uptime90d === null) continue;

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
      state: publicState(aggState, running, total),
      uptime24h,
      uptime7d: uptimePercent(service.id, 7 * 24),
      uptime90d,
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
  // de los últimos 7 días. Solo título y fechas (sin detalles internos).
  const incidents = listProjectIncidents(
    project.id,
    ['service_down', 'crash_loop'],
    Date.now() - 7 * 86_400_000,
  ).map((a) => ({
    id: a.id,
    title: a.title,
    startedAt: a.ts,
    resolvedAt: a.resolved_at,
    severity: a.severity,
  }));

  return {
    project: { name: project.name, client: project.client },
    overall,
    notice: project.status_notice,
    services,
    incidents,
    generatedAt: Date.now(),
  };
}

/** Peticiones concurrentes del mismo token comparten una única construcción. */
const inFlight = new Map<string, Promise<any>>();

export async function statusRoutes(app: FastifyInstance): Promise<void> {
  /** Página de estado pública (sin autenticación): datos mínimos y cacheados. */
  app.get('/api/public/status/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!/^[a-f0-9]{16,128}$/i.test(token)) return reply.code(404).send({ error: 'Página de estado no encontrada' });
    const project = getProjectByStatusToken(token);
    if (!project) return reply.code(404).send({ error: 'Página de estado no encontrada' });

    const hit = cache.get(token);
    if (hit && Date.now() - hit.ts < CACHE_MS) return hit.payload;

    // Single-flight: el endpoint es público, y sin esto una ráfaga de
    // pestañas tras expirar la caché recorrería Docker una vez por petición.
    let pending = inFlight.get(token);
    if (!pending) {
      pending = buildStatusPayload(project)
        .then((payload) => {
          cache.set(token, { ts: Date.now(), payload });
          // Eviction acotada: se retiran las entradas más antiguas, nunca
          // un clear() que tire también las frescas.
          while (cache.size > CACHE_MAX) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
          }
          return payload;
        })
        .finally(() => inFlight.delete(token));
      inFlight.set(token, pending);
    }
    return pending;
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
        notice: project.status_notice,
      };
    });

    /** Activa/desactiva la página pública y gestiona el aviso de mantenimiento. */
    secured.post('/api/projects/:id/status-page', { preHandler: requireAdmin }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const project = getProject(id);
      if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });
      const body = z
        .object({
          enabled: z.boolean().optional(),
          notice: z.string().trim().max(500, 'Máximo 500 caracteres').nullable().optional(),
        })
        .parse(req.body);

      const enabled = body.enabled ?? !!project.status_enabled;
      const token = project.status_token ?? randomToken(20);
      if (body.enabled !== undefined) setProjectStatusPage(id, enabled, token);
      if (body.notice !== undefined) setProjectStatusNotice(id, body.notice || null);
      cache.delete(token);

      const changes: string[] = [];
      if (body.enabled !== undefined) changes.push(enabled ? 'activada' : 'desactivada');
      if (body.notice !== undefined) changes.push(body.notice ? 'aviso publicado' : 'aviso retirado');
      audit(req, 'status_page_updated', {
        type: 'project',
        id,
        detail: `${project.name}: ${changes.join(', ') || 'sin cambios'}`,
      });
      const fresh = getProject(id)!;
      return { enabled, token: enabled ? token : null, notice: fresh.status_notice };
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
