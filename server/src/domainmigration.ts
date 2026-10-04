/**
 * Asistente «Cambiar de dominio» de un proyecto (dominio.es → dominio2.es):
 * la web, sus variables y, si el proyecto tiene el correo en Mailway, el
 * correo (que orquesta Mailway con su API de cambio de dominio).
 *
 * Fases (`domain_migrations.estado`):
 *
 *   preparando ⇄ lista ──Pasar──▶ pasando ──▶ pasada ──(Dar de baja | Terminar)──▶ dando_de_baja ──▶ terminada
 *        └──Cancelar──▶ cancelada                │
 *                                                └──Volver──▶ volviendo ──▶ lista
 *
 * - **Preparar** no despliega nada: los nombres nuevos se sirven antes de
 *   pasar con el contenedor que ya está en marcha (prepublicación por el
 *   proveedor HTTP de Traefik, `redirecciones.ts`), en cuanto su DNS apunta
 *   aquí, para que su certificado exista ANTES del cambio.
 * - **Pasar** cambia en una transacción los dominios de los servicios (en su
 *   sitio: el principal pasa a ser el nuevo), las variables (con instantánea
 *   para deshacer clave a clave) y crea las redirecciones del nombre viejo al
 *   nuevo; después despliega los servicios afectados. El correo pasa antes, en
 *   Mailway: si falla, no se toca la web.
 * - **Volver** deshace lo anterior, pero los nombres nuevos se siguen
 *   sirviendo como secundarios: una redirección permanente que un navegador
 *   ya guardó no debe acabar en un error.
 * - **Dar de baja** (con correo) actualiza antes el usuario SMTP de las
 *   aplicaciones que envían con un buzón pendiente y las vuelve a desplegar
 *   con la imagen en marcha; solo si eso termina bien pide la baja a Mailway.
 *
 * Las acciones dejan el estado intermedio guardado antes de empezar y, si algo
 * falla, el error en la fila: la interfaz ofrece «Reintentar» y todo es
 * idempotente. Un reinicio a mitad deja el error de `marcarCambiosInterrumpidos`.
 * El estado del correo vive SOLO en Mailway: aquí se consulta en vivo.
 */
import crypto from 'crypto';
import { FastifyRequest } from 'fastify';
import { getDomain } from 'tldts';
import { audit, auditSystem } from './audit';
import { currentUser } from './auth';
import { cloudflareConfigurado } from './cloudflareconfig';
import { dnsAutomaticoAdmin, ResultadoDns } from './cloudflaredns';
import {
  AmbitoVariableMigracion,
  bumpConfigRev,
  deleteDomainMigration,
  deleteDomainRedirectHosts,
  deleteDomainRedirects,
  deletePrepublished,
  DomainMigrationRow,
  EstadoMigracionDominio,
  getCloudflareDnsRecord,
  getDeployment,
  getDomainMigration as getCambioSkyway,
  getEnv,
  getMailwayLink,
  getManagedEnv,
  getOpenDomainMigration,
  getPrepublished,
  getProjectVars,
  getService,
  getSetting,
  hashEnvValue,
  insertDomainMigration,
  insertDomainRedirects,
  listDeployments,
  listDomainMigrations,
  listDomainMigrationsByEstado,
  listDomainRedirects,
  listServices,
  listSnapshots,
  markPrepublishedDns,
  ModoHostMigracion,
  patchEnv,
  patchProjectVars,
  purgeSnapshots,
  putSnapshot,
  reservarNombresMailway,
  ServicioMigracion,
  setDomainMigrationServicio,
  transaction,
  updateDomainMigration,
  updateService,
  upsertPrepublished,
  writeManagedEnv,
} from './db';
import { awaitDeployment, triggerDeploy } from './deploy/deployer';
import { imageExists } from './docker/containers';
import { domainClaimError } from './domainguard';
import { checkDomain, getServerIp } from './domains';
import {
  anadirBloqueWordpress,
  AvisoSinMapa,
  avisosDeVariables,
  CambioPropuesto,
  mensajeSinMapa,
  mensajeUsuario,
  planificar,
  ValorVariable,
} from './envreplace';
import { appPasswordName, ownedSummary, refrescarVariablesCorreo, requireLink } from './mailconnect';
import {
  appendWebRecords,
  CambioDominioVista,
  cancelDomainMigration,
  checkDomainMigration,
  createDomainMigration,
  getDomainMigration as getCambioMailway,
  getInfo,
  getZoneFile,
  mailwayConfigured,
  MailwayDomain,
  MailwayError,
  MailwaySummary,
  PlanCambioDominio,
  planDomainMigration,
  projectExternalRef,
  retireDomainMigration,
  rollbackDomainMigration,
  stripWebRecords,
  switchDomainMigration,
  updateMailboxLogin,
} from './mailway';
import { envStateOf, managedUnchanged } from './managedenv';
import { markManualAction } from './monitor';
import { isWorkspaceActive, moduleAllowedForProject, workspaceOfProject } from './quota';
import { comprobarTlsLocal } from './redirecciones';
import { tlsEnabled } from './tls';
import { GitConfig, ImageConfig, MailwayLinkRow, ProjectRow, ServiceRow } from './types';

// ---------- tipos de la API ----------

export type ModoHost = ModoHostMigracion;
export type AmbitoVariable = AmbitoVariableMigracion;

export interface HostPlan {
  serviceId: string;
  from: string;
  to: string;
  modo: ModoHost;
}

export interface Clave {
  ambito: AmbitoVariable;
  serviceId: string | null;
  key: string;
}

export type CorreoDisponible = 'si' | 'no_vinculado' | 'sin_dominio' | 'mailway_antiguo';

/** Un cambio de variable tal como lo ve la interfaz (los argumentos de compilación, sin su valor). */
export interface CambioVariableVista {
  ambito: AmbitoVariable;
  serviceId: string | null;
  serviceName: string | null;
  key: string;
  ocurrencias: number;
  /** null en los argumentos de compilación: la API nunca devuelve su valor (`maskBuildArgs`). */
  antes: string | null;
  despues: string | null;
  gestionada: string | null;
  excluida: boolean;
}

/** Nota de una variable: una mención que no se cambia o un usuario para entrar en el correo. */
export interface NotaVariable {
  ambito: AmbitoVariable;
  serviceId: string | null;
  key: string;
  texto: string;
}

export interface PlanVariablesVista {
  cambios: CambioVariableVista[];
  avisosSinMapa: AvisoSinMapa[];
  usuarios: AvisoSinMapa[];
  notas: NotaVariable[];
  /** WordPress: se fija su URL en `WORDPRESS_CONFIG_EXTRA` (sin ello, un bucle de redirecciones). */
  wordpress: { serviceId: string; serviceName: string; url: string }[];
  huella: string;
}

export interface PlanSkyway {
  fromDomain: string;
  toDomain: string;
  soloWeb: boolean;
  hosts: (HostPlan & { serviceName: string; error: string | null })[];
  dnsWeb: { host: string; ip: string | null; automatico: boolean }[];
  correoDisponible: CorreoDisponible;
  correo: PlanCambioDominio | null;
  variables: PlanVariablesVista;
  /** Servicios que se volverán a desplegar al pasar. */
  servicios: { serviceId: string; nombre: string; reinicio: boolean }[];
  avisos: string[];
  bloqueos: string[];
  /** Huella combinada: la creación la exige para no aplicar otra cosa que lo revisado. */
  expect: string;
}

export type EstadoDnsHost = 'ok' | 'pendiente' | 'desconocido';
export type EstadoCertificado = 'ok' | 'pendiente' | 'desconocido' | 'sin_tls';

export interface Compuerta {
  id: 'dns_web' | 'certificados' | 'correo';
  ok: boolean;
  bloquea: boolean;
  titulo: string;
  detalle: string;
}

export interface MigracionSkyway {
  id: string;
  projectId: string;
  fromDomain: string;
  toDomain: string;
  soloWeb: boolean;
  estado: EstadoMigracionDominio;
  paso: string;
  error: string | null;
  hosts: (HostPlan & { serviceName: string; dns: EstadoDnsHost; certificado: EstadoCertificado; detalle: string })[];
  compuertas: Compuerta[];
  servicios: { serviceId: string; nombre: string; despliegue: { id: string; estado: string } | null; estado: string; error: string | null }[];
  redirecciones: { host: string; toHost: string; permanenteDesde: number }[];
  correo: CambioDominioVista | null;
  /** Variables que cambiarán al pasar (solo antes de pasar): la confirmación las enseña y envía su huella. */
  variables: PlanVariablesVista | null;
  /** Servicios que se volverán a desplegar al pasar (solo antes de pasar). */
  alPasar: { serviceId: string; nombre: string; reinicio: boolean }[] | null;
  /** IP a la que tienen que apuntar los registros A de los nombres nuevos. */
  ipServidor: string | null;
  avisos: string[];
  puedePasar: boolean;
  puedeVolver: boolean;
  puedeCancelar: boolean;
  puedeDarDeBaja: boolean;
  puedeTerminar: boolean;
  fechas: { creada: number; pasada: number | null; terminada: number | null };
}

// ---------- errores ----------

/** Error de una acción con código estable: la ruta responde `{error, code}`. */
export class ErrorCambio extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ErrorCambio';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const ERROR_ESTADO = 'Esta acción no está disponible en el estado actual del cambio de dominio.';
const PLAN_CAMBIADO = 'Algo ha cambiado desde la vista previa. Revisa el resumen y vuelve a intentarlo.';
export const INTERRUMPIDO = 'Interrumpido por un reinicio de Skyway. Pulsa «Reintentar».';
const SIETE_DIAS_MS = 7 * 24 * 60 * 60_000;
/** La baja espera a que las aplicaciones que envían correo se desplieguen con su usuario nuevo. */
const PLAZO_DESPLIEGUE_BAJA_MS = 15 * 60_000;
/** El correo de la vista se consulta en vivo a Mailway, pero no en cada sondeo de la interfaz. */
const CACHE_CORREO_MS = 10_000;
/**
 * Nombres que no son de la web: los publica Mailway (webmail de marca blanca,
 * autoconfiguración, MTA-STS) o son del servidor de correo. El cambio del
 * correo los crea él mismo en el dominio nuevo.
 */
const PREFIJOS_CORREO = ['webmail.', 'autoconfig.', 'autodiscover.', 'mta-sts.', 'mail.'];
const ESTADOS_EN_CURSO: readonly EstadoMigracionDominio[] = ['pasando', 'volviendo', 'dando_de_baja'];

function yaHayUnoAbierto(abierta: DomainMigrationRow): string {
  return `Este proyecto ya tiene un cambio de dominio abierto (${abierta.from_domain} → ${abierta.to_domain}). Termínalo o cancélalo antes de empezar otro.`;
}

function errorEstado(): ErrorCambio {
  return new ErrorCambio(409, 'migration_state', ERROR_ESTADO);
}

function mensajeDe(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Error inesperado.';
}

// ---------- utilidades ----------

function normalizarNombre(s: string): string {
  return s.trim().toLowerCase().replace(/\.$/, '');
}

/** ¿Es `host` el dominio `d` o un subdominio suyo? */
function cuelgaDe(host: string, d: string): boolean {
  return host === d || host.endsWith(`.${d}`);
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function dominiosDe(service: ServiceRow): string[] {
  const d = (service.config as { domains?: unknown }).domains;
  return Array.isArray(d) ? d.filter((x): x is string => typeof x === 'string') : [];
}

function sinRepetidos(lista: string[]): string[] {
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const d of lista) {
    const k = normalizarNombre(d);
    if (!k || vistos.has(k)) continue;
    vistos.add(k);
    out.push(d);
  }
  return out;
}

