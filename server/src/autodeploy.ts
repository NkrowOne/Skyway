import { AUTODEPLOY_ALERT_TYPE, fireAlert, resolveServiceAlerts } from './alerts';
import { auditSystem } from './audit';
import {
  AutoDeployStateRow,
  forgetAutoDeployStates,
  getAutoDeployState,
  getSetting,
  lastAttemptedCommitSha,
  latestDeployment,
  listAutoDeployStates,
  listProjects,
  listServicesForProjects,
  recordAutoDeployFailure,
  recordAutoDeployOk,
} from './db';
import { remoteHeadSha } from './deploy/builder';
import { triggerDeploy } from './deploy/deployer';
import { apiHeadSha, parseGithubSlug } from './github/client';
import { resolveGitToken } from './github/resolve';
import { dockerAvailable } from './docker/client';
import { markManualAction } from './monitor';
import { GitConfig, ProjectRow } from './types';
import { pooled } from './util';

// El sondeo por API con ETag es tan barato (un 304 no consume cuota ni arranca
// un proceso) que se puede mirar cada minuto sin coste apreciable: un push sin
// webhook tarda como mucho un minuto en salir, no dos.
const DEFAULT_POLL_SECONDS = 60;
const MIN_POLL_SECONDS = 15;
/**
 * Primer sondeo tras arrancar. Con el intervalo completo (60 s), un push hecho
 * durante un `skyway update` tardaba hasta dos minutos en salir; unos segundos
 * bastan para que el servidor termine de levantarse.
 */
const FIRST_POLL_MS = 10_000;
/**
 * Fallos seguidos que se toleran antes de avisar. Un GitHub caído un par de
 * minutos no merece una alerta; un token caducado o una App sin acceso al repo,
 * sí: sin ella el operador creía que cada push desplegaba y no era así.
 */
export const AUTODEPLOY_FAIL_ALERT_MS = 15 * 60_000;
export { AUTODEPLOY_ALERT_TYPE };
/** Despliegues aún en marcha: no se encola otro encima. */
const IN_PROGRESS = new Set(['queued', 'building', 'deploying']);
/**
 * Consultas al remoto a la vez. Sin tope, un ciclo lanzaba un `git ls-remote`
 * (un proceso con su handshake TLS) por cada servicio de repositorio, todos a
 * la vez: con decenas de servicios era un pico de CPU y de conexiones cada
 * minuto.
 */
const POLL_CONCURRENCY = 4;

/**
 * Auto-deploy por sondeo: cada cierto tiempo se consulta la cabeza de la rama
 * de cada servicio de repositorio (con `git ls-remote`, sin clonar) y, si el
 * commit cambió, se lanza un despliegue. Es el camino sin configuración —no
 * necesita webhook ni que GitHub alcance al servidor—, complementario al webhook
 * (que sigue disponible para despliegues instantáneos).
 *
 * Doble salvaguarda contra despliegues indeseados:
 *  - Frente al ÚLTIMO COMMIT INTENTADO (en la BD): si la cabeza ya se desplegó
 *    o se intentó —por el webhook, un deploy manual o el propio sondeo— no se
 *    repite. Evita duplicados con el webhook y relanzar un build que falló.
 *  - Frente a la ÚLTIMA CABEZA TRATADA (en la BD, `autodeploy_state`, con copia
 *    en memoria): la PRIMERA vez que se sondea un servicio —auto-deploy recién
 *    activado— solo se fija la línea base y NO se despliega, así que activar la
 *    función nunca provoca un redespliegue retroactivo sorpresa. Se guarda en la
 *    base para que un reinicio no la pierda: antes vivía solo en memoria y el
 *    primer sondeo tras arrancar la fijaba en la cabeza ACTUAL, de modo que un
 *    push hecho con Skyway parado (un `skyway update`) no se desplegaba nunca.
 *    Comparar con la cabeza tratada, y no solo con lo desplegado, es lo que
 *    impide que un reinicio tras un rollback vuelva a desplegar la cabeza.
 */
const lastSeen = new Map<string, string>();

/**
 * El webhook (u otro disparo externo) avisa del commit que va a construir para
 * que el sondeo no lo vuelva a desplegar: fija la línea base. Complementa al
 * cotejo contra `lastAttemptedCommitSha` cerrando la ventana entre el push y que
 * el clon registre el `commit_sha`.
 */
export function noteAutoDeployBaseline(serviceId: string, sha: string): void {
  lastSeen.set(serviceId, sha);
  try {
    recordAutoDeployOk(serviceId, sha);
  } catch {
    /* la copia en memoria basta para este proceso */
  }
}

/** Intervalo efectivo del sondeo, en segundos (lo muestra Ajustes del servicio). */
export function autoDeployPollSeconds(): number {
  return pollMs() / 1000;
}

