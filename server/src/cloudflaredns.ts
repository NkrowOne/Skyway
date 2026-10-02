/**
 * DNS automático en Cloudflare de los dominios de servicios, SOLO para el
 * administrador de la plataforma.
 *
 * Cuando un administrador da de alta dominios nuevos en un servicio (crearlo,
 * añadirlos en Ajustes, una pila o una plantilla con dominio, la importación
 * de Railway) y hay un token de Cloudflare configurado, se crea en su
 * Cloudflare el registro A de cada uno hacia la IP del servidor, sin pisar
 * nada: lo que ya existe se respeta y un conflicto se informa, nunca se toca.
 *
 * Seguridad: el token es del operador y da acceso a SUS zonas. Si lo usara
 * una acción de un cliente (propietario o miembro de un workspace), cualquier
 * cliente podría escribir en las zonas del operador dando de alta como
 * dominio de su servicio un nombre que viva en ellas. Por eso el rol se
 * comprueba aquí dentro, con el usuario de la petición, y no lo decide quien
 * llama: para quien no es administrador no se lee el token, no se consulta la
 * IP y no sale ninguna petición. Un token de API de un administrador cuenta
 * como administrador (lo usan el instalador de Mailway y las automatizaciones
 * del operador).
 *
 * Nunca hace fallar ni bloquea indefinidamente la petición que lo dispara: el
 * servicio ya está creado, todo tiene un plazo total acotado y cualquier fallo
 * vuelve como resultado `error` del dominio afectado.
 *
 * Cada registro creado se anota (`cloudflare_dns_records`) con el proyecto
 * para el que lo creó el administrador: sigue apuntando a este servidor
 * aunque el dominio deje de usarse, así que el nombre queda reservado a ese
 * proyecto (`domainClaimError`) hasta que el administrador borra el registro
 * en Ajustes → Cloudflare (`borrarRegistroCreado`). Sin la reserva, otro
 * cliente podría asignarse después ese nombre del operador y obtener su
 * certificado.
 */
import { FastifyRequest } from 'fastify';
import { audit } from './audit';
import { currentUser } from './auth';
import { CloudflareClient, CloudflareError, CfRegistro, COMENTARIO_SKYWAY, ERRORES_GLOBALES } from './cloudflare';
import { anotarErrorCloudflare, tokenCloudflareGuardado } from './cloudflareconfig';
import {
  deleteCloudflareDnsRecord,
  getCloudflareDnsRecord,
  getProject,
  getService,
  listCloudflareDnsRecords,
  moveCloudflareDnsRecords,
  serviceIdsForDomain,
  upsertCloudflareDnsRecord,
} from './db';
import { getServerIp } from './domains';
import { httpError } from './mailconnect';

export type AccionDns = 'created' | 'kept' | 'conflict' | 'skipped' | 'error';

export interface ResultadoDns {
  domain: string;
  action: AccionDns;
  message: string;
}

/** Plazo total de la operación (todos los dominios) y de cada petición. */
const PLAZO_TOTAL_MS = 20_000;
const PLAZO_PETICION_MS = 8_000;

/** Tipos que deciden a dónde va el tráfico web de un nombre. */
const DIRECCION = new Set(['A', 'AAAA', 'CNAME']);

/** Etiquetas de la auditoría (en español, sin valores secretos). */
const ETIQUETA: Record<AccionDns, string> = {
  created: 'creado',
  kept: 'ya estaba',
  conflict: 'conflicto',
  skipped: 'omitido',
  error: 'error',
};

function describir(registros: CfRegistro[]): string {
  const partes = registros.slice(0, 3).map((r) => `${r.type} hacia ${r.content || '(vacío)'}`);
  const resto = registros.length > 3 ? ` y ${registros.length - 3} más` : '';
  return `${registros.length === 1 ? 'un registro' : 'registros'} ${partes.join(', ')}${resto}`;
}

/** Nombre del comodín que cubriría al dominio dentro de la zona, si lo hay. */
function comodinDe(domain: string, zona: string): string | null {
  if (domain === zona) return null;
  const padre = domain.slice(domain.indexOf('.') + 1);
  return padre === zona || padre.endsWith(`.${zona}`) ? `*.${padre}` : null;
}

