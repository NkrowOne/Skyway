/**
 * Lo que necesitan de la base del panel las copias externas
 * (`scripts/copias/copias.sh`, la orden `skyway copias`), que corren en el host
 * y no dependen de que el panel funcione: qué hay que copiar y, tras restaurar
 * en otro servidor, llevar la IP del servidor anterior a la del nuevo. Las
 * ejecuta el orquestador de las copias como root en el host; quien puede
 * ejecutarlas ya administra la máquina.
 *
 *   docker exec skyway node server/dist/tools/copias.js inventario
 *     → stdout: {"formato":1,"producto":"skyway","version":"…","ajustes":{…},"proyectos":[…]}
 *   docker exec skyway node server/dist/tools/copias.js repuntar --ip-anterior <IPv4> --ip-nueva <IPv4> [--aplicar si]
 *     → stdout: {"ok":true,"aplicado":false,"serverIp":{…},"cloudflare":{…}}
 *
 * `inventario` solo lee la base: cada servicio con sus contenedores (réplicas
 * incluidas), sus volúmenes (`serviceVolumeNames`, la misma lista que mide el
 * disco y que borra el borrado del servicio: lo que se añada allí entra solo en
 * las copias), las órdenes de volcado de las bases con copia (las de
 * `backups.ts`, que corren DENTRO del contenedor con las credenciales de su
 * entorno) y la imagen que corre en cada servicio de repositorio (la de su
 * último despliegue correcto). No usa Docker: con el panel parado, el
 * orquestador la lanza con la imagen de Skyway y el volumen de datos, sin el
 * socket.
 *
 * `repuntar` cambia la IP del servidor de Ajustes si era la anterior y, con el
 * token de Ajustes → Cloudflare, el destino de los registros A que apuntaban
 * exactamente a la IP anterior en todas las zonas que ve el token: solo el
 * destino (el proxy, el TTL y el comentario se conservan). Sin `--aplicar si`
 * solo simula y lista lo que cambiaría. Se puede repetir: lo que ya apunta a la
 * IP nueva no se vuelve a tocar. Lo aplicado queda en la auditoría con el
 * actor «sistema».
 *
 * La salida nunca lleva secretos: ni variables, ni tokens, ni la configuración
 * de los servicios (secretos de webhook, argumentos de compilación). Código 1 y
 * el motivo en stderr si algo falla; los avisos van a stderr con el prefijo
 * «Aviso:» y no cambian el código.
 */
import { z } from 'zod';
import { auditSystem } from '../audit';
import { plantillaCopia } from '../backups';
import { CfRegistro, CfZona, CloudflareClient, CloudflareError, ERRORES_GLOBALES } from '../cloudflare';
import { cloudflareConfigurado, tokenCloudflareGuardado } from '../cloudflareconfig';
import { config } from '../config';
import {
  getSetting,
  initDb,
  lastSuccessfulDeployment,
  listProjects,
  listServicesForProjects,
  repuntarRegistroCloudflare,
  setSetting,
} from '../db';
import { configuredReplicas, replicaName, serviceVolumeNames } from '../docker/containers';
import { DatabaseConfig, ImageConfig, ProjectRow, ServiceRow, ServiceType } from '../types';
import { ENTRADA_SALIDA_PROCESO, EntradaSalida, ErrorHerramienta, leerOpciones, mensajeDeError } from './argumentos';

const USO = [
  'Uso:',
  '  copias inventario',
  '  copias repuntar --ip-anterior <IPv4> --ip-nueva <IPv4> [--aplicar si]',
].join('\n');

/* ------------------------------- Inventario ------------------------------- */

