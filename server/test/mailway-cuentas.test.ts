/**
 * Un cliente de Mailway por cuenta (workspace) de Skyway: los proyectos de una
 * cuenta que activan el correo comparten el cliente de la cuenta (referencia
 * `skyway:workspace:<id>` y nombre de la cuenta), nunca uno de otra cuenta; el
 * nombre sigue al de la cuenta; los vínculos de antes (cliente propio con
 * `skyway:project:<id>`) pasan al de la cuenta sin perder nada, o se quedan
 * como están si la cuenta ya tenía otro. Mismo doble de Mailway que el resto
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
  insertMailwayLink,
  listAudit,
  setUserProjects,
} from '../src/db';
import { migrarVinculosACuentas } from '../src/mailwaycuentas';
import type { GitConfig, ProjectRow, ServiceRow, UserRow } from '../src/types';
import { hashPassword, randomToken } from '../src/util';
import { FakeClient, MW_BASE, MW_TOKEN, fakeFetch, mw } from './mailwayfake';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

let app: FastifyInstance;
let adminCookie = '';
const admin = () => ({ cookie: adminCookie, ...SAME_ORIGIN });

let wsIrene: { id: string; name: string };
let legal: ProjectRow;
let web: ProjectRow;
let bot: ProjectRow;
let svcLegal: ServiceRow;
let svcWeb: ServiceRow;
let ownerIrene: Record<string, string>;
let memberLegal: Record<string, string>;
let wsOtra: { id: string };
let otra: ProjectRow;
let ownerOtra: Record<string, string>;
let clienteIrene = '';

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

function gitCfg(): GitConfig {
  return { repoUrl: 'https://github.com/x/y', branch: 'main', port: 3000, domains: [], webhookSecret: 'w' } as GitConfig;
}

const wsRef = (id: string) => `skyway:workspace:${id}`;
const projectRef = (id: string) => `skyway:project:${id}`;
const client = (id: string) => mw.clients.find((c) => c.id === id)!;

/** Cliente propio de un proyecto, como los que creaba Skyway antes de compartirlos por cuenta. */
function clienteDeAntes(project: ProjectRow, id: string): FakeClient {
  const c: FakeClient = { id, name: project.name, slug: project.slug, externalRef: projectRef(project.id), suspended: false, planId: 'pln_1' };
  mw.clients.push(c);
  insertMailwayLink({ project_id: project.id, client_id: id, client_name: project.name, created_by: null }, { legacyCredentials: true });
  return c;
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
  expect((await call('PUT', '/api/mailway/config', admin(), { baseUrl: MW_BASE, token: MW_TOKEN })).status).toBe(200);
  expect((await call('POST', '/api/mailway/test', admin(), {})).status).toBe(200);

  const ws = createWorkspaceRow('Irene Cobo', { modules_override: JSON.stringify(['mail', 'domains']) });
  wsIrene = { id: ws.id, name: ws.name };
  legal = createProject('codanuancelegal', 'codanuancelegal', null, ws.id);
  web = createProject('Web corporativa', 'web-corporativa', null, ws.id);
  bot = createProject('Bot de avisos', 'bot-de-avisos', null, ws.id);
  // Dos servicios con el mismo slug en dos proyectos de la cuenta.
  svcLegal = createService(legal.id, 'Web', 'web', 'git', gitCfg());
  svcWeb = createService(web.id, 'Web', 'web', 'git', gitCfg());
  ownerIrene = bearerFor(createUser('irene@example.com', hashPassword('contraseña1'), 'owner', ws.id));
  const member = createUser('becaria@example.com', hashPassword('contraseña1'), 'member', ws.id);
  setUserProjects(member.id, [legal.id]);
  memberLegal = bearerFor(member);

  const o = createWorkspaceRow('Otra cuenta', { modules_override: JSON.stringify(['mail', 'domains']) });
  wsOtra = { id: o.id };
  otra = createProject('Otra web', 'otra-web', null, o.id);
  ownerOtra = bearerFor(createUser('otra@example.com', hashPassword('contraseña1'), 'owner', o.id));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  closeDb();
});

