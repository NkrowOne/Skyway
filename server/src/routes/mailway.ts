import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { parse } from 'tldts';
import { z } from 'zod';
import { assertProjectManage, requireAuth } from '../auth';
import { getService } from '../db';

function integration() {
  return {
    url: (process.env.MAILWAY_URL || '').replace(/\/$/, ''),
    token: process.env.MAILWAY_INTEGRATION_TOKEN?.trim() || '',
    source: process.env.MAILWAY_INSTANCE_ID || 'skyway',
  };
}
function enabled() { const c = integration(); return !!c.url && c.token.length >= 32; }
let lastProxyPoll = 0;

async function upstream(action: string, body?: unknown) {
  const c = integration();
  const url = new URL(c.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('MAILWAY_URL debe ser una URL HTTP(S) sin credenciales.');
  const res = await fetch(`${c.url}/api/integrations/skyway/${action}`, {
    method: body ? 'POST' : 'GET', redirect: 'error',
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(action === 'traefik' ? 8000 : 120_000),
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    // Nunca reenviar autenticación fallida como 401: cerraría la sesión de Skyway.
    const err = new Error(typeof data.error === 'string' ? data.error : 'Mailway no pudo completar este paso.') as Error & { statusCode: number };
    err.statusCode = [400, 409].includes(res.status) ? res.status : 502;
    throw err;
  }
  return data;
}

export async function mailwayRoutes(app: FastifyInstance) {
  // Traefik usa su proveedor HTTP, sin exponer el token al navegador.
  app.get('/api/mailway/traefik', async (req, reply) => {
    if (!enabled()) return { http: { routers: {}, services: {} } };
    const token = Buffer.from(integration().token);
    const supplied = Buffer.from(String(req.headers['x-skyway-mailway-token'] || ''));
    if (token.length !== supplied.length || !timingSafeEqual(token, supplied)) return reply.code(401).send({ error: 'No autorizado' });
    try {
      const config = await upstream('traefik');
      lastProxyPoll = Date.now();
      return config;
    } catch { return reply.code(503).send({ error: 'No se pudo actualizar la configuración de Mailway.' }); }
  });

  const endpoint = '/api/services/:id/mailway';
  app.get(endpoint, { preHandler: requireAuth }, async (req, reply) => {
    const service = getService((req.params as { id: string }).id);
    if (!service) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectManage(req, reply, service.project_id)) return reply;
    const domains = 'domains' in service.config ? service.config.domains || [] : [];
    return { enabled: enabled(), routingConnected: Date.now() - lastProxyPoll < 90_000,
      domains: domains.filter(d => { const p = parse(d); return p.isIcann && p.domain === d; }) };
  });
  app.post(`${endpoint}/:action`, { preHandler: requireAuth }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id, action } = req.params as { id: string; action: string };
    if (!['status', 'provision', 'verify'].includes(action)) return reply.code(404).send({ error: 'Acción no encontrada' });
    const service = getService(id);
    if (!service) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectManage(req, reply, service.project_id)) return reply;
    if (!enabled()) return reply.code(503).send({ error: 'El administrador debe conectar Mailway en las variables de Skyway.' });
    const body = z.object({
      domain: z.string().trim().toLowerCase().max(253),
      accounts: z.array(z.object({ localPart: z.string().max(64), password: z.string().min(12).max(128) })).min(1).max(20).optional(),
    }).parse(req.body);
    const domains = 'domains' in service.config ? service.config.domains || [] : [];
    if (!domains.includes(body.domain) || parse(body.domain).domain !== body.domain || !parse(body.domain).isIcann) {
      return reply.code(400).send({ error: 'Guarda primero el dominio raíz personalizado en este servicio, por ejemplo codanuancelegal.com.' });
    }
    if (action === 'provision' && Date.now() - lastProxyPoll >= 90_000) {
      return reply.code(409).send({ error: 'Traefik todavía no está conectado a Mailway. Revisa la conexión del proxy antes de crear las cuentas.' });
    }
    try {
      return await upstream(action, { ...body, source: integration().source, serviceId: service.id });
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      return reply.code(e.statusCode || 502).send({ error: e.statusCode ? e.message : 'Mailway no respondió a tiempo. Puedes reintentar sin duplicar las cuentas ya creadas.' });
    }
  });
}
