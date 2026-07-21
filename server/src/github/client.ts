/**
 * Cliente mínimo de la API de GitHub: valida tokens de acceso y lista repos y
 * ramas para los conectores por proyecto. Solo lectura; nunca escribe en GitHub.
 */

export class GithubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GithubError';
  }
}

async function ghFetch(path: string, token: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Skyway',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    throw new GithubError(`No se pudo conectar con GitHub: ${err?.message || 'error de red'}`);
  }
  if (res.status === 401) throw new GithubError('GitHub rechazó el token (401). ¿Es válido y no ha caducado?');
  if (res.status === 403) throw new GithubError('GitHub devolvió 403: límite de peticiones o permisos insuficientes.');
  if (res.status === 404) throw new GithubError('GitHub devolvió 404: el recurso no existe o el token no lo puede ver.');
  if (!res.ok) throw new GithubError(`GitHub respondió HTTP ${res.status}`);
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
  const res = await ghFetch('/user', token);
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

/** Repos a los que el token tiene acceso, los más recientes primero. */
export async function listGithubRepos(token: string): Promise<GithubRepo[]> {
  const repos: GithubRepo[] = [];
  for (let page = 1; page <= REPOS_MAX_PAGES; page++) {
    const res = await ghFetch(`/user/repos?per_page=100&sort=pushed&page=${page}`, token);
    const body: any[] = (await res.json().catch(() => [])) as any[];
    if (!Array.isArray(body) || body.length === 0) break;
    for (const r of body) {
      if (!r?.full_name) continue;
      repos.push({
        fullName: r.full_name,
        private: !!r.private,
        defaultBranch: r.default_branch || 'main',
        pushedAt: r.pushed_at ?? null,
        description: r.description ?? null,
      });
    }
    if (body.length < 100) break;
  }
  return repos;
}

/** Ramas de un repo (hasta 100), con la rama por defecto primera. */
export async function listGithubBranches(token: string, owner: string, repo: string): Promise<string[]> {
  const enc = (s: string) => encodeURIComponent(s);
  const [branchesRes, repoRes] = await Promise.all([
    ghFetch(`/repos/${enc(owner)}/${enc(repo)}/branches?per_page=100`, token),
    ghFetch(`/repos/${enc(owner)}/${enc(repo)}`, token),
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
