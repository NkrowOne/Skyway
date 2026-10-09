import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { PassThrough, pipeline } from 'stream';
import { config } from './config';
import { docker } from './docker/client';
import { containerName, getRuntime, waitExecExit } from './docker/containers';
import { DatabaseConfig, ProjectRow, ServiceRow } from './types';

const BACKUP_TIMEOUT_MS = 10 * 60_000;
/**
 * Reintentos al leer el código de salida del exec. El daemon tarda unos ms en
 * registrarlo tras cerrar el stream; leerlo una sola vez daba `null` y una
 * copia perfectamente buena se borraba como fallida.
 */
const EXIT_CODE_RETRY = { attempts: 10, delayMs: 100 };

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

/**
 * Carpetas de copias por servicio: `backups/svc_<16 hex>`. El patrón deja
 * fuera `backups/skyway`, donde viven las copias del propio panel, y cualquier
 * otra cosa que alguien haya dejado en la carpeta.
 */
const SERVICE_BACKUP_DIR = /^svc_[0-9a-f]{16}$/;

export function isServiceBackupDirName(name: string): boolean {
  return SERVICE_BACKUP_DIR.test(name);
}

export interface ServiceBackupDir {
  serviceId: string;
  files: number;
  size: number;
  /** Última modificación (la copia más reciente, o la carpeta si está vacía). */
  updatedAt: number;
  /**
   * Nombre de la copia más reciente. Lleva el proyecto y el servicio
   * (`<motor>-<proyecto>-<servicio>-<fecha>`): es lo que permite saber de
   * quién era una carpeta cuyo servicio ya no existe.
   */
  latestFile: string | null;
}

/** Carpetas de copias de servicio que hay en el disco, existan o no sus servicios. */
export function listServiceBackupDirs(): ServiceBackupDir[] {
  const root = path.join(config.dataDir, 'backups');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ServiceBackupDir[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !SERVICE_BACKUP_DIR.test(e.name)) continue;
    const dir = path.join(root, e.name);
    let files = 0;
    let size = 0;
    let updatedAt = 0;
    let latestFile: string | null = null;
    let latestAt = -1;
    try {
      updatedAt = fs.statSync(dir).mtimeMs;
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        // Los temporales de una copia en curso o cortada no son copias.
        if (!f.isFile() || PARTIAL_FILE.test(f.name)) continue;
        const st = fs.statSync(path.join(dir, f.name));
        files += 1;
        size += st.size;
        updatedAt = Math.max(updatedAt, st.mtimeMs);
        if (st.mtimeMs > latestAt) {
          latestAt = st.mtimeMs;
          latestFile = f.name;
        }
      }
    } catch {
      continue; // borrada a la vez: no hay nada que listar
    }
    out.push({ serviceId: e.name, files, size, updatedAt, latestFile });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Borra la carpeta de copias de un servicio. Devuelve false si no existía. El
 * id se valida con el mismo patrón que el listado: nunca toca `backups/skyway`
 * ni una ruta fabricada con `..`.
 */
export function deleteServiceBackupDir(serviceId: string): boolean {
  if (!SERVICE_BACKUP_DIR.test(serviceId)) return false;
  const dir = backupDir(serviceId);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * La copia se escribe primero en un fichero oculto (empieza por «.», así que
 * SAFE_FILE lo deja fuera de los listados, las descargas y las
 * restauraciones) y solo se renombra al nombre definitivo cuando el volcado
 * ha terminado bien. Si el proceso se corta a mitad (un reinicio del panel
 * por una actualización, un apagado), no queda una copia truncada que
 * parezca buena: queda un temporal que la siguiente copia retira.
 */
function partialName(file: string): string {
  return `.${file}.parcial`;
}

const PARTIAL_FILE = /^\..+\.parcial$/;

/**
 * Retira los temporales de copias que se cortaron. Solo los antiguos: uno
 * reciente puede ser de otra copia en curso (una manual a la vez que la
 * programada), y ninguna dura más de BACKUP_TIMEOUT_MS.
 */
function removeStalePartials(dir: string, nowMs = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!PARTIAL_FILE.test(name)) continue;
    const full = path.join(dir, name);
    try {
      if (nowMs - fs.statSync(full).mtimeMs > 2 * BACKUP_TIMEOUT_MS) fs.rmSync(full, { force: true });
    } catch {
      // Borrado a la vez por otra copia: nada que hacer.
    }
  }
}

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
    throw new Error('La base de datos no está en ejecución: es necesario iniciarla antes.');
  }
  return name;
}

