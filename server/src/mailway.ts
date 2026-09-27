/**
 * Cliente de la API de integraciones de Mailway (el servicio de correo
 * multicliente del operador). Skyway lo usa para crear y gestionar, desde cada
 * proyecto, el cliente de correo, sus dominios y buzones, y para inyectar en los
 * servicios las credenciales de envío.
 *
 * Sin dependencias: `fetch` con plazo, JSON y un token de gestión (`mwt_…`)
 * que se guarda en Ajustes y JAMÁS se devuelve ni se registra. Con un token de
 * administrador Skyway puede tocar cualquier cliente de Mailway, así que el
 * aislamiento entre proyectos NO lo da Mailway: lo imponen las rutas
 * (`routes/mailway.ts`), que comprueban cada dominio y buzón contra el cliente
 * vinculado al proyecto antes de actuar.
 */
import { getProject, getService, getSetting, setSetting } from './db';
import { containerName } from './docker/containers';

/** Claves de Ajustes. El token y el de Traefik son secretos: solo se leen aquí. */
export const MAILWAY_SETTING = {
  baseUrl: 'mailway.baseUrl',
  token: 'mailway.token',
  serviceId: 'mailway.serviceId',
  traefikToken: 'mailway.traefikToken',
  traefikCache: 'mailway.traefikCache',
} as const;

/** Prefijo de la referencia externa con la que Mailway identifica al proyecto. */
export function projectExternalRef(projectId: string): string {
  return `skyway:project:${projectId}`;
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
  features?: { cloudflare?: boolean; autoconfig?: boolean; portal?: boolean };
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
}

export interface MailwayUsage {
  domains?: number;
  mailboxes?: number;
  aliases?: number;
  apiKeys?: number;
  messagesLast30d?: number;
}

export interface MailwaySummary {
  client: { id: string; name: string; slug: string; externalRef: string | null; suspended: boolean };
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
}

export interface MailwayCloudflarePlan {
  available: boolean;
  reason?: string;
  account?: { id: string; label: string };
  zone?: { id: string; name: string; status: string };
  changes: MailwayCloudflareChange[];
  summary: { create: number; update: number; keep: number; conflict: number };
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
  if (cfg.baseUrl && !out.includes(cfg.baseUrl)) out.push(cfg.baseUrl);
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
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Configuración alternativa (probar valores aún sin guardar). */
  config?: MailwayConfig;
  timeoutMs?: number;
  /** Cabeceras de autenticación propias; por defecto, el token de gestión como Bearer. */
  headers?: Record<string, string>;
}

/**
 * Petición a Mailway probando primero la dirección interna y después la
 * pública. Devuelve el cuerpo JSON o lanza `MailwayError` con un mensaje listo
 * para la interfaz (el `error` de Mailway cuando lo hay).
 */
async function requestMailway<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const cfg = opts.config ?? readMailwayConfig();
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
  if (!opts.headers) {
    if (!cfg.token) throw new MailwayError('config', 'No se ha configurado ningún token de gestión de Mailway.');
    headers.Authorization = `Bearer ${cfg.token}`;
  }
  const bases = candidateBases(cfg);
  if (bases.length === 0) {
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
          'Compruebe la dirección configurada y que el panel esté en funcionamiento.',
      );
    }
    return parseResponse<T>(res);
  }
  // Inalcanzable: el bucle o devuelve o lanza en la última dirección.
  throw new MailwayError('network', 'No se ha podido conectar con Mailway.');
}

async function parseResponse<T>(res: Response): Promise<T> {
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
      `La dirección de Mailway redirige${destino ? ` a ${destino}` : ''}. Indique la dirección definitiva en Ajustes → Correo (Mailway).`,
      502,
    );
  }
  if (res.status === 401) {
    throw new MailwayError(
      'auth',
      'Mailway ha rechazado el token de gestión (401). Revise el token en Ajustes → Correo (Mailway).',
      401,
      code,
    );
  }
  if (!res.ok) {
    throw new MailwayError('http', mensaje ?? `Mailway ha respondido con el código HTTP ${res.status}.`, res.status, code);
  }
  if (body === undefined || typeof body !== 'object' || body === null) {
    throw new MailwayError(
      'http',
      'La respuesta de Mailway no es válida. Compruebe que la dirección configurada corresponde al panel de Mailway.',
      res.status,
    );
  }
  return body as T;
}

/** Petición autenticada con el token de gestión. */
export function mailwayFetch<T>(
  path: string,
  opts: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; config?: MailwayConfig } = {},
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
    throw new MailwayError('http', 'La respuesta de Mailway no es válida. Compruebe que la versión de Mailway admite integraciones.');
  }
  if (!opts.config) {
    infoCache = { info, at: Date.now() };
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

/** URL pública del panel para los enlaces que ve el usuario. */
export function publicPanelUrl(cfg: MailwayConfig = readMailwayConfig()): string | null {
  return normalizeBaseUrl(cachedInfo()?.panelUrl) ?? cfg.baseUrl;
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

export async function unlinkClient(clientId: string): Promise<MailwayClient | null> {
  const res = await mailwayFetch<{ client?: MailwayClient }>(`/api/integrations/clients/${enc(clientId)}/link`, {
    method: 'DELETE',
  });
  return res.client ?? null;
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
  };
}

// ---------- dominios ----------

export async function createDomain(clientId: string, domain: string): Promise<MailwayDomain> {
  const res = await mailwayFetch<{ domain: MailwayDomain }>('/api/domains', { method: 'POST', body: { domain, clientId } });
  return res.domain;
}

export async function verifyDomain(domainId: string): Promise<MailwayDomain> {
  const res = await mailwayFetch<{ domain: MailwayDomain }>(`/api/domains/${enc(domainId)}/verify`, { method: 'POST' });
  return res.domain;
}

export async function getDomainDns(domainId: string): Promise<MailwayDnsRecord[]> {
  const res = await mailwayFetch<{ records?: MailwayDnsRecord[] }>(`/api/domains/${enc(domainId)}/dns`);
  return Array.isArray(res.records) ? res.records : [];
}

export function getCloudflarePlan(domainId: string): Promise<MailwayCloudflarePlan> {
  return mailwayFetch<MailwayCloudflarePlan>(`/api/domains/${enc(domainId)}/cloudflare`);
}

export function applyCloudflare(domainId: string, opts: { replaceConflicts?: boolean }): Promise<MailwayCloudflareResult> {
  return mailwayFetch<MailwayCloudflareResult>(`/api/domains/${enc(domainId)}/cloudflare/apply`, {
    method: 'POST',
    body: { replaceConflicts: !!opts.replaceConflicts },
  });
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

export function createApiKey(input: {
  clientId: string;
  name: string;
  senderMailboxId: string;
}): Promise<{ key: string; info: MailwayApiKeyInfo }> {
  return mailwayFetch('/api/apikeys', { method: 'POST', body: input });
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
