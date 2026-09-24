import fs from 'fs';
import { config } from './config';
import { listProjects, listServicesForProjects } from './db';
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

/** Totales de lo que ocupa Docker, para el administrador (Monitor → Espacio, Ajustes). */
export interface DockerDiskTotals {
  images: { count: number; size: number };
  containers: { count: number; size: number };
  volumes: { count: number; size: number };
  buildCache: { size: number };
}

interface DiskSnapshot {
  ts: number;
  services: Map<string, ServiceDiskUsage>;
  totals: DockerDiskTotals;
}

/**
 * Tope de `docker system df`: mide cada volumen y cada capa de escritura y en
 * un host grande puede tardar minutos. Sin tope, una llamada colgada dejaba
 * el ciclo del monitor esperando para siempre, y con él las alertas de caída
 * y el histórico.
 */
const DF_TIMEOUT_MS = 2 * 60_000;

/**
 * Los tipos de dockerode no declaran las opciones de `df`, pero la
 * implementación reenvía `abortSignal` igual que en el resto de llamadas.
 */
function systemDf(): Promise<any> {
  const df = docker.df as unknown as (opts: { abortSignal: AbortSignal }) => Promise<any>;
  return df.call(docker, { abortSignal: AbortSignal.timeout(DF_TIMEOUT_MS) });
}

function totalsFrom(df: any): DockerDiskTotals {
  const sum = (arr: any[], pick: (x: any) => number) => (arr || []).reduce((acc, x) => acc + (pick(x) || 0), 0);
  return {
    images: { count: (df.Images || []).length, size: df.LayersSize || sum(df.Images || [], (i) => i.Size) },
    containers: { count: (df.Containers || []).length, size: sum(df.Containers || [], (c) => c.SizeRw) },
    volumes: { count: (df.Volumes || []).length, size: sum(df.Volumes || [], (v) => Math.max(0, v.UsageData?.Size ?? 0)) },
    buildCache: { size: sum(df.BuildCache || [], (b) => b.Size) },
  };
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
    if (!logPath) {
      // Otro driver de log (sin fichero): tampoco hay nada que leer, y no
      // tiene sentido repetir un `inspect` por contenedor en cada ronda.
      logPathReadable = false;
      return null;
    }
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

  // Sin `df` no hay tamaños, y unos ceros no son un dato: se cacheaban 60 s,
  // el monitor los escribía en el histórico y daba por resueltas las alertas
  // de cuota, que volvían a saltar —y a avisar por Discord o correo— cinco
  // minutos después. Se falla, se conserva la foto anterior y se reintenta.
  const df: any = await systemDf();
  const volumeSizes = new Map<string, number>(
    ((df.Volumes ?? []) as any[]).map((v) => [v.Name as string, Math.max(0, v.UsageData?.Size ?? 0)]),
  );
  const containersByService = new Map<string, { id: string; sizeRw: number }[]>();
  for (const c of (df.Containers ?? []) as any[]) {
    const serviceId = c.Labels?.['skyway.service'];
    if (typeof serviceId !== 'string' || !serviceId) continue;
    const list = containersByService.get(serviceId) ?? [];
    list.push({ id: c.Id as string, sizeRw: Math.max(0, c.SizeRw ?? 0) });
    containersByService.set(serviceId, list);
  }

  const projects = listProjects();
  const servicesByProject = listServicesForProjects(projects.map((p) => p.id));
  for (const project of projects) {
    for (const service of servicesByProject.get(project.id) ?? []) {
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

  return { ts: Date.now(), services, totals: totalsFrom(df) };
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

/**
 * Totales de Docker (imágenes, contenedores, volúmenes, caché de build) con
 * la misma caché de 60 s: antes las dos rutas de administración lanzaban su
 * propio `df` sin tope en cada petición, encima del que ya hacía el desglose.
 */
export async function dockerDiskTotals(): Promise<DockerDiskTotals> {
  if (cached) {
    if (Date.now() - cached.ts >= CACHE_MS) void refresh().catch(() => {});
    return cached.totals;
  }
  return (await refresh()).totals;
}
