/**
 * Regresiones de la revisión de la integración con Mailway: contratos con la
 * API de Mailway (longitudes, formato de buzón, credenciales que se acumulan,
 * referencias ajenas) y seguridad (planes, buzones reservados, oráculo de
 * contraseñas, cuentas suspendidas, cuentas de Cloudflare del operador,
 * dominios de otros inquilinos, destinos del puente de Traefik y URLs que
 * llegan de Mailway). Cada prueba afirma el comportamiento SEGURO.
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
  getEnv,
  getMailwayLink,
  getSetting,
  initDb,
  insertApiToken,
  listAudit,
  setSetting,
  setUserProjects,
  updateService,
  updateWorkspace,
} from '../src/db';
import { resetMailwayCaches } from '../src/mailway';
import { bridgeOptions, resetMailwayTraefikState, sanitizeTraefikConfig } from '../src/mailwaytraefik';
import type { GitConfig, ProjectRow, ServiceRow, UserRow } from '../src/types';
import { hashPassword, randomToken } from '../src/util';
import { MW_BASE, MW_TOKEN, fakeFetch, mw } from './mailwayfake';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const PANEL_SKYWAY = 'panel.skyway.example';

let app: FastifyInstance;
let adminCookie = '';
const admin = () => ({ cookie: adminCookie, ...SAME_ORIGIN });

let wsA: { id: string };
let ownerA: Record<string, string>;
let owner2A: Record<string, string>;
let memberA: Record<string, string>;
let projA: ProjectRow;
let svcA: ServiceRow;
let ownerB: Record<string, string>;
let projB: ProjectRow;
let svcB: ServiceRow;
let domainA = '';
let mailboxA = '';

function bearerFor(user: UserRow): Record<string, string> {
  const secret = `${API_TOKEN_PREFIX}${randomToken(24)}`;
  insertApiToken({ user_id: user.id, name: 'pruebas', token_hash: hashApiToken(secret), prefix: secret.slice(0, 12), expires_at: null });
  return { authorization: `Bearer ${secret}` };
}

async function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, headers: Record<string, string>, body?: unknown) {
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

function gitCfg(domains: string[] = [], port = 3000): GitConfig {
  return { repoUrl: 'https://github.com/x/y', branch: 'main', port, domains, webhookSecret: 'w' } as GitConfig;
}

const clientOf = (projectId: string) => mw.clients.find((c) => c.id === getMailwayLink(projectId)?.client_id)!;
const mailwayCalls = (pred: (c: (typeof mw.calls)[number]) => boolean) => mw.calls.filter(pred);

beforeAll(async () => {
  process.env.SKYWAY_DOMAIN = PANEL_SKYWAY;
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

  const r = await call('PUT', '/api/mailway/config', admin(), { baseUrl: MW_BASE, token: MW_TOKEN });
  expect(r.status, r.raw).toBe(200);
  // Aprende los hosts de la instancia (panel, webmail, servidor de correo).
  expect((await call('POST', '/api/mailway/test', admin(), {})).status).toBe(200);

  wsA = createWorkspaceRow('Cliente Correo', { modules_override: JSON.stringify(['mail', 'domains']) });
  projA = createProject('Tienda', 'tienda', null, wsA.id);
  svcA = createService(projA.id, 'API', 'api', 'git', gitCfg([], 3000));
  ownerA = bearerFor(createUser('owner@example.com', hashPassword('contraseña1'), 'owner', wsA.id));
  owner2A = bearerFor(createUser('owner2@example.com', hashPassword('contraseña1'), 'owner', wsA.id));
  const member = createUser('member@example.com', hashPassword('contraseña1'), 'member', wsA.id);
  setUserProjects(member.id, [projA.id]);
  memberA = bearerFor(member);

  const wsB = createWorkspaceRow('Inquilino', { modules_override: JSON.stringify(['mail', 'domains']) });
  projB = createProject('Atacante', 'atacante', null, wsB.id);
  svcB = createService(projB.id, 'Web', 'web', 'git', gitCfg([], 3000));
  ownerB = bearerFor(createUser('ownerb@example.com', hashPassword('contraseña1'), 'owner', wsB.id));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.SKYWAY_DOMAIN;
  await app.close();
  closeDb();
});

beforeEach(() => {
  mw.calls = [];
});

// ======================= permisos (R1–R4) =======================

describe('activación y plan (R1, #8)', () => {
  it('R1: el propietario no elige el plan; recibe el predeterminado. El administrador sí elige', async () => {
    let opts = await call('GET', `/api/projects/${projA.id}/mail/options`, ownerA);
    expect(opts.status, opts.raw).toBe(200);
    expect(opts.json.canChoosePlan).toBe(false);
    expect(opts.json.plans.map((p: Json) => p.id)).toEqual(['pln_1']);

    let r = await call('POST', `/api/projects/${projA.id}/mail/link`, ownerA, { mode: 'create', planId: 'pln_2' });
    expect(r.status).toBe(403);
    expect(mailwayCalls((c) => c.path === '/api/integrations/clients/ensure')).toEqual([]);

    // Plan predeterminado configurado por el administrador.
    r = await call('PUT', '/api/mailway/config', admin(), { defaultPlanId: 'pln_2' });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.config.defaultPlanId).toBe('pln_2');
    opts = await call('GET', `/api/projects/${projA.id}/mail/options`, ownerA);
    expect(opts.json.plans.map((p: Json) => p.id)).toEqual(['pln_2']);

    r = await call('POST', `/api/projects/${projA.id}/mail/link`, ownerA, { mode: 'create' });
    expect(r.status, r.raw).toBe(201);
    const ensure = mailwayCalls((c) => c.path === '/api/integrations/clients/ensure');
    expect((ensure[0].body as Json).planId).toBe('pln_2');
    expect(clientOf(projA.id).planId).toBe('pln_2');

    // El administrador ve todos los planes y puede elegir.
    opts = await call('GET', `/api/projects/${projB.id}/mail/options`, admin());
    expect(opts.json.canChoosePlan).toBe(true);
    expect(opts.json.plans.map((p: Json) => p.id)).toEqual(['pln_1', 'pln_2']);
    expect((await call('PUT', '/api/mailway/config', admin(), { defaultPlanId: '' })).status).toBe(200);
  });

  it('#8: un proyecto de un carácter recibe un nombre de cliente válido; un nombre de 1 carácter se rechaza', async () => {
    const corto = createProject('X', 'x', null, wsA.id);
    let r = await call('POST', `/api/projects/${corto.id}/mail/link`, admin(), { mode: 'create', name: 'a' });
    expect(r.status).toBe(400);
    const opts = await call('GET', `/api/projects/${corto.id}/mail/options`, admin());
    expect(opts.json.defaultName).toBe('Proyecto X');
    r = await call('POST', `/api/projects/${corto.id}/mail/link`, admin(), { mode: 'create' });
    expect(r.status, r.raw).toBe(201);
    expect(clientOf(corto.id).name).toBe('Proyecto X');
  });
});

describe('buzones y enlaces (R2, R3, #6, #7)', () => {
  it('R2: un miembro no crea buzones; los nombres reservados solo los crea un administrador', async () => {
    let r = await call('POST', `/api/projects/${projA.id}/mail/domains`, memberA, { domain: 'tienda.com' });
    expect(r.status, r.raw).toBe(201);
    domainA = r.json.domain.id;

    r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes`, memberA, { domainId: domainA, localPart: 'info' });
    expect(r.status).toBe(403);
    for (const reservado of ['postmaster', 'admin', 'Abuse', 'hostmaster', 'webmaster', 'root']) {
      r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes`, ownerA, { domainId: domainA, localPart: reservado });
      expect(r.status, reservado).toBe(403);
    }
    expect(mailwayCalls((c) => c.path === '/api/mailboxes' && c.method === 'POST')).toEqual([]);

    r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes`, ownerA, { domainId: domainA, localPart: 'noreply' });
    expect(r.status, r.raw).toBe(201);
    r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes`, ownerA, { domainId: domainA, localPart: 'hola' });
    expect(r.status, r.raw).toBe(201);
    mailboxA = r.json.mailbox.id;
    r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes`, admin(), { domainId: domainA, localPart: 'postmaster' });
    expect(r.status, r.raw).toBe(201);
  });

  it('#6 y #7: «+» en el buzón y nombres visibles de más de 80 caracteres se rechazan antes de llegar a Mailway', async () => {
    let r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes`, ownerA, { domainId: domainA, localPart: 'ventas+es' });
    expect(r.status).toBe(400);
    expect(r.json.error).not.toMatch(/«\+»/);
    r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes`, ownerA, {
      domainId: domainA,
      localPart: 'ventas',
      displayName: 'N'.repeat(81),
    });
    expect(r.status).toBe(400);
    expect(mailwayCalls((c) => c.path === '/api/mailboxes')).toEqual([]);
    r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes`, ownerA, {
      domainId: domainA,
      localPart: 'ventas_es',
      displayName: 'N'.repeat(80),
    });
    expect(r.status, r.raw).toBe(201);
  });

  it('R3: el enlace con contraseña es solo para quien gestiona el proyecto y tiene un tope propio', async () => {
    let r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes/${mailboxA}/setup-link`, memberA, {
      includePassword: true,
      password: 'adivinanza1',
    });
    expect(r.status).toBe(403);
    expect(mailwayCalls((c) => c.path.endsWith('/setup-links'))).toEqual([]);
    // Sin contraseña, el miembro sí puede enviar el enlace.
    r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes/${mailboxA}/setup-link`, memberA, {});
    expect(r.status, r.raw).toBe(200);
    expect(r.json.hasPassword).toBe(false);

    for (let i = 0; i < 5; i++) {
      r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes/${mailboxA}/setup-link`, owner2A, {
        includePassword: true,
        password: `intento-${i}`,
      });
      expect(r.status, r.raw).toBe(200);
    }
    r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes/${mailboxA}/setup-link`, owner2A, {
      includePassword: true,
      password: 'intento-6',
    });
    expect(r.status).toBe(429);
  });
});

// ======================= credenciales (#1, #2, #3) =======================

describe('conectar servicios y credenciales (#1, #2, #3)', () => {
  it('#1: el nombre de la clave de API cabe en los 60 caracteres de Mailway con nombres largos', async () => {
    const largo = createProject('Plataforma de reservas para clínicas dentales', 'plataforma-reservas', null, wsA.id);
    const svc = createService(largo.id, 'Servidor de notificaciones', 'servidor-de-notificaciones', 'git', gitCfg());
    expect((await call('POST', `/api/projects/${largo.id}/mail/link`, ownerA, { mode: 'create' })).status).toBe(201);
    const d = await call('POST', `/api/projects/${largo.id}/mail/domains`, ownerA, { domain: 'clinicas.example' });
    const b = await call('POST', `/api/projects/${largo.id}/mail/mailboxes`, ownerA, { domainId: d.json.domain.id, localPart: 'avisos' });
    const r = await call('POST', `/api/projects/${largo.id}/mail/connect`, ownerA, { serviceId: svc.id, mailboxId: b.json.mailbox.id, mode: 'api' });
    expect(r.status, r.raw).toBe(200);
    const created = mw.apiKeys.find((k) => k.senderMailboxId === b.json.mailbox.id)!;
    expect(created.name).toBe('Skyway · servidor-de-notificaciones');
    expect(created.name.length).toBeLessThanOrEqual(60);
  });

  it('#3: volver a conectar revoca la credencial anterior del mismo servicio y tipo', async () => {
    const connect = (mode: 'smtp' | 'api') =>
      call('POST', `/api/projects/${projA.id}/mail/connect`, ownerA, { serviceId: svcA.id, mailboxId: mailboxA, mode });
    let r = await connect('smtp');
    expect(r.status, r.raw).toBe(200);
    const primera = getEnv(svcA.id).SMTP_PASS;
    r = await connect('smtp');
    expect(r.status, r.raw).toBe(200);
    expect(r.json.revoked).toBe(1);
    expect(getEnv(svcA.id).SMTP_PASS).not.toBe(primera);
    const smtp = mw.appPasswords.filter((a) => a.name === 'skyway:api');
    expect(smtp).toHaveLength(2);
    expect(smtp.filter((a) => !a.revokedAt)).toHaveLength(1);

    // Muchas reconexiones no agotan el límite de 25 contraseñas activas del buzón.
    for (let i = 0; i < 3; i++) expect((await connect('smtp')).status).toBe(200);
    expect(mw.appPasswords.filter((a) => a.mailboxId === mailboxA && !a.revokedAt)).toHaveLength(1);

    r = await connect('api');
    expect(r.status, r.raw).toBe(200);
    expect(r.json.revoked).toBe(0);
    r = await connect('api');
    expect(r.json.revoked).toBe(1);
    const claves = mw.apiKeys.filter((k) => k.name === 'Skyway · api');
    expect(claves.filter((k) => !k.revokedAt)).toHaveLength(1);
    // Cambiar de modo no revoca la del otro tipo: su variable sigue en el servicio.
    expect(mw.appPasswords.filter((a) => a.name === 'skyway:api' && !a.revokedAt)).toHaveLength(1);
    expect(listAudit({ action: 'mailway_service_connected' }).some((a) => String(a.detail).includes('revocada'))).toBe(true);
  });

  it('#3: las credenciales se ven en el resumen y se revocan desde Skyway (solo quien gestiona el proyecto)', async () => {
    const view = await call('GET', `/api/projects/${projA.id}/mail`, memberA);
    expect(view.status, view.raw).toBe(200);
    const app = view.json.summary.appPasswords.find((a: Json) => !a.revokedAt);
    const key = view.json.summary.apiKeys.find((k: Json) => !k.revokedAt);
    expect(key.createdBySkyway).toBe(true);
    expect(view.raw).not.toContain('ClaveApiSecreta');

    expect((await call('DELETE', `/api/projects/${projA.id}/mail/app-passwords/${app.id}`, memberA)).status).toBe(403);
    let r = await call('DELETE', `/api/projects/${projA.id}/mail/app-passwords/${app.id}`, ownerA);
    expect(r.status, r.raw).toBe(200);
    expect(mw.appPasswords.find((a) => a.id === app.id)?.revokedAt).toBeTruthy();

    r = await call('DELETE', `/api/projects/${projA.id}/mail/api-keys/${key.id}`, ownerA);
    expect(r.status, r.raw).toBe(200);
    expect(mw.apiKeys.find((k) => k.id === key.id)?.revokedAt).toBeTruthy();
    // Revocar dos veces no falla.
    expect((await call('DELETE', `/api/projects/${projA.id}/mail/api-keys/${key.id}`, ownerA)).status).toBe(200);
    // La de otro cliente no existe para este proyecto (y no llega a Mailway).
    const ajena = mw.apiKeys.find((k) => k.clientId !== clientOf(projA.id).id)!;
    mw.calls = [];
    expect((await call('DELETE', `/api/projects/${projA.id}/mail/api-keys/${ajena.id}`, ownerA)).status).toBe(404);
    expect(mailwayCalls((c) => c.method === 'DELETE')).toEqual([]);
    expect(listAudit({ action: 'mailway_api_key_revoked' }).length).toBeGreaterThan(0);
  });

  it('#2: eliminar un buzón revoca antes las claves de API de Skyway; con una clave ajena, Mailway lo impide', async () => {
    let r = await call('POST', `/api/projects/${projA.id}/mail/connect`, ownerA, { serviceId: svcA.id, mailboxId: mailboxA, mode: 'api' });
    expect(r.status, r.raw).toBe(200);
    // Una clave creada en Mailway por el cliente, con el mismo remitente.
    const propia = mw.mailboxes.find((m) => m.id === mailboxA)!;
    mw.apiKeys.push({
      id: 'key_manual',
      clientId: clientOf(projA.id).id,
      name: 'Tienda online',
      prefix: 'mw_Manu',
      senderMailboxId: propia.id,
      senderEmail: propia.email,
      revokedAt: null,
      createdAt: 1,
    });
    r = await call('DELETE', `/api/projects/${projA.id}/mail/mailboxes/${mailboxA}`, ownerA);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/Revoque esas claves/);
    expect(mw.apiKeys.filter((k) => k.name === 'Skyway · api' && !k.revokedAt)).toHaveLength(0);

    expect((await call('DELETE', `/api/projects/${projA.id}/mail/api-keys/key_manual`, ownerA)).status).toBe(200);
    r = await call('DELETE', `/api/projects/${projA.id}/mail/mailboxes/${mailboxA}`, ownerA);
    expect(r.status, r.raw).toBe(200);
    expect(mw.mailboxes.some((m) => m.id === mailboxA)).toBe(false);
    const box = await call('POST', `/api/projects/${projA.id}/mail/mailboxes`, ownerA, { domainId: domainA, localPart: 'hola' });
    mailboxA = box.json.mailbox.id;
  });
});

// ======================= cuentas suspendidas (R4) =======================

describe('cuentas suspendidas (R4)', () => {
  it('con la cuenta suspendida no se crean dominios, buzones, conexiones ni clientes', async () => {
    const libre = createProject('Suspendido', 'suspendido', null, wsA.id);
    updateWorkspace(wsA.id, { status: 'suspended' });
    try {
      const intentos: [string, string, unknown][] = [
        ['POST', `/api/projects/${projA.id}/mail/domains`, { domain: 'suspendida.com' }],
        ['POST', `/api/projects/${projA.id}/mail/mailboxes`, { domainId: domainA, localPart: 'nuevo' }],
        ['POST', `/api/projects/${projA.id}/mail/connect`, { serviceId: svcA.id, mailboxId: mailboxA, mode: 'smtp' }],
        ['POST', `/api/projects/${libre.id}/mail/link`, { mode: 'create' }],
      ];
      for (const [method, url, body] of intentos) {
        mw.calls = [];
        const r = await call(method as 'POST', url, ownerA, body);
        expect(r.status, `${url}: ${r.raw}`).toBe(403);
        expect(r.json.error).toMatch(/suspendida/);
        expect(mailwayCalls((c) => c.method !== 'GET'), url).toEqual([]);
      }
      const view = await call('GET', `/api/projects/${projA.id}/mail`, ownerA);
      expect(view.json.accountSuspended).toBe(true);
    } finally {
      updateWorkspace(wsA.id, { status: 'active' });
    }
  });

  it('con el cliente suspendido en Mailway tampoco', async () => {
    const client = clientOf(projA.id);
    client.suspended = true;
    try {
      const r = await call('POST', `/api/projects/${projA.id}/mail/domains`, ownerA, { domain: 'otra.com' });
      expect(r.status).toBe(409);
      expect(r.json.error).toMatch(/suspendido en Mailway/);
      expect(mailwayCalls((c) => c.path === '/api/domains')).toEqual([]);
    } finally {
      client.suspended = false;
    }
  });
});

// ======================= Cloudflare (C1) =======================

describe('Cloudflare solo con las cuentas del cliente (C1)', () => {
  it('quien no es administrador pide a Mailway que no use las cuentas de la instancia', async () => {
    let r = await call('GET', `/api/projects/${projA.id}/mail/domains/${domainA}/cloudflare`, memberA);
    expect(r.status, r.raw).toBe(200);
    r = await call('POST', `/api/projects/${projA.id}/mail/domains/${domainA}/cloudflare/apply`, ownerA, { replaceConflicts: true });
    expect(r.status, r.raw).toBe(200);
    const cf = mailwayCalls((c) => c.path.includes('/cloudflare'));
    expect(cf.map((c) => c.path)).toEqual([
      `/api/domains/${domainA}/cloudflare?soloCliente=1`,
      `/api/domains/${domainA}/cloudflare/apply?soloCliente=1`,
    ]);
    mw.calls = [];
    r = await call('GET', `/api/projects/${projA.id}/mail/domains/${domainA}/cloudflare`, admin());
    expect(r.status).toBe(200);
    expect(mailwayCalls((c) => c.path.includes('/cloudflare')).map((c) => c.path)).toEqual([`/api/domains/${domainA}/cloudflare`]);
  });
});

// ======================= referencia externa (R5, R6, #4, #15) =======================

describe('referencia externa del cliente (R5, R6, #4, #15)', () => {
  it('R5: sin referencia o con la de otro proyecto no se opera, tampoco al añadir dominios', async () => {
    const client = clientOf(projA.id);
    for (const ref of [null, 'skyway:project:OTRO']) {
      client.externalRef = ref;
      const view = await call('GET', `/api/projects/${projA.id}/mail`, memberA);
      expect(view.status, view.raw).toBe(200);
      expect(view.json.summary).toBeUndefined();
      expect(view.json.notice).toMatch(ref ? /otra integración/ : /ya no está vinculado/);
      mw.calls = [];
      let r = await call('POST', `/api/projects/${projA.id}/mail/domains`, memberA, { domain: 'ajeno.com' });
      expect(r.status).toBe(409);
      expect(mailwayCalls((c) => c.path === '/api/domains')).toEqual([]);
      r = await call('POST', `/api/projects/${projA.id}/mail/domains/${domainA}/verify`, memberA);
      expect(r.status).toBe(409);
    }
    client.externalRef = `skyway:project:${projA.id}`;
  });

  it('R6/#4: desactivar no borra la referencia de otra integración', async () => {
    const tmp = createProject('Temporal', 'temporal', null, wsA.id);
    expect((await call('POST', `/api/projects/${tmp.id}/mail/link`, ownerA, { mode: 'create' })).status).toBe(201);
    const client = clientOf(tmp.id);
    client.externalRef = 'skyway:project:OTRO';
    const r = await call('DELETE', `/api/projects/${tmp.id}/mail/link`, ownerA);
    expect(r.status, r.raw).toBe(200);
    expect(r.json.released).toBe(false);
    expect(client.externalRef).toBe('skyway:project:OTRO');
    expect(mailwayCalls((c) => c.method === 'DELETE' && c.path.endsWith('/link'))).toEqual([]);
    expect(getMailwayLink(tmp.id)).toBeUndefined();
    // Y no se ofrece recuperarlo: ya es de otra integración.
    const opts = await call('GET', `/api/projects/${tmp.id}/mail/options`, ownerA);
    expect(opts.json.previous).toMatchObject({ available: false });
    const again = await call('POST', `/api/projects/${tmp.id}/mail/link`, ownerA, { mode: 'previous' });
    expect(again.status).toBe(409);
  });

  it('#15: tras desactivar, el propietario recupera el mismo cliente con sus dominios', async () => {
    const before = clientOf(projA.id);
    let r = await call('DELETE', `/api/projects/${projA.id}/mail/link`, ownerA);
    expect(r.status, r.raw).toBe(200);
    expect(r.json.released).toBe(true);
    expect(before.externalRef).toBeNull();

    const opts = await call('GET', `/api/projects/${projA.id}/mail/options`, ownerA);
    expect(opts.json.previous).toEqual({ clientName: before.name, available: true, reason: null });
    // Un miembro no puede reactivar.
    expect((await call('POST', `/api/projects/${projA.id}/mail/link`, memberA, { mode: 'previous' })).status).toBe(403);
    r = await call('POST', `/api/projects/${projA.id}/mail/link`, ownerA, { mode: 'previous' });
    expect(r.status, r.raw).toBe(201);
    expect(getMailwayLink(projA.id)?.client_id).toBe(before.id);
    expect(before.externalRef).toBe(`skyway:project:${projA.id}`);
    const view = await call('GET', `/api/projects/${projA.id}/mail`, ownerA);
    expect(view.json.summary.domains.map((d: Json) => d.id)).toContain(domainA);
    // El recuerdo se consume: no se puede recuperar dos veces.
    expect(getSetting(`mailway.previousClient:${projA.id}`)).toBeNull();
  });
});

// ======================= dominios de otros (C2, R7, R8) =======================

describe('dominios que pertenecen a otros (C2, R7, R8)', () => {
  const patchDomains = (headers: Record<string, string>, id: string, domains: string[]) =>
    call('PATCH', `/api/services/${id}`, headers, { config: { domains } });

  it('R8: el inquilino no puede asignarse los hosts de Mailway ni el del panel de Skyway', async () => {
    for (const host of ['mail-panel.example.com', 'webmail.example.com', 'mail.example.com', PANEL_SKYWAY]) {
      const r = await patchDomains(ownerB, svcB.id, [host, 'x-mas-largo-para-ganar-prioridad.atacante.com']);
      expect(r.status, host).toBe(409);
    }
    // Tampoco al crear el servicio.
    const r = await call('POST', `/api/projects/${projB.id}/services`, ownerB, {
      type: 'image',
      name: 'Pirata',
      image: 'nginx',
      port: 80,
      domains: ['mail-panel.example.com'],
    });
    expect(r.status).toBe(409);
  });

  it('R7: el inquilino no puede quedarse con un dominio que publica Mailway en Traefik', async () => {
    resetMailwayTraefikState();
    mw.traefikConfig = {
      http: {
        routers: { 'mailway-x': { rule: 'Host(`autoconfig.clienteb.com`)', entryPoints: ['websecure'], service: 'mailway-panel', tls: { certResolver: 'le' } } },
        services: { 'mailway-panel': { loadBalancer: { servers: [{ url: 'http://mailway-panel:4100' }] } } },
      },
    };
    let t = await app.inject({ method: 'GET', url: '/api/traefik/mailway' });
    expect(Object.keys(t.json().http.routers)).toEqual(['mailway-x']);
    const p = await patchDomains(ownerB, svcB.id, ['autoconfig.clienteb.com']);
    expect(p.status, p.raw).toBe(409);
    expect(p.json.error).toMatch(/Mailway/);
    resetMailwayTraefikState();
    t = await app.inject({ method: 'GET', url: '/api/traefik/mailway' });
    expect(Object.keys(t.json().http.routers)).toEqual(['mailway-x']);
  });

  it('un dominio asignado a otro servicio no se puede asignar a un segundo (tampoco el administrador)', async () => {
    let r = await patchDomains(ownerA, svcA.id, ['tienda.cliente.com']);
    expect(r.status, r.raw).toBe(200);
    r = await patchDomains(ownerB, svcB.id, ['TIENDA.cliente.com']);
    expect(r.status).toBe(409);
    expect(r.json.error).not.toMatch(/Tienda/); // no revela de quién es
    r = await patchDomains(admin(), svcB.id, ['tienda.cliente.com']);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/Tienda \/ API/);
    // El propio servicio conserva y reenvía el suyo sin conflicto.
    r = await patchDomains(ownerA, svcA.id, ['tienda.cliente.com', 'www.tienda.cliente.com']);
    expect(r.status, r.raw).toBe(200);
  });

  it('C2: el token nunca viaja por una URL pública cuyo dominio sirve un servicio que no es de Mailway', async () => {
    // Situación anterior a la comprobación: el inquilino ya tenía el dominio.
    const pirata = createService(projB.id, 'Pirata', 'pirata', 'git', gitCfg(['mail-panel.example.com']));
    try {
      resetMailwayCaches();
      mw.calls = [];
      const r = await call('GET', `/api/projects/${projA.id}/mail`, ownerA);
      expect(r.status).toBe(409);
      expect(r.json.error).toMatch(/no se envía el token/);
      expect(mw.calls.filter((c) => c.auth || c.traefik)).toEqual([]);
      // Y el administrador no puede guardar esa URL sin indicar el servicio del panel.
      const put = await call('PUT', '/api/mailway/config', admin(), { baseUrl: 'https://mail-panel.example.com/' });
      expect(put.status).toBe(200); // sin cambios: es la misma URL
      const otra = await call('PUT', '/api/mailway/config', admin(), { baseUrl: 'https://mail-panel.example.com:443', serviceId: svcA.id });
      expect(otra.status).toBe(400);
      expect(otra.json.error).toMatch(/Atacante \/ Pirata/);
    } finally {
      // Se retira el dominio del servicio pirata (en la base, como se creó).
      updateService(pirata.id, pirata.name, gitCfg([]));
    }
    resetMailwayCaches();
    expect((await call('GET', `/api/projects/${projA.id}/mail`, ownerA)).status).toBe(200);
  });
});

// ======================= puente de Traefik (R9, R10, R11) =======================

describe('puente de Traefik (R9, R10, R11)', () => {
  it('R9: los destinos de una sola etiqueta que no son de Mailway se rechazan', () => {
    const opts = bridgeOptions();
    for (const host of ['instance-data', 'metadata', 'ip6-localhost', 'ip6-loopback', 'localhost', 'dockerproxy', 'portainer', 'skyway', 'traefik', 'mailway-']) {
      expect(opts.allowBackendHost(host), host).toBe(false);
    }
    expect(opts.allowBackendHost('mailway-webmail')).toBe(true);
    for (const url of ['http://instance-data', 'http://metadata', 'http://ip6-localhost:80', 'http://dockerproxy:2375', 'http://portainer:9000']) {
      const cfg = { http: { routers: { r: { rule: 'Host(`w.cliente.com`)', entryPoints: ['web'], service: 's' } }, services: { s: { loadBalancer: { servers: [{ url }] } } } } };
      expect(sanitizeTraefikConfig(cfg, opts).config, url).toEqual({});
    }
  });

  it('R10: los contenedores del proyecto de Mailway se comparan enteros, sin confundir «buzon» con «buzon-x»', async () => {
    const panelProject = createProject('Buzón', 'buzon', null, null);
    const panel = createService(panelProject.id, 'Panel', 'panel', 'git', gitCfg(['panel.buzon.example'], 8080));
    createService(panelProject.id, 'Datos', 'datos', 'database', { template: 'postgres', version: '16' });
    const otro = createProject('Buzón X', 'buzon-x', null, wsA.id);
    createService(otro.id, 'Web', 'web', 'git', gitCfg());
    const before = getSetting('mailway.serviceId');
    setSetting('mailway.serviceId', panel.id);
    try {
      const allow = bridgeOptions().allowBackendHost;
      expect(allow('skyway-buzon-panel')).toBe(true);
      expect(allow('skyway-buzon-x-web')).toBe(false);
      expect(allow('skyway-buzon-datos')).toBe(false); // una base de datos nunca es destino
      expect(allow('skyway-buzon-panel-r2')).toBe(false); // sin réplicas configuradas
    } finally {
      setSetting('mailway.serviceId', before);
    }
  });

  it('R11: sin token se mantienen las rutas; solo «Desconectar Mailway» las retira', async () => {
    resetMailwayTraefikState();
    mw.traefikConfig = {
      http: {
        routers: { 'mailway-y': { rule: 'Host(`webmail.clientec.com`)', entryPoints: ['websecure'], service: 'mailway-webmail', tls: { certResolver: 'le' } } },
        services: { 'mailway-webmail': { loadBalancer: { servers: [{ url: 'http://mailway-webmail:80' }] } } },
      },
    };
    let t = await app.inject({ method: 'GET', url: '/api/traefik/mailway' });
    expect(Object.keys(t.json().http.routers)).toEqual(['mailway-y']);

    expect((await call('PUT', '/api/mailway/config', admin(), { token: '' })).status).toBe(200);
    t = await app.inject({ method: 'GET', url: '/api/traefik/mailway' });
    expect(Object.keys(t.json().http.routers)).toEqual(['mailway-y']);
    const cfg = await call('GET', '/api/mailway/config', admin());
    expect(cfg.json.configured).toBe(false);
    expect(cfg.json.traefik.error).toMatch(/Desconecte|desconecte/);

    // Desconectar exige administrador con sesión de navegador.
    expect((await call('POST', '/api/mailway/disconnect', ownerA)).status).toBe(403);
    const r = await call('POST', '/api/mailway/disconnect', admin());
    expect(r.status, r.raw).toBe(200);
    expect(r.json.config).toMatchObject({ configured: false, baseUrl: null, hasToken: false });
    t = await app.inject({ method: 'GET', url: '/api/traefik/mailway' });
    expect(t.json()).toEqual({});
    expect(getSetting('mailway.traefikCache')).toBeNull();
    expect(listAudit({ action: 'mailway_disconnected' })).toHaveLength(1);

    // Se vuelve a conectar para las pruebas siguientes.
    expect((await call('PUT', '/api/mailway/config', admin(), { baseUrl: MW_BASE, token: MW_TOKEN })).status).toBe(200);
  });
});

// ======================= mensajes y URLs de Mailway (#14, R12) =======================

describe('respuestas de Mailway (#14, R12)', () => {
  it('#14: el motivo del 401 de Mailway (token revocado) llega al administrador, sin cerrar la sesión', async () => {
    mw.reject401 = { error: 'El token de gestión ha sido revocado.', code: 'token_revoked' };
    try {
      const r = await call('POST', '/api/mailway/test', admin(), {});
      expect(r.status).toBe(502);
      expect(r.json.error).toMatch(/ha sido revocado/);
      expect(r.json.error).toMatch(/Ajustes → Correo/);
    } finally {
      mw.reject401 = null;
    }
  });

  it('R12: una URL de Mailway que no es http(s) nunca llega a la interfaz', async () => {
    mw.infoOverride = {
      panelUrl: 'javascript:fetch(`/api/auth/me`).then(r=>r.text()).then(alert)',
      webmailUrl: 'javascript:alert(1)',
    };
    try {
      resetMailwayCaches();
      const test = await call('POST', '/api/mailway/test', admin(), {});
      expect(test.status, test.raw).toBe(200);
      expect(test.json.info.panelUrl).toBeNull();
      expect(test.json.info.webmailUrl).toBeNull();
      const st = await call('GET', '/api/mailway/status', memberA);
      expect(st.json.panelUrl).toBe(MW_BASE);
      const view = await call('GET', `/api/projects/${projA.id}/mail`, memberA);
      expect(view.json.panelUrl).toBe(MW_BASE);
      expect(view.json.summary.connection.webmailUrl).toBeNull();
      expect(view.raw).not.toContain('javascript:');
    } finally {
      mw.infoOverride = {};
      resetMailwayCaches();
    }
  });
});
