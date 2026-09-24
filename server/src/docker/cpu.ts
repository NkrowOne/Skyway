/**
 * Porcentaje de CPU de un contenedor a partir de `stats` de Docker. Aquí vive
 * solo lo puro, sin Docker, para poder probarlo.
 *
 * Docker expone la CPU como contadores acumulados (nanosegundos consumidos por
 * el contenedor y por el host). `stats` sin `one-shot` obliga al daemon a tomar
 * DOS muestras separadas un segundo para poder restar: ese es el segundo por
 * contenedor que hacía lento cada muestreo del panel. Con `one-shot` el daemon
 * contesta al instante con una sola muestra y la resta se hace aquí contra la
 * lectura anterior, que además cubre el intervalo real entre muestreos
 * (2,5–30 s) en vez de un segundo suelto: menos ruido y el mismo criterio que
 * `docker stats`.
 */

/** Campos de la respuesta de `stats` que se usan (los tipos de dockerode no declaran `id`). */
export interface DockerStatsSample {
  id?: string;
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: { usage?: number; limit?: number };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
}

/** Última lectura de los contadores de un contenedor. */
export interface CpuBaseline {
  /** Id del contenedor: uno recreado con el mismo nombre no comparte contadores. */
  id: string;
  cpuTotal: number;
  systemTotal: number;
  /** Instante de la lectura, para olvidar las de contenedores que ya no se muestrean. */
  at: number;
}

export function baselineFrom(s: DockerStatsSample, at = Date.now()): CpuBaseline {
  return {
    id: s.id ?? '',
    cpuTotal: s.cpu_stats?.cpu_usage?.total_usage ?? 0,
    systemTotal: s.cpu_stats?.system_cpu_usage ?? 0,
    at,
  };
}

/**
 * % de CPU (100 = un núcleo entero) entre la línea base y la muestra, con la
 * fórmula de `docker stats`. null si la línea base no vale: no la hay, es de
 * otro contenedor, o los contadores retrocedieron (el contenedor se reinició
 * y su cgroup empezó de cero).
 */
export function cpuPercentFromBaseline(s: DockerStatsSample, baseline: CpuBaseline | undefined): number | null {
  if (!baseline || baseline.id !== (s.id ?? '')) return null;
  const cur = baselineFrom(s);
  const cpuDelta = cur.cpuTotal - baseline.cpuTotal;
  const sysDelta = cur.systemTotal - baseline.systemTotal;
  if (cpuDelta < 0 || sysDelta <= 0) return null;
  return (cpuDelta / sysDelta) * (s.cpu_stats?.online_cpus || 1) * 100;
}

/** % de CPU con las dos muestras que trae Docker sin `one-shot` (`precpu_stats`). */
export function cpuPercentFromDocker(s: DockerStatsSample): number {
  const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage || 0) - (s.precpu_stats?.cpu_usage?.total_usage || 0);
  const sysDelta = (s.cpu_stats?.system_cpu_usage || 0) - (s.precpu_stats?.system_cpu_usage || 0);
  const onlineCpus = s.cpu_stats?.online_cpus || 1;
  return sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * onlineCpus * 100 : 0;
}
