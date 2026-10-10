/**
 * Cliente de la API de integraciones de Mailway (el servicio de correo
 * multicliente del operador). Skyway lo usa para crear y gestionar, desde cada
 * proyecto, el cliente de correo (uno por cuenta: lo comparten los proyectos de
 * la cuenta), sus dominios y buzones, y para inyectar en los servicios las
 * credenciales de envío.
 *
 * Sin dependencias: `fetch` con plazo, JSON y un token de gestión (`mwt_…`)
 * que se guarda en Ajustes y JAMÁS se devuelve ni se registra. Con un token de
 * administrador Skyway puede tocar cualquier cliente de Mailway, así que el
 * aislamiento entre proyectos NO lo da Mailway: lo imponen las rutas
 * (`routes/mailway.ts`), que comprueban cada dominio y buzón contra el cliente
 * vinculado al proyecto antes de actuar.
 */
import { findServiceIdByDomain, getProject, getService, getSetting, setSetting } from './db';
import { containerName } from './docker/containers';
import { ProjectRow, ServiceRow } from './types';

/** Claves de Ajustes. El token y el de Traefik son secretos: solo se leen aquí. */
export const MAILWAY_SETTING = {
  baseUrl: 'mailway.baseUrl',
  token: 'mailway.token',
  serviceId: 'mailway.serviceId',
  traefikToken: 'mailway.traefikToken',
  traefikCache: 'mailway.traefikCache',
  /** Plan con el que se crea el cliente cuando no lo elige un administrador. */
  defaultPlanId: 'mailway.defaultPlanId',
  /** Hosts públicos de la instancia (panel, webmail, servidor de correo), en JSON. */
  hosts: 'mailway.hosts',
  /** Hosts de las reglas de Traefik de los contenedores de Mailway (`mailway-mail`, `mailway-webmail`…), en JSON. */
  containerHosts: 'mailway.containerHosts',
  /**
   * Hosts que fueron de la instancia y ya no lo son (`[{ host, lastSeen }]`):
   * siguen reservados hasta que el administrador los libera.
   */
  previousHosts: 'mailway.previousHosts',
  /** Nombres de marca blanca de todos los clientes, en cualquier estado (última lista buena, JSON). */
  whitelabelHosts: 'mailway.whitelabelHosts',
} as const;

/**
 * Cliente de correo que tenía un proyecto antes de desactivarlo (`{clientId,
 * clientName}` en JSON). Permite al propietario recuperarlo al reactivar: el
 * cliente conserva sus dominios en Mailway y crear otro chocaría con ellos.
 */
export function previousClientKey(projectId: string): string {
  return `mailway.previousClient:${projectId}`;
}

/** Referencia externa con la que Mailway identifica a un proyecto sin cuenta (o el cliente propio de uno). */
export function projectExternalRef(projectId: string): string {
  return `skyway:project:${projectId}`;
}

/** Referencia externa con la que Mailway identifica a una cuenta (workspace) de Skyway. */
export function workspaceExternalRef(workspaceId: string): string {
  return `skyway:workspace:${workspaceId}`;
}

/**
 * Referencia del cliente de correo de un proyecto. Todos los proyectos de una
 * cuenta comparten el cliente de la cuenta (dominios, buzones y plan); uno sin
 * cuenta tiene el suyo.
 */
export function clientRefFor(project: Pick<ProjectRow, 'id' | 'workspace_id'>): string {
  return project.workspace_id ? workspaceExternalRef(project.workspace_id) : projectExternalRef(project.id);
}

/**
 * Referencias con las que un cliente de Mailway es de este proyecto: la de su
 * cuenta y la suya propia. La propia sigue valiendo en un proyecto de una
 * cuenta para el cliente que tenía antes de compartirlos (mientras no se migra
 * o si la cuenta ya tenía otro): esa referencia solo puede ser de él.
 */
export function acceptedClientRefs(project: Pick<ProjectRow, 'id' | 'workspace_id'>): string[] {
  const propia = projectExternalRef(project.id);
  return project.workspace_id ? [workspaceExternalRef(project.workspace_id), propia] : [propia];
}

/**
 * Nombre válido para un cliente de Mailway (de 2 a 80 caracteres) a partir del
 * de la cuenta o el del proyecto, que en Skyway pueden tener 1 carácter.
 */
export function mailwayClientName(name: string, prefijo: 'Cuenta' | 'Proyecto'): string {
  const n = name.trim();
  return (n.length >= 2 ? n : `${prefijo} ${n}`.trim()).slice(0, 80).trim();
}

/**
 * Proyecto de una cuenta que conserva su propio cliente de Mailway porque, al
 * pasar a un cliente por cuenta, la cuenta ya tenía otro (`{workspaceClientId,
 * workspaceClientName, at}` en JSON). Se recuerda para registrarlo una sola vez.
 */
export function ownClientKey(projectId: string): string {
  return `mailway.ownClient:${projectId}`;
}

export type MailwayErrorKind = 'config' | 'auth' | 'http' | 'network' | 'timeout';

export class MailwayError extends Error {
  kind: MailwayErrorKind;
  /** Código HTTP con el que respondió Mailway (solo `auth` y `http`). */
  status: number | null;
  /** Código de error de Mailway (`not_found`, `conflict`…), si lo envió. */
  code: string | null;

