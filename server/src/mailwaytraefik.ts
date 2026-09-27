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
 * Ajustes): devolver una vacía haría que Traefik retirase todas las rutas.
 * Nunca se responde con error: el proveedor HTTP de Traefik entra en
 * reintentos con espera creciente ante cualquier respuesta distinta de 200.
 */
import { findServiceIdByDomain, getProject, getService, getSetting, listAssignedDomains, setSetting } from './db';
import {
  MAILWAY_SETTING,
  MailwayError,
  getInfo,
  getTraefikConfig,
  mailwayConfigured,
  readMailwayConfig,
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

/** Contenedores que nunca pueden ser destino: el propio panel, Traefik y el host. */
const BACKENDS_VETADOS = new Set(['skyway', 'skyway-traefik', 'traefik', 'localhost']);

/**
 * Prefijo de los contenedores del proyecto de Skyway donde vive Mailway. Se
 * toma del servicio configurado o, si no lo hay, del servicio que sirve el
 * dominio de la URL pública. Los contenedores de OTROS proyectos
 * (`skyway-<otro>-…`) no pueden ser destino: una ruta de Mailway no debe poder
 * exponer la aplicación de otro cliente bajo un dominio distinto.
 */
function mailwayContainerPrefix(): string | null {
  const cfg = readMailwayConfig();
  let serviceId = cfg.serviceId;
  if (!serviceId && cfg.baseUrl) {
    try {
      serviceId = findServiceIdByDomain(new URL(cfg.baseUrl).hostname) ?? null;
    } catch {
      serviceId = null;
    }
  }
  const service = serviceId ? getService(serviceId) : undefined;
  const project = service ? getProject(service.project_id) : undefined;
  return project ? `skyway-${project.slug}-` : null;
}

export function bridgeOptions(): SanitizeOptions {
  const reserved = listAssignedDomains();
  for (const d of (process.env.SKYWAY_DOMAIN ?? '').split(',')) if (d.trim()) reserved.push(d.trim().toLowerCase());
  const prefix = mailwayContainerPrefix();
  return {
    reservedHosts: reserved,
    allowBackendHost: (host) =>
      !BACKENDS_VETADOS.has(host) && (!host.startsWith('skyway-') || (!!prefix && host.startsWith(prefix))),
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
let lastWarn: { message: string; at: number } | null = null;

type Logger = { warn: (obj: object, msg: string) => void };

function countRouters(cfg: TraefikDynamicConfig): number {
  return Object.keys(cfg.http?.routers ?? {}).length;
}

function warnOnce(log: Logger | undefined, message: string, extra: object = {}): void {
  if (!log) return;
  if (lastWarn && lastWarn.message === message && Date.now() - lastWarn.at < WARN_EVERY_MS) return;
  lastWarn = { message, at: Date.now() };
  log.warn(extra, message);
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

/** Configuración dinámica para el proveedor HTTP de Traefik. Nunca lanza. */
export async function mailwayTraefikConfig(log?: Logger): Promise<TraefikDynamicConfig> {
  if (!mailwayConfigured()) return {};
  if (state && Date.now() - state.fetchedAt < MIN_INTERVAL_MS) return state.config;
  if (inflight) return inflight;

  inflight = (async () => {
    const opts = bridgeOptions();
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

/** Olvida el estado en memoria (al cambiar la configuración y en las pruebas). */
export function resetMailwayTraefikState(): void {
  state = null;
  lastWarn = null;
}
