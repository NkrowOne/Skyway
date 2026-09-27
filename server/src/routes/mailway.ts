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
  projectExternalRef,
  publicPanelUrl,
  readMailwayConfig,
  resetMailwayCaches,
  resetMailboxPassword,
  unlinkClient,
  verifyDomain,
} from '../mailway';
import { mailwayTraefikConfig, mailwayTraefikStatus, resetMailwayTraefikState, stableStringify } from '../mailwaytraefik';
import { markManualAction } from '../monitor';
import { moduleAllowedForProject } from '../quota';
import { rateLimit } from '../ratelimit';
import { MailwayLinkRow, ProjectRow, UserRow } from '../types';
import { domainSchema } from './services';

const MODULO_INACTIVO = 'El módulo «Correo» no está activo en este workspace.';
const NO_CONFIGURADO =
  'La integración con Mailway no está configurada. Un administrador puede configurarla en Ajustes → Correo (Mailway).';
const NO_VINCULADO = 'El correo no está activado en este proyecto.';

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
 * Resumen del cliente vinculado, comprobando que sigue siendo el de ESTE
 * proyecto. Skyway habla con Mailway con un token de administrador: si la
 * referencia externa del cliente ya no es la del proyecto (alguien lo ha
 * vinculado a otra cosa desde Mailway), no se opera sobre él.
 */
async function ownedSummary(project: ProjectRow, link: MailwayLinkRow): Promise<MailwaySummary> {
  const summary = await getSummary(link.client_id);
  const expected = projectExternalRef(project.id);
  if (summary.client.id !== link.client_id) {
    throw new MailwayError('http', 'La respuesta de Mailway no corresponde al cliente vinculado.', 502);
  }
  if (summary.client.externalRef && summary.client.externalRef !== expected) {
    throw httpError(
      409,
      `El cliente de Mailway «${summary.client.name}» está vinculado a otra referencia. Desactive el correo en este proyecto y vuelva a activarlo.`,
    );
  }
  return summary;
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
    senderEmail: k.senderEmail,
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
      webmailUrl: s.connection?.webmailUrl ?? null,
    },
  };
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
});

function checkService(serviceId: string): void {
  const service = getService(serviceId);
  if (!service) throw httpError(400, 'El servicio indicado no existe.');
  if (service.type === 'database') throw httpError(400, 'El panel de Mailway no puede ser un servicio de base de datos.');
}

// ---------- rutas ----------

const linkSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('create'),
    name: z.string().trim().min(1).max(80).optional(),
    planId: z.string().trim().min(1).max(100).optional(),
    contactEmail: z.union([z.string().trim().email('Correo electrónico de contacto no válido'), z.literal('')]).optional(),
  }),
  z.object({ mode: z.literal('existing'), clientId: z.string().trim().min(1).max(100) }),
]);

