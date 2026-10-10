/**
 * Correo de un proyecto visto desde un servicio: comprobar que el cliente de
 * Mailway vinculado sigue siendo el del proyecto, elegir con qué nombres
 * recibe el servicio las variables de correo y crear la credencial de envío.
 * Lo usan las rutas del correo (`routes/mailway.ts`), el plan de
 * integraciones (`integrations.ts`) y la renovación automática de las
 * contraseñas de aplicación invalidadas (`mailwayrenovacion.ts`), para que
 * «Conectar a un servicio», el plan de una web nueva y la renovación escriban
 * exactamente lo mismo.
 */
import { createHash } from 'crypto';
import { resolveServiceAlerts } from './alerts';
import { bumpConfigRev, deleteMailwayRenovacion, getMailwayLink, getProject, getService, patchEnv, writeManagedEnv } from './db';
import {
  MailwayError,
  MailwayInfo,
  MailwayMailbox,
  MailwaySummary,
  acceptedClientRefs,
  createApiKey,
  createAppPassword,
  getSummary,
  mailwayConfigured,
  publicPanelUrl,
  revokeApiKey,
  revokeAppPassword,
  updateMailboxLogin,
} from './mailway';
import {
  CONNECTION_ROLES,
  MailMode,
  MailRole,
  MailValues,
  ROLES_BY_MODE,
  SECRET_ROLES,
  mailTargets,
  mailValue,
  mailVarsOf,
} from './mailenv';
import { envStateOf, managedUnchanged, writeDecision } from './managedenv';
import { isWorkspaceActive, workspaceOfProject } from './quota';
import { GitConfig, MailwayLinkRow, ProjectRow, ServiceRow } from './types';

export const NO_CONFIGURADO =
  'La integración con Mailway no está configurada. Un administrador puede configurarla en Ajustes → Correo (Mailway).';
export const NO_VINCULADO = 'El correo no está activado en este proyecto.';
export const CUENTA_SUSPENDIDA =
  'La cuenta de este proyecto está suspendida: no es posible activar el correo, crear dominios ni buzones, ni conectar servicios.';
export const CLIENTE_SUSPENDIDO =
  'El cliente de correo de este proyecto está suspendido en Mailway: no es posible crear dominios ni buzones, ni conectar servicios.';

/**
 * Nombres de buzón reservados a la administración del dominio (RFC 2142 y las
 * direcciones que las autoridades de certificación aceptan para validar un
 * dominio). Quien los recibe puede obtener certificados o recibir los avisos
 * de abuso del dominio: solo los crea un administrador de la plataforma.
 */
export const BUZONES_RESERVADOS = new Set([
  'abuse',
  'admin',
  'administrator',
  'hostmaster',
  'postmaster',
  'root',
  'security',
  'ssladmin',
  'webmaster',
]);

/** Prefijo de las claves de API que crea Skyway (así se distinguen de las demás del cliente). */
export const PREFIJO_CLAVE = 'Skyway · ';

/** Prefijo de las contraseñas de aplicación que crea Skyway. */
const PREFIJO_CONTRASENA = 'skyway:';

/**
 * Lo que distingue a las credenciales de un servicio dentro de su cliente de
 * correo: el slug del servicio, estable aunque se renombren proyecto o
 * servicio (con él se encuentra la credencial anterior al volver a conectar).
 * En un proyecto de una cuenta, también el del proyecto: los proyectos de una
 * cuenta comparten cliente, dos pueden tener un servicio «web», y con solo el
 * slug del servicio, volver a conectar uno revocaría la credencial del otro.
 */
function credentialScope(service: ServiceRow): string {
  const project = getProject(service.project_id);
  return project?.workspace_id ? `${project.slug}/${service.slug}` : service.slug;
}

/**
 * Nombre de una credencial: Mailway admite 60 caracteres. Si no cabe, se
 * recorta con un sufijo sacado de los identificadores (que no cambian): sin
 * él, dos servicios podrían acabar con el mismo nombre recortado.
 */
function credentialName(prefix: string, service: ServiceRow, scope: string): string {
  const full = `${prefix}${scope}`;
  if (full.length <= 60) return full;
  const sufijo = `~${createHash('sha256').update(`${service.project_id}/${service.id}`).digest('hex').slice(0, 8)}`;
  return `${full.slice(0, 60 - sufijo.length)}${sufijo}`;
}

