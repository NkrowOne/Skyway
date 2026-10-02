/**
 * Qué dominios puede asignarse un servicio.
 *
 * Todos los servicios comparten un único Traefik, que reparte el tráfico por la
 * regla `Host(…)` y, cuando dos reglas encajan con el mismo host, da prioridad
 * a la más larga. Sin esta comprobación, el propietario de un proyecto podía
 * quedarse con el dominio de otro cliente, con el del panel de Skyway o con los
 * de Mailway (su panel, por donde viaja el token de administrador de Skyway, y
 * el webmail) con solo añadirlo a su servicio junto a otro nombre más largo.
 *
 * La comprobación solo mira los dominios NUEVOS de cada cambio: un servicio que
 * ya tuviera uno en conflicto antes de esta regla puede seguir editándose.
 */
import { getProject, getService, serviceIdsForDomain } from './db';
import { mailwayProject, mailwayReservedHosts } from './mailway';
import { mailwayPublishedHosts } from './mailwaytraefik';

export interface DomainClaim {
  /** Proyecto del servicio que reclama los dominios. */
  projectId: string;
  /** El propio servicio (en una edición); null al crearlo. */
  serviceId: string | null;
  /** Administrador de la plataforma: puede asignar los dominios de Mailway (p. ej., al desplegar su panel). */
  isAdmin: boolean;
  /** Dominios que el servicio ya tenía: no se vuelven a comprobar. */
  current?: Iterable<string>;
}

/** Dominios del panel de Skyway (`SKYWAY_DOMAIN`, admite una lista separada por comas). */
function panelDomains(): Set<string> {
  return new Set(
    (process.env.SKYWAY_DOMAIN ?? '')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  );
}

function serviceLabel(serviceId: string): string {
  const service = getService(serviceId);
  if (!service) return 'otro servicio';
  const project = getProject(service.project_id);
  return `«${project?.name ?? '?'} / ${service.name}»`;
}

/**
 * Motivo por el que alguno de los dominios nuevos no se puede asignar, o null
 * si todos se pueden. El mensaje no nombra el proyecto ajeno salvo al
 * administrador: a un cliente no le corresponde saber quién usa el dominio.
 */
export function domainClaimError(domains: Iterable<string>, claim: DomainClaim): string | null {
  const current = new Set([...(claim.current ?? [])].map((d) => d.trim().toLowerCase()));
  const nuevos = [...new Set([...domains].map((d) => d.trim().toLowerCase()).filter((d) => d && !current.has(d)))];
  if (nuevos.length === 0) return null;

  const panel = panelDomains();
  // Los dominios de Mailway solo se calculan si hacen falta (lee Ajustes).
  let mailway: Set<string> | null = null;
  let mailwayProjectId: string | null | undefined;

  for (const domain of nuevos) {
    if (panel.has(domain)) {
      return `El dominio ${domain} es el del panel de Skyway y no se puede asignar a un servicio.`;
    }
    const otros = serviceIdsForDomain(domain).filter((id) => id !== claim.serviceId);
    if (otros.length > 0) {
      return claim.isAdmin
        ? `El dominio ${domain} ya está asignado al servicio ${serviceLabel(otros[0])}. Retíralo de ese servicio antes de asignarlo a otro.`
        : `El dominio ${domain} ya está asignado a otro servicio. Cada dominio solo puede servir a un servicio.`;
    }
    if (claim.isAdmin) continue;
    if (!mailway) mailway = new Set([...mailwayReservedHosts(), ...mailwayPublishedHosts()]);
    if (mailway.has(domain)) {
      if (mailwayProjectId === undefined) mailwayProjectId = mailwayProject()?.id ?? null;
      if (mailwayProjectId !== claim.projectId) {
        return `El dominio ${domain} lo utiliza el servicio de correo (Mailway) y no se puede asignar a este servicio.`;
      }
    }
  }
  return null;
}
