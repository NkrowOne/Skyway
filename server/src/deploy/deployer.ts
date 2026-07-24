import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import {
  createDeployment,
  getDeployment,
  getEnv,
  getGithubConnector,
  getProject,
  getService,
  getSetting,
  setDeploymentDiagnosis,
  setEnv,
  successfulDeploymentsBeyond,
  touchGithubConnector,
  updateDeployment,
} from '../db';
import { fireAlert, resolveServiceAlerts } from '../alerts';
import { diagnose } from './diagnose';
import { emitDeploy } from '../events';
import { docker, dockerAvailable } from '../docker/client';
import {
  configuredReplicas,
  containerName,
  findContainer,
  imageExists,
  listServiceContainers,
  removeContainer,
  removeImage,
  renameContainer,
  replicaName,
  runServiceContainer,
  startContainer,
  stopContainer,
  volumeName,
  getRuntime,
} from '../docker/containers';
import { ensureNetwork, projectNetworkName, EDGE_NETWORK } from '../docker/networks';
import { isWorkspaceActive, workspaceOfProject } from '../quota';
import { buildImage, cloneRepo, readRailwayStartCommand, spawnLogged } from './builder';
import { acquireBuildSlot, enqueue, releaseBuildSlot } from './queue';
import { effectiveDbVersion, getTemplate, volumePathFor } from '../templates';
import { resolveServiceEnv } from '../variables';
import { DatabaseConfig, DeploymentRow, GitConfig, ImageConfig, ProjectRow, ServiceRow } from '../types';
import { now } from '../util';

const MAX_LOG_CHARS = 400_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class CanceledError extends Error {
  constructor() {
    super('Despliegue cancelado por el usuario');
    this.name = 'CanceledError';
  }
}

interface ActiveJob {
  canceled: boolean;
  procs: Set<{ kill: (signal?: string) => void }>;
}

const activeJobs = new Map<string, ActiveJob>();

/**
 * Cancela un despliegue: si está corriendo, mata sus procesos (git/build);
 * si sigue en cola, lo marca como cancelado antes de que arranque.
 */
export function cancelDeployment(deploymentId: string): boolean {
  const job = activeJobs.get(deploymentId);
  if (job) {
    job.canceled = true;
    for (const proc of job.procs) {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ya terminado */
      }
    }
    return true;
  }
  const row = getDeployment(deploymentId);
  if (row && row.status === 'queued') {
    updateDeployment(deploymentId, { status: 'canceled', error: 'Cancelado antes de empezar', finished_at: now() });
    emitDeploy(deploymentId, { type: 'done', status: 'canceled', error: null });
    return true;
  }
  return false;
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
  const job: ActiveJob = { canceled: false, procs: new Set() };
  activeJobs.set(deploymentId, job);

  const setStatus = (status: DeploymentRow['status']) => {
    updateDeployment(deploymentId, { status });
    emitDeploy(deploymentId, { type: 'status', status });
  };

  const checkCanceled = () => {
    if (job.canceled) throw new CanceledError();
  };

  try {
    if (!service || !project) throw new Error('El servicio ya no existe');
    // Cuenta suspendida: se detienen los despliegues (los servicios ya en marcha siguen vivos).
    const workspace = workspaceOfProject(project.id);
    if (workspace && !isWorkspaceActive(workspace)) {
      throw new Error(`El workspace «${workspace.name}» está suspendido: los despliegues están detenidos hasta reactivarlo.`);
    }
    if (!(await dockerAvailable(true))) {
      throw new Error('Docker no está disponible. Comprueba que el daemon está corriendo y que Skyway tiene acceso a /var/run/docker.sock');
    }

    log(`Despliegue de "${service.name}" en el proyecto "${project.name}" (${deployment.trigger})`);
    setStatus('building');

    let image: string;
    let repoStartCmd: string | null = null;
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
      const built = await buildGitImage(project, service, deploymentId, job, log);
      image = built.image;
      repoStartCmd = built.repoStartCmd;
    }
    checkCanceled();
    updateDeployment(deploymentId, { image_tag: image });

    setStatus('deploying');
    await deployContainer(project, service, image, deploymentId, log, repoStartCmd);
    checkCanceled();

    setStatus('success');
    updateDeployment(deploymentId, { finished_at: now() });
    emitDeploy(deploymentId, { type: 'done', status: 'success' });
    log('✔ Despliegue completado');

    // Un despliegue correcto resuelve las alertas de caída y el fallo de despliegue previo.
    resolveServiceAlerts(service.id, 'service_down', false);
    resolveServiceAlerts(service.id, 'crash_loop', false);
    resolveServiceAlerts(service.id, 'deploy_failed', false);

    if (service.type === 'git' && !deployment.image_tag) {
      await cleanupOldImages(service.id, log);
    }
  } catch (err: any) {
    if (err instanceof CanceledError || job.canceled) {
      log('✖ Despliegue cancelado por el usuario');
      updateDeployment(deploymentId, { status: 'canceled', error: 'Cancelado por el usuario', finished_at: now() });
      emitDeploy(deploymentId, { type: 'done', status: 'canceled', error: null });
      return;
    }
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
        // Con dedupe no se apilan reintentos fallidos y un despliegue correcto la cierra.
        dedupe: true,
      });
    }
  } finally {
    activeJobs.delete(deploymentId);
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
  const image = `${template.image}:${effectiveDbVersion(template, cfg.version)}`;
  if (!(await imageExists(image))) {
    log(`Descargando imagen ${image}...`);
    await spawnLogged('docker', ['pull', image], {}, log);
  } else {
    log(`Imagen ${image} ya disponible`);
  }
  return image;
}

