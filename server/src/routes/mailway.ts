import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertProjectAccess, assertProjectManage, currentUser, requireAdmin, requireAuth, requireSession } from '../auth';
import { audit } from '../audit';
import {
  deleteMailwayLink,
  getEnv,
  getMailwayLink,
  getMailwayLinkByClient,
  getProject,
  getService,
  getSetting,
  insertMailwayLink,
  listMailwayLinks,
  setEnv,
  setSetting,
} from '../db';
import { triggerDeploy } from '../deploy/deployer';
import {
  MAILWAY_SETTING,
  MailwayApiKeyInfo,
  MailwayAppPasswordInfo,
  MailwayConfig,
  MailwayDomain,
  MailwayError,
  MailwayMailbox,
  MailwayPlan,
  MailwaySummary,
  applyCloudflare,
  cachedInfo,
  createApiKey,
  createAppPassword,
  createDomain,
  createMailbox,
  createSetupLink,
  deleteMailbox,
  ensureClient,
  getClientByRef,
  getCloudflarePlan,
  getDomainDns,
  getInfo,
  getSummary,
  internalPanelUrl,
  linkClient,
  listClients,
  listPlans,
  mailwayConfigured,
  normalizeBaseUrl,
  previousClientKey,
  projectExternalRef,
  publicBaseConflict,
  publicPanelUrl,
  readMailwayConfig,
  releaseProjectClient,
  resetMailwayCaches,
  resetMailboxPassword,
  revokeApiKey,
  revokeAppPassword,
  safeHttpUrl,
  verifyDomain,
} from '../mailway';
import {
  forgetMailwayTraefik,
  mailwayTraefikConfig,
  mailwayTraefikStatus,
  resetMailwayTraefikState,
  stableStringify,
} from '../mailwaytraefik';
import { markManualAction } from '../monitor';
import { isWorkspaceActive, moduleAllowedForProject, workspaceOfProject } from '../quota';
import { rateLimit } from '../ratelimit';
import { MailwayLinkRow, ProjectRow, ServiceRow, UserRow } from '../types';
import { domainSchema } from './services';

const MODULO_INACTIVO = 'El módulo «Correo» no está activo en este workspace.';
const NO_CONFIGURADO =
  'La integración con Mailway no está configurada. Un administrador puede configurarla en Ajustes → Correo (Mailway).';
const NO_VINCULADO = 'El correo no está activado en este proyecto.';
const CUENTA_SUSPENDIDA =
  'La cuenta de este proyecto está suspendida: no es posible activar el correo, crear dominios ni buzones, ni conectar servicios.';
const CLIENTE_SUSPENDIDO =
  'El cliente de correo de este proyecto está suspendido en Mailway: no es posible crear dominios ni buzones, ni conectar servicios.';

/**
 * Nombres de buzón reservados a la administración del dominio (RFC 2142 y las
 * direcciones que las autoridades de certificación aceptan para validar un
 * dominio). Quien los recibe puede obtener certificados o recibir los avisos
 * de abuso del dominio: solo los crea un administrador de la plataforma.
 */
const BUZONES_RESERVADOS = new Set([
  'abuse',
  'admin',
  'administrator',
  'hostmaster',
  'postmaster',
  'root',
  'security',
  'ssladmin',
  'webmaster',
]);

/** Prefijo de las claves de API que crea Skyway (así se distinguen de las demás del cliente). */
const PREFIJO_CLAVE = 'Skyway · ';

/**
 * Nombre de la clave de API de un servicio. Mailway admite 60 caracteres, y el
 * slug del servicio (≤ 35) es estable aunque se renombren proyecto o servicio:
 * con él se encuentra la clave anterior al volver a conectar. El proyecto no
 * hace falta, porque el cliente de correo ya es el del proyecto.
 */
function apiKeyName(service: ServiceRow): string {
  return `${PREFIJO_CLAVE}${service.slug}`.slice(0, 60);
}

/** Nombre de la contraseña de aplicación de un servicio (mismo criterio que la clave). */
function appPasswordName(service: ServiceRow): string {
  return `skyway:${service.slug}`.slice(0, 60);
}

/** Error con código HTTP que el manejador global devuelve tal cual. */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

/**
 * Código con el que se contesta un fallo de Mailway. Los 400/404/409/429 de
 * Mailway se trasladan (describen la petición del usuario); el resto es un
 * fallo del servicio remoto (502). Nunca 401: la interfaz de Skyway interpreta
 * un 401 como sesión caducada y cerraría la sesión del usuario.
 */
function statusFor(err: MailwayError): number {
  if (err.kind === 'config') return 409;
  if (err.kind === 'http' && err.status !== null) {
    if ([400, 404, 409, 429].includes(err.status)) return err.status;
    if (err.status === 422) return 400;
  }
  return 502;
}

function messageFor(err: MailwayError): string {
  if (err.kind === 'http' && err.status === 403) {
    return `Mailway ha denegado la operación: ${err.message} Compruebe que el token de gestión configurado en Skyway es de administrador.`;
  }
  return err.message;
}

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** Traduce los `MailwayError` a una respuesta con mensaje en español. */
function guarded(fn: Handler): Handler {
  return async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (err) {
      if (err instanceof MailwayError) {
        const status = statusFor(err);
        if (status >= 500) req.log.warn({ kind: err.kind, status: err.status }, `Mailway: ${err.message}`);
        return reply.code(status).send({ error: messageFor(err) });
      }
      throw err;
    }
  };
}

function canManageProject(user: UserRow, project: ProjectRow): boolean {
  if (user.role === 'admin') return true;
  return user.role === 'owner' && !!user.workspace_id && project.workspace_id === user.workspace_id;
}

interface ProjectCtx {
  project: ProjectRow;
  user: UserRow;
  isAdmin: boolean;
}

/**
 * Proyecto de la ruta con sus comprobaciones: existe, el usuario tiene acceso,
 * el módulo «Correo» está activo y, si se pide, puede gestionar el proyecto.
 * Si algo falla ya ha respondido y devuelve null.
 */
function projectCtx(req: FastifyRequest, reply: FastifyReply, opts: { manage?: boolean } = {}): ProjectCtx | null {
  const { id } = req.params as { id: string };
  const project = getProject(id);
  if (!project) {
    reply.code(404).send({ error: 'Proyecto no encontrado' });
    return null;
  }
  if (!assertProjectAccess(req, reply, id)) return null;
  const user = currentUser(req)!;
  const isAdmin = user.role === 'admin';
  if (!moduleAllowedForProject(id, 'mail', isAdmin)) {
    reply.code(403).send({ error: MODULO_INACTIVO });
    return null;
  }
  if (opts.manage && !assertProjectManage(req, reply, id)) return null;
  return { project, user, isAdmin };
}

