import { FastifyReply, FastifyRequest } from 'fastify';
import { currentUser } from './auth';

/**
 * Limitador de peticiones en memoria, por clave, con ventana deslizante.
 *
 * El login ya tenía su tope por IP; el resto de rutas caras (buscar en los
 * logs de todos los contenedores, ejecutar comandos, consultar DNS) no tenían
 * ninguno, y una cuenta legítima con un bucle en un script bastaba para
 * saturar el socket de Docker o el resolutor. Es deliberadamente simple: un
 * único proceso Node, sin dependencia externa, y un Map que se poda solo.
 */

export interface RateLimitOptions {
  /** Peticiones admitidas por clave dentro de la ventana. */
  max: number;
  windowMs: number;
  /**
   * Por quién se cuenta. Por defecto el usuario autenticado y, sin él, la IP:
   * un token de API y la sesión del navegador de la misma persona comparten
   * cupo, que es lo que se quiere acotar.
   */
  key?: (req: FastifyRequest) => string;
}

/** Tope de claves seguidas por limitador: pasado, se expulsan las más antiguas. */
const MAX_KEYS = 5000;

const MENSAJE = 'Demasiadas peticiones, espera un momento';

function claveDefecto(req: FastifyRequest): string {
  const user = currentUser(req);
  return user ? `u:${user.id}` : `ip:${req.ip}`;
}

/**
 * Devuelve un preHandler de Fastify que responde 429 (con `Retry-After`) cuando
 * la clave ya ha agotado `max` peticiones en los últimos `windowMs`.
 * Cada llamada crea un limitador independiente: úsalo una vez por ruta.
 */
export function rateLimit(opts: RateLimitOptions) {
  const key = opts.key ?? claveDefecto;
  /** Instantes (ms) de las peticiones admitidas por clave, en orden. */
  const hits = new Map<string, number[]>();
  let ultimaPoda = Date.now();

  // Sin temporizador: se poda al paso de las peticiones, una vez por ventana,
  // así el limitador no mantiene vivo el proceso ni hay que pararlo al apagar.
  function podar(ahora: number): void {
    if (ahora - ultimaPoda < opts.windowMs) return;
    ultimaPoda = ahora;
    const desde = ahora - opts.windowMs;
    for (const [k, marcas] of hits) {
      if (marcas.length === 0 || marcas[marcas.length - 1] <= desde) hits.delete(k);
    }
  }

  return async function limitar(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const ahora = Date.now();
    podar(ahora);
    const k = key(req);
    const desde = ahora - opts.windowMs;

    let marcas = hits.get(k);
    if (!marcas) {
      marcas = [];
      hits.set(k, marcas);
      // Se expulsan las claves MÁS ANTIGUAS, nunca todas: un clear() dejaría
      // que una inundación desde muchas claves reiniciara el cupo del resto.
      while (hits.size > MAX_KEYS) {
        const masAntigua = hits.keys().next().value;
        if (masAntigua === undefined) break;
        hits.delete(masAntigua);
      }
    }
    // Fuera de la ventana: se descartan por delante (están en orden).
    let viejas = 0;
    while (viejas < marcas.length && marcas[viejas] <= desde) viejas++;
    if (viejas > 0) marcas.splice(0, viejas);

    if (marcas.length >= opts.max) {
      const reintentoMs = marcas[0] + opts.windowMs - ahora;
      reply.header('Retry-After', String(Math.max(1, Math.ceil(reintentoMs / 1000))));
      reply.code(429).send({ error: MENSAJE });
      return;
    }
    marcas.push(ahora);
  };
}
