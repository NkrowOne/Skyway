/**
 * Prepublicación y redirecciones del cambio de dominio, publicadas por el
 * proveedor HTTP de Traefik (`GET /api/traefik/mailway`, que Traefik lee cada
 * 15 s) sin desplegar nada.
 *
 *  - **Redirecciones** (`domain_redirects`): el nombre viejo responde con una
 *    redirección al nuevo que conserva la ruta y la consulta. Es temporal
 *    (302/307) hasta `permanent_from` y permanente (301/308) después: el
 *    cambio se calcula en cada sondeo, sin tareas programadas. Sobreviven al
 *    borrado del servicio, que ya no tiene que servir el nombre viejo.
 *  - **Prepublicación** (`domain_prepublished`): el nombre nuevo se sirve con
 *    el contenedor que ya está en marcha antes de pasar, para que su
 *    certificado exista antes del cambio. Solo cuando su DNS ya apunta aquí
 *    (`dns_ok_at`): Traefik no vuelve a intentar un certificado que falló.
 *
 * Todos los routers tienen prioridad 1. Las etiquetas de los contenedores
 * llevan la prioridad por defecto de Traefik (la longitud de la regla, siempre
 * mayor), así que mientras un servicio reclame el nombre gana el servicio y,
 * al dejar de reclamarlo, la redirección o la prepublicación toman el control
 * sin hueco. El reto HTTP-01 no se ve afectado: Traefik lo atiende en un router
 * interno con prioridad máxima.
 */
import crypto from 'crypto';
import tls from 'tls';
import { getProject, getService, listDomainRedirects, listPrepublished } from './db';
import { traefikServiceName } from './docker/containers';
import { parseHostRule, TraefikDynamicConfig } from './mailwaytraefik';
import { tlsEnabled } from './tls';

export interface TraefikRouterSkyway {
  rule: string;
  entryPoints: string[];
  service: string;
  priority: number;
  middlewares?: string[];
  tls?: { certResolver: string };
}

export interface ConfigSkyway {
  http: {
    routers: Record<string, TraefikRouterSkyway>;
    middlewares: Record<
      string,
      {
        redirectRegex?: { regex: string; replacement: string; permanent: boolean };
        redirectScheme?: { scheme: 'https'; permanent: boolean };
      }
    >;
  };
}

/** Lo que se entrega a Traefik: la configuración de Mailway ya saneada más la propia. */
export interface ConfigTraefikMezclada {
  http?: {
    routers?: Record<string, unknown>;
    services?: Record<string, unknown>;
    middlewares?: Record<string, unknown>;
  };
}

const PRIORIDAD = 1;
const CERT_RESOLVER = 'le';
/** Prefijo de todo lo que publica Skyway por el proveedor HTTP: Mailway no puede usarlo. */
const PREFIJO_SKYWAY = 'skyway-';
/**
 * `rawURL` es `esquema://host[:puerto]` + `RequestURI` (`redirect_regex.go`):
 * con esto la ruta y la consulta pasan intactas al nombre nuevo.
 */
const REGEX_REDIRECCION = '^https?://[^/]+(.*)$';
const MW_PRE_HTTPS = 'skyway-pre-https';
/** Nombre de host completo en minúsculas, como en el puente de Mailway: nada que pueda alterar la regla. */
const HOST_RE = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Las filas las escribe el asistente con hosts ya validados; se comprueban de
 * nuevo porque van dentro de una regla de Traefik, que obedece lo que reciba
 * (un acento grave de más bastaría para añadir otra condición).
 */
function hostValido(raw: unknown): string | null {
  const host = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return HOST_RE.test(host) ? host : null;
}

/** Huella corta del host para el nombre del router: los puntos no son válidos en un nombre. */
function huella(host: string): string {
  return crypto.createHash('sha256').update(host).digest('hex').slice(0, 8);
}