/** Hosts que cambian (redirigir o servir). */
function hostsActivos(hosts: readonly HostPlan[]): HostPlan[] {
  return hosts.filter((h) => h.modo !== 'no_cambiar');
}

/**
 * Dominios del servicio tras pasar: cada nombre que cambia se sustituye EN SU
 * SITIO (el primero es el principal: `PUBLIC_URL` pasa al nuevo) y, en modo
 * «servir», el viejo se sigue sirviendo al final de la lista, sin redirigir.
 */
function dominiosTrasPasar(actuales: string[], hosts: readonly HostPlan[]): string[] {
  const porFrom = new Map(hostsActivos(hosts).map((h) => [h.from, h]));
  const out: string[] = [];
  const alFinal: string[] = [];
  for (const d of actuales) {
    const h = porFrom.get(normalizarNombre(d));
    if (!h) {
      out.push(d);
      continue;
    }
    out.push(h.to);
    if (h.modo === 'servir') alFinal.push(d);
  }
  return sinRepetidos([...out, ...alFinal]);
}

/**
 * Dominios del servicio al volver: cada nombre nuevo vuelve a su viejo en su
 * sitio y los nuevos quedan al final. Se calcula sobre la lista ACTUAL (no la
 * instantánea): lo que alguien haya añadido o quitado después de pasar se
 * conserva.
 */
function dominiosTrasVolver(actuales: string[], hosts: readonly HostPlan[]): string[] {
  const activos = hostsActivos(hosts);
  const porTo = new Map(activos.map((h) => [h.to, h]));
  const restaurados = actuales.map((d) => porTo.get(normalizarNombre(d))?.from ?? d);
  return sinRepetidos([...restaurados, ...activos.map((h) => h.to)]);
}

function usaVolumenes(service: ServiceRow): boolean {
  const cfg = service.config as { volumes?: unknown[]; hostPort?: number | null };
  return (Array.isArray(cfg.volumes) && cfg.volumes.length > 0) || !!cfg.hostPort;
}

function esWordpress(service: ServiceRow): boolean {
  return service.type === 'image' && (service.config as ImageConfig).stack === 'wordpress';
}

function esquemaWeb(): 'https' | 'http' {
  return tlsEnabled() ? 'https' : 'http';
}

// ---------- cerrojo por proyecto ----------

/**
 * Mutex en memoria por proyecto (el mismo patrón que `withLock` de Mailway):
 * dos acciones del asistente sobre el mismo proyecto se serializan, así que
 * ninguna lee un estado que otra está cambiando. No es reentrante.
 */
const colas = new Map<string, Promise<void>>();

async function withLockProyecto<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const anterior = colas.get(projectId) ?? Promise.resolve();
  let liberar: () => void = () => {};
  const turno = new Promise<void>((r) => {
    liberar = r;
  });
  const cola = anterior.then(() => turno);
  colas.set(projectId, cola);
  await anterior;
  try {
    return await fn();
  } finally {
    liberar();
    if (colas.get(projectId) === cola) colas.delete(projectId);
  }
}

// ---------- tareas en segundo plano ----------

/** Lo que sigue tras responder (esperar despliegues, la baja): las pruebas esperan a que termine. */
const tareas = new Set<Promise<void>>();

function enSegundoPlano(fn: () => Promise<void>): void {
  const p = fn()
    .catch(() => {
      /* cada tarea deja su error en la fila del cambio */
    })
    .finally(() => tareas.delete(p));
  tareas.add(p);
}

/** Espera a que terminen las tareas en segundo plano del asistente (pruebas y herramientas). */
export async function esperarTareasCambioDominio(): Promise<void> {
  while (tareas.size > 0) await Promise.all([...tareas]);
}

// ---------- cachés ----------

/** Vista del correo por id del cambio en Mailway. */
const cacheCorreo = new Map<string, { at: number; vista: CambioDominioVista }>();

interface EstadoHostWeb {
  dns: EstadoDnsHost;
  certificado: EstadoCertificado;
  detalle: string;
}
/** Última comprobación de los nombres nuevos de cada cambio (`check`). */
const cacheWeb = new Map<string, Map<string, EstadoHostWeb>>();
/** Avisos del último «Volver» (variables que no se han restaurado por haber cambiado a mano). */
const avisosVolver = new Map<string, string[]>();

/** Solo para las pruebas: olvida lo que se guarda en memoria. */
export function resetCambioDominioCaches(): void {
  cacheCorreo.clear();
  cacheWeb.clear();
  avisosVolver.clear();
}

function guardarCorreo(vista: CambioDominioVista): CambioDominioVista {
  cacheCorreo.set(vista.id, { at: Date.now(), vista });
  return vista;
}

// ---------- correo del proyecto ----------

interface ContextoCorreo {
  disponible: CorreoDisponible;
  link: MailwayLinkRow | null;
  summary: MailwaySummary | null;
  dominio: MailwayDomain | null;
}

/**
 * ¿Tiene el proyecto el correo de `fromDomain` en Mailway, y admite Mailway el
 * cambio de dominio? Antes de usar el token de administración de Skyway se
 * comprueba que el cliente sigue siendo el de este proyecto (`ownedSummary`)
 * y que el dominio es suyo: el token lo puede todo en Mailway.
 */
async function contextoCorreo(project: ProjectRow, fromDomain: string, isAdmin: boolean): Promise<ContextoCorreo> {
  const nada: ContextoCorreo = { disponible: 'no_vinculado', link: null, summary: null, dominio: null };
  if (!mailwayConfigured() || !moduleAllowedForProject(project.id, 'mail', isAdmin)) return nada;
  const link = getMailwayLink(project.id);
  if (!link) return nada;
  const summary = await ownedSummary(project, link);
  const dominio = summary.domains.find((d) => normalizarNombre(d.domain) === fromDomain) ?? null;
  if (!dominio) return { disponible: 'sin_dominio', link, summary, dominio: null };
  const info = await getInfo();
  return { disponible: info.features?.domainMigrations ? 'si' : 'mailway_antiguo', link, summary, dominio };
}

/**
 * El cambio de Mailway de este cambio, comprobando que sigue siendo del
 * cliente vinculado al proyecto: si el proyecto se ha vinculado a otro
 * cliente, el cambio de antes ya no es suyo y no se toca con el token.
 */
async function correoDelCambio(project: ProjectRow, row: DomainMigrationRow, isAdmin: boolean): Promise<{ link: MailwayLinkRow; mid: string }> {
  const mid = row.mailway_migration_id;
  if (!mid) throw errorEstado();
  if (!moduleAllowedForProject(project.id, 'mail', isAdmin)) {
    throw new ErrorCambio(403, 'module_disabled', 'El módulo «Correo» no está activo en este workspace: solo la administración puede continuar este cambio de dominio.');
  }
  const link = requireLink(project);
  await ownedSummary(project, link);
  if (row.mailway_client_id && row.mailway_client_id !== link.client_id) {
    throw new ErrorCambio(
      409,
      'migration_other_client',
      'El correo de este proyecto está vinculado ahora a otro cliente de Mailway: el cambio de dominio del correo ya no se puede gestionar desde aquí.',
    );
  }
  return { link, mid };
}

/** Vista del correo en Mailway (con caché de 10 s salvo `fresca`), comprobando que es del cliente del cambio. */
async function vistaCorreo(row: DomainMigrationRow, fresca = false): Promise<CambioDominioVista> {
  const mid = row.mailway_migration_id!;
  const cache = cacheCorreo.get(mid);
  if (!fresca && cache && Date.now() - cache.at < CACHE_CORREO_MS) return cache.vista;
  const vista = await getCambioMailway(mid);
  if (row.mailway_client_id && vista.clientId !== row.mailway_client_id) {
    throw new MailwayError('http', 'La respuesta de Mailway no corresponde al cliente de este cambio de dominio.', 502);
  }
  return guardarCorreo(vista);
}

/** Parte local de una dirección. */
function parteLocal(email: string): string {
  const i = email.lastIndexOf('@');
  return i > 0 ? email.slice(0, i).toLowerCase() : email.toLowerCase();
}

/**
 * Buzones y alias que se mudan, de dirección vieja a nueva. Antes de pasar,
 * del plan de Mailway (buzones y alias del dominio anterior); después, ya no
 * están en el anterior y se deducen de los buzones de la vista.
 */
async function direccionesDelCambio(
  row: DomainMigrationRow,
  vista: CambioDominioVista | null,
  isAdmin: boolean,
): Promise<{ from: string; to: string }[]> {
  if (!vista) return [];
  if (['preparando', 'listo', 'pasando'].includes(vista.estado) && vista.desde.domainId) {
    const plan = await planDomainMigration(vista.desde.domainId, row.to_domain, { soloCliente: !isAdmin });
    return [...plan.buzones, ...plan.alias].map((x) => ({ from: x.de.toLowerCase(), to: x.a.toLowerCase() }));
  }
  return vista.buzones.lista.map((b) => {
    const local = parteLocal(b.email);
    return { from: `${local}@${row.from_domain}`, to: `${local}@${row.to_domain}` };
  });
}

// ---------- mapa de hosts ----------

/**
 * Mapa por defecto: cada nombre de un servicio (no base de datos) igual a
 * `from` o que cuelga de él pasa al mismo nombre bajo `to`, redirigiendo.
 */
export function mapaHostsPorDefecto(projectId: string, fromDomain: string, toDomain: string): HostPlan[] {
  const out: HostPlan[] = [];
  for (const s of listServices(projectId)) {
    if (s.type === 'database') continue;
    for (const d of dominiosDe(s)) {
      const host = normalizarNombre(d);
      if (!cuelgaDe(host, fromDomain)) continue;
      if (PREFIJOS_CORREO.some((p) => host.startsWith(p))) continue;
      out.push({ serviceId: s.id, from: host, to: `${host.slice(0, host.length - fromDomain.length)}${toDomain}`, modo: 'redirigir' });
    }
  }
  return out;
}

/**
 * Valida el mapa: el nombre viejo es del servicio y cuelga del dominio
 * actual; el nuevo cuelga del dominio nuevo, no se repite y se puede asignar
 * al servicio (`domainClaimError`, como al editar sus dominios).
 */