  constructor(kind: MailwayErrorKind, message: string, status: number | null = null, code: string | null = null) {
    super(message);
    this.name = 'MailwayError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

// ---------- tipos del contrato (solo lo que Skyway usa; todo tolerante) ----------

export interface MailwayEndpoint {
  host: string;
  port: number;
  security: string;
}

export interface MailwayUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'client';
  clientId: string | null;
}

export interface MailwayInfo {
  version: string;
  brandName: string;
  mailHostname: string;
  webmailUrl: string;
  panelUrl: string;
  imap?: MailwayEndpoint;
  smtp?: MailwayEndpoint;
  submission?: MailwayEndpoint;
  user: MailwayUser;
  /**
   * `cloudflareSoloCrear` (Mailway 1.1+): el alta con `autoDns` y el registro
   * de marca blanca con `soloCrear` solo crean lo que falta, sin modificar
   * nada, y la cuenta de Cloudflare de la instancia asociada a un dominio
   * nunca se usa con `soloCliente`. Sin ella, Skyway no pide el DNS automático.
   *
   * `webmailAutomatico`: interruptor GLOBAL del webmail automático de la
   * instancia (`webmail.<dominio>` de cada dominio, sin pedirlo). Ausente en un
   * Mailway que no lo tiene: entonces Skyway no ofrece el interruptor del cliente.
   *
   * `appPasswordInvalidation`: Mailway marca con `invalidatedAt` las
   * contraseñas de aplicación que dejan de funcionar al cambiar de motor (las
   * de Stalwart 0.15 no sobreviven al paso a la 0.16). Sin ella, Skyway no da
   * ninguna por invalidada (ver `mailwayrenovacion.ts`).
   */
  features?: {
    cloudflare?: boolean;
    autoconfig?: boolean;
    portal?: boolean;
    cloudflareSoloCrear?: boolean;
    webmailAutomatico?: boolean;
    /** Admite los enlaces de bienvenida del cliente (`/api/clients/:id/invites`). */
    invites?: boolean;
    appPasswordInvalidation?: boolean;
    /** Cambio de dominio de un cliente (`/api/domain-migrations`) y usuario del motor en los buzones. */
    domainMigrations?: boolean;
  };
  /** API del motor de correo con la que trabaja Mailway; ausente en versiones anteriores. */
  engine?: { api?: 'rest015' | 'jmap016' | 'demo' | null } | null;
  traefik?: { configPath: string; token: string } | null;
}

export interface MailwayPlan {
  id: string;
  name: string;
  maxDomains: number;
  maxMailboxes: number;
  maxAliases?: number;
  mailboxQuotaMb: number;
  apiDailyLimit?: number;
  notes?: string;
}

export interface MailwayClient {
  id: string;
  name: string;
  slug: string;
  contactEmail?: string;
  planId?: string;
  suspended: boolean;
  externalRef?: string | null;
  createdAt?: number;
}

export interface MailwayDnsCheck {
  id: string;
  label: string;
  type: string;
  name: string;
  expected: string;
  found?: string | null;
  status: 'ok' | 'missing' | 'mismatch' | 'unknown';
  required: boolean;
  help?: string;
  /**
   * Valor con el que SUSTITUIR el registro que ya existe (Mailway posterior a la 1.2; hoy, el
   * SPF actual con lo que le falta): pegar `expected` en su lugar dejaría sin
   * autorizar al resto de remitentes del dominio.
   */
  suggested?: string;
}

export interface MailwayDomain {
  id: string;
  clientId: string;
  domain: string;
  status: 'pending_dns' | 'active' | 'error';
  dkimSelector?: string;
  dnsStatus?: {
    checks?: MailwayDnsCheck[];
    requiredTotal?: number;
    requiredOk?: number;
    allRequiredOk?: boolean;
    checkedAt?: number | null;
  };
  lastCheckedAt?: number | null;
  verifiedAt?: number | null;
  createdAt?: number;
  cloudflare?: { accountId: string; zoneId: string } | null;
  /**
   * Cuándo probó Mailway que el dominio es del cliente (MX o TXT de
   * verificación). null = pendiente: Mailway no deja crear buzones ni alias.
   * Ausente en versiones de Mailway anteriores a esta comprobación.
   */
  ownershipVerifiedAt?: number | null;
  /** Registro TXT que prueba la propiedad sin tocar el MX. */
  ownershipRecord?: { type: string; name: string; content: string } | null;
  /**
   * true si la última medición dice que el correo del dominio se recibe en
   * otro servidor y Mailway encamina por MX lo que se le envía desde aquí
   * (Mailway posterior a la 1.2). Ausente en versiones anteriores, que lo entregan en local.
   */
  recepcionExterna?: boolean;
  /**
   * Cambio de dominio abierto en el que participa (Mailway 1.3+; null si
   * ninguno, ausente en versiones anteriores). `cuentaEnPlan` es false para el
   * dominio anterior: ya no admite buzones ni alias nuevos.
   */
  migracion?: MailwayDomainMigracion | null;
}

export interface MailwayDomainMigracion {
  id: string;
  rol: 'origen' | 'destino';
  estado: string;
  /** El otro dominio del cambio. */
  pareja: string;
  cuentaEnPlan: boolean;
}

export interface MailwayMailbox {
  id: string;
  domainId: string;
  domain: string;
  localPart: string;
  email: string;
  displayName: string;
  quotaMb: number;
  status: 'active' | 'suspended';
  createdAt?: number;
  usedBytes?: number | null;
  /**
   * Usuario con el que se entra (Mailway 1.3+). Tras pasar a un dominio nuevo
   * sigue siendo la dirección anterior hasta «Actualizar mis dispositivos»
   * (`loginPending`): las aplicaciones se autentican con él y envían con `email`.
   */
  login?: string;
  loginPending?: boolean;
}

export interface MailwayApiKeyInfo {
  id: string;
  clientId: string;
  name: string;
  prefix: string;
  senderMailboxId: string;
  senderEmail: string;
  dailyLimit?: number | null;
  lastUsedAt?: number | null;
  revokedAt?: number | null;
  createdAt?: number;
  usedToday?: number;
}

export interface MailwayAppPasswordInfo {
  id: string;
  mailboxId: string;
  email: string;
  name: string;
  createdAt?: number;
  revokedAt?: number | null;
  /**
   * Cuándo dejó de funcionar por un cambio de motor de Mailway (ver
   * `features.appPasswordInvalidation`). Se puede seguir revocando y ya no
   * cuenta para el límite de contraseñas activas del buzón. Ausente en
   * versiones anteriores: entonces no está invalidada.
   */
  invalidatedAt?: number | null;
}

export interface MailwayUsage {
  domains?: number;
  mailboxes?: number;
  aliases?: number;
  apiKeys?: number;
  messagesLast30d?: number;
}

/**
 * Webmail de marca de un cliente tal como lo devuelven su resumen y el
 * interruptor del webmail automático (sin `clientId`: las dos rutas ya son de
 * un cliente).
 */
export interface MailwayWebmailDomain {
  id: string;
  hostname: string;
  status: MailwayWhitelabelStatus;
  detail?: string;
  /** Lo dio de alta el webmail automático: es de los que se retiran al apagarlo. */
  automatico?: boolean;
  isPrimary?: boolean;
}

export interface MailwaySummary {
  client: {
    id: string;
    name: string;
    slug: string;
    externalRef: string | null;
    suspended: boolean;
    /** Interruptor del webmail automático del cliente (ausente en un Mailway que no lo tiene). */
    webmailAutomatico?: boolean;
  };
  plan: MailwayPlan | null;
  usage: MailwayUsage | null;
  domains: MailwayDomain[];
  mailboxes: MailwayMailbox[];
  apiKeys: MailwayApiKeyInfo[];
  appPasswords: MailwayAppPasswordInfo[];
  connection?: {
    imap?: MailwayEndpoint;
    smtp?: MailwayEndpoint;
    submission?: MailwayEndpoint;
    webmailUrl?: string;
  };
  /** Webmail de marca del cliente; null si el Mailway conectado no lo incluye en el resumen. */
  webmailDomains: MailwayWebmailDomain[] | null;
}

export interface MailwayDnsRecord {
  type: string;
  name: string;
  content: string;
}

export interface MailwayCloudflareChange {
  action: 'create' | 'update' | 'keep' | 'conflict';
  type: string;
  name: string;
  content: string;
  priority?: number;
  current?: string;
  reason: string;
  required: boolean;
  /** Un conflicto que se puede reemplazar desde aquí (Mailway posterior a la 1.2; dos SPF o Email Routing, no). */
  reemplazable?: boolean;
  /** Parte del cambio de proveedor: el MX ajeno y el SPF y el DMARC que se crean con él (Mailway posterior a la 1.2). */
  alCambiar?: boolean;
}

/** Lo que borró el último cambio en Cloudflare y «Deshacer el cambio» recrearía (Mailway posterior a la 1.2). */
export interface MailwayCopiaCambio {
  createdAt: number;
  borrados: { type: string; name: string; content: string; priority?: number }[];
}

export interface MailwayCloudflarePlan {
  available: boolean;
  reason?: string;
  account?: { id: string; label: string };
  zone?: { id: string; name: string; status: string };
  changes: MailwayCloudflareChange[];
  summary: { create: number; update: number; keep: number; conflict: number };
  /**
   * Presente (aunque sea null) en los Mailway que eligen los conflictos uno a
   * uno (`replace`) y guardan copia para deshacer; ausente en los anteriores.
   */
  copia?: MailwayCopiaCambio | null;
}

/** ¿Recibe ya el dominio correo en otro proveedor? (`GET /api/domains/:id/conflicto`). */
export interface MailwayConflicto {
  hayOtroProveedor: boolean;
  mxActuales: string[];
  spfActual: string | null;
  dmarcPolitica: string | null;
  aviso: string | null;
  /** Mailway posterior a la 1.2: qué hacer con una política MTA-STS del proveedor actual antes del cambio. */
  avisoMtaSts?: string | null;
}

export interface MailwayCloudflareResult {
  applied: { action: string; type: string; name: string }[];
  errors: { type: string; name: string; error: string }[];
  domain: MailwayDomain;
}

export interface MailwaySetupLink {
  id: string;
  url: string;
  expiresAt: number;
  hasPassword: boolean;
}

// ---------- configuración ----------

export interface MailwayConfig {
  /** URL pública del panel de Mailway (sin barra final). */
  baseUrl: string | null;
  token: string | null;
  /** Servicio de Skyway que ejecuta el panel de Mailway (opcional). */
  serviceId: string | null;
}

export function readMailwayConfig(): MailwayConfig {
  return {
    baseUrl: normalizeBaseUrl(getSetting(MAILWAY_SETTING.baseUrl)),
    token: getSetting(MAILWAY_SETTING.token) || null,
    serviceId: getSetting(MAILWAY_SETTING.serviceId) || null,
  };
}

/** Quita barras finales: las rutas del contrato empiezan por «/». */
export function normalizeBaseUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed || null;
}

/**
 * La URL si es http(s); si no, null. Las direcciones que llegan de Mailway
 * (panel, webmail, enlaces) acaban en un `href` de la interfaz: un
 * `javascript:` enviado por un Mailway comprometido se ejecutaría en la sesión
 * de Skyway de quien pulsara el enlace.
 */
export function safeHttpUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (parsed.username || parsed.password) return null;
    return url.trim();
  } catch {
    return null;
  }
}

/** Host (en minúsculas, sin puerto) de una URL, o null. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Dirección interna del panel de Mailway cuando lo despliega este mismo Skyway:
 * el nombre del contenedor en la red `skyway-edge`. Solo está en esa red si el
 * servicio tiene algún dominio (así lo conecta el desplegador), y hablarle por
 * dentro evita salir a internet y volver a entrar por Traefik en cada petición.
 */
export function internalPanelUrl(serviceId: string | null): string | null {
  if (!serviceId) return null;
  const service = getService(serviceId);
  if (!service || service.type === 'database') return null;
  const cfg = service.config as { port?: unknown; domains?: unknown };
  if (!Array.isArray(cfg.domains) || cfg.domains.length === 0) return null;
  const port = Number(cfg.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const project = getProject(service.project_id);
  if (!project) return null;
  return `http://${containerName(project, service)}:${port}`;
}

/**
 * Proyecto de Skyway en el que se ejecuta Mailway: el del servicio del panel
 * configurado o, si no lo hay, el del servicio que sirve el dominio de la URL
 * pública. Esto último solo se deduce en un proyecto de la plataforma (sin
 * cuenta de cliente): si un cliente se hubiera asignado antes ese dominio, su
 * proyecto pasaría por el de Mailway y recibiría el token y las rutas del
 * puente. En ese caso hay que seleccionar el servicio del panel en Ajustes.
 */
export function mailwayProject(cfg: MailwayConfig = readMailwayConfig()): ProjectRow | null {
  let service: ServiceRow | undefined;
  if (cfg.serviceId) {
    service = getService(cfg.serviceId);
  } else {
    const host = hostOf(cfg.baseUrl);
    const serviceId = host ? findServiceIdByDomain(host) : undefined;
    service = serviceId ? getService(serviceId) : undefined;
    if (service && getProject(service.project_id)?.workspace_id) return null;
  }
  return (service && getProject(service.project_id)) || null;
}

/**
 * Servicio de Skyway ajeno a Mailway que sirve el dominio de la URL pública, o
 * null si no hay ninguno. Por esa URL viaja el token de gestión (de
 * administrador): si el dominio lo sirve el servicio de otro cliente, Traefik
 * le entregaría la petición con el token dentro.
 */
export function publicBaseConflict(cfg: MailwayConfig = readMailwayConfig()): ServiceRow | null {
  const host = hostOf(cfg.baseUrl);
  if (!host) return null;
  const serviceId = findServiceIdByDomain(host);
  const service = serviceId ? getService(serviceId) : undefined;
  if (!service) return null;
  const project = mailwayProject(cfg);
  return project && service.project_id === project.id ? null : service;
}

const URL_PUBLICA_AJENA =
  'La URL pública de Mailway corresponde a un dominio que Skyway asigna a un servicio que no es el panel de Mailway, ' +
  'y por seguridad no se envía el token de gestión por ella. Un administrador debe seleccionar el servicio del panel ' +
  'o corregir la URL en Ajustes → Correo (Mailway).';

/** Lista JSON de nombres guardada en Ajustes (vacía si falta o no se puede leer). */
function hostsGuardados(key: string): string[] {
  const stored = getSetting(key);
  if (!stored) return [];
  try {
    const list = JSON.parse(stored) as unknown;
    return Array.isArray(list) ? list.filter((h): h is string => typeof h === 'string' && !!h).map((h) => h.toLowerCase()) : [];
  } catch {
    // Valor ilegible: se reescribe con la próxima lectura.
    return [];
  }
}

export interface MailwayPreviousHost {
  host: string;
  /** Última vez que la instancia lo anunció (o que lo sirvió uno de sus contenedores). */
  lastSeen: number;
}

/** Nombres que fueron de la instancia y siguen reservados. */
function anterioresGuardados(): MailwayPreviousHost[] {
  const stored = getSetting(MAILWAY_SETTING.previousHosts);
  if (!stored) return [];
  try {
    const list = JSON.parse(stored) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter((x): x is MailwayPreviousHost => !!x && typeof x.host === 'string' && !!x.host && typeof x.lastSeen === 'number')
      .map((x) => ({ host: x.host.toLowerCase(), lastSeen: x.lastSeen }));
  } catch {
    return [];
  }
}

function guardarAnteriores(list: MailwayPreviousHost[]): void {
  const json = list.length > 0 ? JSON.stringify([...list].sort((a, b) => a.host.localeCompare(b.host))) : null;
  if ((getSetting(MAILWAY_SETTING.previousHosts) ?? null) !== json) setSetting(MAILWAY_SETTING.previousHosts, json);
}

/**
 * Nombres que ha dejado de anunciar alguna fuente (la información de la
 * instancia, los contenedores, la URL configurada): pasan a la lista de
 * anteriores, que sigue reservada. Un cambio de nombre en Mailway no cambia el
 * DNS: mail.viejo.com y webmail.viejo.com siguen apuntando a este servidor, y
 * los titulares los tienen guardados como servidor o como webmail; si dejaran
 * de estar reservados, el servicio de un cliente podría asignárselos y
 * obtener su certificado.
 */
export function rememberPreviousHosts(perdidos: Iterable<string>): void {
  const actuales = new Set(mailwayCurrentHosts());
  const lista = anterioresGuardados();
  const ahora = Date.now();
  let cambio = false;
  for (const raw of perdidos) {
    const host = raw.trim().toLowerCase();
    if (!host || actuales.has(host)) continue;
    const ya = lista.find((x) => x.host === host);
    if (ya) ya.lastSeen = ahora;
    else lista.push({ host, lastSeen: ahora });
    cambio = true;
  }
  if (cambio) guardarAnteriores(lista);
}

/** Un nombre anterior que vuelve a anunciarse deja de ser «anterior». */
function retirarDeAnteriores(hosts: Iterable<string>): void {
  const vuelven = new Set([...hosts].map((h) => h.toLowerCase()));
  const lista = anterioresGuardados();
  const quedan = lista.filter((x) => !vuelven.has(x.host));
  if (quedan.length !== lista.length) guardarAnteriores(quedan);
}

/** Nombres actuales de la instancia: URL configurada, los que anuncia Mailway y los de sus contenedores. */
export function mailwayCurrentHosts(cfg: MailwayConfig = readMailwayConfig()): string[] {
  const out = new Set<string>();
  const base = hostOf(cfg.baseUrl);
  if (base) out.add(base);
  for (const h of hostsGuardados(MAILWAY_SETTING.hosts)) out.add(h);
  for (const h of hostsGuardados(MAILWAY_SETTING.containerHosts)) out.add(h);
  return [...out];
}

/**
 * Hosts públicos de la instancia de Mailway: el de la URL configurada, los que
 * anunció Mailway (panel, webmail y servidor de correo), los de las reglas de
 * Traefik de sus contenedores y los que fueron suyos y el administrador aún no
 * ha liberado. Ningún servicio de un cliente puede asignárselos: con una regla
 * de Traefik más larga se quedaría con el tráfico del webmail o del panel (y
 * con el token de Skyway).
 */
export function mailwayReservedHosts(cfg: MailwayConfig = readMailwayConfig()): string[] {
  return [...new Set([...mailwayCurrentHosts(cfg), ...anterioresGuardados().map((x) => x.host)])];
}

/** Nombres anteriores aún reservados (sin los que vuelven a ser actuales), para Ajustes → Correo. */
export function mailwayPreviousHosts(): MailwayPreviousHost[] {
  const actuales = new Set(mailwayCurrentHosts());
  return anterioresGuardados().filter((x) => !actuales.has(x.host));
}

/** El administrador libera un nombre anterior. false si no estaba en la lista. */
export function releaseMailwayPreviousHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  const lista = anterioresGuardados();
  const quedan = lista.filter((x) => x.host !== h);
  if (quedan.length === lista.length) return false;
  guardarAnteriores(quedan);
  return true;
}

