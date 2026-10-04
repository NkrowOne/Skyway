/**
 * Puente de Traefik para Mailway.
 *
 * Mailway publica en `/api/traefik/config` las rutas de los dominios propios de
 * sus clientes (webmail de marca blanca, autoconfiguración de dispositivos).
 * El Traefik de Skyway las lee a través de Skyway (`GET /api/traefik/mailway`,
 * proveedor HTTP) en lugar de directamente, por dos motivos:
 *
 *  1. Cero configuración: Skyway ya conoce la dirección y el token de Mailway.
 *  2. Seguridad: Traefik obedece cualquier regla que reciba. Un Mailway
 *     comprometido (o un error suyo) podría publicar `Host(\`panel-de-skyway\`)`
 *     o `PathPrefix(\`/\`)` y quedarse con el tráfico de otras aplicaciones, o
 *     apuntar un dominio al dashboard interno de Traefik. Aquí solo pasa lo que
 *     encaja en una forma mínima y conocida; el resto se descarta y se anota.
 *
 * Si Mailway no responde, se sirve la última configuración buena (memoria y
 * Ajustes): devolver una vacía haría que Traefik retirase todas las rutas. Lo
 * mismo si se elimina el token o la dirección: los dominios de los clientes
 * siguen publicados hasta que un administrador desconecta Mailway de forma
 * explícita («Desconectar Mailway», `forgetMailwayTraefik`), que es lo único
 * que las retira. Rotar o corregir la configuración no deja sin webmail a
 * nadie.
 * Nunca se responde con error: el proveedor HTTP de Traefik entra en
 * reintentos con espera creciente ante cualquier respuesta distinta de 200.
 *
 * Con la misma cadencia se lee la lista de nombres de marca blanca de toda la
 * instancia, en cualquier estado (`mailwayWhitelabelHosts`), con la que
 * `domainguard.ts` reserva también los que aún esperan DNS.
 */
import { getSetting, listAssignedDomains, listServices, setSetting } from './db';
import { panelDomains } from './paneldomain';
import { dockerAvailable, dockerQuery } from './docker/client';
import { configuredReplicas, replicaName } from './docker/containers';
import {
  MAILWAY_SETTING,
  MailwayError,
  getInfo,
  getTraefikConfig,
  listAllWhitelabelDomains,
  mailwayConfigured,
  mailwayProject,
  rememberContainerHosts,
} from './mailway';

// ---------- saneado (función pura) ----------

export interface TraefikRouter {
  rule: string;
  entryPoints: string[];
  service: string;
  middlewares?: string[];
  tls?: { certResolver?: string };
}

export interface TraefikService {
  loadBalancer: { servers: { url: string }[] };
}

export interface TraefikMiddleware {
  redirectScheme: { scheme: 'https'; permanent?: boolean };
}

export interface TraefikDynamicConfig {
  http?: {
    routers?: Record<string, TraefikRouter>;
    services?: Record<string, TraefikService>;
    middlewares?: Record<string, TraefikMiddleware>;
  };
}

export interface SanitizeOptions {
  /** Dominios que ya son de Skyway (panel y servicios): ninguna ruta de Mailway puede tomarlos. */
  reservedHosts: Iterable<string>;
  /** Decide si un contenedor puede recibir tráfico (nombre ya en minúsculas). */
  allowBackendHost: (host: string) => boolean;
}

export interface SanitizeResult {
  config: TraefikDynamicConfig;
  /** Qué se ha descartado y por qué, para el diagnóstico del administrador. */
  dropped: string[];
}

/** Nombres de router/servicio/middleware: sin «@» (no pueden señalar a otro proveedor como `api@internal`). */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Nombre de host completo (con al menos un punto), en minúsculas. Excluye comodines y espacios. */
const FQDN_RE = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const HOST_TERM_RE = /^Host\(`([^`]*)`\)$/;
/**
 * Destino: `http://<contenedor>(:puerto)`. El nombre empieza por letra, así que
 * no admite IP (tampoco en decimal u hexadecimal) ni un host con puntos que
 * pudiera resolverse fuera de la red de Docker.
 */