async function unDominio(cliente: CloudflareClient, domain: string, ip: string, projectId: string | null): Promise<ResultadoDns> {
  const zona = await cliente.findZoneFor(domain);
  if (!zona) {
    return {
      domain,
      action: 'skipped',
      message: `Sin zona en tu Cloudflare: el token no ve ninguna zona que contenga ${domain}. Crea el registro A hacia ${ip} en tu proveedor de DNS.`,
    };
  }
  const apuntaAqui = (r: CfRegistro) => r.type === 'A' && r.content.trim() === ip;
  const existentes = (await cliente.listRecords(zona.id, { name: domain })).filter((r) => DIRECCION.has(r.type));
  const ajenos = existentes.filter((r) => !apuntaAqui(r));
  if (ajenos.length > 0) {
    return {
      domain,
      action: 'conflict',
      message:
        `Ya hay ${describir(ajenos)} con ese nombre en Cloudflare y no se ha modificado. ` +
        `Si el dominio debe servirlo este servidor, cámbialo a mano por un registro A hacia ${ip}.`,
    };
  }
  const propio = existentes.find(apuntaAqui);
  if (propio) {
    return {
      domain,
      action: 'kept',
      message: `El registro A hacia ${ip} ya existía${propio.proxied ? ' (con el proxy de Cloudflare activado)' : ''}.`,
    };
  }
  // Un comodín que ya apunta aquí cubre el nombre: crear otro registro solo
  // llenaría la zona de duplicados (p. ej., los subdominios del dominio raíz).
  const comodin = comodinDe(domain, zona.name);
  if (comodin) {
    const delComodin = (await cliente.listRecords(zona.id, { name: comodin })).filter((r) => DIRECCION.has(r.type));
    if (delComodin.length > 0 && delComodin.every(apuntaAqui)) {
      return { domain, action: 'kept', message: `Lo cubre el registro comodín ${comodin}, que ya apunta a este servidor.` };
    }
  }
  try {
    const creado = await cliente.createRecord(zona.id, {
      type: 'A',
      name: domain,
      content: ip,
      ttl: 1,
      // Sin proxy: Let's Encrypt valida por HTTP contra este servidor y el
      // operador decide después si lo activa.
      proxied: false,
      comment: COMENTARIO_SKYWAY,
    });
    upsertCloudflareDnsRecord({
      domain,
      zone_id: zona.id,
      zone_name: zona.name,
      record_id: creado.id,
      content: ip,
      project_id: projectId,
    });
  } catch (err) {
    if (err instanceof CloudflareError && err.code === 'cloudflare_identical') {
      return { domain, action: 'kept', message: `El registro A hacia ${ip} ya existía.` };
    }
    if (err instanceof CloudflareError && err.code === 'cloudflare_exists') {
      return { domain, action: 'conflict', message: `${err.message} No se ha modificado nada.` };
    }
    throw err;
  }
  const pendiente = zona.status !== 'active' ? ' La zona todavía no está activa en Cloudflare: el registro funcionará cuando lo esté.' : '';
  return { domain, action: 'created', message: `Registro A hacia ${ip} creado en la zona ${zona.name}.${pendiente}` };
}

/**
 * Aplica el DNS de los dominios con el token indicado. Exportada para las
 * pruebas; las rutas usan `dnsAutomaticoAdmin`, que comprueba el rol.
 * `projectId` es el proyecto al que queda reservado cada registro creado.
 */