/** Sustituye una lista de nombres actuales; los que salen pasan a anteriores. */
function sustituirHosts(key: string, nuevos: Set<string>): void {
  const antes = hostsGuardados(key);
  const json = JSON.stringify([...nuevos].sort());
  if (getSetting(key) !== json) setSetting(key, json);
  // Después de guardar: un nombre que sigue en otra fuente no es «anterior».
  rememberPreviousHosts(antes.filter((h) => !nuevos.has(h)));
  retirarDeAnteriores(nuevos);
}

function rememberInstanceHosts(info: MailwayInfo): void {
  const hosts = new Set<string>();
  for (const url of [info.panelUrl, info.webmailUrl]) {
    const host = hostOf(safeHttpUrl(url));
    if (host) hosts.add(host);
  }
  const mail = typeof info.mailHostname === 'string' ? info.mailHostname.trim().toLowerCase() : '';
  if (/^[a-z0-9.-]{1,253}$/.test(mail)) hosts.add(mail);
  sustituirHosts(MAILWAY_SETTING.hosts, hosts);
}

/** Hosts de las reglas de Traefik de los contenedores de Mailway (los lee `mailwaytraefik.ts`). */
export function rememberContainerHosts(hosts: readonly string[]): void {
  sustituirHosts(MAILWAY_SETTING.containerHosts, new Set(hosts.map((h) => h.toLowerCase())));
}

/**
 * Hasta cuándo se salta la dirección interna tras un fallo de conexión. Fuera
 * de Docker (desarrollo) el nombre del contenedor no resuelve nunca, y probarlo
 * en cada petición sumaba una consulta DNS fallida a todas.
 */
const INTERNAL_BACKOFF_MS = 60_000;
const internalDownUntil = new Map<string, number>();

function candidateBases(cfg: MailwayConfig): string[] {
  const out: string[] = [];
  const internal = internalPanelUrl(cfg.serviceId);
  if (internal && (internalDownUntil.get(internal) ?? 0) < Date.now()) out.push(internal);
  if (cfg.baseUrl && !out.includes(cfg.baseUrl) && !publicBaseConflict(cfg)) out.push(cfg.baseUrl);
  // Sin URL pública, la interna se intenta aunque haya fallado hace poco: no hay alternativa.
  if (out.length === 0 && internal) out.push(internal);
  return out;
}

export function mailwayConfigured(cfg: MailwayConfig = readMailwayConfig()): boolean {
  return !!cfg.token && (!!cfg.baseUrl || !!internalPanelUrl(cfg.serviceId));
}

// ---------- transporte ----------

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Errores de red en los que la petición no llegó a salir: se puede probar con
 * la siguiente dirección sin riesgo de repetir una creación. Un corte a mitad
 * de respuesta (ECONNRESET) NO está aquí: el POST pudo haberse aplicado.
 */
const NO_CONECTO = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);

function errorCode(err: unknown): string | null {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  if (typeof e?.cause?.code === 'string') return e.cause.code;
  if (typeof e?.code === 'string') return e.code;
  return null;
}

function originOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

interface RequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Configuración alternativa (probar valores aún sin guardar). */
  config?: MailwayConfig;
  timeoutMs?: number;
  /** Cabeceras de autenticación propias; por defecto, el token de gestión como Bearer. */
  headers?: Record<string, string>;
  /** La respuesta correcta es texto plano (un fichero), no JSON. Los errores siguen llegando en JSON. */
  text?: boolean;
}

/**
 * Petición a Mailway probando primero la dirección interna y después la
 * pública. Devuelve el cuerpo JSON o lanza `MailwayError` con un mensaje listo
 * para la interfaz (el `error` de Mailway cuando lo hay).
 */
async function requestMailway<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const cfg = opts.config ?? readMailwayConfig();
  const headers: Record<string, string> = {
    Accept: opts.text ? 'text/plain, application/json' : 'application/json',
    ...(opts.headers ?? {}),
  };
  if (!opts.headers) {
    if (!cfg.token) throw new MailwayError('config', 'No se ha configurado ningún token de gestión de Mailway.');
    headers.Authorization = `Bearer ${cfg.token}`;
  }
  const bases = candidateBases(cfg);
  if (bases.length === 0) {
    if (cfg.baseUrl) throw new MailwayError('config', URL_PUBLICA_AJENA);
    throw new MailwayError('config', 'No se ha configurado la dirección del panel de Mailway.');
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let i = 0; i < bases.length; i++) {
    const base = bases[i];
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(timeoutMs),
        // Seguir una redirección llevaría el token a otra dirección: se informa
        // de ella para que se configure la definitiva (http → https, sobre todo).
        redirect: 'manual',
      });
    } catch (err: unknown) {
      const name = (err as { name?: unknown } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new MailwayError('timeout', `Mailway no ha respondido en ${Math.round(timeoutMs / 1000)} s (${originOf(base)}).`);
      }
      const code = errorCode(err);
      if (code && NO_CONECTO.has(code) && i < bases.length - 1) {
        internalDownUntil.set(base, Date.now() + INTERNAL_BACKOFF_MS);
        continue;
      }
      throw new MailwayError(
        'network',
        `No se ha podido conectar con Mailway (${originOf(base)}${code ? `, ${code}` : ''}). ` +
          'Comprueba la dirección configurada y que el panel esté en funcionamiento.',
      );
    }
    return parseResponse<T>(res, opts.headers ? 'el token de Traefik' : 'el token de gestión', !!opts.text);
  }
  // Inalcanzable: el bucle o devuelve o lanza en la última dirección.
  throw new MailwayError('network', 'No se ha podido conectar con Mailway.');
}

/** Códigos del 401 de Mailway que explican por qué no vale el token (revocado, caducado…). */
const MOTIVOS_401 = new Set(['token_revoked', 'token_expired', 'token_user_disabled']);

/**
 * Tamaño máximo de un fichero de texto de Mailway (un fichero de zona ocupa
 * pocos KB). Lo que lo supera no es lo que se ha pedido.
 */
const MAX_TEXTO = 512 * 1024;

