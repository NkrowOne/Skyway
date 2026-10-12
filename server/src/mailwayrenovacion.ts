/**
 * Renovación automática de las contraseñas de aplicación que Mailway invalida.
 *
 * Al cambiar de motor de correo (Stalwart 0.15 → 0.16), las contraseñas de
 * aplicación creadas con el motor anterior dejan de funcionar: el nuevo las
 * genera él y no puede heredarlas. Mailway las conserva marcadas con
 * `invalidatedAt` y lo anuncia en `features.appPasswordInvalidation`. Un
 * servicio conectado por SMTP lleva una de ellas en sus variables y, sin esto,
 * dejaría de enviar correo hasta que alguien lo volviera a conectar a mano. Los
 * conectados por la API de envío no se ven afectados: Mailway vuelve a emitir
 * por su cuenta la credencial interna de cada clave. Un Mailway anterior no
 * manda ni el anuncio ni el campo: entonces no se da ninguna por invalidada.
 *
 * Para cada servicio cuyas variables llevan la contraseña de aplicación que
 * escribió Skyway (sin tocar desde entonces) y cuya contraseña en Mailway está
 * invalidada, en este orden:
 *
 * 1. se crea una nueva para el mismo buzón (las invalidadas ya no cuentan para
 *    el límite de Mailway); si falla, no se cambia nada y se reintenta después;
 * 2. se escriben las variables (solo la credencial y lo que ya es de Skyway) y
 *    se anota la renovación, en la misma transacción;
 * 3. se vuelve a desplegar el servicio con el despliegue de siempre, si llegó a
 *    desplegarse; si el despliegue falla, las credenciales nuevas se quedan y
 *    el fallo avisa como cualquier otro;
 * 4. se revoca la invalidada, que ya no funcionaba: nunca se retira una
 *    credencial antes de tener guardada la que la sustituye;
 * 5. se audita y se avisa por los canales de alertas.
 *
 * No se toca un servicio detenido a mano ni uno con un despliegue en curso
 * (tampoco lo hace el despliegue automático por commit), ni el de una cuenta
 * suspendida: se anota por qué espera y se reintenta, sin haber creado nada.
 * Todo va con el turno de las credenciales del servicio
 * (`withMailCredentialLock`), el mismo de «Conectar a un servicio».
 *
 * Cuándo: en el ciclo de 10 minutos del planificador, con Mailway configurado y
 * Docker disponible (sin él no se podría volver a desplegar), con un solo
 * resumen por cliente de Mailway en cada pasada; y al abrir el correo del
 * proyecto quien lo gestiona, para que se repare al momento tras la
 * actualización.
 */
import { fireAlert, resolveServiceAlerts } from './alerts';
import { auditSystem } from './audit';
import {
  activeDeploymentIdsForServices,
  clearMailwayRenovacionPendiente,
  deleteMailwayRenovacion,
  deploymentSummary,
  getMailwayRenovacion,
  getProject,
  getService,
  lastSuccessfulImage,
  listMailwayLinks,
  listMailwayRenovaciones,
  listServices,
  listServicesForProjects,
  setMailwayRenovacionDeployment,
  setMailwayRenovacionPendiente,
  writeMailwayRenovacion,
} from './db';
import { triggerDeploy } from './deploy/deployer';
import { dockerAvailable } from './docker/client';
import {
  MailTarget,
  RENEWAL_FAILED_ALERT,
  appPasswordName,
  checkOwnedSummary,
  credentialNames,
  mailConnectNames,
  mailCredentialGeneration,
  mailEntries,
  mailOrigin,
  partialConnectionMessage,
  revokeIgnoringGone,
  submissionOf,
  withMailCredentialLock,
} from './mailconnect';
import { DEFAULT_MAIL_VARS, MailValues, SECRET_ROLES, mailValue } from './mailenv';
import {
  MailwayAppPasswordInfo,
  MailwayError,
  MailwayInfo,
  MailwaySummary,
  cachedInfo,
  createAppPassword,
  getInfo,
  getSummary,
  mailwayConfigured,
  revokeAppPassword,
} from './mailway';
import { EnvState, envStateOf, managedUnchanged } from './managedenv';
import { markManualAction } from './monitor';
import { isWorkspaceActive, workspaceOfProject } from './quota';
import { DeploymentStatus, MailwayLinkRow, MailwayRenovacionStatus, ProjectRow, ServiceRow } from './types';

