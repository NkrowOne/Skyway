import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import {
  createDeployment,
  getDeployment,
  getProject,
  getService,
  getSetting,
  setDeploymentDiagnosis,
  successfulDeploymentsBeyond,
  updateDeployment,
} from '../db';
import { fireAlert, resolveServiceAlerts } from '../alerts';
import { diagnose } from './diagnose';
import { emitDeploy } from '../events';
import { docker, dockerAvailable } from '../docker/client';
import {
  containerName,
  findContainer,
  imageExists,
  removeContainer,
  removeImage,
  renameContainer,
  runServiceContainer,
  startContainer,
  stopContainer,
  volumeName,
  getRuntime,
} from '../docker/containers';
import { ensureNetwork, projectNetworkName, EDGE_NETWORK } from '../docker/networks';
import { buildImage, cloneRepo, spawnLogged } from './builder';
import { acquireBuildSlot, enqueue, releaseBuildSlot } from './queue';
import { getTemplate } from '../templates';
import { resolveServiceEnv } from '../variables';
import { DatabaseConfig, DeploymentRow, GitConfig, ImageConfig, ProjectRow, ServiceRow } from '../types';
import { now } from '../util';

const MAX_LOG_CHARS = 400_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface DeployContext {
  deployment: DeploymentRow;
  log: (line: string) => void;
  flush: () => void;
}

function makeLogger(deploymentId: string): DeployContext['log'] & { buffer: () => string; stop: () => void } {
  let buffer = '';
  let dirty = false;
  const interval = setInterval(() => {
    if (dirty) {
      updateDeployment(deploymentId, { logs: buffer });
      dirty = false;
    }
  }, 1000);

  const log = ((line: string) => {
    const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
    if (buffer.length < MAX_LOG_CHARS) {
      buffer += stamped + '\n';
      dirty = true;
    }
    emitDeploy(deploymentId, { type: 'log', line: stamped });
  }) as any;
  log.buffer = () => buffer;
  log.stop = () => {
    clearInterval(interval);
    updateDeployment(deploymentId, { logs: buffer });
  };
  return log;
}

/** Crea un despliegue y lo encola. Devuelve la fila inmediatamente. */
export function triggerDeploy(
  serviceId: string,
  trigger: string,
  opts: { imageTag?: string } = {},
): DeploymentRow {
  const deployment = createDeployment(serviceId, trigger, opts.imageTag ?? null);
  void enqueue(`deploy:${serviceId}`, () => runDeployment(deployment.id));
  return deployment;
}

async function runDeployment(deploymentId: string): Promise<void> {
  const deployment = getDeployment(deploymentId);
  if (!deployment || deployment.status !== 'queued') return;
  const service = getService(deployment.service_id);
  const project = service ? getProject(service.project_id) : undefined;
  const log = makeLogger(deploymentId);

  const setStatus = (status: DeploymentRow['status']) => {
    updateDeployment(deploymentId, { status });
    emitDeploy(deploymentId, { type: 'status', status });
  };

  try {
    if (!service || !project) throw new Error('El servicio ya no existe');
    if (!(await dockerAvailable(true))) {
      throw new Error('Docker no está disponible. Comprueba que el daemon está corriendo y que Skyway tiene acceso a /var/run/docker.sock');
    }

    log(`Despliegue de "${service.name}" en el proyecto "${project.name}" (${deployment.trigger})`);
    setStatus('building');

    let image: string;
    if (service.type === 'database') {
      image = await prepareDatabaseImage(service, log);
    } else if (service.type === 'image') {
      image = await preparePlainImage(service, log);
    } else if (deployment.image_tag) {
      image = deployment.image_tag;
      log(`Rollback a la imagen ${image}`);
      if (!(await imageExists(image))) {
        throw new Error(`La imagen ${image} ya no existe en el servidor (fue purgada). Haz un despliegue normal.`);
      }
    } else {
      image = await buildGitImage(project, service, deploymentId, log);
    }
    updateDeployment(deploymentId, { image_tag: image });

    setStatus('deploying');
    await deployContainer(project, service, image, deploymentId, log);

    setStatus('success');
    updateDeployment(deploymentId, { finished_at: now() });
    emitDeploy(deploymentId, { type: 'done', status: 'success' });
    log('✔ Despliegue completado');

    // Un despliegue correcto resuelve las alertas de caída previas.
    resolveServiceAlerts(service.id, 'service_down', false);
    resolveServiceAlerts(service.id, 'crash_loop', false);

    if (service.type === 'git' && !deployment.image_tag) {
      await cleanupOldImages(service.id, log);
    }
  } catch (err: any) {
    const message = err?.message || String(err);
    log(`✖ Error: ${message}`);
    updateDeployment(deploymentId, { status: 'failed', error: message, finished_at: now() });

    const diag = diagnose(message, (log as any).buffer());
    if (diag) {
      setDeploymentDiagnosis(deploymentId, diag);
      log(`ℹ ${diag.title}: ${diag.cause}`);
    }
    emitDeploy(deploymentId, { type: 'done', status: 'failed', error: message });

    if (service && project) {
      fireAlert({
        severity: 'warning',
        type: 'deploy_failed',
        serviceId: service.id,
        title: `Despliegue fallido: ${service.name}`,
        message: `El despliegue (${deployment.trigger}) de "${service.name}" en ${project.name} falló: ${message.slice(0, 300)}`,
        explanation: diag ? `${diag.title}. ${diag.fix}` : null,
      });
    }
  } finally {
    (log as any).stop();
  }
}

