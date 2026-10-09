/**
 * DNS automático en Cloudflare de los dominios de servicios, SOLO para el
 * administrador de la plataforma.
 *
 * Cuando un administrador da de alta dominios nuevos en un servicio (crearlo,
 * añadirlos en Ajustes, una pila o una plantilla con dominio, la importación
 * de Railway) y hay un token de Cloudflare configurado, se crea en su
 * Cloudflare el registro A de cada uno hacia la IP del servidor, con el proxy
 * de Cloudflare si la web va por HTTPS, sin pisar nada: lo que ya existe se
 * respeta y un conflicto se informa, nunca se toca.
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
import { CloudflareClient, CloudflareError, CfRegistro, CfZona, COMENTARIO_SKYWAY, ERRORES_GLOBALES } from './cloudflare';
import { anotarErrorCloudflare, tokenCloudflareGuardado } from './cloudflareconfig';
import {
  deleteCloudflareDnsRecord,
  getCloudflareDnsRecord,
  getProject,
  getSetting,
  getService,
  listCloudflareDnsRecords,
  moveCloudflareDnsRecords,
  moveMailwayDnsReservas,
  serviceIdsForDomain,
  upsertCloudflareDnsRecord,
} from './db';
import { getServerIp, VerificacionCloudflare } from './domains';
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
function reservarSiEsDeSkyway(registro: CfRegistro, zona: CfZona, domain: string, ip: string, projectId: string | null): void {
  if (registro.comment !== COMENTARIO_SKYWAY || getCloudflareDnsRecord(domain)) return;
  upsertCloudflareDnsRecord({ domain, zone_id: zona.id, zone_name: zona.name, record_id: registro.id, content: ip, project_id: projectId });
}

/**
 * ¿Lleva el proxy de Cloudflare (nube naranja) el registro que crea Skyway?
 * Sí si la web va por HTTPS: caché, protección y la red de Cloudflare delante,
 * y Let's Encrypt valida igual porque Cloudflare deja pasar
 * `/.well-known/acme-challenge/` hasta este servidor. Sin HTTPS, no: este
 * servidor solo serviría la web por HTTP y Cloudflare solo podría entregarla
 * en el modo «Flexible».
 */
function registrosConProxy(): boolean {
  return !!getSetting('letsencryptEmail');
}

/**
 * ¿Cubre el certificado gratuito de Cloudflare (Universal SSL) este nombre?
 * Solo la zona y un nivel de subdominio (`ejemplo.com` y `*.ejemplo.com`):
 * con el proxy, uno más profundo (`api.tienda.ejemplo.com`) daría un error de
 * certificado a los visitantes, salvo con un certificado avanzado de pago.
 * Ese va sin proxy.
 */
