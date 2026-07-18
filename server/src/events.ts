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