function validarHosts(
  project: ProjectRow,
  hosts: readonly HostPlan[],
  fromDomain: string,
  toDomain: string,
  isAdmin: boolean,
): (HostPlan & { serviceName: string; error: string | null })[] {
  const servicios = new Map(listServices(project.id).map((s) => [s.id, s]));
  const nuevos = new Map<string, number>();
  const vistos = new Set<string>();
  for (const h of hostsActivos(hosts)) nuevos.set(normalizarNombre(h.to), (nuevos.get(normalizarNombre(h.to)) ?? 0) + 1);
  return hosts.map((raw) => {
    const h: HostPlan = { serviceId: raw.serviceId, from: normalizarNombre(raw.from), to: normalizarNombre(raw.to), modo: raw.modo };
    const s = servicios.get(h.serviceId);
    const base = { ...h, serviceName: s?.name ?? '?' };
    if (!s || s.type === 'database') return { ...base, error: 'El servicio no existe en este proyecto.' };
    const clave = `${h.serviceId}\u0000${h.from}`;
    if (vistos.has(clave)) return { ...base, error: `${h.from} está dos veces en el mapa de nombres.` };
    vistos.add(clave);
    const actuales = dominiosDe(s).map(normalizarNombre);
    if (!actuales.includes(h.from)) return { ...base, error: `${h.from} ya no es un dominio de este servicio.` };
    if (!cuelgaDe(h.from, fromDomain)) return { ...base, error: `${h.from} no es ${fromDomain} ni un subdominio suyo.` };
    if (h.modo === 'no_cambiar') return { ...base, error: null };
    if (!cuelgaDe(h.to, toDomain)) return { ...base, error: `El nombre nuevo tiene que ser ${toDomain} o un subdominio suyo.` };
    if ((nuevos.get(h.to) ?? 0) > 1) return { ...base, error: `${h.to} está repetido como nombre nuevo.` };
    const conflicto = domainClaimError([h.to], { projectId: project.id, serviceId: s.id, isAdmin, current: dominiosDe(s) });
    return { ...base, error: conflicto };
  });
}

// ---------- variables ----------

/**
 * Valores de las variables del proyecto que el cambio puede tocar: las
 * compartidas, las de cada servicio (no las bases de datos, que no se vuelven
 * a desplegar) y los argumentos de compilación. Una variable que escribió
 * Skyway y nadie ha cambiado lleva su origen: se reescribe conservándolo.
 */
function valoresVariables(projectId: string): ValorVariable[] {
  const out: ValorVariable[] = [];
  for (const [key, valor] of Object.entries(getProjectVars(projectId))) {
    out.push({ ambito: 'project', serviceId: null, key, valor, origen: null });
  }
  for (const s of listServices(projectId)) {
    if (s.type === 'database') continue;
    const state = envStateOf(s);
    for (const [key, valor] of Object.entries(state.env)) {
      out.push({ ambito: 'service', serviceId: s.id, key, valor, origen: managedUnchanged(state, key) ? state.managed[key].origin : null });
    }
    const args = s.type === 'git' ? (s.config as GitConfig).buildArgs : undefined;
    for (const [key, valor] of Object.entries(args ?? {})) {
      if (typeof valor === 'string') out.push({ ambito: 'build', serviceId: s.id, key, valor, origen: null });
    }
  }
  return out;
}

interface PlanVariablesInterno {
  vista: PlanVariablesVista;
  /** Los cambios con sus valores (también los de compilación): solo para aplicarlos. */
  cambios: CambioPropuesto[];
}

function planVariables(
  projectId: string,
  hosts: readonly HostPlan[],
  direcciones: { from: string; to: string }[],
  fromDomain: string,
  excluidas: readonly Clave[],
): PlanVariablesInterno {
  const activos = hostsActivos(hosts);
  const plan = planificar(valoresVariables(projectId), { hosts: activos.map((h) => ({ from: h.from, to: h.to })), direcciones }, fromDomain, {
    excluidas,
  });
  const servicios = new Map(listServices(projectId).map((s) => [s.id, s]));
  const nombre = (id: string | null) => (id ? (servicios.get(id)?.name ?? '?') : null);
  const notas: NotaVariable[] = [];
  for (const a of plan.avisosSinMapa) {
    for (const n of a.nombres) notas.push({ ambito: a.ambito, serviceId: a.serviceId, key: a.key, texto: mensajeSinMapa(n, a.key) });
  }
  for (const a of plan.usuarios) {
    for (const n of a.nombres) notas.push({ ambito: a.ambito, serviceId: a.serviceId, key: a.key, texto: mensajeUsuario(n, a.key) });
  }
  const wordpress: PlanVariablesVista['wordpress'] = [];
  for (const sid of new Set(activos.map((h) => h.serviceId))) {
    const s = servicios.get(sid);
    if (!s || !esWordpress(s)) continue;
    const principal = dominiosTrasPasar(dominiosDe(s), activos.filter((h) => h.serviceId === sid))[0];
    if (principal) wordpress.push({ serviceId: sid, serviceName: s.name, url: `${esquemaWeb()}://${principal}` });
  }
  return {
    cambios: plan.cambios,
    vista: {
      cambios: plan.cambios.map((c) => ({
        ambito: c.ambito,
        serviceId: c.serviceId,
        serviceName: nombre(c.serviceId),
        key: c.key,
        ocurrencias: c.ocurrencias,
        antes: c.ambito === 'build' ? null : c.antes,
        despues: c.ambito === 'build' ? null : c.despues,
        gestionada: c.gestionada,
        excluida: c.excluida,
      })),
      avisosSinMapa: plan.avisosSinMapa,
      usuarios: plan.usuarios,
      notas,
      wordpress,
      huella: plan.huella,
    },
  };
}

/**
 * Avisos informativos según las variables y las pilas del proyecto: lo que el
 * cambio no puede hacer por sí solo (dar de alta la URL nueva en un proveedor
 * externo, corregir las URL guardadas en una base de datos).
 */
function avisosDelProyecto(projectId: string, hosts: readonly HostPlan[], fromDomain: string, toDomain: string): string[] {
  const claves = valoresVariables(projectId).map((v) => v.key);
  const servicios = listServices(projectId);
  const pilas = servicios
    .map((s) => (s.config as { stack?: string }).stack)
    .filter((p): p is string => typeof p === 'string' && p !== 'wordpress');
  const activos = hostsActivos(hosts);
  const principal = activos[0];
  const out = avisosDeVariables(claves, pilas, principal?.to ?? toDomain, principal?.from ?? fromDomain);
  // La orden de WordPress, con los nombres del propio WordPress (no los de otro servicio).
  for (const s of servicios.filter(esWordpress)) {
    const suyo = activos.find((h) => h.serviceId === s.id);
    if (suyo) out.push(...avisosDeVariables([], ['wordpress'], suyo.to, suyo.from));
  }
  return out;
}

/** Servicios que se volverán a desplegar al pasar (y al volver). */
function serviciosAfectados(
  projectId: string,
  hosts: readonly HostPlan[],
  cambios: readonly CambioPropuesto[],
  remitentes: ReadonlyMap<string, string>,
): ServiceRow[] {
  const ids = new Set<string>(hostsActivos(hosts).map((h) => h.serviceId));
  const aplicados = cambios.filter((c) => !c.excluida);
  for (const c of aplicados) if (c.serviceId) ids.add(c.serviceId);
  const compartidas = aplicados.some((c) => c.ambito === 'project');
  const out: ServiceRow[] = [];
  for (const s of listServices(projectId)) {
    if (s.type === 'database') continue;
    if (compartidas || ids.has(s.id) || remitenteGestionado(s, remitentes)) out.push(s);
  }
  return out;
}

/** ¿Tiene el servicio un remitente de correo que escribió Skyway y que cambia (`refrescarVariablesCorreo`)? */
function remitenteGestionado(s: ServiceRow, remitentes: ReadonlyMap<string, string>): boolean {
  if (remitentes.size === 0) return false;
  const state = envStateOf(s);
  return Object.entries(state.managed).some(
    ([key, m]) =>
      (m.origin === 'mail.smtp.from' || m.origin === 'mail.api.from') &&
      managedUnchanged(state, key) &&
      remitentes.has(state.env[key].trim().toLowerCase()),
  );
}

function mapaDe(pares: readonly { from: string; to: string }[]): Map<string, string> {
  return new Map(pares.map((p) => [p.from.toLowerCase(), p.to.toLowerCase()]));
}

// ---------- plan ----------

export interface PeticionPlan {
  fromDomain: string;
  toDomain: string;
  soloWeb?: boolean;
  hosts?: HostPlan[];
  excluidas?: Clave[];
}

interface PlanCalculado {
  plan: PlanSkyway;
  hosts: HostPlan[];
  correo: ContextoCorreo;
  cambios: CambioPropuesto[];
}

function huellaPlan(p: {
  fromDomain: string;
  toDomain: string;
  soloWeb: boolean;
  hosts: readonly HostPlan[];
  variables: string;
  correo: PlanCambioDominio | null;
}): string {
  const hosts = [...p.hosts]
    .map((h) => [h.serviceId, h.from, h.to, h.modo])
    .sort((a, b) => a.join('\u0000').localeCompare(b.join('\u0000')));
  const correo = p.correo
    ? { buzones: p.correo.buzones.map((b) => b.id).sort(), alias: p.correo.alias.map((a) => a.id).sort() }
    : null;
  return sha256(JSON.stringify([p.fromDomain, p.toDomain, p.soloWeb, hosts, p.variables, correo]));
}

/**
 * Vista previa del cambio: el mapa de nombres, el plan del correo de Mailway
 * (sin efectos) y el de las variables, con sus bloqueos y la huella con la que
 * «Preparar» comprueba que nada ha cambiado desde que se revisó.
 */
export async function calcularPlan(req: FastifyRequest, project: ProjectRow, body: PeticionPlan): Promise<PlanCalculado> {
  const isAdmin = currentUser(req)?.role === 'admin';
  const fromDomain = normalizarNombre(body.fromDomain);
  const toDomain = normalizarNombre(body.toDomain);
  const soloWeb = !!body.soloWeb;
  const bloqueos: string[] = [];
  const avisos: string[] = [];

  const relacionados = fromDomain === toDomain || cuelgaDe(toDomain, fromDomain) || cuelgaDe(fromDomain, toDomain);
  if (fromDomain === toDomain) bloqueos.push('El dominio nuevo tiene que ser distinto del actual.');
  else if (relacionados) bloqueos.push('El dominio nuevo no puede ser un subdominio del actual, ni al revés.');

  const workspace = workspaceOfProject(project.id);
  if (workspace && !isWorkspaceActive(workspace)) {
    bloqueos.push('La cuenta de este proyecto está suspendida: no es posible cambiar de dominio hasta reactivarla.');
  }

  const abierta = getOpenDomainMigration(project.id);
  if (abierta && (abierta.from_domain !== fromDomain || abierta.to_domain !== toDomain)) {
    bloqueos.push(yaHayUnoAbierto(abierta));
  }

  const pedidos = relacionados ? [] : (body.hosts ?? mapaHostsPorDefecto(project.id, fromDomain, toDomain));
  const hostsVista = relacionados ? [] : validarHosts(project, pedidos, fromDomain, toDomain, isAdmin);
  const hosts: HostPlan[] = hostsVista.map(({ serviceId, from, to, modo }) => ({ serviceId, from, to, modo }));
  if (hostsVista.some((h) => h.error)) bloqueos.push('Revisa los nombres marcados en «Web».');
  const activos = hostsActivos(hosts);
  if (activos.length > 0 && !moduleAllowedForProject(project.id, 'domains', isAdmin)) {
    bloqueos.push('El módulo «Dominios y TLS» no está activo en este workspace.');
  }

  // El correo: solo si el proyecto lo tiene en Mailway y no se ha elegido «Solo la web».
  let correo: ContextoCorreo = { disponible: 'no_vinculado', link: null, summary: null, dominio: null };
  let planCorreo: PlanCambioDominio | null = null;
  let correoError: string | null = null;
  if (!relacionados) {
    try {
      correo = await contextoCorreo(project, fromDomain, isAdmin);
    } catch (err) {
      // Con «Solo la web» el correo no se toca: que Mailway no responda no impide cambiar la web.
      if (!soloWeb) throw err;
      correoError = mensajeDe(err);
    }
  }
  if (!soloWeb && correo.disponible === 'si' && correo.dominio) {
    planCorreo = await planDomainMigration(correo.dominio.id, toDomain, { soloCliente: !isAdmin });
    for (const b of planCorreo.bloqueos) bloqueos.push(b.mensaje);
    for (const a of planCorreo.avisos) avisos.push(a.mensaje);
  } else if (!soloWeb && correo.disponible === 'mailway_antiguo') {
    bloqueos.push('Actualiza Mailway a la 1.3 para cambiar el dominio del correo.');
  } else if (correoError) {
    avisos.push(`Solo la web: no se ha podido consultar el correo en Mailway (${correoError.replace(/\.$/, '')}) y no se cambia.`);
  } else if (correo.disponible !== 'si' || soloWeb) {
    avisos.push(
      correo.disponible === 'si' || correo.disponible === 'mailway_antiguo'
        ? `Solo la web: el correo de ${fromDomain} sigue en Mailway sin cambios.`
        : `Solo la web: el correo de ${fromDomain} no está en Mailway.`,
    );
  }
  if (!relacionados && activos.length === 0 && !planCorreo) {
    bloqueos.push(`No hay nada que cambiar: ningún servicio de este proyecto usa ${fromDomain}${soloWeb ? '' : ' y su correo no está en Mailway'}.`);
  }

  const direcciones = planCorreo ? [...planCorreo.buzones, ...planCorreo.alias].map((x) => ({ from: x.de, to: x.a })) : [];
  const vars = planVariables(project.id, hosts, direcciones, fromDomain, body.excluidas ?? []);

  if (!relacionados) avisos.push(...avisosDelProyecto(project.id, hosts, fromDomain, toDomain));

  const { ip } = await getServerIp();
  const automatico = isAdmin && cloudflareConfigurado();
  const remitentes = mapaDe(direcciones);
  const afectados = relacionados ? [] : serviciosAfectados(project.id, hosts, vars.cambios, remitentes);

  const plan: PlanSkyway = {
    fromDomain,
    toDomain,
    soloWeb,
    hosts: hostsVista,
    dnsWeb: [...new Set(activos.map((h) => h.to))].map((host) => ({ host, ip, automatico })),
    correoDisponible: correo.disponible,
    correo: planCorreo,
    variables: vars.vista,
    servicios: afectados.map((s) => ({ serviceId: s.id, nombre: s.name, reinicio: usaVolumenes(s) })),
    avisos,
    bloqueos,
    expect: huellaPlan({ fromDomain, toDomain, soloWeb, hosts, variables: vars.vista.huella, correo: planCorreo }),
  };
  return { plan, hosts, correo, cambios: vars.cambios };
}