/** Nombre de la clave de API de un servicio («Skyway · web» o, en una cuenta, «Skyway · tienda/web»). */
export function apiKeyName(service: ServiceRow): string {
  return credentialName(PREFIJO_CLAVE, service, credentialScope(service));
}

/** Nombre de la contraseña de aplicación de un servicio (mismo criterio que la clave). */
export function appPasswordName(service: ServiceRow): string {
  return credentialName(PREFIJO_CONTRASENA, service, credentialScope(service));
}

/**
 * Nombres con los que se reconoce la credencial del servicio en ese modo: el
 * actual y, si el vínculo es de antes de compartir los clientes por cuenta
 * (`legacy_credentials`), también el de entonces (solo el slug del servicio):
 * en aquel cliente, que era solo de este proyecto, únicamente pudo crearla él.
 * En un vínculo nuevo, ese nombre podría ser de otro proyecto de la cuenta.
 */
export function credentialNames(service: ServiceRow, mode: MailMode, link: MailwayLinkRow | null): string[] {
  const actual = mode === 'smtp' ? appPasswordName(service) : apiKeyName(service);
  const antiguo = credentialName(mode === 'smtp' ? PREFIJO_CONTRASENA : PREFIJO_CLAVE, service, service.slug);
  return link?.legacy_credentials && antiguo !== actual ? [actual, antiguo] : [actual];
}

/** Error con código HTTP que el manejador global devuelve tal cual. */
export function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

export function requireLink(project: ProjectRow): MailwayLinkRow {
  if (!mailwayConfigured()) throw httpError(409, NO_CONFIGURADO);
  const link = getMailwayLink(project.id);
  if (!link) throw httpError(409, NO_VINCULADO);
  return link;
}

/**
 * Crear (cliente, dominios, buzones, credenciales) exige que la cuenta del
 * proyecto esté activa, como crear servicios. Lo ya creado sigue funcionando.
 */
export function assertAccountActive(project: ProjectRow): void {
  const workspace = workspaceOfProject(project.id);
  if (workspace && !isWorkspaceActive(workspace)) throw httpError(403, CUENTA_SUSPENDIDA);
}

export function assertClientActive(summary: MailwaySummary): void {
  if (summary.client.suspended) throw httpError(409, CLIENTE_SUSPENDIDO);
}

/** Error de referencia externa: la vista lo convierte en un aviso en lugar de fallar. */
function refError(message: string): Error {
  return Object.assign(httpError(409, message), { mailwayRef: true });
}

export function isRefError(err: unknown): err is Error {
  return !!err && typeof err === 'object' && (err as { mailwayRef?: unknown }).mailwayRef === true;
}

/**
 * Resumen del cliente vinculado, comprobando que sigue siendo el de ESTE
 * proyecto. Skyway habla con Mailway con un token de administrador: si la
 * referencia externa del cliente no es exactamente una de las del proyecto
 * (`acceptedClientRefs`: la de su cuenta, que comparten los proyectos de la
 * cuenta, o la suya propia), no se opera sobre él: se ha desvinculado o
 * vinculado a otra cosa desde Mailway, o el proyecto ha cambiado de cuenta.
 * Una referencia vacía tampoco vale: puede ser un cliente que el operador ha
 * retirado a propósito de este proyecto.
 */
export async function ownedSummary(project: ProjectRow, link: MailwayLinkRow): Promise<MailwaySummary> {
  return checkOwnedSummary(project, link, await getSummary(link.client_id));
}

/**
 * Las comprobaciones de `ownedSummary` sobre un resumen ya leído: la
 * renovación automática lee uno por cliente y lo comprueba para cada proyecto
 * que lo comparte, en vez de pedirlo otra vez por proyecto.
 */
