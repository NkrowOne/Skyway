import { FastifyReply } from 'fastify';

export interface SseChannel {
  send: (event: string, data: unknown) => void;
  close: () => void;
  onClose: (fn: () => void) => void;
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
    send(event, data) {
      if (channel.closed) return;
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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

  open.add(channel);
  return channel;
}
