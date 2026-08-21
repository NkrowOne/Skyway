import { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { fireAlert } from './alerts';
import { auditSystem } from './audit';
import { config, ensureDataDirs } from './config';
import { checkIntegrity, closeDb, initDb, markStaleDeploymentsFailed } from './db';
import { dockerAvailable } from './docker/client';
import { ensureNetwork, EDGE_NETWORK } from './docker/networks';
import { startMonitor } from './monitor';
import { closeAllSse } from './sse';
import { startScheduler } from './scheduler';
import { startAutoDeploy } from './autodeploy';

async function main(): Promise<void> {
  ensureDataDirs();
  initDb();

  const stale = markStaleDeploymentsFailed();
  const app = buildApp();

  if (stale > 0) app.log.warn(`${stale} despliegues interrumpidos marcados como fallidos`);

  // Integridad de la BD del panel: detectar corrupción (disco, apagón) al
  // arrancar, cuando aún hay backups recientes, y no semanas después.
  const integrity = checkIntegrity();
  if (integrity) {
    app.log.error(`Integridad de skyway.db comprometida: ${integrity}`);
    auditSystem('db_integrity_failed', integrity.slice(0, 300));
    try {
      fireAlert({
        severity: 'critical',
        type: 'db_integrity',
        title: 'Base de datos del panel dañada',
        message: `La comprobación de integridad de skyway.db falló al arrancar: ${integrity.slice(0, 300)}`,
        explanation:
          'Restaura el snapshot más reciente (Ajustes → Copia de seguridad del panel, o /data/backups/skyway/) parando Skyway y reemplazando /data/skyway.db. Revisa también la salud del disco.',
        dedupeKey: 'system:db-integrity',
      });
    } catch {
      /* con la BD dañada, la alerta puede fallar: el log queda como rastro */
    }
  }

  if (await dockerAvailable(true)) {
    try {
      await ensureNetwork(EDGE_NETWORK);
    } catch (err) {
      app.log.warn({ err }, 'No se pudo crear la red edge de Traefik');
    }
  } else {
    app.log.warn('Docker no está disponible: los despliegues fallarán hasta que el daemon sea accesible');
  }

  startMonitor({ warn: (msg) => app.log.warn(msg) });
  startScheduler({ warn: (msg) => app.log.warn(msg) });
  startAutoDeploy({ warn: (msg) => app.log.warn(msg) });
  auditSystem('server_started', `v${config.version}`);

  installProcessHandlers(app);

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Skyway listo en http://localhost:${config.port}`);
}

/** Margen para terminar lo que esté en curso antes de matar el proceso. */
const SHUTDOWN_GRACE_MS = 10_000;

/**
 * Ciclo de vida del proceso.
 *
 * Sin esto, un rechazo de promesa sin capturar tumba Node sin dejar rastro de
 * dónde venía —y con `restart: unless-stopped` el contenedor vuelve solo, así
 * que el fallo se repite en silencio—; y un `docker compose down` mataba el
 * proceso en seco, dejando la base con el WAL a medio consolidar y los
 * despliegues en curso sin marcar.
 */
function installProcessHandlers(app: FastifyInstance): void {
  // Un rechazo sin capturar es un fallo real, pero no una razón para tirar el
  // panel entero: se registra con su traza y el servidor sigue en pie.
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'Promesa rechazada sin capturar');
  });

  // Una excepción sin capturar SÍ deja el proceso en estado dudoso: se registra
  // y se sale, que es lo que permite a Docker levantarlo limpio.
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'Excepción sin capturar: cerrando');
    void shutdown(app, 1);
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      app.log.info(`${signal} recibido: cerrando ordenadamente`);
      void shutdown(app, 0);
    });
  }
}

let shuttingDown = false;

async function shutdown(app: FastifyInstance, code: number): Promise<void> {
  // Un segundo Ctrl+C (o una excepción durante el cierre) no debe reentrar.
  if (shuttingDown) return;
  shuttingDown = true;

  // Reloj de seguridad: si algo se queda colgado —una conexión SSE que no
  // cierra, un build a medias— se sale igual en vez de quedarse esperando.
  const forced = setTimeout(() => {
    app.log.warn('El cierre ordenado no terminó a tiempo: salida forzada');
    process.exit(code);
  }, SHUTDOWN_GRACE_MS);
  forced.unref();

  // Los streams SSE no terminan solos: se cierran antes de que `app.close()`
  // se ponga a esperarlos.
  closeAllSse();
  try {
    // Cierra la escucha y espera a las peticiones en vuelo.
    await app.close();
  } catch (err) {
    app.log.warn({ err }, 'Error cerrando el servidor HTTP');
  }
  closeDb();
  clearTimeout(forced);
  process.exit(code);
}

main().catch((err) => {
  console.error('Error fatal al arrancar Skyway:', err);
  process.exit(1);
});
