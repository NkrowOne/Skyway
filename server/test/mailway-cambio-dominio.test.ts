/**
 * Correo del cambio de dominio en Skyway: el cliente de la API de Mailway 1.3
 * (`/api/domain-migrations` y `login-update`) contra el doble en memoria
 * (`mailwayfake.ts`), la conexión de un servicio con el usuario del motor
 * (`SMTP_USER` = login, `SMTP_FROM` = dirección), el refresco de las
 * variables de correo tras pasar y la elección del dominio de correo del plan
 * de integraciones, que ignora el dominio anterior.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeDb,
  createProject,
  createService,
  createUser,
  getEnv,
  getManagedEnv,
  getService,
  initDb,
  insertMailwayLink,
  patchEnv,
  setSetting,
  writeManagedEnv,
} from '../src/db';
import { mailContext, planWithMail } from '../src/integrations';
import { conexionPrevista, connectServiceMail, refrescarVariablesCorreo } from '../src/mailconnect';
import {
  MAILWAY_SETTING,
  MailwayError,
  cancelDomainMigration,
  checkDomainMigration,
  createDomainMigration,
  getDomainMigration,
  getInfo,
  getSummary,
  planDomainMigration,
  projectExternalRef,
  resetMailwayCaches,
  retireDomainMigration,
  rollbackDomainMigration,
  switchDomainMigration,
  updateMailboxLogin,
} from '../src/mailway';
import type { GitConfig, MailwayLinkRow, ProjectRow, UserRow } from '../src/types';
import { hashPassword } from '../src/util';
import { FakeMailbox, MW_BASE, MW_TOKEN, fakeFetch, marcarListo, mw } from './mailwayfake';

let proj: ProjectRow;
let link: MailwayLinkRow;
let admin: UserRow;
let clientId = '';
let fromId = '';
const plazos: number[] = [];

function gitCfg(domains: string[], expectedVars: string[] = []): GitConfig {
  return {
    repoUrl: 'https://github.com/x/y',
    branch: 'main',
    port: 3000,
    domains,
    webhookSecret: 'w',
    needs: { engines: [], expectedVars, envFile: '.env.example', sources: [], detectedAt: 1 },
  } as GitConfig;
}

function buzon(localPart: string, domainId: string, domain: string, extra: Partial<FakeMailbox> = {}): FakeMailbox {
  const box: FakeMailbox = {
    id: `mbx_${localPart}_${domain}`,
    domainId,
    domain,
    localPart,
    email: `${localPart}@${domain}`,
    displayName: '',
    quotaMb: 1024,
    status: 'active',
    usedBytes: null,
    ...extra,
  };
  mw.mailboxes.push(box);
  return box;
}

function appSkyway(mailboxId: string, name: string) {
  const box = mw.mailboxes.find((b) => b.id === mailboxId)!;
  mw.appPasswords.push({ id: `app_${name}_${mailboxId}`, mailboxId, email: box.email, name, revokedAt: null, createdAt: 1 });
}

const llamadas = (re: RegExp) => mw.calls.filter((c) => re.test(c.path));

beforeAll(() => {
  initDb();
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  // Para comprobar el plazo de cada petición sin esperarlo.
  const original = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    plazos.push(ms);
    return original(ms);
  });
  setSetting(MAILWAY_SETTING.baseUrl, MW_BASE);
  setSetting(MAILWAY_SETTING.token, MW_TOKEN);
  resetMailwayCaches();
  admin = createUser('admin@example.com', hashPassword('contraseña1'), 'admin', null);
  proj = createProject('Tienda', 'tienda', null, null);
  clientId = 'cli_tienda';
  mw.clients.push({ id: clientId, name: 'Tienda', slug: 'tienda', externalRef: projectExternalRef(proj.id), suspended: false, planId: 'pln_2' });
  link = insertMailwayLink({ project_id: proj.id, client_id: clientId, client_name: 'Tienda', created_by: null });
  fromId = 'dom_viejo';
  mw.domains.push({ id: fromId, clientId, domain: 'dominio.es', status: 'active', ownershipVerifiedAt: 1 });
  buzon('tienda', fromId, 'dominio.es');
  buzon('ana', fromId, 'dominio.es');
  mw.aliases.push({ id: 'ali_info', domainId: fromId, localPart: 'info', email: 'info@dominio.es' });
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  closeDb();
});

beforeEach(() => {
  mw.calls = [];
  plazos.length = 0;
});

describe('cliente de la API de cambio de dominio', () => {
  let mid = '';

  it('la instancia declara la función', async () => {
    const info = await getInfo({ fresh: true });
    expect(info.features?.domainMigrations).toBe(true);
  });

  it('plan: sin efectos, con soloCliente y los bloqueos de Mailway', async () => {
    const plan = await planDomainMigration(fromId, 'Dominio2.es', { soloCliente: true });
    const [call] = llamadas(/^\/api\/domain-migrations\/plan/);
    expect(call).toMatchObject({ method: 'POST', path: '/api/domain-migrations/plan?soloCliente=1', auth: `Bearer ${MW_TOKEN}` });
    expect(call.body).toEqual({ fromDomainId: fromId, toDomain: 'Dominio2.es' });
    expect(plan.desde).toEqual({ domainId: fromId, domain: 'dominio.es' });
    expect(plan.hacia).toEqual({ domain: 'dominio2.es', existe: false, domainId: null });
    expect(plan.buzones.map((b) => [b.de, b.a])).toEqual([
      ['tienda@dominio.es', 'tienda@dominio2.es'],
      ['ana@dominio.es', 'ana@dominio2.es'],
    ]);
    expect(plan.alias).toEqual([{ id: 'ali_info', de: 'info@dominio.es', a: 'info@dominio2.es' }]);
    expect(plan.bloqueos).toEqual([]);
    expect(mw.migraciones).toHaveLength(0);

    const mismo = await planDomainMigration(fromId, 'dominio.es');
    expect(llamadas(/^\/api\/domain-migrations\/plan/)[1].path).toBe('/api/domain-migrations/plan');
    expect(mismo.bloqueos.map((b) => b.code)).toEqual(['migration_same_domain']);
  });

  it('crear: origen Skyway, DNS automático y referencia; idempotente', async () => {
    mw.autoDnsConAutoconfig = true;
    const vista = await createDomainMigration({ fromDomainId: fromId, toDomain: 'dominio2.es', referenciaExterna: projectExternalRef(proj.id) }, { soloCliente: true });
    mw.autoDnsConAutoconfig = false;
    const [call] = llamadas(/^\/api\/domain-migrations/);
    expect(call.path).toBe('/api/domain-migrations?soloCliente=1');
    expect(call.body).toEqual({
      fromDomainId: fromId,
      toDomain: 'dominio2.es',
      autoDns: true,
      origen: 'skyway',
      referenciaExterna: projectExternalRef(proj.id),
    });
    expect(plazos).toEqual([60_000]);
    expect(vista).toMatchObject({
      clientId,
      origen: 'skyway',
      estado: 'preparando',
      desde: { domainId: fromId, domain: 'dominio.es' },
      hacia: { domain: 'dominio2.es' },
      puedePasar: false,
      puedeCancelar: true,
      buzones: { total: 2, pendientes: 0 },
      alias: { total: 1 },
      nombresCloudflare: ['autoconfig.dominio2.es', 'autodiscover.dominio2.es'],
    });
    mid = vista.id;
    // Skyway reintenta: el mismo cambio, sin abrir otro.
    const otra = await createDomainMigration({ fromDomainId: fromId, toDomain: 'dominio2.es', referenciaExterna: projectExternalRef(proj.id) });
    expect(otra.id).toBe(mid);
    expect(mw.migraciones).toHaveLength(1);
    // Con otro destino, el origen ya está en un cambio abierto.
    const err = await createDomainMigration({ fromDomainId: fromId, toDomain: 'dominio3.es', referenciaExterna: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(MailwayError);
    expect(err).toMatchObject({ status: 409, code: 'migration_exists', message: 'dominio.es ya está en un cambio de dominio abierto.' });
  });

  it('el resumen marca los dominios del cambio y trae el usuario de cada buzón', async () => {
    const summary = await getSummary(clientId);
    const viejo = summary.domains.find((d) => d.domain === 'dominio.es')!;
    const destino = summary.domains.find((d) => d.domain === 'dominio2.es')!;
    expect(viejo.migracion).toEqual({ id: mid, rol: 'origen', estado: 'preparando', pareja: 'dominio2.es', cuentaEnPlan: false });
    expect(destino.migracion).toMatchObject({ rol: 'destino', pareja: 'dominio.es', cuentaEnPlan: true });
    const tienda = summary.mailboxes.find((b) => b.localPart === 'tienda')!;
    expect(tienda).toMatchObject({ email: 'tienda@dominio.es', login: 'tienda@dominio.es', loginPending: false });
  });

  it('comprobar avanza a «listo» cuando las compuertas están bien', async () => {
    expect((await checkDomainMigration(mid)).estado).toBe('preparando');
    marcarListo(mid);
    const vista = await checkDomainMigration(mid);
    expect(vista).toMatchObject({ estado: 'listo', recepcionPreparada: true, puedePasar: true });
    expect(llamadas(/\/check$/).every((c) => c.method === 'POST')).toBe(true);
    expect((await getDomainMigration(mid)).estado).toBe('listo');
  });

  it('pasar, volver y pasar otra vez, con el plazo largo', async () => {
    const pasado = await switchDomainMigration(mid);
    expect(pasado).toMatchObject({ estado: 'pasado', puedeVolver: true, puedeDarDeBaja: true, buzones: { pendientes: 2 } });
    expect(plazos).toEqual([120_000]);
    let summary = await getSummary(clientId);
    expect(summary.mailboxes.find((b) => b.localPart === 'tienda')).toMatchObject({
      email: 'tienda@dominio2.es',
      login: 'tienda@dominio.es',
      loginPending: true,
    });

    const vuelta = await rollbackDomainMigration(mid);
    expect(vuelta.estado).toBe('listo');
    summary = await getSummary(clientId);
    expect(summary.mailboxes.find((b) => b.localPart === 'tienda')).toMatchObject({ email: 'tienda@dominio.es', loginPending: false });

    expect((await switchDomainMigration(mid)).estado).toBe('pasado');
    const [call] = llamadas(/\/switch$/).slice(-1);
    expect(call).toMatchObject({ method: 'POST', body: {} });
  });

  it('dar de baja exige escribir el dominio anterior', async () => {
    const err = await retireDomainMigration(mid, 'otro.es').catch((e) => e);
    expect(err).toBeInstanceOf(MailwayError);
    expect(err).toMatchObject({ status: 400, code: 'confirm_mismatch' });
    expect(llamadas(/\/retire$/)[0].body).toEqual({ confirm: 'otro.es' });
  });

  it('actualizar el usuario de un buzón (idempotente)', async () => {
    const ana = mw.mailboxes.find((b) => b.localPart === 'ana')!;
    const { mailbox } = await updateMailboxLogin(ana.id);
    expect(mailbox).toMatchObject({ email: 'ana@dominio2.es', login: 'ana@dominio2.es', loginPending: false });
    expect(llamadas(/login-update$/)[0]).toMatchObject({ method: 'POST', path: `/api/mailboxes/${ana.id}/login-update`, body: {} });
    expect((await updateMailboxLogin(ana.id)).mailbox.loginPending).toBe(false);
  });

  it('cancelar un cambio sin pasar elimina el destino que creó', async () => {
    mw.domains.push({ id: 'dom_blog', clientId, domain: 'blog.es', status: 'active', ownershipVerifiedAt: 1 });
    const v = await createDomainMigration({ fromDomainId: 'dom_blog', toDomain: 'blog2.es', referenciaExterna: 'r' });
    const cancelada = await cancelDomainMigration(v.id);
    expect(cancelada.estado).toBe('cancelada');
    expect(plazos.slice(-1)).toEqual([120_000]);
    expect(mw.domains.some((d) => d.domain === 'blog2.es')).toBe(false);
    // En un estado que no lo admite: el error de Mailway, tal cual.
    const err = await cancelDomainMigration(v.id).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'migration_state' });
  });

  it('un Mailway anterior a la 1.3 no tiene las rutas', async () => {
    mw.cambiosDeDominio = false;
    try {
      const err = await planDomainMigration(fromId, 'dominio9.es').catch((e) => e);
      expect(err).toBeInstanceOf(MailwayError);
      expect(err.status).toBe(404);
      const summary = await getSummary(clientId);
      expect(summary.mailboxes[0].login).toBeUndefined();
      expect('migracion' in summary.domains[0]).toBe(false);
    } finally {
      mw.cambiosDeDominio = true;
    }
  });

  it('una respuesta sin el cambio no se da por buena', async () => {
    mw.fallosCambio.set('get', { status: 200, error: '', code: '' });
    const err = await getDomainMigration('lo-que-sea').catch((e) => e);
    expect(err).toBeInstanceOf(MailwayError);
    expect(err.message).toContain('falta el cambio de dominio');
  });
});

describe('conectar un servicio con el usuario del motor', () => {
  const info = () => getInfo();
  const smtpVars = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_URL'];

  it('un buzón que otra aplicación de Skyway usa: SMTP_USER = login viejo y SMTP_FROM = dirección nueva, sin actualizarlo', async () => {
    const tienda = mw.mailboxes.find((b) => b.localPart === 'tienda')!;
    expect(tienda.usuarioMotor).toBe('tienda@dominio.es');
    appSkyway(tienda.id, 'skyway:otra-web');
    const service = createService(proj.id, 'Web', 'web', 'git', gitCfg(['www.dominio2.es'], smtpVars));
    const summary = await getSummary(clientId);
    const mailbox = summary.mailboxes.find((b) => b.id === tienda.id)!;
    const res = await connectServiceMail({ project: proj, link, summary, service, mailbox, mode: 'smtp', info: await info() });
    expect(res.keys.sort()).toEqual(['SMTP_FROM', 'SMTP_HOST', 'SMTP_PASS', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_URL', 'SMTP_USER']);
    const env = getEnv(service.id);
    expect(env.SMTP_USER).toBe('tienda@dominio.es');
    expect(env.SMTP_FROM).toBe('tienda@dominio2.es');
    expect(env.SMTP_URL).toMatch(/^smtp:\/\/tienda%40dominio\.es:[^@]+@mail\.example\.com:587$/);
    expect(llamadas(/login-update$/)).toEqual([]);
    expect(tienda.usuarioMotor).toBe('tienda@dominio.es');
    expect(getManagedEnv(service.id).SMTP_USER.origin).toBe('mail.smtp.user');
  });

  it('un buzón pendiente sin otras aplicaciones se actualiza ANTES de crear la credencial', async () => {
    const destino = mw.domains.find((d) => d.domain === 'dominio2.es')!;
    const pepe = buzon('pepe', destino.id, 'dominio2.es', { usuarioMotor: 'pepe@dominio.es' });
    const service = createService(proj.id, 'Tienda', 'tienda-web', 'git', gitCfg(['www.dominio2.es']));
    const summary = await getSummary(clientId);
    const mailbox = summary.mailboxes.find((b) => b.id === pepe.id)!;
    expect(mailbox.loginPending).toBe(true);
    expect(conexionPrevista({ service, mode: 'smtp', known: { host: 'h', port: 587, apiUrl: null }, mailbox, summary, hadCredential: false })).toMatchObject({
      user: 'pepe@dominio2.es',
      actualizarUsuario: true,
    });
    await connectServiceMail({ project: proj, link, summary, service, mailbox, mode: 'smtp', info: await info() });
    const orden = mw.calls.map((c) => c.path).filter((p) => p.includes(pepe.id));
    expect(orden).toEqual([`/api/mailboxes/${pepe.id}/login-update`, `/api/mailboxes/${pepe.id}/app-passwords`]);
    const env = getEnv(service.id);
    expect(env.SMTP_USER).toBe('pepe@dominio2.es');
    expect(env.SMTP_FROM).toBe('pepe@dominio2.es');
    expect(pepe.usuarioMotor).toBeNull();
  });

  it('si Mailway no deja actualizar el usuario, no se revoca ni se crea nada', async () => {
    const lola = buzon('lola', mw.domains.find((d) => d.domain === 'dominio2.es')!.id, 'dominio2.es', { usuarioMotor: 'lola@dominio.es' });
    const service = createService(proj.id, 'Otra', 'otra', 'git', gitCfg(['otra.dominio2.es']));
    const summary = await getSummary(clientId);
    const mailbox = summary.mailboxes.find((b) => b.id === lola.id)!;
    mw.fallosCambio.set('login-update', {
      status: 409,
      error: 'Se está actualizando el usuario de este buzón. Vuelve a intentarlo en unos minutos.',
      code: 'mailbox_login_updating',
    });
    const err = await connectServiceMail({ project: proj, link, summary, service, mailbox, mode: 'smtp', info: await info() }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'mailbox_login_updating' });
    expect(llamadas(/app-passwords/).filter((c) => c.path.includes(lola.id))).toEqual([]);
    expect(getEnv(service.id)).toEqual({});
  });

  it('en modo API el remitente es la dirección y no se toca el usuario', async () => {
    const tienda = mw.mailboxes.find((b) => b.localPart === 'tienda')!;
    const service = createService(proj.id, 'API', 'api', 'git', gitCfg(['api.dominio2.es']));
    const summary = await getSummary(clientId);
    const mailbox = summary.mailboxes.find((b) => b.id === tienda.id)!;
    await connectServiceMail({ project: proj, link, summary, service, mailbox, mode: 'api', info: await info() });
    expect(getEnv(service.id).MAIL_FROM).toBe('tienda@dominio2.es');
    expect(llamadas(/login-update$/)).toEqual([]);
  });

  it('un buzón al día (o de un Mailway anterior): usuario y remitente son la dirección', async () => {
    const ana = mw.mailboxes.find((b) => b.localPart === 'ana')!;
    const service = createService(proj.id, 'Blog', 'blog', 'git', gitCfg(['blog.dominio2.es']));
    const summary = await getSummary(clientId);
    const { login, loginPending, ...antiguo } = summary.mailboxes.find((b) => b.id === ana.id)!;
    expect([login, loginPending]).toEqual(['ana@dominio2.es', false]);
    await connectServiceMail({ project: proj, link, summary, service, mailbox: antiguo, mode: 'smtp', info: await info() });
    expect(getEnv(service.id)).toMatchObject({ SMTP_USER: 'ana@dominio2.es', SMTP_FROM: 'ana@dominio2.es' });
  });
});

describe('refrescarVariablesCorreo', () => {
  it('solo toca lo que Skyway escribió y nadie ha cambiado, y reconstruye la URL con el mismo secreto', () => {
    const service = createService(proj.id, 'Refresco', 'refresco', 'git', gitCfg(['r.dominio2.es']));
    const url = 'smtp://tienda%40dominio.es:Cl%2Fave%3A%40x@mail.example.com:587';
    writeManagedEnv(service.id, {
      SMTP_FROM: { value: 'tienda@dominio.es', origin: 'mail.smtp.from' },
      MAIL_FROM: { value: 'Tienda@Dominio.es', origin: 'mail.api.from' },
      SMTP_USER: { value: 'tienda@dominio.es', origin: 'mail.smtp.user' },
      SMTP_URL: { value: url, origin: 'mail.smtp.url' },
      // Gestionada, pero no de correo: no es cosa de este refresco.
      CONTACTO: { value: 'tienda@dominio.es', origin: 'value' },
      // Gestionada y cambiada a mano después: no se pisa.
      EMAIL_FROM: { value: 'tienda@dominio.es', origin: 'mail.smtp.from' },
    });
    patchEnv(service.id, { EMAIL_FROM: 'tienda@dominio.es ', MANUAL_FROM: 'tienda@dominio.es' }, []);
    const revAntes = getService(service.id)?.config_rev;

    const remitentes = new Map([['TIENDA@dominio.es', 'tienda@dominio2.es']]);
    expect(refrescarVariablesCorreo(service.id, { remitentes })).toEqual(['MAIL_FROM', 'SMTP_FROM']);
    let env = getEnv(service.id);
    expect(env).toMatchObject({
      SMTP_FROM: 'tienda@dominio2.es',
      MAIL_FROM: 'tienda@dominio2.es',
      SMTP_USER: 'tienda@dominio.es',
      SMTP_URL: url,
      CONTACTO: 'tienda@dominio.es',
      EMAIL_FROM: 'tienda@dominio.es ',
      MANUAL_FROM: 'tienda@dominio.es',
    });
    // Conserva el origen y sigue siendo «de Skyway» (el hash es el del valor nuevo).
    expect(getManagedEnv(service.id).SMTP_FROM.origin).toBe('mail.smtp.from');
    expect(getManagedEnv(service.id).MAIL_FROM.origin).toBe('mail.api.from');

    const usuarios = new Map([['tienda@dominio.es', 'tienda@dominio2.es']]);
    expect(refrescarVariablesCorreo(service.id, { usuarios })).toEqual(['SMTP_URL', 'SMTP_USER']);
    env = getEnv(service.id);
    expect(env.SMTP_USER).toBe('tienda@dominio2.es');
    expect(env.SMTP_URL).toBe('smtp://tienda%40dominio2.es:Cl%2Fave%3A%40x@mail.example.com:587');
    expect(getManagedEnv(service.id).SMTP_URL.origin).toBe('mail.smtp.url');

    // El inverso (Volver) deja el remitente como estaba; repetirlo no cambia nada más.
    expect(refrescarVariablesCorreo(service.id, { remitentes: new Map([['tienda@dominio2.es', 'tienda@dominio.es']]) })).toEqual([
      'MAIL_FROM',
      'SMTP_FROM',
    ]);
    expect(getEnv(service.id).SMTP_FROM).toBe('tienda@dominio.es');
    expect(refrescarVariablesCorreo(service.id, { remitentes: new Map([['tienda@dominio2.es', 'tienda@dominio.es']]) })).toEqual([]);
    // No sube la revisión: quien llama decide cuándo desplegar.
    expect(getService(service.id)?.config_rev).toBe(revAntes);
  });

  it('sin mapas o con un servicio que no existe, no hace nada', () => {
    expect(refrescarVariablesCorreo('svc_inexistente', { remitentes: new Map([['a@b.es', 'a@c.es']]) })).toEqual([]);
    const service = createService(proj.id, 'Vacío', 'vacio', 'git', gitCfg([]));
    expect(refrescarVariablesCorreo(service.id, {})).toEqual([]);
  });

  it('una URL sin usuario reconocible se deja como está', () => {
    const service = createService(proj.id, 'URL rara', 'url-rara', 'git', gitCfg([]));
    writeManagedEnv(service.id, { SMTP_URL: { value: 'smtps://mail.example.com:465', origin: 'mail.smtp.url' } });
    expect(refrescarVariablesCorreo(service.id, { usuarios: new Map([['tienda@dominio.es', 'x@y.es']]) })).toEqual([]);
  });
});

describe('dominio de correo del plan de integraciones', () => {
  it('después de pasar, ignora el dominio anterior aunque la web siga sirviendo sus nombres', async () => {
    const ctx = await mailContext(proj, admin, ['www.dominio.es'], 'avisos', false);
    expect(ctx.available).toBe(true);
    expect(ctx.mailbox?.email).toBe('avisos@dominio2.es');
  });

  it('un servicio conectado con el usuario anterior no aparece como pendiente: lo actualiza la baja', async () => {
    const destino = mw.domains.find((d) => d.domain === 'dominio2.es')!;
    const noReply = buzon('no-reply', destino.id, 'dominio2.es', { usuarioMotor: 'no-reply@dominio.es' });
    // Otra aplicación lo usa: conectar no cambia el usuario.
    appSkyway(noReply.id, 'skyway:vecina');
    const needs = {
      engines: [],
      expectedVars: [],
      envFile: null,
      sources: [],
      mail: { mode: 'smtp' as const, vars: [], evidence: ['package.json: nodemailer'] },
      detectedAt: 1,
    };
    const service = createService(proj.id, 'Avisos', 'avisos', 'git', { ...gitCfg(['avisos.dominio2.es']), needs });
    const summary = await getSummary(clientId);
    const mailbox = summary.mailboxes.find((b) => b.id === noReply.id)!;
    await connectServiceMail({ project: proj, link, summary, service, mailbox, mode: 'smtp', info: await getInfo() });
    expect(getEnv(service.id).SMTP_USER).toBe('no-reply@dominio.es');
    // La vecina se va: ya nada impediría actualizarlo, pero lo escrito sigue valiendo.
    mw.appPasswords.find((a) => a.name === 'skyway:vecina')!.revokedAt = Date.now();
    const { plan } = await planWithMail({ project: proj, user: admin, target: { service: getService(service.id)!, domains: ['avisos.dominio2.es'] }, needs });
    const correo = plan.resources.find((r) => r.key === 'mail');
    expect(correo?.status).toBe('done');
    expect(plan.vars.find((v) => v.name === 'SMTP_USER')?.status).toBe('done');
  });

  it('antes de pasar, el dominio nuevo todavía no admite buzones: lo dice el plan', async () => {
    const p2 = createProject('Blog', 'blog', null, null);
    mw.clients.push({ id: 'cli_blog', name: 'Blog', slug: 'blog', externalRef: projectExternalRef(p2.id), suspended: false, planId: 'pln_2' });
    insertMailwayLink({ project_id: p2.id, client_id: 'cli_blog', client_name: 'Blog', created_by: null });
    mw.domains.push({ id: 'dom_b1', clientId: 'cli_blog', domain: 'viejo.es', status: 'active', ownershipVerifiedAt: 1 });
    buzon('hola', 'dom_b1', 'viejo.es');
    const v = await createDomainMigration({ fromDomainId: 'dom_b1', toDomain: 'nuevo.es', referenciaExterna: projectExternalRef(p2.id) });
    marcarListo(v.id);
    await checkDomainMigration(v.id);

    const ctx = await mailContext(p2, admin, ['www.viejo.es'], 'avisos', false);
    expect(ctx.available).toBe(false);
    expect(ctx.reason).toBe('nuevo.es se está preparando para sustituir a viejo.es: el buzón se podrá crear en cuanto pases a él.');

    // Sin cambio de dominio, el dominio que casa con la web sigue siendo el elegido.
    await cancelDomainMigration(v.id);
    const sin = await mailContext(p2, admin, ['www.viejo.es'], 'hola', false);
    expect(sin.mailbox).toMatchObject({ email: 'hola@viejo.es', domainId: 'dom_b1' });
    expect(sin.mailbox?.existing?.id).toBe('mbx_hola_viejo.es');
  });
});