// ---------- preparar ----------

export interface PeticionPreparar extends PeticionPlan {
  hosts: HostPlan[];
  excluidas: Clave[];
  expect: string;
}

/**
 * Preparar: guarda el cambio, prepublica los nombres nuevos (sin desplegar),
 * abre el cambio del correo en Mailway y crea el DNS de la web si quien pide
 * es la administración. Idempotente: con un cambio abierto del mismo origen y
 * destino, lo devuelve (200).
 */
export async function prepararCambio(
  req: FastifyRequest,
  project: ProjectRow,
  body: PeticionPreparar,
): Promise<{ status: 200 | 201; vista: MigracionSkyway; dns?: ResultadoDns[] }> {
  const isAdmin = currentUser(req)?.role === 'admin';
  const from = normalizarNombre(body.fromDomain);
  const to = normalizarNombre(body.toDomain);
  // Sin esperar al cerrojo: otra acción larga del cambio abierto (la baja) lo puede tener minutos.
  const previa = getOpenDomainMigration(project.id);
  if (previa && (previa.from_domain !== from || previa.to_domain !== to)) throw new ErrorCambio(409, 'migration_exists', yaHayUnoAbierto(previa));
  return withLockProyecto(project.id, async () => {
    const abierta = getOpenDomainMigration(project.id);
    if (abierta) {
      if (abierta.from_domain === from && abierta.to_domain === to) return { status: 200, vista: await vistaMigracion(abierta, isAdmin) };
      throw new ErrorCambio(409, 'migration_exists', yaHayUnoAbierto(abierta));
    }
    const { plan, hosts, correo } = await calcularPlan(req, project, body);
    if (plan.bloqueos.length > 0) throw new ErrorCambio(409, 'migration_blocked', plan.bloqueos[0]);
    if (body.expect !== plan.expect) throw new ErrorCambio(409, 'plan_changed', PLAN_CAMBIADO);

    const conCorreo = !!plan.correo && !!correo.dominio && !!correo.link;
    const activos = hostsActivos(hosts);
    const user = currentUser(req);
    const row = transaction(() => {
      const nueva = insertDomainMigration({
        project_id: project.id,
        from_domain: from,
        to_domain: to,
        solo_web: !conCorreo,
        hosts,
        env: { excluidas: body.excluidas, huella: plan.variables.huella },
        mailway_client_id: conCorreo ? correo.link!.client_id : null,
        created_by: user?.email ?? null,
      });
      const ajenos = upsertPrepublished(activos.map((h) => ({ host: h.to, project_id: project.id, service_id: h.serviceId, migration_id: nueva.id })));
      if (ajenos.length > 0) {
        throw new ErrorCambio(
          409,
          'domain_in_use',
          `El dominio ${ajenos[0]} lo utiliza otro proyecto (redirección o cambio de dominio en curso) y no se puede asignar a este servicio.`,
        );
      }
      return nueva;
    });

    if (conCorreo) {
      try {
        const vista = await createDomainMigration(
          { fromDomainId: correo.dominio!.id, toDomain: to, referenciaExterna: projectExternalRef(project.id), autoDns: true, origen: 'skyway' },
          { soloCliente: !isAdmin },
        );
        if (vista.clientId !== correo.link!.client_id) {
          throw new MailwayError('http', 'La respuesta de Mailway no corresponde al cliente vinculado.', 502);
        }
        updateDomainMigration(row.id, { mailway_migration_id: vista.id });
        guardarCorreo(vista);
        // Los nombres que Mailway creó en Cloudflare (autoconfiguración, webmail)
        // apuntan aquí: solo este proyecto puede asignárselos a un servicio.
        if (vista.nombresCloudflare.length > 0) reservarNombresMailway(vista.nombresCloudflare, project.id);
      } catch (err) {
        // Sin el correo el cambio no está completo: se deshace lo propio (y su
        // prepublicación, que dejaría los nombres reservados sin uso).
        deleteDomainMigration(row.id);
        throw err;
      }
    }

    // DNS de la web: solo la administración, en las zonas del Cloudflare del operador.
    const dns = await dnsAutomaticoAdmin(req, activos.map((h) => h.to), { type: 'project', id: project.id }, project.id);
    audit(req, 'domain_migration_created', { type: 'project', id: project.id, detail: `${from} → ${to}` });

    const actual = getCambioSkyway(row.id)!;
    await comprobarSinCerrojo(actual).catch(() => {
      /* la primera comprobación es un adelanto: el asistente vuelve a comprobar */
    });
    return { status: 201, vista: await vistaMigracion(getCambioSkyway(row.id)!, isAdmin), ...(dns ? { dns } : {}) };
  });
}

// ---------- comprobar ----------

async function estadoHost(host: string): Promise<EstadoHostWeb> {
  const chk = await checkDomain(host);
  const dns: EstadoDnsHost = chk.status === 'ok' ? 'ok' : chk.status === 'unknown' ? 'desconocido' : 'pendiente';
  if (dns === 'ok' && getPrepublished(host)?.dns_ok_at == null) markPrepublishedDns(host, Date.now());
  if (!tlsEnabled()) return { dns, certificado: 'sin_tls', detalle: chk.message };
  if (dns !== 'ok') return { dns, certificado: 'pendiente', detalle: `Esperando al DNS de ${host}. ${chk.message}` };
  const tlsLocal = await comprobarTlsLocal(host);
  const certificado: EstadoCertificado = tlsLocal.estado === 'ok' ? 'ok' : tlsLocal.estado === 'invalido' ? 'pendiente' : 'desconocido';
  return { dns, certificado, detalle: certificado === 'ok' ? `Certificado listo para ${host}.` : tlsLocal.detalle };
}

function compuertas(row: DomainMigrationRow, web: Map<string, EstadoHostWeb> | undefined, correo: CambioDominioVista | null, correoError: string | null): Compuerta[] {
  const out: Compuerta[] = [];
  const nuevos = [...new Set(hostsActivos(row.hosts).map((h) => h.to))];
  if (nuevos.length > 0) {
    const estado = (h: string): EstadoHostWeb => web?.get(h) ?? { dns: getPrepublished(h)?.dns_ok_at ? 'ok' : 'pendiente', certificado: 'desconocido', detalle: '' };
    const sinDns = nuevos.filter((h) => estado(h).dns !== 'ok');
    out.push({
      id: 'dns_web',
      ok: sinDns.length === 0,
      bloquea: true,
      titulo: 'DNS de los nombres nuevos',
      detalle: sinDns.length === 0 ? 'Todos los nombres nuevos apuntan a este servidor.' : `Falta el DNS de ${sinDns.join(', ')}.`,
    });
    const sinTls = !tlsEnabled();
    const pendientes = nuevos.filter((h) => estado(h).certificado === 'pendiente');
    const desconocidos = nuevos.filter((h) => estado(h).certificado === 'desconocido');
    out.push({
      id: 'certificados',
      ok: pendientes.length === 0,
      bloquea: pendientes.length > 0,
      titulo: 'Certificados de los nombres nuevos',
      detalle: sinTls
        ? 'TLS no está activo en este servidor: no hay certificados que esperar.'
        : pendientes.length > 0
          ? `Esperando el certificado de ${pendientes.join(', ')}.`
          : desconocidos.length > 0
            ? `No se ha podido comprobar el certificado de ${desconocidos.join(', ')}: no bloquea el cambio.`
            : nuevos.length === 1
              ? `Certificado listo para ${nuevos[0]}.`
              : 'Certificados listos para todos los nombres nuevos.',
    });
  }
  if (row.mailway_migration_id) {
    const ok = correo?.estado === 'listo';
    out.push({
      id: 'correo',
      ok,
      bloquea: true,
      titulo: 'Correo en Mailway',
      detalle: correoError
        ? `No se ha podido consultar el correo en Mailway: ${correoError}`
        : ok
          ? `${row.to_domain} está listo para el cambio del correo.`
          : `El correo de ${row.to_domain} todavía se está preparando.`,
    });
  }
  return out;
}

/** Mide los nombres nuevos y el correo y deja el cambio en «lista» o «preparando». Quien llama tiene el cerrojo. */
async function comprobarSinCerrojo(row: DomainMigrationRow): Promise<Compuerta[]> {
  const nuevos = [...new Set(hostsActivos(row.hosts).map((h) => h.to))];
  const web = new Map<string, EstadoHostWeb>();
  const resultados = await Promise.all(nuevos.map(async (h) => [h, await estadoHost(h)] as const));
  for (const [h, e] of resultados) web.set(h, e);
  cacheWeb.set(row.id, web);

  let correo: CambioDominioVista | null = null;
  let correoError: string | null = null;
  if (row.mailway_migration_id) {
    try {
      const vista = await checkDomainMigration(row.mailway_migration_id);
      if (row.mailway_client_id && vista.clientId !== row.mailway_client_id) {
        throw new MailwayError('http', 'La respuesta de Mailway no corresponde al cliente de este cambio de dominio.', 502);
      }
      correo = guardarCorreo(vista);
    } catch (err) {
      correoError = mensajeDe(err);
    }
  }
  const lista = compuertas(row, web, correo, correoError);
  const todoBien = lista.every((c) => c.ok || !c.bloquea);
  updateDomainMigration(row.id, { estado: todoBien ? 'lista' : 'preparando' }, { siEstado: ['preparando', 'lista'] });
  return lista;
}

