import Docker from 'dockerode';
import { PassThrough } from 'stream';
import { docker } from './client';
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
  const list = await docker.listContainers({
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
    return await docker.getContainer(name).inspect();
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

export async function removeImage(tag: string): Promise<void> {
  try {
    await docker.getImage(tag).remove({ force: true });
  } catch {
    // best-effort: puede estar en uso o no existir
  }
}

export async function imageExists(tag: string): Promise<boolean> {
  try {
    await docker.getImage(tag).inspect();
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
  volumes?: { name: string; containerPath: string }[];
  /** Overrides para el contenedor de validación de los despliegues sin corte. */
  nameOverride?: string;
  aliasOverride?: string;
  withTraefik?: boolean;
  withHostPort?: boolean;
  withVolumes?: boolean;
  /** 'no' para contenedores de validación: si mueren, queremos verlos muertos. */
  restartPolicy?: 'unless-stopped' | 'no';
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
    RestartPolicy: { Name: spec.restartPolicy ?? 'unless-stopped' },
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
    ExposedPorts: exposed,
    HostConfig: hostConfig,
    NetworkingConfig: {
      EndpointsConfig: {
        [netName]: { Aliases: [alias] },
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
  const feed = (chunk: Buffer) => {
    if (output.length < maxOutput) {
      output += chunk.toString();
      if (output.length >= maxOutput) truncated = true;
    }
  };
  out.on('data', feed);
  err.on('data', feed);
  docker.modem.demuxStream(stream, out, err);

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        (stream as any).destroy?.();
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

  // El daemon puede tardar unos ms en registrar la salida del exec: si el
  // código aún es null (y no hubo timeout), se reintenta brevemente para no
  // confundir una carrera de timing con un fallo.
  let exitCode: number | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const info = await exec.inspect();
      exitCode = info.ExitCode ?? null;
      if (exitCode !== null || info.Running === false) break;
    } catch {
      break;
    }
    if (timedOut) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  return { output, exitCode, truncated, timedOut, durationMs: Date.now() - started };
}

/** Actualiza límites de CPU/RAM de un contenedor en caliente. */
export async function updateResources(
  name: string,
  cpus: number | null | undefined,
  memoryMb: number | null | undefined,
): Promise<void> {
  const c = docker.getContainer(name);
  const update: any = {
    NanoCpus: cpus && cpus > 0 ? Math.round(cpus * 1e9) : 0,
    Memory: memoryMb && memoryMb > 0 ? Math.round(memoryMb * 1024 * 1024) : 0,
    MemorySwap: memoryMb && memoryMb > 0 ? -1 : 0,
  };
  await c.update(update);
}

export async function getStats(name: string): Promise<ServiceStats | null> {
  try {
    const c = docker.getContainer(name);
    const s: any = await c.stats({ stream: false });
    const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage || 0) - (s.precpu_stats?.cpu_usage?.total_usage || 0);
    const sysDelta = (s.cpu_stats?.system_cpu_usage || 0) - (s.precpu_stats?.system_cpu_usage || 0);
    const onlineCpus = s.cpu_stats?.online_cpus || 1;
    const cpuPercent = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * onlineCpus * 100 : 0;
    let netRx = 0;
    let netTx = 0;
    for (const nw of Object.values(s.networks || {}) as any[]) {
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
  const c = docker.getContainer(name);
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

/**
 * Paginación hacia atrás: como mucho `limit` líneas ANTERIORES al cursor dado
 * (o las últimas si no hay cursor), en orden cronológico y con su cursor.
 * `until` se redondea al alza al segundo entero —Docker filtra por segundos—,
 * así que se incluye todo ese segundo (sin huecos) y el solape lo descarta el
 * cliente por cursor. Con muchas líneas en el mismo segundo puede devolver
 * alguna repetida; deduplicar es responsabilidad de quien consume.
 */
export async function fetchLogsBefore(
  name: string,
  limit: number,
  before: string | null,
): Promise<{ cursor: string | null; line: string }[]> {
  const c = docker.getContainer(name);
  // `until` (segundos Unix) no está en los tipos de dockerode pero sí en la API
  // de Docker; se fija `follow: false` como literal para elegir la sobrecarga.
  const opts: Docker.ContainerLogsOptions & { follow: false; until?: number } = {
    follow: false,
    stdout: true,
    stderr: true,
    timestamps: true,
    tail: limit,
  };
  if (before) {
    const secs = cursorToUnixSeconds(before);
    if (secs !== null) opts.until = secs + 1;
  }
  const raw = (await c.logs(opts)) as unknown as Buffer;
  const text = Buffer.isBuffer(raw) ? demuxLogBuffer(raw) : String(raw);
  const out: { cursor: string | null; line: string }[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line) out.push(splitTimestamp(line));
  }
  return out;
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
  const c = docker.getContainer(name);
  // `tail: 'all'` lo acepta la API de Docker aunque los tipos de dockerode solo
  // admitan number: se castea en esta frontera para pedir el buffer completo.
  const opts = { follow: false as const, stdout: true, stderr: true, tail, timestamps };
  const raw = (await c.logs(opts as unknown as Docker.ContainerLogsOptions & { follow: false })) as unknown as Buffer;
  return Buffer.isBuffer(raw) ? demuxLogBuffer(raw) : String(raw);
}

/**
 * Sigue los logs de un contenedor y entrega líneas completas con su cursor.
 * Devuelve una función para detener el stream. Se piden con `timestamps` para
 * que cada línea lleve cursor (el visor lo oculta) y así el frente del buffer
 * en vivo sirve de punto de partida para paginar hacia atrás.
 */
export async function followLogs(
  name: string,
  onLine: (row: { line: string; cursor: string | null }) => void,
  tail = 200,
): Promise<() => void> {
  const c = docker.getContainer(name);
  const stream = (await c.logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
  })) as NodeJS.ReadableStream;

  const out = new PassThrough();
  const err = new PassThrough();
  const feed = lineSplitter((raw) => onLine(splitTimestamp(raw)));
  out.on('data', feed);
  err.on('data', feed);
  docker.modem.demuxStream(stream, out, err);

  const stop = () => {
    try {
      (stream as any).destroy?.();
    } catch {
      /* noop */
    }
  };
  return stop;
}

