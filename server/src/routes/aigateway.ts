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

type ProxyCtx = { key: WorkspaceApiKeyRow; workspace: WorkspaceRow };

/**
 * Valida el modelo (allowlist) y el presupuesto de la clave, reanclando el
 * contador al ciclo actual. Devuelve la clave de Gemini del operador o `null`
 * (con el error ya enviado). Compartido por generateContent, streaming y OpenAI.
 */
function preflight(ctx: ProxyCtx, model: string, reply: FastifyReply): string | null {
  const keyAllowed = JSON.parse(ctx.key.allowed_models || '[]') as string[];
  if (!isModelAllowed(model, keyAllowed)) {
    reply.code(403).send({ error: { code: 403, message: `Modelo no permitido para esta clave: ${model}.` } });
    return null;
  }
  // Presupuesto mensual: reancla el contador al cambiar de ciclo y rechaza si se agotó.
  const cycleStart = currentCycleStartMs(ctx.workspace.billing_day);
  if (ctx.key.cycle_anchor !== cycleStart) {
    resetWorkspaceApiKeyCycle(ctx.key.id, cycleStart);
    ctx.key.spend_cents_cycle = 0;
    ctx.key.cycle_anchor = cycleStart;
  }
  if (ctx.key.budget_cents_month != null && ctx.key.spend_cents_cycle >= ctx.key.budget_cents_month) {
    reply.code(402).send({ error: { code: 402, message: 'Presupuesto mensual de la clave agotado.' } });
    return null;
  }
  const geminiKey = getGeminiApiKey();
  if (!geminiKey) {
    reply.code(502).send({ error: { code: 502, message: 'El gateway de IA no está configurado (falta la clave de Gemini del operador).' } });
    return null;
  }
  return geminiKey;
}

/**
 * Mide SIEMPRE que Google devuelva uso (también en respuestas bloqueadas o
 * parciales: Google cobra la entrada aunque no haya salida). Registra el consumo
 * y acumula el gasto tarifado en la clave (guardarraíl del presupuesto).
 */
function billUsage(ctx: ProxyCtx, model: string, usageMetadata: any, responseId: string | null): void {
  if (!usageMetadata) return;
  const requestId = responseId || randomToken(12);
  const t = recordGeminiUsage(ctx.workspace.id, model, usageMetadata, requestId);
  const whole = accrueSpendCents(ctx.key.id, estimateBudgetCostCents(ctx.workspace.id, t));
  if (whole > 0) incrementWorkspaceApiKeySpend(ctx.key.id, whole);
}

/** Sintetiza un `usageMetadata` estilo Gemini a partir del `usage` de la API OpenAI-compat. */
function usageMetadataFromOpenAI(usage: any): any | null {
  if (!usage) return null;
  const prompt = Number(usage.prompt_tokens ?? 0) || 0;
  const completion = Number(usage.completion_tokens ?? 0) || 0;
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? 0) || 0;
  const total = Number(usage.total_tokens ?? prompt + completion) || 0;
  return { promptTokenCount: prompt, cachedContentTokenCount: cached, candidatesTokenCount: completion, totalTokenCount: total };
}

/**
 * Reenvía un cuerpo SSE de `upstream` al cliente byte a byte y, en paralelo, parsea
 * las líneas `data:` para quedarse con el ÚLTIMO uso (Google/OpenAI lo emiten al
 * final). Al cerrar el flujo, `onUsage` recibe ese uso y su id para facturar.
 * Debe llamarse solo cuando `upstream.ok` y hay cuerpo; toma control de la respuesta.
 */
