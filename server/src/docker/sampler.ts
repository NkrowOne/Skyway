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

import { getProject, getService, listProjects, listServices } from '../db';
import { dockerAvailable } from './client';
import { configuredReplicas, getRuntime, getStats, replicaName } from './containers';
import { ContainerState, ProjectRow, ServiceRow, ServiceRuntime, ServiceStats } from '../types';

/**
 * Contenedores consultados a la vez, en TODO el muestreo. El socket de Docker
 * atiende en serie por dentro, así que subirlo no acelera; lo que hace es
 * evitar que un servidor con muchos servicios encole cientos de peticiones
 * simultáneas.
 */
const CONCURRENCY = 8;

/**
 * Tope por llamada a Docker. Aunque el cliente de consultas ya corta a los
 * 30 s, con un muestreador compartido una llamada colgada no afecta solo a
 * quien preguntó —dejaría el muestreo esperando y con él todo el panel—, así
 * que aquí se rinde antes y se deja un hueco en la foto.
 */
const CALL_TIMEOUT_MS = 8000;

/**
 * Tope de la ESPERA de un muestreo, por si se cuelga algo que no sea una
 * llamada a Docker. Es la red de seguridad que garantiza que quien espera no
 * se queda esperando para siempre. El muestreo físico sigue por debajo hasta
 * terminar; ver `collectingLite`/`collectingFull`.
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
  /**
   * true si se pidió el consumo de cada contenedor. Una foto sin consumo sirve
   * a quien solo enseña estados, pero no al revés, así que hay que distinguir.
   */
  withStats: boolean;
}

const EMPTY_RUNTIME: ServiceRuntime = {
  state: 'not_created',
  startedAt: null,
  exitCode: null,
  restartCount: 0,
  image: null,
};

/**
 * Dos cachés en vez de una. Una foto con consumo sirve para todo, pero una sin
 * consumo no sirve a quien lo necesita; guardarlas juntas obligaba a elegir
 * entre pisar el consumo bueno o dejar los estados viejos. Separadas, cada
 * consumidor lee la más reciente que le vale.
 */
let cacheLite: Snapshot | null = null;
let cacheFull: Snapshot | null = null;
/**
 * Espera en marcha por tipo: lo que ven los consumidores. El barato NO se
 * engancha al caro: esperar al consumo de todo el servidor para pintar cuatro
 * estados es justo lo que hacía lento el panel, y repetir los `inspect`
 * cuesta unas decenas de milisegundos.
 */
let inflightLite: Promise<Snapshot> | null = null;
let inflightFull: Promise<Snapshot> | null = null;
/**
 * Muestreo FÍSICO en marcha por tipo: la llamada real a Docker. Es distinto
 * de la espera de arriba porque esta puede agotar su plazo y resolverse
 * mientras el muestreo sigue vivo por debajo. Sin esta bandera, el tick
 * siguiente arrancaba otro muestreo encima del que aún no había terminado, y
 * otro, hasta ahogar el socket justo cuando ya iba lento.
 */
let collectingLite: Promise<Snapshot> | null = null;
let collectingFull: Promise<Snapshot> | null = null;
/**
 * Se incrementa en cada invalidación. Un muestreo que arrancó antes de que se
 * tocaran los contenedores puede terminar después: sin este contador guardaría
 * en caché una foto ya caduca y el panel enseñaría el estado viejo unos
 * segundos más.
 */
let epoch = 0;
/**
 * Servicios cuya entrada en la foto ya no vale (se acaban de desplegar): se
 * vuelven a mirar en la lectura siguiente y se parchean en las fotos que
 * haya, sin tirar el resto ni obligar a nadie a esperar un muestreo entero.
 */
const pending = new Set<string>();
let repairing: Promise<void> | null = null;

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

/** Estado (y, si se pide, consumo) de UNA réplica. */
async function sampleReplica(
  project: ProjectRow,
  service: ServiceRow,
  index: number,
  withStats: boolean,
): Promise<ReplicaSample> {
  const name = replicaName(project, service, index);
  const runtime = await withTimeout<ServiceRuntime | null>(getRuntime(name), CALL_TIMEOUT_MS, () => null);
  if (!runtime) {
    return { index, name, runtime: { ...EMPTY_RUNTIME, state: 'unknown' }, stats: null, unreachable: true };
  }
  // `stats` solo tiene sentido —y solo cuesta— si el contenedor corre, y
  // solo se pide si alguien lo va a mirar: es la parte cara con diferencia.
  // Que no conteste no invalida la réplica: se sabe su estado, falta el
  // consumo.
  const stats =
    withStats && runtime.state === 'running' ? await withTimeout(getStats(name), CALL_TIMEOUT_MS, () => null) : null;
  return { index, name, runtime, stats, unreachable: false };
}

