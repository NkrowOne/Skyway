import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertProjectAccess, currentUser, requireAdmin, requireAuth } from '../auth';
import { audit } from '../audit';
import { cloudflareConfigurado } from '../cloudflareconfig';
import { dnsAutomaticoAdmin, dnsSinBase } from '../cloudflaredns';
import { dbConsoleEngine } from '../dbconsole';
import { domainClaimError } from '../domainguard';
import { markManualAction } from '../monitor';
import {
  countWorkspaceServices,
  createService,
  getEnv,
  getGithubConnector,
  getGithubInstallation,
  getProject,
  getService,
  latestDeployment,
  setEnv,
  setServiceStopped,
  uniqueServiceSlug,
  updateService,
} from '../db';
import {
  effectiveQuota,
  isWorkspaceActive,
  moduleAllowedForProject,
  quotaMessage,
  serviceReservation,
  workspaceAllocation,
  workspaceOfProject,
  workspacePlan,
} from '../quota';
import { archiveContainerLogs } from '../deploy/deployer';
import { EnvFileSource, envImportContextFor, fetchRepoEnvFiles, finalizeEnvImport, planEnvImport } from '../deploy/envimport';
import { GithubError, parseGithubSlug } from '../github/client';
import { resolveGitToken } from '../github/resolve';
import { rateLimit } from '../ratelimit';
import { dockerAvailable } from '../docker/client';
import {
  configuredReplicas,
  containerName,
  getRuntime,
  replicaName,
  restartContainer,
  startContainer,
  stopContainer,
  updateResources,
} from '../docker/containers';
import { dockerSnapshot, invalidateDockerSnapshot, runtimeIn, Snapshot } from '../docker/sampler';
import { triggerDeploy } from '../deploy/deployer';
import { getTemplate, templateList } from '../templates';
import { applyPlan, applyPlanFromRepo, ApplyResult, PlanChangedError, planWithMail } from '../integrations';
import { adviseEnv } from '../needs';
import { availableReferences, resolveServiceEnv } from '../variables';
import { DatabaseConfig, GitConfig, ImageConfig, ServiceConfig, ServiceRow } from '../types';
import { randomToken, VISIBLE_NAME_ERROR, VISIBLE_NAME_RE } from '../util';
import { confirmsDeletion, purgeService, PurgeBlockedError, purgeSummary, warningsForAudit } from '../purge';

/** Antigüedad tolerada de la foto de Docker en las lecturas del panel. */
const PANEL_MAX_AGE_MS = 4000;

/** Servicios que se están eliminando: un segundo DELETE a la vez no repite el trabajo. */
const deletingServices = new Set<string>();

/** Con qué se tapan los valores de los build args en las respuestas de lectura. */
const VALOR_TAPADO = '•••';

/** Tope de importaciones del `.env` del repositorio por usuario y minuto (cada una son varias peticiones a GitHub). */
const IMPORTACIONES_POR_MINUTO = 10;

/**
 * Config con los valores de `buildArgs` tapados (se conservan las claves, para
 * que se vea QUÉ hay). Un `--build-arg` puede llevar un token de registro o de
 * paquetes privados, y nada del panel los lee: solo se escriben.
 */
export function maskBuildArgs<T extends ServiceConfig>(cfg: T): T {
  const args = (cfg as { buildArgs?: unknown }).buildArgs;
  if (!args || typeof args !== 'object') return cfg;
  return {
    ...cfg,
    buildArgs: Object.fromEntries(Object.keys(args as Record<string, unknown>).map((k) => [k, VALOR_TAPADO])),
  };
}

/**
 * Config de un servicio tal y como viaja en los LISTADOS (proyectos, panel):
 * sin el secreto del webhook y con los build args tapados. El detalle del
 * servicio (`GET /api/services/:id`) sí devuelve el secreto, porque Ajustes lo
 * enseña para copiarlo a GitHub; el listado de proyectos, que se sondea cada
 * 8 s y se comparte con todo el que ve el proyecto, no tiene por qué llevarlo.
 */
export function publicServiceConfig<T extends ServiceConfig>(cfg: T): T {
  const out = { ...maskBuildArgs(cfg) } as T & { webhookSecret?: string };
  delete out.webhookSecret;
  return out;
}

/**
 * Nombre de host válido (RFC 1123), en minúsculas. Los dominios acaban dentro
 * de la regla `Host(\`…\`)` de Traefik, que es único para todo el servidor: un
 * texto libre con una comilla invertida o un paréntesis podía redactar una
 * regla que capturara el tráfico de los dominios de otros clientes.
 */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
export const domainSchema = z
  .string()
  .trim()
  .transform((d) => d.toLowerCase())
  .refine((d) => HOSTNAME.test(d), 'Dominio no válido: solo letras, números, guiones y puntos');

/** Recursos del plan de integraciones que se pueden omitir al aplicarlo. */
const planSkipSchema = z.array(z.enum(['postgres', 'redis', 'mysql', 'mongo', 'minio', 'mail', 'empty'])).max(10);
/** Huella del plan revisado (`IntegrationPlan.fingerprint`): sin ella no se aprueba nada privilegiado. */
const planExpectSchema = z.string().regex(/^[0-9a-f]{32}$/, 'Huella del plan no válida');

