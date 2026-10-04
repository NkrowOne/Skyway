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
 *
 * Reemplazo (traer una web desde otro hosting): el alta automática nunca
 * toca un registro existente, pero el administrador puede pedir, con su
 * confirmación expresa de los registros exactos que va a sustituir, que el
 * A/AAAA/CNAME de ese nombre se cambie por el A hacia este servidor
 * (`planReemplazo` y `reemplazarRegistros`). Solo ese nombre, solo esos
 * tipos y nunca un nombre de la plataforma; lo borrado se guarda para
 * restaurarlo (`restaurarReemplazo`).
 */
import { FastifyRequest } from 'fastify';
import { audit } from './audit';
import { currentUser } from './auth';
import { CloudflareClient, CloudflareError, CfRegistro, CfZona, COMENTARIO_SKYWAY, ERRORES_GLOBALES } from './cloudflare';
import { anotarErrorCloudflare, tokenCloudflareGuardado } from './cloudflareconfig';
import {
  deleteCloudflareDnsRecord,
  getCloudflareDnsRecord,
  getDomainRedirect,
  getMailwayDnsReserva,
  getPrepublished,
  getProject,
  getService,
  getSetting,
  listCloudflareDnsRecords,
  moveCloudflareDnsRecords,
  moveMailwayDnsReservas,
  serviceIdsForDomain,
  upsertCloudflareDnsRecord,
} from './db';
import { panelDomains } from './domainguard';
import { getServerIp, getServerIpv6, mismaIpv6 } from './domains';
import { httpError } from './mailconnect';
import { mailwayReservedHosts } from './mailway';
import { mailwayPublishedHosts, mailwayWhitelabelHosts } from './mailwaytraefik';

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

/**
 * Comodines de la zona que podrían cubrir el dominio, del más cercano
 * (`*.padre`) al de la propia zona. Por la regla del «encloser» más próximo
 * (RFC 4592) solo se aplica el más cercano que exista, y solo si el nombre no
 * tiene ningún registro propio.
 */
function comodinesDe(domain: string, zona: string): string[] {
  if (domain === zona || !domain.endsWith(`.${zona}`)) return [];
  const out: string[] = [];
  let padre = domain.slice(domain.indexOf('.') + 1);
  for (;;) {
    out.push(`*.${padre}`);
    if (padre === zona) return out;
    padre = padre.slice(padre.indexOf('.') + 1);
  }
}

/**
 * Lo que dice el comodín más cercano de un nombre que no tiene ningún
 * registro: `conflict` si apunta a otro sitio (crear el A cambiaría a dónde va
 * hoy su tráfico), `kept` si es el del padre y ya apunta aquí, o null si no
 * hay comodín que lo resuelva y hay que crear el A. Un comodín de un nivel
 * superior quizá no se aplique (si existe algún nombre intermedio): ante la
 * duda, si apunta a otro sitio se informa como conflicto, que nunca pisa
 * nada; si apunta aquí, el A explícito no cambia nada y asegura el nombre.
 */
async function segunComodin(
  cliente: CloudflareClient,
  zona: CfZona,
  domain: string,
  ip: string,
  apuntaAqui: (r: CfRegistro) => boolean,
): Promise<ResultadoDns | null> {
  const comodines = comodinesDe(domain, zona.name);
  for (let i = 0; i < comodines.length; i++) {
    const registros = await cliente.listRecords(zona.id, { name: comodines[i] });
    if (registros.length === 0) continue;
    const web = registros.filter((r) => DIRECCION.has(r.type));
    const ajenos = web.filter((r) => !apuntaAqui(r));
    if (ajenos.length > 0) {
      return {
        domain,
        action: 'conflict',
        message:
          `Ese nombre lo resuelve hoy el comodín ${comodines[i]} (${describir(ajenos)}) y un registro A cambiaría a dónde va su tráfico: no se ha modificado nada. ` +
          `Si el dominio debe servirlo este servidor, crea a mano un registro A hacia ${ip}.`,
      };
    }
    if (web.length > 0 && i === 0) {
      return { domain, action: 'kept', message: `Lo cubre el registro comodín ${comodines[i]}, que ya apunta a este servidor.` };
    }
    return null;
  }
  return null;
}