export interface AutoDeployStatus {
  pollSeconds: number;
  /** Última consulta a la rama (correcta o no); null si aún no se ha hecho. */
  checkedAt: number | null;
  /** Última consulta correcta. */
  okAt: number | null;
  /** Motivo del último fallo, si la última consulta falló. */
  error: string | null;
  /** Inicio de la racha de fallos actual. */
  failingSince: number | null;
  /** Último commit de la rama ya tratado. */
  lastSeenSha: string | null;
}

/** Estado del sondeo de un servicio, para Ajustes → Despliegue automático. */
export function autoDeployStatus(serviceId: string): AutoDeployStatus {
  const row = getAutoDeployState(serviceId);
  return {
    pollSeconds: autoDeployPollSeconds(),
    checkedAt: row?.checked_at ?? null,
    okAt: row?.ok_at ?? null,
    error: row?.error ?? null,
    failingSince: row?.failing_since ?? null,
    lastSeenSha: row?.last_seen_sha ?? null,
  };
}

function pollMs(): number {
  const raw = Number(getSetting('autoDeployPollSeconds'));
  const secs = Number.isFinite(raw) && raw >= MIN_POLL_SECONDS ? raw : DEFAULT_POLL_SECONDS;
  return secs * 1000;
}

/**
 * Cabeza de la rama, por el camino más barato disponible.
 *
 * Con una credencial y un repo de GitHub se pregunta a la API con ETag: la
 * respuesta habitual es un 304 de unos pocos bytes que ni consume cuota ni
 * arranca un proceso. `git ls-remote` cuesta un fork + un handshake TLS
 * completo por servicio y ciclo, así que queda como respaldo: repos que no son
 * de GitHub, sin credencial, o cuando la API no contesta.
 */
async function headSha(repoUrl: string, branch: string, token: string | null): Promise<string | null> {
  const slug = parseGithubSlug(repoUrl);
  if (slug && token) {
    const sha = await apiHeadSha(token, slug.owner, slug.repo, branch);
    if (sha) return sha;
  }
  return remoteHeadSha(repoUrl, branch, token);
}

/**
 * Deja constancia de que no se pudo leer la rama y, si la racha dura, avisa con
 * el remedio. Antes este caso salía del ciclo sin registro, alerta ni estado.
 */
function noteFailure(t: PollTarget, reason: string): void {
  const state = recordAutoDeployFailure(t.id, reason);
  if (state.failing_since === null || Date.now() - state.failing_since < AUTODEPLOY_FAIL_ALERT_MS) return;
  const minutos = Math.round((Date.now() - state.failing_since) / 60_000);
  fireAlert({
    severity: 'warning',
    type: AUTODEPLOY_ALERT_TYPE,
    serviceId: t.id,
    title: `Despliegue automático sin funcionar: ${t.name}`,
    message: `Hace ${minutos} minutos que Skyway no puede consultar la rama «${t.branch}» de ${t.repoUrl}: los push no se despliegan. Último error: ${reason}`,
    explanation:
      'Causas habituales: el token de GitHub ha caducado o se ha revocado, la GitHub App ya no tiene acceso al repositorio ' +
      '(revisa los repositorios de la instalación en GitHub), o la rama se ha renombrado o eliminado (corrígela en Ajustes del servicio).',
    dedupe: true,
  });
}

async function tick(log: { warn: (msg: string) => void }): Promise<void> {
  // Sin Docker el despliegue fallaría; se salta el ciclo y se reintenta luego
  // (no se fija línea base, para no perder un commit que llegue con Docker caído).
  if (!(await dockerAvailable())) return;
  const stored = listAutoDeployStates();

  // Servicios de repositorio con auto-deploy activo (ausente = activo).
  const targets: PollTarget[] = [];
  const active = new Set<string>();
  const projects = listProjects();
  const servicesByProject = listServicesForProjects(projects.map((p) => p.id));
  for (const project of projects) {
    for (const service of servicesByProject.get(project.id) ?? []) {
      if (service.type !== 'git') continue;
      const cfg = service.config as GitConfig;
      if (cfg.autoDeploy === false) continue;
      active.add(service.id);
      targets.push({
        id: service.id,
        name: service.name,
        branch: cfg.branch || 'main',
        repoUrl: cfg.repoUrl,
        project,
        cfg,
      });
    }
  }

  // Consultas en paralelo (con tope): la latencia del ciclo no es la suma de todas.
  // Un servicio que falla (o que se borra a mitad del ciclo) no corta a los demás.
  await pooled(
    targets.map((t) => async () => {
      try {
        await pollOne(t, stored.get(t.id), log);
      } catch (err: any) {
        log.warn(`autodeploy ${t.name}: ${err?.message || err}`);
      }
    }),
    POLL_CONCURRENCY,
  );

  // Olvida los servicios que ya no aplican (borrados o con auto-deploy apagado):
  // al reactivarlo, el primer sondeo vuelve a fijar la línea base sin desplegar.
  for (const id of lastSeen.keys()) if (!active.has(id)) lastSeen.delete(id);
  // Y su alerta de sondeo: sin auto-deploy ya no aplica, y abierta seguía hasta
  // el siguiente despliegue correcto (que, además, ya no la cierra).
  for (const id of forgetAutoDeployStates(active)) resolveServiceAlerts(id, AUTODEPLOY_ALERT_TYPE);
}

