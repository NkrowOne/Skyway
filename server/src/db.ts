import Database from 'better-sqlite3';
import path from 'path';
import { config } from './config';
import {
  AlertRow,
  AlertSeverity,
  AuditRow,
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
    CREATE TABLE IF NOT EXISTS project_vars (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (project_id, key)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      severity TEXT NOT NULL,
      type TEXT NOT NULL,
      project_id TEXT,
      service_id TEXT,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      explanation TEXT,
      dedupe_key TEXT,
      resolved_at INTEGER,
      read_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(dedupe_key) WHERE resolved_at IS NULL;
  `);

  // Migraciones de columnas para bases de datos ya existentes.
  ensureColumn('projects', 'client', 'TEXT');
  ensureColumn('deployments', 'diagnosis', 'TEXT');
}

function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
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

export function updateUserPassword(userId: string, passwordHash: string): void {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
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
export function createProject(name: string, slug: string, client: string | null = null): ProjectRow {
  const row: ProjectRow = { id: id('prj'), name, slug, client, created_at: now() };
  db.prepare('INSERT INTO projects (id, name, slug, client, created_at) VALUES (?, ?, ?, ?, ?)').run(
    row.id, row.name, row.slug, row.client, row.created_at,
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

export function updateProjectMeta(projectId: string, name: string, client: string | null): void {
  db.prepare('UPDATE projects SET name = ?, client = ? WHERE id = ?').run(name, client, projectId);
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
    diagnosis: null,
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
    .prepare('SELECT id, service_id, status, trigger, commit_sha, commit_msg, image_tag, error, diagnosis, created_at, finished_at FROM deployments WHERE service_id = ? ORDER BY created_at DESC LIMIT ?')
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

export function setDeploymentDiagnosis(deploymentId: string, diagnosis: object | null): void {
  db.prepare('UPDATE deployments SET diagnosis = ? WHERE id = ?').run(
    diagnosis ? JSON.stringify(diagnosis) : null,
    deploymentId,
  );
}

// ---------- variables compartidas de proyecto ----------
export function getProjectVars(projectId: string): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM project_vars WHERE project_id = ? ORDER BY key').all(projectId) as any[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function setProjectVars(projectId: string, vars: Record<string, string>): void {
  const del = db.prepare('DELETE FROM project_vars WHERE project_id = ?');
  const ins = db.prepare('INSERT INTO project_vars (project_id, key, value) VALUES (?, ?, ?)');
  const tx = db.transaction(() => {
    del.run(projectId);
    for (const [k, v] of Object.entries(vars)) ins.run(projectId, k, v);
  });
  tx();
}

// ---------- auditoría ----------
export function insertAudit(entry: Omit<AuditRow, 'id' | 'ts'>): void {
  db.prepare(
    'INSERT INTO audit_log (id, ts, actor, action, target_type, target_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id('aud'), now(), entry.actor, entry.action, entry.target_type, entry.target_id, entry.detail, entry.ip);
}

export function listAudit(opts: { limit?: number; action?: string; projectId?: string } = {}): AuditRow[] {
  const limit = Math.min(opts.limit ?? 100, 500);
  if (opts.action) {
    return db
      .prepare('SELECT * FROM audit_log WHERE action LIKE ? ORDER BY ts DESC LIMIT ?')
      .all(`${opts.action}%`, limit) as AuditRow[];
  }
  return db.prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?').all(limit) as AuditRow[];
}

export function countFailedLogins(sinceMs: number): { count: number; ips: string[] } {
  const rows = db
    .prepare("SELECT ip FROM audit_log WHERE action = 'login_failed' AND ts > ?")
    .all(now() - sinceMs) as { ip: string | null }[];
  return { count: rows.length, ips: [...new Set(rows.map((r) => r.ip || '?'))].slice(0, 10) };
}

// ---------- alertas ----------
export function insertAlert(alert: {
  severity: AlertSeverity;
  type: string;
  project_id?: string | null;
  service_id?: string | null;
  title: string;
  message: string;
  explanation?: string | null;
  dedupe_key?: string | null;
}): AlertRow | null {
  if (alert.dedupe_key) {
    const open = db
      .prepare('SELECT id FROM alerts WHERE dedupe_key = ? AND resolved_at IS NULL')
      .get(alert.dedupe_key);
    if (open) return null;
  }
  const row: AlertRow = {
    id: id('alr'),
    ts: now(),
    severity: alert.severity,
    type: alert.type,
    project_id: alert.project_id ?? null,
    service_id: alert.service_id ?? null,
    title: alert.title,
    message: alert.message,
    explanation: alert.explanation ?? null,
    dedupe_key: alert.dedupe_key ?? null,
    resolved_at: null,
    read_at: null,
  };
  db.prepare(
    `INSERT INTO alerts (id, ts, severity, type, project_id, service_id, title, message, explanation, dedupe_key, resolved_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.ts, row.severity, row.type, row.project_id, row.service_id, row.title, row.message, row.explanation, row.dedupe_key, row.resolved_at, row.read_at);
  return row;
}

export function listAlerts(opts: { limit?: number; openOnly?: boolean } = {}): AlertRow[] {
  const limit = Math.min(opts.limit ?? 50, 200);
  if (opts.openOnly) {
    return db
      .prepare('SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY ts DESC LIMIT ?')
      .all(limit) as AlertRow[];
  }
  return db.prepare('SELECT * FROM alerts ORDER BY ts DESC LIMIT ?').all(limit) as AlertRow[];
}

export function countUnreadAlerts(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM alerts WHERE read_at IS NULL').get() as any).c;
}

export function markAlertsRead(): void {
  db.prepare('UPDATE alerts SET read_at = ? WHERE read_at IS NULL').run(now());
}

export function resolveAlert(alertId: string): boolean {
  const res = db.prepare('UPDATE alerts SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(now(), alertId);
  return res.changes > 0;
}

export function resolveAlertsByDedupe(dedupeKey: string): AlertRow[] {
  const open = db
    .prepare('SELECT * FROM alerts WHERE dedupe_key = ? AND resolved_at IS NULL')
    .all(dedupeKey) as AlertRow[];
  if (open.length > 0) {
    db.prepare('UPDATE alerts SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL').run(now(), dedupeKey);
  }
  return open;
}

export function openAlertCountsByService(projectId: string): Record<string, number> {
  const rows = db
    .prepare('SELECT service_id, COUNT(*) AS c FROM alerts WHERE project_id = ? AND resolved_at IS NULL AND service_id IS NOT NULL GROUP BY service_id')
    .all(projectId) as { service_id: string; c: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.service_id] = r.c;
  return out;
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
