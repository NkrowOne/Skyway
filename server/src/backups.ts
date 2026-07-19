import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { PassThrough, pipeline } from 'stream';
import { config } from './config';
import { docker } from './docker/client';
import { containerName, getRuntime } from './docker/containers';
import { DatabaseConfig, ProjectRow, ServiceRow } from './types';

const BACKUP_TIMEOUT_MS = 10 * 60_000;

interface TemplateBackup {
  dump: string;
  restore: string;
  ext: string;
}

/** Comandos que corren DENTRO del contenedor (las credenciales están en su env). */
const TEMPLATE_BACKUPS: Record<string, TemplateBackup> = {
  postgres: {
    dump: 'pg_dump -U skyway -d skyway --no-owner --no-acl',
    restore: 'psql -U skyway -d skyway -q -v ON_ERROR_STOP=0',
    ext: 'sql.gz',
  },
  mysql: {
    dump: 'mysqldump --single-transaction -u skyway -p"$MYSQL_PASSWORD" skyway',
    restore: 'mysql -u skyway -p"$MYSQL_PASSWORD" skyway',
    ext: 'sql.gz',
  },
  mongo: {
    dump: 'mongodump --quiet --username skyway --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive',
    restore: 'mongorestore --quiet --username skyway --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --drop',
    ext: 'archive.gz',
  },
};

export function backupSupported(service: ServiceRow): boolean {
  return service.type === 'database' && !!TEMPLATE_BACKUPS[(service.config as DatabaseConfig).template];
}

function backupDir(serviceId: string): string {
  return path.join(config.dataDir, 'backups', serviceId);
}

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function resolveBackupFile(serviceId: string, file: string): string | null {
  if (!SAFE_FILE.test(file)) return null;
  const full = path.join(backupDir(serviceId), file);
  return fs.existsSync(full) ? full : null;
}

export interface BackupEntry {
  file: string;
  size: number;
  createdAt: number;
}

export function listBackups(serviceId: string): BackupEntry[] {
  const dir = backupDir(serviceId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => SAFE_FILE.test(f))
    .map((file) => {
      const st = fs.statSync(path.join(dir, file));
      return { file, size: st.size, createdAt: st.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function deleteBackup(serviceId: string, file: string): boolean {
  const full = resolveBackupFile(serviceId, file);
  if (!full) return false;
  fs.rmSync(full);
  return true;
}

async function requireRunning(project: ProjectRow, service: ServiceRow): Promise<string> {
  const name = containerName(project, service);
  const runtime = await getRuntime(name);
  if (runtime.state !== 'running') {
    throw new Error('La base de datos no está en ejecución: arráncala antes.');
  }
  return name;
}

/** Crea un backup comprimido ejecutando el dump dentro del contenedor. */
export async function createBackup(project: ProjectRow, service: ServiceRow): Promise<BackupEntry> {
  const cfg = service.config as DatabaseConfig;
  const tpl = TEMPLATE_BACKUPS[cfg.template];
  if (!tpl) throw new Error(`Backups no soportados para la plantilla ${cfg.template}`);
  const name = await requireRunning(project, service);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = `${cfg.template}-${project.slug}-${service.slug}-${stamp}.${tpl.ext}`;
  const dir = backupDir(service.id);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, file);

  const container = docker.getContainer(name);
  const exec = await container.exec({ Cmd: ['sh', '-c', tpl.dump], AttachStdout: true, AttachStderr: true });
  const stream = (await exec.start({})) as NodeJS.ReadableStream;

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let errText = '';
  stderr.on('data', (c) => {
    if (errText.length < 4000) errText += c.toString();
  });
  docker.modem.demuxStream(stream, stdout, stderr);

  const gzip = zlib.createGzip({ level: 6 });
  const sink = fs.createWriteStream(full);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      (stream as any).destroy?.();
      reject(new Error('El backup superó el tiempo máximo (10 min)'));
    }, BACKUP_TIMEOUT_MS);
    pipeline(stdout, gzip, sink, (err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
    stream.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  }).catch((err) => {
    fs.rmSync(full, { force: true });
    throw err;
  });

  const info = await exec.inspect();
  if (info.ExitCode !== 0) {
    fs.rmSync(full, { force: true });
    throw new Error(`El volcado terminó con error (código ${info.ExitCode}): ${errText.slice(0, 500) || 'sin detalle'}`);
  }

  const st = fs.statSync(full);
  if (st.size < 30) {
    fs.rmSync(full, { force: true });
    throw new Error('El volcado salió vacío: revisa el estado de la base de datos.');
  }
  return { file, size: st.size, createdAt: st.mtimeMs };
}

/** Restaura un backup enviándolo por stdin al cliente dentro del contenedor. */
export async function restoreBackup(project: ProjectRow, service: ServiceRow, file: string): Promise<void> {
  const cfg = service.config as DatabaseConfig;
  const tpl = TEMPLATE_BACKUPS[cfg.template];
  if (!tpl) throw new Error(`Backups no soportados para la plantilla ${cfg.template}`);
  const full = resolveBackupFile(service.id, file);
  if (!full) throw new Error('Backup no encontrado');
  const name = await requireRunning(project, service);

  const container = docker.getContainer(name);
  const exec = await container.exec({
    Cmd: ['sh', '-c', tpl.restore],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = (await exec.start({ hijack: true, stdin: true })) as unknown as NodeJS.ReadWriteStream;

  const out = new PassThrough();
  let outText = '';
  out.on('data', (c) => {
    if (outText.length < 4000) outText += c.toString();
  });
  docker.modem.demuxStream(stream as any, out, out);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      (stream as any).destroy?.();
      reject(new Error('La restauración superó el tiempo máximo (10 min)'));
    }, BACKUP_TIMEOUT_MS);

    const source = fs.createReadStream(full);
    const gunzip = zlib.createGunzip();
    source.pipe(gunzip).pipe(stream, { end: true });
    gunzip.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    stream.on('end', () => {
      clearTimeout(timer);
      resolve();
    });
    stream.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  const info = await exec.inspect();
  if (info.ExitCode !== 0) {
    throw new Error(`La restauración terminó con error (código ${info.ExitCode}): ${outText.slice(0, 500) || 'sin detalle'}`);
  }
}
