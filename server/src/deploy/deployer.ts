import { spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import {
  createDeployment,
  deploymentForImage,
  deploymentSummary,
  getDeployment,
  getEnv,
  getProject,
  getService,
  lastSuccessfulImage,
  reusableBuild,
  setDeploymentDiagnosis,
  setEnv,
  successfulDeploymentsBeyond,
  updateDeployment,
  listDeployments,
  getSetting,
} from '../db';
import { fireAlert, resolveServiceAlerts } from '../alerts';
import { diagnose } from './diagnose';
import { emitDeploy, emitDeployFeed, toDeployFeedItem } from '../events';
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
  runArgsFor,
  startCommandSpec,
} from '../docker/containers';
import { ensureNetwork, projectNetworkName, EDGE_NETWORK } from '../docker/networks';
import { invalidateDockerSnapshot } from '../docker/sampler';
import { apiHeadSha, parseGithubSlug } from '../github/client';
import { resolveGitAuth } from '../github/resolve';
import { isWorkspaceActive, workspaceOfProject } from '../quota';
import { buildImage, cloneRepo, normalizeRepoUrl, spawnLogged } from './builder';
import { dockerRestartPolicy, hasRailwayConfig, RailwayRepoConfig, readRailwayRepoConfig } from './railwayconfig';
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
 * Anuncia el despliegue en el feed del proyecto. El canal por despliegue solo
 * llega a quien ya tiene ese despliegue abierto; esto avisa al panel entero
 * —rejilla de servicios y cabecera— en cuanto arranca uno, que es lo que hace
 * visible «hay una versión nueva saliendo» sin abrir nada.
 */
function publishFeed(deploymentId: string): void {
  const row = deploymentSummary(deploymentId);
  if (!row) return;
  const service = getService(row.service_id);
  if (!service) return;
  emitDeployFeed(toDeployFeedItem(row, service.project_id));
}

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
    publishFeed(deploymentId);
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
  opts: { imageTag?: string; forceBuild?: boolean } = {},
): DeploymentRow {
  const deployment = createDeployment(serviceId, trigger, opts.imageTag ?? null, { forceBuild: opts.forceBuild });
  // Se anuncia YA, en cola: el aviso de «versión nueva en camino» no puede
  // esperar a que haya un hueco de build libre.
  publishFeed(deployment.id);
  void enqueue(`deploy:${serviceId}`, () => runDeployment(deployment.id));
  return deployment;
}

/**
 * Espera a que un despliegue llegue a estado final. Lo usan las pilas de
 * aplicaciones, que necesitan encadenar servicios por etapas (la base primero,
 * lo que depende de ella después) sin acoplarse a la cola interna.
 */
export async function awaitDeployment(
  deploymentId: string,
  timeoutMs = 30 * 60_000,
): Promise<DeploymentRow | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = getDeployment(deploymentId);
    if (!row) return undefined;
    if (!['queued', 'building', 'deploying'].includes(row.status)) return row;
    if (Date.now() > deadline) return row;
    await sleep(1000);
  }
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
    publishFeed(deploymentId);
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
    let repoConfig: RailwayRepoConfig | null = null;
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
      // Volver a una versión anterior debe volver también a SU config-as-code:
      // si aquel commit declaraba otro comando de arranque, es el que toca.
      // La configuración vive en el despliegue que CONSTRUYÓ la imagen, no en
      // esta fila de rollback (que nunca clonó nada).
      const origin = deploymentForImage(service.id, image);
      repoConfig = parseRepoConfig(origin?.repo_config ?? null);
      if (origin?.commit_sha) {
        updateDeployment(deploymentId, { commit_sha: origin.commit_sha, commit_msg: origin.commit_msg });
      }
    } else {
      const built = await buildGitImage(project, service, deploymentId, job, log);
      image = built.image;
      repoConfig = built.repoConfig;
    }
    checkCanceled();
    updateDeployment(deploymentId, { image_tag: image });

    setStatus('deploying');
    await deployContainer(project, service, image, deploymentId, log, repoConfig, job);
    checkCanceled();

    // El intercambio acaba de cambiar los contenedores: se tira la foto
    // compartida para que el panel enseñe el estado nuevo en la lectura
    // siguiente, no el de la versión que acaba de irse.
    invalidateDockerSnapshot();
    setStatus('success');
    updateDeployment(deploymentId, { finished_at: now() });
    emitDeploy(deploymentId, { type: 'done', status: 'success' });
    publishFeed(deploymentId);
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
      publishFeed(deploymentId);
      return;
    }
    // Un despliegue fallido también deja contenedores tocados (el intento
    // nuevo retirado, el anterior restaurado): la foto vieja ya no vale.
    invalidateDockerSnapshot();
    const message = err?.message || String(err);
    log(`✖ Error: ${message}`);
    updateDeployment(deploymentId, { status: 'failed', error: message, finished_at: now() });

    const diag = diagnose(message, (log as any).buffer());
    if (diag) {
      setDeploymentDiagnosis(deploymentId, diag);
      log(`ℹ ${diag.title}: ${diag.cause}`);
    }
    emitDeploy(deploymentId, { type: 'done', status: 'failed', error: message });
    publishFeed(deploymentId);

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