export interface ServicioInventario {
  id: string;
  nombre: string;
  slug: string;
  tipo: ServiceType;
  /** Plantilla y versión de una base de datos; null en los demás tipos. */
  plantilla: string | null;
  versionPlantilla: string | null;
  /** Detenido adrede por una persona (`stopped_at`). */
  detenido: boolean;
  /** Nombres canónicos de sus contenedores, réplicas incluidas. */
  contenedores: string[];
  volumenes: string[];
  /** Órdenes de copia de una base con copia, que corren dentro de su contenedor. */
  volcado: { orden: string; restaurar: string; extension: string } | null;
  /** Servicio de repositorio: su último despliegue correcto con imagen (el que corre). */
  despliegue: { id: string; imagen: string; commit: string | null } | null;
  /** Servicio de imagen: la imagen configurada (informativo). */
  imagen: string | null;
}

export interface ProyectoInventario {
  id: string;
  nombre: string;
  slug: string;
  cliente: string | null;
  servicios: ServicioInventario[];
}

export interface InventarioCopias {
  formato: 1;
  producto: 'skyway';
  version: string;
  ajustes: { serverIp: string | null; serverIpv6: string | null; rootDomain: string | null; cloudflare: boolean };
  proyectos: ProyectoInventario[];
}

function ajuste(clave: string): string | null {
  return getSetting(clave)?.trim() || null;
}

function servicioInventario(project: ProjectRow, service: ServiceRow): ServicioInventario {
  const base = service.type === 'database' ? (service.config as DatabaseConfig) : null;
  const copia = plantillaCopia(service);
  const ultimo = service.type === 'git' ? lastSuccessfulDeployment(service.id) : undefined;
  return {
    id: service.id,
    nombre: service.name,
    slug: service.slug,
    tipo: service.type,
    plantilla: base?.template ?? null,
    versionPlantilla: base?.version ?? null,
    detenido: service.stopped_at != null,
    contenedores: Array.from({ length: configuredReplicas(service) }, (_, i) => replicaName(project, service, i + 1)),
    volumenes: serviceVolumeNames(project, service),
    volcado: copia ? { orden: copia.dump, restaurar: copia.restore, extension: copia.ext } : null,
    despliegue: ultimo?.image_tag ? { id: ultimo.id, imagen: ultimo.image_tag, commit: ultimo.commit_sha } : null,
    imagen: service.type === 'image' ? (service.config as ImageConfig).image || null : null,
  };
}

/**
 * Proyectos y servicios tal como los necesitan las copias, sin un solo valor
 * secreto: de cada servicio solo se lee lo que nombra lo que hay que copiar.
 */
export function inventarioCopias(): InventarioCopias {
  const proyectos = listProjects();
  const servicios = listServicesForProjects(proyectos.map((p) => p.id));
  return {
    formato: 1,
    producto: 'skyway',
    version: config.version,
    ajustes: {
      serverIp: ajuste('serverIp'),
      serverIpv6: ajuste('serverIpv6'),
      rootDomain: ajuste('rootDomain'),
      cloudflare: cloudflareConfigurado(),
    },
    proyectos: proyectos.map((p) => ({
      id: p.id,
      nombre: p.name,
      slug: p.slug,
      cliente: p.client ?? null,
      servicios: (servicios.get(p.id) ?? []).map((s) => servicioInventario(p, s)),
    })),
  };
}

function inventario(argv: readonly string[], io: EntradaSalida): number {
  leerOpciones(argv, []);
  io.out(JSON.stringify(inventarioCopias()));
  return 0;
}

/* -------------------------------- Repuntar -------------------------------- */

/**
 * Direcciones que no pueden ser las de un servidor en el DNS: 0.0.0.0/8,
 * 127.0.0.0/8 y de 224.0.0.0 en adelante (multidifusión, reservadas y la de
 * difusión). Una errata aquí cambiaría todos los registros A de todas las
 * zonas, así que se rechaza antes de tocar nada.
 */
function esDireccionDeServidor(ip: string): boolean {
  const primero = Number(ip.split('.')[0]);
  return primero !== 0 && primero !== 127 && primero < 224;
}

/**
 * IPv4 en su forma canónica (sin ceros a la izquierda): es como la guardan
 * Ajustes y Cloudflare, y la comparación con el destino de cada registro es
 * exacta.
 */
