/**
 * Renovación automática de las contraseñas de aplicación que Mailway invalida
 * al cambiar de motor (Stalwart 0.15 → 0.16): los servicios conectados por
 * SMTP reciben una nueva para el mismo buzón, se vuelven a desplegar y la
 * invalidada se revoca, en ese orden. Mismo doble de Mailway que el resto de
 * pruebas de la integración (`mailwayfake.ts`). Sin Docker: el despliegue se
 * sustituye por la creación de su fila salvo en la prueba del despliegue
 * fallido, que usa el de verdad con un servicio de imagen y se detiene al
 * preparar la red (como en `redespliegue.test.ts`).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  realTriggerDeploy: null as null | typeof import('../src/deploy/deployer').triggerDeploy,
}));

vi.mock('../src/docker/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/docker/client')>();
  return { ...mod, dockerAvailable: vi.fn(async () => true) };
});
vi.mock('../src/docker/containers', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/docker/containers')>();
  return { ...mod, imageExists: vi.fn(async () => true) };
});
vi.mock('../src/docker/networks', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/docker/networks')>();
  return {
    ...mod,
    ensureNetwork: vi.fn(async () => {
      throw new Error('Sin Docker en las pruebas');
    }),
  };
});
vi.mock('../src/deploy/deployer', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/deploy/deployer')>();
  mocks.realTriggerDeploy = mod.triggerDeploy;
  return { ...mod, triggerDeploy: vi.fn(mod.triggerDeploy) };
});

import { buildApp } from '../src/app';
import { API_TOKEN_PREFIX, hashApiToken } from '../src/auth';
import {
  closeDb,
  createDeployment,
  createProject,
  createService,
  createUser,
  createWorkspaceRow,
  deleteService,
  getEnv,
  getMailwayLink,
  getMailwayRenovacion,
  getManagedEnv,
  initDb,
  insertApiToken,
  listAlerts,
  listAudit,
  listServices,
  setEnv,
  setServiceStopped,
  setSetting,
  setUserProjects,
  updateDeployment,
} from '../src/db';
import { awaitDeployment, triggerDeploy } from '../src/deploy/deployer';
import { connectServiceMail, ownedSummary, withMailCredentialLock } from '../src/mailconnect';
import { getInfo, resetMailwayCaches } from '../src/mailway';
import { renovarContrasenasInvalidadas } from '../src/mailwayrenovacion';
import type { ImageConfig, ProjectRow, ServiceRow, UserRow } from '../src/types';
import { hashPassword, randomToken, slugify } from '../src/util';
import { FakeAppPassword, MW_BASE, MW_TOKEN, cambiarDeMotor, fakeFetch, mw } from './mailwayfake';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const AVISOS = 'https://avisos.example.com/skyway';

let app: FastifyInstance;
let adminCookie = '';
const admin = () => ({ cookie: adminCookie, ...SAME_ORIGIN });
let ownerHeaders: Record<string, string>;
let memberHeaders: Record<string, string>;

/** Proyectos de la cuenta «Tienda S.L.» (comparten cliente de Mailway) y uno de otra cuenta. */
let tienda: ProjectRow;
let blog: ProjectRow;
let otra: ProjectRow;
let buzonTienda = '';
let buzonOtra = '';

/** Lo que reciben los canales de alertas (un webhook). */
let avisos: { title: string; message: string; severity: string }[] = [];
/** Lo que la pasada registra (en producción, el log del planificador). */
let registro: string[] = [];

