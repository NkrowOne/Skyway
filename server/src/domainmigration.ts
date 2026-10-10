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
import dns from 'dns';
import { FastifyRequest } from 'fastify';
import { getDomain } from 'tldts';
import { fireAlert } from './alerts';
import { audit, auditSystem } from './audit';
import { currentUser } from './auth';
import { cloudflareConfigurado } from './cloudflareconfig';
import { dnsAutomaticoAdmin, ResultadoDns, verificarEnCloudflare } from './cloudflaredns';
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
  getMailwayDnsReserva,
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
  listMailwayLinksByClient,
  listPrepublished,
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
import { estrategiaEfectiva } from './deploy/estrategia';
import { imageExists } from './docker/containers';
import { domainClaimError } from './domainguard';
import { dominioPrincipal } from './dominioprincipal';
import { checkDomain, consultarMx, getServerIp } from './domains';
import {
  anadirBloqueWordpress,
  AvisoSinMapa,
  avisosDeVariables,
  CambioPropuesto,
  mensajeSinMapa,
  mensajeUsuario,
  planificar,
  ProveedorAviso,
  proveedoresDeClaves,
  ValorVariable,
} from './envreplace';
import {
  credentialNames,
  ownedSummary,
  refrescarVariablesCorreo,
  requireLink,
  reescribirUsuariosCompartidos,
  reescribirUsuariosSinGestionar,
  textoUsuarioDeVariable,
  usuarioDeVariable,
  usuarioQueRefrescaSkyway,
} from './mailconnect';
import { mailRoleLoose } from './mailenv';
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
  mailwayFetch,
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
import { EnvState, envStateOf, managedUnchanged } from './managedenv';
import { markManualAction } from './monitor';
import { isWorkspaceActive, moduleAllowedForProject, workspaceOfProject } from './quota';
import { comprobarTlsLocal } from './redirecciones';
import { tlsEnabled } from './tls';
import { GitConfig, ImageConfig, MailwayLinkRow, ProjectRow, ServiceRow } from './types';
import { resolveServiceEnv } from './variables';

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

export type { ProveedorAviso } from './envreplace';

/**
 * Por qué se vuelve a desplegar un servicio al pasar: sus dominios, sus
 * variables, las compartidas, su remitente de correo o `referencias`: usa la
 * dirección de otro servicio que cambia de nombre (`${{api.PUBLIC_URL}}`).
 */
export type MotivoDespliegue = 'dominios' | 'variables' | 'compartidas' | 'remitente' | 'referencias';

/** Servicio que se volverá a desplegar al pasar. `reinicio`: se despliega con una sola copia (unos segundos sin servicio). */
export interface ServicioAlPasar {
  serviceId: string;
  nombre: string;
  reinicio: boolean;
  motivos: MotivoDespliegue[];
}

/**
 * Servicio que recibe webhooks (por sus variables o sus dependencias) en
 * nombres que redirigen al pasar. Telegram y Stripe tratan una redirección como
 * un fallo; del resto no consta: el webhook registrado con la URL anterior
 * puede dejar de llegar.
 */
export interface WebhookEnRiesgo {
  serviceId: string;
  serviceName: string;
  proveedores: ProveedorAviso[];
  /** Lo que lo indica: «TELEGRAM_BOT_TOKEN», «package.json: telegraf». */
  evidencias: string[];
  /** Nombres que reciben sus webhooks y redirigen (o redirigirán) al pasar. */
  hosts: { serviceId: string; from: string; to: string }[];
}

/**
 * Buzón del cambio con el que entran en el correo variables que Skyway no pone
 * al día con su credencial: un `SMTP_USER` con una contraseña de aplicación
 * creada a mano, un `TG_SMTP_LOGIN`, una URL SMTP escrita a mano.
 */