/**
 * Garantiza que un servicio de base de datos tiene sus variables de conexión
 * (DATABASE_URL, host, credenciales…) antes de cada arranque: completa SOLO
 * las que falten, conservando las credenciales existentes para no dejar fuera
 * a una base ya inicializada. Cubre servicios creados por versiones antiguas
 * de Skyway y variables borradas a mano desde el editor.
 */
function ensureDatabaseEnv(service: ServiceRow, log: (l: string) => void): void {
  const template = getTemplate((service.config as DatabaseConfig).template);
  if (!template) return;
  const stored = getEnv(service.id);
  const full = template.makeEnv(service.slug, stored);
  const missing = Object.keys(full).filter((k) => stored[k] === undefined);
  if (missing.length === 0) return;
  const next = { ...stored };
  for (const k of missing) next[k] = full[k];
  setEnv(service.id, next);
  log(`Variables de conexión internas generadas (faltaban): ${missing.join(', ')}`);
}

/** Ejecuta un comando y captura su salida (a diferencia de spawnLogged, que la loguea). */
function captureCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c.toString()));
    p.stderr.on('data', (c) => (err += c.toString()));
    p.on('error', reject);
    p.on('exit', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `código de salida ${code}`)),
    );
  });
}

/**
 * Postgres no puede abrir datos de otra versión mayor, y 18+ además cambió el
 * layout del volumen (subdirectorio versionado bajo /var/lib/postgresql). Si el
 * volumen ya contiene datos incompatibles con la versión pedida, el contenedor
 * entraría en bucle de reinicio con un error confuso: mejor cortar aquí con el
 * remedio concreto. La comprobación es best-effort: si no se puede inspeccionar
 * el volumen, el despliegue continúa.
 */