const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

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
      const cambios: string[] = [];

      if (body.baseUrl !== undefined) {
        const value = body.baseUrl === '' ? null : parsePanelUrl(body.baseUrl);
        if (value !== before.baseUrl) {
          setSetting(MAILWAY_SETTING.baseUrl, value);
          cambios.push(value ? 'URL del panel' : 'URL del panel (eliminada)');
        }
      }
      if (body.token !== undefined) {
        if (body.token !== '' && !TOKEN_RE.test(body.token)) {
          throw httpError(400, 'El token de gestión no es válido: debe empezar por «mwt_» (Mailway → Conexiones → Tokens de gestión).');
        }
        const value = body.token === '' ? null : body.token;
        if (value !== before.token) {
          setSetting(MAILWAY_SETTING.token, value);
          cambios.push(value ? 'token de gestión' : 'token de gestión (eliminado)');
        }
      }
      if (body.serviceId !== undefined) {
        if (body.serviceId !== '') checkService(body.serviceId);
        const value = body.serviceId === '' ? null : body.serviceId;
        if (value !== before.serviceId) {
          setSetting(MAILWAY_SETTING.serviceId, value);
          cambios.push(value ? 'servicio del panel' : 'servicio del panel (eliminado)');
        }
      }

      if (cambios.length > 0) {
        // Otra instancia u otro token: lo aprendido de la anterior no vale. La
        // última configuración de Traefik se conserva hasta la próxima lectura
        // buena, para no retirar rutas por rotar un token.
        resetMailwayCaches();
        setSetting(MAILWAY_SETTING.traefikToken, null);
        resetMailwayTraefikState();
        audit(req, 'mailway_config_updated', { type: 'system', id: 'mailway', detail: cambios.join(', ') });
      }
      return { ok: true, config: configView() };
    });

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
        const info = override ? await getInfo({ config: cfg }) : await getInfo({ fresh: true });
        const warnings: string[] = [];
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
            webmailUrl: info.webmailUrl,
            panelUrl: info.panelUrl,
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
        const base = {
          moduleEnabled: moduleAllowedForProject(id, 'mail', isAdmin),
          configured: mailwayConfigured(),
          canManage: canManageProject(user, project),
          isAdmin,
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
          if (err instanceof MailwayError && err.status === 404) {
            return {
              ...base,
              linked: true,
              link: publicLink(link),
              notice: `No se encuentra en Mailway el cliente «${link.client_name}» vinculado a este proyecto. Si se ha eliminado, desactive el correo y vuelva a activarlo.`,
              panelUrl: publicPanelUrl(),
              features: featuresOf(),
            };
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

    /** Planes (y clientes, para el administrador) del formulario de activación. */
    secured.get(
      '/api/projects/:id/mail/options',
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        if (!mailwayConfigured()) throw httpError(409, NO_CONFIGURADO);
        const plans = (await listPlans()).map((p) => ({
          id: p.id,
          name: p.name,
          maxDomains: p.maxDomains,
          maxMailboxes: p.maxMailboxes,
          mailboxQuotaMb: p.mailboxQuotaMb,
        }));
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
        return { plans, clients };
      }),
    );

    secured.post(
      '/api/projects/:id/mail/link',
      { preHandler: rateLimit({ max: 10, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        if (!mailwayConfigured()) throw httpError(409, NO_CONFIGURADO);
        if (getMailwayLink(ctx.project.id)) throw httpError(409, 'El correo ya está activado en este proyecto.');
        const body = linkSchema.parse(req.body);
        const ref = projectExternalRef(ctx.project.id);

        let client;
        let created = false;
        if (body.mode === 'create') {
          const res = await ensureClient({
            externalRef: ref,
            name: body.name || ctx.project.name,
            ...(body.planId ? { planId: body.planId } : {}),
            ...(body.contactEmail ? { contactEmail: body.contactEmail } : {}),
          });
          client = res.client;
          created = !!res.created;
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
        audit(req, 'mailway_linked', {
          type: 'project',
          id: ctx.project.id,
          detail: `${ctx.project.name} → ${client.name}${created ? ' (cliente nuevo)' : ''}`,
        });
        reply.code(201);
        return { ok: true, created, link: publicLink(link) };
      }),
    );

    /** Desactiva el correo: el cliente y sus buzones siguen en Mailway, sin referencia al proyecto. */
    secured.delete(
      '/api/projects/:id/mail/link',
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const link = requireLink(ctx.project);
        try {
          await unlinkClient(link.client_id);
        } catch (err) {
          // Un cliente que ya no existe en Mailway no impide soltar el vínculo local.
          if (!(err instanceof MailwayError && err.status === 404)) throw err;
        }
        deleteMailwayLink(ctx.project.id);
        audit(req, 'mailway_unlinked', { type: 'project', id: ctx.project.id, detail: `${ctx.project.name} ✕ ${link.client_name}` });
        return { ok: true };
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
        const plan = await getCloudflarePlan(domainId);
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
        const result = await applyCloudflare(domainId, { replaceConflicts: body.replaceConflicts });
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

    secured.post(
      '/api/projects/:id/mail/mailboxes',
      { preHandler: rateLimit({ max: 30, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply);
        if (!ctx) return reply;
        const body = z
          .object({
            domainId: z.string().trim().min(1).max(100),
            localPart: z
              .string()
              .trim()
              .toLowerCase()
              .regex(LOCAL_PART_RE, 'Nombre de buzón no válido: use letras, números, puntos, guiones o «+»'),
            displayName: z.string().trim().max(120).optional(),
          })
          .parse(req.body);
        const summary = await ownedSummary(ctx.project, requireLink(ctx.project));
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
        const summary = await ownedSummary(ctx.project, requireLink(ctx.project));
        const mailbox = ownMailbox(summary, mailboxId);
        // La contraseña solo viaja si se aporta: pedir «incluir contraseña» sin
        // darla podría hacer que Mailway generase otra y desconectara los dispositivos.
        const withPassword = !!body.includePassword && !!body.password;
        const link = await createSetupLink(mailboxId, withPassword ? { includePassword: true, password: body.password } : {});
        // El enlace es una credencial: se audita que se creó, nunca su URL.
        audit(req, 'mailway_setup_link_created', {
          type: 'project',
          id: ctx.project.id,
          detail: `${mailbox.email}${withPassword ? ' (con contraseña)' : ''}`,
        });
        return { url: link.url, expiresAt: link.expiresAt ?? null, hasPassword: !!link.hasPassword };
      }),
    );

    secured.delete(
      '/api/projects/:id/mail/mailboxes/:mailboxId',
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const { mailboxId } = req.params as { mailboxId: string };
        const summary = await ownedSummary(ctx.project, requireLink(ctx.project));
        const mailbox = ownMailbox(summary, mailboxId);
        await deleteMailbox(mailboxId);
        audit(req, 'mailway_mailbox_deleted', { type: 'project', id: ctx.project.id, detail: mailbox.email });
        return { ok: true };
      }),
    );

    // ---------- conectar un servicio ----------

    /**
     * Crea en Mailway una credencial de envío para el buzón y la inyecta en las
     * variables del servicio (fusionando: las demás se conservan). Devuelve
     * solo los NOMBRES de las variables: los valores son secretos y ya están
     * donde tienen que estar.
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
        const link = requireLink(ctx.project);
        const summary = await ownedSummary(ctx.project, link);
        const mailbox = ownMailbox(summary, body.mailboxId);
        const info = await getInfo();

        let vars: Record<string, string>;
        if (body.mode === 'smtp') {
          // Las aplicaciones no están en la red interna del correo: salen por
          // el nombre público y el puerto de envío autenticado (587, STARTTLS).
          const host = info.submission?.host || info.mailHostname;
          if (!host) throw new MailwayError('http', 'Mailway no ha indicado el servidor de envío (submission).', 502);
          const appPassword = await createAppPassword(mailbox.id, `skyway:${service.slug}`);
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
          const res = await createApiKey({
            clientId: link.client_id,
            name: `Skyway · ${ctx.project.name}/${service.name}`.slice(0, 100),
            senderMailboxId: mailbox.id,
          });
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
          detail: `${service.name} ← ${mailbox.email} (${body.mode === 'smtp' ? 'SMTP' : 'API'}): ${keys.join(', ')}${body.redeploy ? ' · despliegue iniciado' : ''}`,
        });
        return { ok: true, keys, needsRedeploy: !body.redeploy, deploymentId };
      }),
    );
  });
}