/**
 * Huella de TODO lo que entra en la imagen aparte del código: si cambia, el
 * commit ya construido no vale y hay que recompilar. Sin esto, tocar el
 * rootDir o un build-arg dejaría al servicio sirviendo la imagen vieja.
 */
function buildKeyFor(service: ServiceRow, cfg: GitConfig): string {
  const args = Object.entries(cfg.buildArgs || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  // RAILWAY_DOCKERFILE_PATH y buildCmd también deciden qué imagen sale, aunque
  // vivan fuera del bloque de build: cambiarlos tiene que invalidar la caché.
  const dockerfile = getEnv(service.id).RAILWAY_DOCKERFILE_PATH || cfg.dockerfilePath || 'Dockerfile';
  return createHash('sha256')
    .update(
      JSON.stringify([
        normalizeRepoUrl(cfg.repoUrl),
        cfg.rootDir || '.',
        dockerfile,
        cfg.buildCmd || '',
        // Nixpacks hornea el comando de arranque en la imagen (NIXPACKS_START_CMD):
        // cambiarlo tiene que invalidar la caché o se reutiliza una imagen con el viejo.
        cfg.startCmd || '',
        args,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
}

async function buildGitImage(
  project: ProjectRow,
  service: ServiceRow,
  deploymentId: string,
  job: ActiveJob,
  log: (l: string) => void,
): Promise<{ image: string; repoConfig: RailwayRepoConfig | null }> {
  const cfg = service.config as GitConfig;
  const image = `skyway/${project.slug}-${service.slug}:${deploymentId.slice(-8)}`;
  const workDir = path.join(config.buildsDir, deploymentId);
  const token = await resolveCloneToken(project, cfg, log);
  const buildKey = buildKeyFor(service, cfg);
  const forceBuild = getDeployment(deploymentId)?.force_build === 1;
  const onSpawn = (p: any) => {
    job.procs.add(p);
    p.on('exit', () => job.procs.delete(p));
  };

  // Atajo: si la cabeza de la rama ya se construyó con ÉXITO y con las mismas
  // entradas, la imagen resultante sería idéntica bit a bit. Redesplegar tras
  // cambiar una variable —el caso más frecuente— pasa de clonar y compilar
  // entero a no hacer nada. Se consulta la cabeza por API (barato) antes de
  // pedir hueco de build, así que ni siquiera ocupa un slot de compilación.
  if (!forceBuild) {
    const reused = await reuseBuiltImage(service.id, cfg, token, buildKey, log);
    if (reused) {
      updateDeployment(deploymentId, {
        commit_sha: reused.commit_sha,
        commit_msg: reused.commit_msg,
        build_key: buildKey,
        repo_config: reused.repo_config,
      });
      return { image: reused.image_tag!, repoConfig: parseRepoConfig(reused.repo_config) };
    }
  }

  await acquireBuildSlot();
  try {
    if (job.canceled) throw new CanceledError();
    const info = await cloneRepo(
      { repoUrl: cfg.repoUrl, branch: cfg.branch || 'main', token, dest: workDir, onSpawn },
      log,
    );
    if (job.canceled) throw new CanceledError();
    const repoConfig = readRailwayRepoConfig(workDir, cfg.rootDir, log);
    if (hasRailwayConfig(repoConfig) && repoConfig.source) {
      log(`Configuración del repositorio leída de ${repoConfig.source} (config-as-code de Railway).`);
      warnBuilderChange(service.id, repoConfig, log);
    }
    updateDeployment(deploymentId, {
      commit_sha: info.commitSha,
      commit_msg: info.commitMsg,
      build_key: buildKey,
      repo_config: JSON.stringify(repoConfig),
    });

    await buildImage(
      {
        repoDir: workDir,
        rootDir: cfg.rootDir,
        // RAILWAY_DOCKERFILE_PATH y el dockerfilePath del fichero mandan sobre
        // el ajuste del panel, misma precedencia que en Railway.
        dockerfilePath: repoDockerfilePath(service, repoConfig) ?? cfg.dockerfilePath,
        imageTag: image,
        buildArgs: cfg.buildArgs,
        builder: repoConfig.builder,
        nixpacksEnv: nixpacksEnvFor(cfg, repoConfig),
        // Capas de la última imagen correcta como caché: si el daemon purgó su
        // caché de build (o la imagen se construyó antes de un reinicio), esto
        // evita rehacer install de dependencias y compilaciones ya hechas.
        cacheFrom: lastSuccessfulImage(service.id),
        onSpawn,
      },
      log,
    );
    if (job.canceled) throw new CanceledError();
    log(`Imagen construida: ${image}`);
    return { image, repoConfig };
  } finally {
    releaseBuildSlot();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Busca un despliegue anterior cuya imagen sirva tal cual para la cabeza actual
 * de la rama. Devuelve la fila reutilizable, o null si hay que compilar. Todo
 * el camino es best-effort: si no se puede saber la cabeza o la imagen ya no
 * está en el disco, se compila como siempre.
 */
async function reuseBuiltImage(
  serviceId: string,
  cfg: GitConfig,
  token: string | null,
  buildKey: string,
  log: (l: string) => void,
): Promise<DeploymentRow | null> {
  const slug = parseGithubSlug(cfg.repoUrl);
  if (!slug) return null; // sin API que preguntar, clonar es la única forma de saber la cabeza
  const head = await apiHeadSha(token ?? '', slug.owner, slug.repo, cfg.branch || 'main');
  if (!head) return null;
  const previous = reusableBuild(serviceId, head, buildKey);
  if (!previous?.image_tag) return null;
  if (!(await imageExists(previous.image_tag))) return null;
  log(
    `El commit ${head.slice(0, 7)} ya está construido con esta configuración: se reutiliza la imagen ${previous.image_tag} ` +
      '(sin clonar ni compilar). Usa «Reconstruir» si quieres forzar una compilación limpia.',
  );
  return previous;
}

/** Resuelve la credencial de clonado y deja constancia en el log del despliegue. */
async function resolveCloneToken(project: ProjectRow, cfg: GitConfig, log: (l: string) => void): Promise<string | null> {
  const auth = await resolveGitAuth(project, cfg);
  if (auth.warning) log(`⚠ ${auth.warning}`);
  if (auth.detail) log(auth.detail);
  return auth.token;
}

/** Config-as-code guardada en el despliegue (JSON), tolerante a basura. */
/**
 * Avisa si este despliegue va a construirse de otra forma que el último que
 * funcionó.
 *
 * Cambiar de constructor cambia el comando de arranque: el del Dockerfile no es
 * el que infiere Nixpacks. Un servicio que llevaba meses bien puede empezar a
 * fallar sin que nadie haya tocado el repo, solo porque Skyway pasó a respetar
 * el `builder` de railway.json. Sin decirlo, la única pista es una línea suelta
 * entre cien de log, y el usuario ve «falla algo que está funcionando».
 */
function warnBuilderChange(
  serviceId: string,
  repoConfig: RailwayRepoConfig,
  log: (l: string) => void,
): void {
  const ahora = (repoConfig.builder || '').toUpperCase();
  if (!ahora) return;
  const previo = listDeployments(serviceId, 25).find((d) => d.status === 'success');
  if (!previo) return;
  const antes = (parseRepoConfig(previo.repo_config)?.builder || '').toUpperCase();
  if (antes === ahora) return;
  log(
    antes
      ? `⚠ El último despliegue correcto se construyó con ${antes} y este usa ${ahora}: el comando de arranque puede no ser el mismo.`
      : `⚠ El último despliegue correcto es anterior a que Skyway leyera ${repoConfig.source}, así que se construyó ` +
        `con el Dockerfile del repo. Este usa ${ahora}, que infiere su propio comando de arranque: si la app no arranca, ` +
        `es lo primero que hay que mirar.`,
  );
}

function parseRepoConfig(raw: string | null): RailwayRepoConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as RailwayRepoConfig) : null;
  } catch {
    return null;
  }
}

/**
 * Dockerfile alternativo: Railway lo admite en el fichero de configuración y
 * también con la variable `RAILWAY_DOCKERFILE_PATH` del servicio, que es como
 * lo tiene mucha gente. Se respetan las dos, con la variable por delante.
 */
function repoDockerfilePath(service: ServiceRow, repoConfig: RailwayRepoConfig): string | null {
  const fromEnv = getEnv(service.id).RAILWAY_DOCKERFILE_PATH;
  return (fromEnv && fromEnv.trim()) || repoConfig.dockerfilePath || null;
}

/**
 * Traducción del `buildCommand` de Railway a Nixpacks, que es el constructor
 * equivalente. Sin esto, un proyecto migrado que compilaba con un comando
 * propio se desplegaba sin compilar y fallaba al arrancar.
 */
function nixpacksEnvFor(cfg: GitConfig, repoConfig: RailwayRepoConfig): Record<string, string> {
  const env: Record<string, string> = {};
  // El fichero del repo manda sobre el ajuste del panel, como en Railway.
  const buildCmd = repoConfig.buildCommand ?? cfg.buildCmd;
  if (buildCmd) env.NIXPACKS_BUILD_CMD = buildCmd;
  const startCmd = repoConfig.startCommand ?? cfg.startCmd;
  if (startCmd) env.NIXPACKS_START_CMD = startCmd;
  return env;
}

/**
 * Variables mágicas de Railway en tiempo de ejecución.
 *
 * Una aplicación migrada que lea `RAILWAY_PUBLIC_DOMAIN` para construir sus
 * URLs, o `RAILWAY_GIT_COMMIT_SHA` para sellar una versión, seguiría leyendo
 * `undefined` después de migrar y fallaría de formas difíciles de atribuir.
 * Se rellenan con el equivalente de Skyway y NUNCA se pisa un valor que el
 * usuario haya definido a mano.
 */
function applyRailwayCompatEnv(
  env: Record<string, string>,
  project: ProjectRow,
  service: ServiceRow,
  deploymentId: string,
  domains: string[],
  internalPort: number | null,
  volumes: { name: string; containerPath: string }[] = [],
): void {
  const deployment = deploymentSummary(deploymentId);
  const put = (key: string, value: string | null | undefined) => {
    if (value && env[key] === undefined) env[key] = value;
  };
  put('RAILWAY_PROJECT_NAME', project.name);
  put('RAILWAY_PROJECT_ID', project.id);
  put('RAILWAY_SERVICE_NAME', service.name);
  put('RAILWAY_SERVICE_ID', service.id);
  put('RAILWAY_ENVIRONMENT', 'production');
  put('RAILWAY_ENVIRONMENT_NAME', 'production');
  put('RAILWAY_DEPLOYMENT_ID', deploymentId);
  put('RAILWAY_REPLICA_ID', deploymentId);
  // El «dominio privado» de Railway es el nombre por el que un servicio llega a
  // otro dentro del proyecto: aquí, su alias en la red del proyecto.
  put('RAILWAY_PRIVATE_DOMAIN', service.slug);
  if (internalPort) put('RAILWAY_TCP_PROXY_PORT', String(internalPort));
  if (domains[0]) {
    put('RAILWAY_PUBLIC_DOMAIN', domains[0]);
    // El esquema lo decide quien enruta: sin correo de Let's Encrypt, Traefik
    // no monta el router seguro y prometer https lleva a un 404 con un
    // certificado que no es el del dominio.
    put('RAILWAY_STATIC_URL', `${getSetting('letsencryptEmail') ? 'https' : 'http'}://${domains[0]}`);
  }
  // La forma que documenta Railway para encontrar el disco persistente; sus
  // plantillas oficiales la usan tal cual.
  if (volumes[0]) {
    put('RAILWAY_VOLUME_NAME', volumes[0].name);
    put('RAILWAY_VOLUME_MOUNT_PATH', volumes[0].containerPath);
  }
  if (deployment?.commit_sha) {
    put('RAILWAY_GIT_COMMIT_SHA', deployment.commit_sha);
    put('RAILWAY_GIT_COMMIT_MESSAGE', deployment.commit_msg ?? '');
  }
  if (service.type === 'git') put('RAILWAY_GIT_BRANCH', (service.config as GitConfig).branch || 'main');
}

/**
 * `preDeployCommand` de Railway: se ejecuta con la imagen y las variables del
 * despliegue nuevo, contra la red del proyecto, ANTES de tocar la versión que
 * está sirviendo. Ahí es donde vive el `migrate` de casi todo el mundo, y por
 * eso un fallo aborta el despliegue en vez de arrancar contra un esquema viejo.
 *
 * El comando viaja en una variable de entorno y se ejecuta con `eval`: nunca se
 * interpola en la línea de órdenes del shell.
 */
async function runPreDeploy(
  project: ProjectRow,
  image: string,
  env: Record<string, string>,
  command: string,
  log: (l: string) => void,
  job?: ActiveJob,
): Promise<void> {
  log(`Ejecutando el comando previo al despliegue: ${command}`);
  const args = ['run', '--rm', '--network', projectNetworkName(project)];
  for (const key of Object.keys(env)) args.push('--env', key);
  args.push('--env', 'SKYWAY_PREDEPLOY_CMD');
  // Cómo se le entrega la orden depende del ENTRYPOINT de la imagen, igual que
  // el comando de arranque: con el de Nixpacks, un `sh -c` acababa arrancando
  // un shell vacío que salía con 0 —y esto se habría dado por ejecutado—.
  args.push(...(await runArgsFor(image, 'eval "$SKYWAY_PREDEPLOY_CMD"')));
  const onSpawn = job
    ? (p: any) => {
        job.procs.add(p);
        p.on('exit', () => job.procs.delete(p));
      }
    : undefined;
  try {
    await spawnLogged('docker', args, { env: { ...env, SKYWAY_PREDEPLOY_CMD: command }, onSpawn }, log);
  } catch (err: any) {
    throw new Error(
      `El comando previo al despliegue falló (${err?.message || err}). No se ha tocado la versión en marcha.`,
    );
  }
  log('Comando previo completado.');
}

async function deployContainer(
  project: ProjectRow,
  service: ServiceRow,
  image: string,
  deploymentId: string,
  log: (l: string) => void,
  repoConfig: RailwayRepoConfig | null = null,
  job?: ActiveJob,
): Promise<void> {
  const netName = projectNetworkName(project);
  await ensureNetwork(netName);
  await ensureNetwork(EDGE_NETWORK);

  if (service.type === 'database') ensureDatabaseEnv(service, log);
  const env = resolveServiceEnv(service);
  // Una referencia que no resuelve se queda como texto literal dentro del
  // contenedor, y la aplicación arranca con ella sin quejarse: una cadena de
  // conexión inválida, o —peor— un secreto que pasa a ser una constante pública.
  // No se aborta el despliegue (romperlo por una variable de adorno sería peor),
  // pero tiene que verse.
  const sinResolver = Object.entries(env)
    .filter(([, value]) => /\$\{\{[^}]+\}\}/.test(value))
    .map(([key]) => key);
  if (sinResolver.length > 0) {
    log(
      `⚠ Referencias sin resolver en ${sinResolver.join(', ')}: la variable apuntada ya no existe. ` +
        'El contenedor arrancará con el texto literal ${{...}} como valor.',
    );
  }
  let internalPort: number | null = null;
  let domains: string[] = [];
  let cmd: string[] | null = null;
  let entrypoint: string[] | null = null;
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
    if (cfg.startCmd) {
      const spec = await startCommandSpec(image, cfg.startCmd);
      cmd = spec.cmd;
      entrypoint = spec.entrypoint ?? null;
      if (spec.replacedEntrypoint) {
        log(`ℹ La imagen trae ENTRYPOINT «${spec.replacedEntrypoint.join(' ')}»; se aparta para ejecutar el comando de arranque.`);
      }
    }
    if (internalPort && !env.PORT) env.PORT = String(internalPort);
  } else {
    const cfg = service.config as GitConfig;
    internalPort = cfg.port || 3000;
    domains = cfg.domains || [];
    hostPort = cfg.hostPort ?? null;
    cpus = cfg.cpus ?? null;
    memoryMb = cfg.memoryMb ?? null;
    volumes = cfg.volumes || [];
    // Config-as-code de Railway: el startCommand del repo manda sobre el del
    // servicio (misma precedencia que Railway; el importador copia el del panel
    // y puede contradecir al del repo).
    const repoStartCmd = repoConfig?.startCommand ?? null;
    const startCmd = repoStartCmd ?? cfg.startCmd;
    if (repoStartCmd && cfg.startCmd && repoStartCmd !== cfg.startCmd) {
      log(`startCommand de ${repoConfig?.source ?? 'la configuración del repo'} («${repoStartCmd}») tiene prioridad sobre el del servicio, como en Railway.`);
    }
    if (startCmd) {
      // Cómo se entrega depende del ENTRYPOINT de la imagen: ver startCommandSpec.
      const spec = await startCommandSpec(image, startCmd);
      cmd = spec.cmd;
      entrypoint = spec.entrypoint ?? null;
      if (spec.replacedEntrypoint) {
        log(`ℹ La imagen trae ENTRYPOINT «${spec.replacedEntrypoint.join(' ')}»; se aparta para ejecutar el comando de arranque.`);
      }
    }
    if (!env.PORT) env.PORT = String(internalPort);
  }

  env.SKYWAY_PROJECT = project.slug;
  env.SKYWAY_SERVICE = service.slug;
  env.SKYWAY_DEPLOYMENT = deploymentId;
  applyRailwayCompatEnv(env, project, service, deploymentId, domains, internalPort, volumes);

  // Política de reinicio declarada en el repo (restartPolicyType de Railway).
  // Sin ella, la de siempre: unless-stopped.
  const restartPolicy = dockerRestartPolicy(
    repoConfig?.restartPolicyType ?? null,
    repoConfig?.restartPolicyMaxRetries ?? null,
  );
  if (restartPolicy) {
    log(`Política de reinicio del repositorio: ${repoConfig!.restartPolicyType} → docker «${restartPolicy.Name}».`);
  }

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
    ...(entrypoint ? { entrypoint } : {}),
    volumes,
    ...(restartPolicy ? { restartPolicy } : {}),
  };

  const name = containerName(project, service);
  const tempName = `${name}--next`;
  const prevName = `${name}--prev`;
  // El healthcheck del repositorio manda sobre el del panel, igual que el
  // comando de arranque: es config-as-code y viaja con el commit.
  const healthcheckPath: string | null =
    repoConfig?.healthcheckPath ?? (service.type !== 'database' ? (service.config as any).healthcheckPath || null : null);
  const envTimeout = Number(getEnv(service.id).RAILWAY_HEALTHCHECK_TIMEOUT_SEC);
  const declaredTimeout = repoConfig?.healthcheckTimeout ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : null);
  const probeTimeoutMs = declaredTimeout ? Math.min(Math.max(declaredTimeout, 5), 900) * 1000 : PROBE_TIMEOUT_MS;

  // Comando previo al despliegue (donde casi todo el mundo pone las
  // migraciones). Va ANTES de tocar la versión en marcha: si falla, el
  // despliegue se aborta y lo que está sirviendo sigue igual, como en Railway.
  if (repoConfig?.preDeployCommand) {
    await runPreDeploy(project, image, env, repoConfig.preDeployCommand, log, job);
  }

  await recoverStaleSwap(service.id, log);

  // El repo puede pedir réplicas, pero eso consume cuota del workspace y se
  // gestiona en el panel: se avisa en vez de aplicarlo a espaldas de nadie.
  if (repoConfig?.numReplicas && repoConfig.numReplicas !== configuredReplicas(service)) {
    log(
      `ℹ La configuración del repositorio pide ${repoConfig.numReplicas} réplicas; en Skyway las réplicas se fijan en Ajustes del servicio (consumen cuota del workspace). Se mantienen ${configuredReplicas(service)}.`,
    );
  }
  if (repoConfig?.watchPatterns.length) {
    log(
      `ℹ La configuración del repositorio declara «watchPatterns» (${repoConfig.watchPatterns.join(', ')}); Skyway aún no filtra ` +
        'por ruta: cualquier push a la rama dispara el despliegue automático.',
    );
  }
  if (repoConfig?.cronSchedule) {
    log(`ℹ La configuración del repositorio declara un cron («${repoConfig.cronSchedule}»); Skyway aún no ejecuta servicios programados.`);
  }

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
      const verdict = await validateContainer(netName, `${service.slug}-next`, internalPort, healthcheckPath, tempName, log, probeTimeoutMs);
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
        // Ventana corta de asentamiento: con oldExists la versión ya pasó la
        // validación completa en `--next`, así que aquí solo se comprueba que
        // esta copia concreta no se cae nada más nacer.
        const runtime = await settleContainer(rn, SETTLE_MS);
        if (runtime.state !== 'running') {
          throw new Error(`estado ${runtime.state}, código ${runtime.exitCode ?? 'n/a'}`);
        }
        if (!oldExists && i === 1) {
          const verdict = await validateContainer(netName, service.slug, internalPort, healthcheckPath, rn, log, probeTimeoutMs);
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
      const verdict = await validateContainer(netName, service.slug, internalPort, healthcheckPath, name, log, probeTimeoutMs);
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

/**
 * Margen para que el healthcheck responda. 300 s es el de Railway: un repo
 * migrado que allí pasaba con el margen por defecto tenía aquí una quinta parte.
 * Se puede subir con `healthcheckTimeout` en railway.json o con la variable
 * `RAILWAY_HEALTHCHECK_TIMEOUT_SEC`, que es lo que documenta Railway.
 */
const PROBE_TIMEOUT_MS = 300_000;
// Sondeo ágil: cada intento cuesta un `docker run busybox` (~0,3 s), así que
// bajar el intervalo apenas añade carga y recorta segundos de la ventana entre
// «el proceso ya responde» y «Skyway se entera».
const PROBE_INTERVAL_MS = 1200;
const GRACE_MS = 5000;
/** Cada cuánto se mira si el contenedor murió durante el periodo de gracia. */
const GRACE_CHECK_MS = 500;
/** Ventana de asentamiento de cada réplica en la actualización rodante. */
const SETTLE_MS = 1500;

/**
 * Observa el contenedor durante `ms` y devuelve su estado. Corta en cuanto deja
 * de estar en marcha: un arranque fallido no tiene por qué agotar la ventana.
 */
async function settleContainer(name: string, ms: number): Promise<Awaited<ReturnType<typeof getRuntime>>> {
  const until = Date.now() + ms;
  let runtime = await getRuntime(name);
  while (Date.now() < until) {
    await sleep(GRACE_CHECK_MS);
    runtime = await getRuntime(name);
    if (runtime.state !== 'running') return runtime;
  }
  return runtime;
}

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
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; reason: string }> {
  if (healthcheckPath && port) {
    const path = healthcheckPath.startsWith('/') ? healthcheckPath : `/${healthcheckPath}`;
    log(`Esperando healthcheck 2xx en http://${aliasHost}:${port}${path} (hasta ${Math.round(timeoutMs / 1000)}s)...`);
    if (!(await imageExists('busybox:stable'))) {
      await spawnLogged('docker', ['pull', 'busybox:stable'], {}, log);
    }
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    // Sin espera previa: hay procesos que ya responden al instante y esperar
    // un segundo «por si acaso» se lo cobraba a TODOS los despliegues.
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
    return { ok: false, reason: `el healthcheck ${path} no respondió 2xx en ${Math.round(timeoutMs / 1000)}s` };
  }

  // Sin healthcheck no hay forma de saber que la versión nueva está bien: solo
  // se puede comprobar que no se muere enseguida. Se vigila cada poco en vez de
  // dormir el periodo entero, para que un arranque fallido corte YA y el
  // usuario vea el error (y la versión anterior vuelva) sin esperar en balde.
  log(`Sin healthcheck configurado: periodo de gracia de ${GRACE_MS / 1000}s...`);
  const graceUntil = Date.now() + GRACE_MS;
  while (Date.now() < graceUntil) {
    await sleep(GRACE_CHECK_MS);
    const runtime = await getRuntime(containerRef);
    if (runtime.state !== 'running') {
      return { ok: false, reason: `el proceso terminó enseguida (estado ${runtime.state}, código ${runtime.exitCode ?? 'n/a'})` };
    }
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
/**
 * Deshace el multiplexado de Docker.
 *
 * El flujo viene en tramas de 8 bytes de cabecera —tipo, tres ceros y el tamaño
 * en 4 bytes— seguidas de su carga, y una sola trama puede traer varias líneas.
 * Cortar 8 caracteres a CADA línea, como se hacía antes, se comía los primeros
 * caracteres de todas menos la primera; y con el contenedor en modo TTY no hay
 * cabecera ninguna, así que se cargaba el principio de todas. Si el primer byte
 * no parece una cabecera, se devuelve tal cual: es texto plano.
 */
function demuxDockerLog(buf: Buffer): string {
  const parts: string[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    if (buf[i] > 2 || buf[i + 1] !== 0 || buf[i + 2] !== 0 || buf[i + 3] !== 0) {
      return buf.toString('utf8');
    }
    const size = buf.readUInt32BE(i + 4);
    parts.push(buf.toString('utf8', i + 8, i + 8 + size));
    i += 8 + size;
  }
  return parts.length > 0 ? parts.join('') : buf.toString('utf8');
}

async function appendContainerTail(name: string, log: (l: string) => void): Promise<void> {
  try {
    const info = await findContainer(name);
    if (!info) return;
    const container = docker.getContainer(name);
    const buf = (await container.logs({ stdout: true, stderr: true, tail: 20, follow: false })) as unknown as Buffer;
    const text = demuxDockerLog(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)))
      .split('\n')
      .filter((l) => l.trim())
      .slice(-20);
    if (text.length > 0) {
      log('— Últimas líneas del contenedor fallido —');
      for (const line of text) log(`  ${line}`);
      return;
    }
    // El silencio también es un dato, y de los buenos: si la app no llegó ni a
    // escribir una línea, el fallo está antes de su código —el comando de
    // arranque, el intérprete, un fichero que no existe—, no dentro de ella.
    log('— El contenedor no escribió nada antes de salir —');
  } catch (err: any) {
    log(`— No se pudieron leer los logs del contenedor fallido (${err?.message || err}) —`);
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