/** Muestra del servicio a partir de las de sus réplicas. */
function assemble(serviceId: string, total: number, perReplica: ReplicaSample[]): ServiceSample {
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
    serviceId,
    state: rollUpState(perReplica, total),
    replicas: { running: perReplica.filter((r) => r.runtime.state === 'running').length, total },
    stats: aggregated,
    perReplica,
  };
}

/** Muestra completa de un solo servicio (para parchear una foto existente). */
async function sampleService(project: ProjectRow, service: ServiceRow, withStats: boolean): Promise<ServiceSample> {
  const total = configuredReplicas(service);
  const perReplica = await pooled(
    Array.from({ length: total }, (_, i) => () => sampleReplica(project, service, i + 1, withStats)),
    CONCURRENCY,
  );
  return assemble(service.id, total, perReplica);
}

async function collect(withStats: boolean): Promise<Snapshot> {
  // Sellado al ARRANCAR, no al terminar. Un muestreo tarda lo suyo (`stats` va
  // cerca del segundo por contenedor); fechándolo al final se serviría como
  // recién hecho y el ciclo siguiente reutilizaría la misma foto en vez de
  // pedir datos nuevos, con lo que el refresco real sería el doble del pedido.
  const at = Date.now();
  // El ping también lleva tope: es una llamada al mismo socket y colgada ahí
  // dejaría el muestreo esperando al plazo largo en vez de rendirse pronto.
  if (!(await withTimeout(dockerAvailable(), CALL_TIMEOUT_MS, () => false))) {
    return { at, docker: false, byService: new Map(), withStats };
  }
  // Tareas planas (servicio, réplica) bajo UN solo límite. Antes había un pool
  // por servicio DENTRO del pool de servicios: 8×8 = 64 llamadas simultáneas
  // al socket, justo lo que el límite quería evitar.
  const targets: { project: ProjectRow; service: ServiceRow; total: number }[] = [];
  const tasks: (() => Promise<ReplicaSample>)[] = [];
  const owner: number[] = [];
  for (const project of listProjects()) {
    for (const service of listServices(project.id)) {
      const total = configuredReplicas(service);
      const t = targets.push({ project, service, total }) - 1;
      for (let i = 1; i <= total; i++) {
        tasks.push(() => sampleReplica(project, service, i, withStats));
        owner.push(t);
      }
    }
  }
  const samples = await pooled(tasks, CONCURRENCY);
  const grouped = targets.map(() => [] as ReplicaSample[]);
  samples.forEach((sample, i) => grouped[owner[i]].push(sample));
  const byService = new Map<string, ServiceSample>();
  targets.forEach((t, i) => byService.set(t.service.id, assemble(t.service.id, t.total, grouped[i])));
  return { at, docker: true, byService, withStats };
}

/** Guarda una foto si nadie invalidó mientras se hacía y trae datos. */
function store(snap: Snapshot, startedAt: number): void {
  // No se guarda si por el medio alguien invalidó, ni si no hay datos: una
  // foto vacía cacheada taparía la recuperación de Docker toda su ventana.
  // La comparación por fecha evita que un muestreo que empezó antes y
  // terminó después deje una foto más vieja que la que ya había.
  if (epoch !== startedAt || !snap.docker) return;
  if (!cacheLite || snap.at >= cacheLite.at) cacheLite = snap;
  if (snap.withStats && (!cacheFull || snap.at >= cacheFull.at)) cacheFull = snap;
}

/** Lanza el muestreo físico de su tipo (uno como mucho por tipo). */
function startCollect(withStats: boolean): Promise<Snapshot> {
  const startedAt = epoch;
  const work = collect(withStats)
    .then((snap) => {
      store(snap, startedAt);
      return snap;
    })
    .finally(() => {
      if (withStats) {
        if (collectingFull === work) collectingFull = null;
      } else if (collectingLite === work) {
        collectingLite = null;
      }
    });
  if (withStats) collectingFull = work;
  else collectingLite = work;
  return work;
}

/** Espera (con plazo) al muestreo de su tipo, o al que ya esté en marcha. */
function refresh(withStats: boolean): Promise<Snapshot> {
  const running = withStats ? inflightFull : inflightLite;
  if (running) return running;

  const at = Date.now();
  // Si el muestreo físico anterior sigue vivo (su espera agotó el plazo pero
  // Docker aún no ha contestado), no se apila otro encima: se espera a ese.
  const physical = (withStats ? collectingFull : collectingLite) ?? startCollect(withStats);
  const work = withTimeout<Snapshot>(physical, COLLECT_TIMEOUT_MS, () => {
    // Plazo agotado con el muestreo aún en marcha: mejor la foto que hay,
    // aunque esté pasada, que declarar Docker caído durante un muestreo lento.
    const stale = withStats ? cacheFull : cacheLite;
    return stale ?? { at, docker: false, byService: new Map(), withStats };
  }).finally(() => {
    if (withStats) {
      if (inflightFull === work) inflightFull = null;
    } else if (inflightLite === work) {
      inflightLite = null;
    }
  });

  if (withStats) inflightFull = work;
  else inflightLite = work;
  return work;
}