/**
 * Un A hacia este servidor con el comentario de Skyway lo creó este mismo
 * token, quizá en un intento cuya respuesta se perdió (conexión cortada o
 * plazo vencido tras enviar la petición). Si aún no está anotado, se reserva
 * igual que al crearlo: si no, otro cliente podría asignarse un nombre que
 * apunta aquí y que nadie más ve en Ajustes → Cloudflare.
 */
/**
 * ¿Lleva este registro el tráfico de la web a este servidor? Un A hacia su IP
 * o, si el administrador la ha indicado, un AAAA hacia su IPv6. Un AAAA
 * cualquiera es del hosting anterior: con él, los visitantes con IPv6 y Let's
 * Encrypt siguen llegando allí.
 */
function apuntaAEsteServidor(ip: string): (r: CfRegistro) => boolean {
  const ipv6 = getServerIpv6();
  return (r) => (r.type === 'A' && r.content.trim() === ip) || (r.type === 'AAAA' && !!ipv6 && mismaIpv6(r.content.trim(), ipv6));
}

function reservarSiEsDeSkyway(registro: CfRegistro, zona: CfZona, domain: string, ip: string, projectId: string | null): void {
  if (registro.comment !== COMENTARIO_SKYWAY || getCloudflareDnsRecord(domain)) return;
  upsertCloudflareDnsRecord({ domain, zone_id: zona.id, zone_name: zona.name, record_id: registro.id, content: ip, project_id: projectId });
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
  const apuntaAqui = apuntaAEsteServidor(ip);
  const todos = await cliente.listRecords(zona.id, { name: domain });
  const existentes = todos.filter((r) => DIRECCION.has(r.type));
  const ajenos = existentes.filter((r) => !apuntaAqui(r));
  if (ajenos.length > 0) {
    return {
      domain,
      action: 'conflict',
      message:
        `Ya hay ${describir(ajenos)} con ese nombre en Cloudflare y no se ha modificado. ` +
        `Si el dominio debe servirlo este servidor, utiliza «Reemplazar en Cloudflare» para revisar y sustituir esos registros por un A hacia ${ip}, o cámbialos a mano.`,
    };
  }
  // El A propio; un AAAA hacia la IPv6 del servidor no basta (Skyway crea el A).
  const propio = existentes.find((r) => r.type === 'A' && apuntaAqui(r));
  if (propio) {
    reservarSiEsDeSkyway(propio, zona, domain, ip, projectId);
    return {
      domain,
      action: 'kept',
      message: `El registro A hacia ${ip} ya existía${propio.proxied ? ' (con el proxy de Cloudflare activado)' : ''}.`,
    };
  }
  // Un comodín solo resuelve un nombre que no tiene ningún registro propio:
  // con un TXT o un MX, el nombre no tiene dirección y hay que crear el A.
  // Sin ninguno, el comodín decide: si ya apunta aquí, crear otro registro
  // solo llenaría la zona de duplicados; si apunta a otro sitio, crearlo
  // cambiaría el destino de un nombre que ya está en uso.
  if (todos.length === 0) {
    const porComodin = await segunComodin(cliente, zona, domain, ip, apuntaAqui);
    if (porComodin) return porComodin;
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
      // Cloudflare dice que ya existe uno idéntico: si es de Skyway, se anota.
      const identico = (await cliente.listRecords(zona.id, { name: domain })).find((r) => r.type === 'A' && apuntaAqui(r));
      if (identico) reservarSiEsDeSkyway(identico, zona, domain, ip, projectId);
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
  if (nuevos.length > 0) {
    moveCloudflareDnsRecords(nuevos, projectId);
    moveMailwayDnsReservas(nuevos, projectId);
  }
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
  /** Registros del hosting anterior que sustituyó (se pueden restaurar), o null. */
  replaced: { type: string; content: string; proxied: boolean }[] | null;
  /**
   * Con `replaced`: true si el A hacia este servidor lo creó el reemplazo (y
   * restaurar lo retira); false si ya estaba y restaurar lo conserva.
   */
  replacedCreated: boolean | null;
}

/** Lo que ve Ajustes → Cloudflare: los registros que creó el DNS automático. */
export function registrosCreados(): RegistroCreadoVista[] {
  return listCloudflareDnsRecords().map((r) => {
    const proyecto = r.project_id ? getProject(r.project_id) : undefined;
    const servicio = serviceIdsForDomain(r.domain).map((id) => getService(id)).find(Boolean);
    const copia = leerReemplazo(r.replaced);
    return {
      domain: r.domain,
      zone: r.zone_name,
      content: r.content,
      project: proyecto ? { id: proyecto.id, name: proyecto.name } : null,
      usedBy: servicio ? { id: servicio.id, name: servicio.name, project: getProject(servicio.project_id)?.name ?? '?' } : null,
      createdAt: r.created_at,
      replaced: copia?.previos.map((p) => ({ type: p.type, content: p.content, proxied: p.proxied })) ?? null,
      replacedCreated: copia ? copia.creado : null,
    };
  });
}

export type ResultadoBorrado = 'deleted' | 'gone' | 'released';

/**
 * Borra en Cloudflare un registro que creó el DNS automático y libera el
 * nombre. Solo el administrador (lo exige la ruta). No se toca nada si el
 * dominio sigue asignado a un servicio o redirige a otro nombre tras un cambio
 * de dominio (`redirecciones.ts`), ni un registro que alguien ha
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
  // Tras un cambio de dominio el nombre viejo ya no lo tiene ningún servicio,
  // pero sigue en uso: responde con la redirección al nuevo, que sin su
  // registro A dejaría de llegar. Lo mismo el nombre nuevo mientras se
  // prepara: su registro lo crea el asistente y ningún servicio lo tiene
  // hasta pasar; sin él no se obtendría su certificado ni se podría pasar.
  if (getDomainRedirect(fila.domain)) {
    throw httpError(409, `El dominio ${fila.domain} redirige a otro nombre; quita antes la redirección.`);
  }
  if (getPrepublished(fila.domain)) {
    throw httpError(409, `El dominio ${fila.domain} se está preparando en un cambio de dominio; cancela antes el cambio.`);
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

/* ------------- Reemplazo del registro de la web del hosting anterior ------------- */

/** Registro de dirección tal como lo ve el administrador antes de sustituirlo. */
export interface RegistroWeb {
  id: string;
  type: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

/** Lo que se guarda para poder restaurar la zona (columna `replaced`). */
export interface ReemplazoGuardado {
  /** Los registros borrados, con todo lo necesario para volver a crearlos. */
  previos: { type: string; content: string; proxied: boolean; ttl: number; comment: string | null }[];
  /** true si el A hacia este servidor lo creó el reemplazo (y restaurar lo retira). */
  creado: boolean;
  /** El nombre ya estaba reservado antes del reemplazo (restaurar conserva la reserva). */
  reservaPrevia?: boolean;
  at: number;
}

export interface PlanReemplazo {
  domain: string;
  zone: string | null;
  ip: string | null;
  /** A/AAAA/CNAME del nombre exacto que no apuntan aquí: lo que se sustituiría. */
  actuales: RegistroWeb[];
  /** Ya hay un A hacia este servidor: solo se retiran los demás. */
  conservaA: boolean;
  /** Avisos que hay que leer antes de confirmar (proxy, zona pendiente…). */
  avisos: string[];
  /** Por qué no se puede reemplazar desde aquí; null si se puede. */
  motivo: string | null;
}

export function leerReemplazo(json: string | null | undefined): ReemplazoGuardado | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as ReemplazoGuardado;
    return v && Array.isArray(v.previos) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Motivo por el que el nombre no se puede reemplazar aunque lo pida el
 * administrador, o null. Nunca los de la plataforma (el panel, el dominio
 * raíz de los subdominios, los de Mailway en cualquier estado) ni uno
 * reservado a otro proyecto: el reemplazo reapunta un nombre que hoy funciona
 * y, con ellos, se llevaría el tráfico del panel, del correo o de otro cliente.
 */
function motivoNoReemplazable(domain: string, projectId: string): string | null {
  if (panelDomains().has(domain)) return `${domain} es el dominio del panel de Skyway: no se reemplaza desde aquí.`;
  const raiz = (getSetting('rootDomain') ?? '').trim().toLowerCase();
  if (raiz && domain === raiz) return `${domain} es el dominio raíz de los subdominios de los servicios: no se reemplaza desde aquí.`;
  const correo = new Set([...mailwayReservedHosts(), ...mailwayPublishedHosts(), ...mailwayWhitelabelHosts()]);
  if (correo.has(domain)) return `${domain} lo utiliza el servicio de correo (Mailway): no se reemplaza desde aquí.`;
  const reservaCorreo = getMailwayDnsReserva(domain);
  if (reservaCorreo && reservaCorreo.project_id !== projectId) {
    return `${domain} es un nombre que Mailway creó para el correo de otro proyecto: no se reemplaza desde aquí.`;
  }
  const reserva = getCloudflareDnsRecord(domain);
  if (reserva && reserva.project_id !== projectId) {
    return `${domain} está reservado a otro proyecto (su registro lo creó el DNS automático para él): no se reemplaza desde aquí.`;
  }
  return null;
}

function clienteAdministrador(): CloudflareClient {
  const token = tokenCloudflareGuardado();
  if (!token) throw httpError(400, 'Configura el token de Cloudflare en Ajustes → Cloudflare para reemplazar el registro.');
  return new CloudflareClient(token, { timeoutMs: PLAZO_PETICION_MS });
}

/** Zona, IP y registros de dirección actuales de un nombre, o el motivo por el que no se puede seguir. */
async function estadoDelNombre(
  cliente: CloudflareClient,
  domain: string,
): Promise<{ zona: CfZona; ip: string; existentes: CfRegistro[]; ajenos: CfRegistro[]; conservaA: boolean } | { motivo: string }> {
  const { ip } = await getServerIp();
  if (!ip) return { motivo: 'No se conoce la IP pública del servidor: indícala en Ajustes → Dominios y TLS.' };
  const zona = await cliente.findZoneFor(domain);
  if (!zona) return { motivo: `El token de Cloudflare no ve ninguna zona que contenga ${domain}.` };
  const apuntaAqui = apuntaAEsteServidor(ip);
  const existentes = (await cliente.listRecords(zona.id, { name: domain })).filter((r) => DIRECCION.has(r.type));
  const ajenos = existentes.filter((r) => !apuntaAqui(r));
  const conservaA = existentes.some((r) => r.type === 'A' && apuntaAqui(r));
  return { zona, ip, existentes, ajenos, conservaA };
}

const aVista = (r: CfRegistro): RegistroWeb => ({ id: r.id, type: r.type, content: r.content, proxied: r.proxied, ttl: r.ttl });

function describirRegistro(r: { type: string; content: string; proxied: boolean }): string {
  return `${r.type} ${r.content || '(vacío)'}${r.proxied ? ' (proxy)' : ''}`;
}

/**
 * Lo que haría el reemplazo de un nombre, sin tocar nada: la revisión que el
 * administrador confirma. Solo el administrador (lo exige la ruta).
 */
export async function planReemplazo(domain: string, projectId: string): Promise<PlanReemplazo> {
  const d = domain.trim().toLowerCase();
  const vacio: PlanReemplazo = { domain: d, zone: null, ip: null, actuales: [], conservaA: false, avisos: [], motivo: null };
  const motivo = motivoNoReemplazable(d, projectId);
  if (motivo) return { ...vacio, motivo };
  const estado = await estadoDelNombre(clienteAdministrador(), d);
  if ('motivo' in estado) return { ...vacio, motivo: estado.motivo };
  const { zona, ip, ajenos, conservaA } = estado;
  const avisos: string[] = [];
  if (ajenos.some((r) => r.proxied)) {
    avisos.push(
      'El registro actual tiene activado el proxy de Cloudflare. El nuevo se crea sin proxy para que Let\'s Encrypt pueda validar el dominio; ' +
        'si lo necesitas, actívalo después en Cloudflare.',
    );
  }
  if (ajenos.some((r) => r.type === 'AAAA') && !getServerIpv6()) {
    avisos.push(
      'Se retira también el registro AAAA (IPv6): si se quedara, los visitantes con IPv6 y Let\'s Encrypt seguirían llegando al hosting anterior.',
    );
  }
  if (zona.status !== 'active') avisos.push('La zona todavía no está activa en Cloudflare: el cambio funcionará cuando lo esté.');
  return {
    domain: d,
    zone: zona.name,
    ip,
    actuales: ajenos.map(aVista),
    conservaA,
    avisos,
    motivo: ajenos.length === 0 ? `No hay nada que reemplazar: ${d} no tiene registros A, AAAA ni CNAME que apunten a otro sitio.` : null,
  };
}

/**
 * Sustituye en un solo lote los A/AAAA/CNAME del nombre que confirmó el
 * administrador por el A hacia este servidor, y guarda lo borrado. Si los
 * registros del nombre ya no son exactamente los confirmados (alguien los ha
 * cambiado entre la revisión y la confirmación), no toca nada: el
 * administrador tiene que volver a revisarlos.
 */
export async function reemplazarRegistros(
  domain: string,
  projectId: string,
  confirmados: readonly { id: string; type: string; content: string }[],
  auditar: (action: string, target: { type: string; id: string; detail: string }) => void,
  objetivo: { type: string; id: string },
): Promise<ResultadoDns> {
  const d = domain.trim().toLowerCase();
  const motivo = motivoNoReemplazable(d, projectId);
  if (motivo) throw httpError(409, motivo);
  const cliente = clienteAdministrador();
  const estado = await estadoDelNombre(cliente, d);
  if ('motivo' in estado) throw httpError(409, estado.motivo);
  const { zona, ip, ajenos, conservaA, existentes } = estado;
  const clave = (r: { id: string; type: string; content: string }) => `${r.id}|${r.type.toUpperCase()}|${r.content.trim()}`;
  const esperado = new Set(confirmados.map(clave));
  if (ajenos.length === 0 || ajenos.length !== esperado.size || !ajenos.every((r) => esperado.has(clave(r)))) {
    throw httpError(
      409,
      `Los registros de ${d} en Cloudflare han cambiado desde la revisión (o no hay nada que reemplazar). Vuelve a revisarlos antes de confirmar.`,
    );
  }
  let resultado: { deletes: CfRegistro[]; posts: CfRegistro[] };
  try {
    resultado = await cliente.batch(zona.id, {
      deletes: ajenos.map((r) => ({ id: r.id })),
      posts: conservaA ? [] : [{ type: 'A', name: d, content: ip, ttl: 1, proxied: false, comment: COMENTARIO_SKYWAY }],
    });
  } catch (err) {
    if (err instanceof CloudflareError) throw httpError(err.statusCode, `No se ha modificado nada en Cloudflare: ${err.message}`);
    throw err;
  }
  const a = conservaA ? existentes.find((r) => r.type === 'A' && r.content.trim() === ip) : resultado.posts[0];
  const borrados = ajenos.map((r) => ({ type: r.type, content: r.content, proxied: r.proxied, ttl: r.ttl, comment: r.comment }));
  // Un segundo reemplazo del mismo nombre (alguien añadió después otro AAAA
  // o CNAME) se suma al primero: si sustituyera la copia, el registro del
  // hosting original se perdería y restaurar ya no devolvería la zona a como
  // estaba. Qué hizo el primero con el A y con la reserva sigue valiendo.
  const filaPrevia = getCloudflareDnsRecord(d);
  const copiaPrevia = leerReemplazo(filaPrevia?.replaced);
  const clavePrevio = (p: { type: string; content: string }) => `${p.type.toUpperCase()}|${p.content.trim().toLowerCase()}`;
  const guardado: ReemplazoGuardado = copiaPrevia
    ? {
        previos: [
          ...copiaPrevia.previos,
          ...borrados.filter((b) => !copiaPrevia.previos.some((p) => clavePrevio(p) === clavePrevio(b))),
        ],
        creado: copiaPrevia.creado,
        reservaPrevia: copiaPrevia.reservaPrevia,
        at: copiaPrevia.at,
      }
    : { previos: borrados, creado: !conservaA, reservaPrevia: !!filaPrevia, at: Date.now() };
  if (a) {
    upsertCloudflareDnsRecord({
      domain: d,
      zone_id: zona.id,
      zone_name: zona.name,
      record_id: a.id,
      content: ip,
      project_id: projectId,
      replaced: JSON.stringify(guardado),
    });
  }
  const sustituidos = ajenos.map(describirRegistro).join(', ');
  auditar('cloudflare_dns_replaced', { ...objetivo, detail: `${d}: ${sustituidos} → A ${ip}`.slice(0, 500) });
  return {
    domain: d,
    action: 'created',
    message:
      `Se ha sustituido ${sustituidos} por un registro A hacia ${ip} en la zona ${zona.name}. ` +
      'Puedes restaurar los registros anteriores en Ajustes → Cloudflare.',
  };
}

export type ResultadoRestauracion = { restaurados: string[]; retirado: boolean };

/**
 * Deshace un reemplazo: vuelve a crear los registros del hosting anterior (con
 * su proxy, su TTL y su comentario) y retira el A que creó Skyway, en un solo
 * lote. Solo si el nombre está como lo dejó el reemplazo: si alguien ha
 * añadido o cambiado registros de dirección desde entonces, no se toca nada.
 * El nombre deja de estar reservado si ya no apunta aquí.
 */
export async function restaurarReemplazo(
  domain: string,
  auditar: (action: string, target: { type: string; id: string; detail: string }) => void,
): Promise<ResultadoRestauracion> {
  const fila = getCloudflareDnsRecord(domain);
  const copia = leerReemplazo(fila?.replaced);
  if (!fila || !copia) throw httpError(404, 'Skyway no tiene guardado ningún reemplazo de ese dominio.');
  const cliente = clienteAdministrador();
  const actuales = (await cliente.listRecords(fila.zone_id, { name: fila.domain })).filter((r) => DIRECCION.has(r.type));
  const nuestro = actuales.find((r) => r.id === fila.record_id);
  // Un AAAA hacia la IPv6 de este servidor ya estaba antes del reemplazo (no
  // es ajeno, así que el reemplazo lo conservó): no impide restaurar y se
  // queda, como estaba.
  const apuntaAqui = apuntaAEsteServidor(fila.content);
  const otros = actuales.filter((r) => r.id !== fila.record_id && !(r.type === 'AAAA' && apuntaAqui(r)));
  if (otros.length > 0) {
    throw httpError(
      409,
      `${fila.domain} tiene ahora en Cloudflare otros registros de dirección (${otros.map(describirRegistro).join(', ')}): no se ha restaurado nada. Revísalos en Cloudflare.`,
    );
  }
  if (nuestro && (nuestro.type !== 'A' || nuestro.content.trim() !== fila.content)) {
    throw httpError(409, `El registro A de ${fila.domain} se ha modificado en Cloudflare desde el reemplazo: no se ha restaurado nada.`);
  }
  const retirar = copia.creado && nuestro ? [{ id: nuestro.id }] : [];
  try {
    await cliente.batch(fila.zone_id, {
      deletes: retirar,
      posts: copia.previos.map((p) => ({
        type: p.type,
        name: fila.domain,
        content: p.content,
        ttl: p.ttl,
        proxied: p.proxied,
        ...(p.comment ? { comment: p.comment } : {}),
      })),
    });
  } catch (err) {
    if (err instanceof CloudflareError) throw httpError(err.statusCode, `No se ha modificado nada en Cloudflare: ${err.message}`);
    throw err;
  }
  // Con el A retirado el nombre ya no apunta aquí: no hay nada que reservar.
  // Si el A ya estaba antes del reemplazo, la zona vuelve a como estaba, y la
  // reserva también: la de siempre si la había; si no, ninguna.
  if (copia.creado || !copia.reservaPrevia) deleteCloudflareDnsRecord(fila.domain);
  else upsertCloudflareDnsRecord({ ...fila, replaced: null });
  const restaurados = copia.previos.map(describirRegistro);
  auditar('cloudflare_dns_restored', {
    type: 'system',
    id: 'cloudflare',
    detail: `${fila.domain}: ${restaurados.join(', ')}${retirar.length ? ` (retirado A ${fila.content})` : ''}`.slice(0, 500),
  });
  return { restaurados, retirado: retirar.length > 0 };
}
