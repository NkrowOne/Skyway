import path from 'path';
import { Readable } from 'stream';
import { docker } from './docker/client';
import { containerName, execInContainer, getRuntime } from './docker/containers';
import { ProjectRow, ServiceRow } from './types';

/**
 * Explorador de archivos por servicio (estilo gestor FTP), pero SIN abrir
 * puertos ni gestionar credenciales de FTP: todo va por el socket de Docker.
 *
 * - Listar / borrar / crear carpeta: `ls`, `rm`, `mkdir` vía exec dentro del
 *   contenedor (la ruta viaja como variable de entorno, nunca interpolada en
 *   el shell, igual que en la consola de bases de datos).
 * - Descargar / subir: API de archivos de Docker (`getArchive`/`putArchive`),
 *   que transporta un tar. Aquí se lee/escribe ese tar con un códec mínimo
 *   propio para no añadir dependencias.
 *
 * Quien usa el explorador ya puede ejecutar comandos en el contenedor desde la
 * terminal del panel: esto es comodidad, no una nueva superficie de permisos.
 */

export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const LIST_TIMEOUT_MS = 15_000;

export interface FileEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  /** Tamaño en bytes (0 para directorios y enlaces). */
  size: number;
  /** Permisos en formato rwxr-xr-x. */
  perms: string;
  /** Destino del enlace simbólico, si aplica. */
  target?: string;
}

export interface DirListing {
  path: string;
  entries: FileEntry[];
}

/** El explorador está disponible para cualquier servicio con contenedor. */
export function filesSupported(_service: ServiceRow): boolean {
  return true;
}

/** Normaliza una ruta a absoluta y sin `..` (se resuelven contra la raíz). */
export function normalizePath(input: string | undefined): string {
  const raw = (input ?? '/').trim() || '/';
  if (!raw.startsWith('/')) throw new Error('La ruta debe ser absoluta (empezar por /)');
  const normalized = path.posix.normalize(raw);
  // normalize() ya colapsa los `..`; por si acaso, rechazamos cualquier resto.
  if (normalized.includes('..')) throw new Error('Ruta inválida');
  return normalized === '.' ? '/' : normalized;
}

async function requireRunning(project: ProjectRow, service: ServiceRow): Promise<string> {
  const name = containerName(project, service);
  const runtime = await getRuntime(name);
  if (runtime.state === 'not_created') {
    throw new Error('El servicio aún no se ha desplegado: no hay contenedor que explorar.');
  }
  if (runtime.state !== 'running') {
    throw new Error('El contenedor no está en ejecución: arráncalo para explorar sus archivos.');
  }
  return name;
}

/** Convierte un error de exec sin shell en un mensaje claro. */
function shellError(res: { exitCode: number | null; output: string }, fallback: string): Error {
  if (res.exitCode === 126 || res.exitCode === 127 || /not found|no such file or directory: unknown/i.test(res.output)) {
    return new Error('La imagen de este contenedor no incluye una shell (sh) ni utilidades básicas: el explorador de archivos no está disponible para este servicio.');
  }
  const clean = res.output.trim().split('\n').slice(0, 4).join('\n').slice(0, 400);
  return new Error(clean || fallback);
}

/**
 * Parsea la salida de `ls -la`. Funciona con coreutils (GNU) y con busybox:
 * ambos usan el formato «permisos enlaces dueño grupo tamaño mes día hora nombre».
 */
export function parseLsOutput(output: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || /^total\b/i.test(line)) continue;
    const typeChar = line[0];
    if (!'bcdlps-'.includes(typeChar)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 9) continue;
    // Los ficheros de dispositivo muestran «mayor, menor» en lugar del tamaño,
    // lo que desplaza una columna: el nombre empieza entonces en el índice 9.
    const deviceShift = /,$/.test(parts[4]) ? 1 : 0;
    const sizeToken = parts[4 + deviceShift];
    const size = Number(sizeToken);
    let name = parts.slice(8 + deviceShift).join(' ');
    let target: string | undefined;
    if (typeChar === 'l') {
      const arrow = name.indexOf(' -> ');
      if (arrow >= 0) {
        target = name.slice(arrow + 4);
        name = name.slice(0, arrow);
      }
    }
    if (name === '' || name === '.' || name === '..') continue;
    const type = typeChar === 'd' ? 'dir' : typeChar === 'l' ? 'symlink' : typeChar === '-' ? 'file' : 'other';
    entries.push({
      name,
      type,
      size: Number.isFinite(size) ? size : 0,
      perms: parts[0].slice(1, 10),
      target,
    });
  }
  // Directorios primero, luego por nombre (como un gestor de archivos al uso).
  entries.sort((a, b) => {
    const ad = a.type === 'dir' ? 0 : 1;
    const bd = b.type === 'dir' ? 0 : 1;
    return ad - bd || a.name.localeCompare(b.name);
  });
  return entries;
}

export async function listDir(project: ProjectRow, service: ServiceRow, dir: string): Promise<DirListing> {
  const norm = normalizePath(dir);
  const name = await requireRunning(project, service);
  const res = await execInContainer(name, 'ls -la -- "$SKYWAY_DIR" 2>&1', {
    env: [`SKYWAY_DIR=${norm}`],
    timeoutMs: LIST_TIMEOUT_MS,
    maxOutput: 600_000,
  });
  if (res.timedOut) throw new Error('El listado del directorio superó el tiempo máximo.');
  if (res.exitCode !== 0) throw shellError(res, `No se pudo listar ${norm}`);
  return { path: norm, entries: parseLsOutput(res.output) };
}

// ---------- códec tar mínimo (sin dependencias) ----------

