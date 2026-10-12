/**
 * Plan de integraciones de una web: qué necesita para funcionar en Skyway
 * (bases de datos, correo, secretos, su propia URL) y con qué nombres de
 * variable, sacado de su `skyway.json` o, si no lo trae, de la detección de
 * `needs.ts`. El plan se construye SIN EFECTOS (`buildPlan`) para enseñarlo, y
 * se aplica con un solo botón (`applyPlan`) con estas reglas:
 *
 * - Lo inofensivo se aplica sin preguntar: secretos generados, la URL pública
 *   del propio servicio, valores literales y huecos vacíos. No dan acceso a
 *   nada que la web no tuviera ya (su código corre en el contenedor igual).
 * - Lo que da acceso a algo (crear o conectar una base de datos, crear un
 *   buzón o una credencial de correo) necesita que una persona lo apruebe: en
 *   un despliegue nunca se aplica solo. Las bases las aprueba cualquiera con
 *   acceso al proyecto, con la misma regla que crearlas a mano (módulo «Bases
 *   de datos» y cuota, `dbCreateBlock`); el correo, quien gestiona el
 *   proyecto (administrador o propietario de la cuenta), como «Conectar a un
 *   servicio». Lo que no puede aprobar quien aplica queda como «Cambios
 *   pendientes de aprobar».
 * - La aprobación va ligada a lo que se ha revisado: el plan lleva una huella
 *   (`fingerprint`) de lo privilegiado y aplicarlo exige esa huella. Si entre
 *   ver el plan y aprobarlo cambia (un push con otro manifiesto), no se aprueba
 *   nada a ciegas. Reutilizar en SMTP un buzón que ya existe pide además una
 *   confirmación explícita: su contraseña de aplicación da acceso IMAP a todo
 *   el buzón.
 * - Nunca se pisa una variable puesta a mano (`managedenv.ts`), nunca `PORT`
 *   ni `SKYWAY_*`, y todo queda dentro del proyecto: las bases se buscan entre
 *   sus servicios y el correo es el de su cliente de Mailway.
 *
 * En cada despliegue (`reconcileOnDeploy`) se vuelve a mirar el manifiesto: lo
 * inofensivo nuevo se aplica y lo privilegiado nuevo se anota como pendiente,
 * y el despliegue sigue con lo ya aprobado.
 */
import crypto from 'crypto';
import { canManageProject } from './auth';
import {
  countWorkspaceServices,
  createService,
  getMailwayLink,
  getProject,
  getService,
  listServices,
  setEnv,
  uniqueServiceSlug,
  updateService,
  writeManagedEnv,
} from './db';
import { triggerDeploy } from './deploy/deployer';
import { parseGithubSlug } from './github/client';
import { resolveGitToken } from './github/resolve';
import {
  BUZONES_RESERVADOS,
  CLIENTE_SUSPENDIDO,
  CUENTA_SUSPENDIDA,
  NO_CONFIGURADO,
  conexionPrevista,
  connectServiceMail,
  credentialNames,
  httpError,
  isRefError,
  knownMailValues,
  mailConnectNames,
  mailCredentialGeneration,
  mailOrigin,
  ownedSummary,
  partialConnectionMessage,
  withMailCredentialLock,
} from './mailconnect';
import { MailMode, MailRole, mailValue } from './mailenv';
import { MailwayDomain, MailwayError, MailwayInfo, MailwayMailbox, MailwaySummary, createMailbox, getInfo, mailwayConfigured } from './mailway';
import { dominioPrincipal } from './dominioprincipal';
import { manifestEngines, manifestMailMode, manifestWantsMail, reservedManifestVar } from './manifest';
import { managedUnchanged, envStateOf, EnvState, writeDecision } from './managedenv';
import { markManualAction } from './monitor';
import { adviseNeeds, detectNeedsFromGithub } from './needs';
import { effectiveQuota, isWorkspaceActive, moduleAllowedForProject, workspaceOfProject, workspacePlan } from './quota';
import { getTemplate } from './templates';
import { DatabaseConfig, DetectedNeeds, GitConfig, MailwayLinkRow, ProjectRow, ServiceRow, UserRow } from './types';
import { projectReferences } from './variables';

export type PlanStatus = 'apply' | 'done' | 'manual' | 'blocked';

export interface PlanVar {
  name: string;
  /** De dónde sale: `postgres.DATABASE_URL`, `mail.password`, `self.public_url`, `generate`, `value` o `empty`. */
  from: string;
  /** Recurso del que depende (motor de base de datos o `mail`), o null. */
  resource: string | null;
  /** Requiere la aprobación de quien gestiona el proyecto. */
  privileged: boolean;
  /** `apply` = se escribirá; `done` = ya está; `manual` = puesta a mano, no se toca; `blocked` = no se puede ahora. */
  status: PlanStatus;
  /** Lo que se escribirá, para la vista (una referencia, «32 bytes aleatorios»…). Nunca un secreto. */
  detail: string | null;
  reason: string | null;
}

export interface PlanResource {
  /** Motor (`postgres`, `redis`…) o `mail`. */
  key: string;
  label: string;
  /** Crear el recurso (una base nueva, un buzón nuevo) o reutilizar el que ya hay. */
  action: 'create' | 'reuse' | null;
  /** Servicio de base de datos o buzón remitente. */
  target: string | null;
  mode: MailMode | null;
  status: PlanStatus;
  reason: string | null;
  evidence: string | null;
  /** Quien consulta el plan puede aprobar este recurso (bases: acceso al proyecto; correo: gestionarlo). */
  canApprove: boolean;
  /**
   * Lo que hay que confirmar expresamente para aprobarlo, o null. Hoy, solo
   * reutilizar en SMTP un buzón que ya existe: su contraseña de aplicación da
   * acceso IMAP y SMTP a todo su correo.
   */
  confirmation: string | null;
}

