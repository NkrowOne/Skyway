import { auditSystem } from './audit';
import { getSetting, lastBuiltCommitSha, latestDeployment, listProjects, listServices } from './db';
import { remoteHeadSha } from './deploy/builder';
import { triggerDeploy } from './deploy/deployer';
import { apiHeadSha, parseGithubSlug } from './github/client';
import { resolveGitToken } from './github/resolve';
import { dockerAvailable } from './docker/client';
import { markManualAction } from './monitor';
import { GitConfig, ProjectRow } from './types';

// El sondeo por API con ETag es tan barato (un 304 no consume cuota ni arranca
// un proceso) que se puede mirar cada minuto sin coste apreciable: un push sin
// webhook tarda como mucho un minuto en salir, no dos.
const DEFAULT_POLL_SECONDS = 60;
const MIN_POLL_SECONDS = 15;
/** Despliegues aún en marcha: no se encola otro encima. */
const IN_PROGRESS = new Set(['queued', 'building', 'deploying']);

/**
 * Auto-deploy por sondeo: cada cierto tiempo se consulta la cabeza de la rama
 * de cada servicio de repositorio (con `git ls-remote`, sin clonar) y, si el
 * commit cambió, se lanza un despliegue. Es el camino sin configuración —no
 * necesita webhook ni que GitHub alcance al servidor—, complementario al webhook
 * (que sigue disponible para despliegues instantáneos).
 *
 * Doble salvaguarda contra despliegues indeseados:
 *  - Frente al ÚLTIMO COMMIT CONSTRUIDO (en la BD): si la cabeza ya se construyó
 *    —por el webhook, un deploy manual o el propio sondeo— no se repite. Evita
 *    duplicados cuando también hay webhook configurado.
 *  - Frente a la ÚLTIMA CABEZA VISTA por este proceso (en memoria): el primer
 *    sondeo de cada servicio solo fija la línea base y NO despliega, así activar
 *    la función (o reiniciar Skyway) nunca provoca un redespliegue retroactivo
 *    sorpresa; solo disparan los commits que lleguen DESPUÉS.
 */
const lastSeen = new Map<string, string>();

/**
 * El webhook (u otro disparo externo) avisa del commit que va a construir para
 * que el sondeo no lo vuelva a desplegar: fija la línea base en memoria de este
 * proceso. Complementa al cotejo contra `lastBuiltCommitSha` cerrando la ventana
 * entre el push y que el clon registre el `commit_sha`.
 */
export function noteAutoDeployBaseline(serviceId: string, sha: string): void {
  lastSeen.set(serviceId, sha);
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

async function tick(log: { warn: (msg: string) => void }): Promise<void> {
  // Sin Docker el despliegue fallaría; se salta el ciclo y se reintenta luego
  // (no se fija línea base, para no perder un commit que llegue con Docker caído).
  if (!(await dockerAvailable())) return;

  // Servicios de repositorio con auto-deploy activo (ausente = activo).
  const targets: { id: string; name: string; branch: string; repoUrl: string; project: ProjectRow; cfg: GitConfig }[] = [];
  const active = new Set<string>();
  for (const project of listProjects()) {
    for (const service of listServices(project.id)) {
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

  // Consultas en paralelo: la latencia del ciclo es la del repo más lento, no la suma.
  await Promise.all(
    targets.map(async (t) => {
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
        return;
      }
      if (!head) return; // repo/rama inaccesible o sin permisos: se reintenta

      // Primera vez que este proceso ve el servicio: fija la línea base a la
      // CABEZA ACTUAL y no despliega; solo disparan los commits que lleguen
      // DESPUÉS (nunca un redespliegue retroactivo al arrancar/activar).
      // DEBE ir ANTES de cotejar el último commit construido: si no, en el caso
      // normal (cabeza ya construida) el return temprano dejaba la línea base sin
      // fijar y el PRIMER commit nuevo se tomaba por línea base y no se desplegaba.
      const seen = lastSeen.get(t.id);
      if (seen === undefined) {
        lastSeen.set(t.id, head);
        return;
      }
      if (head === seen) return; // ya tratado este proceso (evita bucle si el clon falla)

      // Ya construido por otra vía (webhook, deploy manual o un sondeo anterior):
      // sincroniza la línea base y no repite. Evita duplicar con el webhook.
      if (head === lastBuiltCommitSha(t.id)) {
        lastSeen.set(t.id, head);
        return;
      }

      // Commit nuevo → desplegar. Se marca ANTES de disparar para no re-encolar.
      lastSeen.set(t.id, head);
      try {
        markManualAction(t.id); // el intercambio no es una "caída": no alertar
        triggerDeploy(t.id, 'autodeploy');
        auditSystem('autodeploy', `${t.name} @ ${head.slice(0, 7)} (rama ${t.branch})`);
      } catch (err: any) {
        log.warn(`autodeploy ${t.name}: ${err?.message || err}`);
      }
    }),
  );

  // Olvida los servicios que ya no aplican (borrados o con auto-deploy apagado).
  for (const id of lastSeen.keys()) if (!active.has(id)) lastSeen.delete(id);
}

let interval: NodeJS.Timeout | null = null;
let running = false;

export function startAutoDeploy(log: { warn: (msg: string) => void }): void {
  if (interval) return;
  const schedule = () => {
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
      schedule(); // re-lee el intervalo por si cambió en Ajustes
    }, pollMs());
    interval.unref();
  };
  schedule();
}