/** Vuelve a medir (el asistente lo llama cada 30 s mientras prepara). */
export async function comprobarCambio(project: ProjectRow, mid: string, isAdmin: boolean): Promise<MigracionSkyway> {
  const row = cambioDelProyecto(project, mid);
  if (row.estado !== 'preparando' && row.estado !== 'lista') {
    // Fuera de la preparación no hay nada que medir: solo se refresca el correo.
    if (row.mailway_migration_id) cacheCorreo.delete(row.mailway_migration_id);
    return vistaMigracion(row, isAdmin);
  }
  return withLockProyecto(project.id, async () => {
    const actual = cambioDelProyecto(project, mid);
    if (actual.estado === 'preparando' || actual.estado === 'lista') await comprobarSinCerrojo(actual);
    return vistaMigracion(cambioDelProyecto(project, mid), isAdmin);
  });
}

// ---------- vista ----------

export function cambioDelProyecto(project: ProjectRow, mid: string): DomainMigrationRow {
  const row = getCambioSkyway(mid);
  if (!row || row.project_id !== project.id) throw new ErrorCambio(404, 'not_found', 'Cambio de dominio no encontrado.');
  return row;
}

async function planVariablesDe(
  row: DomainMigrationRow,
  correo: CambioDominioVista | null,
  isAdmin: boolean,
): Promise<PlanVariablesInterno & { direcciones: { from: string; to: string }[] }> {
  const direcciones = await direccionesDelCambio(row, correo, isAdmin);
  return { ...planVariables(row.project_id, row.hosts, direcciones, row.from_domain, row.env.excluidas), direcciones };
}

/**
 * Vista del cambio para la interfaz. `ligera`: sin consultar a Mailway ni
 * calcular las variables (los cambios cerrados del listado, que no lo usan).
 */
export async function vistaMigracion(row: DomainMigrationRow, isAdmin: boolean, opts: { ligera?: boolean } = {}): Promise<MigracionSkyway> {
  const avisos: string[] = [...(avisosVolver.get(row.id) ?? [])];
  let correo: CambioDominioVista | null = null;
  let correoError: string | null = null;
  if (row.mailway_migration_id && !opts.ligera) {
    try {
      correo = await vistaCorreo(row);
    } catch (err) {
      correoError = mensajeDe(err);
      avisos.push(`No se ha podido consultar el estado del correo en Mailway: ${correoError}`);
    }
  }
  const web = cacheWeb.get(row.id);
  const servicios = new Map(listServices(row.project_id).map((s) => [s.id, s]));
  const lista = compuertas(row, web, correo, correoError);
  const compuertasOk = lista.every((c) => c.ok || !c.bloquea);

  let variables: PlanVariablesVista | null = null;
  let alPasar: MigracionSkyway['alPasar'] = null;
  const antesDePasar = row.estado === 'preparando' || row.estado === 'lista' || (row.estado === 'pasando' && !!row.error);
  if (antesDePasar && !opts.ligera) {
    try {
      const plan = await planVariablesDe(row, correo, isAdmin);
      variables = plan.vista;
      alPasar = serviciosAfectados(row.project_id, row.hosts, plan.cambios, mapaDe(plan.direcciones)).map((s) => ({
        serviceId: s.id,
        nombre: s.name,
        reinicio: usaVolumenes(s),
      }));
    } catch (err) {
      avisos.push(`No se ha podido calcular el cambio de las variables: ${mensajeDe(err)}`);
    }
    avisos.push(...avisosDelProyecto(row.project_id, row.hosts, row.from_domain, row.to_domain));
  }

  const tls = tlsEnabled();
  const hosts = row.hosts.map((h) => {
    const e = h.modo === 'no_cambiar' ? undefined : web?.get(h.to);
    const pre = h.modo === 'no_cambiar' ? undefined : getPrepublished(h.to);
    const dns: EstadoDnsHost = e?.dns ?? (pre?.dns_ok_at || row.estado !== 'preparando' ? 'ok' : 'pendiente');
    return {
      ...h,
      serviceName: servicios.get(h.serviceId)?.name ?? '?',
      dns,
      certificado: (e?.certificado ?? (tls ? 'desconocido' : 'sin_tls')) as EstadoCertificado,
      detalle: e?.detalle ?? '',
    };
  });

  const serviciosVista = Object.entries(row.servicios).map(([serviceId, s]) => {
    const dep = s.deploymentId ? getDeployment(s.deploymentId) : undefined;
    return {
      serviceId,
      nombre: servicios.get(serviceId)?.name ?? 'Servicio eliminado',
      despliegue: dep ? { id: dep.id, estado: dep.status } : null,
      estado: s.estado,
      error: s.error,
    };
  });
  if (row.estado === 'cancelada') {
    const creados = hostsActivos(row.hosts).filter((h) => getCloudflareDnsRecord(h.to)?.project_id === row.project_id);
    if (creados.length > 0) {
      avisos.push(
        `Los registros DNS creados en Cloudflare para ${creados.map((h) => h.to).join(', ')} se conservan, reservados a este proyecto.`,
      );
    }
  }

  const conCorreo = !!row.mailway_migration_id;
  const bajaBloqueada = (correo?.bloqueosBaja ?? []).some((b) => b.code !== 'mailbox_used_by_app');
  const conError = !!row.error;
  return {
    id: row.id,
    projectId: row.project_id,
    fromDomain: row.from_domain,
    toDomain: row.to_domain,
    soloWeb: !conCorreo,
    estado: row.estado,
    paso: row.paso,
    error: row.error,
    hosts,
    compuertas: lista,
    servicios: serviciosVista,
    redirecciones: listDomainRedirects(row.id).map((r) => ({ host: r.host, toHost: r.to_host, permanenteDesde: r.permanent_from })),
    correo,
    variables,
    alPasar,
    ipServidor: opts.ligera ? null : (await getServerIp()).ip,
    avisos,
    puedePasar: (row.estado === 'lista' && compuertasOk) || (row.estado === 'pasando' && conError),
    puedeVolver: row.estado === 'pasada' || ((row.estado === 'pasando' || row.estado === 'volviendo') && conError),
    puedeCancelar: row.estado === 'preparando' || row.estado === 'lista',
    puedeDarDeBaja:
      conCorreo &&
      ((row.estado === 'pasada' && correo?.estado === 'pasado' && !bajaBloqueada) || (row.estado === 'dando_de_baja' && conError)),
    puedeTerminar: !conCorreo && row.estado === 'pasada',
    fechas: { creada: row.created_at, pasada: row.pasada_at, terminada: row.terminada_at },
  };
}

/** El cambio abierto del proyecto y los últimos cerrados. */
export async function listarCambios(
  project: ProjectRow,
  isAdmin: boolean,
  opts: { ligera?: boolean } = {},
): Promise<{ abierta: MigracionSkyway | null; anteriores: MigracionSkyway[]; dominios: string[] }> {
  const abierta = getOpenDomainMigration(project.id);
  const anteriores = listDomainMigrations(project.id, 6)
    .filter((m) => m.id !== abierta?.id)
    .slice(0, 5);
  return {
    abierta: abierta ? await vistaMigracion(abierta, isAdmin, opts) : null,
    anteriores: await Promise.all(anteriores.map((m) => vistaMigracion(m, isAdmin, { ligera: true }))),
    dominios: dominiosDelProyecto(project.id),
  };
}

/**
 * Dominios que se proponen como «Dominio actual»: los registrables de los
 * dominios de los servicios (www.tienda.es → tienda.es), sin los subdominios
 * genéricos del panel.
 */
function dominiosDelProyecto(projectId: string): string[] {
  const raiz = normalizarNombre(getSetting('rootDomain') ?? '');
  const out = new Set<string>();
  for (const s of listServices(projectId)) {
    if (s.type === 'database') continue;
    for (const d of dominiosDe(s)) {
      const host = normalizarNombre(d);
      if (raiz && cuelgaDe(host, raiz)) continue;
      out.add(getDomain(host, { allowPrivateDomains: true }) ?? host);
    }
  }
  return [...out].sort();
}

// ---------- despliegues ----------

/**
 * Despliega un servicio afectado y lo sigue en segundo plano: si termina bien,
 * el servicio ya sirve los nombres nuevos y su prepublicación sobra; si falla,
 * el contenedor anterior sigue en marcha y la interfaz ofrece reintentar.
 */
function desplegar(mid: string, service: ServiceRow, opts: { imageTag?: string } = {}): string {
  markManualAction(service.id);
  const dep = triggerDeploy(service.id, 'cambio-de-dominio', opts.imageTag ? { imageTag: opts.imageTag } : {});
  setDomainMigrationServicio(mid, service.id, { deploymentId: dep.id, estado: 'desplegando', error: null });
  return dep.id;
}

function seguirDespliegue(mid: string, serviceId: string, deploymentId: string, plazoMs?: number): Promise<boolean> {
  return (async () => {
    const fin = await awaitDeployment(deploymentId, plazoMs);
    const ok = fin?.status === 'success';
    // Otro despliegue posterior del mismo cambio (un «Volver», un reintento) manda.
    if (getCambioSkyway(mid)?.servicios[serviceId]?.deploymentId !== deploymentId) return ok;
    const resultado: ServicioMigracion = ok
      ? { deploymentId, estado: 'ok', error: null }
      : {
          deploymentId,
          estado: 'error',
          error:
            fin?.error ||
            (fin && ['queued', 'building', 'deploying'].includes(fin.status)
              ? 'El despliegue no ha terminado a tiempo.'
              : 'El despliegue no ha terminado bien.'),
        };
    setDomainMigrationServicio(mid, serviceId, resultado);
    if (ok) deletePrepublished(mid, serviceId);
    return ok;
  })();
}

function desplegarYSeguir(mid: string, servicios: readonly ServiceRow[]): void {
  for (const s of servicios) {
    const depId = desplegar(mid, s);
    enSegundoPlano(async () => {
      await seguirDespliegue(mid, s.id, depId);
    });
  }
}

/**
 * Imagen del último despliegue correcto del servicio, si aún existe: la baja
 * vuelve a desplegar lo que ya está en marcha, solo con el usuario SMTP nuevo,
 * sin compilar código nuevo. Sin ella, un despliegue normal.
 */
async function imagenEnMarcha(service: ServiceRow): Promise<string | undefined> {
  if (service.type !== 'git') return undefined;
  const tag = listDeployments(service.id, 50).find((d) => d.status === 'success' && d.image_tag)?.image_tag;
  if (!tag) return undefined;
  try {
    return (await imageExists(tag)) ? tag : undefined;
  } catch {
    return undefined;
  }
}

// ---------- pasar ----------

/**
 * Comprueba el estado ANTES de esperar al cerrojo (para no hacer esperar a
 * quien pulsa mientras otra acción larga lo tiene, p. ej. la baja esperando a
 * un despliegue) y otra vez dentro: entre medias pudo cambiar.
 */
function exigirEstado(ok: boolean): void {
  if (!ok) throw errorEstado();
}