function requireLink(project: ProjectRow): MailwayLinkRow {
  if (!mailwayConfigured()) throw httpError(409, NO_CONFIGURADO);
  const link = getMailwayLink(project.id);
  if (!link) throw httpError(409, NO_VINCULADO);
  return link;
}

/**
 * Crear (cliente, dominios, buzones, credenciales) exige que la cuenta del
 * proyecto esté activa, como crear servicios. Lo ya creado sigue funcionando.
 */
function assertAccountActive(project: ProjectRow): void {
  const workspace = workspaceOfProject(project.id);
  if (workspace && !isWorkspaceActive(workspace)) throw httpError(403, CUENTA_SUSPENDIDA);
}

function assertClientActive(summary: MailwaySummary): void {
  if (summary.client.suspended) throw httpError(409, CLIENTE_SUSPENDIDO);
}

/** Error de referencia externa: la vista lo convierte en un aviso en lugar de fallar. */
function refError(message: string): Error {
  return Object.assign(httpError(409, message), { mailwayRef: true });
}

function isRefError(err: unknown): err is Error {
  return !!err && typeof err === 'object' && (err as { mailwayRef?: unknown }).mailwayRef === true;
}

/**
 * Resumen del cliente vinculado, comprobando que sigue siendo el de ESTE
 * proyecto. Skyway habla con Mailway con un token de administrador: si la
 * referencia externa del cliente no es exactamente la del proyecto (se ha
 * desvinculado o vinculado a otra cosa desde Mailway), no se opera sobre él.
 * Una referencia vacía tampoco vale: puede ser un cliente que el operador ha
 * retirado a propósito de este proyecto.
 */
async function ownedSummary(project: ProjectRow, link: MailwayLinkRow): Promise<MailwaySummary> {
  const summary = await getSummary(link.client_id);
  const expected = projectExternalRef(project.id);
  if (summary.client.id !== link.client_id) {
    throw new MailwayError('http', 'La respuesta de Mailway no corresponde al cliente vinculado.', 502);
  }
  const ref = summary.client.externalRef ?? null;
  if (ref === null) {
    throw refError(
      `El cliente de Mailway «${summary.client.name}» ya no está vinculado a este proyecto: se ha retirado su referencia desde Mailway. ` +
        'Desactive el correo en este proyecto; después podrá activarlo de nuevo recuperando ese mismo cliente.',
    );
  }
  if (ref !== expected) {
    throw refError(
      `El cliente de Mailway «${summary.client.name}» está vinculado a otra integración. ` +
        'Desactive el correo en este proyecto; el cliente y sus buzones se conservan en Mailway.',
    );
  }
  return summary;
}

// ---------- cliente anterior (reactivar sin perder los dominios) ----------

interface PreviousClient {
  clientId: string;
  clientName: string;
}

function readPreviousClient(projectId: string): PreviousClient | null {
  const raw = getSetting(previousClientKey(projectId));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PreviousClient>;
    return typeof v.clientId === 'string' && v.clientId ? { clientId: v.clientId, clientName: String(v.clientName ?? '') } : null;
  } catch {
    return null;
  }
}

function writePreviousClient(projectId: string, value: PreviousClient | null): void {
  setSetting(previousClientKey(projectId), value ? JSON.stringify(value) : null);
}

/**
 * ¿Se puede recuperar el cliente anterior? Solo si sigue existiendo, ningún
 * otro proyecto lo tiene y su referencia en Mailway está libre o es la del
 * proyecto: si otra integración lo ha tomado, ya no es de este proyecto.
 */
async function previousClientStatus(
  projectId: string,
  prev: PreviousClient,
): Promise<{ available: true; name: string; externalRef: string | null } | { available: false; reason: string }> {
  if (getMailwayLinkByClient(prev.clientId)) {
    return { available: false, reason: `El cliente anterior «${prev.clientName}» está vinculado a otro proyecto.` };
  }
  let client;
  try {
    client = (await getSummary(prev.clientId)).client;
  } catch (err) {
    if (err instanceof MailwayError && err.status === 404) {
      return { available: false, reason: `El cliente anterior «${prev.clientName}» ya no existe en Mailway.` };
    }
    throw err;
  }
  const ref = client.externalRef ?? null;
  if (ref !== null && ref !== projectExternalRef(projectId)) {
    return {
      available: false,
      reason: `El cliente anterior «${client.name}» está vinculado ahora a otra integración. Un administrador puede liberarlo desde Mailway.`,
    };
  }
  return { available: true, name: client.name, externalRef: ref };
}

/** Plan con el que se crea el cliente si no lo elige un administrador: el configurado o el primero. */
function defaultPlan(plans: MailwayPlan[]): MailwayPlan | null {
  const configured = getSetting(MAILWAY_SETTING.defaultPlanId);
  return plans.find((p) => p.id === configured) ?? plans[0] ?? null;
}

/** Mailway exige al menos 2 caracteres en el nombre del cliente; un proyecto puede tener 1. */
function defaultClientName(projectName: string): string {
  const name = projectName.trim();
  return (name.length >= 2 ? name : `Proyecto ${name}`.trim()).slice(0, 80);
}

/** El dominio, si pertenece al cliente del proyecto; si no, 404 (como si no existiera). */
function ownDomain(summary: MailwaySummary, domainId: string): MailwayDomain {
  const domain = summary.domains.find((d) => d.id === domainId);
  if (!domain) throw httpError(404, 'Dominio no encontrado en este proyecto');
  return domain;
}

function ownMailbox(summary: MailwaySummary, mailboxId: string): MailwayMailbox {
  const mailbox = summary.mailboxes.find((m) => m.id === mailboxId);
  if (!mailbox) throw httpError(404, 'Buzón no encontrado en este proyecto');
  return mailbox;
}

// ---------- formas públicas (solo campos conocidos: nada que Mailway añada sin revisar) ----------

function publicDomain(d: MailwayDomain) {
  const s = d.dnsStatus ?? {};
  return {
    id: d.id,
    domain: d.domain,
    status: d.status,
    verifiedAt: d.verifiedAt ?? null,
    lastCheckedAt: d.lastCheckedAt ?? null,
    createdAt: d.createdAt ?? null,
    cloudflare: !!d.cloudflare,
    dns: {
      requiredTotal: typeof s.requiredTotal === 'number' ? s.requiredTotal : 0,
      requiredOk: typeof s.requiredOk === 'number' ? s.requiredOk : 0,
      allRequiredOk: !!s.allRequiredOk,
      checkedAt: s.checkedAt ?? null,
      checks: (Array.isArray(s.checks) ? s.checks : []).map((c) => ({
        id: c.id,
        label: c.label,
        type: c.type,
        name: c.name,
        expected: c.expected,
        found: c.found ?? null,
        status: c.status,
        required: !!c.required,
        help: c.help ?? null,
      })),
    },
  };
}

