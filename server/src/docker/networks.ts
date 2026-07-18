import { docker } from './client';
import { ProjectRow } from '../types';

/** Red compartida con Traefik para exponer servicios con dominio. */
export const EDGE_NETWORK = 'skyway-edge';

export function projectNetworkName(project: ProjectRow): string {
  return `skyway-${project.slug}`;
}

export async function ensureNetwork(name: string): Promise<void> {
  try {
    await docker.getNetwork(name).inspect();
  } catch {
    try {
      await docker.createNetwork({
        Name: name,
        Driver: 'bridge',
        Labels: { 'skyway.managed': 'true' },
      });
    } catch (err: any) {
      // Carrera benigna: otro proceso la creó a la vez.
      if (!String(err?.message || '').includes('already exists')) throw err;
    }
  }
}

export async function removeNetwork(name: string): Promise<void> {
  try {
    await docker.getNetwork(name).remove();
  } catch {
    // best-effort: puede no existir o tener contenedores de terceros conectados
  }
}