/** Origen de los despliegues que lanza la renovación: el historial lo distingue de un «Conectar». */
export const RENEWAL_TRIGGER = 'mailway_renovacion';

/** Alerta informativa de cada renovación hecha (una por contraseña nueva). */
export const RENEWED_ALERT = 'mail_password_renewed';

/**
 * Al abrir el correo del proyecto no se vuelve a intentar lo que acaba de
 * fallar: con Mailway rechazando la creación, cada lectura de la vista sería
 * otro intento.
 */
const VIEW_RETRY_MS = 60_000;

type Aviso = (message: string) => void;

/** ¿Anuncia Mailway que marca las contraseñas invalidadas? Sin el anuncio, ninguna lo está. */
export function announcesInvalidation(info: MailwayInfo | null | undefined): boolean {
  return info?.features?.appPasswordInvalidation === true;
}

/** Invalidada por un cambio de motor. Sin el campo (un Mailway anterior), no. */
function invalidated(a: MailwayAppPasswordInfo): boolean {
  return typeof a.invalidatedAt === 'number' && a.invalidatedAt > 0;
}

/** Orígenes con los que Skyway recuerda haber escrito la credencial SMTP (`mail.smtp.password`, `mail.smtp.url`). */
const SMTP_SECRET_ORIGINS = new Set(SECRET_ROLES.smtp.map((role) => mailOrigin('smtp', role)));

/** Nombres de siempre de la conexión SMTP, los que escribía Skyway antes de llevar la cuenta de lo escrito. */
const LEGACY_VAR = Object.fromEntries(DEFAULT_MAIL_VARS.smtp.map((v) => [v.role, v.name])) as Record<string, string>;

/** ¿Lleva Skyway la cuenta de lo que escribió por SMTP en este servicio (`service_managed_env`)? */
function smtpTracked(state: EnvState): boolean {
  return Object.values(state.managed).some((m) => m.origin.startsWith('mail.smtp.'));
}

/**
 * ¿Llevan las variables del servicio una contraseña de aplicación que escribió
 * Skyway? Con la cuenta de lo escrito, una variable de la credencial SMTP que
 * conserva el valor que puso Skyway (si alguien la ha cambiado, la credencial
 * es suya y no se toca). Sin ella (una conexión anterior), los nombres de
 * siempre con valor; con el resumen se comprueba además el buzón.
 */
function carriesSkywaySmtpPassword(state: EnvState): boolean {
  if (smtpTracked(state)) {
    return Object.entries(state.managed).some(([key, m]) => SMTP_SECRET_ORIGINS.has(m.origin) && managedUnchanged(state, key));
  }
  return !!state.env[LEGACY_VAR.password] && !!state.env[LEGACY_VAR.user];
}

/** Usuario SMTP de las variables del servicio (el buzón con el que se conectó), o null. */
function smtpUser(state: EnvState): string | null {
  if (smtpTracked(state)) {
    const key = Object.keys(state.managed).find((k) => state.managed[k].origin === mailOrigin('smtp', 'user'));
    return key ? (state.env[key] ?? null) : null;
  }
  return state.env[LEGACY_VAR.user] ?? null;
}

/**
 * Usuarios con los que entra el buzón de una contraseña de aplicación: su
 * dirección y, tras un cambio de dominio que aún no ha actualizado su usuario,
 * el del motor (`login`, Mailway 1.3+), que sigue siendo la dirección
 * anterior: es el que llevan las variables de las aplicaciones hasta la baja.
 */