/**
 * Lo que cambia en la base de Skyway al pasar, en UNA transacción: dominios en
 * su sitio, variables (con instantánea), remitentes de correo, redirecciones
 * del nombre viejo al nuevo y la revisión de los servicios. Devuelve los
 * servicios que hay que desplegar.
 */
function aplicarWeb(
  row: DomainMigrationRow,
  cambios: readonly CambioPropuesto[],
  remitentes: ReadonlyMap<string, string>,
  ahora: number,
): { afectados: ServiceRow[]; claves: Map<string, string[]> } {
  const projectId = row.project_id;
  const activos = hostsActivos(row.hosts);
  const idsAfectados = new Set<string>();
  const claves = new Map<string, string[]>();
  const anotar = (id: string, key: string) => claves.set(id, [...(claves.get(id) ?? []), key]);
  const redirecciones: { host: string; to: string }[] = [];
  const hostsNuevos: string[] = [];

  // Dominios: en su sitio, con la lista anterior en la instantánea.
  for (const sid of new Set(activos.map((h) => h.serviceId))) {
    const service = getService(sid);
    if (!service || service.project_id !== projectId || service.type === 'database') continue;
    const actuales = dominiosDe(service);
    const presentes = new Set(actuales.map(normalizarNombre));
    // Un nombre que ya no tiene el servicio no se cambia ni redirige: quien lo
    // quitó a mano decidió que ya no es de este servicio.
    const suyos = activos.filter((h) => h.serviceId === sid && presentes.has(h.from));
    if (suyos.length === 0) continue;
    const nuevos = dominiosTrasPasar(actuales, suyos);
    putSnapshot({
      migration_id: row.id,
      ambito: 'domains',
      service_id: sid,
      key: 'domains',
      valor_original: JSON.stringify(actuales),
      valor_escrito: JSON.stringify(nuevos),
    });
    updateService(sid, service.name, { ...(service.config as object), domains: nuevos } as ServiceRow['config']);
    idsAfectados.add(sid);
    for (const h of suyos) {
      hostsNuevos.push(h.to);
      if (h.modo === 'redirigir') redirecciones.push({ host: h.from, to: h.to });
    }
  }

  // Variables: siempre desde el valor actual, que es el que se ha planificado.
  const extraWordpress = new Map<string, { original: string; valor: string }>();
  let compartidas = false;
  for (const c of cambios) {
    if (c.excluida) continue;
    if (c.ambito === 'project') {
      putSnapshot({ migration_id: row.id, ambito: 'project', service_id: '', key: c.key, valor_original: c.antes, valor_escrito: c.despues });
      patchProjectVars(projectId, { [c.key]: c.despues }, []);
      compartidas = true;
      anotar(projectId, c.key);
      continue;
    }
    const service = c.serviceId ? getService(c.serviceId) : undefined;
    if (!service || service.project_id !== projectId) continue;
    if (c.ambito === 'build') {
      const cfg = service.config as GitConfig;
      putSnapshot({ migration_id: row.id, ambito: 'build', service_id: service.id, key: c.key, valor_original: c.antes, valor_escrito: c.despues });
      updateService(service.id, service.name, { ...cfg, buildArgs: { ...(cfg.buildArgs ?? {}), [c.key]: c.despues } });
    } else if (c.key === 'WORDPRESS_CONFIG_EXTRA' && esWordpress(service)) {
      // Se escribe abajo, junto con el bloque que fija la URL.
      extraWordpress.set(service.id, { original: c.antes, valor: c.despues });
      continue;
    } else {
      putSnapshot({ migration_id: row.id, ambito: 'service', service_id: service.id, key: c.key, valor_original: c.antes, valor_escrito: c.despues });
      if (c.gestionada) writeManagedEnv(service.id, { [c.key]: { value: c.despues, origin: c.gestionada } });
      else patchEnv(service.id, { [c.key]: c.despues }, []);
    }
    idsAfectados.add(service.id);
    anotar(service.id, c.key);
  }

  // WordPress: su URL fijada en el mismo despliegue que cambia el dominio (si
  // no, WordPress redirige a la URL vieja y la redirección devuelve a la nueva).
  for (const sid of new Set(activos.map((h) => h.serviceId))) {
    const service = getService(sid);
    if (!service || !esWordpress(service) || !idsAfectados.has(sid)) continue;
    const principal = dominiosDe(service)[0];
    if (!principal) continue;
    const previo = extraWordpress.get(sid);
    const actual = getEnv(sid).WORDPRESS_CONFIG_EXTRA ?? '';
    const original = previo?.original ?? actual;
    const valor = anadirBloqueWordpress(previo?.valor ?? actual, `${esquemaWeb()}://${principal}`);
    putSnapshot({ migration_id: row.id, ambito: 'service', service_id: sid, key: 'WORDPRESS_CONFIG_EXTRA', valor_original: original, valor_escrito: valor });
    patchEnv(sid, { WORDPRESS_CONFIG_EXTRA: valor }, []);
    anotar(sid, 'WORDPRESS_CONFIG_EXTRA');
  }

  // Remitentes de correo que escribió Skyway: salen ya con la dirección nueva.
  // El usuario SMTP NO cambia: el buzón entra con el anterior hasta la baja.
  for (const s of listServices(projectId)) {
    if (s.type === 'database') continue;
    const cambiadas = refrescarVariablesCorreo(s.id, { remitentes });
    if (cambiadas.length > 0) {
      idsAfectados.add(s.id);
      for (const k of cambiadas) anotar(s.id, k);
    }
  }

  // Redirecciones. Antes, las que salían de los nombres nuevos (un cambio
  // anterior de ida y vuelta): sobrarían en cuanto el servicio deje de servirlos.
  deleteDomainRedirectHosts(projectId, hostsNuevos);
  const ajenos = insertDomainRedirects(
    redirecciones.map((r) => ({ host: r.host, project_id: projectId, to_host: r.to, migration_id: row.id, permanent_from: ahora + SIETE_DIAS_MS })),
  );
  if (ajenos.length > 0) {
    throw new ErrorCambio(
      409,
      'domain_in_use',
      `El dominio ${ajenos[0]} lo utiliza otro proyecto (redirección o cambio de dominio en curso) y no se puede asignar a este servicio.`,
    );
  }

  const afectados = listServices(projectId).filter((s) => s.type !== 'database' && (compartidas || idsAfectados.has(s.id)));
  bumpConfigRev(afectados.map((s) => s.id));
  updateDomainMigration(row.id, { estado: 'pasada', pasada_at: ahora, error: null, paso: '', servicios: {} });
  return { afectados, claves };
}

function auditarVariables(req: FastifyRequest, projectId: string, claves: Map<string, string[]>, prefijo = ''): void {
  for (const [id, keys] of claves) {
    audit(req, 'service_env_replaced', {
      type: id === projectId ? 'project' : 'service',
      id,
      detail: `${prefijo}${[...new Set(keys)].sort().join(', ')}`.slice(0, 500),
    });
  }
}

/**
 * Pasar: el correo primero (en Mailway) y, si va bien, la web en una
 * transacción; después se despliegan los servicios afectados (202). `expect`
 * es la huella de las variables que enseñó la confirmación.
 */
export async function pasarCambio(req: FastifyRequest, project: ProjectRow, mid: string, expect: string): Promise<MigracionSkyway> {
  const isAdmin = currentUser(req)?.role === 'admin';
  const puede = (r: DomainMigrationRow) => r.estado === 'lista' || (r.estado === 'pasando' && !!r.error);
  exigirEstado(puede(cambioDelProyecto(project, mid)));
  return withLockProyecto(project.id, async () => {
    let row = cambioDelProyecto(project, mid);
    exigirEstado(puede(row));
    const reintento = row.estado === 'pasando';
    const workspace = workspaceOfProject(project.id);
    if (workspace && !isWorkspaceActive(workspace)) {
      throw new ErrorCambio(403, 'account_suspended', 'La cuenta de este proyecto está suspendida: no es posible cambiar de dominio hasta reactivarla.');
    }
    if (row.mailway_migration_id) await correoDelCambio(project, row, isAdmin);

    // Pasar vuelve a medir siempre (salvo al reintentar: el correo puede haber pasado ya).
    if (!reintento) {
      const lista = await comprobarSinCerrojo(row);
      const fallan = lista.filter((c) => !c.ok && c.bloquea);
      if (fallan.length > 0) {
        throw new ErrorCambio(
          409,
          'migration_not_ready',
          `Todavía no se puede pasar a ${row.to_domain}: ${fallan.map((c) => c.detalle.replace(/\.$/, '')).join('; ')}.`,
        );
      }
      row = cambioDelProyecto(project, mid);
    }

    // Lo que se aplica es lo que se ha revisado en la confirmación.
    const correoAntes = row.mailway_migration_id ? await vistaCorreo(row, true) : null;
    const plan = await planVariablesDe(row, correoAntes, isAdmin);
    if (plan.vista.huella !== expect) throw new ErrorCambio(409, 'plan_changed', PLAN_CAMBIADO);
    for (const h of hostsActivos(row.hosts)) {
      const s = getService(h.serviceId);
      if (!s || !dominiosDe(s).map(normalizarNombre).includes(h.from)) continue;
      const conflicto = domainClaimError([h.to], { projectId: project.id, serviceId: s.id, isAdmin, current: dominiosDe(s) });
      if (conflicto) throw new ErrorCambio(409, 'domain_in_use', conflicto);
    }

    updateDomainMigration(mid, { estado: 'pasando', error: null, paso: '' }, { siEstado: [row.estado] });
    let correo: CambioDominioVista | null = null;
    if (row.mailway_migration_id) {
      updateDomainMigration(mid, { paso: 'Pasando el correo a ' + row.to_domain });
      try {
        correo = guardarCorreo(await switchDomainMigration(row.mailway_migration_id));
      } catch (err) {
        // El correo no ha pasado: la web no se toca.
        updateDomainMigration(mid, { estado: reintento ? 'pasando' : 'lista', error: mensajeDe(err), paso: '' });
        throw err;
      }
    }

    const remitentes = new Map<string, string>();
    for (const b of correo?.buzones.lista ?? []) {
      const local = parteLocal(b.email);
      remitentes.set(`${local}@${row.from_domain}`, `${local}@${row.to_domain}`);
    }
    let resultado: { afectados: ServiceRow[]; claves: Map<string, string[]> };
    try {
      resultado = transaction(() => aplicarWeb(row, plan.cambios, remitentes, Date.now()));
    } catch (err) {
      updateDomainMigration(mid, { error: mensajeDe(err), paso: '' });
      throw err;
    }
    avisosVolver.delete(mid);
    desplegarYSeguir(mid, resultado.afectados);
    auditarVariables(req, project.id, resultado.claves);
    audit(req, 'domain_migration_switched', { type: 'project', id: project.id, detail: `${row.from_domain} → ${row.to_domain}` });
    return vistaMigracion(cambioDelProyecto(project, mid), isAdmin);
  });
}

// ---------- volver ----------

/**
 * Deshace la web en una transacción: dominios con los viejos en su sitio y los
 * nuevos como secundarios, variables clave a clave (solo si nadie las ha
 * cambiado después), remitentes de vuelta y sin redirecciones.
 */
