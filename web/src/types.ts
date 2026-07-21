export type UserRole = 'admin' | 'member';

export interface Me {
  needsSetup: boolean;
  user: { id: string; email: string; role: UserRole } | null;
}

export interface UserSummary {
  id: string;
  email: string;
  role: UserRole;
  created_at: number;
  projectIds: string[];
  passkeys: number;
  tokens: number;
}

export interface Passkey {
  id: string;
  name: string;
  rp_id: string;
  device_type: string | null;
  backed_up: boolean;
  created_at: number;
  last_used_at: number | null;
}

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

/** Conector de GitHub de un proyecto: el token queda en el servidor, aquí solo metadatos. */
export interface GithubConnector {
  id: string;
  project_id: string;
  name: string;
  gh_login: string;
  token_type: string;
  created_by: string;
  created_at: number;
  last_used_at: number | null;
  project_name?: string; // solo en la vista global del admin
  project_client?: string | null;
}

export interface GithubRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
  description: string | null;
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

export interface Runtime {
  state: ContainerState;
  startedAt: string | null;
  exitCode: number | null;
  restartCount: number;
  image: string | null;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  client: string | null;
  created_at: number;
  serviceCount?: number;
  lastDeployAt?: number | null;
  openAlerts?: number;
}

export interface GitConfig {
  repoUrl: string;
  branch: string;
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
  diskMb?: number | null;
  webhookSecret: string;
  healthcheckPath?: string | null;
  replicas?: number;
}

export interface DatabaseConfig {
  template: string;
  version: string;
  hostPort?: number | null;
  cpus?: number | null;
  memoryMb?: number | null;
  diskMb?: number | null;
  backupSchedule?: 'daily' | 'weekly' | null;
  backupRetention?: number;
}

export interface Service {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  type: 'git' | 'database' | 'image';
  config: GitConfig & DatabaseConfig & { image?: string };
  created_at: number;
  runtime?: Runtime;
}

export type DeploymentStatus = 'queued' | 'building' | 'deploying' | 'success' | 'failed' | 'canceled';

export interface Diagnosis {
  id: string;
  title: string;
  cause: string;
  fix: string;
}

export interface Deployment {
  id: string;
  service_id: string;
  status: DeploymentStatus;
  trigger: string;
  commit_sha: string | null;
  commit_msg: string | null;
  image_tag: string | null;
  logs?: string;
  error: string | null;
  diagnosis: string | null;
  created_at: number;
  finished_at: number | null;
}

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface Alert {
  id: string;
  ts: number;
  severity: AlertSeverity;
  type: string;
  project_id: string | null;
  service_id: string | null;
  title: string;
  message: string;
  explanation: string | null;
  resolved_at: number | null;
  read_at: number | null;
}

