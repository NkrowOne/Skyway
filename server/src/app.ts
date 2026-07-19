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

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  app.register(cookie);

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
