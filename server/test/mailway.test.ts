/**
 * Integración con Mailway: configuración, correo por proyecto, aislamiento
 * entre clientes, conexión de servicios y puente de Traefik. Mailway se
 * sustituye por un doble en memoria detrás de `fetch` (`mailwayfake.ts`) que
 * sigue el contrato de su API de integraciones, así se prueba también el
 * cliente HTTP real. Las regresiones de la revisión de seguridad están en
 * `mailway-seguridad.test.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { API_TOKEN_PREFIX, hashApiToken } from '../src/auth';
import {
  closeDb,
  createProject,
  createService,
  createUser,
  createWorkspaceRow,
  deleteMailwayLink,
  getEnv,
  getMailwayLink,
  getSetting,
  initDb,
  insertApiToken,
  insertMailwayLink,
  listAudit,
  setEnv,
  setUserProjects,
} from '../src/db';
import { resetMailwayCaches } from '../src/mailway';
import { resetMailwayTraefikState } from '../src/mailwaytraefik';
import type { GitConfig, ProjectRow, ServiceRow, UserRow } from '../src/types';
import { hashPassword, randomToken } from '../src/util';
import { FakeClient, MW_BASE, MW_TOKEN, TRAEFIK_TOKEN, fakeFetch, mw } from './mailwayfake';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

// ---------- preparación ----------

let app: FastifyInstance;
let adminCookie = '';
let ownerHeaders: Record<string, string>;
let memberHeaders: Record<string, string>;
let ownerNoMailHeaders: Record<string, string>;
let projA: ProjectRow;
let projC: ProjectRow;
let projSinCorreo: ProjectRow;
let apiService: ServiceRow;
let otherService: ServiceRow;

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

const admin = () => ({ cookie: adminCookie, ...SAME_ORIGIN });

function gitCfg(domains: string[] = [], port = 3000): GitConfig {
  return { repoUrl: 'https://github.com/x/y', branch: 'main', port, domains, webhookSecret: 'w' } as GitConfig;
}

beforeAll(async () => {
  initDb();
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
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

  // Cuenta con el módulo de correo y cuenta sin él.
  const ws = createWorkspaceRow('Cliente Correo', { modules_override: JSON.stringify(['mail']) });
  const wsNo = createWorkspaceRow('Cliente Sin Correo', { modules_override: JSON.stringify(['domains']) });
  projA = createProject('Tienda', 'tienda', null, ws.id);
  projC = createProject('Blog', 'blog', null, ws.id);
  projSinCorreo = createProject('Otro', 'otro', null, wsNo.id);

  const owner = createUser('owner@example.com', hashPassword('contraseña1'), 'owner', ws.id);
  ownerHeaders = bearerFor(owner);
  const member = createUser('member@example.com', hashPassword('contraseña1'), 'member', ws.id);
  setUserProjects(member.id, [projA.id]);
  memberHeaders = bearerFor(member);
  const ownerNo = createUser('owner2@example.com', hashPassword('contraseña1'), 'owner', wsNo.id);
  ownerNoMailHeaders = bearerFor(ownerNo);

  apiService = createService(projA.id, 'API', 'api', 'git', gitCfg());
  otherService = createService(projC.id, 'Web', 'web', 'git', gitCfg(['blog.cliente.com']));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  closeDb();
});

beforeEach(() => {
  mw.calls = [];
});

// ---------- configuración ----------

describe('configuración de Mailway', () => {
  it('sin configurar: el estado lo dice y el puente de Traefik devuelve una configuración vacía', async () => {
    const st = await call('GET', '/api/mailway/status', memberHeaders);
    expect(st.status).toBe(200);
    expect(st.json.configured).toBe(false);
    const tr = await app.inject({ method: 'GET', url: '/api/traefik/mailway' });
    expect(tr.statusCode).toBe(200);
    expect(tr.json()).toEqual({});
    const mail = await call('GET', `/api/projects/${projA.id}/mail`, ownerHeaders);
    expect(mail.status).toBe(200);
    expect(mail.json).toMatchObject({ configured: false, linked: false, moduleEnabled: true });
  });

  it('guardar exige administrador con sesión de navegador y valida el token', async () => {
    let r = await call('PUT', '/api/mailway/config', ownerHeaders, { baseUrl: MW_BASE });
    expect(r.status).toBe(403);
    r = await call('PUT', '/api/mailway/config', admin(), { token: 'no-es-un-token' });
    expect(r.status).toBe(400);
    r = await call('PUT', '/api/mailway/config', admin(), { baseUrl: 'ftp://x.example.com' });
    expect(r.status).toBe(400);
    r = await call('PUT', '/api/mailway/config', admin(), { baseUrl: `${MW_BASE}/`, token: MW_TOKEN });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.config.baseUrl).toBe(MW_BASE);
  });

  it('la configuración nunca devuelve el token y la auditoría no lo registra', async () => {
    const r = await call('GET', '/api/mailway/config', admin());
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ configured: true, hasToken: true, baseUrl: MW_BASE });
    expect(r.raw).not.toContain(MW_TOKEN);
    expect(r.raw).not.toContain('EsteEsElSecreto');
    const audit = listAudit({ action: 'mailway_config_updated' });
    expect(audit.length).toBeGreaterThan(0);
    for (const a of audit) expect(String(a.detail)).not.toContain('mwt_');
    // Solo para administradores.
    expect((await call('GET', '/api/mailway/config', ownerHeaders)).status).toBe(403);
  });

  it('probar la conexión informa de la instancia y guarda el token de Traefik', async () => {
    const r = await call('POST', '/api/mailway/test', admin(), {});
    expect(r.status, r.raw).toBe(200);
    expect(r.json.info).toMatchObject({ version: '1.0.0', brandName: 'Correo Demo', mailHostname: 'mail.example.com', role: 'admin' });
    expect(r.json.warnings).toEqual([]);
    expect(r.raw).not.toContain(TRAEFIK_TOKEN);
    expect(getSetting('mailway.traefikToken')).toBe(TRAEFIK_TOKEN);
    // El token de gestión viaja como Bearer.
    expect(mw.calls.every((c) => c.auth === `Bearer ${MW_TOKEN}`)).toBe(true);
  });

  it('avisa si el token no es de administrador y traduce el 401 de Mailway a 502', async () => {
    mw.role = 'client';
    let r = await call('POST', '/api/mailway/test', admin(), {});
    expect(r.status).toBe(200);
    expect(r.json.warnings[0]).toMatch(/no es administrador/);
    mw.role = 'admin';
    // Un token distinto al que conoce Mailway: jamás un 401 hacia el navegador.
    r = await call('POST', '/api/mailway/test', admin(), { token: 'mwt_ffffffff_otroSecretoCualquiera' });
    expect(r.status).toBe(502);
    expect(r.json.error).toMatch(/token de gestión/);
    resetMailwayCaches();
  });

  it('con un token de API no se puede probar otra dirección con el token guardado', async () => {
    const otroAdmin = createUser('admin2@example.com', hashPassword('contraseña1'), 'admin');
    const bearer = bearerFor(otroAdmin);
    mw.calls = [];
    const r = await call('POST', '/api/mailway/test', bearer, { baseUrl: 'https://recolector.example.net' });
    expect(r.status).toBe(403);
    expect(mw.calls).toEqual([]);
    // Con la configuración guardada, sí.
    expect((await call('POST', '/api/mailway/test', bearer, {})).status).toBe(200);
  });

  it('prueba la dirección interna del servicio del panel y, si no resuelve, usa la pública', async () => {
    const panelProject = createProject('Correo', 'correo', null, null);
    const panel = createService(panelProject.id, 'Panel', 'panel', 'git', gitCfg(['mail-panel.example.com'], 8080));
    let r = await call('PUT', '/api/mailway/config', admin(), { serviceId: panel.id });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.config.internalUrl).toBe('http://skyway-correo-panel:8080');
    mw.unreachable.add('skyway-correo-panel');
    r = await call('POST', '/api/mailway/test', admin(), {});
    expect(r.status, r.raw).toBe(200);
    expect(mw.calls.map((c) => c.host)).toEqual(['skyway-correo-panel:8080', 'mail-panel.example.com']);
    // Tras el fallo, la interna se salta durante un tiempo.
    mw.calls = [];
    resetMailwayCaches();
    r = await call('POST', '/api/mailway/test', admin(), {});
    expect(r.status).toBe(200);
    r = await call('PUT', '/api/mailway/config', admin(), { serviceId: '' });
    expect(r.status).toBe(200);
    // Al guardar se olvida el token de Traefik: se vuelve a pedir.
    await call('POST', '/api/mailway/test', admin(), {});
  });
});

// ---------- correo del proyecto ----------

describe('correo de un proyecto', () => {
  let domainA = '';
  let mailboxA = '';
  let domainC = '';
  let mailboxC = '';

  it('un miembro sin acceso al proyecto recibe 403', async () => {
    const r = await call('GET', `/api/projects/${projC.id}/mail`, memberHeaders);
    expect(r.status).toBe(403);
  });

  it('sin el módulo «Correo» la vista lo indica y las acciones se rechazan', async () => {
    const r = await call('GET', `/api/projects/${projSinCorreo.id}/mail`, ownerNoMailHeaders);
    expect(r.status).toBe(200);
    expect(r.json.moduleEnabled).toBe(false);
    const post = await call('POST', `/api/projects/${projSinCorreo.id}/mail/link`, ownerNoMailHeaders, { mode: 'create' });
    expect(post.status).toBe(403);
    expect(post.json.error).toMatch(/Correo/);
    // El administrador traspasa las gates.
    const adm = await call('GET', `/api/projects/${projSinCorreo.id}/mail`, admin());
    expect(adm.json.moduleEnabled).toBe(true);
  });

  it('un miembro no puede activar el correo; el propietario sí, creando el cliente con la referencia del proyecto', async () => {
    let r = await call('POST', `/api/projects/${projA.id}/mail/link`, memberHeaders, { mode: 'create' });
    expect(r.status).toBe(403);
    r = await call('GET', `/api/projects/${projA.id}/mail/options`, ownerHeaders);
    expect(r.status, r.raw).toBe(200);
    expect(r.json.plans[0].id).toBe('pln_1');
    expect(r.json.clients).toEqual([]); // solo el administrador ve los clientes
    r = await call('POST', `/api/projects/${projA.id}/mail/link`, ownerHeaders, { mode: 'existing', clientId: 'cli_x' });
    expect(r.status).toBe(403);
    r = await call('POST', `/api/projects/${projA.id}/mail/link`, ownerHeaders, { mode: 'create', planId: 'pln_1' });
    expect(r.status, r.raw).toBe(201);
    const client = mw.clients.find((c) => c.externalRef === `skyway:project:${projA.id}`);
    expect(client?.name).toBe('Tienda');
    expect(getMailwayLink(projA.id)?.client_id).toBe(client?.id);
    r = await call('POST', `/api/projects/${projA.id}/mail/link`, ownerHeaders, { mode: 'create' });
    expect(r.status).toBe(409);
  });

  it('el administrador vincula un cliente existente, pero no uno ya vinculado', async () => {
    const libre: FakeClient = { id: 'cli_libre', name: 'Blog S.L.', slug: 'blog', externalRef: null, suspended: false, planId: 'pln_1' };
    mw.clients.push(libre);
    const ocupadoA = getMailwayLink(projA.id)!.client_id;
    let r = await call('POST', `/api/projects/${projC.id}/mail/link`, admin(), { mode: 'existing', clientId: ocupadoA });
    expect(r.status).toBe(409);
    const opts = await call('GET', `/api/projects/${projC.id}/mail/options`, admin());
    expect(opts.json.clients.find((c: Json) => c.id === ocupadoA).available).toBe(false);
    expect(opts.json.clients.find((c: Json) => c.id === 'cli_libre').available).toBe(true);
    r = await call('POST', `/api/projects/${projC.id}/mail/link`, admin(), { mode: 'existing', clientId: 'cli_libre' });
    expect(r.status, r.raw).toBe(201);
    expect(libre.externalRef).toBe(`skyway:project:${projC.id}`);
  });

  it('dominios y buzones se crean en el cliente del proyecto; la contraseña se entrega una vez y no se audita', async () => {
    let r = await call('POST', `/api/projects/${projA.id}/mail/domains`, memberHeaders, { domain: 'Tienda.Example' });
    expect(r.status, r.raw).toBe(201);
    domainA = r.json.domain.id;
    expect(mw.domains.find((d) => d.id === domainA)?.clientId).toBe(getMailwayLink(projA.id)!.client_id);
    r = await call('POST', `/api/projects/${projA.id}/mail/domains`, memberHeaders, { domain: 'x`) || PathPrefix(`/' });
    expect(r.status).toBe(400);

    // Crear un buzón entrega una contraseña: solo el propietario o un administrador.
    r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes`, memberHeaders, { domainId: domainA, localPart: 'Hola' });
    expect(r.status).toBe(403);
    r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes`, ownerHeaders, { domainId: domainA, localPart: 'Hola' });
    expect(r.status, r.raw).toBe(201);
    expect(r.json.password).toBe('Contraseña-Del-Buzon-1');
    expect(r.json.mailbox.email).toBe('hola@tienda.example');
    mailboxA = r.json.mailbox.id;
    for (const a of listAudit({ action: 'mailway_' })) expect(String(a.detail)).not.toContain('Contraseña');

    // Recursos del otro proyecto (otro cliente de Mailway).
    r = await call('POST', `/api/projects/${projC.id}/mail/domains`, admin(), { domain: 'blog.example' });
    domainC = r.json.domain.id;
    r = await call('POST', `/api/projects/${projC.id}/mail/mailboxes`, admin(), { domainId: domainC, localPart: 'info' });
    mailboxC = r.json.mailbox.id;

    const view = await call('GET', `/api/projects/${projA.id}/mail`, memberHeaders);
    expect(view.status).toBe(200);
    expect(view.json.linked).toBe(true);
    expect(view.json.canManage).toBe(false);
    expect(view.json.summary.domains.map((d: Json) => d.id)).toEqual([domainA]);
    expect(view.json.summary.mailboxes.map((m: Json) => m.id)).toEqual([mailboxA]);
    expect(view.json.panelUrl).toBe(MW_BASE);
  });

  it('un recurso de otro cliente responde 404 y nunca llega a Mailway', async () => {
    const intentos: [string, string, unknown?][] = [
      ['POST', `/api/projects/${projA.id}/mail/domains/${domainC}/verify`],
      ['GET', `/api/projects/${projA.id}/mail/domains/${domainC}/dns`],
      ['GET', `/api/projects/${projA.id}/mail/domains/${domainC}/cloudflare`],
      ['POST', `/api/projects/${projA.id}/mail/domains/${domainC}/cloudflare/apply`, {}],
      ['GET', `/api/projects/${projA.id}/mail/domains/${domainC}/zonefile`],
      ['GET', `/api/projects/${projA.id}/mail/domains/${domainC}/webmail`],
      ['POST', `/api/projects/${projA.id}/mail/domains/${domainC}/webmail`],
      ['POST', `/api/projects/${projA.id}/mail/domains/${domainC}/webmail/verify`],
      ['POST', `/api/projects/${projA.id}/mail/domains/${domainC}/webmail/cloudflare`],
      ['POST', `/api/projects/${projA.id}/mail/domains/${domainC}/webmail/primary`],
      ['POST', `/api/projects/${projA.id}/mail/mailboxes`, { domainId: domainC, localPart: 'intruso' }],
      ['POST', `/api/projects/${projA.id}/mail/mailboxes/${mailboxC}/password`],
      ['POST', `/api/projects/${projA.id}/mail/mailboxes/${mailboxC}/setup-link`, {}],
      ['DELETE', `/api/projects/${projA.id}/mail/mailboxes/${mailboxC}`],
      ['POST', `/api/projects/${projA.id}/mail/connect`, { serviceId: apiService.id, mailboxId: mailboxC, mode: 'smtp' }],
    ];
    for (const [method, url, body] of intentos) {
      mw.calls = [];
      const r = await call(method as 'GET', url, ownerHeaders, body);
      expect(r.status, `${method} ${url}: ${r.raw}`).toBe(404);
      const tocados = mw.calls.filter((c) => c.path.includes(domainC) || c.path.includes(mailboxC) || c.method !== 'GET');
      expect(tocados, `${method} ${url}`).toEqual([]);
    }
    expect(mw.mailboxes.some((m) => m.id === mailboxC)).toBe(true);
  });

  it('las operaciones sobre recursos propios funcionan con los permisos adecuados', async () => {
    let r = await call('POST', `/api/projects/${projA.id}/mail/domains/${domainA}/verify`, memberHeaders);
    expect(r.status, r.raw).toBe(200);
    expect(r.json.domain.status).toBe('active');
    r = await call('GET', `/api/projects/${projA.id}/mail/domains/${domainA}/dns`, memberHeaders);
    expect(r.json.records[0].type).toBe('MX');
    r = await call('GET', `/api/projects/${projA.id}/mail/domains/${domainA}/cloudflare`, memberHeaders);
    expect(r.json.summary.create).toBe(1);
    r = await call('POST', `/api/projects/${projA.id}/mail/domains/${domainA}/cloudflare/apply`, memberHeaders, {});
    expect(r.status).toBe(403);
    r = await call('POST', `/api/projects/${projA.id}/mail/domains/${domainA}/cloudflare/apply`, ownerHeaders, { replaceConflicts: true });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.applied).toHaveLength(1);

    r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes/${mailboxA}/password`, memberHeaders);
    expect(r.status).toBe(403);
    r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes/${mailboxA}/password`, ownerHeaders);
    expect(r.json.password).toBe('Contraseña-Nueva-2');

    // Pedir la contraseña en el enlace sin darla no la incluye (no fuerza un cambio en Mailway).
    r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes/${mailboxA}/setup-link`, memberHeaders, { includePassword: true });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.hasPassword).toBe(false);
    // Con contraseña, solo quien gestiona el proyecto (Mailway la comprueba: sería un oráculo).
    r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes/${mailboxA}/setup-link`, memberHeaders, {
      includePassword: true,
      password: 'Contraseña-Nueva-2',
    });
    expect(r.status).toBe(403);
    r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes/${mailboxA}/setup-link`, ownerHeaders, {
      includePassword: true,
      password: 'Contraseña-Nueva-2',
    });
    expect(r.json.url).toContain('/conectar/');
    expect(r.json.hasPassword).toBe(true);
    for (const a of listAudit({ action: 'mailway_setup_link' })) {
      expect(String(a.detail)).not.toContain('conectar');
      expect(String(a.detail)).not.toContain('Contraseña');
    }
  });

  it('conectar un servicio fusiona las variables, no pisa las puestas a mano y no devuelve ni audita secretos', async () => {
    setEnv(apiService.id, { EXISTENTE: 'se-conserva', SMTP_HOST: 'antiguo.example.com' });
    let r = await call('POST', `/api/projects/${projA.id}/mail/connect`, memberHeaders, {
      serviceId: apiService.id,
      mailboxId: mailboxA,
      mode: 'smtp',
    });
    expect(r.status).toBe(403);
    r = await call('POST', `/api/projects/${projA.id}/mail/connect`, ownerHeaders, {
      serviceId: otherService.id,
      mailboxId: mailboxA,
      mode: 'smtp',
    });
    expect(r.status).toBe(404);

    r = await call('POST', `/api/projects/${projA.id}/mail/connect`, ownerHeaders, {
      serviceId: apiService.id,
      mailboxId: mailboxA,
      mode: 'smtp',
    });
    expect(r.status, r.raw).toBe(200);
    expect(r.json).toMatchObject({ ok: true, needsRedeploy: true });
    // SMTP_HOST tenía otro valor puesto a mano: se respeta y se informa.
    expect(r.json.keys).toEqual(['SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']);
    expect(r.json.kept).toEqual(['SMTP_HOST']);
    expect(r.raw).not.toContain('ContraseñaDeAplicacion');
    const smtpPass = getEnv(apiService.id).SMTP_PASS;
    expect(smtpPass).toMatch(/^ContraseñaDeAplicacion-Secreta-/);
    expect(getEnv(apiService.id)).toEqual({
      EXISTENTE: 'se-conserva',
      SMTP_HOST: 'antiguo.example.com',
      SMTP_PORT: '587',
      SMTP_SECURE: 'false',
      SMTP_USER: 'hola@tienda.example',
      SMTP_PASS: smtpPass,
      SMTP_FROM: 'hola@tienda.example',
    });
    const appPwCall = mw.calls.find((c) => c.path.endsWith('/app-passwords'));
    expect(appPwCall).toBeDefined();

    r = await call('POST', `/api/projects/${projA.id}/mail/connect`, ownerHeaders, {
      serviceId: apiService.id,
      mailboxId: mailboxA,
      mode: 'api',
    });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.keys).toEqual(['MAILWAY_API_URL', 'MAILWAY_API_KEY', 'MAIL_FROM']);
    expect(r.raw).not.toContain('ClaveApiSecreta');
    const env = getEnv(apiService.id);
    expect(env.MAILWAY_API_KEY).toMatch(/^mw_ClaveApiSecreta_/);
    expect(env.MAILWAY_API_URL).toBe(MW_BASE);
    expect(env.SMTP_PASS).toBe(smtpPass);
    expect(env.EXISTENTE).toBe('se-conserva');

    for (const a of listAudit({ action: 'mailway_service_connected' })) {
      expect(String(a.detail)).not.toContain('Secreta');
      expect(String(a.detail)).not.toContain('mw_Clave');
    }
  });

  it('borrar un buzón exige gestionar el proyecto', async () => {
    let r = await call('DELETE', `/api/projects/${projA.id}/mail/mailboxes/${mailboxA}`, memberHeaders);
    expect(r.status).toBe(403);
    r = await call('DELETE', `/api/projects/${projA.id}/mail/mailboxes/${mailboxA}`, ownerHeaders);
    expect(r.status, r.raw).toBe(200);
    expect(mw.mailboxes.some((m) => m.id === mailboxA)).toBe(false);
  });

  it('recupera el vínculo desde la referencia de Mailway si Skyway lo ha perdido', async () => {
    deleteMailwayLink(projA.id);
    const r = await call('GET', `/api/projects/${projA.id}/mail`, memberHeaders);
    expect(r.status, r.raw).toBe(200);
    expect(r.json.linked).toBe(true);
    expect(getMailwayLink(projA.id)).toBeDefined();
    expect(listAudit({ action: 'mailway_link_restored' }).length).toBe(1);
  });

  it('si el cliente pasa a otra referencia, deja de operarse desde el proyecto', async () => {
    const client = mw.clients.find((c) => c.id === getMailwayLink(projA.id)!.client_id)!;
    client.externalRef = 'otra-integracion:1';
    const r = await call('POST', `/api/projects/${projA.id}/mail/domains/${domainA}/verify`, ownerHeaders);
    expect(r.status).toBe(409);
    client.externalRef = `skyway:project:${projA.id}`;
  });

  it('desactivar el correo suelta la referencia en Mailway y conserva sus datos', async () => {
    let r = await call('DELETE', `/api/projects/${projA.id}/mail/link`, memberHeaders);
    expect(r.status).toBe(403);
    const clientId = getMailwayLink(projA.id)!.client_id;
    r = await call('DELETE', `/api/projects/${projA.id}/mail/link`, ownerHeaders);
    expect(r.status, r.raw).toBe(200);
    expect(getMailwayLink(projA.id)).toBeUndefined();
    expect(mw.clients.find((c) => c.id === clientId)?.externalRef).toBeNull();
    expect(mw.domains.some((d) => d.clientId === clientId)).toBe(true);
    r = await call('GET', `/api/projects/${projA.id}/mail`, ownerHeaders);
    expect(r.json.linked).toBe(false);
  });

  it('si Mailway no encuentra el cliente vinculado, lo indica sin borrar nada y permite desactivarlo', async () => {
    const projD = createProject('Huérfano', 'huerfano', null, null);
    insertMailwayLink({ project_id: projD.id, client_id: 'cli_borrado', client_name: 'Borrado', created_by: null });
    let r = await call('GET', `/api/projects/${projD.id}/mail`, admin());
    expect(r.status, r.raw).toBe(200);
    expect(r.json.linked).toBe(true);
    expect(r.json.summary).toBeUndefined();
    expect(r.json.notice).toMatch(/No se encuentra en Mailway/);
    expect(getMailwayLink(projD.id)).toBeDefined();
    r = await call('DELETE', `/api/projects/${projD.id}/mail/link`, admin());
    expect(r.status, r.raw).toBe(200);
    expect(getMailwayLink(projD.id)).toBeUndefined();
  });

  it('Mailway caído: 502 con mensaje, nunca 401', async () => {
    mw.down = true;
    resetMailwayCaches();
    const r = await call('GET', `/api/projects/${projC.id}/mail`, admin());
    expect(r.status).toBe(502);
    expect(r.json.error).toMatch(/No se ha podido conectar con Mailway/);
    mw.down = false;
  });
});

// ---------- puente de Traefik ----------

describe('puente de Traefik', () => {
  beforeAll(() => {
    // Un dominio que ya sirve una aplicación de Skyway (blog.cliente.com, en beforeAll general).
    mw.traefikConfig = {
      http: {
        routers: {
          'mailway-bueno': { rule: 'Host(`webmail.acme.com`)', entryPoints: ['websecure'], service: 'mailway-webmail', tls: { certResolver: 'le' } },
          'mailway-bueno-http': { rule: 'Host(`webmail.acme.com`)', entryPoints: ['web'], service: 'mailway-webmail', middlewares: ['mailway-https'] },
          'mailway-robo': { rule: 'Host(`blog.cliente.com`)', entryPoints: ['websecure'], service: 'mailway-webmail' },
          'mailway-inyeccion': { rule: 'Host(`x.acme.com`) || PathPrefix(`/`)', entryPoints: ['web'], service: 'mailway-webmail' },
          'mailway-panel-traefik': { rule: 'Host(`t.acme.com`)', entryPoints: ['websecure'], service: 'api@internal' },
        },
        services: {
          'mailway-webmail': { loadBalancer: { servers: [{ url: 'http://mailway-webmail:80' }] } },
        },
        middlewares: { 'mailway-https': { redirectScheme: { scheme: 'https', permanent: true } } },
      },
    };
    resetMailwayTraefikState();
  });

  it('rechaza las peticiones que llegan reenviadas por Traefik desde internet', async () => {
    for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip']) {
      const r = await app.inject({ method: 'GET', url: '/api/traefik/mailway', headers: { [h]: '203.0.113.9' } });
      expect(r.statusCode).toBe(404);
    }
  });

  it('sirve la configuración saneada con el token de Traefik', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/traefik/mailway' });
    expect(r.statusCode).toBe(200);
    const cfg = r.json();
    expect(Object.keys(cfg.http.routers).sort()).toEqual(['mailway-bueno', 'mailway-bueno-http']);
    expect(cfg.http.services['mailway-webmail'].loadBalancer.servers[0].url).toBe('http://mailway-webmail:80');
    expect(r.body).not.toContain('blog.cliente.com');
    expect(r.body).not.toContain('PathPrefix');
    expect(r.body).not.toContain('@internal');
    const peticion = mw.calls.find((c) => c.path === '/api/traefik/config');
    expect(peticion?.traefik).toBe(TRAEFIK_TOKEN);
    expect(peticion?.auth).toBeNull();
    const status = await call2('GET', '/api/mailway/config');
    expect(status.json.traefik.routers).toBe(2);
    expect(status.json.traefik.dropped.length).toBe(3);
  });

  it('si Mailway cae, sigue sirviendo la última configuración buena (memoria y Ajustes)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 10_000);
      mw.down = true;
      let r = await app.inject({ method: 'GET', url: '/api/traefik/mailway' });
      expect(r.statusCode).toBe(200);
      expect(Object.keys(r.json().http.routers)).toHaveLength(2);
      // Sin memoria (reinicio del panel): la copia de Ajustes.
      resetMailwayTraefikState();
      r = await app.inject({ method: 'GET', url: '/api/traefik/mailway' });
      expect(Object.keys(r.json().http.routers)).toHaveLength(2);
      const status = await call2('GET', '/api/mailway/config');
      expect(status.json.traefik.error).toMatch(/No se ha podido conectar/);
    } finally {
      mw.down = false;
      vi.useRealTimers();
    }
  });

  it('la copia guardada se vuelve a sanear: un dominio que ahora es de Skyway no se sirve', async () => {
    createService(projC.id, 'Webmail propio', 'webmail-propio', 'git', gitCfg(['webmail.acme.com']));
    mw.down = true;
    resetMailwayTraefikState();
    try {
      const r = await app.inject({ method: 'GET', url: '/api/traefik/mailway' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({});
    } finally {
      mw.down = false;
    }
  });

  it('si Mailway rota el token de Traefik, se pide el nuevo y se reintenta', async () => {
    mw.traefikToken = 'traefik-token-rotado-2';
    resetMailwayTraefikState();
    mw.calls = [];
    const r = await app.inject({ method: 'GET', url: '/api/traefik/mailway' });
    expect(r.statusCode).toBe(200);
    expect(getSetting('mailway.traefikToken')).toBe('traefik-token-rotado-2');
    expect(mw.calls.filter((c) => c.path === '/api/traefik/config').map((c) => c.traefik)).toEqual([
      TRAEFIK_TOKEN,
      'traefik-token-rotado-2',
    ]);
  });
});

async function call2(method: 'GET', url: string) {
  return call(method, url, admin());
}