const createGitSchema = z.object({
  type: z.literal('git'),
  name: z.string().trim().min(1).max(60).regex(VISIBLE_NAME_RE, VISIBLE_NAME_ERROR),
  repoUrl: z.string().trim().min(3, 'Repositorio requerido'),
  connectorId: z.string().trim().optional(),
  githubInstallationId: z.string().trim().optional(),
  branch: z.string().trim().min(1).default('main'),
  rootDir: z.string().trim().optional(),
  dockerfilePath: z.string().trim().optional(),
  builder: z.enum(['auto', 'dockerfile', 'nixpacks']).optional(),
  startCmd: z.string().trim().optional(),
  buildCmd: z.string().trim().optional(),
  // Sin `.default`: que no venga puerto es un dato —nadie lo ha elegido— y el
  // valor por defecto lo borraba. Se sigue guardando 3000; lo que se guarda
  // además es de dónde salió.
  port: z.coerce.number().int().min(1).max(65535).optional(),
  domains: z.array(domainSchema).default([]),
  autoDeploy: z.boolean().default(true),
  // Variables con las que nace el servicio (el asistente de alta las rellena
  // con las referencias a las bases que acaba de crear). Van ANTES del primer
  // despliegue: guardarlas después dejaba ese despliegue sin ellas.
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Nombre de variable inválido'), z.string()).optional(),
  // Aplicar el plan de integraciones del repositorio (skyway.json o la
  // detección) antes del primer despliegue. `skip`: recursos que no se quieren
  // (un motor, `mail` o `empty`). `expect`: huella del plan que se ha enseñado
  // (GET …/github/needs); si al crear el repositorio dice otra cosa, lo
  // privilegiado queda pendiente. `confirmMailboxAccess`: confirmación del
  // acceso al buzón que se reutiliza, si el plan la pide.
  plan: z
    .object({ skip: planSkipSchema.optional(), expect: planExpectSchema.optional(), confirmMailboxAccess: z.boolean().optional() })
    .strict()
    .optional(),
});

const createDbSchema = z.object({
  type: z.literal('database'),
  name: z.string().trim().min(1).max(60).regex(VISIBLE_NAME_RE, VISIBLE_NAME_ERROR).optional(),
  template: z.string(),
  version: z.string().trim().optional(),
});

