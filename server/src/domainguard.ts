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
 *
 * Los nombres cuyo registro creó el DNS automático del administrador en las
 * zonas de Cloudflare del operador quedan reservados al proyecto para el que
 * se crearon (`cloudflare_dns_records`): el registro sigue apuntando aquí
 * aunque el dominio se quite del servicio.
 *
 * Los nombres que redirigen tras un cambio de dominio y los que se están
 * prepublicando (`redirecciones.ts`) son del proyecto del cambio, también
 * frente a la administración.
 *
 * Los de Mailway son su URL pública, su panel, su webmail y su servidor de
 * correo, los que publica el puente de Traefik y los nombres de marca blanca de
 * todos sus clientes en cualquier estado: uno que aún espera DNS no está
 * publicado, pero en cuanto apunte aquí el servicio que lo tuviera se quedaría
 * con el tráfico de ese webmail.
 */
import {
  getCloudflareDnsRecord,
  getDomainRedirect,
  getMailwayDnsReserva,
  getPrepublished,
  getProject,
  getService,
  serviceIdsForDomain,
} from './db';
import { mailwayProject, mailwayReservedHosts } from './mailway';
import { mailwayPublishedHosts, mailwayWhitelabelHosts } from './mailwaytraefik';
import { panelDomains } from './paneldomain';

export { panelDomains };

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
    // Un nombre que redirige al nuevo tras un cambio de dominio, o el nombre
    // nuevo que se está prepublicando, lo publica Skyway por su cuenta para
    // otro proyecto: asignarlo a un servicio le quitaría el tráfico (el router
    // de un servicio gana a los de prioridad 1) en mitad del cambio. Vale
    // también para la administración, como un dominio de otro servicio.
    const redireccion = getDomainRedirect(domain);
    const prepublicado = getPrepublished(domain);
    const ajena = redireccion && redireccion.project_id !== claim.projectId ? redireccion : undefined;
    const enCambio = ajena ?? (prepublicado && prepublicado.project_id !== claim.projectId ? prepublicado : undefined);
    if (enCambio) {
      // A la administración se le dice de qué proyecto es (como en
      // `webmailHostError`): una redirección sobrevive al borrado del
      // servicio y solo se quita desde el asistente de ese proyecto.
      const proyecto = claim.isAdmin ? getProject(enCambio.project_id) : undefined;
      if (proyecto && ajena) {
        return `El dominio ${domain} redirige a ${ajena.to_host} por un cambio de dominio del proyecto «${proyecto.name}» y no se puede asignar a este servicio. Para liberarlo, quita las redirecciones desde «Cambiar de dominio» de ese proyecto cuando el cambio haya terminado.`;
      }
      if (proyecto) {
        return `El dominio ${domain} lo utiliza un cambio de dominio del proyecto «${proyecto.name}» (nombre en preparación) y no se puede asignar a este servicio hasta que ese cambio termine o se cancele.`;
      }
      return `El dominio ${domain} lo utiliza otro proyecto (redirección o cambio de dominio en curso) y no se puede asignar a este servicio.`;
    }
    if (claim.isAdmin) continue;
    // Un nombre cuyo registro A creó el DNS automático del administrador en
    // las zonas del operador sigue apuntando aquí aunque nadie lo use: solo el
    // proyecto para el que se creó (o el administrador) puede asignárselo.
    const reservado = getCloudflareDnsRecord(domain);
    if (reservado && reservado.project_id !== claim.projectId) {
      return `El dominio ${domain} está reservado por el administrador de la plataforma y no se puede asignar a este servicio.`;
    }
    if (!mailway) mailway = new Set([...mailwayReservedHosts(), ...mailwayPublishedHosts(), ...mailwayWhitelabelHosts()]);
    if (mailway.has(domain)) {
      if (mailwayProjectId === undefined) mailwayProjectId = mailwayProject()?.id ?? null;
      if (mailwayProjectId !== claim.projectId) {
        return `El dominio ${domain} lo utiliza el servicio de correo (Mailway) y no se puede asignar a este servicio.`;
      }
    }
    // Los nombres que Mailway creó en Cloudflare para el administrador
    // (autoconfiguración y webmail del correo) siguen apuntando aquí aunque el
    // dominio de correo o el webmail se borren, o se desconecte Mailway: solo
    // su proyecto (o el administrador) puede asignárselos.
    const deCorreo = getMailwayDnsReserva(domain);
    if (deCorreo && deCorreo.project_id !== claim.projectId) {
      return `El dominio ${domain} está reservado por el administrador de la plataforma y no se puede asignar a este servicio.`;
    }
  }
  return null;
}

/**
 * Motivo por el que un nombre no puede ser el webmail de marca blanca de un
 * cliente de correo (`webmail.<dominio>`), o null si puede serlo.
 *
 * Es la regla inversa a la de los servicios: el puente de Traefik descarta
 * las rutas de Mailway para los dominios que ya sirve Skyway, así que con el
 * nombre de un servicio (de cualquier proyecto, también del mismo) el webmail
 * no llegaría a funcionar, y el del panel nunca se reparte. Lo mismo con un
 * nombre que redirige o se prepublica en un cambio de dominio. Los nombres de
 * la propia instancia de Mailway también los rechaza Mailway; aquí se
 * comprueban antes de llamarle. Como en `domainClaimError`, solo el
 * administrador ve qué servicio (o qué proyecto, en un cambio de dominio)
 * tiene el nombre. No mira los nombres de marca blanca reservados: el propio
 * webmail está entre ellos, y los de otros clientes ya los rechaza Mailway.
 */
export function webmailHostError(hostname: string, opts: { isAdmin: boolean }): string | null {
  const host = hostname.trim().toLowerCase();
  if (panelDomains().has(host)) {
    return `El dominio ${host} es el del panel de Skyway y no se puede utilizar para el webmail.`;
  }
  const servicios = serviceIdsForDomain(host);
  if (servicios.length > 0) {
    return opts.isAdmin
      ? `El dominio ${host} está asignado al servicio ${serviceLabel(servicios[0])}. Retíralo de ese servicio antes de utilizarlo para el webmail.`
      : `El dominio ${host} está asignado a un servicio de Skyway y no se puede utilizar para el webmail.`;
  }
  // Skyway publica por su cuenta los nombres que redirigen tras un cambio de
  // dominio y los que se prepublican, y el puente descarta las rutas de
  // Mailway sobre ellos: el webmail no llegaría a funcionar.
  const enCambio = getDomainRedirect(host) ?? getPrepublished(host);
  if (enCambio) {
    const proyecto = opts.isAdmin ? getProject(enCambio.project_id) : undefined;
    return proyecto
      ? `El dominio ${host} lo utiliza un cambio de dominio del proyecto «${proyecto.name}» (redirección o nombre en preparación) y no se puede utilizar para el webmail.`
      : `El dominio ${host} lo utiliza un cambio de dominio de Skyway (redirección o nombre en preparación) y no se puede utilizar para el webmail.`;
  }
  if (mailwayReservedHosts().includes(host)) {
    return `El dominio ${host} lo utiliza el servicio de correo (Mailway) y no se puede utilizar para el webmail de un cliente.`;
  }
  return null;
}
