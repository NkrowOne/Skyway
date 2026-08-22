/**
 * Config-as-code de Railway (`railway.json` / `railway.toml`).
 *
 * Railway da prioridad al fichero del repositorio sobre lo que diga su panel,
 * y los proyectos migrados llegan con esos ficheros dentro. Leer solo el
 * `startCommand` —lo que se hacía antes— dejaba fuera cosas que cambian el
 * resultado del despliegue: qué constructor usar, el comando de build, el
 * Dockerfile alternativo, el healthcheck, la política de reinicio y el comando
 * previo al arranque (que es donde casi todo el mundo pone las migraciones).
 */

import fs from 'fs';
import path from 'path';

export interface RailwayRepoConfig {
  /** NIXPACKS | DOCKERFILE | RAILPACK (mayúsculas, tal cual las escribe Railway). */
  builder: string | null;
  buildCommand: string | null;
  dockerfilePath: string | null;
  watchPatterns: string[];
  startCommand: string | null;
  preDeployCommand: string | null;
  healthcheckPath: string | null;
  healthcheckTimeout: number | null;
  numReplicas: number | null;
  /** ON_FAILURE | ALWAYS | NEVER */
  restartPolicyType: string | null;
  restartPolicyMaxRetries: number | null;
  cronSchedule: string | null;
  /** Ruta relativa del fichero del que salió, para poder decirlo en el log. */
  source: string | null;
}

const EMPTY: RailwayRepoConfig = {
  builder: null,
  buildCommand: null,
  dockerfilePath: null,
  watchPatterns: [],
  startCommand: null,
  preDeployCommand: null,
  healthcheckPath: null,
  healthcheckTimeout: null,
  numReplicas: null,
  restartPolicyType: null,
  restartPolicyMaxRetries: null,
  cronSchedule: null,
  source: null,
};

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
const num = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Subconjunto de TOML suficiente para un railway.toml: tablas `[build]` /
 * `[deploy]`, y claves con valor de texto, número, booleano o lista de textos.
 * Lo que no encaje se ignora en silencio —una tabla anidada de regiones no
 * debe tumbar un despliegue— igual que hace el lector de JSON con las claves
 * que no conoce.
 */
/**
 * Quita el comentario final de una línea sin meterse dentro de las comillas.
 *
 * Antes se hacía con una expresión sobre la línea entera (`/\s+#.*$/`), y una
 * almohadilla dentro de una cadena la partía por la mitad: `startCommand =
 * "manage.py migrate # y ya"` se quedaba en «manage.py migrat» —con el último
 * carácter comido, porque la comilla de cierre desaparecía antes de recortar
 * las comillas— y `"a # b # c"` se perdía del todo. Un comando de arranque
 * mutilado o vacío que no se ve hasta que el contenedor no levanta.
 *
 * Se conserva la regla de exigir un espacio delante del '#' para abrir
 * comentario: sin ella, un valor desnudo como `--tag=#build` se rompería.
 *
 * No se deshacen las escapadas: el valor se entrega tal cual venía. La barra
 * invertida se mira solo para saber dónde acaba la cadena, que es lo único que
 * hace falta aquí para no cortar donde no se debe.
 */
function sinComentario(valor: string): string {
  let comilla: string | null = null;
  for (let i = 0; i < valor.length; i += 1) {
    const c = valor[i];
    if (comilla) {
      // Solo la comilla doble admite escapadas en TOML; dentro de la simple la
      // barra es un carácter más, y tratarla como escape dejaría sin cerrar
      // rutas como 'C:\app\'.
      if (c === '\\' && comilla === '"') {
        i += 1;
        continue;
      }
      if (c === comilla) comilla = null;
      continue;
    }
    if (c === '"' || c === "'") {
      comilla = c;
      continue;
    }
    if (c === '#' && i > 0 && /\s/.test(valor[i - 1])) return valor.slice(0, i).trim();
  }
  return valor.trim();
}

function parseToml(text: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  let section = '';
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/^﻿/, '').trim();
    if (!line || line.startsWith('#')) continue;

    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) {
      section = table[1].trim();
      if (!out[section]) out[section] = {};
      continue;
    }
    if (!section) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, '');
    const raw = sinComentario(line.slice(eq + 1).trim());
    if (!key) continue;

    if (/^["']/.test(raw)) {
      // Se busca la comilla de cierre en vez de recortar a ciegas el último
      // carácter: si el fichero viene con una comilla sin cerrar, es mejor
      // quedarse con el valor entero que devolverlo mordido.
      const cierre = raw.lastIndexOf(raw[0]);
      out[section][key] = cierre > 0 ? raw.slice(1, cierre) : raw.slice(1);
    } else if (raw === 'true' || raw === 'false') {
      out[section][key] = raw === 'true';
    } else if (/^\[.*\]$/.test(raw)) {
      out[section][key] = raw
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else if (Number.isFinite(Number(raw))) {
      out[section][key] = Number(raw);
    } else {
      out[section][key] = raw;
    }
  }
  return out;
}

