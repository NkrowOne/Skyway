import Database from 'better-sqlite3';
import path from 'path';
import { config } from './config';
import {
  DeploymentRow,
  DeploymentStatus,
  ProjectRow,
  ServiceConfig,
  ServiceRow,
  ServiceType,
  UserRow,
} from './types';
import { id, now } from './util';

let db: Database.Database;

export function initDb(): void {
  db = new Database(path.join(config.dataDir, 'skyway.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(project_id, slug)
    );
    CREATE TABLE IF NOT EXISTS env_vars (
      service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (service_id, key)
    );
    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      trigger TEXT NOT NULL,
      commit_sha TEXT,
      commit_msg TEXT,
      image_tag TEXT,
      logs TEXT NOT NULL DEFAULT '',
      error TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_deployments_service ON deployments(service_id, created_at DESC);
  `);
}

function parseService(row: any): ServiceRow {
  return { ...row, config: JSON.parse(row.config) };
}

// ---------- users ----------
export function countUsers(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM users').get() as any).c;
}

export function createUser(email: string, passwordHash: string): UserRow {
  const row: UserRow = { id: id('usr'), email, password_hash: passwordHash, created_at: now() };
  db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
    row.id, row.email, row.password_hash, row.created_at,
  );
  return row;
}

export function getUserByEmail(email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
}

export function getUser(userId: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
}

// ---------- settings ----------
export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string | null): void {
  if (value === null || value === '') {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  } else {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }
}

// ---------- projects ----------
export function createProject(name: string, slug: string): ProjectRow {
  const row: ProjectRow = { id: id('prj'), name, slug, created_at: now() };
  db.prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)').run(
    row.id, row.name, row.slug, row.created_at,
  );
  return row;
}

export function listProjects(): ProjectRow[] {
  return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[];
}

export function getProject(projectId: string): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
}

export function projectSlugExists(slug: string): boolean {
  return !!db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug);
}

export function renameProject(projectId: string, name: string): void {
  db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, projectId);
}

export function deleteProject(projectId: string): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
}

// ---------- services ----------
export function createService(
  projectId: string,
  name: string,
  slug: string,
  type: ServiceType,
  cfg: ServiceConfig,
): ServiceRow {
  const row = { id: id('svc'), project_id: projectId, name, slug, type, config: cfg, created_at: now() };
  db.prepare(
    'INSERT INTO services (id, project_id, name, slug, type, config, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(row.id, row.project_id, row.name, row.slug, row.type, JSON.stringify(cfg), row.created_at);
  return row as ServiceRow;
}

export function listServices(projectId: string): ServiceRow[] {
  return (db.prepare('SELECT * FROM services WHERE project_id = ? ORDER BY created_at ASC').all(projectId) as any[])
    .map(parseService);
}

export function getService(serviceId: string): ServiceRow | undefined {
  const row = db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId) as any;
  return row ? parseService(row) : undefined;
}

export function serviceSlugExists(projectId: string, slug: string): boolean {
  return !!db.prepare('SELECT 1 FROM services WHERE project_id = ? AND slug = ?').get(projectId, slug);
}

export function updateService(serviceId: string, name: string, cfg: ServiceConfig): void {
  db.prepare('UPDATE services SET name = ?, config = ? WHERE id = ?').run(name, JSON.stringify(cfg), serviceId);
}

export function deleteService(serviceId: string): void {
  db.prepare('DELETE FROM services WHERE id = ?').run(serviceId);
}

// ---------- env vars ----------
export function getEnv(serviceId: string): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM env_vars WHERE service_id = ? ORDER BY key').all(serviceId) as any[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function setEnv(serviceId: string, vars: Record<string, string>): void {
  const del = db.prepare('DELETE FROM env_vars WHERE service_id = ?');
  const ins = db.prepare('INSERT INTO env_vars (service_id, key, value) VALUES (?, ?, ?)');
  const tx = db.transaction(() => {
    del.run(serviceId);
    for (const [k, v] of Object.entries(vars)) ins.run(serviceId, k, v);
  });
  tx();
}

// ---------- deployments ----------
export function createDeployment(serviceId: string, trigger: string, imageTag?: string | null): DeploymentRow {
  const row: DeploymentRow = {
    id: id('dep'),
    service_id: serviceId,
    status: 'queued',
    trigger,
    commit_sha: null,
    commit_msg: null,
    image_tag: imageTag ?? null,
    logs: '',
    error: null,
    created_at: now(),
    finished_at: null,
  };
  db.prepare(
    `INSERT INTO deployments (id, service_id, status, trigger, commit_sha, commit_msg, image_tag, logs, error, created_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.service_id, row.status, row.trigger, row.commit_sha, row.commit_msg, row.image_tag, row.logs, row.error, row.created_at, row.finished_at);
  return row;
}

export function updateDeployment(
  deploymentId: string,
  fields: Partial<Pick<DeploymentRow, 'status' | 'commit_sha' | 'commit_msg' | 'image_tag' | 'logs' | 'error' | 'finished_at'>>,
): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE deployments SET ${sets} WHERE id = ?`).run(...keys.map((k) => (fields as any)[k]), deploymentId);
}

export function getDeployment(deploymentId: string): DeploymentRow | undefined {
  return db.prepare('SELECT * FROM deployments WHERE id = ?').get(deploymentId) as DeploymentRow | undefined;
}

export function listDeployments(serviceId: string, limit = 20): DeploymentRow[] {
  return db
    .prepare('SELECT id, service_id, status, trigger, commit_sha, commit_msg, image_tag, error, created_at, finished_at FROM deployments WHERE service_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(serviceId, limit)
    .map((r: any) => ({ ...r, logs: '' })) as DeploymentRow[];
}

export function latestDeployment(serviceId: string): DeploymentRow | undefined {
  return db
    .prepare('SELECT * FROM deployments WHERE service_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(serviceId) as DeploymentRow | undefined;
}

export function successfulDeploymentsBeyond(serviceId: string, keep: number): DeploymentRow[] {
  return db
    .prepare(
      `SELECT * FROM deployments WHERE service_id = ? AND status = 'success' AND image_tag IS NOT NULL
       ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
    )
    .all(serviceId, keep) as DeploymentRow[];
}

export function markStaleDeploymentsFailed(): number {
  const res = db
    .prepare(
      `UPDATE deployments SET status = 'failed', error = 'Interrumpido por reinicio del servidor', finished_at = ?
       WHERE status IN ('queued', 'building', 'deploying')`,
    )
    .run(now());
  return res.changes;
}
