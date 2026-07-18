import Docker from 'dockerode';

export const docker = new Docker(
  process.env.DOCKER_SOCK ? { socketPath: process.env.DOCKER_SOCK } : undefined,
);

let lastCheck = 0;
let lastResult = false;

/** Comprueba si el daemon de Docker responde (cacheado 5 s). */
export async function dockerAvailable(force = false): Promise<boolean> {
  const nowMs = Date.now();
  if (!force && nowMs - lastCheck < 5000) return lastResult;
  try {
    await docker.ping();
    lastResult = true;
  } catch {
    lastResult = false;
  }
  lastCheck = nowMs;
  return lastResult;
}