export function checkOwnedSummary(project: ProjectRow, link: MailwayLinkRow, summary: MailwaySummary): MailwaySummary {
  if (summary.client.id !== link.client_id) {
    throw new MailwayError('http', 'La respuesta de Mailway no corresponde al cliente vinculado.', 502);
  }
  const ref = summary.client.externalRef ?? null;
  if (ref === null) {
    throw refError(
      `El cliente de Mailway «${summary.client.name}» ya no está vinculado a este proyecto: se ha retirado su referencia desde Mailway. ` +
        'Desactiva el correo en este proyecto; después podrás activarlo de nuevo recuperando ese mismo cliente.',
    );
  }
  if (!acceptedClientRefs(project).includes(ref)) {
    throw refError(
      `El cliente de Mailway «${summary.client.name}» está vinculado a otra integración. ` +
        'Desactiva el correo en este proyecto; el cliente y sus buzones se conservan en Mailway.',
    );
  }
  return summary;
}

/**
 * Revoca sin fallar si la credencial ya no existe o ya estaba revocada (404 o
 * 409 de Mailway): el objetivo, que deje de funcionar, ya se cumple.
 */
export async function revokeIgnoringGone(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof MailwayError && (err.status === 404 || err.status === 409)) return;
    throw err;
  }
}

// ---------- un cambio de credencial a la vez por servicio ----------

/**
 * Cola por servicio de los cambios de su credencial de correo. «Conectar a un
 * servicio», el plan de integraciones y la renovación automática leen las
 * credenciales del cliente, crean una, escriben las variables y revocan la
 * anterior: dos a la vez sobre el mismo servicio podían revocar la que la otra
 * acababa de escribir y dejarle una que ya no funciona. Se espera turno en vez
 * de rechazar: cada cambio dura lo que tardan dos o tres peticiones a Mailway.
 */
const credentialQueues = new Map<string, Promise<void>>();

/**
 * Turnos terminados por servicio. Quien leyó el resumen del cliente antes de
 * pedir turno lo compara al entrar: si ha cambiado, otro ha tocado entretanto
 * las credenciales del servicio y ese resumen ya no vale.
 */
const credentialGenerations = new Map<string, number>();

export function mailCredentialGeneration(serviceId: string): number {
  return credentialGenerations.get(serviceId) ?? 0;
}

export async function withMailCredentialLock<T>(serviceId: string, fn: () => Promise<T>): Promise<T> {
  const previous = credentialQueues.get(serviceId) ?? Promise.resolve();
  let release!: () => void;
  const own = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = previous.then(() => own);
  credentialQueues.set(serviceId, queue);
  await previous;
  try {
    return await fn();
  } finally {
    credentialGenerations.set(serviceId, mailCredentialGeneration(serviceId) + 1);
    release();
    if (credentialQueues.get(serviceId) === queue) credentialQueues.delete(serviceId);
  }
}

/**
 * Tipo de la alerta que deja una renovación automática de la contraseña de
 * aplicación que no se ha podido hacer (`mailwayrenovacion.ts`). Volver a
 * conectar el correo del servicio la resuelve.
 */
export const RENEWAL_FAILED_ALERT = 'mail_password_renewal_failed';

// ---------- nombres de las variables de correo de un servicio ----------

/** Origen con el que se recuerda una variable de correo escrita por Skyway. */
export function mailOrigin(mode: MailMode, role: MailRole): string {
  return `mail.${mode}.${role}`;
}

export interface MailTarget {
  name: string;
  role: MailRole;
}

/**
 * Variables de correo que la web de un servicio espera, por orden de
 * autoridad: las que declara su `skyway.json` (`from: mail.<papel>`), que se
 * escriben tal cual y solas; si no, las que su `.env.example` nombra con un
 * nombre conocido (`SMTP_PASSWORD`, `EMAIL_HOST_USER`…).
 */
export function expectedMailVars(service: ServiceRow): { explicit: boolean; vars: MailTarget[] } {
  if (service.type !== 'git') return { explicit: false, vars: [] };
  const needs = (service.config as GitConfig).needs;
  const declared: MailTarget[] = [];
  for (const [name, entry] of Object.entries(needs?.manifest?.env ?? {})) {
    if ('from' in entry && entry.from.startsWith('mail.')) declared.push({ name, role: entry.from.slice(5) as MailRole });
  }
  if (declared.length > 0) return { explicit: true, vars: declared };
  return { explicit: false, vars: mailVarsOf(needs?.expectedVars ?? []) };
}

