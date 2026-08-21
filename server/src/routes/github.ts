import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { assertProjectAccess, currentUser, jwtSecret, requireAdmin, requireAuth, requireSession } from '../auth';
import { audit } from '../audit';
import {
  deleteGithubInstallation,
  getGithubInstallation,
  getProject,
  listAllGithubInstallations,
  listGithubInstallationsForProject,
  upsertGithubInstallation,
} from '../db';
import {
  buildAppManifest,
  clearGithubApp,
  configureUrl,
  convertManifestCode,
  forgetInstallationToken,
  getInstallation,
  githubAppConfig,
  githubAppConfigured,
  installUrl,
  listInstallationRepos,
} from '../github/app';
import { GithubError, listGithubBranches } from '../github/client';
import { installationTokenFor } from '../github/resolve';
import { moduleAllowedForProject } from '../quota';
import { GithubInstallationRow } from '../types';
import { randomAlnum } from '../util';

/**
 * GitHub App: creación en un clic (flujo de manifiesto), instalación sobre las
 * cuentas del usuario y consulta de sus repos.
 *
 * El estado anti-CSRF de los saltos a github.com viaja FIRMADO en vez de
 * guardado: así el flujo sobrevive a un reinicio del servidor a mitad —crear la
 * App en GitHub y perder el código de canje dejaría una App huérfana— y no hay
 * que limpiar estados caducados.
 */

const STATE_TTL = '30m';

interface SetupState {
  kind: 'manifest' | 'install';
  userId: string;
  projectId?: string | null;
}

function signState(payload: SetupState): string {
  return jwt.sign(payload, jwtSecret(), { algorithm: 'HS256', expiresIn: STATE_TTL });
}

function verifyState(raw: string | undefined, kind: SetupState['kind']): SetupState | null {
  if (!raw) return null;
  try {
    const payload = jwt.verify(raw, jwtSecret(), { algorithms: ['HS256'] }) as jwt.JwtPayload & SetupState;
    if (payload.kind !== kind || typeof payload.userId !== 'string') return null;
    return { kind: payload.kind, userId: payload.userId, projectId: payload.projectId ?? null };
  } catch {
    return null;
  }
}

/**
 * URL pública del panel, que GitHub necesita para el webhook y los retornos.
 * Se toma de la petición (con X-Forwarded-* si el proxy es de confianza), que
 * es lo que el usuario está usando ahora mismo para ver el panel.
 */
function baseUrlOf(req: FastifyRequest): string {
  // req.hostname/req.protocol respetan `config.trustProxy`: solo se hace caso a
  // X-Forwarded-* si el proxy es de confianza. Leer la cabecera a pelo dejaría
  // que cualquiera decidiera qué URLs lleva el manifiesto de la App.
  const host = req.hostname;
  if (!host) throw new Error('No se pudo determinar la URL pública del panel');
  return `${req.protocol}://${host}`;
}

/** Vista pública de una instalación (no hay secreto que ocultar, pero sí ruido). */
function publicInstallation(row: GithubInstallationRow & { project_name?: string | null }) {
  const cfg = githubAppConfig();
  return {
    id: row.id,
    installationId: row.installation_id,
    accountLogin: row.account_login,
    accountType: row.account_type,
    repoSelection: row.repo_selection,
    projectId: row.project_id,
    projectName: row.project_name ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    suspended: row.suspended === 1,
    // Enlace a GitHub para añadir o quitar repos de esta instalación.
    manageUrl: cfg ? configureUrl(cfg, row.installation_id) : null,
  };
}

/** Página mínima que devuelve al panel tras un salto a GitHub. */
function redirectToPanel(reply: FastifyReply, path: string): FastifyReply {
  return reply.redirect(path, 302);
}

/** Acceso a una instalación: la de tu proyecto, o cualquiera si eres admin. */
function installationAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  row: GithubInstallationRow | undefined,
): row is GithubInstallationRow {
  if (!row) {
    reply.code(404).send({ error: 'Instalación no encontrada' });
    return false;
  }
  const user = currentUser(req)!;
  if (user.role === 'admin') return true;
  if (!row.project_id) {
    // Las globales las gestiona solo el admin; el resto puede usarlas, no tocarlas.
    reply.code(403).send({ error: 'Esta conexión de GitHub la gestiona el administrador' });
    return false;
  }
  return assertProjectAccess(req, reply, row.project_id);
}

