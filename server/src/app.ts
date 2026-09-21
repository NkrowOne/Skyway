import fs from 'fs';
import path from 'path';
import Fastify, { FastifyInstance, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { COOKIE_NAME } from './auth';
import { config } from './config';
import { authRoutes } from './routes/auth';
import { connectorRoutes } from './routes/connectors';
import { githubRoutes } from './routes/github';
import { workspaceRoutes } from './routes/workspaces';
import { planRoutes } from './routes/plans';
import { billingRoutes } from './routes/billing';
import { accountingRoutes } from './routes/accounting';
import { productRoutes } from './routes/products';
import { subscriptionRoutes } from './routes/subscriptions';
import { usageRoutes } from './routes/usage';
import { aiGatewayRoutes } from './routes/aigateway';
import { projectRoutes } from './routes/projects';
import { serviceRoutes } from './routes/services';
import { stackRoutes } from './routes/stacks';
import { deploymentRoutes } from './routes/deployments';
import { streamRoutes } from './routes/streams';
import { systemRoutes } from './routes/system';
import { webhookRoutes } from './routes/webhooks';
import { securityRoutes } from './routes/security';
import { alertRoutes } from './routes/alerts';
import { importRoutes } from './routes/import';
import { migrateRoutes } from './routes/migrate';
import { opsRoutes } from './routes/ops';
import { domainRoutes } from './routes/domains';
import { passkeyRoutes } from './routes/passkeys';
import { tokenRoutes } from './routes/tokens';
import { userRoutes } from './routes/users';
import { dbConsoleRoutes } from './routes/dbconsole';
import { fileRoutes } from './routes/files';
import { monitorRoutes } from './routes/monitor';
import { metricsRoutes } from './routes/metrics';
import { statusRoutes } from './routes/status';
import { websiteRoutes } from './routes/websites';
import { helpRoutes } from './routes/help';

const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Defensa anti-CSRF para las peticiones que mutan estado autenticadas con la
 * COOKIE de sesión. `SameSite=Lax` ya frena a otros sitios, pero no a un
 * subdominio del mismo sitio: en Skyway las aplicaciones de los clientes viven
 * en subdominios del `rootDomain` del panel, así que una app desplegada por un
 * inquilino podía hacer POST al panel con la cookie del administrador que la
 * visitara. Un token Bearer no viaja solo, así que no necesita esta guarda; una
 * petición sin cookie tampoco (webhooks de GitHub/Stripe).
 *
 * Se mira primero `Sec-Fetch-Site`, que el navegador rellena sin que nadie
 * pueda falsearlo y que no depende de cómo reenvíe el Host el proxy; sin ella,
 * se compara el host de `Origin` con el de la petición.
 */
function rechazarPorOrigen(req: FastifyRequest): boolean {
  if (METODOS_SEGUROS.has(req.method)) return false;
  const cookie = req.headers.cookie;
  if (!cookie || !cookie.includes(`${COOKIE_NAME}=`)) return false;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return false;

  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite === 'same-origin' || fetchSite === 'none') return false;
  if (fetchSite === 'cross-site' || fetchSite === 'same-site') return true;

  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin) return false;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    // `Origin: null` (iframe aislado, redirección desde otro sitio) o basura.
    return true;
  }
  // `URL.host` omite el puerto por defecto del esquema; la cabecera Host puede
  // llevarlo escrito («panel:443»). Se comparan ambos sin él.
  const puertoDefecto = originUrl.protocol === 'https:' ? ':443' : ':80';
  const normalizar = (h: string): string => h.toLowerCase().replace(new RegExp(`${puertoDefecto}$`), '');
  const originHost = normalizar(originUrl.host);
  const hosts = [req.hostname, req.headers.host].filter((h): h is string => typeof h === 'string' && h.length > 0);
  return !hosts.some((h) => normalizar(h) === originHost);
}