export interface MailConnectNames {
  /** Variables que se escribirían, con su papel. */
  targets: MailTarget[];
  /** Variables con un valor puesto a mano que no se tocan. */
  kept: string[];
  /** ¿Hay al menos una variable libre para la credencial? Si no, conectar no sirve. */
  secretPlaced: boolean;
  /**
   * ¿Pide la web la credencial? Un manifiesto puede pedir solo el remitente
   * (`mail.from`) para enviar con otro proveedor: entonces no se crea ninguna.
   */
  secretRequested: boolean;
  /**
   * Variables de conexión (servidor, puerto, usuario, URL de la API) puestas a
   * mano con un valor distinto del de Mailway. Con alguna, escribir la
   * credencial dejaría la web conectada a medias, así que no se conecta. Solo
   * las que se pueden comparar: sin conocer el valor de Mailway (la vista
   * previa no sabe el buzón) no se da por conflicto.
   */
  conflicts: string[];
}

/** Mensaje del 409 cuando la conexión quedaría a medias (ver `MailConnectNames.conflicts`). */
export function partialConnectionMessage(conflicts: string[]): string {
  const una = conflicts.length === 1;
  return (
    `${conflicts.join(', ')} ${una ? 'tiene' : 'tienen'} un valor puesto a mano distinto del de Mailway: escribir solo la credencial ` +
    'dejaría la web conectada a medias, con la credencial de Mailway y el servidor, el puerto o el usuario de otro proveedor. ' +
    `${una ? 'Elimínala o vacíala' : 'Elimínalas o vacíalas'} en la pestaña «Variables» del servicio si quieres que ${una ? 'la gestione' : 'las gestione'} Skyway.`
  );
}

/**
 * Con qué nombres recibe el servicio el correo en ese modo: los que su web
 * espera (manifiesto o `.env.example`), los de siempre para lo que no nombra,
 * y los que Skyway ya escribió en una conexión anterior (para que no se queden
 * con una credencial revocada). Ninguno que alguien haya puesto a mano con
 * otro valor: esos van en `kept` y, si dicen a dónde se conecta la web, también
 * en `conflicts` (entonces no se conecta). Lo que Skyway importó del
 * `.env.example` y nadie ha tocado cuenta como suyo: es un valor de ejemplo, no
 * una decisión de nadie (ver `finalizeEnvImport`). `hadCredential` dice si el servicio ya tenía
 * una credencial de Skyway de este tipo: entonces los nombres de siempre se
 * consideran de Skyway aunque sean anteriores a llevar la cuenta de lo escrito.
 */
export function mailConnectNames(
  service: ServiceRow,
  mode: MailMode,
  known: { host?: string | null; port?: number | null; from?: string | null; user?: string | null; apiUrl?: string | null },
  hadCredential: boolean,
): MailConnectNames {
  const state = envStateOf(service);
  const roles = new Set(ROLES_BY_MODE[mode]);
  const expected = expectedMailVars(service);
  const base = expected.explicit ? expected.vars.filter((v) => roles.has(v.role)) : mailTargets(mode, expected.vars);
  const candidates = [...base];
  // Lo escrito en una conexión anterior EN ESTE MODO (`mail.<modo>.<papel>`):
  // el remitente de una conexión SMTP no se toca al pasar a la API.
  for (const [name, m] of Object.entries(state.managed)) {
    const [kind, managedMode, role] = m.origin.split('.') as [string, string, MailRole];
    if (kind === 'mail' && managedMode === mode && roles.has(role) && !candidates.some((c) => c.name === name) && state.env[name] !== undefined) {
      candidates.push({ name, role });
    }
  }
  // Solo para conexiones de antes de llevar la cuenta: en cuanto Skyway ha
  // apuntado lo que escribió en este modo, lo que no esté apuntado (o se haya
  // cambiado) es de quien lo puso.
  const tracked = Object.values(state.managed).some((m) => m.origin.startsWith(`mail.${mode}.`));
  const legacy = new Set<string>();
  if (hadCredential && !tracked) {
    for (const def of mailTargets(mode, [])) {
      legacy.add(def.name);
      if (!candidates.some((c) => c.name === def.name) && state.env[def.name] !== undefined) candidates.push(def);
    }
  }
  // El usuario SMTP es el del motor (`login`), que tras un cambio de dominio
  // sigue siendo la dirección anterior; sin él, la dirección (Mailway < 1.3).
  const user = known.user !== undefined ? known.user : (known.from ?? null);
  const values = { host: known.host ?? null, port: known.port ?? null, user, password: null, from: known.from ?? null, apiUrl: known.apiUrl ?? null, apiKey: null };
  const connectionRoles = new Set(CONNECTION_ROLES[mode]);
  const targets: MailTarget[] = [];
  const kept: string[] = [];
  const conflicts: string[] = [];
  for (const c of candidates) {
    const value = mailValue(c.role, values);
    if (writeDecision(state, c.name, value, legacy) === 'write') {
      targets.push(c);
    } else {
      kept.push(c.name);
      if (connectionRoles.has(c.role) && value !== null) conflicts.push(c.name);
    }
  }
  const secretRoles = new Set(SECRET_ROLES[mode]);
  const secretRequested = candidates.some((c) => secretRoles.has(c.role));
  return {
    targets,
    kept,
    secretPlaced: targets.some((t) => secretRoles.has(t.role)),
    secretRequested,
    // Sin credencial que escribir (solo el remitente) no hay nada que pueda salir mal.
    conflicts: secretRequested ? conflicts : [],
  };
}