beforeEach(() => {
  mw.calls = [];
});

describe('un cliente de Mailway por cuenta', () => {
  it('activar el correo en un proyecto de una cuenta crea el cliente de la cuenta, con su nombre', async () => {
    const opts = await call('GET', `/api/projects/${legal.id}/mail/options`, ownerIrene);
    expect(opts.status, opts.raw).toBe(200);
    expect(opts.json.workspace).toEqual({ name: 'Irene Cobo', client: null });
    expect(opts.json.defaultName).toBe('Irene Cobo');

    const r = await call('POST', `/api/projects/${legal.id}/mail/link`, ownerIrene, { mode: 'create', name: 'Lo que sea' });
    expect(r.status, r.raw).toBe(201);
    expect(r.json.created).toBe(true);
    const ensure = mw.calls.find((c) => c.path === '/api/integrations/clients/ensure')!;
    expect(ensure.body).toMatchObject({ externalRef: wsRef(wsIrene.id), name: 'Irene Cobo' });
    const c = mw.clients.find((x) => x.externalRef === wsRef(wsIrene.id))!;
    expect(c.name).toBe('Irene Cobo');
    clienteIrene = c.id;
    expect(getMailwayLink(legal.id)).toMatchObject({ client_id: c.id, client_name: 'Irene Cobo' });
    // El bot de la misma cuenta no ha activado nada.
    expect(getMailwayLink(bot.id)).toBeUndefined();
    expect(mw.clients).toHaveLength(1);
    expect(listAudit({ action: 'mailway_linked' })[0].detail).toBe('codanuancelegal → Irene Cobo (cliente nuevo de la cuenta «Irene Cobo»)');
  });

  it('un segundo proyecto de la cuenta comparte ese cliente sin crear otro: mismos dominios y buzones', async () => {
    let r = await call('POST', `/api/projects/${legal.id}/mail/domains`, ownerIrene, { domain: 'cobo.es' });
    expect(r.status, r.raw).toBe(201);
    const opts = await call('GET', `/api/projects/${web.id}/mail/options`, ownerIrene);
    expect(opts.json.workspace).toEqual({ name: 'Irene Cobo', client: { name: 'Irene Cobo', planName: 'Básico' } });
    expect(opts.json.canChoosePlan).toBe(false);
    expect(opts.json.previous).toBeNull();
    mw.calls = [];
    r = await call('POST', `/api/projects/${web.id}/mail/link`, ownerIrene, { mode: 'create' });
    expect(r.status, r.raw).toBe(201);
    expect(r.json.created).toBe(false);
    expect(mw.calls.some((c) => c.path === '/api/integrations/clients/ensure')).toBe(false);
    expect(getMailwayLink(web.id)?.client_id).toBe(clienteIrene);
    expect(mw.clients).toHaveLength(1);

    const view = await call('GET', `/api/projects/${web.id}/mail`, ownerIrene);
    expect(view.status, view.raw).toBe(200);
    expect(view.json.summary.domains.map((d: Json) => d.domain)).toEqual(['cobo.es']);
    expect(view.json.account).toEqual({
      workspaceName: 'Irene Cobo',
      shared: true,
      projects: [{ id: legal.id, name: 'codanuancelegal' }],
      ownClient: null,
    });
    // Un miembro solo ve los proyectos a los que tiene acceso.
    const delMiembro = await call('GET', `/api/projects/${legal.id}/mail`, memberLegal);
    expect(delMiembro.json.account).toMatchObject({ shared: true, projects: [] });
  });

  it('un proyecto de otra cuenta no puede vincularse a ese cliente ni consultarlo', async () => {
    expect((await call('GET', `/api/projects/${legal.id}/mail`, ownerOtra)).status).toBe(403);
    const opts = await call('GET', `/api/projects/${otra.id}/mail/options`, admin());
    expect(opts.json.clients.find((c: Json) => c.id === clienteIrene)).toMatchObject({ available: false });
    mw.calls = [];
    let r = await call('POST', `/api/projects/${otra.id}/mail/link`, admin(), { mode: 'existing', clientId: clienteIrene });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/proyecto de otra cuenta/);
    expect(mw.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(client(clienteIrene).externalRef).toBe(wsRef(wsIrene.id));

    // Tampoco uno que ya es de otra cuenta (o de otro proyecto) en Mailway, aunque Skyway no lo tenga vinculado.
    mw.clients.push({ id: 'cli_ajeno', name: 'Ajeno', slug: 'ajeno', externalRef: wsRef('wsp_otra'), suspended: false, planId: 'pln_1' });
    mw.clients.push({ id: 'cli_proyecto', name: 'De un proyecto', slug: 'p', externalRef: projectRef(web.id), suspended: false, planId: 'pln_1' });
    for (const clientId of ['cli_ajeno', 'cli_proyecto']) {
      r = await call('POST', `/api/projects/${otra.id}/mail/link`, admin(), { mode: 'existing', clientId });
      expect(r.status, clientId).toBe(409);
      expect(r.json.error).toMatch(/otra integración/);
    }
    // Sin cliente, la otra cuenta crea el suyo con su referencia.
    r = await call('POST', `/api/projects/${otra.id}/mail/link`, ownerOtra, { mode: 'create' });
    expect(r.status, r.raw).toBe(201);
    expect(client(getMailwayLink(otra.id)!.client_id)).toMatchObject({ externalRef: wsRef(wsOtra.id), name: 'Otra cuenta' });
    mw.clients = mw.clients.filter((c) => c.id !== 'cli_ajeno' && c.id !== 'cli_proyecto');
  });

  it('el administrador no puede vincular a una cuenta que ya tiene cliente otro distinto', async () => {
    mw.clients.push({ id: 'cli_suelto', name: 'Suelto', slug: 'suelto', externalRef: null, suspended: false, planId: 'pln_1' });
    try {
      const r = await call('POST', `/api/projects/${bot.id}/mail/link`, admin(), { mode: 'existing', clientId: 'cli_suelto' });
      expect(r.status).toBe(409);
      expect(r.json.error).toMatch(/La cuenta «Irene Cobo» ya tiene su cliente de correo en Mailway/);
      expect(client('cli_suelto').externalRef).toBeNull();
      expect(getMailwayLink(bot.id)).toBeUndefined();
    } finally {
      mw.clients = mw.clients.filter((c) => c.id !== 'cli_suelto');
    }
  });

  it('las credenciales de envío de dos proyectos de la cuenta no se revocan entre sí aunque sus servicios se llamen igual', async () => {
    const d = mw.domains.find((x) => x.domain === 'cobo.es')!;
    const b = await call('POST', `/api/projects/${legal.id}/mail/mailboxes`, ownerIrene, { domainId: d.id, localPart: 'avisos' });
    expect(b.status, b.raw).toBe(201);
    const mailbox = b.json.mailbox.id;
    const connect = (project: ProjectRow, svc: ServiceRow) =>
      call('POST', `/api/projects/${project.id}/mail/connect`, ownerIrene, { serviceId: svc.id, mailboxId: mailbox, mode: 'smtp' });
    let r = await connect(legal, svcLegal);
    expect(r.status, r.raw).toBe(200);
    r = await connect(web, svcWeb);
    expect(r.status, r.raw).toBe(200);
    expect(r.json.revoked).toBe(0);
    r = await connect(web, svcWeb);
    expect(r.json.revoked).toBe(1);
    const activas = mw.appPasswords.filter((a) => !a.revokedAt).map((a) => a.name).sort();
    expect(activas).toEqual(['skyway:codanuancelegal/web', 'skyway:web-corporativa/web']);
  });

  it('renombrar la cuenta renombra su cliente en Mailway, sin bloquear el cambio si Mailway falla', async () => {
    let r = await call('PATCH', `/api/workspaces/${wsIrene.id}`, admin(), { name: 'Irene Cobo Abogados' });
    expect(r.status, r.raw).toBe(200);
    await vi.waitFor(() => expect(client(clienteIrene).name).toBe('Irene Cobo Abogados'));
    const patch = mw.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.path).toBe(`/api/clients/${clienteIrene}`);
    expect(patch.body).toEqual({ name: 'Irene Cobo Abogados' });
    await vi.waitFor(() => expect(getMailwayLink(web.id)?.client_name).toBe('Irene Cobo Abogados'));
    expect(getMailwayLink(legal.id)?.client_name).toBe('Irene Cobo Abogados');
    expect(listAudit({ action: 'mailway_client_renamed' })[0].detail).toBe(
      'Cliente de correo «Irene Cobo» → «Irene Cobo Abogados» (nombre de la cuenta)',
    );

    mw.down = true;
    try {
      r = await call('PATCH', `/api/workspaces/${wsIrene.id}`, admin(), { name: 'Irene Cobo' });
      expect(r.status, r.raw).toBe(200);
      expect(r.json.workspace.name).toBe('Irene Cobo');
      await vi.waitFor(() => expect(listAudit({ action: 'mailway_client_rename_failed' })).toHaveLength(1));
    } finally {
      mw.down = false;
    }
    expect(client(clienteIrene).name).toBe('Irene Cobo Abogados');
  });

  it('al abrir el correo, el nombre del cliente se alinea con el de la cuenta (y el que recuerda Skyway)', async () => {
    mw.calls = [];
    const r = await call('GET', `/api/projects/${legal.id}/mail`, memberLegal);
    expect(r.status, r.raw).toBe(200);
    expect(r.json.summary.client.name).toBe('Irene Cobo');
    expect(r.json.link.clientName).toBe('Irene Cobo');
    expect(client(clienteIrene).name).toBe('Irene Cobo');
    expect(mw.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ name: 'Irene Cobo' }]);
    expect(getMailwayLink(web.id)?.client_name).toBe('Irene Cobo');
    // Ya alineado: abrirlo otra vez no vuelve a escribir en Mailway.
    mw.calls = [];
    await call('GET', `/api/projects/${legal.id}/mail`, memberLegal);
    expect(mw.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('desactivar un proyecto deja el cliente al resto; con el último, la cuenta conserva su referencia', async () => {
    let r = await call('DELETE', `/api/projects/${legal.id}/mail/link`, ownerIrene);
    expect(r.status, r.raw).toBe(200);
    expect(r.json).toMatchObject({ released: false, workspaceClient: true });
    expect(getMailwayLink(web.id)?.client_id).toBe(clienteIrene);
    r = await call('DELETE', `/api/projects/${web.id}/mail/link`, ownerIrene);
    expect(r.json).toMatchObject({ released: false, workspaceClient: true });
    expect(client(clienteIrene).externalRef).toBe(wsRef(wsIrene.id));
    expect(mw.calls.filter((c) => c.method === 'DELETE' && c.path.includes('/link'))).toEqual([]);
    // Volver a activarlo recupera el mismo cliente con lo que tenía.
    r = await call('POST', `/api/projects/${legal.id}/mail/link`, ownerIrene, { mode: 'create' });
    expect(r.status, r.raw).toBe(201);
    expect(getMailwayLink(legal.id)?.client_id).toBe(clienteIrene);
    const view = await call('GET', `/api/projects/${legal.id}/mail`, ownerIrene);
    expect(view.json.summary.domains.map((d: Json) => d.domain)).toEqual(['cobo.es']);
  });
});

