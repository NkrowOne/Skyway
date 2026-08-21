/**
 * Cliente de la API de GitHub: valida tokens, lista repos y ramas y consulta la
 * cabeza de una rama. Solo lectura; nunca escribe en GitHub.
 *
 * Sirve a los dos caminos de autenticación: el token personal de un conector
 * (Bearer) y el token de instalación de la GitHub App (también Bearer, pero
 * efímero y renovado en `github/app.ts`).
 */

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

/**
 * Petición cruda a api.github.com con los errores traducidos a mensajes que
 * dicen qué hacer. Devuelve la Response para quien necesite cabeceras (ETag).
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

  let res: Response;
  try {
    res = await fetch(`https://api.github.com${path}`, {
      method: req.method || 'GET',
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(req.timeoutMs ?? 15_000),
    });
  } catch (err: any) {
    throw new GithubError(`No se pudo conectar con GitHub: ${err?.message || 'error de red'}`);
  }
  if (req.passthrough?.includes(res.status)) return res;
  if (res.status === 401) throw new GithubError('GitHub rechazó la credencial (401). ¿Es válida y no ha caducado?', 401);
  if (res.status === 403) throw new GithubError('GitHub devolvió 403: límite de peticiones o permisos insuficientes.', 403);
  if (res.status === 404) throw new GithubError('GitHub devolvió 404: el recurso no existe o la credencial no lo puede ver.', 404);
  if (!res.ok) throw new GithubError(`GitHub respondió HTTP ${res.status}`, res.status);
  return res;
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

const REPOS_MAX_PAGES = 3; // hasta 300 repos: suficiente para elegir, acotado en tiempo

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

/** Repos a los que el token tiene acceso, los más recientes primero. */
export async function listGithubRepos(token: string): Promise<GithubRepo[]> {
  const repos: GithubRepo[] = [];
  for (let page = 1; page <= REPOS_MAX_PAGES; page++) {
    const res = await ghFetch(`/user/repos?per_page=100&sort=pushed&page=${page}`, { token });
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

/** Ramas de un repo (hasta 100), con la rama por defecto primera. */
export async function listGithubBranches(token: string, owner: string, repo: string): Promise<string[]> {
  const enc = (s: string) => encodeURIComponent(s);
  const [branchesRes, repoRes] = await Promise.all([
    ghFetch(`/repos/${enc(owner)}/${enc(repo)}/branches?per_page=100`, { token }),
    ghFetch(`/repos/${enc(owner)}/${enc(repo)}`, { token }),
  ]);
  const branches: any[] = (await branchesRes.json().catch(() => [])) as any[];
  const meta: any = await repoRes.json().catch(() => ({}));
  const names = (Array.isArray(branches) ? branches : []).map((b) => b?.name).filter(Boolean) as string[];
  const def = meta?.default_branch;
  if (def && names.includes(def)) {
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

export async function apiHeadSha(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  const enc = (s: string) => encodeURIComponent(s);
  // El ETag se cachea por repo+rama+credencial: dos cuentas distintas pueden
  // ver estados distintos del mismo repo (forks privados, permisos).
  const key = `${owner}/${repo}#${branch}#${token.slice(-12)}`;
  const cached = headEtags.get(key);
  try {
    const res = await ghFetch(`/repos/${enc(owner)}/${enc(repo)}/commits/${enc(branch)}`, {
      token,
      etag: cached?.etag ?? null,
      passthrough: [304, 404, 409, 422],
      timeoutMs: 10_000,
    });
    if (res.status === 304 && cached) return cached.sha;
    if (!res.ok) return null;
    const body: any = await res.json().catch(() => null);
    const sha = typeof body?.sha === 'string' ? body.sha : null;
    if (!sha) return null;
    const etag = res.headers.get('etag');
    if (etag) headEtags.set(key, { etag, sha });
    else headEtags.delete(key);
    return sha;
  } catch {
    return null;
  }
}

/** Olvida los ETags cacheados de un repo (tras cambiar de rama o de credencial). */
export function forgetHeadCache(): void {
  headEtags.clear();
}
