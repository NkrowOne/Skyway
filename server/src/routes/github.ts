import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { assertProjectAccess, currentUser, jwtSecret, requireAdmin, requireAuth, requireSession } from '../auth';
import { audit } from '../audit';
import {
  deleteGithubInstallation,
  getGithubConnector,
  getGithubInstallation,
  getProject,
  getProjectVars,
  getSetting,
  listAllGithubInstallations,
  listGithubInstallationsByNumber,
  listGithubInstallationsForProject,
  listUserProjectIds,
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
  installUrlFresh,
  listInstallationRepos,
  refreshAppInfo,
} from '../github/app';
import { GithubError, getGithubRepo, listGithubBranches, parseGithubSlug } from '../github/client';
import { installationTokenFor } from '../github/resolve';
import { adviseNeeds, detectNeedsFromGithub } from '../needs';
import { moduleAllowedForProject } from '../quota';
import { projectReferences } from '../variables';
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
    // Enlace a GitHub para añadir o quitar repos de esta instalación: la página
    // de ajustes de la cuenta u organización, que va por id de instalación (la
    // antigua, por slug de la App, no existía y daba 404).
    manageUrl: cfg ? configureUrl({ accountType: row.account_type, accountLogin: row.account_login }, row.installation_id) : null,
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

/**
 * Acceso para USAR una instalación (listar sus repos y ramas), que es menos que
 * gestionarla: elegir repo es parte del flujo normal de crear un servicio.
 *
 * - Ligada a un proyecto: hace falta acceso a ESE proyecto (si llega `projectId`
 *   y no coincide, se rechaza: un proyecto solo usa sus instalaciones o las
 *   globales, nunca las de otro).
 * - Global: antes no se comprobaba nada, y cualquier autenticado —también un
 *   miembro sin ningún proyecto asignado— podía enumerar los repos privados de
 *   la App. Ahora, con `projectId` se exige acceso a ese proyecto (el caso normal
 *   desde el asistente de servicio); sin él, basta ser admin o propietario, o un
 *   miembro con al menos un proyecto asignado: quien puede desplegar en algún
 *   sitio necesita ver el catálogo, quien no tiene dónde desplegar no.
 */
function installationUseAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  row: GithubInstallationRow,
  projectId: string | undefined,
): boolean {
  if (row.project_id) {
    if (projectId && projectId !== row.project_id) {
      reply.code(403).send({ error: 'Esta conexión de GitHub pertenece a otro proyecto' });
      return false;
    }
    return assertProjectAccess(req, reply, row.project_id);
  }
  const user = currentUser(req)!;
  if (user.role === 'admin') return true;
  if (projectId) {
    if (!getProject(projectId)) {
      reply.code(404).send({ error: 'Proyecto no encontrado' });
      return false;
    }
    return assertProjectAccess(req, reply, projectId);
  }
  if (user.role !== 'member' || listUserProjectIds(user.id).length > 0) return true;
  reply.code(403).send({ error: 'No tienes ningún proyecto desde el que usar esta conexión de GitHub' });
  return false;
}

const useQuerySchema = z.object({ projectId: z.string().trim().min(1).optional() });

/** `owner/repo` o URL de GitHub escritos a mano: se aceptan las dos formas. */
const lookupSchema = useQuerySchema.extend({ repo: z.string().trim().min(3).max(300) });

/**
 * Ficha de UN repo con una credencial concreta (o sin ninguna, para los
 * públicos). null si GitHub dice que no existe o que la credencial no lo ve:
 * para GitHub son lo mismo (404), y aquí también.
 */
const lookupRepo = getGithubRepo;

/**
 * Por qué una cuenta no ve un repo escrito a mano, dicho de forma que se pueda
 * actuar. Es el caso de quien es solo colaborador en un repo ajeno: la App solo
 * ve las cuentas donde está instalada, y un token fine-grained solo lo que se
 * le concedió; un token clásico con permiso «repo» sí ve donde colaboras.
 */
function notVisibleMessage(kind: 'app' | 'pat', account: string, owner: string, repo: string): string {
  const quien = `${owner}/${repo}`;
  if (kind === 'app') {
    return (
      `La cuenta @${account} no ve ${quien}. La App solo ve los repositorios de las cuentas donde está instalada: ` +
      `si ${owner} es tuya, añade el repo desde «Elegir repositorios en GitHub»; si solo eres colaborador, conecta ` +
      'un token clásico de tu usuario con permiso «repo» (Tokens personales), que sí ve los repos donde colaboras.'
    );
  }
  return (
    `El token de @${account} no ve ${quien}. Un token fine-grained solo ve los repos que se le concedieron, nunca los ` +
    'de otra cuenta donde eres colaborador: crea uno clásico con permiso «repo», o pide acceso al dueño del repo.'
  );
}

