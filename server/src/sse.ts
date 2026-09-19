import { FastifyReply } from 'fastify';

export interface SseChannel {
  /**
   * `id` opcional: el navegador lo devuelve en `Last-Event-ID` al reconectar
   * solo, y la ruta puede reanudar desde ahí en vez de empezar de cero.
   *
   * Devuelve lo que `write` del socket: false si el búfer de salida está lleno
   * (el navegador no da abasto). Quien reenvía un stream debe entonces frenar
   * su fuente y esperar a `onDrain`, en vez de acumular en memoria sin tope.
   */
  send: (event: string, data: unknown, id?: string | null) => boolean;
  close: () => void;
  onClose: (fn: () => void) => void;
  /** Avisa UNA vez cuando el socket vuelve a admitir escrituras. */
  onDrain: (fn: () => void) => void;
  closed: boolean;
}

/**
 * Canales abiertos. Un SSE es una conexión que no termina nunca por sí sola, y
 * `fastify.close()` espera a que las conexiones en vuelo acaben: sin cerrarlos
 * a mano, cada apagado se quedaba colgado hasta agotar el margen de gracia.
 */
const open = new Set<SseChannel>();

/** Cierra todos los streams (apagado ordenado). */
export function closeAllSse(): void {
  for (const channel of [...open]) channel.close();
}

/** Inicializa una respuesta Server-Sent Events sobre la conexión cruda. */
export function sseInit(reply: FastifyReply): SseChannel {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  raw.write(':ok\n\n');

  const ping = setInterval(() => {
    if (!channel.closed) raw.write(':ping\n\n');
  }, 15000);

  const closeFns: (() => void)[] = [];

  /**
   * Limpieza única, venga de donde venga el cierre. Antes los `onClose` solo
   * corrían con el evento del socket: si se cerraba desde el servidor —o el
   * socket ya estaba muerto y el evento no llegaba— los temporizadores que
   * registran las rutas (el tick de métricas, el seguimiento de logs) se
   * quedaban vivos apuntando a un canal cerrado.
   */
  let cleaned = false;
  const cleanup = (): void => {
    channel.closed = true;
    if (cleaned) return;
    cleaned = true;
    open.delete(channel);
    clearInterval(ping);
    for (const fn of closeFns) fn();
  };

  const channel: SseChannel = {
    closed: false,
    send(event, data, id) {
      // Cerrado: no hay nada que escribir ni un 'drain' que vaya a llegar, así
      // que no se le pide a nadie que espere.
      if (channel.closed) return true;
      // El id no puede llevar saltos de línea (rompería el protocolo).
      const idLine = id ? `id: ${String(id).replace(/[\r\n]+/g, ' ')}\n` : '';
      return raw.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    onDrain(fn) {
      if (channel.closed) return;
      raw.once('drain', fn);
    },
    close() {
      if (channel.closed) return;
      cleanup();
      try {
        raw.end();
      } catch {
        /* noop */
      }
    },
    onClose(fn) {
      // Registrado ya cerrado: se ejecuta igual, si no nunca se limpiaría.
      if (cleaned) fn();
      else closeFns.push(fn);
    },
  };

  raw.on('close', cleanup);
  // Sin oyente, un error de escritura en la respuesta (el navegador cortó a
  // medias) se emite como excepción no capturada y apaga el proceso entero.
  raw.on('error', cleanup);

  open.add(channel);
  return channel;
}
