/**
 * Pestaña Correo para bots y workers: la vista previa de «Conectar a un
 * servicio» dice con qué nombres se reconoce la credencial de Skyway del
 * servicio (la pestaña los usa para saber si conectar revoca una credencial
 * en uso y marcar «Volver a desplegar ahora», y para no equivocarse con el
 * usuario del buzón en los proyectos de una cuenta) y si el servicio no tiene
 * dominio (para recomendar la API de envío), y con qué nombre lleva cada
 * papel (la ayuda de la API nombra las variables que el servicio espera). El
 * contrato de `POST …/connect` no cambia: sin `redeploy`, no se despliega; con
 * él, se vuelve a desplegar la versión en marcha, sin compilar la cabeza de la
 * rama, salvo que hubiera otros cambios pendientes o un despliegue en curso.
 * Mailway es el doble de `mailwayfake.ts`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { API_TOKEN_PREFIX, hashApiToken } from '../src/auth';
import {
  bumpConfigRev,
  closeDb,
  createDeployment,
  createProject,
  createService,
  createUser,
  createWorkspaceRow,
  getEnv,
  getService,
  initDb,
  insertApiToken,
  insertMailwayLink,
  listDeployments,
  setServiceStopped,
  updateDeployment,
} from '../src/db';
import { detectNeeds } from '../src/needs';
import type { DetectedNeeds, GitConfig, ImageConfig, ProjectRow, ServiceRow, UserRow } from '../src/types';
import { hashPassword, randomToken } from '../src/util';
import { MW_BASE, MW_TOKEN, fakeFetch, mw } from './mailwayfake';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

const m = vi.hoisted(() => ({
  triggers: [] as { serviceId: string; trigger: string; imageTag?: string }[],
  /** Imágenes que ya no están en el disco (purgadas). */
  purgadas: new Set<string>(),
}));

// Sin desplegar de verdad: se crea la fila, como haría triggerDeploy, y se
// apunta con qué imagen se pidió.
vi.mock('../src/deploy/deployer', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/deploy/deployer')>();
  const db = await import('../src/db');
  return {
    ...mod,
    triggerDeploy: vi.fn((serviceId: string, trigger: string, opts: { imageTag?: string } = {}) => {
      m.triggers.push({ serviceId, trigger, ...(opts.imageTag ? { imageTag: opts.imageTag } : {}) });
      return db.createDeployment(serviceId, trigger, opts.imageTag ?? null);
    }),
  };
});
vi.mock('../src/docker/containers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/docker/containers')>()),
  imageExists: vi.fn(async (tag: string) => !m.purgadas.has(tag)),
}));

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

let app: FastifyInstance;
let adminCookie = '';
const admin = () => ({ cookie: adminCookie, ...SAME_ORIGIN });

let tienda: ProjectRow;
let suelto: ProjectRow;
let viejo: ProjectRow;
let owner: Record<string, string>;
let mailboxBot = '';

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

