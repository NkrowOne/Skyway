import path from 'path';
import fs from 'fs';
import os from 'os';

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));

/**
 * Confianza en cabeceras de proxy (X-Forwarded-For / -Proto), que deciden la
 * IP real del cliente usada por el límite de intentos de login y la auditoría.
 *
 * Por defecto se confía SOLO en proxies de rango privado/loopback (Traefik en
 * la red docker, o un túnel SSH local): así la IP del cliente es fiable sin que
 * un atacante en internet pueda falsificar `X-Forwarded-For` para evadir el
 * límite anti fuerza bruta o envenenar el registro de actividad. Ajustable con
 * TRUST_PROXY (`true`, `false`, un número de saltos, o una lista de CIDRs).
 */
function parseTrustProxy(raw: string | undefined): boolean | number | string[] {
  if (raw === undefined || raw.trim() === '') return ['loopback', 'linklocal', 'uniquelocal'];
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function defaultBuildConcurrency(): number {
  const cpus = os.cpus()?.length || 2;
  // Techo de 4: más builds a la vez saturan disco y red antes que CPU, y
  // alargan TODOS los despliegues en vez de acelerar alguno.
  return Math.max(2, Math.min(4, cpus - 1));
}

export const config = {
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || '0.0.0.0',
  dataDir,
  buildsDir: path.join(dataDir, 'builds'),
  webDist: process.env.WEB_DIST
    ? path.resolve(process.env.WEB_DIST)
    : path.resolve(__dirname, '../../web/dist'),
  jwtSecretEnv: process.env.JWT_SECRET || null,
  // Builds en paralelo. Por defecto se reparte según los núcleos del servidor
  // dejando uno libre para el propio panel y los servicios en marcha: en una
  // máquina holgada dos despliegues simultáneos ya no hacen cola detrás de uno.
  buildConcurrency: Math.max(1, Number(process.env.BUILD_CONCURRENCY) || defaultBuildConcurrency()),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  version: '0.26.2',
};

export function ensureDataDirs(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.buildsDir, { recursive: true });
}
