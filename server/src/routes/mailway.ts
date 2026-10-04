import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { parse as parseDomain } from 'tldts';
import { z } from 'zod';
import { assertProjectAccess, assertProjectManage, canManageProject, currentUser, requireAdmin, requireAuth, requireSession } from '../auth';
import { audit } from '../audit';
import {
  deleteMailwayLink,
  getMailwayLink,
  getMailwayLinkByClient,
  getProject,
  getService,
  getSetting,
  insertMailwayLink,
  listDomainMigrations,
  listMailwayLinks,
  listServices,
  setSetting,
  reservarNombresMailway,
} from '../db';
import { triggerDeploy } from '../deploy/deployer';
import { panelDomains, webmailHostError } from '../domainguard';
import { consultarMx } from '../domains';
import {
  MAILWAY_SETTING,
  MailwayApiKeyInfo,
  MailwayAutoDnsResult,
  MailwayAppPasswordInfo,
  MailwayConflicto,
  MailwayCopiaCambio,
  MailwayDnsCheck,
  MailwayDnsInstruction,
  MailwayDomain,
  MailwayError,
  MailwayInfo,
  MailwayMailbox,
  MailwayPlan,
  MailwaySummary,
  MailwayWhitelabelDomain,
  WebZoneRecord,
  ZONE_LEVELS,
  appendWebRecords,
  applyCloudflare,
  applyWhitelabelCloudflare,
  cachedInfo,
  createDomain,
  createMailbox,
  createSetupLink,
  createWhitelabelDomain,
  deleteMailbox,
  ensureClient,
  fusionarSpf,
  getClientByRef,
  getCloudflarePlan,
  getDomainConflict,
  getDomainDns,
  getInfo,
  getSummary,
  getWhitelabelDomain,
  getZoneFile,
  internalPanelUrl,
  linkClient,
  listClientCloudflareAccounts,
  listClients,
  listPlans,
  listWhitelabelDomains,
  mailwayConfigured,
  mailwayCurrentHosts,
  mailwayPreviousHosts,
  mailwayReservedHosts,
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
  safeHttpUrl,
  setPrimaryWebmail,
  stripWebRecords,
  undoCloudflare,
  verifyDomain,
  verifyWhitelabelDomain,
} from '../mailway';
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
  httpError,
  isRefError,
  knownMailValues,
  mailConnectNames,
  ownedSummary,
  requireLink,
  revokeIgnoringGone,
  serviceOfProject,
} from '../mailconnect';
import { LOCAL_PART_RE } from '../mailenv';
import { guardarConfigMailway, mailwayConfigSchema, probarConexionMailway } from '../mailwayconfig';
import { markManualAction } from '../monitor';
import { isWorkspaceActive, moduleAllowedForProject, workspaceOfProject } from '../quota';
import { rateLimit } from '../ratelimit';
import { MailwayLinkRow, ProjectRow, UserRow } from '../types';
import { domainSchema } from './services';

const MODULO_INACTIVO = 'El módulo «Correo» no está activo en este workspace.';

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
     * Mailway conserva un cliente con la referencia del proyecto (base del
     * panel restaurada, vínculo creado desde otro Skyway), se recupera solo.
     * `suggestedDomains` propone, para activar el correo o añadir un dominio,
     * los dominios registrables de los servicios del proyecto.
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
          if (client && !getMailwayLinkByClient(client.id)) {
            link = insertMailwayLink({ project_id: id, client_id: client.id, client_name: client.name, created_by: null });
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
              panelUrl: publicPanelUrl(),
              features: featuresOf(),
              suggestedDomains: [],
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
          suggestedDomains: suggestedDomains(id, summary.domains.map((d) => d.domain), dominiosQueSeVan(summary)),
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
     * crear nada: los que su web espera (`skyway.json` o `.env.example`), los
     * de siempre para lo que no nombra y, en `kept`, los que tienen un valor
     * puesto a mano y no se tocarían. Así la pestaña lo dice antes de conectar.
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
        requireLink(ctx.project);
        // Solo para comparar valores no secretos (servidor, puerto): sin red si no se conoce aún.
        const names = mailConnectNames(service, query.mode, knownMailValues(cachedInfo(), query.mode, null), false);
        const needs = service.type === 'git' ? (service.config as { needs?: { mail?: { mode: string } | null } }).needs : undefined;
        return {
          mode: query.mode,
          suggestedMode: needs?.mail?.mode ?? null,
          keys: names.targets.map((t) => t.name),
          kept: names.kept,
          secretPlaced: names.secretPlaced,
          // Servidor, puerto o URL de otro proveedor puestos a mano: conectar respondería 409.
          conflicts: names.conflicts,
        };
      }),
    );

    /**
     * Crea en Mailway una credencial de envío para el buzón y la escribe en las
     * variables del servicio con los nombres que su web espera (ver
     * `mailConnectNames`), sin pisar ninguna que alguien haya puesto a mano.
     * Devuelve solo los NOMBRES: los valores son secretos y ya están donde
     * tienen que estar. La credencial del mismo tipo que Skyway creó antes para
     * este servicio se revoca.
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
        const summary = await ownedSummary(ctx.project, link);
        assertClientActive(summary);
        const mailbox = ownMailbox(summary, body.mailboxId);
        const info = await getInfo();
        const { keys, kept, revoked } = await connectServiceMail({
          project: ctx.project,
          link,
          summary,
          service,
          mailbox,
          mode: body.mode,
          info,
        });

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
            `${kept.length ? ` · sin tocar (puestas a mano): ${kept.join(', ')}` : ''}` +
            `${revoked ? ` · ${revoked} credencial(es) anterior(es) revocada(s)` : ''}${body.redeploy ? ' · despliegue iniciado' : ''}`,
        });
        return { ok: true, keys, kept, needsRedeploy: !body.redeploy, deploymentId, revoked };
      }),
    );
  });
}