export async function githubRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /**
   * Estado de la App: si existe, cómo se llama y dónde instalarla. Se refresca
   * desde GitHub (memoizado): renombrarla allí cambia su slug y, con el antiguo
   * guardado, su enlace y el de instalar daban 404.
   */
  app.get('/api/github/app', async (req) => {
    const cfg = await refreshAppInfo();
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
    // Con el slug recién comprobado: si la App se renombró en GitHub, el guardado
    // llevaba a un 404.
    return redirectToPanel(reply, await installUrlFresh(state));
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
    /*
     * Sin estado válido, la instalación se hizo desde la propia página de la
     * App en GitHub (o el enlace caducó). Un administrador con sesión la
     * registra igual, como conexión del servidor: es quien puede hacerlo desde
     * Ajustes, y mandarle de vuelta con «estado inválido» solo le obligaba a
     * repetir el paseo. Para cualquier otro sigue siendo un error.
     */
    const adminSinEstado = !state && user.role === 'admin' && !!query.installation_id;
    const projectId = state?.projectId ?? null;
    const back = projectId ? `/projects/${projectId}` : '/settings';

    if (!query.installation_id || (!adminSinEstado && (!state || state.userId !== user.id))) {
      return redirectToPanel(reply, `${back}?github=estado_invalido`);
    }
    // El proyecto pudo borrarse mientras el usuario estaba en GitHub.
    if (projectId && !getProject(projectId)) {
      return redirectToPanel(reply, '/settings?github=proyecto_no_existe');
    }
    /*
     * El id de instalación no viaja firmado en el estado (lo asigna GitHub al
     * volver) y es un entero adivinable: un miembro podía registrar en SU
     * proyecto una instalación ajena de la misma App y clonar con ella los
     * repos privados de otro cliente. Una instalación ya conectada a otro
     * proyecto, o global, solo la reasigna o comparte el administrador.
     */
    if (user.role !== 'admin') {
      const ajena = listGithubInstallationsByNumber(query.installation_id).some((r) => r.project_id !== projectId);
      if (ajena) return redirectToPanel(reply, `${back}?github=instalacion_ajena`);
    }

    try {
      const info = await getInstallation(query.installation_id);
      const row = upsertGithubInstallation({
        installation_id: info.installationId,
        account_login: info.accountLogin,
        account_type: info.accountType,
        repo_selection: info.repositorySelection,
        project_id: projectId,
        created_by: req.authActor ?? user.email,
        suspended: info.suspended,
      });
      audit(req, 'github_installation_connected', {
        type: 'connector',
        id: row.id,
        detail: `@${info.accountLogin} (instalación ${info.installationId})${projectId ? ` en proyecto ${projectId}` : ' global'}`,
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
    // Solo se olvida el token si ya no queda NINGUNA fila (de ningún proyecto)
    // usando esa instalación. Antes se miraba solo el proyecto de la fila
    // borrada —y para una global, el proyecto vacío—, así que una instalación
    // compartida por dos proyectos perdía el token cacheado que el otro seguía
    // usando.
    if (listGithubInstallationsByNumber(row.installation_id).length === 0) {
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
    const query = useQuerySchema.parse(req.query);
    const row = getGithubInstallation(rowId);
    if (!row) return reply.code(404).send({ error: 'Instalación no encontrada' });
    if (!installationUseAccess(req, reply, row, query.projectId)) return reply;
    try {
      return { repos: await listInstallationRepos(row.installation_id) };
    } catch (err: any) {
      if (err instanceof GithubError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/github/installations/:rowId/branches', async (req, reply) => {
    const { rowId } = req.params as { rowId: string };
    const query = useQuerySchema
      .extend({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'Formato de repo inválido (owner/repo)') })
      .parse(req.query);
    const row = getGithubInstallation(rowId);
    if (!row) return reply.code(404).send({ error: 'Instalación no encontrada' });
    if (!installationUseAccess(req, reply, row, query.projectId)) return reply;
    const [owner, repo] = query.repo.split('/');
    try {
      const token = await installationTokenFor(row);
      return { branches: await listGithubBranches(token, owner, repo) };
    } catch (err: any) {
      if (err instanceof GithubError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });

  /**
   * Un repo escrito a mano (o pegado como URL) comprobado con la instalación:
   * el listado solo enseña lo que la App ve, y quien es colaborador en un repo
   * ajeno no lo encuentra ahí. Si la cuenta no lo ve, el 404 dice qué hacer.
   */
  app.get('/api/github/installations/:rowId/repos/lookup', async (req, reply) => {
    const { rowId } = req.params as { rowId: string };
    const query = lookupSchema.parse(req.query);
    const row = getGithubInstallation(rowId);
    if (!row) return reply.code(404).send({ error: 'Instalación no encontrada' });
    if (!installationUseAccess(req, reply, row, query.projectId)) return reply;
    const slug = parseGithubSlug(query.repo);
    if (!slug) return reply.code(400).send({ error: 'Escribe el repositorio como owner/repo o pega su URL de GitHub' });
    try {
      const token = await installationTokenFor(row);
      const repo = await lookupRepo(token, slug.owner, slug.repo);
      if (repo) return { repo };
      return reply.code(404).send({ error: notVisibleMessage('app', row.account_login, slug.owner, slug.repo), reason: 'not_visible' });
    } catch (err: any) {
      if (err instanceof GithubError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });

  /**
   * Dependencias del repositorio ANTES de crear el servicio: los mismos ficheros
   * que la detección mira tras clonar, leídos por la API de GitHub con la
   * credencial que vaya a clonar (`source`: `app:<id>`, `pat:<id>` o nada =
   * token global/anónimo). Con eso el asistente de alta propone crear y
   * conectar las bases que hagan falta, sin esperar al primer despliegue.
   */
  app.get('/api/projects/:id/github/needs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = z
      .object({
        repo: z.string().trim().min(3).max(300),
        branch: z.string().trim().min(1).max(200),
        rootDir: z.string().trim().max(200).optional(),
        source: z.string().trim().max(80).optional(),
        name: z.string().trim().max(60).optional(),
      })
      .parse(req.query);
    if (!getProject(id)) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    if (!assertProjectAccess(req, reply, id)) return reply;
    const slug = parseGithubSlug(query.repo);
    if (!slug) return reply.code(400).send({ error: 'Escribe el repositorio como owner/repo o pega su URL de GitHub' });

    let token: string | null = getSetting('githubToken') || null;
    if (query.source?.startsWith('app:')) {
      const row = getGithubInstallation(query.source.slice(4));
      if (!row) return reply.code(404).send({ error: 'Instalación no encontrada' });
      if (!installationUseAccess(req, reply, row, id)) return reply;
      token = await installationTokenFor(row).catch((err: any) => {
        throw err instanceof GithubError ? err : new GithubError(err?.message || 'No se pudo obtener el token de la instalación');
      });
    } else if (query.source?.startsWith('pat:')) {
      const connector = getGithubConnector(query.source.slice(4));
      if (!connector || connector.project_id !== id) return reply.code(400).send({ error: 'Conector de GitHub desconocido en este proyecto' });
      token = connector.token;
    }

    try {
      const needs = await detectNeedsFromGithub(token, slug.owner, slug.repo, query.branch, query.rootDir || undefined);
      const advice = adviseNeeds(
        needs,
        // Sin dominio todavía: las variables de URL pública se quedan en «missing».
        { serviceName: query.name || slug.repo, domains: [], defined: new Set(Object.keys(getProjectVars(id))) },
        projectReferences(id),
      );
      return { ...advice, envFile: needs?.envFile ?? null };
    } catch (err: any) {
      if (err instanceof GithubError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });

  /**
   * Lo mismo sin cuenta elegida («URL manual»): con el token global del
   * servidor si lo hay, y si no, como anónimo (solo repos públicos). Sirve para
   * decir ANTES de crear el servicio si el primer despliegue va a poder clonar.
   */
  app.get('/api/projects/:id/github/lookup', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = z.object({ repo: z.string().trim().min(3).max(300) }).parse(req.query);
    if (!getProject(id)) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    if (!assertProjectAccess(req, reply, id)) return reply;
    const slug = parseGithubSlug(query.repo);
    if (!slug) return reply.code(400).send({ error: 'Escribe el repositorio como owner/repo o pega su URL de GitHub' });
    const globalToken = getSetting('githubToken') || null;
    try {
      const repo = await lookupRepo(globalToken, slug.owner, slug.repo);
      if (repo) return { repo, credential: globalToken ? 'global' : 'public' };
      return reply.code(404).send({
        error: globalToken
          ? `Ni el token global del servidor ve ${slug.owner}/${slug.repo}: conecta en este proyecto una cuenta de GitHub que lo vea.`
          : `${slug.owner}/${slug.repo} no es público (o no existe): para clonarlo conecta en este proyecto una cuenta de GitHub que lo vea.`,
        reason: 'not_visible',
      });
    } catch (err: any) {
      if (err instanceof GithubError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });
}

export { lookupRepo, notVisibleMessage };