export async function aplicarDnsDominios(
  token: string,
  dominios: string[],
  opts: { plazoMs?: number; projectId?: string | null } = {},
): Promise<ResultadoDns[]> {
  const plazoMs = opts.plazoMs ?? PLAZO_TOTAL_MS;
  const { ip } = await getServerIp();
  if (!ip) {
    return dominios.map((domain) => ({
      domain,
      action: 'skipped' as const,
      message: 'No se conoce la IP pública del servidor: indícala en Ajustes → Dominios y TLS para que el registro se cree automáticamente.',
    }));
  }
  const plazo = new AbortController();
  const temporizador = setTimeout(() => plazo.abort(), plazoMs);
  const cliente = new CloudflareClient(token, { signal: plazo.signal, timeoutMs: Math.min(PLAZO_PETICION_MS, plazoMs) });
  const out: ResultadoDns[] = [];
  let global: CloudflareError | null = null;
  let alguno = false;
  try {
    for (const domain of dominios) {
      // Con el token rechazado o el plazo agotado, el resto fallaría igual.
      if (global) {
        out.push({ domain, action: 'error', message: global.message });
        continue;
      }
      try {
        out.push(await unDominio(cliente, domain, ip, opts.projectId ?? null));
        alguno = true;
      } catch (err) {
        if (err instanceof CloudflareError) {
          if (ERRORES_GLOBALES.has(err.code)) global = err;
          out.push({ domain, action: 'error', message: err.message });
        } else {
          out.push({ domain, action: 'error', message: 'Error inesperado al configurar el DNS en Cloudflare.' });
        }
      }
    }
  } finally {
    clearTimeout(temporizador);
  }
  // El administrador ve en Ajustes → Cloudflare si su token ha dejado de valer.
  if (global && global.code.startsWith('cloudflare_token')) anotarErrorCloudflare(global.message);
  else if (alguno) anotarErrorCloudflare(null);
  return out;
}

function normalizar(dominios: readonly string[]): string[] {
  return [...new Set(dominios.map((d) => d.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean))];
}

/**
 * Dominios nuevos de una petición de un administrador, o [] si quien pide no
 * lo es. Cuando un administrador asigna a un proyecto un nombre reservado
 * (creado antes para otro), la reserva pasa a ese proyecto: es él quien
 * decide a quién sirve el registro.
 */
function dominiosDelAdministrador(req: FastifyRequest, dominios: readonly string[], projectId: string): string[] {
  const user = currentUser(req);
  if (!user || user.role !== 'admin') return [];
  const nuevos = normalizar(dominios);
  if (nuevos.length > 0) moveCloudflareDnsRecords(nuevos, projectId);
  return nuevos;
}

/**
 * DNS automático de los dominios NUEVOS de una petición. Devuelve undefined
 * (y no hace nada) si quien pide no es administrador, si no hay token o si no
 * hay dominios; si no, el resultado por dominio, que las rutas devuelven en
 * `dns`. Audita `cloudflare_dns_applied` con el resumen (nunca el token).
 * `projectId` es el proyecto del servicio: los registros creados quedan
 * reservados a él.
 */
export async function dnsAutomaticoAdmin(
  req: FastifyRequest,
  dominios: readonly string[],
  objetivo: { type: string; id: string },
  projectId: string,
): Promise<ResultadoDns[] | undefined> {
  // Lo primero, antes de leer el token o la IP: la regla que protege las
  // zonas del operador no depende de quien llama a esta función.
  const nuevos = dominiosDelAdministrador(req, dominios, projectId);
  if (nuevos.length === 0) return undefined;
  const token = tokenCloudflareGuardado();
  if (!token) return undefined;

  let resultados: ResultadoDns[];
  try {
    resultados = await aplicarDnsDominios(token, nuevos, { projectId });
  } catch (err) {
    // Nada de aquí puede romper el alta, que ya está hecha.
    req.log.warn({ err: (err as Error)?.message }, 'DNS automático en Cloudflare');
    resultados = nuevos.map((domain) => ({
      domain,
      action: 'error' as const,
      message: 'No se ha podido configurar el DNS en Cloudflare. Crea el registro a mano o vuelve a intentarlo.',
    }));
  }
  audit(req, 'cloudflare_dns_applied', {
    ...objetivo,
    detail: resultados
      .map((r) => `${r.domain}: ${ETIQUETA[r.action]}`)
      .join('; ')
      .slice(0, 500),
  });
  return resultados;
}

/**
 * Edición de un servicio sin `domainsBase`: no se sabe si los dominios nuevos
 * los escribe el administrador o son de una lectura anterior (un dominio que
 * el cliente quitó entretanto y que podría volver a poner y quitar a
 * voluntad), así que no se usa el token. Para un administrador con token, la
 * respuesta lo explica por dominio; para cualquier otro, undefined. Nunca
 * sale ninguna petición.
 */
