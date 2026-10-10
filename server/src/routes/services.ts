import { domainToASCII } from 'url';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertProjectAccess, currentUser, requireAdmin, requireAuth, requireSession } from '../auth';
import { audit } from '../audit';
import { cloudflareConfigurado } from '../cloudflareconfig';
import { cambiarProxyCloudflare, dnsAutomaticoAdmin, dnsSinBase, planReemplazo, reemplazarRegistros, verificarEnCloudflare } from '../cloudflaredns';
import { dbConsoleEngine } from '../dbconsole';
import { domainClaimError, dominiosConPareja } from '../domainguard';
import { limpiarSinPareja, ordenarDominios } from '../dominioprincipal';
import { markManualAction } from '../monitor';
import {
  bumpConfigRev,
  countWorkspaceServices,
  createService,
  getEnv,
  getGithubConnector,
  getGithubInstallation,
  getProject,
  getService,
  getSetting,
  latestDeployment,
  listServices,
  patchEnv,
  servicesWithPendingChanges,
  setEnv,
  setServiceStopped,
  uniqueServiceSlug,
  updateService,
} from '../db';
import { autoDeployStatus } from '../autodeploy';
import { FULL_SHA_RE } from '../deploy/builder';
import { githubAppConfigured } from '../github/app';
import { panelBaseUrl } from '../paneldomain';
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
import { archiveContainerLogs, despliegueEnCurso, limpiarRestosEnCola } from '../deploy/deployer';
import {
  comandoParada,
  estrategiaDespliegue,
  GRACIA_PARADA_MAXIMA,
  GRACIA_PARADA_MINIMA_BASE_DE_DATOS,
  graciaParada,
  llamadoPorOtros,
} from '../deploy/estrategia';
import { EnvFileSource, envImportContextFor, fetchRepoEnvFiles, finalizeEnvImport, planEnvImport } from '../deploy/envimport';
import { GithubError, parseGithubSlug } from '../github/client';
import { resolveGitToken } from '../github/resolve';
import { rateLimit } from '../ratelimit';
import { dockerAvailable } from '../docker/client';
import { checkDomain } from '../domains';
import {
  configuredReplicas,
  containerName,
  getRuntime,
  listServiceContainers,
  pararConGracia,
  replicaName,
  startContainer,
  updateResources,
} from '../docker/containers';
import { dockerSnapshot, invalidateDockerSnapshot, runtimeIn, Snapshot } from '../docker/sampler';
import { triggerDeploy } from '../deploy/deployer';
import { getTemplate, templateList } from '../templates';
import { applyPlan, applyPlanFromRepo, ApplyResult, PlanChangedError, planWithMail } from '../integrations';
import { adviseEnv } from '../needs';
import { availableReferences, resolveServiceEnv } from '../variables';
import { DatabaseConfig, GitConfig, ImageConfig, ProjectRow, ServiceConfig, ServiceRow } from '../types';
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

/**
 * Lo que escribe una persona como dominio, en la forma que va a Traefik y al
 * DNS: sin esquema, ruta ni puerto (se pega a menudo la URL de la web), sin el
 * punto final y en ASCII («panadería.es» → «xn--panadera-i2a.es», como hace
 * Mailway). Devuelve '' si no es un nombre de host; la validación de
 * `HOSTNAME` viene después, sobre el resultado.
 */
