import { ChildProcess, spawn } from 'child_process';
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
  updateService,
  setDeploymentDiagnosis,
  setEnv,
  successfulDeploymentsBeyond,
  updateDeployment,
  saveDeploymentRuntimeLogs,
  listDeployments,
  getSetting,
} from '../db';
import { fireAlert, resolveAllServiceAlerts, resolveServiceAlerts } from '../alerts';
import { diagnose } from './diagnose';
import { emitDeploy, emitDeployFeed, toDeployFeedItem } from '../events';
import { docker, dockerAvailable } from '../docker/client';
import {
  assertImageRef,
  configuredReplicas,
  containerName,
  demuxLogBuffer,
  execInContainer,
  fetchLogsText,
  findContainer,
  imageExists,
  imageExposedPorts,
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
import { buildImage, cloneRepo, isBuildTimeVar, normalizeRepoUrl, spawnLogged } from './builder';
import { importRepoEnv } from './envimport';
import { partitionPreDeployEnv } from './predeployenv';
import { dockerRestartPolicy, hasRailwayConfig, RailwayRepoConfig, readRailwayRepoConfig } from './railwayconfig';
import { acquireBuildSlot, enqueue, releaseBuildSlot } from './queue';
import { effectiveDbVersion, getTemplate, volumePathFor } from '../templates';
import { adviseEnv, detectNeeds } from '../needs';
import { availableReferences, resolveServiceEnv, systemVars } from '../variables';
import { DatabaseConfig, DeploymentRow, GitConfig, ImageConfig, ProjectRow, ServiceRow } from '../types';
import { now } from '../util';

const MAX_LOG_CHARS = 400_000;
/** Tope del log de ejecución que se archiva por despliegue (se guarda el final). */
const MAX_RUNTIME_LOG_CHARS = 256 * 1024;
/** Tope de un `docker pull`: un registro que no contesta no puede colgar el despliegue. */
const PULL_TIMEOUT_MS = 15 * 60_000;
/** Tope de `captureCommand` (inspecciones cortas con un contenedor efímero). */
const CAPTURE_TIMEOUT_MS = 60_000;
/**
 * Tope del comando previo al despliegue: una migración colgada (un bloqueo en
 * la base de datos, una red que no contesta) dejaba el despliegue en
 * «deploying» para siempre, con la plaza de build ocupada.
 */
const PRE_DEPLOY_TIMEOUT_MS = 30 * 60_000;
/** Cada cuánto se vuelca el log del despliegue a la BD (o antes, si crece mucho). */
const LOG_FLUSH_MS = 3000;
const LOG_FLUSH_BYTES = 8 * 1024;
/** Distancia mínima entre dos volcados adelantados por tamaño. */
const LOG_FLUSH_MIN_GAP_MS = 1000;

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
  /** Motivo si no lo canceló el usuario (apagado del servidor). */
  cancelReason?: string;
  procs: Set<ChildProcess>;
  /** Esperas sin proceso que matar (la cola de build): se cortan por aquí. */
  onCancel: Set<() => void>;
}

const activeJobs = new Map<string, ActiveJob>();
/**
 * Apagando: la cola no arranca más despliegues. Los que sigan en «queued» los
 * marca como fallidos el siguiente arranque (markStaleDeploymentsFailed).
 */
let shuttingDown = false;

/** Registra un proceso hijo en el trabajo para poder matarlo al cancelar. */
function trackProc(job: ActiveJob): (p: ChildProcess) => void {
  return (p) => {
    job.procs.add(p);
    p.on('exit', () => job.procs.delete(p));
  };
}

/** SIGTERM y, si a los 3 s sigue vivo, SIGKILL. */
function killProc(proc: ChildProcess): void {
  try {
    proc.kill('SIGTERM');
    const killer = setTimeout(() => {
      try {
        // `killed` solo dice que se ENVIÓ una señal (el SIGTERM de arriba), no
        // que el proceso haya muerto: mirándolo, el SIGKILL no llegaba nunca.
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      } catch {
        /* ya terminado */
      }
    }, 3000);
    // Ni mantiene vivo el proceso al apagar ni queda pendiente si el hijo ya salió.
    killer.unref();
    proc.once('exit', () => clearTimeout(killer));
  } catch {
    /* ya terminado */
  }
}