async function parseResponse<T>(res: Response, credencial: string, texto = false): Promise<T> {
  const text = await res.text().catch(() => '');
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = undefined;
  }
  const obj = (body && typeof body === 'object' ? body : {}) as { error?: unknown; code?: unknown };
  const mensaje = typeof obj.error === 'string' && obj.error.trim() ? obj.error.trim() : null;
  const code = typeof obj.code === 'string' ? obj.code : null;
  if (res.status >= 300 && res.status < 400) {
    const destino = res.headers.get('location');
    throw new MailwayError(
      'http',
      `La dirección de Mailway redirige${destino ? ` a ${destino}` : ''}. Indica la dirección definitiva en Ajustes → Correo (Mailway).`,
      502,
    );
  }
  if (res.status === 401) {
    // Con el motivo concreto el administrador sabe si tiene que crear otro
    // token o reactivar al usuario, en vez de probar a ciegas.
    const motivo = mensaje && code && MOTIVOS_401.has(code) ? ` Motivo: ${/[.!?]$/.test(mensaje) ? mensaje : `${mensaje}.`}` : '';
    throw new MailwayError(
      'auth',
      `Mailway ha rechazado ${credencial} (401).${motivo} Revisa el token en Ajustes → Correo (Mailway).`,
      401,
      code,
    );
  }
  if (!res.ok) {
    throw new MailwayError('http', mensaje ?? `Mailway ha respondido con el código HTTP ${res.status}.`, res.status, code);
  }
  if (texto) {
    // Un Mailway sin la ruta podría contestar 200 con la página de su panel:
    // eso no es el fichero pedido y no se entrega como si lo fuera.
    if (!/^text\/plain\b/i.test(res.headers.get('content-type') ?? '') || text.length > MAX_TEXTO) {
      throw new MailwayError(
        'http',
        'La respuesta de Mailway no es un fichero de texto válido. Comprueba que la versión de Mailway admite esta función.',
        502,
      );
    }
    return text as T;
  }
  if (body === undefined || typeof body !== 'object' || body === null) {
    throw new MailwayError(
      'http',
      'La respuesta de Mailway no es válida. Comprueba que la dirección configurada corresponde al panel de Mailway.',
      res.status,
    );
  }
  return body as T;
}

/** Petición autenticada con el token de gestión. */
export function mailwayFetch<T>(
  path: string,
  opts: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; config?: MailwayConfig; timeoutMs?: number } = {},
): Promise<T> {
  return requestMailway<T>(path, opts);
}

const enc = encodeURIComponent;

// ---------- información de la instancia (con caché) ----------

/** Cuánto se reutiliza la información de la instancia: cambia muy rara vez. */
const INFO_TTL_MS = 5 * 60_000;
let infoCache: { info: MailwayInfo; at: number } | null = null;

/**
 * Información de la instancia y del usuario del token. Con la configuración
 * guardada se cachea y, si el token es de administrador, se guarda de paso el
 * token con el que Traefik lee sus rutas.
 */
export async function getInfo(opts: { config?: MailwayConfig; fresh?: boolean } = {}): Promise<MailwayInfo> {
  if (!opts.config && !opts.fresh && infoCache && Date.now() - infoCache.at < INFO_TTL_MS) return infoCache.info;
  const info = await mailwayFetch<MailwayInfo>('/api/integrations/info', { config: opts.config });
  if (!info || typeof info !== 'object' || !info.user) {
    throw new MailwayError('http', 'La respuesta de Mailway no es válida. Comprueba que la versión de Mailway admite integraciones.');
  }
  if (!opts.config) {
    infoCache = { info, at: Date.now() };
    rememberInstanceHosts(info);
    const traefikToken = info.traefik?.token;
    if (typeof traefikToken === 'string' && traefikToken && getSetting(MAILWAY_SETTING.traefikToken) !== traefikToken) {
      setSetting(MAILWAY_SETTING.traefikToken, traefikToken);
    }
  }
  return info;
}

/** La última información obtenida, sin salir a la red (o null). */
export function cachedInfo(): MailwayInfo | null {
  return infoCache?.info ?? null;
}

/** Olvida lo aprendido de la instancia: se llama al cambiar la configuración. */
export function resetMailwayCaches(): void {
  infoCache = null;
  internalDownUntil.clear();
}

/** URL pública del panel para los enlaces que ve el usuario (siempre http o https). */
export function publicPanelUrl(cfg: MailwayConfig = readMailwayConfig()): string | null {
  return normalizeBaseUrl(safeHttpUrl(cachedInfo()?.panelUrl)) ?? cfg.baseUrl;
}

// ---------- planes y clientes ----------

export async function listPlans(): Promise<MailwayPlan[]> {
  const res = await mailwayFetch<{ plans?: MailwayPlan[] }>('/api/plans');
  return Array.isArray(res.plans) ? res.plans : [];
}

export async function listClients(): Promise<MailwayClient[]> {
  const res = await mailwayFetch<{ clients?: MailwayClient[] }>('/api/clients');
  return Array.isArray(res.clients) ? res.clients : [];
}

/** Crea el cliente de la referencia externa o devuelve el que ya la tenía (idempotente). */
export async function ensureClient(input: {
  externalRef: string;
  name: string;
  contactEmail?: string;
  planId?: string;
}): Promise<{ client: MailwayClient; created: boolean }> {
  return mailwayFetch('/api/integrations/clients/ensure', { method: 'POST', body: input });
}

/** Cliente con esa referencia externa, o null si no hay ninguno. */
export async function getClientByRef(externalRef: string): Promise<MailwayClient | null> {
  try {
    const res = await mailwayFetch<{ client?: MailwayClient }>(
      `/api/integrations/clients/by-ref?externalRef=${enc(externalRef)}`,
    );
    return res.client ?? null;
  } catch (err) {
    if (err instanceof MailwayError && err.status === 404) return null;
    throw err;
  }
}

export async function linkClient(clientId: string, externalRef: string): Promise<MailwayClient> {
  const res = await mailwayFetch<{ client: MailwayClient }>(`/api/integrations/clients/${enc(clientId)}/link`, {
    method: 'PUT',
    body: { externalRef },
  });
  return res.client;
}

export async function unlinkClient(clientId: string, expectedRef?: string): Promise<MailwayClient | null> {
  // Con la referencia esperada, Mailway solo la borra si sigue siendo esa
  // (409 external_ref_mismatch si no): cierra la carrera entre comprobarla y
  // desvincular. Un Mailway anterior ignora el parámetro.
  const query = expectedRef ? `?externalRef=${enc(expectedRef)}` : '';
  const res = await mailwayFetch<{ client?: MailwayClient }>(`/api/integrations/clients/${enc(clientId)}/link${query}`, {
    method: 'DELETE',
  });
  return res.client ?? null;
}

/**
 * Suelta en Mailway la referencia del proyecto, pero solo si el cliente
 * vinculado todavía la lleva. Si ya es de otra integración (o no tiene
 * ninguna), borrarla desvincularía algo que no es de este proyecto: Mailway
 * pone la referencia a null sin mirar cuál era. Devuelve si se ha soltado.
 * Nunca toca la referencia de una cuenta: el cliente de una cuenta la conserva
 * aunque sus proyectos desactiven el correo o se borren.
 */
export async function releaseProjectClient(projectId: string, clientId: string): Promise<boolean> {
  const owner = await getClientByRef(projectExternalRef(projectId));
  if (!owner || owner.id !== clientId) return false;
  try {
    await unlinkClient(clientId, projectExternalRef(projectId));
  } catch (err) {
    if (err instanceof MailwayError && (err.status === 404 || err.status === 409)) return false;
    throw err;
  }
  return true;
}

/**
 * Suelta en Mailway la referencia de una cuenta eliminada, si algún cliente
 * todavía la lleva, con la condición en la propia petición (como al soltar la
 * de un proyecto). El cliente y sus buzones siguen en Mailway. Devuelve el
 * cliente que la llevaba, o null si no había ninguno o ya no era suya.
 */
export async function releaseWorkspaceClient(workspaceId: string): Promise<MailwayClient | null> {
  const ref = workspaceExternalRef(workspaceId);
  const owner = await getClientByRef(ref);
  if (!owner) return null;
  try {
    await unlinkClient(owner.id, ref);
  } catch (err) {
    if (err instanceof MailwayError && (err.status === 404 || err.status === 409)) return null;
    throw err;
  }
  return owner;
}

/** Cambia el nombre del cliente en Mailway (ruta de administración, `PATCH /api/clients/:id`). */
export async function renameClient(clientId: string, name: string): Promise<void> {
  const res = await mailwayFetch<{ client?: { id?: unknown } }>(`/api/clients/${enc(clientId)}`, { method: 'PATCH', body: { name } });
  if (!res.client || res.client.id !== clientId) {
    throw new MailwayError('http', 'La respuesta de Mailway no corresponde al cliente que se ha renombrado.', 502);
  }
}

export async function getSummary(clientId: string): Promise<MailwaySummary> {
  const res = await mailwayFetch<Partial<MailwaySummary>>(`/api/integrations/clients/${enc(clientId)}/summary`);
  if (!res.client || typeof res.client.id !== 'string') {
    throw new MailwayError('http', 'La respuesta de Mailway no es válida: falta el cliente en el resumen.');
  }
  return {
    client: res.client,
    plan: res.plan ?? null,
    usage: res.usage ?? null,
    domains: Array.isArray(res.domains) ? res.domains : [],
    mailboxes: Array.isArray(res.mailboxes) ? res.mailboxes : [],
    apiKeys: Array.isArray(res.apiKeys) ? res.apiKeys : [],
    appPasswords: Array.isArray(res.appPasswords) ? res.appPasswords : [],
    connection: res.connection,
    webmailDomains: Array.isArray(res.webmailDomains) ? res.webmailDomains : null,
  };
}

/** Forma mínima de una dirección de correo (la validación de verdad la hacen el formulario y Mailway). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Correo de contacto del cliente en Mailway, o null si no tiene (o la
 * respuesta no es de ese cliente). Solo sirve para proponerlo en el enlace de
 * bienvenida: nunca se usa sin que alguien lo revise.
 */
export async function getClientContactEmail(clientId: string): Promise<string | null> {
  const res = await mailwayFetch<{ client?: { id?: unknown; contactEmail?: unknown } }>(`/api/clients/${enc(clientId)}`);
  const client = res.client;
  if (!client || client.id !== clientId || typeof client.contactEmail !== 'string') return null;
  // Mailway lo guarda tal como se escribió; el enlace de bienvenida, en minúsculas.
  const email = client.contactEmail.trim().toLowerCase();
  return EMAIL_RE.test(email) && email.length <= 254 ? email : null;
}

// ---------- dominios ----------

/** Resultado del DNS automático del alta de un dominio de correo. */
export interface MailwayAutoDnsResult {
  applied: { action: string; type: string; name: string }[];
  errors: { type: string; name: string; error: string }[];
  /** Conflictos que Mailway no ha tocado (nunca reemplaza en el alta). */
  skipped: { type: string; name: string; reason: string }[];
}

