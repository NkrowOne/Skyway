import { EventEmitter } from 'events';

/** Bus de eventos en memoria para logs de despliegue y cambios de estado. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export type DeployEvent =
  | { type: 'log'; line: string }
  | { type: 'status'; status: string }
  | { type: 'done'; status: 'success' | 'failed' | 'canceled'; error?: string | null };

export function emitDeploy(deploymentId: string, ev: DeployEvent): void {
  bus.emit(`deployment:${deploymentId}`, ev);
}

export function onDeploy(deploymentId: string, fn: (ev: DeployEvent) => void): () => void {
  const key = `deployment:${deploymentId}`;
  bus.on(key, fn);
  return () => bus.off(key, fn);
}

/**
 * Resumen de un despliegue para el feed del proyecto. El canal por despliegue
 * de arriba solo sirve a quien ya está mirando ESE despliegue; este avisa al
 * panel entero —rejilla de servicios incluida— en cuanto empieza uno, que es
 * lo que hace que se vea «hay una versión nueva saliendo» sin abrir nada.
 */
export interface DeployFeedItem {
  id: string;
  serviceId: string;
  projectId: string;
  status: string;
  trigger: string;
  commitSha: string | null;
  commitMsg: string | null;
  createdAt: number;
  finishedAt: number | null;
}

/** Fila de despliegue → item del feed, para que instantánea y evento coincidan. */
export function toDeployFeedItem(
  row: {
    id: string;
    service_id: string;
    status: string;
    trigger: string;
    commit_sha: string | null;
    commit_msg: string | null;
    created_at: number;
    finished_at: number | null;
  },
  projectId: string,
): DeployFeedItem {
  return {
    id: row.id,
    serviceId: row.service_id,
    projectId,
    status: row.status,
    trigger: row.trigger,
    commitSha: row.commit_sha,
    commitMsg: row.commit_msg,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

const FEED_KEY = 'deploy:feed';

export function emitDeployFeed(item: DeployFeedItem): void {
  bus.emit(FEED_KEY, item);
}

export function onDeployFeed(fn: (item: DeployFeedItem) => void): () => void {
  bus.on(FEED_KEY, fn);
  return () => bus.off(FEED_KEY, fn);
}
