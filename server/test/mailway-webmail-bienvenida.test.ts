/**
 * Correo del proyecto: «Webmail propio» (interruptor del webmail automático de
 * Mailway y webmail de marca del cliente) y «Configuración inicial» (enlace de
 * bienvenida de la persona de contacto). Mismo doble de Mailway que el resto
 * de pruebas de la integración (`mailwayfake.ts`).
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
  getMailwayLink,
  getSetting,
  initDb,
  insertApiToken,
  listAudit,
  setUserProjects,
  updateWorkspace,
} from '../src/db';
import { resetMailwayCaches } from '../src/mailway';
import type { GitConfig, ProjectRow, ServiceRow, UserRow } from '../src/types';
import { hashPassword, randomToken } from '../src/util';
import { MW_BASE, MW_TOKEN, fakeFetch, mw } from './mailwayfake';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const DAY = 24 * 3_600_000;

let app: FastifyInstance;
let adminCookie = '';
const admin = () => ({ cookie: adminCookie, ...SAME_ORIGIN });

let wsA: { id: string };
let projA: ProjectRow;
let projB: ProjectRow;
let svcB: ServiceRow;
let ownerA: Record<string, string>;
// Segundo propietario de la cuenta: las rutas tienen un tope por usuario y minuto.
let owner2A: Record<string, string>;
let memberA: Record<string, string>;
let ownerB: Record<string, string>;
let domainEmpresa = '';
let domainTienda = '';

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

function gitCfg(domains: string[] = []): GitConfig {
  return { repoUrl: 'https://github.com/x/y', branch: 'main', port: 3000, domains, webhookSecret: 'w' } as GitConfig;
}

const clientOf = (projectId: string) => mw.clients.find((c) => c.id === getMailwayLink(projectId)?.client_id)!;
const autoCalls = () => mw.calls.filter((c) => c.path.endsWith('/webmail-automatico'));
const inviteCalls = () => mw.calls.filter((c) => c.path.includes('/invites'));
const toggle = (projectId: string, headers: Record<string, string>, body: unknown) =>
  call('PUT', `/api/projects/${projectId}/mail/webmail-automatico`, headers, body);
const invites = (projectId: string, extra = '') => `/api/projects/${projectId}/mail/invites${extra}`;

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

  expect((await call('PUT', '/api/mailway/config', admin(), { baseUrl: MW_BASE, token: MW_TOKEN })).status).toBe(200);
  expect((await call('POST', '/api/mailway/test', admin(), {})).status).toBe(200);

  wsA = createWorkspaceRow('Cliente Correo', { modules_override: JSON.stringify(['mail', 'domains']) });
  projA = createProject('Tienda', 'tienda', null, wsA.id);
  ownerA = bearerFor(createUser('owner@example.com', hashPassword('contraseña1'), 'owner', wsA.id));
  owner2A = bearerFor(createUser('owner2@example.com', hashPassword('contraseña1'), 'owner', wsA.id));
  const member = createUser('member@example.com', hashPassword('contraseña1'), 'member', wsA.id);
  setUserProjects(member.id, [projA.id]);
  memberA = bearerFor(member);

  const wsB = createWorkspaceRow('Otra cuenta', { modules_override: JSON.stringify(['mail', 'domains']) });
  projB = createProject('Otro', 'otro', null, wsB.id);
  ownerB = bearerFor(createUser('ownerb@example.com', hashPassword('contraseña1'), 'owner', wsB.id));
  svcB = createService(projB.id, 'Web', 'web', 'git', gitCfg());

  let r = await call('POST', `/api/projects/${projA.id}/mail/link`, ownerA, { mode: 'create', contactEmail: 'Contacto@Empresa.com' });
  expect(r.status, r.raw).toBe(201);
  r = await call('POST', `/api/projects/${projA.id}/mail/domains`, ownerA, { domain: 'empresa.com' });
  expect(r.status, r.raw).toBe(201);
  domainEmpresa = r.json.domain.id;
  r = await call('POST', `/api/projects/${projB.id}/mail/link`, ownerB, { mode: 'create' });
  expect(r.status, r.raw).toBe(201);
  r = await call('POST', `/api/projects/${projB.id}/mail/domains`, ownerB, { domain: 'ajeno.com' });
  expect(r.status, r.raw).toBe(201);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  closeDb();
});

beforeEach(() => {
  mw.calls = [];
});

// ======================= webmail propio (webmail automático) =======================

describe('webmail propio: interruptor del webmail automático', () => {
  it('la vista del correo trae el interruptor global, el del cliente y sus webmail; también para un miembro', async () => {
    const r = await call('GET', `/api/projects/${projA.id}/mail`, memberA);
    expect(r.status, r.raw).toBe(200);
    expect(r.json.features.webmailAutomatico).toBe(true);
    expect(r.json.summary.webmail).toEqual({ automatico: true, domains: [] });
  });

  it('solo quien gestiona el proyecto lo cambia: un miembro u otra cuenta reciben 403 sin llegar a Mailway', async () => {
    let r = await toggle(projA.id, memberA, { activo: false });
    expect(r.status).toBe(403);
    r = await toggle(projA.id, ownerB, { activo: false });
    expect(r.status).toBe(403);
    r = await toggle(projA.id, ownerA, { activo: 'no' });
    expect(r.status).toBe(400);
    r = await toggle(projA.id, ownerA, {});
    expect(r.status).toBe(400);
    expect(autoCalls()).toEqual([]);
    expect(clientOf(projA.id).webmailAutomatico).toBeUndefined();
  });

  it('el propietario lo apaga en el cliente del proyecto y queda registrado', async () => {
    const r = await toggle(projA.id, ownerA, { activo: false });
    expect(r.status, r.raw).toBe(200);
    expect(r.json).toEqual({ automatico: false, global: true, domains: [] });
    expect(autoCalls().map((c) => [c.method, c.path, c.body])).toEqual([
      ['PUT', `/api/clients/${clientOf(projA.id).id}/webmail-automatico`, { activo: false }],
    ]);
    expect(clientOf(projA.id).webmailAutomatico).toBe(false);
    expect(listAudit({ action: 'mailway_webmail_automatico' }).map((a) => a.detail)).toEqual(['Tienda: desactivado']);
    const view = await call('GET', `/api/projects/${projA.id}/mail`, memberA);
    expect(view.json.summary.webmail.automatico).toBe(false);
  });

  it('al encenderlo, Mailway prepara webmail.<dominio> y Skyway reserva el nombre al momento', async () => {
    const r = await toggle(projA.id, ownerA, { activo: true });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.automatico).toBe(true);
    expect(r.json.domains).toEqual([
      {
        hostname: 'webmail.empresa.com',
        status: 'pending_dns',
        detail: expect.any(String),
        automatico: true,
        isPrimary: false,
        url: null,
        conflict: null,
      },
    ]);
    // Sin esperar a la lectura del puente: un servicio de otra cuenta no puede quedárselo.
    expect(JSON.parse(getSetting('mailway.whitelabelHosts') ?? '[]')).toContain('webmail.empresa.com');
    const p = await call('PATCH', `/api/services/${svcB.id}`, ownerB, { config: { domains: ['webmail.empresa.com'] } });
    expect(p.status, p.raw).toBe(409);
  });

  it('el resumen enseña el estado, el principal y el enlace solo en servicio; nada que no sea del cliente', async () => {
    const w = mw.whitelabel.find((x) => x.hostname === 'webmail.empresa.com')!;
    w.status = 'active';
    w.isPrimary = true;
    // Un nombre que no cuelga de ningún dominio del cliente no se enseña aunque Mailway lo devuelva.
    mw.whitelabel.push({
      id: 'wld_raro',
      clientId: clientOf(projA.id).id,
      hostname: 'webmail.ajeno.com',
      kind: 'webmail',
      status: 'active',
      detail: '',
      lastCheckedAt: null,
      activatedAt: null,
      createdAt: 1,
      isPrimary: false,
    });
    try {
      const r = await call('GET', `/api/projects/${projA.id}/mail`, memberA);
      expect(r.json.summary.webmail.domains).toEqual([
        {
          hostname: 'webmail.empresa.com',
          status: 'active',
          detail: expect.any(String),
          automatico: true,
          isPrimary: true,
          url: 'https://webmail.empresa.com',
          conflict: null,
        },
      ]);
      expect(r.raw).not.toContain('webmail.ajeno.com');
      expect(r.raw).not.toContain(w.id);
    } finally {
      mw.whitelabel = mw.whitelabel.filter((x) => x.id !== 'wld_raro');
    }
  });

  it('apagarlo retira los que creó solo y conserva los dados de alta a mano', async () => {
    let r = await call('POST', `/api/projects/${projA.id}/mail/domains`, ownerA, { domain: 'tienda.es' });
    expect(r.status, r.raw).toBe(201);
    domainTienda = r.json.domain.id;
    r = await call('POST', `/api/projects/${projA.id}/mail/domains/${domainTienda}/webmail`, ownerA);
    expect(r.status, r.raw).toBe(201);
    r = await toggle(projA.id, ownerA, { activo: false });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.domains.map((d: Json) => [d.hostname, d.automatico])).toEqual([['webmail.tienda.es', false]]);
    r = await toggle(projA.id, ownerA, { activo: true });
    expect(r.json.domains.map((d: Json) => d.hostname).sort()).toEqual(['webmail.empresa.com', 'webmail.tienda.es']);
  });

  it('con el interruptor global apagado se guarda sin efecto y la vista lo indica', async () => {
    mw.webmailAutoGlobal = false;
    resetMailwayCaches();
    try {
      let r = await call('GET', `/api/projects/${projA.id}/mail`, owner2A);
      expect(r.json.features.webmailAutomatico).toBe(false);
      r = await toggle(projA.id, owner2A, { activo: false });
      expect(r.json).toMatchObject({ automatico: false, global: false });
      r = await toggle(projA.id, owner2A, { activo: true });
      expect(r.status, r.raw).toBe(200);
      expect(r.json).toMatchObject({ automatico: true, global: false });
      // Encendido pero sin efecto: no se crea nada.
      expect(r.json.domains.map((d: Json) => d.hostname)).toEqual(['webmail.tienda.es']);
    } finally {
      mw.webmailAutoGlobal = true;
      resetMailwayCaches();
    }
  });

  it('con la cuenta o el cliente suspendidos no se enciende, pero se puede apagar', async () => {
    updateWorkspace(wsA.id, { status: 'suspended' });
    try {
      let r = await toggle(projA.id, owner2A, { activo: true });
      expect(r.status).toBe(403);
      expect(r.json.error).toMatch(/suspendida/);
      expect(autoCalls()).toEqual([]);
      r = await toggle(projA.id, owner2A, { activo: false });
      expect(r.status, r.raw).toBe(200);
    } finally {
      updateWorkspace(wsA.id, { status: 'active' });
    }
    const client = clientOf(projA.id);
    client.suspended = true;
    try {
      mw.calls = [];
      const r = await toggle(projA.id, owner2A, { activo: true });
      expect(r.status).toBe(409);
      expect(r.json.error).toMatch(/suspendido en Mailway/);
      expect(autoCalls()).toEqual([]);
    } finally {
      client.suspended = false;
    }
    expect((await toggle(projA.id, owner2A, { activo: true })).status).toBe(200);
  });

  it('si el cliente ya no es del proyecto, 409 sin tocar su interruptor', async () => {
    const client = clientOf(projA.id);
    const original = client.externalRef;
    client.externalRef = `skyway:project:${projB.id}`;
    try {
      const r = await toggle(projA.id, owner2A, { activo: false });
      expect(r.status).toBe(409);
      expect(autoCalls()).toEqual([]);
    } finally {
      client.externalRef = original;
    }
  });

  it('con un Mailway anterior (sin features.webmailAutomatico) no se ofrece ni se llama', async () => {
    mw.webmailAutoSoportado = false;
    resetMailwayCaches();
    try {
      const view = await call('GET', `/api/projects/${projA.id}/mail`, ownerA);
      expect(view.status, view.raw).toBe(200);
      expect(view.json.features.webmailAutomatico).toBeNull();
      expect(view.json.summary.webmail).toBeNull();
      mw.calls = [];
      const r = await toggle(projA.id, owner2A, { activo: false });
      expect(r.status).toBe(409);
      expect(r.json.error).toMatch(/no permite crear el webmail automáticamente/);
      expect(autoCalls()).toEqual([]);
    } finally {
      mw.webmailAutoSoportado = true;
      resetMailwayCaches();
    }
  });
});

// ======================= configuración inicial (enlace de bienvenida) =======================

describe('configuración inicial: enlace de bienvenida', () => {
  let primero = '';

  it('solo quien gestiona el proyecto: un miembro u otra cuenta reciben 403 sin llegar a Mailway', async () => {
    const intentos: ['GET' | 'POST' | 'DELETE', string, unknown?][] = [
      ['GET', invites(projA.id)],
      ['POST', invites(projA.id), { email: 'ana@empresa.com' }],
      ['GET', invites(projA.id, '/inv_x/url')],
      ['DELETE', invites(projA.id, '/inv_x')],
    ];
    for (const [method, url, body] of intentos) {
      for (const headers of [memberA, ownerB]) {
        const r = await call(method, url, headers, body);
        expect(r.status, `${method} ${url}`).toBe(403);
      }
    }
    expect(inviteCalls()).toEqual([]);
  });

  it('la lista propone el correo de contacto del cliente o, si no tiene, el del propietario de la cuenta', async () => {
    let r = await call('GET', invites(projA.id), ownerA);
    expect(r.status, r.raw).toBe(200);
    expect(r.json).toEqual({ invites: [], suggestedEmail: 'contacto@empresa.com', clientName: 'Cliente Correo' });
    r = await call('GET', invites(projB.id), ownerB);
    expect(r.json.suggestedEmail).toBe('ownerb@example.com');
  });

  it('crea el enlace en el cliente del proyecto: URL una vez, caducidad y nada secreto en la auditoría', async () => {
    const antes = Date.now();
    const r = await call('POST', invites(projA.id), ownerA, { email: ' Ana@Empresa.com ', name: 'Ana García' });
    expect(r.status, r.raw).toBe(201);
    expect(r.json.invite).toMatchObject({ email: 'ana@empresa.com', name: 'Ana García', existingUser: false });
    expect(r.json.invite.url).toMatch(new RegExp(`^${MW_BASE}/bienvenida/`));
    expect(r.json.invite.expiresAt).toBeGreaterThanOrEqual(antes + 7 * DAY);
    expect(r.json.invite.expiresAt).toBeLessThanOrEqual(Date.now() + 7 * DAY);
    primero = r.json.invite.id;
    const alta = inviteCalls().find((c) => c.method === 'POST')!;
    expect(alta.path).toBe(`/api/clients/${clientOf(projA.id).id}/invites`);
    expect(alta.body).toEqual({ email: 'ana@empresa.com', name: 'Ana García', ttlHours: 168 });
    const auditados = listAudit({ action: 'mailway_invite_created' });
    expect(auditados.map((a) => a.detail)).toEqual(['Tienda: ana@empresa.com (válido 7 días)']);
    for (const a of listAudit({ action: 'mailway_invite' })) expect(String(a.detail)).not.toContain('bienvenida/');
  });

  it('valida el correo y la validez (de 1 hora a 30 días) antes de llamar a Mailway', async () => {
    const malos = [
      { email: 'no-es-correo' },
      {},
      { email: 'ana@empresa.com', ttlHours: 0 },
      { email: 'ana@empresa.com', ttlHours: 721 },
      { email: 'ana@empresa.com', ttlHours: 1.5 },
      { email: 'ana@empresa.com', name: 'N'.repeat(81) },
    ];
    for (const body of malos) {
      const r = await call('POST', invites(projA.id), owner2A, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(inviteCalls()).toEqual([]);
    const r = await call('POST', invites(projA.id), owner2A, { email: 'luis@empresa.com', ttlHours: 24 });
    expect(r.status, r.raw).toBe(201);
    expect(r.json.invite.expiresAt).toBeLessThanOrEqual(Date.now() + DAY);
    expect(listAudit({ action: 'mailway_invite_created' })[0].detail).toBe('Tienda: luis@empresa.com (válido 1 día)');
  });

  it('un correo de la administración o de otro cliente: 409 explicado; uno del propio cliente elige contraseña nueva', async () => {
    let r = await call('POST', invites(projA.id), ownerA, { email: 'admin@mail.example.com' });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/ya lo utiliza otra cuenta del servicio de correo/);
    mw.panelUsers.push({ email: 'eva@empresa.com', role: 'client', clientId: clientOf(projA.id).id });
    r = await call('POST', invites(projA.id), ownerA, { email: 'eva@empresa.com' });
    expect(r.status, r.raw).toBe(201);
    expect(r.json.invite.existingUser).toBe(true);
  });

  it('crear otro para el mismo correo sustituye al pendiente; la lista lo refleja', async () => {
    const r = await call('POST', invites(projA.id), ownerA, { email: 'ana@empresa.com', name: 'Ana García' });
    expect(r.status, r.raw).toBe(201);
    const lista = await call('GET', invites(projA.id), ownerA);
    const deAna = lista.json.invites.filter((i: Json) => i.email === 'ana@empresa.com');
    expect(deAna.map((i: Json) => [i.id, i.status, i.recoverable])).toEqual([
      [r.json.invite.id, 'pending', true],
      [primero, 'revoked', false],
    ]);
    expect(lista.raw).not.toContain('bienvenida/');
    primero = r.json.invite.id;
  });

  it('«Ver enlace» devuelve la URL de un pendiente y lo registra; uno usado o irrecuperable, con su motivo', async () => {
    let r = await call('GET', invites(projA.id, `/${primero}/url`), ownerA);
    expect(r.status, r.raw).toBe(200);
    expect(r.json.invite).toMatchObject({ id: primero, email: 'ana@empresa.com', existingUser: null });
    expect(r.json.invite.url).toMatch(/\/bienvenida\//);
    expect(listAudit({ action: 'mailway_invite_viewed' }).map((a) => a.detail)).toEqual(['Tienda: ana@empresa.com']);

    mw.invites.find((i) => i.id === primero)!.recoverable = false;
    r = await call('GET', invites(projA.id, `/${primero}/url`), ownerA);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/ya no se puede volver a mostrar/);
    mw.invites.find((i) => i.id === primero)!.recoverable = true;

    const vieja = mw.invites.find((i) => i.email === 'ana@empresa.com' && i.revokedAt)!;
    r = await call('GET', invites(projA.id, `/${vieja.id}/url`), ownerA);
    expect(r.status).toBe(404);
    expect(r.json.error).toMatch(/ya no es válido/);
  });

  it('revocar: el pendiente deja de servir; uno aceptado no se revoca y uno caducado no llega a Mailway', async () => {
    let r = await call('DELETE', invites(projA.id, `/${primero}`), ownerA);
    expect(r.status, r.raw).toBe(200);
    expect(r.json).toEqual({ ok: true, revoked: true });
    expect(inviteCalls().filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
      `/api/clients/${clientOf(projA.id).id}/invites/${primero}`,
    ]);
    expect(listAudit({ action: 'mailway_invite_revoked' }).map((a) => a.detail)).toEqual(['Tienda: ana@empresa.com']);

    const luis = mw.invites.find((i) => i.email === 'luis@empresa.com')!;
    luis.acceptedAt = Date.now();
    const eva = mw.invites.find((i) => i.email === 'eva@empresa.com')!;
    eva.expiresAt = Date.now() - 1;
    mw.calls = [];
    r = await call('DELETE', invites(projA.id, `/${luis.id}`), ownerA);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/ya se ha utilizado/);
    r = await call('DELETE', invites(projA.id, `/${eva.id}`), ownerA);
    expect(r.status, r.raw).toBe(200);
    expect(r.json).toEqual({ ok: true, revoked: false });
    expect(inviteCalls().filter((c) => c.method === 'DELETE')).toEqual([]);
    const lista = await call('GET', invites(projA.id), ownerA);
    const estado = (id: string) => lista.json.invites.find((i: Json) => i.id === id).status;
    expect([estado(primero), estado(luis.id), estado(eva.id)]).toEqual(['revoked', 'accepted', 'expired']);
  });

  it('aislamiento: un enlace de otro cliente responde 404 sin llegar a su ruta', async () => {
    const r0 = await call('POST', invites(projB.id), ownerB, { email: 'pepe@ajeno.com' });
    expect(r0.status, r0.raw).toBe(201);
    const ajeno = r0.json.invite.id;
    mw.calls = [];
    let r = await call('GET', invites(projA.id, `/${ajeno}/url`), ownerA);
    expect(r.status).toBe(404);
    r = await call('DELETE', invites(projA.id, `/${ajeno}`), ownerA);
    expect(r.status).toBe(404);
    // Solo se ha leído la lista del cliente del proyecto: ni la URL ni el borrado del ajeno.
    expect(inviteCalls().map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /api/clients/${clientOf(projA.id).id}/invites`,
      `GET /api/clients/${clientOf(projA.id).id}/invites`,
    ]);
    expect(mw.invites.find((i) => i.id === ajeno)?.revokedAt).toBeNull();
  });

  it('con el cliente suspendido o la cuenta suspendida no se crea; si el cliente ya no es del proyecto, 409', async () => {
    const client = clientOf(projA.id);
    client.suspended = true;
    try {
      const r = await call('POST', invites(projA.id), ownerA, { email: 'nuevo@empresa.com' });
      expect(r.status).toBe(409);
      expect(r.json.error).toMatch(/no es posible enviar la configuración inicial/);
    } finally {
      client.suspended = false;
    }
    updateWorkspace(wsA.id, { status: 'suspended' });
    try {
      const r = await call('POST', invites(projA.id), ownerA, { email: 'nuevo@empresa.com' });
      expect(r.status).toBe(403);
    } finally {
      updateWorkspace(wsA.id, { status: 'active' });
    }
    const original = client.externalRef;
    client.externalRef = 'otra-integracion:1';
    try {
      for (const [method, url] of [
        ['GET', invites(projA.id)],
        ['POST', invites(projA.id)],
        ['DELETE', invites(projA.id, `/${primero}`)],
      ] as const) {
        const r = await call(method, url, ownerA, method === 'POST' ? { email: 'nuevo@empresa.com' } : undefined);
        expect(r.status, `${method} ${url}`).toBe(409);
      }
    } finally {
      client.externalRef = original;
    }
    expect(inviteCalls()).toEqual([]);
  });
});
