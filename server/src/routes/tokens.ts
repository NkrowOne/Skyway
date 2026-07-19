import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { API_TOKEN_PREFIX, currentUser, hashApiToken, requireAuth, requireSession } from '../auth';
import { audit } from '../audit';
import { deleteApiToken, insertApiToken, listApiTokens } from '../db';
import { randomToken } from '../util';

const createSchema = z.object({
  name: z.string().trim().min(1, 'Nombre requerido').max(60),
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
    const token = `${API_TOKEN_PREFIX}${randomToken(24)}`; // sky_ + 48 hex
    const row = insertApiToken({
      user_id: user.id,
      name: body.name,
      token_hash: hashApiToken(token),
      prefix: token.slice(0, API_TOKEN_PREFIX.length + 8),
      expires_at: body.expiresDays ? Date.now() + body.expiresDays * 24 * 3600 * 1000 : null,
    });
    audit(req, 'token_created', { type: 'token', id: row.id, detail: body.name });
    reply.code(201);
    // El token en claro solo viaja aquí: se guarda hasheado.
    return { token, apiToken: publicToken(row) };
  });

  app.delete('/api/tokens/:id', async (req, reply) => {
    const user = currentUser(req)!;
    const { id } = req.params as { id: string };
    if (!deleteApiToken(id, user.id)) return reply.code(404).send({ error: 'Token no encontrado' });
    audit(req, 'token_deleted', { type: 'token', id });
    return { ok: true };
  });
}