describe('vínculos de antes de compartir el cliente por cuenta', () => {
  let wsMig: { id: string; name: string };
  let viejo: ProjectRow;
  let viejo2: ProjectRow;
  let ownerMig: Record<string, string>;

  beforeAll(() => {
    const ws = createWorkspaceRow('Estudio Martínez', { modules_override: JSON.stringify(['mail', 'domains']) });
    wsMig = { id: ws.id, name: ws.name };
    viejo = createProject('Tienda vieja', 'tienda-vieja', null, ws.id);
    viejo2 = createProject('Blog viejo', 'blog-viejo', null, ws.id);
    ownerMig = bearerFor(createUser('martinez@example.com', hashPassword('contraseña1'), 'owner', ws.id));
  });

  it('al abrir el correo, el cliente propio pasa a ser el de la cuenta: misma referencia de cuenta, su nombre y sus datos', async () => {
    const c = clienteDeAntes(viejo, 'cli_viejo');
    mw.domains.push({ id: 'dom_viejo', clientId: c.id, domain: 'martinez.es', status: 'active', ownershipVerifiedAt: 1 });
    const r = await call('GET', `/api/projects/${viejo.id}/mail`, ownerMig);
    expect(r.status, r.raw).toBe(200);
    expect(c.externalRef).toBe(wsRef(wsMig.id));
    expect(c.name).toBe('Estudio Martínez');
    expect(r.json.summary.domains.map((d: Json) => d.domain)).toEqual(['martinez.es']);
    expect(r.json.account).toEqual({ workspaceName: 'Estudio Martínez', shared: true, projects: [], ownClient: null });
    expect(listAudit({ action: 'mailway_client_shared' }).map((a) => a.detail)).toEqual([
      'Tienda vieja: el cliente «Tienda vieja» pasa a ser el de la cuenta «Estudio Martínez» y lo comparten sus proyectos',
    ]);
  });

  it('si la cuenta ya tenía otro cliente, el proyecto conserva el suyo sin fusionar nada y queda registrado una vez', async () => {
    const c2 = clienteDeAntes(viejo2, 'cli_viejo2');
    mw.domains.push({ id: 'dom_viejo2', clientId: c2.id, domain: 'blogviejo.es', status: 'active', ownershipVerifiedAt: 1 });
    for (let i = 0; i < 2; i++) {
      const r = await call('GET', `/api/projects/${viejo2.id}/mail`, ownerMig);
      expect(r.status, r.raw).toBe(200);
      expect(r.json.account).toEqual({
        workspaceName: 'Estudio Martínez',
        shared: false,
        projects: [],
        ownClient: { workspaceClientName: 'Estudio Martínez' },
      });
      expect(r.json.summary.domains.map((d: Json) => d.domain)).toEqual(['blogviejo.es']);
    }
    expect(c2.externalRef).toBe(projectRef(viejo2.id));
    expect(c2.name).toBe('Blog viejo');
    expect(client('cli_viejo').externalRef).toBe(wsRef(wsMig.id));
    expect(listAudit({ action: 'mailway_client_kept' })).toHaveLength(1);
    expect(JSON.parse(getSetting(`mailway.ownClient:${viejo2.id}`) ?? '{}')).toMatchObject({ workspaceClientId: 'cli_viejo' });
    // Sigue funcionando con su cliente.
    const v = await call('POST', `/api/projects/${viejo2.id}/mail/domains/dom_viejo2/verify`, ownerMig);
    expect(v.status, v.raw).toBe(200);
    // Desactivarlo suelta su referencia propia, como siempre, y olvida el aviso.
    const d = await call('DELETE', `/api/projects/${viejo2.id}/mail/link`, ownerMig);
    expect(d.json).toMatchObject({ released: true, workspaceClient: false });
    expect(getSetting(`mailway.ownClient:${viejo2.id}`)).toBeNull();
  });

  it('las credenciales con el nombre de antes solo las reconoce el proyecto que las creó', async () => {
    const svc = createService(viejo.id, 'Web', 'web', 'git', gitCfg());
    const box = { id: 'mbx_viejo', domainId: 'dom_viejo', domain: 'martinez.es', localPart: 'web', email: 'web@martinez.es', displayName: '', quotaMb: 1024, status: 'active' as const, usedBytes: 0 };
    mw.mailboxes.push(box);
    mw.appPasswords.push({ id: 'app_antigua', mailboxId: box.id, email: box.email, name: 'skyway:web', revokedAt: null, createdAt: 1 });
    // Otro proyecto de la cuenta, vinculado después, con un servicio del mismo nombre: no la toca.
    const nuevo = createProject('Nuevo', 'nuevo', null, wsMig.id);
    const svcNuevo = createService(nuevo.id, 'Web', 'web', 'git', gitCfg());
    expect((await call('POST', `/api/projects/${nuevo.id}/mail/link`, ownerMig, { mode: 'create' })).status).toBe(201);
    let r = await call('POST', `/api/projects/${nuevo.id}/mail/connect`, ownerMig, { serviceId: svcNuevo.id, mailboxId: box.id, mode: 'smtp' });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.revoked).toBe(0);
    expect(mw.appPasswords.find((a) => a.id === 'app_antigua')?.revokedAt).toBeNull();
    // El proyecto que la creó sí: es la anterior de su servicio.
    r = await call('POST', `/api/projects/${viejo.id}/mail/connect`, ownerMig, { serviceId: svc.id, mailboxId: box.id, mode: 'smtp' });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.revoked).toBe(1);
    expect(mw.appPasswords.find((a) => a.id === 'app_antigua')?.revokedAt).toBeTruthy();
  });

  it('migración de arranque: el vínculo más antiguo pasa a la cuenta y el siguiente conserva el suyo; sin Mailway, no falla', async () => {
    const ws = createWorkspaceRow('Arranque S.L.', { modules_override: JSON.stringify(['mail']) });
    const p1 = createProject('Uno', 'uno', null, ws.id);
    const p2 = createProject('Dos', 'dos', null, ws.id);
    const c1 = clienteDeAntes(p1, 'cli_uno');
    const c2 = clienteDeAntes(p2, 'cli_dos');
    const avisos: string[] = [];
    mw.down = true;
    try {
      await migrarVinculosACuentas((m) => avisos.push(m));
    } finally {
      mw.down = false;
    }
    expect(avisos[0]).toMatch(/No se ha podido revisar en Mailway/);
    expect(c1.externalRef).toBe(projectRef(p1.id));

    await migrarVinculosACuentas((m) => avisos.push(m));
    expect(avisos).toHaveLength(1);
    expect(c1).toMatchObject({ externalRef: wsRef(ws.id), name: 'Arranque S.L.' });
    expect(c2).toMatchObject({ externalRef: projectRef(p2.id), name: 'Dos' });
    expect(JSON.parse(getSetting(`mailway.ownClient:${p2.id}`) ?? '{}')).toMatchObject({ workspaceClientId: 'cli_uno' });
    expect(getMailwayLink(p1.id)?.client_name).toBe('Arranque S.L.');

    // Borrar la cuenta suelta su referencia en Mailway (solo la de la cuenta).
    const r = await call('DELETE', `/api/workspaces/${ws.id}`, admin());
    expect(r.status, r.raw).toBe(200);
    await vi.waitFor(() => expect(c1.externalRef).toBeNull());
    expect(mw.calls.some((c) => c.method === 'DELETE' && c.path === `/api/integrations/clients/cli_uno/link?externalRef=${encodeURIComponent(wsRef(ws.id))}`)).toBe(true);
    expect(c2.externalRef).toBe(projectRef(p2.id));
    expect(listAudit({ action: 'mailway_client_released' })[0].detail).toBe('Arranque S.L.: Arranque S.L.');
  });

  it('un proyecto sin cuenta sigue con su propio cliente, con la referencia y el nombre del proyecto', async () => {
    const solo = createProject('Proyecto suelto', 'proyecto-suelto', null, null);
    const r = await call('POST', `/api/projects/${solo.id}/mail/link`, admin(), { mode: 'create' });
    expect(r.status, r.raw).toBe(201);
    expect(client(getMailwayLink(solo.id)!.client_id)).toMatchObject({ externalRef: projectRef(solo.id), name: 'Proyecto suelto' });
    const view = await call('GET', `/api/projects/${solo.id}/mail`, admin());
    expect(view.json.account).toBeNull();
  });
});
