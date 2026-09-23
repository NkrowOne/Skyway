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

/*
 * Formateadores reutilizados. `toLocaleString` y `new Intl.NumberFormat`
 * construyen un formateador nuevo en cada llamada, y estas funciones se
 * ejecutan por fila de tabla y por marca de eje en cada repintado: con cien
 * filas y una gráfica en vivo eran miles de instancias por segundo.
 */
const DATE_FMT = new Map<string, Intl.DateTimeFormat>();
function dateFmt(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(opts);
  let f = DATE_FMT.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('es', opts);
    DATE_FMT.set(key, f);
  }
  return f;
}
const MONEY_FMT = new Map<string, Intl.NumberFormat>();

/** Etiqueta de eje temporal adaptada a la ventana (24 h → hora; días → fecha). */
export function fmtAxisTime(ts: number, hours: number): string {
  const d = new Date(ts);
  if (hours <= 24) return dateFmt({ hour: '2-digit', minute: '2-digit' }).format(d);
  if (hours <= 24 * 7) return dateFmt({ weekday: 'short', hour: '2-digit' }).format(d);
  return dateFmt({ day: '2-digit', month: '2-digit' }).format(d);
}

/** MB legibles (RAM/disco): reutiliza fmtBytes convirtiendo desde megabytes. */
export function fmtMb(mb: number): string {
  return fmtBytes(mb * 1024 * 1024);
}

