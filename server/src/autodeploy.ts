import { auditSystem } from './audit';
import { getSetting, lastBuiltCommitSha, latestDeployment, listProjects, listServices } from './db';
import { remoteHeadSha } from './deploy/builder';
import { gitTokenFor, triggerDeploy } from './deploy/deployer';
import { dockerAvailable } from './docker/client';
import { markManualAction } from './monitor';
import { GitConfig } from './types';

const DEFAULT_POLL_SECONDS = 120;
const MIN_POLL_SECONDS = 30;
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

function pollMs(): number {
  const raw = Number(getSetting('autoDeployPollSeconds'));
  const secs = Number.isFinite(raw) && raw >= MIN_POLL_SECONDS ? raw : DEFAULT_POLL_SECONDS;
  return secs * 1000;
}

async function tick(log: { warn: (msg: string) => void }): Promise<void> {
  // Sin Docker el despliegue fallaría; se salta el ciclo y se reintenta luego
  // (no se fija línea base, para no perder un commit que llegue con Docker caído).
  if (!(await dockerAvailable())) return;

  // Servicios de repositorio con auto-deploy activo (ausente = activo).
  const targets: { id: string; name: string; branch: string; repoUrl: string; token: string | null }[] = [];
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
        token: gitTokenFor(project, cfg),
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
        head = await remoteHeadSha(t.repoUrl, t.branch, t.token);
      } catch (err: any) {
        log.warn(`autodeploy ${t.name}: ${err?.message || err}`);
        return;
      }
      if (!head) return; // repo/rama inaccesible o sin permisos: se reintenta

      // Ya construido (webhook, manual o un sondeo anterior): nada que hacer.
      if (head === lastBuiltCommitSha(t.id)) return;

      // Primera vez que este proceso ve el servicio: línea base, sin desplegar.
      const seen = lastSeen.get(t.id);
      if (seen === undefined) {
        lastSeen.set(t.id, head);
        return;
      }
      if (head === seen) return; // ya tratado este proceso (evita bucle si el clon falla)

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