const BACKEND_RE = /^http:\/\/([a-z][a-z0-9_-]{0,127})(?::(\d{1,5}))?\/?$/;
const ENTRY_POINTS = new Set(['web', 'websecure']);
const CERT_RESOLVER = 'le';
const MAX_HOSTS_PER_ROUTER = 50;
const MAX_ROUTERS = 2000;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Hosts de una regla hecha EXCLUSIVAMENTE de términos Host(`…`) unidos por «||»; null si hay algo más. */
export function parseHostRule(rule: unknown): string[] | null {
  if (typeof rule !== 'string' || rule.length > 20_000) return null;
  const terms = rule.split('||').map((t) => t.trim());
  if (terms.length === 0 || terms.length > MAX_HOSTS_PER_ROUTER) return null;
  const hosts: string[] = [];
  for (const term of terms) {
    const m = HOST_TERM_RE.exec(term);
    if (!m) return null;
    const host = m[1].toLowerCase();
    if (!FQDN_RE.test(host)) return null;
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

function sanitizeMiddleware(raw: unknown): TraefikMiddleware | null {
  if (!isObject(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== 'redirectScheme') return null;
  const rs = raw.redirectScheme;
  if (!isObject(rs) || rs.scheme !== 'https') return null;
  return {
    redirectScheme: {
      scheme: 'https',
      ...(typeof rs.permanent === 'boolean' ? { permanent: rs.permanent } : {}),
    },
  };
}

function sanitizeService(raw: unknown, allowBackendHost: (h: string) => boolean): { service: TraefikService } | { reason: string } {
  if (!isObject(raw) || !isObject(raw.loadBalancer)) return { reason: 'no es un balanceador simple' };
  const servers = raw.loadBalancer.servers;
  if (!Array.isArray(servers) || servers.length === 0 || servers.length > 10) return { reason: 'sin destinos válidos' };
  const out: { url: string }[] = [];
  for (const s of servers) {
    const url = isObject(s) && typeof s.url === 'string' ? s.url.trim().toLowerCase() : '';
    const m = BACKEND_RE.exec(url);
    if (!m) return { reason: `destino no permitido (${url.slice(0, 80) || 'vacío'})` };
    const host = m[1];
    if (m[2] !== undefined) {
      const port = Number(m[2]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { reason: `puerto no válido (${m[2]})` };
    }
    if (!allowBackendHost(host)) return { reason: `contenedor no permitido (${host})` };
    out.push({ url: `http://${host}${m[2] !== undefined ? `:${Number(m[2])}` : ''}` });
  }
  return { service: { loadBalancer: { servers: out } } };
}

/**
 * Reduce la configuración de Mailway a lo que se sabe inofensivo:
 *  - routers con regla solo de `Host(\`…\`)`, sin colisión con dominios de
 *    Skyway, con entradas `web`/`websecure`, `certResolver` «le» y que señalan
 *    a servicios y middlewares que también han pasado el filtro;
 *  - servicios que solo reparten a contenedores permitidos por HTTP;
 *  - middlewares de redirección a HTTPS y nada más.
 * La regla se reescribe a partir de los hosts validados: nunca se reenvía el
 * texto original.
 */
export function sanitizeTraefikConfig(raw: unknown, opts: SanitizeOptions): SanitizeResult {
  const dropped: string[] = [];
  const reserved = new Set([...opts.reservedHosts].map((h) => h.trim().toLowerCase()).filter(Boolean));
  const http = isObject(raw) && isObject(raw.http) ? raw.http : {};

  const middlewares = new Map<string, TraefikMiddleware>();
  if (isObject(http.middlewares)) {
    for (const [name, def] of Object.entries(http.middlewares)) {
      const mw = NAME_RE.test(name) ? sanitizeMiddleware(def) : null;
      if (mw) middlewares.set(name, mw);
      else dropped.push(`middleware «${name.slice(0, 80)}»: solo se admiten redirecciones a HTTPS`);
    }
  }

  const services = new Map<string, TraefikService>();
  if (isObject(http.services)) {
    for (const [name, def] of Object.entries(http.services)) {
      if (!NAME_RE.test(name)) {
        dropped.push(`servicio «${name.slice(0, 80)}»: nombre no válido`);
        continue;
      }
      const r = sanitizeService(def, opts.allowBackendHost);
      if ('service' in r) services.set(name, r.service);
      else dropped.push(`servicio «${name}»: ${r.reason}`);
    }
  }

  const routers = new Map<string, TraefikRouter>();
  if (isObject(http.routers)) {
    for (const [name, def] of Object.entries(http.routers)) {
      const motivo = (m: string) => dropped.push(`router «${name.slice(0, 80)}»: ${m}`);
      if (routers.size >= MAX_ROUTERS) {
        motivo('se ha superado el máximo de rutas');
        continue;
      }
      if (!NAME_RE.test(name)) {
        motivo('nombre no válido');
        continue;
      }
      if (!isObject(def)) {
        motivo('definición no válida');
        continue;
      }
      const hosts = parseHostRule(def.rule);
      if (!hosts) {
        motivo('la regla solo puede contener Host(`dominio`) unidos por ||');
        continue;
      }
      const tomados = hosts.filter((h) => reserved.has(h));
      if (tomados.length > 0) {
        motivo(`el dominio ${tomados.join(', ')} ya lo utiliza Skyway`);
        continue;
      }
      const entryPoints = Array.isArray(def.entryPoints)
        ? [...new Set(def.entryPoints.filter((e): e is string => typeof e === 'string' && ENTRY_POINTS.has(e)))]
        : [];
      if (entryPoints.length === 0) {
        motivo('sin puntos de entrada web/websecure');
        continue;
      }
      if (typeof def.service !== 'string' || !services.has(def.service)) {
        motivo('el servicio no existe o se ha descartado');
        continue;
      }
      let mws: string[] | undefined;
      if (def.middlewares !== undefined) {
        if (!Array.isArray(def.middlewares) || !def.middlewares.every((m) => typeof m === 'string' && middlewares.has(m))) {
          // Sin su redirección, la ruta del puerto 80 serviría contenido en claro: mejor ninguna.
          motivo('usa middlewares no admitidos');
          continue;
        }
        mws = [...new Set(def.middlewares as string[])];
      }
      let tls: TraefikRouter['tls'];
      if (def.tls !== undefined) {
        if (!isObject(def.tls)) {
          motivo('configuración TLS no válida');
          continue;
        }
        if (def.tls.certResolver !== undefined && def.tls.certResolver !== CERT_RESOLVER) {
          motivo(`solo se admite el emisor de certificados «${CERT_RESOLVER}»`);
          continue;
        }
        tls = def.tls.certResolver === CERT_RESOLVER ? { certResolver: CERT_RESOLVER } : {};
      }
      routers.set(name, {
        rule: hosts.map((h) => `Host(\`${h}\`)`).join(' || '),
        entryPoints,
        service: def.service,
        ...(mws && mws.length > 0 ? { middlewares: mws } : {}),
        ...(tls ? { tls } : {}),
      });
    }
  }

  // Solo lo que usan las rutas supervivientes.
  const usedServices = new Set([...routers.values()].map((r) => r.service));
  const usedMiddlewares = new Set([...routers.values()].flatMap((r) => r.middlewares ?? []));
  const sortedEntries = <T>(m: Map<string, T>, keep: Set<string>) =>
    Object.fromEntries([...m.entries()].filter(([k]) => keep.has(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  if (routers.size === 0) return { config: {}, dropped };
  const outHttp: NonNullable<TraefikDynamicConfig['http']> = {
    routers: sortedEntries(routers, new Set(routers.keys())),
    services: sortedEntries(services, usedServices),
  };
  if (usedMiddlewares.size > 0) outHttp.middlewares = sortedEntries(middlewares, usedMiddlewares);
  return { config: { http: outHttp }, dropped };
}

/**
 * JSON con las claves ordenadas: Traefik compara un hash del cuerpo para saber
 * si la configuración cambió, y así dos respuestas equivalentes son idénticas.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// ---------- puente con estado ----------

/**
 * Contenedores propios de Mailway que no despliega Skyway (webmail, servidor de
 * correo; `mailway-webmail` por defecto). Skyway nombra los suyos
 * `skyway-<proyecto>-<servicio>` y no crea alias en la red de Traefik, así que
 * ningún cliente puede tener un contenedor con este prefijo.
 */
const PREFIJO_MAILWAY = 'mailway-';

/**
 * Nombres exactos de los contenedores del proyecto de Skyway donde vive Mailway
 * (con sus réplicas). Se comparan enteros, nunca por prefijo: `skyway-correo-`
 * también es el principio de los contenedores del proyecto «correo-x», que es
 * de otro cliente.
 */
function mailwayContainerNames(): Set<string> {
  const project = mailwayProject();
  const names = new Set<string>();
  if (!project) return names;
  for (const service of listServices(project.id)) {
    if (service.type === 'database') continue;
    for (let i = 1; i <= configuredReplicas(service); i++) names.add(replicaName(project, service, i));
  }
  return names;
}

/**
 * Qué acepta el puente. Destinos: los contenedores `mailway-…` y los del
 * proyecto de Mailway, y nada más. Una lista de prohibidos no bastaba: un
 * nombre de una sola etiqueta como `localhost`, `metadata` o el de otro
 * contenedor de la máquina (un proxy del socket de Docker, un panel de
 * administración) lo resuelve Traefik fuera del alcance de Mailway.
 */
export function bridgeOptions(): SanitizeOptions {
  const reserved = listAssignedDomains();
  // Los del panel: SKYWAY_DOMAIN y los adicionales de SKYWAY_DOMAIN_EXTRA.
  for (const d of panelDomains()) reserved.push(d);
  const names = mailwayContainerNames();
  return {
    reservedHosts: reserved,
    allowBackendHost: (host) => (host.startsWith(PREFIJO_MAILWAY) && host.length > PREFIJO_MAILWAY.length) || names.has(host),
  };
}

export interface BridgeStatus {
  routers: number;
  dropped: string[];
  /** Última lectura correcta de Mailway (ms) o null si aún no la ha habido. */
  syncedAt: number | null;
  /** Motivo del último fallo, si la última lectura falló. */
  error: string | null;
}

interface BridgeState extends BridgeStatus {
  config: TraefikDynamicConfig;
  fetchedAt: number;
}

/** Traefik sondea cada 15 s; varias peticiones seguidas comparten una lectura. */
const MIN_INTERVAL_MS = 5000;
/** Un mismo aviso en el registro, como mucho cada 10 minutos. */
const WARN_EVERY_MS = 10 * 60_000;

let state: BridgeState | null = null;
let inflight: Promise<TraefikDynamicConfig> | null = null;
/**
 * Último aviso de cada mensaje. Por mensaje y no uno solo: con Mailway caído
 * fallan a la vez las rutas y la lista de marca blanca, y alternar los dos
 * avisos los repetiría en cada sondeo.
 */
const lastWarns = new Map<string, number>();

type Logger = { warn: (obj: object, msg: string) => void };

function countRouters(cfg: TraefikDynamicConfig): number {
  return Object.keys(cfg.http?.routers ?? {}).length;
}

function warnOnce(log: Logger | undefined, message: string, extra: object = {}): void {
  if (!log) return;
  const at = lastWarns.get(message);
  if (at !== undefined && Date.now() - at < WARN_EVERY_MS) return;
  if (lastWarns.size >= 50) lastWarns.clear();
  lastWarns.set(message, Date.now());
  log.warn(extra, message);
}

// ---------- nombres de marca blanca de la instancia ----------

/**
 * Nombres de marca blanca de TODOS los clientes de Mailway, en cualquier estado
 * («Esperando DNS» incluido). Mailway solo publica en Traefik los que ya
 * apuntan aquí: mientras uno espera DNS, el puente no lo conoce, y sin esta
 * lista otro cliente podía asignárselo a un servicio y quedarse con el tráfico
 * del webmail (y con las contraseñas que se escribieran en él) en cuanto el DNS
 * apuntase a este servidor. Si Mailway no responde se conserva la última lista
 * buena (memoria y Ajustes); solo «Desconectar Mailway» la vacía.
 */
let whitelabelHosts: string[] | null = null;

function hostList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const hosts = raw
    .filter((h): h is string => typeof h === 'string')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => FQDN_RE.test(h));
  return [...new Set(hosts)].sort();
}

function rememberWhitelabelHosts(hosts: string[]): void {
  whitelabelHosts = hosts;
  const json = JSON.stringify(hosts);
  if (getSetting(MAILWAY_SETTING.whitelabelHosts) !== json) setSetting(MAILWAY_SETTING.whitelabelHosts, json);
}

/** Nombres de marca blanca de la instancia según la última lista buena. */
export function mailwayWhitelabelHosts(): string[] {
  if (whitelabelHosts) return whitelabelHosts;
  let stored: unknown = null;
  try {
    stored = JSON.parse(getSetting(MAILWAY_SETTING.whitelabelHosts) ?? 'null');
  } catch {
    stored = null;
  }
  whitelabelHosts = hostList(stored);
  return whitelabelHosts;
}

/**
 * Nombres reservados desde Skyway mientras una lectura estaba en curso: esa
 * lectura pudo salir antes del alta y no traerlos, y no debe soltarlos.
 */
let reservadosDuranteLectura = new Set<string>();

/**
 * Reserva al momento un nombre que se acaba de dar de alta desde Skyway, sin
 * esperar a la siguiente lectura: es justo cuando más tiempo pasará esperando DNS.
 */
export function reserveWhitelabelHost(hostname: string): void {
  reservadosDuranteLectura.add(hostname.trim().toLowerCase());
  rememberWhitelabelHosts(hostList([...mailwayWhitelabelHosts(), hostname]));
}

/** Lee la lista de Mailway. Nunca lanza: si falla, se conserva la anterior. */
async function refreshWhitelabelHosts(log?: Logger): Promise<void> {
  // Solo hay una lectura a la vez (la del puente, compartida por `inflight`).
  reservadosDuranteLectura = new Set();
  try {
    const domains = await listAllWhitelabelDomains();
    const leidos = domains.map((d) => (d && typeof d === 'object' ? d.hostname : null));
    rememberWhitelabelHosts(hostList([...leidos, ...reservadosDuranteLectura]));
  } catch (err) {
    const message = err instanceof MailwayError ? err.message : 'Error inesperado.';
    warnOnce(log, `No se ha podido leer la lista de dominios de marca blanca de Mailway: ${message}`);
  }
}

/**
 * Contenedores que despliega el instalador de Mailway con sus propias rutas
 * de Traefik (etiquetas del compose, que el puente no ve): el servidor de
 * correo, el webmail y, en la instalación autónoma, el panel. Se comparan
 * enteros: los contenedores de Skyway se llaman `skyway-…` y ningún cliente
 * puede crear uno con estos nombres.
 */
const CONTENEDORES_MAILWAY = ['mailway-mail', 'mailway-webmail', 'mailway-panel'];
const LECTURA_CONTENEDORES_MS = 60_000;
let contenedoresLeidosEn = 0;

/**
 * Hosts de las reglas `Host(…)` de los contenedores de Mailway. Son nombres
 * del operador que apuntan aquí aunque Mailway anuncie otros (tras reinstalar
 * con nombres nuevos, el compose usa los nuevos y Mailway puede seguir
 * anunciando los viejos): `domainguard.ts` los reserva igual. Nunca lanza;
 * sin Docker se conserva la última lista.
 */
export async function refreshContainerHosts(force = false): Promise<void> {
  if (!force && Date.now() - contenedoresLeidosEn < LECTURA_CONTENEDORES_MS) return;
  contenedoresLeidosEn = Date.now();
  try {
    if (!(await dockerAvailable())) return;
    const lista = await dockerQuery.listContainers({ all: true, filters: { name: CONTENEDORES_MAILWAY } });
    const hosts = new Set<string>();
    for (const c of lista) {
      const nombres = (c.Names ?? []).map((n) => n.replace(/^\//, ''));
      if (!nombres.some((n) => CONTENEDORES_MAILWAY.includes(n))) continue;
      for (const [clave, valor] of Object.entries(c.Labels ?? {})) {
        if (!/^traefik\.http\.routers\.[^.]+\.rule$/.test(clave)) continue;
        for (const h of parseHostRule(valor) ?? []) hosts.add(h);
      }
    }
    rememberContainerHosts([...hosts]);
  } catch {
    /* Docker no responde: se conserva la lista anterior */
  }
}

/** Última configuración buena conocida, vuelta a sanear con los dominios de AHORA. */
function lastGood(opts: SanitizeOptions): TraefikDynamicConfig {
  let base: unknown = state?.syncedAt ? state.config : null;
  if (!base) {
    const stored = getSetting(MAILWAY_SETTING.traefikCache);
    if (stored) {
      try {
        base = JSON.parse(stored);
      } catch {
        base = null;
      }
    }
  }
  // Re-saneada: si desde la última lectura un servicio de Skyway ha tomado uno
  // de esos dominios, la copia antigua no puede seguir quitándoselo.
  return base ? sanitizeTraefikConfig(base, opts).config : {};
}

async function fetchRaw(): Promise<unknown> {
  let token = getSetting(MAILWAY_SETTING.traefikToken);
  if (!token) token = (await getInfo({ fresh: true })).traefik?.token ?? null;
  if (!token) {
    throw new MailwayError(
      'config',
      'Mailway no ha facilitado el token de Traefik: el token de gestión configurado no es de administrador.',
    );
  }
  try {
    return await getTraefikConfig(token);
  } catch (err) {
    // Token de Traefik rotado en Mailway: se pide el vigente y se reintenta una vez.
    if (!(err instanceof MailwayError) || err.status !== 401) throw err;
    setSetting(MAILWAY_SETTING.traefikToken, null);
    const fresh = (await getInfo({ fresh: true })).traefik?.token;
    if (!fresh) throw new MailwayError('auth', 'Mailway ha rechazado el token de Traefik y no ha facilitado uno nuevo.', 401);
    return getTraefikConfig(fresh);
  }
}

const SIN_CONFIGURAR =
  'La conexión con Mailway no está configurada (sin token o sin dirección). Se mantienen las últimas rutas publicadas hasta que un administrador desconecte Mailway.';

/** Configuración dinámica para el proveedor HTTP de Traefik. Nunca lanza. */
export async function mailwayTraefikConfig(log?: Logger): Promise<TraefikDynamicConfig> {
  // Con su propia cadencia y sin esperar: no retrasa la respuesta a Traefik.
  void refreshContainerHosts();
  if (!mailwayConfigured()) {
    // Sin token no se puede leer nada nuevo, pero retirar las rutas dejaría sin
    // webmail a los clientes por un token rotado o borrado por error: solo las
    // retira «Desconectar Mailway». Se re-sanea igualmente con los dominios de ahora.
    const config = lastGood(bridgeOptions());
    const routers = countRouters(config);
    state = {
      config,
      fetchedAt: Date.now(),
      syncedAt: state?.syncedAt ?? null,
      routers,
      dropped: state?.dropped ?? [],
      error: routers > 0 ? SIN_CONFIGURAR : null,
    };
    return config;
  }
  if (state && Date.now() - state.fetchedAt < MIN_INTERVAL_MS) return state.config;
  if (inflight) return inflight;

  inflight = (async () => {
    const opts = bridgeOptions();
    // En paralelo y con plazo corto: no retrasa la respuesta a Traefik.
    const nombres = refreshWhitelabelHosts(log);
    try {
      const raw = await fetchRaw();
      const { config, dropped } = sanitizeTraefikConfig(raw, opts);
      const json = stableStringify(config);
      if (getSetting(MAILWAY_SETTING.traefikCache) !== json) setSetting(MAILWAY_SETTING.traefikCache, json);
      if (dropped.length > 0) warnOnce(log, 'Rutas de Mailway descartadas por seguridad', { dropped });
      state = { config, fetchedAt: Date.now(), syncedAt: Date.now(), routers: countRouters(config), dropped, error: null };
      return config;
    } catch (err) {
      const message = err instanceof MailwayError ? err.message : 'Error inesperado al leer la configuración de Mailway.';
      const config = lastGood(opts);
      warnOnce(log, `No se ha podido leer la configuración de Traefik de Mailway: ${message}`);
      state = {
        config,
        fetchedAt: Date.now(),
        syncedAt: state?.syncedAt ?? null,
        routers: countRouters(config),
        dropped: state?.dropped ?? [],
        error: message,
      };
      return config;
    } finally {
      await nombres;
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function mailwayTraefikStatus(): BridgeStatus | null {
  if (!state) return null;
  return { routers: state.routers, dropped: state.dropped, syncedAt: state.syncedAt, error: state.error };
}

/**
 * Olvida el estado en memoria (al cambiar la configuración y en las pruebas).
 * Las copias guardadas en Ajustes (rutas y nombres de marca blanca) se
 * conservan: son la última configuración buena.
 */
export function resetMailwayTraefikState(): void {
  state = null;
  whitelabelHosts = null;
  reservadosDuranteLectura = new Set();
  lastWarns.clear();
}

/**
 * Retira todas las rutas de Mailway: borra también la última configuración
 * buena guardada y libera los nombres de marca blanca reservados. Solo lo hace
 * «Desconectar Mailway»; el siguiente sondeo de Traefik recibe una
 * configuración vacía.
 */
export function forgetMailwayTraefik(): void {
  setSetting(MAILWAY_SETTING.traefikCache, null);
  setSetting(MAILWAY_SETTING.whitelabelHosts, null);
  resetMailwayTraefikState();
}

/**
 * Dominios que publica ahora el puente (la última configuración buena, ya
 * saneada). Ningún servicio de un cliente puede asignárselos: el saneado
 * retiraría la ruta de Mailway y el webmail de ese dominio pasaría a ser suyo.
 */
export function mailwayPublishedHosts(): string[] {
  let config: unknown = state?.config ?? null;
  if (!config) {
    const stored = getSetting(MAILWAY_SETTING.traefikCache);
    if (stored) {
      try {
        config = JSON.parse(stored);
      } catch {
        config = null;
      }
    }
  }
  const routers = isObject(config) && isObject(config.http) && isObject(config.http.routers) ? config.http.routers : {};
  const hosts = new Set<string>();
  for (const def of Object.values(routers)) {
    for (const h of (isObject(def) ? parseHostRule(def.rule) : null) ?? []) hosts.add(h);
  }
  return [...hosts];
}
