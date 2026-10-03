import { docker, dockerQuery } from './client';

/**
 * Operaciones sobre volúmenes, redes e imágenes para el borrado de proyectos y
 * servicios y para la limpieza de datos sin proyecto.
 *
 * A diferencia de `removeVolume`/`removeNetwork`, que son de mejor esfuerzo y
 * callan cualquier error, estas devuelven «missing» si el recurso ya no existe
 * y LANZAN el resto (un 409 porque un contenedor lo usa, un daemon que no
 * responde): quien borra datos tiene que poder decir qué se ha quedado.
 */

export interface DockerVolumeInfo {
  name: string;
  driver: string;
  /** Etiquetas del volumen (Compose, Swarm, anónimo…). Los de Skyway no llevan. */
  labels: Record<string, string>;
  createdAt: string | null;
}

export async function listVolumes(): Promise<DockerVolumeInfo[]> {
  const res = (await dockerQuery.listVolumes()) as { Volumes?: any[] | null };
  return (res.Volumes ?? []).map((v) => ({
    name: String(v.Name),
    driver: String(v.Driver ?? ''),
    labels: v.Labels && typeof v.Labels === 'object' ? (v.Labels as Record<string, string>) : {},
    createdAt: typeof v.CreatedAt === 'string' ? v.CreatedAt : null,
  }));
}

/**
 * Volúmenes con nombre que monta algún contenedor, en cualquier estado
 * (también parados o recién creados), con los nombres de esos contenedores.
 * Un contenedor parado sigue siendo el dueño de sus datos: no se toca.
 */
export async function volumesInUse(): Promise<Map<string, string[]>> {
  const list = await dockerQuery.listContainers({ all: true });
  const out = new Map<string, string[]>();
  for (const c of list) {
    const name = (c.Names?.[0] || c.Id).replace(/^\//, '');
    for (const m of (c.Mounts ?? []) as { Type?: string; Name?: string }[]) {
      if (m.Type !== 'volume' || !m.Name) continue;
      const users = out.get(m.Name) ?? [];
      users.push(name);
      out.set(m.Name, users);
    }
  }
  return out;
}

function esNoEncontrado(err: any): boolean {
  return err?.statusCode === 404;
}

/** Borra un volumen. Sin `force`: un volumen en uso no se borra nunca (409). */
export async function deleteVolume(name: string): Promise<'removed' | 'missing'> {
  try {
    await docker.getVolume(name).remove();
    return 'removed';
  } catch (err: any) {
    if (esNoEncontrado(err)) return 'missing';
    throw err;
  }
}

/** Borra una red. Falla (403/409) si queda algún contenedor conectado. */
export async function deleteNetwork(name: string): Promise<'removed' | 'missing'> {
  try {
    await docker.getNetwork(name).remove();
    return 'removed';
  } catch (err: any) {
    if (esNoEncontrado(err)) return 'missing';
    throw err;
  }
}

/** Quita una etiqueta de imagen. Sin `force`: si un contenedor la usa, 409. */
export async function deleteImage(tag: string): Promise<'removed' | 'missing'> {
  try {
    await docker.getImage(tag).remove();
    return 'removed';
  } catch (err: any) {
    if (esNoEncontrado(err)) return 'missing';
    throw err;
  }
}

/** Mensaje legible de un error del daemon (dockerode lo envuelve con el código HTTP). */
export function dockerErrorText(err: unknown): string {
  const e = err as { json?: { message?: string }; reason?: string; message?: string } | null;
  return e?.json?.message || e?.message || e?.reason || String(err);
}