const createImageSchema = z.object({
  type: z.literal('image'),
  name: z.string().trim().min(1).max(60).regex(VISIBLE_NAME_RE, VISIBLE_NAME_ERROR),
  image: z.string().trim().min(1, 'Imagen requerida'),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  startCmd: z.string().trim().optional(),
  domains: z.array(domainSchema).default([]),
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(60).regex(VISIBLE_NAME_RE, VISIBLE_NAME_ERROR).optional(),
  config: z
    .object({
      repoUrl: z.string().trim().min(3).optional(),
      connectorId: z.string().trim().nullable().optional(),
      githubInstallationId: z.string().trim().nullable().optional(),
      branch: z.string().trim().min(1).optional(),
      rootDir: z.string().trim().nullable().optional(),
      dockerfilePath: z.string().trim().nullable().optional(),
      builder: z.enum(['auto', 'dockerfile', 'nixpacks']).optional(),
      startCmd: z.string().trim().nullable().optional(),
      buildCmd: z.string().trim().nullable().optional(),
      // nullable: los servicios de imagen sin puerto interno (workers) envían
      // null; sin esto, NINGÚN ajuste suyo se podía guardar (Number(null)=0).
      port: z.coerce.number().int().min(1).max(65535).nullable().optional(),
      domains: z.array(domainSchema).optional(),
      hostPort: z.coerce.number().int().min(1).max(65535).nullable().optional(),
      cpus: z.coerce.number().min(0.1).max(64).nullable().optional(),
      memoryMb: z.coerce.number().int().min(32).max(1024 * 512).nullable().optional(),
      diskMb: z.coerce.number().int().min(64).max(1024 * 1024).nullable().optional(),
      version: z.string().trim().optional(),
      image: z.string().trim().min(1).optional(),
      healthcheckPath: z.string().trim().max(200).nullable().optional(),
      buildArgs: z.record(z.string()).optional(),
      alertsMuted: z.boolean().optional(),
      autoDeploy: z.boolean().optional(),
      autoImportEnv: z.boolean().optional(),
      volumes: z.array(z.object({ containerPath: z.string().trim().min(1).regex(/^\//, 'Ruta absoluta requerida') })).optional(),
      replicas: z.coerce.number().int().min(1).max(10).optional(),
      backupSchedule: z.enum(['daily', 'weekly']).nullable().optional(),
      backupRetention: z.coerce.number().int().min(1).max(60).optional(),
    })
    .optional(),
  /**
   * Dominios que tenía el servicio cuando se cargó el formulario (o la lectura
   * de la que parte quien edita). Con `config.domains`, sirve para saber qué
   * dominios añade de verdad esta petición (§ concurrencia en el PATCH).
   * Laxo a propósito: es una lista de comparación, nunca se guarda.
   */
  domainsBase: z.array(z.string().trim().toLowerCase().max(253)).max(200).optional(),
});

/** Mismo conjunto de dominios, sin importar el orden ni las repeticiones. */
function mismosDominios(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((d) => sb.has(d));
}

/**
 * ¿Se puede usar esa conexión de GitHub desde este proyecto? Vale la del propio
 * proyecto y la global del administrador; la de OTRO proyecto no, aunque se
 * escriba su id a mano (sería una vía para clonar repos de otro cliente).
 */
function installationVisibleFrom(rowId: string, projectId: string): boolean {
  const row = getGithubInstallation(rowId);
  return !!row && (row.project_id === null || row.project_id === projectId);
}

/** Campos cuyo cambio requiere recrear el contenedor. */
const REDEPLOY_FIELDS = [
  'repoUrl', 'connectorId', 'githubInstallationId', 'branch', 'rootDir', 'dockerfilePath', 'builder', 'startCmd', 'buildCmd', 'port',
  'domains', 'hostPort', 'version', 'image', 'buildArgs', 'healthcheckPath', 'volumes', 'replicas',
] as const;

function loadService(id: string): { service: ServiceRow; project: NonNullable<ReturnType<typeof getProject>> } | null {
  const service = getService(id);
  if (!service) return null;
  const project = getProject(service.project_id);
  if (!project) return null;
  return { service, project };
}

export async function serviceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/templates', async () => ({ templates: templateList() }));

  app.post('/api/projects/:projectId/services', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = getProject(projectId);
    if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    if (!assertProjectAccess(req, reply, projectId)) return reply;

    const base = z.object({ type: z.enum(['git', 'database', 'image']) }).parse(req.body);

    // Cuota agregada del workspace: suspensión, número de servicios y módulos.
    const user = currentUser(req)!;
    const isAdmin = user.role === 'admin';
    const workspace = workspaceOfProject(projectId);
    if (workspace) {
      if (!isWorkspaceActive(workspace)) {
        return reply.code(403).send({ error: 'El workspace está suspendido: no se pueden crear servicios.' });
      }
      const quota = effectiveQuota(workspace, workspacePlan(workspace));
      if (countWorkspaceServices(workspace.id) >= quota.maxServices) {
        return reply.code(409).send({
          error: `El workspace ha alcanzado su límite de ${quota.maxServices} servicios. Un administrador puede ampliar la cuota.`,
        });
      }
    }
    if (base.type === 'database' && !moduleAllowedForProject(projectId, 'databases', isAdmin)) {
      return reply.code(403).send({ error: 'El módulo «Bases de datos» no está activo en este workspace.' });
    }
    const reqDomains = (req.body as { domains?: unknown })?.domains;
    if (Array.isArray(reqDomains) && reqDomains.length > 0 && !moduleAllowedForProject(projectId, 'domains', isAdmin)) {
      return reply.code(403).send({ error: 'El módulo «Dominios y TLS» no está activo en este workspace.' });
    }
    // Los dominios que pide ESTA alta: los únicos que pasan por el DNS automático.
    let dominiosPedidos: string[] = [];
    if (base.type !== 'database') {
      // Antes de crear nada: un dominio de otro (o del panel) no se reparte.
      const { domains } = z.object({ domains: z.array(domainSchema).default([]) }).parse(req.body);
      const conflicto = domainClaimError(domains, { projectId, serviceId: null, isAdmin });
      if (conflicto) return reply.code(409).send({ error: conflicto });
      dominiosPedidos = domains;
    }

    let service: ServiceRow;
    let planOutcome: Awaited<ReturnType<typeof applyPlanFromRepo>> | null = null;
    if (base.type === 'image') {
      const body = createImageSchema.parse(req.body);
      // Un dominio sin puerto no enruta a nada y el panel lo enseñaría como
      // configurado. Se corta en el alta, que es donde no hay nada que romper.
      // No se infiere un puerto a propósito: un worker sin HTTP es legítimo, y
      // darle router y certificado por su cuenta sería peor que el error.
      if (body.domains.length > 0 && !body.port) {
        return reply.code(400).send({
          error:
            'Un servicio con dominio requiere puerto interno: Traefik necesita saber a qué puerto del contenedor entregar la petición. Indica el puerto en el que escucha la imagen, o crea el servicio sin dominio si es un worker sin HTTP.',
        });
      }
      const slug = uniqueServiceSlug(projectId, body.name);
      const cfg: ImageConfig = {
        image: body.image,
        port: body.port ?? null,
        startCmd: body.startCmd || undefined,
        domains: body.domains,
      };
      service = createService(projectId, body.name, slug, 'image', cfg);
    } else if (base.type === 'git') {
      const body = createGitSchema.parse(req.body);
      if (body.connectorId && getGithubConnector(body.connectorId)?.project_id !== projectId) {
        return reply.code(400).send({ error: 'Conector de GitHub desconocido en este proyecto' });
      }
      if (body.githubInstallationId && !installationVisibleFrom(body.githubInstallationId, projectId)) {
        return reply.code(400).send({ error: 'Conexión de GitHub desconocida en este proyecto' });
      }
      const slug = uniqueServiceSlug(projectId, body.name);
      const cfg: GitConfig = {
        repoUrl: body.repoUrl,
        connectorId: body.connectorId || undefined,
        githubInstallationId: body.githubInstallationId || undefined,
        branch: body.branch,
        rootDir: body.rootDir || undefined,
        dockerfilePath: body.dockerfilePath || undefined,
        builder: body.builder && body.builder !== 'auto' ? body.builder : undefined,
        startCmd: body.startCmd || undefined,
        buildCmd: body.buildCmd || undefined,
        port: body.port ?? 3000,
        // Nadie eligió el puerto: el primer despliegue puede corregirlo con el
        // EXPOSE de la imagen. En cuanto se elija uno a mano, esto desaparece.
        portAuto: body.port === undefined ? true : undefined,
        domains: body.domains,
        autoDeploy: body.autoDeploy,
        webhookSecret: randomToken(16),
      };
      service = createService(projectId, body.name, slug, 'git', cfg);
      if (body.env && Object.keys(body.env).length > 0) setEnv(service.id, body.env);
      if (body.plan) {
        planOutcome = await applyPlanFromRepo({
          project,
          user,
          service,
          skip: new Set(body.plan.skip ?? []),
          expect: body.plan.expect,
          confirmMailboxAccess: body.plan.confirmMailboxAccess,
        });
        if (planOutcome.error) req.log.warn({ serviceId: service.id }, planOutcome.error);
        if (planOutcome.result) auditPlan(req, service, planOutcome.result);
        service = getService(service.id) ?? service;
      }
    } else {
      const body = createDbSchema.parse(req.body);
      const template = getTemplate(body.template);
      if (!template) return reply.code(400).send({ error: `Plantilla desconocida: ${body.template}` });
      const name = body.name || template.label;
      const slug = uniqueServiceSlug(projectId, name);
      const cfg: DatabaseConfig = {
        template: template.key,
        version: body.version || template.defaultVersion,
      };
      service = createService(projectId, name, slug, 'database', cfg);
      setEnv(service.id, template.makeEnv(slug));
    }

    audit(req, 'service_created', { type: 'service', id: service.id, detail: `${service.name} (${service.type})` });
    markManualAction(service.id);
    const deployment = triggerDeploy(service.id, 'initial');
    // Solo para un administrador con token de Cloudflare (lo comprueba
    // `dnsAutomaticoAdmin`); nunca hace fallar el alta, que ya está hecha.
    // Los dominios son los de la petición, no los que tenga el servicio al
    // releerlo tras el plan: mientras se consulta GitHub, el cliente del
    // proyecto puede añadir al servicio un nombre de las zonas del operador,
    // que no debe crearse con su token. Y solo si siguen en el servicio: uno
    // que el cliente ya quitó dejaría un registro huérfano.
    const dominiosAhora = new Set((service.config as { domains?: string[] }).domains ?? []);
    const dns = await dnsAutomaticoAdmin(
      req,
      dominiosPedidos.filter((d) => dominiosAhora.has(d)),
      { type: 'service', id: service.id },
      projectId,
    );
    reply.code(201);
    return {
      service,
      deployment,
      ...(planOutcome ? { plan: { result: planOutcome.result, plan: planOutcome.plan, error: planOutcome.error } } : {}),
      ...(dns ? { dns } : {}),
    };
  });

  /**
   * Plan de integraciones del servicio (sin efectos): lo que pide su
   * `skyway.json` o la detección del último despliegue, contra el estado
   * actual, con lo que ya está, lo que se aplicaría y lo pendiente de aprobar.
   */
  app.get('/api/services/:id/integrations', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = loadService(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
    if (found.service.type !== 'git') return { plan: null, pending: [] };
    const cfg = found.service.config as GitConfig;
    const { plan } = await planWithMail({
      project: found.project,
      user: currentUser(req)!,
      target: { service: found.service, domains: cfg.domains ?? [] },
      needs: cfg.needs,
    });
    return { plan, pending: cfg.integrationsPending ?? [] };
  });

  /**
   * Aplica el plan con un solo botón. Lo inofensivo lo aplica cualquiera con
   * acceso al proyecto, y las bases de datos también (la misma regla que
   * crearlas a mano); el correo, solo quien lo gestiona (administrador o
   * propietario): para los demás queda pendiente. Lo privilegiado se aprueba
   * con la huella del plan revisado (`expect`): sin ella queda pendiente, y si
   * el plan ha cambiado desde entonces responde 409 con el plan nuevo sin
   * aplicar nada. Nunca pisa una variable puesta a mano. `redeploy` despliega
   * si se ha escrito algo.
   */
  app.post(
    '/api/services/:id/integrations/apply',
    { preHandler: rateLimit({ max: 10, windowMs: 60_000 }) },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const found = loadService(id);
      if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
      if (!assertProjectAccess(req, reply, found.project.id)) return reply;
      if (found.service.type !== 'git') return reply.code(400).send({ error: 'El plan de integraciones solo existe en los servicios de repositorio.' });
      const body = z
        .object({
          skip: planSkipSchema.optional(),
          expect: planExpectSchema.optional(),
          confirmMailboxAccess: z.boolean().optional(),
          redeploy: z.boolean().optional().default(false),
        })
        .strict()
        .parse(req.body ?? {});
      let applied: Awaited<ReturnType<typeof applyPlan>>;
      try {
        applied = await applyPlan({
          project: found.project,
          user: currentUser(req)!,
          service: found.service,
          skip: new Set(body.skip ?? []),
          expect: body.expect,
          confirmMailboxAccess: body.confirmMailboxAccess,
          onMismatch: 'reject',
        });
      } catch (err) {
        // Con el plan nuevo: la vista lo enseña antes de volver a ofrecer el botón.
        if (err instanceof PlanChangedError) return reply.code(409).send({ error: err.message, plan: err.plan });
        throw err;
      }
      const { result, plan } = applied;
      auditPlan(req, found.service, result);
      let deploymentId: string | null = null;
      if (body.redeploy && result.applied.length > 0) {
        markManualAction(id);
        deploymentId = triggerDeploy(id, 'manual').id;
      }
      return { result, plan, needsRedeploy: result.applied.length > 0 && !deploymentId, deploymentId };
    },
  );

  app.get('/api/services/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = loadService(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
    // Lectura de panel: se sirve de la foto compartida (el drawer la repite
    // cada 4 s) en vez de lanzar su propio inspect contra el socket. La foto es
    // también quien dice si Docker respondía, para no dar dos verdades.
    const snap = await dockerSnapshot(PANEL_MAX_AGE_MS);
    const docker = snap.docker;
    const runtime = runtimeIn(snap, id);
    return {
      // El secreto del webhook sí va (Ajustes lo copia); los build args, tapados.
      service: { ...found.service, config: maskBuildArgs(found.service.config) },
      project: found.project,
      runtime,
      latestDeployment: latestDeployment(id) ?? null,
      // Quién tiene consola lo decide el servidor: el panel no puede saber si
      // una imagen cualquiera es una base de datos sin repetir aquí la tabla de
      // imágenes conocidas, y dos copias de esa tabla se separan a la primera.
      dbConsole: dbConsoleEngine(found.service),
    };
  });

  app.patch('/api/services/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = loadService(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
    const body = patchSchema.parse(req.body);
    if (body.config?.connectorId && getGithubConnector(body.config.connectorId)?.project_id !== found.project.id) {
      return reply.code(400).send({ error: 'Conector de GitHub desconocido en este proyecto' });
    }
    if (body.config?.githubInstallationId && !installationVisibleFrom(body.config.githubInstallationId, found.project.id)) {
      return reply.code(400).send({ error: 'Conexión de GitHub desconocida en este proyecto' });
    }

    const oldCfg = found.service.config as any;
    const newCfg = { ...oldCfg };
    let needsRedeploy = false;
    let resourcesChanged = false;

    // Concurrencia de los dominios. Ajustes reenvía siempre la lista entera, y
    // un formulario abierto antes de que otra persona (el cliente, otro
    // administrador) cambiara los dominios devolvería la lista vieja: el
    // dominio que alguien acaba de quitar volvería en silencio y, guardado por
    // un administrador, contaría como «nuevo» para el DNS automático, que lo
    // crearía con el token del operador en su zona. Con `domainsBase` se
    // compara con lo que hay ahora: si quien guarda no ha tocado los dominios,
    // se conservan los actuales; si los ha tocado, se rechaza para que recargue.
    const dominiosAntes = (oldCfg.domains ?? []) as string[];
    if (body.config?.domains !== undefined && body.domainsBase !== undefined && !mismosDominios(body.domainsBase, dominiosAntes)) {
      if (!mismosDominios(body.config.domains, body.domainsBase)) {
        return reply.code(409).send({
          error:
            'Los dominios de este servicio han cambiado mientras los editabas. Recarga la página para ver los actuales y vuelve a hacer tus cambios.',
        });
      }
      body.config.domains = undefined;
    }

    if (body.config) {
      for (const [key, value] of Object.entries(body.config)) {
        if (value === undefined) continue;
        // El conector y el auto-deploy solo tienen sentido en servicios de repositorio.
        if (key === 'connectorId' && found.service.type !== 'git') continue;
        if (key === 'githubInstallationId' && found.service.type !== 'git') continue;
        if (key === 'buildCmd' && found.service.type !== 'git') continue;
        if (key === 'builder' && found.service.type !== 'git') continue;
        if (key === 'autoDeploy' && found.service.type !== 'git') continue;
        if (key === 'autoImportEnv' && found.service.type !== 'git') continue;
        // Campos que no aplican a bases de datos: se ignoran sin efecto.
        if (found.service.type === 'database' && ['replicas', 'healthcheckPath'].includes(key)) continue;
        if (found.service.type !== 'database' && ['backupSchedule', 'backupRetention'].includes(key)) continue;
        // Un servicio git siempre escucha en un puerto: null no lo borra.
        if (key === 'port' && value === null && found.service.type === 'git') continue;
        let normalized: unknown = value === null ? undefined : value;
        // 'auto' es la ausencia de elección: se guarda como tal, y así volver a
        // «Automático» no cuenta como cambio frente a un servicio que nunca lo tocó.
        if (key === 'builder' && value === 'auto') normalized = undefined;

        // Las lecturas devuelven los build args tapados (`•••`): un cliente de la
        // API que reenvíe la config tal cual conserva el valor que ya tenía en vez
        // de guardar la marca como si fuera el secreto.
        if (key === 'buildArgs' && value && typeof value === 'object') {
          const old: Record<string, string> = oldCfg.buildArgs ?? {};
          const merged: Record<string, string> = {};
          for (const [k, v] of Object.entries(value as Record<string, string>)) {
            if (v !== VALOR_TAPADO) merged[k] = v;
            else if (old[k] !== undefined) merged[k] = old[k];
          }
          normalized = Object.keys(merged).length > 0 ? merged : undefined;
        }

        // Los volúmenes llegan como rutas; se conserva el nombre del volumen
        // Docker existente para no perder los datos al reordenar/añadir.
        if (key === 'volumes' && Array.isArray(value)) {
          if (found.service.type === 'database') continue; // su volumen es fijo
          const oldVols: { name: string; containerPath: string }[] = oldCfg.volumes ?? [];
          const used = new Set(oldVols.map((v) => v.name));
          normalized = (value as { containerPath: string }[]).map((v) => {
            const existing = oldVols.find((o) => o.containerPath === v.containerPath);
            if (existing) return existing;
            let n = 0;
            let volName: string;
            do {
              volName = `skyway-${found.project.slug}-${found.service.slug}-data${n === 0 ? '' : n + 1}`;
              n += 1;
            } while (used.has(volName));
            used.add(volName);
            return { name: volName, containerPath: v.containerPath };
          });
          if ((normalized as any[]).length === 0) normalized = undefined;
        }

        if ((REDEPLOY_FIELDS as readonly string[]).includes(key)) {
          if (JSON.stringify(oldCfg[key] ?? null) !== JSON.stringify(normalized ?? null)) needsRedeploy = true;
        }
        if (key === 'cpus' || key === 'memoryMb') {
          if ((oldCfg[key] ?? null) !== (value ?? null)) resourcesChanged = true;
          newCfg[key] = value; // conserva null explícito para "sin límite"
          continue;
        }
        newCfg[key] = normalized;
      }
    }

    // Cambiar el puerto a mano cierra la auto-detección: a partir de ahí manda
    // la persona, aunque la imagen exponga otro. Se compara con el valor viejo
    // porque Ajustes reenvía el puerto al guardar CUALQUIER campo, y guardar la
    // rama sin tocar el puerto no es elegirlo.
    if (body.config?.port != null && body.config.port !== oldCfg.port) newCfg.portAuto = undefined;

    // Se rechaza solo cuando el cambio CREA la combinación dominio-sin-puerto:
    // un servicio que ya la tiene guardada —los importados de Railway sin puerto
    // conocido, sobre todo— tiene que poder seguir editándose (CPU, imagen,
    // volúmenes) sin chocar con un error por un campo que no ha tocado.
    if (found.service.type === 'image') {
      const yaEstaba = ((oldCfg.domains ?? []) as string[]).length > 0 && !oldCfg.port;
      const quedaria = ((newCfg.domains ?? []) as string[]).length > 0 && !newCfg.port;
      if (quedaria && !yaEstaba) {
        return reply.code(400).send({
          error:
            'Un servicio con dominio necesita puerto interno: Traefik tiene que saber a qué puerto del contenedor entregar la petición. Indica el puerto en el que escucha el servicio, o quítale el dominio si es un worker sin HTTP.',
        });
      }
    }

    if ((newCfg.replicas ?? 1) > 1 && ((newCfg.volumes?.length ?? 0) > 0 || newCfg.hostPort)) {
      return reply.code(400).send({
        error:
          'Las réplicas requieren un servicio sin volúmenes y sin puerto público: varias copias no pueden compartir el mismo volumen de escritura ni el mismo puerto del host.',
      });
    }

    // Dominios únicos en todo el servidor (y nunca los del panel ni los de
    // Mailway): vale también para proyectos sin cuenta y para el administrador.
    const oldDomainList = (oldCfg.domains ?? []) as string[];
    if (Array.isArray(newCfg.domains)) {
      const conflicto = domainClaimError(newCfg.domains as string[], {
        projectId: found.project.id,
        serviceId: found.service.id,
        isAdmin: currentUser(req)!.role === 'admin',
        current: oldDomainList,
      });
      if (conflicto) return reply.code(409).send({ error: conflicto });
    }

    // Cuota agregada y módulos del workspace (recursos acotados a todos los proyectos en total).
    const workspace = workspaceOfProject(found.project.id);
    if (workspace) {
      const isAdmin = currentUser(req)!.role === 'admin';
      if ((newCfg.replicas ?? 1) > 1 && !moduleAllowedForProject(found.project.id, 'replicas', isAdmin)) {
        return reply.code(403).send({ error: 'El módulo «Escalado horizontal» no está activo en este workspace.' });
      }
      // Solo se bloquea AÑADIR dominios o ACTIVAR backups programados (no conservar los existentes).
      const oldDomains = new Set<string>(oldDomainList);
      if (
        Array.isArray(newCfg.domains) &&
        (newCfg.domains as string[]).some((d) => !oldDomains.has(d)) &&
        !moduleAllowedForProject(found.project.id, 'domains', isAdmin)
      ) {
        return reply.code(403).send({ error: 'El módulo «Dominios y TLS» no está activo en este workspace.' });
      }
      if (newCfg.backupSchedule && !oldCfg.backupSchedule && !moduleAllowedForProject(found.project.id, 'backups', isAdmin)) {
        return reply.code(403).send({ error: 'El módulo «Copias de seguridad» no está activo en este workspace.' });
      }
      // Se rechaza CUALQUIER dimensión que SUBA su reserva por encima de la cuota;
      // se comprueban las tres (no solo la primera): subir la RAM no debe colarse
      // por estar ya la CPU excedida. Mantener o reducir una dimensión ya por encima
      // (p. ej. tras un «live resize» a la baja del admin) sigue permitido.
      const quota = effectiveQuota(workspace, workspacePlan(workspace));
      const alloc = workspaceAllocation(workspace.id);
      const oldRes = serviceReservation(found.service.type, oldCfg);
      const newRes = serviceReservation(found.service.type, newCfg);
      const dims = [
        { field: 'cpu' as const, old: oldRes.cpuCores, neu: newRes.cpuCores, prospective: Math.round((alloc.cpuCores - oldRes.cpuCores + newRes.cpuCores) * 100) / 100, limit: quota.cpuCores, unit: 'núcleos', eps: 0.001 },
        { field: 'memory' as const, old: oldRes.memoryMb, neu: newRes.memoryMb, prospective: alloc.memoryMb - oldRes.memoryMb + newRes.memoryMb, limit: quota.memoryMb, unit: 'MB', eps: 0 },
        { field: 'disk' as const, old: oldRes.diskMb, neu: newRes.diskMb, prospective: alloc.diskMb - oldRes.diskMb + newRes.diskMb, limit: quota.diskMb, unit: 'MB', eps: 0 },
      ];
      for (const dm of dims) {
        if (dm.neu > dm.old + 1e-9 && dm.prospective > dm.limit + dm.eps) {
          return reply.code(409).send({
            error: quotaMessage({ field: dm.field, limit: dm.limit, requested: Math.round(dm.prospective * 100) / 100, unit: dm.unit }),
          });
        }
      }
    }

    const name = body.name ?? found.service.name;
    updateService(id, name, newCfg);

    if (resourcesChanged && !(await dockerAvailable())) {
      // Sin Docker no se pueden aplicar en caliente: que el panel pida redesplegar
      // en vez de dar por aplicados unos límites que el contenedor no tiene.
      needsRedeploy = true;
    } else if (resourcesChanged) {
      try {
        const updated = getService(id)!;
        // Se recorren las réplicas de ANTES y de AHORA: al bajar el número de
        // réplicas en la misma edición, las sobrantes siguen vivas hasta el
        // redespliegue y se quedarían con los límites viejos.
        const total = Math.max(configuredReplicas(found.service), configuredReplicas(updated));
        for (let i = 1; i <= total; i++) {
          try {
            await updateResources(replicaName(found.project, found.service, i), newCfg.cpus, newCfg.memoryMb);
          } catch (err: any) {
            // Una réplica que aún no existe (nunca desplegada, o recién ampliada)
            // no es un fallo: tomará los límites al crearse.
            if (err?.statusCode !== 404) throw err;
          }
        }
      } catch {
        needsRedeploy = true;
      }
    }

    const updated = getService(id)!;
    audit(req, 'service_updated', { type: 'service', id, detail: updated.name });
    // DNS automático solo de los dominios que añade ESTA petición: los que ya
    // tenía el servicio (quizá añadidos por el cliente) nunca se tocan al
    // guardar otra cosa. «Nuevo» respecto a la base de quien edita, no solo a
    // la base de datos: sin `domainsBase` no se puede distinguir un dominio que
    // escribe el administrador de uno que el cliente quitó entre su lectura y
    // este guardado (y que el cliente puede poner y quitar a voluntad), así que
    // no se aplica y la respuesta lo explica.
    const nuevos = body.config?.domains !== undefined ? ((newCfg.domains ?? []) as string[]).filter((d) => !oldDomainList.includes(d)) : [];
    const dns =
      body.domainsBase !== undefined
        ? await dnsAutomaticoAdmin(req, nuevos.filter((d) => !body.domainsBase!.includes(d)), { type: 'service', id }, found.project.id)
        : dnsSinBase(req, nuevos, found.project.id);
    return { service: { ...updated, config: maskBuildArgs(updated.config) }, needsRedeploy, ...(dns ? { dns } : {}) };
  });

  /**
   * Repite el DNS automático en Cloudflare de UN dominio del servicio: tras un
   * error (Cloudflare no respondió a tiempo), un conflicto que el
   * administrador ha resuelto a mano o una zona que faltaba en su token. Solo
   * el administrador y nombrando el dominio, que es la misma decisión que
   * añadirlo: nunca se recorren los dominios del servicio, que pudo poner el
   * cliente. Como siempre, solo crea lo que falta.
   */
  app.post(
    '/api/services/:id/cloudflare-dns',
    { preHandler: [requireAdmin, rateLimit({ max: 30, windowMs: 60_000 })] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const found = loadService(id);
      if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
      const { domain } = z.object({ domain: z.string().trim().toLowerCase().min(1).max(253) }).parse(req.body ?? {});
      const asignados = ((found.service.config as { domains?: string[] }).domains ?? []).map((d) => d.trim().toLowerCase());
      if (!asignados.includes(domain)) {
        return reply.code(404).send({ error: `El dominio ${domain} no está asignado a este servicio. Guarda antes los cambios.` });
      }
      if (!cloudflareConfigurado()) {
        return reply.code(400).send({ error: 'Configura el token de Cloudflare en Ajustes → Cloudflare para crear el registro automáticamente.' });
      }
      const dns = await dnsAutomaticoAdmin(req, [domain], { type: 'service', id }, found.project.id);
      return { dns: dns ?? [] };
    },
  );

  /**
   * Elimina el servicio con TODOS sus datos (contenedores, volúmenes que no
   * comparta con otro servicio, imágenes construidas y copias de seguridad;
   * ver `purge.ts`), con la misma regla que el borrado de proyectos: sin
   * opción para conservarlos, con `?confirm=` (nombre o slug del servicio) y
   * sin borrar nada si Docker no responde.
   */
  app.delete('/api/services/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { confirm } = (req.query ?? {}) as { confirm?: unknown };
    const found = loadService(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
    if (!confirmsDeletion(confirm, found.service)) {
      return reply.code(400).send({
        error:
          typeof confirm === 'string' && confirm.trim()
            ? `El texto de confirmación no coincide con el nombre del servicio («${found.service.name}»). No se ha eliminado nada.`
            : `Para eliminar el servicio, confirma con su nombre («${found.service.name}») en el parámetro confirm. Se eliminarán sus datos (volúmenes y copias de seguridad) sin posibilidad de recuperarlos.`,
      });
    }
    if (deletingServices.has(id)) return reply.code(409).send({ error: 'El servicio ya se está eliminando.' });
    if (!(await dockerAvailable(true))) {
      return reply.code(503).send({
        error: 'Docker no está disponible: no es posible eliminar el servicio sin eliminar sus datos. Vuelve a intentarlo cuando Docker responda. No se ha eliminado nada.',
      });
    }

    deletingServices.add(id);
    try {
      const report = await purgeService(found.project, found.service);
      audit(req, 'service_deleted', {
        type: 'service',
        id,
        detail:
          `${found.service.name} (${found.project.slug}/${found.service.slug}) · ${purgeSummary(report)}` +
          warningsForAudit(report.warnings),
      });
      return {
        ok: true,
        warnings: report.warnings,
        removed: { volumes: report.volumes, images: report.images, backups: report.backups },
      };
    } catch (err) {
      if (!(err instanceof PurgeBlockedError)) throw err;
      return reply.code(409).send({
        error: `No se ha podido retirar todo lo que está en marcha, así que no se han eliminado los datos ni el servicio. Vuelve a intentarlo. ${err.message}`,
        warnings: err.warnings,
      });
    } finally {
      deletingServices.delete(id);
    }
  });

  /**
   * Despliegue manual. Por defecto reutiliza la imagen si el commit y la
   * configuración de compilación no han cambiado (que es lo que se quiere al
   * redesplegar por un cambio de variables); con `force` se recompila desde
   * cero, para cuando lo que cambió está fuera del repo (imagen base, un
   * paquete del registro).
   */
  app.post('/api/services/:id/deploy', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = loadService(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
    const body = z.object({ force: z.boolean().optional() }).parse(req.body ?? {});
    markManualAction(id);
    audit(req, 'service_deploy', {
      type: 'service',
      id,
      detail: `${found.service.name}${body.force ? ' (reconstrucción forzada)' : ''}`,
    });
    const deployment = triggerDeploy(id, 'manual', { forceBuild: body.force });
    reply.code(202);
    return { deployment };
  });

  for (const action of ['start', 'stop', 'restart'] as const) {
    app.post(`/api/services/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const found = loadService(id);
      if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
      if (!assertProjectAccess(req, reply, found.project.id)) return reply;
      if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });
      markManualAction(id);
      const total = configuredReplicas(found.service);
      const lastDep = latestDeployment(found.service.id);
      // Se actúa réplica a réplica: una que aún no existe (réplicas ampliadas en
      // Ajustes sin redesplegar, o un servicio nunca desplegado) no puede
      // convertir en 500 la acción sobre las que sí están.
      let tocadas = 0;
      let fallo: any = null;
      for (let i = 1; i <= total; i++) {
        const name = replicaName(found.project, found.service, i);
        try {
          if (action === 'start') {
            await startContainer(name);
          } else if (action === 'stop') {
            await archiveContainerLogs(name, lastDep?.id);
            await stopContainer(name);
          } else {
            await restartContainer(name);
          }
          tocadas += 1;
        } catch (err: any) {
          if (err?.statusCode === 404) continue;
          fallo = err;
        }
      }
      if (fallo) return reply.code(500).send({ error: fallo?.message || 'Operación fallida' });
      if (tocadas === 0 && action !== 'stop') {
        return reply.code(409).send({ error: 'El contenedor aún no existe: es necesario desplegar el servicio primero' });
      }
      audit(req, `service_${action}`, { type: 'service', id, detail: found.service.name });
      // Una parada pedida desde aquí no es una caída: el panel la pinta en gris.
      setServiceStopped(id, action === 'stop');
      // La acción acaba de cambiar los contenedores: la foto compartida ya no
      // vale y aquí se lee la verdad, no la caché.
      invalidateDockerSnapshot();
      return { ok: true, runtime: await getRuntime(containerName(found.project, found.service)) };
    });
  }

  app.get('/api/services/:id/env', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = loadService(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
    const references = availableReferences(found.service);
    return {
      vars: getEnv(id),
      resolved: resolveServiceEnv(found.service),
      references,
      // Lo que el repositorio necesita y aún no tiene, como propuestas de un clic.
      ...adviseEnv(found.service, references),
    };
  });

  app.put('/api/services/:id/env', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = loadService(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
    const body = z.object({ vars: z.record(z.string()) }).parse(req.body);
    for (const key of Object.keys(body.vars)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return reply.code(400).send({ error: `Nombre de variable inválido: ${key}` });
      }
    }
    setEnv(id, body.vars);
    audit(req, 'service_env_updated', {
      type: 'service',
      id,
      detail: `${found.service.name}: ${Object.keys(body.vars).length} variables`,
    });
    return { ok: true, needsRedeploy: true };
  });

  /**
   * Importación de los `.env` del repositorio sin clonar, leyendo por la API
   * de GitHub. Sin `apply` es una vista previa (con los valores, para que se
   * vea qué entraría); con `apply: true` escribe las variables y guarda el
   * informe en la config del servicio. Cada llamada son varias peticiones a
   * GitHub con la credencial del servicio: de ahí el tope por usuario.
   */
  app.post(
    '/api/services/:id/env/import-repo',
    { preHandler: rateLimit({ max: IMPORTACIONES_POR_MINUTO, windowMs: 60_000 }) },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const found = loadService(id);
      if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
      if (!assertProjectAccess(req, reply, found.project.id)) return reply;
      const body = z.object({ apply: z.boolean().optional().default(false) }).parse(req.body ?? {});

      const cfg = found.service.config as GitConfig;
      const slug = found.service.type === 'git' ? parseGithubSlug(cfg.repoUrl) : null;
      if (!slug) {
        return reply.code(400).send({ error: 'Solo es posible importar variables de servicios desplegados desde un repositorio de GitHub' });
      }

      let files: EnvFileSource[];
      try {
        const token = await resolveGitToken(found.project, cfg);
        files = await fetchRepoEnvFiles(token, slug, cfg.branch || 'main', cfg.rootDir);
      } catch (err: any) {
        if (err instanceof GithubError) return reply.code(502).send({ error: err.message });
        throw err;
      }

      const plan = planEnvImport(files, envImportContextFor(found.service));
      // Sin ficheros no hay nada que aplicar ni que recordar: no se persiste un informe vacío.
      const apply = body.apply && files.length > 0;
      const report = finalizeEnvImport(found.service, plan, { source: 'manual', apply });
      const n = report.imported.length;
      const m = report.pending.length;
      const pendientes = m > 0 ? `; ${m === 1 ? '1 pendiente' : `${m} pendientes`} de valor` : '';

      if (files.length === 0) {
        const donde = cfg.rootDir && cfg.rootDir !== '.' ? `en «${cfg.rootDir}» ni en la raíz` : 'en la raíz';
        return {
          report,
          message: `No se ha encontrado ningún fichero .env (.env.example, .env…) ${donde} del repositorio.`,
        };
      }
      if (!body.apply) {
        return {
          report,
          message:
            n === 0 && m === 0
              ? 'No hay variables nuevas que importar.'
              : `Se ${n === 1 ? 'importaría 1 variable' : `importarían ${n} variables`}${pendientes}.`,
        };
      }
      audit(req, 'service_env_imported', {
        type: 'service',
        id,
        detail: `${found.service.name}: ${n} importadas, ${m} pendientes`,
      });
      return {
        report,
        needsRedeploy: true,
        message:
          n === 0
            ? `No había variables nuevas que importar${pendientes}.`
            : `${n === 1 ? 'Se ha importado 1 variable' : `Se han importado ${n} variables`}${pendientes}. Es necesario volver a desplegar el servicio para que el contenedor las reciba.`,
      };
    },
  );
}

/**
 * Deja constancia de lo que ha hecho el plan: nombres de variables y recursos
 * creados, nunca valores (hay secretos generados y credenciales).
 */
function auditPlan(req: FastifyRequest, service: ServiceRow, result: ApplyResult): void {
  if (result.applied.length === 0 && result.created.length === 0 && result.pending.length === 0) return;
  const partes = [
    result.applied.length ? `aplicadas: ${result.applied.join(', ')}` : '',
    result.created.length ? `creados: ${result.created.join(', ')}` : '',
    result.pending.length ? `pendientes de aprobar: ${result.pending.join(', ')}` : '',
    result.kept.length ? `sin tocar (puestas a mano): ${result.kept.join(', ')}` : '',
  ].filter(Boolean);
  audit(req, 'service_integrations_applied', { type: 'service', id: service.id, detail: `${service.name} · ${partes.join(' · ')}` });
}
