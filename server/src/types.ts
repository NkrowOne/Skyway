export type ServiceType = 'git' | 'database' | 'image';

export interface VolumeMount {
  name: string;
  containerPath: string;
}

export interface GitConfig {
  repoUrl: string;
  branch: string;
  /** Conector de GitHub del proyecto con cuyo token se clona (null/ausente = token global). */
  connectorId?: string | null;
  rootDir?: string;
  dockerfilePath?: string;
  startCmd?: string;
  port: number;
  buildArgs?: Record<string, string>;
  domains: string[];
  hostPort?: number | null;
  cpus?: number | null;
  memoryMb?: number | null;
  /** Cuota de disco orientativa en MB (volúmenes + capa de escritura): al superarla salta una alerta. */
  diskMb?: number | null;
  webhookSecret: string;
  volumes?: VolumeMount[];
  healthcheckPath?: string | null;
  replicas?: number;
}

export interface DatabaseConfig {
  template: string;
  version: string;
  domains?: string[];
  hostPort?: number | null;
  cpus?: number | null;
  memoryMb?: number | null;
  diskMb?: number | null;
  backupSchedule?: 'daily' | 'weekly' | null;
  backupRetention?: number;
}

export interface ImageConfig {
  image: string;
  port?: number | null;
  startCmd?: string;
  domains: string[];
  hostPort?: number | null;
  cpus?: number | null;
  memoryMb?: number | null;
  diskMb?: number | null;
  volumes?: VolumeMount[];
  healthcheckPath?: string | null;
  replicas?: number;
}

export type ServiceConfig = GitConfig | DatabaseConfig | ImageConfig;

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  client: string | null;
  created_at: number;
  /** Página de estado pública: token de la URL compartible y si está activa. */
  status_token: string | null;
  status_enabled: number;
  /** Aviso de mantenimiento visible en la página de estado (null = sin aviso). */
  status_notice: string | null;
}

export interface ServiceRow {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  type: ServiceType;
  config: ServiceConfig;
  created_at: number;
}

export type DeploymentStatus =
  | 'queued'
  | 'building'
  | 'deploying'
  | 'success'
  | 'failed'
  | 'canceled';

export interface Diagnosis {
  id: string;
  title: string;
  cause: string;
  fix: string;
}

export interface DeploymentRow {
  id: string;
  service_id: string;
  status: DeploymentStatus;
  trigger: string;
  commit_sha: string | null;
  commit_msg: string | null;
  image_tag: string | null;
  logs: string;
  error: string | null;
  diagnosis: string | null;
  created_at: number;
  finished_at: number | null;
}

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface AlertRow {
  id: string;
  ts: number;
  severity: AlertSeverity;
  type: string;
  project_id: string | null;
  service_id: string | null;
  title: string;
  message: string;
  explanation: string | null;
  dedupe_key: string | null;
  resolved_at: number | null;
  read_at: number | null;
}

export interface AuditRow {
  id: string;
  ts: number;
  actor: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: string | null;
  ip: string | null;
}

export interface SecurityFinding {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  fix: string;
  projectId?: string;
  projectName?: string;
  serviceId?: string;
  serviceName?: string;
}

export type ContainerState =
  | 'running'
  | 'restarting'
  | 'exited'
  | 'paused'
  | 'created'
  | 'removing'
  | 'dead'
  | 'not_created'
  | 'unknown';

export interface ServiceRuntime {
  state: ContainerState;
  startedAt: string | null;
  exitCode: number | null;
  restartCount: number;
  image: string | null;
}

export interface ServiceStats {
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  netRx: number;
  netTx: number;
}

/** Muestra puntual del consumo de un servicio (agregada de sus réplicas). */
export interface ServiceMetricSample {
  /** % de CPU en la convención de Docker: 100 = un núcleo completo. */
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  /** Bytes transferidos DESDE la muestra anterior (no acumulado): permite sumar por hora. */
  netRxDelta: number;
  netTxDelta: number;
}

/** Fila horaria del histórico de un servicio (sumas para medias + máximos para picos). */
export interface ServiceMetricHour {
  hour: number;
  samples: number;
  cpu_sum: number;
  cpu_max: number;
  mem_sum: number;
  mem_max: number;
  mem_limit_last: number;
  net_rx: number;
  net_tx: number;
  disk_last: number | null;
}

/** Fila horaria del histórico del host. */
export interface HostMetricHour {
  hour: number;
  samples: number;
  load_sum: number;
  load_max: number;
  mem_used_sum: number;
  mem_used_max: number;
  mem_total_last: number;
  disk_used_last: number | null;
  disk_total_last: number | null;
}

export type UserRole = 'admin' | 'member';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  session_epoch: number;
  created_at: number;
}

export interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string; // base64url
  public_key: string; // base64url
  counter: number;
  transports: string | null; // JSON array
  device_type: string | null;
  backed_up: number;
  rp_id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

export interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string; // sha256 hex del token completo
  prefix: string; // primeros caracteres, para identificarlo en la UI
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

/**
 * Conector de GitHub ligado a un proyecto: un cliente conecta su propio token
 * para desplegar sus repos privados sin depender del token global del admin.
 * El token se necesita en claro para clonar; jamás se devuelve por la API.
 */
export interface GithubConnectorRow {
  id: string;
  project_id: string;
  name: string;
  token: string;
  gh_login: string;
  token_type: string;
  created_by: string; // email de quien lo conectó (auditoría y control del admin)
  created_at: number;
  last_used_at: number | null;
}