export async function githubRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Estado de la App: si existe, cómo se llama y dónde instalarla. */
  app.get('/api/github/app', async (req) => {
    const cfg = githubAppConfig();
    const user = currentUser(req)!;
    return {
      configured: !!cfg,
      // Solo el admin puede crear o desenlazar la App del servidor.
      canConfigure: user.role === 'admin',
      app: cfg ? { slug: cfg.slug, name: cfg.name, htmlUrl: cfg.htmlUrl } : null,
      webhookUrl: `${baseUrlOf(req)}/api/webhooks/github/app`,
    };
  });

  /**
   * Manifiesto para crear la App. La web lo envía por POST a github.com desde
   * el navegador del administrador (GitHub no admite crearla server-to-server).
   */
  app.post('/api/github/app/manifest', { preHandler: [requireAdmin, requireSession] }, async (req, reply) => {
    const body = z.object({ org: z.string().trim().max(80).optional() }).parse(req.body ?? {});
    if (githubAppConfig()) {
      return reply.code(409).send({ error: 'Ya hay una GitHub App conectada. Desconéctala antes de crear otra.' });
    }
    const user = currentUser(req)!;
    const state = signState({ kind: 'manifest', userId: user.id });
    // GitHub exige nombre único global: un sufijo corto evita el choque más común.
    const manifest = buildAppManifest(baseUrlOf(req), randomAlnum(5));
    const action = body.org
      ? `https://github.com/organizations/${encodeURIComponent(body.org)}/settings/apps/new?state=${encodeURIComponent(state)}`
      : `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
    return { action, manifest, state };
  });

  /**
   * Retorno del flujo de manifiesto: GitHub redirige aquí con un código de un
   * solo uso que se canjea por las credenciales definitivas.
   */
  app.get('/api/github/app/setup', { preHandler: [requireAdmin, requireSession] }, async (req, reply) => {
    const query = z
      .object({ code: z.string().trim().min(1).optional(), state: z.string().trim().optional() })
      .parse(req.query);
    const state = verifyState(query.state, 'manifest');
    const user = currentUser(req)!;
    if (!query.code || !state || state.userId !== user.id) {
      return redirectToPanel(reply, '/settings?github=estado_invalido#github');
    }
    try {
      const cfg = await convertManifestCode(query.code);
      audit(req, 'github_app_created', { type: 'settings', id: cfg.appId, detail: cfg.name });
      return redirectToPanel(reply, '/settings?github=creada#github');
    } catch (err: any) {
      req.log.error(err);
      return redirectToPanel(reply, '/settings?github=error#github');
    }
  });

  /** Desenlaza la App del servidor (en GitHub sigue existiendo hasta que se borre allí). */
  app.post('/api/github/app/disconnect', { preHandler: [requireAdmin, requireSession] }, async (req) => {
    const cfg = githubAppConfig();
    clearGithubApp();
    audit(req, 'github_app_disconnected', { type: 'settings', id: cfg?.appId ?? 'github-app', detail: cfg?.name ?? '' });
    return { ok: true };
  });

  /**
   * Salto a GitHub para instalar la App sobre una cuenta u organización. Con
   * projectId la instalación queda ligada a ese proyecto; sin él (solo admin)
   * es global y sirve para todos.
   */
  app.get('/api/github/app/install', async (req, reply) => {
    const query = z.object({ projectId: z.string().trim().optional() }).parse(req.query);
    const cfg = githubAppConfig();
    if (!cfg) return reply.code(409).send({ error: 'La GitHub App no está configurada en este servidor.' });
    const user = currentUser(req)!;

    if (query.projectId) {
      if (!getProject(query.projectId)) return reply.code(404).send({ error: 'Proyecto no encontrado' });
      if (!assertProjectAccess(req, reply, query.projectId)) return reply;
      if (!moduleAllowedForProject(query.projectId, 'github', user.role === 'admin')) {
        return reply.code(403).send({ error: 'El módulo «Conectores de GitHub» no está activo en este workspace.' });
      }
    } else if (user.role !== 'admin') {
      return reply.code(403).send({ error: 'Solo un administrador puede conectar GitHub para todo el servidor.' });
    }

    const state = signState({ kind: 'install', userId: user.id, projectId: query.projectId ?? null });
    return redirectToPanel(reply, installUrl(cfg, state));
  });

  /**
   * Retorno tras instalar en GitHub (`setup_url` de la App). Registra la
   * instalación para el proyecto que la pidió y devuelve al panel.
   */
  app.get('/api/github/app/installed', async (req, reply) => {
    const query = z
      .object({
        installation_id: z.coerce.number().int().positive().optional(),
        setup_action: z.string().trim().optional(),
        state: z.string().trim().optional(),
      })
      .parse(req.query);

    const state = verifyState(query.state, 'install');
    const user = currentUser(req)!;
    const back = state?.projectId ? `/projects/${state.projectId}` : '/settings';

    if (!query.installation_id || !state || state.userId !== user.id) {
      return redirectToPanel(reply, `${back}?github=estado_invalido`);
    }
    // El proyecto pudo borrarse mientras el usuario estaba en GitHub.
    if (state.projectId && !getProject(state.projectId)) {
      return redirectToPanel(reply, '/settings?github=proyecto_no_existe');
    }

    try {
      const info = await getInstallation(query.installation_id);
      const row = upsertGithubInstallation({
        installation_id: info.installationId,
        account_login: info.accountLogin,
        account_type: info.accountType,
        repo_selection: info.repositorySelection,
        project_id: state.projectId ?? null,
        created_by: req.authActor ?? user.email,
        suspended: info.suspended,
      });
      audit(req, 'github_installation_connected', {
        type: 'connector',
        id: row.id,
        detail: `@${info.accountLogin} (instalación ${info.installationId})${state.projectId ? ` en proyecto ${state.projectId}` : ' global'}`,
      });
      return redirectToPanel(reply, `${back}?github=conectado`);
    } catch (err: any) {
      req.log.error(err);
      return redirectToPanel(reply, `${back}?github=error`);
    }
  });

  /** Instalaciones utilizables desde un proyecto (las suyas y las globales). */
  app.get('/api/projects/:id/github/installations', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getProject(id)) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    if (!assertProjectAccess(req, reply, id)) return reply;
    return {
      appConfigured: githubAppConfigured(),
      installations: listGithubInstallationsForProject(id).map(publicInstallation),
    };
  });

  /** Vista global para el administrador. */
  app.get('/api/github/installations', { preHandler: requireAdmin }, async () => ({
    appConfigured: githubAppConfigured(),
    installations: listAllGithubInstallations().map(publicInstallation),
  }));

  app.delete('/api/github/installations/:rowId', async (req, reply) => {
    const { rowId } = req.params as { rowId: string };
    const row = getGithubInstallation(rowId);
    if (!installationAccess(req, reply, row)) return reply;
    deleteGithubInstallation(rowId);
    // Solo se olvida el token si ya no queda ninguna fila usando esa instalación.
    if (listGithubInstallationsForProject(row.project_id ?? '').every((r) => r.installation_id !== row.installation_id)) {
      forgetInstallationToken(row.installation_id);
    }
    audit(req, 'github_installation_removed', {
      type: 'connector',
      id: rowId,
      detail: `@${row.account_login} (instalación ${row.installation_id})`,
    });
    return { ok: true };
  });

  /** Refresca desde GitHub el estado de la instalación (repos elegidos, suspensión). */
  app.post('/api/github/installations/:rowId/sync', async (req, reply) => {
    const { rowId } = req.params as { rowId: string };
    const row = getGithubInstallation(rowId);
    if (!installationAccess(req, reply, row)) return reply;
    try {
      const info = await getInstallation(row.installation_id);
      const updated = upsertGithubInstallation({
        installation_id: info.installationId,
        account_login: info.accountLogin,
        account_type: info.accountType,
        repo_selection: info.repositorySelection,
        project_id: row.project_id,
        created_by: row.created_by,
        suspended: info.suspended,
      });
      return { installation: publicInstallation(updated) };
    } catch (err: any) {
      if (err instanceof GithubError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/github/installations/:rowId/repos', async (req, reply) => {
    const { rowId } = req.params as { rowId: string };
    const row = getGithubInstallation(rowId);
    if (!row) return reply.code(404).send({ error: 'Instalación no encontrada' });
    // Para LISTAR basta con acceso al proyecto (o que sea global): elegir un
    // repo es parte del flujo normal de crear un servicio, no de gestionarla.
    if (row.project_id && !assertProjectAccess(req, reply, row.project_id)) return reply;
    try {
      return { repos: await listInstallationRepos(row.installation_id) };
    } catch (err: any) {
      if (err instanceof GithubError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/github/installations/:rowId/branches', async (req, reply) => {
    const { rowId } = req.params as { rowId: string };
    const query = z
      .object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'Formato de repo inválido (owner/repo)') })
      .parse(req.query);
    const row = getGithubInstallation(rowId);
    if (!row) return reply.code(404).send({ error: 'Instalación no encontrada' });
    if (row.project_id && !assertProjectAccess(req, reply, row.project_id)) return reply;
    const [owner, repo] = query.repo.split('/');
    try {
      const token = await installationTokenFor(row);
      return { branches: await listGithubBranches(token, owner, repo) };
    } catch (err: any) {
      if (err instanceof GithubError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });
}
