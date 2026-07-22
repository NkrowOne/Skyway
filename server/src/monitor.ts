import os from 'os';
import { fireAlert, resolveServiceAlerts } from './alerts';
import {
  getSetting,
  listDeployments,
  listProjects,
  listServices,
  pruneMetrics,
  pruneUptime,
  recordHostDisk,
  recordHostMetrics,
  recordServiceDisk,
  recordServiceMetrics,
  recordUptimeSample,
} from './db';
import { diskUsageByService, hostDisk } from './disk';
import { dockerAvailable } from './docker/client';
import { configuredReplicas, getRuntime, getStats, replicaName } from './docker/containers';
import { explainExitCode } from './deploy/diagnose';
import { netDelta, pruneNetCounters } from './metrics';
import { ContainerState } from './types';
import { fmtBytesEs } from './util';

const TICK_MS = 30_000;
const RESTART_WINDOW_MS = 10 * 60_000;
/** Cada cuántos ticks se revisan las cuotas de disco (~5 min). */
const DISK_CHECK_EVERY = 10;

interface Tracked {
  state: ContainerState;
  restartSamples: { ts: number; count: number }[];
  cpuHighSince: number | null;
  memHighSince: number | null;
}

const tracked = new Map<string, Tracked>();
const manualActions = new Map<string, number>();

/** Las rutas marcan acciones manuales para no alertar de "caídas" provocadas por el usuario. */
export function markManualAction(serviceId: string): void {
  manualActions.set(serviceId, Date.now());
}

function recentManualAction(serviceId: string, windowMs = 3 * 60_000): boolean {
  const ts = manualActions.get(serviceId);
  return !!ts && Date.now() - ts < windowMs;
}