/** Configuración propia de Skyway para el proveedor HTTP. Pura salvo las lecturas de la base. */
export function configuracionTraefikSkyway(ahora = Date.now()): ConfigSkyway {
  const conTls = tlsEnabled();
  const routers: ConfigSkyway['http']['routers'] = {};
  const middlewares: ConfigSkyway['http']['middlewares'] = {};

  for (const fila of listDomainRedirects()) {
    const host = hostValido(fila.host);
    const destino = hostValido(fila.to_host);
    if (!host || !destino || host === destino) continue;
    const nombre = `skyway-redir-${huella(host)}`;
    const rule = `Host(\`${host}\`)`;
    middlewares[nombre] = {
      redirectRegex: {
        regex: REGEX_REDIRECCION,
        // Desde el puerto 80 se salta directamente a https://nuevo, en un solo salto.
        replacement: `${conTls ? 'https' : 'http'}://${destino}\${1}`,
        permanent: ahora >= fila.permanent_from,
      },
    };
    routers[nombre] = { rule, entryPoints: ['web'], priority: PRIORIDAD, service: 'noop@internal', middlewares: [nombre] };
    if (conTls) {
      routers[`${nombre}-secure`] = {
        rule,
        entryPoints: ['websecure'],
        priority: PRIORIDAD,
        service: 'noop@internal',
        middlewares: [nombre],
        tls: { certResolver: CERT_RESOLVER },
      };
    }
  }

  for (const fila of listPrepublished()) {
    if (fila.dns_ok_at === null || fila.dns_ok_at === undefined) continue;
    const host = hostValido(fila.host);
    if (!host) continue;
    const servicio = getService(fila.service_id);
    if (!servicio || servicio.project_id !== fila.project_id) continue;
    const proyecto = getProject(servicio.project_id);
    if (!proyecto) continue;
    // Sin dominios el contenedor no lleva etiquetas de Traefik y el servicio
    // `@docker` no existe: el router solo dejaría un error en el registro.
    const dominios = (servicio.config as { domains?: unknown }).domains;
    if (!Array.isArray(dominios) || dominios.length === 0) continue;
    const nombre = `skyway-pre-${huella(host)}`;
    const rule = `Host(\`${host}\`)`;
    // El servicio con el nombre base de las etiquetas (`traefikServiceName`),
    // el mismo en todas las versiones del contenedor.
    const service = `${traefikServiceName(proyecto, servicio)}@docker`;
    routers[nombre] = {
      rule,
      entryPoints: ['web'],
      priority: PRIORIDAD,
      service,
      ...(conTls ? { middlewares: [MW_PRE_HTTPS] } : {}),
    };
    if (conTls) {
      middlewares[MW_PRE_HTTPS] = { redirectScheme: { scheme: 'https', permanent: true } };
      routers[`${nombre}-secure`] = {
        rule,
        entryPoints: ['websecure'],
        priority: PRIORIDAD,
        service,
        tls: { certResolver: CERT_RESOLVER },
      };
    }
  }

  return { http: { routers, middlewares } };
}

function esObjeto(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Mezcla: los nombres de Mailway que empiecen por «skyway-» se descartan; los
 * de Skyway ganan. Con los nombres se descartan también los routers de Mailway
 * que señalaban a un servicio o middleware descartado (quedarían rotos) y los
 * que reclaman un host que ya publica Skyway: el saneado del puente ya los
 * quita (`listAssignedDomains`), y aquí se asegura aunque la copia de Mailway
 * sea anterior a la redirección. `panel` son los routers de los dominios
 * adicionales del panel (`SKYWAY_DOMAIN_EXTRA`), también propios.
 */
export function mezclarConfiguracion(
  mailway: TraefikDynamicConfig,
  propia: ConfigSkyway,
  panel: TraefikDynamicConfig = {},
): ConfigTraefikMezclada {
  const deSkyway = (nombre: string) => nombre.startsWith(PREFIJO_SKYWAY);
  const hostsPropios = new Set<string>();
  for (const r of [...Object.values(propia.http.routers), ...Object.values(panel.http?.routers ?? {})]) {
    for (const h of parseHostRule(r.rule) ?? []) hostsPropios.add(h);
  }

  const mwServicios = Object.entries(mailway.http?.services ?? {}).filter(([n]) => !deSkyway(n));
  const mwMiddlewares = Object.entries(mailway.http?.middlewares ?? {}).filter(([n]) => !deSkyway(n));
  const serviciosOk = new Set(mwServicios.map(([n]) => n));
  const middlewaresOk = new Set(mwMiddlewares.map(([n]) => n));
  const mwRouters = Object.entries(mailway.http?.routers ?? {}).filter(
    ([n, r]) =>
      !deSkyway(n) &&
      serviciosOk.has(r.service) &&
      (r.middlewares ?? []).every((m) => middlewaresOk.has(m)) &&
      !(parseHostRule(r.rule) ?? []).some((h) => hostsPropios.has(h)),
  );
  // Solo lo que siguen usando los routers de Mailway que quedan, como en el saneado.
  const serviciosUsados = new Set(mwRouters.map(([, r]) => r.service));
  const middlewaresUsados = new Set(mwRouters.flatMap(([, r]) => r.middlewares ?? []));

  const routers: Record<string, unknown> = {
    ...Object.fromEntries(mwRouters),
    ...(panel.http?.routers ?? {}),
    ...propia.http.routers,
  };
  const services: Record<string, unknown> = {
    ...Object.fromEntries(mwServicios.filter(([n]) => serviciosUsados.has(n))),
    ...(panel.http?.services ?? {}),
  };
  const middlewares: Record<string, unknown> = {
    ...Object.fromEntries(mwMiddlewares.filter(([n]) => middlewaresUsados.has(n))),
    ...(panel.http?.middlewares ?? {}),
    ...propia.http.middlewares,
  };

  // Sin nada que publicar, `{}` como hasta ahora: Traefik la acepta y la
  // respuesta no cambia para quien no usa redirecciones.
  const http: NonNullable<ConfigTraefikMezclada['http']> = {};
  if (Object.keys(routers).length > 0) http.routers = routers;
  if (Object.keys(services).length > 0) http.services = services;
  if (Object.keys(middlewares).length > 0 && http.routers) http.middlewares = middlewares;
  return http.routers ? { http } : {};
}

export interface OpcionesTlsLocal {
  /** Dónde está Traefik; por defecto, su contenedor en la red `skyway-edge`. */
  destino?: string;
  puerto?: number;
  plazoMs?: number;
  /** Solo para las pruebas: autoridades de confianza en lugar de las del sistema. */
  ca?: string | Buffer;
}

/** Errores de red: no se ha llegado a hablar TLS con Traefik, así que no se sabe nada del certificado. */
const SIN_CONEXION = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'EPIPE',
]);
/** Certificado autofirmado: el que sirve Traefik por defecto mientras no tiene uno emitido. */
const AUTOFIRMADO = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN']);

