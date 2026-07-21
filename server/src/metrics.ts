import { ServiceMetricHour, HostMetricHour } from './types';
import { now } from './util';

/**
 * Estado del histórico de consumo: la parte que no cabe en SQLite.
 *
 * Docker expone la red como CONTADORES ACUMULADOS por contenedor (bytes desde
 * que arrancó). Para saber cuánto se transfirió en una hora hace falta la
 * diferencia entre muestras consecutivas; aquí se guarda el último valor visto
 * por réplica para calcular ese delta en el siguiente tick del monitor.
 */
const netCounters = new Map<string, { rx: number; tx: number }>();

/**
 * Bytes transferidos por una réplica desde la muestra anterior.
 * - Primera muestra: 0 (no hay línea base; el acumulado podría venir de días).
 * - Contador que retrocede: el contenedor se reinició y el contador volvió a 0,
 *   así que el valor actual ES el delta del periodo.
 */
export function netDelta(replicaName: string, curRx: number, curTx: number): { rx: number; tx: number } {
  const prev = netCounters.get(replicaName);
  netCounters.set(replicaName, { rx: curRx, tx: curTx });
  if (!prev) return { rx: 0, tx: 0 };
  return {
    rx: curRx >= prev.rx ? curRx - prev.rx : curRx,
    tx: curTx >= prev.tx ? curTx - prev.tx : curTx,
  };
}

/** Olvida los contadores de réplicas que ya no existen (evita fugas de memoria). */
export function pruneNetCounters(seen: Set<string>): void {
  for (const name of netCounters.keys()) if (!seen.has(name)) netCounters.delete(name);
}

// ---------- agrupado del histórico para la API ----------

export interface ServiceMetricPoint {
  /** Inicio del cubo en ms (UTC). */
  t: number;
  /** Muestras del monitor que respaldan el cubo (para ponderar medias entre cubos). */
  samples: number;
  /** Media de CPU en el cubo (100 = un núcleo). null si no hubo muestras. */
  cpuAvg: number | null;
  cpuMax: number | null;
  memAvg: number | null;
  memMax: number | null;
  memLimit: number | null;
  /** Bytes recibidos/enviados en el cubo (total del periodo). */
  netRx: number;
  netTx: number;
  disk: number | null;
}

export interface HostMetricPoint {
  t: number;
  loadAvg: number | null;
  loadMax: number | null;
  memUsedAvg: number | null;
  memUsedMax: number | null;
  memTotal: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
}

/**
 * Tamaño de cubo según la ventana pedida, para mantener ~24-30 puntos por
 * gráfica (legibles) sea cual sea el rango: 24 h por hora, 7 d cada 6 h, más
 * largo por día.
 */
export function bucketHoursFor(hours: number): number {
  if (hours <= 24) return 1;
  if (hours <= 24 * 7) return 6;
  return 24;
}

/** Rango de horas cubierto por la ventana (coincide con el filtro `hour > from` de la BD). */
function windowHours(hours: number): { first: number; last: number } {
  const nowHour = Math.floor(now() / 3_600_000);
  return { first: nowHour - hours + 1, last: nowHour };
}

/**
 * Convierte las filas horarias en una rejilla completa de puntos: los cubos sin
 * datos (servicio parado) salen con null en CPU/RAM para que la línea se corte
 * en lugar de fingir un cero medido. La red va a 0 (no hubo tráfico).
 */
export function bucketServiceMetrics(rows: ServiceMetricHour[], hours: number): ServiceMetricPoint[] {
  const bh = bucketHoursFor(hours);
  const { first, last } = windowHours(hours);
  const byKey = new Map<number, ServiceMetricHour[]>();
  for (const r of rows) {
    const key = Math.floor(r.hour / bh);
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(r);
  }

  const out: ServiceMetricPoint[] = [];
  for (let key = Math.floor(first / bh); key <= Math.floor(last / bh); key++) {
    const group = byKey.get(key) ?? [];
    const samples = group.reduce((a, r) => a + r.samples, 0);
    let netRx = 0;
    let netTx = 0;
    let cpuMax: number | null = null;
    let memMax: number | null = null;
    let cpuSum = 0;
    let memSum = 0;
    let memLimit: number | null = null;
    let disk: number | null = null;
    for (const r of group) {
      netRx += r.net_rx;
      netTx += r.net_tx;
      cpuSum += r.cpu_sum;
      memSum += r.mem_sum;
      if (r.samples > 0) {
        cpuMax = Math.max(cpuMax ?? 0, r.cpu_max);
        memMax = Math.max(memMax ?? 0, r.mem_max);
        if (r.mem_limit_last > 0) memLimit = r.mem_limit_last; // último de la hora más reciente del cubo
      }
      if (r.disk_last !== null && r.disk_last !== undefined) disk = r.disk_last;
    }
    out.push({
      t: key * bh * 3_600_000,
      samples,
      cpuAvg: samples > 0 ? cpuSum / samples : null,
      cpuMax,
      memAvg: samples > 0 ? memSum / samples : null,
      memMax,
      memLimit,
      netRx,
      netTx,
      disk,
    });
  }
  return out;
}

export function bucketHostMetrics(rows: HostMetricHour[], hours: number): HostMetricPoint[] {
  const bh = bucketHoursFor(hours);
  const { first, last } = windowHours(hours);
  const byKey = new Map<number, HostMetricHour[]>();
  for (const r of rows) {
    const key = Math.floor(r.hour / bh);
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(r);
  }

  const out: HostMetricPoint[] = [];
  for (let key = Math.floor(first / bh); key <= Math.floor(last / bh); key++) {
    const group = byKey.get(key) ?? [];
    const samples = group.reduce((a, r) => a + r.samples, 0);
    let loadMax: number | null = null;
    let memMax: number | null = null;
    let loadSum = 0;
    let memSum = 0;
    let memTotal: number | null = null;
    let diskUsed: number | null = null;
    let diskTotal: number | null = null;
    for (const r of group) {
      loadSum += r.load_sum;
      memSum += r.mem_used_sum;
      if (r.samples > 0) {
        loadMax = Math.max(loadMax ?? 0, r.load_max);
        memMax = Math.max(memMax ?? 0, r.mem_used_max);
        if (r.mem_total_last > 0) memTotal = r.mem_total_last;
      }
      if (r.disk_used_last !== null && r.disk_used_last !== undefined) diskUsed = r.disk_used_last;
      if (r.disk_total_last !== null && r.disk_total_last !== undefined) diskTotal = r.disk_total_last;
    }
    out.push({
      t: key * bh * 3_600_000,
      loadAvg: samples > 0 ? loadSum / samples : null,
      loadMax,
      memUsedAvg: samples > 0 ? memSum / samples : null,
      memUsedMax: memMax,
      memTotal,
      diskUsed,
      diskTotal,
    });
  }
  return out;
}