function abortJob(job: ActiveJob, reason?: string): void {
  job.canceled = true;
  if (reason) job.cancelReason = reason;
  for (const proc of job.procs) killProc(proc);
  for (const hook of job.onCancel) {
    try {
      hook();
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Apagado del servidor: corta los despliegues en marcha (sus procesos hijos
 * quedarían huérfanos y la fila en «building» para siempre) y espera un poco a
 * que cierren para que puedan dejar su estado escrito antes de cerrar la BD.
 */
export async function abortActiveDeployments(graceMs = 3000): Promise<number> {
  shuttingDown = true;
  const count = activeJobs.size;
  for (const job of activeJobs.values()) abortJob(job, 'Interrumpido por el apagado del servidor');
  const deadline = Date.now() + graceMs;
  while (activeJobs.size > 0 && Date.now() < deadline) await sleep(100);
  return count;
}

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
    abortJob(job);
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

type DeployLogger = DeployContext['log'] & { buffer: () => string; flush: () => void; stop: () => void };

function makeLogger(deploymentId: string): DeployLogger {
  let buffer = '';
  let dirty = false;
  /** Longitud del búfer en la última escritura, para volcar antes si crece deprisa. */
  let written = 0;
  /** Instante del último volcado, para espaciar los adelantos por tamaño. */
  let lastFlushAt = 0;
  // Cada volcado REESCRIBE la columna entera (hasta 400 KB): hacerlo cada
  // segundo durante un build parlanchín era una escritura grande por segundo
  // en SQLite. Cada 3 s basta para seguirlo en vivo (el SSE ya lleva las
  // líneas al instante), y si el búfer crece ≥ 8 KB se adelanta, pero como
  // mucho una vez por segundo: sin ese freno, un build que suelta 400 KB
  // reescribía ~50 veces un búfer de hasta 200 KB. El volcado del temporizador
  // y el final (`stop`) no esperan a nada.
  const flush = () => {
    if (!dirty) return;
    updateDeployment(deploymentId, { logs: buffer });
    dirty = false;
    written = buffer.length;
    lastFlushAt = Date.now();
  };
  const interval = setInterval(flush, LOG_FLUSH_MS);
  interval.unref();

  const log = ((line: string) => {
    // Sello ISO completo (YYYY-MM-DDTHH:mm:ss.sssZ) para que el visor pueda pintar
    // la fecha, la hora exacta y calcular tiempos relativos precisos como en Railway.
    const iso = new Date().toISOString();
    // Solo se respeta un sello ISO de verdad: «2000 tests passed» empieza por
    // «20» y lleva una T, y salía sin hora mientras sus vecinas sí la tenían.
    const stamped = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(line) ? line : `${iso} ${line}`;
    if (buffer.length < MAX_LOG_CHARS) {
      buffer += stamped + '\n';
      dirty = true;
      if (buffer.length - written >= LOG_FLUSH_BYTES && Date.now() - lastFlushAt >= LOG_FLUSH_MIN_GAP_MS) flush();
    }
    emitDeploy(deploymentId, { type: 'log', line: stamped });
  }) as DeployLogger;
  log.buffer = () => buffer;
  log.flush = flush;
  log.stop = () => {
    clearInterval(interval);
    flush();
  };
  return log;
}

/** Archiva los logs de ejecución del contenedor antes de destruirlo, para el histórico por despliegue. */
export async function archiveContainerLogs(cName: string, fallbackDeploymentId?: string): Promise<void> {
  try {
    const info = await findContainer(cName);
    let targetDepId = info?.Config?.Labels?.['skyway.deployment'];
    if (!targetDepId && fallbackDeploymentId) {
      targetDepId = fallbackDeploymentId;
    }
    if (targetDepId) {
      const text = await fetchLogsText(cName, 3000, true);
      if (text && text.trim()) {
        saveDeploymentRuntimeLogs(targetDepId, tailChars(text, MAX_RUNTIME_LOG_CHARS));
      }
    }
  } catch {
    /* noop best-effort */
  }
}

/** Últimos `max` caracteres de un texto, cortando en un salto de línea. */
function tailChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.length - max;
  const nl = text.indexOf('\n', cut);
  return `[… recortado …]\n${text.slice(nl >= 0 ? nl + 1 : cut)}`;
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
  if (shuttingDown) return;
  const deployment = getDeployment(deploymentId);
  if (!deployment || deployment.status !== 'queued') return;
  const service = getService(deployment.service_id);
  const project = service ? getProject(service.project_id) : undefined;
  const log = makeLogger(deploymentId);
  const job: ActiveJob = { canceled: false, procs: new Set(), onCancel: new Set() };
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
      throw new Error('Docker no está disponible. Compruebe que el daemon está en ejecución y que Skyway tiene acceso a /var/run/docker.sock');
    }

    log(`Despliegue de "${service.name}" en el proyecto "${project.name}" (${deployment.trigger})`);
    setStatus('building');

    let image: string;
    let repoConfig: RailwayRepoConfig | null = null;
    if (service.type === 'database') {
      image = await prepareDatabaseImage(service, log, job);
    } else if (service.type === 'image') {
      image = await preparePlainImage(service, log, job);
    } else if (deployment.image_tag) {
      image = deployment.image_tag;
      log(`Rollback a la imagen ${image}`);
      if (!(await imageExists(image))) {
        throw new Error(`La imagen ${image} ya no existe en el servidor (se purgó). Realice un despliegue normal.`);
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

    // El intercambio acaba de cambiar los contenedores de ESTE servicio: se
    // renueva su entrada en la foto compartida para que el panel enseñe el
    // estado nuevo en la lectura siguiente, no el de la versión que se fue.
    invalidateDockerSnapshot(service.id);

    // La purga va ANTES del estado final: escribe en este log, y todo lo que
    // se escriba después del volcado final lo pisaría quien añada líneas al
    // despliegue ya terminado (las pilas, con sus esperas y su SQL).
    if (service.type === 'git' && !deployment.image_tag) {
      await cleanupOldImages(project, service, log);
    }
    // La última línea va ANTES del «done»: la ruta SSE cierra el canal 100 ms
    // después de ese evento y el «✔» llegaba tarde, o no llegaba.
    log('✔ Despliegue completado');
    // Volcado completo ANTES del estado final: quien espere a ese estado lee
    // el log entero y ninguna escritura tardía del logger pisa lo suyo.
    log.flush();
    setStatus('success');
    updateDeployment(deploymentId, { finished_at: now() });
    emitDeploy(deploymentId, { type: 'done', status: 'success' });
    publishFeed(deploymentId);

    // Un despliegue correcto resuelve todas las alertas abiertas previas del servicio (caídas, fallos de deploy, memoria, etc.).
    resolveAllServiceAlerts(service.id, false);
  } catch (err: any) {
    if (err instanceof CanceledError || job.canceled) {
      const reason = job.cancelReason ?? 'Cancelado por el usuario';
      log(`✖ ${reason}`);
      log.flush();
      updateDeployment(deploymentId, { status: 'canceled', error: reason, finished_at: now() });
      emitDeploy(deploymentId, { type: 'done', status: 'canceled', error: null });
      publishFeed(deploymentId);
      return;
    }
    // Un despliegue fallido también deja contenedores tocados (el intento
    // nuevo retirado, el anterior restaurado): la foto vieja ya no vale.
    if (service) invalidateDockerSnapshot(service.id);
    const message = err?.message || String(err);
    log(`✖ Error: ${message}`);

    const diag = diagnose(message, log.buffer());
    if (diag) {
      setDeploymentDiagnosis(deploymentId, diag);
      log(`ℹ ${diag.title}: ${diag.cause}`);
    }
    // Mismo orden que en el éxito: primero el log completo, después el estado.
    log.flush();
    updateDeployment(deploymentId, { status: 'failed', error: message, finished_at: now() });
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
    // Único punto de parada del logger: cubre éxito, fallo y cancelación.
    log.stop();
  }
}

/**
 * Descarga una imagen si no está. La referencia se valida antes de ponerla en
 * la línea de órdenes y va detrás de «--»: un nombre que empezara por «-» se
 * tomaría por una opción de la CLI.
 */
async function pullImage(
  image: string,
  log: (l: string) => void,
  job?: ActiveJob,
  opts: { quietIfPresent?: boolean } = {},
): Promise<void> {
  assertImageRef(image);
  if (await imageExists(image)) {
    // La imagen auxiliar (busybox) no es noticia: solo se anuncia la del servicio.
    if (!opts.quietIfPresent) log(`Imagen ${image} ya disponible`);
    return;
  }
  log(`Descargando imagen ${image}...`);
  await spawnLogged(
    'docker',
    ['pull', '--', image],
    { timeoutMs: PULL_TIMEOUT_MS, onSpawn: job ? trackProc(job) : undefined },
    log,
  );
}

async function preparePlainImage(service: ServiceRow, log: (l: string) => void, job?: ActiveJob): Promise<string> {
  const cfg = service.config as ImageConfig;
  if (!cfg.image) throw new Error('El servicio no tiene imagen configurada');
  await pullImage(cfg.image, log, job);
  return cfg.image;
}

async function prepareDatabaseImage(service: ServiceRow, log: (l: string) => void, job?: ActiveJob): Promise<string> {
  const cfg = service.config as DatabaseConfig;
  const template = getTemplate(cfg.template);
  if (!template) throw new Error(`Plantilla desconocida: ${cfg.template}`);
  const image = `${template.image}:${effectiveDbVersion(template, cfg.version)}`;
  await pullImage(image, log, job);
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

/**
 * Ejecuta un comando y captura su salida (a diferencia de spawnLogged, que la
 * loguea). Con tope: es para inspecciones cortas, y sin él un `docker run`
 * que no arranca dejaba el despliegue colgado. El hijo se registra en el
 * trabajo para que Cancelar también lo alcance.
 */
function captureCommand(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; onSpawn?: (p: ChildProcess) => void } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    opts.onSpawn?.(p);
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProc(p);
    }, timeoutMs);
    timer.unref();
    p.stdout.on('data', (c) => (out += c.toString()));
    p.stderr.on('data', (c) => (err += c.toString()));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${cmd} superó el tiempo máximo (${Math.round(timeoutMs / 1000)} s)`));
      else if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `código de salida ${code}`));
    });
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
  job?: ActiveJob,
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
    await pullImage(PROBE_IMAGE, log, job, { quietIfPresent: true });
    report = await captureCommand(
      'docker',
      [
        'run', '--rm', '-v', `${volume}:/v:ro`, '--', PROBE_IMAGE, 'sh', '-c',
        'for f in /v/PG_VERSION /v/data/PG_VERSION /v/*/docker/PG_VERSION; do [ -s "$f" ] && echo "$f=$(cat "$f")"; done; true',
      ],
      { onSpawn: job ? trackProc(job) : undefined },
    );
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
    'Para cambiar de versión mayor: cree una copia de seguridad con la versión actual de los datos, cambie la versión en Ajustes, elimine el servicio marcando «borrar también el volumen», vuelva a crearlo y restaure la copia. Para empezar de cero es suficiente con eliminar el servicio con su volumen.';

  if (rootMajor !== null) {
    if (target >= 18) {
      throw new Error(
        `El volumen ${volume} contiene los datos de PostgreSQL ${rootMajor} con el formato antiguo (anterior a 18) y la imagen solicitada es ${version}: Postgres 18+ no puede abrirlos directamente. Mantenga la versión «${rootMajor}-alpine» en Ajustes para seguir funcionando, o migre los datos. ${migra}`,
      );
    }
    if (rootMajor !== target) {
      throw new Error(
        `El volumen ${volume} contiene los datos de PostgreSQL ${rootMajor} y la imagen solicitada es ${version}: una versión mayor no puede abrir los datos de otra. Vuelva a la versión «${rootMajor}-alpine» o migre los datos. ${migra}`,
      );
    }
    return; // datos y versión coinciden (layout <18): arranque normal
  }

  if (nestedMajor !== null) {
    throw new Error(
      `El volumen ${volume} contiene los datos de PostgreSQL ${nestedMajor} en el subdirectorio data/ (los escribió un Postgres <18 montado en la ruta de 18+, un estado que esta versión de Skyway ya no produce). Con el servicio detenido, muévalos a la raíz del volumen: docker run --rm -v ${volume}:/v busybox sh -c 'mv /v/data/* /v/ && rmdir /v/data' y utilice la versión «${nestedMajor}-alpine»; o elimine el servicio con su volumen para empezar de cero.`,
    );
  }

  // Solo layout 18+ (N/docker): la propia imagen abre el mayor que coincida.
  if (target < 18 || !newLayoutMajors.includes(target)) {
    const found = [...new Set(newLayoutMajors)].join(', ');
    throw new Error(
      `El volumen ${volume} ya está inicializado con el formato de Postgres 18+ (datos de la versión ${found}) y la imagen solicitada es ${version}. Utilice la versión «${found}-alpine» (o superior con pg_upgrade manual), o migre los datos. ${migra}`,
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
  // Solo las variables que LLEGAN al build (ver isBuildTimeVar): cambiarlas
  // cambia la imagen y hay que recompilar, o se serviría el bundle construido
  // con el valor viejo. Las de ejecución no entran, para no recompilar cada vez
  // que se rota un token que el build nunca vio.
  const vars = Object.entries(resolveServiceEnv(service))
    .filter(([k]) => isBuildTimeVar(k))
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
        // Cambiar de constructor cambia la imagen entera: sin esto, pasar de
        // Dockerfile a Nixpacks reutilizaría la imagen del Dockerfile y el
        // ajuste parecería no hacer nada.
        cfg.builder || 'auto',
        // Nixpacks hornea el comando de arranque en la imagen (NIXPACKS_START_CMD):
        // cambiarlo tiene que invalidar la caché o se reutiliza una imagen con el viejo.
        cfg.startCmd || '',
        args,
        vars,
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
  let buildKey = buildKeyFor(service, cfg);
  // Un solo cálculo del entorno para las dos cosas que lo necesitan: comprobar
  // que las variables del build siguen valiendo lo mismo, y dárselas al build.
  // Se recalcula si la importación del `.env` del repositorio añade variables.
  let env = resolveServiceEnv(service);
  const forceBuild = getDeployment(deploymentId)?.force_build === 1;
  const onSpawn = trackProc(job);

  // Atajo: si la cabeza de la rama ya se construyó con ÉXITO y con las mismas
  // entradas, la imagen resultante sería idéntica bit a bit. Redesplegar tras
  // cambiar una variable —el caso más frecuente— pasa de clonar y compilar
  // entero a no hacer nada. Se consulta la cabeza por API (barato) antes de
  // pedir hueco de build, así que ni siquiera ocupa un slot de compilación.
  if (!forceBuild) {
    const reused = await reuseBuiltImage(service.id, cfg, token, buildKey, env, log);
    if (reused) {
      updateDeployment(deploymentId, {
        commit_sha: reused.commit_sha,
        commit_msg: reused.commit_msg,
        build_key: buildKey,
        repo_config: reused.repo_config,
        // La huella de las variables viaja con la imagen, no con la fila: sin
        // arrastrarla, el despliegue siguiente compararía contra esta fila —que
        // no construyó nada— y se quedaría ciego otra vez.
        build_vars: reused.build_vars ?? null,
      });
      return { image: reused.image_tag!, repoConfig: parseRepoConfig(reused.repo_config) };
    }
  }

  // Mientras se espera hueco no hay ningún proceso que matar: Cancelar solo
  // surte efecto si la espera se puede abandonar. Quien abandona no llegó a
  // tener plaza, así que no pasa por el `release` de abajo.
  let abandonWait: (() => void) | null = null;
  const cancelWait = () => abandonWait?.();
  job.onCancel.add(cancelWait);
  try {
    await acquireBuildSlot({
      onWait: (abandon) => {
        abandonWait = abandon;
        if (job.canceled) abandon();
      },
    });
  } catch (err) {
    if (job.canceled) throw new CanceledError();
    throw err;
  } finally {
    job.onCancel.delete(cancelWait);
  }
  try {
    if (job.canceled) throw new CanceledError();
    const info = await cloneRepo(
      { repoUrl: cfg.repoUrl, branch: cfg.branch || 'main', token, dest: workDir, onSpawn },
      log,
    );
    if (job.canceled) throw new CanceledError();
    // Las variables del `.env.example`/`.env` del repo se importan ANTES de
    // construir: así las públicas (VITE_*, NEXT_PUBLIC_*…) entran en el build
    // y todas llegan al contenedor de ESTE despliegue (deployContainer vuelve
    // a resolver el entorno). Un fallo aquí no puede tirar el despliegue.
    if (cfg.autoImportEnv !== false) {
      try {
        const contextDir = path.resolve(workDir, cfg.rootDir || '.');
        const report = importRepoEnv({ service, workDir, contextDir, log });
        if (report?.applied) {
          env = resolveServiceEnv(service);
          // La huella del build incluye las variables de build: con las recién
          // importadas, la que se calculó antes de clonar ya no describe esta imagen.
          buildKey = buildKeyFor(service, cfg);
        }
      } catch (err: any) {
        log(`Variables: no se pudo leer el .env del repositorio (${err?.message || err})`);
      }
    }
    const repoConfig = readRailwayRepoConfig(workDir, cfg.rootDir, log);
    recordNeeds(service, cfg, workDir, log);
    let builderPrevio: string | null = null;
    if (hasRailwayConfig(repoConfig) && repoConfig.source) {
      log(`Configuración del repositorio leída de ${repoConfig.source} (config-as-code de Railway).`);
      builderPrevio = previousBuilder(service.id);
    }
    updateDeployment(deploymentId, {
      commit_sha: info.commitSha,
      commit_msg: info.commitMsg,
      build_key: buildKey,
      repo_config: JSON.stringify(repoConfig),
    });

    const { varsDelBuild } = await buildImage(
      {
        repoDir: workDir,
        rootDir: cfg.rootDir,
        // RAILWAY_DOCKERFILE_PATH y el dockerfilePath del fichero mandan sobre
        // el ajuste del panel, misma precedencia que en Railway.
        dockerfilePath: repoDockerfilePath(service, repoConfig) ?? cfg.dockerfilePath,
        imageTag: image,
        buildArgs: cfg.buildArgs,
        builder: repoConfig.builder,
        serviceBuilder: cfg.builder,
        previousBuilder: builderPrevio,
        nixpacksEnv: nixpacksEnvFor(cfg, repoConfig),
        serviceEnv: env,
        // Capas de la última imagen correcta como caché: si el daemon purgó su
        // caché de build (o la imagen se construyó antes de un reinicio), esto
        // evita rehacer install de dependencias y compilaciones ya hechas.
        cacheFrom: lastSuccessfulImage(service.id),
        onSpawn,
      },
      log,
    );
    if (job.canceled) throw new CanceledError();
    updateDeployment(deploymentId, { build_vars: digestBuildVars(varsDelBuild) });
    log(`Imagen construida: ${image}`);
    return { image, repoConfig };
  } finally {
    releaseBuildSlot();
    // Asíncrono y sin lanzar: `rmSync` bloqueaba el proceso entero borrando un
    // node_modules, y si fallaba su excepción tapaba el error real del build.
    try {
      await fs.promises.rm(workDir, { recursive: true, force: true });
    } catch (err: any) {
      log(`⚠ No se pudo borrar el directorio de trabajo ${workDir}: ${err?.message || err}`);
    }
  }
}

/**
 * Busca un despliegue anterior cuya imagen sirva tal cual para la cabeza actual
 * de la rama. Devuelve la fila reutilizable, o null si hay que compilar. Todo
 * el camino es best-effort: si no se puede saber la cabeza o la imagen ya no
 * está en el disco, se compila como siempre.
 */
/**
 * Digest de las variables que entraron en un build. Se guarda el hash y no el
 * valor: la fila del despliegue se sirve por la API del panel, y un `--build-arg`
 * puede llevar un token. Para saber si algo cambió basta con comparar hashes.
 */
function hashVar(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function digestBuildVars(vars: Record<string, string>): string {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) out[k] = hashVar(v);
  return JSON.stringify(out);
}

/** Variables que entraron en aquel build y hoy valen otra cosa (o ya no están). */
function changedBuildVars(raw: string | null | undefined, env: Record<string, string>): string[] {
  if (!raw) return []; // despliegue anterior al registro: se reutiliza como siempre
  let previo: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return [];
    previo = parsed as Record<string, unknown>;
  } catch {
    return []; // ilegible: no es motivo para recompilar a ciegas
  }
  const out: string[] = [];
  for (const [nombre, hash] of Object.entries(previo)) {
    if (typeof hash !== 'string') continue;
    const actual = env[nombre];
    if (actual === undefined || hashVar(actual) !== hash) out.push(nombre);
  }
  return out.sort();
}

async function reuseBuiltImage(
  serviceId: string,
  cfg: GitConfig,
  token: string | null,
  buildKey: string,
  env: Record<string, string>,
  log: (l: string) => void,
): Promise<DeploymentRow | null> {
  const slug = parseGithubSlug(cfg.repoUrl);
  if (!slug) return null; // sin API que preguntar, clonar es la única forma de saber la cabeza
  const head = await apiHeadSha(token ?? '', slug.owner, slug.repo, cfg.branch || 'main');
  if (!head) return null;
  const previous = reusableBuild(serviceId, head, buildKey);
  if (!previous?.image_tag) return null;
  if (!(await imageExists(previous.image_tag))) return null;
  // La huella no puede saber qué variables entran en un build con Dockerfile: eso
  // lo deciden los `ARG` que declare el repo, y para leerlos habría que clonar,
  // que es justo lo que este atajo evita. Se comparan con las que SÍ entraron la
  // última vez: si una cambió, esa imagen lleva el valor viejo horneado dentro y
  // reutilizarla sería servir un cambio que el usuario cree haber aplicado.
  const cambiadas = changedBuildVars(previous.build_vars, env);
  if (cambiadas.length > 0) {
    log(
      `El commit ${head.slice(0, 7)} ya estaba construido, pero ${cambiadas.join(', ')} formó parte de aquella compilación y su ` +
        'valor ha cambiado: la imagen guardada contiene el valor anterior, por lo que se compila de nuevo.',
    );
    return null;
  }
  log(
    `El commit ${head.slice(0, 7)} ya está construido con esta configuración: se reutiliza la imagen ${previous.image_tag} ` +
      '(sin clonar ni compilar). Utilice «Reconstruir» para forzar una compilación limpia.',
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
 * Con qué se construyó el último despliegue que funcionó.
 *
 * Devuelve el constructor que quedó registrado, `'LEGACY'` si hubo un
 * despliegue correcto de cuando Skyway aún no leía railway.json —entonces la
 * regla era «Dockerfile si lo hay»— o null si el servicio nunca ha desplegado
 * bien. Lo usa buildImage para no cambiarle el constructor por su cuenta a un
 * servicio que ya va: cambiarlo cambia el comando de arranque y el entorno
 * entero, y eso rompe cosas que llevaban meses en pie.
 */
function previousBuilder(serviceId: string): string | null {
  const previo = listDeployments(serviceId, 25).find((d) => d.status === 'success');
  if (!previo) return null;
  return (parseRepoConfig(previo.repo_config)?.builder || '').toUpperCase() || 'LEGACY';
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
  // Las variables llegan al contenedor por dos vías según su nombre: las que el
  // propio CLI de Docker respetaría en su entorno (PATH, LD_*, DOCKER_HOST…)
  // van con su valor en la línea de órdenes y nunca entran en el entorno del
  // proceso `docker`; el resto, como entorno del hijo más `--env CLAVE`.
  const { inherited, explicit } = partitionPreDeployEnv(env);
  const args = ['run', '--rm', '--network', projectNetworkName(project)];
  for (const key of Object.keys(inherited)) args.push('--env', key);
  for (const [key, value] of Object.entries(explicit)) args.push('--env', `${key}=${value}`);
  args.push('--env', 'SKYWAY_PREDEPLOY_CMD');
  // Cómo se le entrega la orden depende del ENTRYPOINT de la imagen, igual que
  // el comando de arranque: con el de Nixpacks, un `sh -c` acababa arrancando
  // un shell vacío que salía con 0 —y esto se habría dado por ejecutado—.
  args.push(...(await runArgsFor(image, 'eval "$SKYWAY_PREDEPLOY_CMD"')));
  const onSpawn = job ? trackProc(job) : undefined;
  try {
    await spawnLogged(
      'docker',
      args,
      { env: { ...inherited, SKYWAY_PREDEPLOY_CMD: command }, onSpawn, timeoutMs: PRE_DEPLOY_TIMEOUT_MS },
      log,
    );
  } catch (err: any) {
    throw new Error(
      `El comando previo al despliegue falló (${err?.message || err}). La versión en ejecución no se ha modificado.`,
    );
  }
  log('Comando previo completado.');
}

/**
 * Puerto interno de un servicio de repositorio, contrastado con el EXPOSE de la
 * imagen recién construida.
 *
 * Skyway no puede saber dónde escucha de verdad una aplicación: le pasa el
 * puerto por `PORT` y confía. Cuando la app no respeta `PORT` y escucha en otro
 * sitio no pasaba nada visible —el proceso sigue vivo y la validación sin
 * healthcheck lo da por bueno—, y quedaba un despliegue en verde con un 502 en
 * el dominio sin una sola línea del log que mencionara el puerto. El EXPOSE de
 * la imagen es la única pista que hay, y se usa con dos varas muy distintas:
 *
 *  - Si alguien eligió el puerto, o el servicio ya ha desplegado bien alguna
 *    vez, NO se toca: solo se avisa. Cambiárselo a un servicio que va sería
 *    reabrir lo que ya funciona, y EXPOSE se hereda de la imagen base con tanta
 *    frecuencia que miente más de lo que acierta.
 *  - Solo en el PRIMER despliegue de un servicio cuyo puerto nadie eligió y
 *    cuya imagen expone UN único puerto se adopta ese, se dice en el log y se
 *    guarda en los ajustes: a partir de ahí ya es una decisión, no una
 *    suposición, y no se vuelve a tomar sola.
 */
async function resolveGitPort(
  service: ServiceRow,
  cfg: GitConfig,
  image: string,
  log: (l: string) => void,
): Promise<number> {
  const configurado = cfg.port || 3000;
  const expuestos = await imageExposedPorts(image);
  if (expuestos.length === 0 || expuestos.includes(configurado)) return configurado;

  const nuncaDesplegoBien = lastSuccessfulImage(service.id) === null;
  const nadieLoEligio = cfg.portAuto === true;
  if (nadieLoEligio && nuncaDesplegoBien && expuestos.length === 1) {
    const detectado = expuestos[0];
    log(
      `Puerto interno detectado a partir del EXPOSE de la imagen: ${detectado} (el valor por defecto era ${configurado}, ` +
        'sin selección explícita). Se guarda en Ajustes del servicio; modifíquelo si la aplicación escucha en otro puerto.',
    );
    // Se persiste para que el panel, las etiquetas de Traefik y los despliegues
    // siguientes cuenten todos lo mismo, y para que esto deje de decidirse solo.
    updateService(service.id, service.name, { ...cfg, port: detectado, portAuto: undefined });
    return detectado;
  }

  log(
    `⚠ La imagen declara EXPOSE ${expuestos.join(', ')} y el puerto interno del servicio es ${configurado}. Si la ` +
      `aplicación escucha en el puerto que indica la imagen y no en ${configurado}, Traefik enrutará a un puerto sin proceso (502) ` +
      'aunque el despliegue se considere correcto. Se respeta el puerto configurado: modifíquelo en Ajustes → Puerto interno si es necesario.',
  );
  return configurado;
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
      `⚠ Referencias sin resolver en ${sinResolver.join(', ')}: la variable referenciada ya no existe. ` +
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
      await assertPostgresVolumeCompatible(volumes[0].name, version, log, job);
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
    internalPort = await resolveGitPort(service, cfg, image, log);
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
  // Las mismas variables de sistema que otro servicio puede referenciar
  // (`${{api.PUBLIC_URL}}`), también dentro del propio contenedor: una app que
  // monta enlaces absolutos las tiene sin escribir su dominio a mano. Con el
  // puerto y los dominios de ESTE despliegue, no con lo guardado, y sin pisar
  // nunca un valor que el usuario haya definido.
  for (const [key, value] of Object.entries(systemVars(service, { port: internalPort, domains }))) {
    if (env[key] === undefined) env[key] = value;
  }
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
      `ℹ La configuración del repositorio solicita ${repoConfig.numReplicas} réplicas; en Skyway las réplicas se establecen en Ajustes del servicio (consumen cuota del workspace). Se mantienen ${configuredReplicas(service)}.`,
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
      'Las réplicas requieren un servicio sin volúmenes y sin puerto público: varias copias no pueden compartir el mismo volumen de escritura ni el mismo puerto del host. Elimine esas opciones o vuelva a 1 réplica.',
    );
  }

  // Sin volúmenes ni puerto de host, la versión nueva puede convivir con la
  // vieja unos segundos: corte cero. Con estado compartido, intercambio con
  // restauración automática (nunca dos procesos escribiendo el mismo volumen).
  const canOverlap = service.type !== 'database' && volumes.length === 0 && !hostPort;
  const oldExists = !!(await findContainer(name));

  if (canOverlap) {
    if (oldExists) {
      log('Validando la versión nueva antes de sustituir la actual (la versión anterior sigue en servicio)...');
      await runServiceContainer({
        ...spec,
        nameOverride: tempName,
        aliasOverride: `${service.slug}-next`,
        withTraefik: false,
        withHostPort: false,
        restartPolicy: 'no',
      });
      // Sin política: este contenedor se crea con `restartPolicy: 'no'` a
      // propósito —si muere, queremos verlo muerto— así que esperar reintentos
      // que Docker no va a hacer solo alargaría el fallo.
      let verdict: { ok: boolean; reason: string };
      try {
        verdict = await validateContainer(netName, `${service.slug}-next`, internalPort, healthcheckPath, tempName, log, probeTimeoutMs, null, job);
      } catch (err) {
        // Cancelado a mitad: el contenedor de prueba no se queda vivo.
        await removeContainer(tempName).catch(() => undefined);
        throw err;
      }
      if (!verdict.ok) {
        await appendContainerTail(tempName, log);
        await removeContainer(tempName);
        throw new Error(
          `La versión nueva no pasó la validación (${verdict.reason}). La versión anterior sigue en ejecución sin interrupción.`,
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
        const runtime = await settleContainer(rn, SETTLE_MS, job);
        if (runtime.state !== 'running') {
          throw new Error(`estado ${runtime.state}, código ${runtime.exitCode ?? 'n/a'}`);
        }
        if (!oldExists && i === 1) {
          const verdict = await validateContainer(netName, service.slug, internalPort, healthcheckPath, rn, log, probeTimeoutMs, restartPolicy, job);
          if (!verdict.ok) throw new Error(verdict.reason);
        }
      } catch (err: any) {
        await appendContainerTail(rn, log);
        await removeContainer(rn);
        if (hadOld) {
          log(`La réplica ${i} falló: restaurando su versión anterior...`);
          await renameContainer(rPrev, rn);
          throw new Error(
            `La réplica ${i}/${replicas} falló (${err?.message || err}). Su versión anterior sigue en ejecución; las réplicas ya actualizadas conservan la versión nueva hasta el próximo despliegue.`,
          );
        }
        throw new Error(`La réplica ${i}/${replicas} no arrancó (${err?.message || err}).`);
      }
      if (hadOld) {
        await archiveContainerLogs(rPrev);
        await stopContainer(rPrev);
        await removeContainer(rPrev);
      }
      if (replicas > 1) log(`Réplica ${i}/${replicas} lista.`);
    }

    // Scale-down: retira las réplicas con índice mayor al configurado. Solo
    // las que casan con el patrón EXACTO de réplica de este servicio y no
    // están entre las legítimas: una regex suelta sobre el final del nombre
    // tomaba un slug que acabara en «-r2» por una réplica sobrante y borraba
    // el contenedor que se acababa de desplegar.
    const legit = new Set(Array.from({ length: replicas }, (_, i) => replicaName(project, service, i + 1)));
    const replicaPattern = new RegExp(`^${escapeRegExp(name)}-r\\d+$`);
    for (const c of await listServiceContainers(service.id)) {
      if (!replicaPattern.test(c.name) || legit.has(c.name)) continue;
      log(`Retirando réplica sobrante ${c.name}...`);
      await archiveContainerLogs(c.name);
      await stopContainer(c.name);
      await removeContainer(c.name);
    }
    log(oldExists ? 'Intercambio completado sin interrupción del servicio.' : 'Servicio en ejecución.');
  } else {
    if (oldExists) {
      log('Servicio con estado (volúmenes/puerto fijo): intercambio con restauración automática...');
      await renameContainer(name, prevName);
      await stopContainer(prevName);
    }
    try {
      await runServiceContainer(spec);
      const verdict = await validateContainer(netName, service.slug, internalPort, healthcheckPath, name, log, probeTimeoutMs, restartPolicy, job);
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
        `El contenedor terminó inesperadamente (${err?.message || err}). Consulte el registro del servicio.`,
      );
    }
    if (oldExists) {
      await archiveContainerLogs(prevName);
      await removeContainer(prevName);
    }
  }

  if (domains.length > 0) {
    // Sin puerto interno no hay a dónde enrutar: las etiquetas de Traefik solo
    // se ponen con puerto, así que no se crea el router ni se pide certificado.
    // Decirlo aquí es lo único que rompe el fallo silencioso: el usuario ya ha
    // hecho el DNS y, leyendo «Dominios activos» al final de un despliegue
    // correcto, da por bueno que funciona.
    if (!internalPort) {
      log(
        `⚠ ${domains.join(', ')}: el dominio no enruta a este servicio. No tiene puerto interno, y Traefik necesita ` +
          'saber a qué puerto del contenedor entregar la petición: no se crea la ruta ni se emite certificado, por ' +
          'lo que el dominio responderá 404 y con un certificado que no le corresponde.',
      );
      log(
        'Si el servicio sirve HTTP, indique su puerto en Ajustes del servicio → Puerto interno y vuelva a desplegar. Si es ' +
          'un worker sin HTTP, elimine el dominio: no es necesario.',
      );
    } else {
      log(`Dominios activos: ${domains.join(', ')}`);
    }
  }
  if (hostPort && internalPort) {
    log(`Puerto publicado: ${hostPort} → ${internalPort}`);
  }
}

/**
 * Mira qué dependencias declara el repositorio recién clonado, lo guarda en la
 * config del servicio (para que la pestaña Variables lo convierta en
 * propuestas) y lo cuenta en el log del despliegue. Solo informa: la app
 * arrancará igual sin `DATABASE_URL`, y eso es precisamente lo que aquí se
 * intenta que no pase en silencio.
 */
function recordNeeds(service: ServiceRow, cfg: GitConfig, workDir: string, log: (l: string) => void): void {
  let needs: ReturnType<typeof detectNeeds>;
  try {
    needs = detectNeeds(workDir, cfg.rootDir);
  } catch (err: any) {
    log(`ℹ No se pudieron inspeccionar las dependencias del repositorio: ${err?.message || err}`);
    return;
  }
  // En memoria, para que las escrituras posteriores de esta config (el puerto
  // detectado del EXPOSE) no la pierdan; y en la base releyendo la fila, para
  // no pisar un ajuste que alguien haya guardado mientras se clonaba.
  if (needs) cfg.needs = needs;
  else delete cfg.needs;
  const fresh = getService(service.id);
  if (fresh) {
    const freshCfg = { ...(fresh.config as GitConfig) };
    if (needs) freshCfg.needs = needs;
    else delete freshCfg.needs;
    updateService(fresh.id, fresh.name, freshCfg);
  }
  if (!needs) return;

  const advice = adviseEnv({ ...service, config: cfg }, availableReferences(service));
  if (advice.needs && advice.needs.engines.length > 0) {
    log(`Dependencias detectadas en el repositorio: ${advice.needs.engines.map((e) => `${e.label} (${e.evidence})`).join(', ')}.`);
  }
  const sinCubrir = advice.suggestions.filter((s) => s.template).map((s) => s.key);
  if (sinCubrir.length > 0) {
    log(
      `⚠ Faltan variables para esas dependencias: ${sinCubrir.join(', ')}. En la pestaña Variables hay propuestas para ` +
        'conectarlas en un clic (o crear la base que falte); se aplican al redesplegar.',
    );
  }
  if (advice.missing.length > 0) {
    log(`ℹ El repositorio espera además (${needs.envFile ?? 'variables de ejemplo'}) y no están definidas: ${advice.missing.join(', ')}.`);
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
/** Imagen del contenedor auxiliar de las sondas e inspecciones. */
const PROBE_IMAGE = 'busybox:stable';
/** Tope de cada intento de sonda (el `wget` ya corta a los 3 s; esto cubre al exec). */
const PROBE_ATTEMPT_TIMEOUT_MS = 8000;
const GRACE_MS = 5000;

/**
 * Pausa entre sondas. Ágil al principio —hay procesos que responden al
 * instante y cada segundo de espera se lo cobraba a TODOS los despliegues— y
 * más espaciada cuanto más tarda: a los cinco minutos ya da igual enterarse
 * dos segundos antes o después, y no hace falta martillear a Docker.
 */
function probeDelay(attempt: number): number {
  if (attempt <= 10) return 1200; // ~12 s
  if (attempt <= 25) return 2000; // hasta ~40 s
  if (attempt <= 40) return 3000; // hasta ~1,5 min
  return 5000;
}

/**
 * Sonda HTTP del healthcheck: UN contenedor auxiliar (`busybox sleep`) en la
 * red del proyecto durante toda la validación y un `exec wget` por intento.
 * Antes cada intento era un `docker run --rm` completo —crear, arrancar,
 * conectar a la red, destruir— cada 1,2 s durante hasta cinco minutos: unos
 * 250 contenedores por despliegue lento, y el daemon lo notaba.
 */
class HealthProbe {
  private id: string | null = null;

  constructor(
    private readonly netName: string,
    private readonly name: string,
  ) {}

  async start(ttlSeconds: number): Promise<void> {
    // Un resto de una validación interrumpida (Skyway cayó a mitad) no debe
    // impedir la de ahora.
    await removeContainer(this.name);
    const c = await docker.createContainer({
      name: this.name,
      Image: PROBE_IMAGE,
      // Se autodestruye pasado el plazo aunque nadie llegue a pararlo.
      Cmd: ['sleep', String(ttlSeconds)],
      Labels: { 'skyway.managed': 'true', 'skyway.probe': 'true' },
      HostConfig: { NetworkMode: this.netName, AutoRemove: true },
    });
    this.id = c.id;
    await c.start();
  }

  /** true si la URL respondió 2xx. La URL viaja por entorno, no por el shell. */
  async probe(url: string): Promise<boolean> {
    if (!this.id) return false;
    try {
      const res = await execInContainer(this.id, 'wget -q -T 3 -O /dev/null "$SKYWAY_PROBE_URL"', {
        timeoutMs: PROBE_ATTEMPT_TIMEOUT_MS,
        maxOutput: 1000,
        env: [`SKYWAY_PROBE_URL=${url}`],
      });
      return res.exitCode === 0;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    if (!this.id) return;
    const id = this.id;
    this.id = null;
    try {
      await docker.getContainer(id).remove({ force: true });
    } catch {
      /* ya se fue solo (AutoRemove) */
    }
  }
}
/**
 * Margen total cuando el repositorio declara una política que reintenta. Manda
 * la política: si pidió reintentos, se le dan de verdad en vez de sentenciar al
 * primer tropiezo. Sigue acotado, para que un bucle de reinicio no deje el
 * despliegue colgado para siempre.
 */
const RESTART_WINDOW_MS = 90_000;
/** Líneas que se rescatan del contenedor fallido antes de borrarlo. */
const TAIL_LINES = 80;
/** Cada cuánto se mira si el contenedor murió durante el periodo de gracia. */
const GRACE_CHECK_MS = 500;
/** Ventana de asentamiento de cada réplica en la actualización rodante. */
const SETTLE_MS = 1500;

/**
 * Observa el contenedor durante `ms` y devuelve su estado. Corta en cuanto deja
 * de estar en marcha: un arranque fallido no tiene por qué agotar la ventana.
 */
async function settleContainer(name: string, ms: number, job?: ActiveJob): Promise<Awaited<ReturnType<typeof getRuntime>>> {
  const until = Date.now() + ms;
  let runtime = await getRuntime(name);
  while (Date.now() < until) {
    if (job?.canceled) throw new CanceledError();
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
  restartPolicy: { Name: string; MaximumRetryCount?: number } | null = null,
  job?: ActiveJob,
): Promise<{ ok: boolean; reason: string }> {
  // Cancelar tiene que surtir efecto también aquí: son los bucles más largos
  // del despliegue (hasta cinco minutos) y no tienen proceso hijo que matar.
  const checkCanceled = () => {
    if (job?.canceled) throw new CanceledError();
  };

  if (healthcheckPath && port) {
    const path = healthcheckPath.startsWith('/') ? healthcheckPath : `/${healthcheckPath}`;
    const url = `http://${aliasHost}:${port}${path}`;
    log(`Esperando healthcheck 2xx en ${url} (hasta ${Math.round(timeoutMs / 1000)}s)...`);
    await pullImage(PROBE_IMAGE, log, job, { quietIfPresent: true });
    const probe = new HealthProbe(netName, `${containerRef}--probe`);
    await probe.start(Math.ceil(timeoutMs / 1000) + 60);
    try {
      const deadline = Date.now() + timeoutMs;
      let attempts = 0;
      // Sin espera previa: hay procesos que ya responden al instante y esperar
      // un segundo «por si acaso» se lo cobraba a TODOS los despliegues.
      while (Date.now() < deadline) {
        checkCanceled();
        attempts += 1;
        const state = await getRuntime(containerRef);
        if (state.state !== 'running') {
          return { ok: false, reason: `el proceso finalizó durante el arranque (código ${state.exitCode ?? 'n/a'})` };
        }
        if (await probe.probe(url)) {
          log(`Healthcheck superado en el intento ${attempts}.`);
          return { ok: true, reason: 'ok' };
        }
        await sleep(probeDelay(attempts));
      }
      return { ok: false, reason: `el healthcheck ${path} no respondió 2xx en ${Math.round(timeoutMs / 1000)}s` };
    } finally {
      await probe.stop();
    }
  }

  // Sin healthcheck no hay forma de saber que la versión nueva está bien: solo
  // se puede comprobar que no se muere enseguida. Se vigila cada poco en vez de
  // dormir el periodo entero, para que un arranque fallido corte YA y el
  // usuario vea el error (y la versión anterior vuelva) sin esperar en balde.
  // Si el repositorio declaró reintentos, un tropiezo al arrancar NO es un
  // veredicto: es Docker haciendo lo que le pidieron. Fallar en el primer
  // intento contradice el `restartPolicyMaxRetries` del propio repo, y con un
  // fallo transitorio —una conexión que se cae al arrancar— tumba un despliegue
  // que se habría recuperado solo. Se le da margen a que se asiente.
  const reintenta = !!restartPolicy && restartPolicy.Name !== 'no';
  const budget = reintenta ? RESTART_WINDOW_MS : GRACE_MS;
  log(
    reintenta
      ? `Sin healthcheck configurado: el proceso debe mantenerse en ejecución ${GRACE_MS / 1000}s seguidos (hasta ${budget / 1000}s, porque el repositorio solicita reintentos)...`
      : `Sin healthcheck configurado: periodo de gracia de ${GRACE_MS / 1000}s...`,
  );

  const inicio = Date.now();
  const deadline = inicio + budget;
  // Acaba de arrancar: se cuenta en pie desde ya, o el reloj de la racha
  // empezaría medio segundo tarde y no cabría dentro de la ventana.
  let enPieDesde: number | null = inicio;
  let avisado = false;
  for (;;) {
    checkCanceled();
    await sleep(GRACE_CHECK_MS);
    const runtime = await getRuntime(containerRef);

    if (runtime.state === 'running') {
      if (enPieDesde === null) enPieDesde = Date.now();
      if (Date.now() - enPieDesde >= GRACE_MS) return { ok: true, reason: 'ok' };
    } else {
      enPieDesde = null;
      // Salir con 0 bajo `on-failure` es terminal: Docker no lo reinicia.
      const terminal =
        !reintenta || (restartPolicy!.Name === 'on-failure' && runtime.state === 'exited' && runtime.exitCode === 0);
      if (terminal) {
        return { ok: false, reason: `el proceso terminó enseguida (estado ${runtime.state}, código ${runtime.exitCode ?? 'n/a'})` };
      }
      if (!avisado) {
        log('El proceso finalizó al arrancar; Docker lo reintenta según la política del repositorio. Esperando a que se estabilice...');
        avisado = true;
      }
    }
    if (Date.now() >= deadline) break;
  }
  return {
    ok: false,
    reason: reintenta
      ? `no se mantuvo en ejecución ${GRACE_MS / 1000}s seguidos en ${budget / 1000}s: continúa finalizando y reiniciándose`
      : 'el proceso no llegó a arrancar',
  };
}

