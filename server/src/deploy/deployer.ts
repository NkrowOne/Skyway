import { ChildProcess, spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import {
  activeDeploymentIdsForServices,
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
  takeInterruptedDeployments,
} from '../db';
import {
  AUTODEPLOY_ALERT_TYPE,
  ESTRATEGIA_ALERT_TYPE,
  fireAlert,
  PARADA_FORZADA_ALERT_TYPE,
  resolveAllServiceAlerts,
  resolveServiceAlerts,
} from '../alerts';
import { anotarParadaForzada } from './avisoestrategia';
import { diagnose } from './diagnose';
import { dominioPrincipal } from '../dominioprincipal';
import { emitDeploy, emitDeployFeed, toDeployFeedItem } from '../events';
import { docker, dockerAvailable, dockerQuery } from '../docker/client';
import {
  assertImageRef,
  configuredReplicas,
  containerHealth,
  containerName,
  demuxLogBuffer,
  execInContainer,
  fetchLogsText,
  findContainer,
  imageDeclaredVolumes,
  imageExists,
  imageExposedPorts,
  imageHealthcheckWindowMs,
  listServiceContainers,
  normalizeContainerPath,
  pararConGracia,
  removeContainer,
  removeImage,
  type ResultadoParada,
  renameContainer,
  replicaName,
  RunSpec,
  runServiceContainer,
  startContainer,
  volumeName,
  getRuntime,
  runArgsFor,
  startCommandSpec,
} from '../docker/containers';
import { ensureNetwork, projectNetworkName, EDGE_NETWORK } from '../docker/networks';
import { invalidateDockerSnapshot } from '../docker/sampler';
import { apiHeadSha, parseGithubSlug } from '../github/client';
import { resolveGitAuth } from '../github/resolve';
import { markManualAction } from '../monitor';
import { isWorkspaceActive, workspaceOfProject } from '../quota';
import { buildImage, cloneRepo, isBuildTimeVar, normalizeRepoUrl, spawnLogged } from './builder';
import { importRepoEnv } from './envimport';
import { partitionPreDeployEnv } from './predeployenv';
import { dockerRestartPolicy, hasRailwayConfig, RailwayRepoConfig, readRailwayRepoConfig } from './railwayconfig';
import { acquireBuildSlot, enqueue, releaseBuildSlot } from './queue';
import {
  comandoParada,
  describirEstrategia,
  EstrategiaServicio,
  estrategiaDespliegue,
  estrategiaEfectiva,
  bibliotecasDeBot,
  GRACIA_VALIDACION_MAXIMA,
  graciaParada,
  llamadoPorOtros,
} from './estrategia';
import { effectiveDbVersion, getTemplate, volumePathFor } from '../templates';
import { reconcileOnDeploy } from '../integrations';
import { adviseEnv, detectNeeds } from '../needs';
import { availableReferences, resolveServiceEnv, systemVars } from '../variables';
import { DatabaseConfig, DeploymentRow, GitConfig, ImageConfig, ProjectRow, ServiceRow } from '../types';
import { now } from '../util';
import { refreshTraefikAcme, tlsBlocked, tlsEnabled } from '../tls';

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
/** Motivo de los despliegues que corta el apagado de Skyway (se reanudan al arrancar). */
const SHUTDOWN_REASON = 'Interrumpido por el apagado del servidor';
/**
 * Origen del reintento automático de un despliegue cortado por un reinicio.
 * Un despliegue con este origen que vuelve a cortarse ya no se reintenta: si
 * fue el propio build el que tumbó Skyway (falta de memoria), reintentar
 * siempre sería un bucle de reinicios.
 */
export const RETRY_TRIGGER = 'reintento';
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
  for (const job of activeJobs.values()) abortJob(job, SHUTDOWN_REASON);
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

/**
 * Servicios que se están eliminando. Mientras dura el borrado (paradas de
 * contenedores, espera a los despliegues cancelados…) las filas siguen vivas,
 * y un webhook de GitHub, el autodeploy o el botón de desplegar podían colar
 * un despliegue nuevo que volvía a crear el contenedor y, con el montaje, el
 * volumen recién borrado. Los que llegan en esa ventana nacen cancelados.
 */
const deletingServices = new Set<string>();

export function markServicesDeleting(serviceIds: string[]): void {
  for (const id of serviceIds) deletingServices.add(id);
}

export function unmarkServicesDeleting(serviceIds: string[]): void {
  for (const id of serviceIds) deletingServices.delete(id);
}

const DELETING_REASON = 'Cancelado: el servicio se está eliminando';

/**
 * Cancela los despliegues en cola o en marcha de unos servicios que se van a
 * borrar y espera (hasta `graceMs`) a que los que corrían terminen. Sin esto,
 * un despliegue a medias seguía adelante sin fila en la base: volvía a crear
 * la red, el contenedor y, con el montaje, el volumen que se acababa de
 * borrar. Devuelve cuántos seguían vivos al vencer el plazo.
 */
export async function cancelServiceDeployments(serviceIds: string[], graceMs = 15_000): Promise<number> {
  const ids = activeDeploymentIdsForServices(serviceIds);
  for (const depId of ids) cancelDeployment(depId);
  const deadline = Date.now() + graceMs;
  const vivos = () => ids.filter((depId) => activeJobs.has(depId)).length;
  while (vivos() > 0 && Date.now() < deadline) await sleep(100);
  return vivos();
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
  opts: { imageTag?: string; forceBuild?: boolean; targetCommit?: string } = {},
): DeploymentRow {
  const deployment = createDeployment(serviceId, trigger, opts.imageTag ?? null, {
    forceBuild: opts.forceBuild,
    targetCommit: opts.targetCommit ?? null,
  });
  // Se anuncia YA, en cola: el aviso de «versión nueva en camino» no puede
  // esperar a que haya un hueco de build libre.
  if (deletingServices.has(serviceId)) {
    updateDeployment(deployment.id, { status: 'canceled', error: DELETING_REASON, finished_at: now() });
    emitDeploy(deployment.id, { type: 'done', status: 'canceled', error: null });
    publishFeed(deployment.id);
    return getDeployment(deployment.id) ?? deployment;
  }
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

/** Disparadores cuyo reintento tras un reinicio despliega la imagen del despliegue cortado. */
const CON_IMAGEN_AL_REINTENTAR = new Set(['rollback', 'cambio-de-dominio', 'mailway']);

/**
 * Disparadores que, con imagen, vuelven a desplegar la versión en marcha para
 * que tome otras variables (el usuario o la credencial de correo): no son una
 * vuelta atrás y el registro no debe decirlo.
 */
const MISMA_IMAGEN_SIN_COMPILAR = new Set(['cambio-de-dominio', 'mailway']);

/**
 * Si el despliegue volvía a una versión anterior (una vuelta atrás, o el
 * reintento de una), el despliegue correcto cuya imagen se quería recuperar.
 * La alerta lo usa para ofrecer «Volver a esta versión»: «Desplegar» despliega
 * la cabeza de la rama, justo lo contrario de lo que se pidió.
 *
 * `imageTag` es la imagen con la que se CREÓ el despliegue (solo la llevan las
 * vueltas atrás); en un reintento que ya construyó, la suya no es de ninguna
 * versión correcta anterior y no cuenta.
 */
function rollbackTargetOf(service: ServiceRow, trigger: string, imageTag: string | null): string | null {
  if (service.type !== 'git' || !imageTag) return null;
  if (trigger !== 'rollback' && trigger !== RETRY_TRIGGER) return null;
  return deploymentForImage(service.id, imageTag)?.id ?? null;
}

/**
 * Al arrancar: los despliegues que cortó el reinicio o el apagado anterior
 * (un `skyway update` a mitad de un build, sin ir más lejos) quedaban como
 * fallidos o cancelados sin alerta ni reintento, y el servicio seguía en la
 * versión vieja sin que nadie lo supiera. Cada servicio cuyo ÚLTIMO despliegue
 * quedó cortado recibe una alerta y, una sola vez, un reintento automático.
 */
export function resumeInterruptedDeployments(): { retried: number; alerted: number } {
  let retried = 0;
  let alerted = 0;
  for (const dep of takeInterruptedDeployments()) {
    const service = getService(dep.service_id);
    if (!service) continue;
    const project = getProject(service.project_id);
    const reintentoCortado = dep.trigger === RETRY_TRIGGER;
    const rollbackTo = rollbackTargetOf(service, dep.trigger, dep.image_tag);
    fireAlert({
      severity: 'warning',
      type: 'deploy_interrupted',
      serviceId: service.id,
      title: `Despliegue interrumpido por un reinicio: ${service.name}`,
      message: reintentoCortado
        ? `El reintento automático del despliegue de "${service.name}" en ${project?.name ?? '?'} también se interrumpió por un reinicio de Skyway. No se vuelve a intentar de forma automática: el servicio sigue con la versión anterior.`
        : `El despliegue (${dep.trigger}) de "${service.name}" en ${project?.name ?? '?'} se interrumpió por un reinicio de Skyway. Se ha vuelto a lanzar una vez de forma automática.`,
      explanation: reintentoCortado
        ? 'Si el reinicio lo provocó el propio despliegue (por ejemplo, por falta de memoria durante la compilación), revisa los recursos del servidor antes de volver a desplegar. ' +
          (rollbackTo
            ? 'Para intentarlo de nuevo, pulsa «Volver a esta versión» (no «Desplegar», que desplegaría la última versión de la rama).'
            : 'Para intentarlo de nuevo, pulsa «Desplegar».')
        : 'Si el reintento termina correctamente, esta alerta se cierra sola.',
      dedupe: true,
      rollbackTo,
      // El reintento suele resolverlo: fuera del panel solo se avisa cuando hay que actuar.
      quiet: !reintentoCortado,
    });
    alerted += 1;
    if (reintentoCortado) continue;
    markManualAction(service.id); // el intercambio no es una caída
    triggerDeploy(service.id, RETRY_TRIGGER, {
      // Una vuelta atrás se reintenta como vuelta atrás: desplegar la cabeza
      // desharía lo que se pidió. Lo mismo un despliegue del cambio de dominio
      // o de la pestaña Correo con imagen: vuelven a desplegar la versión en
      // marcha con otras variables de correo, no código nuevo (si no la
      // fijaron, solo la tienen si ya habían construido, y es esa misma). El
      // resto vuelve a construir (o reutilizar).
      imageTag: CON_IMAGEN_AL_REINTENTAR.has(dep.trigger) && dep.image_tag ? dep.image_tag : undefined,
      forceBuild: dep.force_build === 1,
      targetCommit: dep.target_commit ?? undefined,
    });
    retried += 1;
  }
  return { retried, alerted };
}

async function runDeployment(deploymentId: string): Promise<void> {
  if (shuttingDown) return;
  const deployment = getDeployment(deploymentId);
  if (!deployment || deployment.status !== 'queued') return;
  if (deletingServices.has(deployment.service_id)) {
    updateDeployment(deploymentId, { status: 'canceled', error: DELETING_REASON, finished_at: now() });
    emitDeploy(deploymentId, { type: 'done', status: 'canceled', error: null });
    publishFeed(deploymentId);
    return;
  }
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
    // También si el servicio ha empezado a eliminarse mientras construía:
    // crear ahora el contenedor dejaría uno (y su volumen) sin servicio.
    if (!job.canceled && deletingServices.has(deployment.service_id)) {
      job.canceled = true;
      job.cancelReason = DELETING_REASON;
    }
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
      throw new Error('Docker no está disponible. Comprueba que el daemon está en ejecución y que Skyway tiene acceso a /var/run/docker.sock');
    }

    log(`Despliegue de "${service.name}" en el proyecto "${project.name}" (${deployment.trigger})`);
    // Revisión de la configuración que lleva este despliegue, leída con el
    // servicio: lo que se guarde a partir de ahora queda como «sin desplegar».
    updateDeployment(deploymentId, { config_rev: service.config_rev ?? 0 });
    setStatus('building');

    let image: string;
    let repoConfig: RailwayRepoConfig | null = null;
    if (service.type === 'database') {
      image = await prepareDatabaseImage(service, log, job);
    } else if (service.type === 'image') {
      image = await preparePlainImage(service, log, job);
    } else if (deployment.image_tag) {
      image = deployment.image_tag;
      // El reintento tras un reinicio lleva el disparador `reintento`, no el
      // original: si vuelve a desplegar la imagen que ya estaba en marcha (el
      // de la pestaña Correo o el del cambio de dominio), tampoco es una vuelta
      // atrás. Antes de este despliegue, la última correcta es la que corre.
      const mismaImagen =
        MISMA_IMAGEN_SIN_COMPILAR.has(deployment.trigger) ||
        (deployment.trigger === RETRY_TRIGGER && lastSuccessfulImage(service.id) === image);
      log(
        mismaImagen
          ? `Se vuelve a desplegar la imagen en marcha ${image} con las variables actuales, sin compilar.`
          : `Rollback a la imagen ${image}`,
      );
      if (!(await imageExists(image))) {
        throw new Error(`La imagen ${image} ya no existe en el servidor (se purgó). Realiza un despliegue normal.`);
      }
      // Volver a una versión anterior debe volver también a SU config-as-code:
      // si aquel commit declaraba otro comando de arranque, es el que toca.
      // La configuración vive en el despliegue que CONSTRUYÓ la imagen, no en
      // esta fila de rollback (que nunca clonó nada). Se copia a esta fila: sin
      // ella, la siguiente vuelta a esta imagen (o el siguiente despliegue de la
      // pestaña Correo) encontraba esta fila sin configuración y arrancaba sin
      // el comando de arranque ni el healthcheck del repositorio, y el build
      // siguiente la tomaba por un despliegue de antes de railway.json
      // (`previousBuilder`) y podía cambiar de constructor.
      const origin = deploymentForImage(service.id, image);
      repoConfig = parseRepoConfig(origin?.repo_config ?? null);
      updateDeployment(deploymentId, {
        ...(origin?.commit_sha ? { commit_sha: origin.commit_sha, commit_msg: origin.commit_msg } : {}),
        ...(origin?.repo_config != null ? { repo_config: origin.repo_config } : {}),
      });
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
    // Menos la del sondeo del auto-deploy: un despliegue correcto (una vuelta
    // atrás, uno manual) no dice que la rama vuelva a poder leerse, y cerrarla
    // aquí hacía que el siguiente ciclo abriera otra y volviera a notificar. La
    // cierra el propio sondeo cuando se recupera.
    // Tampoco el aviso de «una sola copia» ni el de la parada forzada: los dos
    // hablan justamente de lo que pasa en los despliegues correctos.
    resolveAllServiceAlerts(service.id, false, [AUTODEPLOY_ALERT_TYPE, ESTRATEGIA_ALERT_TYPE, PARADA_FORZADA_ALERT_TYPE]);
  } catch (err: any) {
    if (err instanceof CanceledError || job.canceled) {
      const reason = job.cancelReason ?? 'Cancelado por el usuario';
      log(`✖ ${reason}`);
      log.flush();
      updateDeployment(deploymentId, {
        status: 'canceled',
        error: reason,
        finished_at: now(),
        // Cortado por el apagado: el siguiente arranque avisa y lo reintenta.
        ...(reason === SHUTDOWN_REASON ? { interrupted: 1 } : {}),
      });
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
        // `deployment` es la fila leída al empezar: su imagen es la de la vuelta
        // atrás, no la que haya construido después.
        rollbackTo: rollbackTargetOf(service, deployment.trigger, deployment.image_tag),
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
    'Para cambiar de versión mayor: crea una copia de seguridad con la versión actual de los datos, cambia la versión en Ajustes, elimina el servicio marcando «borrar también el volumen», vuelve a crearlo y restaura la copia. Para empezar de cero es suficiente con eliminar el servicio con su volumen.';

  if (rootMajor !== null) {
    if (target >= 18) {
      throw new Error(
        `El volumen ${volume} contiene los datos de PostgreSQL ${rootMajor} con el formato antiguo (anterior a 18) y la imagen solicitada es ${version}: Postgres 18+ no puede abrirlos directamente. Mantén la versión «${rootMajor}-alpine» en Ajustes para seguir funcionando, o migra los datos. ${migra}`,
      );
    }
    if (rootMajor !== target) {
      throw new Error(
        `El volumen ${volume} contiene los datos de PostgreSQL ${rootMajor} y la imagen solicitada es ${version}: una versión mayor no puede abrir los datos de otra. Vuelve a la versión «${rootMajor}-alpine» o migra los datos. ${migra}`,
      );
    }
    return; // datos y versión coinciden (layout <18): arranque normal
  }

  if (nestedMajor !== null) {
    throw new Error(
      `El volumen ${volume} contiene los datos de PostgreSQL ${nestedMajor} en el subdirectorio data/ (los escribió un Postgres <18 montado en la ruta de 18+, un estado que esta versión de Skyway ya no produce). Con el servicio detenido, muévelos a la raíz del volumen: docker run --rm -v ${volume}:/v busybox sh -c 'mv /v/data/* /v/ && rmdir /v/data' y utiliza la versión «${nestedMajor}-alpine»; o elimina el servicio con su volumen para empezar de cero.`,
    );
  }

  // Solo layout 18+ (N/docker): la propia imagen abre el mayor que coincida.
  if (target < 18 || !newLayoutMajors.includes(target)) {
    const found = [...new Set(newLayoutMajors)].join(', ');
    throw new Error(
      `El volumen ${volume} ya está inicializado con el formato de Postgres 18+ (datos de la versión ${found}) y la imagen solicitada es ${version}. Utiliza la versión «${found}-alpine» (o superior con pg_upgrade manual), o migra los datos. ${migra}`,
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
  const fila = getDeployment(deploymentId);
  const forceBuild = fila?.force_build === 1;
  // Commit concreto (reconstruir una versión cuya imagen ya se purgó): ni se
  // pregunta por la cabeza ni se reutiliza nada, se clona ese commit.
  const pinned = fila?.target_commit ?? null;
  const onSpawn = trackProc(job);

  // Atajo: si la cabeza de la rama ya se construyó con ÉXITO y con las mismas
  // entradas, la imagen resultante sería idéntica bit a bit. Redesplegar tras
  // cambiar una variable —el caso más frecuente— pasa de clonar y compilar
  // entero a no hacer nada. Se consulta la cabeza por API (barato) antes de
  // pedir hueco de build, así que ni siquiera ocupa un slot de compilación.
  if (!forceBuild && !pinned) {
    let reused = await reuseBuiltImage(service.id, cfg, token, buildKey, env, log);
    // Reutilizar la imagen no puede saltarse el manifiesto: el despliegue
    // vuelve a aplicar el `skyway.json` del commit (el que se guardó al
    // clonarlo, porque es el mismo) para que, p. ej., la URL propia se defina
    // al añadir el dominio y redesplegar, o se regenere un secreto borrado.
    if (reused && reconcileReusedBuild(service, cfg, log)) {
      env = resolveServiceEnv(service);
      const nuevaKey = buildKeyFor(service, cfg);
      const cambiadas = changedBuildVars(reused.build_vars, env);
      if (nuevaKey !== buildKey || cambiadas.length > 0) {
        // Ha definido variables que entran en la compilación (VITE_*, NEXT_PUBLIC_*…):
        // la imagen guardada no las lleva y hay que compilar.
        log('El manifiesto ha definido variables que forman parte de la compilación: se compila de nuevo.');
        buildKey = nuevaKey;
        reused = null;
      }
    }
    if (reused) {
      log(
        `El commit ${reused.commit_sha?.slice(0, 7) ?? '?'} ya está construido con esta configuración: se reutiliza la imagen ${reused.image_tag} ` +
          '(sin clonar ni compilar). Utiliza «Reconstruir» para forzar una compilación limpia.',
      );
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
      { repoUrl: cfg.repoUrl, branch: cfg.branch || 'main', token, dest: workDir, onSpawn, commit: pinned },
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
    if (recordNeeds(service, cfg, workDir, log)) {
      // El manifiesto ha definido variables (secretos generados, su URL): entran ya en este build.
      env = resolveServiceEnv(service);
      buildKey = buildKeyFor(service, cfg);
    }
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
  // El aviso de que se reutiliza lo da quien llama: antes vuelve a aplicar el
  // manifiesto, y eso puede obligar a compilar.
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
  const ultimo = listDeployments(serviceId, 25).find((d) => d.status === 'success');
  if (!ultimo) return null;
  // Un despliegue que volvió a desplegar una imagen sin compilar (una vuelta
  // atrás, la pestaña Correo, el cambio de dominio) de antes de que se copiara
  // la configuración a su fila: cuenta el que construyó esa imagen. Sin esto,
  // su fila sin configuración pasaba por un despliegue de antes de railway.json.
  const previo =
    ultimo.repo_config == null && ultimo.image_tag ? (deploymentForImage(serviceId, ultimo.image_tag) ?? ultimo) : ultimo;
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
export function applyRailwayCompatEnv(
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
  // RAILWAY_REPLICA_ID no va aquí: es distinta en cada copia (`conIdentidad`).
  // El «dominio privado» de Railway es el nombre por el que un servicio llega a
  // otro dentro del proyecto: aquí, su alias en la red del proyecto.
  put('RAILWAY_PRIVATE_DOMAIN', service.slug);
  if (internalPort) put('RAILWAY_TCP_PROXY_PORT', String(internalPort));
  // El mismo dominio principal que `PUBLIC_DOMAIN` (`systemVars`): dos
  // variables que dicen la dirección de la web no pueden discrepar.
  const principal = dominioPrincipal(domains, getSetting('rootDomain'));
  if (principal) {
    put('RAILWAY_PUBLIC_DOMAIN', principal);
    // El esquema lo decide quien enruta: sin correo de Let's Encrypt, Traefik
    // no monta el router seguro y prometer https lleva a un 404 con un
    // certificado que no es el del dominio.
    put('RAILWAY_STATIC_URL', `${tlsEnabled() ? 'https' : 'http'}://${principal}`);
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
        'sin selección explícita). Se guarda en Ajustes del servicio; modifícalo si la aplicación escucha en otro puerto.',
    );
    // Se persiste para que el panel, las etiquetas de Traefik y los despliegues
    // siguientes cuenten todos lo mismo, y para que esto deje de decidirse solo.
    updateService(service.id, service.name, { ...cfg, port: detectado, portAuto: undefined });
    return detectado;
  }

  log(
    `⚠ La imagen declara EXPOSE ${expuestos.join(', ')} y el puerto interno del servicio es ${configurado}. Si la ` +
      `aplicación escucha en el puerto que indica la imagen y no en ${configurado}, Traefik enrutará a un puerto sin proceso (502) ` +
      'aunque el despliegue se considere correcto. Se respeta el puerto configurado: modifícalo en Ajustes → Puerto interno si es necesario.',
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
  // Las etiquetas HTTPS dependen del correo REAL de Traefik (ver tls.ts): se
  // mira ahora y no con lo que se leyó hace un rato.
  await refreshTraefikAcme();

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

  if (service.type !== 'database') await noteImageVolumes(service, image, volumes, log);

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

  // Estrategia y parada, una vez por despliegue: `estrategiaEfectiva` lee las
  // variables del proyecto (¿lo llama otro servicio por la red interna?), y la
  // gracia sale del entorno RESUELTO, porque RAILWAY_DEPLOYMENT_DRAINING_SECONDS
  // puede llegar como variable compartida. Las paradas de este despliegue —la
  // versión anterior, la réplica que falla, las sobrantes— usan la misma gracia,
  // que también se fija como `StopTimeout` (la «--next», una más corta, ver
  // `retirarValidacion`). El healthcheck del repositorio cuenta como el de
  // Ajustes: es el que valida este despliegue.
  const estrategia = estrategiaEfectiva(service, repoConfig?.healthcheckPath ?? null);
  const gracia = graciaParada(service, env);
  const comando = comandoParada(service);
  const parar = (nombre: string) => pararConGracia(nombre, { graciaSegundos: gracia.segundos, comando, log });
  /**
   * La copia de validación «--next» se para con SIGTERM, pero SIN el comando al
   * parar: nunca ha atendido (lleva SKYWAY_VALIDATION=1) y la versión anterior
   * sigue en servicio. Un comando natural como dar de baja el webhook de un bot
   * (`deleteWebhook`) o soltar un registro global, ejecutado aquí, desharía lo
   * que la copia que sirve tiene hecho.
   *
   * Y con una gracia corta (la del servicio, hasta `GRACIA_VALIDACION_MAXIMA`):
   * no tiene peticiones que terminar, y con la gracia completa una copia que no
   * atiende SIGTERM alargaba cada despliegue «sin corte» hasta 30 s o, parada en
   * segundo plano, convivía con la versión anterior y la nueva (tres copias, el
   * triple de memoria).
   */
  const graciaValidacion = Math.min(gracia.segundos, GRACIA_VALIDACION_MAXIMA);
  const retirarValidacion = async () => {
    await pararConGracia(tempName, { graciaSegundos: graciaValidacion, comando: null, log });
    await removeContainer(tempName);
  };

  const spec: RunSpec = {
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
    stopGraceSeconds: gracia.segundos,
  };

  const name = containerName(project, service);
  const tempName = `${name}--next`;
  // El healthcheck del repositorio manda sobre el del panel, igual que el
  // comando de arranque: es config-as-code y viaja con el commit.
  const healthcheckPath: string | null =
    repoConfig?.healthcheckPath ?? (service.type !== 'database' ? (service.config as any).healthcheckPath || null : null);
  const envTimeout = Number(getEnv(service.id).RAILWAY_HEALTHCHECK_TIMEOUT_SEC);
  const declaredTimeout = repoConfig?.healthcheckTimeout ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : null);
  const probeTimeoutMs = declaredTimeout ? Math.min(Math.max(declaredTimeout, 5), 900) * 1000 : PROBE_TIMEOUT_MS;
  // Sin ruta de healthcheck, un servicio que recibe tráfico (dominio o puerto
  // público) se valida al menos con una sonda TCP a su puerto interno: antes
  // bastaba con que el proceso siguiera vivo 5 s, y una app que escuchaba en
  // otro puerto sustituía a la versión buena y dejaba el dominio en 502 con el
  // despliegue en verde. Solo en ese caso: un worker sin HTTP —los servicios de
  // repositorio tienen puerto 3000 por defecto— no escucha y fallaría.
  const tcpProbe = !healthcheckPath && !!internalPort && (domains.length > 0 || !!hostPort);

  // Comando previo al despliegue (donde casi todo el mundo pone las
  // migraciones). Va ANTES de tocar la versión en marcha: si falla, el
  // despliegue se aborta y lo que está sirviendo sigue igual, como en Railway.
  // También en «una sola copia»: es una orden puntual, no una copia del servicio.
  if (repoConfig?.preDeployCommand) {
    // Un contenedor más, con su propio RAILWAY_REPLICA_ID (antes lo recibía de
    // `applyRailwayCompatEnv`, que ya no lo pone: es distinto en cada copia).
    const envPrevio = env.RAILWAY_REPLICA_ID === undefined ? { ...env, RAILWAY_REPLICA_ID: randomUUID() } : env;
    await runPreDeploy(project, image, envPrevio, repoConfig.preDeployCommand, log, job);
  }

  // Restos de un intercambio cortado (Skyway cayó a mitad): con parada limpia.
  await limpiarRestosIntercambio(service, log);

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
  // Lo de Railway sobre el relevo se lee y se cuenta, pero no se aplica tal
  // cual: OVERLAP solo alarga el tiempo en que la versión anterior sigue viva
  // DESPUÉS de arrancar la nueva (con 0 tampoco hay «una sola copia»), que es
  // lo contrario de lo que necesita un bot. DRAINING sí tiene equivalente (la
  // gracia de parada) y se lee de la variable; el del fichero solo se informa.
  if (env.RAILWAY_DEPLOYMENT_OVERLAP_SECONDS !== undefined) {
    log(
      'ℹ Skyway no aplica RAILWAY_DEPLOYMENT_OVERLAP_SECONDS: en Railway solo alarga el tiempo en que la versión anterior sigue en ' +
        'marcha después de arrancar la nueva, y con 0 no evita que haya dos copias a la vez. Para que no las haya, elige la ' +
        'estrategia en Ajustes del servicio → Despliegue y parada.',
    );
  }
  const declaradosRepo = [
    repoConfig?.drainingSeconds != null ? `deploy.drainingSeconds (${repoConfig.drainingSeconds})` : null,
    repoConfig?.overlapSeconds != null ? `deploy.overlapSeconds (${repoConfig.overlapSeconds})` : null,
  ].filter((x): x is string => x !== null);
  if (declaradosRepo.length > 0) {
    log(
      `ℹ La configuración del repositorio declara ${declaradosRepo.join(' y ')}; Skyway no aplica estos valores: la estrategia y la ` +
        'gracia de parada se establecen en Ajustes del servicio → Despliegue y parada (la gracia, también con la variable ' +
        'RAILWAY_DEPLOYMENT_DRAINING_SECONDS).',
    );
  }

  const replicas = configuredReplicas(service);
  if (replicas > 1 && (volumes.length > 0 || hostPort)) {
    throw new Error(
      'Las réplicas requieren un servicio sin volúmenes y sin puerto público: varias copias no pueden compartir el mismo volumen de escritura ni el mismo puerto del host. Elimina esas opciones o vuelve a 1 réplica.',
    );
  }
  const motivoSinTrafico = replicas > 1 ? sinTrafico(service, estrategia, repoConfig?.healthcheckPath ?? null) : null;
  if (motivoSinTrafico === 'bot') {
    log(
      `ℹ El repositorio usa una biblioteca de bots de Telegram o Discord (${bibliotecasDeBot(service).join(', ')}): con ` +
        `${replicas} réplicas hay ${replicas} copias del bot en marcha a la vez de forma permanente, y un bot que pide ` +
        'actualizaciones (polling) o se conecta al gateway de Discord solo admite una. Vuelve a 1 réplica en Ajustes del servicio.',
    );
  } else if (motivoSinTrafico === 'sin_trafico') {
    log(
      `ℹ Este servicio no recibe tráfico (sin dominio, healthcheck ni llamadas de otros servicios): con ${replicas} réplicas hay ` +
        `${replicas} copias en marcha a la vez de forma permanente. Un bot de polling (Telegram, Discord…) solo admite una; un ` +
        'worker tiene que repartir el trabajo con SKYWAY_REPLICA y SKYWAY_REPLICAS o usar una cola.',
    );
  }

  log(
    `Estrategia: ${describirEstrategia(estrategia)}. Parada: ${comando ? 'comando al parar, ' : ''}SIGTERM y ${gracia.segundos} s de gracia` +
      `${gracia.origen === 'railway' ? ' (RAILWAY_DEPLOYMENT_DRAINING_SECONDS)' : ''}.`,
  );

  avisosDeEstrategia(service, estrategia, { domains, internalPort, healthcheckPath, comando }, log);

  if (estrategia.estrategia === 'overlap') {
    // «Sin corte»: la versión nueva convive con la vieja unos segundos. Solo
    // sin volúmenes ni puerto de host (`estrategiaDespliegue` lo garantiza):
    // nunca dos procesos escribiendo el mismo volumen.
    const oldExists = !!(await findContainer(name));
    if (oldExists) {
      log('Validando la versión nueva antes de sustituir la actual (la versión anterior sigue en servicio)...');
      // La copia de validación lleva su propia identidad y SKYWAY_VALIDATION=1:
      // una app puede saltarse en ella los efectos de arranque (registrar un
      // webhook, ocupar una cola) mientras la anterior sigue atendiendo.
      const validacion = conIdentidad(env, { replica: 1, total: replicas, validacion: true });
      await runServiceContainer({
        ...spec,
        env: validacion.env,
        identidad: { instancia: validacion.instancia, replica: 1 },
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
        verdict = await validateContainer(netName, `${service.slug}-next`, internalPort, healthcheckPath, tempName, log, probeTimeoutMs, null, job, tcpProbe);
      } catch (err) {
        // Cancelado a mitad: el contenedor de prueba no se queda vivo, y se
        // para como cualquier copia (SIGTERM y gracia), no de un SIGKILL.
        await retirarValidacion().catch(() => undefined);
        throw err;
      }
      if (!verdict.ok) {
        await appendContainerTail(tempName, log);
        await retirarValidacion();
        throw new Error(
          `La versión nueva no pasó la validación (${verdict.reason}). La versión anterior sigue en ejecución sin interrupción.`,
        );
      }
      // Validada: se retira ANTES del relevo, con su gracia corta. En segundo
      // plano convivía con la versión anterior y la nueva (tres copias); y la
      // versión anterior sigue en servicio mientras tanto, así que esperar no
      // deja el servicio sin atender.
      await retirarValidacion().catch((err: any) => {
        log(`⚠ No se pudo retirar la copia de validación ${tempName} (${err?.message || err}).`);
      });
      log(replicas > 1 ? `Versión validada. Actualización rodante de ${replicas} réplicas...` : 'Versión validada. Intercambiando sin corte...');
    }

    // Rolling update: réplica a réplica; todas comparten alias y labels de
    // Traefik, así que el balanceo entre copias es automático.
    // Con HEALTHCHECK en la imagen: cuánto puede tardar Docker en decidir.
    const dockerHealthcheckMs = await imageHealthcheckWindowMs(image);
    // Si alguna réplica se dio por buena sin poder comprobar que atendía.
    let sinComprobar = false;
    for (let i = 1; i <= replicas; i++) {
      const rn = replicaName(project, service, i);
      const rPrev = `${rn}--prev`;
      const hadOld = !!(await findContainer(rn));
      if (hadOld) await renameContainer(rn, rPrev);
      // Cada copia, su identidad: dos réplicas con el mismo id no pueden
      // repartirse el trabajo ni distinguirse en los registros.
      const copia = conIdentidad(env, { replica: i, total: replicas });
      try {
        await runServiceContainer({ ...spec, env: copia.env, identidad: { instancia: copia.instancia, replica: i }, nameOverride: rn });
        if (!oldExists && i === 1) {
          // Primer despliegue: no hay versión anterior que proteger, y esta es
          // la validación completa (con la política de reinicio del repo).
          const runtime = await settleContainer(rn, SETTLE_MS, job);
          // Una caída que la política del repositorio reintenta la juzga la
          // validación, con su margen; aquí solo cortan las definitivas.
          if (runtime.state !== 'running' && salidaDefinitiva(restartPolicy, runtime)) {
            throw new Error(`estado ${runtime.state}, código ${runtime.exitCode ?? 'n/a'}`);
          }
          const verdict = await validateContainer(netName, service.slug, internalPort, healthcheckPath, rn, log, probeTimeoutMs, restartPolicy, job, tcpProbe);
          if (!verdict.ok) throw new Error(verdict.reason);
        } else {
          // La versión ya pasó la validación en `--next`, pero ESTA copia acaba
          // de nacer en frío: la anterior no se retira hasta que atienda. Antes
          // solo se comprobaba que siguiera en marcha 1,5 s, y una app que
          // tardaba más en escuchar dejaba el dominio en 502 (o sin servidor,
          // si la imagen trae HEALTHCHECK) justo al retirar la anterior.
          const ready = await waitReplicaReady(
            { netName, containerRef: rn, port: internalPort, healthcheckPath, tcpProbe, dockerHealthcheckMs, timeoutMs: probeTimeoutMs },
            log,
            job,
          );
          if (!ready.ok) throw new Error(ready.reason);
          if (!ready.verified) sinComprobar = true;
        }
      } catch (err: any) {
        await appendContainerTail(rn, log);
        // Parada limpia sin el comando al parar, como la «--next»: la versión
        // anterior de esta réplica sigue (o vuelve a estar) en servicio, y el
        // comando de la copia que se descarta podría deshacer lo suyo.
        await pararConGracia(rn, { graciaSegundos: gracia.segundos, comando: null, log });
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
        // El monitor no toma por caída la parada de la versión anterior; y el
        // registro se archiva DESPUÉS de pararla, para que conserve lo que
        // escribió al recibir SIGTERM (su cierre ordenado, o por qué no lo hubo).
        markManualAction(service.id);
        await parar(rPrev);
        await archiveContainerLogs(rPrev);
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
      markManualAction(service.id);
      await parar(c.name);
      await archiveContainerLogs(c.name);
      await removeContainer(c.name);
    }
    if (!oldExists) log('Servicio en ejecución.');
    else if (sinComprobar) {
      log(
        'Intercambio completado. No se ha podido comprobar que la versión nueva atendiera antes de retirar la anterior ' +
          '(sin ruta de healthcheck, dominio ni puerto público): define una ruta de healthcheck para que el intercambio sea verificable.',
      );
    } else log('Intercambio completado sin interrupción del servicio.');
  } else {
    await desplegarUnaSolaCopia({
      project,
      service,
      spec,
      env,
      replicas,
      netName,
      internalPort,
      healthcheckPath,
      probeTimeoutMs,
      restartPolicy,
      tcpProbe,
      image,
      parar,
      graciaSegundos: gracia.segundos,
      log,
      job,
    });
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
        'Si el servicio sirve HTTP, indica su puerto en Ajustes del servicio → Puerto interno y vuelve a desplegar. Si es ' +
          'un worker sin HTTP, elimina el dominio: no es necesario.',
      );
    } else {
      log(`Dominios activos: ${domains.join(', ')} (dirección principal: ${dominioPrincipal(domains, getSetting('rootDomain'))})`);
      if (tlsBlocked()) {
        log(
          '⚠ El correo de Let\'s Encrypt está configurado en el panel, pero Traefik tiene uno de ejemplo (LETSENCRYPT_EMAIL ' +
            'del .env del servidor), que Let\'s Encrypt rechaza: no puede obtener certificados y los dominios se sirven por ' +
            'HTTP, sin redirección a HTTPS. Define un correo real en LETSENCRYPT_EMAIL (o déjalo vacío), recrea Traefik ' +
            '(docker compose up -d traefik) y vuelve a desplegar.',
        );
      }
    }
  }
  if (hostPort && internalPort) {
    log(`Puerto publicado: ${hostPort} → ${internalPort}`);
  }
}

/**
 * El manifiesto en un despliegue que reutiliza la imagen (sin clonar): se
 * aplica el `cfg.needs` guardado, que es el del mismo commit. Mismo trato que
 * en `recordNeeds`: un fallo aquí no tira el despliegue. Devuelve si ha
 * escrito variables.
 */
function reconcileReusedBuild(service: ServiceRow, cfg: GitConfig, log: (l: string) => void): boolean {
  try {
    return reconcileOnDeploy(service, cfg, log);
  } catch (err: any) {
    log(`ℹ No se pudo aplicar el manifiesto del repositorio: ${err?.message || err}`);
    return false;
  }
}

/**
 * Mira qué dependencias declara el repositorio recién clonado, lo guarda en la
 * config del servicio (para que la pestaña Variables lo convierta en
 * propuestas) y lo cuenta en el log del despliegue. De la detección solo
 * informa: la app arrancará igual sin `DATABASE_URL`, y eso es precisamente lo
 * que aquí se intenta que no pase en silencio. Del manifiesto `skyway.json`
 * aplica lo inofensivo y anota lo que requiere aprobación
 * (`reconcileOnDeploy`). Devuelve si ha escrito variables.
 */
function recordNeeds(service: ServiceRow, cfg: GitConfig, workDir: string, log: (l: string) => void): boolean {
  let needs: ReturnType<typeof detectNeeds>;
  try {
    needs = detectNeeds(workDir, cfg.rootDir);
  } catch (err: any) {
    log(`ℹ No se pudieron inspeccionar las dependencias del repositorio: ${err?.message || err}`);
    return false;
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
  let changed = false;
  try {
    changed = reconcileOnDeploy(service, cfg, log);
  } catch (err: any) {
    log(`ℹ No se pudo aplicar el manifiesto del repositorio: ${err?.message || err}`);
  }
  if (!needs) return changed;

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
  if (advice.mail && !needs.manifest) {
    const sinDefinir = advice.mail.vars.map((v) => v.name).filter((k) => !(k in getEnv(service.id)));
    log(
      `El servicio envía correo (${advice.mail.evidence.join(' · ')}).` +
        (sinDefinir.length > 0
          ? ` Faltan ${sinDefinir.join(', ')}: conéctalo desde Correo → Conectar a un servicio, que las escribe con esos nombres.`
          : ''),
    );
  }
  return changed;
}

/** Lo que necesita `desplegarUnaSolaCopia` del despliegue en curso. */
interface DespliegueUnaSolaCopia {
  project: ProjectRow;
  service: ServiceRow;
  spec: RunSpec;
  env: Record<string, string>;
  replicas: number;
  netName: string;
  internalPort: number | null;
  healthcheckPath: string | null;
  probeTimeoutMs: number;
  restartPolicy: RestartPolicySpec | null;
  tcpProbe: boolean;
  image: string;
  parar: (nombre: string) => Promise<ResultadoParada>;
  /** Gracia de la parada, para el aviso de la parada forzada. */
  graciaSegundos: number;
  log: (l: string) => void;
  job?: ActiveJob;
}

/** Índice de réplica de un nombre de copia (`<base>` = 1, `<base>-r3` = 3). */
function indiceCopia(nombre: string, base: string): number {
  return nombre === base ? 1 : Number(nombre.slice(base.length + 2)) || 0;
}

/**
 * «Una sola copia» (estrategia 'recreate'): se detienen TODAS las copias de la
 * versión anterior —en paralelo, con su parada limpia— antes de arrancar
 * ninguna nueva, y después arrancan las N nuevas. Sin copia de validación
 * «--next»: precisamente es la segunda copia lo que un bot de polling no
 * admite (Telegram responde 409 a la segunda que pide actualizaciones) y lo
 * que haría a un worker procesar dos veces el mismo trabajo.
 *
 * Es la rama «con estado» de siempre (volúmenes, puerto público, bases de
 * datos) generalizada a N réplicas: con una réplica hace lo mismo. Las copias
 * anteriores se apartan como «--prev» y, si cualquier copia nueva falla, se
 * paran y retiran las nuevas y se restauran TODAS las anteriores.
 */
async function desplegarUnaSolaCopia(o: DespliegueUnaSolaCopia): Promise<void> {
  const { project, service, log, job } = o;
  const base = containerName(project, service);
  const patron = new RegExp(`^${escapeRegExp(base)}(-r\\d+)?$`);
  const encontradas = new Set((await listServiceContainers(service.id)).map((c) => c.name).filter((n) => patron.test(n)));
  // La copia canónica también por su nombre, como antes: una copia sin la
  // etiqueta del servicio no puede quedarse en marcha junto a la nueva.
  if (!encontradas.has(base) && (await findContainer(base))) encontradas.add(base);
  const anteriores = [...encontradas].sort((a, b) => indiceCopia(a, base) - indiceCopia(b, base));
  const prev = (n: string) => `${n}--prev`;
  const apartadas: string[] = [];
  const nuevas: string[] = [];
  const dockerHealthcheckMs = o.replicas > 1 ? await imageHealthcheckWindowMs(o.image) : null;
  /** Motivo si no se pudo detener la versión anterior (y la nueva no llegó a arrancar). */
  let errorParada: string | null = null;

  try {
    if (anteriores.length > 0) {
      log(
        anteriores.length > 1
          ? `Una sola copia: se detienen las ${anteriores.length} copias de la versión anterior antes de arrancar la nueva...`
          : 'Una sola copia: se detiene la versión anterior antes de arrancar la nueva...',
      );
      for (const n of anteriores) {
        await renameContainer(n, prev(n));
        apartadas.push(n);
      }
      // El monitor no debe tomar por caída los segundos sin servicio.
      markManualAction(service.id);
      // Todas a la vez, y se espera a TODAS aunque alguna falle: con
      // `Promise.all`, la primera que fallaba disparaba la restauración mientras
      // las demás seguían parándose, y una copia «restaurada» (arrancar una
      // que sigue viva no hace nada) caía después por su parada pendiente.
      const paradas = await Promise.allSettled(anteriores.map((n) => o.parar(prev(n))));
      const rechazada = paradas.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (rechazada) {
        errorParada = String(rechazada.reason?.message || rechazada.reason);
        throw new Error(errorParada);
      }
      // Una parada forzada aquí es tiempo sin servicio en cada despliegue: se
      // recuerda en Alertas, fuera de este registro (o se cierra el aviso).
      const forzadas = paradas.filter((r) => r.status === 'fulfilled' && r.value.forzada).length;
      try {
        anotarParadaForzada(service, forzadas, o.graciaSegundos);
      } catch {
        /* un aviso no puede tirar el despliegue */
      }
      // Después de parar: el registro conserva lo que escribió al recibir SIGTERM.
      for (const n of anteriores) await archiveContainerLogs(prev(n));
      // Una parada no se puede cortar a mitad: un «Cancelar» durante ella
      // surte efecto aquí, y la versión anterior se restaura.
      if (job?.canceled) throw new CanceledError();
    }
    for (let i = 1; i <= o.replicas; i++) {
      const rn = replicaName(project, service, i);
      const copia = conIdentidad(o.env, { replica: i, total: o.replicas });
      nuevas.push(rn);
      await runServiceContainer({ ...o.spec, env: copia.env, identidad: { instancia: copia.instancia, replica: i }, nameOverride: rn });
      const etiqueta = o.replicas > 1 ? `réplica ${i}/${o.replicas}: ` : '';
      if (i === 1) {
        // La primera pasa la validación completa (healthcheck o sonda TCP, y
        // la política de reinicio del repositorio), como la rama con estado.
        const verdict = await validateContainer(
          o.netName,
          service.slug,
          o.internalPort,
          o.healthcheckPath,
          rn,
          log,
          o.probeTimeoutMs,
          o.restartPolicy,
          job,
          o.tcpProbe,
        );
        if (!verdict.ok) throw new Error(`${etiqueta}${verdict.reason}`);
      } else {
        const ready = await waitReplicaReady(
          {
            netName: o.netName,
            containerRef: rn,
            port: o.internalPort,
            healthcheckPath: o.healthcheckPath,
            tcpProbe: o.tcpProbe,
            dockerHealthcheckMs,
            timeoutMs: o.probeTimeoutMs,
          },
          log,
          job,
        );
        if (!ready.ok) throw new Error(`${etiqueta}${ready.reason}`);
      }
      if (o.replicas > 1) log(`Réplica ${i}/${o.replicas} lista.`);
    }
  } catch (err: any) {
    const cancelado = err instanceof CanceledError || !!job?.canceled;
    const fallida = nuevas[nuevas.length - 1];
    if (fallida && !cancelado) await appendContainerTail(fallida, log);
    for (const n of nuevas) {
      await o.parar(n).catch(() => undefined);
      await removeContainer(n).catch(() => undefined);
    }
    const sinRestaurar: string[] = [];
    if (apartadas.length > 0) {
      log(cancelado ? 'Despliegue cancelado: restaurando la versión anterior...' : 'La versión nueva falló: restaurando la anterior...');
      for (const n of apartadas) {
        try {
          await renameContainer(prev(n), n);
          await startContainer(n);
        } catch (e: any) {
          sinRestaurar.push(n);
          log(`⚠ No se pudo restaurar ${n} (${e?.message || e}).`);
        }
      }
    }
    // La cancelación sigue siendo una cancelación (el despliegue queda como
    // cancelado, no como fallido), con la versión anterior ya restaurada.
    if (cancelado) throw err instanceof CanceledError ? err : new CanceledError();
    const motivo = err?.message || String(err);
    if (apartadas.length === 0) {
      throw new Error(`El contenedor terminó inesperadamente (${motivo}). Consulta el registro del servicio.`);
    }
    if (errorParada !== null && sinRestaurar.length === 0) {
      throw new Error(
        `No se pudo detener la versión anterior (${errorParada}): sigue en servicio y no se ha arrancado la nueva. ` +
          'Comprueba que Docker responde y vuelve a desplegar.',
      );
    }
    if (sinRestaurar.length > 0) {
      throw new Error(
        `La versión nueva falló (${motivo}) y no se pudo restaurar la versión anterior (${sinRestaurar.join(', ')}): ` +
          'consulta el registro del despliegue y vuelve a desplegar.',
      );
    }
    throw new Error(`La versión nueva falló (${motivo}). Se restauró la versión anterior automáticamente.`);
  }
  for (const n of anteriores) await removeContainer(prev(n));
  log(anteriores.length > 0 ? 'Versión nueva en marcha (una sola copia: la anterior se detuvo antes de arrancarla).' : 'Servicio en ejecución.');
}

/**
 * Lo que la regla automática no puede ver, dicho en el registro cuando importa:
 *
 *  - Un bot de Telegram o Discord sin dominio va a «una sola copia» aunque
 *    tenga healthcheck o lo llamen otros servicios: si lo llaman, esas llamadas
 *    fallan durante el relevo, y se dice.
 *  - Un bot de Telegram o Discord CON dominio queda en «sin corte» (puede
 *    recibir webhooks, y entonces dos copias no se pisan); si en realidad pide
 *    actualizaciones (polling), con dos copias recibe un 409.
 *  - Un servicio con puerto que pasa a «una sola copia» de forma automática:
 *    una llamada escrita en el código o en la configuración de otro servicio
 *    (un `proxy_pass` de nginx, una dirección montada en el código) no se detecta, y ese
 *    servicio tendría unos segundos sin servicio en cada despliegue.
 *  - «Sin corte» con comando al parar: el de la versión anterior se ejecuta
 *    cuando la nueva ya está en servicio.
 */
function avisosDeEstrategia(
  service: ServiceRow,
  estrategia: EstrategiaServicio,
  d: { domains: string[]; internalPort: number | null; healthcheckPath: string | null; comando: string | null },
  log: (l: string) => void,
): void {
  const bots = bibliotecasDeBot(service);
  if (estrategia.motivo === 'bot') {
    const llamado = llamadoPorOtros(service);
    log(
      `ℹ Una sola copia elegida automáticamente: el repositorio usa una biblioteca de bots (${bots.join(', ')}) y el servicio no ` +
        'tiene dominio, así que el bot pide sus actualizaciones (polling) o se conecta al gateway de Discord, y dos copias a la vez ' +
        'se pisan.' +
        (d.healthcheckPath || llamado
          ? ` ${llamado ? 'Otro servicio lo llama por la red interna: esas llamadas fallarán' : 'Su healthcheck no recibirá respuesta'} ` +
            'mientras se detiene la versión anterior y arranca la nueva. Si el bot recibe webhooks a través de otro servicio, ' +
            'elige «Sin corte» en Ajustes del servicio → Despliegue y parada.'
          : ''),
    );
  }
  if (estrategia.estrategia === 'overlap' && estrategia.automatica && d.domains.length > 0 && bots.length > 0) {
    log(
      `ℹ El repositorio usa una biblioteca de bots (${bots.join(', ')}) y el servicio se despliega «sin corte» por su dominio: si ` +
        'el bot recibe webhooks, dos copias no se pisan; si pide actualizaciones (polling), la segunda recibe un error 409 durante ' +
        'el intercambio. En ese caso, elige «Una sola copia» en Ajustes del servicio → Despliegue y parada.',
    );
  }
  if (estrategia.estrategia === 'recreate' && estrategia.motivo === 'sin_trafico' && d.internalPort) {
    log(
      'ℹ Una sola copia elegida automáticamente: el servicio no tiene dominio ni ruta de healthcheck (en Ajustes o en el ' +
        'repositorio), y ninguna variable de otro servicio apunta a él. Si otro servicio lo llama por la red interna desde su ' +
        'código o su configuración (por ejemplo, un proxy_pass de nginx), elige «Sin corte» en Ajustes del servicio → ' +
        'Despliegue y parada para que no haya corte al desplegar.',
    );
  }
  if (estrategia.estrategia === 'overlap' && d.comando) {
    log(
      'ℹ Con «sin corte», el comando al parar de la versión anterior se ejecuta cuando la nueva ya está en servicio (en la ' +
        'copia de validación no se ejecuta): no debe deshacer lo que la nueva registra al arrancar, como el webhook de un bot.',
    );
  }
}

/**
 * ¿Recibe tráfico el servicio, al margen de la estrategia que se haya elegido?
 * Con varias réplicas y sin tráfico (sin dominio, healthcheck ni llamadas de
 * otros servicios) hay N copias en marcha a la vez de forma permanente, y eso
 * vale la pena decirlo también a quien eligió «una sola copia» a mano.
 */
function sinTrafico(service: ServiceRow, estrategia: EstrategiaServicio, healthcheckRepo: string | null): 'sin_trafico' | 'bot' | null {
  if (estrategia.motivo === 'sin_trafico' || estrategia.motivo === 'bot') return estrategia.motivo;
  if (estrategia.motivo !== 'elegida') return null;
  const sinEleccion = { ...service, config: { ...service.config, deployStrategy: undefined } } as ServiceRow;
  const motivo = estrategiaDespliegue(sinEleccion, llamadoPorOtros(service), healthcheckRepo).motivo;
  return motivo === 'sin_trafico' || motivo === 'bot' ? motivo : null;
}

/**
 * Copia del entorno con la identidad de ESTA copia (no modifica `env`).
 *
 * `SKYWAY_DEPLOYMENT` y `RAILWAY_DEPLOYMENT_ID` son iguales en todas las copias
 * de un despliegue, y `RAILWAY_REPLICA_ID` también lo era (el id del
 * despliegue): dos réplicas no podían distinguirse, ni la copia de validación
 * de la que sirve. Cada contenedor recibe ahora un UUID propio
 * (`SKYWAY_INSTANCE_ID`, nuevo en cada despliegue), su índice y el total
 * (`SKYWAY_REPLICA`/`SKYWAY_REPLICAS`, para repartir el trabajo) y, solo la
 * copia de validación «--next», `SKYWAY_VALIDATION=1`. `RAILWAY_REPLICA_ID`
 * pasa a ser la instancia, como en Railway, salvo que el usuario la defina.
 */
export function conIdentidad(
  env: Record<string, string>,
  opts: { replica: number; total: number; validacion?: boolean },
): { env: Record<string, string>; instancia: string } {
  const instancia = randomUUID();
  const out: Record<string, string> = {
    ...env,
    SKYWAY_INSTANCE_ID: instancia,
    SKYWAY_REPLICA: String(opts.replica),
    SKYWAY_REPLICAS: String(opts.total),
  };
  if (opts.validacion) out.SKYWAY_VALIDATION = '1';
  else delete out.SKYWAY_VALIDATION;
  if (out.RAILWAY_REPLICA_ID === undefined) out.RAILWAY_REPLICA_ID = instancia;
  return { env: out, instancia };
}

const SUFIJO_NEXT = '--next';
const SUFIJO_PREV = '--prev';

/** ¿Tiene el servicio un despliegue en cola o en marcha? */
export function despliegueEnCurso(serviceId: string): boolean {
  return activeDeploymentIdsForServices([serviceId]).length > 0;
}

/** Estado del despliegue que creó un contenedor (etiqueta `skyway.deployment`), o null si no se sabe. */
function estadoDespliegueDe(info: { Config?: { Labels?: Record<string, string> | null } } | null): DeploymentRow['status'] | null {
  const id = info?.Config?.Labels?.['skyway.deployment'];
  return id ? (deploymentSummary(id)?.status ?? null) : null;
}

/**
 * Retira, con parada limpia, los restos de un intercambio interrumpido (Skyway
 * cayó o se apagó a mitad de un despliegue):
 *  - «--next» (copia de validación) → parar y retirar;
 *  - «--prev» con su copia base presente → se decide por la etiqueta
 *    `skyway.deployment` de las dos. Si la base es de un despliegue que no
 *    terminó bien y la «--prev» de uno correcto, Skyway cayó mientras validaba
 *    la versión nueva: se para y retira la base y la «--prev» vuelve a su
 *    nombre, porque es la que funcionaba. En cualquier otro caso (la base es de
 *    un despliegue correcto, o no se sabe) se para y retira la «--prev»;
 *  - «--prev» sin base → vuelve a su nombre: es la única versión que hay.
 *
 * La copia que vuelve a su nombre se arranca, salvo que el servicio esté
 * parado a propósito o que la limpieza la pida «Detener» (`sinArrancar`).
 *
 * Antes solo se hacía al principio del despliegue siguiente, con `remove
 * --force` (SIGKILL) y quedándose siempre con la base: con «una sola copia»,
 * una caída durante la validación tiraba la versión buena y dejaba en servicio
 * la nueva sin validar (y quizá parada: la cancelación ya le había mandado
 * SIGTERM). Un bot podía además seguir con dos copias vivas hasta el próximo
 * despliegue, y Detener no las alcanzaba. Devuelve lo hecho, en texto (también
 * va a `log`). Un resto que no se puede tratar se registra y no impide tratar
 * los demás.
 */
export async function limpiarRestosIntercambio(
  service: ServiceRow,
  log?: (l: string) => void,
  opts: { sinArrancar?: boolean } = {},
): Promise<string[]> {
  let contenedores: { name: string }[];
  try {
    contenedores = await listServiceContainers(service.id);
  } catch {
    return [];
  }
  const restos = contenedores
    .map((c) => c.name)
    .filter((n) => n.endsWith(SUFIJO_NEXT) || n.endsWith(SUFIJO_PREV))
    // Primero las copias de validación: nunca son la versión que se queda.
    .sort((a, b) => Number(b.endsWith(SUFIJO_NEXT)) - Number(a.endsWith(SUFIJO_NEXT)));
  if (restos.length === 0) return [];
  let env: Record<string, string> = {};
  try {
    env = resolveServiceEnv(service);
  } catch {
    /* sin entorno resuelto, la gracia del servicio o la de por defecto */
  }
  const graciaSegundos = graciaParada(service, env).segundos;
  const comando = comandoParada(service);
  const arrancar = !service.stopped_at && !opts.sinArrancar;
  const hecho: string[] = [];
  const anotar = (texto: string) => {
    hecho.push(texto);
    log?.(texto);
  };
  /** La «--prev» vuelve a su nombre (y se arranca si toca). */
  const recuperar = async (nombre: string, base: string, motivo: string) => {
    await renameContainer(nombre, base);
    if (arrancar) await startContainer(base);
    anotar(`${motivo}: ${base} vuelve a su nombre${arrancar ? ' y queda en marcha' : ''}.`);
  };
  for (const nombre of restos) {
    if (nombre.endsWith(SUFIJO_NEXT)) {
      try {
        // Sin el comando al parar: la copia de validación nunca atendió.
        await pararConGracia(nombre, { graciaSegundos, comando: null, log });
        await removeContainer(nombre);
        anotar(`Retirada la copia de validación ${nombre} de un intercambio interrumpido.`);
      } catch (err: any) {
        anotar(`⚠ No se pudo retirar ${nombre} (${err?.message || err}).`);
      }
      continue;
    }
    const base = nombre.slice(0, -SUFIJO_PREV.length);
    const infoBase = await findContainer(base);
    if (!infoBase) {
      try {
        await recuperar(nombre, base, 'Recuperado un intercambio interrumpido');
      } catch (err: any) {
        anotar(`⚠ No se pudo recuperar ${nombre} (${err?.message || err}).`);
      }
      continue;
    }
    const estadoBase = estadoDespliegueDe(infoBase);
    const estadoPrev = estadoDespliegueDe(await findContainer(nombre));
    const baseSinValidar = estadoBase !== null && estadoBase !== 'success' && estadoPrev === 'success';
    try {
      if (baseSinValidar) {
        // La base es la versión nueva de un despliegue cortado: se para (con su
        // comando: pudo llegar a atender), se archiva su registro y se retira.
        await pararConGracia(base, { graciaSegundos, comando, log });
        await archiveContainerLogs(base);
        await removeContainer(base);
        await recuperar(nombre, base, 'Recuperada la versión anterior de un despliegue interrumpido antes de terminar la validación');
      } else {
        await pararConGracia(nombre, { graciaSegundos, comando, log });
        await removeContainer(nombre);
        anotar(`Retirada la versión anterior ${nombre} de un intercambio interrumpido.`);
      }
    } catch (err: any) {
      anotar(
        baseSinValidar
          ? `⚠ No se pudo recuperar la versión anterior ${nombre} (${err?.message || err}).`
          : `⚠ No se pudo retirar ${nombre} (${err?.message || err}).`,
      );
    }
  }
  return hecho;
}

/**
 * La misma limpieza, por la cola de despliegues del servicio (`deploy:<id>`) y
 * esperando a que termine. La usan Detener, Iniciar y Reiniciar: así nunca
 * coincide con la que encola el arranque de Skyway sobre los mismos restos (las
 * dos acababan en 404 y 409 sueltos).
 */
export function limpiarRestosEnCola(
  service: ServiceRow,
  log?: (l: string) => void,
  opts: { sinArrancar?: boolean } = {},
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    void enqueue(`deploy:${service.id}`, async () => {
      try {
        // Releída en la cola: lo que hubiera delante puede haberla cambiado.
        resolve(await limpiarRestosIntercambio(getService(service.id) ?? service, log, opts));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Al arrancar Skyway: los contenedores «--next»/«--prev» que dejó un
 * intercambio cortado por el reinicio. Hasta ahora solo los limpiaba el
 * despliegue siguiente del servicio, así que un bot podía seguir con dos
 * copias vivas (y una de ellas, la de validación, sin el resto de su
 * configuración) indefinidamente.
 *
 * La limpieza va por la cola de despliegues del servicio (`deploy:<id>`): el
 * reintento automático del despliegue cortado (`resumeInterruptedDeployments`,
 * que se llama después) se encola detrás y nunca coincide con ella. No espera
 * a las paradas, para no retrasar el arranque. Los restos de un servicio que
 * ya no existe se dejan como están y se avisa.
 */
export async function limpiarIntercambiosAlArrancar(
  log: (msg: string) => void,
): Promise<{ servicios: number; contenedores: number }> {
  const lista = await dockerQuery.listContainers({ all: true, filters: { label: ['skyway.managed=true'] } as any });
  const porServicio = new Map<string, string[]>();
  for (const c of lista) {
    const nombre = (c.Names?.[0] || '').replace(/^\//, '');
    if (!nombre.endsWith(SUFIJO_NEXT) && !nombre.endsWith(SUFIJO_PREV)) continue;
    const serviceId = c.Labels?.['skyway.service'];
    if (!serviceId) continue;
    porServicio.set(serviceId, [...(porServicio.get(serviceId) ?? []), nombre]);
  }
  let servicios = 0;
  let contenedores = 0;
  for (const [serviceId, nombres] of porServicio) {
    const service = getService(serviceId);
    if (!service) {
      log(`Restos de un intercambio de un servicio que ya no existe: ${nombres.join(', ')}. No se tocan; retíralos a mano si no los necesitas.`);
      continue;
    }
    servicios += 1;
    contenedores += nombres.length;
    void enqueue(`deploy:${serviceId}`, async () => {
      // Releída en la cola: la de antes de encolar puede haber cambiado.
      const actual = getService(serviceId);
      if (!actual) return;
      try {
        await limpiarRestosIntercambio(actual, (l) => log(`«${actual.name}»: ${l}`));
      } catch (err: any) {
        log(`«${actual.name}»: no se pudieron retirar los restos de un intercambio (${err?.message || err}).`);
      }
    });
  }
  return { servicios, contenedores };
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

  /**
   * true si `host:port` acepta conexiones TCP. Sirve para los servicios sin
   * ruta de healthcheck: no dice que la app esté bien, pero sí que escucha en
   * el puerto al que Traefik va a enrutar. Host y puerto viajan por entorno.
   */
  async probeTcp(host: string, port: number): Promise<boolean> {
    if (!this.id) return false;
    try {
      const res = await execInContainer(this.id, 'nc -z -w 3 "$SKYWAY_PROBE_HOST" "$SKYWAY_PROBE_PORT"', {
        timeoutMs: PROBE_ATTEMPT_TIMEOUT_MS,
        maxOutput: 1000,
        env: [`SKYWAY_PROBE_HOST=${host}`, `SKYWAY_PROBE_PORT=${port}`],
      });
      return res.exitCode === 0;
    } catch {
      return false;
    }
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
/** Tope de la espera al «healthy» de Docker (el mismo que el del healthcheck del servicio). */
const DOCKER_HEALTH_MAX_MS = 900_000;

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

type RestartPolicySpec = { Name: string; MaximumRetryCount?: number };

/**
 * ¿Es definitiva esta parada al arrancar? Si el repositorio declaró una
 * política que reintenta, una salida temprana es Docker haciendo lo que se le
 * pidió (una base que aún no acepta conexiones, por ejemplo), y no un veredicto.
 * Solo es definitiva sin esa política, si el contenedor ya no existe, o con
 * `on-failure` cuando salió con 0 (Docker no lo reinicia) o agotó sus reintentos.
 */
function salidaDefinitiva(restartPolicy: RestartPolicySpec | null, runtime: Awaited<ReturnType<typeof getRuntime>>): boolean {
  if (!restartPolicy || restartPolicy.Name === 'no') return true;
  if (runtime.state === 'not_created') return true;
  if (restartPolicy.Name === 'on-failure' && runtime.state === 'exited') {
    if (runtime.exitCode === 0) return true;
    const max = restartPolicy.MaximumRetryCount ?? 0;
    if (max > 0 && runtime.restartCount >= max) return true;
  }
  return false;
}

/**
 * Valida un contenedor recién arrancado: sonda HTTP al healthcheck si está
 * configurado; si no, y el servicio recibe tráfico (`tcpProbe`), una sonda TCP
 * a su puerto interno; y si no, un periodo de gracia comprobando que sigue vivo.
 * En los tres casos se respeta la política de reinicio del repositorio.
 */
async function validateContainer(
  netName: string,
  aliasHost: string,
  port: number | null,
  healthcheckPath: string | null,
  containerRef: string,
  log: (l: string) => void,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  restartPolicy: RestartPolicySpec | null = null,
  job?: ActiveJob,
  tcpProbe = false,
): Promise<{ ok: boolean; reason: string }> {
  // Cancelar tiene que surtir efecto también aquí: son los bucles más largos
  // del despliegue (hasta cinco minutos) y no tienen proceso hijo que matar.
  const checkCanceled = () => {
    if (job?.canceled) throw new CanceledError();
  };

  if ((healthcheckPath || tcpProbe) && port) {
    const path = healthcheckPath ? (healthcheckPath.startsWith('/') ? healthcheckPath : `/${healthcheckPath}`) : null;
    const url = path ? `http://${aliasHost}:${port}${path}` : null;
    const plazo = Math.round(timeoutMs / 1000);
    log(
      url
        ? `Esperando healthcheck 2xx en ${url} (hasta ${plazo}s)...`
        : `Sin healthcheck configurado: se espera a que el puerto interno ${port} acepte conexiones (hasta ${plazo}s). ` +
            'Una ruta de healthcheck permite comprobar además que la aplicación responde.',
    );
    await pullImage(PROBE_IMAGE, log, job, { quietIfPresent: true });
    const probe = new HealthProbe(netName, `${containerRef}--probe`);
    await probe.start(Math.ceil(timeoutMs / 1000) + 60);
    try {
      const inicio = Date.now();
      const deadline = inicio + timeoutMs;
      let attempts = 0;
      // Caídas al arrancar que la política del repositorio reintenta: se espera
      // como en el periodo de gracia. Un servicio con dominio y sin healthcheck
      // iba antes por ese camino; cortar aquí al primer tropiezo tumbaba
      // despliegues que se habrían recuperado solos.
      let caido = false;
      let avisado = false;
      // Desde cuándo sigue en pie sin caerse: tras un reinicio, el margen de
      // «escuchar no basta» vuelve a contar desde cero.
      let enPieDesde: number | null = inicio;
      const reintentoEnCurso = (rt: Awaited<ReturnType<typeof getRuntime>>): boolean => {
        if (salidaDefinitiva(restartPolicy, rt)) return false;
        // Acotado como el periodo de gracia: un bucle de reinicios no puede
        // agotar un plazo de sonda de varios minutos.
        if (Date.now() - inicio >= RESTART_WINDOW_MS) return false;
        caido = true;
        enPieDesde = null;
        if (!avisado) {
          log('El proceso finalizó al arrancar; Docker lo reintenta según la política del repositorio. Esperando a que se estabilice...');
          avisado = true;
        }
        return true;
      };
      // Sin espera previa: hay procesos que ya responden al instante y esperar
      // un segundo «por si acaso» se lo cobraba a TODOS los despliegues.
      while (Date.now() < deadline) {
        checkCanceled();
        attempts += 1;
        const state = await getRuntime(containerRef);
        if (state.state !== 'running') {
          if (reintentoEnCurso(state)) {
            await sleep(probeDelay(attempts));
            continue;
          }
          return {
            ok: false,
            reason: caido
              ? `no llegó a atender en ${Math.round((Date.now() - inicio) / 1000)}s: continúa finalizando y reiniciándose (código ${state.exitCode ?? 'n/a'})`
              : `el proceso finalizó durante el arranque (código ${state.exitCode ?? 'n/a'})`,
          };
        }
        caido = false;
        if (enPieDesde === null) enPieDesde = Date.now();
        if (url ? await probe.probe(url) : await probe.probeTcp(aliasHost, port)) {
          if (url) {
            log(`Healthcheck superado en el intento ${attempts}.`);
            return { ok: true, reason: 'ok' };
          }
          log(`El puerto ${port} acepta conexiones (intento ${attempts}).`);
          // Escuchar no basta si se cae enseguida: el mismo margen que sin sonda.
          const resto = GRACE_MS - (Date.now() - enPieDesde);
          if (resto > 0) {
            const rt = await settleContainer(containerRef, resto, job);
            if (rt.state !== 'running') {
              if (reintentoEnCurso(rt)) continue;
              return { ok: false, reason: `el proceso terminó enseguida (estado ${rt.state}, código ${rt.exitCode ?? 'n/a'})` };
            }
          }
          return { ok: true, reason: 'ok' };
        }
        await sleep(probeDelay(attempts));
      }
      return {
        ok: false,
        reason: caido
          ? `no llegó a atender en ${plazo}s: continúa finalizando y reiniciándose`
          : path
            ? `el healthcheck ${path} no respondió 2xx en ${plazo}s`
            : `el puerto interno ${port} no aceptó conexiones en ${plazo}s: la aplicación no escucha en ese puerto ` +
              '(comprueba que use la variable PORT o corrige el puerto interno en Ajustes del servicio)',
      };
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
      if (salidaDefinitiva(restartPolicy, runtime)) {
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

/**
 * Espera a que una réplica recién creada atienda antes de retirar la versión
 * anterior. `verified` dice si se ha podido comprobar de verdad (sin puerto que
 * sondear, solo se mira que siga en marcha un momento).
 *
 *  - Si la imagen declara HEALTHCHECK, hasta que Docker la marque «healthy»:
 *    Traefik no le envía tráfico antes, y retirar la anterior deja el dominio
 *    sin servidor. El plazo es el mayor entre el del servicio y lo que Docker
 *    puede tardar en decidir con ese HEALTHCHECK (`dockerHealthcheckMs`).
 *  - Si no, la misma sonda que validó la versión (HTTP o TCP), contra ESTA
 *    copia por su nombre de contenedor en la red del proyecto.
 */
async function waitReplicaReady(
  opts: {
    netName: string;
    containerRef: string;
    port: number | null;
    healthcheckPath: string | null;
    tcpProbe: boolean;
    /** Lo que puede tardar Docker en dar veredicto con el HEALTHCHECK de la imagen; null sin él. */
    dockerHealthcheckMs: number | null;
    timeoutMs: number;
  },
  log: (l: string) => void,
  job?: ActiveJob,
): Promise<{ ok: boolean; reason: string; verified: boolean }> {
  const { containerRef, timeoutMs } = opts;
  if (opts.dockerHealthcheckMs !== null) {
    // El primer chequeo de Docker no llega hasta pasado su `interval`: con solo
    // el plazo del servicio (que puede ser de 5 s), una versión buena acababa
    // siempre en «no la marcó como healthy» y se restauraba la anterior.
    const esperaMs = Math.min(Math.max(timeoutMs, opts.dockerHealthcheckMs), DOCKER_HEALTH_MAX_MS);
    log(`La imagen declara HEALTHCHECK: se espera a que Docker marque ${containerRef} como «healthy» (hasta ${Math.round(esperaMs / 1000)}s) antes de retirar la versión anterior...`);
    const deadline = Date.now() + esperaMs;
    while (Date.now() < deadline) {
      if (job?.canceled) throw new CanceledError();
      const h = await containerHealth(containerRef);
      if (h.state !== 'running') {
        return { ok: false, reason: `el proceso finalizó durante el arranque (código ${h.exitCode ?? 'n/a'})`, verified: false };
      }
      if (h.health === 'healthy') {
        log(`${containerRef} está «healthy».`);
        return { ok: true, reason: 'ok', verified: true };
      }
      if (h.health === 'unhealthy') {
        return { ok: false, reason: 'Docker la ha marcado como «unhealthy» (HEALTHCHECK de la imagen)', verified: false };
      }
      // Sin estado de salud el contenedor no tiene HEALTHCHECK: se sigue con la sonda.
      if (h.health === null) break;
      await sleep(GRACE_CHECK_MS * 2);
    }
    if (Date.now() >= deadline) {
      return { ok: false, reason: `Docker no la marcó como «healthy» en ${Math.round(esperaMs / 1000)}s`, verified: false };
    }
  }
  if ((opts.healthcheckPath || opts.tcpProbe) && opts.port) {
    const verdict = await validateContainer(
      opts.netName,
      containerRef,
      opts.port,
      opts.healthcheckPath,
      containerRef,
      log,
      timeoutMs,
      null,
      job,
      opts.tcpProbe,
    );
    return { ...verdict, verified: verdict.ok };
  }
  const runtime = await settleContainer(containerRef, SETTLE_MS, job);
  if (runtime.state !== 'running') {
    return { ok: false, reason: `estado ${runtime.state}, código ${runtime.exitCode ?? 'n/a'}`, verified: false };
  }
  return { ok: true, reason: 'ok', verified: false };
}

/**
 * Rutas que la imagen guarda con VOLUME y que el servicio no monta: su
 * contenido empieza de cero en cada despliegue (Docker crea un volumen anónimo
 * por contenedor y el anterior queda huérfano, con los datos dentro). Se avisa
 * en el log y se guarda la lista en la config del servicio para que Ajustes
 * ofrezca añadir el volumen. Nunca se crea solo: con volúmenes el intercambio
 * deja de ser sin corte, y eso lo decide quien administra el servicio.
 */
async function noteImageVolumes(
  service: ServiceRow,
  image: string,
  volumes: { containerPath: string }[],
  log: (l: string) => void,
): Promise<void> {
  const declared = await imageDeclaredVolumes(image);
  const mounted = new Set(volumes.map((v) => normalizeContainerPath(v.containerPath)));
  for (const ruta of declared.filter((p) => !mounted.has(p))) {
    log(
      `⚠ La imagen guarda datos en ${ruta} (VOLUME) y el servicio no tiene un volumen en esa ruta: su contenido se reinicia en ` +
        'cada despliegue (el anterior queda en un volumen anónimo huérfano). Añádelo en Ajustes del servicio → Volúmenes persistentes.',
    );
  }
  // Releyendo la fila, para no pisar un ajuste guardado durante el build.
  const fresh = getService(service.id);
  if (!fresh) return;
  const cfg = fresh.config as GitConfig | ImageConfig;
  if (JSON.stringify(cfg.imageVolumes ?? []) === JSON.stringify(declared)) return;
  const next = { ...cfg };
  if (declared.length > 0) next.imageVolumes = declared;
  else delete next.imageVolumes;
  updateService(fresh.id, fresh.name, next);
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

/** Imágenes correctas que se conservan por defecto (las de los últimos despliegues buenos). */
export const DEFAULT_KEEP_IMAGES = 5;

/**
 * Cuántas versiones se conservan para poder volver a ellas sin compilar
 * (ajuste `keepImages`, de 1 a 50). Cada una ocupa su imagen en disco.
 */
export function keepImages(): number {
  const n = Number(getSetting('keepImages'));
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : DEFAULT_KEEP_IMAGES;
}

/**
 * Purga las imágenes de despliegues antiguos. Varias filas comparten etiqueta
 * —la imagen se reutiliza cuando el commit ya estaba construido—, así que una
 * fila «antigua» puede apuntar a la imagen que se está sirviendo AHORA: se
 * conservan las etiquetas de los últimos despliegues correctos y la que corre
 * cada réplica, y solo se borra lo que no referencia ninguna de ellas.
 */
async function cleanupOldImages(project: ProjectRow, service: ServiceRow, log: (l: string) => void): Promise<void> {
  try {
    const conservar = keepImages();
    const stale = successfulDeploymentsBeyond(service.id, conservar);
    if (stale.length === 0) return;
    const keep = new Set<string>();
    for (const d of listDeployments(service.id, Math.max(50, conservar * 4)).filter((d) => d.status === 'success' && d.image_tag).slice(0, conservar)) {
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
      log(`Purgadas ${doomed.size} imágenes antiguas (se conservan las de los últimos ${conservar} despliegues correctos)`);
    }
  } catch {
    // best-effort
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