export interface IntegrationPlan {
  source: 'manifest' | 'detection' | null;
  manifestFile: string | null;
  manifestError: string | null;
  resources: PlanResource[];
  vars: PlanVar[];
  /** Variables privilegiadas por aplicar: necesitan que alguien las apruebe. */
  pendingApproval: string[];
  /** Quien consulta el plan puede aprobar todo lo pendiente (ver `PlanResource.canApprove`). */
  canApprove: boolean;
  /**
   * Huella de lo privilegiado por aplicar (recursos y variables). Aprobar exige
   * enviarla: si el plan ha cambiado desde que se revisó, no coincide.
   */
  fingerprint: string;
}

/** Servicio al que va el plan: el que existe o el que se va a crear con el asistente. */
export interface PlanTarget {
  /** Fila del servicio; en el asistente, una provisional sin id (sin variables propias). */
  service: ServiceRow;
  domains: string[];
}

/** Papel → texto de la vista. */
const MAIL_ROLE_LABEL: Record<MailRole, string> = {
  host: 'servidor de envío',
  port: 'puerto de envío',
  secure: 'TLS implícito (false)',
  starttls: 'STARTTLS (true)',
  encryption: 'cifrado (tls)',
  user: 'usuario (dirección del buzón)',
  password: 'contraseña de aplicación',
  from: 'remitente (dirección del buzón)',
  url: 'URL SMTP con credenciales',
  api_url: 'URL de la API de envío',
  api_key: 'clave de API',
};

const MANUAL = 'Tiene un valor puesto a mano: no se modifica.';
export const PLAN_CAMBIADO = 'El plan ha cambiado desde que lo revisaste: revísalo de nuevo antes de aprobarlo.';
const SIN_DOMINIO = 'El servicio todavía no tiene dominio: se definirá cuando lo tenga y vuelvas a desplegar.';

/** Fila provisional para planificar un servicio que aún no existe (asistente de alta). */
export function draftService(project: ProjectRow, name: string, needs: DetectedNeeds | null): ServiceRow {
  return {
    id: '',
    project_id: project.id,
    name,
    slug: uniqueServiceSlug(project.id, name),
    type: 'git',
    config: { repoUrl: '', branch: 'main', port: 3000, domains: [], webhookSecret: '', ...(needs ? { needs } : {}) },
    created_at: 0,
  } as ServiceRow;
}

// ---------- estado del correo del proyecto (consulta Mailway, sin efectos) ----------

export interface MailContext {
  available: boolean;
  reason: string | null;
  isAdmin: boolean;
  link: MailwayLinkRow | null;
  summary: MailwaySummary | null;
  info: MailwayInfo | null;
  /** Buzón remitente: el existente o el que se creará. */
  mailbox: { email: string; domainId: string; existing: MailwayMailbox | null } | null;
}

/**
 * Estados de un cambio de dominio (Mailway 1.3+) en los que los buzones siguen
 * en el dominio anterior: hasta que se pasa, el nuevo está vacío. Al pasar
 * (y al volver, mientras dura) están en el nuevo.
 */
const BUZONES_EN_EL_ANTERIOR = new Set(['preparando', 'listo', 'pasando']);

/** ¿Están los buzones del cliente en este dominio, o en el otro de su cambio de dominio? */
function tieneLosBuzones(d: MailwayDomain): boolean {
  const m = d.migracion;
  if (!m) return true;
  return BUZONES_EN_EL_ANTERIOR.has(m.estado) === (m.rol === 'origen');
}

/**
 * El dominio del cliente con la propiedad comprobada que mejor casa con los
 * dominios del servicio. De un cambio de dominio (Mailway 1.3+) cuenta el que
 * tiene los buzones: el anterior hasta que se pasa (la web aún sirve sus
 * nombres y sus buzones se pueden conectar) y el nuevo después, aunque la
 * web siga sirviendo nombres del anterior.
 */
function pickMailDomain(summary: MailwaySummary, serviceDomains: string[]) {
  const domains = summary.domains.filter(tieneLosBuzones);
  const verified = domains.filter((d) => !('ownershipVerifiedAt' in d) || d.ownershipVerifiedAt !== null);
  const matches = (d: { domain: string }) =>
    serviceDomains.some((h) => h.toLowerCase() === d.domain.toLowerCase() || h.toLowerCase().endsWith(`.${d.domain.toLowerCase()}`));
  return { domain: verified.find(matches) ?? verified[0] ?? null, pending: domains.filter((d) => !verified.includes(d)) };
}

/**
 * Por qué no se puede crear un buzón en ese dominio mientras dura su cambio de
 * dominio, o null si se puede: Mailway no admite altas en el anterior hasta
 * que el cambio se cierra, ni en el nuevo hasta pasar (`domain_migrating`).
 * Los buzones que ya existen se pueden conectar igualmente.
 */
function altaBloqueada(d: MailwayDomain): string | null {
  const m = d.migracion;
  if (!m) return null;
  if (m.rol === 'origen') {
    // Ya pasado (o dándose de baja), el nuevo es el que tiene los buzones y ya no se puede cancelar.
    if (m.estado === 'pasado' || m.estado === 'dando_de_baja') return `${d.domain} está en un cambio de dominio: crea el buzón en ${m.pareja}.`;
    return `${d.domain} está en un cambio de dominio: el buzón se podrá crear en ${m.pareja} en cuanto pases a él.`;
  }
  if (m.estado === 'volviendo') return `${d.domain} está volviendo a ${m.pareja}: el buzón se podrá crear cuando termine.`;
  if (BUZONES_EN_EL_ANTERIOR.has(m.estado)) {
    return `${d.domain} se está preparando para sustituir a ${m.pareja}: el buzón se podrá crear en cuanto pases a él.`;
  }
  return null;
}

/**
 * Lo que hace falta saber del correo del proyecto para planificar: si está
 * activo, con qué dominio y qué buzón. Cada «no» lleva su motivo, que el plan
 * enseña tal cual. Nunca lanza por Mailway: un Mailway caído deja el correo
 * como pendiente, no rompe el plan.
 */