function fromSections(build: any, deploy: any, source: string): RailwayRepoConfig {
  return {
    builder: str(build?.builder)?.toUpperCase() ?? null,
    buildCommand: str(build?.buildCommand),
    dockerfilePath: str(build?.dockerfilePath),
    watchPatterns: Array.isArray(build?.watchPatterns) ? build.watchPatterns.filter((p: unknown) => typeof p === 'string') : [],
    startCommand: str(deploy?.startCommand),
    preDeployCommand: Array.isArray(deploy?.preDeployCommand)
      ? // Railway admite lista (argv); aquí se ejecuta con sh -c, así que se une.
        str(deploy.preDeployCommand.filter((c: unknown) => typeof c === 'string').join(' '))
      : str(deploy?.preDeployCommand),
    healthcheckPath: str(deploy?.healthcheckPath),
    healthcheckTimeout: num(deploy?.healthcheckTimeout),
    numReplicas: num(deploy?.numReplicas),
    restartPolicyType: str(deploy?.restartPolicyType)?.toUpperCase() ?? null,
    restartPolicyMaxRetries: num(deploy?.restartPolicyMaxRetries),
    cronSchedule: str(deploy?.cronSchedule),
    source,
  };
}

/**
 * Lee la configuración del repositorio. Busca primero en el directorio raíz
 * del servicio (monorepos) y después en la raíz del repo, que es el orden en
 * el que Railway la resuelve. `RAILWAY_DOCKERFILE_PATH` en las variables del
 * servicio sigue mandando sobre el fichero, como en Railway.
 */
export function readRailwayRepoConfig(
  repoDir: string,
  rootDir?: string,
  log?: (l: string) => void,
): RailwayRepoConfig {
  // Sin rootDir las dos rutas son la misma, y sin deduplicar el mismo fichero
  // se leía —y se avisaba— dos veces.
  const roots = [...new Set([path.resolve(repoDir, rootDir || '.'), path.resolve(repoDir)])];
  for (const dir of roots) {
    for (const file of ['railway.json', 'railway.toml']) {
      const full = path.join(dir, file);
      let text: string;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue; // no está en esta ubicación: se prueba la siguiente
      }
      const rel = path.relative(repoDir, full) || file;
      try {
        if (file.endsWith('.json')) {
          const parsed = JSON.parse(text);
          // Railway admite `environments.<entorno>[.<servicio>]` en el mismo
          // fichero. Skyway aún no lo aplica, y callarlo es lo peor que puede
          // hacer: quien lo usa cree que su configuración está activa.
          if (parsed?.environments && log) {
            log(`⚠ ${rel} trae configuración por entorno («environments»), que Skyway todavía no aplica. Solo se lee la del nivel raíz.`);
          }
          return fromSections(parsed?.build, parsed?.deploy, rel);
        }
        const tables = parseToml(text);
        if (log && Object.keys(tables).some((k) => k.startsWith('environments.'))) {
          log(`⚠ ${rel} trae configuración por entorno («[environments…]»), que Skyway todavía no aplica. Solo se lee la del nivel raíz.`);
        }
        return fromSections(tables.build, tables.deploy, rel);
      } catch (err: any) {
        // Presente pero ilegible. No se adivina, pero tampoco se calla: si no,
        // el despliegue termina en verde con una configuración que no se aplicó.
        log?.(`⚠ ${rel} no se pudo leer (${err?.message || err}): se ignora y se usan los ajustes del panel.`);
        continue;
      }
    }
  }
  return { ...EMPTY };
}

/** ¿Aporta algo esta configuración, o es un fichero vacío? */
export function hasRailwayConfig(cfg: RailwayRepoConfig): boolean {
  return (
    !!cfg.builder ||
    !!cfg.buildCommand ||
    !!cfg.dockerfilePath ||
    !!cfg.startCommand ||
    !!cfg.preDeployCommand ||
    !!cfg.healthcheckPath ||
    cfg.numReplicas !== null ||
    !!cfg.restartPolicyType ||
    cfg.restartPolicyMaxRetries !== null ||
    cfg.watchPatterns.length > 0 ||
    !!cfg.cronSchedule
  );
}

/**
 * Política de reinicio de Docker equivalente a la de Railway. Docker no tiene
 * un «ON_FAILURE sin límite» distinto de `on-failure`, así que el número de
 * reintentos se traslada tal cual cuando viene.
 */
export function dockerRestartPolicy(
  type: string | null,
  maxRetries: number | null,
): { Name: string; MaximumRetryCount?: number } | null {
  const retries = maxRetries && maxRetries > 0 ? Math.min(maxRetries, 100) : null;
  switch (type) {
    case 'NEVER':
      return { Name: 'no' };
    case 'ON_FAILURE':
      return retries ? { Name: 'on-failure', MaximumRetryCount: retries } : { Name: 'on-failure' };
    case 'ALWAYS':
      return { Name: 'unless-stopped' };
    default:
      // Declarar solo el número de reintentos es válido en Railway: se aplica
      // sobre su política por defecto, que es ON_FAILURE. Sin esto acababa en
      // reinicios ilimitados, justo lo contrario de lo que se pedía.
      return retries ? { Name: 'on-failure', MaximumRetryCount: retries } : null;
  }
}