function readOctal(buf: Buffer, offset: number, len: number): number {
  const str = buf.toString('ascii', offset, offset + len).replace(/\0.*$/, '').trim();
  return str ? parseInt(str, 8) || 0 : 0;
}

/** Descarga UN archivo del contenedor leyendo el tar de `getArchive`. */
export async function downloadFile(
  project: ProjectRow,
  service: ServiceRow,
  filePath: string,
): Promise<{ name: string; content: Buffer }> {
  const norm = normalizePath(filePath);
  if (norm === '/') throw new Error('Selecciona un archivo, no la raíz.');
  const name = await requireRunning(project, service);
  const container = docker.getContainer(name);

  let stream: NodeJS.ReadableStream;
  try {
    stream = (await container.getArchive({ path: norm })) as unknown as NodeJS.ReadableStream;
  } catch (err: any) {
    if (err?.statusCode === 404) throw new Error('El archivo no existe en el contenedor.');
    throw new Error(err?.message || 'No se pudo leer el archivo.');
  }

  let buf: Buffer = Buffer.alloc(0);
  let size = -1;
  let entryName = '';
  const cap = MAX_DOWNLOAD_BYTES + 16_384; // cabeceras tar + relleno

  for await (const chunk of stream as any as AsyncIterable<Buffer>) {
    buf = Buffer.concat([buf as Uint8Array, chunk as unknown as Uint8Array]);
    if (size < 0 && buf.length >= 512) {
      entryName = buf.toString('ascii', 0, 100).replace(/\0.*$/, '');
      const typeflag = String.fromCharCode(buf[156]);
      if (typeflag === '5' || entryName.endsWith('/')) {
        (stream as any).destroy?.();
        throw new Error('Es un directorio: descarga archivos concretos.');
      }
      size = readOctal(buf, 124, 12);
      if (size > MAX_DOWNLOAD_BYTES) {
        (stream as any).destroy?.();
        throw new Error(`El archivo supera el límite de descarga (${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)} MB).`);
      }
    }
    if (buf.length > cap) {
      (stream as any).destroy?.();
      throw new Error('El archivo es demasiado grande para descargarlo desde el explorador.');
    }
    if (size >= 0 && buf.length >= 512 + size) break;
  }

  if (size < 0) throw new Error('El archivo está vacío o no se pudo leer.');
  return { name: path.posix.basename(entryName) || path.posix.basename(norm), content: buf.subarray(512, 512 + size) };
}

/** Construye un tar (formato ustar) con un único archivo. */
function buildTar(fileName: string, content: Buffer): Buffer {
  if (Buffer.byteLength(fileName) > 100) {
    throw new Error('El nombre del archivo es demasiado largo (máx. 100 bytes).');
  }
  const header = Buffer.alloc(512, 0);
  header.write(fileName, 0, 100, 'ascii');
  header.write('0000644\0', 100, 8, 'ascii'); // modo 0644
  header.write('0000000\0', 108, 8, 'ascii'); // uid 0
  header.write('0000000\0', 116, 8, 'ascii'); // gid 0
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii'); // checksum: espacios mientras se calcula
  header.write('0', 156, 1, 'ascii'); // typeflag: archivo regular
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

  const pad = (512 - (content.length % 512)) % 512;
  return Buffer.concat([header, content, Buffer.alloc(pad), Buffer.alloc(1024)]);
}

/** Sube un archivo al directorio indicado del contenedor. */
export async function uploadFile(
  project: ProjectRow,
  service: ServiceRow,
  dir: string,
  fileName: string,
  content: Buffer,
): Promise<void> {
  const normDir = normalizePath(dir);
  const base = path.posix.basename(fileName.trim());
  if (!base || base === '.' || base === '..' || base.includes('/')) {
    throw new Error('Nombre de archivo inválido.');
  }
  if (content.length > MAX_UPLOAD_BYTES) {
    throw new Error(`El archivo supera el límite de subida (${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB).`);
  }
  const name = await requireRunning(project, service);
  const container = docker.getContainer(name);
  const tar = buildTar(base, content);
  try {
    await container.putArchive(Readable.from(tar) as any, { path: normDir });
  } catch (err: any) {
    if (err?.statusCode === 404) throw new Error(`El directorio ${normDir} no existe en el contenedor.`);
    throw new Error(err?.message || 'No se pudo subir el archivo.');
  }
}

/** Crea un directorio (mkdir -p) dentro del contenedor. */
export async function makeDir(project: ProjectRow, service: ServiceRow, dir: string): Promise<void> {
  const norm = normalizePath(dir);
  if (norm === '/') throw new Error('Ruta inválida.');
  const name = await requireRunning(project, service);
  const res = await execInContainer(name, 'mkdir -p -- "$SKYWAY_DIR" 2>&1', {
    env: [`SKYWAY_DIR=${norm}`],
    timeoutMs: LIST_TIMEOUT_MS,
  });
  if (res.exitCode !== 0) throw shellError(res, `No se pudo crear ${norm}`);
}

/** Borra un archivo (o un directorio con `recursive`) dentro del contenedor. */
export async function deletePath(
  project: ProjectRow,
  service: ServiceRow,
  target: string,
  recursive: boolean,
): Promise<void> {
  const norm = normalizePath(target);
  if (norm === '/') throw new Error('No se puede borrar la raíz del contenedor.');
  const name = await requireRunning(project, service);
  const flag = recursive ? '-rf' : '-f';
  const res = await execInContainer(name, `rm ${flag} -- "$SKYWAY_DIR" 2>&1`, {
    env: [`SKYWAY_DIR=${norm}`],
    timeoutMs: LIST_TIMEOUT_MS,
  });
  if (res.exitCode !== 0) throw shellError(res, `No se pudo borrar ${norm}`);
}
