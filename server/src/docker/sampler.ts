/**
 * Muestreador único del estado de Docker.
 *
 * Hasta ahora cada consumidor preguntaba por su cuenta: el monitor cada 30 s, el
 * stream de métricas de CADA pestaña abierta cada 2,5 s, la consulta del
 * proyecto cada 4 s, la del servicio otros 4 s y la vista de Monitor cada 60 s.
 * Con N servicios eso son N `inspect` + N `stats` por consumidor y por ciclo, y
 * `stats` tarda alrededor de un segundo por contenedor: con dos pestañas
 * abiertas el socket de Docker pasa a ser el cuello de botella y el panel se
 * mueve a tirones.
 *
 * Aquí se muestrea UNA vez y todos leen de la misma foto. El muestreo es bajo
 * demanda —no hay temporizador de fondo—: quien necesita datos dice cuánta
 * antigüedad tolera, y si la foto sirve se la lleva sin tocar Docker. Las
 * peticiones que coinciden mientras hay un muestreo en marcha se enganchan a
 * él en vez de lanzar otro, así que da igual cuántas pestañas haya abiertas.
 */

import { listProjects, listServices } from '../db';
import { dockerAvailable } from './client';
import { configuredReplicas, getRuntime, getStats, replicaName } from './containers';
import { ContainerState, ProjectRow, ServiceRow, ServiceRuntime, ServiceStats } from '../types';

/**
 * Contenedores consultados a la vez. El socket de Docker atiende en serie por
 * dentro, así que subirlo no acelera; lo que hace es evitar que un servidor con
 * muchos servicios encole cientos de peticiones simultáneas.
 */
const CONCURRENCY = 8;

/**
 * Tope por llamada a Docker. El cliente se construye sin `timeout` y dockerode
 * no impone ninguno: una petición al socket que no vuelve, no vuelve nunca. Con
 * un muestreador compartido eso ya no afecta solo a quien preguntó —dejaría el
 * muestreo colgado y con él todo el panel—, así que aquí se corta.
 */
const CALL_TIMEOUT_MS = 8000;

/**
 * Tope del muestreo entero, por si se cuelga algo que no sea una llamada a
 * Docker. Es la red de seguridad que garantiza que `inflight` siempre se
 * suelta: sin ella, un único cuelgue dejaría a todos los consumidores
 * posteriores esperando para siempre y solo un reinicio lo arreglaría.
 */
const COLLECT_TIMEOUT_MS = 20_000;

/**
 * Espera con tope, sin rechazar nunca: al vencer el plazo —o si el trabajo
 * falla— se resuelve con lo que diga `onFail`. Quien muestrea prefiere un hueco
 * en la foto antes que quedarse esperando.
 */
function withTimeout<T>(work: Promise<T>, ms: number, onFail: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    function finish(value: T): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }
    const timer = setTimeout(() => finish(onFail()), ms);
    // El reloj no debe mantener vivo el proceso mientras se apaga.
    timer.unref();
    work.then(finish, () => finish(onFail()));
  });
}

export interface ReplicaSample {
  /** Índice 1..n de la réplica (el monitor lleva su seguimiento por índice). */
  index: number;
  name: string;
  runtime: ServiceRuntime;
  /** null si el contenedor no corre o Docker no dio estadísticas. */
  stats: ServiceStats | null;
  /**
   * true si Docker no pudo decir nada de esta réplica (error de socket, no que
   * el contenedor no exista). El monitor la salta en vez de interpretar el
   * silencio como un cambio de estado y disparar una alerta falsa.
   */
  unreachable: boolean;
}

export interface ServiceSample {
  serviceId: string;
  /** Estado del servicio en conjunto (ver `rollUpState`). */
  state: ContainerState;
  replicas: { running: number; total: number };
  /** Consumo agregado de las réplicas vivas; null si ninguna dio datos. */
  stats: ServiceStats | null;
  perReplica: ReplicaSample[];
}

export interface Snapshot {
  /** Instante del muestreo. */
  at: number;
  /** false = el daemon no respondía; el resto viene vacío. */
  docker: boolean;
  byService: Map<string, ServiceSample>;
}

const EMPTY_RUNTIME: ServiceRuntime = {
  state: 'not_created',
  startedAt: null,
  exitCode: null,
  restartCount: 0,
  image: null,
};

let cache: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;
/**
 * Se incrementa en cada invalidación. Un muestreo que arrancó antes de que se
 * tocaran los contenedores puede terminar después: sin este contador guardaría
 * en caché una foto ya caduca y el panel enseñaría el estado viejo unos
 * segundos más.
 */
let epoch = 0;

/**
 * Estado del servicio a partir del de sus réplicas: corre si TODAS corren; si
 * solo algunas, manda el de la primera, que es la que el panel enseña.
 */
function rollUpState(perReplica: ReplicaSample[], total: number): ContainerState {
  const running = perReplica.filter((r) => r.runtime.state === 'running').length;
  if (total > 0 && running === total) return 'running';
  return perReplica[0]?.runtime.state ?? 'not_created';
}

/** Ejecuta las tareas con un tope de concurrencia, conservando el orden. */
async function pooled<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      out[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return out;
}