function num(key: string, fallback: number): number {
  const raw = getSetting(key);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function tick(): Promise<void> {
  if (!(await dockerAvailable())) return;

  const cpuThreshold = num('alertCpuPercent', 90);
  const memThreshold = num('alertMemPercent', 90);
  const sustainMs = num('alertSustainMinutes', 5) * 60_000;
  const hostCores = os.cpus().length;
  const nowMs = Date.now();
  // Réplicas con contador de red vivo este tick: las que desaparezcan se olvidan.
  const seenReplicas = new Set<string>();

  for (const project of listProjects()) {
    for (const service of listServices(project.id)) {
      const totalReplicas = configuredReplicas(service);
      let runningReplicas = 0;
      let anyReplicaSeen = false;
      // Acumulador del consumo del servicio (suma de sus réplicas) para el histórico.
      // Los contadores de red se guardan crudos y el delta se calcula al final:
      // así una muestra incompleta (una réplica con stats caídos) no avanza la
      // línea base y no pierde bytes en el siguiente tick.
      const agg = { cpuPercent: 0, memUsage: 0, memLimit: 0 };
      const rawNet: { name: string; rx: number; tx: number }[] = [];
      let statsReplicas = 0;
      for (let idx = 1; idx <= totalReplicas; idx++) {
      const name = replicaName(project, service, idx);
      const trackKey = `${service.id}#${idx}`;
      const replicaTag = totalReplicas > 1 ? ` (réplica ${idx}/${totalReplicas})` : '';
      let runtime;
      try {
        runtime = await getRuntime(name);
      } catch {
        continue;
      }
      if (runtime.state !== 'not_created') anyReplicaSeen = true;
      if (runtime.state === 'running') runningReplicas += 1;
      const prev = tracked.get(trackKey);
      const entry: Tracked = prev ?? {
        state: runtime.state,
        restartSamples: [],
        cpuHighSince: null,
        memHighSince: null,
      };

      // --- caída del servicio ---
      const wasUp = prev && (prev.state === 'running' || prev.state === 'restarting');
      const isDown = runtime.state === 'exited' || runtime.state === 'dead';
      if (wasUp && isDown && !recentManualAction(service.id)) {
        fireAlert({
          severity: 'critical',
          type: 'service_down',
          serviceId: service.id,
          title: `Servicio caído: ${service.name}${replicaTag}`,
          message: `El contenedor de "${service.name}"${replicaTag} (proyecto ${project.name}) se detuvo inesperadamente.`,
          explanation: explainExitCode(runtime.exitCode),
          dedupe: true,
        });
      }
      if (runtime.state === 'running') {
        // Resolución por estado, no por flanco: así se limpia también una alerta
        // anterior a un reinicio de Skyway (con `tracked` vacío no hay transición
        // observada). La notificación de "recuperado" sí que es solo del flanco.
        const recovered = !!prev && prev.state !== 'running';
        resolveServiceAlerts(service.id, 'service_down', recovered);
        if (recovered) {
          entry.cpuHighSince = null;
          entry.memHighSince = null;
        }
      }

      // --- bucle de reinicios ---
      entry.restartSamples.push({ ts: nowMs, count: runtime.restartCount });
      entry.restartSamples = entry.restartSamples.filter((s) => nowMs - s.ts < RESTART_WINDOW_MS);
      const restartDelta = entry.restartSamples.length > 1
        ? runtime.restartCount - entry.restartSamples[0].count
        : 0;
      if (restartDelta >= 3) {
        fireAlert({
          severity: 'critical',
          type: 'crash_loop',
          serviceId: service.id,
          title: `Bucle de reinicios: ${service.name}${replicaTag}`,
          message: `"${service.name}"${replicaTag} se ha reiniciado ${restartDelta} veces en los últimos 10 minutos. Docker lo relanza (restart: unless-stopped) pero el proceso muere una y otra vez.`,
          explanation: `${explainExitCode(runtime.exitCode)} Revisa la pestaña Logs del servicio: el error aparece justo antes de cada reinicio. Causas típicas: variable de entorno que falta, base de datos inaccesible o puerto interno equivocado.`,
          dedupe: true,
        });
      } else if (restartDelta === 0 && runtime.state === 'running') {
        resolveServiceAlerts(service.id, 'crash_loop', false);
      }

      // --- uso de recursos ---
      if (runtime.state === 'running') {
        // La réplica corre: su contador de red debe sobrevivir aunque getStats
        // falle puntualmente (si no, al recuperarse perdería el tramo del hueco).
        seenReplicas.add(name);
        const stats = await getStats(name);
        if (stats) {
          // Muestra para el histórico: suma de todas las réplicas del servicio.
          statsReplicas += 1;
          agg.cpuPercent += stats.cpuPercent;
          agg.memUsage += stats.memUsage;
          agg.memLimit += stats.memLimit;
          rawNet.push({ name, rx: stats.netRx, tx: stats.netTx });

          const cfg = service.config as any;
          const cpuAllowance = (cfg.cpus && cfg.cpus > 0 ? cfg.cpus : hostCores) * 100;
          const cpuPct = (stats.cpuPercent / cpuAllowance) * 100;
          if (cpuPct >= cpuThreshold) {
            entry.cpuHighSince = entry.cpuHighSince ?? nowMs;
            if (nowMs - entry.cpuHighSince >= sustainMs) {
              fireAlert({
                severity: 'warning',
                type: 'cpu_high',
                serviceId: service.id,
                title: `CPU alta: ${service.name}`,
                message: `"${service.name}" lleva ${Math.round((nowMs - entry.cpuHighSince) / 60000)} min usando ~${Math.round(cpuPct)}% de su CPU ${cfg.cpus ? `(límite ${cfg.cpus} núcleos)` : `(sin límite, ${hostCores} núcleos del host)`}.`,
                explanation: 'Si es tráfico legítimo, sube el límite de CPU en Ajustes → Recursos. Si no, puede ser un bucle infinito o un proceso desbocado: revisa los logs. Sin límite configurado, este servicio puede acaparar la CPU del resto de proyectos.',
                dedupe: true,
              });
            }
          } else {
            entry.cpuHighSince = null;
            resolveServiceAlerts(service.id, 'cpu_high', false);
          }

          if (stats.memLimit > 0) {
            const memPct = (stats.memUsage / stats.memLimit) * 100;
            const hasLimit = !!(cfg.memoryMb && cfg.memoryMb > 0);
            if (memPct >= memThreshold) {
              entry.memHighSince = entry.memHighSince ?? nowMs;
              if (nowMs - entry.memHighSince >= sustainMs) {
                fireAlert({
                  severity: 'warning',
                  type: 'mem_high',
                  serviceId: service.id,
                  title: `Memoria alta: ${service.name}`,
                  message: `"${service.name}" usa el ${Math.round(memPct)}% de ${hasLimit ? `su límite (${cfg.memoryMb} MB)` : 'la RAM del servidor'}.`,
                  explanation: hasLimit
                    ? 'Si supera el límite, el kernel matará el proceso (OOM, código 137). Sube el límite de RAM o investiga una posible fuga de memoria.'
                    : 'Este servicio no tiene límite de RAM y está consumiendo gran parte de la memoria del host: puede afectar a todos los proyectos. Ponle un límite en Ajustes → Recursos.',
                  dedupe: true,
                });
              }
            } else {
              entry.memHighSince = null;
              resolveServiceAlerts(service.id, 'mem_high', false);
            }
          }
        }
      }

      entry.state = runtime.state;
      tracked.set(trackKey, entry);
      }

      // Reconciliación del fallo de despliegue: si el despliegue VIGENTE es
      // correcto, no hay un problema de despliegue activo aunque la alerta de
      // fallo siga abierta (p. ej. se creó antes de existir la auto-resolución,
      // o el servicio se recuperó sin un despliegue nuevo). Así la campana solo
      // refleja problemas activos, sin que el usuario tenga que resolver a mano.
      const latestDeploy = listDeployments(service.id, 1)[0];
      if (latestDeploy?.status === 'success') {
        resolveServiceAlerts(service.id, 'deploy_failed', false);
      }

      // La telemetría es best-effort: un fallo de escritura (p. ej. disco lleno)
      // no debe abortar el tick y dejar sin vigilar a los servicios siguientes.
      try {
        // Muestra de disponibilidad para las páginas de estado: cuenta como "en
        // marcha" si al menos una réplica corre. Antes del primer despliegue no
        // se registra nada (no penaliza el uptime).
        if (anyReplicaSeen) recordUptimeSample(service.id, runningReplicas > 0);
        // Muestra de consumo: solo si TODAS las réplicas en marcha dieron stats,
        // para no sesgar la media con una lectura parcial. El delta de red se
        // calcula aquí (avanza la línea base) únicamente cuando se registra.
        if (statsReplicas > 0 && statsReplicas === runningReplicas) {
          let netRxDelta = 0;
          let netTxDelta = 0;
          for (const r of rawNet) {
            const d = netDelta(r.name, r.rx, r.tx);
            netRxDelta += d.rx;
            netTxDelta += d.tx;
          }
          recordServiceMetrics(service.id, { ...agg, netRxDelta, netTxDelta });
        }
      } catch {
        /* histórico best-effort: se reintenta en el siguiente tick */
      }
    }
  }

  // Histórico de carga y RAM del host (independiente de los servicios).
  try {
    recordHostMetrics(os.loadavg()[0], os.totalmem() - os.freemem(), os.totalmem());
  } catch {
    /* best-effort */
  }
  // Se olvidan los contadores de red de réplicas que ya no corren.
  pruneNetCounters(seenReplicas);

  // Limpieza de servicios eliminados.
  const alive = new Set<string>();
  for (const p of listProjects()) for (const s of listServices(p.id)) alive.add(s.id);
  for (const key of tracked.keys()) if (!alive.has(key.split('#')[0])) tracked.delete(key);
}

/**
 * Vigila las cuotas de disco por servicio (config.diskMb): alerta al superar
 * la cuota y avisa antes (90%) para dar margen de reacción.
 */
async function checkDiskQuotas(): Promise<void> {
  if (!(await dockerAvailable())) return;
  const usage = await diskUsageByService();
  // Foto de disco del host para el histórico (una por cada ronda de disco, ~5 min).
  const hd = await hostDisk().catch(() => null);
  if (hd) recordHostDisk(hd.total - hd.free, hd.total);
  for (const project of listProjects()) {
    for (const service of listServices(project.id)) {
      const du = usage.get(service.id);
      // Foto de disco del servicio para el histórico (aunque no tenga cuota).
      if (du) recordServiceDisk(service.id, du.totalBytes);
      if (!du || !du.quotaMb) {
        // Sin cuota (o quitada): cualquier alerta de disco pendiente se cierra.
        resolveServiceAlerts(service.id, 'disk_quota', false);
        continue;
      }
      const quotaBytes = du.quotaMb * 1024 * 1024;
      const pct = (du.totalBytes / quotaBytes) * 100;
      if (pct >= 100) {
        resolveServiceAlerts(service.id, 'disk_quota_soon', false);
        fireAlert({
          severity: 'warning',
          type: 'disk_quota',
          serviceId: service.id,
          title: `Espacio asignado superado: ${service.name}`,
          message: `"${service.name}" (${project.name}) usa ${fmtBytesEs(du.totalBytes)} de los ${du.quotaMb} MB asignados (${Math.round(pct)}%).`,
          explanation:
            'La cuota es orientativa: el servicio sigue funcionando, pero está ocupando más disco del previsto. Revisa qué crece (datos de la base, uploads, logs) desde Monitor → Espacio, amplía la cuota en Ajustes del servicio o libera espacio.',
          dedupe: true,
        });
      } else if (pct >= 90) {
        // Aviso anticipado (solo campana): da margen antes de rebasar la cuota.
        fireAlert({
          severity: 'info',
          type: 'disk_quota_soon',
          serviceId: service.id,
          title: `Espacio al ${Math.round(pct)}%: ${service.name}`,
          message: `"${service.name}" (${project.name}) usa ${fmtBytesEs(du.totalBytes)} de los ${du.quotaMb} MB asignados. Al superar el 100% recibirás una alerta.`,
          dedupe: true,
          quiet: true,
        });
        resolveServiceAlerts(service.id, 'disk_quota', false);
      } else {
        resolveServiceAlerts(service.id, 'disk_quota', false);
        if (pct < 85) resolveServiceAlerts(service.id, 'disk_quota_soon', false);
      }
    }
  }
}

let interval: NodeJS.Timeout | null = null;
let tickCount = 0;
let lastPrune = 0;
let tickRunning = false;

export function startMonitor(log: { warn: (msg: string) => void }): void {
  if (interval) return;
  interval = setInterval(() => {
    // Sin solape: con muchos contenedores un tick puede tardar más de 30 s
    // (getStats ~1 s por contenedor) y los ticks apilados duplicarían las
    // muestras de uptime y martillearían a Docker.
    if (tickRunning) return;
    tickRunning = true;
    (async () => {
      try {
        await tick();
      } catch (err: any) {
        log.warn(`monitor: ${err?.message || err}`);
      }
      tickCount += 1;
      if (tickCount % DISK_CHECK_EVERY === 0) {
        try {
          await checkDiskQuotas();
        } catch (err: any) {
          log.warn(`monitor disco: ${err?.message || err}`);
        }
      }
      // Poda diaria del histórico de disponibilidad y de consumo (~90-92 días).
      if (Date.now() - lastPrune > 24 * 3600_000) {
        lastPrune = Date.now();
        try {
          pruneUptime();
          pruneMetrics();
        } catch (err: any) {
          log.warn(`monitor prune: ${err?.message || err}`);
        }
      }
    })().finally(() => {
      tickRunning = false;
    });
  }, TICK_MS);
  interval.unref();
}
