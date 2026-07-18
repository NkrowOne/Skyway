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
import { dockerAvailable } from '../docker/client';
import {
  containerName,
  imageExists,
  removeContainer,
  removeImage,
  runServiceContainer,
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

  const name = containerName(project, service);
  log(`Recreando contenedor ${name}...`);
  await stopContainer(name);
  await removeContainer(name);

  await runServiceContainer({
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
  });

  log('Contenedor iniciado, comprobando estado...');
  await sleep(3000);
  const runtime = await getRuntime(name);
  if (runtime.state !== 'running') {
    throw new Error(
      `El contenedor terminó inesperadamente (estado: ${runtime.state}, código de salida: ${runtime.exitCode ?? 'n/a'}). Revisa los logs del servicio.`,
    );
  }
  if (domains.length > 0) {
    log(`Dominios activos: ${domains.join(', ')}`);
  }
  if (hostPort && internalPort) {
    log(`Puerto publicado: ${hostPort} → ${internalPort}`);
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
