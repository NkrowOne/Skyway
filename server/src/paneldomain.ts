/**
 * Dominios del propio panel de Skyway.
 *
 * `SKYWAY_DOMAIN` es UN nombre: docker-compose.yml lo pone tal cual en la regla
 * `Host(…)` de los routers del panel. La documentación decía que admitía una
 * lista separada por comas, y quien la seguía (lo natural al cambiar el dominio
 * del panel: servir el viejo y el nuevo a la vez) obtenía `Host(`a,b`)`, un host
 * literal con coma que nunca coincide: el panel dejaba de responder por dominio
 * y el certificado se pedía para un nombre no válido.
 *
 * Los nombres adicionales van en `SKYWAY_DOMAIN_EXTRA` (lista separada por
 * comas, opcional). Sus routers no salen del compose —una variable vacía daría
 * una regla `Host(``)` inválida—, sino del proveedor de configuración dinámica
 * que Traefik ya lee de Skyway (`/api/traefik/mailway`): un par de routers por
 * nombre, cada uno con su certificado, hacia el mismo servicio del panel.
 */
import type { TraefikDynamicConfig, TraefikRouter } from './mailwaytraefik';

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function hostList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/** El dominio principal del panel (`SKYWAY_DOMAIN`), o null si no hay. */
export function primaryPanelDomain(): string | null {
  // Con una lista (configuración antigua) vale el primero: es el que se escribió primero.
  return hostList(process.env.SKYWAY_DOMAIN)[0] ?? null;
}

/** Nombres adicionales del panel (`SKYWAY_DOMAIN_EXTRA`), válidos y sin el principal. */
export function extraPanelDomains(): string[] {
  const primary = primaryPanelDomain();
  return [...new Set(hostList(process.env.SKYWAY_DOMAIN_EXTRA))].filter((d) => HOST_RE.test(d) && d !== primary);
}

/**
 * Todos los dominios del panel: ningún servicio puede asignárselos y el puente
 * de Traefik de Mailway nunca acepta una ruta para ellos. Incluye cualquier
 * nombre de un `SKYWAY_DOMAIN` con comas: aunque Traefik no los sirva, siguen
 * siendo del panel.
 */
export function panelDomains(): Set<string> {
  return new Set([...hostList(process.env.SKYWAY_DOMAIN), ...hostList(process.env.SKYWAY_DOMAIN_EXTRA)]);
}

/** Aviso de arranque si `SKYWAY_DOMAIN` trae una lista (la regla de Traefik no coincidirá nunca). */
export function panelDomainWarning(): string | null {
  const raw = process.env.SKYWAY_DOMAIN ?? '';
  if (!raw.includes(',')) return null;
  return (
    `SKYWAY_DOMAIN contiene varios nombres («${raw}»), pero Traefik lo usa como un único nombre en la regla Host() del panel: ` +
    'el panel no responderá por ningún dominio. Deja en SKYWAY_DOMAIN el dominio principal y pon los demás en SKYWAY_DOMAIN_EXTRA.'
  );
}

/** Nombre de los routers que se generan, a partir del dominio (Traefik solo admite [a-z0-9-]). */
function routerName(domain: string): string {
  return `skyway-panel-extra-${domain.replace(/[^a-z0-9]+/g, '-')}`;
}

/**
 * Routers del panel para los nombres de `SKYWAY_DOMAIN_EXTRA`. Reutilizan el
 * servicio y la redirección a HTTPS que declaran las etiquetas del panel en
 * docker-compose.yml (`skyway@docker`, `skyway-https@docker`): mismo destino y
 * mismas reglas que el dominio principal, cada nombre con su certificado.
 */
export function panelExtraTraefikConfig(): TraefikDynamicConfig {
  const extras = extraPanelDomains();
  if (extras.length === 0) return {};
  const routers: Record<string, TraefikRouter> = {};
  for (const domain of extras) {
    const name = routerName(domain);
    const rule = `Host(\`${domain}\`)`;
    routers[name] = { rule, entryPoints: ['web'], middlewares: ['skyway-https@docker'], service: 'skyway@docker' };
    routers[`${name}-secure`] = { rule, entryPoints: ['websecure'], service: 'skyway@docker', tls: { certResolver: 'le' } };
  }
  return { http: { routers } };
}

/**
 * URL pública del panel: `https://SKYWAY_DOMAIN` si está definido y, si no, la
 * de la petición. Es la que se ofrece para los webhooks de GitHub: la de la
 * petición puede ser el túnel SSH (`http://localhost:4000`), que GitHub no alcanza.
 */
export function panelBaseUrl(req: { protocol: string; host: string }): string {
  const domain = primaryPanelDomain();
  // `req.host` y no `req.hostname`: en Fastify 5 este pierde el puerto (el del
  // túnel SSH, `localhost:4000`, o el de un proxy en otro puerto).
  return domain ? `https://${domain}` : `${req.protocol}://${req.host}`;
}

/** Host que GitHub no puede alcanzar: localhost, una IP de bucle local o cualquier IP literal. */
export function isLocalOrIpHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/:\d+$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  return h.includes(':'); // IPv6 literal
}
