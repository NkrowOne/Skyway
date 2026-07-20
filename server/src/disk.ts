import fs from 'fs';
import { config } from './config';
import { listProjects, listServices } from './db';
import { docker } from './docker/client';
import { listServiceContainers, volumeName } from './docker/containers';
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
const CACHE_MS = 60_000;

/** Nombres de todos los volúmenes que pertenecen a un servicio. */
function serviceVolumeNames(project: ProjectRow, service: ServiceRow): string[] {
  const names = new Set<string>();
  if (service.type === 'database') names.add(volumeName(project, service));
  for (const v of ((service.config as any).volumes ?? []) as { name: string }[]) names.add(v.name);
  return [...names];
}

/**
 * Calcula el uso de disco de todos los servicios en una sola pasada:
 * `docker system df -v` para volúmenes + inspect con tamaños por contenedor.
 * Es una operación costosa, así que se cachea 60 s y se comparte entre peticiones.
 */
async function collect(): Promise<DiskSnapshot> {
  const services = new Map<string, ServiceDiskUsage>();

  let volumeSizes = new Map<string, number>();
  try {
    const df: any = await docker.df();
    volumeSizes = new Map(
      ((df.Volumes ?? []) as any[]).map((v) => [v.Name as string, Math.max(0, v.UsageData?.Size ?? 0)]),
    );
  } catch {
    // sin df seguimos con los tamaños de contenedor
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

      try {
        for (const c of await listServiceContainers(service.id)) {
          const info: any = await docker.getContainer(c.id).inspect({ size: true } as any);
          entry.containerBytes += info?.SizeRw ?? 0;
          // El log json-file solo es medible si el path del host es accesible
          // (Skyway corriendo en el host o con /var/lib/docker montado).
          const logPath = info?.LogPath;
          if (logPath) {
            try {
              const st = fs.statSync(logPath);
              entry.logBytes = (entry.logBytes ?? 0) + st.size;
            } catch {
              /* inaccesible desde el contenedor de Skyway */
            }
          }
        }
      } catch {
        /* contenedor inexistente */
      }

      entry.totalBytes =
        entry.volumes.reduce((acc, v) => acc + v.sizeBytes, 0) + entry.containerBytes + (entry.logBytes ?? 0);
      services.set(service.id, entry);
    }
  }

  return { ts: Date.now(), services };
}

/** Uso de disco por servicio, con caché de 60 s compartida. */
export async function diskUsageByService(force = false): Promise<Map<string, ServiceDiskUsage>> {
  if (!force && cached && Date.now() - cached.ts < CACHE_MS) return cached.services;
  if (!inFlight) {
    inFlight = collect()
      .then((snap) => {
        cached = snap;
        return snap;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return (await inFlight).services;
}