function usuariosDe(a: MailwayAppPasswordInfo, summary: MailwaySummary | null): string[] {
  const login = summary?.mailboxes.find((m) => m.id === a.mailboxId)?.login;
  return login && login !== a.email ? [a.email, login] : [a.email];
}

/**
 * ¿Es una de las invalidadas la que llevan las variables? En una conexión
 * anterior a llevar la cuenta de lo escrito, solo si el usuario de las
 * variables es su buzón: sin esa comprobación, unas variables SMTP puestas a
 * mano con esos nombres se tomarían por las de Skyway.
 */
function usesInvalidated(state: EnvState, dead: readonly MailwayAppPasswordInfo[], summary: MailwaySummary | null): boolean {
  if (dead.length === 0 || !carriesSkywaySmtpPassword(state)) return false;
  if (smtpTracked(state)) return true;
  const user = smtpUser(state);
  return !!user && dead.some((a) => usuariosDe(a, summary).includes(user));
}

/**
 * De lo que escribiría «Conectar a un servicio», lo que cambia la renovación:
 * la credencial, y lo que ya es de Skyway (lo escribió y nadie lo ha cambiado)
 * o ya tiene ese mismo valor. No añade variables que no estuvieran ni cambia
 * una que nadie pueda asegurar que sea de Skyway: solo se sustituye la
 * contraseña que ha dejado de funcionar.
 */
function varsToRenew(targets: readonly MailTarget[], state: EnvState, values: MailValues): MailTarget[] {
  const secret = new Set(SECRET_ROLES.smtp);
  return targets.filter((t) => {
    const current = state.env[t.name];
    if (current === undefined || current === '') return false;
    if (secret.has(t.role)) return true;
    return managedUnchanged(state, t.name) || current === mailValue(t.role, values);
  });
}

/**
 * En una conexión anterior a llevar la cuenta de lo escrito no se sabe qué ha
 * cambiado alguien a mano. La credencial solo se renueva si el servidor, el
 * puerto y el usuario siguen siendo los de Mailway: con otro servidor puesto a
 * mano, la contraseña nueva viajaría a ese tercero. Devuelve los distintos.
 */
function legacyMismatches(state: EnvState, expected: { host: string; port: number; user: string }): string[] {
  const out: string[] = [];
  const check = (role: 'host' | 'port' | 'user', value: string) => {
    const current = state.env[LEGACY_VAR[role]];
    if (current !== undefined && current !== '' && current !== value) out.push(LEGACY_VAR[role]);
  };
  check('host', expected.host);
  check('port', String(expected.port));
  check('user', expected.user);
  return out;
}

/** El texto de un error termina en punto: se encadena con otra frase. */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

// ---------- estado anotado ----------

/** Lo anotado como pendiente ya no hace falta: vuelve a la última renovación hecha y se resuelve su alerta. */
function clearPending(serviceId: string): void {
  const row = getMailwayRenovacion(serviceId);
  if (!row || row.status === 'renewed') return;
  clearMailwayRenovacionPendiente(serviceId);
  resolveServiceAlerts(serviceId, RENEWAL_FAILED_ALERT);
}

/** Se renovará cuando se pueda: no es un fallo, así que no avisa (y retira el aviso de un fallo anterior). */
function waiting(serviceId: string, reason: string): 'waiting' {
  setMailwayRenovacionPendiente(serviceId, 'waiting', reason);
  resolveServiceAlerts(serviceId, RENEWAL_FAILED_ALERT);
  return 'waiting';
}

/**
 * No se ha podido renovar: se anota el motivo y se avisa una vez (la alerta se
 * deduplica mientras siga abierta). Se reintenta en la comprobación siguiente.
 */