/** Servidor de envío autenticado (587, STARTTLS): las aplicaciones no están en la red interna del correo. */
export function submissionOf(info: MailwayInfo): { host: string | null; port: number } {
  return { host: info.submission?.host || info.mailHostname || null, port: info.submission?.port || 587 };
}

/** Variables que se escriben: el valor de cada papel y el origen con el que Skyway recuerda que es suyo. */
export function mailEntries(
  mode: MailMode,
  targets: readonly MailTarget[],
  values: MailValues,
): Record<string, { value: string; origin: string }> {
  const entries: Record<string, { value: string; origin: string }> = {};
  for (const t of targets) {
    const value = mailValue(t.role, values);
    if (value !== null) entries[t.name] = { value, origin: mailOrigin(mode, t.role) };
  }
  return entries;
}

/**
 * Lo que se conoce sin crear nada: sirve para la vista previa de los nombres.
 * `mailboxLogin` es el usuario del motor del buzón (Mailway 1.3+); sin él, el
 * usuario es la dirección.
 */
export function knownMailValues(info: MailwayInfo | null, mode: MailMode, mailboxEmail: string | null, mailboxLogin?: string | null) {
  const sub = info ? submissionOf(info) : { host: null, port: 587 };
  return {
    host: sub.host,
    port: sub.port,
    from: mailboxEmail,
    user: mailboxLogin || mailboxEmail,
    apiUrl: mode === 'api' ? publicPanelUrl() : null,
  };
}

/**
 * ¿Hay que actualizar el usuario del buzón antes de crearle una credencial
 * SMTP? Un buzón que acaba de pasar a otro dominio sigue entrando con su
 * dirección anterior (`loginPending`). Si Skyway le creara la credencial así,
 * el servicio nacería con el usuario viejo y la baja del dominio anterior
 * tendría que cambiárselo después, con otro despliegue. Se actualiza antes,
 * salvo que lo usen OTRAS aplicaciones de Skyway: esas siguen con el usuario
 * viejo hasta la baja, que las actualiza todas a la vez con sus variables, y
 * cambiarlo ahora las dejaría sin poder enviar.
 */
export function actualizaUsuarioAlConectar(
  mailbox: Pick<MailwayMailbox, 'id' | 'loginPending'> | null,
  summary: Pick<MailwaySummary, 'appPasswords'> | null,
  credNames: readonly string[],
): boolean {
  if (!mailbox?.loginPending) return false;
  // En una cuenta, el cliente de correo es de todos sus proyectos: también
  // cuentan las aplicaciones de los demás (`skyway:<proyecto>/<servicio>`).
  return !(summary?.appPasswords ?? []).some(
    (a) => !a.revokedAt && a.mailboxId === mailbox.id && a.name.startsWith(PREFIJO_CONTRASENA) && !credNames.includes(a.name),
  );
}

