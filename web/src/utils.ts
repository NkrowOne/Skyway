import { ContainerState, DeploymentStatus } from './types';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'hace unos segundos';
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return `hace ${d} d`;
}

export function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10));
  const value = bytes / 2 ** (10 * i);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export const STATE_LABEL: Record<ContainerState, string> = {
  running: 'Activo',
  restarting: 'Reiniciando',
  exited: 'Detenido',
  paused: 'Pausado',
  created: 'Creado',
  removing: 'Eliminando',
  dead: 'Muerto',
  not_created: 'Sin desplegar',
  unknown: 'Desconocido',
};

/** Tonos semánticos del StatusBadge unificado. */
export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'neutral';

export const STATE_TONE: Record<ContainerState, Tone> = {
  running: 'ok',
  restarting: 'warn',
  exited: 'err',
  paused: 'warn',
  created: 'neutral',
  removing: 'warn',
  dead: 'err',
  not_created: 'neutral',
  unknown: 'neutral',
};

/** Estados transitorios: el dot del badge pulsa. */
export const STATE_PULSE: Partial<Record<ContainerState, boolean>> = {
  restarting: true,
  removing: true,
};

export const DEPLOY_STATUS_LABEL: Record<DeploymentStatus, string> = {
  queued: 'En cola',
  building: 'Construyendo',
  deploying: 'Desplegando',
  success: 'Completado',
  failed: 'Fallido',
  canceled: 'Cancelado',
};

export function isActiveDeploy(status: DeploymentStatus): boolean {
  return status === 'queued' || status === 'building' || status === 'deploying';
}

export type Severity = 'critical' | 'warning' | 'info';

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Crítico',
  warning: 'Aviso',
  info: 'Info',
};

export const SEVERITY_TONE: Record<Severity, Tone> = {
  critical: 'err',
  warning: 'warn',
  info: 'info',
};

export const ALERT_TYPE_LABEL: Record<string, string> = {
  service_down: 'Servicio caído',
  crash_loop: 'Bucle de reinicios',
  cpu_high: 'CPU alta',
  mem_high: 'Memoria alta',
  deploy_failed: 'Despliegue fallido',
  backup_failed: 'Backup fallido',
  disk_quota: 'Espacio asignado superado',
};

export const AUDIT_ACTION_LABEL: Record<string, string> = {
  setup: 'Cuenta creada',
  login: 'Inicio de sesión',
  login_failed: 'Login fallido',
  login_blocked: 'Login bloqueado (rate limit)',
  logout: 'Cierre de sesión',
  password_changed: 'Contraseña cambiada',
  sessions_rotated: 'Sesiones invalidadas',
  project_created: 'Proyecto creado',
  project_updated: 'Proyecto actualizado',
  project_deleted: 'Proyecto eliminado',
  project_vars_updated: 'Variables compartidas actualizadas',
  service_created: 'Servicio creado',
  service_updated: 'Servicio actualizado',
  service_deleted: 'Servicio eliminado',
  service_deploy: 'Despliegue manual',
  service_rollback: 'Rollback',
  service_start: 'Servicio iniciado',
  service_stop: 'Servicio detenido',
  service_restart: 'Servicio reiniciado',
  service_env_updated: 'Variables actualizadas',
  settings_updated: 'Ajustes globales cambiados',
  webhook_push: 'Push recibido (webhook)',
  server_started: 'Servidor iniciado',
  railway_import: 'Proyecto importado de Railway',
  deployment_canceled: 'Despliegue cancelado',
  project_deploy_all: 'Despliegue de todo el proyecto',
  service_exec: 'Comando ejecutado en contenedor',
  backup_created: 'Backup creado',
  backup_downloaded: 'Backup descargado',
  backup_restored: 'Backup restaurado',
  backup_deleted: 'Backup eliminado',
  system_prune: 'Espacio liberado (prune)',
  db_query: 'Consulta en base de datos',
  status_page_updated: 'Página de estado actualizada',
  status_page_rotated: 'Enlace de página de estado rotado',
};

export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString('es', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