function failed(service: ServiceRow, project: ProjectRow, reason: string): 'failed' {
  setMailwayRenovacionPendiente(service.id, 'failed', reason);
  fireAlert({
    severity: 'warning',
    type: RENEWAL_FAILED_ALERT,
    serviceId: service.id,
    title: `No se ha podido renovar la contraseña de aplicación: ${service.name}`,
    message:
      `La contraseña de aplicación con la que «${service.name}» (${project.name}) envía correo ha dejado de ser válida ` +
      `tras la actualización del servidor de correo y no se ha podido renovar automáticamente. ${reason}`,
    explanation:
      'Mientras tanto, el servicio no puede enviar correo. Se vuelve a intentar cada 10 minutos; también puedes ' +
      'conectar de nuevo el correo del servicio desde «Correo → Conectar a un servicio».',
    dedupe: true,
  });
  return 'failed';
}

/** Por qué hay que esperar para renovarla sin crear nada todavía, o null si se puede ya. */
function waitReason(service: ServiceRow, project: ProjectRow, summary: MailwaySummary): string | null {
  const workspace = workspaceOfProject(project.id);
  // Con la cuenta suspendida los despliegues están detenidos: no se podría aplicar.
  if (workspace && !isWorkspaceActive(workspace)) {
    return 'La cuenta del proyecto está suspendida. La contraseña se renovará automáticamente cuando se reactive.';
  }
  if (summary.client.suspended) {
    return 'El cliente de correo está suspendido en Mailway. La contraseña se renovará automáticamente cuando se reactive.';
  }
  // Volver a desplegarlo lo arrancaría; arrancarlo a mano tampoco basta (el
  // contenedor conserva sus variables), así que se espera a que vuelva a estar
  // en marcha y entonces se renueva y se despliega.
  if (service.stopped_at) {
    return 'El servicio está detenido. La contraseña se renovará automáticamente cuando vuelva a estar en marcha.';
  }
  if (activeDeploymentIdsForServices([service.id]).length > 0) {
    return 'Hay un despliegue del servicio en curso. La contraseña se renovará automáticamente cuando termine.';
  }
  return null;
}

/** Revoca las invalidadas, que ya no funcionaban. Lo que falle se reintenta en la comprobación siguiente. */
async function revokeInvalidated(list: MailwayAppPasswordInfo[]): Promise<number> {
  let revoked = 0;
  for (const a of list) {
    try {
      await revokeIgnoringGone(() => revokeAppPassword(a.mailboxId, a.id));
      revoked++;
    } catch (err) {
      if (!(err instanceof MailwayError)) throw err;
    }
  }
  return revoked;
}

// ---------- renovación de un servicio ----------

interface Pass {
  project: ProjectRow;
  link: MailwayLinkRow;
  info: MailwayInfo;
  /** Resumen del cliente, leído antes de pedir el turno del servicio. */
  summary: MailwaySummary;
  /** Turnos terminados del servicio antes de leer `summary`; null si no se sabe (se vuelve a leer). */
  generation: number | null;
}

type Outcome = 'none' | 'renewed' | 'cleanup' | 'waiting' | 'failed';