export function cubiertoPorCertificadoCloudflare(domain: string, zona: string): boolean {
  const nombre = domain.trim().toLowerCase().replace(/\.$/, '');
  const raiz = zona.trim().toLowerCase().replace(/\.$/, '');
  if (nombre === raiz) return true;
  if (!nombre.endsWith(`.${raiz}`)) return false;
  return !nombre.slice(0, -(raiz.length + 1)).includes('.');
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
  const todos = await cliente.listRecords(zona.id, { name: domain });
  const existentes = todos.filter((r) => DIRECCION.has(r.type));
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
    reservarSiEsDeSkyway(propio, zona, domain, ip, projectId);
    return {
      domain,
      action: 'kept',
      message: `El registro A hacia ${ip} ya existía${propio.proxied ? ' (con el proxy de Cloudflare activado)' : ' (sin el proxy de Cloudflare)'}.`,
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
  const conHttps = registrosConProxy();
  const cubierto = cubiertoPorCertificadoCloudflare(domain, zona.name);
  const proxied = conHttps && cubierto;
  try {
    const creado = await cliente.createRecord(zona.id, {
      type: 'A',
      name: domain,
      content: ip,
      ttl: 1,
      proxied,
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
      const identico = (await cliente.listRecords(zona.id, { name: domain })).find(apuntaAqui);
      if (identico) reservarSiEsDeSkyway(identico, zona, domain, ip, projectId);
      return { domain, action: 'kept', message: `El registro A hacia ${ip} ya existía.` };
    }
    if (err instanceof CloudflareError && err.code === 'cloudflare_exists') {
      return { domain, action: 'conflict', message: `${err.message} No se ha modificado nada.` };
    }
    throw err;
  }
  const pendiente = zona.status !== 'active' ? ' La zona todavía no está activa en Cloudflare: el registro funcionará cuando lo esté.' : '';
  const conProxy = proxied
    ? ', con el proxy de Cloudflare'
    : conHttps
      ? `, sin el proxy de Cloudflare: su certificado gratuito solo cubre ${zona.name} y un nivel de subdominio`
      : '';
  return { domain, action: 'created', message: `Registro A hacia ${ip} creado en la zona ${zona.name}${conProxy}.${pendiente}` };
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

/* ------------------- Activar o desactivar el proxy ------------------- */

export interface ResultadoProxy {
  domain: string;
  /** Registros a los que se ha cambiado el proxy (0 si ya estaban así). */
  changed: number;
  message: string;
}

/**
 * «Activar proxy en Cloudflare» y «Desactivar proxy en Cloudflare»: pone o
 * quita el proxy (nube naranja) en los registros A de un dominio que apuntan
 * a este servidor. Activarlo pone la web detrás de Cloudflare (caché,
 * protección); desactivarlo es la salida para un servicio que no funciona
 * detrás del proxy (subidas de más de 100 MB o peticiones de más de 100 s en
 * el plan gratuito de Cloudflare).
 *
 * Son las únicas modificaciones de un registro existente que hace Skyway, y
 * solo por un clic expreso del administrador (lo exige la ruta): el DNS
 * automático al guardar sigue sin tocar nada de lo que ya existe. Se limitan
 * a lo mínimo:
 * - solo registros A/AAAA con ese nombre exacto (nunca otros nombres);
 * - solo envían `proxied` (ni el destino ni el tipo cambian);
 * - si algún registro afectado apunta a otro sitio (otra IP o un AAAA, que no
 *   puede ser este servidor), no se modifica ninguno y se explica: cambiar el
 *   proxy solo a una parte dejaría el nombre a medias. Al activarlo cuentan
 *   todos los registros del nombre (con el proxy, Cloudflare repartiría el
 *   tráfico entre ellos); al desactivarlo, los que lo tienen.
 * - activarlo exige HTTPS en Skyway: sin él, Cloudflare solo podría entregar
 *   la web en el modo «Flexible».
 */
export async function cambiarProxyCloudflare(domain: string, proxied: boolean): Promise<ResultadoProxy> {
  const accion = proxied ? 'activar' : 'desactivar';
  const token = tokenCloudflareGuardado();
  if (!token) throw httpError(400, `Configura el token de Cloudflare en Ajustes → Cloudflare para ${accion} el proxy.`);
  if (proxied && !registrosConProxy()) {
    throw httpError(
      409,
      'Para activar el proxy de Cloudflare, configura antes HTTPS (correo de Let\'s Encrypt en Ajustes → Dominios y TLS): sin él, Cloudflare solo podría entregar la web en el modo «Flexible».',
    );
  }
  const { ip } = await getServerIp();
  if (!ip) throw httpError(400, 'No se conoce la IP pública del servidor: indícala en Ajustes → Dominios y TLS.');
  const cliente = new CloudflareClient(token, { timeoutMs: PLAZO_PETICION_MS });
  const zona = await cliente.findZoneFor(domain);
  if (!zona) {
    throw httpError(404, `El token de Cloudflare no ve ninguna zona que contenga ${domain}. ${proxied ? 'Activa' : 'Desactiva'} el proxy en el panel de Cloudflare.`);
  }
  if (proxied && !cubiertoPorCertificadoCloudflare(domain, zona.name)) {
    throw httpError(
      409,
      `El certificado gratuito de Cloudflare solo cubre ${zona.name} y un nivel de subdominio: con el proxy, ${domain} daría un error de certificado a los visitantes. Si tienes un certificado avanzado de Cloudflare que lo cubra, activa el proxy en el panel de Cloudflare.`,
    );
  }
  const delNombre = (await cliente.listRecords(zona.id, { name: domain })).filter((r) => r.name === domain);
  const direcciones = delNombre.filter((r) => r.type === 'A' || r.type === 'AAAA');
  if (direcciones.length === 0) {
    const cname = delNombre.find((r) => r.type === 'CNAME');
    throw httpError(
      cname ? 409 : 404,
      cname
        ? `${domain} es un CNAME hacia ${cname.content || '(vacío)'} y no se ha modificado. ${proxied ? 'Activa' : 'Desactiva'} el proxy en el panel de Cloudflare.`
        : `No hay ningún registro A de ${domain} en la zona ${zona.name}.`,
    );
  }
  const apuntaAqui = (r: CfRegistro) => r.type === 'A' && r.content.trim() === ip;
  const afectados = proxied ? direcciones : direcciones.filter((r) => r.proxied);
  const ajenos = afectados.filter((r) => !apuntaAqui(r));
  if (ajenos.length > 0) {
    throw httpError(
      409,
      proxied
        ? `Hay ${describir(ajenos)} con ese nombre que no apunta a este servidor (${ip}): no se ha modificado nada. Revisa los registros de ${domain} en Cloudflare.`
        : `Hay ${describir(ajenos)} con el proxy activado que no apunta a este servidor (${ip}): no se ha modificado nada. Revisa los registros de ${domain} en Cloudflare.`,
    );
  }
  const cambiar = afectados.filter((r) => r.proxied !== proxied);
  for (const r of cambiar) await cliente.cambiarProxy(zona.id, r.id, proxied);
  const hecho = proxied ? 'activado' : 'desactivado';
  return {
    domain,
    changed: cambiar.length,
    message:
      cambiar.length > 0
        ? `Proxy ${hecho} en ${cambiar.length === 1 ? 'el registro A' : `${cambiar.length} registros A`} de ${domain}. El cambio puede tardar unos minutos en propagarse.`
        : `El registro A de ${domain} ya ${proxied ? 'tiene' : 'no tiene'} el proxy activado.`,
  };
}

/* --------------- Comprobar a dónde lleva un nombre con proxy --------------- */

/** Plazo total de la comprobación (todas las consultas a la API). */
const PLAZO_VERIFICACION_MS = 10_000;

/**
 * Comprobación de un nombre con el proxy de Cloudflare para la vista del
 * administrador: desde fuera solo se ven las IP de Cloudflare, así que se
 * pregunta a su API (solo lectura) a dónde lleva el registro. Sigue un CNAME
 * (hasta tres saltos, en zonas que vea el token) y, si el nombre no tiene
 * ningún registro propio, el comodín más cercano (la misma regla que el DNS
 * automático). null si no se puede saber: sin token, sin IP, una zona que el
 * token no ve o que aún no está activa en Cloudflare (sus registros todavía no
 * deciden nada), sin registros de dirección o un fallo de la API. `proxied` es
 * el del nombre (o de su comodín): el que decide si el tráfico pasa por
 * Cloudflare. Nunca crea, cambia ni reserva nada.
 */
export async function verificarEnCloudflare(domain: string): Promise<VerificacionCloudflare> {
  const token = tokenCloudflareGuardado();
  if (!token) return null;
  const { ip } = await getServerIp();
  if (!ip) return null;
  const plazo = new AbortController();
  const temporizador = setTimeout(() => plazo.abort(), PLAZO_VERIFICACION_MS);
  const cliente = new CloudflareClient(token, { signal: plazo.signal, timeoutMs: PLAZO_PETICION_MS });
  try {
    let nombre = domain.trim().toLowerCase().replace(/\.$/, '');
    let proxied: boolean | null = null;
    for (let salto = 0; salto < 4; salto++) {
      const zona = await cliente.findZoneFor(nombre);
      if (!zona || zona.status !== 'active') return null;
      const todos = await cliente.listRecords(zona.id, { name: nombre });
      let direcciones = todos.filter((r) => DIRECCION.has(r.type));
      if (todos.length === 0) {
        for (const comodin of comodinesDe(nombre, zona.name)) {
          const delComodin = await cliente.listRecords(zona.id, { name: comodin });
          if (delComodin.length === 0) continue;
          direcciones = delComodin.filter((r) => DIRECCION.has(r.type));
          break;
        }
      }
      if (direcciones.length === 0) return null;
      if (proxied === null) proxied = direcciones.some((r) => r.proxied);
      const cname = direcciones.find((r) => r.type === 'CNAME');
      if (cname) {
        nombre = cname.content.trim().toLowerCase().replace(/\.$/, '');
        continue;
      }
      const ajenos = direcciones.filter((r) => !(r.type === 'A' && r.content.trim() === ip));
      return ajenos.length > 0 ? { estado: 'otro', detalle: describir(ajenos) } : { estado: 'aqui', proxied };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(temporizador);
  }
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