export interface MailwayCreatedDomain {
  domain: MailwayDomain;
  /** null si no se pidió el DNS automático o no se llegó a aplicar. */
  cloudflare: MailwayAutoDnsResult | null;
  /** Por qué no se ha aplicado (sin cuenta de Cloudflare que contenga la zona…). */
  cloudflareReason: string | null;
}

/**
 * Da de alta el dominio en el cliente. `autoDns` pide a Mailway que cree en
 * Cloudflare los registros que faltan sin reemplazar ninguno; Skyway solo lo
 * pide para un administrador. Para quien no lo es, `autoDns` viaja en false y
 * con `soloCliente`: el alta nunca escribe en las zonas de Cloudflare del
 * operador, ni aunque Mailway decidiera aplicar el DNS por su cuenta.
 */
export async function createDomain(
  clientId: string,
  domain: string,
  opts: { soloCliente?: boolean; autoDns?: boolean } = {},
): Promise<MailwayCreatedDomain> {
  const res = await mailwayFetch<{ domain: MailwayDomain; cloudflare?: Partial<MailwayAutoDnsResult> | null; cloudflareReason?: unknown }>(
    `/api/domains${cloudflareQuery(opts.soloCliente)}`,
    { method: 'POST', body: { domain, clientId, autoDns: !!opts.autoDns } },
  );
  const cf = res.cloudflare && typeof res.cloudflare === 'object' ? res.cloudflare : null;
  return {
    domain: res.domain,
    cloudflare: cf
      ? {
          applied: Array.isArray(cf.applied) ? cf.applied : [],
          errors: Array.isArray(cf.errors) ? cf.errors : [],
          skipped: Array.isArray(cf.skipped) ? cf.skipped : [],
        }
      : null,
    cloudflareReason: typeof res.cloudflareReason === 'string' ? res.cloudflareReason : null,
  };
}

export async function verifyDomain(domainId: string): Promise<MailwayDomain> {
  const res = await mailwayFetch<{ domain: MailwayDomain }>(`/api/domains/${enc(domainId)}/verify`, { method: 'POST' });
  return res.domain;
}

export async function getDomainDns(domainId: string): Promise<MailwayDnsRecord[]> {
  const res = await mailwayFetch<{ records?: MailwayDnsRecord[] }>(`/api/domains/${enc(domainId)}/dns`);
  return Array.isArray(res.records) ? res.records : [];
}

/**
 * `soloCliente` pide a Mailway que use únicamente las cuentas de Cloudflare del
 * propio cliente. Skyway habla con un token de administrador, y sin esto
 * Mailway resolvería la zona también con las cuentas de la instancia: el
 * propietario de un proyecto podría leer y reescribir el DNS de las zonas del
 * operador dando de alta como dominio de correo uno que viva en ellas.
 */
function cloudflareQuery(soloCliente: boolean | undefined): string {
  return soloCliente ? '?soloCliente=1' : '';
}

/** Cuenta de Cloudflare conectada en Mailway (sin el token, que Mailway nunca devuelve). */
export interface MailwayCloudflareAccount {
  id: string;
  /** null = cuenta de la instancia (del operador). */
  clientId: string | null;
  label: string;
}

/**
 * Cuentas de Cloudflare propias del cliente. Se filtran también aquí por
 * cliente: con el token de administrador, un Mailway que ignorase `clientId`
 * devolvería las de todos, incluidas las de la instancia.
 */
export async function listClientCloudflareAccounts(clientId: string): Promise<MailwayCloudflareAccount[]> {
  const res = await mailwayFetch<{ accounts?: MailwayCloudflareAccount[] }>(`/api/cloudflare/accounts?clientId=${enc(clientId)}`);
  return (Array.isArray(res.accounts) ? res.accounts : []).filter((a) => a && typeof a.id === 'string' && a.clientId === clientId);
}

export function getCloudflarePlan(domainId: string, opts: { soloCliente?: boolean } = {}): Promise<MailwayCloudflarePlan> {
  return mailwayFetch<MailwayCloudflarePlan>(`/api/domains/${enc(domainId)}/cloudflare${cloudflareQuery(opts.soloCliente)}`);
}

/**
 * Aplica el plan. `replace` (Mailway posterior a la 1.2) elige uno a uno los conflictos que
 * se reemplazan («TIPO:nombre»); un Mailway anterior lo ignora y no reemplaza
 * ninguno, que es lo seguro. `replaceConflicts` los reemplaza todos.
 */
export function applyCloudflare(
  domainId: string,
  opts: { replaceConflicts?: boolean; replace?: string[]; soloCliente?: boolean },
): Promise<MailwayCloudflareResult> {
  return mailwayFetch<MailwayCloudflareResult>(
    `/api/domains/${enc(domainId)}/cloudflare/apply${cloudflareQuery(opts.soloCliente)}`,
    {
      method: 'POST',
      body: { replaceConflicts: !!opts.replaceConflicts, ...(opts.replace && opts.replace.length > 0 ? { replace: opts.replace } : {}) },
    },
  );
}

/**
 * Deshace el último cambio en Cloudflare del dominio (Mailway posterior a la 1.2): recrea lo
 * que borraron los reemplazos y retira lo que Mailway creó en su lugar.
 */
export function undoCloudflare(
  domainId: string,
  opts: { soloCliente?: boolean } = {},
): Promise<{ restaurados?: { type: string; name: string }[]; retirados?: { type: string; name: string }[]; domain?: MailwayDomain }> {
  return mailwayFetch(`/api/domains/${enc(domainId)}/cloudflare/undo${cloudflareQuery(opts.soloCliente)}`, { method: 'POST' });
}

/** ¿El dominio ya recibe correo en otro proveedor? Lo mide Mailway en el DNS público. */
export function getDomainConflict(domainId: string): Promise<MailwayConflicto> {
  return mailwayFetch<MailwayConflicto>(`/api/domains/${enc(domainId)}/conflicto`);
}

/**
 * SPF con el que sustituir el actual para autorizar también a este servidor,
 * para los Mailway que aún no lo calculan (`suggested`): el actual con los
 * mecanismos del propuesto que le faltan, delante de su «all», sin tocar sus
 * include ni su calificador final (son decisiones del titular). null si no se
 * puede calcular (no es un SPF, hay varios) o si no falta nada.
 */
export function fusionarSpf(actual: string, propuesto: string): string | null {
  const a = actual.trim();
  if (!/^v=spf1(\s|$)/i.test(a) || a.includes(' | ')) return null;
  const tokens = a.split(/\s+/);
  const indiceAll = tokens.findIndex((t, i) => i > 0 && /^[-~?+]?all$/i.test(t));
  const antesDeAll = new Set((indiceAll === -1 ? tokens : tokens.slice(0, indiceAll)).map((t) => t.toLowerCase().replace(/^\+/, '')));
  const faltan = propuesto
    .trim()
    .split(/\s+/)
    .slice(1)
    // Ni el «all» ni los modificadores (ra=, redirect=…): son del titular.
    .filter((t) => t && !/^[-~?+]?all$/i.test(t) && !t.includes('='))
    .filter((t) => !antesDeAll.has(t.toLowerCase().replace(/^\+/, '')));
  if (faltan.length === 0) return null;
  if (indiceAll === -1) tokens.push(...faltan);
  else tokens.splice(indiceAll, 0, ...faltan);
  return tokens.join(' ');
}

// ---------- fichero de zona ----------

/** Niveles del fichero de zona de Mailway: obligatorios, recomendados (por defecto) o todos. */
export const ZONE_LEVELS = ['obligatorios', 'recomendados', 'completo'] as const;
export type MailwayZoneLevel = (typeof ZONE_LEVELS)[number];

/** Fichero de zona BIND con los registros de correo del dominio, tal como lo genera Mailway. */
export function getZoneFile(domainId: string, nivel: MailwayZoneLevel): Promise<string> {
  return requestMailway<string>(`/api/domains/${enc(domainId)}/zonefile?nivel=${enc(nivel)}`, { text: true });
}

/**
 * Tipos de registro que publican la web de un nombre (A, AAAA, CNAME y los
 * HTTPS/SVCB que consultan los navegadores). El correo no los necesita en el
 * dominio raíz ni en www.
 */
const TIPOS_WEB = new Set(['A', 'AAAA', 'CNAME', 'HTTPS', 'SVCB']);
const CLASES_DNS = new Set(['IN', 'CH', 'HS', 'CS']);
const TTL_RE = /^\d+[smhdw]?$/i;

/** La línea sin su comentario («;» fuera de comillas) y el saldo de paréntesis que abre o cierra. */
function analizarLinea(line: string): { code: string; parens: number } {
  let quoted = false;
  let parens = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') {
      i++;
    } else if (c === '"') {
      quoted = !quoted;
    } else if (!quoted) {
      if (c === ';') return { code: line.slice(0, i), parens };
      if (c === '(') parens++;
      else if (c === ')') parens--;
    }
  }
  return { code: line, parens };
}

/** Nombre absoluto, en minúsculas y sin punto final, de un propietario del fichero de zona. */
function nombreAbsoluto(name: string, origin: string): string {
  const n = name.toLowerCase();
  if (n === '@') return origin;
  if (n.endsWith('.')) return n.slice(0, -1);
  return `${n}.${origin}`;
}

/**
 * Retira del fichero de zona los registros web (A, AAAA, CNAME, HTTPS y SVCB)
 * del dominio raíz y de www. El fichero se importa en el proveedor de DNS del
 * dominio, donde suele estar ya la web del cliente, alojada en Skyway o en otro
 * sitio: un registro de esos nombres la sustituiría. Mailway no los genera (su
 * selección solo trae MX, TXT, SRV y los CNAME de autoconfiguración), así que
 * esto es una defensa por si eso cambia o la respuesta no es la esperada.
 *
 * Entiende lo que admite un importador de BIND: nombres absolutos, relativos y
 * «@», `$ORIGIN`, líneas sin propietario (heredan el de la anterior) y
 * registros partidos en varias líneas entre paréntesis.
 */
