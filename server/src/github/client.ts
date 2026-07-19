/**
 * Cliente mínimo de la API de GitHub para validar el token de acceso que
 * Skyway usa al clonar repositorios privados. Solo lectura de la identidad.
 */

export class GithubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GithubError';
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
  let res: Response;
  try {
    res = await fetch('https://api.github.com/user', {
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
  if (!res.ok) throw new GithubError(`GitHub respondió HTTP ${res.status}`);

  const body: any = await res.json().catch(() => ({}));
  // Los tokens clásicos exponen sus scopes en esta cabecera; los fine-grained no.
  const scopeHeader = res.headers.get('x-oauth-scopes');
  const scopes = scopeHeader ? scopeHeader.split(',').map((s) => s.trim()).filter(Boolean) : [];
  return { login: body.login ?? '(desconocido)', name: body.name ?? null, scopes, tokenType: classify(token) };
}