async function sampleService(project: ProjectRow, service: ServiceRow): Promise<ServiceSample> {
  const total = configuredReplicas(service);
  const perReplica = await pooled(
    Array.from({ length: total }, (_, i) => async (): Promise<ReplicaSample> => {
      const name = replicaName(project, service, i + 1);
      const runtime = await withTimeout<ServiceRuntime | null>(getRuntime(name), CALL_TIMEOUT_MS, () => null);
      if (!runtime) {
        return { index: i + 1, name, runtime: { ...EMPTY_RUNTIME, state: 'unknown' }, stats: null, unreachable: true };
      }
      // `stats` solo tiene sentido —y solo cuesta— si el contenedor corre. Que
      // no conteste no invalida la réplica: se sabe su estado, falta el consumo.
      const stats =
        runtime.state === 'running' ? await withTimeout(getStats(name), CALL_TIMEOUT_MS, () => null) : null;
      return { index: i + 1, name, runtime, stats, unreachable: false };
    }),
    CONCURRENCY,
  );

  let aggregated: ServiceStats | null = null;
  for (const r of perReplica) {
    if (!r.stats) continue;
    if (!aggregated) aggregated = { cpuPercent: 0, memUsage: 0, memLimit: 0, netRx: 0, netTx: 0 };
    aggregated.cpuPercent = Math.round((aggregated.cpuPercent + r.stats.cpuPercent) * 10) / 10;
    aggregated.memUsage += r.stats.memUsage;
    // El límite se suma por réplica: si no, el % de RAM agregado superaría el
    // 100 % con el servicio perfectamente sano.
    aggregated.memLimit += r.stats.memLimit;
    aggregated.netRx += r.stats.netRx;
    aggregated.netTx += r.stats.netTx;
  }

  return {
    serviceId: service.id,
    state: rollUpState(perReplica, total),
    replicas: { running: perReplica.filter((r) => r.runtime.state === 'running').length, total },
    stats: aggregated,
    perReplica,
  };
}

async function collect(): Promise<Snapshot> {
  // Sellado al ARRANCAR, no al terminar. Un muestreo tarda lo suyo (`stats` va
  // cerca del segundo por contenedor); fechándolo al final se serviría como
  // recién hecho y el ciclo siguiente reutilizaría la misma foto en vez de
  // pedir datos nuevos, con lo que el refresco real sería el doble del pedido.
  const at = Date.now();
  // El ping también lleva tope: es una llamada al mismo socket y colgada ahí
  // dejaría el muestreo esperando al plazo largo en vez de rendirse pronto.
  if (!(await withTimeout(dockerAvailable(), CALL_TIMEOUT_MS, () => false))) {
    return { at, docker: false, byService: new Map() };
  }
  const targets: { project: ProjectRow; service: ServiceRow }[] = [];
  for (const project of listProjects()) {
    for (const service of listServices(project.id)) targets.push({ project, service });
  }
  const results = await pooled(
    targets.map((t) => () => sampleService(t.project, t.service)),
    CONCURRENCY,
  );
  const byService = new Map<string, ServiceSample>();
  for (const sample of results) byService.set(sample.serviceId, sample);
  return { at, docker: true, byService };
}

/**
 * Foto del estado de Docker con como mucho `maxAgeMs` de antigüedad. Si la que
 * hay sirve, se devuelve tal cual; si no, se muestrea —y quien llegue mientras
 * tanto se engancha al mismo muestreo en vez de lanzar otro—.
 */
export async function dockerSnapshot(maxAgeMs: number): Promise<Snapshot> {
  if (cache && Date.now() - cache.at <= maxAgeMs) return cache;
  if (!inflight) {
    const startedAt = epoch;
    const at = Date.now();
    inflight = withTimeout<Snapshot>(collect(), COLLECT_TIMEOUT_MS, () => ({
      at,
      docker: false,
      byService: new Map(),
    }))
      .then((snap) => {
        // Quien pidió la foto se la lleva igual —es lo más fresco que hay—,
        // pero no se guarda si por el medio alguien invalidó. Tampoco se guarda
        // una foto sin datos: no informa de nada y, cacheada, taparía la
        // recuperación de Docker durante toda su ventana de validez.
        if (epoch === startedAt && snap.docker) cache = snap;
        return snap;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Estado de un servicio dentro de una foto ya obtenida. */
export function sampleIn(snap: Snapshot, serviceId: string): ServiceSample {
  return (
    snap.byService.get(serviceId) ?? {
      serviceId,
      // Sin Docker no se sabe nada; con Docker, que no esté en la foto
      // significa que el contenedor no existe.
      state: snap.docker ? 'not_created' : 'unknown',
      replicas: { running: 0, total: 0 },
      stats: null,
      perReplica: [],
    }
  );
}

/**
 * Runtime de la primera réplica dentro de una foto ya obtenida: lo que enseñan
 * las fichas de servicio. Quien pinta varios servicios debe pedir la foto una
 * vez y usar esto, para que todos cuenten lo mismo y el indicador de «Docker
 * disponible» de la respuesta case con los estados que la acompañan.
 */
export function runtimeIn(snap: Snapshot, serviceId: string): ServiceRuntime {
  const sample = sampleIn(snap, serviceId);
  return sample.perReplica[0]?.runtime ?? { ...EMPTY_RUNTIME, state: sample.state };
}

/** Estado de un servicio concreto (o el vacío si Docker no lo conoce). */
export async function serviceSample(serviceId: string, maxAgeMs: number): Promise<ServiceSample> {
  return sampleIn(await dockerSnapshot(maxAgeMs), serviceId);
}

/** Runtime de la primera réplica: lo que enseñan las fichas de servicio. */
export async function sampledRuntime(serviceId: string, maxAgeMs: number): Promise<ServiceRuntime> {
  return runtimeIn(await dockerSnapshot(maxAgeMs), serviceId);
}

/**
 * Descarta la foto. La llaman las acciones que cambian contenedores (desplegar,
 * arrancar, parar) para que el panel refleje el cambio en la lectura siguiente
 * en vez de enseñar el estado viejo hasta que caduque.
 */
export function invalidateDockerSnapshot(): void {
  cache = null;
  epoch += 1;
}