/**
 * Vuelve a mirar los servicios pendientes y parchea su entrada en las fotos
 * que haya. Varias lecturas a la vez comparten la misma reparación.
 */
function repairPending(): Promise<void> {
  if (repairing) return repairing;
  const ids = [...pending];
  pending.clear();
  repairing = (async () => {
    // Sin foto no hay nada que parchear: el muestreo siguiente ya trae el
    // estado nuevo.
    if (!cacheLite && !cacheFull) return;
    const withStats = !!cacheFull;
    await Promise.all(
      ids.map(async (id) => {
        const service = getService(id);
        const project = service ? getProject(service.project_id) : undefined;
        if (!service || !project) {
          cacheLite?.byService.delete(id);
          cacheFull?.byService.delete(id);
          return;
        }
        const sample = await withTimeout<ServiceSample | null>(
          sampleService(project, service, withStats),
          CALL_TIMEOUT_MS * 2,
          () => null,
        );
        // Sin respuesta se queda la entrada anterior: peor sería inventar una.
        if (!sample) return;
        cacheLite?.byService.set(id, sample);
        cacheFull?.byService.set(id, sample);
      }),
    );
  })().finally(() => {
    repairing = null;
  });
  return repairing;
}

/**
 * Foto del estado de Docker con como mucho `maxAgeMs` de antigüedad.
 *
 * `stats: true` la pide con el consumo de cada contenedor. Es opcional porque
 * es la parte cara con diferencia —cerca de un segundo por contenedor, frente a
 * unas decenas de milisegundos del `inspect`— y casi nadie la mira: solo el
 * stream de métricas, la vista de Monitor y el vigilante de fondo. Las fichas
 * de proyecto y servicio, Sitios y la página de estado solo enseñan estados, y
 * hacerlas esperar al consumo de TODO el servidor las volvía lentísimas.
 *
 * Si la foto que hay está pasada pero sirve, se devuelve igual y el muestreo se
 * lanza por detrás: el panel responde al instante y la lectura siguiente ya
 * trae lo nuevo. Solo se espera cuando no hay nada que enseñar todavía —el
 * arranque en frío— o justo después de una acción que invalidó la foto, que es
 * cuando el usuario sí quiere el estado recién mirado. `wait: true` espera
 * siempre a una foto que cumpla la antigüedad: lo pide quien prefiere datos
 * nuevos a responder ya (el stream de métricas, que tiene su propio ritmo).
 */
export async function dockerSnapshot(maxAgeMs: number, opts: { stats?: boolean; wait?: boolean } = {}): Promise<Snapshot> {
  const needStats = opts.stats === true;
  if (pending.size > 0) await repairPending();
  const usable = needStats ? cacheFull : cacheLite;
  if (usable && Date.now() - usable.at <= maxAgeMs) return usable;
  if (usable) {
    if (opts.wait) return refresh(needStats);
    // Pasada pero servible: se entrega ya y se mira de nuevo por detrás.
    void refresh(needStats).catch(() => undefined);
    return usable;
  }
  return refresh(needStats);
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

/** Runtime de la primera réplica: lo que enseñan las fichas de servicio. */
export async function sampledRuntime(serviceId: string, maxAgeMs: number): Promise<ServiceRuntime> {
  return runtimeIn(await dockerSnapshot(maxAgeMs), serviceId);
}

/**
 * Descarta la foto. La llaman las acciones que cambian contenedores (desplegar,
 * arrancar, parar) para que el panel refleje el cambio en la lectura siguiente
 * en vez de enseñar el estado viejo hasta que caduque.
 *
 * Con `serviceId` solo se invalida ESE servicio: se vuelve a mirar en la
 * lectura siguiente y se parchea en la foto, y el resto del panel no tiene
 * que esperar a un muestreo completo del servidor por un despliegue. Un
 * muestreo que ya estuviera en marcha no se guarda (podría traer el estado
 * anterior al cambio).
 */
export function invalidateDockerSnapshot(serviceId?: string): void {
  epoch += 1;
  if (serviceId) {
    pending.add(serviceId);
    return;
  }
  cacheLite = null;
  cacheFull = null;
}