export async function mailContext(
  project: ProjectRow,
  user: UserRow,
  serviceDomains: string[],
  localPart: string,
  withInfo: boolean,
): Promise<MailContext> {
  const isAdmin = user.role === 'admin';
  const no = (reason: string): MailContext => ({ available: false, reason, isAdmin, link: null, summary: null, info: null, mailbox: null });
  if (!moduleAllowedForProject(project.id, 'mail', isAdmin)) return no('El módulo «Correo» no está activo en esta cuenta.');
  if (!mailwayConfigured()) return no(NO_CONFIGURADO);
  const link = getMailwayLink(project.id);
  if (!link) return no('El correo no está activado en este proyecto: actívalo en «Correo» y vuelve a aplicar el plan.');
  const workspace = workspaceOfProject(project.id);
  if (workspace && !isWorkspaceActive(workspace)) return no(CUENTA_SUSPENDIDA);
  let summary: MailwaySummary;
  let info: MailwayInfo | null = null;
  try {
    summary = await ownedSummary(project, link);
    if (withInfo) info = await getInfo();
  } catch (err) {
    if (err instanceof MailwayError || isRefError(err)) return no((err as Error).message);
    throw err;
  }
  if (summary.client.suspended) return no(CLIENTE_SUSPENDIDO);
  const { domain, pending } = pickMailDomain(summary, serviceDomains);
  if (!domain) {
    return no(
      pending.length > 0
        ? `La propiedad de ${pending.map((d) => d.domain).join(', ')} todavía no está comprobada: compruébala en «Correo → Dominios» y vuelve a aplicar el plan.`
        : 'El correo del proyecto todavía no tiene ningún dominio: añádelo en «Correo → Dominios» y vuelve a aplicar el plan.',
    );
  }
  const email = `${localPart}@${domain.domain.toLowerCase()}`;
  const existing = summary.mailboxes.find((m) => typeof m.email === 'string' && m.email.toLowerCase() === email) ?? null;
  // Durante un cambio de dominio el buzón que falta no se puede crear: mejor
  // decirlo en el plan que fallar al aplicarlo.
  const bloqueo = existing ? null : altaBloqueada(domain);
  if (bloqueo) return no(bloqueo);
  if (!existing && BUZONES_RESERVADOS.has(localPart) && !isAdmin) {
    return no(`El buzón «${localPart}» está reservado para la administración del dominio: solo un administrador de la plataforma puede crearlo.`);
  }
  return { available: true, reason: null, isAdmin, link, summary, info, mailbox: { email, domainId: domain.id, existing } };
}

// ---------- construcción del plan (sin efectos) ----------

interface DbWant {
  name: string;
  engine: string;
  refVar: string;
  evidence: string;
}

/** Base de datos del proyecto con ese motor (la primera), si la hay. Solo de ESTE proyecto. */
function projectDatabase(projectId: string, engine: string): ServiceRow | null {
  return listServices(projectId).find((s) => s.type === 'database' && (s.config as DatabaseConfig).template === engine) ?? null;
}

/** ¿Es el valor una referencia a la variable `refVar` de una base de ese motor del proyecto? */
function pointsToProjectDb(projectId: string, value: string, engine: string, refVar: string): boolean {
  const m = value.trim().match(/^\$\{\{\s*([A-Za-z0-9 _.-]+?)\.([A-Za-z0-9_]+)\s*\}\}$/);
  if (!m || m[2] !== refVar) return false;
  const name = m[1].trim().toLowerCase();
  return listServices(projectId).some(
    (s) => s.type === 'database' && (s.config as DatabaseConfig).template === engine && (s.name.toLowerCase() === name || s.slug === name),
  );
}

/** Por qué no se puede crear una base ahora mismo en el proyecto, o null. */
function dbCreateBlock(project: ProjectRow, user: UserRow, extra: number): string | null {
  if (!moduleAllowedForProject(project.id, 'databases', user.role === 'admin')) {
    return 'El módulo «Bases de datos» no está activo en esta cuenta.';
  }
  const workspace = workspaceOfProject(project.id);
  if (workspace) {
    if (!isWorkspaceActive(workspace)) return 'La cuenta está suspendida: no se pueden crear servicios.';
    const quota = effectiveQuota(workspace, workspacePlan(workspace));
    if (countWorkspaceServices(workspace.id) + extra >= quota.maxServices) {
      return `La cuenta ha alcanzado su límite de ${quota.maxServices} servicios.`;
    }
  }
  return null;
}

function statusOfValue(state: EnvState, name: string, value: string): { status: PlanStatus; reason: string | null } {
  if (writeDecision(state, name, value) === 'manual') return { status: 'manual', reason: MANUAL };
  return state.env[name] === value ? { status: 'done', reason: null } : { status: 'apply', reason: null };
}

/**
 * Construye el plan contra el estado actual del proyecto y del servicio. Sin
 * `mail` (null) no se consulta Mailway: el correo se da por pendiente si le
 * falta algo, que es lo que necesita saber un despliegue.
 */
