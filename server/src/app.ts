import fs from 'fs';
import path from 'path';
import Fastify, { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { config } from './config';
import { authRoutes } from './routes/auth';
import { projectRoutes } from './routes/projects';
import { serviceRoutes } from './routes/services';
import { deploymentRoutes } from './routes/deployments';
import { streamRoutes } from './routes/streams';
import { systemRoutes } from './routes/system';
import { webhookRoutes } from './routes/webhooks';
import { securityRoutes } from './routes/security';
import { alertRoutes } from './routes/alerts';
import { importRoutes } from './routes/import';
import { opsRoutes } from './routes/ops';
import { domainRoutes } from './routes/domains';
import { passkeyRoutes } from './routes/passkeys';
import { tokenRoutes } from './routes/tokens';
import { userRoutes } from './routes/users';
import { dbConsoleRoutes } from './routes/dbconsole';
import { fileRoutes } from './routes/files';
import { monitorRoutes } from './routes/monitor';
import { statusRoutes } from './routes/status';
import { websiteRoutes } from './routes/websites';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    // Solo se confía en cabeceras de proxy de rangos privados/loopback por
    // defecto (ver config.trustProxy): impide falsear la IP del cliente.
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  app.register(cookie);

  // Cabeceras de seguridad en todas las respuestas (no rompe la SPA: los
  // assets son del mismo origen). Las respuestas SSE hacen hijack y no pasan
  // por aquí, pero tampoco cargan HTML, así que no las necesitan.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()');
    reply.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
        "form-action 'self'",
      ].join('; '),
    );
    // HSTS solo sobre HTTPS: en un túnel SSH por HTTP no debe fijarse.
    if (req.protocol === 'https') {
      reply.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const message = err.issues.map((i) => i.message).join('; ');
      return reply.code(400).send({ error: message });
    }
    req.log.error(err);
    const status = (err as any).statusCode && (err as any).statusCode >= 400 ? (err as any).statusCode : 500;
    return reply.code(status).send({ error: err.message || 'Error interno' });
  });

  app.register(authRoutes);
  app.register(projectRoutes);
  app.register(serviceRoutes);
  app.register(deploymentRoutes);
  app.register(streamRoutes);
  app.register(systemRoutes);
  app.register(webhookRoutes);
  app.register(securityRoutes);
  app.register(alertRoutes);
  app.register(importRoutes);
  app.register(opsRoutes);
  app.register(domainRoutes);
  app.register(passkeyRoutes);
  app.register(tokenRoutes);
  app.register(userRoutes);
  app.register(dbConsoleRoutes);
  app.register(fileRoutes);
  app.register(monitorRoutes);
  app.register(statusRoutes);
  app.register(websiteRoutes);

  // Sirve la UI compilada (producción) con fallback SPA.
  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    app.register(fastifyStatic, { root: config.webDist, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.type('text/html').send(fs.readFileSync(path.join(config.webDist, 'index.html')));
      }
      return reply.code(404).send({ error: 'No encontrado' });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'No encontrado' }));
  }

  return app;
}
