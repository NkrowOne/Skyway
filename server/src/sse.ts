import { FastifyReply } from 'fastify';

export interface SseChannel {
  send: (event: string, data: unknown) => void;
  close: () => void;
  onClose: (fn: () => void) => void;
  closed: boolean;
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
  const channel: SseChannel = {
    closed: false,
    send(event, data) {
      if (channel.closed) return;
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (channel.closed) return;
      channel.closed = true;
      clearInterval(ping);
      try {
        raw.end();
      } catch {
        /* noop */
      }
    },
    onClose(fn) {
      closeFns.push(fn);
    },
  };

  raw.on('close', () => {
    channel.closed = true;
    clearInterval(ping);
    for (const fn of closeFns) fn();
  });

  return channel;
}
