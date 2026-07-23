import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertWorkspaceAccess, currentUser, hashApiToken, requireAdmin, requireAuth, requireSession } from '../auth';
import { audit } from '../audit';
import {
  createWorkspaceApiKey,
  getWorkspace,
  getWorkspaceApiKey,
  getWorkspaceApiKeyByHash,
  incrementWorkspaceApiKeySpend,
  listWorkspaceApiKeys,
  resetWorkspaceApiKeyCycle,
  touchWorkspaceApiKey,
  updateWorkspaceApiKey,
} from '../db';
import {
  PROXY_KEY_PREFIX,
  accrueSpendCents,
  allowRate,
  currentCycleStartMs,
  estimateBudgetCostCents,
  getAllowedModels,
  getGeminiApiKey,
  getGeminiBaseUrl,
  isModelAllowed,
  recordGeminiUsage,
  setAllowedModels,
  setGeminiApiKey,
  setGeminiBaseUrl,
} from '../aigateway';
import { WorkspaceApiKeyRow, WorkspaceRow } from '../types';
import { randomToken } from '../util';

const GW_BODY_LIMIT = 8 * 1024 * 1024; // contexto largo/multimodal supera 1 MB

function publicKey(k: WorkspaceApiKeyRow) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    provider: k.provider,
    status: k.status,
    allowed_models: JSON.parse(k.allowed_models || '[]') as string[],
    budget_cents_month: k.budget_cents_month,
    spend_cents_cycle: k.spend_cents_cycle,
    rate_limit_rpm: k.rate_limit_rpm,
    last_used_at: k.last_used_at,
    expires_at: k.expires_at,
    created_at: k.created_at,
  };
}