async function preparePlainImage(service: ServiceRow, log: (l: string) => void): Promise<string> {
  const cfg = service.config as ImageConfig;
  if (!cfg.image) throw new Error('El servicio no tiene imagen configurada');
  if (!(await imageExists(cfg.image))) {
    log(`Descargando imagen ${cfg.image}...`);
    await spawnLogged('docker', ['pull', cfg.image], {}, log);
  } else {
    log(`Imagen ${cfg.image} ya disponible`);
  }
  return cfg.image;
}

async function prepareDatabaseImage(service: ServiceRow, log: (l: string) => void): Promise<string> {
  const cfg = service.config as DatabaseConfig;
  const template = getTemplate(cfg.template);
  if (!template) throw new Error(`Plantilla desconocida: ${cfg.template}`);
  const image = `${template.image}:${cfg.version || template.defaultVersion}`;
  if (!(await imageExists(image))) {
    log(`Descargando imagen ${image}...`);
    await spawnLogged('docker', ['pull', image], {}, log);
  } else {
    log(`Imagen ${image} ya disponible`);
  }
  return image;
}

async function buildGitImage(
  project: ProjectRow,
  service: ServiceRow,
  deploymentId: string,
  log: (l: string) => void,
): Promise<string> {
  const cfg = service.config as GitConfig;
  const image = `skyway/${project.slug}-${service.slug}:${deploymentId.slice(-8)}`;
  const workDir = path.join(config.buildsDir, deploymentId);
  const token = getSetting('githubToken');

  await acquireBuildSlot();
  try {
    const info = await cloneRepo(
      { repoUrl: cfg.repoUrl, branch: cfg.branch || 'main', token, dest: workDir },
      log,
    );
    updateDeployment(deploymentId, { commit_sha: info.commitSha, commit_msg: info.commitMsg });

    await buildImage(
      {
        repoDir: workDir,
        rootDir: cfg.rootDir,
        dockerfilePath: cfg.dockerfilePath,
        imageTag: image,
        buildArgs: cfg.buildArgs,
      },
      log,
    );
    log(`Imagen construida: ${image}`);
    return image;
  } finally {
    releaseBuildSlot();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function deployContainer(
  project: ProjectRow,
  service: ServiceRow,
  image: string,
  deploymentId: string,
  log: (l: string) => void,
): Promise<void> {
  const netName = projectNetworkName(project);
  await ensureNetwork(netName);
  await ensureNetwork(EDGE_NETWORK);

  const env = resolveServiceEnv(service);
  let internalPort: number | null = null;
  let domains: string[] = [];
  let cmd: string[] | null = null;
  let volumes: { name: string; containerPath: string }[] = [];
  let hostPort: number | null = null;
  let cpus: number | null = null;
  let memoryMb: number | null = null;

  if (service.type === 'database') {
    const cfg = service.config as DatabaseConfig;
    const template = getTemplate(cfg.template)!;
    internalPort = template.port;
    cmd = template.cmd || null;
    volumes = [{ name: volumeName(project, service), containerPath: template.volumePath }];
    hostPort = cfg.hostPort ?? null;
    cpus = cfg.cpus ?? null;
    memoryMb = cfg.memoryMb ?? null;
  } else if (service.type === 'image') {
    const cfg = service.config as ImageConfig;
    internalPort = cfg.port ?? null;
    domains = cfg.domains || [];
    hostPort = cfg.hostPort ?? null;
    cpus = cfg.cpus ?? null;
    memoryMb = cfg.memoryMb ?? null;
    volumes = cfg.volumes || [];
    if (cfg.startCmd) cmd = ['sh', '-c', cfg.startCmd];
    if (internalPort && !env.PORT) env.PORT = String(internalPort);
  } else {
    const cfg = service.config as GitConfig;
    internalPort = cfg.port || 3000;
    domains = cfg.domains || [];
    hostPort = cfg.hostPort ?? null;
    cpus = cfg.cpus ?? null;
    memoryMb = cfg.memoryMb ?? null;
    volumes = cfg.volumes || [];
    if (cfg.startCmd) cmd = ['sh', '-c', cfg.startCmd];
    if (!env.PORT) env.PORT = String(internalPort);
  }

  env.SKYWAY_PROJECT = project.slug;
  env.SKYWAY_SERVICE = service.slug;
  env.SKYWAY_DEPLOYMENT = deploymentId;

  const spec = {
    project,
    service,
    image,
    env,
    deploymentId,
    internalPort,
    domains,
    hostPort,
    cpus,
    memoryMb,
    cmd,
    volumes,
  };

  const name = containerName(project, service);
  const tempName = `${name}--next`;
  const prevName = `${name}--prev`;
  const healthcheckPath: string | null =
    service.type !== 'database' ? (service.config as any).healthcheckPath || null : null;

  await recoverStaleSwap(name, prevName, tempName, log);

  // Sin volúmenes ni puerto de host, la versión nueva puede convivir con la
  // vieja unos segundos: corte cero. Con estado compartido, intercambio con
  // restauración automática (nunca dos procesos escribiendo el mismo volumen).
  const canOverlap = service.type !== 'database' && volumes.length === 0 && !hostPort;
  const oldExists = !!(await findContainer(name));

  if (canOverlap && oldExists) {
    log('Validando la versión nueva antes de tocar la actual (la vieja sigue sirviendo)...');
    await runServiceContainer({
      ...spec,
      nameOverride: tempName,
      aliasOverride: `${service.slug}-next`,
      withTraefik: false,
      withHostPort: false,
      restartPolicy: 'no',
    });
    const verdict = await validateContainer(netName, `${service.slug}-next`, internalPort, healthcheckPath, tempName, log);
    if (!verdict.ok) {
      await appendContainerTail(tempName, log);
      await removeContainer(tempName);
      throw new Error(
        `La versión nueva no pasó la validación (${verdict.reason}). La versión anterior sigue en marcha SIN interrupción.`,
      );
    }
    await removeContainer(tempName);

    log('Versión validada. Intercambiando sin corte...');
    await renameContainer(name, prevName);
    try {
      await runServiceContainer(spec);
      await sleep(3000);
      const runtime = await getRuntime(name);
      if (runtime.state !== 'running') {
        throw new Error(`estado ${runtime.state}, código ${runtime.exitCode ?? 'n/a'}`);
      }
    } catch (err: any) {
      log('El arranque definitivo falló: restaurando la versión anterior...');
      await removeContainer(name);
      await renameContainer(prevName, name);
      throw new Error(
        `Fallo en el arranque definitivo (${err?.message || err}). Se mantuvo la versión anterior sin interrupción.`,
      );
    }
    await stopContainer(prevName);
    await removeContainer(prevName);
    log('Intercambio completado: corte cero.');
  } else {
    if (oldExists) {
      log('Servicio con estado (volúmenes/puerto fijo): intercambio con restauración automática...');
      await renameContainer(name, prevName);
      await stopContainer(prevName);
    }
    try {
      await runServiceContainer(spec);
      const verdict = await validateContainer(netName, service.slug, internalPort, healthcheckPath, name, log);
      if (!verdict.ok) throw new Error(verdict.reason);
    } catch (err: any) {
      await appendContainerTail(name, log);
      await removeContainer(name);
      if (oldExists) {
        log('La versión nueva falló: restaurando la anterior...');
        await renameContainer(prevName, name);
        await startContainer(name);
        throw new Error(
          `La versión nueva falló (${err?.message || err}). Se restauró la versión anterior automáticamente.`,
        );
      }
      throw new Error(
        `El contenedor terminó inesperadamente (${err?.message || err}). Revisa los logs del servicio.`,
      );
    }
    if (oldExists) await removeContainer(prevName);
  }

  if (domains.length > 0) {
    log(`Dominios activos: ${domains.join(', ')}`);
  }
  if (hostPort && internalPort) {
    log(`Puerto publicado: ${hostPort} → ${internalPort}`);
  }
}

/** Repara restos de un intercambio interrumpido (caída del servidor a mitad). */
async function recoverStaleSwap(name: string, prevName: string, tempName: string, log: (l: string) => void): Promise<void> {
  await removeContainer(tempName);
  const prev = await findContainer(prevName);
  if (!prev) return;
  const current = await findContainer(name);
  if (current) {
    await removeContainer(prevName);
  } else {
    log('Recuperando intercambio interrumpido: restaurando contenedor previo...');
    await renameContainer(prevName, name);
  }
}

const PROBE_TIMEOUT_MS = 60_000;
const PROBE_INTERVAL_MS = 2500;
const GRACE_MS = 5000;

/**
 * Valida un contenedor recién arrancado: sonda HTTP al healthcheck si está
 * configurado; si no, un periodo de gracia comprobando que sigue vivo.
 */
async function validateContainer(
  netName: string,
  aliasHost: string,
  port: number | null,
  healthcheckPath: string | null,
  containerRef: string,
  log: (l: string) => void,
): Promise<{ ok: boolean; reason: string }> {
  if (healthcheckPath && port) {
    const path = healthcheckPath.startsWith('/') ? healthcheckPath : `/${healthcheckPath}`;
    log(`Esperando healthcheck 2xx en http://${aliasHost}:${port}${path} (hasta ${PROBE_TIMEOUT_MS / 1000}s)...`);
    if (!(await imageExists('busybox:stable'))) {
      await spawnLogged('docker', ['pull', 'busybox:stable'], {}, log);
    }
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    let attempts = 0;
    await sleep(1000);
    while (Date.now() < deadline) {
      attempts += 1;
      const state = await getRuntime(containerRef);
      if (state.state !== 'running') {
        return { ok: false, reason: `el proceso murió durante el arranque (código ${state.exitCode ?? 'n/a'})` };
      }
      if (await probeOnce(netName, aliasHost, port, path)) {
        log(`Healthcheck superado en el intento ${attempts}.`);
        return { ok: true, reason: 'ok' };
      }
      await sleep(PROBE_INTERVAL_MS);
    }
    return { ok: false, reason: `el healthcheck ${path} no respondió 2xx en ${PROBE_TIMEOUT_MS / 1000}s` };
  }

  log(`Sin healthcheck configurado: periodo de gracia de ${GRACE_MS / 1000}s...`);
  await sleep(GRACE_MS);
  const runtime = await getRuntime(containerRef);
  if (runtime.state !== 'running') {
    return { ok: false, reason: `el proceso terminó enseguida (estado ${runtime.state}, código ${runtime.exitCode ?? 'n/a'})` };
  }
  return { ok: true, reason: 'ok' };
}

function probeOnce(netName: string, host: string, port: number, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('docker', [
      'run', '--rm', '--network', netName, 'busybox:stable',
      'wget', '-q', '-T', '3', '-O', '/dev/null', `http://${host}:${port}${path}`,
    ], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

/** Añade al log del despliegue las últimas líneas del contenedor fallido. */
async function appendContainerTail(name: string, log: (l: string) => void): Promise<void> {
  try {
    const info = await findContainer(name);
    if (!info) return;
    const container = docker.getContainer(name);
    const buf = (await container.logs({ stdout: true, stderr: true, tail: 15, follow: false })) as unknown as Buffer;
    const text = buf
      .toString('utf8')
      .split('\n')
      .map((l) => l.slice(8)) // cabecera de multiplexado de docker
      .filter((l) => l.trim())
      .slice(-15);
    if (text.length > 0) {
      log('— Últimas líneas del contenedor fallido —');
      for (const line of text) log(`  ${line}`);
    }
  } catch {
    /* best-effort */
  }
}

async function cleanupOldImages(serviceId: string, log: (l: string) => void): Promise<void> {
  try {
    const stale = successfulDeploymentsBeyond(serviceId, 5);
    for (const dep of stale) {
      if (dep.image_tag) {
        await removeImage(dep.image_tag);
      }
    }
    if (stale.length > 0) log(`Purgadas ${stale.length} imágenes antiguas (se conservan las últimas 5)`);
  } catch {
    // best-effort
  }
}
