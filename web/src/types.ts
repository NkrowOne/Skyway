export type ContainerState =
  | 'running'
  | 'restarting'
  | 'exited'
  | 'paused'
  | 'created'
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
  healthcheckPath?: string | null;
}

export interface DatabaseConfig {
  template: string;
  version: string;
  hostPort?: number | null;
  cpus?: number | null;
  memoryMb?: number | null;
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
  services: Record<string, { state: ContainerState; stats: ServiceStats | null }>;
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