export function buildPlan(opts: {
  project: ProjectRow;
  user: UserRow | null;
  target: PlanTarget;
  needs: DetectedNeeds | null | undefined;
  mail: MailContext | null;
}): IntegrationPlan {
  const { project, user, target, needs, mail } = opts;
  const service = target.service;
  const state: EnvState = envStateOf(service);
  const plan: IntegrationPlan = {
    source: null,
    manifestFile: needs?.manifestFile ?? null,
    manifestError: needs?.manifestError ?? null,
    resources: [],
    vars: [],
    pendingApproval: [],
    canApprove: false,
    fingerprint: '',
  };
  plan.fingerprint = planFingerprint(plan);
  if (!needs) return plan;
  // Un manifiesto roto no aplica nada, ni siquiera la detección: lo que la web
  // quería decir está en ese fichero, y adivinarlo sería peor.
  if (needs.manifestFile && !needs.manifest) {
    plan.source = 'manifest';
    return plan;
  }
  const manifest = needs.manifest ?? null;
  plan.source = manifest ? 'manifest' : 'detection';

  const dbWants: DbWant[] = [];
  let wantsMail: { mode: MailMode; mailbox: string; evidence: string } | null = null;
  const selfRef = `\${{${service.slug}.PUBLIC_URL}}`;
  const addVar = (v: PlanVar) => {
    if (reservedManifestVar(v.name) || plan.vars.some((x) => x.name === v.name)) return;
    plan.vars.push(v);
  };
  const harmless = (name: string, from: string, value: string | null, detail: string | null, blockedReason?: string) => {
    if (value === null) {
      addVar({ name, from, resource: null, privileged: false, status: 'blocked', detail, reason: blockedReason ?? null });
      return;
    }
    addVar({ name, from, resource: null, privileged: false, detail, ...statusOfValue(state, name, value) });
  };

  if (manifest) {
    for (const [name, entry] of Object.entries(manifest.env ?? {})) {
      if ('from' in entry) {
        if (entry.from === 'self.public_url') {
          // La referencia apunta a `PUBLIC_URL`, que lleva el dominio principal
          // (`dominioPrincipal`); aquí solo importa que haya alguno.
          harmless(name, 'self.public_url', dominioPrincipal(target.domains) ? selfRef : null, selfRef, SIN_DOMINIO);
        } else if (entry.from === 'postgres.url' || entry.from === 'redis.url') {
          const engine = entry.from.split('.')[0];
          dbWants.push({ name, engine, refVar: getTemplate(engine)!.conn.main, evidence: `${needs.manifestFile}: ${name}` });
        }
        // Las de correo se resuelven abajo, todas juntas.
      } else if ('generate' in entry) {
        // Un secreto generado no se regenera jamás: rotarlo cerraría sesiones
        // o dejaría ilegibles los datos cifrados con él. Si ya tiene valor,
        // está hecho (lo generó Skyway) o es de quien lo puso.
        // Lo que Skyway importó del `.env.example` y nadie ha tocado tampoco
        // es un secreto: es el valor público del repositorio y se sustituye.
        const current = state.env[name];
        const imported = state.managed[name]?.origin === 'import' && managedUnchanged(state, name);
        let status: PlanStatus = 'apply';
        if (current === undefined ? !!state.shared[name] : current !== '' && !managedUnchanged(state, name)) status = 'manual';
        else if (current !== undefined && current !== '' && !imported) status = 'done';
        addVar({
          name,
          from: 'generate',
          resource: null,
          privileged: false,
          status,
          detail: `${entry.generate.bytes} bytes aleatorios`,
          reason: status === 'manual' ? MANUAL : null,
        });
      } else {
        harmless(name, 'value', entry.value, entry.value);
      }
    }
    for (const engine of manifestEngines(manifest)) {
      if (!dbWants.some((w) => w.engine === engine)) {
        const tpl = getTemplate(engine)!;
        dbWants.push({ name: tpl.conn.connect[0], engine, refVar: tpl.conn.connect[0], evidence: `${needs.manifestFile}: integrations.${engine}` });
      }
    }
    if (manifestWantsMail(manifest)) {
      wantsMail = {
        mode: manifestMailMode(manifest),
        mailbox: manifest.integrations?.mail?.mailbox ?? 'no-reply',
        evidence: `${needs.manifestFile}`,
      };
    }
  } else {
    // Sin manifiesto: las propuestas de la detección, las mismas que Variables.
    const advice = adviseNeeds(
      needs,
      {
        serviceName: service.slug,
        domains: target.domains,
        defined: new Set([...Object.keys(state.shared), ...Object.keys(state.env)]),
      },
      projectReferences(project.id, service.id || undefined),
    );
    for (const s of advice.suggestions) {
      if (s.template && s.refVar) {
        dbWants.push({ name: s.key, engine: s.template, refVar: s.refVar, evidence: s.reason });
      } else if (s.value) {
        harmless(s.key, 'self.public_url', s.value, s.value);
      }
    }
    for (const name of advice.missing) {
      addVar({ name, from: 'empty', resource: null, privileged: false, status: 'apply', detail: 'vacía, para rellenar', reason: null });
    }
    if (needs.mail) wantsMail = { mode: needs.mail.mode, mailbox: 'no-reply', evidence: needs.mail.evidence.join(' · ') };
  }

  // Bases de datos: una por motor, reutilizando la del proyecto si la hay.
  let pendingCreates = 0;
  for (const engine of [...new Set(dbWants.map((w) => w.engine))]) {
    const tpl = getTemplate(engine);
    if (!tpl) continue;
    const wants = dbWants.filter((w) => w.engine === engine);
    const existing = projectDatabase(project.id, engine);
    const providerName = existing?.name ?? tpl.label;
    const block = existing ? null : user ? dbCreateBlock(project, user, pendingCreates) : null;
    if (!existing && !block) pendingCreates++;
    let anyApply = false;
    for (const w of wants) {
      const value = `\${{${providerName}.${w.refVar}}}`;
      const current = state.env[w.name];
      let status: PlanStatus;
      let reason: string | null = null;
      if (current !== undefined && current !== '' && pointsToProjectDb(project.id, current, engine, w.refVar)) {
        status = 'done';
      } else if (writeDecision(state, w.name, existing ? value : null) === 'manual') {
        status = 'manual';
        reason = MANUAL;
      } else if (block) {
        status = 'blocked';
        reason = block;
      } else {
        status = 'apply';
        anyApply = true;
      }
      addVar({ name: w.name, from: `${engine}.${w.refVar}`, resource: engine, privileged: true, status, detail: value, reason });
    }
    // Bloqueado solo si queda algo por hacer: con todo conectado, da igual que ya no quepa otra base.
    const anyBlocked = plan.vars.some((v) => v.resource === engine && v.status === 'blocked');
    plan.resources.push({
      key: engine,
      label: tpl.label,
      action: existing ? 'reuse' : 'create',
      target: providerName,
      mode: null,
      status: anyBlocked ? 'blocked' : anyApply ? 'apply' : 'done',
      reason: anyBlocked ? block : null,
      evidence: wants[0].evidence,
      // La misma regla que crear la base a mano (POST …/services) o escribir la
      // referencia en Variables: acceso al proyecto, que ya exigen las rutas, y
      // el módulo y la cuota, que ya bloquean el recurso arriba.
      canApprove: !!user,
      confirmation: null,
    });
  }

  // Correo: los nombres los decide lo mismo que «Conectar a un servicio».
  if (wantsMail) {
    const mode = wantsMail.mode;
    // Los mismos nombres con los que «Conectar a un servicio» reconoce la credencial del servicio.
    const credNames = credentialNames(service, mode, mail?.link ?? null);
    const hadCredential = !!mail?.summary &&
      (mode === 'smtp'
        ? mail.summary.appPasswords.some((a) => !a.revokedAt && credNames.includes(a.name))
        : mail.summary.apiKeys.some((k) => !k.revokedAt && credNames.includes(k.name)));
    const known = knownMailValues(mail?.info ?? null, mode, mail?.mailbox?.email ?? null);
    // Mismos nombres y mismo usuario que escribirá `connectServiceMail`.
    const { names, user: mailUser, actualizarUsuario } = conexionPrevista({
      service,
      mode,
      known,
      mailbox: mail?.mailbox?.existing ?? null,
      email: mail?.mailbox?.email ?? null,
      summary: mail?.summary ?? null,
      hadCredential,
      link: mail?.link ?? null,
    });
    const blocked = mail && !mail.available ? mail.reason : null;
    // Lo que se sabe sin crear nada: si el remitente o el servidor han
    // cambiado (otro buzón en el manifiesto), lo escrito ya no vale.
    const expectedValue = (role: MailRole): string | null =>
      mailValue(role, { host: known.host, port: known.port, user: mailUser, password: null, from: known.from, apiUrl: known.apiUrl, apiKey: null });
    const valueStillGood = (role: MailRole, current: string | undefined): boolean => {
      const expected = expectedValue(role);
      if (expected === null || expected === current) return true;
      // Tras un cambio de dominio, el usuario del motor con el que ya está
      // conectado el servicio sigue valiendo: lo actualiza la baja del dominio
      // anterior, con sus variables y un despliegue.
      const login = mail?.mailbox?.existing?.login;
      return role === 'user' && !!login && login === current;
    };
    let anyApply = false;
    const all = [...names.targets.map((t) => ({ ...t, kept: false })), ...names.kept.map((n) => ({ name: n, role: null, kept: true }))];
    for (const t of all) {
      const managed = state.managed[t.name];
      const role = (t.role ?? (managed?.origin.split('.')[2] as MailRole | undefined) ?? null) as MailRole | null;
      let status: PlanStatus;
      let reason: string | null = null;
      if (t.kept) {
        status = 'manual';
        reason = MANUAL;
      } else if (
        role &&
        managed?.origin === mailOrigin(mode, role) &&
        managedUnchanged(state, t.name) &&
        valueStillGood(role, state.env[t.name])
      ) {
        status = 'done';
      } else if (blocked) {
        status = 'blocked';
        reason = blocked;
      } else {
        status = 'apply';
        anyApply = true;
      }
      addVar({
        name: t.name,
        from: role ? `mail.${role}` : 'mail',
        resource: 'mail',
        privileged: true,
        status,
        detail: role ? MAIL_ROLE_LABEL[role] : null,
        reason,
      });
    }
    const noSecret = names.secretRequested && !names.secretPlaced && anyApply;
    // Con el servidor (o el puerto, o el usuario) de otro proveedor puesto a
    // mano, la credencial de Mailway acabaría en ese tercero: tampoco se aplica.
    const partial = !noSecret && names.conflicts.length > 0 && anyApply;
    const anyBlocked = plan.vars.some((v) => v.resource === 'mail' && v.status === 'blocked');
    const existing = mail?.mailbox?.existing ?? null;
    // Un buzón que ya existe puede ser el de una persona: su contraseña de
    // aplicación abre todo su correo por IMAP. Si el servicio ya tiene una de
    // Skyway en ESE buzón, volver a conectarlo no da nada nuevo.
    const holdsCredential =
      !!existing && !!mail?.summary && mail.summary.appPasswords.some((a) => !a.revokedAt && credNames.includes(a.name) && a.mailboxId === existing.id);
    const status: PlanStatus = anyBlocked || noSecret || partial ? 'blocked' : anyApply ? 'apply' : 'done';
    plan.resources.push({
      key: 'mail',
      label: 'Correo',
      action: mail?.mailbox ? (existing ? 'reuse' : 'create') : null,
      target: mail?.mailbox?.email ?? `${wantsMail.mailbox}@…`,
      mode,
      status,
      reason: anyBlocked
        ? blocked
        : noSecret
          ? 'Las variables de la credencial tienen un valor puesto a mano: Skyway no las sobrescribe.'
          : partial
            ? partialConnectionMessage(names.conflicts)
            : null,
      evidence: wantsMail.evidence,
      canApprove: !!user && canManageProject(user, project),
      confirmation: confirmacionCorreo(status === 'apply' && mode === 'smtp' ? existing : null, {
        compartida: names.secretRequested && !holdsCredential,
        actualizaUsuario: actualizarUsuario,
      }),
    });
    // Sin sitio para la credencial, o con la conexión a medias, no hay nada que aprobar: se dice en el recurso.
    if (noSecret || partial) {
      for (const v of plan.vars) {
        if (v.resource === 'mail' && v.status === 'apply') {
          v.status = 'blocked';
          v.reason = noSecret ? 'La credencial no cabe en ninguna variable libre.' : 'La conexión quedaría a medias: revisa el motivo del correo.';
        }
      }
    }
  }

  plan.pendingApproval = plan.vars.filter((v) => v.privileged && v.status === 'apply').map((v) => v.name);
  const pendingResources = plan.resources.filter((r) => r.status === 'apply');
  plan.canApprove = !!user && pendingResources.every((r) => r.canApprove);
  plan.fingerprint = planFingerprint(plan);
  return plan;
}