export function stripWebRecords(zone: string, domain: string): { zone: string; removed: number } {
  const apex = domain.trim().toLowerCase().replace(/\.$/, '');
  const web = new Set([apex, `www.${apex}`]);
  let origin = apex;
  let owner: string | null = null;
  let depth = 0;
  let skipping = false;
  let removed = 0;
  const out: string[] = [];
  for (const line of zone.split(/\r?\n/)) {
    const { code, parens } = analizarLinea(line);
    if (depth > 0) {
      // Continuación de un registro entre paréntesis: corre la suerte de su primera línea.
      depth += parens;
      if (!skipping) out.push(line);
      continue;
    }
    skipping = false;
    if (!code.trim()) {
      out.push(line);
      continue;
    }
    const tokens = code.trim().split(/\s+/);
    if (tokens[0].startsWith('$')) {
      if (tokens[0].toUpperCase() === '$ORIGIN' && tokens[1]) origin = nombreAbsoluto(tokens[1], origin);
      out.push(line);
      continue;
    }
    let i = 0;
    if (!/^\s/.test(code)) owner = nombreAbsoluto(tokens[i++], origin);
    // TTL y clase pueden ir en cualquier orden antes del tipo.
    while (i < tokens.length && (TTL_RE.test(tokens[i]) || CLASES_DNS.has(tokens[i].toUpperCase()))) i++;
    const type = (tokens[i] ?? '').toUpperCase();
    depth = Math.max(0, parens);
    if (owner !== null && web.has(owner) && TIPOS_WEB.has(type)) {
      removed++;
      skipping = true;
      continue;
    }
    out.push(line);
  }
  if (removed === 0) return { zone, removed };
  const aviso =
    `;  Skyway ha retirado ${removed} registro(s) A, AAAA, CNAME, HTTPS o SVCB de ${apex} o www.${apex}: ` +
    'el fichero de correo no debe modificar la web del dominio.';
  return { zone: [aviso, ';', ...out].join('\n'), removed };
}

/**
 * Nombres propietarios del fichero de zona con sus tipos (`www.empresa.com` →
 * {A}). Mismo análisis que `stripWebRecords`: sirve para no añadir un registro
 * que choque con uno que ya trae el fichero (un CNAME no convive con nada).
 */
export function zoneOwners(zone: string, domain: string): Map<string, Set<string>> {
  const apex = domain.trim().toLowerCase().replace(/\.$/, '');
  let origin = apex;
  let owner: string | null = null;
  let depth = 0;
  const out = new Map<string, Set<string>>();
  for (const line of zone.split(/\r?\n/)) {
    const { code, parens } = analizarLinea(line);
    if (depth > 0) {
      depth += parens;
      continue;
    }
    if (!code.trim()) continue;
    const tokens = code.trim().split(/\s+/);
    if (tokens[0].startsWith('$')) {
      if (tokens[0].toUpperCase() === '$ORIGIN' && tokens[1]) origin = nombreAbsoluto(tokens[1], origin);
      continue;
    }
    let i = 0;
    if (!/^\s/.test(code)) owner = nombreAbsoluto(tokens[i++], origin);
    while (i < tokens.length && (TTL_RE.test(tokens[i]) || CLASES_DNS.has(tokens[i].toUpperCase()))) i++;
    const type = (tokens[i] ?? '').toUpperCase();
    depth = Math.max(0, parens);
    if (owner && type) {
      const set = out.get(owner) ?? new Set<string>();
      set.add(type);
      out.set(owner, set);
    }
  }
  return out;
}

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const NOMBRE_DNS_RE = /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/;

/**
 * Texto libre como comentario de una sola línea del fichero de zona. Un salto
 * de línea (o cualquier carácter de control) dentro de la nota cerraría el
 * comentario y lo que siguiera se importaría como un registro DNS más.
 */
function zoneComment(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
}

/** Registro web que Skyway añade al fichero de zona. */
export interface WebZoneRecord {
  name: string;
  type: 'A' | 'CNAME';
  value: string;
}

/**
 * Añade al fichero de zona, en secciones propias, los registros web de los
 * servicios del proyecto que cuelgan del dominio (A hacia la IP del servidor)
 * y el del webmail del cliente. Solo nombres del dominio (o el propio
 * dominio), sin duplicar ni chocar con lo que ya trae el fichero. Sin IP
 * configurada, los registros de los servicios se omiten y se dice en un
 * comentario.
 *
 * Los de los servicios van comentados: el importador de Cloudflare (y el de
 * casi cualquier proveedor) añade y no sustituye, así que sobre un nombre que
 * ya apunta al hosting anterior dejaría dos A y el tráfico se repartiría entre
 * los dos. Quien importa tiene que borrar antes el registro actual y quitar el
 * comentario; el del webmail es un nombre nuevo y va activo.
 */
export function appendWebRecords(
  zone: string,
  domain: string,
  input: { serverIp: string | null; hosts: string[]; webmail: WebZoneRecord | null; webmailNote?: string | null },
): { zone: string; added: number } {
  const apex = domain.trim().toLowerCase().replace(/\.$/, '');
  const owners = zoneOwners(zone, apex);
  const inZone = (h: string) => h === apex || h.endsWith(`.${apex}`);
  const ip = input.serverIp && IPV4_RE.test(input.serverIp) ? input.serverIp : null;
  const lines: string[] = [];
  let added = 0;
  const choca = (name: string, type: string) => {
    const tipos = owners.get(name);
    return !!tipos && (type === 'CNAME' || tipos.has('CNAME') || tipos.has(type));
  };

  const hosts = [...new Set(input.hosts.map((h) => h.trim().toLowerCase().replace(/\.$/, '')))]
    .filter((h) => inZone(h) && NOMBRE_DNS_RE.test(h) && h !== input.webmail?.name.toLowerCase().replace(/\.$/, ''))
    .sort();
  if (hosts.length > 0) {
    lines.push(';', ';  Registros web de los servicios de este proyecto en Skyway');
    if (!ip) {
      lines.push(
        `;  No se incluyen (${hosts.join(', ')}): no hay IP pública del servidor configurada en`,
        ';  Skyway (Ajustes → IP pública del servidor). Configúrala y vuelve a descargar el fichero.',
      );
    } else {
      lines.push(
        `;  Apuntan a la IP pública del servidor (${ip}) y van comentados a propósito: importar añade y no`,
        ';  sustituye. Si el nombre ya tiene un registro A, AAAA o CNAME (por ejemplo, del hosting anterior),',
        ';  bórralo antes en tu proveedor de DNS; si no, quedarían dos y el tráfico se repartiría entre ellos.',
        ';  Después quita el «; » del principio de la línea para importarla, sin proxy. Si el dominio está en',
        ';  el Cloudflare del administrador de Skyway, puede sustituirlo él desde los dominios del servicio.',
      );
      for (const h of hosts) {
        if (choca(h, 'A')) {
          lines.push(`;  ${h}: se omite, el fichero ya trae un registro con ese nombre.`);
          continue;
        }
        lines.push(`; ${h}.\t3600\tIN\tA\t${ip}`);
      }
    }
  }

  const w = input.webmail;
  if (w || input.webmailNote) {
    lines.push(';', ';  Webmail del cliente');
    if (input.webmailNote) lines.push(`;  ${zoneComment(input.webmailNote)}`);
    const name = w?.name.toLowerCase().replace(/\.$/, '') ?? '';
    const valueOk = w && (w.type === 'A' ? IPV4_RE.test(w.value) : NOMBRE_DNS_RE.test(w.value.toLowerCase()));
    if (w && inZone(name) && NOMBRE_DNS_RE.test(name) && valueOk && !input.webmailNote) {
      if (choca(name, w.type)) {
        lines.push(`;  ${name}: se omite, el fichero ya trae un registro con ese nombre.`);
      } else {
        const value = w.type === 'CNAME' ? `${w.value.toLowerCase().replace(/\.$/, '')}.` : w.value;
        lines.push(`${name}.\t3600\tIN\t${w.type}\t${value}`);
        added++;
      }
    }
  }
  if (lines.length === 0) return { zone, added };
  return { zone: `${zone.replace(/\s+$/, '')}\n${lines.join('\n')}\n`, added };
}

// ---------- buzones ----------

export function createMailbox(input: {
  domainId: string;
  localPart: string;
  displayName?: string;
}): Promise<{ mailbox: MailwayMailbox; password?: string }> {
  return mailwayFetch('/api/mailboxes', { method: 'POST', body: input });
}

/** Genera una contraseña nueva: los dispositivos configurados dejan de conectar. */
export function resetMailboxPassword(mailboxId: string): Promise<{ ok: boolean; password?: string }> {
  return mailwayFetch(`/api/mailboxes/${enc(mailboxId)}/password`, { method: 'POST', body: {} });
}

export async function deleteMailbox(mailboxId: string): Promise<void> {
  await mailwayFetch(`/api/mailboxes/${enc(mailboxId)}`, { method: 'DELETE' });
}

export async function createSetupLink(
  mailboxId: string,
  opts: { includePassword?: boolean; password?: string },
): Promise<MailwaySetupLink> {
  const res = await mailwayFetch<{ link: MailwaySetupLink }>(`/api/mailboxes/${enc(mailboxId)}/setup-links`, {
    method: 'POST',
    body: opts,
  });
  return res.link;
}

export function createAppPassword(
  mailboxId: string,
  name: string,
): Promise<{ appPassword: MailwayAppPasswordInfo; password: string }> {
  return mailwayFetch(`/api/mailboxes/${enc(mailboxId)}/app-passwords`, { method: 'POST', body: { name } });
}

/** Revoca una contraseña de aplicación: deja de funcionar al instante. */
export async function revokeAppPassword(mailboxId: string, appId: string): Promise<void> {
  await mailwayFetch(`/api/mailboxes/${enc(mailboxId)}/app-passwords/${enc(appId)}`, { method: 'DELETE' });
}

export function createApiKey(input: {
  clientId: string;
  name: string;
  senderMailboxId: string;
}): Promise<{ key: string; info: MailwayApiKeyInfo }> {
  return mailwayFetch('/api/apikeys', { method: 'POST', body: input });
}

/** Revoca una clave de la API de envío (Mailway retira también su contraseña SMTP interna). */
export async function revokeApiKey(keyId: string): Promise<void> {
  await mailwayFetch(`/api/apikeys/${enc(keyId)}`, { method: 'DELETE' });
}

// ---------- cambio de dominio (Mailway 1.3+) ----------

export type EstadoCambio =
  | 'preparando'
  | 'listo'
  | 'pasando'
  | 'pasado'
  | 'volviendo'
  | 'dando_de_baja'
  | 'dado_de_baja'
  | 'cancelada';