async function assertPostgresVolumeCompatible(
  volume: string,
  version: string,
  log: (l: string) => void,
): Promise<void> {
  const parsed = parseInt(version, 10);
  const target = Number.isInteger(parsed) ? parsed : 18; // latest/alpine → 18+
  try {
    await docker.getVolume(volume).inspect();
  } catch {
    return; // volumen aún no creado: arranque limpio garantizado
  }
  let report: string;
  try {
    if (!(await imageExists('busybox:stable'))) {
      await spawnLogged('docker', ['pull', 'busybox:stable'], {}, log);
    }
    report = await captureCommand('docker', [
      'run', '--rm', '-v', `${volume}:/v:ro`, 'busybox:stable', 'sh', '-c',
      'for f in /v/PG_VERSION /v/data/PG_VERSION /v/*/docker/PG_VERSION; do [ -s "$f" ] && echo "$f=$(cat "$f")"; done; true',
    ]);
  } catch (err: any) {
    log(`⚠ No se pudo inspeccionar el volumen ${volume} (${err?.message || err}): se continúa.`);
    return;
  }

  // Líneas `ruta=versión`: raíz (layout <18), data/ (layout mixto) o N/docker (layout 18+).
  let rootMajor: number | null = null;
  let nestedMajor: number | null = null;
  const newLayoutMajors: number[] = [];
  for (const line of report.split('\n')) {
    const m = /^\/v\/(?:(.+)\/)?PG_VERSION=(\d+)/.exec(line.trim());
    if (!m) continue;
    const major = parseInt(m[2], 10);
    if (!m[1]) rootMajor = major;
    else if (m[1] === 'data') nestedMajor = major;
    else if (/\/docker$/.test(m[1])) newLayoutMajors.push(major);
  }
  if (rootMajor === null && nestedMajor === null && newLayoutMajors.length === 0) return;

  const migra =
    'Para cambiar de versión mayor: crea un Backup con la versión actual de los datos, cambia la versión en Ajustes, borra el servicio marcando «borrar también el volumen», recréalo y restaura el backup. Para empezar de cero basta con borrar el servicio con su volumen.';

  if (rootMajor !== null) {
    if (target >= 18) {
      throw new Error(
        `El volumen ${volume} contiene los datos de PostgreSQL ${rootMajor} con el formato antiguo (anterior a 18) y la imagen pedida es ${version}: Postgres 18+ no puede abrirlos directamente. Mantén la versión «${rootMajor}-alpine» en Ajustes para seguir funcionando, o migra. ${migra}`,
      );
    }
    if (rootMajor !== target) {
      throw new Error(
        `El volumen ${volume} contiene los datos de PostgreSQL ${rootMajor} y la imagen pedida es ${version}: una versión mayor no puede abrir los datos de otra. Vuelve a la versión «${rootMajor}-alpine» o migra. ${migra}`,
      );
    }
    return; // datos y versión coinciden (layout <18): arranque normal
  }

  if (nestedMajor !== null) {
    throw new Error(
      `El volumen ${volume} tiene los datos de PostgreSQL ${nestedMajor} en el subdirectorio data/ (los escribió un Postgres <18 montado en la ruta de 18+, un estado que esta versión de Skyway ya no produce). Con el servicio parado, muévelos a la raíz del volumen: docker run --rm -v ${volume}:/v busybox sh -c 'mv /v/data/* /v/ && rmdir /v/data' y usa la versión «${nestedMajor}-alpine»; o borra el servicio con su volumen para empezar de cero.`,
    );
  }

  // Solo layout 18+ (N/docker): la propia imagen abre el mayor que coincida.
  if (target < 18 || !newLayoutMajors.includes(target)) {
    const found = [...new Set(newLayoutMajors)].join(', ');
    throw new Error(
      `El volumen ${volume} ya está inicializado con el formato de Postgres 18+ (datos de la versión ${found}) y la imagen pedida es ${version}. Usa la versión «${found}-alpine» (o superior con pg_upgrade manual), o migra. ${migra}`,
    );
  }
}

