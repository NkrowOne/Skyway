/**
 * Cliente de la API de GitHub: valida tokens, lista repos y ramas y consulta la
 * cabeza de una rama. Solo lectura; nunca escribe en GitHub.
 *
 * Sirve a los dos caminos de autenticación: el token personal de un conector
 * (Bearer) y el token de instalación de la GitHub App (también Bearer, pero
 * efímero y renovado en `github/app.ts`).
 */

import crypto from 'crypto';
import { safeParse } from '../util';

export class GithubError extends Error {
  /** Código HTTP que devolvió GitHub, cuando lo hubo (0 = error de red). */
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'GithubError';
    this.status = status;
  }
}

export interface GhRequest {
  /** Credencial Bearer: PAT de conector, token de instalación o JWT de la App. */
  token?: string | null;
  method?: string;
  body?: unknown;
  /** ETag de una respuesta anterior: un 304 no consume cuota de la API. */
  etag?: string | null;
  /** Códigos que NO deben lanzar (p. ej. 304 cuando se manda ETag). */
  passthrough?: number[];
  timeoutMs?: number;
}

/** Códigos por los que merece la pena un segundo intento: GitHub caído o saturado, no nuestra petición. */
const RETRY_STATUS = new Set([502, 503, 504]);

/**
 * Mensaje de error del cuerpo JSON de GitHub («Bad credentials», «'exp' claim
 * is too far in the future»…). Se acota porque acaba en la UI y en el log.
 */
function githubMessage(text: string): string | null {
  const parsed = safeParse<{ message?: unknown }>(text, {});
  return typeof parsed.message === 'string' && parsed.message.trim() ? parsed.message.trim().slice(0, 200) : null;
}

/** Segundos hasta que GitHub vuelve a aceptar peticiones, según sus cabeceras de cuota. */
function retryAfterSeconds(res: Response): number | null {
  const retryAfter = Number(res.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter);
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(1, Math.ceil(reset - Date.now() / 1000));
  return null;
}

/**
 * Petición cruda a api.github.com con los errores traducidos a mensajes que
 * dicen qué hacer. Devuelve la Response para quien necesite cabeceras (ETag).
 *
 * Cuando lanza, el cuerpo de la respuesta ya se ha leído: un cuerpo sin
 * consumir deja el socket de undici ocupado hasta que el recolector pase por
 * él, y el sondeo de auto-deploy hace una petición por servicio y minuto.
 * Un GET (idempotente) se repite una vez si GitHub responde 5xx o la conexión
 * se corta antes de contestar; un timeout no se repite, porque doblaría la
 * espera de quien está delante de la pantalla.
 */
export async function ghFetch(path: string, req: GhRequest = {}): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Skyway',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (req.token) headers.Authorization = `Bearer ${req.token}`;
  if (req.etag) headers['If-None-Match'] = req.etag;
  if (req.body !== undefined) headers['Content-Type'] = 'application/json';
  const method = (req.method || 'GET').toUpperCase();
  const timeoutMs = req.timeoutMs ?? 15_000;
  let retriesLeft = method === 'GET' ? 1 : 0;

  for (;;) {
    let res: Response;
    try {
      res = await fetch(`https://api.github.com${path}`, {
        method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: any) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new GithubError(`GitHub no respondió en ${Math.round(timeoutMs / 1000)} s. Vuelve a intentarlo.`);
      }
      if (retriesLeft-- > 0) continue;
      throw new GithubError(`No se pudo conectar con GitHub: ${err?.cause?.message || err?.message || 'error de red'}`);
    }
    if (req.passthrough?.includes(res.status)) return res;
    if (res.ok) return res;

    // A partir de aquí se lanza: el cuerpo se lee (libera el socket) y sirve
    // para afinar el mensaje. Los errores de GitHub no llevan credenciales.
    const text = await res.text().catch(() => '');
    if (RETRY_STATUS.has(res.status) && retriesLeft-- > 0) continue;
    const detail = githubMessage(text);
    const status = res.status;

    if (status === 401) {
      throw new GithubError(`GitHub rechazó la credencial (401${detail ? `: ${detail}` : ''}). ¿Es válida y no ha caducado?`, 401);
    }
    if (status === 403 || status === 429) {
      // 403 con la cuota a cero es límite de peticiones; 429 es el límite
      // secundario (ráfagas). Cualquier otro 403 son permisos.
      const wait = retryAfterSeconds(res);
      const agotada = status === 429 || res.headers.get('x-ratelimit-remaining') === '0';
      if (agotada) {
        const cuando = wait ? ` Se reabre en ${wait > 90 ? `${Math.ceil(wait / 60)} min` : `${wait} s`}.` : '';
        throw new GithubError(`GitHub ha limitado las peticiones de esta credencial (${status}).${cuando}`, status);
      }
      throw new GithubError(`GitHub devolvió 403: la credencial no tiene permiso para esto${detail ? ` (${detail})` : ''}.`, 403);
    }
    if (status === 404) throw new GithubError('GitHub devolvió 404: el recurso no existe o la credencial no lo puede ver.', 404);
    throw new GithubError(`GitHub respondió HTTP ${status}${detail ? ` (${detail})` : ''}`, status);
  }
}