const ipv4 = (opcion: string, falta: string) =>
  z
    .string({ required_error: falta })
    .trim()
    .ip({ version: 'v4', message: `La IP de --${opcion} no es una dirección IPv4 válida (por ejemplo, 203.0.113.10).` })
    .refine(
      esDireccionDeServidor,
      `La IP de --${opcion} no es la de un servidor: las direcciones 0.x.x.x, 127.x.x.x y a partir de 224.0.0.0 no se publican en el DNS.`,
    );

const repuntarSchema = z
  .object({
    'ip-anterior': ipv4('ip-anterior', 'Indica la IP anterior del servidor con --ip-anterior.'),
    'ip-nueva': ipv4('ip-nueva', 'Indica la IP nueva del servidor con --ip-nueva.'),
    aplicar: z
      .literal('si', { errorMap: () => ({ message: 'La opción --aplicar solo admite «si». Sin ella, la orden solo simula los cambios.' }) })
      .optional(),
  })
  .refine((o) => o['ip-anterior'] !== o['ip-nueva'], 'La IP nueva es la misma que la anterior: no hay nada que cambiar.');

type EstadoRegistro = 'pendiente' | 'cambiado' | 'error';

interface RegistroRepuntado {
  zona: string;
  nombre: string;
  proxied: boolean;
  estado: EstadoRegistro;
  error?: string;
}

interface CloudflareRepuntado {
  configurado: boolean;
  /** Lo que no se ha podido consultar (las zonas, o los registros de alguna): la lista puede estar incompleta. */
  error: string | null;
  registros: RegistroRepuntado[];
}

const esErrorGlobal = (err: unknown) => err instanceof CloudflareError && ERRORES_GLOBALES.has(err.code);

const mensajeCloudflare = (err: unknown) => (err instanceof CloudflareError ? err.message : mensajeDeError(err));

/**
 * Registros A con la IP anterior en todas las zonas que ve el token y, al
 * aplicar, su cambio de destino. Una zona que no se puede leer no impide
 * cambiar las demás (cada cambio es correcto por sí solo y la orden se puede
 * repetir); un fallo del token o de la conexión sí corta: con el siguiente
 * pasaría lo mismo.
 */
async function repuntarCloudflare(anterior: string, nueva: string, aplicar: boolean): Promise<CloudflareRepuntado> {
  const token = tokenCloudflareGuardado();
  if (!token) return { configurado: false, error: null, registros: [] };
  const cliente = new CloudflareClient(token);

  const errores: string[] = [];
  let zonas: CfZona[] = [];
  try {
    zonas = (await cliente.listZones()).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    errores.push(`No se han podido consultar las zonas: ${mensajeCloudflare(err)}`);
  }
  const encontrados: { zona: CfZona; registro: CfRegistro }[] = [];
  for (const [i, zona] of zonas.entries()) {
    try {
      const registros = await cliente.listRecords(zona.id, { type: 'A' });
      const conLaAnterior = registros.filter((r) => r.type === 'A' && r.content.trim() === anterior);
      for (const registro of conLaAnterior.sort((a, b) => a.name.localeCompare(b.name))) encontrados.push({ zona, registro });
    } catch (err) {
      const restantes = zonas.length - i - 1;
      const corta = esErrorGlobal(err) && restantes > 0;
      errores.push(
        `No se han podido leer los registros de la zona ${zona.name}: ${mensajeCloudflare(err)}` +
          (corta ? ` No se han revisado las ${restantes} zona(s) siguientes.` : ''),
      );
      if (corta) break;
    }
  }

  const registros: RegistroRepuntado[] = [];
  let corte: string | null = null;
  for (const { zona, registro } of encontrados) {
    const entrada: RegistroRepuntado = { zona: zona.name, nombre: registro.name, proxied: registro.proxied, estado: 'pendiente' };
    if (aplicar && corte) {
      entrada.estado = 'error';
      entrada.error = corte;
    } else if (aplicar) {
      try {
        const cambiado = await cliente.cambiarContenido(zona.id, registro.id, nueva);
        repuntarRegistroCloudflare(zona.id, registro.id, anterior, nueva);
        entrada.estado = 'cambiado';
        entrada.proxied = cambiado.proxied;
      } catch (err) {
        entrada.estado = 'error';
        entrada.error = mensajeCloudflare(err);
        if (esErrorGlobal(err)) corte = entrada.error;
      }
    }
    registros.push(entrada);
  }
  return { configurado: true, error: errores.length > 0 ? errores.join(' ') : null, registros };
}

