import { ContainerState, DeploymentStatus } from './types';

/* Secuencias ANSI CSI (colores de npm/docker build…): se limpian antes de pintar logs. */
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

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
  // Acotado a [0, TB]: valores <1 B (p. ej. un caudal de red casi ocioso, 0,4 B/s)
  // daban un índice negativo → `units[-1]` = undefined y se pintaba «0,4 undefined».
  const i = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log2(bytes) / 10)));
  const value = bytes / 2 ** (10 * i);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/** Caudal de red: bytes/s legibles (p. ej. «1,4 MB/s»). */
export function fmtRate(bytesPerSec: number): string {
  return `${fmtBytes(bytesPerSec)}/s`;
}

/**
 * CPU en núcleos, la unidad que sí se entiende: la convención de Docker usa
 * 100 = un núcleo, así que 250 % son 2,5 núcleos. Se muestra con el detalle
 * justo (más decimales cuando es una fracción pequeña).
 */
export function fmtCores(cpuPercent: number): string {
  const cores = cpuPercent / 100;
  const txt = cores < 1 ? cores.toFixed(2) : cores < 10 ? cores.toFixed(1) : Math.round(cores).toString();
  return `${txt} ${cores === 1 ? 'núcleo' : 'núcleos'}`;
}

/** Etiqueta de eje temporal adaptada a la ventana (24 h → hora; días → fecha). */
export function fmtAxisTime(ts: number, hours: number): string {
  const d = new Date(ts);
  if (hours <= 24) return d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  if (hours <= 24 * 7) return d.toLocaleString('es', { weekday: 'short', hour: '2-digit' });
  return d.toLocaleDateString('es', { day: '2-digit', month: '2-digit' });
}

/** MB legibles (RAM/disco): reutiliza fmtBytes convirtiendo desde megabytes. */
export function fmtMb(mb: number): string {
  return fmtBytes(mb * 1024 * 1024);
}

/** Importe monetario a partir de céntimos (facturación). */
export function fmtMoney(cents: number, currency = 'EUR'): string {
  try {
    return new Intl.NumberFormat('es', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** Fecha corta (día/mes/año) para periodos de facturación. */
export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Fecha+hora completa para tooltips del histórico. */
export function fmtStamp(ts: number, hours: number): string {
  const d = new Date(ts);
  if (hours <= 24) return d.toLocaleString('es', { hour: '2-digit', minute: '2-digit' });
  if (hours <= 24 * 7) return d.toLocaleString('es', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit' });
  return d.toLocaleDateString('es', { weekday: 'short', day: '2-digit', month: '2-digit' });
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

/** De dónde vino el despliegue. Compartido: lo pintan el historial y la rejilla. */
export const DEPLOY_TRIGGER_LABEL: Record<string, string> = {
  initial: 'creación',
  manual: 'manual',
  webhook: 'push',
  autodeploy: 'auto-deploy',
  rollback: 'rollback',
  import: 'importación',
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
  system_backup_failed: 'Backup del panel fallido',
  db_integrity: 'BD del panel dañada',
  disk_quota: 'Espacio asignado superado',
  disk_quota_soon: 'Espacio asignado al 90%',
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
  autodeploy: 'Auto-deploy (commit nuevo)',
  server_started: 'Servidor iniciado',
  railway_import: 'Proyecto importado de Railway',
  deployment_canceled: 'Despliegue cancelado',
  project_deploy_all: 'Despliegue de todo el proyecto',
  service_exec: 'Comando ejecutado en contenedor',
  backup_created: 'Backup creado',
  backup_downloaded: 'Backup descargado',
  backup_restored: 'Backup restaurado',
  backup_deleted: 'Backup eliminado',
  system_backup_created: 'Backup del panel creado',
  system_backup_downloaded: 'Backup del panel descargado',
  system_backup_deleted: 'Backup del panel eliminado',
  db_integrity_failed: 'Integridad de la BD del panel fallida',
  system_prune: 'Espacio liberado (prune)',
  db_query: 'Consulta en base de datos',
  file_downloaded: 'Archivo descargado del contenedor',
  file_uploaded: 'Archivo subido al contenedor',
  file_deleted: 'Archivo/carpeta eliminado del contenedor',
  file_mkdir: 'Carpeta creada en el contenedor',
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
