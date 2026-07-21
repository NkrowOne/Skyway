import { buildApp } from './app';
import { fireAlert } from './alerts';
import { auditSystem } from './audit';
import { config, ensureDataDirs } from './config';
import { checkIntegrity, initDb, markStaleDeploymentsFailed } from './db';
import { dockerAvailable } from './docker/client';
import { ensureNetwork, EDGE_NETWORK } from './docker/networks';
import { startMonitor } from './monitor';
import { startScheduler } from './scheduler';

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
  auditSystem('server_started', `v${config.version}`);

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Skyway listo en http://localhost:${config.port}`);
}

main().catch((err) => {
  console.error('Error fatal al arrancar Skyway:', err);
  process.exit(1);
});