interface PollTarget {
  id: string;
  name: string;
  branch: string;
  repoUrl: string;
  project: ProjectRow;
  cfg: GitConfig;
}

async function pollOne(
  t: PollTarget,
  previo: AutoDeployStateRow | undefined,
  log: { warn: (msg: string) => void },
): Promise<void> {
  // Si ya hay un despliegue en marcha, no se encola otro (cierra la ventana
  // entre disparar y que el clon registre el commit_sha).
  const latest = latestDeployment(t.id);
  if (latest && IN_PROGRESS.has(latest.status)) return;

  let head: string | null = null;
  try {
    const token = await resolveGitToken(t.project, t.cfg);
    head = await headSha(t.repoUrl, t.branch, token);
  } catch (err: any) {
    log.warn(`autodeploy ${t.name}: ${err?.message || err}`);
    noteFailure(t, err?.message || String(err));
    return;
  }
  if (!head) {
    // Repo o rama inaccesible, credencial sin permisos o GitHub caído: se
    // reintenta en el siguiente ciclo, pero ya no en silencio.
    noteFailure(t, `no se ha podido leer la rama «${t.branch}» con la credencial del servicio`);
    return;
  }
  // Vuelve a leer la rama tras una racha de fallos: el aviso ya no aplica.
  if (previo?.error) resolveServiceAlerts(t.id, AUTODEPLOY_ALERT_TYPE);

  // Línea base: la de este proceso o, tras un reinicio, la guardada.
  const seen = lastSeen.get(t.id) ?? previo?.last_seen_sha ?? undefined;
  // Cada camino de abajo termina con la cabeza como tratada (también el que
  // despliega, ANTES de disparar, para no re-encolar si el clon falla).
  lastSeen.set(t.id, head);
  recordAutoDeployOk(t.id, head);

  // Primera vez que se sondea el servicio (auto-deploy recién activado): la
  // línea base es la CABEZA ACTUAL y no se despliega; solo disparan los
  // commits que lleguen DESPUÉS (nunca un redespliegue retroactivo).
  // DEBE ir ANTES de cotejar el último commit desplegado: si no, en el caso
  // normal (cabeza ya desplegada) el return temprano dejaba la línea base sin
  // fijar y el PRIMER commit nuevo se tomaba por línea base y no se desplegaba.
  if (seen === undefined) return;
  if (head === seen) return; // ya tratado (evita el bucle si el clon falla)

  // Ya desplegado o intentado por otra vía (webhook, deploy manual o un sondeo
  // anterior): no se repite. Evita duplicar con el webhook y relanzar un build
  // manual que acaba de fallar. Aquí cuentan también los fallidos, a diferencia
  // de los webhooks (`lastBuiltCommitSha`), donde «Redeliver» debe relanzarlo.
  if (head === lastAttemptedCommitSha(t.id)) return;

  // Commit nuevo (también el que llegó mientras Skyway estaba parado) → desplegar.
  try {
    markManualAction(t.id); // el intercambio no es una "caída": no alertar
    triggerDeploy(t.id, 'autodeploy');
    auditSystem('autodeploy', `${t.name} @ ${head.slice(0, 7)} (rama ${t.branch})`);
  } catch (err: any) {
    log.warn(`autodeploy ${t.name}: ${err?.message || err}`);
  }
}

let interval: NodeJS.Timeout | null = null;
let running = false;
let stopped = false;

export function startAutoDeploy(log: { warn: (msg: string) => void }): void {
  if (interval) return;
  stopped = false;
  const schedule = (delayMs: number) => {
    if (stopped) return;
    interval = setTimeout(async () => {
      if (!running) {
        running = true;
        try {
          await tick(log);
        } catch (err: any) {
          log.warn(`autodeploy: ${err?.message || err}`);
        } finally {
          running = false;
        }
      }
      schedule(pollMs()); // re-lee el intervalo por si cambió en Ajustes
    }, delayMs);
    interval.unref();
  };
  schedule(Math.min(FIRST_POLL_MS, pollMs()));
}

/** Apagado ordenado: no se programa ningún sondeo más. */
export function stopAutoDeploy(): void {
  stopped = true;
  if (interval) clearTimeout(interval);
  interval = null;
}
