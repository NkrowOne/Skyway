/**
 * GitHub App de la instalación.
 *
 * Los tokens personales (PAT) tienen tres problemas que el usuario nota: hay
 * que crearlos a mano en GitHub, caducan —y el día que caducan los despliegues
 * dejan de funcionar sin avisar— y dan acceso a TODO lo que ve esa cuenta. Una
 * GitHub App resuelve los tres: se instala una vez sobre los repos elegidos, no
 * caduca, y sus credenciales de clonado son tokens de instalación efímeros que
 * Skyway renueva solo.
 *
 * La App se crea desde el propio panel con el «flujo de manifiesto» de GitHub:
 * el navegador envía un manifiesto a github.com, el usuario confirma, y GitHub
 * devuelve un código de un solo uso que aquí se canjea por el id, la clave
 * privada y el secreto del webhook. Sin copiar y pegar nada.
 */

import jwt from 'jsonwebtoken';
import { getSetting, setSetting } from '../db';
import { GithubError, ghFetch, GithubRepo, toGithubRepo } from './client';

export interface GithubAppConfig {
  appId: string;
  slug: string;
  name: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  htmlUrl: string;
}

const SETTING = {
  appId: 'githubAppId',
  slug: 'githubAppSlug',
  name: 'githubAppName',
  privateKey: 'githubAppPrivateKey',
  clientId: 'githubAppClientId',
  clientSecret: 'githubAppClientSecret',
  webhookSecret: 'githubAppWebhookSecret',
  htmlUrl: 'githubAppHtmlUrl',
} as const;

/** Credenciales de la App, o null si aún no se ha creado/enlazado ninguna. */
export function githubAppConfig(): GithubAppConfig | null {
  const appId = getSetting(SETTING.appId);
  const privateKey = getSetting(SETTING.privateKey);
  const slug = getSetting(SETTING.slug);
  if (!appId || !privateKey || !slug) return null;
  return {
    appId,
    slug,
    name: getSetting(SETTING.name) || slug,
    privateKey,
    clientId: getSetting(SETTING.clientId) || '',
    clientSecret: getSetting(SETTING.clientSecret) || '',
    webhookSecret: getSetting(SETTING.webhookSecret) || '',
    htmlUrl: getSetting(SETTING.htmlUrl) || `https://github.com/apps/${slug}`,
  };
}

export function githubAppConfigured(): boolean {
  return githubAppConfig() !== null;
}

/** Borra las credenciales de la App (desenlazar sin tocar nada en GitHub). */
export function clearGithubApp(): void {
  for (const key of Object.values(SETTING)) setSetting(key, null);
  tokenCache.clear();
}

/**
 * JWT de la App (RS256, ≤10 min de vida). Autentica a la App ante GitHub para
 * las operaciones «de app»: listar instalaciones y emitir tokens de instalación.
 * El `iat` se retrasa 60 s por el desfase de reloj que GitHub documenta.
 */
function appJwt(cfg: GithubAppConfig): string {
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    return jwt.sign({ iat: nowSec - 60, exp: nowSec + 540, iss: cfg.appId }, cfg.privateKey, { algorithm: 'RS256' });
  } catch (err: any) {
    throw new GithubError(
      `La clave privada de la GitHub App no es válida (${err?.message || 'error al firmar'}). Vuelve a conectar la App desde Ajustes.`,
    );
  }
}

// ---------- tokens de instalación ----------

interface CachedToken {
  token: string;
  /** Instante en ms a partir del cual conviene renovar (5 min de margen). */
  renewAt: number;
}

const tokenCache = new Map<number, CachedToken>();
/** Peticiones en vuelo: varias descargas a la vez no deben pedir N tokens. */
const inflight = new Map<number, Promise<string>>();

const RENEW_MARGIN_MS = 5 * 60_000;

/**
 * Token de clonado de una instalación. Vive una hora; se cachea en memoria y se
 * renueva con margen. No se persiste: si Skyway reinicia se pide otro, que es
 * más barato que guardar una credencial viva en disco.
 */
export async function installationToken(installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && Date.now() < cached.renewAt) return cached.token;

  const pending = inflight.get(installationId);
  if (pending) return pending;

  const cfg = githubAppConfig();
  if (!cfg) throw new GithubError('La GitHub App no está configurada en este servidor.');

  const request = (async () => {
    const res = await ghFetch(`/app/installations/${installationId}/access_tokens`, {
      token: appJwt(cfg),
      method: 'POST',
      passthrough: [404],
    });
    if (res.status === 404) {
      throw new GithubError(
        'GitHub ya no conoce esa instalación de la App: se desinstaló desde GitHub. Vuelve a conectar la cuenta.',
        404,
      );
    }
    const body: any = await res.json().catch(() => ({}));
    if (!body?.token) throw new GithubError('GitHub no devolvió token de instalación.');
    const expiresAt = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 3600_000;
    tokenCache.set(installationId, {
      token: body.token,
      renewAt: (Number.isFinite(expiresAt) ? expiresAt : Date.now() + 3600_000) - RENEW_MARGIN_MS,
    });
    return body.token as string;
  })();

  inflight.set(installationId, request);
  try {
    return await request;
  } finally {
    inflight.delete(installationId);
  }
}

/** Olvida el token cacheado (al desconectar una instalación). */
export function forgetInstallationToken(installationId: number): void {
  tokenCache.delete(installationId);
}

// ---------- instalaciones ----------

