/**
 * Servicios compartidos entre proyectos.
 *
 * Cada proyecto tiene su red privada y en ella un servicio se llama por su
 * slug (`postgresql`). Ese nombre solo existe dentro del proyecto: desde otro,
 * `postgresql` es SU base de datos (o nadie). Compartir un servicio lo conecta
 * también a la red del otro proyecto con un nombre que no puede chocar con los
 * de allí, `<servicio>.<proyecto de origen>` (los slugs no llevan punto), y deja
 * referenciar sus variables como `${{proyecto/servicio.DATABASE_URL}}` con el
 * host ya cambiado por ese nombre.
 *
 * El resto del proyecto de origen sigue aislado: solo se ve lo compartido.
 */
import { getProject, getService, listServiceShares, listSharedIntoProject } from './db';
import { projectNetworkName } from './docker/networks';
import { ProjectRow, ServiceRow } from './types';

/** Nombre DNS de un servicio compartido en la red de los proyectos que lo reciben. */
export function aliasCompartido(service: ServiceRow, origen: ProjectRow): string {
  return `${service.slug}.${origen.slug}`;
}

export interface RedCompartida {
  /** Red privada del proyecto que recibe el servicio. */
  red: string;
  alias: string;
}

/** Redes de otros proyectos a las que hay que conectar las copias de un servicio. */
export function redesCompartidas(service: ServiceRow, origen: ProjectRow): RedCompartida[] {
  const alias = aliasCompartido(service, origen);
  const out: RedCompartida[] = [];
  for (const pid of listServiceShares(service.id)) {
    const destino = getProject(pid);
    if (destino && destino.id !== origen.id) out.push({ red: projectNetworkName(destino), alias });
  }
  return out;
}

export interface ServicioRecibido {
  service: ServiceRow;
  origen: ProjectRow;
  alias: string;
}

/** Servicios de otros proyectos que este proyecto recibe. */
export function serviciosRecibidos(projectId: string): ServicioRecibido[] {
  const out: ServicioRecibido[] = [];
  for (const sid of listSharedIntoProject(projectId)) {
    const service = getService(sid);
    const origen = service ? getProject(service.project_id) : undefined;
    if (service && origen && origen.id !== projectId) out.push({ service, origen, alias: aliasCompartido(service, origen) });
  }
  return out;
}

/** El servicio recibido al que apunta `proyecto/servicio` (por nombre o por slug), si lo hay. */
export function buscarRecibido(recibidos: readonly ServicioRecibido[], scope: string): ServicioRecibido | undefined {
  const corte = scope.indexOf('/');
  if (corte < 0) return undefined;
  const p = scope.slice(0, corte).trim().toLowerCase();
  const s = scope.slice(corte + 1).trim().toLowerCase();
  return recibidos.find(
    (r) =>
      (r.origen.slug === p || r.origen.name.toLowerCase() === p) &&
      (r.service.slug === s || r.service.name.toLowerCase() === s),
  );
}

const URL_RE = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i;

/**
 * Cambia el host interno de un servicio (`slug`) por su nombre compartido en
 * el valor de una de sus variables, y solo donde es un host:
 *
 *  - en una URL, el host de la autoridad (nunca el usuario ni la ruta: en
 *    `postgres://postgres:…@postgres:5432/postgres` solo cambia el tercero);
 *  - `slug:puerto` a secas (`REDIS_ADDR=redis:6379`);
 *  - el valor entero, si la variable es de host (`PGHOST`, `REDIS_HOST`…): un
 *    `PGDATABASE=postgres` de un servicio llamado `postgres` no se toca.
 */
export function reescribirHost(clave: string, valor: string, slug: string, alias: string): string {
  const esHost = (h: string) => h === slug || h === `${slug}.railway.internal`;
  const url = URL_RE.exec(valor);
  if (url) {
    const [, esquema, autoridad, resto] = url;
    const arroba = autoridad.lastIndexOf('@');
    const usuario = arroba >= 0 ? autoridad.slice(0, arroba + 1) : '';
    // Varios hosts separados por comas: una cadena de réplicas de Mongo.
    const hosts = autoridad
      .slice(arroba + 1)
      .split(',')
      .map((hp) => {
        const dos = hp.lastIndexOf(':');
        const host = dos >= 0 ? hp.slice(0, dos) : hp;
        return esHost(host) ? alias + (dos >= 0 ? hp.slice(dos) : '') : hp;
      });
    return esquema + usuario + hosts.join(',') + resto;
  }
  const conPuerto = /^([^:\s/]+):(\d{1,5})$/.exec(valor);
  if (conPuerto && esHost(conPuerto[1])) return `${alias}:${conPuerto[2]}`;
  if (esHost(valor) && /HOST/i.test(clave)) return alias;
  return valor;
}
