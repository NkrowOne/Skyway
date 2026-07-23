/**
 * Motor de cuotas de los workspaces. Traduce plan + overrides del workspace a
 * una cuota efectiva, calcula la asignación AGREGADA de recursos a todos los
 * proyectos del workspace en total, y resuelve qué módulos están activos.
 *
 * Nota sobre atomicidad: better-sqlite3 es síncrono y Node de un solo hilo, así
 * que una comprobación de cuota seguida de su escritura, sin `await` entre
 * medias, es efectivamente atómica (no hay ventana TOCTOU entre dos peticiones).
 * Las rutas deben calcular y escribir en la misma tanda síncrona.
 */
import {
  countWorkspaceMembers,
  countWorkspaceProjects,
  countWorkspaceServices,
  getDefaultPlan,
  getPlan,
  getProject,
  getWorkspace,
  listWorkspaceServices,
} from './db';
import { ALL_MODULE_KEYS, ModuleKey, sanitizeModules } from './modules';
import { PlanRow, ServiceConfig, ServiceType, WorkspaceRow } from './types';

export interface EffectiveQuota {
  cpuCores: number;
  memoryMb: number;
  diskMb: number;
  maxProjects: number;
  maxServices: number;
  maxMembers: number;
}

/** Cuota mínima cuando un workspace no tiene ni plan ni override (nunca ilimitada). */
const FALLBACK: EffectiveQuota = {
  cpuCores: 1,
  memoryMb: 1024,
  diskMb: 10240,
  maxProjects: 3,
  maxServices: 10,
  maxMembers: 3,
};

/** Recursos que un servicio reserva de la cuota (las réplicas multiplican cómputo). */
export interface Reservation {
  cpuCores: number;
  memoryMb: number;
  diskMb: number;
}