/**
 * Lo que hay que confirmar antes de conectar por SMTP un buzón que ya existe:
 * que su contraseña de aplicación abre todo su correo y, tras un cambio de
 * dominio, que conectar cambia el usuario con el que entra la persona
 * (`conexionPrevista`): sus dispositivos configurados con el anterior dejan
 * de conectar hasta que los actualice. null si no hay nada que confirmar.
 */
function confirmacionCorreo(
  existing: MailwayMailbox | null,
  opts: { compartida: boolean; actualizaUsuario: boolean },
): string | null {
  if (!existing) return null;
  const partes: string[] = [];
  if (opts.compartida) {
    partes.push(
      `El buzón ${existing.email} ya existe: su contraseña de aplicación da acceso IMAP y SMTP a todo su correo, y la leerá ` +
        'cualquiera que vea las variables del servicio. Apruébalo solo si ese buzón es para los envíos de este servicio.',
    );
  }
  if (opts.actualizaUsuario && existing.login && existing.login !== existing.email) {
    partes.push(
      `${existing.email} todavía entra con ${existing.login}: al conectar pasará a entrar con ${existing.email}, y los dispositivos ` +
        `que sigan configurados con ${existing.login} dejarán de conectar hasta que se actualicen. La contraseña no cambia.`,
    );
  }
  return partes.length > 0 ? partes.join(' ') : null;
}