function bearerFor(user: UserRow): Record<string, string> {
  const secret = `${API_TOKEN_PREFIX}${randomToken(24)}`;
  insertApiToken({ user_id: user.id, name: 'pruebas', token_hash: hashApiToken(secret), prefix: secret.slice(0, 12), expires_at: null });
  return { authorization: `Bearer ${secret}` };
}

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, body?: unknown) {
  const r = await app.inject({
    method,
    url,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: Json = null;
  try {
    parsed = r.json();
  } catch {
    /* sin JSON */
  }
  return { status: r.statusCode, json: parsed, raw: r.body };
}

/** Correo activado, un dominio y un buzón: devuelve el id del buzón. */
async function activarCorreo(project: ProjectRow, dominio: string, localPart: string): Promise<string> {
  let r = await call('POST', `/api/projects/${project.id}/mail/link`, admin(), { mode: 'create' });
  expect(r.status, r.raw).toBe(201);
  r = await call('POST', `/api/projects/${project.id}/mail/domains`, admin(), { domain: dominio });
  expect(r.status, r.raw).toBe(201);
  r = await call('POST', `/api/projects/${project.id}/mail/mailboxes`, admin(), { domainId: r.json.domain.id, localPart });
  expect(r.status, r.raw).toBe(201);
  return r.json.mailbox.id;
}

/** Servicio de imagen (el despliegue de verdad no necesita clonar nada). */
function servicio(project: ProjectRow, nombre: string): ServiceRow {
  return createService(project.id, nombre, slugify(nombre), 'image', { image: 'nginx:1.27', port: 80, domains: [] } as ImageConfig);
}

/** Conecta el correo del servicio como «Conectar a un servicio», sin el tope de peticiones de la ruta. */
async function conectar(project: ProjectRow, service: ServiceRow, mailboxId: string, mode: 'smtp' | 'api' = 'smtp') {
  const link = getMailwayLink(project.id)!;
  return withMailCredentialLock(service.id, async () => {
    const summary = await ownedSummary(project, link);
    const mailbox = summary.mailboxes.find((m) => m.id === mailboxId)!;
    return connectServiceMail({ project, link, summary, service, mailbox, mode, info: await getInfo() });
  });
}

/** Un despliegue correcto anterior: el servicio está en marcha con las variables de entonces. */
function desplegado(serviceId: string): void {
  const dep = createDeployment(serviceId, 'manual');
  updateDeployment(dep.id, { status: 'success', image_tag: 'nginx:1.27', finished_at: Date.now() });
}

const nombreDe = (project: ProjectRow, service: ServiceRow) => `skyway:${project.slug}/${service.slug}`;
const secreto = (a: FakeAppPassword) => `ContraseñaDeAplicacion-Secreta-${a.id}`;
const vigentes = (nombre: string) => mw.appPasswords.filter((a) => a.name === nombre && !a.revokedAt && !a.invalidatedAt);
const creaciones = () => mw.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/app-passwords'));
const alertasDe = (serviceId: string, type: string) => listAlerts({ limit: 200 }).filter((a) => a.service_id === serviceId && a.type === type);
const pasada = () => renovarContrasenasInvalidadas((msg) => registro.push(msg));
const auditoriasDe = (serviceId: string) =>
  listAudit({ action: 'mailway_app_password_renewed', limit: 500 }).filter((a) => a.target_id === serviceId);

/** El cambio de motor de Mailway, después de preparar la prueba: lo que se mira son las peticiones de la renovación. */
function invalidar(filtro?: (a: FakeAppPassword) => boolean): FakeAppPassword[] {
  const invalidadas = cambiarDeMotor(filtro);
  mw.calls = [];
  return invalidadas;
}

beforeAll(async () => {
  initDb();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === AVISOS) {
        avisos.push(JSON.parse(String(init.body)));
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return fakeFetch(input, init);
    }),
  );
  app = buildApp();
  await app.ready();

  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { email: 'admin@example.com', password: 'contraseña1' },
    headers: SAME_ORIGIN,
  });
  expect(setup.statusCode, setup.body).toBe(200);
  adminCookie = String(setup.headers['set-cookie']).split(';')[0];
  expect((await call('PUT', '/api/mailway/config', admin(), { baseUrl: MW_BASE, token: MW_TOKEN })).status).toBe(200);
  expect((await call('POST', '/api/mailway/test', admin(), {})).status).toBe(200);

  const ws = createWorkspaceRow('Tienda S.L.', { modules_override: JSON.stringify(['mail', 'domains']) });
  tienda = createProject('Tienda', 'tienda', null, ws.id);
  blog = createProject('Blog', 'blog', null, ws.id);
  ownerHeaders = bearerFor(createUser('owner@example.com', hashPassword('contraseña1'), 'owner', ws.id));
  const member = createUser('member@example.com', hashPassword('contraseña1'), 'member', ws.id);
  setUserProjects(member.id, [tienda.id]);
  memberHeaders = bearerFor(member);
  buzonTienda = await activarCorreo(tienda, 'tienda.example', 'hola');
  // El blog es de la misma cuenta: se vincula al mismo cliente, con sus buzones.
  const r = await call('POST', `/api/projects/${blog.id}/mail/link`, admin(), { mode: 'create' });
  expect(r.status, r.raw).toBe(201);
  expect(getMailwayLink(blog.id)?.client_id).toBe(getMailwayLink(tienda.id)?.client_id);

  const ws2 = createWorkspaceRow('Otra S.L.', { modules_override: JSON.stringify(['mail', 'domains']) });
  otra = createProject('Otra', 'otra', null, ws2.id);
  buzonOtra = await activarCorreo(otra, 'otra.example', 'info');
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  closeDb();
});

beforeEach(() => {
  for (const p of [tienda, blog, otra]) for (const s of listServices(p.id)) deleteService(s.id);
  mw.appPasswords = [];
  mw.apiKeys = [];
  mw.calls = [];
  mw.invalidacionSoportada = true;
  mw.motor = 'rest015';
  mw.infoOverride = {};
  mw.fallarCreacionContrasena = null;
  mw.fallarRevocacionContrasena = false;
  mw.retrasoCreacionContrasenaMs = 0;
  mw.retrasoResumenMs = 0;
  avisos = [];
  registro = [];
  setSetting('alertWebhookUrl', null);
  resetMailwayCaches();
  vi.mocked(triggerDeploy).mockReset();
  // Por defecto el despliegue solo se anota en cola: lo que se prueba es que se pide.
  vi.mocked(triggerDeploy).mockImplementation((serviceId: string, trigger: string) => createDeployment(serviceId, trigger));
});