function restaurarWeb(row: DomainMigrationRow, remitentes: ReadonlyMap<string, string>): { afectados: ServiceRow[]; avisos: string[]; claves: Map<string, string[]> } {
  const projectId = row.project_id;
  const avisos: string[] = [];
  const ids = new Set<string>();
  const claves = new Map<string, string[]>();
  const anotar = (id: string, key: string) => claves.set(id, [...(claves.get(id) ?? []), key]);
  let compartidas = false;
  const noRestaurada = (key: string, donde: string | null) =>
    avisos.push(`No se ha restaurado ${key}${donde ? ` en «${donde}»` : ''}: cambió después del cambio de dominio.`);

  for (const snap of listSnapshots(row.id)) {
    if (snap.ambito === 'domains') {
      const service = getService(snap.service_id);
      if (!service || service.project_id !== projectId) continue;
      // Solo los nombres que este cambio llegó a poner (al pasar se saltan los
      // que el servicio ya no tenía).
      let escritos: string[] = [];
      try {
        escritos = (JSON.parse(snap.valor_escrito ?? '[]') as unknown[]).filter((d): d is string => typeof d === 'string').map(normalizarNombre);
      } catch {
        /* instantánea ilegible: no se añade ningún nombre nuevo */
      }
      const hosts = row.hosts.filter((h) => h.serviceId === service.id && escritos.includes(h.to));
      updateService(service.id, service.name, {
        ...(service.config as object),
        domains: dominiosTrasVolver(dominiosDe(service), hosts),
      } as ServiceRow['config']);
      ids.add(service.id);
      continue;
    }
    if (snap.ambito === 'project') {
      const actual = getProjectVars(projectId)[snap.key];
      if (actual === snap.valor_original) continue;
      if (actual !== snap.valor_escrito) {
        noRestaurada(snap.key, null);
        continue;
      }
      patchProjectVars(projectId, { [snap.key]: snap.valor_original }, []);
      compartidas = true;
      anotar(projectId, snap.key);
      continue;
    }
    const service = getService(snap.service_id);
    if (!service || service.project_id !== projectId) continue;
    if (snap.ambito === 'build') {
      const cfg = service.config as GitConfig;
      const actual = cfg.buildArgs?.[snap.key];
      if (actual === snap.valor_original) continue;
      if (actual !== snap.valor_escrito) {
        noRestaurada(snap.key, service.name);
        continue;
      }
      updateService(service.id, service.name, { ...cfg, buildArgs: { ...(cfg.buildArgs ?? {}), [snap.key]: snap.valor_original } });
    } else {
      const actual = getEnv(service.id)[snap.key];
      if (actual === snap.valor_original) continue;
      if (actual !== snap.valor_escrito) {
        noRestaurada(snap.key, service.name);
        continue;
      }
      const gestionada = getManagedEnv(service.id)[snap.key];
      if (snap.key === 'WORDPRESS_CONFIG_EXTRA' && snap.valor_original === '') {
        // No existía: se quita en vez de dejarla vacía.
        patchEnv(service.id, {}, [snap.key]);
      } else if (gestionada && snap.valor_escrito !== null && gestionada.valueHash === hashEnvValue(snap.valor_escrito)) {
        writeManagedEnv(service.id, { [snap.key]: { value: snap.valor_original, origin: gestionada.origin } });
      } else {
        patchEnv(service.id, { [snap.key]: snap.valor_original }, []);
      }
    }
    ids.add(service.id);
    anotar(service.id, snap.key);
  }

  for (const s of listServices(projectId)) {
    if (s.type === 'database') continue;
    const cambiadas = refrescarVariablesCorreo(s.id, { remitentes });
    if (cambiadas.length > 0) {
      ids.add(s.id);
      for (const k of cambiadas) anotar(s.id, k);
    }
  }

  deleteDomainRedirects(row.id);
  // Las instantáneas ya han servido: al pasar otra vez se hacen de nuevo.
  purgeSnapshots(row.id);
  const afectados = listServices(projectId).filter((s) => s.type !== 'database' && (compartidas || ids.has(s.id)));
  bumpConfigRev(afectados.map((s) => s.id));
  updateDomainMigration(row.id, { estado: 'lista', pasada_at: null, error: null, paso: '', servicios: {} });
  return { afectados, avisos, claves };
}

export async function volverCambio(req: FastifyRequest, project: ProjectRow, mid: string): Promise<MigracionSkyway> {
  const isAdmin = currentUser(req)?.role === 'admin';
  const puede = (r: DomainMigrationRow) => r.estado === 'pasada' || ((r.estado === 'pasando' || r.estado === 'volviendo') && !!r.error);
  exigirEstado(puede(cambioDelProyecto(project, mid)));
  return withLockProyecto(project.id, async () => {
    const row = cambioDelProyecto(project, mid);
    exigirEstado(puede(row));
    if (row.mailway_migration_id) await correoDelCambio(project, row, isAdmin);
    const previo = row.estado;
    updateDomainMigration(mid, { estado: 'volviendo', error: null, paso: '' }, { siEstado: [previo] });

    let correo: CambioDominioVista | null = null;
    if (row.mailway_migration_id) {
      updateDomainMigration(mid, { paso: `Volviendo el correo a ${row.from_domain}` });
      try {
        correo = guardarCorreo(await rollbackDomainMigration(row.mailway_migration_id));
      } catch (err) {
        updateDomainMigration(mid, { estado: previo, error: mensajeDe(err), paso: '' });
        throw err;
      }
    }
    const remitentes = new Map<string, string>();
    for (const b of correo?.buzones.lista ?? []) {
      const local = parteLocal(b.email);
      remitentes.set(`${local}@${row.to_domain}`, `${local}@${row.from_domain}`);
    }
    let resultado: ReturnType<typeof restaurarWeb>;
    try {
      resultado = transaction(() => restaurarWeb(row, remitentes));
    } catch (err) {
      updateDomainMigration(mid, { error: mensajeDe(err), paso: '' });
      throw err;
    }
    if (resultado.avisos.length > 0) avisosVolver.set(mid, resultado.avisos);
    else avisosVolver.delete(mid);
    desplegarYSeguir(mid, resultado.afectados);
    auditarVariables(req, project.id, resultado.claves, 'Restauradas: ');
    audit(req, 'domain_migration_rolled_back', { type: 'project', id: project.id, detail: `${row.from_domain} → ${row.to_domain}` });
    return vistaMigracion(cambioDelProyecto(project, mid), isAdmin);
  });
}

// ---------- cancelar ----------

/**
 * Cancela antes de pasar. El correo se cancela primero: si Mailway se niega
 * (el MX nuevo ya apunta aquí), el cambio sigue como estaba, con sus nombres
 * prepublicados.
 */
export async function cancelarCambio(req: FastifyRequest, project: ProjectRow, mid: string): Promise<MigracionSkyway> {
  const isAdmin = currentUser(req)?.role === 'admin';
  const puede = (r: DomainMigrationRow) => r.estado === 'preparando' || r.estado === 'lista';
  exigirEstado(puede(cambioDelProyecto(project, mid)));
  return withLockProyecto(project.id, async () => {
    const row = cambioDelProyecto(project, mid);
    exigirEstado(puede(row));
    if (row.mailway_migration_id) {
      await correoDelCambio(project, row, isAdmin);
      guardarCorreo(await cancelDomainMigration(row.mailway_migration_id));
    }
    transaction(() => {
      deletePrepublished(mid);
      purgeSnapshots(mid);
      updateDomainMigration(mid, { estado: 'cancelada', terminada_at: Date.now(), error: null, paso: '' });
    });
    cacheWeb.delete(mid);
    avisosVolver.delete(mid);
    audit(req, 'domain_migration_cancelled', { type: 'project', id: project.id, detail: `${row.from_domain} → ${row.to_domain}` });
    return vistaMigracion(cambioDelProyecto(project, mid), isAdmin);
  });
}

// ---------- aplicaciones que envían correo con un buzón pendiente ----------

type BuzonVista = CambioDominioVista['buzones']['lista'][number];

/**
 * Pasa al usuario nuevo los buzones que usan aplicaciones de Skyway y prepara
 * esas aplicaciones: usuario del buzón en Mailway, después sus variables de
 * correo (usuario y remitente) y un despliegue con la imagen que ya está en
 * marcha. La ventana sin poder enviar es la del relevo del contenedor.
 * Devuelve los despliegues lanzados.
 */
async function actualizarBuzonesDeApps(
  mid: string,
  projectId: string,
  buzones: readonly BuzonVista[],
): Promise<{ serviceId: string; deploymentId: string }[]> {
  const porCredencial = new Map<string, ServiceRow>();
  for (const s of listServices(projectId)) if (s.type !== 'database') porCredencial.set(appPasswordName(s), s);
  const usuarios = new Map<string, string>();
  const servicios = new Map<string, ServiceRow>();
  for (const b of buzones) {
    const { mailbox } = await updateMailboxLogin(b.id);
    const nuevo = (mailbox.login || mailbox.email || b.email).toLowerCase();
    usuarios.set(b.login.toLowerCase(), nuevo);
    for (const nombre of b.usadoPorApps) {
      const s = porCredencial.get(nombre);
      if (s) servicios.set(s.id, s);
    }
  }
  const lanzados: { serviceId: string; deploymentId: string }[] = [];
  for (const s of servicios.values()) {
    // El remitente también: si alguien excluyó el suyo al pasar, la dirección
    // anterior deja de ser del buzón con la baja y el servidor la rechazaría.
    refrescarVariablesCorreo(s.id, { usuarios, remitentes: usuarios }, { credencialSmtp: true });
    bumpConfigRev([s.id]);
    const imageTag = await imagenEnMarcha(s);
    lanzados.push({ serviceId: s.id, deploymentId: desplegar(mid, s, { imageTag }) });
  }
  return lanzados;
}

// ---------- dar de baja ----------

/**
 * Da de baja el dominio anterior (con correo). Responde en cuanto el cambio
 * queda en «dando_de_baja»; lo demás sigue en segundo plano: actualizar las
 * aplicaciones que envían con un buzón pendiente (y esperar a su despliegue) y
 * pedir la baja a Mailway. Si algo falla, vuelve a «pasada» con el error.
 */
export async function darDeBajaCambio(req: FastifyRequest, project: ProjectRow, mid: string, confirm: string): Promise<MigracionSkyway> {
  const isAdmin = currentUser(req)?.role === 'admin';
  const puede = (r: DomainMigrationRow) => r.estado === 'pasada' || (r.estado === 'dando_de_baja' && !!r.error);
  const inicial = cambioDelProyecto(project, mid);
  if (confirm.trim().toLowerCase() !== inicial.from_domain) {
    throw new ErrorCambio(400, 'confirm_mismatch', `Escribe ${inicial.from_domain} exactamente para confirmar.`);
  }
  if (!inicial.mailway_migration_id) {
    throw new ErrorCambio(409, 'migration_state', 'Este cambio de dominio no incluye el correo: termínalo con «Terminar».');
  }
  exigirEstado(puede(inicial));
  await withLockProyecto(project.id, async () => {
    const row = cambioDelProyecto(project, mid);
    exigirEstado(puede(row));
    await correoDelCambio(project, row, isAdmin);
    updateDomainMigration(mid, { estado: 'dando_de_baja', error: null, paso: '' }, { siEstado: [row.estado] });
  });
  enSegundoPlano(() => withLockProyecto(project.id, () => ejecutarBaja(req, project, mid)));
  return vistaMigracion(cambioDelProyecto(project, mid), isAdmin);
}