/**
 * Huella de lo privilegiado que se aplicaría: qué recursos (crear o reutilizar,
 * cuál, en qué modo, si piden confirmación) y qué variables con qué origen. Lo
 * inofensivo no entra: se aplica igual sin aprobación. Determinista para el
 * mismo estado, sea quien sea quien lo consulte.
 */
function planFingerprint(plan: IntegrationPlan): string {
  const resources = plan.resources
    .filter((r) => r.status === 'apply')
    .map((r) => [r.key, r.action, r.target, r.mode, r.confirmation !== null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const vars = plan.vars
    .filter((v) => v.privileged && v.status === 'apply')
    .map((v) => [v.name, v.from, v.resource])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return crypto.createHash('sha256').update(JSON.stringify({ resources, vars })).digest('hex').slice(0, 32);
}

/** Buzón que pide el plan (manifiesto o, por defecto, `no-reply`). */
export function planMailbox(needs: DetectedNeeds | null | undefined): string | null {
  if (!needs) return null;
  if (needs.manifestFile && !needs.manifest) return null;
  if (needs.manifest) return manifestWantsMail(needs.manifest) ? needs.manifest.integrations?.mail?.mailbox ?? 'no-reply' : null;
  return needs.mail ? 'no-reply' : null;
}

/**
 * Plan con el estado del correo consultado en Mailway (para enseñarlo o
 * aplicarlo). Los datos del servidor de envío (`withInfo`) se consultan si
 * quien mira puede aprobar el correo, tanto al enseñarlo como al aplicarlo:
 * con ellos se decide qué variables de correo se tocan, y la huella de lo
 * enseñado tiene que ser la de lo que se aplicará.
 */
export async function planWithMail(opts: {
  project: ProjectRow;
  user: UserRow;
  target: PlanTarget;
  needs: DetectedNeeds | null | undefined;
}): Promise<{ plan: IntegrationPlan; mail: MailContext | null }> {
  const mailbox = planMailbox(opts.needs);
  const withInfo = canManageProject(opts.user, opts.project);
  const mail = mailbox ? await mailContext(opts.project, opts.user, opts.target.domains, mailbox, withInfo) : null;
  return { plan: buildPlan({ ...opts, mail }), mail };
}

// ---------- aplicación ----------

export interface ApplyResult {
  /** Variables escritas. */
  applied: string[];
  /** Privilegiadas por aprobar (quien aplica no gestiona el proyecto, o se han omitido). */
  pending: string[];
  /** Puestas a mano, que no se tocan. */
  kept: string[];
  blocked: { name: string; reason: string }[];
  /** Recursos creados: servicios de base de datos y buzones. */
  created: string[];
  errors: string[];
}

function generatedSecret(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Crea una base de datos en el proyecto como «Nuevo servicio → Base de datos», con su primer despliegue. */
function createDatabaseService(projectId: string, engine: string): ServiceRow {
  const tpl = getTemplate(engine)!;
  const slug = uniqueServiceSlug(projectId, tpl.label);
  const cfg: DatabaseConfig = { template: tpl.key, version: tpl.defaultVersion };
  const db = createService(projectId, tpl.label, slug, 'database', cfg);
  setEnv(db.id, tpl.makeEnv(slug));
  markManualAction(db.id);
  triggerDeploy(db.id, 'initial');
  return db;
}

/** El plan recalculado no es el que se revisó: no se aplica nada (lo lanza `applyPlan` con `onMismatch: 'reject'`). */
export class PlanChangedError extends Error {
  readonly statusCode = 409;
  constructor(readonly plan: IntegrationPlan) {
    super(PLAN_CAMBIADO);
  }
}

export interface ApplyOptions {
  project: ProjectRow;
  user: UserRow;
  service: ServiceRow;
  skip?: ReadonlySet<string>;
  /**
   * Huella del plan que se ha revisado (`IntegrationPlan.fingerprint`). Sin
   * ella no se aprueba nada privilegiado: queda pendiente.
   */
  expect?: string;
  /** Confirmación expresa del acceso al buzón que se reutiliza (`PlanResource.confirmation`). */
  confirmMailboxAccess?: boolean;
  /**
   * Si la huella no coincide: `reject` lanza `PlanChangedError` sin aplicar
   * nada (la ruta de aplicar); `pending` aplica lo inofensivo y deja lo
   * privilegiado pendiente (el alta, donde el servicio ya existe).
   */
  onMismatch?: 'reject' | 'pending';
}

/**
 * Aplica el plan de un servicio existente con los permisos de `user`: lo
 * inofensivo siempre; lo privilegiado, si lo puede aprobar (`canApprove` de
 * cada recurso), coincide la huella revisada (`expect`) y no está en `skip`;
 * si no, queda pendiente. Lo que falla de un recurso (Mailway caído) no impide
 * aplicar el resto: se informa en `errors`. Recalcula `integrationsPending`
 * del servicio.
 */
export async function applyPlan(opts: ApplyOptions): Promise<{ result: ApplyResult; plan: IntegrationPlan }> {
  // Dos «Aplicar» seguidos crearían dos bases o dos credenciales.
  if (applying.has(opts.service.id)) throw httpError(409, 'Ya se está aplicando el plan de este servicio. Espera a que termine.');
  applying.add(opts.service.id);
  try {
    return await applyPlanLocked(opts);
  } finally {
    applying.delete(opts.service.id);
  }
}

const applying = new Set<string>();

async function applyPlanLocked(opts: ApplyOptions): Promise<{ result: ApplyResult; plan: IntegrationPlan }> {
  const { project, user } = opts;
  const skip = opts.skip ?? new Set<string>();
  const service = getService(opts.service.id) ?? opts.service;
  const cfg = service.config as GitConfig;
  const target: PlanTarget = { service, domains: cfg.domains ?? [] };
  // Antes de leer el resumen del correo con el plan: al conectar se sabrá si
  // entretanto otro ha cambiado las credenciales del servicio.
  const generation = mailCredentialGeneration(service.id);
  const { plan, mail } = await planWithMail({ project, user, target, needs: cfg.needs });
  const result: ApplyResult = { applied: [], pending: [], kept: [], blocked: [], created: [], errors: [] };
  // La aprobación vale para el plan revisado, no para el que haya ahora: entre
  // verlo y pulsar el botón, un push puede haber cambiado el manifiesto.
  const matches = opts.expect !== undefined && opts.expect === plan.fingerprint;
  if (opts.expect !== undefined && !matches) {
    if (opts.onMismatch !== 'pending') throw new PlanChangedError(plan);
    if (plan.pendingApproval.length > 0) {
      result.errors.push('El plan ha cambiado desde que lo revisaste: lo que requiere aprobación ha quedado pendiente. Revísalo en Variables → Integraciones.');
    }
  }
  const approved = (key: string) => matches && !skip.has(key) && !!plan.resources.find((r) => r.key === key)?.canApprove;

  // Lo inofensivo.
  const harmless: Record<string, { value: string; origin: string }> = {};
  for (const v of plan.vars) {
    if (v.privileged || v.status !== 'apply') continue;
    if (v.from === 'empty' && skip.has('empty')) continue;
    if (v.from === 'generate') {
      const bytes = Number(v.detail?.split(' ')[0]) || 32;
      harmless[v.name] = { value: generatedSecret(bytes), origin: 'generate' };
    } else if (v.from === 'empty') {
      harmless[v.name] = { value: '', origin: 'empty' };
    } else if (v.detail !== null) {
      harmless[v.name] = { value: v.detail, origin: v.from };
    }
  }
  writeManagedEnv(service.id, harmless);
  result.applied.push(...Object.keys(harmless));

  // Lo privilegiado: bases de datos.
  for (const res of plan.resources.filter((r) => r.key !== 'mail')) {
    const vars = plan.vars.filter((v) => v.resource === res.key && v.status === 'apply');
    if (vars.length === 0) continue;
    if (!approved(res.key)) {
      result.pending.push(...vars.map((v) => v.name));
      continue;
    }
    let providerName = res.target!;
    if (res.action === 'create') {
      // Se vuelve a comprobar justo antes: entre el plan y aquí puede haberse llenado la cuota.
      const block = dbCreateBlock(project, user, 0);
      if (block) {
        result.blocked.push(...vars.map((v) => ({ name: v.name, reason: block })));
        continue;
      }
      const db = createDatabaseService(project.id, res.key);
      providerName = db.name;
      result.created.push(db.name);
    }
    const entries: Record<string, { value: string; origin: string }> = {};
    for (const v of vars) {
      const refVar = v.from.split('.')[1];
      entries[v.name] = { value: `\${{${providerName}.${refVar}}}`, origin: v.from };
    }
    writeManagedEnv(service.id, entries);
    result.applied.push(...Object.keys(entries));
  }

  // Lo privilegiado: correo.
  const mailRes = plan.resources.find((r) => r.key === 'mail');
  const mailVars = plan.vars.filter((v) => v.resource === 'mail' && v.status === 'apply');
  if (mailRes && mailVars.length > 0 && mailRes.status === 'apply') {
    if (!approved('mail')) {
      result.pending.push(...mailVars.map((v) => v.name));
    } else if (mailRes.confirmation && !opts.confirmMailboxAccess) {
      result.pending.push(...mailVars.map((v) => v.name));
      result.errors.push(`Correo: no se ha conectado ${mailRes.target}. ${mailRes.confirmation} Confírmalo para aplicarlo.`);
    } else if (mail?.available && mail.link && mail.summary && mail.info && mail.mailbox && mailRes.mode) {
      const link = mail.link;
      const planned = mail.summary;
      const info = mail.info;
      const wanted = mail.mailbox;
      const mode = mailRes.mode;
      try {
        // Con el turno de las credenciales del servicio, como «Conectar a un servicio».
        const connected = await withMailCredentialLock(service.id, async () => {
          let mailbox = wanted.existing;
          if (!mailbox) {
            const created = await createMailbox({ domainId: wanted.domainId, localPart: wanted.email.split('@')[0] });
            mailbox = created.mailbox;
            result.created.push(mailbox.email);
          }
          // Si otro ha cambiado las credenciales desde que se leyó el plan (una
          // renovación automática, un «Conectar»), las que hay que revocar son
          // las de ahora.
          const summary = mailCredentialGeneration(service.id) === generation ? planned : await ownedSummary(project, link);
          return connectServiceMail({ project, link, summary, service, mailbox, mode, info });
        });
        result.applied.push(...connected.keys);
        result.kept.push(...connected.kept.filter((k) => !result.kept.includes(k)));
      } catch (err) {
        if (!(err instanceof MailwayError) && !(err as { statusCode?: unknown })?.statusCode) throw err;
        result.errors.push(`Correo: ${(err as Error).message}`);
        result.pending.push(...mailVars.map((v) => v.name));
      }
    }
  }

  for (const v of plan.vars) {
    if (v.status === 'manual' && !result.kept.includes(v.name)) result.kept.push(v.name);
    if (v.status === 'blocked' && v.reason) result.blocked.push({ name: v.name, reason: v.reason });
  }
  savePending(service.id, plan.source === 'manifest' ? result.pending : []);
  const fresh = getService(service.id) ?? service;
  const { plan: after } = await planWithMail({
    project,
    user,
    target: { service: fresh, domains: (fresh.config as GitConfig).domains ?? [] },
    needs: (fresh.config as GitConfig).needs,
  }).catch(() => ({ plan }));
  return { result, plan: after };
}

/** Guarda en la config del servicio lo pendiente de aprobar (releyendo la fila para no pisar otros ajustes). */
function savePending(serviceId: string, pending: string[]): void {
  const fresh = getService(serviceId);
  if (!fresh || fresh.type !== 'git') return;
  const cfg = { ...(fresh.config as GitConfig) };
  const before = JSON.stringify(cfg.integrationsPending ?? []);
  if (pending.length > 0) cfg.integrationsPending = [...new Set(pending)];
  else delete cfg.integrationsPending;
  if (JSON.stringify(cfg.integrationsPending ?? []) !== before) updateService(fresh.id, fresh.name, cfg);
}

/**
 * En cada despliegue, con el manifiesto recién leído: aplica lo inofensivo
 * nuevo (sin preguntar), anota como pendiente lo privilegiado que falte y lo
 * cuenta en el registro. El despliegue sigue con lo ya aprobado. Devuelve si
 * ha escrito variables (para recalcular el entorno del build).
 */
export function reconcileOnDeploy(service: ServiceRow, cfg: GitConfig, log: (line: string) => void): boolean {
  const needs = cfg.needs;
  const project = getProject(service.project_id);
  if (!project) return false;
  if (!needs?.manifestFile) {
    if (cfg.integrationsPending?.length) {
      delete cfg.integrationsPending;
      savePending(service.id, []);
    }
    return false;
  }
  if (!needs.manifest) {
    log(`⚠ ${needs.manifestError ?? `${needs.manifestFile} no es válido.`} No se aplica nada del manifiesto.`);
    return false;
  }
  const fresh = getService(service.id) ?? service;
  const plan = buildPlan({ project, user: null, target: { service: fresh, domains: cfg.domains ?? [] }, needs, mail: null });
  const harmless: Record<string, { value: string; origin: string }> = {};
  for (const v of plan.vars) {
    if (v.privileged || v.status !== 'apply') continue;
    if (v.from === 'generate') harmless[v.name] = { value: generatedSecret(Number(v.detail?.split(' ')[0]) || 32), origin: 'generate' };
    else if (v.from !== 'empty' && v.detail !== null) harmless[v.name] = { value: v.detail, origin: v.from };
  }
  writeManagedEnv(service.id, harmless);
  const nuevas = Object.keys(harmless);
  if (nuevas.length > 0) log(`Manifiesto ${needs.manifestFile}: se han definido ${nuevas.join(', ')} (los valores no se muestran).`);

  const pending = plan.pendingApproval;
  if (pending.length > 0) {
    const recursos = plan.resources.filter((r) => r.status === 'apply').map((r) => r.label);
    log(
      `⚠ ${needs.manifestFile} pide cambios que requieren aprobación (${recursos.join(', ')}: ${pending.join(', ')}). ` +
        'El despliegue continúa con lo ya aprobado. Apruébalos en Variables → Integraciones: las bases de datos, cualquiera con ' +
        'acceso al proyecto; el correo, quien gestiona el proyecto.',
    );
  }
  cfg.integrationsPending = pending.length > 0 ? pending : undefined;
  if (!cfg.integrationsPending) delete cfg.integrationsPending;
  savePending(service.id, pending);
  return nuevas.length > 0;
}

/**
 * Alta de un servicio desde un repositorio con «aplicar el plan»: lee de
 * GitHub (con la credencial con la que se clonará) el manifiesto y las
 * dependencias, los deja en la config del servicio y aplica el plan con los
 * permisos de quien crea el servicio. Se llama ANTES del primer despliegue,
 * para que nazca con sus variables. Nunca lanza: el servicio ya existe y un
 * GitHub o un Mailway caídos no pueden dejarlo a medias; se informa en `error`.
 */
export async function applyPlanFromRepo(
  opts: Omit<ApplyOptions, 'onMismatch'>,
): Promise<{ result: ApplyResult | null; plan: IntegrationPlan | null; error: string | null }> {
  const cfg = opts.service.config as GitConfig;
  const slug = parseGithubSlug(cfg.repoUrl);
  if (!slug) return { result: null, plan: null, error: 'El plan de integraciones solo está disponible para repositorios de GitHub.' };
  try {
    const token = await resolveGitToken(opts.project, cfg);
    const needs = await detectNeedsFromGithub(token, slug.owner, slug.repo, cfg.branch || 'main', cfg.rootDir);
    const fresh = getService(opts.service.id) ?? opts.service;
    const freshCfg = { ...(fresh.config as GitConfig) };
    if (needs) freshCfg.needs = needs;
    else delete freshCfg.needs;
    updateService(fresh.id, fresh.name, freshCfg);
    // El repositorio se vuelve a leer ahora: si no es lo que el asistente
    // enseñó (`expect`), lo privilegiado queda pendiente en vez de aprobarse.
    const { result, plan } = await applyPlan({ ...opts, service: { ...fresh, config: freshCfg }, onMismatch: 'pending' });
    return { result, plan, error: null };
  } catch (err) {
    return { result: null, plan: null, error: `No se ha podido aplicar el plan: ${(err as Error)?.message || err}` };
  }
}