/** Vista previa del cambio (`POST /api/domain-migrations/plan`), sin efectos. */
export interface PlanCambioDominio {
  desde: { domainId: string; domain: string };
  hacia: { domain: string; existe: boolean; domainId: string | null };
  buzones: { id: string; de: string; a: string; usadoPorApps: string[] }[];
  alias: { id: string; de: string; a: string }[];
  formularios: { id: string; name: string; origenesNuevos: string[] }[];
  webmail: { viejo: string | null; nuevo: string | null };
  avisos: { code: string; mensaje: string }[];
  /** No vacío: la creación respondería 409 o 400 con el primero. */
  bloqueos: { code: string; mensaje: string }[];
}

export interface CambioDominioWebmail {
  id: string;
  hostname: string;
  status: string;
  principal: boolean;
}

/** Estado de un cambio de dominio en Mailway: el del correo vive SOLO allí. */
export interface CambioDominioVista {
  id: string;
  clientId: string;
  origen: 'panel' | 'skyway';
  referenciaExterna: string | null;
  desde: { domainId: string | null; domain: string };
  hacia: { domainId: string | null; domain: string; cloudflare: boolean; recibeEnOtroProveedor: boolean };
  estado: EstadoCambio;
  paso: string;
  error: string | null;
  /** Las direcciones nuevas ya reciben en los buzones (pre-recepción hecha). */
  recepcionPreparada: boolean;
  compuertas: {
    id: 'motor' | 'cliente' | 'propiedad' | 'recepcion' | 'dns' | 'webmail';
    ok: boolean;
    bloquea: boolean;
    titulo: string;
    detalle: string;
  }[];
  puedePasar: boolean;
  puedeVolver: boolean;
  puedeCancelar: boolean;
  puedeDarDeBaja: boolean;
  /** Sin red: apps SMTP pendientes y nombres de la instancia (el MX se mide al pulsar). */
  bloqueosBaja: { code: string; mensaje: string }[];
  buzones: {
    total: number;
    pendientes: number;
    lista: { id: string; email: string; login: string; pendiente: boolean; usadoPorApps: string[] }[];
  };
  alias: { total: number };
  webmail: { viejo: CambioDominioWebmail | null; nuevo: CambioDominioWebmail | null };
  /** A/AAAA/CNAME que Mailway creó en Cloudflare (Skyway los reserva al proyecto). */
  nombresCloudflare: string[];
  avisos: { code: string; mensaje: string }[];
  fechas: { creado: number; listo: number | null; pasado: number | null; terminado: number | null };
}

/**
 * Pasar, volver, cancelar y dar de baja trabajan dentro de la petición (todos
 * los buzones y alias, con el motor de correo y una recarga del directorio):
 * con el plazo normal, Skyway daría por fallida una operación que Mailway
 * termina bien. Aun así, la respuesta se puede perder (ver `accionCambio`).
 */
const PLAZO_CAMBIO_MS = 120_000;
/**
 * Crear y comprobar miden el DNS del dominio nuevo y pueden hacer la
 * pre-recepción (crear el dominio en el motor y añadir una dirección a cada
 * buzón): Mailway espera hasta 20 s y después sigue en segundo plano.
 */
const PLAZO_PREPARAR_MS = 60_000;

/** Una vista válida tiene al menos el id y el estado: lo demás se lee con tolerancia. */
function vistaCambio(res: unknown): CambioDominioVista {
  const v = res as Partial<CambioDominioVista> | null;
  if (!v || typeof v.id !== 'string' || typeof v.estado !== 'string') {
    throw new MailwayError('http', 'La respuesta de Mailway no es válida: falta el cambio de dominio.', 502);
  }
  return v as CambioDominioVista;
}

/** Vista previa del cambio de `fromDomainId` a `toDomain`. `soloCliente`, como en `createDomain`. */
export async function planDomainMigration(
  fromDomainId: string,
  toDomain: string,
  opts: { soloCliente?: boolean } = {},
): Promise<PlanCambioDominio> {
  const res = await mailwayFetch<PlanCambioDominio>(`/api/domain-migrations/plan${cloudflareQuery(opts.soloCliente)}`, {
    method: 'POST',
    body: { fromDomainId, toDomain },
  });
  if (!res || typeof res !== 'object' || !res.desde || !res.hacia) {
    throw new MailwayError('http', 'La respuesta de Mailway no es válida: falta el plan del cambio de dominio.', 502);
  }
  return {
    ...res,
    buzones: Array.isArray(res.buzones) ? res.buzones : [],
    alias: Array.isArray(res.alias) ? res.alias : [],
    formularios: Array.isArray(res.formularios) ? res.formularios : [],
    avisos: Array.isArray(res.avisos) ? res.avisos : [],
    bloqueos: Array.isArray(res.bloqueos) ? res.bloqueos : [],
  };
}

/**
 * Abre el cambio en Mailway con `origen: 'skyway'`: desde ese momento solo se
 * pasa, se vuelve, se cancela o se da de baja con un token de gestión (el de
 * Skyway), no desde el panel de Mailway. Idempotente: si ya estaba abierto con
 * el mismo origen y destino, Mailway devuelve el mismo cambio (200).
 */
export async function createDomainMigration(
  input: { fromDomainId: string; toDomain: string; referenciaExterna: string; autoDns?: boolean; origen?: 'skyway' },
  opts: { soloCliente?: boolean } = {},
): Promise<CambioDominioVista> {
  const res = await mailwayFetch<unknown>(`/api/domain-migrations${cloudflareQuery(opts.soloCliente)}`, {
    method: 'POST',
    body: {
      fromDomainId: input.fromDomainId,
      toDomain: input.toDomain,
      autoDns: input.autoDns ?? true,
      origen: input.origen ?? 'skyway',
      referenciaExterna: input.referenciaExterna,
    },
    timeoutMs: PLAZO_PREPARAR_MS,
  });
  return vistaCambio(res);
}

export async function getDomainMigration(id: string): Promise<CambioDominioVista> {
  return vistaCambio(await mailwayFetch<unknown>(`/api/domain-migrations/${enc(id)}`));
}

/** Avanza la preparación (mide el DNS y, con la propiedad probada, hace la pre-recepción). */
export async function checkDomainMigration(id: string): Promise<CambioDominioVista> {
  return vistaCambio(
    await mailwayFetch<unknown>(`/api/domain-migrations/${enc(id)}/check`, { method: 'POST', body: {}, timeoutMs: PLAZO_PREPARAR_MS }),
  );
}

type AccionCambio = 'switch' | 'rollback' | 'cancel' | 'retire';

/**
 * Estado en el que queda el cambio cuando la acción ha terminado bien. Volver
 * deja el cambio «listo», y Mailway puede devolverlo a «preparando» si una
 * medición posterior del DNS falla: las dos valen.
 */
const ESTADO_TRAS: Record<AccionCambio, readonly EstadoCambio[]> = {
  switch: ['pasado'],
  rollback: ['listo', 'preparando'],
  cancel: ['cancelada'],
  retire: ['dado_de_baja'],
};

/**
 * ¿Puede haber hecho Mailway la acción aunque Skyway no lo sepa? Si vence el
 * plazo o se corta la conexión, Mailway puede terminarla igualmente; y al
 * reintentarla, solo pasar es idempotente: volver, cancelar y dar de baja
 * responden 409 `migration_state` porque el cambio ya no está en el estado de
 * partida. Un 5xx puede venir de un proxy que cortó la espera (si es de
 * Mailway, el cambio no habrá llegado al estado final y el error se devuelve
 * tal cual). Los errores propios de la acción (confirmación, MX, apps) no.
 */
function puedeEstarHecha(err: MailwayError): boolean {
  if (err.kind === 'timeout' || err.kind === 'network') return true;
  if (err.kind !== 'http' || err.status === null) return false;
  return err.status >= 500 || (err.status === 409 && err.code === 'migration_state');
}

/**
 * Lanza la acción y, si falla de una forma que no descarta que Mailway la haya
 * hecho, consulta el cambio: si ya está en el estado en el que la acción lo
 * deja, la da por buena. Sin esto, un «Volver» o una baja cuya respuesta se
 * pierde dejarían a Skyway y a Mailway en estados distintos para siempre (el
 * reintento recibe 409 y la web se queda sin volver, o la baja sin cerrarse).
 */
async function accionCambio(id: string, accion: AccionCambio, body: object = {}): Promise<CambioDominioVista> {
  try {
    return vistaCambio(
      await mailwayFetch<unknown>(`/api/domain-migrations/${enc(id)}/${accion}`, { method: 'POST', body, timeoutMs: PLAZO_CAMBIO_MS }),
    );
  } catch (err) {
    if (!(err instanceof MailwayError) || !puedeEstarHecha(err)) throw err;
    let vista: CambioDominioVista;
    try {
      vista = await getDomainMigration(id);
    } catch {
      throw err;
    }
    if (ESTADO_TRAS[accion].includes(vista.estado)) return vista;
    throw err;
  }
}

/** Pasa el correo al dominio nuevo: sale como @dominio2.es y lo que llega a @dominio.es sigue entrando. */
export function switchDomainMigration(id: string): Promise<CambioDominioVista> {
  return accionCambio(id, 'switch');
}

/** Vuelve al dominio anterior; quien ya actualizó sus dispositivos sigue entrando con su usuario nuevo. */
export function rollbackDomainMigration(id: string): Promise<CambioDominioVista> {
  return accionCambio(id, 'rollback');
}

/** Cancela antes de pasar (409 `migration_new_mx_here` si el MX nuevo ya apunta al servidor). */
export function cancelDomainMigration(id: string): Promise<CambioDominioVista> {
  return accionCambio(id, 'cancel');
}

/** Da de baja el dominio anterior. `confirm` es el dominio anterior escrito por el usuario. */
export function retireDomainMigration(id: string, confirm: string): Promise<CambioDominioVista> {
  return accionCambio(id, 'retire', { confirm });
}

/**
 * Cambia el usuario del buzón a su dirección vigente («Actualizar mis
 * dispositivos»). Idempotente. Con el token de gestión Mailway lo permite
 * aunque lo usen aplicaciones: Skyway actualiza después sus variables.
 */
export async function updateMailboxLogin(mailboxId: string): Promise<{ mailbox: MailwayMailbox }> {
  const res = await mailwayFetch<{ mailbox?: MailwayMailbox }>(`/api/mailboxes/${enc(mailboxId)}/login-update`, {
    method: 'POST',
    body: {},
  });
  if (!res.mailbox || typeof res.mailbox.id !== 'string') {
    throw new MailwayError('http', 'La respuesta de Mailway no es válida: falta el buzón.', 502);
  }
  return { mailbox: res.mailbox };
}

