import Database from 'better-sqlite3';
import path from 'path';
import { config } from './config';
import {
  AlertRow,
  AlertSeverity,
  ApiTokenRow,
  AuditRow,
  DeploymentRow,
  DeploymentStatus,
  GithubConnectorRow,
  HostMetricHour,
  PasskeyRow,
  ProjectRow,
  ServiceConfig,
  ServiceMetricHour,
  ServiceMetricSample,
  ServiceRow,
  ServiceType,
  UserRole,
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
      role TEXT NOT NULL DEFAULT 'admin',
      session_epoch INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_projects (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, project_id)
    );
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      device_type TEXT,
      backed_up INTEGER NOT NULL DEFAULT 0,
      rp_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      expires_at INTEGER
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
  ensureColumn('users', 'role', "TEXT NOT NULL DEFAULT 'admin'"); // los usuarios previos eran el dueño
  ensureColumn('users', 'session_epoch', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('projects', 'status_token', 'TEXT');
  ensureColumn('projects', 'status_enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('projects', 'status_notice', 'TEXT');

  // Histórico de disponibilidad agregado por horas (para las páginas de estado):
  // una fila por servicio y hora, con muestras totales y muestras "en marcha".
  db.exec(`
    CREATE TABLE IF NOT EXISTS uptime_hourly (
      service_id TEXT NOT NULL,
      hour INTEGER NOT NULL,
      up INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (service_id, hour)
    );
  `);

  // Histórico de consumo por servicio y hora: una fila por servicio y hora con
  // sumas (para medias) y máximos (para picos) de CPU/RAM, bytes de red del
  // periodo (delta, no acumulado) y la última foto de disco de esa hora. El
  // monitor lo alimenta cada 30 s; se conservan ~90 días y se podan a diario.
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_metrics_hourly (
      service_id TEXT NOT NULL,
      hour INTEGER NOT NULL,
      samples INTEGER NOT NULL DEFAULT 0,
      cpu_sum REAL NOT NULL DEFAULT 0,
      cpu_max REAL NOT NULL DEFAULT 0,
      mem_sum REAL NOT NULL DEFAULT 0,
      mem_max REAL NOT NULL DEFAULT 0,
      mem_limit_last REAL NOT NULL DEFAULT 0,
      net_rx REAL NOT NULL DEFAULT 0,
      net_tx REAL NOT NULL DEFAULT 0,
      disk_last REAL,
      PRIMARY KEY (service_id, hour)
    );
    CREATE TABLE IF NOT EXISTS host_metrics_hourly (
      hour INTEGER PRIMARY KEY,
      samples INTEGER NOT NULL DEFAULT 0,
      load_sum REAL NOT NULL DEFAULT 0,
      load_max REAL NOT NULL DEFAULT 0,
      mem_used_sum REAL NOT NULL DEFAULT 0,
      mem_used_max REAL NOT NULL DEFAULT 0,
      mem_total_last REAL NOT NULL DEFAULT 0,
      disk_used_last REAL,
      disk_total_last REAL
    );
  `);

  // Conectores de GitHub por proyecto: tokens de los clientes para clonar sus
  // repos. Caen en cascada con el proyecto.
  db.exec(`
    CREATE TABLE IF NOT EXISTS github_connectors (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token TEXT NOT NULL,
      gh_login TEXT NOT NULL,
      token_type TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_github_connectors_project ON github_connectors(project_id);
  `);
}

function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/**
 * Copia consistente y compactada de la base de datos del panel en `dest`
 * (VACUUM INTO): sirve como snapshot de backup incluso con la BD en uso.
 */
export function vacuumInto(dest: string): void {
  db.prepare('VACUUM INTO ?').run(dest);
}

/**
 * Comprobación de integridad de la BD del panel. Devuelve null si está sana,
 * o el detalle del problema. Se ejecuta al arrancar: detectar corrupción
 * temprano (disco, apagón…) vale más que descubrirla con un fallo raro.
 */
export function checkIntegrity(): string | null {
  try {
    const rows = db.pragma('integrity_check') as { integrity_check: string }[];
    const results = rows.map((r) => r.integrity_check);
    if (results.length === 1 && results[0] === 'ok') return null;
    return results.join('; ').slice(0, 1000) || 'resultado vacío';
  } catch (err: any) {
    return `no se pudo comprobar: ${err?.message || err}`;
  }
}

/** Ejecuta varias escrituras de forma atómica (todo o nada). */
export function transaction<T>(fn: () => T): T {
  return db.transaction(fn)();
}

function parseService(row: any): ServiceRow {
  return { ...row, config: JSON.parse(row.config) };
}

// ---------- users ----------
export function countUsers(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM users').get() as any).c;
}

export function createUser(email: string, passwordHash: string, role: UserRole = 'admin'): UserRow {
  const row: UserRow = { id: id('usr'), email, password_hash: passwordHash, role, session_epoch: 0, created_at: now() };
  db.prepare('INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
    row.id, row.email, row.password_hash, row.role, row.created_at,
  );
  return row;
}

export function listUsers(): UserRow[] {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as UserRow[];
}

export function countAdmins(): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get() as any).c;
}

export function updateUserRole(userId: string, role: UserRole): void {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
}

export function deleteUser(userId: string): void {
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

// ---------- workspaces por usuario ----------
export function listUserProjectIds(userId: string): string[] {
  return (db.prepare('SELECT project_id FROM user_projects WHERE user_id = ?').all(userId) as any[])
    .map((r) => r.project_id);
}

export function setUserProjects(userId: string, projectIds: string[]): void {
  const del = db.prepare('DELETE FROM user_projects WHERE user_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO user_projects (user_id, project_id) VALUES (?, ?)');
  const tx = db.transaction(() => {
    del.run(userId);
    for (const pid of projectIds) ins.run(userId, pid);
  });
  tx();
}

export function userHasProject(userId: string, projectId: string): boolean {
  return !!db.prepare('SELECT 1 FROM user_projects WHERE user_id = ? AND project_id = ?').get(userId, projectId);
}

// ---------- passkeys ----------
export function insertPasskey(row: Omit<PasskeyRow, 'id' | 'created_at' | 'last_used_at'>): PasskeyRow {
  const full: PasskeyRow = { ...row, id: id('pky'), created_at: now(), last_used_at: null };
  db.prepare(
    `INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, device_type, backed_up, rp_id, name, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(full.id, full.user_id, full.credential_id, full.public_key, full.counter, full.transports, full.device_type, full.backed_up, full.rp_id, full.name, full.created_at, full.last_used_at);
  return full;
}

export function listPasskeys(userId: string): PasskeyRow[] {
  return db.prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at ASC').all(userId) as PasskeyRow[];
}

export function countPasskeys(userId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM passkeys WHERE user_id = ?').get(userId) as any).c;
}

export function getPasskeyByCredentialId(credentialId: string): PasskeyRow | undefined {
  return db.prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(credentialId) as PasskeyRow | undefined;
}

export function touchPasskey(passkeyId: string, counter: number): void {
  db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(counter, now(), passkeyId);
}

export function deletePasskey(passkeyId: string, userId: string): boolean {
  return db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(passkeyId, userId).changes > 0;
}

// ---------- tokens de API ----------
export function insertApiToken(row: Omit<ApiTokenRow, 'id' | 'created_at' | 'last_used_at'>): ApiTokenRow {
  const full: ApiTokenRow = { ...row, id: id('tok'), created_at: now(), last_used_at: null };
  db.prepare(
    `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, created_at, last_used_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(full.id, full.user_id, full.name, full.token_hash, full.prefix, full.created_at, full.last_used_at, full.expires_at);
  return full;
}

export function listApiTokens(userId: string): ApiTokenRow[] {
  return db.prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at ASC').all(userId) as ApiTokenRow[];
}

export function countApiTokens(userId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM api_tokens WHERE user_id = ?').get(userId) as any).c;
}

export function getApiTokenByHash(tokenHash: string): ApiTokenRow | undefined {
  return db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(tokenHash) as ApiTokenRow | undefined;
}

export function touchApiToken(tokenId: string): void {
  db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now(), tokenId);
}

export function deleteApiToken(tokenId: string, userId: string): boolean {
  return db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(tokenId, userId).changes > 0;
}

export function getUserByEmail(email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
}

export function getUser(userId: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
}

/** Cambia la contraseña e invalida las sesiones y cookies previas del usuario (bump de epoch). */
export function updateUserPassword(userId: string, passwordHash: string): void {
  db.prepare('UPDATE users SET password_hash = ?, session_epoch = session_epoch + 1 WHERE id = ?').run(passwordHash, userId);
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
  const row: ProjectRow = {
    id: id('prj'), name, slug, client, created_at: now(),
    status_token: null, status_enabled: 0, status_notice: null,
  };
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

// ---------- página de estado pública ----------
export function getProjectByStatusToken(token: string): ProjectRow | undefined {
  return db
    .prepare('SELECT * FROM projects WHERE status_token = ? AND status_enabled = 1')
    .get(token) as ProjectRow | undefined;
}

export function setProjectStatusPage(projectId: string, enabled: boolean, token?: string | null): void {
  if (token !== undefined) {
    db.prepare('UPDATE projects SET status_enabled = ?, status_token = ? WHERE id = ?')
      .run(enabled ? 1 : 0, token, projectId);
  } else {
    db.prepare('UPDATE projects SET status_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, projectId);
  }
}

/** Aviso de mantenimiento que se muestra como banner en la página de estado. */
export function setProjectStatusNotice(projectId: string, notice: string | null): void {
  db.prepare('UPDATE projects SET status_notice = ? WHERE id = ?').run(notice, projectId);
}

// ---------- histórico de disponibilidad ----------
/** Registra una muestra del monitor (una por servicio y tick) agregada por hora. */
export function recordUptimeSample(serviceId: string, up: boolean): void {
  const hour = Math.floor(now() / 3_600_000);
  db.prepare(
    `INSERT INTO uptime_hourly (service_id, hour, up, total) VALUES (?, ?, ?, 1)
     ON CONFLICT(service_id, hour) DO UPDATE SET up = up + excluded.up, total = total + 1`,
  ).run(serviceId, hour, up ? 1 : 0);
}

/** Disponibilidad acumulada de las últimas `hours` horas: NULL si no hay datos. */
export function uptimePercent(serviceId: string, hours: number): number | null {
  const from = Math.floor(now() / 3_600_000) - hours;
  const row = db
    .prepare('SELECT SUM(up) AS up, SUM(total) AS total FROM uptime_hourly WHERE service_id = ? AND hour > ?')
    .get(serviceId, from) as { up: number | null; total: number | null };
  if (!row.total) return null;
  return Math.round(((row.up ?? 0) / row.total) * 10000) / 100;
}

/** Disponibilidad por día (UTC) de los últimos `days` días, para las barras de la página de estado. */
export function uptimeDaily(serviceId: string, days: number): { day: number; up: number; total: number }[] {
  const fromHour = Math.floor(now() / 3_600_000) - days * 24;
  return db
    .prepare(
      `SELECT (hour / 24) AS day, SUM(up) AS up, SUM(total) AS total
       FROM uptime_hourly WHERE service_id = ? AND hour > ? GROUP BY day ORDER BY day ASC`,
    )
    .all(serviceId, fromHour) as { day: number; up: number; total: number }[];
}

/** Borra el histórico de disponibilidad viejo y el de servicios eliminados. */
export function pruneUptime(keepDays = 92): void {
  const cutoff = Math.floor(now() / 3_600_000) - keepDays * 24;
  db.prepare('DELETE FROM uptime_hourly WHERE hour < ?').run(cutoff);
  db.prepare('DELETE FROM uptime_hourly WHERE service_id NOT IN (SELECT id FROM services)').run();
}

// ---------- histórico de consumo (CPU/RAM/red/disco) ----------
/**
 * Acumula una muestra de consumo de un servicio en su cubo horario. Las sumas
 * dividen luego entre `samples` para la media; los máximos guardan el pico real
 * de la hora, que una media aplasta y es justo lo que delata un problema.
 */
export function recordServiceMetrics(serviceId: string, s: ServiceMetricSample): void {
  const hour = Math.floor(now() / 3_600_000);
  db.prepare(
    `INSERT INTO service_metrics_hourly
       (service_id, hour, samples, cpu_sum, cpu_max, mem_sum, mem_max, mem_limit_last, net_rx, net_tx)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(service_id, hour) DO UPDATE SET
       samples = samples + 1,
       cpu_sum = cpu_sum + excluded.cpu_sum,
       cpu_max = MAX(cpu_max, excluded.cpu_max),
       mem_sum = mem_sum + excluded.mem_sum,
       mem_max = MAX(mem_max, excluded.mem_max),
       mem_limit_last = excluded.mem_limit_last,
       net_rx = net_rx + excluded.net_rx,
       net_tx = net_tx + excluded.net_tx`,
  ).run(serviceId, hour, s.cpuPercent, s.cpuPercent, s.memUsage, s.memUsage, s.memLimit, s.netRxDelta, s.netTxDelta);
}

/** Registra la foto de disco de un servicio en el cubo horario actual (sobrescribe). */
export function recordServiceDisk(serviceId: string, totalBytes: number): void {
  const hour = Math.floor(now() / 3_600_000);
  db.prepare(
    `INSERT INTO service_metrics_hourly (service_id, hour, disk_last) VALUES (?, ?, ?)
     ON CONFLICT(service_id, hour) DO UPDATE SET disk_last = excluded.disk_last`,
  ).run(serviceId, hour, totalBytes);
}

/** Acumula una muestra de carga y RAM del host en su cubo horario. */
export function recordHostMetrics(load: number, memUsed: number, memTotal: number): void {
  const hour = Math.floor(now() / 3_600_000);
  db.prepare(
    `INSERT INTO host_metrics_hourly
       (hour, samples, load_sum, load_max, mem_used_sum, mem_used_max, mem_total_last)
     VALUES (?, 1, ?, ?, ?, ?, ?)
     ON CONFLICT(hour) DO UPDATE SET
       samples = samples + 1,
       load_sum = load_sum + excluded.load_sum,
       load_max = MAX(load_max, excluded.load_max),
       mem_used_sum = mem_used_sum + excluded.mem_used_sum,
       mem_used_max = MAX(mem_used_max, excluded.mem_used_max),
       mem_total_last = excluded.mem_total_last`,
  ).run(hour, load, load, memUsed, memUsed, memTotal);
}

/** Registra la foto de disco del host en el cubo horario actual (sobrescribe). */
export function recordHostDisk(diskUsed: number, diskTotal: number): void {
  const hour = Math.floor(now() / 3_600_000);
  db.prepare(
    `INSERT INTO host_metrics_hourly (hour, disk_used_last, disk_total_last) VALUES (?, ?, ?)
     ON CONFLICT(hour) DO UPDATE SET disk_used_last = excluded.disk_used_last, disk_total_last = excluded.disk_total_last`,
  ).run(hour, diskUsed, diskTotal);
}

/** Filas horarias del histórico de un servicio de las últimas `hours` horas (orden ascendente). */
export function serviceMetricsRange(serviceId: string, hours: number): ServiceMetricHour[] {
  const from = Math.floor(now() / 3_600_000) - hours;
  return db
    .prepare('SELECT * FROM service_metrics_hourly WHERE service_id = ? AND hour > ? ORDER BY hour ASC')
    .all(serviceId, from) as ServiceMetricHour[];
}

/** Filas horarias del histórico del host de las últimas `hours` horas (orden ascendente). */
export function hostMetricsRange(hours: number): HostMetricHour[] {
  const from = Math.floor(now() / 3_600_000) - hours;
  return db
    .prepare('SELECT * FROM host_metrics_hourly WHERE hour > ? ORDER BY hour ASC')
    .all(from) as HostMetricHour[];
}

/** Poda el histórico de consumo viejo y el de servicios eliminados. */
export function pruneMetrics(keepDays = 90): void {
  const cutoff = Math.floor(now() / 3_600_000) - keepDays * 24;
  db.prepare('DELETE FROM service_metrics_hourly WHERE hour < ?').run(cutoff);
  db.prepare('DELETE FROM service_metrics_hourly WHERE service_id NOT IN (SELECT id FROM services)').run();
  db.prepare('DELETE FROM host_metrics_hourly WHERE hour < ?').run(cutoff);
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

/**
 * SHA del último commit que Skyway llegó a construir para el servicio (clon
 * realizado, con éxito o no). Sirve al auto-deploy para no re-desplegar un
 * commit ya tratado —lo desplegara el webhook, un deploy manual o el propio
 * sondeo— y evitar duplicados y bucles.
 */
export function lastBuiltCommitSha(serviceId: string): string | null {
  const row = db
    .prepare('SELECT commit_sha FROM deployments WHERE service_id = ? AND commit_sha IS NOT NULL ORDER BY created_at DESC LIMIT 1')
    .get(serviceId) as { commit_sha: string } | undefined;
  return row?.commit_sha ?? null;
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

// ---------- conectores de GitHub por proyecto ----------
export function insertGithubConnector(
  row: Omit<GithubConnectorRow, 'id' | 'created_at' | 'last_used_at'>,
): GithubConnectorRow {
  const full: GithubConnectorRow = { ...row, id: id('ghc'), created_at: now(), last_used_at: null };
  db.prepare(
    `INSERT INTO github_connectors (id, project_id, name, token, gh_login, token_type, created_by, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(full.id, full.project_id, full.name, full.token, full.gh_login, full.token_type, full.created_by, full.created_at, full.last_used_at);
  return full;
}

export function listGithubConnectors(projectId: string): GithubConnectorRow[] {
  return db
    .prepare('SELECT * FROM github_connectors WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId) as GithubConnectorRow[];
}

/** Todos los conectores con su proyecto, para el panel de control del admin. */
export function listAllGithubConnectors(): (GithubConnectorRow & { project_name: string; project_client: string | null })[] {
  return db
    .prepare(
      `SELECT c.*, p.name AS project_name, p.client AS project_client
       FROM github_connectors c JOIN projects p ON p.id = c.project_id
       ORDER BY p.name ASC, c.created_at ASC`,
    )
    .all() as (GithubConnectorRow & { project_name: string; project_client: string | null })[];
}

export function getGithubConnector(connectorId: string): GithubConnectorRow | undefined {
  return db.prepare('SELECT * FROM github_connectors WHERE id = ?').get(connectorId) as GithubConnectorRow | undefined;
}

export function countGithubConnectors(projectId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM github_connectors WHERE project_id = ?').get(projectId) as any).c;
}

export function touchGithubConnector(connectorId: string): void {
  db.prepare('UPDATE github_connectors SET last_used_at = ? WHERE id = ?').run(now(), connectorId);
}

export function deleteGithubConnector(connectorId: string): boolean {
  return db.prepare('DELETE FROM github_connectors WHERE id = ?').run(connectorId).changes > 0;
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

export function listAlerts(opts: { limit?: number; openOnly?: boolean; projectIds?: string[] } = {}): AlertRow[] {
  const limit = Math.min(opts.limit ?? 50, 200);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.openOnly) where.push('resolved_at IS NULL');
  if (opts.projectIds) {
    // Restricción por workspaces: las alertas de servidor (sin proyecto) quedan fuera.
    if (opts.projectIds.length === 0) return [];
    where.push(`project_id IN (${opts.projectIds.map(() => '?').join(',')})`);
    params.push(...opts.projectIds);
  }
  const sql = `SELECT * FROM alerts${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC LIMIT ?`;
  return db.prepare(sql).all(...params, limit) as AlertRow[];
}

export function getAlert(alertId: string): AlertRow | undefined {
  return db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId) as AlertRow | undefined;
}

export function countUnreadAlerts(projectIds?: string[]): number {
  if (projectIds) {
    if (projectIds.length === 0) return 0;
    const sql = `SELECT COUNT(*) AS c FROM alerts WHERE read_at IS NULL AND project_id IN (${projectIds.map(() => '?').join(',')})`;
    return (db.prepare(sql).get(...projectIds) as any).c;
  }
  return (db.prepare('SELECT COUNT(*) AS c FROM alerts WHERE read_at IS NULL').get() as any).c;
}

export function markAlertsRead(projectIds?: string[]): void {
  if (projectIds) {
    if (projectIds.length === 0) return;
    const sql = `UPDATE alerts SET read_at = ? WHERE read_at IS NULL AND project_id IN (${projectIds.map(() => '?').join(',')})`;
    db.prepare(sql).run(now(), ...projectIds);
    return;
  }
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

/**
 * Resuelve las alertas abiertas de un servicio para un tipo, por (service_id, type)
 * en vez de por dedupe_key. Equivale a la clave para las alertas bien formadas
 * (su dedupe_key es `${serviceId}:${type}`) pero además limpia las heredadas sin
 * clave (p. ej. `deploy_failed` antiguas), que si no se quedarían abiertas para siempre.
 */
export function resolveOpenServiceAlerts(serviceId: string, type: string): AlertRow[] {
  const open = db
    .prepare('SELECT * FROM alerts WHERE service_id = ? AND type = ? AND resolved_at IS NULL')
    .all(serviceId, type) as AlertRow[];
  if (open.length > 0) {
    db.prepare('UPDATE alerts SET resolved_at = ? WHERE service_id = ? AND type = ? AND resolved_at IS NULL').run(
      now(),
      serviceId,
      type,
    );
  }
  return open;
}

/**
 * Incidencias para la página de estado: alertas de los tipos dados, abiertas
 * o resueltas después de `resolvedSince`. Consulta dedicada — pasar por la
 * ventana de listAlerts podía expulsar una incidencia abierta si había >100
 * alertas más recientes de otros tipos.
 */
export function listProjectIncidents(projectId: string, types: string[], resolvedSince: number): AlertRow[] {
  if (types.length === 0) return [];
  const placeholders = types.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT * FROM alerts WHERE project_id = ? AND type IN (${placeholders})
       AND (resolved_at IS NULL OR resolved_at > ?) ORDER BY ts DESC LIMIT 20`,
    )
    .all(projectId, ...types, resolvedSince) as AlertRow[];
}

/** Metadatos de actividad por proyecto para el panel: último despliegue y alertas abiertas. */
export function projectDashboardMeta(): Record<string, { lastDeployAt: number | null; openAlerts: number }> {
  const out: Record<string, { lastDeployAt: number | null; openAlerts: number }> = {};
  const deploys = db
    .prepare('SELECT s.project_id AS pid, MAX(d.created_at) AS m FROM deployments d JOIN services s ON s.id = d.service_id GROUP BY s.project_id')
    .all() as { pid: string; m: number }[];
  for (const r of deploys) out[r.pid] = { lastDeployAt: r.m, openAlerts: 0 };
  const alerts = db
    .prepare('SELECT project_id AS pid, COUNT(*) AS c FROM alerts WHERE resolved_at IS NULL AND project_id IS NOT NULL GROUP BY project_id')
    .all() as { pid: string; c: number }[];
  for (const r of alerts) out[r.pid] = { lastDeployAt: out[r.pid]?.lastDeployAt ?? null, openAlerts: r.c };
  return out;
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
