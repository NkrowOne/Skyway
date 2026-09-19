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

/** Cadena terminada en NUL de una cabecera tar (los nombres son bytes UTF-8). */
function readString(buf: Buffer, offset: number, len: number): string {
  return buf.toString('utf8', offset, offset + len).replace(/\0.*$/s, '');
}

const roundUp512 = (n: number): number => Math.ceil(n / 512) * 512;

/** Cabeceras que solo aportan metadatos de la entrada SIGUIENTE (o del archivo). */
const META_TYPEFLAGS = new Set(['x', 'g', 'L', 'K']);

type TarScan =
  | { status: 'need_more' }
  | { status: 'end' }
  | { status: 'entry'; name: string; typeflag: string; size: number; dataStart: number };

/**
 * Localiza la primera entrada REAL del tar que hay en `buf`. Docker escribe con
 * el `archive/tar` de Go, que delante de un nombre de más de 100 bytes pone una
 * cabecera PAX (`x`) cuyo cuerpo es `NN path=...`; tar GNU usa `L`. Antes se
 * tomaba la primera cabecera fuera la que fuera, así que un archivo con nombre
 * largo (o con acentos suficientes) se descargaba como un fichero de texto con
 * `path=` dentro. Las cabeceras de metadatos se saltan y su nombre, si lo
 * traen, se aplica a la entrada que sigue.
 */
export function scanTarEntry(buf: Buffer): TarScan {
  let offset = 0;
  let longName: string | null = null;
  for (;;) {
    if (buf.length < offset + 512) return { status: 'need_more' };
    // Dos bloques a cero marcan el fin del archivo; con uno basta para saber
    // que no hay entrada.
    if (buf[offset] === 0 && buf.subarray(offset, offset + 512).every((b) => b === 0)) return { status: 'end' };
    const typeflag = String.fromCharCode(buf[offset + 156]);
    const size = readOctal(buf, offset + 124, 12);
    if (META_TYPEFLAGS.has(typeflag)) {
      const dataEnd = offset + 512 + size;
      if (buf.length < dataEnd) return { status: 'need_more' };
      if (typeflag === 'x' || typeflag === 'L') {
        const body = buf.toString('utf8', offset + 512, dataEnd);
        if (typeflag === 'L') longName = body.replace(/\0.*$/s, '');
        else {
          // Registros PAX: «longitud clave=valor\n», la longitud cuenta todo el registro.
          const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body);
          if (m) longName = m[1];
        }
      }
      offset = dataEnd + ((512 - (size % 512)) % 512);
      continue;
    }
    let name = readString(buf, offset, 100);
    // ustar reparte los nombres largos en «prefix/name».
    if (readString(buf, offset + 257, 6) === 'ustar') {
      const prefix = readString(buf, offset + 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    return { status: 'entry', name: longName ?? name, typeflag, size, dataStart: offset + 512 };
  }
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

  // Trozos acumulados en una lista y un único concat al final: concatenar en
  // cada trozo copiaba todo lo leído una y otra vez (cuadrático), y con un
  // archivo de decenas de MB en trozos de 16 KB eran gigabytes de copia.
  const chunks: Buffer[] = [];
  let total = 0;
  let entry: Extract<TarScan, { status: 'entry' }> | null = null;
  const cap = MAX_DOWNLOAD_BYTES + 16_384; // cabeceras tar + relleno

  try {
    for await (const chunk of stream as any as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      total += chunk.length;
      if (total > cap) throw new Error('El archivo es demasiado grande para descargarlo desde el explorador.');
      if (!entry) {
        // Mientras se buscan las cabeceras el acumulado es pequeño (bloques de
        // 512 bytes): aquí sí se compacta, y se sustituye la lista para no
        // volver a concatenar lo mismo con el siguiente trozo.
        const head = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
        chunks.length = 0;
        chunks.push(head);
        const scan = scanTarEntry(head);
        if (scan.status === 'need_more') continue;
        if (scan.status === 'end') throw new Error('El archivo está vacío o no se pudo leer.');
        if (scan.typeflag === '5' || scan.name.endsWith('/')) throw new Error('Es un directorio: descarga archivos concretos.');
        if (scan.typeflag === '2') throw new Error('Es un enlace simbólico: descarga el archivo al que apunta.');
        if (scan.size > MAX_DOWNLOAD_BYTES) {
          throw new Error(`El archivo supera el límite de descarga (${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)} MB).`);
        }
        entry = scan;
      }
      if (total >= entry.dataStart + entry.size) break;
    }
  } finally {
    // También al salir por `break`: sin esto el stream de Docker quedaba
    // abierto hasta que el daemon terminaba de enviar el relleno del tar.
    try {
      (stream as any).destroy?.();
    } catch {
      /* noop */
    }
  }

  if (!entry) throw new Error('El archivo está vacío o no se pudo leer.');
  const buf = Buffer.concat(chunks);
  if (buf.length < entry.dataStart + entry.size) throw new Error('La descarga se cortó antes de terminar.');
  return {
    name: path.posix.basename(entry.name) || path.posix.basename(norm),
    content: buf.subarray(entry.dataStart, entry.dataStart + entry.size),
  };
}

/** Construye un tar (formato ustar) con un único archivo. */
function buildTar(fileName: string, content: Buffer): Buffer {
  if (Buffer.byteLength(fileName) > 100) {
    throw new Error('El nombre del archivo es demasiado largo (máx. 100 bytes).');
  }
  const header = Buffer.alloc(512, 0);
  // En UTF-8, que es como el tar de Go (Docker) lee los nombres: con 'ascii'
  // una «ñ» o un acento se escribían como bytes sueltos y el archivo aparecía
  // en el contenedor con el nombre destrozado.
  header.write(fileName, 0, 100, 'utf8');
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