async function pipeSse(
  upstream: Response,
  reply: FastifyReply,
  onUsage: (usage: any, id: string | null) => void,
  pick: (obj: any) => { usage?: any; id?: string },
): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // desactiva el buffering de proxies intermedios (nginx)
  });
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let lastUsage: any = null;
  let id: string | null = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw.write(Buffer.from(value)); // passthrough exacto (bytes) al cliente
      pending += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const picked = pick(JSON.parse(payload));
          if (picked.usage) lastUsage = picked.usage;
          if (picked.id) id = picked.id;
        } catch {
          /* fragmento aún incompleto: se ignora, la línea completa llega después */
        }
      }
    }
  } catch {
    /* corte del upstream o del cliente: cerramos con lo que haya */
  } finally {
    try {
      raw.end();
    } catch {
      /* respuesta ya cerrada */
    }
    try {
      await reader.cancel();
    } catch {
      /* nada que cancelar */
    }
  }
  onUsage(lastUsage, id);
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

    // generateContent y streamGenerateContent. El modelo y la acción se construyen
    // en servidor: nunca se reenvía el path del cliente (anti-SSRF).
    proxy.post('/gw/v1beta/models/*', { bodyLimit: GW_BODY_LIMIT }, async (req, reply) => {
      const ctx = (req as any).proxyCtx as ProxyCtx;
      const rest = ((req.params as Record<string, string>)['*'] || '').trim();
      const colon = rest.lastIndexOf(':');
      if (colon < 0) return reply.code(404).send({ error: { code: 404, message: 'Ruta no válida.' } });
      const model = rest.slice(0, colon);
      const action = rest.slice(colon + 1);
      if (action !== 'generateContent' && action !== 'streamGenerateContent') {
        return reply.code(501).send({ error: { code: 501, message: `Acción no soportada: ${action}.` } });
      }
      const geminiKey = preflight(ctx, model, reply);
      if (!geminiKey) return reply;

      // Streaming: SSE de Google (?alt=sse) reenviado tal cual, midiendo al cerrar.
      if (action === 'streamGenerateContent') {
        const url = `${getGeminiBaseUrl()}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
        let upstream: Response;
        try {
          upstream = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
            body: JSON.stringify(req.body ?? {}),
            signal: AbortSignal.timeout(300_000),
          });
        } catch (err: any) {
          return reply.code(502).send({ error: { code: 502, message: `No se pudo contactar con Gemini: ${err?.message || 'error de red'}` } });
        }
        // Error antes del stream: Google responde JSON (no SSE); se reenvía tal cual.
        if (!upstream.ok || !upstream.body) {
          const data = await upstream.json().catch(() => ({}));
          return reply.code(upstream.status).send(data);
        }
        await pipeSse(
          upstream,
          reply,
          (usage, id) => billUsage(ctx, model, usage, id),
          (obj) => ({ usage: obj.usageMetadata, id: obj.responseId }),
        );
        return reply;
      }

      // generateContent (sin streaming).
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
      billUsage(ctx, model, data?.usageMetadata, (data?.responseId as string) || null);
      // No se reenvía ninguna cabecera de Google (evita filtrar credenciales/estado).
      return reply.code(res.status).send(data);
    });

    // Compatible con la API de OpenAI (chat/completions): permite reutilizar SDKs de
    // OpenAI apuntando el baseURL al gateway. El modelo viaja en el cuerpo.
    proxy.post('/gw/v1beta/openai/chat/completions', { bodyLimit: GW_BODY_LIMIT }, async (req, reply) => {
      const ctx = (req as any).proxyCtx as ProxyCtx;
      const body = (req.body ?? {}) as any;
      const model = String(body.model || '').replace(/^models\//, '').trim();
      if (!model) return reply.code(400).send({ error: { code: 400, message: 'Falta el modelo en la petición.' } });
      const geminiKey = preflight(ctx, model, reply);
      if (!geminiKey) return reply;

      const stream = body.stream === true;
      const outBody = { ...body, model };
      // Forzamos el uso en el último chunk del stream para poder facturar.
      if (stream) outBody.stream_options = { ...(body.stream_options || {}), include_usage: true };
      const url = `${getGeminiBaseUrl()}/v1beta/openai/chat/completions`;
      let upstream: Response;
      try {
        upstream = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${geminiKey}` },
          body: JSON.stringify(outBody),
          signal: AbortSignal.timeout(stream ? 300_000 : 120_000),
        });
      } catch (err: any) {
        return reply.code(502).send({ error: { code: 502, message: `No se pudo contactar con Gemini: ${err?.message || 'error de red'}` } });
      }

      if (!stream) {
        const data = await upstream.json().catch(() => ({}));
        billUsage(ctx, model, usageMetadataFromOpenAI(data?.usage), (data?.id as string) || null);
        return reply.code(upstream.status).send(data);
      }
      if (!upstream.ok || !upstream.body) {
        const data = await upstream.json().catch(() => ({}));
        return reply.code(upstream.status).send(data);
      }
      await pipeSse(
        upstream,
        reply,
        (usage, id) => billUsage(ctx, model, usageMetadataFromOpenAI(usage), id),
        (obj) => ({ usage: obj.usage, id: obj.id }),
      );
      return reply;
    });

    // Lista de modelos que esta clave puede usar (allowlist del operador ∩ de la clave).
    proxy.get('/gw/v1beta/models', async (req) => {
      const ctx = (req as any).proxyCtx as ProxyCtx;
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