/** Crea un backup comprimido ejecutando el dump dentro del contenedor. */
export async function createBackup(project: ProjectRow, service: ServiceRow): Promise<BackupEntry> {
  const cfg = service.config as DatabaseConfig;
  const tpl = TEMPLATE_BACKUPS[cfg.template];
  if (!tpl) throw new Error(`Las copias de seguridad no están disponibles para la plantilla ${cfg.template}`);
  const name = await requireRunning(project, service);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = `${cfg.template}-${project.slug}-${service.slug}-${stamp}.${tpl.ext}`;
  const dir = backupDir(service.id);
  fs.mkdirSync(dir, { recursive: true });
  removeStalePartials(dir);
  const full = path.join(dir, file);
  const partial = path.join(dir, partialName(file));

  const container = docker.getContainer(name);
  const exec = await container.exec({ Cmd: ['sh', '-c', tpl.dump], AttachStdout: true, AttachStderr: true });
  const stream = (await exec.start({})) as NodeJS.ReadableStream;

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let errText = '';
  stderr.on('data', (c) => {
    if (errText.length < 4000) errText += c.toString();
  });
  stderr.on('error', () => undefined);
  docker.modem.demuxStream(stream, stdout, stderr);
  // demuxStream solo copia datos: NUNCA cierra los destinos. Sin esto la
  // tubería stdout→gzip→fichero no terminaba jamás y la copia solo acababa
  // por el temporizador, que la daba por fallida y borraba el fichero.
  let outputsClosed = false;
  const closeOutputs = () => {
    if (outputsClosed) return;
    outputsClosed = true;
    stdout.end();
    stderr.end();
  };
  stream.on('end', closeOutputs);
  stream.on('close', closeOutputs);

  const gzip = zlib.createGzip({ level: 6 });
  const sink = fs.createWriteStream(partial);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error('La copia de seguridad ha superado el tiempo máximo (10 min)');
      // Destruir la cabeza con error desmonta la cadena entera (pipeline
      // destruye gzip y el fichero) y corta el exec dentro del contenedor.
      stdout.destroy(err);
      (stream as any).destroy?.();
      reject(err);
    }, BACKUP_TIMEOUT_MS);
    pipeline(stdout, gzip, sink, (err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
    stream.on('error', (err) => {
      clearTimeout(timer);
      stdout.destroy(err);
      reject(err);
    });
  }).catch((err) => {
    fs.rmSync(partial, { force: true });
    throw err;
  });

  const exitCode = await waitExecExit(exec, EXIT_CODE_RETRY);
  if (exitCode !== 0) {
    fs.rmSync(partial, { force: true });
    throw new Error(
      `El volcado terminó con error (código ${exitCode ?? 'desconocido'}): ${errText.slice(0, 500) || 'sin detalle'}`,
    );
  }

  if (fs.statSync(partial).size < 30) {
    fs.rmSync(partial, { force: true });
    throw new Error('El volcado ha resultado vacío: comprueba el estado de la base de datos.');
  }
  // Solo ahora la copia aparece con su nombre: completa o nada.
  fs.renameSync(partial, full);
  const st = fs.statSync(full);
  return { file, size: st.size, createdAt: st.mtimeMs };
}

/** Restaura un backup enviándolo por stdin al cliente dentro del contenedor. */
export async function restoreBackup(project: ProjectRow, service: ServiceRow, file: string): Promise<void> {
  const cfg = service.config as DatabaseConfig;
  const tpl = TEMPLATE_BACKUPS[cfg.template];
  if (!tpl) throw new Error(`Las copias de seguridad no están disponibles para la plantilla ${cfg.template}`);
  const full = resolveBackupFile(service.id, file);
  if (!full) throw new Error('Copia de seguridad no encontrada');
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
  out.on('error', () => undefined);
  docker.modem.demuxStream(stream as any, out, out);
  stream.on('end', () => out.end());
  stream.on('close', () => out.end());

  // true cuando el fichero entero llegó al cliente dentro del contenedor.
  let sentAll = false;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const source = fs.createReadStream(full);
    const gunzip = zlib.createGunzip();
    const timer = setTimeout(() => {
      const err = new Error('La restauración ha superado el tiempo máximo (10 min)');
      // Se desmonta la cadena entera: el fichero deja de leerse, gunzip se
      // descarta y el socket con Docker se cierra.
      source.destroy(err);
      (stream as any).destroy?.();
      settle(err);
    }, BACKUP_TIMEOUT_MS);
    // pipeline destruye los tres si cualquiera falla —un fichero ilegible, un
    // gzip corrupto, el socket que se corta— en vez de dejar la excepción sin
    // manejador (createReadStream no tenía ninguno). Su callback llega cuando
    // TODO el fichero se ha escrito y se ha cerrado stdin; el final del exec
    // llega después, por el 'end' del stream, y es lo que se espera.
    pipeline(source, gunzip, stream, (err) => {
      if (err) settle(err);
      else sentAll = true;
    });
    stream.on('end', () => settle());
    stream.on('close', () => settle());
    stream.on('error', (err) => settle(err));
  });

  const exitCode = await waitExecExit(exec, EXIT_CODE_RETRY);
  if (exitCode !== 0) {
    throw new Error(
      `La restauración terminó con error (código ${exitCode ?? 'desconocido'}): ${outText.slice(0, 500) || 'sin detalle'}`,
    );
  }
  if (!sentAll) {
    throw new Error(
      `El cliente finalizó antes de recibir la copia de seguridad completa: ${outText.slice(0, 500) || 'sin detalle'}`,
    );
  }
}