/**
 * Nombres y usuario con los que quedaría conectado el servicio a ese buzón:
 * lo que `connectServiceMail` escribirá y lo que el plan de integraciones
 * enseña antes. El usuario es el del motor, o la dirección si conectar va a
 * actualizarlo (solo cuando se crea una credencial SMTP).
 */
export function conexionPrevista(opts: {
  service: ServiceRow;
  mode: MailMode;
  known: { host: string | null; port: number | null; apiUrl: string | null };
  mailbox: Pick<MailwayMailbox, 'id' | 'email' | 'login' | 'loginPending'> | null;
  /** Dirección del buzón que se creará, si todavía no existe. */
  email?: string | null;
  summary: Pick<MailwaySummary, 'appPasswords'> | null;
  hadCredential: boolean;
  /** Vínculo del proyecto: decide con qué nombres se reconoce la credencial del servicio (`credentialNames`). */
  link?: MailwayLinkRow | null;
}): { names: MailConnectNames; user: string | null; actualizarUsuario: boolean } {
  const { service, mode, known, mailbox, summary, hadCredential } = opts;
  const email = mailbox?.email ?? opts.email ?? null;
  const login = mailbox?.login || email;
  const actualiza = mode === 'smtp' && actualizaUsuarioAlConectar(mailbox, summary, credentialNames(service, mode, opts.link ?? null));
  const nombres = (user: string | null) => mailConnectNames(service, mode, { ...known, from: email, user }, hadCredential);
  if (actualiza) {
    const names = nombres(email);
    // Sin credencial que crear (solo el remitente), no se actualiza nada.
    if (names.secretRequested) return { names, user: email, actualizarUsuario: true };
  }
  return { names: nombres(login), user: login, actualizarUsuario: false };
}

export interface MailConnectResult {
  keys: string[];
  kept: string[];
  revoked: number;
}

/**
 * Crea en Mailway la credencial de envío del servicio para ese buzón y la
 * escribe en sus variables con los nombres de `mailConnectNames`. La
 * credencial del mismo tipo que Skyway creó antes para este servicio se
 * revoca: su variable se va a sobrescribir, y sin revocarla seguiría siendo
 * válida sin que nadie la use (y Mailway limita las contraseñas de aplicación
 * activas por buzón). Si la credencial no cabe en ninguna variable (todas
 * puestas a mano), o si cabe pero el servidor, el puerto o el usuario están
 * puestos a mano con otro valor, no se crea nada (409). Quien llama tiene el
 * turno del servicio (`withMailCredentialLock`) y leyó `summary` dentro de él.
 */
