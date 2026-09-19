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

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

let active = 0;
const waiters: Waiter[] = [];

/**
 * Semáforo global para limitar builds concurrentes.
 *
 * La plaza la CEDE quien la suelta: si hay alguien esperando, `release` se la
 * pasa directamente y `active` no cambia. Antes decrementaba Y despertaba, y
 * un llamante nuevo que llegara entre medias veía hueco y se colaba: dos
 * builds en una plaza, y así hasta agotar la memoria del servidor.
 *
 * `onWait` recibe una función para desistir de la espera (el despliegue se
 * cancela mientras está en cola): se quita de la lista y la promesa rechaza.
 * Quien desiste NO tiene plaza, así que no debe soltarla.
 */
export function acquireBuildSlot(opts: { onWait?: (abandon: () => void) => void } = {}): Promise<void> {
  if (active < config.buildConcurrency) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = { resolve, reject };
    waiters.push(waiter);
    opts.onWait?.(() => {
      const idx = waiters.indexOf(waiter);
      // Ya no está en la cola: le dieron la plaza (o ya desistió). Nada que deshacer.
      if (idx < 0) return;
      waiters.splice(idx, 1);
      reject(new Error('Despliegue cancelado mientras esperaba hueco de build'));
    });
  });
}

export function releaseBuildSlot(): void {
  const next = waiters.shift();
  if (next) {
    // La plaza pasa al siguiente tal cual: sigue ocupada.
    next.resolve();
    return;
  }
  active = Math.max(0, active - 1);
}
