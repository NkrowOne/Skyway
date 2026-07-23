import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertWorkspaceAccess, requireAuth } from '../auth';
import { getProject, getService, ingestUsageEvent } from '../db';

/**
 * Ingesta de consumo lógico/IA (tokens, peticiones, bytes…) para tarifar los
 * productos `metered`. Idempotente por `idempotencyKey`. El emisor debe tener
 * acceso al workspace del sujeto (admin, o propietario/miembro de la cuenta),
 * de modo que la facturación por uso no se pueda falsear desde fuera.
 */
const usageSchema = z.object({
  idempotencyKey: z.string().trim().min(6).max(200),
  subjectType: z.enum(['workspace', 'service']).default('workspace'),
  subjectId: z.string().trim().min(1),
  meter: z.enum(['ai_tokens_in', 'ai_tokens_out', 'ai_requests', 'ai_bytes', 'unit']),
  quantity: z.coerce.number().min(0).max(1e15),
  productId: z.string().trim().nullable().optional(),
  ts: z.coerce.number().int().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export async function usageRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/api/usage', async (req, reply) => {
    const body = usageSchema.parse(req.body);
    // Resolver el workspace del sujeto y exigir acceso a él.
    let workspaceId: string | null;
    if (body.subjectType === 'service') {
      const service = getService(body.subjectId);
      const project = service ? getProject(service.project_id) : undefined;
      workspaceId = project?.workspace_id ?? null;
      if (!workspaceId) return reply.code(404).send({ error: 'Servicio no encontrado o sin cuenta' });
    } else {
      workspaceId = body.subjectId;
    }
    if (!assertWorkspaceAccess(req, reply, workspaceId)) return reply;

    // La marca temporal no puede caer en el futuro (evita adelantar consumo a ciclos venideros).
    const ts = Math.min(body.ts ?? Date.now(), Date.now());
    const fresh = ingestUsageEvent({
      idempotencyKey: body.idempotencyKey,
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      meter: body.meter,
      quantity: body.quantity,
      productId: body.productId ?? null,
      ts,
      metadata: body.metadata ? JSON.stringify(body.metadata) : null,
    });
    return { ok: true, duplicate: !fresh };
  });
}