export async function connectServiceMail(opts: {
  project: ProjectRow;
  link: MailwayLinkRow;
  summary: MailwaySummary;
  service: ServiceRow;
  mailbox: MailwayMailbox;
  mode: MailMode;
  info: MailwayInfo;
}): Promise<MailConnectResult> {
  const { link, summary, service, mailbox, mode, info } = opts;
  const { host, port } = submissionOf(info);
  const apiUrl = mode === 'api' ? publicPanelUrl() : null;
  if (mode === 'smtp' && !host) throw new MailwayError('http', 'Mailway no ha indicado el servidor de envío (submission).', 502);
  if (mode === 'api' && !apiUrl) {
    throw new MailwayError('config', 'No se conoce la URL pública de Mailway: configúrala en Ajustes → Correo (Mailway).');
  }

  const credNames = credentialNames(service, mode, link);
  const credName = credNames[0];
  const previousApps = mode === 'smtp' ? summary.appPasswords.filter((a) => !a.revokedAt && credNames.includes(a.name)) : [];
  const previousKeys = mode === 'api' ? summary.apiKeys.filter((k) => !k.revokedAt && credNames.includes(k.name)) : [];
  const prevista = conexionPrevista({
    service,
    mode,
    known: { host, port, apiUrl },
    mailbox,
    summary,
    hadCredential: previousApps.length + previousKeys.length > 0,
    link,
  });
  const names = prevista.names;
  if (names.secretRequested && !names.secretPlaced) {
    const secretas = names.kept.length > 0 ? names.kept.join(', ') : 'las variables de la credencial';
    throw httpError(
      409,
      `No se ha conectado el correo: ${secretas} ${names.kept.length === 1 ? 'tiene' : 'tienen'} un valor puesto a mano y Skyway no lo sobrescribe. ` +
        'Elimínala o vacíala en la pestaña «Variables» del servicio si quieres que la gestione Skyway.',
    );
  }
  // La regla de no pisar va variable a variable: sin esto, la credencial de
  // Mailway se escribiría junto al servidor de otro proveedor puesto a mano, y
  // la web se la enviaría a ese tercero. Antes de crear nada en Mailway.
  if (names.conflicts.length > 0) {
    throw httpError(409, `No se ha conectado el correo: ${partialConnectionMessage(names.conflicts)}`);
  }

  // Antes de revocar ni crear nada: si Mailway no deja actualizar el usuario
  // (un cambio de usuario a medias), el servicio se queda como estaba.
  let user = prevista.user;
  if (prevista.actualizarUsuario) {
    const { mailbox: actualizado } = await updateMailboxLogin(mailbox.id);
    user = actualizado.login || actualizado.email || mailbox.email;
  }

  let revoked = 0;
  let password: string | null = null;
  let apiKey: string | null = null;
  if (!names.secretRequested) {
    // Solo el remitente (y quizá el servidor): no hace falta credencial.
  } else if (mode === 'smtp') {
    for (const old of previousApps) {
      await revokeIgnoringGone(() => revokeAppPassword(old.mailboxId, old.id));
      revoked++;
    }
    const created = await createAppPassword(mailbox.id, credName);
    if (!created?.password) throw new MailwayError('http', 'Mailway no ha devuelto la contraseña de aplicación.', 502);
    password = created.password;
  } else {
    for (const old of previousKeys) {
      await revokeIgnoringGone(() => revokeApiKey(old.id));
      revoked++;
    }
    const res = await createApiKey({ clientId: link.client_id, name: credName, senderMailboxId: mailbox.id });
    if (!res?.key) throw new MailwayError('http', 'Mailway no ha devuelto la clave de API.', 502);
    apiKey = res.key;
  }

  // El usuario es el del motor y el remitente, la dirección: tras pasar a un
  // dominio nuevo, Mailway acepta enviar como la dirección nueva con el usuario
  // viejo (es una dirección del mismo buzón).
  const entries = mailEntries(mode, names.targets, { host, port, user, password, from: mailbox.email, apiUrl, apiKey });
  writeManagedEnv(service.id, entries);
  // Las credenciales nuevas solo llegan al contenedor al redesplegar.
  if (Object.keys(entries).length > 0) bumpConfigRev([service.id]);
  if (password) {
    // Contraseña de aplicación nueva, elegida por quien conecta: lo que anotó
    // una renovación automática anterior (y su alerta, si no pudo hacerse) ya
    // no describe la credencial del servicio.
    deleteMailwayRenovacion(service.id);
    resolveServiceAlerts(service.id, RENEWAL_FAILED_ALERT);
  }
  return { keys: Object.keys(entries), kept: names.kept, revoked };
}

/** Normaliza las claves de un mapa de direcciones (minúsculas y sin espacios). */
function mapaDirecciones(mapa: ReadonlyMap<string, string> | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const [de, a] of mapa ?? []) {
    const k = de.trim().toLowerCase();
    if (k && a.trim()) out.set(k, a.trim());
  }
  return out;
}

/**
 * La URL `smtp://usuario:clave@host:puerto` con otro usuario, o null si no se
 * reconoce o su usuario no está en el mapa. La contraseña se copia tal cual
 * (ya va codificada): sin leerla, no hay forma de equivocarse con ella.
 */