export function normalizarDominio(raw: string): string {
  let host = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return '';
    }
  } else {
    host = host.split(/[/?#]/)[0].replace(/:\d+$/, '');
  }
  host = host.replace(/\.$/, '');
  // domainToASCII devuelve '' para lo que no puede ser un dominio.
  return host ? domainToASCII(host) : '';
}

export const domainSchema = z
  .string()
  .trim()
  .max(2000)
  .transform(normalizarDominio)
  .refine(
    (d) => HOSTNAME.test(d),
    'Dominio no válido: escribe solo el nombre, por ejemplo app.midominio.com (se admiten acentos y «ñ»).',
  );

/**
 * Dominios cuya pareja con o sin www se descarta (`dominiosSinPareja`). Se
 * guarda solo la parte que está en `domains` y a la que le falta la pareja
 * (`limpiarSinPareja`), así que nunca crece más que la lista de dominios; el
 * tope es para la petición.
 */
const sinParejaSchema = z.array(domainSchema).max(200);

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
  dominiosSinPareja: sinParejaSchema.optional(),
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
  dominiosSinPareja: sinParejaSchema.optional(),
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
      dominiosSinPareja: sinParejaSchema.optional(),
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
      // Despliegue y parada (`deploy/estrategia.ts`). 'auto' es la ausencia de
      // elección, igual que en el constructor; null deja la gracia por defecto.
      deployStrategy: z.enum(['overlap', 'recreate', 'auto']).optional(),
      // Un número, o sus cifras como texto; vacío o null la deja sin fijar. Sin
      // `z.coerce`: convertía "" en 0 (SIGKILL inmediato en cada parada) y
      // `true` en 1.
      stopGraceSeconds: z
        .preprocess(
          (v) => (v === '' ? null : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v),
          z
            .number({ invalid_type_error: 'La gracia de parada es un número entero de segundos, de 0 a 600.' })
            .int('La gracia de parada es un número entero de segundos, de 0 a 600.')
            .min(0, 'La gracia de parada es un número entero de segundos, de 0 a 600.')
            .max(GRACIA_PARADA_MAXIMA, 'La gracia de parada admite hasta 600 segundos.')
            .nullable(),
        )
        .optional(),
      stopCommand: z.string().trim().max(1000, 'El comando al parar admite hasta 1000 caracteres.').nullable().optional(),
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

/** Nombre de variable de entorno admitido. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Cambios de variables de quien edita (`set` y `unset`), calculados contra lo
 * que cargó. Sustituye al reemplazo de la lista entera (PUT), que borraba lo que
 * otros habían escrito entretanto (ver `patchEnv`).
 */
export const envPatchSchema = z.object({
  set: z.record(z.string()).default({}),
  unset: z.array(z.string().max(200)).max(1000).default([]),
});

/** Primera clave que no es un nombre de variable válido, o null. */
export function invalidEnvKey(keys: Iterable<string>): string | null {
  for (const key of keys) if (!ENV_KEY_RE.test(key)) return key;
  return null;
}

/**
 * ¿Recibe este servicio los push por el webhook de la GitHub App? Lo hace si
 * clona con una instalación de la App que sigue conectada y activa: la App
 * recibe los eventos de los repos a los que tiene acceso. Entonces el webhook
 * manual sobra (y con los dos cada push desplegaba dos veces).
 */
function coveredByGithubApp(service: ServiceRow): boolean {
  if (service.type !== 'git' || !githubAppConfigured()) return false;
  const rowId = (service.config as GitConfig).githubInstallationId;
  const row = rowId ? getGithubInstallation(rowId) : undefined;
  return !!row && row.suspended !== 1;
}

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
    // Los dominios que pide ESTA alta, con la pareja con o sin www de cada
    // uno: los únicos que pasan por el DNS automático.
    let dominiosPedidos: string[] = [];
    let sinPareja: string[] = [];
    if (base.type !== 'database') {
      // Antes de crear nada: un dominio de otro (o del panel) no se reparte.
      const pedidos = z
        .object({ domains: z.array(domainSchema).default([]), dominiosSinPareja: sinParejaSchema.optional() })
        .parse(req.body);
      const claim = { projectId, serviceId: null, isAdmin };
      const conflicto = domainClaimError(pedidos.domains, claim);
      if (conflicto) return reply.code(409).send({ error: conflicto });
      // La pareja que no se puede asignar (la usa otro servicio) se omite sin
      // error: el alta del dominio pedido no depende de ella.
      const conPareja = dominiosConPareja(pedidos.domains, { claim, sinPareja: pedidos.dominiosSinPareja });
      dominiosPedidos = conPareja.domains;
      sinPareja = conPareja.sinPareja;
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
        // Con la pareja con o sin www y en el orden del dominio principal (www
        // primero), el mismo con el que se calcula PUBLIC_URL: así la lista
        // guardada, el panel y la variable dicen lo mismo.
        domains: dominiosPedidos,
        dominiosSinPareja: sinPareja.length > 0 ? sinPareja : undefined,
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
        domains: dominiosPedidos,
        dominiosSinPareja: sinPareja.length > 0 ? sinPareja : undefined,
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
      if (result.applied.length > 0) bumpConfigRev([id]);
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
    const isGit = found.service.type === 'git';
    return {
      // El secreto del webhook sí va (Ajustes lo copia); los build args, tapados.
      service: { ...found.service, config: maskBuildArgs(found.service.config) },
      project: found.project,
      runtime,
      latestDeployment: latestDeployment(id) ?? null,
      // Cambios guardados que su último despliegue correcto no lleva: lo guarda
      // el servidor, así que el aviso sobrevive a cerrar el panel o recargar.
      pendingChanges: servicesWithPendingChanges([found.service]).has(id),
      // Sondeo del auto-deploy: última comprobación y su error, si lo hubo.
      autoDeploy: isGit && (found.service.config as GitConfig).autoDeploy !== false ? autoDeployStatus(id) : null,
      // Webhook manual: con el dominio del panel (no el del túnel SSH) y si ya
      // lo cubre la GitHub App, para no configurar los dos.
      webhook: isGit
        ? { url: `${panelBaseUrl(req)}/api/webhooks/github/${id}`, coveredByApp: coveredByGithubApp(found.service) }
        : null,
      // Quién tiene consola lo decide el servidor: el panel no puede saber si
      // una imagen cualquiera es una base de datos sin repetir aquí la tabla de
      // imágenes conocidas, y dos copias de esa tabla se separan a la primera.
      dbConsole: dbConsoleEngine(found.service),
      // Cómo se despliega y se para: la estrategia efectiva y su motivo, para
      // que Ajustes enseñe qué hace «Automático» con este servicio ahora.
      deploy: infoDespliegue(found.service),
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

    const isAdmin = currentUser(req)!.role === 'admin';
    // Renuncias a la pareja con o sin www: las que manda la petición o, si no
    // manda ninguna, las guardadas. Se aplican al completar los dominios y se
    // guardan limpias tras el bucle.
    const sinParejaPedida = (body.config?.dominiosSinPareja ?? oldCfg.dominiosSinPareja ?? []) as string[];

    if (body.config) {
      for (const [key, value] of Object.entries(body.config)) {
        if (value === undefined) continue;
        if (key === 'dominiosSinPareja') continue;
        // El conector y el auto-deploy solo tienen sentido en servicios de repositorio.
        if (key === 'connectorId' && found.service.type !== 'git') continue;
        if (key === 'githubInstallationId' && found.service.type !== 'git') continue;
        if (key === 'buildCmd' && found.service.type !== 'git') continue;
        if (key === 'builder' && found.service.type !== 'git') continue;
        if (key === 'autoDeploy' && found.service.type !== 'git') continue;
        if (key === 'autoImportEnv' && found.service.type !== 'git') continue;
        // Campos que no aplican a bases de datos: se ignoran sin efecto.
        // Ni la estrategia ni el comando al parar: una base de datos se despliega
        // siempre con una sola copia y su parada la gobierna el motor.
        if (found.service.type === 'database' && ['replicas', 'healthcheckPath', 'deployStrategy', 'stopCommand'].includes(key)) continue;
        if (found.service.type !== 'database' && ['backupSchedule', 'backupRetention'].includes(key)) continue;
        // Un servicio git siempre escucha en un puerto: null no lo borra.
        if (key === 'port' && value === null && found.service.type === 'git') continue;
        let normalized: unknown = value === null ? undefined : value;
        // 'auto' es la ausencia de elección: se guarda como tal, y así volver a
        // «Automático» no cuenta como cambio frente a un servicio que nunca lo tocó.
        if (key === 'builder' && value === 'auto') normalized = undefined;
        if (key === 'deployStrategy' && value === 'auto') normalized = undefined;
        if (key === 'stopCommand' && value === '') normalized = undefined;
        // Una base de datos nunca se para con menos de 10 s (`graciaParada` lo
        // aplica igualmente): se dice aquí en vez de guardar lo que no se usará.
        if (
          key === 'stopGraceSeconds' &&
          found.service.type === 'database' &&
          typeof value === 'number' &&
          value < GRACIA_PARADA_MINIMA_BASE_DE_DATOS
        ) {
          return reply
            .code(400)
            .send({ error: `La gracia de parada de una base de datos va de ${GRACIA_PARADA_MINIMA_BASE_DE_DATOS} a ${GRACIA_PARADA_MAXIMA} segundos.` });
        }

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

        // Los dominios se guardan en el orden de la regla del dominio principal
        // (www primero, el subdominio generado al final), venga como venga la
        // lista. Se compara con la lista vieja ordenada igual: un servicio
        // guardado con el orden antiguo ya despliega con el principal correcto
        // (el despliegue aplica la misma regla), y ordenar no es un cambio que
        // obligue a volver a desplegar.
        //
        // Cada dominio NUEVO llega con su pareja con o sin www (salvo renuncia
        // expresa o que la pareja sea de otro servicio). Solo los nuevos: un
        // servicio antiguo al que le falta la pareja no la recibe al guardar
        // otra cosa o al reordenar, que seguiría sin desplegar ni llamar a
        // Cloudflare; el panel indica que falta y la añade con un clic.
        let anterior: unknown = oldCfg[key];
        if (key === 'domains' && Array.isArray(value)) {
          const raiz = getSetting('rootDomain');
          const actuales = (oldCfg.domains ?? []) as string[];
          normalized = dominiosConPareja(value as string[], {
            claim: { projectId: found.project.id, serviceId: found.service.id, isAdmin, current: actuales },
            sinPareja: sinParejaPedida,
            nuevos: (value as string[]).filter((d) => !actuales.includes(d)),
          }).domains;
          anterior = ordenarDominios(actuales, raiz);
        }

        if ((REDEPLOY_FIELDS as readonly string[]).includes(key)) {
          if (JSON.stringify(anterior ?? null) !== JSON.stringify(normalized ?? null)) needsRedeploy = true;
        }
        if (key === 'cpus' || key === 'memoryMb') {
          if ((oldCfg[key] ?? null) !== (value ?? null)) resourcesChanged = true;
          newCfg[key] = value; // conserva null explícito para "sin límite"
          continue;
        }
        newCfg[key] = normalized;
      }
    }

    if (body.config?.domains !== undefined || body.config?.dominiosSinPareja !== undefined) {
      const sinPareja = limpiarSinPareja(sinParejaPedida, (newCfg.domains ?? []) as string[], getSetting('rootDomain'));
      newCfg.dominiosSinPareja = sinPareja.length > 0 ? sinPareja : undefined;
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
        isAdmin,
        current: oldDomainList,
      });
      if (conflicto) return reply.code(409).send({ error: conflicto });
    }

    // Cuota agregada y módulos del workspace (recursos acotados a todos los proyectos en total).
    const workspace = workspaceOfProject(found.project.id);
    if (workspace) {
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

    // El comando al parar se ejecuta dentro del contenedor en marcha en cada
    // parada (también al pulsar Reiniciar): equivale a la terminal y lleva sus
    // mismas protecciones. Solo al guardar uno nuevo o distinto: conservar el
    // que hay, o quitarlo, no abre nada.
    const comandoNuevo = typeof newCfg.stopCommand === 'string' ? newCfg.stopCommand : undefined;
    const comandoCambia = (comandoNuevo ?? null) !== (typeof oldCfg.stopCommand === 'string' ? oldCfg.stopCommand : null);
    if (comandoNuevo !== undefined && comandoCambia) {
      const ws = workspaceOfProject(found.project.id);
      if (ws && !isAdmin && !isWorkspaceActive(ws)) {
        return reply.code(403).send({ error: 'El workspace está suspendido: las operaciones están detenidas hasta reactivarlo.' });
      }
      if (!moduleAllowedForProject(found.project.id, 'exec', isAdmin)) {
        return reply.code(403).send({ error: 'El comando al parar requiere el módulo «Terminal de comandos», que no está activo en este workspace.' });
      }
    }

    // Los servicios que usan la dirección de este (`${{web.PUBLIC_URL}}`,
    // `${{api.INTERNAL_URL}}`) la llevan escrita en su entorno desde su último
    // despliegue: si cambian los dominios o el puerto, quedan con «cambios sin
    // desplegar» para que se vea que también hay que volver a desplegarlos.
    // Foto de su entorno resuelto antes de guardar; se compara después.
    const fotoHermanos =
      body.config?.domains !== undefined || body.config?.port !== undefined ? entornosDeHermanos(found.service) : null;

    const name = body.name ?? found.service.name;
    updateService(id, name, newCfg);
    if (fotoHermanos) {
      const despues = entornosDeHermanos(found.service);
      const cambian = [...fotoHermanos].filter(([sid, antes]) => despues.has(sid) && despues.get(sid) !== antes).map(([sid]) => sid);
      if (cambian.length > 0) bumpConfigRev(cambian);
    }

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

    // Un cambio que solo surte efecto al redesplegar queda como «sin desplegar».
    if (needsRedeploy) bumpConfigRev([id]);
    const updated = getService(id)!;
    audit(req, 'service_updated', { type: 'service', id, detail: updated.name });
    if (comandoCambia) {
      // Como la terminal (`service_exec`): los primeros 120 caracteres.
      audit(req, 'service_stop_command', {
        type: 'service',
        id,
        detail: `${updated.name}: ${comandoNuevo !== undefined ? comandoNuevo.slice(0, 120) : 'sin comando al parar'}`,
      });
    }
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
   * «Activar proxy en Cloudflare» (`proxied: true`) o «Desactivar proxy en
   * Cloudflare» (sin `proxied` o `false`, como antes) de UN dominio del
   * servicio: cambia el proxy de sus registros A que apuntan a este servidor y
   * vuelve a comprobar el DNS (con la API de Cloudflare). Solo el
   * administrador, con sesión de navegador y nombrando un dominio que el
   * servicio ya tiene guardado: son las únicas modificaciones de un registro
   * existente y siempre son un clic expreso (`cambiarProxyCloudflare`).
   */
  app.post(
    '/api/services/:id/cloudflare-proxy',
    { preHandler: [requireAdmin, requireSession, rateLimit({ max: 10, windowMs: 60_000 })] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const found = loadService(id);
      if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
      const { domain, proxied } = z.object({ domain: domainSchema, proxied: z.boolean().optional() }).parse(req.body ?? {});
      const asignados = ((found.service.config as { domains?: string[] }).domains ?? []).map((d) => d.trim().toLowerCase());
      if (!asignados.includes(domain)) {
        return reply.code(404).send({ error: `El dominio ${domain} no está asignado a este servicio. Guarda antes los cambios.` });
      }
      const activar = proxied === true;
      const result = await cambiarProxyCloudflare(domain, activar);
      audit(req, activar ? 'cloudflare_proxy_enabled' : 'cloudflare_proxy_disabled', {
        type: 'service',
        id,
        detail: `${domain}: ${result.changed === 0 ? `ya estaba ${activar ? 'activado' : 'desactivado'}` : `${result.changed} registro(s)`}`,
      });
      return { result, check: await checkDomain(domain, { verificar: verificarEnCloudflare }) };
    },
  );

  /**
   * Reemplazo en Cloudflare del registro de la web del hosting anterior
   * (traer una web a Skyway). Solo el administrador y en dos pasos: la
   * revisión (GET, no toca nada) enseña los A/AAAA/CNAME exactos de ese
   * nombre que se sustituirían, y la confirmación (POST, con sesión de
   * navegador) los repite: si la zona ha cambiado entre medias, no se toca
   * nada. Nunca se reemplazan los nombres de la plataforma ni los reservados
   * a otro proyecto (`planReemplazo`). Lo borrado se guarda para restaurarlo
   * en Ajustes → Cloudflare.
   */
  const dominioDelServicio = (service: ServiceRow, domain: string): boolean =>
    ((service.config as { domains?: string[] }).domains ?? []).map((d) => d.trim().toLowerCase()).includes(domain);

  app.get(
    '/api/services/:id/cloudflare-dns/replace',
    { preHandler: [requireAdmin, rateLimit({ max: 30, windowMs: 60_000 })] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const found = loadService(id);
      if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
      const { domain } = z.object({ domain: z.string().trim().toLowerCase().min(1).max(253) }).parse(req.query ?? {});
      if (!dominioDelServicio(found.service, domain)) {
        return reply.code(404).send({ error: `El dominio ${domain} no está asignado a este servicio. Guarda antes los cambios.` });
      }
      return { plan: await planReemplazo(domain, found.project.id) };
    },
  );

  app.post(
    '/api/services/:id/cloudflare-dns/replace',
    { preHandler: [requireAdmin, requireSession, rateLimit({ max: 10, windowMs: 60_000 })] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const found = loadService(id);
      if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
      const body = z
        .object({
          domain: z.string().trim().toLowerCase().min(1).max(253),
          // Los registros que el administrador ha revisado y confirma sustituir.
          records: z
            .array(z.object({ id: z.string().min(1).max(100), type: z.enum(['A', 'AAAA', 'CNAME']), content: z.string().max(500) }))
            .min(1, 'Indica los registros que confirmas sustituir.')
            .max(20),
        })
        .parse(req.body ?? {});
      if (!dominioDelServicio(found.service, body.domain)) {
        return reply.code(404).send({ error: `El dominio ${body.domain} no está asignado a este servicio. Guarda antes los cambios.` });
      }
      const dns = await reemplazarRegistros(
        body.domain,
        found.project.id,
        body.records,
        (action, target) => audit(req, action, target),
        { type: 'service', id },
      );
      return { dns: [dns] };
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
    const body = z
      .object({
        force: z.boolean().optional(),
        // Reconstruir un commit concreto (una versión cuya imagen ya se purgó).
        commit: z.string().trim().toLowerCase().regex(FULL_SHA_RE, 'El commit debe ser un SHA completo de 40 caracteres').optional(),
      })
      .parse(req.body ?? {});
    if (body.commit && found.service.type !== 'git') {
      return reply.code(400).send({ error: 'Solo los servicios de repositorio pueden reconstruir un commit concreto.', code: 'not_git' });
    }
    markManualAction(id);
    audit(req, 'service_deploy', {
      type: 'service',
      id,
      detail: `${found.service.name}${body.commit ? ` (reconstrucción del commit ${body.commit.slice(0, 7)})` : body.force ? ' (reconstrucción forzada)' : ''}`,
    });
    const deployment = triggerDeploy(id, 'manual', { forceBuild: body.force, targetCommit: body.commit });
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
      // El monitor solo perdona una caída durante 3 min tras una acción
      // manual, y una parada con una gracia larga (hasta 600 s, más el comando
      // al parar) puede terminar fuera de esa ventana: se renueva mientras dura
      // la acción y una vez más al acabar.
      markManualAction(id);
      const latido = setInterval(() => markManualAction(id), 60_000);
      try {
        return await accionSobreCopias(req, reply, found.project, found.service, action);
      } finally {
        clearInterval(latido);
        markManualAction(id);
      }
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
    const mala = invalidEnvKey(Object.keys(body.vars));
    if (mala !== null) return reply.code(400).send({ error: `Nombre de variable inválido: ${mala}`, code: 'invalid_key' });
    setEnv(id, body.vars);
    bumpConfigRev([id]);
    audit(req, 'service_env_updated', {
      type: 'service',
      id,
      detail: `${found.service.name}: ${Object.keys(body.vars).length} variables`,
    });
    return { ok: true, needsRedeploy: true };
  });

  /**
   * Guardado de la pestaña Variables: solo los cambios de quien edita, sobre
   * las variables ACTUALES. El PUT reemplazaba la lista entera y borraba en
   * silencio lo que otro había escrito mientras se editaba: lo que importa el
   * primer despliegue, los secretos que genera el manifiesto (que el siguiente
   * despliegue regeneraría con otro valor) o las credenciales SMTP de Correo.
   */
  app.patch('/api/services/:id/env', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = loadService(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
    const body = envPatchSchema.parse(req.body ?? {});
    const mala = invalidEnvKey([...Object.keys(body.set), ...body.unset]);
    if (mala !== null) return reply.code(400).send({ error: `Nombre de variable inválido: ${mala}`, code: 'invalid_key' });
    const cambiadas = Object.keys(body.set).length;
    const quitadas = body.unset.filter((k) => !Object.hasOwn(body.set, k)).length;
    if (cambiadas + quitadas > 0) {
      patchEnv(id, body.set, body.unset);
      bumpConfigRev([id]);
      audit(req, 'service_env_updated', {
        type: 'service',
        id,
        detail: `${found.service.name}: ${cambiadas} definidas, ${quitadas} eliminadas`,
      });
    }
    return { ok: true, needsRedeploy: cambiadas + quitadas > 0, vars: getEnv(id) };
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
      if (n > 0) bumpConfigRev([id]);
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

/**
 * Iniciar, Detener o Reiniciar todas las copias del servicio.
 *
 * Antes, si el servicio no tiene un despliegue en cola o en marcha, se tratan
 * los restos de un intercambio cortado («--next», «--prev»): sin despliegue no
 * son de nadie, y Detener tiene que alcanzarlos (un bot con una «--next» viva
 * seguiría contestando). Va por la cola del servicio (`limpiarRestosEnCola`)
 * para no coincidir con la limpieza que encola el arranque de Skyway. Al
 * detener, una «--prev» que vuelve a su nombre no se arranca: se va a parar.
 *
 * Detener y Reiniciar paran todas las copias a la vez, con parada limpia, y
 * responden `forced` con las que no terminaron con SIGTERM a tiempo. Reiniciar
 * es parar con gracia y volver a arrancar el MISMO contenedor (conserva su
 * identidad), como `docker restart`, pero con el comando al parar y sabiendo
 * si hubo SIGKILL. Al registro del servidor solo va el resultado del comando,
 * nunca lo que escribe: ese registro no es del proyecto.
 */
async function accionSobreCopias(
  req: FastifyRequest,
  reply: FastifyReply,
  project: ProjectRow,
  service: ServiceRow,
  action: 'start' | 'stop' | 'restart',
) {
  const id = service.id;
  const registro = (l: string) => req.log.info(`«${service.name}»: ${l}`);
  if (!despliegueEnCurso(id)) {
    try {
      await limpiarRestosEnCola(service, registro, { sinArrancar: action === 'stop' });
    } catch (err) {
      req.log.warn({ err }, `No se pudieron retirar los restos de un intercambio de «${service.name}»`);
    }
  }
  let env: Record<string, string> = {};
  try {
    env = resolveServiceEnv(service);
  } catch {
    /* sin entorno resuelto, la gracia del servicio o la de por defecto */
  }
  const graciaSegundos = graciaParada(service, env).segundos;
  const comando = comandoParada(service);
  const lastDep = latestDeployment(id);
  const nombres = await copiasDelServicio(project, service, action === 'stop');
  // Copia a copia: una que aún no existe (réplicas ampliadas en Ajustes sin
  // redesplegar, o un servicio nunca desplegado) no puede convertir en 500 la
  // acción sobre las que sí están.
  let tocadas = 0;
  let fallo: any = null;
  /** Copias que no terminaron con SIGTERM a tiempo y se detuvieron con SIGKILL. */
  const forced: string[] = [];
  if (action === 'start') {
    for (const name of nombres) {
      try {
        await startContainer(name);
        tocadas += 1;
      } catch (err: any) {
        if (err?.statusCode === 404) continue;
        fallo = err;
      }
    }
  } else {
    // Todas a la vez: en serie, N réplicas con su gracia eran N veces la espera.
    const resultados = await Promise.allSettled(
      nombres.map(async (n) => {
        const r = await pararConGracia(n, { graciaSegundos, comando, log: registro, salidaComando: false });
        if (r.existia && action === 'restart') await startContainer(n);
        return r;
      }),
    );
    for (const [k, r] of resultados.entries()) {
      if (r.status === 'rejected') {
        if (r.reason?.statusCode !== 404) fallo = r.reason;
        continue;
      }
      if (!r.value.existia) continue;
      tocadas += 1;
      if (r.value.forzada) forced.push(nombres[k]);
      // Después de parar: el registro guarda también lo que la copia escribió
      // al recibir SIGTERM (su cierre, o por qué no lo hubo). Al reiniciar, el
      // contenedor es el mismo y conserva su registro.
      if (action === 'stop') await archiveContainerLogs(nombres[k], lastDep?.id);
    }
  }
  if (fallo) return reply.code(500).send({ error: fallo?.message || 'Operación fallida' });
  if (tocadas === 0 && action !== 'stop') {
    return reply.code(409).send({ error: 'El contenedor aún no existe: es necesario desplegar el servicio primero' });
  }
  audit(req, `service_${action}`, { type: 'service', id, detail: service.name });
  // Una parada pedida desde aquí no es una caída: el panel la pinta en gris.
  setServiceStopped(id, action === 'stop');
  // La acción acaba de cambiar los contenedores: la foto compartida ya no vale
  // y aquí se lee la verdad, no la caché.
  invalidateDockerSnapshot();
  return {
    ok: true,
    runtime: await getRuntime(containerName(project, service)),
    ...(action !== 'start' ? { forced } : {}),
  };
}

/**
 * Copias del servicio sobre las que actúan Iniciar, Detener y Reiniciar: las
 * réplicas configuradas y, al detener, también las que siguen en marcha con un
 * índice mayor (réplicas reducidas en Ajustes sin volver a desplegar): Detener
 * no puede dejar ninguna copia viva.
 */
async function copiasDelServicio(project: ProjectRow, service: ServiceRow, conSobrantes: boolean): Promise<string[]> {
  const nombres = Array.from({ length: configuredReplicas(service) }, (_, i) => replicaName(project, service, i + 1));
  if (!conSobrantes) return nombres;
  const base = containerName(project, service);
  const patron = new RegExp(`^${escaparRegExp(base)}-r\\d+$`);
  try {
    for (const c of await listServiceContainers(service.id)) {
      if (patron.test(c.name) && !nombres.includes(c.name)) nombres.push(c.name);
    }
  } catch {
    /* sin listado, al menos las configuradas */
  }
  return nombres;
}

function escaparRegExp(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Entorno resuelto de los DEMÁS servicios (no bases de datos) del proyecto, para compararlo. */
function entornosDeHermanos(service: ServiceRow): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of listServices(service.project_id)) {
    if (s.id === service.id || s.type === 'database') continue;
    out.set(s.id, JSON.stringify(resolveServiceEnv(s)));
  }
  return out;
}

/**
 * Cómo se despliega y se para el servicio (`ServiceDeployInfo` de la web): la
 * estrategia efectiva y su motivo, si otro servicio lo llama por la red
 * interna (con eso Ajustes calcula el «ahora» de «Automático» mientras se
 * edita) y la gracia de parada con su origen.
 */
function infoDespliegue(service: ServiceRow) {
  const llamado = service.type === 'database' ? false : llamadoPorOtros(service);
  const e = estrategiaDespliegue(service, llamado);
  let env: Record<string, string> = {};
  try {
    env = resolveServiceEnv(service);
  } catch {
    /* sin entorno resuelto, la gracia del servicio o la de por defecto */
  }
  const g = graciaParada(service, env);
  return {
    strategy: e.estrategia,
    reason: e.motivo,
    automatic: e.automatica,
    calledByOthers: llamado,
    stopGraceSeconds: g.segundos,
    stopGraceSource: g.origen,
  };
}
