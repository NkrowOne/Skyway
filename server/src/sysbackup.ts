import fs from 'fs';
import path from 'path';
import { config } from './config';
import { vacuumInto } from './db';

/**
 * Backups del propio panel (skyway.db): usuarios, proyectos, servicios,
 * variables, dominios y auditoría. Los backups por servicio cubren las bases
 * de datos de los proyectos; esto cubre el cerebro de Skyway.
 *
 * El snapshot se hace con VACUUM INTO (copia consistente y compactada aunque
 * la BD esté en uso) sobre un fichero temporal que se renombra al final: nunca
 * queda un backup a medias con nombre definitivo.
 *
 * Restaurar es deliberadamente manual (parar Skyway y reemplazar
 * /data/skyway.db): un endpoint que sustituyera la BD en caliente podría
 * dejar el proceso con estado inconsistente en memoria.
 */

export const SYSTEM_BACKUP_RETENTION = 7;

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function systemBackupDir(): string {
  return path.join(config.dataDir, 'backups', 'skyway');
}

export interface SystemBackupEntry {
  file: string;
  size: number;
  createdAt: number;
}

export function listSystemBackups(): SystemBackupEntry[] {
  const dir = systemBackupDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => SAFE_FILE.test(f) && f.endsWith('.db'))
    .map((file) => {
      const st = fs.statSync(path.join(dir, file));
      return { file, size: st.size, createdAt: st.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function resolveSystemBackupFile(file: string): string | null {
  if (!SAFE_FILE.test(file) || !file.endsWith('.db')) return null;
  const full = path.join(systemBackupDir(), file);
  return fs.existsSync(full) ? full : null;
}

export function deleteSystemBackup(file: string): boolean {
  const full = resolveSystemBackupFile(file);
  if (!full) return false;
  fs.rmSync(full);
  return true;
}

export function createSystemBackup(): SystemBackupEntry {
  const dir = systemBackupDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = `skyway-${stamp}.db`;
  const full = path.join(dir, file);
  const tmp = `${full}.tmp`;

  fs.rmSync(tmp, { force: true });
  try {
    vacuumInto(tmp);
    const st = fs.statSync(tmp);
    if (st.size < 4096) throw new Error('el snapshot salió sospechosamente vacío');
    fs.renameSync(tmp, full);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  const st = fs.statSync(full);
  return { file, size: st.size, createdAt: st.mtimeMs };
}

/** Aplica la retención: conserva los `keep` más recientes y borra el resto. */
export function pruneSystemBackups(keep = SYSTEM_BACKUP_RETENTION): void {
  for (const old of listSystemBackups().slice(keep)) {
    deleteSystemBackup(old.file);
  }
}