/**
 * TLS local contra Traefik con SNI = host (`tls.connect` a
 * `SKYWAY_TRAEFIK_CONTAINER || 'skyway-traefik'`:443, `rejectUnauthorized:
 * true`). Comprueba el certificado que vería un visitante sin depender del DNS
 * público ni de salir a internet. `desconocido` si no se puede conectar (Skyway
 * fuera de la red de Traefik, en desarrollo): no debe bloquear nada.
 */
export async function comprobarTlsLocal(
  host: string,
  opts: OpcionesTlsLocal = {},
): Promise<{ estado: 'ok' | 'invalido' | 'desconocido'; detalle: string }> {
  const nombre = host.trim().toLowerCase();
  const destino = opts.destino ?? (process.env.SKYWAY_TRAEFIK_CONTAINER || 'skyway-traefik');
  const puerto = opts.puerto ?? 443;
  const plazoMs = opts.plazoMs ?? 5000;
  return new Promise((resolve) => {
    let resuelto = false;
    const terminar = (estado: 'ok' | 'invalido' | 'desconocido', detalle: string) => {
      if (resuelto) return;
      resuelto = true;
      clearTimeout(reloj);
      socket.destroy();
      resolve({ estado, detalle });
    };
    const socket = tls.connect({
      host: destino,
      port: puerto,
      servername: nombre,
      rejectUnauthorized: true,
      ...(opts.ca ? { ca: opts.ca } : {}),
    });
    const reloj = setTimeout(
      () => terminar('desconocido', `Traefik no ha respondido a tiempo al comprobar el certificado de ${nombre}.`),
      plazoMs,
    );
    socket.once('secureConnect', () => {
      // Con rejectUnauthorized un certificado no válido llega como error; esto es una segunda red.
      if (!socket.authorized) {
        terminar('invalido', `El certificado que sirve Traefik para ${nombre} no es válido.`);
        return;
      }
      terminar('ok', `Certificado válido para ${nombre}.`);
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ?? '';
      if (SIN_CONEXION.has(code)) {
        terminar('desconocido', `No se ha podido conectar con Traefik para comprobar el certificado de ${nombre}.`);
      } else if (AUTOFIRMADO.has(code)) {
        terminar('invalido', `Traefik todavía no tiene el certificado de ${nombre}: sirve el suyo por defecto.`);
      } else if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
        terminar('invalido', `El certificado que sirve Traefik no incluye ${nombre}.`);
      } else if (code === 'CERT_HAS_EXPIRED') {
        terminar('invalido', `El certificado de ${nombre} ha caducado.`);
      } else {
        terminar('invalido', `El certificado de ${nombre} no es válido${code ? ` (${code})` : ''}.`);
      }
    });
  });
}