// ---------- marca blanca (webmail con el dominio del cliente) ----------

export type MailwayWhitelabelStatus = 'pending_dns' | 'issuing' | 'active' | 'error';

/** Dominio propio de un cliente (marca blanca): sirve su webmail o su panel con certificado propio. */
export interface MailwayWhitelabelDomain {
  id: string;
  clientId: string;
  hostname: string;
  kind: 'webmail' | 'panel';
  status: MailwayWhitelabelStatus;
  detail?: string;
  lastCheckedAt?: number | null;
  activatedAt?: number | null;
  createdAt?: number;
  /** Webmail principal del cliente: el que usan sus enlaces y datos de conexión. */
  isPrimary?: boolean;
}

/** Registro que hay que crear para que el nombre apunte al servidor (CNAME recomendado o A). */
export interface MailwayDnsInstruction {
  type: string;
  name: string;
  value: string;
  recommended?: boolean;
  help?: string;
}

export interface MailwayWhitelabelView {
  domain: MailwayWhitelabelDomain;
  instructions?: MailwayDnsInstruction[];
}

export interface MailwayWhitelabelCloudflareResult {
  applied?: { action: string; type: string; name: string }[];
  errors?: { type: string; name: string; error: string }[];
  /** Conflictos que Mailway no ha tocado (ya hay otro registro con ese nombre). */
  skipped?: { type: string; name: string; reason: string }[];
  domain?: MailwayWhitelabelDomain;
}

/** Dominios propios de un cliente. La consulta va filtrada por cliente (con un token de administrador). */
export async function listWhitelabelDomains(clientId: string): Promise<MailwayWhitelabelDomain[]> {
  const res = await mailwayFetch<{ domains?: MailwayWhitelabelDomain[] }>(`/api/whitelabel/domains?clientId=${enc(clientId)}`);
  return Array.isArray(res.domains) ? res.domains : [];
}

/**
 * Dominios propios de TODOS los clientes, en cualquier estado (sin `clientId`,
 * con un token de administrador). Plazo corto: se lee junto a las rutas del
 * puente de Traefik, que no puede esperar. Una respuesta sin la lista es un
 * fallo, no una lista vacía: vaciarla liberaría los nombres reservados.
 */
export async function listAllWhitelabelDomains(timeoutMs = 5000): Promise<MailwayWhitelabelDomain[]> {
  const res = await requestMailway<{ domains?: MailwayWhitelabelDomain[] }>('/api/whitelabel/domains', { timeoutMs });
  if (!Array.isArray(res.domains)) {
    throw new MailwayError('http', 'La respuesta de Mailway no incluye la lista de dominios propios.', 502);
  }
  return res.domains;
}

export function getWhitelabelDomain(id: string): Promise<MailwayWhitelabelView> {
  return mailwayFetch<MailwayWhitelabelView>(`/api/whitelabel/domains/${enc(id)}`);
}

/**
 * Da de alta el webmail del cliente en `hostname`. Mailway exige que sea un
 * subdominio de un dominio de correo del cliente con la propiedad comprobada.
 */
export function createWhitelabelDomain(input: { hostname: string; clientId: string }): Promise<MailwayWhitelabelView> {
  return mailwayFetch<MailwayWhitelabelView>('/api/whitelabel/domains', {
    method: 'POST',
    body: { hostname: input.hostname, clientId: input.clientId, kind: 'webmail' },
  });
}

/** Comprueba el DNS y el certificado del nombre y avanza su estado. */
export function verifyWhitelabelDomain(id: string): Promise<MailwayWhitelabelView> {
  return mailwayFetch<MailwayWhitelabelView>(`/api/whitelabel/domains/${enc(id)}/verify`, { method: 'POST' });
}

/**
 * Crea en Cloudflare el registro del nombre. Nunca reemplaza un registro que ya
 * exista con otro valor: Mailway lo devuelve en `skipped`. `soloCliente`, como
 * en los dominios de correo.
 */
/**
 * Registro del webmail en Cloudflare. `soloCrear` (el que se crea solo al
 * configurar el webmail) pide a Mailway que no modifique un registro que ya
 * exista, ni para quitarle el proxy: eso queda para el botón, a la vista.
 */
export function applyWhitelabelCloudflare(
  id: string,
  opts: { soloCliente?: boolean; soloCrear?: boolean },
): Promise<MailwayWhitelabelCloudflareResult> {
  return mailwayFetch<MailwayWhitelabelCloudflareResult>(
    `/api/whitelabel/domains/${enc(id)}/cloudflare${cloudflareQuery(opts.soloCliente)}`,
    { method: 'POST', body: opts.soloCrear ? { soloCrear: true } : {} },
  );
}

/** Marca el webmail como principal de su cliente (debe estar en servicio). */
export function setPrimaryWebmail(id: string): Promise<{ domain: MailwayWhitelabelDomain }> {
  return mailwayFetch(`/api/whitelabel/domains/${enc(id)}/primary`, { method: 'POST' });
}

// ---------- webmail automático (webmail.<dominio> de cada dominio, sin pedirlo) ----------

export interface MailwayWebmailAutomatico {
  /** Interruptor del cliente, tal como queda. */
  webmailAutomatico: boolean;
  /** Interruptor global de la instancia; null si Mailway no lo ha indicado. */
  global: boolean | null;
  /** Webmail de marca del cliente después del cambio. */
  webmailDomains: MailwayWebmailDomain[];
}

/**
 * Enciende o apaga el webmail automático del cliente. Encendido, Mailway
 * prepara en el momento `webmail.<dominio>` de cada dominio con la propiedad
 * comprobada (pueden volver esperando DNS o emitiendo el certificado y quedar
 * en servicio a los pocos minutos); apagado, retira los que creó solo, con el
 * registro DNS que creó para ellos. Mientras el interruptor global esté
 * apagado, el del cliente se guarda pero no tiene efecto.
 */
export async function setWebmailAutomatico(clientId: string, activo: boolean): Promise<MailwayWebmailAutomatico> {
  const res = await mailwayFetch<Partial<MailwayWebmailAutomatico>>(`/api/clients/${enc(clientId)}/webmail-automatico`, {
    method: 'PUT',
    body: { activo },
  });
  if (typeof res.webmailAutomatico !== 'boolean') {
    throw new MailwayError('http', 'La respuesta de Mailway no es válida: falta el estado del webmail automático.', 502);
  }
  return {
    webmailAutomatico: res.webmailAutomatico,
    global: typeof res.global === 'boolean' ? res.global : null,
    webmailDomains: Array.isArray(res.webmailDomains) ? res.webmailDomains : [],
  };
}

// ---------- configuración inicial (enlace de bienvenida del cliente) ----------

export type MailwayInviteStatus = 'pending' | 'accepted' | 'expired' | 'revoked';

/**
 * Enlace de bienvenida tal como lo lista Mailway: sin la URL, que es una
 * credencial (con ella se crea un acceso al panel del cliente).
 */
export interface MailwayInvite {
  id: string;
  email: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  openedAt: number | null;
  acceptedAt: number | null;
  revokedAt: number | null;
  status: MailwayInviteStatus;
  /** Pendiente y con la URL todavía recuperable: se puede volver a mostrar. */
  recoverable: boolean;
}

/** Enlace de bienvenida con su URL: solo al crearlo y al recuperarlo. */
export interface MailwayInviteLink {
  id: string;
  url: string;
  email: string;
  name: string;
  expiresAt: number;
  /** El correo ya es de un usuario de ese cliente: con el enlace elige una contraseña nueva (solo al crearlo). */
  existingUser?: boolean;
}

function inviteOf(res: { invite?: MailwayInviteLink }): MailwayInviteLink {
  if (!res.invite || typeof res.invite.id !== 'string' || !res.invite.id) {
    throw new MailwayError('http', 'La respuesta de Mailway no incluye el enlace de bienvenida.', 502);
  }
  return res.invite;
}

/**
 * Crea el enlace de bienvenida de la persona de contacto del cliente: con él
 * crea su acceso al panel de Mailway y entra en la puesta en marcha (dominio y
 * buzones). Sirve una vez y sustituye al que esa persona tuviera pendiente.
 * Mailway responde 409 `user_exists` si el correo es de la administración o
 * de otro cliente, y 400 `client_suspended` con el cliente suspendido.
 */
export async function createInvite(
  clientId: string,
  input: { email: string; name?: string; ttlHours?: number },
): Promise<MailwayInviteLink> {
  return inviteOf(await mailwayFetch(`/api/clients/${enc(clientId)}/invites`, { method: 'POST', body: input }));
}

/** Enlaces de bienvenida del cliente (los más recientes, como los da Mailway). Sin la lista, es un fallo. */
export async function listInvites(clientId: string): Promise<MailwayInvite[]> {
  const res = await mailwayFetch<{ invites?: MailwayInvite[] }>(`/api/clients/${enc(clientId)}/invites`);
  if (!Array.isArray(res.invites)) {
    throw new MailwayError('http', 'La respuesta de Mailway no incluye la lista de enlaces de bienvenida.', 502);
  }
  return res.invites;
}

/**
 * URL de un enlace pendiente, para volver a enviarlo. 404 `invite_invalid` si
 * ya se ha usado, revocado o caducado; 409 `invite_not_recoverable` si Mailway
 * ya no la conserva.
 */
export async function getInviteUrl(clientId: string, inviteId: string): Promise<MailwayInviteLink> {
  return inviteOf(await mailwayFetch(`/api/clients/${enc(clientId)}/invites/${enc(inviteId)}/url`));
}

/** Revoca un enlace de bienvenida: deja de servir al instante. */
export async function revokeInvite(clientId: string, inviteId: string): Promise<void> {
  await mailwayFetch(`/api/clients/${enc(clientId)}/invites/${enc(inviteId)}`, { method: 'DELETE' });
}

// ---------- Traefik ----------

/**
 * Configuración dinámica de Traefik que publica Mailway (dominios de marca
 * blanca y de autoconfiguración). Se autentica con su token propio, no con el
 * de gestión. Plazo corto: quien espera es Traefik, que corta a los pocos
 * segundos (ver `--providers.http.pollTimeout` en docker-compose.yml).
 */
export function getTraefikConfig(token: string, timeoutMs = 5000): Promise<unknown> {
  return requestMailway<unknown>('/api/traefik/config', { headers: { 'X-Mailway-Token': token }, timeoutMs });
}