async function ejecutarBaja(req: FastifyRequest, project: ProjectRow, mid: string): Promise<void> {
  const row = getCambioSkyway(mid);
  if (!row || row.estado !== 'dando_de_baja' || !row.mailway_migration_id) return;
  const volverAPasada = (error: string) => updateDomainMigration(mid, { estado: 'pasada', error, paso: '' }, { siEstado: ['dando_de_baja'] });
  try {
    const correo = await vistaCorreo(row, true);
    const conApps = correo.buzones.lista.filter((b) => b.pendiente && b.usadoPorApps.some((n) => n.startsWith('skyway:')));
    if (conApps.length > 0) {
      updateDomainMigration(mid, { paso: 'Actualizando las aplicaciones que envían correo' });
      const lanzados = await actualizarBuzonesDeApps(mid, project.id, conApps);
      // Los buzones ya entran con su dirección nueva: la vista no puede seguir diciendo lo contrario.
      cacheCorreo.delete(row.mailway_migration_id);
      for (const b of conApps) {
        audit(req, 'mailway_mailbox_login_updated', { type: 'project', id: project.id, detail: `${b.login} → ${b.email} (baja)` });
      }
      const resultados = await Promise.all(
        lanzados.map(async (l) => ({ ...l, ok: await seguirDespliegue(mid, l.serviceId, l.deploymentId, PLAZO_DESPLIEGUE_BAJA_MS) })),
      );
      const fallido = resultados.find((r) => !r.ok);
      if (fallido) {
        const nombre = getService(fallido.serviceId)?.name ?? 'un servicio';
        volverAPasada(
          `El despliegue de «${nombre}» no ha terminado bien: no se ha dado de baja ${row.from_domain}. Reintenta ese servicio y vuelve a dar de baja.`,
        );
        return;
      }
    }
    updateDomainMigration(mid, { paso: `Dando de baja ${row.from_domain} en Mailway` });
    guardarCorreo(await retireDomainMigration(row.mailway_migration_id, row.from_domain));
    transaction(() => {
      retirarPrepublicacion(getCambioSkyway(mid) ?? row);
      purgeSnapshots(mid);
      updateDomainMigration(mid, { estado: 'terminada', terminada_at: Date.now(), error: null, paso: '' });
    });
    audit(req, 'domain_migration_retired', { type: 'project', id: project.id, detail: `${row.from_domain} → ${row.to_domain}` });
  } catch (err) {
    volverAPasada(mensajeDe(err));
  }
}

/**
 * Al cerrar un cambio, la prepublicación que quede sobra: los servicios ya
 * sirven sus nombres. Se conserva la de un servicio cuyo despliegue falló o
 * sigue en curso (su contenedor anterior aún no tiene el nombre nuevo): la
 * retira ese despliegue cuando termine bien.
 */
function retirarPrepublicacion(row: DomainMigrationRow): void {
  const servicios = new Set(hostsActivos(row.hosts).map((h) => h.serviceId));
  for (const sid of servicios) {
    const estado = row.servicios[sid]?.estado;
    if (estado !== 'error' && estado !== 'desplegando') deletePrepublished(row.id, sid);
  }
}

// ---------- terminar (solo web) y quitar las redirecciones ----------

export async function terminarCambio(req: FastifyRequest, project: ProjectRow, mid: string, confirm: string): Promise<MigracionSkyway> {
  const isAdmin = currentUser(req)?.role === 'admin';
  exigirEstado(cambioDelProyecto(project, mid).estado === 'pasada');
  return withLockProyecto(project.id, async () => {
    const row = cambioDelProyecto(project, mid);
    if (confirm.trim().toLowerCase() !== row.from_domain) {
      throw new ErrorCambio(400, 'confirm_mismatch', `Escribe ${row.from_domain} exactamente para confirmar.`);
    }
    if (row.mailway_migration_id) {
      throw new ErrorCambio(409, 'migration_state', `Este cambio de dominio incluye el correo: termínalo con «Dar de baja ${row.from_domain}».`);
    }
    exigirEstado(row.estado === 'pasada');
    transaction(() => {
      retirarPrepublicacion(row);
      purgeSnapshots(mid);
      updateDomainMigration(mid, { estado: 'terminada', terminada_at: Date.now(), error: null, paso: '' });
    });
    audit(req, 'domain_migration_finished', { type: 'project', id: project.id, detail: `${row.from_domain} → ${row.to_domain}` });
    return vistaMigracion(cambioDelProyecto(project, mid), isAdmin);
  });
}

export async function quitarRedirecciones(req: FastifyRequest, project: ProjectRow, mid: string, confirm: string): Promise<MigracionSkyway> {
  const isAdmin = currentUser(req)?.role === 'admin';
  exigirEstado(cambioDelProyecto(project, mid).estado === 'terminada');
  return withLockProyecto(project.id, async () => {
    const row = cambioDelProyecto(project, mid);
    if (confirm.trim().toLowerCase() !== row.from_domain) {
      throw new ErrorCambio(400, 'confirm_mismatch', `Escribe ${row.from_domain} exactamente para confirmar.`);
    }
    exigirEstado(row.estado === 'terminada');
    const n = deleteDomainRedirects(mid);
    audit(req, 'domain_redirects_removed', { type: 'project', id: project.id, detail: `${row.from_domain} → ${row.to_domain}: ${n}` });
    return vistaMigracion(cambioDelProyecto(project, mid), isAdmin);
  });
}

// ---------- reintentar un servicio y actualizar una persona ----------

export async function reintentarServicio(req: FastifyRequest, project: ProjectRow, mid: string, serviceId: string): Promise<MigracionSkyway> {
  const isAdmin = currentUser(req)?.role === 'admin';
  const puede = (r: DomainMigrationRow) => !ESTADOS_EN_CURSO.includes(r.estado) && r.estado !== 'cancelada';
  exigirEstado(puede(cambioDelProyecto(project, mid)));
  return withLockProyecto(project.id, async () => {
    const row = cambioDelProyecto(project, mid);
    exigirEstado(puede(row));
    const servicio = row.servicios[serviceId];
    if (!servicio || servicio.estado !== 'error') {
      throw new ErrorCambio(409, 'migration_state', 'Este servicio no tiene un despliegue fallido que reintentar.');
    }
    const service = getService(serviceId);
    if (!service || service.project_id !== project.id) throw new ErrorCambio(404, 'not_found', 'Servicio no encontrado.');
    desplegarYSeguir(mid, [service]);
    audit(req, 'domain_migration_service_retried', { type: 'service', id: service.id, detail: `${row.from_domain} → ${row.to_domain}` });
    return vistaMigracion(cambioDelProyecto(project, mid), isAdmin);
  });
}

/**
 * «Actualizar ahora» de una persona: su buzón entra desde ahora con la
 * dirección nueva. Si lo usan aplicaciones de este proyecto para enviar, se
 * actualizan también sus variables y se despliegan con la imagen en marcha
 * (si no, dejarían de enviar).
 */
export async function actualizarPersona(req: FastifyRequest, project: ProjectRow, mid: string, mailboxId: string): Promise<MigracionSkyway> {
  const isAdmin = currentUser(req)?.role === 'admin';
  const puede = (r: DomainMigrationRow) => !ESTADOS_EN_CURSO.includes(r.estado) && r.estado !== 'terminada' && r.estado !== 'cancelada';
  exigirEstado(puede(cambioDelProyecto(project, mid)));
  return withLockProyecto(project.id, async () => {
    const row = cambioDelProyecto(project, mid);
    if (!row.mailway_migration_id) throw new ErrorCambio(409, 'migration_state', 'Este cambio de dominio no incluye el correo.');
    exigirEstado(puede(row));
    await correoDelCambio(project, row, isAdmin);
    const correo = await vistaCorreo(row, true);
    const buzon = correo.buzones.lista.find((b) => b.id === mailboxId);
    if (!buzon) throw new ErrorCambio(404, 'not_found', 'Ese buzón no forma parte de este cambio de dominio.');
    if (buzon.pendiente) {
      if (buzon.usadoPorApps.some((n) => n.startsWith('skyway:'))) {
        const lanzados = await actualizarBuzonesDeApps(mid, project.id, [buzon]);
        for (const l of lanzados) {
          enSegundoPlano(async () => {
            await seguirDespliegue(mid, l.serviceId, l.deploymentId, PLAZO_DESPLIEGUE_BAJA_MS);
          });
        }
      } else {
        await updateMailboxLogin(buzon.id);
      }
      cacheCorreo.delete(row.mailway_migration_id);
      audit(req, 'mailway_mailbox_login_updated', { type: 'project', id: project.id, detail: `${buzon.login} → ${buzon.email}` });
    }
    return vistaMigracion(cambioDelProyecto(project, mid), isAdmin);
  });
}

// ---------- fichero de zona ----------

/**
 * Registros DNS del dominio nuevo en un fichero: los del correo que genera
 * Mailway (nivel «recomendados»: incluye el TXT que prueba la propiedad sin
 * tocar el MX) y, al final, los A de la web. Solo web: solo los A.
 */
export async function ficheroDeZona(project: ProjectRow, mid: string, isAdmin: boolean): Promise<{ nombre: string; texto: string }> {
  const row = cambioDelProyecto(project, mid);
  const hosts = [...new Set(hostsActivos(row.hosts).map((h) => h.to))];
  let zona = `;  Registros DNS de ${row.to_domain} para el cambio de dominio de Skyway\n`;
  if (row.mailway_migration_id) {
    await correoDelCambio(project, row, isAdmin);
    const correo = await vistaCorreo(row, true);
    if (correo.hacia.domainId) {
      zona = stripWebRecords(await getZoneFile(correo.hacia.domainId, 'recomendados'), row.to_domain).zone;
    }
  }
  const { zone } = appendWebRecords(zona, row.to_domain, { serverIp: getSetting('serverIp') || null, hosts, webmail: null });
  return { nombre: `${row.to_domain.replace(/[^A-Za-z0-9.-]+/g, '_')}-cambio-de-dominio.txt`, texto: zone };
}

// ---------- arranque ----------

/**
 * Al arrancar: los cambios que el reinicio cortó a mitad de pasar, volver o
 * dar de baja quedan con un error para que la interfaz ofrezca «Reintentar»
 * (no se reanudan solos: Mailway pudo hacer su parte o no). Los despliegues
 * que se estaban siguiendo se vuelven a seguir.
 */
export function marcarCambiosInterrumpidos(): { interrumpidos: number; seguidos: number } {
  let interrumpidos = 0;
  let seguidos = 0;
  for (const row of listDomainMigrationsByEstado(ESTADOS_EN_CURSO)) {
    if (row.error) continue;
    if (updateDomainMigration(row.id, { error: INTERRUMPIDO, paso: '' }, { siEstado: [row.estado] })) {
      interrumpidos += 1;
      auditSystem('domain_migration_interrupted', `${row.from_domain} → ${row.to_domain} (${row.estado})`, { type: 'project', id: row.project_id });
    }
  }
  for (const row of listDomainMigrationsByEstado(['preparando', 'lista', 'pasada', 'pasando', 'volviendo', 'dando_de_baja'])) {
    for (const [sid, s] of Object.entries(row.servicios)) {
      if (s.estado !== 'desplegando' || !s.deploymentId) continue;
      const depId = s.deploymentId;
      enSegundoPlano(async () => {
        await seguirDespliegue(row.id, sid, depId);
      });
      seguidos += 1;
    }
  }
  return { interrumpidos, seguidos };
}

