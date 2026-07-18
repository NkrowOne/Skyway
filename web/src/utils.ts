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
  dead: 'Muerto',
  not_created: 'Sin desplegar',
  unknown: 'Desconocido',
};

export const STATE_COLOR: Record<ContainerState, string> = {
  running: 'bg-ok',
  restarting: 'bg-warn pulse-soft',
  exited: 'bg-err',
  paused: 'bg-warn',
  created: 'bg-sub',
  dead: 'bg-err',
  not_created: 'bg-sub/60',
  unknown: 'bg-sub/60',
};

export const DEPLOY_STATUS_LABEL: Record<DeploymentStatus, string> = {
  queued: 'En cola',
  building: 'Construyendo',
  deploying: 'Desplegando',
  success: 'Completado',
  failed: 'Fallido',
  canceled: 'Cancelado',
};

export const DEPLOY_STATUS_STYLE: Record<DeploymentStatus, string> = {
  queued: 'text-warn border-warn/40 bg-warn/10',
  building: 'text-warn border-warn/40 bg-warn/10 pulse-soft',
  deploying: 'text-warn border-warn/40 bg-warn/10 pulse-soft',
  success: 'text-ok border-ok/40 bg-ok/10',
  failed: 'text-err border-err/40 bg-err/10',
  canceled: 'text-sub border-line bg-panel2',
};

export function isActiveDeploy(status: DeploymentStatus): boolean {
  return status === 'queued' || status === 'building' || status === 'deploying';
}
