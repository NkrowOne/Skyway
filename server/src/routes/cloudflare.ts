import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin, requireAuth, requireSession } from '../auth';
import { audit } from '../audit';
import {
  borrarTokenCloudflare,
  cloudflareConfigView,
  cloudflareTokenSchema,
  guardarTokenCloudflare,
  probarTokenCloudflare,
} from '../cloudflareconfig';
import { borrarRegistroCreado, registrosCreados, restaurarReemplazo } from '../cloudflaredns';
import { rateLimit } from '../ratelimit';

/**
 * Ajustes → Cloudflare: el token del administrador con el que Skyway crea el
 * DNS de los dominios de servicios que da de alta un administrador
 * (`cloudflaredns.ts`). Todo es solo de administrador; guardar y borrar exigen
 * además sesión de navegador, como la conexión con Mailway: un token de API
 * robado no debe poder cambiar a qué cuenta de Cloudflare escribe el panel.
 * El token nunca se devuelve: solo su pista y las zonas que ve.
 */
export async function cloudflareRoutes(app: FastifyInstance): Promise<void> {
  app.register(async (secured) => {
    secured.addHook('preHandler', requireAuth);

    secured.get('/api/cloudflare/config', { preHandler: requireAdmin }, async () => cloudflareConfigView());

    secured.put('/api/cloudflare/config', { preHandler: [requireAdmin, requireSession] }, async (req) => {
      const body = cloudflareTokenSchema.parse(req.body ?? {});
      await guardarTokenCloudflare(body.token, (action, target) => audit(req, action, target));
      return { ok: true, config: cloudflareConfigView() };
    });

    secured.delete('/api/cloudflare/config', { preHandler: [requireAdmin, requireSession] }, async (req) => {
      borrarTokenCloudflare((action, target) => audit(req, action, target));
      return { ok: true, config: cloudflareConfigView() };
    });

    /**
     * Registros que creó el DNS automático en las zonas del operador. Cada
     * nombre queda reservado al proyecto para el que se creó hasta que el
     * administrador borra aquí su registro (solo si nadie lo usa ni lo ha
     * cambiado en Cloudflare).
     */
    secured.get('/api/cloudflare/records', { preHandler: requireAdmin }, async () => ({ records: registrosCreados() }));

    secured.delete(
      '/api/cloudflare/records/:domain',
      { preHandler: [requireAdmin, rateLimit({ max: 30, windowMs: 60_000 })] },
      async (req) => {
        const { domain } = z.object({ domain: z.string().trim().toLowerCase().min(1).max(253) }).parse(req.params);
        const result = await borrarRegistroCreado(domain, (action, target) => audit(req, action, target));
        return { ok: true, result, records: registrosCreados() };
      },
    );

    /**
     * Deshace el reemplazo de un nombre: vuelve a crear los registros del
     * hosting anterior y retira el A de Skyway, de una vez. Con sesión de
     * navegador, como el reemplazo: devuelve el tráfico de la web a otro sitio.
     */
    secured.post(
      '/api/cloudflare/records/:domain/restore',
      { preHandler: [requireAdmin, requireSession, rateLimit({ max: 10, windowMs: 60_000 })] },
      async (req) => {
        const { domain } = z.object({ domain: z.string().trim().toLowerCase().min(1).max(253) }).parse(req.params);
        const result = await restaurarReemplazo(domain, (action, target) => audit(req, action, target));
        return { ok: true, result, records: registrosCreados() };
      },
    );

    /**
     * Prueba el token indicado (sin guardarlo) o el guardado. Cada prueba son
     * varias peticiones a Cloudflare, que limita por token: tope por usuario.
     */
    secured.post(
      '/api/cloudflare/test',
      { preHandler: [requireAdmin, rateLimit({ max: 12, windowMs: 60_000 })] },
      async (req) => {
        const body = z.object({ token: z.string().trim().max(400).optional() }).parse(req.body ?? {});
        return probarTokenCloudflare({ token: body.token || undefined });
      },
    );
  });
}