/** Importe monetario a partir de céntimos (facturación). */
export function fmtMoney(cents: number, currency = 'EUR'): string {
  try {
    let f = MONEY_FMT.get(currency);
    if (!f) {
      f = new Intl.NumberFormat('es', { style: 'currency', currency });
      MONEY_FMT.set(currency, f);
    }
    return f.format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** Fecha corta (día/mes/año) para periodos de facturación. */
export function fmtDate(ts: number): string {
  return dateFmt({ day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(ts));
}

/** Fecha+hora completa para tooltips del histórico. */
export function fmtStamp(ts: number, hours: number): string {
  const d = new Date(ts);
  if (hours <= 24) return dateFmt({ hour: '2-digit', minute: '2-digit' }).format(d);
  if (hours <= 24 * 7) return dateFmt({ weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit' }).format(d);
  return dateFmt({ weekday: 'short', day: '2-digit', month: '2-digit' }).format(d);
}

export const STATE_LABEL: Record<ContainerState, string> = {
  running: 'Activo',
  restarting: 'Reiniciando',
  exited: 'Detenido',
  paused: 'Pausado',
  created: 'Creado',
  removing: 'Eliminando',
  dead: 'Inoperativo',
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

/**
 * Lo que de verdad se quiere saber de un servicio, en cinco casos: está en
 * pie, lo pararon adrede, se cayó, está cambiando, o no existe todavía.
 */
export type ServiceStatusKind = 'up' | 'stopped' | 'down' | 'transient' | 'none';

export interface ServiceStatus {
  kind: ServiceStatusKind;
  tone: Tone;
  label: string;
  pulse?: boolean;
  /** Matiz corto para un title o una línea secundaria («código 137»). */
  detail?: string;
}

/** Códigos de salida con nombre: el número solo no le dice nada a nadie. */
function explainExit(code: number | null | undefined): string | undefined {
  if (code === null || code === undefined) return undefined;
  if (code === 137) return 'sin memoria o terminado por el sistema (código 137)';
  if (code === 143) return 'detenido por SIGTERM (código 143)';
  if (code === 0) return 'finalizó sin error (código 0)';
  return `finalizó con código ${code}`;
}

/**
 * Docker solo dice «exited», y eso vale lo mismo para «lo paré yo» que para
 * «se murió». Con la marca de parada manual del servidor (o una salida limpia,
 * código 0) es una parada y va en gris; si no, es una caída y va en rojo.
 */
export function serviceStatus(
  state: ContainerState,
  runtime?: { exitCode?: number | null; stoppedAt?: number | null },
): ServiceStatus {
  switch (state) {
    case 'running':
      return { kind: 'up', tone: 'ok', label: 'Activo' };
    case 'restarting':
      return { kind: 'transient', tone: 'warn', label: 'Reiniciando', pulse: true };
    case 'removing':
      return { kind: 'transient', tone: 'warn', label: 'Eliminando', pulse: true };
    case 'paused':
      return { kind: 'stopped', tone: 'warn', label: 'Pausado' };
    case 'created':
      return { kind: 'stopped', tone: 'neutral', label: 'Creado', detail: 'todavía no se ha iniciado' };
    case 'exited': {
      const manual = !!runtime?.stoppedAt || runtime?.exitCode === 0;
      if (manual) {
        return {
          kind: 'stopped',
          tone: 'neutral',
          label: 'Detenido',
          detail: runtime?.stoppedAt ? 'desde el panel' : explainExit(runtime?.exitCode),
        };
      }
      return { kind: 'down', tone: 'err', label: 'Caído', detail: explainExit(runtime?.exitCode) };
    }
    case 'dead':
      return { kind: 'down', tone: 'err', label: 'Caído', detail: explainExit(runtime?.exitCode) };
    case 'not_created':
      return { kind: 'none', tone: 'neutral', label: 'Sin desplegar' };
    default:
      return { kind: 'none', tone: 'neutral', label: 'Desconocido' };
  }
}

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
  autodeploy: 'automático',
  rollback: 'reversión',
  import: 'importación',
};

export function isActiveDeploy(status: DeploymentStatus): boolean {
  return status === 'queued' || status === 'building' || status === 'deploying';
}

export type Severity = 'critical' | 'warning' | 'info';

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Crítico',
  warning: 'Advertencia',
  info: 'Información',
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
  backup_failed: 'Copia de seguridad fallida',
  system_backup_failed: 'Copia de seguridad del panel fallida',
  db_integrity: 'Base de datos del panel dañada',
  disk_quota: 'Espacio asignado superado',
  disk_quota_soon: 'Espacio asignado al 90 %',
};

export const AUDIT_ACTION_LABEL: Record<string, string> = {
  setup: 'Cuenta creada',
  login: 'Inicio de sesión',
  login_failed: 'Inicio de sesión fallido',
  login_blocked: 'Inicio de sesión bloqueado (límite de intentos)',
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
  service_rollback: 'Vuelta a una versión anterior',
  service_start: 'Servicio iniciado',
  service_stop: 'Servicio detenido',
  service_restart: 'Servicio reiniciado',
  service_env_updated: 'Variables actualizadas',
  settings_updated: 'Ajustes globales cambiados',
  webhook_push: 'Push recibido (webhook)',
  autodeploy: 'Despliegue automático (commit nuevo)',
  server_started: 'Servidor iniciado',
  railway_import: 'Proyecto importado de Railway',
  data_migration_started: 'Copia de datos iniciada',
  data_migration_canceled: 'Copia de datos cancelada',
  github_app_created: 'GitHub App conectada',
  github_app_disconnected: 'GitHub App desenlazada',
  github_installation_connected: 'Cuenta de GitHub conectada',
  github_installation_removed: 'Cuenta de GitHub desconectada',
  github_installation_deleted: 'Instalación de GitHub eliminada en GitHub',
  github_installation_suspended: 'Instalación de GitHub suspendida/reactivada',
  deployment_canceled: 'Despliegue cancelado',
  project_deploy_all: 'Despliegue de todo el proyecto',
  service_exec: 'Comando ejecutado en contenedor',
  backup_created: 'Copia de seguridad creada',
  backup_downloaded: 'Copia de seguridad descargada',
  backup_restored: 'Copia de seguridad restaurada',
  backup_deleted: 'Copia de seguridad eliminada',
  system_backup_created: 'Copia de seguridad del panel creada',
  system_backup_downloaded: 'Copia de seguridad del panel descargada',
  system_backup_deleted: 'Copia de seguridad del panel eliminada',
  db_integrity_failed: 'Comprobación de integridad de la base de datos del panel fallida',
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
  return dateFmt({ day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
}

/** Detección de macOS / iOS para adaptar atajos de teclado (⌘ vs Ctrl) */
export const isMac =
  typeof navigator !== 'undefined' &&
  Boolean(
    /Mac|iPhone|iPod|iPad/i.test(
      (navigator as any).userAgentData?.platform || navigator.platform || navigator.userAgent,
    ),
  );

/** Tecla modificadora principal: ⌘ en Mac, Ctrl en Windows/Linux */
export const MOD_KEY = isMac ? '⌘' : 'Ctrl';

/** Etiqueta de la paleta de comandos: ⌘K en Mac, Ctrl+K en Windows/Linux */
export const CMD_K_LABEL = isMac ? '⌘K' : 'Ctrl+K';

/** Etiqueta de ejecutar consulta: ⌘↵ en Mac, Ctrl+↵ en Windows/Linux */
export const CMD_ENTER_LABEL = isMac ? '⌘↵' : 'Ctrl+↵';

/**
 * Vacíos compartidos para `datos ?? EMPTY_LIST` mientras una consulta carga: un
 * `[]` o `{}` literal en el cuerpo del componente es un objeto nuevo en cada
 * render y obliga a recalcular todos los `useMemo` que dependan de él.
 */
export const EMPTY_LIST: never[] = [];
export const EMPTY_RECORD: Record<string, never> = {};

/**
 * `owner/repo` a partir de lo que alguien escribe o pega: el atajo, la URL de
 * GitHub (con o sin `.git`, con o sin barra final) o null si no se reconoce.
 */
export function parseRepoInput(raw: string): string | null {
  const t = raw.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const direct = /^([\w.-]+)\/([\w.-]+)$/.exec(t);
  if (direct) return `${direct[1]}/${direct[2]}`;
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/i.exec(t);
  return url ? `${url[1]}/${url[2]}` : null;
}

/**
 * Copia texto al portapapeles y dice si lo ha conseguido.
 *
 * La API moderna solo existe en contextos seguros (HTTPS o localhost). Un
 * panel auto-alojado que se abre por IP en la red local no lo es, y ahí
 * `navigator.clipboard` ni siquiera existe: el botón de copiar fallaba con una
 * excepción antes de llegar al `catch` y parecía no hacer nada. En ese caso se
 * recurre al método clásico (área de texto oculta + `execCommand`), que sigue
 * funcionando en HTTP. Debe llamarse dentro del gesto del usuario.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* permiso denegado: se prueba el método clásico */
    }
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.setAttribute('aria-hidden', 'true');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.width = '1px';
    area.style.height = '1px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
