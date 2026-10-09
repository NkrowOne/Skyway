import path from 'path';
import fs from 'fs';
import os from 'os';

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));

/**
 * Valor de la opción `trustProxy` de Fastify: todos o ninguno, una lista de
 * rangos (CIDR o los nombres `loopback`, `linklocal` y `uniquelocal`), o una
 * función que decide salto a salto.
 */
export type TrustProxy = boolean | string[] | ((address: string, hop: number) => boolean);

/**
 * Confianza en cabeceras de proxy (X-Forwarded-For / -Host / -Proto), que
 * deciden la IP real del cliente usada por el límite de intentos de login y la
 * auditoría.
 *
 * Por defecto se confía SOLO en proxies de rango privado/loopback (Traefik en
 * la red docker, o un túnel SSH local): así la IP del cliente es fiable sin que
 * un atacante en internet pueda falsificar `X-Forwarded-For` para evadir el
 * límite anti fuerza bruta o envenenar el registro de actividad. Ajustable con
 * TRUST_PROXY (`true`, `false`, un número de saltos, o una lista de CIDRs).
 */
export function parseTrustProxy(raw: string | undefined): TrustProxy {
  if (raw === undefined || raw.trim() === '') return ['loopback', 'linklocal', 'uniquelocal'];
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return confiarEnSaltos(Number(value));
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * `TRUST_PROXY` con un número de saltos: se confía en los `saltos` proxies más
 * cercanos, sea cual sea su dirección. Fastify 5 ya no acepta el número (lo
 * trata como «ningún proxy es de confianza»): todas las peticiones llegarían con
 * la IP del proxy y el límite de intentos por IP pasaría a ser uno solo para
 * todo el mundo. La función conserva el criterio de siempre (`hop < saltos`,
 * el de `proxy-addr`). Igual que antes, el salto inmediato cuenta siempre como
 * proxy de confianza, así que solo es seguro si a Skyway no se puede llegar sin
 * pasar por el proxy; por eso el valor por defecto es una lista de rangos.
 */
function confiarEnSaltos(saltos: number): TrustProxy {
  if (saltos === 0) return false;
  return (_address, hop) => hop < saltos;
}

/** Puerto de escucha. Un valor no numérico (`PORT=` mal puesto) daba `NaN` y `listen` fallaba con un error críptico. */
function parsePort(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 4000;
}

function defaultBuildConcurrency(): number {
  const cpus = os.cpus()?.length || 2;
  // Techo de 4: más builds a la vez saturan disco y red antes que CPU, y
  // alargan TODOS los despliegues en vez de acelerar alguno.
  return Math.max(2, Math.min(4, cpus - 1));
}

export const config = {
  port: parsePort(process.env.PORT),
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
  /**
   * Comprobación anti-CSRF del origen en las peticiones mutantes con cookie
   * (ver `app.ts`). Activa por defecto; `CSRF_ORIGIN_CHECK=false` la desactiva
   * para un proxy que no reenvía el Host real y no se puede corregir.
   */
  csrfOriginCheck: process.env.CSRF_ORIGIN_CHECK !== 'false',
  version: '0.38.0',
};

export function ensureDataDirs(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.buildsDir, { recursive: true });
}
