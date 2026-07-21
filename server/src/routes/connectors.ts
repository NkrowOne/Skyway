import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertProjectAccess, requireAdmin, requireAuth } from '../auth';
import { audit } from '../audit';
import {
  countGithubConnectors,
  deleteGithubConnector,
  getGithubConnector,
  getProject,
  getSetting,
  insertGithubConnector,
  listAllGithubConnectors,
  listGithubConnectors,
} from '../db';
import { GithubError, listGithubBranches, listGithubRepos, verifyGithubToken } from '../github/client';
import { GithubConnectorRow } from '../types';

const MAX_CONNECTORS_PER_PROJECT = 10;

const createSchema = z.object({
  name: z.string().trim().min(1, 'Nombre requerido').max(60),
  token: z.string().trim().min(10, 'Token de GitHub requerido'),
});

/** Vista pública de un conector: el token jamás sale del servidor. */
function publicConnector(c: GithubConnectorRow) {
  return {
    id: c.id,
    project_id: c.project_id,
    name: c.name,
    gh_login: c.gh_login,
    token_type: c.token_type,
    created_by: c.created_by,
    created_at: c.created_at,
    last_used_at: c.last_used_at,
  };
}

/** Aviso si un token clásico no podrá clonar repos privados. */
function scopeWarning(tokenType: string, scopes: string[]): string | null {
  if (tokenType === 'classic' && !scopes.includes('repo')) {
    return 'El token no tiene el permiso «repo»: podrá listar y clonar solo repositorios públicos.';
  }
  return null;
}

/**
 * Conectores de GitHub por proyecto: cualquier usuario con acceso al workspace
 * (clientes incluidos) conecta su token y asigna sus repos a los servicios.
 * El admin ve y revoca todos desde /api/connectors y Ajustes.
 */
export async function connectorRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/projects/:projectId/connectors', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    if (!getProject(projectId)) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    if (!assertProjectAccess(req, reply, projectId)) return reply;
    return {
      connectors: listGithubConnectors(projectId).map(publicConnector),
      // Para el aviso de la UI: sin conector, el clonado usa el token global del admin (si existe).
      hasGlobalToken: !!getSetting('githubToken'),
    };
  });

  app.post('/api/projects/:projectId/connectors', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    if (!getProject(projectId)) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    if (!assertProjectAccess(req, reply, projectId)) return reply;
    if (countGithubConnectors(projectId) >= MAX_CONNECTORS_PER_PROJECT) {
      return reply.code(400).send({ error: `Máximo ${MAX_CONNECTORS_PER_PROJECT} conectores por proyecto` });
    }
    const body = createSchema.parse(req.body);

    let identity;
    try {
      identity = await verifyGithubToken(body.token);
    } catch (err: any) {
      if (err instanceof GithubError) return reply.code(502).send({ error: err.message });
      throw err;
    }

    const connector = insertGithubConnector({
      project_id: projectId,
      name: body.name,
      token: body.token,
      gh_login: identity.login,
      token_type: identity.tokenType,
      created_by: req.authActor ?? 'desconocido',
    });
    audit(req, 'connector_created', {
      type: 'connector',
      id: connector.id,
      detail: `${body.name} (@${identity.login}) en proyecto ${projectId}`,
    });
    reply.code(201);
    return { connector: publicConnector(connector), warning: scopeWarning(identity.tokenType, identity.scopes) };
  });

  app.delete('/api/connectors/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const connector = getGithubConnector(id);
    if (!connector) return reply.code(404).send({ error: 'Conector no encontrado' });
    if (!assertProjectAccess(req, reply, connector.project_id)) return reply;
    deleteGithubConnector(id);
    // Los servicios que lo referencien vuelven al token global en el siguiente despliegue.
    audit(req, 'connector_deleted', {
      type: 'connector',
      id,
      detail: `${connector.name} (@${connector.gh_login}) del proyecto ${connector.project_id}`,
    });
    return { ok: true };
  });

  /** Revalida el token guardado (p. ej. para detectar tokens revocados o caducados). */
  app.post('/api/connectors/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const connector = getGithubConnector(id);
    if (!connector) return reply.code(404).send({ error: 'Conector no encontrado' });
    if (!assertProjectAccess(req, reply, connector.project_id)) return reply;
    try {
      const identity = await verifyGithubToken(connector.token);
      return { ok: true, login: identity.login, tokenType: identity.tokenType, warning: scopeWarning(identity.tokenType, identity.scopes) };
    } catch (err: any) {
      if (err instanceof GithubError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });

  /** Repos visibles con el token del conector, para el selector de la UI. */
  app.get('/api/connectors/:id/repos', async (req, reply) => {
    const { id } = req.params as { id: string };
    const connector = getGithubConnector(id);
    if (!connector) return reply.code(404).send({ error: 'Conector no encontrado' });
    if (!assertProjectAccess(req, reply, connector.project_id)) return reply;
    try {
      return { repos: await listGithubRepos(connector.token) };
    } catch (err: any) {
      if (err instanceof GithubError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/connectors/:id/branches', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = z
      .object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'Formato de repo inválido (owner/repo)') })
      .parse(req.query);
    const connector = getGithubConnector(id);
    if (!connector) return reply.code(404).send({ error: 'Conector no encontrado' });
    if (!assertProjectAccess(req, reply, connector.project_id)) return reply;
    const [owner, repo] = query.repo.split('/');
    try {
      return { branches: await listGithubBranches(connector.token, owner, repo) };
    } catch (err: any) {
      if (err instanceof GithubError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });

  /** Vista global para el admin: todos los conectores de todos los proyectos. */
  app.get('/api/connectors', { preHandler: requireAdmin }, async () => ({
    connectors: listAllGithubConnectors().map((c) => ({
      ...publicConnector(c),
      project_name: c.project_name,
      project_client: c.project_client,
    })),
  }));
}
