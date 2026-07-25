import { aiPricesTick } from './aiprices';
import { auditSystem } from './audit';
import { fireAlert, resolveServiceAlerts } from './alerts';
import { billingAutomationTick } from './billingauto';
import { backupSupported, createBackup, deleteBackup, listBackups } from './backups';
import { listProjects, listServices, resolveAlertsByDedupe } from './db';
import { dockerAvailable } from './docker/client';
import { createSystemBackup, listSystemBackups, pruneSystemBackups } from './sysbackup';
import { DatabaseConfig } from './types';

const TICK_MS = 10 * 60_000;
/** Hora local a partir de la cual se ejecutan los backups programados. */
const RUN_AFTER_HOUR = 4;
const SYSTEM_BACKUP_DEDUPE = 'system:backup';

function isDue(schedule: 'daily' | 'weekly', newestTs: number, now: Date): boolean {
  if (now.getHours() < RUN_AFTER_HOUR) return false;
  const age = now.getTime() - newestTs;
  // Margen bajo el periodo exacto para que la hora de ejecución no vaya
  // deslizándose día a día.
  if (schedule === 'daily') return age > 20 * 3600_000;
  return age > 6.5 * 24 * 3600_000;
}

/**
 * Backup diario del propio skyway.db (usuarios, servicios, variables…).
 * No depende de Docker: aunque el daemon esté caído, el panel se protege.
 */
function systemBackupTick(now: Date): void {
  const newestTs = listSystemBackups()[0]?.createdAt ?? 0;
  if (!isDue('daily', newestTs, now)) return;
  try {
    const entry = createSystemBackup();
    pruneSystemBackups();
    auditSystem('system_backup_created', `${entry.file} (programado diario)`);
    resolveAlertsByDedupe(SYSTEM_BACKUP_DEDUPE);
  } catch (err: any) {
    fireAlert({
      severity: 'warning',
      type: 'system_backup_failed',
      title: 'Backup del panel fallido',
      message: `El backup diario de la base de datos de Skyway falló: ${(err?.message || err).toString().slice(0, 300)}`,
      explanation:
        'Sin este backup, una avería del disco perdería usuarios, proyectos y configuración. Causa típica: disco lleno. Puedes lanzarlo manualmente desde Ajustes → Copia de seguridad del panel.',
      dedupeKey: SYSTEM_BACKUP_DEDUPE,
    });
  }
}

async function tick(): Promise<void> {
  const nowDate = new Date();
  try {
    systemBackupTick(nowDate);
  } catch {
    /* nunca debe tumbar el tick de los backups de servicios */
  }
  try {
    // Facturación automática del ciclo + corte por impago (no dependen de Docker).
    billingAutomationTick(nowDate);
  } catch {
    /* aislado: un fallo de facturación no debe tumbar el resto del tick */
  }
  try {
    // Tarifa de Gemini al día (una vez al día): el margen se calcula sobre el
    // coste real, no sobre el que había cuando se configuró el gateway.
    await aiPricesTick(nowDate);
  } catch {
    /* la sincronización de precios es best-effort: sin red, se reintenta en el próximo tick */
  }
  if (!(await dockerAvailable())) return;
  const now = nowDate;

  for (const project of listProjects()) {
    for (const service of listServices(project.id)) {
      if (service.type !== 'database' || !backupSupported(service)) continue;
      const cfg = service.config as DatabaseConfig;
      const schedule = cfg.backupSchedule;
      if (schedule !== 'daily' && schedule !== 'weekly') continue;

      const backups = listBackups(service.id);
      const newestTs = backups[0]?.createdAt ?? 0;
      if (!isDue(schedule, newestTs, now)) continue;

      try {
        const entry = await createBackup(project, service);
        auditSystem('backup_created', `${service.name}: ${entry.file} (programado ${schedule})`);
        resolveServiceAlerts(service.id, 'backup_failed', false);

        const retention = cfg.backupRetention && cfg.backupRetention > 0 ? cfg.backupRetention : 7;
        const current = listBackups(service.id);
        for (const old of current.slice(retention)) {
          deleteBackup(service.id, old.file);
        }
      } catch (err: any) {
        fireAlert({
          severity: 'warning',
          type: 'backup_failed',
          serviceId: service.id,
          title: `Backup programado fallido: ${service.name}`,
          message: `El backup ${schedule === 'daily' ? 'diario' : 'semanal'} de "${service.name}" (${project.name}) falló: ${(err?.message || err).toString().slice(0, 300)}`,
          explanation:
            'Se reintentará en el próximo ciclo (cada 10 min). Causas típicas: la base de datos no está en ejecución o el disco está lleno. Puedes lanzar uno manual desde la pestaña Backups para ver el error completo.',
          dedupe: true,
        });
      }
    }
  }
}

let interval: NodeJS.Timeout | null = null;

export function startScheduler(log: { warn: (msg: string) => void }): void {
  if (interval) return;
  interval = setInterval(() => {
    tick().catch((err) => log.warn(`scheduler: ${err?.message || err}`));
  }, TICK_MS);
  interval.unref();
}
