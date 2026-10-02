import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { emitirTokenApi, nombreTokenSchema } from '../apitokens';
import { currentUser, requireAuth, requireSession } from '../auth';
import { audit } from '../audit';
import { deleteApiToken, listApiTokens } from '../db';

const createSchema = z.object({
  name: nombreTokenSchema,
  expiresDays: z.coerce.number().int().min(1).max(3650).nullable().optional(),
});

function publicToken(t: ReturnType<typeof listApiTokens>[number]) {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    created_at: t.created_at,
    last_used_at: t.last_used_at,
    expires_at: t.expires_at,
  };
}

/**
 * Tokens de API personales: heredan los permisos del usuario que los crea.
 * Pensados para automatizaciones y agentes (Claude) vía Authorization: Bearer.
 */
export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/tokens', async (req) => {
    const user = currentUser(req)!;
    return { tokens: listApiTokens(user.id).map(publicToken) };
  });

  // Crear tokens exige sesión de navegador: un token robado no puede emitir más.
  app.post('/api/tokens', { preHandler: requireSession }, async (req, reply) => {
    const user = currentUser(req)!;
    const body = createSchema.parse(req.body);
    const { token, row } = emitirTokenApi({
      userId: user.id,
      name: body.name,
      expiresAt: body.expiresDays ? Date.now() + body.expiresDays * 24 * 3600 * 1000 : null,
    });
    audit(req, 'token_created', { type: 'token', id: row.id, detail: body.name });
    reply.code(201);
    // El token en claro solo viaja aquí: se guarda hasheado.
    return { token, apiToken: publicToken(row) };
  });

  // Revocar también exige sesión: con un token robado no se pueden borrar los
  // demás (ni el propio, para ocultar el rastro de su uso).
  app.delete('/api/tokens/:id', { preHandler: requireSession }, async (req, reply) => {
    const user = currentUser(req)!;
    const { id } = req.params as { id: string };
    if (!deleteApiToken(id, user.id)) return reply.code(404).send({ error: 'Token no encontrado' });
    audit(req, 'token_deleted', { type: 'token', id });
    return { ok: true };
  });
}
