import { config } from '../config';

const chains = new Map<string, Promise<void>>();

/** Serializa trabajos por clave (un despliegue a la vez por servicio). */
export function enqueue(key: string, job: () => Promise<void>): Promise<void> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(job, job).catch(() => {});
  chains.set(key, next);
  next.finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
  return next;
}

let active = 0;
const waiters: (() => void)[] = [];

/** Semáforo global para limitar builds concurrentes. */
export async function acquireBuildSlot(): Promise<void> {
  if (active >= config.buildConcurrency) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active += 1;
}

export function releaseBuildSlot(): void {
  active = Math.max(0, active - 1);
  const next = waiters.shift();
  if (next) next();
}