function publicMailbox(m: MailwayMailbox) {
  return {
    id: m.id,
    domainId: m.domainId,
    domain: m.domain,
    localPart: m.localPart,
    email: m.email,
    displayName: m.displayName,
    quotaMb: m.quotaMb,
    usedBytes: typeof m.usedBytes === 'number' ? m.usedBytes : null,
    status: m.status,
    createdAt: m.createdAt ?? null,
  };
}

function publicApiKey(k: MailwayApiKeyInfo) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    senderMailboxId: k.senderMailboxId ?? null,
    senderEmail: k.senderEmail,
    createdBySkyway: typeof k.name === 'string' && k.name.startsWith(PREFIJO_CLAVE),
    lastUsedAt: k.lastUsedAt ?? null,
    revokedAt: k.revokedAt ?? null,
    createdAt: k.createdAt ?? null,
  };
}

function publicAppPassword(a: MailwayAppPasswordInfo) {
  return { id: a.id, mailboxId: a.mailboxId, email: a.email, name: a.name, createdAt: a.createdAt ?? null, revokedAt: a.revokedAt ?? null };
}

function publicSummary(s: MailwaySummary) {
  return {
    client: { id: s.client.id, name: s.client.name, slug: s.client.slug, suspended: !!s.client.suspended },
    plan: s.plan
      ? { id: s.plan.id, name: s.plan.name, maxDomains: s.plan.maxDomains, maxMailboxes: s.plan.maxMailboxes, mailboxQuotaMb: s.plan.mailboxQuotaMb }
      : null,
    usage: { domains: s.usage?.domains ?? s.domains.length, mailboxes: s.usage?.mailboxes ?? s.mailboxes.length },
    domains: s.domains.map(publicDomain),
    mailboxes: s.mailboxes.map(publicMailbox),
    apiKeys: s.apiKeys.map(publicApiKey),
    appPasswords: s.appPasswords.map(publicAppPassword),
    connection: {
      imap: s.connection?.imap ?? null,
      submission: s.connection?.submission ?? null,
      webmailUrl: safeHttpUrl(s.connection?.webmailUrl),
    },
  };
}

function publicPlan(p: MailwayPlan) {
  return { id: p.id, name: p.name, maxDomains: p.maxDomains, maxMailboxes: p.maxMailboxes, mailboxQuotaMb: p.mailboxQuotaMb };
}

/**
 * Revoca sin fallar si la credencial ya no existe o ya estaba revocada (404 o
 * 409 de Mailway): el objetivo, que deje de funcionar, ya se cumple.
 */
async function revokeIgnoringGone(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof MailwayError && (err.status === 404 || err.status === 409)) return;
    throw err;
  }
}

function publicLink(link: MailwayLinkRow) {
  return { clientId: link.client_id, clientName: link.client_name, createdAt: link.created_at, createdBy: link.created_by };
}

/** Funciones de la instancia, sin salir a la red si aún no se conocen. */
function featuresOf(): { cloudflare: boolean; autoconfig: boolean; portal: boolean } | null {
  const f = cachedInfo()?.features;
  return f ? { cloudflare: !!f.cloudflare, autoconfig: !!f.autoconfig, portal: !!f.portal } : null;
}

/** Lee la información de la instancia sin que un fallo impida mostrar el resto. */
async function tryInfo(): Promise<void> {
  try {
    await getInfo();
  } catch {
    /* la URL pública y las funciones quedan con lo que haya en caché */
  }
}

// ---------- configuración (administrador) ----------

function configView() {
  const cfg = readMailwayConfig();
  const service = cfg.serviceId ? getService(cfg.serviceId) : undefined;
  const project = service ? getProject(service.project_id) : undefined;
  return {
    configured: mailwayConfigured(cfg),
    baseUrl: cfg.baseUrl,
    serviceId: cfg.serviceId,
    serviceName: service ? `${project?.name ?? '?'} / ${service.name}` : null,
    internalUrl: internalPanelUrl(cfg.serviceId),
    hasToken: !!cfg.token,
    panelUrl: publicPanelUrl(cfg),
    defaultPlanId: getSetting(MAILWAY_SETTING.defaultPlanId) || null,
    traefik: mailwayTraefikStatus(),
  };
}

/** Valida una URL de panel: http(s), sin credenciales, consulta ni fragmento. */
function parsePanelUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw httpError(400, 'La URL del panel de Mailway no es válida.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw httpError(400, 'La URL del panel de Mailway debe empezar por https:// o http://.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw httpError(400, 'La URL del panel de Mailway no puede incluir credenciales, parámetros ni fragmentos.');
  }
  return normalizeBaseUrl(url.toString())!;
}

const TOKEN_RE = /^mwt_[A-Za-z0-9_-]{8,500}$/;

const configSchema = z.object({
  baseUrl: z.string().trim().max(500).optional(),
  token: z.string().trim().max(520).optional(),
  serviceId: z.string().trim().max(100).optional(),
  defaultPlanId: z
    .string()
    .trim()
    .max(64)
    .regex(/^[A-Za-z0-9_-]*$/, 'Identificador de plan no válido')
    .optional(),
});

/**
 * Motivo por el que no se puede usar la URL pública, si su dominio lo sirve un
 * servicio de Skyway que no es el panel de Mailway (el token viajaría hasta
 * él). Nombra el servicio: esta comprobación solo la ve el administrador.
 */
function baseConflictMessage(cfg: MailwayConfig): string | null {
  const service = publicBaseConflict(cfg);
  if (!service) return null;
  const project = getProject(service.project_id);
  return (
    `El dominio de la URL pública lo sirve el servicio «${project?.name ?? '?'} / ${service.name}» de Skyway, que no es el panel de Mailway. ` +
    'Si ese servicio ejecuta el panel, selecciónelo en «Servicio del panel de Mailway»; si no, corrija la URL. El token de gestión no se envía por un dominio de otro servicio.'
  );
}

function checkService(serviceId: string): void {
  const service = getService(serviceId);
  if (!service) throw httpError(400, 'El servicio indicado no existe.');
  if (service.type === 'database') throw httpError(400, 'El panel de Mailway no puede ser un servicio de base de datos.');
}

// ---------- rutas ----------

const linkSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('create'),
    name: z.string().trim().min(2, 'El nombre del cliente debe tener al menos 2 caracteres').max(80).optional(),
    planId: z.string().trim().min(1).max(100).optional(),
    contactEmail: z.union([z.string().trim().email('Correo electrónico de contacto no válido'), z.literal('')]).optional(),
  }),
  z.object({ mode: z.literal('existing'), clientId: z.string().trim().min(1).max(100) }),
  // Recuperar el cliente que el proyecto tenía antes de desactivar el correo.
  z.object({ mode: z.literal('previous') }),
]);