async function repuntar(argv: readonly string[], io: EntradaSalida): Promise<number> {
  const opts = repuntarSchema.parse(leerOpciones(argv, ['ip-anterior', 'ip-nueva', 'aplicar']));
  const anterior = opts['ip-anterior'];
  const nueva = opts['ip-nueva'];
  const aplicar = opts.aplicar === 'si';
  const avisos: string[] = [];

  // Solo si era la anterior: vacía, la IP se detecta sola y en el servidor
  // nuevo ya saldrá la nueva; otra distinta la ha puesto alguien a propósito.
  const antes = ajuste('serverIp');
  const cambia = antes === anterior;
  if (cambia && aplicar) setSetting('serverIp', nueva);
  if (antes && !cambia && antes !== nueva) avisos.push(`La IP del servidor de Ajustes (${antes}) no es la anterior: se mantiene.`);

  const cloudflare = await repuntarCloudflare(anterior, nueva, aplicar);
  if (!cloudflare.configurado) {
    avisos.push(
      'No hay ningún token de Cloudflare configurado (Ajustes → Cloudflare): los registros DNS que apuntan a la IP anterior se cambian en su proveedor.',
    );
  }
  const fallidos = cloudflare.registros.filter((r) => r.estado === 'error');
  const ok = !cloudflare.error && fallidos.length === 0;

  if (aplicar && (cambia || cloudflare.registros.length > 0)) {
    const partes = [`${anterior} → ${nueva}`, cambia ? 'IP del servidor de Ajustes cambiada' : 'IP del servidor de Ajustes sin cambios'];
    if (cloudflare.registros.length > 0) {
      const cambiados = cloudflare.registros.length - fallidos.length;
      partes.push(`${cambiados} registro(s) A cambiado(s) en Cloudflare${fallidos.length > 0 ? `, ${fallidos.length} con error` : ''}`);
    }
    auditSystem('server_ip_repointed', `${partes.join(' · ')}, desde la terminal del servidor`.slice(0, 500), { type: 'system', id: 'server_ip' });
  }

  io.out(JSON.stringify({ ok, aplicado: aplicar, serverIp: { antes, despues: cambia ? nueva : antes, cambia }, cloudflare }));
  for (const aviso of avisos) io.err(`Aviso: ${aviso}`);
  if (cloudflare.error) io.err(`Cloudflare: ${cloudflare.error}`);
  for (const r of fallidos) io.err(`Cloudflare: No se ha podido cambiar el registro A de ${r.nombre} (zona ${r.zona}): ${r.error}`);
  return ok ? 0 : 1;
}

/* --------------------------------- Entrada -------------------------------- */

/** Ejecuta la herramienta y devuelve el código de salida. La base de datos ya debe estar abierta. */
export async function ejecutarCopias(argv: readonly string[], io: EntradaSalida): Promise<number> {
  const [orden, ...resto] = argv;
  try {
    if (orden === 'inventario') return inventario(resto, io);
    if (orden === 'repuntar') return await repuntar(resto, io);
    throw new ErrorHerramienta(USO);
  } catch (err) {
    io.err(mensajeDeError(err));
    return 1;
  }
}

if (require.main === module) {
  initDb();
  void ejecutarCopias(process.argv.slice(2), ENTRADA_SALIDA_PROCESO).then((code) => process.exit(code));
}