export type GithubTokenType = 'classic' | 'fine-grained' | 'unknown';

export interface GithubIdentity {
  login: string;
  name: string | null;
  scopes: string[];
  tokenType: GithubTokenType;
}

function classify(token: string): GithubTokenType {
  if (token.startsWith('github_pat_')) return 'fine-grained';
  if (token.startsWith('ghp_') || token.startsWith('gho_')) return 'classic';
  return 'unknown';
}

/**
 * Comprueba el token contra GET /user. Devuelve la cuenta y (para tokens
 * clásicos) los permisos; lanza GithubError con un mensaje claro si falla.
 */
export async function verifyGithubToken(token: string): Promise<GithubIdentity> {
  const res = await ghFetch('/user', { token });
  const body: any = await res.json().catch(() => ({}));
  // Los tokens clásicos exponen sus scopes en esta cabecera; los fine-grained no.
  const scopeHeader = res.headers.get('x-oauth-scopes');
  const scopes = scopeHeader ? scopeHeader.split(',').map((s) => s.trim()).filter(Boolean) : [];
  return { login: body.login ?? '(desconocido)', name: body.name ?? null, scopes, tokenType: classify(token) };
}

export interface GithubRepo {
  fullName: string; // owner/repo
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
  description: string | null;
}

// Hasta 1000 repos, ordenados por último push: lo que se recorta es lo que
// lleva más tiempo sin tocarse. Con colaboraciones y organizaciones incluidas,
// una cuenta veterana pasa de largo los 300 que se listaban antes.
const REPOS_MAX_PAGES = 10;
const BRANCHES_MAX_PAGES = 5; // hasta 500 ramas; más allá, el selector ya no es la herramienta

/** Normaliza la ficha de repo que devuelve la API (misma forma en ambos caminos). */
export function toGithubRepo(raw: any): GithubRepo | null {
  if (!raw?.full_name) return null;
  return {
    fullName: raw.full_name,
    private: !!raw.private,
    defaultBranch: raw.default_branch || 'main',
    pushedAt: raw.pushed_at ?? null,
    description: raw.description ?? null,
  };
}

/**
 * Repos a los que el token tiene acceso, los más recientes primero. La
 * afiliación va explícita: sin ella GitHub aplica su valor por defecto, que
 * es el mismo trío, pero escribirla deja claro que se quieren también los
 * repos donde el usuario es solo colaborador, que era justo lo que la gente
 * echaba en falta al elegir repo.
 */
export async function listGithubRepos(token: string): Promise<GithubRepo[]> {
  const repos: GithubRepo[] = [];
  const query = 'per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&visibility=all';
  for (let page = 1; page <= REPOS_MAX_PAGES; page++) {
    const res = await ghFetch(`/user/repos?${query}&page=${page}`, { token });
    const body: any[] = (await res.json().catch(() => [])) as any[];
    if (!Array.isArray(body) || body.length === 0) break;
    for (const r of body) {
      const repo = toGithubRepo(r);
      if (repo) repos.push(repo);
    }
    if (body.length < 100) break;
  }
  return repos;
}

/**
 * Ficha de un repo concreto, o null si no existe o la credencial no lo ve
 * (GitHub responde 404 en ambos casos para no delatar repos privados). Sin
 * token pregunta en anónimo: vale para comprobar un repo público escrito a
 * mano. Cualquier otro fallo (401, cuota, red) sí lanza, porque entonces «no
 * existe» sería mentira.
 */
export async function getGithubRepo(token: string | null, owner: string, repo: string): Promise<GithubRepo | null> {
  const enc = (s: string) => encodeURIComponent(s);
  const res = await ghFetch(`/repos/${enc(owner)}/${enc(repo)}`, { token, passthrough: [404] });
  if (res.status === 404) {
    await res.text().catch(() => '');
    return null;
  }
  return toGithubRepo(await res.json().catch(() => null));
}