function urlConOtroUsuario(url: string, usuarios: Map<string, string>): string | null {
  const m = url.match(/^(smtps?:\/\/)([^:@/?#]*)(:[^@/?#]*)?@(.+)$/i);
  if (!m) return null;
  let actual: string;
  try {
    actual = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  const nuevo = usuarios.get(actual.trim().toLowerCase());
  return nuevo ? `${m[1]}${encodeURIComponent(nuevo)}${m[3] ?? ''}@${m[4]}` : null;
}

/**
 * Refresca las variables de correo que Skyway escribió en el servicio tras un
 * cambio de dominio: el remitente (`mail.smtp.from` y `mail.api.from`) según
 * `remitentes` y el usuario SMTP (`mail.smtp.user` y el de la URL
 * `mail.smtp.url`) según `usuarios`, en mapas de dirección vieja → nueva.
 * Solo toca las que Skyway escribió y nadie ha cambiado (`managedUnchanged`):
 * lo puesto a mano no se pisa nunca. Conserva el origen, no crea ni revoca
 * credenciales (la contraseña de aplicación sigue valiendo: va con el buzón,
 * no con su dirección) y no sube la revisión: quien llama decide cuándo
 * desplegar (`bumpConfigRev`). Devuelve los nombres que ha cambiado.
 *
 * `credencialSmtp`: el servicio tiene una contraseña de aplicación de Skyway
 * (`skyway:<slug>`). Una conexión anterior a llevar la cuenta de lo escrito
 * (Skyway 0.34) no tiene ninguna fila `mail.smtp.*`: entonces `SMTP_USER` y
 * `SMTP_FROM`, los nombres de siempre, cuentan como de Skyway si su valor es
 * exactamente una dirección del mapa, el mismo criterio que
 * `mailConnectNames`. Sin esto, tras la baja esa aplicación seguiría entrando
 * con un usuario que ya no existe. Se escriben sin registrarlas, como
 * estaban: si no, la próxima conexión tomaría por puestos a mano el resto de
 * los nombres de siempre (`SMTP_PASS`, `SMTP_HOST`) y no podría escribirlos.
 */
export function refrescarVariablesCorreo(
  serviceId: string,
  cambios: { remitentes?: ReadonlyMap<string, string>; usuarios?: ReadonlyMap<string, string> },
  opts: { credencialSmtp?: boolean } = {},
): string[] {
  const service = getService(serviceId);
  if (!service) return [];
  const remitentes = mapaDirecciones(cambios.remitentes);
  const usuarios = mapaDirecciones(cambios.usuarios);
  if (remitentes.size === 0 && usuarios.size === 0) return [];
  const state = envStateOf(service);
  const entries: Record<string, { value: string; origin: string }> = {};
  for (const [key, managed] of Object.entries(state.managed)) {
    if (!managedUnchanged(state, key)) continue;
    const actual = state.env[key];
    let nuevo: string | null = null;
    switch (managed.origin) {
      case 'mail.smtp.from':
      case 'mail.api.from':
        nuevo = remitentes.get(actual.trim().toLowerCase()) ?? null;
        break;
      case 'mail.smtp.user':
        nuevo = usuarios.get(actual.trim().toLowerCase()) ?? null;
        break;
      case 'mail.smtp.url':
        nuevo = urlConOtroUsuario(actual, usuarios);
        break;
    }
    if (nuevo !== null && nuevo !== actual) entries[key] = { value: nuevo, origin: managed.origin };
  }
  writeManagedEnv(serviceId, entries);

  const legado: Record<string, string> = {};
  const registrada = Object.values(state.managed).some((m) => m.origin.startsWith('mail.smtp.'));
  if (opts.credencialSmtp && !registrada) {
    for (const def of mailTargets('smtp', [])) {
      const actual = state.env[def.name];
      if (actual === undefined || state.managed[def.name]) continue;
      const mapa = def.role === 'user' ? usuarios : def.role === 'from' ? remitentes : null;
      const nuevo = mapa?.get(actual.trim().toLowerCase());
      if (nuevo && nuevo !== actual) legado[def.name] = nuevo;
    }
    patchEnv(serviceId, legado, []);
  }
  return [...Object.keys(entries), ...Object.keys(legado)].sort();
}

/** El servicio, si es del proyecto y se le puede conectar el correo; si no, el error de la ruta. */
export function serviceOfProject(projectId: string, serviceId: string): ServiceRow {
  const service = getService(serviceId);
  if (!service || service.project_id !== projectId || !getProject(projectId)) throw httpError(404, 'Servicio no encontrado en este proyecto');
  if (service.type === 'database') throw httpError(400, 'No es posible conectar el correo a un servicio de base de datos.');
  return service;
}