/** Añade al log del despliegue las últimas líneas del contenedor fallido. */
async function appendContainerTail(name: string, log: (l: string) => void): Promise<void> {
  try {
    const info = await findContainer(name);
    if (!info) return;
    const container = docker.getContainer(name);
    // Ochenta y no veinte: el contenedor se borra a continuación y estas líneas
    // son lo ÚNICO que queda de él. Un traceback de Python se come veinte sin
    // esfuerzo y deja fuera justo lo de antes —qué arrancó, qué no—, que suele
    // ser donde está la respuesta.
    const buf = (await container.logs({ stdout: true, stderr: true, tail: TAIL_LINES, follow: false })) as unknown as Buffer;
    // El mismo demultiplexor que el visor de logs: tolera tramas truncadas y
    // contenedores con TTY (texto plano, sin cabeceras).
    const text = demuxLogBuffer(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)))
      .split('\n')
      .filter((l) => l.trim())
      .slice(-TAIL_LINES);
    if (text.length > 0) {
      log(`— Últimas ${text.length} líneas del contenedor fallido —`);
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

/** Imágenes correctas que se conservan (las de los últimos despliegues buenos). */
const KEEP_IMAGES = 5;

/**
 * Purga las imágenes de despliegues antiguos. Varias filas comparten etiqueta
 * —la imagen se reutiliza cuando el commit ya estaba construido—, así que una
 * fila «antigua» puede apuntar a la imagen que se está sirviendo AHORA: se
 * conservan las etiquetas de los últimos despliegues correctos y la que corre
 * cada réplica, y solo se borra lo que no referencia ninguna de ellas.
 */
async function cleanupOldImages(project: ProjectRow, service: ServiceRow, log: (l: string) => void): Promise<void> {
  try {
    const stale = successfulDeploymentsBeyond(service.id, KEEP_IMAGES);
    if (stale.length === 0) return;
    const keep = new Set<string>();
    for (const d of listDeployments(service.id, 50).filter((d) => d.status === 'success' && d.image_tag).slice(0, KEEP_IMAGES)) {
      keep.add(d.image_tag!);
    }
    for (let i = 1; i <= configuredReplicas(service); i++) {
      const rt = await getRuntime(replicaName(project, service, i));
      if (rt.image) keep.add(rt.image);
    }
    const doomed = new Set<string>();
    for (const dep of stale) {
      if (dep.image_tag && !keep.has(dep.image_tag)) doomed.add(dep.image_tag);
    }
    for (const tag of doomed) await removeImage(tag, log);
    if (doomed.size > 0) {
      log(`Purgadas ${doomed.size} imágenes antiguas (se conservan las de los últimos ${KEEP_IMAGES} despliegues correctos)`);
    }
  } catch {
    // best-effort
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
