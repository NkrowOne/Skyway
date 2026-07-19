import { buildApp } from './app';
import { auditSystem } from './audit';
import { config, ensureDataDirs } from './config';
import { initDb, markStaleDeploymentsFailed } from './db';
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