export interface UsuarioSinGestionar {
  mailboxId: string;
  email: string;
  /** Usuario con el que entra hoy el buzón (`login` de Mailway). */
  login: string;
  pendiente: boolean;
  usos: {
    ambito: 'service' | 'project';
    serviceId: string | null;
    serviceName: string | null;
    key: string;
    /** Usuario que tiene la variable. */
    usuario: string;
    /** 'cambiara': entra hoy y dejará de entrar al actualizar el buzón o en la baja; 'no_entra': ya no entra. */
    estado: 'cambiara' | 'no_entra';
  }[];
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
  servicios: ServicioAlPasar[];
  /** Servicios con webhooks en nombres que redirigirán al pasar. */
  webhooks: WebhookEnRiesgo[];
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
  alPasar: ServicioAlPasar[] | null;
  /** Servicios con webhooks en nombres que redirigen («preparando», «lista» y «pasada», mientras sigan redirigiendo). */
  webhooks: WebhookEnRiesgo[];
  /** Buzones con los que entran variables que Skyway no gestiona («pasada» y «dando_de_baja»). */
  usuariosSinGestionar: UsuarioSinGestionar[];
  /**
   * Buzones pendientes con contraseñas de aplicación creadas a mano: las
   * aplicaciones de fuera de Skyway que las usen tendrán que entrar con la
   * dirección nueva tras actualizarlos o dar de baja el dominio.
   * `usadoEnProyecto`: algún servicio del proyecto usa el buzón (con su
   * credencial de Skyway o con variables sin gestionar), y a esos Skyway sí
   * los pone al día; la misma contraseña puede usarla además algo de fuera.
   */
  appsManuales: { mailboxId: string; email: string; apps: string[]; usadoEnProyecto: boolean }[];
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
/** Estados de un despliegue que aún no ha terminado. */
const DESPLIEGUE_EN_CURSO = new Set(['queued', 'building', 'deploying']);
/** Estados del correo en Mailway desde los que se puede dar de baja (o reintentar la baja). */
const CORREO_DE_BAJA = ['pasado', 'dando_de_baja'];

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
/**
 * Avisos de la última acción: las variables que «Volver» no ha restaurado por
 * haber cambiado a mano, o las aplicaciones que «Cancelar» no ha podido poner
 * al día.
 */
const avisosAccion = new Map<string, string[]>();

/** Solo para las pruebas: olvida lo que se guarda en memoria. */
export function resetCambioDominioCaches(): void {
  cacheCorreo.clear();
  cacheWeb.clear();
  avisosAccion.clear();
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
  /** Con `no_vinculado`: el módulo «Correo» está desactivado (el correo puede estar en Mailway). */
  sinModulo?: boolean;
}

/**
 * ¿Tiene el proyecto el correo de `fromDomain` en Mailway, y admite Mailway el
 * cambio de dominio? Antes de usar el token de administración de Skyway se
 * comprueba que el cliente sigue siendo el de este proyecto (`ownedSummary`)
 * y que el dominio es suyo: el token lo puede todo en Mailway.
 */
async function contextoCorreo(project: ProjectRow, fromDomain: string, isAdmin: boolean): Promise<ContextoCorreo> {
  const nada: ContextoCorreo = { disponible: 'no_vinculado', link: null, summary: null, dominio: null };
  if (!mailwayConfigured()) return nada;
  if (!moduleAllowedForProject(project.id, 'mail', isAdmin)) return { ...nada, sinModulo: true };
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

/**
 * Estado del correo en Mailway justo después de que una acción falle (sin la
 * caché, que diría lo de antes del fallo): decide en qué estado se queda el
 * cambio de Skyway. null si Mailway no responde.
 */
async function correoTrasFallo(row: DomainMigrationRow): Promise<CambioDominioVista | null> {
  if (!row.mailway_migration_id) return null;
  cacheCorreo.delete(row.mailway_migration_id);
  try {
    return await vistaCorreo(row, true);
  } catch {
    return null;
  }
}

/** Parte local de una dirección. */
function parteLocal(email: string): string {
  const i = email.lastIndexOf('@');
  return i > 0 ? email.slice(0, i).toLowerCase() : email.toLowerCase();
}

/** Dominio de una dirección (vacío si no tiene «@»). */
function dominioDe(email: string): string {
  const i = email.lastIndexOf('@');
  return i >= 0 ? normalizarNombre(email.slice(i + 1)) : '';
}

/**
 * Buzones y alias que se mudan, de dirección vieja a nueva. Antes de pasar,
 * del plan de Mailway (buzones y alias del dominio anterior). Si el correo ya
 * pasó (un «Pasar» de Skyway que se cortó después de que Mailway terminara),
 * ya no están en el anterior: el plan inverso, que tampoco tiene efectos, los
 * lista en el nuevo con sus direcciones de ahora. Sin él, las direcciones de
 * los alias se quedarían sin cambiar en las variables y dejarían de existir
 * con la baja.
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
  if (vista.hacia.domainId) {
    const inverso = await planDomainMigration(vista.hacia.domainId, row.from_domain, { soloCliente: !isAdmin });
    const buzones = new Set(vista.buzones.lista.map((b) => b.id));
    return [...inverso.buzones.filter((b) => buzones.has(b.id)), ...inverso.alias].map((x) => ({
      from: x.a.toLowerCase(),
      to: x.de.toLowerCase(),
    }));
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

/** Una referencia `${{servicio.VARIABLE}}` o `${{shared.VARIABLE}}` (la misma sintaxis que resuelve `variables.ts`). */
const REFERENCIA = /\$\{\{\s*([A-Za-z0-9 _.-]+?)\.([A-Za-z0-9_]+)\s*\}\}/g;
const AMBITO_COMPARTIDAS = new Set(['shared', 'proyecto', 'project']);

/** Variables cuyo valor entero es un usuario para entrar en el correo aunque su nombre no lo diga. */
interface ClavesUsuario {
  proyecto: Set<string>;
  /** Por servicio (no bases de datos). */
  servicios: Map<string, Set<string>>;
}

/**
 * Variables a las que apunta un usuario SMTP con una referencia:
 * `SMTP_USER=${{shared.LOGIN_CORREO}}` o `smtp://${{web.LOGIN}}:…@host`. Su
 * nombre no dice que sean un usuario, pero lo son: al pasar no se cambian (el
 * buzón aún entra con el anterior) y al actualizar el buzón o dar de baja el
 * dominio anterior se ponen al día como cualquier otro usuario. Se siguen las
 * referencias encadenadas, con el mismo límite que al resolver.
 */
function clavesUsuarioPorReferencia(projectId: string): ClavesUsuario {
  const servicios = listServices(projectId).filter((s) => s.type !== 'database');
  const compartidas = getProjectVars(projectId);
  const envs = new Map(servicios.map((s) => [s.id, getEnv(s.id)]));
  const out: ClavesUsuario = { proyecto: new Set(), servicios: new Map() };
  const buscar = (nombre: string) => {
    const n = nombre.trim().toLowerCase();
    return servicios.find((s) => s.name.toLowerCase() === n || s.slug === n);
  };
  const pendientes: { texto: string; nivel: number }[] = [];
  const desde = (key: string, valor: string) => {
    const texto = textoUsuarioDeVariable(key, valor);
    if (texto?.includes('${{')) pendientes.push({ texto, nivel: 0 });
  };
  for (const [key, valor] of Object.entries(compartidas)) desde(key, valor);
  for (const env of envs.values()) for (const [key, valor] of Object.entries(env)) desde(key, valor);
  while (pendientes.length > 0) {
    const { texto, nivel } = pendientes.pop()!;
    if (nivel > 5) continue;
    for (const m of texto.matchAll(REFERENCIA)) {
      const key = m[2];
      let valor: string | undefined;
      if (AMBITO_COMPARTIDAS.has(m[1].trim().toLowerCase())) {
        valor = compartidas[key];
        if (valor === undefined || out.proyecto.has(key)) continue;
        out.proyecto.add(key);
      } else {
        const destino = buscar(m[1]);
        valor = destino ? envs.get(destino.id)?.[key] : undefined;
        if (!destino || valor === undefined) continue;
        const suyas = out.servicios.get(destino.id) ?? new Set<string>();
        if (suyas.has(key)) continue;
        out.servicios.set(destino.id, suyas.add(key));
      }
      if (valor.includes('${{')) pendientes.push({ texto: valor, nivel: nivel + 1 });
    }
  }
  return out;
}

/**
 * Valores de las variables del proyecto que el cambio puede tocar: las
 * compartidas, las de cada servicio (no las bases de datos, que no se vuelven
 * a desplegar) y los argumentos de compilación. Una variable que escribió
 * Skyway y nadie ha cambiado lleva su origen: se reescribe conservándolo. Las
 * que referencia un usuario SMTP van marcadas como usuario (`clavesUsuarioPorReferencia`).
 */
function valoresVariables(projectId: string): ValorVariable[] {
  const out: ValorVariable[] = [];
  const comoUsuario = clavesUsuarioPorReferencia(projectId);
  for (const [key, valor] of Object.entries(getProjectVars(projectId))) {
    out.push({ ambito: 'project', serviceId: null, key, valor, origen: null, ...(comoUsuario.proyecto.has(key) ? { usuario: true } : {}) });
  }
  for (const s of listServices(projectId)) {
    if (s.type === 'database') continue;
    const state = envStateOf(s);
    const suyas = comoUsuario.servicios.get(s.id);
    for (const [key, valor] of Object.entries(state.env)) {
      out.push({
        ambito: 'service',
        serviceId: s.id,
        key,
        valor,
        origen: managedUnchanged(state, key) ? state.managed[key].origin : null,
        ...(suyas?.has(key) ? { usuario: true } : {}),
      });
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

/**
 * ¿Puede cambiar el entorno resuelto del servicio por lo que cambia en OTRO
 * servicio? Solo si él (o las compartidas) referencia algo con `${{…}}`: sin
 * referencias, su entorno es el suyo y lo que cambie ya lo dicen sus motivos.
 */
function tieneReferencias(s: ServiceRow, compartidas: Record<string, string>): boolean {
  const conRef = (v: string) => v.includes('${{');
  return Object.values(getEnv(s.id)).some(conRef) || Object.values(compartidas).some(conRef);
}

/** El entorno resuelto, comparable: mismas variables con los mismos valores, la misma cadena. */
function huellaEntorno(env: Record<string, string>): string {
  return JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Entorno resuelto de los servicios del proyecto (no bases de datos) que
 * referencian otros servicios. Al pasar y al volver se toma antes y después
 * de escribir: el que cambia (`${{api.PUBLIC_URL}}` de un servicio que cambia
 * de nombre, una variable de otro servicio que se ha reescrito) se vuelve a
 * desplegar, o se quedaría con la dirección anterior.
 */
function fotoEntornos(projectId: string): Map<string, string> {
  const compartidas = getProjectVars(projectId);
  const out = new Map<string, string>();
  for (const s of listServices(projectId)) {
    if (s.type === 'database' || !tieneReferencias(s, compartidas)) continue;
    out.set(s.id, huellaEntorno(resolveServiceEnv(s)));
  }
  return out;
}

/** Servicios cuyo entorno resuelto ya no es el de la foto. */
function cambiaronDeEntorno(projectId: string, antes: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [id, huella] of antes) {
    const s = getService(id);
    if (s && huella !== huellaEntorno(resolveServiceEnv(s))) out.push(id);
  }
  return out;
}

/**
 * «Servir también» el nombre que hoy es el principal de un servicio lo deja
 * como su dirección pública (`PUBLIC_URL`): el principal se elige por la regla
 * de `dominioPrincipal` (www primero), no por el orden. Se avisa; no bloquea.
 */
function avisosServirPrincipal(projectId: string, hosts: readonly HostPlan[]): string[] {
  const raiz = getSetting('rootDomain');
  const activos = hostsActivos(hosts);
  const out: string[] = [];
  for (const s of listServices(projectId)) {
    const suyos = activos.filter((h) => h.serviceId === s.id);
    if (!suyos.some((h) => h.modo === 'servir')) continue;
    const principal = dominioPrincipal(dominiosTrasPasar(dominiosDe(s), suyos), raiz);
    const h = suyos.find((x) => x.modo === 'servir' && x.from === principal);
    if (h) out.push(`Con «Servir también», ${h.from} seguirá siendo el dominio principal de «${s.name}»: su PUBLIC_URL no pasará a ${h.to}.`);
  }
  return out;
}

/** Servicios que se volverán a desplegar al pasar, con sus motivos. */
function serviciosAfectados(
  projectId: string,
  hosts: readonly HostPlan[],
  cambios: readonly CambioPropuesto[],
  remitentes: ReadonlyMap<string, string>,
): { service: ServiceRow; motivos: MotivoDespliegue[] }[] {
  const activos = hostsActivos(hosts);
  const porDominios = new Set<string>(activos.map((h) => h.serviceId));
  const aplicados = cambios.filter((c) => !c.excluida);
  const porVariables = new Set<string>();
  for (const c of aplicados) if (c.serviceId) porVariables.add(c.serviceId);
  const compartidas = aplicados.some((c) => c.ambito === 'project');
  const servicios = listServices(projectId).filter((s) => s.type !== 'database');
  // Los dominios de cada servicio tras pasar: con ellos se resuelven las
  // referencias como quedarán (`${{api.PUBLIC_URL}}` pasa a la dirección nueva).
  const dominios = new Map<string, string[]>();
  for (const s of servicios) {
    if (!porDominios.has(s.id)) continue;
    const despues = dominiosTrasPasar(dominiosDe(s), activos.filter((h) => h.serviceId === s.id));
    if (despues.join('\u0000') !== dominiosDe(s).join('\u0000')) dominios.set(s.id, despues);
  }
  const vars = getProjectVars(projectId);
  const out: { service: ServiceRow; motivos: MotivoDespliegue[] }[] = [];
  for (const s of servicios) {
    const motivos: MotivoDespliegue[] = [];
    if (porDominios.has(s.id)) motivos.push('dominios');
    if (porVariables.has(s.id)) motivos.push('variables');
    if (compartidas) motivos.push('compartidas');
    if (remitenteGestionado(s, remitentes)) motivos.push('remitente');
    if (
      dominios.size > 0 &&
      tieneReferencias(s, vars) &&
      huellaEntorno(resolveServiceEnv(s)) !== huellaEntorno(resolveServiceEnv(s, { dominios }))
    ) {
      motivos.push('referencias');
    }
    if (motivos.length > 0) out.push({ service: s, motivos });
  }
  return out;
}

/** Cómo lo enseña la interfaz. `reinicio`: se despliega con una sola copia, así que hay unos segundos sin servicio. */
function alPasarVista(afectados: readonly { service: ServiceRow; motivos: MotivoDespliegue[] }[]): ServicioAlPasar[] {
  return afectados.map(({ service, motivos }) => ({
    serviceId: service.id,
    nombre: service.name,
    reinicio: estrategiaEfectiva(service).estrategia === 'recreate',
    motivos,
  }));
}

// ---------- webhooks ----------

const ORDEN_PROVEEDORES: readonly ProveedorAviso[] = ['telegram', 'discord', 'slack', 'whatsapp', 'twilio', 'stripe', 'webhook'];

/**
 * Proveedores de webhooks de un servicio y lo que los delata: los nombres de
 * sus variables (las suyas, las de compilación y las que espera su
 * `.env.example`) y sus dependencias (`needs.bots`). «webhook» (un nombre que
 * no dice el proveedor) solo si no hay otro más concreto.
 */
function proveedoresDeServicio(s: ServiceRow, entorno: Record<string, string>): { proveedores: ProveedorAviso[]; evidencias: string[] } {
  const claves = Object.keys(getEnv(s.id));
  const cfg = s.type === 'git' ? (s.config as GitConfig) : null;
  const args = Object.fromEntries(Object.entries(cfg?.buildArgs ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'));
  if (cfg) claves.push(...Object.keys(args), ...(cfg.needs?.expectedVars ?? []));
  // Con sus valores (resueltos): un webhook de salida (`https://hooks.slack.com/…`) no recibe nada.
  const porClave = proveedoresDeClaves(claves, { ...args, ...entorno });
  const bots = cfg?.needs?.bots ?? [];
  const hay = (p: ProveedorAviso) => porClave.some((x) => x.proveedor === p) || bots.some((b) => b.proveedor === p);
  let proveedores = ORDEN_PROVEEDORES.filter(hay);
  if (proveedores.some((p) => p !== 'webhook')) proveedores = proveedores.filter((p) => p !== 'webhook');
  return { proveedores, evidencias: [...new Set([...porClave.map((p) => p.clave), ...bots.map((b) => b.evidencia)])] };
}

/** ¿Aparece `host` como nombre (no como parte de otro) en alguno de los valores? */
function mencionaHost(valores: readonly string[], host: string): boolean {
  const re = new RegExp(`(?<![A-Za-z0-9.-])${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`, 'i');
  return valores.some((v) => re.test(v));
}

/**
 * Servicios con webhooks en nombres que redirigen al pasar (`hosts` en modo
 * «redirigir»): los suyos propios y los que aparecen en su entorno resuelto
 * (un bot sin dominio que registra `${{api.PUBLIC_URL}}/tg` recibe en el nombre
 * de `api`). Antes de pasar se mira el nombre anterior y, ya pasado
 * (`pasada`), también el nuevo: la variable ya dice el nuevo, pero el webhook
 * se registró en el proveedor con el anterior. Un bot de polling sin dominio
 * ni URL a un nombre del proyecto no recibe webhooks y no sale.
 */
function webhooksEnRiesgo(projectId: string, hosts: readonly HostPlan[], pasada = false): WebhookEnRiesgo[] {
  const redirigen = hosts.filter((h) => h.modo === 'redirigir');
  if (redirigen.length === 0) return [];
  const out: WebhookEnRiesgo[] = [];
  for (const s of listServices(projectId)) {
    if (s.type === 'database') continue;
    const entorno = resolveServiceEnv(s);
    const { proveedores, evidencias } = proveedoresDeServicio(s, entorno);
    if (proveedores.length === 0) continue;
    const valores = Object.values(entorno);
    if (s.type === 'git') valores.push(...Object.values((s.config as GitConfig).buildArgs ?? {}).filter((v): v is string => typeof v === 'string'));
    const vistos = new Set<string>();
    const suyos = redirigen.filter((h) => {
      if (vistos.has(h.from)) return false;
      const recibe = h.serviceId === s.id || mencionaHost(valores, h.from) || (pasada && mencionaHost(valores, h.to));
      if (recibe) vistos.add(h.from);
      return recibe;
    });
    if (suyos.length === 0) continue;
    out.push({ serviceId: s.id, serviceName: s.name, proveedores, evidencias, hosts: suyos.map((h) => ({ serviceId: h.serviceId, from: h.from, to: h.to })) });
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

/** Una dirección de `dominio` (también dentro de una URL `smtp://usuario%40dominio:…`). */
function direccionDe(dominio: string): RegExp {
  return new RegExp(`@${dominio.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9.-])`, 'i');
}

function decodificar(valor: string): string {
  try {
    return decodeURIComponent(valor);
  } catch {
    return valor;
  }
}

/**
 * Servicios de OTROS proyectos que envían con direcciones de `fromDomain`
 * desde el mismo cliente de correo. Los proyectos de una cuenta comparten su
 * cliente de Mailway (Skyway 0.38): el dominio de correo y sus buzones son de
 * toda la cuenta y el cambio de Mailway los muda todos, pero el asistente solo
 * cambia las variables y despliega los servicios de SU proyecto. Tras la baja
 * (o al actualizar el usuario de un buzón), esas aplicaciones se quedarían con
 * un usuario o un remitente que ya no existen. Se miran las variables de
 * correo (usuario, remitente y URL SMTP, también con un prefijo propio:
 * `mailRoleLoose`) de sus servicios y las compartidas de su proyecto, las
 * escribiera Skyway o no.
 */
function enviosDeOtrosProyectos(projectId: string, clientId: string, fromDomain: string): string[] {
  const direccion = direccionDe(fromDomain);
  const usa = (vars: Record<string, string>) =>
    Object.entries(vars).some(([key, value]) => {
      const role = mailRoleLoose(key);
      return (role === 'user' || role === 'from' || role === 'url') && direccion.test(decodificar(value));
    });
  const out: string[] = [];
  for (const link of listMailwayLinksByClient(clientId)) {
    if (link.project_id === projectId) continue;
    const proyecto = link.project_name ?? link.project_id;
    if (usa(getProjectVars(link.project_id))) out.push(`«${proyecto}» (variables compartidas)`);
    for (const s of listServices(link.project_id)) {
      if (s.type !== 'database' && usa(getEnv(s.id))) out.push(`«${proyecto} / ${s.name}»`);
    }
  }
  return out;
}

/** Por qué el correo de `fromDomain` no se puede cambiar desde este proyecto (`enviosDeOtrosProyectos`), o null. */
function bloqueoCorreoCompartido(projectId: string, clientId: string, fromDomain: string): string | null {
  const otros = enviosDeOtrosProyectos(projectId, clientId, fromDomain);
  if (otros.length === 0) return null;
  const lista = otros.length > 3 ? `${otros.slice(0, 3).join(', ')} y ${otros.length - 3} más` : otros.join(', ');
  return (
    `El correo de ${fromDomain} es de toda la cuenta y también envían con él servicios de otros proyectos (${lista}). ` +
    'Este asistente solo actualiza los servicios de este proyecto: cambia antes el usuario y el remitente de esos servicios, desconecta su correo o cambia solo la web.'
  );
}

/** Lo mismo que `bloqueoCorreoCompartido`, como error de una acción del cambio. */
function exigirCorreoNoCompartido(row: DomainMigrationRow, link: MailwayLinkRow): void {
  const motivo = bloqueoCorreoCompartido(row.project_id, link.client_id, row.from_domain);
  if (motivo) throw new ErrorCambio(409, 'migration_shared_mail', `${motivo} No se ha cambiado nada.`);
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
    // Mailway no bloquea un cambio idéntico al que ya está abierto (crear lo
    // devuelve, es idempotente), pero si no lo abrió este proyecto no se
    // puede gestionar desde aquí (`exigirCambioPropio`): se dice ya en el plan.
    const compartido = correo.link ? bloqueoCorreoCompartido(project.id, correo.link.client_id, fromDomain) : null;
    if (compartido) bloqueos.push(compartido);
    const enCambio = correo.dominio.migracion;
    const propio = !!abierta && abierta.from_domain === fromDomain && abierta.to_domain === toDomain;
    if (enCambio && !propio && !planCorreo.bloqueos.some((b) => b.code === 'migration_exists')) {
      bloqueos.push(
        `${fromDomain} ya está en un cambio de dominio abierto en Mailway que no se ha abierto desde este proyecto (por ejemplo, desde el panel de Mailway). Continúalo allí, o cancélalo antes de cambiar el dominio desde Skyway.`,
      );
    }
  } else if (!soloWeb && correo.disponible === 'mailway_antiguo') {
    bloqueos.push('Actualiza Mailway a la 1.3 para cambiar el dominio del correo.');
  } else if (correoError) {
    avisos.push(`Solo la web: no se ha podido consultar el correo en Mailway (${correoError.replace(/\.$/, '')}) y no se cambia.`);
  } else if (correo.disponible !== 'si' || soloWeb) {
    avisos.push(
      correo.disponible === 'si' || correo.disponible === 'mailway_antiguo'
        ? `Solo la web: el correo de ${fromDomain} sigue en Mailway sin cambios.`
        : correo.sinModulo
          ? `Solo la web: el módulo «Correo» no está activo en este workspace, así que el correo de ${fromDomain} no se cambia.`
          : `Solo la web: el correo de ${fromDomain} no está en Mailway.`,
    );
  }
  if (!relacionados && activos.length === 0 && !planCorreo) {
    bloqueos.push(`No hay nada que cambiar: ningún servicio de este proyecto usa ${fromDomain}${soloWeb ? '' : ' y su correo no está en Mailway'}.`);
  }

  const direcciones = planCorreo ? [...planCorreo.buzones, ...planCorreo.alias].map((x) => ({ from: x.de, to: x.a })) : [];
  const vars = planVariables(project.id, hosts, direcciones, fromDomain, body.excluidas ?? []);

  if (!relacionados) avisos.push(...avisosDelProyecto(project.id, hosts, fromDomain, toDomain), ...avisosServirPrincipal(project.id, hosts));

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
    servicios: alPasarVista(afectados),
    webhooks: relacionados ? [] : webhooksEnRiesgo(project.id, hosts),
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
      if (abierta.from_domain !== from || abierta.to_domain !== to) throw new ErrorCambio(409, 'migration_exists', yaHayUnoAbierto(abierta));
      // Repetir «Preparar» tras una respuesta perdida de Mailway termina de vincular el correo.
      if (!abierta.solo_web && !abierta.mailway_migration_id && ['preparando', 'lista'].includes(abierta.estado)) {
        await comprobarSinCerrojo(project, abierta, isAdmin).catch(() => {
          /* el error queda en la compuerta del correo */
        });
      }
      return { status: 200, vista: await vistaMigracion(getCambioSkyway(abierta.id) ?? abierta, isAdmin) };
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
        exigirCambioPropio(vista, project.id);
        updateDomainMigration(row.id, { mailway_migration_id: vista.id });
        guardarCorreo(vista);
        reservarNombresDelCorreo(vista, project.id);
      } catch (err) {
        if (!puedeHaberseHecho(err)) {
          // Mailway lo ha rechazado: sin el correo el cambio no está completo y
          // se deshace lo propio (y su prepublicación, que dejaría los nombres
          // reservados sin uso).
          deleteDomainMigration(row.id);
          throw err;
        }
        // Sin respuesta (plazo, red, 5xx), Mailway pudo crearlo igualmente y, con
        // origen «skyway», nadie podría cerrarlo desde su panel. El cambio se
        // conserva con el error: la comprobación lo busca en Mailway y lo
        // vincula (crear es idempotente), y «Cancelar» lo cancela allí si existe.
        updateDomainMigration(row.id, { error: `No se ha podido confirmar el cambio del correo en Mailway: ${mensajeDe(err)}` });
      }
    }

    // DNS de la web: solo la administración, en las zonas del Cloudflare del operador.
    const dns = await dnsAutomaticoAdmin(req, activos.map((h) => h.to), { type: 'project', id: project.id }, project.id);
    audit(req, 'domain_migration_created', { type: 'project', id: project.id, detail: `${from} → ${to}` });

    const actual = getCambioSkyway(row.id)!;
    await comprobarSinCerrojo(project, actual, isAdmin).catch(() => {
      /* la primera comprobación es un adelanto: el asistente vuelve a comprobar */
    });
    return { status: 201, vista: await vistaMigracion(getCambioSkyway(row.id)!, isAdmin), ...(dns ? { dns } : {}) };
  });
}

// ---------- comprobar ----------

/**
 * DNS y certificado de un nombre nuevo. El proxy de Cloudflare es la forma
 * recomendada de servir una web y el DNS automático lo pone con HTTPS: a la
 * administración, un nombre con el proxy se comprueba con la API de
 * Cloudflare, como en «Comprobar DNS» (`routes/domains.ts`). Sin ella (quien
 * comprueba no administra, o el token no ve la zona), no se puede saber a
 * dónde lleva: vale si ya se comprobó que apuntaba aquí y, si no, no se
 * prepublica (Traefik no vuelve a pedir un certificado que falló). Un CAA que
 * no autoriza a Let's Encrypt deja el DNS correcto y el certificado
 * pendiente, con el registro que falta.
 */
async function estadoHost(host: string, isAdmin: boolean): Promise<EstadoHostWeb> {
  const chk = await checkDomain(host, isAdmin ? { verificar: verificarEnCloudflare } : {});
  let dns: EstadoDnsHost = chk.status === 'ok' || chk.status === 'caa' ? 'ok' : chk.status === 'unknown' ? 'desconocido' : 'pendiente';
  let detalle = chk.message;
  if (chk.status === 'cloudflare_proxy') {
    dns = getPrepublished(host)?.dns_ok_at ? 'ok' : 'desconocido';
    if (dns !== 'ok') {
      detalle =
        `${host} pasa por el proxy de Cloudflare y desde aquí no se puede comprobar a dónde lleva. ` +
        'Desactiva el proxy de ese nombre mientras se prepara el cambio (puedes activarlo de nuevo después de pasar) o pide a la administración que lo compruebe.';
    }
  }
  if (dns === 'ok' && getPrepublished(host)?.dns_ok_at == null) markPrepublishedDns(host, Date.now());
  if (!tlsEnabled()) return { dns, certificado: 'sin_tls', detalle };
  if (dns !== 'ok') return { dns, certificado: 'pendiente', detalle: `Esperando al DNS de ${host}. ${detalle}` };
  if (chk.status === 'caa') return { dns, certificado: 'pendiente', detalle };
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
  if (!row.solo_web) {
    const ok = !!row.mailway_migration_id && correo?.estado === 'listo';
    out.push({
      id: 'correo',
      ok,
      bloquea: true,
      titulo: 'Correo en Mailway',
      detalle: correoError
        ? `No se ha podido consultar el correo en Mailway: ${correoError}`
        : !row.mailway_migration_id
          ? `El cambio del correo de ${row.to_domain} todavía no está confirmado en Mailway.`
          : ok
            ? `${row.to_domain} está listo para el cambio del correo.`
            : `El correo de ${row.to_domain} todavía se está preparando.`,
    });
  }
  return out;
}

/**
 * ¿Pudo Mailway hacer lo que se le pidió aunque Skyway no haya recibido la
 * respuesta? Si vence el plazo, se corta la conexión o responde un 5xx (un
 * proxy que dejó de esperar), sí. Sus 4xx describen la petición: no.
 */
function puedeHaberseHecho(err: unknown): boolean {
  if (!(err instanceof MailwayError)) return false;
  if (err.kind === 'timeout' || err.kind === 'network') return true;
  return err.kind === 'http' && err.status !== null && err.status >= 500;
}

/** Una vista de cambio de Mailway válida: al menos el id y el estado (lo demás se lee con tolerancia). */
function esVistaCambio(v: unknown): v is CambioDominioVista {
  const x = v as Partial<CambioDominioVista> | null;
  return !!x && typeof x === 'object' && typeof x.id === 'string' && typeof x.estado === 'string';
}

/**
 * 409 si el cambio que devuelve Mailway no lo abrió este proyecto: uno creado
 * desde el panel de Mailway (origen «panel») o desde otro proyecto. Crear es
 * idempotente con el mismo origen y destino, así que Mailway devuelve el que
 * ya existe; adoptarlo dejaría el asistente sin salida en cuanto su dueño lo
 * pasara o lo cancelara por su cuenta (la compuerta del correo no vería nunca
 * «listo» y pasar o cancelar responderían 409).
 */
function exigirCambioPropio(vista: CambioDominioVista, projectId: string): void {
  if (vista.origen === 'skyway' && vista.referenciaExterna === projectExternalRef(projectId)) return;
  const dominio = vista.desde?.domain ?? 'El dominio';
  throw new ErrorCambio(
    409,
    'migration_exists',
    vista.origen === 'skyway'
      ? `${dominio} ya está en un cambio de dominio abierto en Mailway que se gestiona desde otro proyecto de Skyway. Termínalo o cancélalo allí antes de empezar otro.`
      : `${dominio} ya está en un cambio de dominio abierto en Mailway, creado desde su panel. Continúalo allí, o cancélalo antes de cambiar el dominio desde Skyway.`,
  );
}

/**
 * Los nombres que Mailway ha creado en Cloudflare para el cambio
 * (autoconfiguración, el webmail de marca blanca, los que crea al cambiar el
 * MX) apuntan aquí: solo este proyecto puede asignárselos a un servicio.
 * Mailway los crea a lo largo de la preparación (el webmail, cuando se prueba
 * la propiedad), así que se reservan en cada respuesta, no solo al crear. Un
 * nombre que ya tiene reserva se deja como está: la administración pudo
 * pasarlo a otro proyecto.
 */
function reservarNombresDelCorreo(vista: CambioDominioVista, projectId: string): void {
  const nombres = (Array.isArray(vista.nombresCloudflare) ? vista.nombresCloudflare : []).filter(
    (n): n is string => typeof n === 'string' && !!n.trim() && !getMailwayDnsReserva(n),
  );
  if (nombres.length > 0) reservarNombresMailway(nombres, projectId);
}

/**
 * Cambio con el correo cuyo alta en Mailway no se pudo confirmar (respuesta
 * perdida al preparar, o un reinicio entre crearlo y anotarlo): se busca en
 * Mailway por la referencia del proyecto y, si no está y `crear`, se vuelve a
 * pedir (crear es idempotente: con el mismo origen y destino, Mailway
 * devuelve el que ya existe). Devuelve la fila, vinculada si se ha podido.
 */
async function vincularCorreo(project: ProjectRow, row: DomainMigrationRow, isAdmin: boolean, crear: boolean): Promise<DomainMigrationRow> {
  if (row.solo_web || row.mailway_migration_id) return row;
  const ctx = await contextoCorreo(project, row.from_domain, isAdmin);
  if (ctx.disponible !== 'si' || !ctx.dominio || !ctx.link) {
    // Sin vínculo o sin el dominio ya no hay nada que buscar con el token: cancelar sigue adelante.
    if (!crear) return row;
    throw new ErrorCambio(409, 'mail_unavailable', `El correo de ${row.from_domain} ya no está disponible en Mailway para este proyecto.`);
  }
  if (row.mailway_client_id && row.mailway_client_id !== ctx.link.client_id) {
    if (!crear) return row;
    throw new ErrorCambio(
      409,
      'migration_other_client',
      'El correo de este proyecto está vinculado ahora a otro cliente de Mailway: el cambio de dominio del correo ya no se puede gestionar desde aquí.',
    );
  }
  const ref = projectExternalRef(project.id);
  const lista = await mailwayFetch<{ migraciones?: unknown }>(
    `/api/domain-migrations?clientId=${encodeURIComponent(ctx.link.client_id)}&domainId=${encodeURIComponent(ctx.dominio.id)}`,
  );
  let vista: CambioDominioVista | null =
    (Array.isArray(lista?.migraciones) ? lista.migraciones : [])
      .filter(esVistaCambio)
      .find(
        (v) =>
          v.referenciaExterna === ref &&
          normalizarNombre(v.desde?.domain ?? '') === row.from_domain &&
          normalizarNombre(v.hacia?.domain ?? '') === row.to_domain &&
          v.estado !== 'dado_de_baja' &&
          v.estado !== 'cancelada',
      ) ?? null;
  if (!vista && crear) {
    vista = await createDomainMigration(
      { fromDomainId: ctx.dominio.id, toDomain: row.to_domain, referenciaExterna: ref, autoDns: true, origen: 'skyway' },
      { soloCliente: !isAdmin },
    );
    if (vista.clientId === ctx.link.client_id) exigirCambioPropio(vista, project.id);
  }
  if (!vista) return row;
  if (vista.clientId !== ctx.link.client_id) {
    throw new MailwayError('http', 'La respuesta de Mailway no corresponde al cliente vinculado.', 502);
  }
  updateDomainMigration(row.id, { mailway_migration_id: vista.id, mailway_client_id: ctx.link.client_id, error: null });
  guardarCorreo(vista);
  reservarNombresDelCorreo(vista, project.id);
  return getCambioSkyway(row.id) ?? row;
}

/** Mide los nombres nuevos y el correo y deja el cambio en «lista» o «preparando». Quien llama tiene el cerrojo. */
async function comprobarSinCerrojo(project: ProjectRow, inicial: DomainMigrationRow, isAdmin: boolean): Promise<Compuerta[]> {
  let row = inicial;
  const nuevos = [...new Set(hostsActivos(row.hosts).map((h) => h.to))];
  const web = new Map<string, EstadoHostWeb>();
  const resultados = await Promise.all(nuevos.map(async (h) => [h, await estadoHost(h, isAdmin)] as const));
  for (const [h, e] of resultados) web.set(h, e);
  cacheWeb.set(row.id, web);

  let correo: CambioDominioVista | null = null;
  let correoError: string | null = null;
  if (!row.solo_web && !row.mailway_migration_id) {
    try {
      row = await vincularCorreo(project, row, isAdmin, true);
    } catch (err) {
      correoError = mensajeDe(err);
      // El motivo queda en la fila: la vista lo enseña (un cambio ajeno en
      // Mailway no se resuelve solo y la interfaz tiene que decir por qué).
      updateDomainMigration(row.id, { error: `No se ha podido confirmar el cambio del correo en Mailway: ${correoError}` }, { siEstado: ['preparando', 'lista'] });
    }
  }
  if (row.mailway_migration_id) {
    try {
      const vista = await checkDomainMigration(row.mailway_migration_id);
      if (row.mailway_client_id && vista.clientId !== row.mailway_client_id) {
        throw new MailwayError('http', 'La respuesta de Mailway no corresponde al cliente de este cambio de dominio.', 502);
      }
      correo = guardarCorreo(vista);
      reservarNombresDelCorreo(vista, project.id);
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
    // Fuera de la preparación no hay nada que medir: se refresca el correo y
    // se anotan los despliegues que otro posterior ya ha resuelto.
    if (row.mailway_migration_id) cacheCorreo.delete(row.mailway_migration_id);
    return vistaMigracion(ESTADOS_EN_CURSO.includes(row.estado) ? row : conciliarServicios(row), isAdmin);
  }
  return withLockProyecto(project.id, async () => {
    const actual = conciliarServicios(cambioDelProyecto(project, mid));
    if (actual.estado === 'preparando' || actual.estado === 'lista') await comprobarSinCerrojo(project, actual, isAdmin);
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
  const avisos: string[] = [...(avisosAccion.get(row.id) ?? [])];
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
      alPasar = alPasarVista(serviciosAfectados(row.project_id, row.hosts, plan.cambios, mapaDe(plan.direcciones)));
    } catch (err) {
      avisos.push(`No se ha podido calcular el cambio de las variables: ${mensajeDe(err)}`);
    }
    avisos.push(...avisosDelProyecto(row.project_id, row.hosts, row.from_domain, row.to_domain), ...avisosServirPrincipal(row.project_id, row.hosts));
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

  // El estado real de cada despliegue (uno posterior puede haber resuelto un
  // error). Los servicios eliminados no se enseñan: no queda nada que hacer con ellos.
  const serviciosVista = Object.entries(row.servicios).filter(([serviceId]) => servicios.has(serviceId)).map(([serviceId, s]) => {
    const e = estadoServicio(serviceId, s);
    const dep = e.deploymentId ? getDeployment(e.deploymentId) : undefined;
    return {
      serviceId,
      nombre: servicios.get(serviceId)?.name ?? 'Servicio eliminado',
      despliegue: dep ? { id: dep.id, estado: dep.status } : null,
      estado: e.estado,
      error: e.error,
    };
  });
  const sinDesplegar = serviciosVista.filter((s) => s.estado !== 'ok');
  if (row.estado === 'cancelada') {
    const creados = hostsActivos(row.hosts).filter((h) => getCloudflareDnsRecord(h.to)?.project_id === row.project_id);
    if (creados.length > 0) {
      avisos.push(
        `Los registros DNS creados en Cloudflare para ${creados.map((h) => h.to).join(', ')} se conservan, reservados a este proyecto.`,
      );
    }
  }

  // `solo_web`, no el id de Mailway: un cambio con el correo cuyo alta en
  // Mailway no se pudo confirmar sigue siendo un cambio con el correo.
  const conCorreo = !row.solo_web;
  // Correo de la cuenta que también usan otros proyectos para enviar: la baja
  // (y actualizar el usuario de un buzón) los dejaría sin poder hacerlo.
  const compartido =
    conCorreo && row.mailway_client_id && (row.estado === 'pasada' || row.estado === 'dando_de_baja')
      ? bloqueoCorreoCompartido(row.project_id, row.mailway_client_id, row.from_domain)
      : null;
  if (compartido) avisos.push(compartido);
  const bajaBloqueada = !!compartido || (correo?.bloqueosBaja ?? []).some((b) => b.code !== 'mailbox_used_by_app');
  const conError = !!row.error;
  const redirecciones = listDomainRedirects(row.id);

  // Webhooks en nombres que redirigen: antes de pasar, los del mapa; después,
  // los que siguen redirigiendo (no los que ya se sirven también).
  let webhooks: WebhookEnRiesgo[] = [];
  if (!opts.ligera && (row.estado === 'preparando' || row.estado === 'lista')) {
    webhooks = webhooksEnRiesgo(row.project_id, row.hosts);
  } else if (!opts.ligera && row.estado === 'pasada') {
    const redirigen = new Set(redirecciones.map((r) => r.host));
    webhooks = webhooksEnRiesgo(row.project_id, row.hosts.filter((h) => redirigen.has(h.from)), true);
  }
  let usuariosSinGestionar: UsuarioSinGestionar[] = [];
  let appsManuales: MigracionSkyway['appsManuales'] = [];
  if (correo && !opts.ligera && (row.estado === 'pasada' || row.estado === 'dando_de_baja')) {
    const ctx = contextoUsos(row.project_id);
    usuariosSinGestionar = usuariosSinGestionarDe(ctx, row, correo);
    appsManuales = appsManualesDe(ctx, row, correo);
  }

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
    redirecciones: redirecciones.map((r) => ({ host: r.host, toHost: r.to_host, permanenteDesde: r.permanent_from })),
    correo,
    variables,
    alPasar,
    webhooks,
    usuariosSinGestionar,
    appsManuales,
    ipServidor: opts.ligera ? null : (await getServerIp()).ip,
    avisos,
    puedePasar: (row.estado === 'lista' && compuertasOk) || (row.estado === 'pasando' && conError),
    puedeVolver: row.estado === 'pasada' || ((row.estado === 'pasando' || row.estado === 'volviendo') && conError),
    // Cerrar el cambio con un servicio sin desplegar dejaría su nombre sin servir
    // (o su aplicación con el usuario SMTP anterior): antes, «Reintentar este servicio».
    puedeCancelar: (row.estado === 'preparando' || row.estado === 'lista') && sinDesplegar.length === 0,
    puedeDarDeBaja:
      conCorreo &&
      sinDesplegar.length === 0 &&
      ((row.estado === 'pasada' && CORREO_DE_BAJA.includes(correo?.estado ?? '') && !bajaBloqueada) ||
        (row.estado === 'dando_de_baja' && conError)),
    puedeTerminar: !conCorreo && row.estado === 'pasada' && sinDesplegar.length === 0,
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
/**
 * Lanza el despliegue de un servicio afectado y lo anota en el cambio.
 * `correo`: es el que pone al día su usuario de correo; se guarda con él para
 * retomar su seguimiento (reintento y alerta) tras un reinicio.
 */
function desplegar(mid: string, service: ServiceRow, opts: { imageTag?: string; correo?: CorreoDelDespliegue } = {}): string {
  markManualAction(service.id);
  let depId: string;
  try {
    depId = triggerDeploy(service.id, 'cambio-de-dominio', opts.imageTag ? { imageTag: opts.imageTag } : {}).id;
  } catch (err) {
    // Sin despliegue, el servicio tiene la configuración nueva y el contenedor
    // anterior: queda en error para que nadie cierre el cambio sin reintentarlo.
    setDomainMigrationServicio(mid, service.id, { deploymentId: null, estado: 'error', error: mensajeDe(err) });
    throw err;
  }
  const entrada: ServicioConCorreo = { deploymentId: depId, estado: 'desplegando', error: null, ...(opts.correo ? { correo: opts.correo } : {}) };
  setDomainMigrationServicio(mid, service.id, entrada);
  return depId;
}

interface EstadoServicio {
  estado: 'ok' | 'desplegando' | 'error';
  deploymentId: string | null;
  error: string | null;
}

/**
 * Estado real del despliegue de un servicio afectado. Manda el que sigue el
 * cambio mientras está en curso o si terminó bien; si falló, un despliegue
 * POSTERIOR del servicio lo resuelve: el reintento automático tras un
 * reinicio de Skyway (`resumeInterruptedDeployments`, que lanza otro y deja el
 * original como fallido) o uno manual, que ya llevan la configuración del
 * cambio. Sin esto, un servicio arreglado a mano seguiría bloqueando el cierre.
 */
function estadoServicio(serviceId: string, s: ServicioMigracion): EstadoServicio {
  if (s.estado === 'ok') return { estado: 'ok', deploymentId: s.deploymentId, error: null };
  // Un servicio eliminado no sirve ningún nombre ni envía correo: no hay nada
  // que esperar de él. Sus despliegues se borraron con él, así que ninguno
  // posterior resolvería su error y bloquearía para siempre cerrar el cambio.
  if (!getService(serviceId)) return { estado: 'ok', deploymentId: null, error: null };
  // Sin despliegue que fechar (no se pudo lanzar), solo lo resuelve «Reintentar este servicio».
  if (!s.deploymentId) return { estado: 'error', deploymentId: null, error: s.error ?? 'El despliegue no se ha podido lanzar.' };
  const propio = getDeployment(s.deploymentId);
  if (propio && DESPLIEGUE_EN_CURSO.has(propio.status)) return { estado: 'desplegando', deploymentId: propio.id, error: null };
  if (propio?.status === 'success') return { estado: 'ok', deploymentId: propio.id, error: null };
  const posteriores = listDeployments(serviceId, 20).filter((d) => d.id !== s.deploymentId && d.created_at >= (propio?.created_at ?? 0));
  const bien = posteriores.find((d) => d.status === 'success');
  if (bien) return { estado: 'ok', deploymentId: bien.id, error: null };
  const enCurso = posteriores.find((d) => DESPLIEGUE_EN_CURSO.has(d.status));
  if (enCurso) return { estado: 'desplegando', deploymentId: enCurso.id, error: null };
  return {
    estado: 'error',
    deploymentId: s.deploymentId,
    error: s.error || propio?.error || 'El despliegue no ha terminado bien.',
  };
}

/** Servicios del cambio que no han terminado de desplegarse bien (en curso o con error). */
function serviciosSinDesplegar(
  row: DomainMigrationRow,
): { serviceId: string; nombre: string; estado: 'desplegando' | 'error'; error: string | null }[] {
  const out: { serviceId: string; nombre: string; estado: 'desplegando' | 'error'; error: string | null }[] = [];
  for (const [sid, s] of Object.entries(row.servicios)) {
    const e = estadoServicio(sid, s);
    if (e.estado !== 'ok') out.push({ serviceId: sid, nombre: getService(sid)?.name ?? 'un servicio eliminado', estado: e.estado, error: e.error });
  }
  return out;
}

/**
 * 409 si algún servicio del cambio no está desplegado: cerrar el cambio (o
 * dar de baja el dominio anterior) dejaría un nombre sin servir o una
 * aplicación enviando con un usuario que deja de existir.
 */
function exigirServiciosDesplegados(row: DomainMigrationRow, accion: string): void {
  const [primero] = serviciosSinDesplegar(row);
  if (!primero) return;
  throw new ErrorCambio(
    409,
    'migration_services_pending',
    primero.estado === 'desplegando'
      ? `«${primero.nombre}» se está desplegando: espera a que termine antes de ${accion}.`
      : `El despliegue de «${primero.nombre}» ha fallado: pulsa «Reintentar este servicio» antes de ${accion}.`,
  );
}

/**
 * Anota en la fila lo que `estadoServicio` deduce de los despliegues (un
 * error que otro despliegue resolvió) y retira la prepublicación del servicio
 * que ya sirve sus nombres. Los que siguen en curso se dejan: los sigue quien
 * los lanzó (o el arranque).
 */
function conciliarServicios(row: DomainMigrationRow): DomainMigrationRow {
  let cambiado = false;
  for (const [sid, s] of Object.entries(row.servicios)) {
    if (s.estado === 'ok') continue;
    const e = estadoServicio(sid, s);
    if (e.estado === 'desplegando' || (e.estado === s.estado && e.deploymentId === s.deploymentId)) continue;
    setDomainMigrationServicio(row.id, sid, e);
    if (e.estado === 'ok') deletePrepublished(row.id, sid);
    cambiado = true;
  }
  return cambiado ? (getCambioSkyway(row.id) ?? row) : row;
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
  const entornos = fotoEntornos(projectId);

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

  // Los que usan la dirección (`${{api.PUBLIC_URL}}`) o una variable de un
  // servicio que acaba de cambiar: sin desplegar, seguirían con la anterior.
  for (const id of cambiaronDeEntorno(projectId, entornos)) idsAfectados.add(id);

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
      const lista = await comprobarSinCerrojo(project, row, isAdmin);
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
        // La web no se toca hasta que el correo haya pasado. Dónde se queda el
        // cambio lo dice Mailway: si su «Pasar» falló a medias (queda en
        // «pasando» con su error), aquí también, para ofrecer «Reintentar» y
        // «Volver»; volver a «lista» lo dejaría sin salida, porque Mailway ya no
        // está «listo» y no admite pasar desde «lista» ni cancelar.
        const tras = await correoTrasFallo(row);
        if (tras?.estado !== 'pasado') {
          const antes = !!tras && (tras.estado === 'listo' || tras.estado === 'preparando');
          updateDomainMigration(mid, { estado: antes ? 'lista' : 'pasando', error: mensajeDe(err), paso: '' });
          throw err;
        }
        // Mailway sí ha pasado (la respuesta se perdió): se sigue con la web.
        correo = tras;
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
    avisosAccion.delete(mid);
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
 * cambiado después), remitentes de vuelta y sin redirecciones (los nombres
 * viejos, prepublicados hasta que el contenedor nuevo los sirva).
 */
function restaurarWeb(
  row: DomainMigrationRow,
  remitentes: ReadonlyMap<string, string>,
  ahora: number,
  isAdmin: boolean,
): { afectados: ServiceRow[]; avisos: string[]; claves: Map<string, string[]> } {
  const projectId = row.project_id;
  const avisos: string[] = [];
  const ids = new Set<string>();
  const claves = new Map<string, string[]>();
  const anotar = (id: string, key: string) => claves.set(id, [...(claves.get(id) ?? []), key]);
  let compartidas = false;
  const noRestaurada = (key: string, donde: string | null) =>
    avisos.push(`No se ha restaurado ${key}${donde ? ` en «${donde}»` : ''}: cambió después del cambio de dominio.`);
  const entornos = fotoEntornos(projectId);

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
      const actuales = dominiosDe(service);
      const presentes = new Set(actuales.map(normalizarNombre));
      // Un nombre nuevo que el servicio ya no tiene (alguien lo quitó después
      // de pasar) se vuelve a añadir como secundario, pero solo si sigue
      // libre: otro proyecto pudo asignárselo entretanto, y dos servicios con
      // el mismo host se repartirían su tráfico (gana la regla más larga).
      const hosts = row.hosts.filter((h) => {
        if (h.serviceId !== service.id || !escritos.includes(h.to)) return false;
        if (h.modo === 'no_cambiar' || presentes.has(h.to)) return true;
        // Con el rol de quien vuelve: el mensaje solo nombra el proyecto ajeno a la administración.
        const conflicto = domainClaimError([h.to], { projectId, serviceId: service.id, isAdmin, current: actuales });
        if (conflicto) avisos.push(`No se ha vuelto a añadir ${h.to} a «${service.name}»: ${conflicto}`);
        return !conflicto;
      });
      const restaurados = dominiosTrasVolver(actuales, hosts);
      updateService(service.id, service.name, { ...(service.config as object), domains: restaurados } as ServiceRow['config']);
      // Los nombres que vuelven no los tiene el contenedor en marcha (solo los
      // nuevos) y su redirección se borra abajo: hasta que arranque el
      // siguiente (o para siempre, si su despliegue falla) no los serviría
      // nadie. Se prepublican con su DNS dado por bueno (ya apuntaba aquí); el
      // despliegue que termina bien retira la prepublicación (`seguirDespliegue`).
      const faltan = [...new Set(restaurados.map(normalizarNombre))].filter((d) => !presentes.has(d));
      if (faltan.length > 0) {
        const ajenos = upsertPrepublished(faltan.map((host) => ({ host, project_id: projectId, service_id: service.id, migration_id: row.id })));
        for (const host of faltan) if (!ajenos.includes(host)) markPrepublishedDns(host, ahora);
      }
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
  // Como al pasar: los que referencian un servicio que vuelve a sus nombres.
  for (const id of cambiaronDeEntorno(projectId, entornos)) ids.add(id);
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
        // Mailway admite volver desde «volviendo», así que el estado anterior
        // sigue ofreciendo «Volver» aunque su vuelta fallara a medias.
        cacheCorreo.delete(row.mailway_migration_id);
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
      resultado = transaction(() => restaurarWeb(row, remitentes, Date.now(), isAdmin));
    } catch (err) {
      updateDomainMigration(mid, { error: mensajeDe(err), paso: '' });
      throw err;
    }
    if (resultado.avisos.length > 0) avisosAccion.set(mid, resultado.avisos);
    else avisosAccion.delete(mid);
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
 *
 * Tras un «Volver», un buzón que se había actualizado sigue entrando con su
 * usuario de dominio2.es; al cancelar, Mailway le devuelve el de dominio.es
 * (la dirección de dominio2.es desaparece). Las aplicaciones que envían con
 * él se ponen al día justo después (usuario y remitente, y un despliegue con
 * la imagen en marcha), como en la baja: si no, se quedarían con un usuario
 * que ya no existe. Después de Mailway y no antes: si se niega a cancelar, ni
 * el buzón ni las aplicaciones han cambiado.
 */
export async function cancelarCambio(req: FastifyRequest, project: ProjectRow, mid: string): Promise<MigracionSkyway> {
  const isAdmin = currentUser(req)?.role === 'admin';
  const puede = (r: DomainMigrationRow) => r.estado === 'preparando' || r.estado === 'lista';
  exigirEstado(puede(cambioDelProyecto(project, mid)));
  return withLockProyecto(project.id, async () => {
    let row = conciliarServicios(cambioDelProyecto(project, mid));
    exigirEstado(puede(row));
    exigirServiciosDesplegados(row, 'cancelar el cambio');
    // Un alta en Mailway sin confirmar: si existe allí, se cancela también.
    row = await vincularCorreo(project, row, isAdmin, false);
    let conApps: BuzonVista[] = [];
    if (row.mailway_migration_id) {
      await correoDelCambio(project, row, isAdmin);
      const antes = await vistaCorreo(row, true);
      // Ya cancelado en Mailway (la respuesta se perdió y el cambio quedó aquí
      // abierto): no se vuelve a pedir, pero sus aplicaciones se repasan.
      const tras = guardarCorreo(antes.estado === 'cancelada' ? antes : await cancelDomainMigration(row.mailway_migration_id));
      const porId = new Map(tras.buzones.lista.map((b) => [b.id, b]));
      const ctx = contextoUsos(row.project_id);
      const actual = row;
      conApps = antes.buzones.lista.map((b) => porId.get(b.id) ?? b).filter((b) => conAplicaciones(ctx, actual, b));
    }
    let lanzados: DespliegueCorreo[] = [];
    let errorApps: string | null = null;
    if (conApps.length > 0) {
      try {
        ({ lanzados } = await ponerAlDiaApps(mid, row, conApps));
      } catch (err) {
        // El correo ya está cancelado en Mailway: el cambio se cierra igual y
        // el aviso dice qué falta (un servicio sin desplegar se ve en la lista).
        errorApps = mensajeDe(err);
      }
    }
    transaction(() => {
      deletePrepublished(mid);
      purgeSnapshots(mid);
      updateDomainMigration(mid, { estado: 'cancelada', terminada_at: Date.now(), error: null, paso: '' });
    });
    for (const l of lanzados) {
      enSegundoPlano(async () => {
        await seguirDespliegueCorreo(mid, l, PLAZO_DESPLIEGUE_BAJA_MS);
      });
    }
    cacheWeb.delete(mid);
    avisosAccion.delete(mid);
    if (errorApps) {
      avisosAccion.set(mid, [
        `No se han podido poner al día las aplicaciones que envían con los buzones del cambio: ${errorApps.replace(/\.$/, '')}. Revisa su usuario de correo en «Variables».`,
      ]);
    }
    audit(req, 'domain_migration_cancelled', { type: 'project', id: project.id, detail: `${row.from_domain} → ${row.to_domain}` });
    return vistaMigracion(cambioDelProyecto(project, mid), isAdmin);
  });
}

// ---------- servir también el nombre anterior ----------

export interface PeticionModoHost {
  serviceId: string;
  /** Uno o varios nombres del mismo servicio: tras pasar, todos con un solo despliegue. */
  from: string | string[];
  modo: 'servir' | 'redirigir';
}

function errorHostPrincipal(from: string, service: ServiceRow): ErrorCambio {
  return new ErrorCambio(
    409,
    'host_principal',
    `${from} pasaría a ser otra vez el dominio principal de «${service.name}» y cambiaría su PUBLIC_URL, que ya es la nueva. ` +
      'Vuelve a registrar el webhook con la URL nueva en el proveedor.',
  );
}

/**
 * «Servir también» nombres que redirigen (o volver a redirigirlos): un
 * webhook registrado en el proveedor con la URL anterior no sigue una
 * redirección (Telegram y Stripe la tratan como un fallo), así que el nombre
 * anterior se sigue sirviendo, sin redirigir.
 *
 * Antes de pasar solo cambia el modo de los nombres en el cambio, en los dos
 * sentidos, con el mismo criterio que la vista previa: servir también el
 * nombre que seguirá siendo el principal se admite, con su aviso
 * (`avisosServirPrincipal`). Después de pasar, solo de «redirigir» a
 * «servir», en una transacción: los nombres anteriores vuelven al final de
 * los dominios del servicio (el principal no cambia: su PUBLIC_URL ya es la
 * nueva y volver a la anterior a estas alturas obligaría a desplegar a quien
 * la usa; si cambiara, 409 `host_principal`), se borran sus redirecciones y
 * se prepublican con su DNS dado por bueno (ya apuntaba aquí) para que no
 * queden sin servir mientras se despliega el servicio con la imagen en
 * marcha. Varios nombres del mismo servicio van en una sola petición: con
 * uno por petición, el despliegue de la primera haría rechazar la segunda.
 * Un «Volver» posterior los trata como cualquier otro nombre que se sirve.
 * Idempotente: los nombres que ya tienen el modo pedido no cambian.
 */
export async function cambiarModoHost(
  req: FastifyRequest,
  project: ProjectRow,
  mid: string,
  body: PeticionModoHost,
): Promise<{ vista: MigracionSkyway; desplegado: boolean }> {
  const isAdmin = currentUser(req)?.role === 'admin';
  const nombres = sinRepetidos((Array.isArray(body.from) ? body.from : [body.from]).map(normalizarNombre));
  const admite = (r: DomainMigrationRow) => r.estado === 'preparando' || r.estado === 'lista' || r.estado === 'pasada';
  exigirEstado(admite(cambioDelProyecto(project, mid)));
  return withLockProyecto(project.id, async () => {
    const row = cambioDelProyecto(project, mid);
    exigirEstado(admite(row));
    const indices = nombres.map((from) => {
      const i = row.hosts.findIndex((h) => h.serviceId === body.serviceId && h.from === from);
      if (i < 0) throw new ErrorCambio(404, 'not_found', `${from} no forma parte de este cambio de dominio.`);
      return i;
    });
    const aCambiar = indices.filter((i) => row.hosts[i].modo !== body.modo);
    if (aCambiar.length === 0) return { vista: await vistaMigracion(row, isAdmin), desplegado: false };
    const quietos = aCambiar.filter((i) => row.hosts[i].modo === 'no_cambiar').map((i) => row.hosts[i].from);
    if (quietos.length > 0) {
      throw new ErrorCambio(409, 'migration_state', `${quietos.join(', ')} no cambia de nombre en este cambio de dominio: no hay redirección que cambiar.`);
    }
    if (row.estado === 'pasada' && body.modo !== 'servir') {
      throw new ErrorCambio(409, 'migration_state', 'Después de pasar, un nombre que se sirve también ya no puede volver a redirigir desde el asistente.');
    }
    const service = getService(body.serviceId);
    if (!service || service.project_id !== project.id || service.type === 'database') {
      throw new ErrorCambio(404, 'not_found', 'Servicio no encontrado.');
    }
    const cambiar = new Set(aCambiar);
    const hosts = row.hosts.map((h, j) => (cambiar.has(j) ? { ...h, modo: body.modo } : h));
    const froms = aCambiar.map((i) => row.hosts[i].from);
    const detalle = aCambiar.map((i) => `«${row.hosts[i].from}»: ${row.hosts[i].modo} → ${body.modo}`).join(', ');

    if (row.estado !== 'pasada') {
      if (!updateDomainMigration(row.id, { hosts }, { siEstado: [row.estado] })) throw errorEstado();
      audit(req, 'domain_migration_host_mode', { type: 'project', id: project.id, detail: detalle });
      return { vista: await vistaMigracion(cambioDelProyecto(project, mid), isAdmin), desplegado: false };
    }

    const raiz = getSetting('rootDomain');
    const actuales = dominiosDe(service);
    const principal = dominioPrincipal(sinRepetidos([...actuales, ...froms]), raiz);
    if (principal !== dominioPrincipal(actuales, raiz)) throw errorHostPrincipal(principal ?? froms[0], service);
    const conflicto = domainClaimError(froms, { projectId: project.id, serviceId: service.id, isAdmin, current: actuales });
    if (conflicto) throw new ErrorCambio(409, 'domain_in_use', conflicto);
    // Con un despliegue en curso (el de pasar, que compila la cabeza de la
    // rama), desplegar ahora la imagen en marcha lo dejaría en la versión
    // anterior en cuanto termine el otro.
    if (listDeployments(service.id, 5).some((d) => DESPLIEGUE_EN_CURSO.has(d.status))) {
      throw new ErrorCambio(
        409,
        'migration_services_pending',
        `«${service.name}» se está desplegando: espera a que termine para servir también ${froms.join(', ')}.`,
      );
    }
    // La imagen antes de tocar nada: entre la configuración y el despliegue no hay ninguna espera.
    const imageTag = await imagenEnMarcha(service);
    const ahora = Date.now();
    transaction(() => {
      const s = getService(service.id)!;
      updateService(s.id, s.name, { ...(s.config as object), domains: sinRepetidos([...dominiosDe(s), ...froms]) } as ServiceRow['config']);
      deleteDomainRedirectHosts(project.id, froms);
      const ajenos = upsertPrepublished(froms.map((host) => ({ host, project_id: project.id, service_id: s.id, migration_id: row.id })));
      if (ajenos.length > 0) {
        throw new ErrorCambio(409, 'domain_in_use', `El dominio ${ajenos[0]} lo utiliza otro proyecto (redirección o cambio de dominio en curso) y no se puede asignar a este servicio.`);
      }
      for (const host of froms) markPrepublishedDns(host, ahora);
      updateDomainMigration(row.id, { hosts });
      bumpConfigRev([s.id]);
    });
    const depId = desplegar(row.id, service, { imageTag });
    enSegundoPlano(async () => {
      await seguirDespliegue(row.id, service.id, depId);
    });
    audit(req, 'domain_migration_host_mode', { type: 'project', id: project.id, detail: detalle });
    return { vista: await vistaMigracion(cambioDelProyecto(project, mid), isAdmin), desplegado: true };
  });
}

// ---------- aplicaciones que envían correo con buzones del cambio ----------

type BuzonVista = CambioDominioVista['buzones']['lista'][number];

const usaAppsSkyway = (b: BuzonVista) => b.usadoPorApps.some((n) => n.startsWith('skyway:'));

/**
 * Servicios del proyecto por el nombre de su contraseña de aplicación de
 * Skyway: el de ahora y, en un vínculo de antes de compartir los clientes por
 * cuenta, también el de entonces (`credentialNames`).
 */
function serviciosPorCredencial(projectId: string): Map<string, ServiceRow> {
  const link = getMailwayLink(projectId);
  const out = new Map<string, ServiceRow>();
  for (const s of listServices(projectId)) {
    if (s.type === 'database') continue;
    for (const nombre of credentialNames(s, 'smtp', link ?? null)) out.set(nombre, s);
  }
  return out;
}

/** Una variable que entra en el correo con un usuario del buzón. */
interface UsoUsuario {
  ambito: 'service' | 'project';
  serviceId: string | null;
  serviceName: string | null;
  key: string;
  usuario: string;
}

/** Lo que se lee una vez para buscar los usos de todos los buzones de un cambio. */
interface ContextoUsos {
  /** `entorno`: el resuelto, con el que se despliega (referencias y compartidas incluidas). */
  servicios: { service: ServiceRow; state: EnvState; entorno: Record<string, string> }[];
  compartidas: Record<string, string>;
  porCredencial: Map<string, ServiceRow>;
  comoUsuario: ClavesUsuario;
}

function contextoUsos(projectId: string): ContextoUsos {
  return {
    servicios: listServices(projectId)
      .filter((s) => s.type !== 'database')
      .map((service) => ({ service, state: envStateOf(service), entorno: resolveServiceEnv(service) })),
    compartidas: getProjectVars(projectId),
    porCredencial: serviciosPorCredencial(projectId),
    comoUsuario: clavesUsuarioPorReferencia(projectId),
  };
}

/** Usuarios con los que se puede entrar en el buzón durante el cambio: su dirección en cada dominio y el de ahora. */
function loginsDe(row: DomainMigrationRow, b: BuzonVista): Set<string> {
  const local = parteLocal(b.email);
  return new Set([`${local}@${row.from_domain}`, `${local}@${row.to_domain}`, b.login.toLowerCase()]);
}

/**
 * Variables del proyecto que entran en el correo con un usuario del buzón y
 * que NO pone al día la credencial de Skyway del buzón: puestas a mano (un
 * `SMTP_USER` con una contraseña de aplicación creada a mano), con un nombre
 * propio (`TG_SMTP_LOGIN`), una URL SMTP, en un servicio sin la credencial o
 * compartidas. Las que escribió Skyway en el servicio de su credencial las pone
 * al día `refrescarVariablesCorreo` (`usuarioQueRefrescaSkyway`).
 *
 * Las de un servicio se miran con el valor con el que se despliegan (el
 * entorno resuelto): `SMTP_USER=${{shared.SMTP_USER}}` entra con la dirección
 * de la compartida y se enseña con su nombre. Las que solo hereda sin
 * definirlas ya salen como compartidas. Las variables con otro nombre a las
 * que apunta un usuario SMTP (`clavesUsuarioPorReferencia`) también cuentan.
 */
function usosSinGestionar(ctx: ContextoUsos, row: DomainMigrationRow, b: BuzonVista): UsoUsuario[] {
  const logins = loginsDe(row, b);
  const conCredencial = new Set(
    b.usadoPorApps
      .filter((n) => n.startsWith('skyway:'))
      .map((n) => ctx.porCredencial.get(n)?.id)
      .filter((id): id is string => !!id),
  );
  const out: UsoUsuario[] = [];
  for (const { service, state, entorno } of ctx.servicios) {
    const comoUsuario = ctx.comoUsuario.servicios.get(service.id);
    for (const [key, crudo] of Object.entries(state.env)) {
      const usuario = usuarioDeVariable(key, entorno[key] ?? crudo, comoUsuario?.has(key) ?? false);
      if (!usuario || !logins.has(usuario)) continue;
      if (conCredencial.has(service.id) && usuarioQueRefrescaSkyway(state, key)) continue;
      out.push({ ambito: 'service', serviceId: service.id, serviceName: service.name, key, usuario });
    }
  }
  for (const [key, valor] of Object.entries(ctx.compartidas)) {
    const usuario = usuarioDeVariable(key, valor, ctx.comoUsuario.proyecto.has(key));
    if (usuario && logins.has(usuario)) out.push({ ambito: 'project', serviceId: null, serviceName: null, key, usuario });
  }
  return out;
}

/**
 * Los usos sin gestionar que importan: los que entran hoy y dejarán de entrar
 * al actualizar el buzón o en la baja (`cambiara`) y los que ya no entran
 * (`no_entra`). Uno que entra con el usuario de ahora de un buzón ya
 * actualizado está bien y no sale.
 */
function usuariosSinGestionarDe(ctx: ContextoUsos, row: DomainMigrationRow, correo: CambioDominioVista): UsuarioSinGestionar[] {
  const out: UsuarioSinGestionar[] = [];
  for (const b of correo.buzones.lista) {
    const login = b.login.toLowerCase();
    const usos: UsuarioSinGestionar['usos'] = [];
    for (const u of usosSinGestionar(ctx, row, b)) {
      if (u.usuario !== login) usos.push({ ...u, estado: 'no_entra' });
      else if (b.pendiente) usos.push({ ...u, estado: 'cambiara' });
    }
    if (usos.length > 0) out.push({ mailboxId: b.id, email: b.email, login: b.login, pendiente: b.pendiente, usos });
  }
  return out;
}

/**
 * Buzones pendientes con contraseñas de aplicación creadas a mano (Mailway
 * 1.6+). Salen también los que usa algún servicio del proyecto: Skyway pone
 * al día ese servicio, pero no puede saber si la misma contraseña la usa
 * además una aplicación de fuera (un n8n, un cliente de correo), y esa tendrá
 * que entrar con la dirección nueva. Mailway ya descarta las revocadas y las
 * invalidadas.
 */
function appsManualesDe(ctx: ContextoUsos, row: DomainMigrationRow, correo: CambioDominioVista): MigracionSkyway['appsManuales'] {
  return correo.buzones.lista
    .filter((b) => b.pendiente && Array.isArray(b.appsManuales) && b.appsManuales.length > 0)
    .map((b) => ({
      mailboxId: b.id,
      email: b.email,
      apps: (b.appsManuales ?? []).filter((n): n is string => typeof n === 'string'),
      usadoEnProyecto: b.usadoPorApps.some((n) => ctx.porCredencial.has(n)) || usosSinGestionar(ctx, row, b).length > 0,
    }))
    .filter((a) => a.apps.length > 0);
}

/** ¿Hay servicios que poner al día con este buzón: los de su credencial de Skyway o variables sin gestionar? */
function conAplicaciones(ctx: ContextoUsos, row: DomainMigrationRow, b: BuzonVista): boolean {
  return usaAppsSkyway(b) || usosSinGestionar(ctx, row, b).length > 0;
}

/**
 * Lo que necesita el seguimiento de un despliegue que pone al día el usuario
 * de correo de un servicio. Se guarda con el servicio del cambio
 * (`servicios_json` guarda el objeto entero) para retomarlo, con su reintento
 * y su alerta, si Skyway se reinicia mientras tanto.
 */
interface CorreoDelDespliegue {
  /** Usuario con el que entraba (el del contenedor en marcha) y con el que entra ahora. */
  de: string;
  a: string;
  /** Imagen en marcha que se vuelve a desplegar (el reintento usa la misma). */
  imageTag?: string;
  /** Este despliegue ya es el reintento: si falla, no hay otro. */
  reintento: boolean;
}

type ServicioConCorreo = ServicioMigracion & { correo?: CorreoDelDespliegue };

/** Lo del correo de la entrada de un servicio del cambio, si lo tiene (leído de JSON: se comprueba). */
function correoDe(s: ServicioMigracion): CorreoDelDespliegue | null {
  const c = (s as ServicioConCorreo).correo;
  if (!c || typeof c !== 'object' || typeof c.de !== 'string' || typeof c.a !== 'string') return null;
  return { de: c.de, a: c.a, ...(typeof c.imageTag === 'string' ? { imageTag: c.imageTag } : {}), reintento: c.reintento === true };
}

/** Un despliegue que pone al día el usuario de correo de un servicio. */
interface DespliegueCorreo {
  serviceId: string;
  deploymentId: string;
  /** Imagen en marcha que se ha vuelto a desplegar (el reintento usa la misma). */
  imageTag?: string;
  /** Usuario con el que entraba (el del contenedor en marcha) y con el que entra ahora. */
  de: string;
  a: string;
}

/**
 * ¿Tiene el servicio alguna versión desplegada? Uno que nunca se ha
 * desplegado bien no tiene un contenedor que poner al día (su primer
 * despliegue ya saldrá con el usuario nuevo), y desplegarlo ahora compilaría
 * la cabeza de la rama sin que nadie lo haya pedido.
 */
function tieneVersionEnMarcha(s: ServiceRow): boolean {
  return listDeployments(s.id, 50).some((d) => d.status === 'success');
}

/**
 * Pone al día las aplicaciones que envían con buzones del cambio, buzón a
 * buzón: su usuario en Mailway (si sigue pendiente) y, justo después, las
 * variables de correo de sus servicios y un despliegue con la imagen que ya
 * está en marcha. La ventana sin poder enviar es la del relevo del contenedor.
 *
 * Se reescriben las variables de los servicios de su credencial de Skyway
 * (`refrescarVariablesCorreo`: usuario y remitente que escribió Skyway), las
 * que entran con un usuario del buzón por su cuenta
 * (`reescribirUsuariosSinGestionar`: un `SMTP_USER` con una contraseña creada
 * a mano, un `TG_SMTP_LOGIN`, una URL SMTP) y las compartidas. Se vuelven a
 * desplegar los servicios cuyo entorno resuelto cambia, como al pasar: los
 * reescritos, los que heredan la compartida y los que la referencian
 * (`SMTP_USER=${{shared.SMTP_USER}}`, `${{mailer.SMTP_USER}}`). Los que nunca
 * se han desplegado solo quedan pendientes.
 *
 * El orden (Mailway → variables → despliegue) no cambia: desplegar antes con
 * el usuario nuevo solo sería seguro con un único servicio por buzón y con
 * Mailway respondiendo; con dos, uno quedaría con un usuario que aún no
 * existe. Un despliegue que falla se reintenta una vez (`seguirDespliegueCorreo`).
 *
 * Se mira cada buzón, pendiente o no, y lo que decide si un servicio está al
 * día son SUS variables: si el usuario ya cambió en Mailway (una respuesta
 * perdida, una baja que falló a medias), el buzón ya no está pendiente pero
 * la aplicación puede seguir con el usuario anterior, que la baja elimina.
 * El usuario anterior es el de la misma parte local en el OTRO dominio del
 * cambio: el viejo en la baja (el buzón ya está en el nuevo) y el nuevo al
 * cancelar tras un «Volver» (el buzón ha vuelto al viejo y Mailway devuelve
 * a su dirección el usuario de quien lo había actualizado).
 * Devuelve los despliegues lanzados y los buzones cuyo usuario ha cambiado.
 */
async function ponerAlDiaApps(
  mid: string,
  row: DomainMigrationRow,
  buzones: readonly BuzonVista[],
): Promise<{ lanzados: DespliegueCorreo[]; actualizados: BuzonVista[] }> {
  const porCredencial = serviciosPorCredencial(row.project_id);
  const lanzados: DespliegueCorreo[] = [];
  const actualizados: BuzonVista[] = [];
  const imagenes = new Map<string, string | undefined>();
  const imagenDe = async (s: ServiceRow) => {
    if (!imagenes.has(s.id)) imagenes.set(s.id, await imagenEnMarcha(s));
    return imagenes.get(s.id);
  };
  for (const b of buzones) {
    const deCredencial = new Set(
      [...new Set(b.usadoPorApps)].map((n) => porCredencial.get(n)?.id).filter((id): id is string => !!id),
    );
    let nuevo = b.login.toLowerCase();
    if (b.pendiente) {
      // También sin servicios en el proyecto (una credencial de un servicio ya
      // borrado): Mailway no da de baja con buzones pendientes que usan apps.
      const { mailbox } = await updateMailboxLogin(b.id);
      nuevo = (mailbox.login || mailbox.email || b.email).toLowerCase();
      actualizados.push(b);
    }
    const usuarios = new Map<string, string>();
    const otro = dominioDe(b.email) === row.to_domain ? row.from_domain : row.to_domain;
    for (const viejo of [b.login, `${parteLocal(b.email)}@${otro}`]) {
      if (viejo.toLowerCase() !== nuevo) usuarios.set(viejo.toLowerCase(), nuevo);
    }
    if (usuarios.size === 0) continue;
    const comoUsuario = clavesUsuarioPorReferencia(row.project_id);
    const entraCon = (key: string, valor: string, marcadas?: ReadonlySet<string>) => {
      const u = usuarioDeVariable(key, valor, marcadas?.has(key) ?? false);
      return !!u && usuarios.has(u);
    };
    const servicios = listServices(row.project_id).filter((s) => s.type !== 'database');
    // El entorno resuelto antes de escribir: el de cada servicio que cambie se vuelve a desplegar.
    const antes = new Map(servicios.map((s) => [s.id, resolveServiceEnv(s)]));
    const candidatos = servicios.filter(
      (s) => deCredencial.has(s.id) || Object.entries(getEnv(s.id)).some(([k, v]) => entraCon(k, v, comoUsuario.servicios.get(s.id))),
    );
    // La imagen antes de tocar nada: entre las variables y el despliegue no
    // hay ninguna espera, así que no puede quedar una sin el otro. Se toma de
    // los que se reescriben y de los que entran con el usuario por herencia o
    // por referencia, que son los que van a cambiar.
    for (const s of servicios) {
      const previsto = candidatos.includes(s) || Object.entries(antes.get(s.id) ?? {}).some(([k, v]) => entraCon(k, v));
      if (previsto && tieneVersionEnMarcha(s)) await imagenDe(s);
    }

    const reescritos = new Set<string>();
    for (const s of candidatos) {
      // El remitente también: si alguien excluyó el suyo al pasar, la dirección
      // anterior deja de ser del buzón con la baja y el servidor la rechazaría.
      const refrescadas = deCredencial.has(s.id)
        ? refrescarVariablesCorreo(s.id, { usuarios, remitentes: usuarios }, { credencialSmtp: true })
        : [];
      const sueltas = reescribirUsuariosSinGestionar(s.id, usuarios, new Set(refrescadas), comoUsuario.servicios.get(s.id));
      if (refrescadas.length + sueltas.length > 0) reescritos.add(s.id);
    }
    reescribirUsuariosCompartidos(row.project_id, usuarios, comoUsuario.proyecto);

    const de = [...usuarios.keys()][0];
    for (const s of servicios) {
      const cambia = reescritos.has(s.id) || huellaEntorno(antes.get(s.id) ?? {}) !== huellaEntorno(resolveServiceEnv(s));
      if (!cambia) continue;
      bumpConfigRev([s.id]);
      if (!tieneVersionEnMarcha(s)) continue;
      // Uno que no se previó (referencia el remitente de otro servicio) espera
      // a su imagen ya con las variables escritas: queda pendiente si algo falla.
      const imageTag = imagenes.has(s.id) ? imagenes.get(s.id) : await imagenDe(s);
      const correo: CorreoDelDespliegue = { de, a: nuevo, ...(imageTag ? { imageTag } : {}), reintento: false };
      lanzados.push({ serviceId: s.id, deploymentId: desplegar(mid, s, { imageTag, correo }), ...(imageTag ? { imageTag } : {}), de, a: nuevo });
    }
  }
  return { lanzados, actualizados };
}

/** Por qué no ha terminado bien el despliegue con el usuario nuevo (para el error y la alerta). */
const MOTIVO_SIN_ENVIAR = {
  doble: 'ha fallado dos veces',
  reinicio: 'no ha terminado bien tras un reinicio de Skyway',
} as const;

/** Prefijo del error de un servicio cuyo despliegue con el usuario nuevo ha fallado dos veces. */
const FALLO_DOBLE = `El despliegue ${MOTIVO_SIN_ENVIAR.doble}`;

/**
 * El servicio tiene ya el usuario nuevo y su despliegue no ha terminado bien
 * (ha fallado dos veces, o un reinicio de Skyway lo cortó): el contenedor en
 * marcha sigue entrando con el anterior, que ya no existe, y no puede enviar.
 * Alerta crítica (se cierra sola con el siguiente despliegue correcto) y el
 * error en el servicio del cambio, con la salida.
 */
function avisarCorreoSinEnviar(
  mid: string,
  l: DespliegueCorreo,
  deploymentId: string | null,
  motivo: keyof typeof MOTIVO_SIN_ENVIAR = 'doble',
): void {
  const service = getService(l.serviceId);
  const nombre = service?.name ?? 'el servicio';
  const porque = MOTIVO_SIN_ENVIAR[motivo];
  setDomainMigrationServicio(mid, l.serviceId, {
    deploymentId,
    estado: 'error',
    error: `El despliegue ${porque} y «${nombre}» no puede enviar correo: su usuario ya es ${l.a} y el contenedor en marcha sigue con ${l.de}. Pulsa «Reintentar este servicio».`,
  });
  if (!service) return;
  fireAlert({
    severity: 'critical',
    type: 'mail_login_deploy_failed',
    serviceId: service.id,
    dedupe: true,
    title: `«${service.name}» no puede enviar correo`,
    message: `El usuario de correo de «${service.name}» ha cambiado a ${l.a} y su despliegue ${porque}: el contenedor en marcha sigue entrando con ${l.de}, que ya no es válido.`,
    explanation: 'Abre «Cambiar de dominio» en el proyecto y pulsa «Reintentar este servicio». Si vuelve a fallar, revisa el registro del despliegue.',
  });
}

/** ¿Sigue el cambio pendiente de este despliegue del servicio (no lo ha sustituido otro)? */
function sigueSiendoDelCambio(mid: string, serviceId: string, deploymentId: string): boolean {
  return getCambioSkyway(mid)?.servicios[serviceId]?.deploymentId === deploymentId;
}

/**
 * Sigue el despliegue que pone al día el usuario de correo de un servicio. Si
 * FALLA (no si alguien lo cancela ni si no termina a tiempo), lo reintenta una
 * vez con la misma imagen: con el usuario ya cambiado en Mailway, un fallo
 * pasajero (la red al arrancar, el registro de imágenes) dejaría el servicio
 * sin poder enviar. Si vuelve a fallar, `avisarCorreoSinEnviar`.
 * `reintentar: false` (al retomarlo tras un reinicio, cuando el reintento ya
 * se ha hecho): si falla, se avisa sin más.
 */
async function seguirDespliegueCorreo(
  mid: string,
  l: DespliegueCorreo,
  plazoMs: number,
  opts: { reintentar?: boolean; motivo?: keyof typeof MOTIVO_SIN_ENVIAR } = {},
): Promise<boolean> {
  if (await seguirDespliegue(mid, l.serviceId, l.deploymentId, plazoMs)) return true;
  if (getDeployment(l.deploymentId)?.status !== 'failed' || !sigueSiendoDelCambio(mid, l.serviceId, l.deploymentId)) return false;
  if (opts.reintentar === false) {
    avisarCorreoSinEnviar(mid, l, l.deploymentId, opts.motivo);
    return false;
  }
  const service = getService(l.serviceId);
  if (!service) return false;
  let reintento: string;
  try {
    const correo: CorreoDelDespliegue = { de: l.de, a: l.a, ...(l.imageTag ? { imageTag: l.imageTag } : {}), reintento: true };
    reintento = desplegar(mid, service, { imageTag: l.imageTag, correo });
  } catch {
    avisarCorreoSinEnviar(mid, l, null);
    return false;
  }
  if (await seguirDespliegue(mid, l.serviceId, reintento, plazoMs)) return true;
  if (getDeployment(reintento)?.status === 'failed' && sigueSiendoDelCambio(mid, l.serviceId, reintento)) avisarCorreoSinEnviar(mid, l, reintento);
  return false;
}

// ---------- dar de baja ----------

const resolutorDns = new dns.promises.Resolver({ timeout: 4000, tries: 2 });

/** IPv4 e IPv6 de un nombre; vacío si no resuelve. */
async function ipsDe(host: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([resolutorDns.resolve4(host).catch(() => []), resolutorDns.resolve6(host).catch(() => [])]);
  return [...v4, ...v6].map((ip) => ip.toLowerCase());
}

/**
 * ¿Apunta todavía el MX del dominio anterior al servidor de correo de Mailway,
 * por nombre o por IP? Es un adelanto de lo que Mailway mide al dar de baja
 * (`migration_old_mx_here`): true solo cuando es seguro. Con cualquier duda
 * (sin MX, el DNS no responde, no se conoce el servidor) devuelve null y
 * decide Mailway, como siempre.
 */
async function mxAnteriorAqui(dominio: string): Promise<boolean | null> {
  let servidor = '';
  try {
    servidor = normalizarNombre((await getInfo()).mailHostname ?? '');
  } catch {
    return null;
  }
  if (!servidor) return null;
  const mx = await consultarMx(dominio);
  if (!mx.ok || mx.hosts.length === 0) return null;
  if (mx.hosts.includes(servidor)) return true;
  const propias = new Set(await ipsDe(servidor));
  if (propias.size === 0) return null;
  for (const host of mx.hosts.slice(0, 10)) {
    if ((await ipsDe(host)).some((ip) => propias.has(ip))) return true;
  }
  return false;
}

/**
 * Da de baja el dominio anterior (con correo). Responde en cuanto el cambio
 * queda en «dando_de_baja»; lo demás sigue en segundo plano: poner al día las
 * aplicaciones que envían con buzones del cambio (y esperar a su despliegue)
 * y pedir la baja a Mailway.
 */
export async function darDeBajaCambio(req: FastifyRequest, project: ProjectRow, mid: string, confirm: string): Promise<MigracionSkyway> {
  const isAdmin = currentUser(req)?.role === 'admin';
  const puede = (r: DomainMigrationRow) => r.estado === 'pasada' || (r.estado === 'dando_de_baja' && !!r.error);
  const inicial = cambioDelProyecto(project, mid);
  if (confirm.trim().toLowerCase() !== inicial.from_domain) {
    throw new ErrorCambio(400, 'confirm_mismatch', `Escribe ${inicial.from_domain} exactamente para confirmar.`);
  }
  if (inicial.solo_web) {
    throw new ErrorCambio(409, 'migration_state', 'Este cambio de dominio no incluye el correo: termínalo con «Terminar».');
  }
  exigirEstado(puede(inicial));
  await withLockProyecto(project.id, async () => {
    const row = conciliarServicios(cambioDelProyecto(project, mid));
    exigirEstado(puede(row));
    exigirServiciosDesplegados(row, `dar de baja ${row.from_domain}`);
    const { link } = await correoDelCambio(project, row, isAdmin);
    exigirCorreoNoCompartido(row, link);
    // La baja cambia el usuario de las aplicaciones y las despliega ANTES de
    // pedírsela a Mailway, que solo entonces mide el MX: con el MX anterior
    // aún aquí (el fallo más probable), ese cambio irreversible ya estaría
    // hecho. Lo que se puede medir sin Mailway se mide antes.
    const correo = await vistaCorreo(row, true);
    const ctx = contextoUsos(row.project_id);
    const conApps = correo.buzones.lista.some((b) => conAplicaciones(ctx, row, b));
    if (correo.estado === 'pasado' && conApps && (await mxAnteriorAqui(row.from_domain)) === true) {
      throw new ErrorCambio(
        409,
        'migration_old_mx_here',
        `El MX de ${row.from_domain} todavía apunta al servidor de correo. Cámbialo o publica un MX nulo («0 .») antes de darlo de baja: si no, el correo que siga llegando a @${row.from_domain} se rechazaría y el servidor podría bloquear a quien lo envía. No se ha cambiado nada: las aplicaciones siguen como estaban.`,
      );
    }
    updateDomainMigration(mid, { estado: 'dando_de_baja', error: null, paso: '' }, { siEstado: [row.estado] });
  });
  enSegundoPlano(() => withLockProyecto(project.id, () => ejecutarBaja(req, project, mid)));
  return vistaMigracion(cambioDelProyecto(project, mid), isAdmin);
}

/**
 * Al cerrar un cambio, la prepublicación sobra: los servicios ya sirven sus
 * nombres. Se conserva la de un servicio sin desplegar (solo puede quedar uno
 * si Mailway ya había dado de baja el dominio anterior): la retira su
 * despliegue cuando termine bien.
 */
function retirarPrepublicacion(row: DomainMigrationRow): void {
  const sinDesplegar = new Set(serviciosSinDesplegar(row).map((s) => s.serviceId));
  for (const sid of new Set(listPrepublished(row.id).map((p) => p.service_id))) {
    if (!sinDesplegar.has(sid)) deletePrepublished(row.id, sid);
  }
}

/** Cierra el cambio cuando Mailway ya ha dado de baja el dominio anterior. */
function cerrarBaja(req: FastifyRequest, project: ProjectRow, inicial: DomainMigrationRow): void {
  const row = getCambioSkyway(inicial.id) ?? inicial;
  transaction(() => {
    retirarPrepublicacion(row);
    purgeSnapshots(row.id);
    updateDomainMigration(row.id, { estado: 'terminada', terminada_at: Date.now(), error: null, paso: '' });
  });
  audit(req, 'domain_migration_retired', { type: 'project', id: project.id, detail: `${row.from_domain} → ${row.to_domain}` });
}

async function ejecutarBaja(req: FastifyRequest, project: ProjectRow, mid: string): Promise<void> {
  const row = getCambioSkyway(mid);
  if (!row || row.estado !== 'dando_de_baja' || !row.mailway_migration_id) return;
  try {
    const correo = await vistaCorreo(row, true);
    const ctx = contextoUsos(row.project_id);
    const conApps = correo.buzones.lista.filter((b) => conAplicaciones(ctx, row, b));
    if (conApps.length > 0) {
      updateDomainMigration(mid, { paso: 'Actualizando las aplicaciones que envían correo' });
      const { lanzados, actualizados } = await ponerAlDiaApps(mid, row, conApps);
      // Los buzones ya entran con su dirección nueva: la vista no puede seguir diciendo lo contrario.
      cacheCorreo.delete(row.mailway_migration_id);
      for (const b of actualizados) {
        audit(req, 'mailway_mailbox_login_updated', { type: 'project', id: project.id, detail: `${b.login} → ${b.email} (baja)` });
      }
      await Promise.all(lanzados.map((l) => seguirDespliegueCorreo(mid, l, PLAZO_DESPLIEGUE_BAJA_MS)));
    }
    // Todos los servicios del cambio, no solo los de ahora: uno que falló antes
    // (al pasar, o en una baja anterior) tiene que estar desplegado.
    const pendiente = serviciosSinDesplegar(conciliarServicios(getCambioSkyway(mid) ?? row))[0];
    if (pendiente) {
      throw new ErrorCambio(
        409,
        'migration_services_pending',
        pendiente.estado === 'desplegando'
          ? `«${pendiente.nombre}» no ha terminado de desplegarse: no se ha dado de baja ${row.from_domain}. Espera a que termine y vuelve a dar de baja.`
          : pendiente.error?.startsWith(FALLO_DOBLE)
            ? `${pendiente.error} No se ha dado de baja ${row.from_domain}: vuelve a darlo de baja cuando el servicio esté desplegado.`
            : `El despliegue de «${pendiente.nombre}» no ha terminado bien: no se ha dado de baja ${row.from_domain}. Reintenta ese servicio y vuelve a dar de baja.`,
      );
    }
    updateDomainMigration(mid, { paso: `Dando de baja ${row.from_domain} en Mailway` });
    guardarCorreo(await retireDomainMigration(row.mailway_migration_id, row.from_domain));
    cerrarBaja(req, project, row);
  } catch (err) {
    // Dónde se queda el cambio lo dice Mailway. Si su baja falló a medias
    // (queda en «dando_de_baja» con su error), aquí también, con «Reintentar»:
    // volver a «pasada» lo dejaría sin salida, porque Mailway ya no admite
    // volver. Si Mailway sigue en «pasado», a «pasada» con el error. Si no
    // responde, «dando_de_baja» con el error: reintentar vale en los dos casos.
    const tras = await correoTrasFallo(row);
    if (tras?.estado === 'dado_de_baja') {
      cerrarBaja(req, project, row);
      return;
    }
    updateDomainMigration(
      mid,
      { estado: tras?.estado === 'pasado' ? 'pasada' : 'dando_de_baja', error: mensajeDe(err), paso: '' },
      { siEstado: ['dando_de_baja'] },
    );
  }
}

// ---------- terminar (solo web) y quitar las redirecciones ----------

export async function terminarCambio(req: FastifyRequest, project: ProjectRow, mid: string, confirm: string): Promise<MigracionSkyway> {
  const isAdmin = currentUser(req)?.role === 'admin';
  exigirEstado(cambioDelProyecto(project, mid).estado === 'pasada');
  return withLockProyecto(project.id, async () => {
    const row = conciliarServicios(cambioDelProyecto(project, mid));
    if (confirm.trim().toLowerCase() !== row.from_domain) {
      throw new ErrorCambio(400, 'confirm_mismatch', `Escribe ${row.from_domain} exactamente para confirmar.`);
    }
    if (!row.solo_web) {
      throw new ErrorCambio(409, 'migration_state', `Este cambio de dominio incluye el correo: termínalo con «Dar de baja ${row.from_domain}».`);
    }
    exigirEstado(row.estado === 'pasada');
    exigirServiciosDesplegados(row, 'terminar');
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

/**
 * Vuelve a desplegar un servicio cuyo despliegue del cambio falló. Si el que
 * falló reutilizaba la imagen en marcha (el de la baja, que solo cambia el
 * usuario SMTP), el reintento también: compilar la cabeza de la rama no es
 * lo que se pidió. También con el cambio cortado («dando_de_baja» con error):
 * un servicio sin desplegar es justo lo que impide reintentar la baja. Y en
 * uno cancelado, mientras no haya otro abierto: cancelar tras un «Volver»
 * despliega las aplicaciones que envían con buzones del cambio.
 */
export async function reintentarServicio(req: FastifyRequest, project: ProjectRow, mid: string, serviceId: string): Promise<MigracionSkyway> {
  const isAdmin = currentUser(req)?.role === 'admin';
  const puede = (r: DomainMigrationRow) =>
    r.estado === 'cancelada' ? (getOpenDomainMigration(project.id)?.id ?? r.id) === r.id : !ESTADOS_EN_CURSO.includes(r.estado) || !!r.error;
  exigirEstado(puede(cambioDelProyecto(project, mid)));
  return withLockProyecto(project.id, async () => {
    const row = conciliarServicios(cambioDelProyecto(project, mid));
    exigirEstado(puede(row));
    const servicio = row.servicios[serviceId];
    if (!servicio || estadoServicio(serviceId, servicio).estado !== 'error') {
      throw new ErrorCambio(409, 'migration_state', 'Este servicio no tiene un despliegue fallido que reintentar.');
    }
    const service = getService(serviceId);
    if (!service || service.project_id !== project.id) throw new ErrorCambio(404, 'not_found', 'Servicio no encontrado.');
    const fallido = servicio.deploymentId ? getDeployment(servicio.deploymentId) : undefined;
    const enMarcha = fallido?.image_tag ? await imagenEnMarcha(service) : undefined;
    const imageTag = enMarcha && fallido?.image_tag === enMarcha ? enMarcha : undefined;
    const depId = desplegar(mid, service, { imageTag });
    enSegundoPlano(async () => {
      await seguirDespliegue(mid, service.id, depId);
    });
    audit(req, 'domain_migration_service_retried', { type: 'service', id: service.id, detail: `${row.from_domain} → ${row.to_domain}` });
    return vistaMigracion(cambioDelProyecto(project, mid), isAdmin);
  });
}

/**
 * «Actualizar ahora» de una persona: su buzón entra desde ahora con la
 * dirección nueva. Si lo usan aplicaciones de este proyecto para enviar, se
 * ponen al día también sus variables y se despliegan con la imagen en marcha
 * (si no, dejarían de enviar); con el buzón ya al día, repetirlo arregla una
 * aplicación que se quedó con el usuario anterior.
 */
export async function actualizarPersona(req: FastifyRequest, project: ProjectRow, mid: string, mailboxId: string): Promise<MigracionSkyway> {
  const isAdmin = currentUser(req)?.role === 'admin';
  const puede = (r: DomainMigrationRow) => !ESTADOS_EN_CURSO.includes(r.estado) && r.estado !== 'terminada' && r.estado !== 'cancelada';
  exigirEstado(puede(cambioDelProyecto(project, mid)));
  return withLockProyecto(project.id, async () => {
    const row = cambioDelProyecto(project, mid);
    if (!row.mailway_migration_id) throw new ErrorCambio(409, 'migration_state', 'Este cambio de dominio no incluye el correo.');
    exigirEstado(puede(row));
    const { link } = await correoDelCambio(project, row, isAdmin);
    const correo = await vistaCorreo(row, true);
    const buzon = correo.buzones.lista.find((b) => b.id === mailboxId);
    // Cambiar su usuario dejaría sin enviar a las aplicaciones de otros proyectos que lo usan.
    if (buzon) exigirCorreoNoCompartido(row, link);
    if (!buzon) throw new ErrorCambio(404, 'not_found', 'Ese buzón no forma parte de este cambio de dominio.');
    if (conAplicaciones(contextoUsos(row.project_id), row, buzon)) {
      const { lanzados, actualizados } = await ponerAlDiaApps(mid, row, [buzon]);
      for (const l of lanzados) {
        enSegundoPlano(async () => {
          await seguirDespliegueCorreo(mid, l, PLAZO_DESPLIEGUE_BAJA_MS);
        });
      }
      if (actualizados.length > 0) {
        audit(req, 'mailway_mailbox_login_updated', { type: 'project', id: project.id, detail: `${buzon.login} → ${buzon.email}` });
      }
    } else if (buzon.pendiente) {
      await updateMailboxLogin(buzon.id);
      audit(req, 'mailway_mailbox_login_updated', { type: 'project', id: project.id, detail: `${buzon.login} → ${buzon.email}` });
    }
    cacheCorreo.delete(row.mailway_migration_id);
    return vistaMigracion(cambioDelProyecto(project, mid), isAdmin);
  });
}

// ---------- cambiar el MX del dominio nuevo (Cloudflare) ----------

/**
 * Cambia el MX del dominio nuevo a este servidor en su zona de Cloudflare
 * cuando hoy recibe en otro proveedor. Solo tras la pre-recepción (si no, el
 * correo que llegara se rechazaría). Lo hace Mailway: el cambio es de Skyway
 * y su panel no lo admite, y si la zona está en el Cloudflare de la
 * instancia, el cliente tampoco puede tocarla.
 */
export async function cambiarMx(req: FastifyRequest, project: ProjectRow, mid: string): Promise<MigracionSkyway> {
  const isAdmin = currentUser(req)?.role === 'admin';
  const puede = (r: DomainMigrationRow) => r.estado === 'preparando' || r.estado === 'lista';
  exigirEstado(puede(cambioDelProyecto(project, mid)));
  return withLockProyecto(project.id, async () => {
    const row = cambioDelProyecto(project, mid);
    exigirEstado(puede(row));
    if (!row.mailway_migration_id) throw new ErrorCambio(409, 'migration_state', 'Este cambio de dominio no incluye el correo.');
    await correoDelCambio(project, row, isAdmin);
    const antes = await vistaCorreo(row, true);
    if (!antes.hacia.cloudflare) {
      throw new ErrorCambio(400, 'cloudflare_unavailable', `El DNS de ${row.to_domain} no está en Cloudflare: cambia el MX en tu proveedor de DNS.`);
    }
    if (!antes.recepcionPreparada) {
      throw new ErrorCambio(
        409,
        'migration_state',
        `Espera a ver «${row.to_domain} ya recibe en los buzones»: hasta entonces, el correo que llegara a @${row.to_domain} se rechazaría.`,
      );
    }
    const res = await mailwayFetch<unknown>(
      `/api/domain-migrations/${encodeURIComponent(row.mailway_migration_id)}/mx${isAdmin ? '' : '?soloCliente=1'}`,
      { method: 'POST', body: {}, timeoutMs: 60_000 },
    );
    if (!esVistaCambio(res) || (row.mailway_client_id && res.clientId !== row.mailway_client_id)) {
      throw new MailwayError('http', 'La respuesta de Mailway no corresponde a este cambio de dominio.', 502);
    }
    guardarCorreo(res);
    reservarNombresDelCorreo(res, project.id);
    audit(req, 'domain_migration_mx_changed', { type: 'project', id: project.id, detail: `${row.from_domain} → ${row.to_domain}` });
    await comprobarSinCerrojo(project, row, isAdmin).catch(() => {
      /* el MX ya ha cambiado: la siguiente comprobación lo vuelve a medir */
    });
    return vistaMigracion(cambioDelProyecto(project, mid), isAdmin);
  });
}

// ---------- fichero de zona ----------

/**
 * Comenta los MX del fichero de zona del correo. Con el dominio nuevo
 * recibiendo hoy en otro proveedor, importar el fichero AÑADIRÍA este MX al
 * de ese proveedor (los importadores no sustituyen): antes de la
 * pre-recepción, el correo que llegara aquí se rechazaría (y alimentaría el
 * bloqueo automático de IPs del servidor); después, se repartiría entre los
 * dos y las direcciones que solo existen en el otro rebotarían. El MX se
 * cambia aparte, sustituyendo el actual, cuando el asistente lo indica.
 * Los MX del fichero de Mailway son de una línea.
 */
export function comentarMx(zona: string, dominio: string): { zona: string; comentados: number } {
  const salida: string[] = [];
  let comentados = 0;
  for (const linea of zona.split(/\r?\n/)) {
    // Lo que va antes de un «;» (un TXT con «;» entre comillas no llega al tipo antes de cortarse).
    const codigo = linea.split(';')[0];
    const tokens = codigo.trim().split(/\s+/);
    if (!codigo.trim() || tokens[0].startsWith('$')) {
      salida.push(linea);
      continue;
    }
    // Sin propietario (línea que empieza por espacio) el tipo puede ir primero.
    let i = /^\s/.test(codigo) ? 0 : 1;
    while (i < tokens.length && (/^\d+[smhdw]?$/i.test(tokens[i]) || /^(IN|CH|HS|CS)$/i.test(tokens[i]))) i++;
    if ((tokens[i] ?? '').toUpperCase() !== 'MX') {
      salida.push(linea);
      continue;
    }
    if (comentados === 0) {
      salida.push(
        `;  El MX va comentado a propósito: ${dominio} recibe hoy el correo en otro proveedor e importar`,
        ';  añade y no sustituye. Cuando el asistente diga que el dominio ya recibe en los buzones, sustituye',
        ';  en tu proveedor de DNS el MX actual por este (bórralo antes) y quita el «; » del principio.',
      );
    }
    salida.push(`; ${linea}`);
    comentados += 1;
  }
  return { zona: salida.join('\n'), comentados };
}

/**
 * Registros DNS del dominio nuevo en un fichero: los del correo que genera
 * Mailway (nivel «recomendados»: incluye el TXT que prueba la propiedad sin
 * tocar el MX) y, al final, los A de la web. Solo web: solo los A. Si el
 * dominio nuevo recibe hoy en otro proveedor, su MX va comentado (`comentarMx`).
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
      if (correo.hacia.recibeEnOtroProveedor) zona = comentarMx(zona, row.to_domain).zona;
    }
  }
  const { zone } = appendWebRecords(zona, row.to_domain, { serverIp: getSetting('serverIp') || null, hosts, webmail: null });
  return { nombre: `${row.to_domain.replace(/[^A-Za-z0-9.-]+/g, '_')}-cambio-de-dominio.txt`, texto: zone };
}

// ---------- proyecto y vínculo del correo ----------

/**
 * Motivo por el que no se puede eliminar el proyecto ni desactivar su correo
 * mientras tenga abierto un cambio de dominio con el correo, o null si se
 * puede. El cambio de Mailway (origen «skyway») solo se gestiona con el token
 * de Skyway y desde este proyecto: sin él (o sin su vínculo), quedaría
 * abierto sin que nadie pudiera cerrarlo desde el panel de Mailway, con los
 * dos dominios sin altas y sin poder eliminarse. Solo la web no toca Mailway.
 */
export function bloqueoPorCambioConCorreo(projectId: string, accion: string): string | null {
  const abierta = getOpenDomainMigration(projectId);
  if (!abierta || abierta.solo_web) return null;
  return (
    `Este proyecto tiene un cambio de dominio abierto con el correo en Mailway (${abierta.from_domain} → ${abierta.to_domain}). ` +
    `Cancélalo, o da de baja ${abierta.from_domain}, desde «Cambiar de dominio» antes de ${accion}: si no, el cambio del correo ` +
    'quedaría abierto en Mailway sin que nadie pudiera cerrarlo.'
  );
}

// ---------- arranque ----------

/**
 * Al arrancar: los cambios que el reinicio cortó a mitad de pasar, volver o
 * dar de baja quedan con un error para que la interfaz ofrezca «Reintentar»
 * (no se reanudan solos: Mailway pudo hacer su parte o no). Los despliegues
 * que se estaban siguiendo se vuelven a seguir: el que cortó el reinicio ya
 * es «fallido» (`markStaleDeploymentsFailed`) y, si el arranque lanzó otro
 * (`resumeInterruptedDeployments`, que corre antes), se sigue ese.
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
  // También los cancelados: cancelar tras un «Volver» despliega las aplicaciones que envían con buzones del cambio.
  for (const row of listDomainMigrationsByEstado(['preparando', 'lista', 'pasada', 'pasando', 'volviendo', 'dando_de_baja', 'terminada', 'cancelada'])) {
    for (const [sid, s] of Object.entries(row.servicios)) {
      if (s.estado !== 'desplegando' || !s.deploymentId) continue;
      // El que ponía al día el usuario de correo: el usuario ya cambió en
      // Mailway, así que si no termina bien el servicio no puede enviar.
      const correo = correoDe(s);
      const seguido = (deploymentId: string): DespliegueCorreo | null =>
        correo ? { serviceId: sid, deploymentId, de: correo.de, a: correo.a, ...(correo.imageTag ? { imageTag: correo.imageTag } : {}) } : null;
      const e = estadoServicio(sid, s);
      if (e.estado !== 'desplegando' || !e.deploymentId) {
        // Ya terminó (o se cortó sin reintento): se anota tal cual.
        setDomainMigrationServicio(row.id, sid, e);
        if (e.estado === 'ok') deletePrepublished(row.id, sid);
        else if (correo) avisarCorreoSinEnviar(row.id, seguido(s.deploymentId)!, e.deploymentId, 'reinicio');
        continue;
      }
      const depId = e.deploymentId;
      if (depId !== s.deploymentId) {
        // El reintento automático tras el reinicio (`resumeInterruptedDeployments`) hace de reintento.
        const entrada: ServicioConCorreo = {
          deploymentId: depId,
          estado: 'desplegando',
          error: null,
          ...(correo ? { correo: { ...correo, reintento: true } } : {}),
        };
        setDomainMigrationServicio(row.id, sid, entrada);
      }
      const l = seguido(depId);
      enSegundoPlano(async () => {
        if (l) {
          await seguirDespliegueCorreo(row.id, l, PLAZO_DESPLIEGUE_BAJA_MS, {
            reintentar: depId === s.deploymentId && !correo!.reintento,
            motivo: 'reinicio',
          });
        } else {
          await seguirDespliegue(row.id, sid, depId);
        }
      });
      seguidos += 1;
    }
  }
  return { interrumpidos, seguidos };
}
