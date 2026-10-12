import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { parse as parseDomain } from 'tldts';
import { z } from 'zod';
import {
  accessibleProjectRows,
  assertProjectAccess,
  assertProjectManage,
  canManageProject,
  currentUser,
  requireAdmin,
  requireAuth,
  requireSession,
} from '../auth';
import { audit } from '../audit';
import {
  MailwayLinkWithProject,
  activeDeploymentIdsForServices,
  deleteMailwayLink,
  getMailwayLink,
  getProject,
  getService,
  getSetting,
  insertMailwayLink,
  listDomainMigrations,
  listMailwayLinks,
  listMailwayLinksByClient,
  listServices,
  listWorkspaceUsers,
  lastSuccessfulImage,
  servicesWithPendingChanges,
  setMailwayLinkClientName,
  setSetting,
  reservarNombresMailway,
} from '../db';
import { triggerDeploy } from '../deploy/deployer';
import { imageExists } from '../docker/containers';
import { panelDomains, webmailHostError } from '../domainguard';
import { bloqueoPorCambioConCorreo } from '../domainmigration';
import { consultarMx } from '../domains';
import {
  MAILWAY_SETTING,
  MailwayApiKeyInfo,
  MailwayAutoDnsResult,
  MailwayAppPasswordInfo,
  MailwayClient,
  MailwayConflicto,
  MailwayCopiaCambio,
  MailwayDnsCheck,
  MailwayDnsInstruction,
  MailwayDomain,
  MailwayError,
  MailwayInfo,
  MailwayInvite,
  MailwayInviteLink,
  MailwayInviteStatus,
  MailwayMailbox,
  MailwayPlan,
  MailwaySummary,
  MailwayWebmailDomain,
  MailwayWhitelabelDomain,
  MailwayWhitelabelStatus,
  WebZoneRecord,
  ZONE_LEVELS,
  acceptedClientRefs,
  appendWebRecords,
  applyCloudflare,
  applyWhitelabelCloudflare,
  cachedInfo,
  clientRefFor,
  createDomain,
  createInvite,
  createMailbox,
  createSetupLink,
  createWhitelabelDomain,
  deleteMailbox,
  ensureClient,
  fusionarSpf,
  getClientByRef,
  getClientContactEmail,
  getCloudflarePlan,
  getDomainConflict,
  getDomainDns,
  getInfo,
  getInviteUrl,
  getSummary,
  getWhitelabelDomain,
  getZoneFile,
  internalPanelUrl,
  linkClient,
  listClientCloudflareAccounts,
  listClients,
  listInvites,
  listPlans,
  listWhitelabelDomains,
  mailwayClientName,
  mailwayConfigured,
  mailwayCurrentHosts,
  mailwayPreviousHosts,
  mailwayReservedHosts,
  ownClientKey,
  previousClientKey,
  releaseMailwayPreviousHost,
  rememberPreviousHosts,
  projectExternalRef,
  publicPanelUrl,
  readMailwayConfig,
  releaseProjectClient,
  resetMailwayCaches,
  resetMailboxPassword,
  revokeApiKey,
  revokeAppPassword,
  revokeInvite,
  safeHttpUrl,
  setPrimaryWebmail,
  setWebmailAutomatico,
  stripWebRecords,
  undoCloudflare,
  verifyDomain,
  verifyWhitelabelDomain,
  workspaceExternalRef,
} from '../mailway';
import {
  alinearNombreCliente,
  migrarVinculo,
  readOwnClient,
  workspaceClientName,
  workspaceOfMailProject,
} from '../mailwaycuentas';
import {
  forgetMailwayTraefik,
  mailwayTraefikConfig,
  mailwayTraefikStatus,
  reserveWhitelabelHost,
  stableStringify,
} from '../mailwaytraefik';
import { panelExtraTraefikConfig } from '../paneldomain';
import { configuracionTraefikSkyway, mezclarConfiguracion } from '../redirecciones';
import {
  BUZONES_RESERVADOS,
  NO_CONFIGURADO,
  PREFIJO_CLAVE,
  assertAccountActive,
  assertClientActive,
  connectServiceMail,
  credentialNames,
  httpError,
  isRefError,
  knownMailValues,
  mailConnectNames,
  ownedSummary,
  requireLink,
  revokeIgnoringGone,
  serviceOfProject,
  withMailCredentialLock,
} from '../mailconnect';
import { LOCAL_PART_RE } from '../mailenv';
import { guardarConfigMailway, mailwayConfigSchema, probarConexionMailway } from '../mailwayconfig';
import { forgetProjectRenewals, renewalsOfProject, renovarCorreoDelProyecto } from '../mailwayrenovacion';
import { markManualAction } from '../monitor';
import { isWorkspaceActive, moduleAllowedForProject, workspaceOfProject } from '../quota';
import { rateLimit } from '../ratelimit';
import { MailwayLinkRow, ProjectRow, ServiceRow, UserRow, WorkspaceRow } from '../types';
import { withTimeout } from '../util';
import { domainSchema } from './services';

const MODULO_INACTIVO = 'El módulo «Correo» no está activo en este workspace.';

/**
 * Lo que espera la vista del correo a la renovación automática de las
 * contraseñas invalidadas: con Mailway respondiendo, renovar es cuestión de
 * dos o tres peticiones; si tarda más, sigue por detrás.
 */
const RENOVACION_VISTA_MS = 8000;

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
    return `Mailway ha denegado la operación: ${err.message} Comprueba que el token de gestión configurado en Skyway es de administrador.`;
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

// ---------- quién puede compartir un cliente (un cliente por cuenta) ----------

/**
 * Vínculo de OTRO proyecto con el cliente que impide vincularlo a este, o
 * undefined si no hay ninguno. Los proyectos de una cuenta comparten el
 * cliente de la cuenta; uno de otra cuenta (o cualquier otro, si el proyecto
 * no tiene cuenta) vería y borraría sus buzones.
 */
function linkedElsewhere(project: ProjectRow, links: MailwayLinkWithProject[]): MailwayLinkWithProject | undefined {
  return links.find((l) => l.project_id !== project.id && (!project.workspace_id || l.workspace_id !== project.workspace_id));
}

function linkedElsewhereError(project: ProjectRow): Error {
  return httpError(
    409,
    project.workspace_id
      ? 'Ese cliente de Mailway ya está vinculado a un proyecto de otra cuenta.'
      : 'Ese cliente de Mailway ya está vinculado a otro proyecto.',
  );
}

/**
 * Por qué no se puede vincular este cliente al proyecto (lo que se enseña
 * como «vinculado a…»), o null si se puede: lo tiene en Skyway un proyecto que
 * no es de la misma cuenta, o en Mailway lleva una referencia que no es de
 * este proyecto ni de su cuenta (la de otro proyecto, otra cuenta u otra
 * integración).
 */
function clientUnavailable(project: ProjectRow, client: { externalRef?: string | null }, links: MailwayLinkWithProject[]): string | null {
  const ajeno = linkedElsewhere(project, links);
  if (ajeno) return `proyecto «${ajeno.project_name}»`;
  const ref = client.externalRef ?? null;
  return ref !== null && !acceptedClientRefs(project).includes(ref) ? ref : null;
}

/**
 * Cliente que la cuenta del proyecto ya tiene en Mailway (referencia
 * `skyway:workspace:<id>`), o null. La búsqueda por referencia tiene que
 * devolver un cliente con esa misma referencia.
 */
async function workspaceClient(workspace: WorkspaceRow): Promise<MailwayClient | null> {
  const ref = workspaceExternalRef(workspace.id);
  const client = await getClientByRef(ref);
  if (client && (typeof client.id !== 'string' || client.externalRef !== ref)) {
    throw new MailwayError('http', 'La respuesta de Mailway no corresponde al cliente de la cuenta.', 502);
  }
  return client;
}

/**
 * ¿Se puede recuperar el cliente anterior? Solo si sigue existiendo, ningún
 * proyecto de otra cuenta lo tiene y su referencia en Mailway está libre o es
 * del proyecto o de su cuenta: si otra integración lo ha tomado, ya no es suyo.
 */
