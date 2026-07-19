import os from 'os';
import { fireAlert, resolveServiceAlerts } from './alerts';
import { getSetting, listProjects, listServices } from './db';
import { dockerAvailable } from './docker/client';
import { configuredReplicas, getRuntime, getStats, replicaName } from './docker/containers';
import { explainExitCode } from './deploy/diagnose';
import { ContainerState } from './types';

const TICK_MS = 30_000;
const RESTART_WINDOW_MS = 10 * 60_000;

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

  for (const project of listProjects()) {
    for (const service of listServices(project.id)) {
      const totalReplicas = configuredReplicas(service);
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
      if (runtime.state === 'running' && prev && prev.state !== 'running') {
        resolveServiceAlerts(service.id, 'service_down', true);
        entry.cpuHighSince = null;
        entry.memHighSince = null;
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
        const stats = await getStats(name);
        if (stats) {
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
    }
  }

  // Limpieza de servicios eliminados.
  const alive = new Set<string>();
  for (const p of listProjects()) for (const s of listServices(p.id)) alive.add(s.id);
  for (const key of tracked.keys()) if (!alive.has(key.split('#')[0])) tracked.delete(key);
}

let interval: NodeJS.Timeout | null = null;

export function startMonitor(log: { warn: (msg: string) => void }): void {
  if (interval) return;
  interval = setInterval(() => {
    tick().catch((err) => log.warn(`monitor: ${err?.message || err}`));
  }, TICK_MS);
  interval.unref();
}