/** Mismo criterio que Mailway: sin «+» (no admite subdirecciones) y sin empezar ni acabar en signo. */
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export async function mailwayRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Configuración dinámica para el proveedor HTTP de Traefik (ver
   * docker-compose.yml). Sin sesión: la llama Traefik por la red interna
   * (`http://skyway:4000`). Una petición que trae cabeceras de reenvío ha
   * entrado desde internet a través de Traefik y no tiene nada que hacer aquí.
   * Lo que se sirve está saneado (`mailwaytraefik.ts`) y solo contiene
   * dominios públicos y nombres de contenedor, sin secretos.
   */
  app.get('/api/traefik/mailway', async (req, reply) => {
    const reenviada = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded'].some(
      (h) => req.headers[h] !== undefined,
    );
    if (reenviada) return reply.code(404).send({ error: 'No encontrado' });
    const config = await mailwayTraefikConfig(req.log);
    return reply.type('application/json; charset=utf-8').send(stableStringify(config));
  });

  app.register(async (secured) => {
    secured.addHook('preHandler', requireAuth);

    /** Lo consulta cualquier usuario: decide si la interfaz ofrece el correo. */
    secured.get('/api/mailway/status', async () => ({
      configured: mailwayConfigured(),
      panelUrl: publicPanelUrl(),
    }));

    secured.get('/api/mailway/config', { preHandler: requireAdmin }, async () => configView());

    secured.put('/api/mailway/config', { preHandler: [requireAdmin, requireSession] }, async (req) => {
      const body = configSchema.parse(req.body ?? {});
      const before = readMailwayConfig();
      const next: MailwayConfig = { ...before };
      const cambios: string[] = [];

      if (body.baseUrl !== undefined) next.baseUrl = body.baseUrl === '' ? null : parsePanelUrl(body.baseUrl);
      if (body.token !== undefined) {
        if (body.token !== '' && !TOKEN_RE.test(body.token)) {
          throw httpError(400, 'El token de gestión no es válido: debe empezar por «mwt_» (Mailway → Conexiones → Tokens de gestión).');
        }
        next.token = body.token === '' ? null : body.token;
      }
      if (body.serviceId !== undefined) {
        if (body.serviceId !== '') checkService(body.serviceId);
        next.serviceId = body.serviceId === '' ? null : body.serviceId;
      }
      // Al cambiar la dirección o el servicio se valida la combinación final
      // antes de guardar nada: una URL cuyo dominio sirve otro servicio de
      // Skyway recibiría el token. Sin tocarlas (p. ej., para quitar el token)
      // no se bloquea al administrador.
      if (next.baseUrl !== before.baseUrl || next.serviceId !== before.serviceId) {
        const conflicto = baseConflictMessage(next);
        if (conflicto) throw httpError(400, conflicto);
      }

      if (next.baseUrl !== before.baseUrl) {
        setSetting(MAILWAY_SETTING.baseUrl, next.baseUrl);
        cambios.push(next.baseUrl ? 'URL del panel' : 'URL del panel (eliminada)');
      }
      if (next.token !== before.token) {
        setSetting(MAILWAY_SETTING.token, next.token);
        cambios.push(next.token ? 'token de gestión' : 'token de gestión (eliminado)');
      }
      if (next.serviceId !== before.serviceId) {
        setSetting(MAILWAY_SETTING.serviceId, next.serviceId);
        cambios.push(next.serviceId ? 'servicio del panel' : 'servicio del panel (eliminado)');
      }
      let cambioPlan = false;
      if (body.defaultPlanId !== undefined) {
        const value = body.defaultPlanId || null;
        if (value !== (getSetting(MAILWAY_SETTING.defaultPlanId) || null)) {
          setSetting(MAILWAY_SETTING.defaultPlanId, value);
          cambioPlan = true;
        }
      }

      if (cambios.length > 0) {
        // Otra instancia u otro token: lo aprendido de la anterior no vale. La
        // última configuración de Traefik se conserva (también sin token):
        // solo «Desconectar Mailway» retira las rutas.
        resetMailwayCaches();
        setSetting(MAILWAY_SETTING.traefikToken, null);
        resetMailwayTraefikState();
      }
      if (cambioPlan) cambios.push('plan predeterminado');
      if (cambios.length > 0) {
        audit(req, 'mailway_config_updated', { type: 'system', id: 'mailway', detail: cambios.join(', ') });
      }
      return { ok: true, config: configView() };
    });

    /**
     * Desconecta Mailway: borra la dirección, el token, el servicio del panel y
     * el plan predeterminado, y retira del Traefik las rutas de los dominios de
     * Mailway. Es la única acción que las retira: quitar el token o cambiar la
     * dirección las mantiene (ver `mailwaytraefik.ts`). Los vínculos de los
     * proyectos se conservan en Skyway, y los clientes y buzones en Mailway.
     */
    secured.post('/api/mailway/disconnect', { preHandler: [requireAdmin, requireSession] }, async (req) => {
      for (const key of [
        MAILWAY_SETTING.baseUrl,
        MAILWAY_SETTING.token,
        MAILWAY_SETTING.serviceId,
        MAILWAY_SETTING.traefikToken,
        MAILWAY_SETTING.defaultPlanId,
        MAILWAY_SETTING.hosts,
      ]) {
        setSetting(key, null);
      }
      resetMailwayCaches();
      forgetMailwayTraefik();
      audit(req, 'mailway_disconnected', { type: 'system', id: 'mailway' });
      return { ok: true, config: configView() };
    });

    /** Planes de la instancia para elegir el predeterminado en Ajustes. */
    secured.get(
      '/api/mailway/plans',
      { preHandler: requireAdmin },
      guarded(async () => {
        if (!mailwayConfigured()) throw httpError(409, NO_CONFIGURADO);
        const plans = (await listPlans()).map(publicPlan);
        return { plans, defaultPlanId: getSetting(MAILWAY_SETTING.defaultPlanId) || null };
      }),
    );

    /**
     * Prueba la conexión con los valores indicados (aún sin guardar) o con los
     * guardados. Con estos últimos, deja además en caché la información de la
     * instancia y el token de Traefik.
     */
    secured.post(
      '/api/mailway/test',
      { preHandler: [requireAdmin, rateLimit({ max: 12, windowMs: 60_000 })] },
      guarded(async (req, reply) => {
        const body = configSchema.parse(req.body ?? {});
        const saved = readMailwayConfig();
        const override = !!(body.baseUrl || body.token || body.serviceId);
        if (body.token && !TOKEN_RE.test(body.token)) {
          return reply.code(400).send({ error: 'El token de gestión no es válido: debe empezar por «mwt_».' });
        }
        if (body.serviceId) checkService(body.serviceId);
        // Probar OTRA dirección con el token GUARDADO lo enviaría allí: con un
        // token de API de Skyway sería una forma de sacar una credencial
        // persistente, así que exige sesión de navegador, como guardarla.
        if ((body.baseUrl || body.serviceId) && !body.token && req.authMethod !== 'cookie') {
          return reply.code(403).send({ error: 'Probar otra dirección con el token guardado requiere una sesión de navegador.' });
        }
        const cfg: MailwayConfig = {
          baseUrl: body.baseUrl ? parsePanelUrl(body.baseUrl) : saved.baseUrl,
          token: body.token || saved.token,
          serviceId: body.serviceId || saved.serviceId,
        };
        if (!cfg.token) {
          return reply.code(400).send({ error: 'Introduzca el token de gestión de Mailway o guárdelo antes de probar la conexión.' });
        }
        if (!cfg.baseUrl && !internalPanelUrl(cfg.serviceId)) {
          return reply.code(400).send({ error: 'Indique la URL pública del panel de Mailway o el servicio de Skyway que lo ejecuta.' });
        }
        const conflicto = baseConflictMessage(cfg);
        if (conflicto && !internalPanelUrl(cfg.serviceId)) return reply.code(400).send({ error: conflicto });
        const info = override ? await getInfo({ config: cfg }) : await getInfo({ fresh: true });
        const warnings: string[] = [];
        if (conflicto) warnings.push(conflicto);
        if (info.user?.role !== 'admin') {
          warnings.push(
            'El token pertenece a un usuario que no es administrador de Mailway: no será posible activar el correo en los proyectos ni publicar en Traefik los dominios propios de los clientes.',
          );
        } else if (!info.traefik?.token) {
          warnings.push('Mailway no ha facilitado el token de Traefik: los dominios propios de los clientes no se publicarán automáticamente.');
        }
        return {
          ok: true,
          info: {
            version: info.version,
            brandName: info.brandName,
            mailHostname: info.mailHostname,
            webmailUrl: safeHttpUrl(info.webmailUrl),
            panelUrl: safeHttpUrl(info.panelUrl),
            role: info.user?.role ?? null,
            email: info.user?.email ?? null,
            features: {
              cloudflare: !!info.features?.cloudflare,
              autoconfig: !!info.features?.autoconfig,
              portal: !!info.features?.portal,
            },
          },
          warnings,
        };
      }),
    );

    // ---------- correo de un proyecto ----------

    /**
     * Estado del correo del proyecto. Si Skyway no tiene el vínculo pero
     * Mailway conserva un cliente con la referencia del proyecto (base del
     * panel restaurada, vínculo creado desde otro Skyway), se recupera solo.
     */
    secured.get(
      '/api/projects/:id/mail',
      guarded(async (req, reply) => {
        const { id } = req.params as { id: string };
        const project = getProject(id);
        if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });
        if (!assertProjectAccess(req, reply, id)) return reply;
        const user = currentUser(req)!;
        const isAdmin = user.role === 'admin';
        const workspace = workspaceOfProject(id);
        const base = {
          moduleEnabled: moduleAllowedForProject(id, 'mail', isAdmin),
          configured: mailwayConfigured(),
          canManage: canManageProject(user, project),
          isAdmin,
          accountSuspended: !!workspace && !isWorkspaceActive(workspace),
        };
        if (!base.moduleEnabled || !base.configured) {
          return { ...base, linked: false, panelUrl: base.configured ? publicPanelUrl() : null, features: null };
        }

        await tryInfo();
        let link = getMailwayLink(id);
        if (!link) {
          let client = null;
          try {
            client = await getClientByRef(projectExternalRef(id));
          } catch (err) {
            // Un token sin permisos de administrador no puede buscar por referencia: no es un fallo de la vista.
            if (!(err instanceof MailwayError && err.kind === 'http' && err.status === 403)) throw err;
          }
          if (client && !getMailwayLinkByClient(client.id)) {
            link = insertMailwayLink({ project_id: id, client_id: client.id, client_name: client.name, created_by: null });
            writePreviousClient(id, null);
            audit(req, 'mailway_link_restored', { type: 'project', id, detail: `${project.name} → ${client.name}` });
          }
        }
        if (!link) return { ...base, linked: false, panelUrl: publicPanelUrl(), features: featuresOf() };

        let summary: MailwaySummary;
        try {
          summary = await ownedSummary(project, link);
        } catch (err) {
          // El cliente no aparece en Mailway. No se borra el vínculo por su
          // cuenta: un 404 también lo da una URL mal configurada o un Mailway
          // sin la API de integraciones. Se informa y se deja desactivarlo.
          // Lo mismo si el cliente ya no lleva la referencia del proyecto.
          const notice =
            err instanceof MailwayError && err.status === 404
              ? `No se encuentra en Mailway el cliente «${link.client_name}» vinculado a este proyecto. Si se ha eliminado, desactive el correo y vuelva a activarlo.`
              : isRefError(err)
                ? err.message
                : null;
          if (notice) {
            return { ...base, linked: true, link: publicLink(link), notice, panelUrl: publicPanelUrl(), features: featuresOf() };
          }
          throw err;
        }
        return {
          ...base,
          linked: true,
          link: publicLink(link),
          summary: publicSummary(summary),
          panelUrl: publicPanelUrl(),
          features: featuresOf(),
        };
      }),
    );

    /**
     * Opciones del formulario de activación: planes (el administrador elige
     * entre todos; el propietario ve el que se le asignará), clientes para
     * vincular (solo el administrador) y el cliente anterior del proyecto, si
     * lo hay y se puede recuperar.
     */
    secured.get(
      '/api/projects/:id/mail/options',
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        if (!mailwayConfigured()) throw httpError(409, NO_CONFIGURADO);
        const all = await listPlans();
        const def = defaultPlan(all);
        const plans = (ctx.isAdmin ? all : def ? [def] : []).map(publicPlan);
        let clients: { id: string; name: string; available: boolean; linkedTo: string | null }[] = [];
        if (ctx.isAdmin) {
          const ref = projectExternalRef(ctx.project.id);
          const byClient = new Map(listMailwayLinks().map((l) => [l.client_id, l.project_name]));
          clients = (await listClients()).map((c) => {
            const project = byClient.get(c.id);
            const otherRef = c.externalRef && c.externalRef !== ref ? c.externalRef : null;
            return {
              id: c.id,
              name: c.name,
              available: !project && !otherRef,
              linkedTo: project ? `proyecto «${project}»` : otherRef,
            };
          });
        }
        const prev = readPreviousClient(ctx.project.id);
        let previous: { clientName: string; available: boolean; reason: string | null } | null = null;
        if (prev) {
          const st = await previousClientStatus(ctx.project.id, prev);
          previous = st.available
            ? { clientName: st.name, available: true, reason: null }
            : { clientName: prev.clientName, available: false, reason: st.reason };
        }
        return {
          plans,
          clients,
          defaultPlanId: def?.id ?? null,
          canChoosePlan: ctx.isAdmin,
          defaultName: defaultClientName(ctx.project.name),
          previous,
        };
      }),
    );

    secured.post(
      '/api/projects/:id/mail/link',
      { preHandler: rateLimit({ max: 10, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        if (!mailwayConfigured()) throw httpError(409, NO_CONFIGURADO);
        assertAccountActive(ctx.project);
        if (getMailwayLink(ctx.project.id)) throw httpError(409, 'El correo ya está activado en este proyecto.');
        const body = linkSchema.parse(req.body);
        const ref = projectExternalRef(ctx.project.id);

        let client;
        let created = false;
        let detalle = '';
        if (body.mode === 'create') {
          // El plan fija lo que el cliente puede crear en Mailway: el
          // propietario recibe el predeterminado; solo el administrador elige.
          let planId: string | undefined = body.planId;
          if (!ctx.isAdmin || !planId) {
            const def = defaultPlan(await listPlans());
            if (!ctx.isAdmin && planId && planId !== def?.id) {
              return reply.code(403).send({
                error: 'Solo un administrador puede elegir el plan de correo. Al activar el correo se aplica el plan predeterminado.',
              });
            }
            planId = def?.id;
          }
          const res = await ensureClient({
            externalRef: ref,
            name: body.name || defaultClientName(ctx.project.name),
            ...(planId ? { planId } : {}),
            ...(body.contactEmail ? { contactEmail: body.contactEmail } : {}),
          });
          client = res.client;
          created = !!res.created;
          if (created) detalle = ' (cliente nuevo)';
        } else if (body.mode === 'previous') {
          const prev = readPreviousClient(ctx.project.id);
          if (!prev) throw httpError(404, 'Este proyecto no tiene ningún cliente de correo anterior que recuperar.');
          const st = await previousClientStatus(ctx.project.id, prev);
          if (!st.available) throw httpError(409, st.reason);
          client = st.externalRef === ref ? { id: prev.clientId, name: st.name } : await linkClient(prev.clientId, ref);
          detalle = ' (cliente anterior recuperado)';
        } else {
          // Vincular un cliente que ya existe da a este proyecto sus buzones: solo el administrador.
          if (!ctx.isAdmin) return reply.code(403).send({ error: 'Solo un administrador puede vincular un cliente existente de Mailway.' });
          if (getMailwayLinkByClient(body.clientId)) {
            throw httpError(409, 'Ese cliente de Mailway ya está vinculado a otro proyecto.');
          }
          const current = (await listClients()).find((c) => c.id === body.clientId);
          if (!current) throw httpError(404, 'Cliente de Mailway no encontrado');
          if (current.externalRef && current.externalRef !== ref) {
            throw httpError(409, `El cliente «${current.name}» ya está vinculado a otra integración (${current.externalRef}).`);
          }
          client = await linkClient(body.clientId, ref);
        }
        if (!client?.id) throw new MailwayError('http', 'La respuesta de Mailway no incluye el cliente.', 502);
        if (getMailwayLinkByClient(client.id)) {
          throw httpError(409, 'Ese cliente de Mailway ya está vinculado a otro proyecto.');
        }
        const link = insertMailwayLink({
          project_id: ctx.project.id,
          client_id: client.id,
          client_name: client.name,
          created_by: req.authActor ?? null,
        });
        writePreviousClient(ctx.project.id, null);
        audit(req, 'mailway_linked', {
          type: 'project',
          id: ctx.project.id,
          detail: `${ctx.project.name} → ${client.name}${detalle}`,
        });
        reply.code(201);
        return { ok: true, created, link: publicLink(link) };
      }),
    );

    /**
     * Desactiva el correo: el cliente y sus buzones siguen en Mailway. La
     * referencia del proyecto solo se retira si el cliente todavía la lleva, y
     * se recuerda el cliente para poder recuperarlo al reactivar.
     */
    secured.delete(
      '/api/projects/:id/mail/link',
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const link = requireLink(ctx.project);
        const released = await releaseProjectClient(ctx.project.id, link.client_id);
        deleteMailwayLink(ctx.project.id);
        writePreviousClient(ctx.project.id, { clientId: link.client_id, clientName: link.client_name });
        audit(req, 'mailway_unlinked', {
          type: 'project',
          id: ctx.project.id,
          detail: `${ctx.project.name} ✕ ${link.client_name}${released ? '' : ' (la referencia en Mailway ya no era de este proyecto: no se ha modificado)'}`,
        });
        return { ok: true, released };
      }),
    );

    // ---------- dominios ----------

    secured.post(
      '/api/projects/:id/mail/domains',
      { preHandler: rateLimit({ max: 20, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply);
        if (!ctx) return reply;
        const link = requireLink(ctx.project);
        const body = z.object({ domain: domainSchema }).parse(req.body);
        if (!body.domain.includes('.')) throw httpError(400, 'Indique un dominio completo, por ejemplo: suempresa.com');
        assertAccountActive(ctx.project);
        // Como en el resto de rutas: el cliente tiene que seguir siendo el del proyecto.
        const summary = await ownedSummary(ctx.project, link);
        assertClientActive(summary);
        const domain = await createDomain(link.client_id, body.domain);
        audit(req, 'mailway_domain_added', { type: 'project', id: ctx.project.id, detail: `${ctx.project.name}: ${body.domain}` });
        reply.code(201);
        return { domain: publicDomain(domain) };
      }),
    );

    secured.post(
      '/api/projects/:id/mail/domains/:domainId/verify',
      { preHandler: rateLimit({ max: 30, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply);
        if (!ctx) return reply;
        const { domainId } = req.params as { domainId: string };
        const summary = await ownedSummary(ctx.project, requireLink(ctx.project));
        ownDomain(summary, domainId);
        return { domain: publicDomain(await verifyDomain(domainId)) };
      }),
    );

    secured.get(
      '/api/projects/:id/mail/domains/:domainId/dns',
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply);
        if (!ctx) return reply;
        const { domainId } = req.params as { domainId: string };
        const summary = await ownedSummary(ctx.project, requireLink(ctx.project));
        ownDomain(summary, domainId);
        const records = await getDomainDns(domainId);
        return { records: records.map((r) => ({ type: r.type, name: r.name, content: r.content })) };
      }),
    );

    secured.get(
      '/api/projects/:id/mail/domains/:domainId/cloudflare',
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply);
        if (!ctx) return reply;
        const { domainId } = req.params as { domainId: string };
        const summary = await ownedSummary(ctx.project, requireLink(ctx.project));
        ownDomain(summary, domainId);
        // Quien no es administrador de Skyway solo puede usar las cuentas de
        // Cloudflare del propio cliente, nunca las del operador.
        const plan = await getCloudflarePlan(domainId, { soloCliente: !ctx.isAdmin });
        return {
          available: !!plan.available,
          reason: plan.reason ?? null,
          account: plan.account ? { label: plan.account.label } : null,
          zone: plan.zone ? { name: plan.zone.name, status: plan.zone.status } : null,
          changes: (Array.isArray(plan.changes) ? plan.changes : []).map((c) => ({
            action: c.action,
            type: c.type,
            name: c.name,
            content: c.content,
            priority: c.priority ?? null,
            current: c.current ?? null,
            reason: c.reason,
            required: !!c.required,
          })),
          summary: plan.summary ?? { create: 0, update: 0, keep: 0, conflict: 0 },
        };
      }),
    );

    secured.post(
      '/api/projects/:id/mail/domains/:domainId/cloudflare/apply',
      { preHandler: rateLimit({ max: 10, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const { domainId } = req.params as { domainId: string };
        const body = z.object({ replaceConflicts: z.boolean().optional() }).parse(req.body ?? {});
        const summary = await ownedSummary(ctx.project, requireLink(ctx.project));
        const domain = ownDomain(summary, domainId);
        const result = await applyCloudflare(domainId, { replaceConflicts: body.replaceConflicts, soloCliente: !ctx.isAdmin });
        const applied = Array.isArray(result.applied) ? result.applied : [];
        const errors = Array.isArray(result.errors) ? result.errors : [];
        audit(req, 'mailway_dns_applied', {
          type: 'project',
          id: ctx.project.id,
          detail: `${domain.domain}: ${applied.length} cambio(s)${errors.length ? `, ${errors.length} error(es)` : ''}${body.replaceConflicts ? ' (reemplazando conflictos)' : ''}`,
        });
        return {
          applied: applied.map((a) => ({ action: a.action, type: a.type, name: a.name })),
          errors: errors.map((e) => ({ type: e.type, name: e.name, error: e.error })),
          domain: result.domain ? publicDomain(result.domain) : null,
        };
      }),
    );

    // ---------- buzones ----------

    /**
     * Crear un buzón da una identidad nueva en el dominio y su contraseña: lo
     * hacen el propietario de la cuenta o un administrador, como el resto de
     * acciones que entregan credenciales.
     */
    secured.post(
      '/api/projects/:id/mail/mailboxes',
      { preHandler: rateLimit({ max: 30, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const body = z
          .object({
            domainId: z.string().trim().min(1).max(100),
            localPart: z
              .string()
              .trim()
              .toLowerCase()
              .regex(
                LOCAL_PART_RE,
                'Nombre de buzón no válido: use letras minúsculas, números, puntos, guiones o guiones bajos, y empiece y termine por una letra o un número',
              ),
            displayName: z.string().trim().max(80, 'El nombre visible admite como máximo 80 caracteres').optional(),
          })
          .parse(req.body);
        if (BUZONES_RESERVADOS.has(body.localPart) && !ctx.isAdmin) {
          return reply.code(403).send({
            error: `El buzón «${body.localPart}» está reservado para la administración del dominio: solo un administrador de la plataforma puede crearlo.`,
          });
        }
        assertAccountActive(ctx.project);
        const summary = await ownedSummary(ctx.project, requireLink(ctx.project));
        assertClientActive(summary);
        ownDomain(summary, body.domainId);
        const res = await createMailbox({
          domainId: body.domainId,
          localPart: body.localPart,
          ...(body.displayName ? { displayName: body.displayName } : {}),
        });
        audit(req, 'mailway_mailbox_created', { type: 'project', id: ctx.project.id, detail: res.mailbox?.email ?? body.localPart });
        reply.code(201);
        // La contraseña se entrega UNA sola vez: Mailway no vuelve a mostrarla.
        return { mailbox: publicMailbox(res.mailbox), password: res.password ?? null };
      }),
    );

    secured.post(
      '/api/projects/:id/mail/mailboxes/:mailboxId/password',
      { preHandler: rateLimit({ max: 10, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const { mailboxId } = req.params as { mailboxId: string };
        const summary = await ownedSummary(ctx.project, requireLink(ctx.project));
        const mailbox = ownMailbox(summary, mailboxId);
        const res = await resetMailboxPassword(mailboxId);
        audit(req, 'mailway_mailbox_password_reset', { type: 'project', id: ctx.project.id, detail: mailbox.email });
        // Como al crear el buzón: la contraseña nueva se muestra una sola vez.
        return { password: res.password ?? null };
      }),
    );

    /**
     * Los enlaces con contraseña tienen su propio tope, mucho más bajo: Mailway
     * comprueba la contraseña antes de guardarla en el enlace, así que sin él
     * la ruta serviría para probar contraseñas de un buzón a gran velocidad.
     */
    const limiteEnlaceConContrasena = rateLimit({ max: 5, windowMs: 10 * 60_000 });

    secured.post(
      '/api/projects/:id/mail/mailboxes/:mailboxId/setup-link',
      { preHandler: rateLimit({ max: 30, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply);
        if (!ctx) return reply;
        const { mailboxId } = req.params as { mailboxId: string };
        const body = z
          .object({ includePassword: z.boolean().optional(), password: z.string().min(1).max(200).optional() })
          .parse(req.body ?? {});
        // La contraseña solo viaja si se aporta: pedir «incluir contraseña» sin
        // darla podría hacer que Mailway generase otra y desconectara los dispositivos.
        const withPassword = !!body.includePassword && !!body.password;
        if (withPassword) {
          if (!canManageProject(ctx.user, ctx.project)) {
            return reply.code(403).send({
              error: 'Solo el propietario de la cuenta o un administrador puede crear enlaces de configuración que incluyan la contraseña.',
            });
          }
          await limiteEnlaceConContrasena(req, reply);
          if (reply.sent) return reply;
        }
        const summary = await ownedSummary(ctx.project, requireLink(ctx.project));
        const mailbox = ownMailbox(summary, mailboxId);
        const link = await createSetupLink(mailboxId, withPassword ? { includePassword: true, password: body.password } : {});
        const url = safeHttpUrl(link?.url);
        if (!url) throw new MailwayError('http', 'Mailway ha devuelto un enlace de configuración no válido.', 502);
        // El enlace es una credencial: se audita que se creó, nunca su URL.
        audit(req, 'mailway_setup_link_created', {
          type: 'project',
          id: ctx.project.id,
          detail: `${mailbox.email}${withPassword ? ' (con contraseña)' : ''}`,
        });
        return { url, expiresAt: link.expiresAt ?? null, hasPassword: !!link.hasPassword };
      }),
    );

    /**
     * Elimina el buzón. Mailway no borra un buzón que sea remitente de claves
     * de API activas: las que creó Skyway para ese buzón se revocan antes (sus
     * servicios ya no podrían enviar con él). Las demás claves las gestiona el
     * cliente, y si queda alguna, Mailway responde 409 con el motivo.
     */
    secured.delete(
      '/api/projects/:id/mail/mailboxes/:mailboxId',
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const { mailboxId } = req.params as { mailboxId: string };
        const summary = await ownedSummary(ctx.project, requireLink(ctx.project));
        const mailbox = ownMailbox(summary, mailboxId);
        const propias = summary.apiKeys.filter(
          (k) =>
            !k.revokedAt &&
            typeof k.name === 'string' &&
            k.name.startsWith(PREFIJO_CLAVE) &&
            (k.senderMailboxId ? k.senderMailboxId === mailbox.id : k.senderEmail === mailbox.email),
        );
        for (const key of propias) await revokeIgnoringGone(() => revokeApiKey(key.id));
        await deleteMailbox(mailboxId);
        audit(req, 'mailway_mailbox_deleted', {
          type: 'project',
          id: ctx.project.id,
          detail: `${mailbox.email}${propias.length ? ` (${propias.length} clave(s) de API de Skyway revocada(s))` : ''}`,
        });
        return { ok: true, revokedApiKeys: propias.length };
      }),
    );

    // ---------- credenciales de envío ----------

    secured.delete(
      '/api/projects/:id/mail/app-passwords/:appId',
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const { appId } = req.params as { appId: string };
        const summary = await ownedSummary(ctx.project, requireLink(ctx.project));
        const app = summary.appPasswords.find((a) => a.id === appId);
        if (!app) throw httpError(404, 'Contraseña de aplicación no encontrada en este proyecto');
        if (!app.revokedAt) await revokeIgnoringGone(() => revokeAppPassword(app.mailboxId, app.id));
        audit(req, 'mailway_app_password_revoked', { type: 'project', id: ctx.project.id, detail: `${app.email}: ${app.name}` });
        return { ok: true };
      }),
    );

    secured.delete(
      '/api/projects/:id/mail/api-keys/:keyId',
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const { keyId } = req.params as { keyId: string };
        const summary = await ownedSummary(ctx.project, requireLink(ctx.project));
        const key = summary.apiKeys.find((k) => k.id === keyId);
        if (!key) throw httpError(404, 'Clave de API no encontrada en este proyecto');
        if (!key.revokedAt) await revokeIgnoringGone(() => revokeApiKey(key.id));
        audit(req, 'mailway_api_key_revoked', {
          type: 'project',
          id: ctx.project.id,
          detail: `${key.name} (${key.prefix}…, ${key.senderEmail})`,
        });
        return { ok: true };
      }),
    );

    // ---------- conectar un servicio ----------

    /**
     * Crea en Mailway una credencial de envío para el buzón y la inyecta en las
     * variables del servicio (fusionando: las demás se conservan). Devuelve
     * solo los NOMBRES de las variables: los valores son secretos y ya están
     * donde tienen que estar. La credencial del mismo tipo que Skyway creó
     * antes para este servicio se revoca: la variable que la guardaba se va a
     * sobrescribir, y sin revocarla seguiría siendo válida sin que nadie la
     * use (y Mailway limita las contraseñas de aplicación activas por buzón).
     */
    secured.post(
      '/api/projects/:id/mail/connect',
      { preHandler: rateLimit({ max: 20, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const body = z
          .object({
            serviceId: z.string().trim().min(1).max(100),
            mailboxId: z.string().trim().min(1).max(100),
            mode: z.enum(['smtp', 'api']),
            redeploy: z.boolean().optional().default(false),
          })
          .parse(req.body);
        const service = getService(body.serviceId);
        if (!service || service.project_id !== ctx.project.id) throw httpError(404, 'Servicio no encontrado en este proyecto');
        if (service.type === 'database') throw httpError(400, 'No es posible conectar el correo a un servicio de base de datos.');
        assertAccountActive(ctx.project);
        const link = requireLink(ctx.project);
        const summary = await ownedSummary(ctx.project, link);
        assertClientActive(summary);
        const mailbox = ownMailbox(summary, body.mailboxId);
        const info = await getInfo();

        let vars: Record<string, string>;
        let revoked = 0;
        if (body.mode === 'smtp') {
          // Las aplicaciones no están en la red interna del correo: salen por
          // el nombre público y el puerto de envío autenticado (587, STARTTLS).
          const host = info.submission?.host || info.mailHostname;
          if (!host) throw new MailwayError('http', 'Mailway no ha indicado el servidor de envío (submission).', 502);
          const name = appPasswordName(service);
          for (const old of summary.appPasswords.filter((a) => !a.revokedAt && a.name === name)) {
            await revokeIgnoringGone(() => revokeAppPassword(old.mailboxId, old.id));
            revoked++;
          }
          const appPassword = await createAppPassword(mailbox.id, name);
          if (!appPassword?.password) throw new MailwayError('http', 'Mailway no ha devuelto la contraseña de aplicación.', 502);
          vars = {
            SMTP_HOST: host,
            SMTP_PORT: String(info.submission?.port || 587),
            SMTP_SECURE: 'false',
            SMTP_USER: mailbox.email,
            SMTP_PASS: appPassword.password,
            SMTP_FROM: mailbox.email,
          };
        } else {
          const apiUrl = publicPanelUrl();
          if (!apiUrl) throw new MailwayError('config', 'No se conoce la URL pública de Mailway: configúrela en Ajustes → Correo (Mailway).');
          const name = apiKeyName(service);
          for (const old of summary.apiKeys.filter((k) => !k.revokedAt && k.name === name)) {
            await revokeIgnoringGone(() => revokeApiKey(old.id));
            revoked++;
          }
          const res = await createApiKey({ clientId: link.client_id, name, senderMailboxId: mailbox.id });
          if (!res?.key) throw new MailwayError('http', 'Mailway no ha devuelto la clave de API.', 502);
          vars = { MAILWAY_API_URL: apiUrl, MAILWAY_API_KEY: res.key, MAIL_FROM: mailbox.email };
        }

        setEnv(service.id, { ...getEnv(service.id), ...vars });
        const keys = Object.keys(vars);
        let deploymentId: string | null = null;
        if (body.redeploy) {
          markManualAction(service.id);
          deploymentId = triggerDeploy(service.id, 'mailway').id;
        }
        audit(req, 'mailway_service_connected', {
          type: 'service',
          id: service.id,
          detail:
            `${service.name} ← ${mailbox.email} (${body.mode === 'smtp' ? 'SMTP' : 'API'}): ${keys.join(', ')}` +
            `${revoked ? ` · ${revoked} credencial(es) anterior(es) revocada(s)` : ''}${body.redeploy ? ' · despliegue iniciado' : ''}`,
        });
        return { ok: true, keys, needsRedeploy: !body.redeploy, deploymentId, revoked };
      }),
    );
  });
}