describe('renovación de las contraseñas de aplicación invalidadas', () => {
  it('crea una nueva para el mismo buzón, la guarda, vuelve a desplegar, revoca la invalidada, audita y avisa', async () => {
    const web = servicio(tienda, 'Web');
    await conectar(tienda, web, buzonTienda);
    desplegado(web.id);
    const antes = getEnv(web.id);
    const [vieja] = invalidar();
    expect(vieja.name).toBe('skyway:tienda/web');
    setSetting('alertWebhookUrl', AVISOS);
    mw.calls = [];

    await pasada();

    const [nueva] = vigentes(nombreDe(tienda, web));
    expect(nueva).toBeDefined();
    expect(nueva.id).not.toBe(vieja.id);
    expect(nueva.mailboxId).toBe(buzonTienda);
    // Solo cambia la contraseña: el resto de la conexión ya era la de Mailway.
    const env = getEnv(web.id);
    expect(env.SMTP_PASS).toBe(secreto(nueva));
    expect({ ...env, SMTP_PASS: '' }).toEqual({ ...antes, SMTP_PASS: '' });
    expect(getManagedEnv(web.id).SMTP_PASS.origin).toBe('mail.smtp.password');
    // Despliegue con la maquinaria de siempre y un origen propio.
    expect(triggerDeploy).toHaveBeenCalledTimes(1);
    expect(triggerDeploy).toHaveBeenCalledWith(web.id, 'mailway_renovacion');
    // La invalidada se revoca DESPUÉS de crear la nueva.
    expect(vieja.revokedAt).toBeTruthy();
    const crear = mw.calls.findIndex((c) => c.method === 'POST' && c.path.endsWith('/app-passwords'));
    const revocar = mw.calls.findIndex((c) => c.method === 'DELETE' && c.path.endsWith(`/app-passwords/${vieja.id}`));
    expect(crear).toBeGreaterThanOrEqual(0);
    expect(revocar).toBeGreaterThan(crear);
    expect(mw.calls[crear].body).toEqual({ name: 'skyway:tienda/web' });

    const renovacion = getMailwayRenovacion(web.id)!;
    expect(renovacion).toMatchObject({ status: 'renewed', reason: null, app_password_id: nueva.id, mailbox: 'hola@tienda.example' });
    expect(renovacion.deployment_id).toBeTruthy();

    // Auditoría del sistema, sin secretos.
    const [entrada] = auditoriasDe(web.id);
    expect(entrada).toMatchObject({ actor: 'sistema', target_type: 'service', target_id: web.id });
    expect(entrada.detail).toContain('hola@tienda.example');
    expect(entrada.detail).toContain('SMTP_PASS');
    expect(entrada.detail).toContain('despliegue iniciado');
    expect(entrada.detail).not.toContain('Secreta');

    // Aviso en la campana y por los canales configurados, también sin secretos.
    const [alerta] = alertasDe(web.id, 'mail_password_renewed');
    expect(alerta).toMatchObject({ severity: 'info', resolved_at: null });
    expect(alerta.message).toContain('hola@tienda.example');
    await vi.waitFor(() => expect(avisos).toHaveLength(1));
    expect(avisos[0]).toMatchObject({ severity: 'info', title: 'Contraseña de aplicación renovada: Web' });
    expect(JSON.stringify(avisos)).not.toContain('Secreta');
    expect(registro).toEqual([]);

    // La pestaña del correo lo enseña, también a un miembro.
    const vista = await call('GET', `/api/projects/${tienda.id}/mail`, memberHeaders);
    expect(vista.status, vista.raw).toBe(200);
    expect(vista.json.renewals[web.id]).toMatchObject({
      status: 'renewed',
      reason: null,
      mailbox: 'hola@tienda.example',
      deployment: { status: 'queued' },
    });
    expect(vista.json.renewals[web.id].renewedAt).toBeGreaterThan(0);
    expect(vista.raw).not.toContain('Secreta');
  });

  it('sin contraseñas invalidadas no cambia nada, y sin servicios conectados por SMTP ni siquiera llama a Mailway', async () => {
    await pasada();
    expect(mw.calls).toEqual([]);

    const web = servicio(tienda, 'Web');
    await conectar(tienda, web, buzonTienda);
    desplegado(web.id);
    const antes = getEnv(web.id);
    mw.calls = [];
    await pasada();
    expect(mw.calls.filter((c) => c.path.endsWith('/summary'))).toHaveLength(1);
    expect(mw.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(getEnv(web.id)).toEqual(antes);
    expect(triggerDeploy).not.toHaveBeenCalled();
    expect(getMailwayRenovacion(web.id)).toBeUndefined();
  });

  it('con un Mailway que no anuncia la invalidación (o anterior, sin el campo) no da ninguna por invalidada', async () => {
    const web = servicio(tienda, 'Web');
    await conectar(tienda, web, buzonTienda);
    desplegado(web.id);
    const antes = getEnv(web.id);
    invalidar();

    // Las contraseñas llevan el campo, pero Mailway no anuncia la función.
    mw.infoOverride = { features: { cloudflare: true, autoconfig: true, portal: true } };
    resetMailwayCaches();
    await pasada();
    expect(creaciones()).toEqual([]);

    // Un Mailway anterior: ni el anuncio ni el campo.
    mw.infoOverride = {};
    mw.invalidacionSoportada = false;
    resetMailwayCaches();
    await pasada();
    expect(creaciones()).toEqual([]);
    expect(getEnv(web.id)).toEqual(antes);
    expect(triggerDeploy).not.toHaveBeenCalled();
    expect(mw.appPasswords.every((a) => !a.revokedAt)).toBe(true);
    expect(getMailwayRenovacion(web.id)).toBeUndefined();
  });

  it('si Mailway no crea la nueva, no cambia nada, lo indica y lo reintenta en la pasada siguiente', async () => {
    const web = servicio(tienda, 'Web');
    await conectar(tienda, web, buzonTienda);
    desplegado(web.id);
    const antes = getEnv(web.id);
    const [vieja] = invalidar();
    mw.fallarCreacionContrasena = { status: 500, error: 'Error interno del servidor', code: 'internal' };

    await pasada();
    expect(getEnv(web.id)).toEqual(antes);
    expect(vieja.revokedAt).toBeNull();
    expect(triggerDeploy).not.toHaveBeenCalled();
    expect(auditoriasDe(web.id)).toEqual([]);
    const fallo = getMailwayRenovacion(web.id)!;
    expect(fallo.status).toBe('failed');
    expect(fallo.reason).toBe(
      'No se ha podido crear la contraseña de aplicación nueva en Mailway: Error interno del servidor. Se volverá a intentar automáticamente.',
    );
    const [alerta] = alertasDe(web.id, 'mail_password_renewal_failed');
    expect(alerta).toMatchObject({ severity: 'warning', resolved_at: null });

    // Sigue fallando: la alerta no se repite.
    await pasada();
    expect(alertasDe(web.id, 'mail_password_renewal_failed')).toHaveLength(1);

    mw.fallarCreacionContrasena = null;
    await pasada();
    const [nueva] = vigentes(nombreDe(tienda, web));
    expect(getEnv(web.id).SMTP_PASS).toBe(secreto(nueva));
    expect(vieja.revokedAt).toBeTruthy();
    expect(triggerDeploy).toHaveBeenCalledTimes(1);
    expect(getMailwayRenovacion(web.id)).toMatchObject({ status: 'renewed', reason: null });
    expect(alertasDe(web.id, 'mail_password_renewal_failed')[0].resolved_at).toBeTruthy();
  });

  it('si el despliegue falla, conserva las credenciales nuevas y lo avisa como cualquier despliegue fallido', async () => {
    vi.mocked(triggerDeploy).mockImplementation(mocks.realTriggerDeploy!);
    const web = servicio(tienda, 'Web');
    await conectar(tienda, web, buzonTienda);
    desplegado(web.id);
    const [vieja] = invalidar();

    await pasada();
    const renovacion = getMailwayRenovacion(web.id)!;
    expect(renovacion.status).toBe('renewed');
    const hecho = await awaitDeployment(renovacion.deployment_id!, 15_000);
    expect(hecho).toMatchObject({ status: 'failed', trigger: 'mailway_renovacion' });
    expect(hecho?.error).toMatch(/Sin Docker en las pruebas/);

    // Las credenciales nuevas se quedan; la invalidada ya no funcionaba y se ha revocado igual.
    const [nueva] = vigentes(nombreDe(tienda, web));
    expect(getEnv(web.id).SMTP_PASS).toBe(secreto(nueva));
    expect(vieja.revokedAt).toBeTruthy();
    const [alerta] = alertasDe(web.id, 'deploy_failed');
    expect(alerta).toMatchObject({ severity: 'warning', resolved_at: null });
    expect(alerta.message).toMatch(/\(mailway_renovacion\)/);

    // La vista lo dice; una pasada más no crea otra contraseña ni otro despliegue.
    const vista = await call('GET', `/api/projects/${tienda.id}/mail`, memberHeaders);
    expect(vista.json.renewals[web.id].deployment.status).toBe('failed');
    mw.calls = [];
    await pasada();
    expect(creaciones()).toEqual([]);
    expect(triggerDeploy).toHaveBeenCalledTimes(1);
  });

  it('si no se puede iniciar el despliegue, conserva las credenciales nuevas y lo avisa', async () => {
    vi.mocked(triggerDeploy).mockImplementation(() => {
      throw new Error('La cola de despliegues no está disponible.');
    });
    const web = servicio(tienda, 'Web');
    await conectar(tienda, web, buzonTienda);
    desplegado(web.id);
    invalidar();

    await pasada();
    const [nueva] = vigentes(nombreDe(tienda, web));
    expect(getEnv(web.id).SMTP_PASS).toBe(secreto(nueva));
    expect(getMailwayRenovacion(web.id)).toMatchObject({ status: 'renewed', deployment_id: null });
    const [alerta] = alertasDe(web.id, 'deploy_failed');
    expect(alerta.message).toContain('La cola de despliegues no está disponible.');
    expect(alerta.explanation).toMatch(/Vuelve a desplegarlo/);
    expect(auditoriasDe(web.id)[0].detail).toContain('no se ha podido iniciar el despliegue');
  });

  it('no toca los servicios conectados por la API de envío', async () => {
    const api = servicio(tienda, 'Api');
    await conectar(tienda, api, buzonTienda, 'api');
    desplegado(api.id);
    const antes = getEnv(api.id);
    expect(antes.MAILWAY_API_KEY).toMatch(/^mw_ClaveApiSecreta_/);
    invalidar();
    mw.calls = [];
    // Solo hay un servicio por la API: ni siquiera se lee el resumen.
    await pasada();
    expect(mw.calls).toEqual([]);

    // Con otro conectado por SMTP en el proyecto, se renueva solo ese.
    const web = servicio(tienda, 'Web');
    await conectar(tienda, web, buzonTienda);
    desplegado(web.id);
    invalidar();
    await pasada();
    expect(vigentes(nombreDe(tienda, web))).toHaveLength(1);
    expect(getEnv(api.id)).toEqual(antes);
    expect(mw.apiKeys.every((k) => !k.revokedAt)).toBe(true);
    expect(triggerDeploy).toHaveBeenCalledTimes(1);
    expect(triggerDeploy).toHaveBeenCalledWith(web.id, 'mailway_renovacion');
    expect(getMailwayRenovacion(api.id)).toBeUndefined();
  });

  it('dos pasadas seguidas no crean dos contraseñas, aunque la invalidada no se haya podido revocar', async () => {
    const web = servicio(tienda, 'Web');
    await conectar(tienda, web, buzonTienda);
    desplegado(web.id);
    const [vieja] = invalidar();
    mw.fallarRevocacionContrasena = true;
    mw.calls = [];

    await pasada();
    expect(creaciones()).toHaveLength(1);
    expect(vieja.revokedAt).toBeNull();
    const [nueva] = vigentes(nombreDe(tienda, web));
    expect(getEnv(web.id).SMTP_PASS).toBe(secreto(nueva));
    expect(auditoriasDe(web.id)[0].detail).not.toContain('se ha revocado');

    // La revocación sigue fallando: no se crea otra ni se vuelve a desplegar.
    await pasada();
    expect(creaciones()).toHaveLength(1);
    expect(triggerDeploy).toHaveBeenCalledTimes(1);

    // Ya funciona: solo se revoca la que faltaba.
    mw.fallarRevocacionContrasena = false;
    await pasada();
    expect(vieja.revokedAt).toBeTruthy();
    expect(creaciones()).toHaveLength(1);
    expect(getEnv(web.id).SMTP_PASS).toBe(secreto(nueva));

    // Y después, nada.
    mw.calls = [];
    await pasada();
    expect(mw.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(auditoriasDe(web.id)).toHaveLength(1);
    expect(alertasDe(web.id, 'mail_password_renewed')).toHaveLength(1);
  });

  it('un «Conectar» durante la renovación espera su turno y deja una sola contraseña vigente, la de las variables', async () => {
    const web = servicio(tienda, 'Web');
    await conectar(tienda, web, buzonTienda);
    desplegado(web.id);
    const [vieja] = invalidar();
    mw.retrasoCreacionContrasenaMs = 200;

    const renovacion = pasada();
    // La renovación tiene el turno mientras Mailway crea su contraseña.
    await vi.waitFor(() => expect(creaciones()).toHaveLength(1), { interval: 5 });
    const conexion = call('POST', `/api/projects/${tienda.id}/mail/connect`, admin(), { serviceId: web.id, mailboxId: buzonTienda, mode: 'smtp' });
    const [, r] = await Promise.all([renovacion, conexion]);
    expect(r.status, r.raw).toBe(200);

    const activas = mw.appPasswords.filter((a) => a.name === nombreDe(tienda, web) && !a.revokedAt);
    expect(activas).toHaveLength(1);
    expect(getEnv(web.id).SMTP_PASS).toBe(secreto(activas[0]));
    expect(vieja.revokedAt).toBeTruthy();
    // La conexión manual es la última: la renovación anterior ya no la describe.
    expect(getMailwayRenovacion(web.id)).toBeUndefined();
  });

  it('una renovación que leyó el resumen antes de un «Conectar» lo vuelve a leer y no crea otra', async () => {
    const web = servicio(tienda, 'Web');
    await conectar(tienda, web, buzonTienda);
    desplegado(web.id);
    const [vieja] = invalidar();
    mw.retrasoResumenMs = 200;
    mw.calls = [];

    const renovacion = pasada();
    // La pasada ya ha pedido el resumen (con la invalidada sin revocar) cuando llega el «Conectar».
    await vi.waitFor(() => expect(mw.calls.some((c) => c.path.endsWith('/summary'))).toBe(true), { interval: 5 });
    const conexion = call('POST', `/api/projects/${tienda.id}/mail/connect`, admin(), { serviceId: web.id, mailboxId: buzonTienda, mode: 'smtp' });
    const [, r] = await Promise.all([renovacion, conexion]);
    expect(r.status, r.raw).toBe(200);

    // Solo la del «Conectar»: la renovación vio, con el resumen de después, que ya no hacía falta.
    expect(creaciones()).toHaveLength(1);
    const activas = mw.appPasswords.filter((a) => a.name === nombreDe(tienda, web) && !a.revokedAt);
    expect(activas).toHaveLength(1);
    expect(getEnv(web.id).SMTP_PASS).toBe(secreto(activas[0]));
    expect(vieja.revokedAt).toBeTruthy();
    expect(triggerDeploy).not.toHaveBeenCalled();
    expect(getMailwayRenovacion(web.id)).toBeUndefined();
  });

  it('con el servicio detenido o con un despliegue en curso espera sin crear nada, y después la renueva', async () => {
    const parado = servicio(tienda, 'Parado');
    await conectar(tienda, parado, buzonTienda);
    desplegado(parado.id);
    setServiceStopped(parado.id, true);
    const enCurso = servicio(tienda, 'En curso');
    await conectar(tienda, enCurso, buzonTienda);
    desplegado(enCurso.id);
    const pendiente = createDeployment(enCurso.id, 'manual');
    const antes = { parado: getEnv(parado.id), enCurso: getEnv(enCurso.id) };
    invalidar();

    await pasada();
    expect(creaciones()).toEqual([]);
    expect(triggerDeploy).not.toHaveBeenCalled();
    expect(getEnv(parado.id)).toEqual(antes.parado);
    expect(getEnv(enCurso.id)).toEqual(antes.enCurso);
    expect(getMailwayRenovacion(parado.id)).toMatchObject({
      status: 'waiting',
      reason: 'El servicio está detenido. La contraseña se renovará automáticamente cuando vuelva a estar en marcha.',
    });
    expect(getMailwayRenovacion(enCurso.id)).toMatchObject({
      status: 'waiting',
      reason: 'Hay un despliegue del servicio en curso. La contraseña se renovará automáticamente cuando termine.',
    });
    // Esperar no es un fallo: no hay alerta.
    expect(alertasDe(parado.id, 'mail_password_renewal_failed')).toEqual([]);

    setServiceStopped(parado.id, false);
    updateDeployment(pendiente.id, { status: 'success', image_tag: 'nginx:1.27', finished_at: Date.now() });
    await pasada();
    expect(creaciones()).toHaveLength(2);
    expect(triggerDeploy).toHaveBeenCalledTimes(2);
    expect(getMailwayRenovacion(parado.id)?.status).toBe('renewed');
    expect(getMailwayRenovacion(enCurso.id)?.status).toBe('renewed');
  });

  it('no toca una contraseña cambiada a mano ni deja la conexión a medias con otro servidor puesto a mano', async () => {
    const propia = servicio(tienda, 'Propia');
    await conectar(tienda, propia, buzonTienda);
    desplegado(propia.id);
    setEnv(propia.id, { ...getEnv(propia.id), SMTP_PASS: 'la-de-otro-proveedor' });
    const otroServidor = servicio(tienda, 'Otro servidor');
    await conectar(tienda, otroServidor, buzonTienda);
    desplegado(otroServidor.id);
    setEnv(otroServidor.id, { ...getEnv(otroServidor.id), SMTP_HOST: 'smtp.otro-proveedor.example' });
    const antes = { propia: getEnv(propia.id), otroServidor: getEnv(otroServidor.id) };
    invalidar();

    await pasada();
    expect(creaciones()).toEqual([]);
    expect(triggerDeploy).not.toHaveBeenCalled();
    expect(getEnv(propia.id)).toEqual(antes.propia);
    expect(getEnv(otroServidor.id)).toEqual(antes.otroServidor);
    // La cambiada a mano ya no es de Skyway: nada que anotar.
    expect(getMailwayRenovacion(propia.id)).toBeUndefined();
    // Con otro servidor, la nueva acabaría en otro proveedor: se explica y se avisa.
    const fallo = getMailwayRenovacion(otroServidor.id)!;
    expect(fallo.status).toBe('failed');
    expect(fallo.reason).toMatch(/^SMTP_HOST tiene un valor puesto a mano distinto del de Mailway/);
    expect(alertasDe(otroServidor.id, 'mail_password_renewal_failed')).toHaveLength(1);

    // Al conectarlo de nuevo a mano, la anotación y su alerta desaparecen.
    setEnv(otroServidor.id, { ...getEnv(otroServidor.id), SMTP_HOST: '' });
    await conectar(tienda, otroServidor, buzonTienda);
    expect(getMailwayRenovacion(otroServidor.id)).toBeUndefined();
    expect(alertasDe(otroServidor.id, 'mail_password_renewal_failed')[0].resolved_at).toBeTruthy();
  });

  it('una conexión anterior a llevar la cuenta de lo escrito se renueva solo si sigue siendo la de Mailway', async () => {
    const legado = (nombre: string, env: Record<string, string>, email = 'hola@tienda.example') => {
      const s = servicio(tienda, nombre);
      setEnv(s.id, env);
      desplegado(s.id);
      mw.appPasswords.push({
        id: `app_${s.slug}`,
        mailboxId: buzonTienda,
        email,
        name: nombreDe(tienda, s),
        revokedAt: null,
        createdAt: 1,
        invalidatedAt: null,
      });
      return s;
    };
    const comoSkyway = {
      SMTP_HOST: 'mail.example.com',
      SMTP_PORT: '587',
      SMTP_SECURE: 'false',
      SMTP_USER: 'hola@tienda.example',
      SMTP_PASS: 'ContraseñaDeAntes',
    };
    // Con el remitente cambiado a mano: no se sabe, así que no se toca.
    const intacta = legado('Intacta', { ...comoSkyway, SMTP_FROM: 'ventas@tienda.example' });
    const otroServidor = legado('Movida', { ...comoSkyway, SMTP_HOST: 'smtp.otro-proveedor.example' });
    const ajena = legado('Ajena', { ...comoSkyway, SMTP_USER: 'yo@otro-proveedor.example' });
    const antes = { otroServidor: getEnv(otroServidor.id), ajena: getEnv(ajena.id) };
    invalidar();

    await pasada();
    const [nueva] = vigentes(nombreDe(tienda, intacta));
    expect(nueva).toBeDefined();
    expect(getEnv(intacta.id)).toEqual({ ...comoSkyway, SMTP_PASS: secreto(nueva), SMTP_FROM: 'ventas@tienda.example' });
    // Desde ahora Skyway lleva la cuenta de lo que ha escrito; el remitente sigue siendo de quien lo puso.
    expect(getManagedEnv(intacta.id).SMTP_PASS?.origin).toBe('mail.smtp.password');
    expect(getManagedEnv(intacta.id).SMTP_FROM).toBeUndefined();

    expect(vigentes(nombreDe(tienda, otroServidor))).toEqual([]);
    expect(getEnv(otroServidor.id)).toEqual(antes.otroServidor);
    expect(getMailwayRenovacion(otroServidor.id)?.reason).toMatch(/^SMTP_HOST tiene un valor distinto del de Mailway/);

    expect(vigentes(nombreDe(tienda, ajena))).toEqual([]);
    expect(getEnv(ajena.id)).toEqual(antes.ajena);
    expect(getMailwayRenovacion(ajena.id)).toBeUndefined();
    expect(triggerDeploy).toHaveBeenCalledTimes(1);
  });

  it('durante un cambio de dominio, la renovación conserva el usuario del motor (la dirección anterior)', async () => {
    const web = servicio(tienda, 'Web');
    await conectar(tienda, web, buzonTienda);
    // Como tras «Pasar» un cambio de dominio de Mailway: el buzón ya es
    // hola@tienda2.example, pero entra con la dirección anterior hasta la baja.
    const buzon = mw.mailboxes.find((b) => b.id === buzonTienda)!;
    const original = { ...buzon };
    buzon.email = 'hola@tienda2.example';
    buzon.usuarioMotor = 'hola@tienda.example';
    // Una conexión anterior a llevar la cuenta de lo escrito, con el usuario de siempre.
    const legado = servicio(tienda, 'Legado');
    setEnv(legado.id, {
      SMTP_HOST: 'mail.example.com',
      SMTP_PORT: '587',
      SMTP_SECURE: 'false',
      SMTP_USER: 'hola@tienda.example',
      SMTP_PASS: 'ContraseñaDeAntes',
    });
    mw.appPasswords.push({
      id: 'app_legado',
      mailboxId: buzonTienda,
      email: 'hola@tienda2.example',
      name: nombreDe(tienda, legado),
      revokedAt: null,
      createdAt: 1,
      invalidatedAt: null,
    });
    try {
      for (const s of [web, legado]) desplegado(s.id);
      const antes = getEnv(web.id);
      expect(antes.SMTP_USER).toBe('hola@tienda.example');
      invalidar();

      await pasada();

      const [nueva] = vigentes(nombreDe(tienda, web));
      expect(nueva).toBeDefined();
      // El usuario sigue siendo el del motor; el remitente, la dirección del buzón (la nueva).
      expect(getEnv(web.id)).toEqual({ ...antes, SMTP_PASS: secreto(nueva), SMTP_FROM: 'hola@tienda2.example' });
      const [nuevaLegado] = vigentes(nombreDe(tienda, legado));
      expect(nuevaLegado).toBeDefined();
      expect(getEnv(legado.id)).toMatchObject({ SMTP_USER: 'hola@tienda.example', SMTP_PASS: secreto(nuevaLegado) });
      expect(triggerDeploy).toHaveBeenCalledTimes(2);
    } finally {
      Object.assign(buzon, original);
      delete buzon.usuarioMotor;
    }
  });

  it('un servicio que nunca se ha desplegado recibe la nueva sin desplegarlo', async () => {
    const web = servicio(tienda, 'Web');
    await conectar(tienda, web, buzonTienda);
    invalidar();

    await pasada();
    const [nueva] = vigentes(nombreDe(tienda, web));
    expect(getEnv(web.id).SMTP_PASS).toBe(secreto(nueva));
    expect(triggerDeploy).not.toHaveBeenCalled();
    expect(getMailwayRenovacion(web.id)).toMatchObject({ status: 'renewed', deployment_id: null });
    expect(auditoriasDe(web.id)[0].detail).toContain('sin desplegar');
    const vista = await call('GET', `/api/projects/${tienda.id}/mail`, memberHeaders);
    expect(vista.json.renewals[web.id].deployment).toBeNull();
  });

  it('una pasada lee un solo resumen por cliente de Mailway, aunque lo compartan varios proyectos', async () => {
    const servicios: [ProjectRow, ServiceRow][] = [];
    for (const [project, nombre, buzon] of [
      [tienda, 'Web', buzonTienda],
      [tienda, 'Tareas', buzonTienda],
      [blog, 'Web', buzonTienda],
      [otra, 'Web', buzonOtra],
    ] as const) {
      const s = servicio(project, nombre);
      await conectar(project, s, buzon);
      desplegado(s.id);
      servicios.push([project, s]);
    }
    invalidar();
    mw.calls = [];

    await pasada();
    expect(mw.calls.filter((c) => c.path.endsWith('/summary'))).toHaveLength(2);
    expect(creaciones()).toHaveLength(4);
    for (const [project, s] of servicios) {
      const [nueva] = vigentes(nombreDe(project, s));
      expect(getEnv(s.id).SMTP_PASS).toBe(secreto(nueva));
    }
    expect(triggerDeploy).toHaveBeenCalledTimes(4);
  });

  it('al abrir el correo del proyecto quien lo gestiona se renueva al momento; un miembro solo lo ve', async () => {
    const web = servicio(tienda, 'Web');
    await conectar(tienda, web, buzonTienda);
    desplegado(web.id);
    const [vieja] = invalidar();

    let vista = await call('GET', `/api/projects/${tienda.id}/mail`, memberHeaders);
    expect(vista.status).toBe(200);
    expect(creaciones()).toEqual([]);
    const marcada = vista.json.summary.appPasswords.find((a: Json) => a.id === vieja.id);
    expect(marcada.invalidatedAt).toBeGreaterThan(0);
    expect(vista.json.renewals[web.id]).toBeUndefined();

    vista = await call('GET', `/api/projects/${tienda.id}/mail`, ownerHeaders);
    expect(vista.status, vista.raw).toBe(200);
    expect(vista.json.renewals[web.id]).toMatchObject({ status: 'renewed', mailbox: 'hola@tienda.example' });
    // El resumen de la respuesta ya es el de después.
    const [nueva] = vigentes(nombreDe(tienda, web));
    expect(vista.json.summary.appPasswords.find((a: Json) => a.id === nueva.id)).toMatchObject({ revokedAt: null, invalidatedAt: null });
    expect(vista.json.summary.appPasswords.find((a: Json) => a.id === vieja.id).revokedAt).toBeTruthy();
    expect(triggerDeploy).toHaveBeenCalledWith(web.id, 'mailway_renovacion');
    expect(vista.raw).not.toContain('Secreta');
  });

  it('al abrir el correo, un servicio detenido queda en espera y se renueva en cuanto vuelve a estar en marcha', async () => {
    const web = servicio(tienda, 'Web');
    await conectar(tienda, web, buzonTienda);
    desplegado(web.id);
    setServiceStopped(web.id, true);
    invalidar();

    let vista = await call('GET', `/api/projects/${tienda.id}/mail`, ownerHeaders);
    expect(vista.json.renewals[web.id]).toMatchObject({ status: 'waiting', reason: expect.stringMatching(/^El servicio está detenido/) });
    expect(creaciones()).toEqual([]);
    // Para saber que hay que esperar basta con el resumen de la propia vista.
    expect(mw.calls.filter((c) => c.path.endsWith('/summary'))).toHaveLength(1);

    setServiceStopped(web.id, false);
    vista = await call('GET', `/api/projects/${tienda.id}/mail`, ownerHeaders);
    expect(vista.json.renewals[web.id]).toMatchObject({ status: 'renewed', reason: null });
    expect(triggerDeploy).toHaveBeenCalledWith(web.id, 'mailway_renovacion');
  });

  it('al abrir el correo no se reintenta en cada lectura lo que acaba de fallar', async () => {
    const web = servicio(tienda, 'Web');
    await conectar(tienda, web, buzonTienda);
    desplegado(web.id);
    invalidar();
    mw.fallarCreacionContrasena = { status: 409, error: 'El buzón ha alcanzado su límite.', code: 'app_password_limit' };

    let vista = await call('GET', `/api/projects/${tienda.id}/mail`, ownerHeaders);
    expect(vista.json.renewals[web.id]).toMatchObject({ status: 'failed' });
    expect(vista.json.renewals[web.id].reason).toContain('El buzón ha alcanzado su límite.');
    vista = await call('GET', `/api/projects/${tienda.id}/mail`, ownerHeaders);
    expect(vista.status).toBe(200);
    expect(creaciones()).toHaveLength(1);
  });

  // La última: desactiva el correo de uno de los proyectos.
  it('al desactivar el correo del proyecto se olvida lo anotado y se resuelve su aviso', async () => {
    const web = servicio(otra, 'Web');
    await conectar(otra, web, buzonOtra);
    desplegado(web.id);
    invalidar();
    mw.fallarCreacionContrasena = { status: 500, error: 'Error interno del servidor', code: 'internal' };
    await pasada();
    expect(getMailwayRenovacion(web.id)?.status).toBe('failed');
    expect(alertasDe(web.id, 'mail_password_renewal_failed')[0].resolved_at).toBeNull();

    const r = await call('DELETE', `/api/projects/${otra.id}/mail/link`, admin());
    expect(r.status, r.raw).toBe(200);
    expect(getMailwayRenovacion(web.id)).toBeUndefined();
    expect(alertasDe(web.id, 'mail_password_renewal_failed')[0].resolved_at).toBeTruthy();
    // Sin vínculo, la pasada ya no lo mira.
    mw.calls = [];
    await pasada();
    expect(mw.calls).toEqual([]);
  });
});