/** Lee la clave del cliente de `x-goog-api-key` o `Authorization: Bearer`. */
function readProxyKey(req: FastifyRequest): string | null {
  const h = req.headers['x-goog-api-key'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

/**
 * Autenticación PROPIA del proxy (nunca `requireAuth`): valida la clave `skai_…`
 * contra `workspace_api_keys` en cada petición (sin caché → suspender surte efecto
 * al instante). Una clave que no empiece por `skai_` se rechaza (jamás toca el panel).
 */
function resolveProxyKey(req: FastifyRequest, reply: FastifyReply): { key: WorkspaceApiKeyRow; workspace: WorkspaceRow } | null {
  const raw = readProxyKey(req);
  if (!raw || !raw.startsWith(PROXY_KEY_PREFIX)) {
    reply.code(401).send({ error: { code: 401, message: 'Clave de API no válida.' } });
    return null;
  }
  const key = getWorkspaceApiKeyByHash(hashApiToken(raw));
  if (!key || key.status === 'revoked' || key.revoked_at) {
    reply.code(401).send({ error: { code: 401, message: 'Clave de API no válida o revocada.' } });
    return null;
  }
  if (key.status === 'suspended') {
    reply.code(403).send({ error: { code: 403, message: 'Clave suspendida (impago o corte manual). Regulariza el pago para reactivarla.' } });
    return null;
  }
  if (key.expires_at && key.expires_at < Date.now()) {
    reply.code(401).send({ error: { code: 401, message: 'Clave caducada.' } });
    return null;
  }
  const ws = getWorkspace(key.workspace_id);
  if (!ws || ws.status !== 'active') {
    reply.code(403).send({ error: { code: 403, message: 'Cuenta suspendida.' } });
    return null;
  }
  touchWorkspaceApiKey(key.id, key.last_used_at);
  return { key, workspace: ws };
}

export async function aiGatewayRoutes(app: FastifyInstance): Promise<void> {
  // ---- Proxy de IA (auth propia; SIN requireAuth; cuerpo grande) ----
  app.register(async (proxy) => {
    // Autenticación en onRequest: se rechaza la clave inválida ANTES de que Fastify
    // bufferice/parsee el cuerpo (hasta 8 MB), evitando amplificación DoS pre-auth.
    proxy.addHook('onRequest', async (req, reply) => {
      const ctx = resolveProxyKey(req, reply);
      if (!ctx) return reply; // 401/403 ya enviado; corta el ciclo sin leer el cuerpo
      // Límite de ritmo por clave (token-bucket), antes de bufferizar el cuerpo.
      if (!allowRate(ctx.key.id, ctx.key.rate_limit_rpm)) {
        return reply.code(429).send({ error: { code: 429, message: 'Límite de peticiones por minuto de la clave superado.' } });
      }
      (req as any).proxyCtx = ctx;
    });

    // generateContent (no streaming en esta fase). El modelo y la acción se
    // construyen en servidor: nunca se reenvía el path del cliente (anti-SSRF).
    proxy.post('/gw/v1beta/models/*', { bodyLimit: GW_BODY_LIMIT }, async (req, reply) => {
      const ctx = (req as any).proxyCtx as { key: WorkspaceApiKeyRow; workspace: WorkspaceRow };
      const rest = ((req.params as Record<string, string>)['*'] || '').trim();
      const colon = rest.lastIndexOf(':');
      if (colon < 0) return reply.code(404).send({ error: { code: 404, message: 'Ruta no válida.' } });
      const model = rest.slice(0, colon);
      const action = rest.slice(colon + 1);
      if (action !== 'generateContent') {
        return reply.code(501).send({ error: { code: 501, message: 'De momento solo se admite generateContent (el streaming llega en la siguiente fase).' } });
      }
      const keyAllowed = JSON.parse(ctx.key.allowed_models || '[]') as string[];
      if (!isModelAllowed(model, keyAllowed)) {
        return reply.code(403).send({ error: { code: 403, message: `Modelo no permitido para esta clave: ${model}.` } });
      }
      // Presupuesto mensual: reancla el contador al cambiar de ciclo y rechaza si se agotó.
      const cycleStart = currentCycleStartMs(ctx.workspace.billing_day);
      if (ctx.key.cycle_anchor !== cycleStart) {
        resetWorkspaceApiKeyCycle(ctx.key.id, cycleStart);
        ctx.key.spend_cents_cycle = 0;
        ctx.key.cycle_anchor = cycleStart;
      }
      if (ctx.key.budget_cents_month != null && ctx.key.spend_cents_cycle >= ctx.key.budget_cents_month) {
        return reply.code(402).send({ error: { code: 402, message: 'Presupuesto mensual de la clave agotado.' } });
      }
      const geminiKey = getGeminiApiKey();
      if (!geminiKey) return reply.code(502).send({ error: { code: 502, message: 'El gateway de IA no está configurado (falta la clave de Gemini del operador).' } });

      const url = `${getGeminiBaseUrl()}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      let res: Response;
      let data: any;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
          body: JSON.stringify(req.body ?? {}),
          signal: AbortSignal.timeout(120_000),
        });
        data = await res.json().catch(() => ({}));
      } catch (err: any) {
        return reply.code(502).send({ error: { code: 502, message: `No se pudo contactar con Gemini: ${err?.message || 'error de red'}` } });
      }
      // Medir SIEMPRE que Google devuelva uso (también en respuestas bloqueadas o
      // parciales: Google cobra la entrada aunque no haya salida).
      const requestId = (data?.responseId as string) || randomToken(12);
      if (data?.usageMetadata) {
        const t = recordGeminiUsage(ctx.workspace.id, model, data.usageMetadata, requestId);
        // Acumula el gasto tarifado en la clave (guardarraíl del presupuesto),
        // sumando fracciones de céntimo para no perder las peticiones pequeñas.
        const whole = accrueSpendCents(ctx.key.id, estimateBudgetCostCents(ctx.workspace.id, t));
        if (whole > 0) incrementWorkspaceApiKeySpend(ctx.key.id, whole);
      }
      // No se reenvía ninguna cabecera de Google (evita filtrar credenciales/estado).
      return reply.code(res.status).send(data);
    });

    // Lista de modelos que esta clave puede usar (allowlist del operador ∩ de la clave).
    proxy.get('/gw/v1beta/models', async (req) => {
      const ctx = (req as any).proxyCtx as { key: WorkspaceApiKeyRow; workspace: WorkspaceRow };
      const keyAllowed = JSON.parse(ctx.key.allowed_models || '[]') as string[];
      const models = getAllowedModels().filter((m) => keyAllowed.length === 0 || keyAllowed.includes(m));
      return { models: models.map((name) => ({ name: `models/${name}` })) };
    });
  });

  // ---- Gestión de claves y configuración del gateway (requireAuth) ----
  app.register(async (mgmt) => {
    mgmt.addHook('preHandler', requireAuth);

    mgmt.get('/api/workspaces/:id/keys', async (req, reply) => {
      const { id } = req.params as { id: string };
      const ws = getWorkspace(id);
      if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
      if (!assertWorkspaceAccess(req, reply, id)) return reply;
      return { keys: listWorkspaceApiKeys(id).map(publicKey), geminiConfigured: !!getGeminiApiKey() };
    });

    // Crear exige sesión de navegador: una clave robada no puede emitir más claves.
    mgmt.post('/api/workspaces/:id/keys', { preHandler: requireSession }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const ws = getWorkspace(id);
      if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
      if (!assertWorkspaceAccess(req, reply, id)) return reply;
      const body = z
        .object({
          name: z.string().trim().min(1).max(60),
          allowedModels: z.array(z.string().trim()).max(50).optional(),
          budgetCentsMonth: z.coerce.number().int().min(0).max(100_000_00).nullable().optional(),
          rateLimitRpm: z.coerce.number().int().min(1).max(100_000).nullable().optional(),
          expiresDays: z.coerce.number().int().min(1).max(3650).nullable().optional(),
        })
        .parse(req.body);
      const secret = `${PROXY_KEY_PREFIX}${randomToken(24)}`;
      const row = createWorkspaceApiKey({
        workspace_id: id,
        name: body.name,
        key_hash: hashApiToken(secret),
        prefix: secret.slice(0, PROXY_KEY_PREFIX.length + 8),
        allowed_models: JSON.stringify(body.allowedModels ?? []),
        budget_cents_month: body.budgetCentsMonth ?? null,
        rate_limit_rpm: body.rateLimitRpm ?? null,
        expires_at: body.expiresDays ? Date.now() + body.expiresDays * 24 * 3600 * 1000 : null,
        created_by: currentUser(req)?.id ?? null,
      });
      audit(req, 'ws_api_key_created', { type: 'workspace', id, detail: body.name });
      reply.code(201);
      // El secreto solo viaja aquí; se guarda hasheado.
      return { key: secret, apiKey: publicKey(row) };
    });

    mgmt.patch('/api/workspaces/:id/keys/:keyId', { preHandler: requireAdmin }, async (req, reply) => {
      const { id, keyId } = req.params as { id: string; keyId: string };
      const key = getWorkspaceApiKey(keyId);
      if (!key || key.workspace_id !== id) return reply.code(404).send({ error: 'Clave no encontrada' });
      const body = z
        .object({
          name: z.string().trim().min(1).max(60).optional(),
          allowedModels: z.array(z.string().trim()).max(50).optional(),
          budgetCentsMonth: z.coerce.number().int().min(0).max(100_000_00).nullable().optional(),
          rateLimitRpm: z.coerce.number().int().min(1).max(100_000).nullable().optional(),
          expiresDays: z.coerce.number().int().min(1).max(3650).nullable().optional(),
        })
        .parse(req.body);
      const fields: Record<string, unknown> = {};
      if (body.name !== undefined) fields.name = body.name;
      if (body.allowedModels !== undefined) fields.allowed_models = JSON.stringify(body.allowedModels);
      if (body.budgetCentsMonth !== undefined) fields.budget_cents_month = body.budgetCentsMonth;
      if (body.rateLimitRpm !== undefined) fields.rate_limit_rpm = body.rateLimitRpm;
      if (body.expiresDays !== undefined) fields.expires_at = body.expiresDays ? Date.now() + body.expiresDays * 24 * 3600 * 1000 : null;
      updateWorkspaceApiKey(keyId, fields);
      audit(req, 'ws_api_key_updated', { type: 'workspace', id });
      return { apiKey: publicKey(getWorkspaceApiKey(keyId)!) };
    });

    // Corte / reactivación manual (operador).
    const setStatus = (status: 'active' | 'suspended') => async (req: FastifyRequest, reply: FastifyReply) => {
      const { id, keyId } = req.params as { id: string; keyId: string };
      const key = getWorkspaceApiKey(keyId);
      if (!key || key.workspace_id !== id) return reply.code(404).send({ error: 'Clave no encontrada' });
      if (key.status === 'revoked') return reply.code(409).send({ error: 'La clave está revocada.' });
      updateWorkspaceApiKey(keyId, { status });
      audit(req, status === 'suspended' ? 'ws_api_key_block' : 'ws_api_key_unblock', { type: 'workspace', id });
      return { apiKey: publicKey(getWorkspaceApiKey(keyId)!) };
    };
    mgmt.post('/api/workspaces/:id/keys/:keyId/block', { preHandler: requireAdmin }, setStatus('suspended'));
    mgmt.post('/api/workspaces/:id/keys/:keyId/unblock', { preHandler: requireAdmin }, setStatus('active'));

    mgmt.delete('/api/workspaces/:id/keys/:keyId', async (req, reply) => {
      const { id, keyId } = req.params as { id: string; keyId: string };
      const ws = getWorkspace(id);
      if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
      if (!assertWorkspaceAccess(req, reply, id)) return reply;
      const key = getWorkspaceApiKey(keyId);
      if (!key || key.workspace_id !== id) return reply.code(404).send({ error: 'Clave no encontrada' });
      updateWorkspaceApiKey(keyId, { status: 'revoked', revoked_at: Date.now() });
      audit(req, 'ws_api_key_revoked', { type: 'workspace', id });
      return { ok: true };
    });

    // Configuración del gateway (clave de Gemini del operador, host y modelos permitidos).
    mgmt.get('/api/ai/gateway/config', { preHandler: requireAdmin }, async () => ({
      hasGeminiKey: !!getGeminiApiKey(),
      baseUrl: getGeminiBaseUrl(),
      allowedModels: getAllowedModels(),
    }));

    mgmt.put('/api/ai/gateway/config', { preHandler: requireAdmin }, async (req) => {
      const body = z
        .object({
          geminiApiKey: z.string().trim().optional(),
          baseUrl: z.string().trim().url().optional(),
          allowedModels: z.array(z.string().trim().min(1)).max(100).optional(),
        })
        .parse(req.body ?? {});
      if (body.geminiApiKey !== undefined) setGeminiApiKey(body.geminiApiKey || null);
      if (body.baseUrl !== undefined) setGeminiBaseUrl(body.baseUrl || null);
      if (body.allowedModels !== undefined) setAllowedModels(body.allowedModels);
      audit(req, 'ai_gateway_config_updated', { type: 'system', id: 'ai-gateway' });
      return { hasGeminiKey: !!getGeminiApiKey(), baseUrl: getGeminiBaseUrl(), allowedModels: getAllowedModels() };
    });
  });
}
