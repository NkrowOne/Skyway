import Docker from 'dockerode';

const socketPath = process.env.DOCKER_SOCK;

/**
 * Cliente para streams y mutaciones: `logs --follow`, `exec`, backups por
 * stdin, `stop`/`remove`... Va SIN `timeout` a propósito: docker-modem lo
 * implementa como inactividad del socket (`req.setTimeout`), y un contenedor
 * que no escribe nada en medio minuto, un exec callado o un `remove` de una
 * capa enorme son silencios legítimos que no hay que cortar.
 */
export const docker = new Docker(socketPath ? { socketPath } : undefined);

/**
 * Tope de una consulta corta al daemon. Sin él, dockerode no impone ninguno:
 * un `inspect` que no vuelve dejaba colgado a quien preguntó para siempre.
 */
const QUERY_TIMEOUT_MS = 30_000;

/**
 * Cliente para consultas cortas (ping, inspect, stats, listados, volcados de
 * log sin seguir): aquí un socket callado 30 s solo puede ser un daemon que
 * no responde, así que se corta y quien preguntó recibe un error en vez de
 * esperar indefinidamente.
 */
export const dockerQuery = new Docker({ ...(socketPath ? { socketPath } : {}), timeout: QUERY_TIMEOUT_MS });

let lastCheck = 0;
let lastResult = false;
/** Ping en vuelo: N llamadas simultáneas comparten UNA petición al daemon. */
let pending: Promise<boolean> | null = null;

/** Comprueba si el daemon de Docker responde (cacheado 5 s). */
export function dockerAvailable(force = false): Promise<boolean> {
  const nowMs = Date.now();
  if (!force && nowMs - lastCheck < 5000) return Promise.resolve(lastResult);
  if (pending) return pending;
  pending = dockerQuery
    .ping()
    .then(
      () => true,
      () => false,
    )
    .then((ok) => {
      lastResult = ok;
      lastCheck = Date.now();
      return ok;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}