/** Contraseñas de aplicación de Skyway para el servicio, sin revocar, que están invalidadas (la más nueva primero). */
function invalidatedOf(service: ServiceRow, link: MailwayLinkRow, summary: MailwaySummary): MailwayAppPasswordInfo[] {
  const names = credentialNames(service, 'smtp', link);
  return summary.appPasswords
    .filter((a) => !a.revokedAt && names.includes(a.name) && invalidated(a))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

async function renewService(service: ServiceRow, pass: Pass): Promise<Outcome> {
  return withMailCredentialLock(service.id, async () => {
    const current = getService(service.id);
    if (!current || current.project_id !== pass.project.id || current.type === 'database') return 'none';
    let summary = pass.summary;
    if (pass.generation === null || mailCredentialGeneration(service.id) !== pass.generation) {
      // Otro ha cambiado las credenciales del servicio desde que se leyó el
      // resumen (un «Conectar», otra renovación), o no se sabe: las de ahora.
      summary = checkOwnedSummary(pass.project, pass.link, await getSummary(pass.link.client_id));
    }
    return renewWithSummary(current, pass, summary);
  });
}

/**
 * ¿Dejó ya una renovación anterior la nueva en las variables (sigue vigente en
 * Mailway) sin llegar a revocar la invalidada? Entonces solo falta revocarla:
 * así dos pasadas seguidas no crean dos contraseñas.
 */
function alreadyRenewed(service: ServiceRow, link: MailwayLinkRow, summary: MailwaySummary): boolean {
  const row = getMailwayRenovacion(service.id);
  if (!row?.app_password_id) return false;
  const names = credentialNames(service, 'smtp', link);
  return summary.appPasswords.some((a) => a.id === row.app_password_id && !a.revokedAt && !invalidated(a) && names.includes(a.name));
}

async function renewWithSummary(service: ServiceRow, pass: Pass, summary: MailwaySummary): Promise<Outcome> {
  const { project, link } = pass;
  const dead = invalidatedOf(service, link, summary);
  const state = envStateOf(service);
  // Nada invalidado, o el servicio ya no usa la contraseña de Skyway (alguien
  // la ha cambiado; en una conexión anterior, con otro buzón): nada que hacer.
  if (!usesInvalidated(state, dead, summary)) {
    clearPending(service.id);
    return 'none';
  }
  if (alreadyRenewed(service, link, summary)) {
    await revokeInvalidated(dead);
    return 'cleanup';
  }

  const tracked = smtpTracked(state);
  const user = smtpUser(state);
  const previous = (user ? dead.find((a) => usuariosDe(a, summary).includes(user)) : undefined) ?? dead[0];
  const wait = waitReason(service, project, summary);
  if (wait) return waiting(service.id, wait);
  const mailbox = summary.mailboxes.find((m) => m.id === previous.mailboxId);
  if (!mailbox) {
    return failed(service, project, `El buzón ${previous.email} ya no existe en Mailway. Conecta de nuevo el correo del servicio con otro buzón.`);
  }
  if (mailbox.status === 'suspended') {
    return waiting(service.id, `El buzón ${mailbox.email} está suspendido en Mailway. La contraseña se renovará automáticamente cuando se reactive.`);
  }
  const { host, port } = submissionOf(pass.info);
  if (!host) {
    return failed(service, project, 'Mailway no ha indicado el servidor de envío (submission). Se volverá a intentar automáticamente.');
  }

  // Las mismas reglas que «Conectar a un servicio», antes de crear nada: si el
  // servidor, el puerto o el usuario están puestos a mano con otro valor, la
  // contraseña nueva acabaría en otro proveedor.
  // El usuario es el del motor (tras un cambio de dominio, la dirección
  // anterior hasta la baja), como al conectar: con la dirección nueva, la
  // aplicación no podría entrar.
  const usuario = mailbox.login || mailbox.email;
  const connect = mailConnectNames(service, 'smtp', { host, port, from: mailbox.email, user: usuario }, true);
  if (connect.conflicts.length > 0) return failed(service, project, partialConnectionMessage(connect.conflicts));
  if (!tracked) {
    const distintas = legacyMismatches(state, { host, port, user: usuario });
    if (distintas.length > 0) {
      const una = distintas.length === 1;
      return failed(
        service,
        project,
        `${distintas.join(', ')} ${una ? 'tiene' : 'tienen'} un valor distinto del de Mailway y la conexión es anterior a que Skyway ` +
          'anotara lo que escribe, así que no se sabe si se ha cambiado a mano. Conecta de nuevo el correo del servicio desde ' +
          '«Correo → Conectar a un servicio».',
      );
    }
  }

  // Qué se escribirá, antes de crear nada: sin una variable que reciba la
  // contraseña nueva, crearla solo dejaría otra sin usar en Mailway.
  const base: MailValues = { host, port, user: usuario, password: null, from: mailbox.email, apiUrl: null, apiKey: null };
  const toWrite = varsToRenew(connect.targets, state, base);
  const secretRoles = new Set(SECRET_ROLES.smtp);
  if (!toWrite.some((t) => secretRoles.has(t.role))) {
    return failed(
      service,
      project,
      'Ninguna variable del servicio puede recibir la contraseña nueva sin sobrescribir un valor puesto a mano. ' +
        'Conecta de nuevo el correo del servicio desde «Correo → Conectar a un servicio».',
    );
  }

  // 1. La nueva, antes de tocar nada.
  let created: Awaited<ReturnType<typeof createAppPassword>>;
  try {
    created = await createAppPassword(mailbox.id, appPasswordName(service));
  } catch (err) {
    if (!(err instanceof MailwayError)) throw err;
    return failed(
      service,
      project,
      `No se ha podido crear la contraseña de aplicación nueva en Mailway: ${sentence(err.message)} Se volverá a intentar automáticamente.`,
    );
  }
  const newId = created?.appPassword?.id;
  if (!created?.password || typeof newId !== 'string' || !newId) {
    return failed(service, project, 'Mailway no ha devuelto la contraseña de aplicación nueva. Se volverá a intentar automáticamente.');
  }

  // 2. Variables y anotación juntas: desde aquí Skyway sabe qué contraseña llevan.
  const entries = mailEntries('smtp', toWrite, { ...base, password: created.password });
  writeMailwayRenovacion(service.id, entries, { appPasswordId: newId, mailbox: mailbox.email });
  const keys = Object.keys(entries);

  // 3. Volver a desplegar, solo si llegó a desplegarse: uno que nunca lo hizo la
  // recibirá en su primer despliegue.
  let deploymentId: string | null = null;
  let deployError: string | null = null;
  if (lastSuccessfulImage(service.id)) {
    try {
      // El intercambio de contenedores no es una caída: sin esto, el monitor avisaría.
      markManualAction(service.id);
      deploymentId = triggerDeploy(service.id, RENEWAL_TRIGGER).id;
      setMailwayRenovacionDeployment(service.id, deploymentId);
    } catch (err) {
      deployError = err instanceof Error ? err.message : String(err);
      fireAlert({
        severity: 'warning',
        type: 'deploy_failed',
        serviceId: service.id,
        title: `Despliegue fallido: ${service.name}`,
        message: `No se ha podido iniciar el despliegue de «${service.name}» (${project.name}) que aplica la contraseña de aplicación renovada: ${deployError.slice(0, 300)}`,
        explanation: 'La contraseña nueva ya está guardada en las variables del servicio. Vuelve a desplegarlo para aplicarla.',
        dedupe: true,
      });
    }
  }

  // 4. La invalidada ya no funcionaba: retirarla no deja al servicio sin nada.
  const revoked = await revokeInvalidated(dead);

  // 5. Rastro y aviso.
  const deployText = deploymentId
    ? 'despliegue iniciado'
    : deployError
      ? 'no se ha podido iniciar el despliegue'
      : 'sin desplegar: se aplicará en el próximo despliegue';
  auditSystem(
    'mailway_app_password_renewed',
    `${service.name} ← ${mailbox.email} (SMTP): ${keys.join(', ')} · la anterior dejó de ser válida tras la actualización del servidor de correo` +
      `${revoked === dead.length ? ' y se ha revocado' : ''} · ${deployText}`,
    { type: 'service', id: service.id },
  );
  resolveServiceAlerts(service.id, RENEWAL_FAILED_ALERT);
  fireAlert({
    severity: 'info',
    type: RENEWED_ALERT,
    serviceId: service.id,
    title: `Contraseña de aplicación renovada: ${service.name}`,
    message:
      `La contraseña de aplicación con la que «${service.name}» (${project.name}) envía correo dejó de ser válida tras la ` +
      `actualización del servidor de correo. Se ha creado una nueva para ${mailbox.email} y se ha guardado en ${keys.join(', ')}. ` +
      (deploymentId
        ? 'Se ha iniciado un nuevo despliegue para aplicarla.'
        : deployError
          ? 'No se ha podido iniciar el despliegue que la aplica: vuelve a desplegar el servicio.'
          : 'Se aplicará en el próximo despliegue del servicio.'),
    explanation:
      'La renovación es automática: Mailway invalida las contraseñas de aplicación creadas con su motor de correo anterior. ' +
      'Si el despliegue falla, vuelve a desplegar el servicio para aplicar la contraseña nueva.',
    // Una por contraseña nueva: la de otra renovación posterior también avisa.
    dedupeKey: `${service.id}:${RENEWED_ALERT}:${newId}`,
  });
  return 'renewed';
}

// ---------- cuándo se comprueba ----------

/** Lo anotado como pendiente (espera o fallo) del servicio, si lo hay. */
function pendingRow(serviceId: string) {
  const row = getMailwayRenovacion(serviceId);
  return row && row.status !== 'renewed' ? row : null;
}

interface ProjectGroup {
  project: ProjectRow;
  link: MailwayLinkRow;
  services: ServiceRow[];
}

/**
 * Servicios que hay que mirar, por cliente de Mailway, sin salir a la red: los
 * que llevan una contraseña de aplicación de Skyway en sus variables y los que
 * tienen algo pendiente anotado (para quitarlo si ya no hace falta).
 */
function candidatesByClient(): Map<string, ProjectGroup[]> {
  const links = listMailwayLinks();
  const servicesByProject = listServicesForProjects(links.map((l) => l.project_id));
  const out = new Map<string, ProjectGroup[]>();
  for (const link of links) {
    const project = getProject(link.project_id);
    if (!project) continue;
    const services = (servicesByProject.get(link.project_id) ?? []).filter(
      (s) => s.type !== 'database' && (carriesSkywaySmtpPassword(envStateOf(s)) || !!pendingRow(s.id)),
    );
    if (services.length === 0) continue;
    const groups = out.get(link.client_id) ?? [];
    groups.push({ project, link, services });
    out.set(link.client_id, groups);
  }
  return out;
}

/**
 * Pasada del planificador por todos los proyectos con correo. Sin red mientras
 * ningún servicio lleve una contraseña de aplicación de Skyway; si no, la
 * información de la instancia (en caché) y un resumen por cliente de Mailway,
 * compartido por los proyectos de una misma cuenta. Nunca lanza por un cliente
 * o un servicio: lo registra y sigue con el resto.
 */
export async function renovarContrasenasInvalidadas(aviso: Aviso): Promise<void> {
  if (!mailwayConfigured()) return;
  const groups = candidatesByClient();
  if (groups.size === 0) return;
  const info = await getInfo();
  if (!announcesInvalidation(info)) return;
  if (!(await dockerAvailable())) return;
  for (const [clientId, projects] of groups) {
    // Antes de leer el resumen: al pedir el turno de cada servicio se sabrá si
    // otro ha cambiado entretanto sus credenciales.
    const generations = new Map<string, number>();
    for (const g of projects) for (const s of g.services) generations.set(s.id, mailCredentialGeneration(s.id));
    let summary: MailwaySummary;
    try {
      summary = await getSummary(clientId);
    } catch (err) {
      aviso(`Renovación de contraseñas de aplicación: no se ha podido leer el cliente de correo ${clientId}: ${(err as Error).message}`);
      continue;
    }
    for (const g of projects) {
      try {
        checkOwnedSummary(g.project, g.link, summary);
      } catch {
        // El cliente ya no es el del proyecto: lo explica la vista del correo.
        continue;
      }
      for (const service of g.services) {
        // Lo normal en cada pasada: nada invalidado. Sin turno ni más
        // peticiones; solo se quita lo que quedara anotado.
        if (!usesInvalidated(envStateOf(service), invalidatedOf(service, g.link, summary), summary)) {
          clearPending(service.id);
          continue;
        }
        try {
          await renewService(service, { ...g, info, summary, generation: generations.get(service.id) ?? null });
        } catch (err) {
          aviso(`No se ha podido renovar la contraseña de aplicación de «${service.name}» (${g.project.name}): ${(err as Error).message}`);
        }
      }
    }
  }
}

/**
 * Al abrir el correo del proyecto quien lo gestiona: se renuevan al momento
 * las contraseñas invalidadas de los servicios de ESTE proyecto, sin esperar al
 * ciclo de fondo. `summary` es el que acaba de leer la vista; dentro del turno
 * de cada servicio que haya que renovar se vuelve a leer. Devuelve si ha
 * cambiado algo en Mailway, para que la vista lea el resumen de nuevo. Nunca
 * lanza: lo que falle queda anotado y lo reintenta el ciclo de fondo.
 */
export async function renovarCorreoDelProyecto(
  project: ProjectRow,
  link: MailwayLinkRow,
  summary: MailwaySummary,
  aviso: Aviso,
): Promise<boolean> {
  let changed = false;
  try {
    const info = cachedInfo();
    if (!info || !announcesInvalidation(info)) return false;
    // Sin red: lo que hay que renovar según el resumen de la vista.
    const due: ServiceRow[] = [];
    for (const service of listServices(project.id)) {
      if (service.type === 'database') continue;
      if (!usesInvalidated(envStateOf(service), invalidatedOf(service, link, summary), summary)) {
        clearPending(service.id);
        continue;
      }
      // Revocar lo que ya se sustituyó queda para el ciclo de fondo: la vista no espera por eso.
      if (alreadyRenewed(service, link, summary)) continue;
      // Si hay que esperar (servicio detenido, despliegue en curso…), se sabe sin volver a leer el resumen.
      const wait = waitReason(service, project, summary);
      if (wait) {
        waiting(service.id, wait);
        continue;
      }
      const pending = pendingRow(service.id);
      if (pending?.status === 'failed' && Date.now() - pending.updated_at < VIEW_RETRY_MS) continue;
      due.push(service);
    }
    if (due.length === 0 || !(await dockerAvailable())) return false;
    for (const service of due) {
      try {
        const outcome = await renewService(service, { project, link, info, summary, generation: null });
        if (outcome === 'renewed' || outcome === 'cleanup') changed = true;
      } catch (err) {
        aviso(`No se ha podido renovar la contraseña de aplicación de «${service.name}» (${project.name}): ${(err as Error).message}`);
      }
    }
  } catch (err) {
    aviso(`Renovación de contraseñas de aplicación del proyecto «${project.name}»: ${(err as Error).message}`);
  }
  return changed;
}

/**
 * Al desactivar el correo del proyecto, Skyway deja de renovar las contraseñas
 * de sus servicios: lo anotado ya no se actualizaría y su aviso quedaría
 * abierto para siempre.
 */
export function forgetProjectRenewals(projectId: string): void {
  for (const r of listMailwayRenovaciones(projectId)) {
    deleteMailwayRenovacion(r.service_id);
    resolveServiceAlerts(r.service_id, RENEWAL_FAILED_ALERT);
  }
}

// ---------- vista ----------

export interface MailRenewalView {
  status: MailwayRenovacionStatus;
  reason: string | null;
  renewedAt: number | null;
  mailbox: string | null;
  /** Despliegue que aplica la contraseña renovada y su estado; null si no se lanzó. */
  deployment: { id: string; status: DeploymentStatus } | null;
}

/** Renovaciones de los servicios del proyecto, por servicio: lo que enseña «Conectar a un servicio». */
export function renewalsOfProject(projectId: string): Record<string, MailRenewalView> {
  const out: Record<string, MailRenewalView> = {};
  for (const r of listMailwayRenovaciones(projectId)) {
    const dep = r.deployment_id ? deploymentSummary(r.deployment_id) : undefined;
    out[r.service_id] = {
      status: r.status,
      reason: r.reason,
      renewedAt: r.renewed_at,
      mailbox: r.mailbox,
      deployment: dep ? { id: dep.id, status: dep.status } : null,
    };
  }
  return out;
}
