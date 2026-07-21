import path from 'path';
import fs from 'fs';

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

export const config = {
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || '0.0.0.0',
  dataDir,
  buildsDir: path.join(dataDir, 'builds'),
  webDist: process.env.WEB_DIST
    ? path.resolve(process.env.WEB_DIST)
    : path.resolve(__dirname, '../../web/dist'),
  jwtSecretEnv: process.env.JWT_SECRET || null,
  buildConcurrency: Number(process.env.BUILD_CONCURRENCY || 2),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  version: '0.13.0',
};

export function ensureDataDirs(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.buildsDir, { recursive: true });
}
