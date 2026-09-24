import { useSyncExternalStore } from 'react';
import { ContainerState, MetricsSnapshot, ServiceStats } from './types';

/** Entrada de un servicio en la foto de métricas del stream del proyecto. */
export type ServiceLive = MetricsSnapshot['services'][string];

/**
 * Última foto de métricas del proyecto abierto, FUERA del estado de React.
 *
 * Con la foto como estado de la página, cada tick del stream (2,5 s) volvía a
 * pintar la página entera, las N tarjetas —cuyo `memo` no servía porque cada
 * foto trae objetos nuevos— y el drawer con la pestaña abierta (una consulta de
 * 500 filas, el listado de archivos…) aunque no hubiera cambiado ni una cifra.
 * Aquí cada consumidor se suscribe a lo suyo: la tarjeta a su servicio, la
 * cabecera del drawer a su estado, la pestaña de métricas a la foto entera. Y
 * al publicar se conserva la identidad de las entradas que no cambian, así que
 * un servicio parado no vuelve a pintar nada.
 */
let snapshot: MetricsSnapshot | null = null;
const listeners = new Set<() => void>();

function sameStats(a: ServiceStats | null, b: ServiceStats | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.cpuPercent === b.cpuPercent &&
    a.memUsage === b.memUsage &&
    a.memLimit === b.memLimit &&
    a.netRx === b.netRx &&
    a.netTx === b.netTx
  );
}

function sameReplicas(a: ServiceLive['replicas'], b: ServiceLive['replicas']): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.running === b.running && a.total === b.total;
}

/** La entrada nueva, o la anterior si nada cambió (misma identidad → sin repintado). */
function reuse(prev: ServiceLive | undefined, next: ServiceLive): ServiceLive {
  if (!prev) return next;
  const replicas = sameReplicas(prev.replicas, next.replicas);
  const stats = sameStats(prev.stats, next.stats);
  if (prev.state === next.state && replicas && stats) return prev;
  // Cambió algo, pero las partes iguales conservan su identidad: también
  // tienen suscriptores propios (la cabecera del drawer solo mira las réplicas).
  if (replicas) next.replicas = prev.replicas;
  if (stats) next.stats = prev.stats;
  return next;
}

function emit(): void {
  for (const fn of listeners) fn();
}

/** Publica la foto recién llegada por el stream. */
export function publishLiveSnapshot(next: MetricsSnapshot): void {
  if (snapshot) {
    for (const id of Object.keys(next.services)) next.services[id] = reuse(snapshot.services[id], next.services[id]);
  }
  snapshot = next;
  emit();
}

/** Vacía la foto: al cambiar de proyecto, las tarjetas del nuevo no deben pintar el estado del anterior. */
export function clearLiveSnapshot(): void {
  if (snapshot === null) return;
  snapshot = null;
  emit();
}

/** Lectura puntual, sin suscripción (pruebas y acumuladores). */
export function liveSnapshot(): MetricsSnapshot | null {
  return snapshot;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** La foto entera: para quien pinta valores de todos los servicios (pestaña Métricas). */
export function useLiveSnapshot(): MetricsSnapshot | null {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** La entrada de UN servicio; misma identidad mientras no cambie nada de ese servicio. */
export function useServiceLive(serviceId: string): ServiceLive | null {
  return useSyncExternalStore(subscribe, () => snapshot?.services[serviceId] ?? null);
}

/** Solo el estado del contenedor (un texto): quien lo usa no se repinta por el consumo. */
export function useServiceLiveState(serviceId: string): ContainerState | null {
  return useSyncExternalStore(subscribe, () => snapshot?.services[serviceId]?.state ?? null);
}

/** Solo las réplicas, con identidad conservada mientras no cambien. */
export function useServiceLiveReplicas(serviceId: string): { running: number; total: number } | null {
  return useSyncExternalStore(subscribe, () => snapshot?.services[serviceId]?.replicas ?? null);
}