function needsFrom(files: Record<string, string>): DetectedNeeds {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-correo-bots-'));
  try {
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    const needs = detectNeeds(dir);
    if (!needs) throw new Error('No se ha detectado nada en el repositorio de prueba');
    return needs;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Un bot de imagen: sin puerto, sin dominio y sin healthcheck. */
function bot(project: ProjectRow, slug = 'bot', extra: Partial<ImageConfig> = {}): ServiceRow {
  return createService(project.id, 'Bot', slug, 'image', { image: 'ghcr.io/x/bot:latest', port: null, domains: [], ...extra } as ImageConfig);
}

async function preview(project: ProjectRow, service: ServiceRow, mode: 'smtp' | 'api', who: Record<string, string>) {
  const r = await call('GET', `/api/projects/${project.id}/mail/connect/preview?serviceId=${service.id}&mode=${mode}`, who);
  expect(r.status, r.raw).toBe(200);
  return r.json;
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

  // Una cuenta con correo (cliente compartido por sus proyectos) y un
  // proyecto suelto, sin cuenta, con su propio cliente.
  const ws = createWorkspaceRow('Cuenta Bots', { modules_override: JSON.stringify(['mail', 'domains']), max_services: 100 });
  tienda = createProject('Tienda', 'tienda', null, ws.id);
  owner = bearerFor(createUser('owner@example.com', hashPassword('contraseña1'), 'owner', ws.id));
  let r = await call('POST', `/api/projects/${tienda.id}/mail/link`, owner, { mode: 'create' });
  expect(r.status, r.raw).toBe(201);
  r = await call('POST', `/api/projects/${tienda.id}/mail/domains`, owner, { domain: 'tienda.es' });
  expect(r.status, r.raw).toBe(201);
  r = await call('POST', `/api/projects/${tienda.id}/mail/mailboxes`, owner, { domainId: r.json.domain.id, localPart: 'bot' });
  expect(r.status, r.raw).toBe(201);
  mailboxBot = r.json.mailbox.id;

  suelto = createProject('Suelto', 'suelto', null, null);
  r = await call('POST', `/api/projects/${suelto.id}/mail/link`, admin(), { mode: 'create' });
  expect(r.status, r.raw).toBe(201);

  // Un proyecto de la cuenta con el cliente propio de antes de compartirlos
  // por cuenta: sus credenciales pueden llevar todavía el nombre de entonces.
  viejo = createProject('Viejo', 'viejo', null, ws.id);
  mw.clients.push({ id: 'cli_viejo', name: 'Viejo', slug: 'viejo', externalRef: `skyway:project:${viejo.id}`, suspended: false, planId: 'pln_1' });
  insertMailwayLink({ project_id: viejo.id, client_id: 'cli_viejo', client_name: 'Viejo', created_by: null }, { legacyCredentials: true });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  closeDb();
});

beforeEach(() => {
  mw.calls = [];
  m.triggers = [];
  m.purgadas.clear();
});

/** Un worker de repositorio sin dominio, con un despliegue correcto de la imagen `imagen`. */
function workerDesplegado(project: ProjectRow, slug: string, imagen: string): ServiceRow {
  const svc = createService(project.id, 'Worker', slug, 'git', {
    repoUrl: `https://github.com/x/${slug}`,
    branch: 'main',
    port: null,
    domains: [],
    webhookSecret: 'w',
  } as unknown as GitConfig);
  const dep = createDeployment(svc.id, 'manual');
  updateDeployment(dep.id, { status: 'success', image_tag: imagen, config_rev: getService(svc.id)?.config_rev ?? 0, finished_at: Date.now() });
  return svc;
}

async function conectarYDesplegar(project: ProjectRow, svc: ServiceRow, who: Record<string, string>) {
  const r = await call('POST', `/api/projects/${project.id}/mail/connect`, who, {
    serviceId: svc.id,
    mailboxId: mailboxBot,
    mode: 'api',
    redeploy: true,
  });
  expect(r.status, r.raw).toBe(200);
  expect(r.json).toMatchObject({ ok: true, needsRedeploy: false });
  expect(r.json.deploymentId).toBeTruthy();
  return r.json;
}

describe('vista previa de «Conectar a un servicio»: nombres de la credencial', () => {
  it('en un proyecto suelto, el slug del servicio', async () => {
    const svc = bot(suelto);
    expect((await preview(suelto, svc, 'smtp', admin())).credentialNames).toEqual(['skyway:bot']);
    expect((await preview(suelto, svc, 'api', admin())).credentialNames).toEqual(['Skyway · bot']);
  });

  it('en un proyecto de una cuenta, también el del proyecto: otro proyecto puede tener un servicio «bot»', async () => {
    const svc = bot(tienda);
    expect((await preview(tienda, svc, 'smtp', owner)).credentialNames).toEqual(['skyway:tienda/bot']);
    expect((await preview(tienda, svc, 'api', owner)).credentialNames).toEqual(['Skyway · tienda/bot']);
  });

  it('con un vínculo de antes de compartir los clientes, el nombre actual y el de entonces', async () => {
    const svc = bot(viejo);
    expect((await preview(viejo, svc, 'smtp', owner)).credentialNames).toEqual(['skyway:viejo/bot', 'skyway:bot']);
    expect((await preview(viejo, svc, 'api', owner)).credentialNames).toEqual(['Skyway · viejo/bot', 'Skyway · bot']);
  });

  it('el nombre es exactamente el de la credencial que crea conectar, también recortado a 60 caracteres', async () => {
    const svc = bot(tienda, 'notificador-de-pedidos-pendientes-con-un-nombre-muy-largo');
    const smtp = (await preview(tienda, svc, 'smtp', owner)).credentialNames as string[];
    expect(smtp).toHaveLength(1);
    expect(smtp[0].length).toBeLessThanOrEqual(60);
    expect(smtp[0]).toMatch(/^skyway:tienda\/notificador-.*~[0-9a-f]{8}$/);
    let r = await call('POST', `/api/projects/${tienda.id}/mail/connect`, owner, { serviceId: svc.id, mailboxId: mailboxBot, mode: 'smtp' });
    expect(r.status, r.raw).toBe(200);
    expect(mw.appPasswords.filter((a) => !a.revokedAt && smtp.includes(a.name))).toHaveLength(1);

    const apiNames = (await preview(tienda, svc, 'api', owner)).credentialNames as string[];
    r = await call('POST', `/api/projects/${tienda.id}/mail/connect`, owner, { serviceId: svc.id, mailboxId: mailboxBot, mode: 'api' });
    expect(r.status, r.raw).toBe(200);
    expect(mw.apiKeys.filter((k) => !k.revokedAt && apiNames.includes(k.name))).toHaveLength(1);
  });
});

describe('vista previa: servicio sin dominio', () => {
  it('un bot de imagen sin puerto ni dominio es «sin dominio» en los dos modos', async () => {
    const svc = bot(tienda, 'bot-telegram');
    expect((await preview(tienda, svc, 'smtp', owner)).sinDominio).toBe(true);
    expect((await preview(tienda, svc, 'api', owner)).sinDominio).toBe(true);
  });

  it('con un dominio o una ruta de healthcheck, no', async () => {
    const conDominio = bot(tienda, 'bot-webhook', { domains: ['bot.tienda.es'], port: 8080 });
    expect((await preview(tienda, conDominio, 'smtp', owner)).sinDominio).toBe(false);
    const conSalud = bot(tienda, 'worker-salud', { healthcheckPath: '/salud', port: 8080 });
    expect((await preview(tienda, conSalud, 'smtp', owner)).sinDominio).toBe(false);
    const web = createService(tienda.id, 'Web', 'web', 'git', {
      repoUrl: 'https://github.com/x/web',
      branch: 'main',
      port: 3000,
      domains: ['tienda.es'],
      webhookSecret: 'w',
    } as GitConfig);
    expect((await preview(tienda, web, 'api', owner)).sinDominio).toBe(false);
  });
});

describe('vista previa: qué variable lleva cada papel', () => {
  it('sin manifiesto, los nombres de siempre', async () => {
    const svc = bot(tienda, 'bot-nombres');
    expect((await preview(tienda, svc, 'api', owner)).roleNames).toMatchObject({
      api_url: 'MAILWAY_API_URL',
      api_key: 'MAILWAY_API_KEY',
      from: 'MAIL_FROM',
    });
  });

  it('con un skyway.json que los nombra de otra forma, los suyos: la ayuda y el ejemplo de la pestaña los usan', async () => {
    const svc = createService(tienda.id, 'Avisos', 'avisos', 'git', {
      repoUrl: 'https://github.com/x/avisos',
      branch: 'main',
      port: null,
      domains: [],
      webhookSecret: 'w',
      needs: needsFrom({
        'skyway.json': JSON.stringify({
          version: 1,
          integrations: { mail: { mode: 'api', mailbox: 'bot' } },
          env: { MAIL_API: { from: 'mail.api_url' }, MAIL_TOKEN: { from: 'mail.api_key' }, REMITENTE: { from: 'mail.from' } },
        }),
      }),
    } as unknown as GitConfig);
    const p = await preview(tienda, svc, 'api', owner);
    expect(p.roleNames).toEqual({ api_url: 'MAIL_API', api_key: 'MAIL_TOKEN', from: 'REMITENTE' });
    expect(p.keys).toEqual(expect.arrayContaining(['MAIL_API', 'MAIL_TOKEN', 'REMITENTE']));
  });
});

describe('conectar y volver a desplegar: la versión en marcha, no la cabeza de la rama', () => {
  it('con una imagen correcta en marcha y nada más pendiente, se despliega esa imagen', async () => {
    const svc = workerDesplegado(tienda, 'worker-a', 'skyway/tienda-worker-a:aaaa1111');
    await conectarYDesplegar(tienda, svc, owner);
    expect(m.triggers).toEqual([{ serviceId: svc.id, trigger: 'mailway', imageTag: 'skyway/tienda-worker-a:aaaa1111' }]);
  });

  it('con cambios guardados sin desplegar de antes de conectar, un despliegue normal (los aplica)', async () => {
    const svc = workerDesplegado(tienda, 'worker-b', 'skyway/tienda-worker-b:bbbb2222');
    bumpConfigRev([svc.id]);
    await conectarYDesplegar(tienda, svc, owner);
    expect(m.triggers).toEqual([{ serviceId: svc.id, trigger: 'mailway' }]);
  });

  it('con otro despliegue en cola, un despliegue normal: fijar la imagen desharía el que va delante', async () => {
    const svc = workerDesplegado(tienda, 'worker-c', 'skyway/tienda-worker-c:cccc3333');
    createDeployment(svc.id, 'manual');
    await conectarYDesplegar(tienda, svc, owner);
    expect(m.triggers).toEqual([{ serviceId: svc.id, trigger: 'mailway' }]);
  });

  it('con la imagen purgada, un servicio de imagen Docker o sin despliegues correctos, un despliegue normal', async () => {
    const purgado = workerDesplegado(tienda, 'worker-d', 'skyway/tienda-worker-d:dddd4444');
    m.purgadas.add('skyway/tienda-worker-d:dddd4444');
    await conectarYDesplegar(tienda, purgado, owner);
    const imagen = bot(tienda, 'bot-imagen');
    await conectarYDesplegar(tienda, imagen, owner);
    const nuevo = createService(tienda.id, 'Nuevo', 'worker-e', 'git', {
      repoUrl: 'https://github.com/x/worker-e',
      branch: 'main',
      port: null,
      domains: [],
      webhookSecret: 'w',
    } as unknown as GitConfig);
    await conectarYDesplegar(tienda, nuevo, owner);
    expect(m.triggers).toEqual([
      { serviceId: purgado.id, trigger: 'mailway' },
      { serviceId: imagen.id, trigger: 'mailway' },
      { serviceId: nuevo.id, trigger: 'mailway' },
    ]);
  });

  it('un servicio detenido desde el panel solo se despliega si se pide (la API no cambia)', async () => {
    const svc = bot(tienda, 'bot-detenido');
    setServiceStopped(svc.id, true);
    const r = await call('POST', `/api/projects/${tienda.id}/mail/connect`, owner, { serviceId: svc.id, mailboxId: mailboxBot, mode: 'api' });
    expect(r.status, r.raw).toBe(200);
    expect(r.json).toMatchObject({ needsRedeploy: true, deploymentId: null });
    expect(m.triggers).toEqual([]);
    expect(getService(svc.id)?.stopped_at).toBeTruthy();
  });
});

describe('conectar: el contrato de la API no cambia', () => {
  it('sin `redeploy` no se despliega: needsRedeploy, sin despliegue, y la credencial anterior se revoca al volver a conectar', async () => {
    const svc = bot(tienda, 'bot-avisos');
    let r = await call('POST', `/api/projects/${tienda.id}/mail/connect`, owner, { serviceId: svc.id, mailboxId: mailboxBot, mode: 'smtp' });
    expect(r.status, r.raw).toBe(200);
    expect(r.json).toMatchObject({ ok: true, needsRedeploy: true, deploymentId: null, revoked: 0 });
    expect(getEnv(svc.id).SMTP_USER).toBe('bot@tienda.es');

    // La pestaña reconoce la credencial que acaba de crear por sus nombres:
    // es la que se revoca al volver a conectar.
    const nombres = (await preview(tienda, svc, 'smtp', owner)).credentialNames as string[];
    const vigentes = () => mw.appPasswords.filter((a) => !a.revokedAt && nombres.includes(a.name));
    expect(vigentes()).toHaveLength(1);
    const anterior = vigentes()[0].id;

    r = await call('POST', `/api/projects/${tienda.id}/mail/connect`, owner, { serviceId: svc.id, mailboxId: mailboxBot, mode: 'smtp' });
    expect(r.status, r.raw).toBe(200);
    expect(r.json).toMatchObject({ ok: true, needsRedeploy: true, deploymentId: null, revoked: 1 });
    expect(mw.appPasswords.find((a) => a.id === anterior)?.revokedAt).not.toBeNull();
    expect(vigentes()).toHaveLength(1);
    expect(listDeployments(svc.id, 10)).toEqual([]);
  });

  it('por la API de envío, MAILWAY_API_URL es la dirección base de Mailway (el envío es POST …/v1/send)', async () => {
    const svc = bot(tienda, 'bot-api');
    const r = await call('POST', `/api/projects/${tienda.id}/mail/connect`, owner, { serviceId: svc.id, mailboxId: mailboxBot, mode: 'api' });
    expect(r.status, r.raw).toBe(200);
    expect(r.json).toMatchObject({ needsRedeploy: true, deploymentId: null });
    const env = getEnv(svc.id);
    expect(env.MAILWAY_API_URL).toBe(MW_BASE);
    expect(env.MAILWAY_API_URL.endsWith('/v1/send')).toBe(false);
    expect(env.MAILWAY_API_KEY).toBeTruthy();
    expect(env.MAIL_FROM).toBe('bot@tienda.es');
  });
});

describe('plan de integraciones', () => {
  it('reutilizar un buzón que ya existe pide confirmarlo hablando del servicio, no de una web', async () => {
    const svc = createService(tienda.id, 'Worker', 'worker', 'git', {
      repoUrl: 'https://github.com/x/worker',
      branch: 'main',
      port: 3000,
      domains: [],
      webhookSecret: 'w',
      needs: needsFrom({
        'skyway.json': JSON.stringify({
          version: 1,
          integrations: { mail: { mode: 'smtp', mailbox: 'bot' } },
          env: { SMTP_USER: { from: 'mail.user' }, SMTP_PASS: { from: 'mail.password' } },
        }),
      }),
    } as GitConfig);
    const r = await call('GET', `/api/services/${svc.id}/integrations`, owner);
    expect(r.status, r.raw).toBe(200);
    const correo = r.json.plan.resources.find((x: Json) => x.key === 'mail');
    expect(correo).toMatchObject({ action: 'reuse', target: 'bot@tienda.es' });
    expect(correo.confirmation).toMatch(/Apruébalo solo si ese buzón es para los envíos de este servicio\./);
    expect(correo.confirmation).not.toMatch(/web/);
  });
});