export interface AuditEntry {
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

export interface SecurityReport {
  score: number;
  grade: string;
  findings: SecurityFinding[];
  failedLogins24h: number;
  jwtFromEnv: boolean;
}

export interface ServiceStats {
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  netRx: number;
  netTx: number;
}

export interface MetricsSnapshot {
  ts: number;
  docker: boolean;
  host?: {
    cpus: number;
    load: number;
    totalMem: number;
    freeMem: number;
  };
  services: Record<
    string,
    { state: ContainerState; stats: ServiceStats | null; replicas?: { running: number; total: number } }
  >;
}

// ---------- histórico de consumo ----------

/** Un punto (cubo) del histórico de consumo de un servicio. */
export interface ServiceMetricPoint {
  t: number;
  /** Muestras que respaldan el cubo (para ponderar la media del periodo). */
  samples: number;
  /** Media de CPU en el cubo (100 = un núcleo). null si el servicio no corría. */
  cpuAvg: number | null;
  cpuMax: number | null;
  memAvg: number | null;
  memMax: number | null;
  memLimit: number | null;
  netRx: number;
  netTx: number;
  disk: number | null;
}

export interface ServiceMetricHistory {
  hours: number;
  points: ServiceMetricPoint[];
}

/** Un punto (cubo) del histórico de consumo del host. */
export interface HostMetricPoint {
  t: number;
  loadAvg: number | null;
  loadMax: number | null;
  memUsedAvg: number | null;
  memUsedMax: number | null;
  memTotal: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
}

export interface HostMetricHistory {
  hours: number;
  points: HostMetricPoint[];
}

export interface DbTemplate {
  key: string;
  label: string;
  description: string;
  image: string;
  defaultVersion: string;
  port: number;
}

export interface SystemInfo {
  version: string;
  docker: boolean;
  nixpacks: boolean;
  host: {
    platform: string;
    arch: string;
    cpus: number;
    totalMem: number;
    freeMem: number;
    load: number[];
    uptime: number;
  };
  disk: { total: number; free: number } | null;
  dataDir: string;
}

export interface DockerUsage {
  images: { count: number; size: number };
  containers: { count: number; size: number };
  volumes: { count: number; size: number };
  buildCache: { size: number };
}

// ---------- monitor global ----------

export interface MonitorService {
  id: string;
  projectId: string;
  projectName: string;
  client: string | null;
  name: string;
  slug: string;
  type: 'git' | 'database' | 'image';
  template?: string;
  image?: string;
  domains: string[];
  state: ContainerState;
  startedAt: string | null;
  exitCode: number | null;
  exitExplanation: string | null;
  restartCount: number;
  replicas: { running: number; total: number };
  stats: { cpuPercent: number; memUsage: number; memLimit: number } | null;
  memoryMb: number | null;
  cpus: number | null;
  alerts: number;
  lastDeploy: { id: string; status: DeploymentStatus; created_at: number } | null;
  disk: { totalBytes: number | null; quotaMb: number | null };
  uptime24h: number | null;
}

export interface MonitorOverview {
  docker: boolean;
  host: {
    cpus: number;
    load: number;
    totalMem: number;
    freeMem: number;
    disk: { total: number; free: number } | null;
  };
  services: MonitorService[];
}

export interface LogSearchResult {
  serviceId: string;
  serviceName: string;
  projectId: string;
  projectName: string;
  replica: number | null;
  ts: number | null;
  line: string;
}

export interface DiskBreakdown {
  host: { total: number; free: number } | null;
  docker: DockerUsage | null;
  services: {
    serviceId: string;
    name: string;
    type: string;
    projectId: string;
    projectName: string;
    totalBytes: number;
    containerBytes: number;
    logBytes: number | null;
    volumes: { name: string; sizeBytes: number }[];
    quotaMb: number | null;
  }[];
}

// ---------- sitios web ----------

export interface WebsiteEntry {
  id: string;
  name: string;
  type: 'git' | 'image';
  image?: string;
  repoUrl?: string;
  projectId: string;
  projectName: string;
  client: string | null;
  domains: string[];
  hostPort: number | null;
  state: ContainerState;
  startedAt: string | null;
  replicas: { running: number; total: number };
  alerts: number;
  lastDeploy: { status: DeploymentStatus; created_at: number; finished_at: number | null } | null;
}

// ---------- consola de base de datos ----------

export interface DbObject {
  name: string;
  rows: number | null;
  sizeBytes: number | null;
}

export interface DbOverview {
  engine: 'postgres' | 'mysql' | 'mongo' | 'redis';
  version: string | null;
  sizeBytes: number | null;
  objectLabel: string;
  objects: DbObject[];
}

export interface DbSnippet {
  label: string;
  query: string;
  hint?: string;
}

export interface DbQueryResult {
  kind: 'table' | 'text';
  columns?: string[];
  rows?: string[][];
  raw?: string;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  notice?: string;
}

// ---------- explorador de archivos ----------

export interface FileEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  perms: string;
  target?: string;
}

export interface DirListing {
  path: string;
  entries: FileEntry[];
}

// ---------- página de estado pública ----------

export type PublicServiceState = 'operational' | 'degraded' | 'down' | 'unknown';

export interface StatusPageConfig {
  enabled: boolean;
  token: string | null;
  notice: string | null;
}

export interface PublicStatusService {
  name: string;
  type: string;
  state: PublicServiceState;
  uptime24h: number | null;
  uptime7d: number | null;
  uptime90d: number | null;
  days: { date: number; pct: number | null }[];
}

export interface PublicStatus {
  project: { name: string; client: string | null };
  overall: PublicServiceState;
  notice: string | null;
  services: PublicStatusService[];
  incidents: {
    id: string;
    title: string;
    startedAt: number;
    resolvedAt: number | null;
    severity: AlertSeverity;
  }[];
  generatedAt: number;
}