export interface GithubInstallationInfo {
  installationId: number;
  accountLogin: string;
  accountType: string;
  /** 'all' o 'selected': si la App ve toda la cuenta o solo repos elegidos. */
  repositorySelection: string;
  suspended: boolean;
}

function toInstallationInfo(raw: any): GithubInstallationInfo {
  return {
    installationId: Number(raw?.id),
    accountLogin: raw?.account?.login ?? '(desconocido)',
    accountType: raw?.account?.type ?? 'User',
    repositorySelection: raw?.repository_selection ?? 'selected',
    suspended: !!raw?.suspended_at,
  };
}

/** Ficha de una instalación concreta (autenticado como App). */
export async function getInstallation(installationId: number): Promise<GithubInstallationInfo> {
  const cfg = githubAppConfig();
  if (!cfg) throw new GithubError('La GitHub App no está configurada en este servidor.');
  const res = await ghFetch(`/app/installations/${installationId}`, { token: appJwt(cfg) });
  return toInstallationInfo(await res.json().catch(() => ({})));
}

/** Todas las instalaciones vivas de la App (para reconciliar con la BD). */
export async function listAppInstallations(): Promise<GithubInstallationInfo[]> {
  const cfg = githubAppConfig();
  if (!cfg) return [];
  const res = await ghFetch('/app/installations?per_page=100', { token: appJwt(cfg) });
  const body: any[] = (await res.json().catch(() => [])) as any[];
  return Array.isArray(body) ? body.map(toInstallationInfo) : [];
}

const REPOS_MAX_PAGES = 5; // hasta 500 repos accesibles por instalación

/** Repos que la instalación deja ver, los más recientes primero. */
export async function listInstallationRepos(installationId: number): Promise<GithubRepo[]> {
  const token = await installationToken(installationId);
  const repos: GithubRepo[] = [];
  for (let page = 1; page <= REPOS_MAX_PAGES; page++) {
    const res = await ghFetch(`/installation/repositories?per_page=100&page=${page}`, { token });
    const body: any = await res.json().catch(() => ({}));
    const list: any[] = Array.isArray(body?.repositories) ? body.repositories : [];
    for (const raw of list) {
      const repo = toGithubRepo(raw);
      if (repo) repos.push(repo);
    }
    if (list.length < 100) break;
  }
  // La API no admite sort aquí: se ordena en casa por último push.
  repos.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
  return repos;
}

// ---------- creación de la App con manifiesto ----------

export interface AppManifest {
  name: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  callback_urls: string[];
  setup_url: string;
  setup_on_update: boolean;
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
  request_oauth_on_install: boolean;
}

/**
 * Manifiesto de la App. Pide lo mínimo imprescindible: leer el contenido de los
 * repos (clonar) y sus metadatos, y recibir el evento `push`. Nada de escritura:
 * Skyway nunca empuja a GitHub.
 */
export function buildAppManifest(baseUrl: string, suffix: string): AppManifest {
  const base = baseUrl.replace(/\/+$/, '');
  let host = 'skyway';
  try {
    host = new URL(base).hostname;
  } catch {
    /* baseUrl ya viene validada por la ruta; el nombre es solo cosmético */
  }
  return {
    name: `Skyway ${host} ${suffix}`.slice(0, 34), // GitHub limita el nombre a 34 caracteres
    url: base,
    hook_attributes: { url: `${base}/api/webhooks/github/app`, active: true },
    redirect_url: `${base}/api/github/app/setup`,
    callback_urls: [`${base}/api/github/app/setup`],
    setup_url: `${base}/api/github/app/installed`,
    setup_on_update: true,
    public: false,
    default_permissions: { contents: 'read', metadata: 'read' },
    default_events: ['push'],
    request_oauth_on_install: false,
  };
}

/**
 * Canjea el código del manifiesto por las credenciales definitivas y las
 * guarda. El código es de un solo uso y caduca en una hora.
 */
export async function convertManifestCode(code: string): Promise<GithubAppConfig> {
  const res = await ghFetch(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST' });
  const body: any = await res.json().catch(() => ({}));
  if (!body?.id || !body?.pem || !body?.slug) {
    throw new GithubError('GitHub no devolvió las credenciales de la App. Vuelve a intentarlo.');
  }
  setSetting(SETTING.appId, String(body.id));
  setSetting(SETTING.slug, String(body.slug));
  setSetting(SETTING.name, String(body.name ?? body.slug));
  setSetting(SETTING.privateKey, String(body.pem));
  setSetting(SETTING.clientId, String(body.client_id ?? ''));
  setSetting(SETTING.clientSecret, String(body.client_secret ?? ''));
  setSetting(SETTING.webhookSecret, String(body.webhook_secret ?? ''));
  setSetting(SETTING.htmlUrl, String(body.html_url ?? `https://github.com/apps/${body.slug}`));
  tokenCache.clear();
  return githubAppConfig()!;
}

/** URL donde el usuario instala la App sobre su cuenta u organización. */
export function installUrl(cfg: GithubAppConfig, state: string): string {
  return `https://github.com/apps/${encodeURIComponent(cfg.slug)}/installations/new?state=${encodeURIComponent(state)}`;
}

/** URL para revisar qué repos ve una instalación ya hecha. */
export function configureUrl(cfg: GithubAppConfig, installationId: number): string {
  return `${cfg.htmlUrl.replace(/\/+$/, '')}/installations/${installationId}`;
}
