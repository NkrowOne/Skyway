/**
 * Con qué credencial se clona un repositorio.
 *
 * Hay tres caminos y conviven a propósito: la GitHub App (lo nuevo, sin
 * caducidad y con permiso solo sobre los repos elegidos), el token personal de
 * un conector del proyecto (lo que ya había) y el token global del servidor
 * (el atajo del administrador). Este módulo es el único sitio que decide cuál
 * toca, para que el despliegue, el sondeo de auto-deploy y el webhook usen
 * exactamente la misma credencial y no haya un camino que funcione y otro no.
 */

import {
  getGithubConnector,
  getGithubInstallation,
  getSetting,
  listGithubInstallationsForProject,
  touchGithubConnector,
  touchGithubInstallation,
} from '../db';
import { GitConfig, GithubInstallationRow, ProjectRow } from '../types';
import { installationToken } from './app';
import { parseGithubSlug } from './client';

/**
 * Token de clonado de una instalación. `touch` marca el uso: solo lo hace quien
 * va a clonar de verdad. El sondeo pide token cada minuto, y si lo marcara, el
 * «último despliegue» de la conexión diría siempre «hace unos segundos» y
 * dejaría de significar nada.
 */
export async function installationTokenFor(
  row: GithubInstallationRow,
  opts: { touch?: boolean } = {},
): Promise<string> {
  const token = await installationToken(row.installation_id);
  if (opts.touch !== false) touchGithubInstallation(row.id);
  return token;
}

export type GitAuthSource = 'app' | 'connector' | 'global' | 'none';

export interface GitAuth {
  token: string | null;
  source: GitAuthSource;
  /** Frase para el log del despliegue; null cuando no hay nada que contar. */
  detail: string | null;
  /** Aviso de una configuración rota (conector borrado, instalación caída). */
  warning: string | null;
}

/** Instalación elegida en el servicio, si sigue siendo visible desde el proyecto. */
function pinnedInstallation(project: ProjectRow, cfg: GitConfig): GithubInstallationRow | null {
  if (!cfg.githubInstallationId) return null;
  const row = getGithubInstallation(cfg.githubInstallationId);
  if (!row) return null;
  // Una instalación de OTRO proyecto no vale aunque el id sea correcto: sería
  // una vía para clonar repos de otro cliente escribiendo su id a mano.
  if (row.project_id !== null && row.project_id !== project.id) return null;
  return row;
}

/**
 * Instalación que ve el repo por coincidencia de cuenta. Cubre el caso normal
 * —el repo es de la organización que acabas de conectar— sin obligar a elegir
 * la conexión a mano en cada servicio.
 */
function matchingInstallation(project: ProjectRow, repoUrl: string): GithubInstallationRow | null {
  const slug = parseGithubSlug(repoUrl);
  if (!slug) return null;
  const owner = slug.owner.toLowerCase();
  const candidates = listGithubInstallationsForProject(project.id).filter(
    (row) => row.suspended === 0 && row.account_login.toLowerCase() === owner,
  );
  // Con empate (una del proyecto y una global) gana la del proyecto, que es la
  // que ordena listGithubInstallationsForProject primero.
  return candidates[0] ?? null;
}

/**
 * Resuelve la credencial de clonado del servicio. Nunca lanza por un problema
 * de configuración: devuelve el aviso y sigue con el siguiente camino, porque
 * un repo público se clona igual sin credencial y romper el despliegue por eso
 * sería peor que avisar.
 */
export async function resolveGitAuth(
  project: ProjectRow,
  cfg: GitConfig,
  opts: { touch?: boolean } = {},
): Promise<GitAuth> {
  const globalToken = getSetting('githubToken');
  const touch = opts.touch !== false;

  // 1. Instalación de la GitHub App elegida explícitamente en el servicio.
  if (cfg.githubInstallationId) {
    const row = pinnedInstallation(project, cfg);
    if (row) {
      try {
        return {
          token: await installationTokenFor(row, { touch }),
          source: 'app',
          detail: `Clonando con la GitHub App instalada en @${row.account_login}`,
          warning: row.suspended ? `La instalación de @${row.account_login} está suspendida en GitHub.` : null,
        };
      } catch (err: any) {
        return {
          token: globalToken,
          source: globalToken ? 'global' : 'none',
          detail: null,
          warning: `No se pudo obtener el token de la GitHub App (${err?.message || err}). Se intenta con el token global.`,
        };
      }
    }
    return {
      token: globalToken,
      source: globalToken ? 'global' : 'none',
      detail: null,
      warning: 'La conexión de GitHub de este servicio ya no existe: se usa el token global si está configurado.',
    };
  }

  // 2. Conector con token personal del proyecto.
  if (cfg.connectorId) {
    const connector = getGithubConnector(cfg.connectorId);
    if (connector && connector.project_id === project.id) {
      if (touch) touchGithubConnector(connector.id);
      return {
        token: connector.token,
        source: 'connector',
        detail: `Clonando con el conector de GitHub «${connector.name}» (@${connector.gh_login})`,
        warning: null,
      };
    }
    return {
      token: globalToken,
      source: globalToken ? 'global' : 'none',
      detail: null,
      warning: 'El conector de GitHub de este servicio ya no existe: se usa el token global si está configurado.',
    };
  }

  // 3. Sin nada elegido: si hay una instalación de la App para esa cuenta, vale.
  const auto = matchingInstallation(project, cfg.repoUrl);
  if (auto) {
    try {
      return {
        token: await installationTokenFor(auto, { touch }),
        source: 'app',
        detail: `Clonando con la GitHub App instalada en @${auto.account_login}`,
        warning: null,
      };
    } catch {
      /* se cae al token global, como cualquier otro fallo de credencial */
    }
  }

  return { token: globalToken, source: globalToken ? 'global' : 'none', detail: null, warning: null };
}

/**
 * Igual, pero solo el token y sin marcar uso: para el sondeo, que no escribe en
 * ningún log y no debe contar como «último despliegue» de la conexión.
 */
export async function resolveGitToken(project: ProjectRow, cfg: GitConfig): Promise<string | null> {
  return (await resolveGitAuth(project, cfg, { touch: false })).token;
}
