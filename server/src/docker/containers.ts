import Docker from 'dockerode';
import { PassThrough } from 'stream';
import { StringDecoder } from 'string_decoder';
import { docker, dockerQuery } from './client';
import { baselineFrom, CpuBaseline, cpuPercentFromBaseline, cpuPercentFromDocker, DockerStatsSample } from './cpu';
import { countStrictlyBefore } from './logcursor';
import { EDGE_NETWORK, projectNetworkName } from './networks';
import { getSetting } from '../db';
import { ContainerState, ProjectRow, ServiceRow, ServiceRuntime, ServiceStats } from '../types';
import { lineSplitter } from '../util';

export function containerName(project: ProjectRow, service: ServiceRow): string {
  return `skyway-${project.slug}-${service.slug}`;
}

/** Nombre del contenedor de la réplica i (la 1 conserva el nombre canónico). */
export function replicaName(project: ProjectRow, service: ServiceRow, index: number): string {
  const base = containerName(project, service);
  return index <= 1 ? base : `${base}-r${index}`;
}

export function configuredReplicas(service: ServiceRow): number {
  if (service.type === 'database') return 1;
  const n = (service.config as any).replicas;
  return Number.isInteger(n) && n > 1 ? Math.min(n, 10) : 1;
}

/**
 * Estado agregado de un servicio a partir de los estados de sus réplicas,
 * con una única semántica para todo el panel: si ALGUNA réplica corre, el
 * servicio sirve tráfico ('running' — el badge de réplicas ya marca las
 * caídas); si ninguna corre, gana el estado más informativo.
 */
export function aggregateReplicaState(states: ContainerState[]): ContainerState {
  if (states.length === 0) return 'unknown';
  const has = (s: ContainerState) => states.includes(s);
  if (has('running')) return 'running';
  for (const s of ['restarting', 'exited', 'dead', 'paused', 'removing', 'created'] as ContainerState[]) {
    if (has(s)) return s;
  }
  if (states.every((s) => s === 'not_created')) return 'not_created';
  return has('unknown') ? 'unknown' : states[0];
}

