/**
 * Correo de un proyecto visto desde un servicio: comprobar que el cliente de
 * Mailway vinculado sigue siendo el del proyecto, elegir con qué nombres
 * recibe el servicio las variables de correo y crear la credencial de envío.
 * Lo usan las rutas del correo (`routes/mailway.ts`) y el plan de
 * integraciones (`integrations.ts`), para que «Conectar a un servicio» y el
 * plan de una web nueva escriban exactamente lo mismo.
 */
import { bumpConfigRev, getMailwayLink, getProject, getService, writeManagedEnv } from './db';
import {
  MailwayError,
  MailwayInfo,
  MailwayMailbox,
  MailwaySummary,
  createApiKey,
  createAppPassword,
  getSummary,
  mailwayConfigured,
  projectExternalRef,
  publicPanelUrl,
  revokeApiKey,
  revokeAppPassword,
} from './mailway';
import { CONNECTION_ROLES, MailMode, MailRole, ROLES_BY_MODE, SECRET_ROLES, mailTargets, mailValue, mailVarsOf } from './mailenv';
import { envStateOf, writeDecision } from './managedenv';
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

/**
 * Nombre de la clave de API de un servicio. Mailway admite 60 caracteres, y el
 * slug del servicio (≤ 35) es estable aunque se renombren proyecto o servicio:
 * con él se encuentra la clave anterior al volver a conectar. El proyecto no
 * hace falta, porque el cliente de correo ya es el del proyecto.
 */
export function apiKeyName(service: ServiceRow): string {
  return `${PREFIJO_CLAVE}${service.slug}`.slice(0, 60);
}

/** Nombre de la contraseña de aplicación de un servicio (mismo criterio que la clave). */
export function appPasswordName(service: ServiceRow): string {
  return `skyway:${service.slug}`.slice(0, 60);
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
 * referencia externa del cliente no es exactamente la del proyecto (se ha
 * desvinculado o vinculado a otra cosa desde Mailway), no se opera sobre él.
 * Una referencia vacía tampoco vale: puede ser un cliente que el operador ha
 * retirado a propósito de este proyecto.
 */
export async function ownedSummary(project: ProjectRow, link: MailwayLinkRow): Promise<MailwaySummary> {
  const summary = await getSummary(link.client_id);
  const expected = projectExternalRef(project.id);
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
  if (ref !== expected) {
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
  known: { host?: string | null; port?: number | null; from?: string | null; apiUrl?: string | null },
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
  const values = { host: known.host ?? null, port: known.port ?? null, user: known.from ?? null, password: null, from: known.from ?? null, apiUrl: known.apiUrl ?? null, apiKey: null };
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
function submissionOf(info: MailwayInfo): { host: string | null; port: number } {
  return { host: info.submission?.host || info.mailHostname || null, port: info.submission?.port || 587 };
}

/** Lo que se conoce sin crear nada: sirve para la vista previa de los nombres. */
export function knownMailValues(info: MailwayInfo | null, mode: MailMode, mailboxEmail: string | null) {
  const sub = info ? submissionOf(info) : { host: null, port: 587 };
  return { host: sub.host, port: sub.port, from: mailboxEmail, apiUrl: mode === 'api' ? publicPanelUrl() : null };
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
 * puestos a mano con otro valor, no se crea nada (409).
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

  const credName = mode === 'smtp' ? appPasswordName(service) : apiKeyName(service);
  const previousApps = mode === 'smtp' ? summary.appPasswords.filter((a) => !a.revokedAt && a.name === credName) : [];
  const previousKeys = mode === 'api' ? summary.apiKeys.filter((k) => !k.revokedAt && k.name === credName) : [];
  const names = mailConnectNames(
    service,
    mode,
    { host, port, from: mailbox.email, apiUrl },
    previousApps.length + previousKeys.length > 0,
  );
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

  const values = { host, port, user: mailbox.email, password, from: mailbox.email, apiUrl, apiKey };
  const entries: Record<string, { value: string; origin: string }> = {};
  for (const t of names.targets) {
    const value = mailValue(t.role, values);
    if (value !== null) entries[t.name] = { value, origin: mailOrigin(mode, t.role) };
  }
  writeManagedEnv(service.id, entries);
  // Las credenciales nuevas solo llegan al contenedor al redesplegar.
  if (Object.keys(entries).length > 0) bumpConfigRev([service.id]);
  return { keys: Object.keys(entries), kept: names.kept, revoked };
}

/** El servicio, si es del proyecto y se le puede conectar el correo; si no, el error de la ruta. */
export function serviceOfProject(projectId: string, serviceId: string): ServiceRow {
  const service = getService(serviceId);
  if (!service || service.project_id !== projectId || !getProject(projectId)) throw httpError(404, 'Servicio no encontrado en este proyecto');
  if (service.type === 'database') throw httpError(400, 'No es posible conectar el correo a un servicio de base de datos.');
  return service;
}