async function buildGitImage(
  project: ProjectRow,
  service: ServiceRow,
  deploymentId: string,
  job: ActiveJob,
  log: (l: string) => void,
): Promise<{ image: string; repoStartCmd: string | null }> {
  const cfg = service.config as GitConfig;
  const image = `skyway/${project.slug}-${service.slug}:${deploymentId.slice(-8)}`;
  const workDir = path.join(config.buildsDir, deploymentId);
  const token = resolveCloneToken(project, cfg, log);
  const onSpawn = (p: any) => {
    job.procs.add(p);
    p.on('exit', () => job.procs.delete(p));
  };

  await acquireBuildSlot();
  try {
    if (job.canceled) throw new CanceledError();
    const info = await cloneRepo(
      { repoUrl: cfg.repoUrl, branch: cfg.branch || 'main', token, dest: workDir, onSpawn },
      log,
    );
    if (job.canceled) throw new CanceledError();
    updateDeployment(deploymentId, { commit_sha: info.commitSha, commit_msg: info.commitMsg });

    const repoStartCmd = readRailwayStartCommand(workDir, cfg.rootDir);

    await buildImage(
      {
        repoDir: workDir,
        rootDir: cfg.rootDir,
        dockerfilePath: cfg.dockerfilePath,
        imageTag: image,
        buildArgs: cfg.buildArgs,
        onSpawn,
      },
      log,
    );
    if (job.canceled) throw new CanceledError();
    log(`Imagen construida: ${image}`);
    return { image, repoStartCmd };
  } finally {
    releaseBuildSlot();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Token con el que clonar/consultar un repo: el conector del proyecto elegido en
 * el servicio (repos del cliente) o, en su defecto, el token global del admin.
 * Sin efectos secundarios: úsalo también fuera del despliegue (p. ej. el sondeo
 * de auto-deploy).
 */
export function gitTokenFor(project: ProjectRow, cfg: GitConfig): string | null {
  if (cfg.connectorId) {
    const connector = getGithubConnector(cfg.connectorId);
    if (connector && connector.project_id === project.id) return connector.token;
  }
  return getSetting('githubToken');
}

/** Igual que `gitTokenFor` pero registra en el log del despliegue y marca el uso del conector. */
function resolveCloneToken(project: ProjectRow, cfg: GitConfig, log: (l: string) => void): string | null {
  if (cfg.connectorId) {
    const connector = getGithubConnector(cfg.connectorId);
    if (connector && connector.project_id === project.id) {
      touchGithubConnector(connector.id);
      log(`Clonando con el conector de GitHub «${connector.name}» (@${connector.gh_login})`);
      return connector.token;
    }
    log('⚠ El conector de GitHub de este servicio ya no existe: se usa el token global si está configurado');
  }
  return getSetting('githubToken');
}

async function deployContainer(
  project: ProjectRow,
  service: ServiceRow,
  image: string,
  deploymentId: string,
  log: (l: string) => void,
  repoStartCmd: string | null = null,
): Promise<void> {
  const netName = projectNetworkName(project);
  await ensureNetwork(netName);
  await ensureNetwork(EDGE_NETWORK);

  if (service.type === 'database') ensureDatabaseEnv(service, log);
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
    // La misma versión efectiva decide imagen y ruta de montaje: si divergieran,
    // un Postgres <18 escribiría los datos en un subdirectorio del volumen y ese
    // layout rompería cualquier cambio de versión posterior.
    const version = effectiveDbVersion(template, cfg.version);
    volumes = [{ name: volumeName(project, service), containerPath: volumePathFor(template, version) }];
    hostPort = cfg.hostPort ?? null;
    cpus = cfg.cpus ?? null;
    memoryMb = cfg.memoryMb ?? null;
    if (template.key === 'postgres') {
      await assertPostgresVolumeCompatible(volumes[0].name, version, log);
    }
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
    // Config-as-code de Railway: el startCommand de railway.json manda sobre
    // el del servicio (misma precedencia que Railway; el importador copia el
    // del panel y puede contradecir al del repo).
    const startCmd = repoStartCmd ?? cfg.startCmd;
    if (repoStartCmd && cfg.startCmd && repoStartCmd !== cfg.startCmd) {
      log(`startCommand de railway.json («${repoStartCmd}») tiene prioridad sobre el del servicio, como en Railway.`);
    }
    if (startCmd) cmd = ['sh', '-c', startCmd];
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

  await recoverStaleSwap(service.id, log);

  const replicas = configuredReplicas(service);
  if (replicas > 1 && (volumes.length > 0 || hostPort)) {
    throw new Error(
      'Las réplicas requieren un servicio sin volúmenes y sin puerto público: varias copias no pueden compartir el mismo volumen de escritura ni el mismo puerto del host. Quita esas opciones o vuelve a 1 réplica.',
    );
  }

  // Sin volúmenes ni puerto de host, la versión nueva puede convivir con la
  // vieja unos segundos: corte cero. Con estado compartido, intercambio con
  // restauración automática (nunca dos procesos escribiendo el mismo volumen).
  const canOverlap = service.type !== 'database' && volumes.length === 0 && !hostPort;
  const oldExists = !!(await findContainer(name));

  if (canOverlap) {
    if (oldExists) {
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
      log(replicas > 1 ? `Versión validada. Actualización rodante de ${replicas} réplicas...` : 'Versión validada. Intercambiando sin corte...');
    }

    // Rolling update: réplica a réplica; todas comparten alias y labels de
    // Traefik, así que el balanceo entre copias es automático.
    for (let i = 1; i <= replicas; i++) {
      const rn = replicaName(project, service, i);
      const rPrev = `${rn}--prev`;
      const hadOld = !!(await findContainer(rn));
      if (hadOld) await renameContainer(rn, rPrev);
      try {
        await runServiceContainer({ ...spec, nameOverride: rn });
        await sleep(3000);
        const runtime = await getRuntime(rn);
        if (runtime.state !== 'running') {
          throw new Error(`estado ${runtime.state}, código ${runtime.exitCode ?? 'n/a'}`);
        }
        if (!oldExists && i === 1) {
          const verdict = await validateContainer(netName, service.slug, internalPort, healthcheckPath, rn, log);
          if (!verdict.ok) throw new Error(verdict.reason);
        }
      } catch (err: any) {
        await appendContainerTail(rn, log);
        await removeContainer(rn);
        if (hadOld) {
          log(`La réplica ${i} falló: restaurando su versión anterior...`);
          await renameContainer(rPrev, rn);
          throw new Error(
            `La réplica ${i}/${replicas} falló (${err?.message || err}). Su versión anterior sigue en marcha; las réplicas ya actualizadas quedan con la versión nueva hasta el próximo despliegue.`,
          );
        }
        throw new Error(`La réplica ${i}/${replicas} no arrancó (${err?.message || err}).`);
      }
      if (hadOld) {
        await stopContainer(rPrev);
        await removeContainer(rPrev);
      }
      if (replicas > 1) log(`Réplica ${i}/${replicas} lista.`);
    }

    // Scale-down: retira réplicas con índice mayor al configurado.
    for (const c of await listServiceContainers(service.id)) {
      const match = c.name.match(/-r(\d+)$/);
      if (match && Number(match[1]) > replicas) {
        log(`Retirando réplica sobrante ${c.name}...`);
        await stopContainer(c.name);
        await removeContainer(c.name);
      }
    }
    log(oldExists ? 'Intercambio completado: corte cero.' : 'Servicio en marcha.');
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
async function recoverStaleSwap(serviceId: string, log: (l: string) => void): Promise<void> {
  let containers: { name: string }[] = [];
  try {
    containers = await listServiceContainers(serviceId);
  } catch {
    return;
  }
  for (const c of containers) {
    if (c.name.endsWith('--next')) {
      await removeContainer(c.name);
      continue;
    }
    if (c.name.endsWith('--prev')) {
      const base = c.name.slice(0, -'--prev'.length);
      if (await findContainer(base)) {
        await removeContainer(c.name);
      } else {
        log(`Recuperando intercambio interrumpido: restaurando ${base}...`);
        await renameContainer(c.name, base);
      }
    }
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