/** Error que describe el interior del servidor y no una situación del usuario. */
function esErrorInterno(err: unknown): boolean {
  if (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError || err instanceof SyntaxError) {
    return true;
  }
  const e = err as { code?: unknown; errno?: unknown } | null;
  if (typeof e?.code === 'string' && e.code.startsWith('SQLITE_')) return true;
  // Errores de sistema de Node (ENOENT, EACCES, ECONNREFUSED…) llevan `errno`.
  return typeof e?.errno === 'number';
}

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
        // github.com: crear la GitHub App exige que el NAVEGADOR envíe el
        // manifiesto por POST a github.com (no hay forma server-to-server).
        // Es el único destino externo admitido, y solo para formularios.
        "form-action 'self' https://github.com",
      ].join('; '),
    );
    // HSTS solo sobre HTTPS: en un túnel SSH por HTTP no debe fijarse.
    if (req.protocol === 'https') {
      reply.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    // Las respuestas de la API llevan datos de la sesión: sin esto el navegador
    // podía guardarlas en la caché de historial y enseñarlas tras cerrar sesión
    // en un equipo compartido. Una ruta que quiera otra política la sobrescribe.
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');

    if (config.csrfOriginCheck && rechazarPorOrigen(req)) {
      req.log.warn({ origin: req.headers.origin, host: req.hostname, url: req.url }, 'Petición con cookie rechazada por origen');
      return reply.code(403).send({
        error:
          'Petición rechazada: su origen no coincide con el del panel. Si accedes a través de un proxy, ' +
          'configúralo para que reenvíe la cabecera Host (o X-Forwarded-Host) del navegador.',
      });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const message = err.issues.map((i) => i.message).join('; ');
      return reply.code(400).send({ error: message });
    }
    const status = (err as any).statusCode && (err as any).statusCode >= 400 ? (err as any).statusCode : 500;
    if (status >= 500) req.log.error(err);
    else req.log.warn(err);
    // Los mensajes que lanza el propio código (`new Error('…')`) están pensados
    // para el usuario y se devuelven. Los de un fallo de programación o del
    // sistema (TypeError, error de SQLite, ENOENT…) describen las tripas del
    // servidor —rutas de fichero, nombres de columna— y no le sirven a nadie
    // que no tenga ya el log: se sustituyen por un mensaje genérico.
    const message = status >= 500 && esErrorInterno(err) ? 'Error interno' : err.message || 'Error interno';
    return reply.code(status).send({ error: message });
  });

  app.register(authRoutes);
  app.register(connectorRoutes);
  app.register(githubRoutes);
  app.register(workspaceRoutes);
  app.register(planRoutes);
  app.register(billingRoutes);
  app.register(accountingRoutes);
  app.register(productRoutes);
  app.register(subscriptionRoutes);
  app.register(usageRoutes);
  app.register(aiGatewayRoutes);
  app.register(projectRoutes);
  app.register(serviceRoutes);
  app.register(stackRoutes);
  app.register(deploymentRoutes);
  app.register(streamRoutes);
  app.register(systemRoutes);
  app.register(webhookRoutes);
  app.register(securityRoutes);
  app.register(alertRoutes);
  app.register(importRoutes);
  app.register(migrateRoutes);
  app.register(opsRoutes);
  app.register(domainRoutes);
  app.register(passkeyRoutes);
  app.register(tokenRoutes);
  app.register(userRoutes);
  app.register(dbConsoleRoutes);
  app.register(fileRoutes);
  app.register(monitorRoutes);
  app.register(metricsRoutes);
  app.register(statusRoutes);
  app.register(websiteRoutes);
  app.register(helpRoutes);

  // Sirve la UI compilada (producción) con fallback SPA optimizado en memoria y caché inmutable.
  const indexHtmlPath = path.join(config.webDist, 'index.html');
  if (fs.existsSync(indexHtmlPath)) {
    let cachedIndexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
    // `persistent: false`: el sondeo no debe mantener vivo el proceso por sí
    // solo (tras `app.close()` en pruebas o herramientas se quedaba colgado).
    fs.watchFile(indexHtmlPath, { interval: 5000, persistent: false }, () => {
      try {
        if (fs.existsSync(indexHtmlPath)) cachedIndexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
      } catch {
        /* noop */
      }
    });

    app.register(fastifyStatic, {
      root: config.webDist,
      index: ['index.html'],
      setHeaders: (res, filePath) => {
        if (filePath.includes(path.sep + 'assets' + path.sep) || filePath.includes('/assets/')) {
          // Assets versionados con hash de Vite: caché inmutable de 1 año
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          // index.html y otros archivos raíz: no-cache para detección inmediata de versiones nuevas
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      },
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply
          .type('text/html')
          .header('Cache-Control', 'no-cache, no-store, must-revalidate')
          .send(cachedIndexHtml);
      }
      return reply.code(404).send({ error: 'No encontrado' });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'No encontrado' }));
  }

  return app;
}