async function previousClientStatus(
  project: ProjectRow,
  prev: PreviousClient,
): Promise<{ available: true; name: string; externalRef: string | null } | { available: false; reason: string }> {
  if (linkedElsewhere(project, listMailwayLinksByClient(prev.clientId))) {
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
  if (ref !== null && !acceptedClientRefs(project).includes(ref)) {
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

/**
 * Nombre del cliente que se crea para el proyecto: el de su cuenta (lo
 * comparten todos sus proyectos) o, sin cuenta, el del proyecto. Mailway exige
 * al menos 2 caracteres y en Skyway pueden tener 1.
 */
function defaultClientName(project: ProjectRow, workspace: WorkspaceRow | undefined): string {
  return workspace ? workspaceClientName(workspace) : mailwayClientName(project.name, 'Proyecto');
}

/**
 * El cliente de una cuenta lleva el nombre de la cuenta. Si Mailway no deja
 * cambiarlo, se registra y se sigue con el que tiene: se reintenta al abrir el
 * correo del proyecto. Devuelve el nombre con el que queda.
 */
async function nombreDeCuenta(req: FastifyRequest, clientId: string, actual: string, workspace: WorkspaceRow): Promise<string> {
  try {
    return await alinearNombreCliente(clientId, actual, workspace);
  } catch (err) {
    if (!(err instanceof MailwayError)) throw err;
    req.log.warn({ clientId }, `No se ha podido poner al cliente de Mailway el nombre de la cuenta: ${err.message}`);
    return actual;
  }
}

/**
 * Cliente de correo del proyecto visto desde la cuenta: si es el de la cuenta
 * (y con qué otros proyectos de la cuenta, de los que quien pregunta puede
 * ver, lo comparte) o si el proyecto conserva su propio cliente. De paso,
 * migra el vínculo de antes de compartirlos (`migrarVinculo`) y alinea el
 * nombre del cliente con el de la cuenta. Ningún fallo de Mailway aquí impide
 * mostrar el correo: se registra y se reintenta la próxima vez.
 */
async function mailAccount(req: FastifyRequest, project: ProjectRow, user: UserRow, summary: MailwaySummary) {
  const workspace = workspaceOfMailProject(project);
  if (!workspace) return null;
  const ref = workspaceExternalRef(workspace.id);
  let ownClient: { workspaceClientName: string } | null = null;
  try {
    if (summary.client.externalRef === projectExternalRef(project.id)) {
      const r = await migrarVinculo(project, workspace, summary.client);
      if (r.estado === 'cuenta') Object.assign(summary.client, { externalRef: ref, name: r.name });
      else ownClient = { workspaceClientName: r.cuenta.name };
    } else if (summary.client.externalRef === ref) {
      summary.client.name = await alinearNombreCliente(summary.client.id, summary.client.name, workspace);
    }
  } catch (err) {
    if (!(err instanceof MailwayError)) throw err;
    req.log.warn({ projectId: project.id }, `Cliente de correo de la cuenta: ${err.message}`);
    const recordado = summary.client.externalRef === projectExternalRef(project.id) ? readOwnClient(project.id) : null;
    if (recordado) ownClient = { workspaceClientName: recordado.workspaceClientName };
  }
  const shared = summary.client.externalRef === ref;
  const otros = shared
    ? listMailwayLinksByClient(summary.client.id)
        .filter((l) => l.project_id !== project.id && l.workspace_id === workspace.id)
        .map((l) => getProject(l.project_id))
        .filter((p): p is ProjectRow => !!p)
    : [];
  return {
    workspaceName: workspace.name,
    shared,
    projects: accessibleProjectRows(user, otros).map((p) => ({ id: p.id, name: p.name })),
    ownClient,
  };
}

/** El dominio, si pertenece al cliente del proyecto; si no, 404 (como si no existiera). */
function ownDomain(summary: MailwaySummary, domainId: string): MailwayDomain {
  const domain = summary.domains.find((d) => d.id === domainId);
  if (!domain) throw httpError(404, 'Dominio no encontrado en este proyecto');
  return domain;
}

/**
 * ¿Garantiza el Mailway conectado que el DNS automático solo crea lo que falta
 * y que nunca usa en nombre de un cliente la cuenta de Cloudflare de la
 * instancia asociada a un dominio? Lo declara Mailway 1.1+ en
 * `features.cloudflareSoloCrear`; uno anterior modificaría registros que ya
 * existen (SPF, proxy…) y aceptaría esa cuenta con `soloCliente`.
 */
async function mailwayDnsSeguro(): Promise<{ info: MailwayInfo | null; seguro: boolean }> {
  try {
    const info = await getInfo();
    return { info, seguro: info.features?.cloudflareSoloCrear === true };
  } catch {
    return { info: null, seguro: false };
  }
}

/** Versión de Mailway para un mensaje, solo si tiene forma de versión (viene de fuera). */
function versionMailway(info: MailwayInfo | null): string {
  const v = info?.version;
  return typeof v === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(v) ? ` (${v})` : '';
}

/**
 * ¿Se pide a Mailway el DNS automático (alta de un dominio de correo, registro
 * del webmail) para un administrador? Solo si Mailway tiene alguna cuenta de
 * Cloudflare (`features.cloudflare`; si no, ni se intenta ni se avisa) y
 * garantiza que solo crea lo que falta. Con un Mailway anterior no se pide, y
 * `motivo` lo explica junto al botón con el que aplicarlo tras revisarlo.
 */
async function dnsAutomaticoCorreo(boton: string): Promise<{ pedir: boolean; motivo: string | null }> {
  const { info, seguro } = await mailwayDnsSeguro();
  if (!info) {
    return {
      pedir: false,
      motivo: `No se ha podido consultar a Mailway si admite el DNS automático, así que no se ha pedido. Aplícalo con «${boton}» tras revisar los cambios.`,
    };
  }
  if (!info.features?.cloudflare) return { pedir: false, motivo: null };
  if (!seguro) {
    return {
      pedir: false,
      motivo:
        `La versión de Mailway conectada${versionMailway(info)} no garantiza que el DNS automático solo cree los registros que faltan, ` +
        `así que no se ha pedido. Actualiza Mailway a la 1.1 o posterior; mientras tanto, aplícalo con «${boton}» tras revisar los cambios.`,
    };
  }
  return { pedir: true, motivo: null };
}

const CUENTA_DE_LA_PLATAFORMA_CONECTA =
  'El DNS de este dominio en Cloudflare lo gestiona el administrador de la plataforma con su propia cuenta. ' +
  'Conecta en Mailway una cuenta de Cloudflare del cliente que contenga la zona o solicita al administrador que aplique los cambios.';

const CUENTA_DE_LA_PLATAFORMA_SOLICITA =
  'El DNS de este dominio en Cloudflare lo gestiona el administrador de la plataforma con su propia cuenta. ' +
  'Solicita al administrador que aplique los cambios.';

/**
 * ¿El dominio quedó asociado en Mailway a una cuenta de Cloudflare que no es
 * del cliente? Pasa cuando un administrador aplica su DNS con las cuentas de
 * la instancia: Mailway guarda esa cuenta en el dominio y, en versiones
 * anteriores a la 1.1, la usaría también con `soloCliente`. Para quien no es
 * administrador, Skyway lo comprueba ANTES de pedir el plan o aplicarlo: ni
 * siquiera para leer debe usarse el token del operador en nombre de un
 * cliente. Solo consulta las cuentas del propio cliente.
 *
 * Devuelve el motivo para responder sin llamar a Mailway, o null si se le
 * puede llamar. Con un Mailway que lo garantiza (`cloudflareSoloCrear`) y
 * alguna cuenta propia del cliente, sí se le llama: ignora la cuenta de la
 * instancia, prueba las del cliente y, si una contiene la zona, el dominio
 * pasa a ella. Sin esa garantía, conectar una cuenta propia no lo resolvería,
 * así que el mensaje solo remite al administrador.
 */
async function bloqueoCuentaAjena(clientId: string, domain: MailwayDomain): Promise<string | null> {
  const asociada = domain.cloudflare?.accountId;
  if (!asociada) return null;
  const propias = await listClientCloudflareAccounts(clientId);
  if (propias.some((a) => a.id === asociada)) return null;
  const { seguro } = await mailwayDnsSeguro();
  if (!seguro) return CUENTA_DE_LA_PLATAFORMA_SOLICITA;
  return propias.length > 0 ? null : CUENTA_DE_LA_PLATAFORMA_CONECTA;
}

function ownMailbox(summary: MailwaySummary, mailboxId: string): MailwayMailbox {
  const mailbox = summary.mailboxes.find((m) => m.id === mailboxId);
  if (!mailbox) throw httpError(404, 'Buzón no encontrado en este proyecto');
  return mailbox;
}

// ---------- formas públicas (solo campos conocidos: nada que Mailway añada sin revisar) ----------

function publicOwnershipRecord(r: MailwayDomain['ownershipRecord']) {
  if (!r || typeof r.name !== 'string' || typeof r.content !== 'string') return null;
  return { type: typeof r.type === 'string' ? r.type : 'TXT', name: r.name, content: r.content };
}

function publicDomain(d: MailwayDomain) {
  const s = d.dnsStatus ?? {};
  const checks = Array.isArray(s.checks) ? s.checks : [];
  // Solo un Mailway posterior a la 1.2 informa `recepcionExterna`; ese ya
  // calcula él mismo el SPF combinado.
  const mailwayCalculaSpf = typeof d.recepcionExterna === 'boolean';
  return {
    id: d.id,
    domain: d.domain,
    status: d.status,
    verifiedAt: d.verifiedAt ?? null,
    lastCheckedAt: d.lastCheckedAt ?? null,
    createdAt: d.createdAt ?? null,
    cloudflare: !!d.cloudflare,
    // Un Mailway sin la comprobación de propiedad no manda el campo: entonces
    // no hay nada pendiente que mostrar.
    ownershipVerifiedAt: d.ownershipVerifiedAt ?? null,
    ownershipPending: 'ownershipVerifiedAt' in d && d.ownershipVerifiedAt === null,
    ownershipRecord: publicOwnershipRecord(d.ownershipRecord),
    dns: {
      requiredTotal: typeof s.requiredTotal === 'number' ? s.requiredTotal : 0,
      requiredOk: typeof s.requiredOk === 'number' ? s.requiredOk : 0,
      allRequiredOk: !!s.allRequiredOk,
      checkedAt: s.checkedAt ?? null,
      checks: checks.map((c) => ({
        id: c.id,
        label: c.label,
        type: c.type,
        name: c.name,
        expected: c.expected,
        found: c.found ?? null,
        status: c.status,
        required: !!c.required,
        help: c.help ?? null,
        suggested: sugerencia(c, checks, mailwayCalculaSpf),
      })),
    },
    // null: el Mailway conectado no lo informa (y entrega en local lo que se
    // envía desde aquí a un dominio cuyo MX está en otro proveedor).
    recepcionExterna: typeof d.recepcionExterna === 'boolean' ? d.recepcionExterna : null,
  };
}

/**
 * Valor con el que sustituir el registro existente: el que calcula Mailway
 * (`suggested`) o, con un Mailway que aún no lo hace, el SPF actual con lo que
 * le falta del propuesto. Pegar `expected` en su lugar dejaría sin autorizar
 * a Google, al hosting o a Mailchimp. Si un Mailway que ya lo calcula no lo
 * manda, es a propósito (el SPF gastaría demasiadas consultas DNS, o lo que
 * falta está detrás de «all») y aquí no se inventa otro.
 */
function sugerencia(c: MailwayDnsCheck, checks: readonly MailwayDnsCheck[], mailwayCalculaSpf: boolean): string | null {
  if (typeof c.suggested === 'string' && c.suggested) return c.suggested;
  if (mailwayCalculaSpf) return null;
  if (typeof c.id !== 'string' || !c.id.startsWith('spf:') || c.status !== 'mismatch') return null;
  if (typeof c.found !== 'string' || !c.found || typeof c.expected !== 'string') return null;
  const propuesto = spfSegunMx(c.id.slice('spf:'.length), c.expected, checks);
  return propuesto ? fusionarSpf(c.found, propuesto) : null;
}

/**
 * El SPF que propone un Mailway hasta la 1.2 autoriza con «mx», que solo vale
 * si el MX del dominio es este servidor. Con el MX en Google (un dominio que
 * aquí solo envía, o antes del traslado), «mx» autorizaría a los servidores
 * de entrada de Google y no a este: se cambia por «a:<servidor de correo>»,
 * como hacen los Mailway posteriores. null si no se conoce el servidor: no
 * hay valor correcto que proponer.
 */
function spfSegunMx(nombre: string, propuesto: string, checks: readonly MailwayDnsCheck[]): string | null {
  const tokens = propuesto.trim().split(/\s+/);
  if (!tokens.some((t) => /^\+?mx$/i.test(t))) return propuesto;
  const n = nombre.trim().toLowerCase();
  const mxPropio = checks.some((x) => typeof x.id === 'string' && x.id.toLowerCase() === `mx:${n}` && x.status === 'ok');
  if (mxPropio) return propuesto;
  const servidor = cachedInfo()?.mailHostname?.trim().toLowerCase().replace(/\.$/, '');
  if (!servidor || !MX_RE.test(servidor)) return null;
  return tokens.map((t) => (/^\+?mx$/i.test(t) ? `a:${servidor}` : t)).join(' ');
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
    // Tras pasar a otro dominio, el usuario con el que entra sigue siendo el
    // anterior hasta «Actualizar mis dispositivos» (Mailway 1.3+): «Conectar a
    // un servicio» avisa de que conectar por SMTP lo actualiza.
    login: typeof m.login === 'string' && m.login ? m.login : m.email,
    loginPending: m.loginPending === true,
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
  return {
    id: a.id,
    mailboxId: a.mailboxId,
    email: a.email,
    name: a.name,
    createdAt: a.createdAt ?? null,
    revokedAt: a.revokedAt ?? null,
    // Dejó de funcionar al cambiar Mailway de motor (null con un Mailway anterior).
    invalidatedAt: typeof a.invalidatedAt === 'number' ? a.invalidatedAt : null,
  };
}

function publicSummary(s: MailwaySummary, opts: { isAdmin: boolean }) {
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
    // Webmail propio: interruptor del webmail automático del cliente y sus
    // webmail de marca. null con un Mailway que no lo incluye en el resumen.
    webmail:
      typeof s.client.webmailAutomatico === 'boolean' && s.webmailDomains
        ? { automatico: s.client.webmailAutomatico, domains: publicWebmailDomains(s.webmailDomains, s.domains, opts) }
        : null,
  };
}

function publicPlan(p: MailwayPlan) {
  return { id: p.id, name: p.name, maxDomains: p.maxDomains, maxMailboxes: p.maxMailboxes, mailboxQuotaMb: p.mailboxQuotaMb };
}

function publicLink(link: MailwayLinkRow) {
  return { clientId: link.client_id, clientName: link.client_name, createdAt: link.created_at, createdBy: link.created_by };
}

/**
 * Funciones de la instancia, sin salir a la red si aún no se conocen.
 * `webmailAutomatico` es el interruptor global del webmail automático, o null
 * si el Mailway conectado no lo tiene (la interfaz oculta entonces el suyo).
 * `invites`: admite los enlaces de bienvenida («Enviar configuración inicial»).
 */
function featuresOf(): {
  cloudflare: boolean;
  autoconfig: boolean;
  portal: boolean;
  webmailAutomatico: boolean | null;
  invites: boolean;
} | null {
  const f = cachedInfo()?.features;
  return f
    ? {
        cloudflare: !!f.cloudflare,
        autoconfig: !!f.autoconfig,
        portal: !!f.portal,
        webmailAutomatico: typeof f.webmailAutomatico === 'boolean' ? f.webmailAutomatico : null,
        invites: f.invites === true,
      }
    : null;
}

/** Lee la información de la instancia sin que un fallo impida mostrar el resto. */
async function tryInfo(): Promise<void> {
  try {
    await getInfo();
  } catch {
    /* la URL pública y las funciones quedan con lo que haya en caché */
  }
}

// ---------- recepción del correo de un dominio ----------

/** Nombre de host plausible de un MX (viene del DNS o de Mailway: se filtra antes de enseñarlo). */
const MX_RE = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)*$/;

type Recepcion = 'otro' | 'aqui' | 'sin_mx' | 'desconocido';

/**
 * ¿Dónde recibe hoy el correo un dominio? Lo mide Skyway en el DNS público
 * antes de darlo de alta (Mailway solo lo mide de un dominio que ya tiene):
 * `otro` si algún MX apunta a un servidor que no es el de Mailway.
 */
async function recepcionDe(domain: string): Promise<{ recepcion: Recepcion; mx: string[] }> {
  const [mx] = await Promise.all([consultarMx(domain), tryInfo()]);
  const propio = cachedInfo()?.mailHostname?.trim().toLowerCase().replace(/\.$/, '') || null;
  const hosts = mx.hosts.filter((h) => MX_RE.test(h)).slice(0, 10);
  if (!mx.ok) return { recepcion: 'desconocido', mx: [] };
  if (hosts.length === 0) return { recepcion: 'sin_mx', mx: [] };
  if (!propio) return { recepcion: 'desconocido', mx: hosts };
  return { recepcion: hosts.some((h) => h !== propio) ? 'otro' : 'aqui', mx: hosts };
}

const POLITICAS_DMARC = new Set(['none', 'quarantine', 'reject']);

/** Lo que dice Mailway de un dominio que quizá recibe en otro proveedor, solo con campos conocidos y acotados. */
function publicConflicto(c: MailwayConflicto) {
  const texto = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const mx = (Array.isArray(c.mxActuales) ? c.mxActuales : [])
    .filter((h): h is string => typeof h === 'string')
    .map((h) => h.trim().toLowerCase().replace(/\.$/, ''))
    .filter((h) => MX_RE.test(h))
    .slice(0, 10);
  return {
    hayOtroProveedor: c.hayOtroProveedor === true,
    mxActuales: mx,
    spfActual: texto(c.spfActual, 1000),
    dmarcPolitica: typeof c.dmarcPolitica === 'string' && POLITICAS_DMARC.has(c.dmarcPolitica) ? c.dmarcPolitica : null,
    avisoMtaSts: texto(c.avisoMtaSts, 2000),
  };
}

/** Copia del último cambio en Cloudflare (Mailway posterior a la 1.2), solo con campos conocidos. */
function publicCopia(c: MailwayCopiaCambio | null | undefined) {
  if (!c || typeof c !== 'object' || !Array.isArray(c.borrados)) return null;
  return {
    createdAt: typeof c.createdAt === 'number' ? c.createdAt : null,
    borrados: c.borrados
      .filter((b) => b && typeof b.type === 'string' && typeof b.name === 'string' && typeof b.content === 'string')
      .slice(0, 50)
      .map((b) => ({ type: b.type, name: b.name, content: b.content, priority: typeof b.priority === 'number' ? b.priority : null })),
  };
}

// ---------- dominios sugeridos ----------

/**
 * Dominio registrable de un nombre (empresa.com de api.empresa.com) según la
 * lista de sufijos públicos, o null. Solo bajo un sufijo de ICANN: bajo uno
 * privado (github.io, duckdns.org…) el nombre lo reparte un proveedor entre
 * sus usuarios, y el dominio registrable es del proveedor, no del cliente.
 */
function registrableDomain(host: string): string | null {
  const p = parseDomain(host.trim().toLowerCase(), { allowPrivateDomains: true });
  if (p.isIp || !p.isIcann || !p.domain) return null;
  return p.domain;
}

/** Son atajos del formulario, no un inventario. */
const MAX_SUGERENCIAS = 8;

/**
 * Dominios del cliente que son el origen de un cambio de dominio abierto en
 * Mailway (`migracion.rol === 'origen'` en el resumen). Se lee sin depender
 * del tipo: un Mailway anterior al cambio de dominio no manda el campo.
 */
function dominiosQueSeVan(summary: MailwaySummary): string[] {
  return summary.domains
    .filter((d) => (d as { migracion?: { rol?: unknown } | null }).migracion?.rol === 'origen')
    .map((d) => d.domain);
}

/**
 * Dominios de correo que se proponen al proyecto: los registrables de los
 * dominios de sus servicios (api.empresa.com → empresa.com), sin los que ya
 * tiene su cliente de correo ni los de la plataforma: el del panel, el raíz
 * con el que se generan los subdominios de los servicios y los de la instancia
 * de Mailway. Que un servicio cuelgue de esos dominios no los hace del cliente.
 * Tampoco el dominio que se va en un cambio de dominio (`dominiosQueSeVan`),
 * aunque dejara de figurar entre los del cliente: proponerlo invitaría a darlo
 * de alta otra vez justo cuando se retira.
 */
function suggestedDomains(projectId: string, existing: string[], salientes: readonly string[] = []): string[] {
  const fuera = new Set([...existing, ...salientes].filter((d) => typeof d === 'string').map((d) => d.toLowerCase()));
  for (const host of [...panelDomains(), getSetting('rootDomain') ?? '', ...mailwayReservedHosts()]) {
    const reg = host ? registrableDomain(host) : null;
    if (reg) fuera.add(reg);
  }
  // Tras la baja, el dominio anterior ya no está en el resumen de Mailway, pero
  // la web puede seguir sirviéndolo (modos «servir» y «no cambiar»): sin esto
  // se volvería a proponer el dominio que este proyecto acaba de retirar. Se
  // compara el nombre exacto, como los del resumen: el registrable de un
  // subdominio de correo excluiría un dominio que nadie ha retirado.
  for (const m of listDomainMigrations(projectId)) {
    if (m.mailway_migration_id && m.estado !== 'cancelada') fuera.add(m.from_domain.toLowerCase());
  }
  const out: string[] = [];
  for (const service of listServices(projectId)) {
    const domains = (service.config as { domains?: unknown }).domains;
    if (!Array.isArray(domains)) continue;
    for (const d of domains) {
      const reg = typeof d === 'string' ? registrableDomain(d) : null;
      if (reg && !fuera.has(reg) && !out.includes(reg)) out.push(reg);
    }
  }
  return out.slice(0, MAX_SUGERENCIAS);
}

// ---------- webmail con el dominio del cliente (marca blanca) ----------

const WEBMAIL_STATUS = new Set(['pending_dns', 'issuing', 'active', 'error']);
/** Nombre de host completo en minúsculas, con al menos un punto. */
const HOST_RE = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * El webmail de un dominio de correo vive siempre en `webmail.<dominio>`: el
 * nombre lo fija Skyway a partir del dominio del cliente, nunca quien llama.
 */
function webmailHostname(domain: MailwayDomain): string {
  return `webmail.${domain.domain.toLowerCase()}`;
}

/**
 * El dominio propio del cliente con ese nombre, o null. Se filtra también por
 * cliente: con el token de administrador, un Mailway que ignorase `clientId`
 * devolvería los de todos los clientes.
 */
async function findWebmail(clientId: string, hostname: string): Promise<MailwayWhitelabelDomain | null> {
  const list = await listWhitelabelDomains(clientId);
  return (
    list.find((d) => d.clientId === clientId && typeof d.hostname === 'string' && d.hostname.toLowerCase() === hostname) ?? null
  );
}

async function requireWebmail(clientId: string, hostname: string): Promise<MailwayWhitelabelDomain> {
  const found = await findWebmail(clientId, hostname);
  if (!found) throw httpError(404, `El webmail ${hostname} no está configurado en este proyecto.`);
  return found;
}

/** Lo que devuelve Mailway tiene que ser ese mismo nombre y del cliente vinculado. */
function ownedWebmail(d: MailwayWhitelabelDomain | undefined, clientId: string, hostname: string): MailwayWhitelabelDomain {
  if (!d || d.clientId !== clientId || typeof d.hostname !== 'string' || d.hostname.toLowerCase() !== hostname) {
    throw new MailwayError('http', 'La respuesta de Mailway no corresponde al webmail de este dominio.', 502);
  }
  return d;
}

/** Resultado de Cloudflare tal como sale hacia la web: solo los campos conocidos. */
function publicAutoDns(r: MailwayAutoDnsResult): MailwayAutoDnsResult {
  return {
    applied: r.applied.map((a) => ({ action: a.action, type: a.type, name: a.name })),
    errors: r.errors.map((e) => ({ type: e.type, name: e.name, error: e.error })),
    skipped: r.skipped.map((x) => ({ type: x.type, name: x.name, reason: x.reason })),
  };
}

/**
 * Reserva para el proyecto los nombres con dirección (A, AAAA o CNAME) que
 * Mailway acaba de crear en Cloudflare a petición de un administrador: con
 * las cuentas de la instancia, en las zonas del operador. Apuntan a este
 * servidor aunque después se borre el dominio de correo o el webmail, y otro
 * cliente podría asignárselos a un servicio. Solo se llama para el
 * administrador: lo que crea un cliente con su cuenta va a su propia zona.
 */
function reservarCreadosPorMailway(applied: readonly { action: string; type: string; name: string }[], projectId: string): void {
  const nombres = applied
    // También lo que sustituye un reemplazo («replace», Mailway posterior a la 1.2): apunta aquí igual.
    .filter((a) => a && (a.action === 'create' || a.action === 'replace') && ['A', 'AAAA', 'CNAME'].includes(String(a.type).toUpperCase()))
    .map((a) => String(a.name))
    .filter((n) => n.includes('.'));
  if (nombres.length > 0) reservarNombresMailway(nombres, projectId);
}

interface WebmailDnsAutomatico {
  cloudflare: MailwayAutoDnsResult | null;
  cloudflareReason: string | null;
  domain: MailwayWhitelabelDomain | undefined;
}

/**
 * Registro del webmail en Cloudflare justo después de darlo de alta, como el
 * botón «Crear registro en Cloudflare». Solo lo llama la ruta para un administrador:
 * va sin `soloCliente`, así que Mailway puede usar las cuentas de la
 * instancia, que nunca se usan en nombre de un cliente. Si Mailway no tiene
 * ninguna cuenta de Cloudflare no se intenta; un fallo no deshace el alta y
 * vuelve como motivo. Con `soloCrear`, Mailway no reemplaza ni modifica un
 * registro existente (ni le quita el proxy): lo devuelve en `skipped`.
 */
async function webmailDnsAutomatico(
  req: FastifyRequest,
  project: ProjectRow,
  whitelabelId: string,
  hostname: string,
): Promise<WebmailDnsAutomatico | null> {
  try {
    const { pedir, motivo } = await dnsAutomaticoCorreo('Crear registro en Cloudflare');
    if (!pedir) return motivo ? { cloudflare: null, cloudflareReason: motivo, domain: undefined } : null;
    const result = await applyWhitelabelCloudflare(whitelabelId, { soloCliente: false, soloCrear: true });
    const applied = Array.isArray(result.applied) ? result.applied : [];
    reservarCreadosPorMailway(applied, project.id);
    const errors = Array.isArray(result.errors) ? result.errors : [];
    const skipped = Array.isArray(result.skipped) ? result.skipped : [];
    audit(req, 'mailway_webmail_dns_applied', {
      type: 'project',
      id: project.id,
      detail:
        `${hostname}: ${applied.length} cambio(s)` +
        `${errors.length ? `, ${errors.length} error(es)` : ''}${skipped.length ? `, ${skipped.length} sin aplicar` : ''} (automático al configurarlo)`,
    });
    return { cloudflare: publicAutoDns({ applied, errors, skipped }), cloudflareReason: null, domain: result.domain };
  } catch (err) {
    // El webmail ya está creado: ningún fallo de aquí hace fallar el alta.
    if (err instanceof MailwayError) return { cloudflare: null, cloudflareReason: messageFor(err), domain: undefined };
    req.log.warn({ err: (err as Error)?.message }, 'Registro automático del webmail en Cloudflare');
    return {
      cloudflare: null,
      cloudflareReason: 'No se ha podido crear el registro en Cloudflare. Utiliza «Crear registro en Cloudflare» en el webmail del dominio.',
      domain: undefined,
    };
  }
}

function publicInstructions(list: MailwayDnsInstruction[] | undefined) {
  return (Array.isArray(list) ? list : [])
    .filter((i) => i && typeof i.type === 'string' && typeof i.name === 'string' && typeof i.value === 'string')
    .map((i) => ({
      type: i.type,
      name: i.name,
      value: i.value,
      recommended: !!i.recommended,
      help: typeof i.help === 'string' ? i.help : null,
    }));
}

function publicWebmail(d: MailwayWhitelabelDomain, instructions?: MailwayDnsInstruction[]) {
  const hostname = d.hostname.toLowerCase();
  const status = WEBMAIL_STATUS.has(d.status) ? d.status : 'error';
  return {
    hostname,
    kind: d.kind === 'panel' ? ('panel' as const) : ('webmail' as const),
    status,
    detail: typeof d.detail === 'string' ? d.detail : '',
    lastCheckedAt: d.lastCheckedAt ?? null,
    activatedAt: d.activatedAt ?? null,
    createdAt: d.createdAt ?? null,
    isPrimary: !!d.isPrimary,
    // El enlace lo forma Skyway con el nombre validado, no llega de Mailway.
    url: status === 'active' && HOST_RE.test(hostname) ? `https://${hostname}` : null,
    instructions: publicInstructions(instructions),
  };
}

// ---------- webmail propio (webmail automático) ----------

/**
 * Webmail de marca del cliente (resumen o interruptor) tal como sale hacia la
 * web: solo nombres válidos que cuelgan de un dominio de correo del cliente
 * (lo demás no es suyo y no se enseña), sin identificadores de Mailway y con
 * el enlace formado por Skyway. Con el nombre en un servicio de Skyway o en el
 * panel, `conflict` lo explica y no hay enlace: llevaría a ese servicio.
 */
function publicWebmailDomains(list: MailwayWebmailDomain[], domains: MailwayDomain[], opts: { isAdmin: boolean }) {
  const zonas = domains.filter((d) => typeof d?.domain === 'string').map((d) => d.domain.toLowerCase());
  const out: {
    hostname: string;
    status: MailwayWhitelabelStatus;
    detail: string;
    automatico: boolean;
    isPrimary: boolean;
    url: string | null;
    conflict: string | null;
  }[] = [];
  for (const d of list) {
    const hostname = typeof d?.hostname === 'string' ? d.hostname.trim().toLowerCase() : '';
    if (!HOST_RE.test(hostname) || !zonas.some((z) => hostname.endsWith(`.${z}`))) continue;
    if (out.some((o) => o.hostname === hostname)) continue;
    const status = WEBMAIL_STATUS.has(d.status) ? d.status : 'error';
    const conflict = webmailHostError(hostname, opts);
    out.push({
      hostname,
      status,
      detail: typeof d.detail === 'string' ? d.detail : '',
      automatico: d.automatico === true,
      isPrimary: d.isPrimary === true,
      url: status === 'active' && !conflict ? `https://${hostname}` : null,
      conflict,
    });
  }
  return out;
}

// ---------- configuración inicial (enlace de bienvenida) ----------

const INVITE_STATUS = new Set<MailwayInviteStatus>(['pending', 'accepted', 'expired', 'revoked']);

const instante = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

interface PublicInvite {
  id: string;
  email: string;
  name: string;
  createdAt: number | null;
  expiresAt: number | null;
  openedAt: number | null;
  acceptedAt: number | null;
  revokedAt: number | null;
  status: MailwayInviteStatus;
  recoverable: boolean;
}

/**
 * Enlace de bienvenida de la lista, solo con los campos conocidos. Un estado
 * que no se reconoce se deduce de las fechas; solo se puede volver a mostrar
 * uno pendiente que Mailway marque como recuperable.
 */
function publicInvite(i: MailwayInvite): PublicInvite | null {
  if (!i || typeof i.id !== 'string' || !i.id || typeof i.email !== 'string') return null;
  const expiresAt = instante(i.expiresAt);
  const acceptedAt = instante(i.acceptedAt);
  const revokedAt = instante(i.revokedAt);
  const status: MailwayInviteStatus = INVITE_STATUS.has(i.status)
    ? i.status
    : acceptedAt
      ? 'accepted'
      : revokedAt
        ? 'revoked'
        : expiresAt !== null && expiresAt <= Date.now()
          ? 'expired'
          : 'pending';
  return {
    id: i.id,
    email: i.email,
    name: typeof i.name === 'string' ? i.name : '',
    createdAt: instante(i.createdAt),
    expiresAt,
    openedAt: instante(i.openedAt),
    acceptedAt,
    revokedAt,
    status,
    recoverable: status === 'pending' && i.recoverable === true,
  };
}

/** Enlaces de bienvenida del cliente, ya saneados. */
async function clientInvites(clientId: string): Promise<PublicInvite[]> {
  return (await listInvites(clientId)).map(publicInvite).filter((i): i is PublicInvite => i !== null);
}

/**
 * El enlace, si es del cliente vinculado; si no, 404 sin llegar a la ruta
 * del enlace (como si no existiera). Mailway lista los 50 más recientes.
 */
async function ownInvite(clientId: string, inviteId: string): Promise<PublicInvite> {
  const invite = (await clientInvites(clientId)).find((i) => i.id === inviteId);
  if (!invite) throw httpError(404, 'Enlace de bienvenida no encontrado en este proyecto');
  return invite;
}

/** El enlace con su URL tal como sale hacia la web (la URL, ya comprobada que es http o https). */
function publicInviteLink(link: MailwayInviteLink, url: string, fallback: { email: string; name: string }) {
  return {
    id: link.id,
    url,
    email: typeof link.email === 'string' && link.email ? link.email : fallback.email,
    name: typeof link.name === 'string' ? link.name : fallback.name,
    expiresAt: instante(link.expiresAt),
    existingUser: link.existingUser === true,
  };
}

const BIENVENIDA_CLIENTE_SUSPENDIDO =
  'El cliente de correo de este proyecto está suspendido en Mailway: no es posible enviar la configuración inicial hasta que se reactive.';

/**
 * Los errores de Mailway con un significado propio en los enlaces de
 * bienvenida, explicados para quien lo pide desde Skyway. El resto se
 * traslada tal cual (`guarded`).
 */
function errorBienvenida(err: unknown): unknown {
  if (!(err instanceof MailwayError)) return err;
  switch (err.code) {
    case 'user_exists':
      // No se dice de quién es: la administración u otro cliente, da igual a quien lo pide.
      return httpError(
        409,
        'Ese correo electrónico ya lo utiliza otra cuenta del servicio de correo y no puede recibir la configuración inicial de este cliente. Indica otro correo electrónico.',
      );
    case 'client_suspended':
      return httpError(409, BIENVENIDA_CLIENTE_SUSPENDIDO);
    case 'invite_invalid':
      return httpError(404, 'Este enlace de bienvenida ya no es válido: se ha utilizado, se ha revocado o ha caducado. Crea uno nuevo.');
    case 'invite_not_recoverable':
      return httpError(
        409,
        'Este enlace de bienvenida ya no se puede volver a mostrar. Crea uno nuevo para la misma persona: sustituirá al pendiente.',
      );
    default:
      return err;
  }
}

/**
 * Correo que se propone para el enlace de bienvenida: el de contacto del
 * cliente en Mailway o, si no lo tiene, el del propietario de la cuenta del
 * proyecto. Solo se propone (el formulario lo deja cambiar), así que un fallo
 * al consultarlo no impide nada.
 */
async function suggestedInviteEmail(project: ProjectRow, clientId: string): Promise<string | null> {
  try {
    const contacto = await getClientContactEmail(clientId);
    if (contacto) return contacto;
  } catch (err) {
    if (!(err instanceof MailwayError)) throw err;
  }
  if (!project.workspace_id) return null;
  return listWorkspaceUsers(project.workspace_id).find((u) => u.role === 'owner')?.email ?? null;
}

/**
 * Los enlaces de bienvenida solo existen en un Mailway que declara
 * `features.invites`: con uno anterior, 409 sin llamarle (como el webmail
 * automático), en lugar de un 404 de Mailway que no explica nada.
 */
async function assertInvitesSupported(): Promise<void> {
  const info = await getInfo();
  if (info.features?.invites !== true) {
    throw httpError(
      409,
      `La versión de Mailway conectada${versionMailway(info)} no permite enviar la configuración inicial. Es necesario actualizar Mailway.`,
    );
  }
}

/** Días u horas de validez, para la auditoría. */
function validez(ttlHours: number): string {
  if (ttlHours % 24 === 0) return `${ttlHours / 24} ${ttlHours === 24 ? 'día' : 'días'}`;
  return `${ttlHours} ${ttlHours === 1 ? 'hora' : 'horas'}`;
}

// ---------- registros web del fichero de zona ----------

/**
 * Dominios de los servicios del proyecto que cuelgan de la zona (el propio
 * dominio o un subdominio). Solo de ESTE proyecto: los de otros proyectos no
 * se mencionan nunca, aunque compartan dominio.
 */
function projectHostsUnder(projectId: string, zone: string): string[] {
  const apex = zone.toLowerCase();
  const out: string[] = [];
  for (const service of listServices(projectId)) {
    const domains = (service.config as { domains?: unknown }).domains;
    if (!Array.isArray(domains)) continue;
    for (const d of domains) {
      if (typeof d !== 'string') continue;
      const host = d.toLowerCase();
      if ((host === apex || host.endsWith(`.${apex}`)) && !out.includes(host)) out.push(host);
    }
  }
  return out;
}

/**
 * Registro del webmail del cliente en `webmail.<dominio>`, si está dado de
 * alta: el que indica Mailway (el CNAME recomendado o, si no, el primero). Si
 * el nombre no se puede utilizar (lo sirve un servicio de Skyway, es el del
 * panel…), no se incluye y se dice por qué. El motivo es siempre el genérico,
 * también para el administrador: el fichero de zona se entrega al cliente (y se
 * importa en su DNS), así que no puede nombrar servicios ni proyectos ajenos.
 */
async function webmailZoneRecord(
  clientId: string,
  domain: MailwayDomain,
): Promise<{ webmail: WebZoneRecord | null; webmailNote: string | null }> {
  const hostname = webmailHostname(domain);
  const found = await findWebmail(clientId, hostname);
  if (!found) return { webmail: null, webmailNote: null };
  const conflicto = webmailHostError(hostname, { isAdmin: false });
  if (conflicto) return { webmail: null, webmailNote: `No se incluye ${hostname}: ${conflicto}` };
  const view = await getWhitelabelDomain(found.id);
  ownedWebmail(view.domain, clientId, hostname);
  const instrucciones = publicInstructions(view.instructions).filter(
    (i) => (i.type === 'CNAME' || i.type === 'A') && i.name.toLowerCase().replace(/\.$/, '') === hostname,
  );
  const elegida = instrucciones.find((i) => i.recommended) ?? instrucciones[0];
  if (!elegida) return { webmail: null, webmailNote: `No se incluye ${hostname}: Mailway no ha indicado su registro.` };
  return { webmail: { name: hostname, type: elegida.type as 'A' | 'CNAME', value: elegida.value }, webmailNote: null };
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
    // Nombres que fueron de la instancia: siguen reservados hasta liberarlos aquí.
    previousHosts: mailwayPreviousHosts(),
  };
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

/** Enlace de bienvenida: los mismos límites que Mailway (validez de 1 hora a 30 días; 7 días si no se indica). */
const inviteSchema = z.object({
  email: z
    .string({ required_error: 'Indica el correo electrónico de la persona de contacto.' })
    .trim()
    .toLowerCase()
    .email('El correo electrónico de la persona de contacto no es válido')
    .max(254, 'El correo electrónico admite como máximo 254 caracteres'),
  name: z.string().trim().max(80, 'El nombre admite como máximo 80 caracteres').optional(),
  ttlHours: z
    .number({ invalid_type_error: 'La validez del enlace debe indicarse en horas.' })
    .int('La validez del enlace debe indicarse en horas enteras')
    .min(1, 'La validez mínima del enlace es de 1 hora')
    .max(720, 'La validez máxima del enlace es de 30 días (720 horas)')
    .optional(),
});

/**
 * Imagen que tiene en marcha un servicio de repositorio, para volver a
 * desplegarlo tras conectar el correo sin compilar la cabeza de la rama: lo
 * que cambia son variables. Desplegar la cabeza publicaba commits que nadie
 * había pedido desplegar (con el despliegue automático desactivado) y, mientras
 * compilaba, el contenedor seguía con la credencial ya revocada; si la
 * compilación fallaba, se quedaba con ella. Es la misma regla que la baja del
 * cambio de dominio (`imagenEnMarcha` de `domainmigration.ts`).
 *
 * Sin imagen (servicio de imagen Docker, nunca desplegado bien, imagen purgada)
 * o con otro despliegue en cola o en curso (que terminaría después con una
 * versión más nueva, y esta la desharía), un despliegue normal.
 */
async function imagenEnMarcha(service: ServiceRow): Promise<string | undefined> {
  if (service.type !== 'git') return undefined;
  if (activeDeploymentIdsForServices([service.id]).length > 0) return undefined;
  const tag = lastSuccessfulImage(service.id);
  if (!tag) return undefined;
  try {
    return (await imageExists(tag)) ? tag : undefined;
  } catch {
    return undefined;
  }
}

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
    // Más lo propio de Skyway: las redirecciones y la prepublicación del cambio
    // de dominio (redirecciones.ts) y los routers de los dominios adicionales
    // del panel (SKYWAY_DOMAIN_EXTRA, ver paneldomain.ts). Van aquí porque es el
    // único proveedor dinámico que Traefik ya lee, y salen aunque Mailway no
    // esté configurado: `mailwayTraefikConfig` nunca lanza.
    const config = mezclarConfiguracion(
      await mailwayTraefikConfig(req.log),
      configuracionTraefikSkyway(),
      panelExtraTraefikConfig(),
    );
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
      guardarConfigMailway(mailwayConfigSchema.parse(req.body ?? {}), (action, target) => audit(req, action, target));
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
      // Desconectar no cambia el DNS: los nombres de la instancia siguen
      // apuntando aquí y quedan reservados como anteriores.
      const nombres = mailwayCurrentHosts();
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
      rememberPreviousHosts(nombres);
      resetMailwayCaches();
      forgetMailwayTraefik();
      audit(req, 'mailway_disconnected', { type: 'system', id: 'mailway' });
      return { ok: true, config: configView() };
    });

    /**
     * Libera un nombre que fue de la instancia de Mailway (un servidor de
     * correo o un webmail anteriores): a partir de ahí, un servicio de
     * cualquier proyecto puede asignárselo. Solo cuando ya no se usa: si su
     * DNS sigue apuntando aquí y los titulares lo tienen configurado, quien se
     * lo asigne recibe su tráfico. Con sesión de navegador, como el resto de
     * la configuración del correo.
     */
    secured.delete('/api/mailway/previous-hosts/:host', { preHandler: [requireAdmin, requireSession] }, async (req, reply) => {
      const { host } = z.object({ host: z.string().trim().toLowerCase().min(1).max(253) }).parse(req.params);
      if (!releaseMailwayPreviousHost(host)) {
        return reply.code(404).send({ error: `${host} no está entre los nombres anteriores de Mailway.` });
      }
      audit(req, 'mailway_host_released', { type: 'system', id: 'mailway', detail: host });
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
      guarded(async (req) =>
        probarConexionMailway(mailwayConfigSchema.parse(req.body ?? {}), { sesionNavegador: req.authMethod === 'cookie' }),
      ),
    );

    // ---------- correo de un proyecto ----------

    /**
     * Estado del correo del proyecto. Si Skyway no tiene el vínculo pero
     * Mailway conserva un cliente con la referencia propia del proyecto (base
     * del panel restaurada, vínculo creado desde otro Skyway), se recupera
     * solo. Con la de su cuenta no: la comparten todos los proyectos de la
     * cuenta y recuperarlo activaría el correo en proyectos que nunca lo
     * activaron (al activarlo, el proyecto se vincula a ese mismo cliente).
     * `account` dice si el cliente es el de la cuenta y con qué otros
     * proyectos se comparte. `suggestedDomains` propone, para activar el
     * correo o añadir un dominio, los dominios registrables de los servicios
     * del proyecto.
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
          return { ...base, linked: false, panelUrl: base.configured ? publicPanelUrl() : null, features: null, suggestedDomains: [] };
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
          if (client && listMailwayLinksByClient(client.id).length === 0) {
            // Es el cliente propio del proyecto: lo que tenga con el nombre de antes es suyo.
            link = insertMailwayLink(
              { project_id: id, client_id: client.id, client_name: client.name, created_by: null },
              { legacyCredentials: true },
            );
            writePreviousClient(id, null);
            audit(req, 'mailway_link_restored', { type: 'project', id, detail: `${project.name} → ${client.name}` });
          }
        }
        if (!link) {
          return { ...base, linked: false, panelUrl: publicPanelUrl(), features: featuresOf(), suggestedDomains: suggestedDomains(id, []) };
        }

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
              ? `No se encuentra en Mailway el cliente «${link.client_name}» vinculado a este proyecto. Si se ha eliminado, desactiva el correo y vuelve a activarlo.`
              : isRefError(err)
                ? err.message
                : null;
          if (notice) {
            return {
              ...base,
              linked: true,
              link: publicLink(link),
              notice,
              account: null,
              panelUrl: publicPanelUrl(),
              features: featuresOf(),
              suggestedDomains: [],
            };
          }
          throw err;
        }
        // Quien gestiona el proyecto, al abrir su correo, repara al momento las
        // contraseñas de aplicación que Mailway haya invalidado al cambiar de
        // motor, sin esperar al ciclo de fondo. Con un plazo: si Mailway tarda,
        // la renovación sigue por detrás y la vista no la espera.
        if (base.canManage) {
          const renovacion = renovarCorreoDelProyecto(project, link, summary, (msg) => req.log.warn(msg));
          if (await withTimeout(renovacion, RENOVACION_VISTA_MS, () => false)) {
            const leido = summary;
            summary = await ownedSummary(project, link).catch(() => leido);
          }
        }
        const account = await mailAccount(req, project, user, summary);
        // El nombre que recuerdan los vínculos es el de Mailway, que es la fuente.
        setMailwayLinkClientName(summary.client.id, summary.client.name);
        return {
          ...base,
          linked: true,
          link: publicLink({ ...link, client_name: summary.client.name }),
          summary: publicSummary(summary, { isAdmin }),
          account,
          panelUrl: publicPanelUrl(),
          features: featuresOf(),
          suggestedDomains: suggestedDomains(id, summary.domains.map((d) => d.domain), dominiosQueSeVan(summary)),
          // Renovaciones automáticas de las contraseñas de aplicación de sus servicios.
          renewals: renewalsOfProject(id),
        };
      }),
    );

    /**
     * Opciones del formulario de activación: planes (el administrador elige
     * entre todos; el propietario ve el que se le asignará), clientes para
     * vincular (solo el administrador) y el cliente anterior del proyecto, si
     * lo hay y se puede recuperar. En un proyecto de una cuenta, `workspace`
     * dice qué cliente tiene ya la cuenta: si tiene uno, activar el correo
     * vincula el proyecto a él (no se elige plan, nombre ni cliente).
     */
    secured.get(
      '/api/projects/:id/mail/options',
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        if (!mailwayConfigured()) throw httpError(409, NO_CONFIGURADO);
        const workspace = workspaceOfMailProject(ctx.project);
        const cuenta = workspace ? await workspaceClient(workspace) : null;
        const all = await listPlans();
        const def = defaultPlan(all);
        const plans = (ctx.isAdmin ? all : def ? [def] : []).map(publicPlan);
        let clients: { id: string; name: string; available: boolean; linkedTo: string | null }[] = [];
        // Con el cliente de la cuenta ya creado no se vincula otro: la cuenta tiene uno solo.
        if (ctx.isAdmin && !cuenta) {
          const links = listMailwayLinks();
          clients = (await listClients()).map((c) => {
            const motivo = clientUnavailable(ctx.project, c, links.filter((l) => l.client_id === c.id));
            return { id: c.id, name: c.name, available: !motivo, linkedTo: motivo };
          });
        }
        const prev = cuenta ? null : readPreviousClient(ctx.project.id);
        let previous: { clientName: string; available: boolean; reason: string | null } | null = null;
        if (prev) {
          const st = await previousClientStatus(ctx.project, prev);
          previous = st.available
            ? { clientName: st.name, available: true, reason: null }
            : { clientName: prev.clientName, available: false, reason: st.reason };
        }
        return {
          plans,
          clients,
          defaultPlanId: def?.id ?? null,
          canChoosePlan: ctx.isAdmin && !cuenta,
          defaultName: defaultClientName(ctx.project, workspace),
          previous,
          workspace: workspace
            ? {
                name: workspace.name,
                client: cuenta ? { name: cuenta.name, planName: all.find((p) => p.id === cuenta.planId)?.name ?? null } : null,
              }
            : null,
        };
      }),
    );

    /**
     * Activa el correo del proyecto. En un proyecto de una cuenta, el cliente
     * es el de la cuenta (`skyway:workspace:<id>`, con el nombre de la
     * cuenta): si ya existe, el proyecto se vincula a él sin crear nada; si
     * no, se crea (o se recupera el anterior o, un administrador, vincula uno
     * existente) y pasa a ser el de la cuenta. Sin cuenta, como siempre: un
     * cliente propio con la referencia del proyecto.
     */
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
        // Vincular un cliente que ya existe da a este proyecto sus buzones: solo el administrador.
        if (body.mode === 'existing' && !ctx.isAdmin) {
          return reply.code(403).send({ error: 'Solo un administrador puede vincular un cliente existente de Mailway.' });
        }
        const workspace = workspaceOfMailProject(ctx.project);
        if (ctx.project.workspace_id && !workspace) throw httpError(409, 'No se encuentra la cuenta del proyecto.');
        const ref = clientRefFor(ctx.project);

        let client: { id: string; name: string } | null = null;
        let created = false;
        let detalle = '';
        // Credenciales con el nombre de antes: solo en un cliente que era de este proyecto.
        let legacyCredentials = false;
        const cuenta = workspace ? await workspaceClient(workspace) : null;
        if (cuenta && workspace) {
          // La cuenta ya tiene su cliente: es el de todos sus proyectos.
          const pedido = body.mode === 'existing' ? body.clientId : body.mode === 'previous' ? readPreviousClient(ctx.project.id)?.clientId : cuenta.id;
          if (pedido !== cuenta.id) {
            throw httpError(
              409,
              `La cuenta «${workspace.name}» ya tiene su cliente de correo en Mailway («${cuenta.name}»). Activa el correo para vincular el proyecto a ese cliente.`,
            );
          }
          client = cuenta;
          detalle = ` (cliente de la cuenta «${workspace.name}»)`;
        } else if (body.mode === 'create') {
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
            // En una cuenta, el nombre es el de la cuenta: no se elige.
            name: workspace ? defaultClientName(ctx.project, workspace) : body.name || defaultClientName(ctx.project, undefined),
            ...(planId ? { planId } : {}),
            ...(body.contactEmail ? { contactEmail: body.contactEmail } : {}),
          });
          client = res.client;
          created = !!res.created;
          if (created) detalle = workspace ? ` (cliente nuevo de la cuenta «${workspace.name}»)` : ' (cliente nuevo)';
        } else if (body.mode === 'previous') {
          const prev = readPreviousClient(ctx.project.id);
          if (!prev) throw httpError(404, 'Este proyecto no tiene ningún cliente de correo anterior que recuperar.');
          const st = await previousClientStatus(ctx.project, prev);
          if (!st.available) throw httpError(409, st.reason);
          // En una cuenta pasa a ser el cliente de la cuenta, con sus dominios y buzones.
          client = st.externalRef === ref ? { id: prev.clientId, name: st.name } : await linkClient(prev.clientId, ref);
          legacyCredentials = true;
          detalle = ' (cliente anterior recuperado)';
        } else {
          if (linkedElsewhere(ctx.project, listMailwayLinksByClient(body.clientId))) throw linkedElsewhereError(ctx.project);
          const current = (await listClients()).find((c) => c.id === body.clientId);
          if (!current) throw httpError(404, 'Cliente de Mailway no encontrado');
          if (current.externalRef && !acceptedClientRefs(ctx.project).includes(current.externalRef)) {
            throw httpError(409, `El cliente «${current.name}» ya está vinculado a otra integración (${current.externalRef}).`);
          }
          // En una cuenta pasa a ser el de la cuenta. Si otro cliente ya tiene
          // esa referencia, Mailway responde 409 «external_ref_in_use» con el
          // motivo, que se traslada tal cual.
          client = current.externalRef === ref ? current : await linkClient(body.clientId, ref);
          if (workspace) detalle = ` (cliente de la cuenta «${workspace.name}»)`;
        }
        if (!client?.id) throw new MailwayError('http', 'La respuesta de Mailway no incluye el cliente.', 502);
        // Por si entretanto lo ha tomado un proyecto que no es de la cuenta.
        if (linkedElsewhere(ctx.project, listMailwayLinksByClient(client.id))) throw linkedElsewhereError(ctx.project);
        const clientName = workspace ? await nombreDeCuenta(req, client.id, client.name, workspace) : client.name;
        const link = insertMailwayLink(
          { project_id: ctx.project.id, client_id: client.id, client_name: clientName, created_by: req.authActor ?? null },
          { legacyCredentials },
        );
        writePreviousClient(ctx.project.id, null);
        setSetting(ownClientKey(ctx.project.id), null);
        audit(req, 'mailway_linked', {
          type: 'project',
          id: ctx.project.id,
          detail: `${ctx.project.name} → ${clientName}${detalle}`,
        });
        reply.code(201);
        return { ok: true, created, link: publicLink(link) };
      }),
    );

    /**
     * Desactiva el correo: solo se retira el vínculo de este proyecto; el
     * cliente y sus buzones siguen en Mailway. El cliente de una cuenta
     * conserva la referencia de la cuenta (aunque fuera el último proyecto que
     * lo usaba): al volver a activar el correo, el proyecto se vincula de nuevo
     * a él. Un cliente propio, como siempre: su referencia solo se retira si
     * todavía la lleva, y se recuerda para poder recuperarlo al reactivar.
     */
    secured.delete(
      '/api/projects/:id/mail/link',
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const link = requireLink(ctx.project);
        const cambioAbierto = bloqueoPorCambioConCorreo(ctx.project.id, 'desactivar el correo');
        if (cambioAbierto) return reply.code(409).send({ error: cambioAbierto, code: 'migration_open' });
        const released = await releaseProjectClient(ctx.project.id, link.client_id);
        const workspace = workspaceOfMailProject(ctx.project);
        const deLaCuenta = !released && !!workspace && (await getClientByRef(workspaceExternalRef(workspace.id)))?.id === link.client_id;
        deleteMailwayLink(ctx.project.id);
        forgetProjectRenewals(ctx.project.id);
        setSetting(ownClientKey(ctx.project.id), null);
        writePreviousClient(ctx.project.id, deLaCuenta ? null : { clientId: link.client_id, clientName: link.client_name });
        audit(req, 'mailway_unlinked', {
          type: 'project',
          id: ctx.project.id,
          detail:
            `${ctx.project.name} ✕ ${link.client_name}` +
            (deLaCuenta && workspace
              ? ` (sigue siendo el cliente de la cuenta «${workspace.name}»)`
              : released
                ? ''
                : ' (la referencia en Mailway ya no era de este proyecto: no se ha modificado)'),
        });
        return { ok: true, released, workspaceClient: deLaCuenta };
      }),
    );

    // ---------- dominios ----------

    /**
     * Antes de dar de alta un dominio de correo: dónde recibe hoy el correo
     * (sus MX) y si al administrador se le ofrece el DNS automático. No da de
     * alta nada ni llama a Mailway más que para saber su servidor de correo:
     * la interfaz lo usa para pedir confirmación cuando el dominio recibe en
     * otro proveedor (añadirlo aquí no mueve el correo, pero el DNS automático
     * y lo que se envía desde este servidor sí le afectan).
     */
    secured.get(
      '/api/projects/:id/mail/domain-check',
      { preHandler: rateLimit({ max: 30, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply);
        if (!ctx) return reply;
        requireLink(ctx.project);
        const { domain } = z.object({ domain: domainSchema }).parse(req.query ?? {});
        if (!domain.includes('.')) throw httpError(400, 'Indica un dominio completo, por ejemplo: tuempresa.com');
        const { recepcion, mx } = await recepcionDe(domain);
        const dnsAutomatico = ctx.isAdmin ? (await dnsAutomaticoCorreo('Configurar en Cloudflare')).pedir : false;
        return { domain, recepcion, mx, dnsAutomatico };
      }),
    );

    secured.post(
      '/api/projects/:id/mail/domains',
      { preHandler: rateLimit({ max: 20, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply);
        if (!ctx) return reply;
        const link = requireLink(ctx.project);
        // `autoDns` solo cuenta para el administrador: true lo pide, false no;
        // sin él, Skyway lo decide (véase abajo).
        const body = z.object({ domain: domainSchema, autoDns: z.boolean().optional() }).parse(req.body);
        if (!body.domain.includes('.')) throw httpError(400, 'Indica un dominio completo, por ejemplo: tuempresa.com');
        assertAccountActive(ctx.project);
        // Como en el resto de rutas: el cliente tiene que seguir siendo el del proyecto.
        const summary = await ownedSummary(ctx.project, link);
        assertClientActive(summary);
        // DNS automático en Cloudflare solo para el administrador (con las
        // cuentas de Mailway, también las de la instancia) y solo si Mailway
        // garantiza que se limita a crear lo que falta. Para cualquier otro,
        // `autoDns: false` y `soloCliente`: el alta de un cliente nunca escribe
        // en las zonas del operador.
        let dnsCorreo: { pedir: boolean; motivo: string | null } = { pedir: false, motivo: null };
        if (ctx.isAdmin && body.autoDns !== false) {
          dnsCorreo = await dnsAutomaticoCorreo('Configurar en Cloudflare');
          // Sin decisión expresa, un dominio que recibe hoy en otro proveedor no
          // se toca: un Mailway hasta la 1.2 crearía su SPF y un DMARC
          // p=reject que rompen el correo saliente del proveedor actual, de la
          // web en otro hosting y de herramientas como Mailchimp.
          if (dnsCorreo.pedir && body.autoDns === undefined) {
            const { recepcion, mx } = await recepcionDe(body.domain);
            if (recepcion === 'otro') {
              dnsCorreo = {
                pedir: false,
                motivo:
                  `${body.domain} recibe hoy el correo en ${mx.join(', ')}, así que no se ha configurado el DNS en Cloudflare para no cambiar nada del proveedor actual. ` +
                  'Revisa los cambios con «Configurar en Cloudflare» cuando vayas a trasladar el correo.',
              };
            } else if (recepcion === 'desconocido') {
              // Sin saber dónde recibe (el DNS no respondió o no se conoce el
              // servidor de correo), lo prudente es lo mismo que con otro
              // proveedor: el DNS automático puede romper uno que no se ve.
              dnsCorreo = {
                pedir: false,
                motivo:
                  `No se ha podido comprobar dónde recibe hoy el correo ${body.domain}, así que no se ha configurado el DNS en Cloudflare para no cambiar nada de un proveedor que pudiera tener. ` +
                  'Revisa los cambios con «Configurar en Cloudflare».',
              };
            }
          }
        }
        const created = await createDomain(link.client_id, body.domain, { soloCliente: !ctx.isAdmin, autoDns: dnsCorreo.pedir });
        const cf = created.cloudflare;
        if (ctx.isAdmin && cf) reservarCreadosPorMailway(cf.applied, ctx.project.id);
        audit(req, 'mailway_domain_added', {
          type: 'project',
          id: ctx.project.id,
          detail:
            `${ctx.project.name}: ${body.domain}` +
            (cf ? ` (DNS en Cloudflare: ${cf.applied.length} cambio(s)${cf.errors.length ? `, ${cf.errors.length} error(es)` : ''}${cf.skipped.length ? `, ${cf.skipped.length} sin aplicar` : ''})` : ''),
        });
        reply.code(201);
        return {
          domain: publicDomain(created.domain),
          cloudflare: cf ? publicAutoDns(cf) : null,
          cloudflareReason: created.cloudflareReason ?? dnsCorreo.motivo,
        };
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

    /**
     * ¿El dominio recibe ya el correo en otro proveedor? Lo mide Mailway en el
     * DNS público. La pestaña Correo lo consulta para avisar de lo que pasa
     * mientras el MX siga fuera (lo que se envía a ese dominio desde aquí, el
     * fichero de zona, el DNS automático).
     */
    secured.get(
      '/api/projects/:id/mail/domains/:domainId/conflicto',
      { preHandler: rateLimit({ max: 60, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply);
        if (!ctx) return reply;
        const { domainId } = req.params as { domainId: string };
        const summary = await ownedSummary(ctx.project, requireLink(ctx.project));
        ownDomain(summary, domainId);
        return publicConflicto(await getDomainConflict(domainId));
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
        const link = requireLink(ctx.project);
        const summary = await ownedSummary(ctx.project, link);
        const domain = ownDomain(summary, domainId);
        // Quien no es administrador de Skyway solo puede usar las cuentas de
        // Cloudflare del propio cliente, nunca las del operador.
        const bloqueo = ctx.isAdmin ? null : await bloqueoCuentaAjena(link.client_id, domain);
        if (bloqueo) {
          return {
            available: false,
            reason: bloqueo,
            account: null,
            zone: null,
            changes: [],
            summary: { create: 0, update: 0, keep: 0, conflict: 0 },
            porRegistro: false,
            copia: null,
          };
        }
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
            // null: el Mailway conectado no lo dice (hasta la 1.2).
            reemplazable: typeof c.reemplazable === 'boolean' ? c.reemplazable : null,
            alCambiar: c.alCambiar === true,
          })),
          summary: plan.summary ?? { create: 0, update: 0, keep: 0, conflict: 0 },
          // Un Mailway que elige los conflictos uno a uno y guarda copia manda
          // `copia` (aunque sea null); con uno anterior, solo «reemplazar todos».
          porRegistro: 'copia' in plan,
          copia: publicCopia(plan.copia),
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
        const body = z
          .object({
            replaceConflicts: z.boolean().optional(),
            // Conflictos que se reemplazan, uno a uno («TIPO:nombre», p. ej.
            // «MX:empresa.com»). Un Mailway hasta la 1.2 lo ignora y no
            // reemplaza ninguno, que es lo seguro.
            replace: z
              .array(z.string().trim().regex(/^[A-Za-z]{1,10}:[^\s:]{1,253}$/, 'Cada elemento de «replace» debe ser «TIPO:nombre».'))
              .max(100)
              .optional(),
          })
          .parse(req.body ?? {});
        const link = requireLink(ctx.project);
        const summary = await ownedSummary(ctx.project, link);
        const domain = ownDomain(summary, domainId);
        const bloqueo = ctx.isAdmin ? null : await bloqueoCuentaAjena(link.client_id, domain);
        if (bloqueo) throw httpError(409, bloqueo);
        const result = await applyCloudflare(domainId, {
          replaceConflicts: body.replaceConflicts,
          replace: body.replace,
          soloCliente: !ctx.isAdmin,
        });
        const applied = Array.isArray(result.applied) ? result.applied : [];
        if (ctx.isAdmin) reservarCreadosPorMailway(applied, ctx.project.id);
        const errors = Array.isArray(result.errors) ? result.errors : [];
        audit(req, 'mailway_dns_applied', {
          type: 'project',
          id: ctx.project.id,
          detail: (
            `${domain.domain}: ${applied.length} cambio(s)${errors.length ? `, ${errors.length} error(es)` : ''}` +
            (body.replaceConflicts ? ' (reemplazando conflictos)' : body.replace?.length ? ` (reemplazando ${body.replace.join(', ')})` : '')
          ).slice(0, 500),
        });
        return {
          applied: applied.map((a) => ({ action: a.action, type: a.type, name: a.name })),
          errors: errors.map((e) => ({ type: e.type, name: e.name, error: e.error })),
          domain: result.domain ? publicDomain(result.domain) : null,
        };
      }),
    );

    /**
     * Deshace el último cambio en Cloudflare (Mailway posterior a la 1.2): vuelve a crear lo
     * que borraron los reemplazos y retira lo que Mailway creó en su lugar.
     * Con las mismas reglas que aplicar: quien gestiona el proyecto y, si no
     * es administrador, solo con las cuentas de Cloudflare del cliente.
     */
    secured.post(
      '/api/projects/:id/mail/domains/:domainId/cloudflare/undo',
      { preHandler: rateLimit({ max: 10, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const { domainId } = req.params as { domainId: string };
        const link = requireLink(ctx.project);
        const summary = await ownedSummary(ctx.project, link);
        const domain = ownDomain(summary, domainId);
        const bloqueo = ctx.isAdmin ? null : await bloqueoCuentaAjena(link.client_id, domain);
        if (bloqueo) throw httpError(409, bloqueo);
        const r = await undoCloudflare(domainId, { soloCliente: !ctx.isAdmin });
        const lista = (v: unknown) =>
          (Array.isArray(v) ? v : [])
            .filter((x): x is { type: string; name: string } => !!x && typeof x.type === 'string' && typeof x.name === 'string')
            .map((x) => ({ type: x.type, name: x.name }));
        const restaurados = lista(r.restaurados);
        const retirados = lista(r.retirados);
        audit(req, 'mailway_dns_undone', {
          type: 'project',
          id: ctx.project.id,
          detail: `${domain.domain}: ${restaurados.length} restaurado(s), ${retirados.length} retirado(s)`,
        });
        return { restaurados, retirados, domain: r.domain ? publicDomain(r.domain) : null };
      }),
    );

    /**
     * Fichero de zona BIND del dominio, para importarlo en el proveedor de DNS
     * (en Cloudflare: DNS → Registros → Importar y exportar). Lo genera Mailway
     * (`?nivel=obligatorios|recomendados|completo`, recomendados por defecto);
     * Skyway comprueba antes que el dominio es del cliente del proyecto,
     * retira los registros web que pudiera traer del dominio raíz y de www
     * (`stripWebRecords`) y añade, en secciones propias, los de los servicios
     * de ESTE proyecto que cuelgan del dominio y el del webmail del cliente
     * (`appendWebRecords`): un solo fichero deja la zona completa.
     */
    secured.get(
      '/api/projects/:id/mail/domains/:domainId/zonefile',
      { preHandler: rateLimit({ max: 20, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply);
        if (!ctx) return reply;
        const { domainId } = req.params as { domainId: string };
        const { nivel } = z
          .object({
            nivel: z
              .enum(ZONE_LEVELS, { errorMap: () => ({ message: 'Nivel no válido: usa obligatorios, recomendados o completo.' }) })
              .default('recomendados'),
          })
          .parse(req.query ?? {});
        const link = requireLink(ctx.project);
        const summary = await ownedSummary(ctx.project, link);
        const domain = ownDomain(summary, domainId);
        const stripped = stripWebRecords(await getZoneFile(domainId, nivel), domain.domain);
        if (stripped.removed > 0) {
          req.log.warn({ domain: domain.domain, removed: stripped.removed }, 'Mailway: registros web retirados del fichero de zona');
        }
        const { zone } = appendWebRecords(stripped.zone, domain.domain, {
          serverIp: getSetting('serverIp') || null,
          hosts: projectHostsUnder(ctx.project.id, domain.domain),
          // El webmail es un añadido: si Mailway no lo devuelve, el fichero de correo se descarga igual.
          ...(await webmailZoneRecord(link.client_id, domain).catch((err: unknown) => {
            if (!(err instanceof MailwayError)) throw err;
            return { webmail: null, webmailNote: `No se ha podido consultar el webmail en Mailway: ${err.message}` };
          })),
        });
        const fichero = `${domain.domain.replace(/[^A-Za-z0-9.-]+/g, '_')}-mailway-${nivel}.txt`;
        return reply
          .type('text/plain; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="${fichero}"`)
          .send(zone);
      }),
    );

    // ---------- webmail con el dominio del cliente ----------

    /**
     * Webmail del dominio en `webmail.<dominio>` (marca blanca de Mailway):
     * estado, registro DNS que indica Mailway y, en `conflict`, el motivo por
     * el que el nombre no se puede utilizar (lo sirve un servicio de Skyway, es
     * el del panel o uno de Mailway).
     */
    secured.get(
      '/api/projects/:id/mail/domains/:domainId/webmail',
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply);
        if (!ctx) return reply;
        const { domainId } = req.params as { domainId: string };
        const link = requireLink(ctx.project);
        const domain = ownDomain(await ownedSummary(ctx.project, link), domainId);
        const hostname = webmailHostname(domain);
        const found = await findWebmail(link.client_id, hostname);
        let webmail = null;
        if (found) {
          const view = await getWhitelabelDomain(found.id);
          webmail = publicWebmail(ownedWebmail(view.domain, link.client_id, hostname), view.instructions);
        }
        return { hostname, webmail, conflict: webmailHostError(hostname, { isAdmin: ctx.isAdmin }) };
      }),
    );

    /**
     * Da de alta `webmail.<dominio>` en la marca blanca de Mailway para el
     * cliente del proyecto. Mailway exige además que la propiedad del dominio
     * esté comprobada (400 `domain_not_verified`, con su mensaje) y limita los
     * dominios propios por cliente.
     */
    secured.post(
      '/api/projects/:id/mail/domains/:domainId/webmail',
      { preHandler: rateLimit({ max: 10, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const { domainId } = req.params as { domainId: string };
        const link = requireLink(ctx.project);
        assertAccountActive(ctx.project);
        const summary = await ownedSummary(ctx.project, link);
        assertClientActive(summary);
        const hostname = webmailHostname(ownDomain(summary, domainId));
        const conflicto = webmailHostError(hostname, { isAdmin: ctx.isAdmin });
        if (conflicto) throw httpError(409, conflicto);
        if (await findWebmail(link.client_id, hostname)) {
          throw httpError(409, `El webmail ${hostname} ya está configurado en este proyecto.`);
        }
        const res = await createWhitelabelDomain({ hostname, clientId: link.client_id });
        let created = ownedWebmail(res.domain, link.client_id, hostname);
        // Reservado ya, sin esperar a la siguiente lectura del puente: mientras
        // espera DNS, ningún servicio de otro cliente puede asignárselo.
        reserveWhitelabelHost(hostname);
        audit(req, 'mailway_webmail_created', { type: 'project', id: ctx.project.id, detail: `${ctx.project.name}: ${hostname}` });
        const auto = ctx.isAdmin ? await webmailDnsAutomatico(req, ctx.project, created.id, hostname) : null;
        // El estado tras crear el registro, solo si es ese mismo nombre y cliente
        // (si no, se queda el del alta: el webmail ya está creado).
        const tras = auto?.domain;
        if (tras && tras.clientId === link.client_id && typeof tras.hostname === 'string' && tras.hostname.toLowerCase() === hostname) {
          created = tras;
        }
        reply.code(201);
        return {
          webmail: publicWebmail(created, res.instructions),
          ...(auto ? { cloudflare: auto.cloudflare, cloudflareReason: auto.cloudflareReason } : {}),
        };
      }),
    );

    /** Comprueba el DNS y el certificado del webmail y avanza su estado. */
    secured.post(
      '/api/projects/:id/mail/domains/:domainId/webmail/verify',
      { preHandler: rateLimit({ max: 30, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply);
        if (!ctx) return reply;
        const { domainId } = req.params as { domainId: string };
        const link = requireLink(ctx.project);
        const hostname = webmailHostname(ownDomain(await ownedSummary(ctx.project, link), domainId));
        const found = await requireWebmail(link.client_id, hostname);
        const res = await verifyWhitelabelDomain(found.id);
        return {
          webmail: publicWebmail(ownedWebmail(res.domain, link.client_id, hostname), res.instructions),
          conflict: webmailHostError(hostname, { isAdmin: ctx.isAdmin }),
        };
      }),
    );

    /**
     * Crea en Cloudflare el registro del webmail. Mailway nunca sustituye un
     * registro que ya exista con otro valor: lo devuelve en `skipped`.
     */
    secured.post(
      '/api/projects/:id/mail/domains/:domainId/webmail/cloudflare',
      { preHandler: rateLimit({ max: 10, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const { domainId } = req.params as { domainId: string };
        const link = requireLink(ctx.project);
        const hostname = webmailHostname(ownDomain(await ownedSummary(ctx.project, link), domainId));
        const found = await requireWebmail(link.client_id, hostname);
        // El registro lleva el nombre a este servidor: si lo sirve un servicio de Skyway, no se crea.
        const conflicto = webmailHostError(hostname, { isAdmin: ctx.isAdmin });
        if (conflicto) throw httpError(409, conflicto);
        // Quien no es administrador de Skyway solo usa las cuentas de Cloudflare del propio cliente.
        const result = await applyWhitelabelCloudflare(found.id, { soloCliente: !ctx.isAdmin });
        const applied = Array.isArray(result.applied) ? result.applied : [];
        if (ctx.isAdmin) reservarCreadosPorMailway(applied, ctx.project.id);
        const errors = Array.isArray(result.errors) ? result.errors : [];
        const skipped = Array.isArray(result.skipped) ? result.skipped : [];
        audit(req, 'mailway_webmail_dns_applied', {
          type: 'project',
          id: ctx.project.id,
          detail:
            `${hostname}: ${applied.length} cambio(s)` +
            `${errors.length ? `, ${errors.length} error(es)` : ''}${skipped.length ? `, ${skipped.length} sin aplicar` : ''}`,
        });
        return {
          applied: applied.map((a) => ({ action: a.action, type: a.type, name: a.name })),
          errors: errors.map((e) => ({ type: e.type, name: e.name, error: e.error })),
          skipped: skipped.map((s) => ({ type: s.type, name: s.name, reason: s.reason })),
          webmail: result.domain ? publicWebmail(ownedWebmail(result.domain, link.client_id, hostname)) : null,
        };
      }),
    );

    /** Marca el webmail como principal del cliente: el que usan sus enlaces y datos de conexión. */
    secured.post(
      '/api/projects/:id/mail/domains/:domainId/webmail/primary',
      { preHandler: rateLimit({ max: 10, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const { domainId } = req.params as { domainId: string };
        const link = requireLink(ctx.project);
        const hostname = webmailHostname(ownDomain(await ownedSummary(ctx.project, link), domainId));
        const found = await requireWebmail(link.client_id, hostname);
        // El principal es la dirección que Mailway da a los titulares: nunca un nombre que sirve otro servicio.
        const conflicto = webmailHostError(hostname, { isAdmin: ctx.isAdmin });
        if (conflicto) throw httpError(409, conflicto);
        const res = await setPrimaryWebmail(found.id);
        const webmail = ownedWebmail(res.domain, link.client_id, hostname);
        audit(req, 'mailway_webmail_primary', { type: 'project', id: ctx.project.id, detail: `${ctx.project.name}: ${hostname}` });
        return { webmail: publicWebmail(webmail) };
      }),
    );

    // ---------- webmail propio (webmail automático del cliente) ----------

    /**
     * Interruptor del webmail automático del cliente del proyecto. Encendido,
     * Mailway da de alta por su cuenta `webmail.<dominio>` de cada dominio con
     * la propiedad comprobada (con su registro DNS); apagado, retira los que
     * creó solo, con ese registro, y los titulares vuelven al webmail general.
     * Mientras el interruptor global de Mailway esté apagado, el cambio se
     * guarda sin efecto (`global: false`). Encenderlo da de alta nombres, así
     * que exige la cuenta y el cliente activos; apagarlo, no. Con un Mailway
     * sin la función, 409 sin llamarle.
     */
    secured.put(
      '/api/projects/:id/mail/webmail-automatico',
      { preHandler: rateLimit({ max: 10, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const body = z
          .object({
            activo: z.boolean({
              required_error: 'Indica si el webmail automático debe estar activado.',
              invalid_type_error: 'Indica si el webmail automático debe estar activado (true o false).',
            }),
          })
          .parse(req.body ?? {});
        const link = requireLink(ctx.project);
        if (body.activo) assertAccountActive(ctx.project);
        // Como en el resto de rutas: el cliente tiene que seguir siendo el del proyecto.
        const summary = await ownedSummary(ctx.project, link);
        if (body.activo) assertClientActive(summary);
        const info = await getInfo();
        const global = info.features?.webmailAutomatico;
        if (typeof global !== 'boolean') {
          throw httpError(
            409,
            `La versión de Mailway conectada${versionMailway(info)} no permite crear el webmail automáticamente. Es necesario actualizar Mailway.`,
          );
        }
        const res = await setWebmailAutomatico(link.client_id, body.activo);
        const domains = publicWebmailDomains(res.webmailDomains, summary.domains, { isAdmin: ctx.isAdmin });
        // Reservados ya, sin esperar a la siguiente lectura del puente (como el
        // alta a mano): mientras esperan DNS, ningún servicio de otro cliente
        // puede asignárselos.
        if (res.webmailAutomatico) for (const d of domains) reserveWhitelabelHost(d.hostname);
        audit(req, 'mailway_webmail_automatico', {
          type: 'project',
          id: ctx.project.id,
          detail: `${ctx.project.name}: ${res.webmailAutomatico ? 'activado' : 'desactivado'}`,
        });
        return { automatico: res.webmailAutomatico, global: res.global ?? global, domains };
      }),
    );

    // ---------- configuración inicial (enlace de bienvenida del cliente) ----------

    /**
     * El enlace de bienvenida da a quien lo recibe un acceso propio al panel de
     * Mailway con todo el cliente del proyecto (dominios, buzones,
     * contraseñas): crearlo, verlo, revocarlo e incluso listarlos (llevan los
     * correos de contacto) exigen gestionar el proyecto. El identificador del
     * cliente sale siempre del vínculo del proyecto, y un enlace concreto se
     * busca antes entre los de ese cliente: si no es suyo, 404 sin llegar a él.
     * Con un Mailway que no declara `features.invites`, 409 sin llamarle.
     */
    secured.get(
      '/api/projects/:id/mail/invites',
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const link = requireLink(ctx.project);
        await assertInvitesSupported();
        const summary = await ownedSummary(ctx.project, link);
        const invites = await clientInvites(link.client_id);
        return {
          invites,
          suggestedEmail: await suggestedInviteEmail(ctx.project, link.client_id),
          clientName: summary.client.name,
        };
      }),
    );

    /**
     * Crea el enlace de bienvenida de la persona de contacto del cliente: con
     * él crea su acceso al panel de Mailway y entra en la puesta en marcha
     * (dominio y buzones). Sirve una sola vez y sustituye al que esa persona
     * tuviera pendiente. La URL se devuelve aquí y no se audita.
     */
    secured.post(
      '/api/projects/:id/mail/invites',
      { preHandler: rateLimit({ max: 10, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const body = inviteSchema.parse(req.body ?? {});
        const link = requireLink(ctx.project);
        await assertInvitesSupported();
        assertAccountActive(ctx.project);
        const summary = await ownedSummary(ctx.project, link);
        if (summary.client.suspended) throw httpError(409, BIENVENIDA_CLIENTE_SUSPENDIDO);
        const ttlHours = body.ttlHours ?? 168;
        let invite: MailwayInviteLink;
        try {
          invite = await createInvite(link.client_id, { email: body.email, ...(body.name ? { name: body.name } : {}), ttlHours });
        } catch (err) {
          throw errorBienvenida(err);
        }
        const url = safeHttpUrl(invite.url);
        if (!url) throw new MailwayError('http', 'Mailway ha devuelto un enlace de bienvenida no válido.', 502);
        // El enlace es una credencial: se audita para quién se creó, nunca su URL.
        audit(req, 'mailway_invite_created', {
          type: 'project',
          id: ctx.project.id,
          detail: `${ctx.project.name}: ${body.email} (válido ${validez(ttlHours)})`,
        });
        reply.code(201);
        return { invite: publicInviteLink(invite, url, { email: body.email, name: body.name ?? '' }) };
      }),
    );

    /** URL de un enlace pendiente, para volver a enviarlo. */
    secured.get(
      '/api/projects/:id/mail/invites/:inviteId/url',
      { preHandler: rateLimit({ max: 20, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const { inviteId } = req.params as { inviteId: string };
        const link = requireLink(ctx.project);
        await assertInvitesSupported();
        await ownedSummary(ctx.project, link);
        const invite = await ownInvite(link.client_id, inviteId);
        let res: MailwayInviteLink;
        try {
          res = await getInviteUrl(link.client_id, invite.id);
        } catch (err) {
          throw errorBienvenida(err);
        }
        if (res.id !== invite.id) {
          throw new MailwayError('http', 'La respuesta de Mailway no corresponde a este enlace de bienvenida.', 502);
        }
        const url = safeHttpUrl(res.url);
        if (!url) throw new MailwayError('http', 'Mailway ha devuelto un enlace de bienvenida no válido.', 502);
        audit(req, 'mailway_invite_viewed', { type: 'project', id: ctx.project.id, detail: `${ctx.project.name}: ${invite.email}` });
        // `existingUser` solo lo indica Mailway al crearlo: aquí no se sabe.
        return { invite: { ...publicInviteLink(res, url, invite), existingUser: null } };
      }),
    );

    /**
     * Revoca un enlace pendiente. Uno caducado o ya revocado no tiene nada que
     * revocar (200 sin llamar a Mailway); uno aceptado, tampoco: el acceso ya
     * existe y revocar el enlace no lo retiraría (409).
     */
    secured.delete(
      '/api/projects/:id/mail/invites/:inviteId',
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const { inviteId } = req.params as { inviteId: string };
        const link = requireLink(ctx.project);
        await assertInvitesSupported();
        await ownedSummary(ctx.project, link);
        const invite = await ownInvite(link.client_id, inviteId);
        if (invite.status === 'accepted') {
          throw httpError(409, 'Este enlace de bienvenida ya se ha utilizado: la persona de contacto ya tiene su acceso al panel de Mailway.');
        }
        if (invite.status !== 'pending') return { ok: true, revoked: false };
        await revokeIgnoringGone(() => revokeInvite(link.client_id, invite.id));
        audit(req, 'mailway_invite_revoked', { type: 'project', id: ctx.project.id, detail: `${ctx.project.name}: ${invite.email}` });
        return { ok: true, revoked: true };
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
                'Nombre de buzón no válido: usa letras minúsculas, números, puntos, guiones o guiones bajos, y empieza y termina por una letra o un número',
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
     * Nombres con los que el servicio recibiría el correo en cada modo, sin
     * crear nada: los que el servicio espera (`skyway.json` o `.env.example`),
     * los de siempre para lo que no nombra y, en `kept`, los que tienen un
     * valor puesto a mano y no se tocarían. Así la pestaña lo dice antes de
     * conectar. `credentialNames` son los nombres con los que se reconoce la
     * credencial de Skyway del servicio en ese modo (en un proyecto de una
     * cuenta llevan también el del proyecto): con ellos la pestaña sabe, sin
     * repetir la regla, si conectar revoca una credencial que el contenedor en
     * marcha está usando. `sinDominio` (ni dominios ni ruta de healthcheck:
     * casi siempre un bot o un worker) le sirve para recomendar la API de
     * envío. `roleNames` dice qué variable lleva cada papel (la primera, si
     * hay varias): la ayuda del modo API y su ejemplo nombran las que el
     * servicio espera, no siempre `MAILWAY_API_URL` y `MAILWAY_API_KEY`.
     */
    secured.get(
      '/api/projects/:id/mail/connect/preview',
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply);
        if (!ctx) return reply;
        const query = z
          .object({ serviceId: z.string().trim().min(1).max(100), mode: z.enum(['smtp', 'api']).default('smtp') })
          .parse(req.query ?? {});
        const service = serviceOfProject(ctx.project.id, query.serviceId);
        const link = requireLink(ctx.project);
        // Solo para comparar valores no secretos (servidor, puerto): sin red si no se conoce aún.
        const names = mailConnectNames(service, query.mode, knownMailValues(cachedInfo(), query.mode, null), false);
        const config = service.config as { needs?: { mail?: { mode: string } | null }; domains?: string[]; healthcheckPath?: string | null };
        const needs = service.type === 'git' ? config.needs : undefined;
        return {
          mode: query.mode,
          suggestedMode: needs?.mail?.mode ?? null,
          keys: names.targets.map((t) => t.name),
          kept: names.kept,
          secretPlaced: names.secretPlaced,
          // Servidor, puerto o URL de otro proveedor puestos a mano: conectar respondería 409.
          conflicts: names.conflicts,
          credentialNames: credentialNames(service, query.mode, link),
          sinDominio: (config.domains ?? []).length === 0 && !config.healthcheckPath?.trim(),
          roleNames: names.targets.reduce<Record<string, string>>((acc, t) => {
            if (!(t.role in acc)) acc[t.role] = t.name;
            return acc;
          }, {}),
        };
      }),
    );

    /**
     * Crea en Mailway una credencial de envío para el buzón y la escribe en las
     * variables del servicio con los nombres que el servicio espera (ver
     * `mailConnectNames`), sin pisar ninguna que alguien haya puesto a mano.
     * Devuelve solo los NOMBRES: los valores son secretos y ya están donde
     * tienen que estar. La credencial del mismo tipo que Skyway creó antes para
     * este servicio se revoca. Con el turno de las credenciales del servicio:
     * una renovación automática en marcha sobre él termina antes, y el resumen
     * se lee después, con lo que haya dejado. Con `redeploy`, la versión en
     * marcha con las variables nuevas (ver `imagenEnMarcha`).
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
        const service = serviceOfProject(ctx.project.id, body.serviceId);
        assertAccountActive(ctx.project);
        const link = requireLink(ctx.project);
        // Antes de conectar, que sube la revisión de la configuración: después
        // ya no se distingue lo que estaba pendiente de lo que escribe esto.
        const habiaPendientes = servicesWithPendingChanges([service]).has(service.id);
        const { keys, kept, revoked, mailbox } = await withMailCredentialLock(service.id, async () => {
          const summary = await ownedSummary(ctx.project, link);
          assertClientActive(summary);
          const box = ownMailbox(summary, body.mailboxId);
          const info = await getInfo();
          const r = await connectServiceMail({ project: ctx.project, link, summary, service, mailbox: box, mode: body.mode, info });
          return { ...r, mailbox: box };
        });

        let deploymentId: string | null = null;
        let imagen: string | undefined;
        if (body.redeploy) {
          imagen = habiaPendientes ? undefined : await imagenEnMarcha(service);
          markManualAction(service.id);
          deploymentId = triggerDeploy(service.id, 'mailway', imagen ? { imageTag: imagen } : {}).id;
        }
        audit(req, 'mailway_service_connected', {
          type: 'service',
          id: service.id,
          detail:
            `${service.name} ← ${mailbox.email} (${body.mode === 'smtp' ? 'SMTP' : 'API'}): ${keys.join(', ')}` +
            `${kept.length ? ` · sin tocar (puestas a mano): ${kept.join(', ')}` : ''}` +
            `${revoked ? ` · ${revoked} credencial(es) anterior(es) revocada(s)` : ''}` +
            `${body.redeploy ? (imagen ? ' · despliegue iniciado con la versión en marcha' : ' · despliegue iniciado') : ''}`,
        });
        // `rebuild`: había otros cambios sin desplegar, y «Desplegar ahora»
        // (`/mail/redeploy`) tiene que compilar en vez de volver a desplegar la
        // versión en marcha, como habría hecho la casilla.
        return { ok: true, keys, kept, needsRedeploy: !body.redeploy, deploymentId, revoked, rebuild: habiaPendientes };
      }),
    );

    /**
     * «Desplegar ahora» del resultado de conectar sin volver a desplegar: lo
     * mismo que habría hecho la casilla «Volver a desplegar ahora», la versión
     * en marcha con las variables nuevas (origen `mailway`). Antes el botón
     * llamaba al despliegue normal, que compila la cabeza de la rama: publicaba
     * commits que nadie había pedido y, si la compilación fallaba, el servicio
     * seguía con la credencial revocada. Con `rebuild` (había otros cambios sin
     * desplegar al conectar) o sin imagen en marcha, compila.
     */
    secured.post(
      '/api/projects/:id/mail/redeploy',
      { preHandler: rateLimit({ max: 20, windowMs: 60_000 }) },
      guarded(async (req, reply) => {
        const ctx = projectCtx(req, reply, { manage: true });
        if (!ctx) return reply;
        const body = z
          .object({
            serviceId: z.string().trim().min(1).max(100),
            rebuild: z.boolean().optional().default(false),
          })
          .parse(req.body);
        const service = serviceOfProject(ctx.project.id, body.serviceId);
        assertAccountActive(ctx.project);
        const imagen = body.rebuild ? undefined : await imagenEnMarcha(service);
        markManualAction(service.id);
        const deployment = triggerDeploy(service.id, 'mailway', imagen ? { imageTag: imagen } : {});
        audit(req, 'mailway_service_redeploy', {
          type: 'service',
          id: service.id,
          detail: `${service.name}${imagen ? ' (versión en marcha)' : ''}`,
        });
        reply.code(202);
        return { deployment, imagenEnMarcha: !!imagen };
      }),
    );
  });
}