export interface WorkspaceAllocation extends Reservation {
  projects: number;
  services: number;
  members: number;
  /** Servicios sin límite explícito por dimensión: no reservan cuota pero pueden crecer sin tope. */
  unlimited: { cpu: number; memory: number; disk: number };
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Réplicas efectivas de un servicio (bases de datos siempre 1). */
function serviceReplicas(type: ServiceType, cfg: any): number {
  if (type === 'database') return 1;
  const n = cfg?.replicas;
  return Number.isInteger(n) && n > 1 ? Math.min(n, 10) : 1;
}

/** Reserva de un servicio: límites explícitos × réplicas. Sin límite = 0 (no reserva). */
export function serviceReservation(type: ServiceType, cfg: ServiceConfig | any): Reservation {
  const reps = serviceReplicas(type, cfg);
  const cpu = typeof cfg?.cpus === 'number' && cfg.cpus > 0 ? cfg.cpus : 0;
  const mem = typeof cfg?.memoryMb === 'number' && cfg.memoryMb > 0 ? cfg.memoryMb : 0;
  const disk = typeof cfg?.diskMb === 'number' && cfg.diskMb > 0 ? cfg.diskMb : 0;
  return { cpuCores: cpu * reps, memoryMb: mem * reps, diskMb: disk };
}

/** El plan efectivo del workspace (el asignado, o el plan por defecto como respaldo informativo). */
export function workspacePlan(ws: WorkspaceRow): PlanRow | undefined {
  if (ws.plan_id) return getPlan(ws.plan_id);
  return getDefaultPlan();
}

/** Cuota efectiva: override del workspace ?? valor del plan ?? mínimo de respaldo. */
export function effectiveQuota(ws: WorkspaceRow, plan: PlanRow | undefined): EffectiveQuota {
  return {
    cpuCores: ws.cpu_cores ?? plan?.cpu_cores ?? FALLBACK.cpuCores,
    memoryMb: ws.memory_mb ?? plan?.memory_mb ?? FALLBACK.memoryMb,
    diskMb: ws.disk_mb ?? plan?.disk_mb ?? FALLBACK.diskMb,
    maxProjects: ws.max_projects ?? plan?.max_projects ?? FALLBACK.maxProjects,
    maxServices: ws.max_services ?? plan?.max_services ?? FALLBACK.maxServices,
    maxMembers: ws.max_members ?? plan?.max_members ?? FALLBACK.maxMembers,
  };
}

/** Módulos concedidos por el admin (override del workspace ?? del plan ?? todos). */
export function grantedModules(ws: WorkspaceRow, plan: PlanRow | undefined): ModuleKey[] {
  if (ws.modules_override != null) return sanitizeModules(parseJsonArray(ws.modules_override));
  if (plan) return sanitizeModules(parseJsonArray(plan.modules));
  return [...ALL_MODULE_KEYS];
}

/** Módulos que el propietario ha desactivado (acotado) para su workspace. */
export function ownerDisabledModules(ws: WorkspaceRow): ModuleKey[] {
  return sanitizeModules(parseJsonArray(ws.owner_disabled_modules));
}

/** Módulos activos = concedidos por el admin menos los que el propietario acota. */
export function effectiveModules(ws: WorkspaceRow, plan: PlanRow | undefined): ModuleKey[] {
  const granted = new Set(grantedModules(ws, plan));
  for (const k of ownerDisabledModules(ws)) granted.delete(k);
  return ALL_MODULE_KEYS.filter((k) => granted.has(k));
}

export function moduleEnabled(ws: WorkspaceRow, plan: PlanRow | undefined, key: ModuleKey): boolean {
  return effectiveModules(ws, plan).includes(key);
}

/** Asignación agregada actual: suma de reservas de TODOS los servicios del workspace + recuentos. */
export function workspaceAllocation(workspaceId: string): WorkspaceAllocation {
  const services = listWorkspaceServices(workspaceId);
  let cpu = 0;
  let mem = 0;
  let disk = 0;
  let uCpu = 0;
  let uMem = 0;
  let uDisk = 0;
  for (const s of services) {
    const cfg = s.config as any;
    const res = serviceReservation(s.type, cfg);
    cpu += res.cpuCores;
    mem += res.memoryMb;
    disk += res.diskMb;
    if (!(typeof cfg?.cpus === 'number' && cfg.cpus > 0)) uCpu += 1;
    if (!(typeof cfg?.memoryMb === 'number' && cfg.memoryMb > 0)) uMem += 1;
    if (!(typeof cfg?.diskMb === 'number' && cfg.diskMb > 0)) uDisk += 1;
  }
  return {
    cpuCores: Math.round(cpu * 100) / 100,
    memoryMb: mem,
    diskMb: disk,
    projects: countWorkspaceProjects(workspaceId),
    services: services.length,
    members: countWorkspaceMembers(workspaceId),
    unlimited: { cpu: uCpu, memory: uMem, disk: uDisk },
  };
}

export type QuotaField = 'cpu' | 'memory' | 'disk' | 'projects' | 'services' | 'members';

export interface QuotaViolation {
  field: QuotaField;
  limit: number;
  requested: number;
  unit: string;
}

const FIELD_LABEL: Record<QuotaField, string> = {
  cpu: 'CPU',
  memory: 'memoria',
  disk: 'disco',
  projects: 'proyectos',
  services: 'servicios',
  members: 'usuarios',
};

const FIELD_UNIT: Record<QuotaField, string> = {
  cpu: 'núcleos',
  memory: 'MB',
  disk: 'MB',
  projects: '',
  services: '',
  members: '',
};

/** Mensaje en español para una violación de cuota (para el 409). */
export function quotaMessage(v: QuotaViolation): string {
  const unit = v.unit ? ` ${v.unit}` : '';
  return `Supera la cuota del workspace para ${FIELD_LABEL[v.field]}: ${v.requested}${unit} solicitados de ${v.limit}${unit} disponibles. Un administrador puede ampliar la cuota.`;
}

/**
 * Comprueba una asignación de recursos prospectiva contra la cuota. Devuelve la
 * primera dimensión superada, o null si cabe. Tolerancia pequeña para redondeos.
 */
export function checkResourceQuota(quota: EffectiveQuota, prospective: Reservation): QuotaViolation | null {
  const EPS = 0.001;
  if (prospective.cpuCores > quota.cpuCores + EPS) {
    return { field: 'cpu', limit: quota.cpuCores, requested: Math.round(prospective.cpuCores * 100) / 100, unit: FIELD_UNIT.cpu };
  }
  if (prospective.memoryMb > quota.memoryMb) {
    return { field: 'memory', limit: quota.memoryMb, requested: prospective.memoryMb, unit: FIELD_UNIT.memory };
  }
  if (prospective.diskMb > quota.diskMb) {
    return { field: 'disk', limit: quota.diskMb, requested: prospective.diskMb, unit: FIELD_UNIT.disk };
  }
  return null;
}

export function isWorkspaceActive(ws: WorkspaceRow): boolean {
  return ws.status === 'active';
}

/** El workspace de un proyecto (o undefined si el proyecto no está asignado). */
export function workspaceOfProject(projectId: string): WorkspaceRow | undefined {
  const project = getProject(projectId);
  if (!project || !project.workspace_id) return undefined;
  return getWorkspace(project.workspace_id);
}

/**
 * Comprueba si un módulo está disponible para actuar sobre un proyecto. Los
 * administradores de plataforma traspasan siempre las gates (controlan todo,
 * también en nombre del cliente). Un proyecto sin workspace no tiene gates.
 */
export function moduleAllowedForProject(projectId: string, key: ModuleKey, isPlatformAdmin: boolean): boolean {
  if (isPlatformAdmin) return true;
  const ws = workspaceOfProject(projectId);
  if (!ws) return true;
  return moduleEnabled(ws, workspacePlan(ws), key);
}

/**
 * Resumen completo del estado de cuota de un workspace, para la API: cuota
 * efectiva, asignación agregada, uso reciente y módulos (concedidos / acotados /
 * efectivos). El `over` marca las dimensiones donde la asignación ya supera la
 * cuota (p. ej. tras un «live resize» a la baja del admin): se avisa, no se mata.
 */
export function workspaceQuotaSummary(ws: WorkspaceRow) {
  const plan = workspacePlan(ws);
  const quota = effectiveQuota(ws, plan);
  const allocation = workspaceAllocation(ws.id);
  const granted = grantedModules(ws, plan);
  const disabled = ownerDisabledModules(ws);
  const effective = effectiveModules(ws, plan);
  const over = {
    cpu: allocation.cpuCores > quota.cpuCores,
    memory: allocation.memoryMb > quota.memoryMb,
    disk: allocation.diskMb > quota.diskMb,
    projects: allocation.projects > quota.maxProjects,
    services: allocation.services > quota.maxServices,
    members: allocation.members > quota.maxMembers,
  };
  return {
    plan: plan ? { id: plan.id, name: plan.name, price_cents: plan.price_cents, currency: plan.currency, interval: plan.interval } : null,
    quota,
    allocation,
    modules: { granted, disabled, effective },
    over,
    inheriting: {
      cpuCores: ws.cpu_cores == null,
      memoryMb: ws.memory_mb == null,
      diskMb: ws.disk_mb == null,
      maxProjects: ws.max_projects == null,
      maxServices: ws.max_services == null,
      maxMembers: ws.max_members == null,
      modules: ws.modules_override == null,
    },
  };
}
