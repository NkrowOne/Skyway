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
  type: 'git' | 'database';
  config: GitConfig & DatabaseConfig;
  created_at: number;
  runtime?: Runtime;
}

export type DeploymentStatus = 'queued' | 'building' | 'deploying' | 'success' | 'failed' | 'canceled';

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
  created_at: number;
  finished_at: number | null;
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
  dataDir: string;
}