export function dnsSinBase(req: FastifyRequest, dominios: readonly string[], projectId: string): ResultadoDns[] | undefined {
  const nuevos = dominiosDelAdministrador(req, dominios, projectId);
  if (nuevos.length === 0 || !tokenCloudflareGuardado()) return undefined;
  return nuevos.map((domain) => ({
    domain,
    action: 'skipped' as const,
    message:
      'No se ha configurado el DNS automáticamente: al editar un servicio, la petición debe indicar en «domainsBase» los dominios de los que parte, ' +
      'para no crear el registro de un dominio que otra persona haya quitado entretanto. Crea el registro A a mano o repite el cambio con «domainsBase».',
  }));
}

/* ------------------ Registros creados: reserva y limpieza ------------------ */

export interface RegistroCreadoVista {
  domain: string;
  zone: string;
  content: string;
  /** Proyecto al que queda reservado el nombre (null si ya no existe). */
  project: { id: string; name: string } | null;
  /** Servicio que usa hoy el dominio, si alguno. */
  usedBy: { id: string; name: string; project: string } | null;
  createdAt: number;
}

/** Lo que ve Ajustes → Cloudflare: los registros que creó el DNS automático. */
export function registrosCreados(): RegistroCreadoVista[] {
  return listCloudflareDnsRecords().map((r) => {
    const proyecto = r.project_id ? getProject(r.project_id) : undefined;
    const servicio = serviceIdsForDomain(r.domain).map((id) => getService(id)).find(Boolean);
    return {
      domain: r.domain,
      zone: r.zone_name,
      content: r.content,
      project: proyecto ? { id: proyecto.id, name: proyecto.name } : null,
      usedBy: servicio ? { id: servicio.id, name: servicio.name, project: getProject(servicio.project_id)?.name ?? '?' } : null,
      createdAt: r.created_at,
    };
  });
}

export type ResultadoBorrado = 'deleted' | 'gone' | 'released';

/**
 * Borra en Cloudflare un registro que creó el DNS automático y libera el
 * nombre. Solo el administrador (lo exige la ruta). No se toca nada si el
 * dominio sigue asignado a un servicio, ni un registro que alguien ha
 * cambiado desde entonces y que sigue apuntando aquí (quizá lo usa el
 * operador para otra cosa): en ese caso se mantiene la reserva. Si ya no
 * existe o ya apunta a otro sitio, solo se libera el nombre.
 */
export async function borrarRegistroCreado(
  domain: string,
  auditar: (action: string, target: { type: string; id: string; detail: string }) => void,
): Promise<ResultadoBorrado> {
  const fila = getCloudflareDnsRecord(domain);
  if (!fila) throw httpError(404, 'Skyway no tiene anotado ningún registro creado para ese dominio.');
  const servicio = serviceIdsForDomain(fila.domain).map((id) => getService(id)).find(Boolean);
  if (servicio) {
    throw httpError(
      409,
      `El dominio ${fila.domain} sigue asignado al servicio «${getProject(servicio.project_id)?.name ?? '?'} / ${servicio.name}». Quítalo del servicio antes de borrar su registro.`,
    );
  }
  const token = tokenCloudflareGuardado();
  if (!token) throw httpError(400, 'Configura el token de Cloudflare para borrar el registro.');
  const cliente = new CloudflareClient(token, { timeoutMs: PLAZO_PETICION_MS });
  const actual = await cliente.getRecord(fila.zone_id, fila.record_id);
  let resultado: ResultadoBorrado;
  if (!actual) {
    resultado = 'gone';
  } else if (actual.type !== 'A' || actual.content.trim() !== fila.content) {
    // Ya no apunta a este servidor: no hay nada que reservar ni que borrar.
    resultado = 'released';
  } else if (actual.comment !== COMENTARIO_SKYWAY) {
    throw httpError(
      409,
      `El registro de ${fila.domain} se ha modificado en Cloudflare desde que lo creó Skyway y sigue apuntando a este servidor: no se ha borrado. Si ya no se utiliza, bórralo en Cloudflare y vuelve a intentarlo.`,
    );
  } else {
    await cliente.deleteRecord(fila.zone_id, fila.record_id);
    resultado = 'deleted';
  }
  deleteCloudflareDnsRecord(fila.domain);
  const detalle = { deleted: 'registro borrado', gone: 'ya no existía', released: 'ya apuntaba a otro sitio; nombre liberado' }[resultado];
  auditar('cloudflare_dns_record_deleted', { type: 'system', id: 'cloudflare', detail: `${fila.domain}: ${detalle}` });
  return resultado;
}