/**
 * Ramas de un repo (hasta 500, paginadas), con la rama por defecto primera. Un
 * monorepo con más de 100 ramas dejaba fuera la que el usuario buscaba, y el
 * selector decía que «no existe» una rama que sí estaba en GitHub.
 */
export async function listGithubBranches(token: string, owner: string, repo: string): Promise<string[]> {
  const enc = (s: string) => encodeURIComponent(s);
  const base = `/repos/${enc(owner)}/${enc(repo)}`;
  const names: string[] = [];
  for (let page = 1; page <= BRANCHES_MAX_PAGES; page++) {
    const res = await ghFetch(`${base}/branches?per_page=100&page=${page}`, { token });
    const list: any[] = (await res.json().catch(() => [])) as any[];
    if (!Array.isArray(list) || list.length === 0) break;
    for (const b of list) if (typeof b?.name === 'string' && b.name) names.push(b.name);
    if (list.length < 100) break;
  }
  const meta: any = await (await ghFetch(base, { token })).json().catch(() => ({}));
  const def = meta?.default_branch;
  if (typeof def === 'string' && names.includes(def)) {
    return [def, ...names.filter((n) => n !== def)];
  }
  return names;
}

/** owner/repo a partir de una URL de repositorio de GitHub (o null si no lo es). */
export function parseGithubSlug(repoUrl: string): { owner: string; repo: string } | null {
  const trimmed = repoUrl.trim().replace(/\.git$/, '');
  const direct = /^([\w.-]+)\/([\w.-]+)$/.exec(trimmed);
  if (direct) return { owner: direct[1], repo: direct[2] };
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/i.exec(trimmed);
  if (url) return { owner: url[1], repo: url[2] };
  return null;
}

/**
 * Cabeza de una rama por la API REST, con ETag: un 304 devuelve el SHA que ya
 * teníamos sin consumir cuota y sin lanzar un proceso. Frente a `git ls-remote`
 * ahorra el arranque de git y el handshake TLS completo en cada sondeo, que es
 * la mayor parte del coste de comprobar «¿hay commit nuevo?».
 *
 * Devuelve null si no se pudo resolver (rama inexistente, credencial sin
 * acceso, red caída): quien llama decide si cae a `git ls-remote`.
 */
const headEtags = new Map<string, { etag: string; sha: string }>();

/**
 * Tope de la caché de ETags. Los tokens de instalación rotan cada hora y cada
 * rotación estrena clave, así que sin tope el mapa crecía sin fin en un
 * servidor que lleva meses encendido. Se descarta lo más antiguo (un Map
 * itera en orden de inserción).
 */
const HEAD_CACHE_MAX = 2000;

export async function apiHeadSha(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  const enc = (s: string) => encodeURIComponent(s);
  // El ETag se cachea por repo+rama+credencial: dos cuentas distintas pueden
  // ver estados distintos del mismo repo (forks privados, permisos). La
  // credencial entra en la clave como huella, no en claro: un volcado de
  // memoria o un log de depuración del mapa no debe enseñar trozos del token.
  const huella = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
  const key = `${owner}/${repo}#${branch}#${huella}`;
  const cached = headEtags.get(key);
  try {
    const res = await ghFetch(`/repos/${enc(owner)}/${enc(repo)}/commits/${enc(branch)}`, {
      token,
      etag: cached?.etag ?? null,
      passthrough: [304, 404, 409, 422],
      timeoutMs: 10_000,
    });
    if (res.status === 304 && cached) return cached.sha;
    if (!res.ok) {
      // Los códigos en passthrough llegan con cuerpo: hay que leerlo aunque no
      // interese, o el socket queda ocupado (una vez por servicio y minuto).
      await res.text().catch(() => '');
      return null;
    }
    const body: any = await res.json().catch(() => null);
    const sha = typeof body?.sha === 'string' ? body.sha : null;
    if (!sha) return null;
    const etag = res.headers.get('etag');
    if (etag) {
      // Reinsertar mueve la clave al final: lo que se usa no caduca.
      headEtags.delete(key);
      headEtags.set(key, { etag, sha });
      while (headEtags.size > HEAD_CACHE_MAX) {
        const oldest = headEtags.keys().next().value;
        if (oldest === undefined) break;
        headEtags.delete(oldest);
      }
    } else {
      headEtags.delete(key);
    }
    return sha;
  } catch {
    return null;
  }
}

/** Olvida los ETags cacheados de un repo (tras cambiar de rama o de credencial). */
export function forgetHeadCache(): void {
  headEtags.clear();
}
