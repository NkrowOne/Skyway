export type ServiceType = 'git' | 'database' | 'image';

export interface VolumeMount {
  name: string;
  containerPath: string;
}

export interface GitConfig {
  repoUrl: string;
  branch: string;
  rootDir?: string;
  dockerfilePath?: string;
  startCmd?: string;
  port: number;
  buildArgs?: Record<string, string>;
  domains: string[];
  hostPort?: number | null;
  cpus?: number | null;
  memoryMb?: number | null;
  webhookSecret: string;
  volumes?: VolumeMount[];
  healthcheckPath?: string | null;
}

export interface DatabaseConfig {
  template: string;
  version: string;
  domains?: string[];
  hostPort?: number | null;
  cpus?: number | null;
  memoryMb?: number | null;
}

export interface ImageConfig {
  image: string;
  port?: number | null;
  startCmd?: string;
  domains: string[];
  hostPort?: number | null;
  cpus?: number | null;
  memoryMb?: number | null;
  volumes?: VolumeMount[];
  healthcheckPath?: string | null;
}

export type ServiceConfig = GitConfig | DatabaseConfig | ImageConfig;

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  client: string | null;
  created_at: number;
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

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: number;
}
