/**
 * Tandas de líneas de un stream de logs. Un build o una aplicación parlanchina
 * mandan cientos de líneas por segundo; antes se pintaba una tanda por frame
 * (hasta sesenta renders por segundo de toda la consola) y en el móvil el
 * hilo principal no daba abasto: el scroll y los botones dejaban de responder.
 * Con una tanda cada 60 ms la consola sigue pareciendo instantánea. Medido con
 * la CPU a 1/6 y 300 líneas/s: al subir con el dedo en pleno directo, de ~40
 * a ~57 fotogramas por segundo. Con 120 ms cada tanda pasaba de los 50 ms de
 * trabajo seguido y se notaban tirones.
 */
export const LOG_FLUSH_MS = 60;

export interface Batcher<T> {
  push: (item: T) => void;
  /** Entrega ya lo pendiente (p. ej. al terminar el stream). */
  flush: () => void;
  /** Descarta lo pendiente sin entregarlo (otra fuente, desmontaje). */
  clear: () => void;
}

export function createBatcher<T>(onFlush: (items: T[]) => void, ms = LOG_FLUSH_MS): Batcher<T> {
  let pending: T[] = [];
  let timer = 0;
  const run = () => {
    timer = 0;
    if (!pending.length) return;
    const items = pending;
    pending = [];
    onFlush(items);
  };
  return {
    push(item) {
      pending.push(item);
      if (!timer) timer = window.setTimeout(run, ms);
    },
    flush() {
      if (timer) window.clearTimeout(timer);
      run();
    },
    clear() {
      pending = [];
      if (timer) window.clearTimeout(timer);
      timer = 0;
    },
  };
}