/** Todos los contenedores del servicio por label (incluye réplicas y restos de swaps). */
export async function listServiceContainers(serviceId: string): Promise<{ id: string; name: string }[]> {
  const list = await dockerQuery.listContainers({
    all: true,
    filters: { label: [`skyway.service=${serviceId}`] } as any,
  });
  return list.map((c) => ({ id: c.Id, name: (c.Names?.[0] || c.Id).replace(/^\//, '') }));
}

export function volumeName(project: ProjectRow, service: ServiceRow, suffix = 'data'): string {
  return `skyway-${project.slug}-${service.slug}-${suffix}`;
}

export async function findContainer(name: string): Promise<Docker.ContainerInspectInfo | null> {
  try {
    return await dockerQuery.getContainer(name).inspect();
  } catch {
    return null;
  }
}

export async function getRuntime(name: string): Promise<ServiceRuntime> {
  const info = await findContainer(name);
  if (!info) {
    return { state: 'not_created', startedAt: null, exitCode: null, restartCount: 0, image: null };
  }
  const st = info.State;
  return {
    state: (st.Status as ServiceRuntime['state']) || 'unknown',
    startedAt: st.Running ? st.StartedAt : null,
    exitCode: st.Running ? null : st.ExitCode,
    restartCount: info.RestartCount || 0,
    image: info.Config?.Image || null,
  };
}

export async function stopContainer(name: string): Promise<void> {
  const c = docker.getContainer(name);
  try {
    await c.stop({ t: 10 });
  } catch (err: any) {
    if (err?.statusCode !== 304 && err?.statusCode !== 404) throw err;
  }
}

export async function startContainer(name: string): Promise<void> {
  try {
    await docker.getContainer(name).start();
  } catch (err: any) {
    if (err?.statusCode !== 304) throw err;
  }
}

export async function restartContainer(name: string): Promise<void> {
  await docker.getContainer(name).restart({ t: 10 });
}

export async function removeContainer(name: string): Promise<void> {
  try {
    await docker.getContainer(name).remove({ force: true, v: false });
  } catch (err: any) {
    if (err?.statusCode !== 404) throw err;
  }
}

export async function removeVolume(name: string): Promise<void> {
  try {
    await docker.getVolume(name).remove({ force: true });
  } catch {
    // best-effort
  }
}

/**
 * Quita una etiqueta de imagen. SIN `force`: con él Docker desetiqueta aunque
 * un contenedor la esté usando, y la purga de imágenes antiguas podía dejar al
 * servicio en marcha con una imagen sin nombre (y sin rollback posible). El
 * conflicto se deja por escrito en vez de tragárselo.
 */
export async function removeImage(tag: string, log?: (line: string) => void): Promise<void> {
  try {
    await dockerQuery.getImage(tag).remove();
  } catch (err: any) {
    if (err?.statusCode === 409) {
      log?.(`⚠ La imagen ${tag} está en uso por un contenedor: no se purga.`);
    }
    // 404 (ya no existe) y demás: best-effort
  }
}

/**
 * Referencia de imagen tal y como la admite Docker (registro, ruta, etiqueta
 * o digest). Rechaza cualquier cosa que empiece por «-»: puesta como
 * posicional de la CLI la tomaría por una opción.
 */
const IMAGE_REF = /^[a-z0-9][a-z0-9._\-/:@]*$/i;

export function assertImageRef(image: string): string {
  if (!IMAGE_REF.test(image)) {
    throw new Error(`Referencia de imagen no válida: «${image.slice(0, 80)}»`);
  }
  return image;
}

/**
 * Cómo pasarle un comando de arranque a una imagen, según su ENTRYPOINT.
 *
 * Nixpacks construye con `ENTRYPOINT ["/bin/bash","-l","-c"]` y deja el comando
 * en el CMD. Si ahí se mete un `['sh','-c','...']`, `bash -l -c` toma el PRIMER
 * argumento como el programa a ejecutar y los demás pasan a ser `$0` y `$1`:
 * arranca un `sh` pelado que lee EOF de una entrada vacía y **sale con 0 sin
 * escribir una línea**. El despliegue falla sin dejar rastro de por qué, y la
 * imagen construida con Dockerfile —que no lleva entrypoint— funcionaba.
 *
 * Con un entrypoint que ya es un shell, el comando va tal cual como CMD, que es
 * lo que hacen Nixpacks y Railway. Con uno que no lo es, se aparta: quien fija
 * un comando de arranque quiere ESE comando, no el envoltorio de la imagen.
 */
export async function startCommandSpec(
  image: string,
  startCmd: string,
): Promise<{ cmd: string[]; entrypoint?: string[]; replacedEntrypoint: string[] | null }> {
  let entry: string[] = [];
  try {
    const info = await dockerQuery.getImage(image).inspect();
    entry = (info.Config?.Entrypoint as string[] | null) || [];
  } catch {
    /* imagen no inspeccionable: se envuelve en un shell, como siempre */
  }
  if (entry.length === 0) return { cmd: ['sh', '-c', startCmd], replacedEntrypoint: null };
  if (isShellEntrypoint(entry)) return { cmd: [startCmd], replacedEntrypoint: null };
  return { cmd: ['sh', '-c', startCmd], entrypoint: [], replacedEntrypoint: entry };
}

/**
 * Lo mismo, en forma de argumentos de `docker run`: todo lo que va a partir de
 * las opciones. Lo usa quien lanza un contenedor efímero con la imagen del
 * usuario —el comando previo al despliegue, sin ir más lejos—, que tropezaba
 * con el mismo entrypoint y, peor, se daba por bueno: la migración no corría y
 * el despliegue seguía como si hubiera ido bien.
 */
export async function runArgsFor(image: string, command: string): Promise<string[]> {
  assertImageRef(image);
  const spec = await startCommandSpec(image, command);
  // entrypoint definido = hay que apartarlo, y en la CLI eso es --entrypoint.
  // El «--» cierra las opciones: a partir de ahí todo es posicional, venga
  // como venga escrito el nombre de la imagen. Quien llama pone esto al final.
  return spec.entrypoint ? ['--entrypoint', 'sh', '--', image, ...spec.cmd.slice(1)] : ['--', image, ...spec.cmd];
}

/** `["/bin/bash","-l","-c"]`, `["/bin/sh","-c"]`… es decir: ya envuelve un comando. */
function isShellEntrypoint(entry: string[]): boolean {
  if (entry[entry.length - 1] !== '-c') return false;
  const bin = (entry[0] || '').split('/').pop() || '';
  return ['sh', 'bash', 'ash', 'dash', 'zsh', 'busybox'].includes(bin);
}

/**
 * Puertos TCP que la imagen declara con EXPOSE: los suyos y los que hereda de
 * su imagen base, de menor a mayor.
 *
 * Es una PISTA, no una verdad. EXPOSE es documentación —Docker no comprueba que
 * haya nadie escuchando ahí— y se hereda: un multi-stage que acaba en
 * `FROM nginx` arrastra su 80 aunque la aplicación sirva en otro sitio, y una
 * imagen de Nixpacks normalmente no expone nada. Por eso esto solo devuelve el
 * dato y decide quien lo pide; jamás se le cambia el puerto por su cuenta a un
 * servicio que ya despliega bien.
 */
export async function imageExposedPorts(image: string): Promise<number[]> {
  try {
    const info = await dockerQuery.getImage(image).inspect();
    const expuestos = (info.Config?.ExposedPorts || {}) as Record<string, unknown>;
    return Object.keys(expuestos)
      .filter((clave) => !clave.endsWith('/udp'))
      .map((clave) => Number(clave.split('/')[0]))
      .filter((p) => Number.isInteger(p) && p > 0 && p < 65536)
      .sort((a, b) => a - b);
  } catch {
    // Imagen no inspeccionable: sin pista, se sigue con el puerto configurado.
    return [];
  }
}

export async function imageExists(tag: string): Promise<boolean> {
  try {
    await dockerQuery.getImage(tag).inspect();
    return true;
  } catch {
    return false;
  }
}

export function traefikLabels(
  project: ProjectRow,
  service: ServiceRow,
  domains: string[],
  port: number,
): Record<string, string> {
  const labels: Record<string, string> = {};
  if (domains.length === 0) return labels;
  const router = `skyway-${project.slug}-${service.slug}`;
  const rule = domains.map((d) => `Host(\`${d}\`)`).join(' || ');
  const tls = !!getSetting('letsencryptEmail');
  labels['traefik.enable'] = 'true';
  labels['traefik.docker.network'] = EDGE_NETWORK;
  // Router HTTP (puerto 80). Con TLS activo se añade un segundo router HTTPS:
  // un único router con tls=true rechazaría las conexiones en claro del puerto 80.
  labels[`traefik.http.routers.${router}.rule`] = rule;
  labels[`traefik.http.routers.${router}.entrypoints`] = 'web';
  if (tls) {
    labels[`traefik.http.routers.${router}-secure.rule`] = rule;
    labels[`traefik.http.routers.${router}-secure.entrypoints`] = 'websecure';
    labels[`traefik.http.routers.${router}-secure.tls.certresolver`] = 'le';
    // Con HTTPS disponible, el router de texto en claro deja de servir contenido
    // y solo redirige: si no, el puerto 80 seguiría entregando la web —y con
    // ella cookies de sesión o claves de API— sin cifrar, para siempre. El reto
    // HTTP-01 de Let's Encrypt no se ve afectado: Traefik lo atiende en un
    // router interno propio, con prioridad por encima de este.
    labels[`traefik.http.middlewares.${router}-https.redirectscheme.scheme`] = 'https';
    labels[`traefik.http.middlewares.${router}-https.redirectscheme.permanent`] = 'true';
    labels[`traefik.http.routers.${router}.middlewares`] = `${router}-https`;
  }
  labels[`traefik.http.services.${router}.loadbalancer.server.port`] = String(port);
  return labels;
}

export interface RunSpec {
  project: ProjectRow;
  service: ServiceRow;
  image: string;
  env: Record<string, string>;
  deploymentId: string;
  /** Puerto interno que escucha la app (para Traefik). */
  internalPort: number | null;
  domains: string[];
  hostPort?: number | null;
  cpus?: number | null;
  memoryMb?: number | null;
  cmd?: string[] | null;
  /** Solo si hay que APARTAR el de la imagen; `[]` lo anula. */
  entrypoint?: string[] | null;
  volumes?: { name: string; containerPath: string }[];
  /** Overrides para el contenedor de validación de los despliegues sin corte. */
  nameOverride?: string;
  aliasOverride?: string;
  withTraefik?: boolean;
  withHostPort?: boolean;
  withVolumes?: boolean;
  /**
   * 'no' para contenedores de validación: si mueren, queremos verlos muertos.
   * También admite la política completa de Docker, que es como se traslada el
   * `restartPolicyType` de la config-as-code de Railway.
   */
  restartPolicy?: 'unless-stopped' | 'no' | { Name: string; MaximumRetryCount?: number };
}

/** Crea y arranca el contenedor de un servicio (elimina el homónimo si existe). */
export async function runServiceContainer(spec: RunSpec): Promise<string> {
  const name = spec.nameOverride ?? containerName(spec.project, spec.service);
  const alias = spec.aliasOverride ?? spec.service.slug;
  const withTraefik = spec.withTraefik !== false;
  const withHostPort = spec.withHostPort !== false;
  const withVolumes = spec.withVolumes !== false;
  const netName = projectNetworkName(spec.project);

  await removeContainer(name);

  const labels: Record<string, string> = {
    'skyway.managed': 'true',
    'skyway.project': spec.project.id,
    'skyway.service': spec.service.id,
    'skyway.deployment': spec.deploymentId,
    ...(withTraefik && spec.internalPort
      ? traefikLabels(spec.project, spec.service, spec.domains, spec.internalPort)
      : {}),
  };

  const hostConfig: Docker.HostConfig = {
    RestartPolicy:
      typeof spec.restartPolicy === 'object'
        ? (spec.restartPolicy as Docker.HostConfig['RestartPolicy'])
        : { Name: spec.restartPolicy ?? 'unless-stopped' },
    Binds: withVolumes ? (spec.volumes || []).map((v) => `${v.name}:${v.containerPath}`) : [],
    // Rotación de logs: sin esto, el json-log de un contenedor parlanchín
    // crece sin límite y acaba llenando el disco del servidor.
    LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
  };
  if (spec.cpus && spec.cpus > 0) hostConfig.NanoCpus = Math.round(spec.cpus * 1e9);
  if (spec.memoryMb && spec.memoryMb > 0) hostConfig.Memory = Math.round(spec.memoryMb * 1024 * 1024);

  const exposed: Record<string, {}> = {};
  if (spec.internalPort) exposed[`${spec.internalPort}/tcp`] = {};
  if (withHostPort && spec.hostPort && spec.internalPort) {
    hostConfig.PortBindings = {
      [`${spec.internalPort}/tcp`]: [{ HostPort: String(spec.hostPort) }],
    };
  }

  const container = await docker.createContainer({
    name,
    Image: spec.image,
    Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
    Labels: labels,
    Cmd: spec.cmd || undefined,
    ...(spec.entrypoint ? { Entrypoint: spec.entrypoint } : {}),
    ExposedPorts: exposed,
    HostConfig: hostConfig,
    NetworkingConfig: {
      EndpointsConfig: {
        // El segundo alias es el nombre DNS privado de Railway: una app migrada
        // que lleve `postgres.railway.internal` escrito en una cadena de
        // conexión —o dentro del código, donde el importador no llega— resuelve
        // igual sin tocar nada. No cuesta nada tener los dos.
        [netName]: { Aliases: [alias, `${alias}.railway.internal`] },
      },
    },
  });

  if (withTraefik && spec.domains.length > 0) {
    try {
      await docker.getNetwork(EDGE_NETWORK).connect({ Container: container.id });
    } catch (err: any) {
      if (!String(err?.message || '').includes('already exists')) throw err;
    }
  }

  await container.start();
  return container.id;
}

export async function renameContainer(from: string, to: string): Promise<void> {
  await docker.getContainer(from).rename({ name: to });
}

export interface ExecResult {
  output: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

/** Ejecuta un comando dentro de un contenedor en marcha y captura su salida. */
export async function execInContainer(
  name: string,
  command: string,
  opts: { timeoutMs?: number; maxOutput?: number; env?: string[] } = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxOutput = opts.maxOutput ?? 200_000;
  const started = Date.now();
  const container = docker.getContainer(name);
  const exec = await container.exec({
    Cmd: ['sh', '-c', command],
    // Env extra del exec: permite pasar datos (p. ej. una consulta SQL) sin
    // interpolarlos en el shell, evitando cualquier problema de escapado.
    Env: opts.env && opts.env.length > 0 ? opts.env : undefined,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = (await exec.start({})) as NodeJS.ReadableStream;

  let output = '';
  let truncated = false;
  let timedOut = false;
  const out = new PassThrough();
  const err = new PassThrough();
  // Un decodificador por canal: un carácter UTF-8 partido entre dos trozos
  // salía como dos «�» con `chunk.toString()`.
  const decOut = new StringDecoder('utf8');
  const decErr = new StringDecoder('utf8');
  const feed = (text: string) => {
    if (output.length < maxOutput) {
      output += text;
      if (output.length >= maxOutput) truncated = true;
    }
  };
  out.on('data', (chunk: Buffer) => feed(decOut.write(chunk)));
  err.on('data', (chunk: Buffer) => feed(decErr.write(chunk)));
  out.on('error', noop);
  err.on('error', noop);
  docker.modem.demuxStream(stream, out, err);

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        (stream as any).destroy?.();
        out.destroy();
        err.destroy();
      } catch {
        /* noop */
      }
      resolve();
    }, timeoutMs);
    stream.on('end', () => {
      clearTimeout(timer);
      resolve();
    });
    stream.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  feed(decOut.end() + decErr.end());

  const exitCode = await waitExecExit(exec, { giveUp: () => timedOut });
  return { output, exitCode, truncated, timedOut, durationMs: Date.now() - started };
}

function noop(): void {
  /* nada */
}

/**
 * Código de salida de un exec cuyo stream ya terminó. El daemon puede tardar
 * unos ms en registrar la salida: mientras `ExitCode` sea null y el exec siga
 * marcado como `Running`, se reintenta brevemente para no confundir esa
 * carrera de timing con un fallo (o con un éxito). Devuelve null si no se
 * llegó a saber.
 */
export async function waitExecExit(
  exec: Docker.Exec,
  opts: { attempts?: number; delayMs?: number; giveUp?: () => boolean } = {},
): Promise<number | null> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 60;
  let exitCode: number | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const info = await exec.inspect();
      exitCode = info.ExitCode ?? null;
      if (exitCode !== null || info.Running === false) break;
    } catch {
      break;
    }
    if (opts.giveUp?.()) break;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return exitCode;
}

/** Actualiza límites de CPU/RAM de un contenedor en caliente. */
export async function updateResources(
  name: string,
  cpus: number | null | undefined,
  memoryMb: number | null | undefined,
): Promise<void> {
  const c = docker.getContainer(name);
  const memory = memoryMb && memoryMb > 0 ? Math.round(memoryMb * 1024 * 1024) : 0;
  const update: any = {
    NanoCpus: cpus && cpus > 0 ? Math.round(cpus * 1e9) : 0,
    Memory: memory,
    // Docker exige que el tope de swap no quede por debajo de la memoria nueva.
    // El doble es lo mismo que fija al crear el contenedor sin decir nada; con
    // -1 el swap quedaba SIN límite y el tope de RAM dejaba de acotar nada.
    MemorySwap: memory > 0 ? memory * 2 : 0,
  };
  await c.update(update);
}

/**
 * Última lectura de los contadores de CPU por contenedor (ver `docker/cpu.ts`).
 * Con ella `stats` se pide en modo `one-shot`, que contesta al instante, en vez
 * de esperar el segundo que tarda el daemon en tomar dos muestras: un muestreo
 * completo del servidor pasa de «un segundo por contenedor» a unas decenas de
 * milisegundos por contenedor.
 */
const cpuBaselines = new Map<string, CpuBaseline>();
/** Las líneas base de contenedores que dejan de muestrearse se olvidan pasado este tiempo. */
const BASELINE_TTL_MS = 10 * 60_000;
let lastBaselineSweep = 0;

function rememberBaseline(name: string, s: DockerStatsSample): void {
  const nowMs = Date.now();
  cpuBaselines.set(name, baselineFrom(s, nowMs));
  // Barrido esporádico: un servicio borrado no deja su entrada para siempre.
  if (nowMs - lastBaselineSweep < BASELINE_TTL_MS) return;
  lastBaselineSweep = nowMs;
  for (const [key, b] of cpuBaselines) if (nowMs - b.at > BASELINE_TTL_MS) cpuBaselines.delete(key);
}

export async function getStats(name: string): Promise<ServiceStats | null> {
  try {
    const c = dockerQuery.getContainer(name);
    let s = (await c.stats({ stream: false, 'one-shot': true })) as unknown as DockerStatsSample;
    let cpuPercent = cpuPercentFromBaseline(s, cpuBaselines.get(name));
    if (cpuPercent === null) {
      // Sin línea base que valga (primera lectura de este proceso, contenedor
      // recreado o contadores a cero): una lectura de dos muestras, que cuesta
      // ~1 s pero da ya un valor correcto. Solo pasa una vez por contenedor.
      s = (await c.stats({ stream: false })) as unknown as DockerStatsSample;
      cpuPercent = cpuPercentFromDocker(s);
    }
    rememberBaseline(name, s);
    let netRx = 0;
    let netTx = 0;
    for (const nw of Object.values(s.networks ?? {})) {
      netRx += nw.rx_bytes || 0;
      netTx += nw.tx_bytes || 0;
    }
    return {
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      memUsage: s.memory_stats?.usage || 0,
      memLimit: s.memory_stats?.limit || 0,
      netRx,
      netTx,
    };
  } catch {
    return null;
  }
}

/**
 * Separa un buffer de logs multiplexado de Docker (frames de 8 bytes de
 * cabecera) en texto plano. Si el contenedor corre con TTY el buffer ya es
 * texto crudo, y se devuelve tal cual.
 */
export function demuxLogBuffer(buf: Buffer): string {
  let out = '';
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const type = buf[offset];
    const zeros = buf[offset + 1] === 0 && buf[offset + 2] === 0 && buf[offset + 3] === 0;
    if ((type !== 0 && type !== 1 && type !== 2) || !zeros) {
      // Cabecera inválida: si es el primer frame, el contenedor corre con TTY
      // (texto crudo). Si ya había frames válidos, es basura tras un corte:
      // se conserva lo parseado y no se vuelca el buffer entero (duplicaría
      // el contenido con las cabeceras binarias incrustadas).
      return offset === 0 ? buf.toString('utf8') : out;
    }
    const size = buf.readUInt32BE(offset + 4);
    if (offset + 8 + size > buf.length) {
      // Frame truncado (conexión cortada a mitad): se añade el trozo legible.
      out += buf.slice(offset + 8).toString('utf8');
      return out;
    }
    out += buf.slice(offset + 8, offset + 8 + size).toString('utf8');
    offset += 8 + size;
  }
  // Resto menor que una cabecera: con frames previos se descarta; sin ellos
  // es un buffer TTY diminuto y se devuelve tal cual.
  return offset === 0 && buf.length > 0 ? buf.toString('utf8') : out;
}

/** Devuelve las últimas líneas de log de un contenedor (sin seguir el stream). */
export async function fetchLogsTail(
  name: string,
  tail = 400,
  timestamps = true,
): Promise<{ ts: number | null; line: string }[]> {
  const c = dockerQuery.getContainer(name);
  const raw = (await c.logs({ follow: false, stdout: true, stderr: true, tail, timestamps })) as unknown as Buffer;
  const text = Buffer.isBuffer(raw) ? demuxLogBuffer(raw) : String(raw);
  const out: { ts: number | null; line: string }[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;
    if (timestamps) {
      // Formato: 2024-05-01T12:00:00.000000000Z <línea>
      const idx = line.indexOf(' ');
      const ts = idx > 0 ? Date.parse(line.slice(0, idx)) : NaN;
      if (Number.isFinite(ts)) {
        out.push({ ts, line: line.slice(idx + 1) });
        continue;
      }
    }
    out.push({ ts: null, line });
  }
  return out;
}

/**
 * Separa el prefijo de tiempo que añade Docker con `timestamps: true`
 * (`2024-05-01T12:00:00.123456789Z <línea>`). El cursor RFC3339 es ordenable
 * lexicográficamente y con precisión de nanosegundos: sirve de identidad de la
 * línea para paginar hacia atrás (filtro `until`) y deduplicar en el cliente.
 */
export function splitTimestamp(raw: string): { cursor: string | null; line: string } {
  const idx = raw.indexOf(' ');
  // El sello de Docker ocupa ≥20 caracteres y lleva un guion en la 5ª posición
  // (año-mes). Comprobarlo evita confundir la 1ª palabra de un log sin sello.
  if (idx >= 20 && raw[4] === '-' && Number.isFinite(Date.parse(raw.slice(0, idx)))) {
    return { cursor: raw.slice(0, idx), line: raw.slice(idx + 1) };
  }
  return { cursor: null, line: raw };
}

/** Cursor RFC3339 → segundos Unix, para el filtro `until` de Docker. */
function cursorToUnixSeconds(cursor: string): number | null {
  const ms = Date.parse(cursor);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** Tope de líneas que se piden a Docker en una página hacia atrás. */
const MAX_PAGE_TAIL = 20_000;

/**
 * Paginación hacia atrás: como mucho `limit` líneas ESTRICTAMENTE anteriores
 * al cursor dado (o las últimas si no hay cursor), en orden cronológico y con
 * su cursor. Docker filtra `until` por segundos enteros, así que la página
 * cruda trae también las líneas del mismo segundo que el ancla, posteriores a
 * ella: se recortan aquí. Si tras recortar no llega a `limit` y Docker había
 * devuelto la página entera (hay más detrás), se vuelve a pedir con más cola,
 * hasta un tope. Antes se devolvía la página cruda: en un contenedor que
 * escribe cientos de líneas por segundo, la página entera caía dentro del
 * segundo del ancla, el cliente la descartaba y daba el historial por
 * terminado sin haber retrocedido una sola línea.
 *
 * `hasMore` dice si quedan líneas anteriores a las devueltas.
 */
export async function fetchLogsBefore(
  name: string,
  limit: number,
  before: string | null,
): Promise<{ lines: { cursor: string | null; line: string }[]; hasMore: boolean }> {
  const c = dockerQuery.getContainer(name);
  const secs = before ? cursorToUnixSeconds(before) : null;
  let want = Math.max(1, limit);
  for (;;) {
    // `until` (segundos Unix) no está en los tipos de dockerode pero sí en la API
    // de Docker; se fija `follow: false` como literal para elegir la sobrecarga.
    const opts: Docker.ContainerLogsOptions & { follow: false; until?: number } = {
      follow: false,
      stdout: true,
      stderr: true,
      timestamps: true,
      tail: want,
    };
    if (secs !== null) opts.until = secs + 1;
    const raw = (await c.logs(opts)) as unknown as Buffer;
    const text = Buffer.isBuffer(raw) ? demuxLogBuffer(raw) : String(raw);
    const all: { cursor: string | null; line: string }[] = [];
    for (const rawLine of text.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (line) all.push(splitTimestamp(line));
    }
    const usable = before ? countStrictlyBefore(all, before) : all.length;
    // Docker ha devuelto menos de lo pedido: ya no hay nada más antiguo.
    const exhausted = all.length < want;
    if (usable >= limit || exhausted || want >= MAX_PAGE_TAIL) {
      const from = Math.max(0, usable - limit);
      return { lines: all.slice(from, usable), hasMore: from > 0 || !exhausted };
    }
    want = Math.min(MAX_PAGE_TAIL, want * 4);
  }
}

/**
 * Texto completo del log de un contenedor (para la descarga íntegra). El buffer
 * está acotado por la rotación (`max-size`·`max-file`), así que cargarlo entero
 * es asumible. Con `timestamps` se antepone el sello de tiempo a cada línea.
 */
export async function fetchLogsText(
  name: string,
  tail: number | 'all' = 'all',
  timestamps = false,
): Promise<string> {
  const c = dockerQuery.getContainer(name);
  // `tail: 'all'` lo acepta la API de Docker aunque los tipos de dockerode solo
  // admitan number: se castea en esta frontera para pedir el buffer completo.
  const opts = { follow: false as const, stdout: true, stderr: true, tail, timestamps };
  const raw = (await c.logs(opts as unknown as Docker.ContainerLogsOptions & { follow: false })) as unknown as Buffer;
  return Buffer.isBuffer(raw) ? demuxLogBuffer(raw) : String(raw);
}

export interface FollowHandle {
  /** Corta el seguimiento y libera el stream de Docker. */
  stop: () => void;
  /**
   * Contrapresión: si quien consume (el socket del navegador) no da abasto,
   * se deja de leer de Docker en vez de acumular líneas en memoria.
   */
  pause: () => void;
  resume: () => void;
}

/**
 * Sigue los logs de un contenedor y entrega líneas completas con su cursor.
 * Devuelve un manejador para detener o pausar el stream. Se piden con
 * `timestamps` para que cada línea lleve cursor (el visor lo oculta) y así el
 * frente del buffer en vivo sirve de punto de partida para paginar hacia atrás.
 */
export async function followLogs(
  name: string,
  onLine: (row: { line: string; cursor: string | null }) => void,
  tail: number | 'all' = 200,
  /**
   * Se llama UNA vez cuando Docker cierra el stream por su cuenta: el
   * contenedor se ha eliminado (un redespliegue lo sustituye por otro con el
   * mismo nombre) o el daemon se ha reiniciado. Sin este aviso la ruta SSE
   * seguía abierta pero muda, y el visor decía «En vivo» sin recibir nada.
   */
  onEnd?: () => void,
  /**
   * Cursor (sello RFC3339 con nanosegundos) a partir del cual reanudar. Lo
   * envía el navegador al reconectar (Last-Event-ID): así una conexión que se
   * cae —el móvil que se bloquea, un cambio de red— retoma justo donde estaba
   * en vez de volver a las últimas 200 líneas y perder lo de en medio.
   */
  since?: string | null,
): Promise<FollowHandle> {
  const c = docker.getContainer(name);
  // `since` acepta un RFC3339Nano en la API de Docker aunque los tipos de
  // dockerode solo declaren number; `tail: 'all'` igual. Se castea en la frontera.
  const opts: Record<string, unknown> = { follow: true, stdout: true, stderr: true, timestamps: true };
  if (since) {
    opts.since = since;
    opts.tail = 'all';
  } else {
    opts.tail = tail;
  }
  const stream = (await c.logs(opts as unknown as Docker.ContainerLogsOptions & { follow: true })) as NodeJS.ReadableStream;

  const out = new PassThrough();
  const err = new PassThrough();
  // Un troceador POR canal: con uno compartido, un trozo de stderr que llegaba
  // a media línea de stdout se pegaba dentro de ella y salía una línea corrupta.
  const feedOut = lineSplitter((raw) => onLine(splitTimestamp(raw)));
  const feedErr = lineSplitter((raw) => onLine(splitTimestamp(raw)));
  out.on('data', feedOut);
  err.on('data', feedErr);
  // Destruir un PassThrough puede emitir 'error'; sin manejador sería una
  // excepción sin capturar que tumba el proceso entero.
  out.on('error', noop);
  err.on('error', noop);
  docker.modem.demuxStream(stream, out, err);

  let stopped = false;
  let ended = false;
  const finish = () => {
    if (stopped || ended) return;
    ended = true;
    feedOut.flush();
    feedErr.flush();
    onEnd?.();
  };
  stream.on('end', finish);
  stream.on('close', finish);
  stream.on('error', finish);

  const stop = () => {
    stopped = true;
    // Primero la fuente y después los PassThrough: al revés, el demuxer
    // seguía escribiendo en un destino destruido.
    try {
      (stream as any).destroy?.();
    } catch {
      /* noop */
    }
    try {
      out.destroy();
      err.destroy();
    } catch {
      /* noop */
    }
  };
  const pause = () => {
    try {
      (stream as any).pause?.();
    } catch {
      /* noop */
    }
  };
  const resume = () => {
    if (stopped) return;
    try {
      (stream as any).resume?.();
    } catch {
      /* noop */
    }
  };
  return { stop, pause, resume };
}

