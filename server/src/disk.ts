import fs from 'fs';
import { config } from './config';
import { listProjects, listServices } from './db';
import { docker, dockerQuery } from './docker/client';
import { volumeName } from './docker/containers';
import { ProjectRow, ServiceRow } from './types';

/** Espacio total/libre del sistema de archivos donde vive DATA_DIR. */
export async function hostDisk(): Promise<{ total: number; free: number } | null> {
  try {
    const st = await fs.promises.statfs(config.dataDir);
    return { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
  } catch {
    return null;
  }
}

export interface ServiceDiskUsage {
  serviceId: string;
  /** Suma de volúmenes + capa de escritura del contenedor + log json (si es legible). */
  totalBytes: number;
  volumes: { name: string; sizeBytes: number }[];
  containerBytes: number;
  logBytes: number | null;
  quotaMb: number | null;
}

interface DiskSnapshot {
  ts: number;
  services: Map<string, ServiceDiskUsage>;
}

let cached: DiskSnapshot | null = null;
let inFlight: Promise<DiskSnapshot> | null = null;
/** Refresco encadenado detrás del que está en vuelo (ver `refresh(force)`). */
let queued: Promise<DiskSnapshot> | null = null;
const CACHE_MS = 60_000;

/** Nombres de todos los volúmenes que pertenecen a un servicio. */
function serviceVolumeNames(project: ProjectRow, service: ServiceRow): string[] {
  const names = new Set<string>();
  if (service.type === 'database') names.add(volumeName(project, service));
  for (const v of ((service.config as any).volumes ?? []) as { name: string }[]) names.add(v.name);
  return [...names];
}

/**
 * Si la ruta del log json-file es legible desde aquí. Solo lo es con Skyway
 * corriendo en el host o con /var/lib/docker montado; en el caso habitual (en
 * su contenedor) no lo es, y la primera vez que se comprueba se deja de pedir
 * el `inspect` por contenedor que solo servía para eso.
 */
let logPathReadable: boolean | null = null;

async function containerLogBytes(id: string): Promise<number | null> {
  if (logPathReadable === false) return null;
  try {
    const info: any = await dockerQuery.getContainer(id).inspect();
    const logPath = info?.LogPath;
    if (!logPath) return null;
    const st = await fs.promises.stat(logPath);
    logPathReadable = true;
    return st.size;
  } catch (err: any) {
    // Inaccesible desde el contenedor de Skyway: no se vuelve a intentar. Un
    // 404 de Docker (contenedor eliminado a mitad) no dice nada de la ruta.
    if (err?.code === 'ENOENT' || err?.code === 'EACCES') logPathReadable = false;
    return null;
  }
}

/**
 * Calcula el uso de disco de todos los servicios en una sola pasada. Un solo
 * `docker system df` trae el tamaño de cada volumen Y la capa de escritura
 * (`SizeRw`) de cada contenedor con sus etiquetas; antes se hacía además un
 * `inspect({size:true})` por contenedor, que obliga al daemon a medir la capa
 * uno a uno. Es una operación costosa, así que se cachea 60 s y se comparte.
 */
async function collect(): Promise<DiskSnapshot> {
  const services = new Map<string, ServiceDiskUsage>();

  let volumeSizes = new Map<string, number>();
  const containersByService = new Map<string, { id: string; sizeRw: number }[]>();
  try {
    const df: any = await docker.df();
    volumeSizes = new Map(
      ((df.Volumes ?? []) as any[]).map((v) => [v.Name as string, Math.max(0, v.UsageData?.Size ?? 0)]),
    );
    for (const c of (df.Containers ?? []) as any[]) {
      const serviceId = c.Labels?.['skyway.service'];
      if (typeof serviceId !== 'string' || !serviceId) continue;
      const list = containersByService.get(serviceId) ?? [];
      list.push({ id: c.Id as string, sizeRw: Math.max(0, c.SizeRw ?? 0) });
      containersByService.set(serviceId, list);
    }
  } catch {
    // sin df no hay tamaños: se devuelven ceros y se reintenta en el siguiente ciclo
  }

  for (const project of listProjects()) {
    for (const service of listServices(project.id)) {
      const cfg = service.config as any;
      const entry: ServiceDiskUsage = {
        serviceId: service.id,
        totalBytes: 0,
        volumes: [],
        containerBytes: 0,
        logBytes: null,
        quotaMb: cfg.diskMb && cfg.diskMb > 0 ? cfg.diskMb : null,
      };

      for (const name of serviceVolumeNames(project, service)) {
        const size = volumeSizes.get(name);
        if (size !== undefined) entry.volumes.push({ name, sizeBytes: size });
      }

      for (const c of containersByService.get(service.id) ?? []) {
        entry.containerBytes += c.sizeRw;
        const logBytes = await containerLogBytes(c.id);
        if (logBytes !== null) entry.logBytes = (entry.logBytes ?? 0) + logBytes;
      }

      entry.totalBytes =
        entry.volumes.reduce((acc, v) => acc + v.sizeBytes, 0) + entry.containerBytes + (entry.logBytes ?? 0);
      services.set(service.id, entry);
    }
  }

  return { ts: Date.now(), services };
}

function start(): Promise<DiskSnapshot> {
  const work = collect()
    .then((snap) => {
      cached = snap;
      return snap;
    })
    .finally(() => {
      if (inFlight === work) inFlight = null;
    });
  inFlight = work;
  return work;
}

function refresh(force = false): Promise<DiskSnapshot> {
  if (!inFlight) return start();
  if (!force) return inFlight;
  // Forzar con un refresco en vuelo: ese empezó ANTES de la acción que motiva
  // el force (un borrado, una restauración) y puede no reflejarla. Se encadena
  // uno detrás; varios force seguidos comparten el mismo encadenado.
  if (!queued) {
    const run = () => start();
    queued = inFlight.then(run, run).finally(() => {
      queued = null;
    });
  }
  return queued;
}

/**
 * Uso de disco por servicio, con caché de 60 s compartida.
 * Si el caché está caducado se sirve el dato viejo y se refresca en segundo
 * plano: el Monitor nunca se queda esperando a `docker system df`.
 */
export async function diskUsageByService(force = false): Promise<Map<string, ServiceDiskUsage>> {
  if (cached && !force) {
    if (Date.now() - cached.ts >= CACHE_MS) void refresh().catch(() => {});
    return cached.services;
  }
  return (await refresh(force)).services;
}
