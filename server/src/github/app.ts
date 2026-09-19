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
import { GhRequest, GithubError, ghFetch, GithubRepo, toGithubRepo } from './client';

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
  lastAppInfoCheck = 0;
}

// ---------- ficha de la App (slug, nombre) ----------

/** Cada cuánto se vuelve a preguntar a GitHub por la ficha de la App. */
const APP_INFO_TTL_MS = 5 * 60_000;
let lastAppInfoCheck = 0;
let appInfoInflight: Promise<void> | null = null;

/**
 * Pone al día `slug`, nombre y URL de la App desde `GET /app`. Si el
 * administrador renombra la App en GitHub cambia su slug, y con el antiguo
 * guardado tanto la página de la App como el enlace de instalación daban 404;
 * el `appId` (lo que firma el JWT) no cambia, así que se puede preguntar.
 *
 * Memoizada (una consulta cada 5 min como mucho) y nunca lanza: si GitHub no
 * contesta se sigue con lo guardado y se reintenta pasado el plazo.
 */
export async function refreshAppInfo(opts: { force?: boolean } = {}): Promise<GithubAppConfig | null> {
  const cfg = githubAppConfig();
  if (!cfg) return null;
  if (!opts.force && Date.now() - lastAppInfoCheck < APP_INFO_TTL_MS) return cfg;
  if (!appInfoInflight) {
    // La marca se pone ANTES de preguntar: un fallo también cuenta como
    // intento, o un GitHub caído se consultaría en cada petición del panel.
    lastAppInfoCheck = Date.now();
    appInfoInflight = (async () => {
      try {
        const res = await appFetch(cfg, '/app', { timeoutMs: 8_000 });
        const body: any = await res.json().catch(() => null);
        // Si por lo que sea contesta otra App (clave cambiada a mano), no se
        // pisa nada: los ajustes deben seguir describiendo la App cuyo id firma.
        if (String(body?.id ?? '') !== cfg.appId) return;
        const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
        if (!slug) return;
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : slug;
        const htmlUrl =
          typeof body.html_url === 'string' && body.html_url.startsWith('https://')
            ? body.html_url
            : `https://github.com/apps/${slug}`;
        if (slug !== cfg.slug) setSetting(SETTING.slug, slug);
        if (name !== cfg.name) setSetting(SETTING.name, name);
        if (htmlUrl !== cfg.htmlUrl) setSetting(SETTING.htmlUrl, htmlUrl);
      } catch {
        /* sin red o sin permiso: se sigue con lo guardado */
      } finally {
        appInfoInflight = null;
      }
    })();
  }
  await appInfoInflight;
  return githubAppConfig();
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

/**
 * Petición autenticada como App (JWT). Un 401 aquí no es «token caducado»
 * como en el resto del cliente: o el reloj del servidor va desfasado (GitHub
 * rechaza un `exp` a más de 10 min o un `iat` en el futuro) o la clave ya no
 * es la de la App. El mensaje genérico mandaba al usuario a revisar una
 * credencial que no existe.
 */
async function appFetch(cfg: GithubAppConfig, path: string, req: Omit<GhRequest, 'token'> = {}): Promise<Response> {
  try {
    return await ghFetch(path, { ...req, token: appJwt(cfg) });
  } catch (err) {
    if (err instanceof GithubError && err.status === 401) {
      throw new GithubError(
        `GitHub rechazó la firma de la App (${err.message}). Suele ser el reloj del servidor desfasado (revisa NTP) ` +
          'o una clave privada que ya no vale: en ese caso, vuelve a conectar la App desde Ajustes.',
        401,
      );
    }
    throw err;
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
    const res = await appFetch(cfg, `/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      passthrough: [404],
    });
    if (res.status === 404) {
      await res.text().catch(() => ''); // libera el socket antes de lanzar
      throw new GithubError(
        'GitHub ya no conoce esa instalación de la App: se desinstaló desde GitHub. Vuelve a conectar la cuenta.',
        404,
      );
    }
    const body: any = await res.json().catch(() => ({}));
    if (typeof body?.token !== 'string' || !body.token) throw new GithubError('GitHub no devolvió token de instalación.');
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
  const res = await appFetch(cfg, `/app/installations/${installationId}`);
  const info = toInstallationInfo(await res.json().catch(() => ({})));
  // Sin id válido no hay nada que guardar: antes acababa una fila con
  // installation_id = NaN en la BD y una conexión que nunca podría clonar.
  if (!Number.isInteger(info.installationId) || info.installationId !== installationId) {
    throw new GithubError('GitHub devolvió una instalación que no se corresponde con la pedida.');
  }
  return info;
}

const INSTALLATIONS_MAX_PAGES = 10; // hasta 1000 instalaciones: de sobra para un servidor

/** Todas las instalaciones vivas de la App (para reconciliar con la BD). */
export async function listAppInstallations(): Promise<GithubInstallationInfo[]> {
  const cfg = githubAppConfig();
  if (!cfg) return [];
  const out: GithubInstallationInfo[] = [];
  for (let page = 1; page <= INSTALLATIONS_MAX_PAGES; page++) {
    const res = await appFetch(cfg, `/app/installations?per_page=100&page=${page}`);
    const body: any[] = (await res.json().catch(() => [])) as any[];
    if (!Array.isArray(body) || body.length === 0) break;
    for (const raw of body) {
      const info = toInstallationInfo(raw);
      if (Number.isInteger(info.installationId)) out.push(info);
    }
    if (body.length < 100) break;
  }
  return out;
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
  // GitHub limita el nombre a 34 caracteres y exige que sea único en todo
  // github.com: el sufijo aleatorio evita el choque y por eso se recorta el
  // host, nunca el sufijo. El usuario puede cambiarlo en el propio formulario.
  const suffixPart = ` ${suffix}`;
  const name = `Skyway ${host}`.slice(0, 34 - suffixPart.length) + suffixPart;
  return {
    name,
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
  const res = await ghFetch(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', passthrough: [404] });
  if (res.status === 404) {
    // Es lo que devuelve GitHub cuando el código ya se canjeó (recarga de la
    // página de retorno) o pasó su hora de vida.
    await res.text().catch(() => '');
    throw new GithubError('El código de creación de la App ya se usó o ha caducado: vuelve a crearla desde Ajustes.', 404);
  }
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

/**
 * Igual, pero comprobando antes que el slug guardado sigue siendo el de GitHub
 * (ver `refreshAppInfo`). Lanza solo si no hay App configurada.
 */
export async function installUrlFresh(state: string): Promise<string> {
  const cfg = await refreshAppInfo();
  if (!cfg) throw new GithubError('La GitHub App no está configurada en este servidor.');
  return installUrl(cfg, state);
}

/** Cuenta (usuario u organización) sobre la que está hecha una instalación. */
export interface InstallationAccount {
  accountType: string;
  accountLogin: string;
}

/**
 * URL para revisar qué repos ve una instalación ya hecha. GitHub la sirve en
 * los ajustes de la CUENTA, no en la página de la App:
 * `/settings/installations/<id>` para un usuario y
 * `/organizations/<login>/settings/installations/<id>` para una organización.
 * La forma antigua `/apps/<slug>/installations/<id>` no existe (404).
 *
 * Se admite todavía la config de la App como primer argumento para no romper
 * a quien aún no pasa la cuenta: en ese caso se cae a la URL de usuario, que
 * es correcta para cuentas personales.
 */
export function configureUrl(account: InstallationAccount | GithubAppConfig, installationId: number): string {
  const id = encodeURIComponent(String(installationId));
  if ('accountLogin' in account && account.accountType.toLowerCase() === 'organization' && account.accountLogin) {
    return `https://github.com/organizations/${encodeURIComponent(account.accountLogin)}/settings/installations/${id}`;
  }
  return `https://github.com/settings/installations/${id}`;
}
