/**
 * Webs que trabajan con el correo y sus bases sin configurarlas a mano:
 * detección del correo y del manifiesto `skyway.json`, nombres de variable por
 * alias al conectar un servicio, plan de integraciones (con su aprobación y su
 * aislamiento entre proyectos) y registros web en el fichero de zona. Mailway
 * es el doble de `mailwayfake.ts`; GitHub, un doble mínimo de su API de
 * contenidos.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
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
  getManagedEnv,
  getService,
  initDb,
  insertApiToken,
  listAudit,
  listServices,
  setEnv,
  setProjectVars,
  setSetting,
  setUserProjects,
  updateService,
  writeManagedEnv,
} from '../src/db';
import { importRepoEnv } from '../src/deploy/envimport';
import { reconcileOnDeploy } from '../src/integrations';
import { appendWebRecords } from '../src/mailway';
import { mailTargets, mailVarsOf } from '../src/mailenv';
import { parseManifest } from '../src/manifest';
import { adviseNeeds, detectNeeds } from '../src/needs';
import type { DetectedNeeds, GitConfig, ProjectRow, ServiceRow, UserRow } from '../src/types';
import { hashPassword, randomToken } from '../src/util';
import { MW_BASE, MW_TOKEN, fakeFetch, mw } from './mailwayfake';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

let app: FastifyInstance;
let adminCookie = '';
const admin = () => ({ cookie: adminCookie, ...SAME_ORIGIN });

let projA: ProjectRow;
let projB: ProjectRow;
let ownerA: Record<string, string>;
let memberA: Record<string, string>;
let ownerB: Record<string, string>;
let domainA = '';
let dbB: ServiceRow;

// ---------- doble de GitHub (árbol y contenidos de un repositorio) ----------

const repos = new Map<string, Record<string, string>>();

async function githubFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.host !== 'api.github.com') return fakeFetch(input, init);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  let m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/[^/]+$/);
  if (m) {
    const files = repos.get(`${m[1]}/${m[2]}`);
    if (!files) return json(404, { message: 'Not Found' });
    return json(200, { tree: Object.keys(files).map((p) => ({ path: p, type: 'blob' })), truncated: false });
  }
  m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
  if (m) {
    const text = repos.get(`${m[1]}/${m[2]}`)?.[decodeURIComponent(m[3])];
    if (text === undefined) return json(404, { message: 'Not Found' });
    return json(200, { content: Buffer.from(text).toString('base64'), encoding: 'base64', size: text.length });
  }
  return json(404, { message: 'Not Found' });
}

// ---------- utilidades ----------

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
    /* sin JSON (el fichero de zona es texto) */
  }
  return { status: r.statusCode, json: parsed, raw: r.body, headers: r.headers };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gitCfg(domains: string[] = [], needs?: DetectedNeeds): GitConfig {
  return { repoUrl: 'https://github.com/x/y', branch: 'main', port: 3000, domains, webhookSecret: 'w', ...(needs ? { needs } : {}) } as GitConfig;
}

function needsFrom(files: Record<string, string>): DetectedNeeds | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-needs-test-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    }
    return detectNeeds(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Huella del plan que ve `who`: lo que la web envía al aprobar. */
async function fingerprintOf(serviceId: string, who: Record<string, string>): Promise<string> {
  const r = await call('GET', `/api/services/${serviceId}/integrations`, who);
  expect(r.status, r.raw).toBe(200);
  return r.json.plan.fingerprint as string;
}

/** Aprobar como en la web: con la huella del plan que se acaba de ver. */
async function approve(serviceId: string, who: Record<string, string>, extra: Record<string, unknown> = {}) {
  return call('POST', `/api/services/${serviceId}/integrations/apply`, who, { expect: await fingerprintOf(serviceId, who), ...extra });
}

/** Lo que hace el primer despliegue con el `.env.example` del repositorio: importar lo que tiene valor. */
function importExample(service: ServiceRow, example: string): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-import-test-'));
  try {
    fs.writeFileSync(path.join(dir, '.env.example'), example);
    importRepoEnv({ service: getService(service.id)!, workDir: dir, contextDir: dir, log: () => {} });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Servicio de repositorio con lo detectado en `files` (como tras un despliegue). */
function webService(project: ProjectRow, name: string, files: Record<string, string>, domains: string[] = []): ServiceRow {
  const needs = needsFrom(files) ?? undefined;
  return createService(project.id, name, name.toLowerCase(), 'git', gitCfg(domains, needs));
}

const MANIFIESTO = JSON.stringify({
  version: 1,
  integrations: { mail: { mode: 'smtp', mailbox: 'no-reply' }, postgres: {} },
  env: {
    DATABASE_URL: { from: 'postgres.url' },
    SMTP_SERVER: { from: 'mail.host' },
    SMTP_LOGIN: { from: 'mail.user' },
    SMTP_PASSWORD: { from: 'mail.password' },
    MAIL_FROM_ADDRESS: { from: 'mail.from' },
    SESSION_SECRET: { generate: { bytes: 32 } },
    APP_URL: { from: 'self.public_url' },
    APP_NAME: { value: 'Tienda' },
  },
});

beforeAll(async () => {
  initDb();
  vi.stubGlobal('fetch', vi.fn(githubFetch));
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

  const modules = JSON.stringify(['mail', 'domains', 'databases']);
  const wsA = createWorkspaceRow('Tienda', { modules_override: modules, max_services: 100 });
  projA = createProject('Tienda', 'tienda', null, wsA.id);
  ownerA = bearerFor(createUser('owner@example.com', hashPassword('contraseña1'), 'owner', wsA.id));
  const member = createUser('member@example.com', hashPassword('contraseña1'), 'member', wsA.id);
  setUserProjects(member.id, [projA.id]);
  memberA = bearerFor(member);

  const wsB = createWorkspaceRow('Otro', { modules_override: modules });
  projB = createProject('Otro', 'otro', null, wsB.id);
  ownerB = bearerFor(createUser('ownerb@example.com', hashPassword('contraseña1'), 'owner', wsB.id));
  // Una base de OTRO proyecto: el plan de A no puede reutilizarla jamás.
  dbB = createService(projB.id, 'PostgreSQL', 'postgresql', 'database', { template: 'postgres', version: '16-alpine' });
  setEnv(dbB.id, { DATABASE_URL: 'postgresql://b' });

  // Correo del proyecto A con un dominio de propiedad comprobada.
  let r = await call('POST', `/api/projects/${projA.id}/mail/link`, ownerA, { mode: 'create' });
  expect(r.status, r.raw).toBe(201);
  r = await call('POST', `/api/projects/${projA.id}/mail/domains`, ownerA, { domain: 'tienda.es' });
  expect(r.status, r.raw).toBe(201);
  domainA = r.json.domain.id;
});

afterAll(async () => {
  await sleep(300);
  vi.unstubAllGlobals();
  await app.close();
  closeDb();
});

beforeEach(() => {
  mw.calls = [];
});

// ======================= A) detección =======================

describe('detección del correo', () => {
  it('por la librería y por las variables, con los nombres exactos y el modo SMTP', () => {
    const needs = needsFrom({
      'package.json': JSON.stringify({ dependencies: { nodemailer: '^6' } }),
      '.env.example': 'SMTP_SERVER=\nSMTP_PASSWORD=\nMAIL_FROM_ADDRESS=hola@x.com\nEMAIL_USE_TLS=true\nEMAIL_VERIFICATION=1\n',
    })!;
    expect(needs.mail).toMatchObject({ mode: 'smtp' });
    expect(needs.mail!.vars).toEqual([
      { name: 'SMTP_SERVER', role: 'host' },
      { name: 'SMTP_PASSWORD', role: 'password' },
      { name: 'MAIL_FROM_ADDRESS', role: 'from' },
      { name: 'EMAIL_USE_TLS', role: 'starttls' },
    ]);
    expect(needs.mail!.evidence[0]).toBe('package.json: nodemailer');
  });

  it('propone la API si la web pide MAILWAY_API_KEY o MAILWAY_API_URL', () => {
    const needs = needsFrom({ '.env.example': 'MAILWAY_API_URL=\nMAILWAY_API_KEY=\nMAIL_FROM=\n' })!;
    expect(needs.mail?.mode).toBe('api');
  });

  it('otras librerías (resend, @sendgrid/mail, postmark, emailjs) y otros ecosistemas', () => {
    for (const dep of ['resend', '@sendgrid/mail', 'postmark', 'emailjs']) {
      expect(needsFrom({ 'package.json': JSON.stringify({ dependencies: { [dep]: '1' } }) })?.mail?.evidence).toEqual([`package.json: ${dep}`]);
    }
    expect(needsFrom({ 'requirements.txt': 'Flask-Mail==0.9\n' })?.mail).not.toBeNull();
    expect(needsFrom({ 'composer.json': JSON.stringify({ require: { 'phpmailer/phpmailer': '^6' } }) })?.mail).not.toBeNull();
  });

  it('las variables propias de Mailway o un EMAIL_ suelto no son correo de la web', () => {
    const needs = needsFrom({ '.env.example': 'MAILWAY_SECRET=\nMAIL_HOSTNAME=\nEMAIL_VERIFICATION=1\nLETSENCRYPT_EMAIL=\n' })!;
    expect(needs.mail).toBeNull();
    // Una dependencia de desarrollo (pruebas) tampoco.
    expect(needsFrom({ 'package.json': JSON.stringify({ devDependencies: { nodemailer: '1' } }) })).toBeNull();
  });

  it('las variables de correo no salen como «missing»: las rellena el correo', () => {
    const needs = needsFrom({ '.env.example': 'SMTP_HOST=\nSMTP_PASS=\nOTRA=\n' })!;
    const advice = adviseNeeds(needs, { serviceName: 'web', domains: [], defined: new Set() }, []);
    expect(advice.missing).toEqual(['OTRA']);
    expect(advice.mail?.vars.map((v) => v.name)).toEqual(['SMTP_HOST', 'SMTP_PASS']);
  });

  it('nombres que se escriben: los esperados y, para lo que no nombra, los de siempre', () => {
    expect(mailTargets('smtp', mailVarsOf(['SMTP_PASSWORD', 'MAIL_FROM_ADDRESS'])).map((t) => t.name)).toEqual([
      'SMTP_PASSWORD',
      'MAIL_FROM_ADDRESS',
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_SECURE',
      'SMTP_USER',
    ]);
    expect(mailTargets('api', []).map((t) => t.name)).toEqual(['MAILWAY_API_URL', 'MAILWAY_API_KEY', 'MAIL_FROM']);
  });
});

describe('detección de bots y webhooks (needs.bots)', () => {
  it('por sus bibliotecas en cada ecosistema, con el fichero y el paquete; solo las de producción en npm', () => {
    const needs = needsFrom({
      'package.json': JSON.stringify({ dependencies: { telegraf: '^4', 'discord.js': '^14' }, devDependencies: { stripe: '^14' } }),
      'requirements.txt': 'aiogram==3.4\npython-telegram-bot[job-queue]>=21\nslack_bolt==1.18\n',
      'go.mod': 'module bot\n\nrequire (\n\tgithub.com/bwmarrin/discordgo v0.27.1\n\tgithub.com/stripe/stripe-go/v76 v76.0.0\n)\n',
      Gemfile: "gem 'telegram-bot-ruby'\ngem 'twilio-ruby'\n",
      'composer.json': JSON.stringify({ require: { 'nutgram/nutgram': '^4', 'stripe/stripe-php': '^13' } }),
    })!;
    expect(needs.bots).toEqual([
      { proveedor: 'telegram', evidencia: 'package.json: telegraf' },
      { proveedor: 'discord', evidencia: 'package.json: discord.js' },
      { proveedor: 'telegram', evidencia: 'requirements.txt: aiogram' },
      { proveedor: 'telegram', evidencia: 'requirements.txt: python-telegram-bot' },
      { proveedor: 'slack', evidencia: 'requirements.txt: slack-bolt' },
      { proveedor: 'discord', evidencia: 'go.mod: github.com/bwmarrin/discordgo' },
      { proveedor: 'stripe', evidencia: 'go.mod: github.com/stripe/stripe-go/v76' },
      { proveedor: 'telegram', evidencia: 'Gemfile: telegram-bot-ruby' },
      { proveedor: 'twilio', evidencia: 'Gemfile: twilio-ruby' },
      { proveedor: 'telegram', evidencia: 'composer.json: nutgram/nutgram' },
      { proveedor: 'stripe', evidencia: 'composer.json: stripe/stripe-php' },
    ]);
    expect(needs.sources).toEqual(expect.arrayContaining(['package.json', 'requirements.txt', 'go.mod', 'Gemfile', 'composer.json']));
  });

  it('Python: dependencias de Poetry (solo las de producción) y nombres normalizados como en PyPI', () => {
    const poetry = needsFrom({
      'pyproject.toml': [
        '[tool.poetry]',
        'name = "bot"',
        '',
        '[tool.poetry.dependencies]',
        'python = "^3.11"',
        'aiogram = "^3.4"',
        'Discord_Py = { version = "^2.3", extras = ["voice"] }',
        '',
        '[tool.poetry.group.dev.dependencies]',
        'stripe = "^9"',
        '',
        '[[tool.poetry.source]]',
        'twilio = "no es una dependencia"',
      ].join('\n'),
    })!;
    expect(poetry.bots).toEqual([
      { proveedor: 'telegram', evidencia: 'pyproject.toml: aiogram' },
      { proveedor: 'discord', evidencia: 'pyproject.toml: discord-py' },
    ]);
    // `discord.py` (como se escribe en PyPI) y `discord-py` son el mismo paquete.
    const req = needsFrom({ 'requirements.txt': 'discord.py==2.3\nPython_Telegram.Bot>=21\n' })!;
    expect(req.bots).toEqual([
      { proveedor: 'discord', evidencia: 'requirements.txt: discord-py' },
      { proveedor: 'telegram', evidencia: 'requirements.txt: python-telegram-bot' },
    ]);
  });

  it('un repositorio que solo es un bot ya dice algo; sin bibliotecas de bots, no hay `bots`', () => {
    const bot = needsFrom({ 'package.json': JSON.stringify({ dependencies: { grammy: '^1' } }) });
    expect(bot).not.toBeNull();
    expect(bot!.bots).toEqual([{ proveedor: 'telegram', evidencia: 'package.json: grammy' }]);
    expect(needsFrom({ 'package.json': JSON.stringify({ dependencies: { pg: '^8' } }) })!.bots).toBeUndefined();
    expect(needsFrom({ 'package.json': JSON.stringify({ devDependencies: { stripe: '^14' } }) })).toBeNull();
  });
});

// ======================= C) manifiesto =======================

describe('manifiesto skyway.json', () => {
  it('se lee de la raíz y se valida', () => {
    const needs = needsFrom({ 'skyway.json': MANIFIESTO })!;
    expect(needs.manifestFile).toBe('skyway.json');
    expect(needs.manifestError).toBeNull();
    expect(needs.manifest?.env?.SESSION_SECRET).toEqual({ generate: { bytes: 32 } });
  });

  it.each([
    [{ version: 2 }, /Versión no admitida/],
    [{ version: 1, build: 'npm run x' }, /campo no admitido \(build\)/],
    [{ version: 1, env: { PORT: { value: '80' } } }, /PORT y las variables SKYWAY_\*/],
    [{ version: 1, env: { SKYWAY_TOKEN: { value: 'x' } } }, /SKYWAY_/],
    [{ version: 1, env: { X: { value: '${{Postgres.DATABASE_URL}}' } } }, /no puede contener referencias/],
    [{ version: 1, env: { X: { generate: { bytes: 8 } } } }, /al menos 16 bytes/],
    [{ version: 1, env: { X: { from: 'otro.servicio' } } }, /Origen desconocido/],
    [{ version: 1, env: { X: { run: 'rm -rf /' } } }, /exactamente uno de estos campos/],
    [{ version: 1, integrations: { mail: { mode: 'api' } }, env: { P: { from: 'mail.password' } } }, /mail\.password no existe en el modo API/],
    [{ version: 1, integrations: { mail: { mailbox: 'a+b' } } }, /Buzón no válido/],
    [{ version: 1, integrations: { mongo: {} } }, /campo no admitido \(mongo\)/],
  ])('rechaza %j', (raw, error) => {
    const r = parseManifest(JSON.stringify(raw));
    expect(r.manifest).toBeNull();
    expect(r.error).toMatch(error);
  });

  it('no admite más de 64 KB ni JSON roto', () => {
    expect(parseManifest('{').error).toMatch(/no es JSON válido/);
    expect(parseManifest(JSON.stringify({ version: 1, env: { A: { value: 'x'.repeat(70_000) } } })).error).toMatch(/64 KB/);
  });
});

// ======================= B) nombres por alias al conectar =======================

describe('conectar un servicio: nombres que espera la web', () => {
  let mailboxId = '';

  beforeAll(async () => {
    const r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes`, ownerA, { domainId: domainA, localPart: 'avisos' });
    expect(r.status, r.raw).toBe(201);
    mailboxId = r.json.mailbox.id;
  });

  it('escribe los nombres del .env.example y los de siempre para lo que no nombra', async () => {
    const svc = webService(projA, 'Django', {
      '.env.example': 'EMAIL_HOST=\nEMAIL_HOST_USER=\nEMAIL_HOST_PASSWORD=\nEMAIL_USE_TLS=\nDEFAULT_FROM_EMAIL=\n',
    });
    const preview = await call('GET', `/api/projects/${projA.id}/mail/connect/preview?serviceId=${svc.id}&mode=smtp`, memberA);
    expect(preview.status, preview.raw).toBe(200);
    expect(preview.json.keys).toEqual(['EMAIL_HOST', 'EMAIL_HOST_USER', 'EMAIL_HOST_PASSWORD', 'EMAIL_USE_TLS', 'DEFAULT_FROM_EMAIL', 'SMTP_PORT', 'SMTP_SECURE']);

    const r = await call('POST', `/api/projects/${projA.id}/mail/connect`, ownerA, { serviceId: svc.id, mailboxId, mode: 'smtp' });
    expect(r.status, r.raw).toBe(200);
    const env = getEnv(svc.id);
    expect(env).toMatchObject({
      EMAIL_HOST: 'mail.example.com',
      EMAIL_HOST_USER: 'avisos@tienda.es',
      EMAIL_USE_TLS: 'true',
      DEFAULT_FROM_EMAIL: 'avisos@tienda.es',
      SMTP_PORT: '587',
    });
    expect(env.EMAIL_HOST_PASSWORD).toMatch(/^ContraseñaDeAplicacion-Secreta-/);
    expect(env.SMTP_PASS).toBeUndefined();
    // Se recuerda qué escribió Skyway (con su hash, nunca el valor).
    expect(getManagedEnv(svc.id).EMAIL_HOST_PASSWORD.origin).toBe('mail.smtp.password');
    expect(JSON.stringify(getManagedEnv(svc.id))).not.toContain('Secreta');
  });

  it('al volver a conectar actualiza lo suyo, pero nunca lo que se ha cambiado a mano', async () => {
    const svc = webService(projA, 'Laravel', { '.env.example': 'MAIL_HOST=\nMAIL_USERNAME=\nMAIL_PASSWORD=\nMAIL_ENCRYPTION=\nMAIL_FROM_ADDRESS=\n' });
    let r = await call('POST', `/api/projects/${projA.id}/mail/connect`, ownerA, { serviceId: svc.id, mailboxId, mode: 'smtp' });
    expect(r.status, r.raw).toBe(200);
    const primera = getEnv(svc.id).MAIL_PASSWORD;
    setEnv(svc.id, { ...getEnv(svc.id), MAIL_FROM_ADDRESS: 'ventas@tienda.es' });
    r = await call('POST', `/api/projects/${projA.id}/mail/connect`, ownerA, { serviceId: svc.id, mailboxId, mode: 'smtp' });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.kept).toEqual(['MAIL_FROM_ADDRESS']);
    expect(r.json.revoked).toBe(1);
    const env = getEnv(svc.id);
    expect(env.MAIL_FROM_ADDRESS).toBe('ventas@tienda.es');
    expect(env.MAIL_PASSWORD).not.toBe(primera);
    expect(env.MAIL_ENCRYPTION).toBe('tls');
    const audit = listAudit({ action: 'mailway_service_connected' }).map((a) => String(a.detail));
    expect(audit.some((d) => d.includes('sin tocar (puestas a mano): MAIL_FROM_ADDRESS'))).toBe(true);
  });

  it('si la credencial no cabe en ninguna variable (puestas a mano), no se crea nada', async () => {
    const svc = webService(projA, 'Externo', { '.env.example': 'SMTP_PASSWORD=\n' });
    setEnv(svc.id, { SMTP_PASSWORD: 'clave-de-otro-proveedor' });
    const antes = mw.appPasswords.length;
    const r = await call('POST', `/api/projects/${projA.id}/mail/connect`, ownerA, { serviceId: svc.id, mailboxId, mode: 'smtp' });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/SMTP_PASSWORD tiene un valor puesto a mano/);
    expect(mw.appPasswords.length).toBe(antes);
    expect(getEnv(svc.id).SMTP_PASSWORD).toBe('clave-de-otro-proveedor');
  });

  it('un servicio conectado antes de llevar la cuenta sigue actualizándose con los nombres de siempre', async () => {
    const svc = createService(projA.id, 'Antiguo', 'antiguo', 'image', { image: 'nginx', domains: [] });
    let r = await call('POST', `/api/projects/${projA.id}/mail/connect`, ownerA, { serviceId: svc.id, mailboxId, mode: 'smtp' });
    expect(r.status, r.raw).toBe(200);
    // Como si fuera de una versión anterior: las variables están, la cuenta no.
    const raw = new Database(path.join(process.env.DATA_DIR!, 'skyway.db'));
    raw.prepare('DELETE FROM service_managed_env WHERE service_id = ?').run(svc.id);
    raw.close();
    r = await call('POST', `/api/projects/${projA.id}/mail/connect`, ownerA, { serviceId: svc.id, mailboxId, mode: 'smtp' });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.kept).toEqual([]);
    expect(r.json.keys).toContain('SMTP_PASS');
    // Desde ahí ya se lleva la cuenta: un cambio a mano en un nombre «de siempre» se respeta.
    setEnv(svc.id, { ...getEnv(svc.id), SMTP_FROM: 'otra@tienda.es' });
    r = await call('POST', `/api/projects/${projA.id}/mail/connect`, ownerA, { serviceId: svc.id, mailboxId, mode: 'smtp' });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.kept).toEqual(['SMTP_FROM']);
    expect(getEnv(svc.id).SMTP_FROM).toBe('otra@tienda.es');
  });

  it('una variable compartida del proyecto con otro valor tampoco se tapa', async () => {
    const svc = createService(projA.id, 'Compartida', 'compartida', 'image', { image: 'nginx', domains: [] });
    setProjectVars(projA.id, { SMTP_FROM: 'equipo@tienda.es' });
    try {
      const r = await call('POST', `/api/projects/${projA.id}/mail/connect`, ownerA, { serviceId: svc.id, mailboxId, mode: 'smtp' });
      expect(r.status, r.raw).toBe(200);
      expect(r.json.kept).toEqual(['SMTP_FROM']);
      expect(getEnv(svc.id).SMTP_FROM).toBeUndefined();
    } finally {
      setProjectVars(projA.id, {});
    }
  });

  it('Laravel: lo que el primer despliegue importó del .env.example es de Skyway y se sustituye al conectar', async () => {
    // El .env.example por defecto de Laravel: «mailpit» y «null» no son valores
    // de ejemplo para la importación, así que el primer despliegue los importa.
    const example = [
      'APP_NAME=Laravel',
      'MAIL_MAILER=smtp',
      'MAIL_HOST=mailpit',
      'MAIL_PORT=1025',
      'MAIL_USERNAME=null',
      'MAIL_PASSWORD=null',
      'MAIL_ENCRYPTION=null',
      'MAIL_FROM_ADDRESS="hello@example.com"',
      'MAIL_FROM_NAME="${APP_NAME}"',
      '',
    ].join('\n');
    const svc = webService(projA, 'LaravelImportado', { '.env.example': example });
    importExample(svc, example);
    expect(getEnv(svc.id)).toMatchObject({ MAIL_HOST: 'mailpit', MAIL_PORT: '1025', MAIL_USERNAME: 'null', MAIL_PASSWORD: 'null' });
    expect(getManagedEnv(svc.id).MAIL_HOST.origin).toBe('import');

    const preview = await call('GET', `/api/projects/${projA.id}/mail/connect/preview?serviceId=${svc.id}&mode=smtp`, ownerA);
    expect(preview.json).toMatchObject({ kept: [], conflicts: [], secretPlaced: true });
    const r = await call('POST', `/api/projects/${projA.id}/mail/connect`, ownerA, { serviceId: svc.id, mailboxId, mode: 'smtp' });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.kept).toEqual([]);
    const env = getEnv(svc.id);
    expect(env).toMatchObject({
      MAIL_HOST: 'mail.example.com',
      MAIL_PORT: '587',
      MAIL_USERNAME: 'avisos@tienda.es',
      MAIL_ENCRYPTION: 'tls',
      MAIL_FROM_ADDRESS: 'avisos@tienda.es',
      // Lo que no es de correo se queda como se importó.
      APP_NAME: 'Laravel',
      MAIL_MAILER: 'smtp',
    });
    expect(env.MAIL_PASSWORD).toMatch(/^ContraseñaDeAplicacion-Secreta-/);
    expect(getManagedEnv(svc.id).MAIL_HOST.origin).toBe('mail.smtp.host');
  });

  it('un servidor de otro proveedor: importado se sustituye; puesto a mano, no se conecta a medias', async () => {
    const example = 'SMTP_HOST=smtp.gmail.com\nSMTP_PORT=587\nSMTP_USER=\nSMTP_PASS=\n';
    const files = { 'package.json': JSON.stringify({ dependencies: { nodemailer: '^6' } }), '.env.example': example };
    const importado = webService(projA, 'GmailImportado', files);
    importExample(importado, example);
    expect(getEnv(importado.id).SMTP_HOST).toBe('smtp.gmail.com');
    let r = await call('POST', `/api/projects/${projA.id}/mail/connect`, ownerA, { serviceId: importado.id, mailboxId, mode: 'smtp' });
    expect(r.status, r.raw).toBe(200);
    expect(getEnv(importado.id)).toMatchObject({ SMTP_HOST: 'mail.example.com', SMTP_USER: 'avisos@tienda.es' });

    // Puesto a mano: escribir solo la credencial la mandaría a Gmail.
    const aMano = webService(projA, 'GmailAMano', files);
    setEnv(aMano.id, { SMTP_HOST: 'smtp.gmail.com' });
    const preview = await call('GET', `/api/projects/${projA.id}/mail/connect/preview?serviceId=${aMano.id}&mode=smtp`, ownerA);
    expect(preview.json.conflicts).toEqual(['SMTP_HOST']);
    const apps = mw.appPasswords.length;
    r = await call('POST', `/api/projects/${projA.id}/mail/connect`, ownerA, { serviceId: aMano.id, mailboxId, mode: 'smtp' });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/SMTP_HOST tiene un valor puesto a mano distinto del de Mailway/);
    expect(mw.appPasswords.length).toBe(apps);
    expect(getEnv(aMano.id)).toEqual({ SMTP_HOST: 'smtp.gmail.com' });

    // El plan de un manifiesto tampoco lo aplica: lo deja bloqueado con el motivo.
    const manifiesto = webService(projA, 'GmailManifiesto', {
      'skyway.json': JSON.stringify({ version: 1, integrations: { mail: {} }, env: { SMTP_SERVER: { from: 'mail.host' }, SMTP_PASSWORD: { from: 'mail.password' } } }),
    });
    setEnv(manifiesto.id, { SMTP_SERVER: 'smtp.gmail.com' });
    const plan = (await call('GET', `/api/services/${manifiesto.id}/integrations`, ownerA)).json.plan;
    expect(plan.resources[0]).toMatchObject({ key: 'mail', status: 'blocked' });
    expect(plan.resources[0].reason).toMatch(/SMTP_SERVER tiene un valor puesto a mano distinto del de Mailway/);
    expect(plan.pendingApproval).toEqual([]);
  });

  it('aislamiento: la vista previa de un servicio de otro proyecto es 404', async () => {
    const svcB = createService(projB.id, 'Web', 'web', 'git', gitCfg());
    const r = await call('GET', `/api/projects/${projA.id}/mail/connect/preview?serviceId=${svcB.id}`, ownerA);
    expect(r.status).toBe(404);
    expect((await call('GET', `/api/projects/${projA.id}/mail/connect/preview?serviceId=${svcB.id}`, ownerB)).status).toBe(403);
  });
});

// ======================= C) plan de integraciones =======================

describe('plan de integraciones', () => {
  it('el plan se enseña sin efectos: qué se crea, qué se reutiliza y qué requiere aprobación', async () => {
    const svc = webService(projA, 'Tienda', { 'skyway.json': MANIFIESTO }, ['www.tienda.es']);
    const antes = { servicios: listServices(projA.id).length, buzones: mw.mailboxes.length };
    const r = await call('GET', `/api/services/${svc.id}/integrations`, memberA);
    expect(r.status, r.raw).toBe(200);
    const plan = r.json.plan;
    expect(plan.source).toBe('manifest');
    // La base la puede aprobar un miembro (como crearla a mano); el correo, no.
    expect(plan.canApprove).toBe(false);
    expect(plan.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(plan.resources.find((x: Json) => x.key === 'postgres')).toMatchObject({ action: 'create', status: 'apply', canApprove: true });
    expect(plan.resources.find((x: Json) => x.key === 'mail')).toMatchObject({
      action: 'create',
      target: 'no-reply@tienda.es',
      status: 'apply',
      mode: 'smtp',
      canApprove: false,
      confirmation: null,
    });
    const byName = Object.fromEntries(plan.vars.map((v: Json) => [v.name, v]));
    expect(byName.SESSION_SECRET).toMatchObject({ privileged: false, status: 'apply', detail: '32 bytes aleatorios' });
    expect(byName.APP_URL).toMatchObject({ privileged: false, status: 'apply', detail: '${{tienda.PUBLIC_URL}}' });
    expect(byName.DATABASE_URL).toMatchObject({ privileged: true, status: 'apply' });
    expect(plan.pendingApproval.sort()).toEqual(['DATABASE_URL', 'MAIL_FROM_ADDRESS', 'SMTP_LOGIN', 'SMTP_PASSWORD', 'SMTP_SERVER']);
    // Sin efectos: ni servicios, ni buzones, ni variables.
    expect(listServices(projA.id).length).toBe(antes.servicios);
    expect(mw.mailboxes.length).toBe(antes.buzones);
    expect(getEnv(svc.id)).toEqual({});
  });

  it('sin la huella del plan revisado solo se aplica lo inofensivo: la base y el correo quedan pendientes', async () => {
    const svc = webService(projA, 'Miembro', { 'skyway.json': MANIFIESTO }, ['miembro.tienda.es']);
    setEnv(svc.id, { APP_NAME: 'Puesto a mano' });
    const r = await call('POST', `/api/services/${svc.id}/integrations/apply`, memberA, {});
    expect(r.status, r.raw).toBe(200);
    expect(r.json.result.applied.sort()).toEqual(['APP_URL', 'SESSION_SECRET']);
    expect(r.json.result.kept).toEqual(['APP_NAME']);
    expect(r.json.result.pending.sort()).toEqual(['DATABASE_URL', 'MAIL_FROM_ADDRESS', 'SMTP_LOGIN', 'SMTP_PASSWORD', 'SMTP_SERVER']);
    const env = getEnv(svc.id);
    expect(env.SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(env.APP_URL).toBe('${{miembro.PUBLIC_URL}}');
    expect(env.APP_NAME).toBe('Puesto a mano');
    expect(env.DATABASE_URL).toBeUndefined();
    expect((getService(svc.id)!.config as GitConfig).integrationsPending?.sort()).toEqual(r.json.result.pending.sort());
    // La auditoría lista nombres, nunca valores.
    const detalle = listAudit({ action: 'service_integrations_applied' }).map((a) => String(a.detail)).join('\n');
    expect(detalle).toContain('pendientes de aprobar');
    expect(detalle).not.toContain(env.SESSION_SECRET);

    // Aplicarlo otra vez no regenera el secreto.
    await call('POST', `/api/services/${svc.id}/integrations/apply`, memberA, {});
    expect(getEnv(svc.id).SESSION_SECRET).toBe(env.SESSION_SECRET);
  });

  it('un miembro aprueba la base (la misma regla que crearla a mano), pero el correo sigue pendiente', async () => {
    const svc = webService(projA, 'Miembro2', { 'skyway.json': MANIFIESTO }, ['miembro2.tienda.es']);
    const apps = mw.appPasswords.length;
    const r = await approve(svc.id, memberA);
    expect(r.status, r.raw).toBe(200);
    expect(r.json.result.created).toEqual(['PostgreSQL']);
    expect(getEnv(svc.id).DATABASE_URL).toBe('${{PostgreSQL.DATABASE_URL}}');
    expect(r.json.result.pending.sort()).toEqual(['MAIL_FROM_ADDRESS', 'SMTP_LOGIN', 'SMTP_PASSWORD', 'SMTP_SERVER']);
    expect(getEnv(svc.id).SMTP_PASSWORD).toBeUndefined();
    expect(mw.appPasswords.length).toBe(apps);
    expect((getService(svc.id)!.config as GitConfig).integrationsPending?.sort()).toEqual(r.json.result.pending.sort());
  });

  it('quien gestiona el proyecto lo aprueba: reutiliza la base y crea el buzón y la credencial con los nombres del manifiesto', async () => {
    const svc = webService(projA, 'Propietario', { 'skyway.json': MANIFIESTO }, ['propietario.tienda.es']);
    const r = await approve(svc.id, ownerA);
    expect(r.status, r.raw).toBe(200);
    expect(r.json.result.pending).toEqual([]);
    expect(r.json.result.errors).toEqual([]);
    expect(r.json.result.created).toEqual(['no-reply@tienda.es']);
    const env = getEnv(svc.id);
    expect(env.DATABASE_URL).toBe('${{PostgreSQL.DATABASE_URL}}');
    expect(env).toMatchObject({ SMTP_SERVER: 'mail.example.com', SMTP_LOGIN: 'no-reply@tienda.es', MAIL_FROM_ADDRESS: 'no-reply@tienda.es' });
    expect(env.SMTP_PASSWORD).toMatch(/^ContraseñaDeAplicacion-Secreta-/);
    // Solo lo que pide el manifiesto: nada de SMTP_HOST ni SMTP_PASS «de siempre».
    expect(env.SMTP_HOST).toBeUndefined();
    expect(env.SMTP_PASS).toBeUndefined();
    expect(r.json.raw ?? JSON.stringify(r.json)).not.toContain('Secreta');
    expect(r.json.plan.pendingApproval).toEqual([]);
    expect((getService(svc.id)!.config as GitConfig).integrationsPending).toBeUndefined();

    // Una segunda web del proyecto reutiliza esa base y ese buzón.
    const otra = webService(projA, 'Segunda', { 'skyway.json': MANIFIESTO });
    const r2 = await approve(otra.id, ownerA);
    expect(r2.status, r2.raw).toBe(200);
    expect(r2.json.result.created).toEqual([]);
    expect(getEnv(otra.id).DATABASE_URL).toBe('${{PostgreSQL.DATABASE_URL}}');
    // Y sin dominio, la URL propia queda bloqueada hasta tenerlo.
    expect(r2.json.result.blocked.map((b: Json) => b.name)).toEqual(['APP_URL']);
  });

  it('aislamiento: nunca reutiliza una base de otro proyecto ni opera sobre su correo', async () => {
    const svc = webService(projB, 'WebB', { 'skyway.json': JSON.stringify({ version: 1, env: { DATABASE_URL: { from: 'postgres.url' } } }) });
    let r = await call('GET', `/api/services/${svc.id}/integrations`, ownerA);
    expect(r.status).toBe(403);
    r = await call('POST', `/api/services/${svc.id}/integrations/apply`, ownerA, {});
    expect(r.status).toBe(403);
    r = await call('GET', `/api/services/${svc.id}/integrations`, ownerB);
    expect(r.status, r.raw).toBe(200);
    // B tiene su propia base: se reutiliza la suya.
    expect(r.json.plan.resources[0]).toMatchObject({ key: 'postgres', action: 'reuse', target: dbB.name });
    // El correo de B no está activado: el plan lo explica y lo deja pendiente.
    const conCorreo = webService(projB, 'CorreoB', { 'skyway.json': JSON.stringify({ version: 1, integrations: { mail: {} } }) });
    r = await call('GET', `/api/services/${conCorreo.id}/integrations`, ownerB);
    expect(r.json.plan.resources[0]).toMatchObject({ key: 'mail', status: 'blocked' });
    expect(r.json.plan.resources[0].reason).toMatch(/no está activado en este proyecto/);
    const calls = mw.calls.length;
    r = await call('POST', `/api/services/${conCorreo.id}/integrations/apply`, ownerB, {});
    expect(r.status).toBe(200);
    expect(mw.calls.slice(calls).some((c) => c.method !== 'GET')).toBe(false);
  });

  it('con la propiedad del dominio pendiente, el correo queda pendiente con su motivo', async () => {
    const ws = createWorkspaceRow('Pendiente', { modules_override: JSON.stringify(['mail', 'databases']) });
    const proj = createProject('Pendiente', 'pendiente', null, ws.id);
    const owner = bearerFor(createUser('owner-p@example.com', hashPassword('contraseña1'), 'owner', ws.id));
    expect((await call('POST', `/api/projects/${proj.id}/mail/link`, owner, { mode: 'create' })).status).toBe(201);
    mw.requireOwnership = true;
    try {
      expect((await call('POST', `/api/projects/${proj.id}/mail/domains`, owner, { domain: 'pendiente.es' })).status).toBe(201);
    } finally {
      mw.requireOwnership = false;
    }
    const svc = webService(proj, 'Web', { 'skyway.json': JSON.stringify({ version: 1, integrations: { mail: {} } }) });
    const r = await call('POST', `/api/services/${svc.id}/integrations/apply`, owner, {});
    expect(r.status, r.raw).toBe(200);
    expect(r.json.plan.resources[0]).toMatchObject({ key: 'mail', status: 'blocked' });
    expect(r.json.plan.resources[0].reason).toMatch(/propiedad de pendiente\.es todavía no está comprobada/);
    expect(getEnv(svc.id)).toEqual({});
  });

  it('sin el módulo «Correo» el correo se bloquea, y sin «Bases de datos» la base', async () => {
    const ws = createWorkspaceRow('Sin módulos', { modules_override: JSON.stringify(['domains']) });
    const proj = createProject('Sin módulos', 'sin-modulos', null, ws.id);
    const owner = bearerFor(createUser('owner-s@example.com', hashPassword('contraseña1'), 'owner', ws.id));
    const svc = webService(proj, 'Web', { 'skyway.json': MANIFIESTO });
    const r = await call('POST', `/api/services/${svc.id}/integrations/apply`, owner, {});
    expect(r.status, r.raw).toBe(200);
    const res = Object.fromEntries(r.json.plan.resources.map((x: Json) => [x.key, x]));
    expect(res.mail.reason).toMatch(/módulo «Correo» no está activo/);
    expect(res.postgres.reason).toMatch(/módulo «Bases de datos» no está activo/);
    expect(listServices(proj.id).filter((s) => s.type === 'database')).toEqual([]);
    expect(getEnv(svc.id).SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
  });

  it('un manifiesto no válido no aplica nada y lo explica', async () => {
    const svc = webService(projA, 'Roto', { 'skyway.json': '{"version":1,"env":{"PORT":{"value":"80"}}}', '.env.example': 'REDIS_URL=\n' });
    const r = await call('POST', `/api/services/${svc.id}/integrations/apply`, ownerA, {});
    expect(r.status).toBe(200);
    expect(r.json.plan.manifestError).toMatch(/PORT/);
    expect(r.json.result.applied).toEqual([]);
    expect(getEnv(svc.id)).toEqual({});
  });
});

describe('aprobación ligada al plan revisado', () => {
  const conBuzon = (mailbox: string) =>
    JSON.stringify({
      version: 1,
      integrations: { mail: { mode: 'smtp', mailbox } },
      env: { SMTP_LOGIN: { from: 'mail.user' }, SMTP_PASSWORD: { from: 'mail.password' }, APP_NAME: { value: 'Web' } },
    });

  it('si el manifiesto cambia entre ver el plan y aprobarlo, responde 409 con el plan nuevo y no aplica nada', async () => {
    // El buzón personal de dirección, creado a mano.
    let r = await call('POST', `/api/projects/${projA.id}/mail/mailboxes`, ownerA, { domainId: domainA, localPart: 'direccion' });
    expect(r.status, r.raw).toBe(201);
    const direccionId = r.json.mailbox.id as string;
    const svc = webService(projA, 'Cambiante', { 'skyway.json': conBuzon('envios') });

    // El propietario ve «crear el buzón envios@tienda.es».
    r = await call('GET', `/api/services/${svc.id}/integrations`, ownerA);
    expect(r.json.plan.resources[0]).toMatchObject({ key: 'mail', action: 'create', target: 'envios@tienda.es', confirmation: null });
    const visto = r.json.plan.fingerprint as string;

    // Un push con otro manifiesto y su despliegue (lo que hace recordNeeds).
    const cfg = getService(svc.id)!.config as GitConfig;
    updateService(svc.id, svc.name, { ...cfg, needs: needsFrom({ 'skyway.json': conBuzon('direccion') })! });

    // «Aprobar y aplicar» con lo que vio: no se aprueba otra cosa a ciegas.
    const antes = { apps: mw.appPasswords.length, buzones: mw.mailboxes.length };
    r = await call('POST', `/api/services/${svc.id}/integrations/apply`, ownerA, { redeploy: true, expect: visto });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/El plan ha cambiado desde que lo revisaste/);
    expect(r.json.plan.resources[0]).toMatchObject({ key: 'mail', action: 'reuse', target: 'direccion@tienda.es' });
    expect(r.json.plan.fingerprint).not.toBe(visto);
    expect(mw.appPasswords.length).toBe(antes.apps);
    expect(mw.mailboxes.length).toBe(antes.buzones);
    expect(getEnv(svc.id)).toEqual({});

    // Revisado de nuevo: reutilizar un buzón que ya existe pide confirmar el acceso.
    const nuevo = r.json.plan;
    expect(nuevo.resources[0].confirmation).toMatch(/direccion@tienda\.es ya existe: su contraseña de aplicación da acceso IMAP y SMTP/);
    r = await call('POST', `/api/services/${svc.id}/integrations/apply`, ownerA, { expect: nuevo.fingerprint });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.result.pending.sort()).toEqual(['SMTP_LOGIN', 'SMTP_PASSWORD']);
    expect(r.json.result.errors.join(' ')).toMatch(/Confírmalo para aplicarlo/);
    expect(getEnv(svc.id).SMTP_PASSWORD).toBeUndefined();
    expect(getEnv(svc.id).APP_NAME).toBe('Web');
    expect(mw.appPasswords.some((a) => a.mailboxId === direccionId && !a.revokedAt)).toBe(false);

    // Con la confirmación expresa, sí.
    r = await call('POST', `/api/services/${svc.id}/integrations/apply`, ownerA, { expect: nuevo.fingerprint, confirmMailboxAccess: true });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.result.pending).toEqual([]);
    expect(getEnv(svc.id).SMTP_LOGIN).toBe('direccion@tienda.es');
    expect(mw.appPasswords.filter((a) => a.mailboxId === direccionId && !a.revokedAt).length).toBe(1);
  });

  it('una huella con otro formato se rechaza antes de aplicar nada', async () => {
    const svc = webService(projA, 'HuellaMala', { 'skyway.json': conBuzon('envios') });
    const r = await call('POST', `/api/services/${svc.id}/integrations/apply`, ownerA, { expect: 'x' });
    expect(r.status).toBe(400);
    expect(getEnv(svc.id)).toEqual({});
  });

  it('en el alta, si el repositorio cambia entre el plan y la creación, lo privilegiado queda pendiente', async () => {
    const uno = { version: 1, env: { DATABASE_URL: { from: 'postgres.url' }, APP_NAME: { value: 'Uno' } } };
    repos.set('acme/cambia', { 'skyway.json': JSON.stringify(uno) });
    const q = new URLSearchParams({ repo: 'acme/cambia', branch: 'main', name: 'Cambia' });
    const visto = await call('GET', `/api/projects/${projA.id}/github/needs?${q}`, ownerA);
    expect(visto.status, visto.raw).toBe(200);
    // Entre medias, el repositorio pasa a pedir también Redis.
    repos.set('acme/cambia', { 'skyway.json': JSON.stringify({ ...uno, env: { ...uno.env, CACHE_URL: { from: 'redis.url' } } }) });
    const r = await call('POST', `/api/projects/${projA.id}/services`, ownerA, {
      type: 'git',
      name: 'Cambia',
      repoUrl: 'acme/cambia',
      branch: 'main',
      plan: { expect: visto.json.plan.fingerprint },
    });
    expect(r.status, r.raw).toBe(201);
    await sleep(200);
    expect(r.json.plan.result.errors.join(' ')).toMatch(/El plan ha cambiado desde que lo revisaste/);
    const env = getEnv(r.json.service.id);
    expect(env.APP_NAME).toBe('Uno');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.CACHE_URL).toBeUndefined();
    expect((getService(r.json.service.id)!.config as GitConfig).integrationsPending?.sort()).toEqual(['CACHE_URL', 'DATABASE_URL']);
  });
});

describe('despliegues posteriores', () => {
  it('lo inofensivo nuevo se aplica; lo privilegiado nuevo queda pendiente y se avisa en el registro', async () => {
    const svc = webService(projA, 'Evoluciona', { 'skyway.json': JSON.stringify({ version: 1, env: { SECRET_KEY: { generate: {} } } }) });
    let cfg = getService(svc.id)!.config as GitConfig;
    const log: string[] = [];
    expect(reconcileOnDeploy(getService(svc.id)!, cfg, (l) => log.push(l))).toBe(true);
    expect(getEnv(svc.id).SECRET_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(log.join('\n')).toMatch(/se han definido SECRET_KEY/);
    expect(log.join('\n')).not.toContain(getEnv(svc.id).SECRET_KEY);

    // El repositorio pasa a pedir Redis: no se conecta solo.
    const nuevo = needsFrom({
      'skyway.json': JSON.stringify({ version: 1, env: { SECRET_KEY: { generate: {} }, CACHE_URL: { from: 'redis.url' } } }),
    })!;
    updateService(svc.id, svc.name, { ...cfg, needs: nuevo });
    cfg = getService(svc.id)!.config as GitConfig;
    log.length = 0;
    expect(reconcileOnDeploy(getService(svc.id)!, cfg, (l) => log.push(l))).toBe(false);
    expect(getEnv(svc.id).CACHE_URL).toBeUndefined();
    expect(log.join('\n')).toMatch(/pide cambios que requieren aprobación \(Redis: CACHE_URL\)\. El despliegue continúa con lo ya aprobado/);
    expect((getService(svc.id)!.config as GitConfig).integrationsPending).toEqual(['CACHE_URL']);

    // Cualquiera con acceso al proyecto lo aprueba desde el panel (es una base).
    const r = await approve(svc.id, memberA);
    expect(r.status, r.raw).toBe(200);
    expect(getEnv(svc.id).CACHE_URL).toMatch(/^\$\{\{Redis\.REDIS_URL\}\}$/);
    expect((getService(svc.id)!.config as GitConfig).integrationsPending).toBeUndefined();
  });

  it('un secreto que el manifiesto pide generar sustituye el valor de ejemplo importado del repositorio', async () => {
    const example = 'SECRET_KEY=dev-secret-123\n';
    const svc = webService(projA, 'SecretoImportado', {
      'skyway.json': JSON.stringify({ version: 1, env: { SECRET_KEY: { generate: {} } } }),
      '.env.example': example,
    });
    importExample(svc, example);
    expect(getEnv(svc.id).SECRET_KEY).toBe('dev-secret-123');
    reconcileOnDeploy(getService(svc.id)!, getService(svc.id)!.config as GitConfig, () => {});
    const generado = getEnv(svc.id).SECRET_KEY;
    expect(generado).toMatch(/^[0-9a-f]{64}$/);
    // Ya generado, no se vuelve a tocar.
    reconcileOnDeploy(getService(svc.id)!, getService(svc.id)!.config as GitConfig, () => {});
    expect(getEnv(svc.id).SECRET_KEY).toBe(generado);
  });

  it('una variable gestionada que alguien cambia a mano pasa a ser suya', async () => {
    const svc = webService(projA, 'Cambiada', { 'skyway.json': JSON.stringify({ version: 1, env: { APP_NAME: { value: 'Uno' } } }) });
    const cfg = getService(svc.id)!.config as GitConfig;
    reconcileOnDeploy(getService(svc.id)!, cfg, () => {});
    expect(getEnv(svc.id).APP_NAME).toBe('Uno');
    setEnv(svc.id, { APP_NAME: 'Mío' });
    const needs = needsFrom({ 'skyway.json': JSON.stringify({ version: 1, env: { APP_NAME: { value: 'Dos' } } }) })!;
    updateService(svc.id, svc.name, { ...cfg, needs });
    reconcileOnDeploy(getService(svc.id)!, getService(svc.id)!.config as GitConfig, () => {});
    expect(getEnv(svc.id).APP_NAME).toBe('Mío');
    // Si no la toca nadie, el valor nuevo del manifiesto sí se aplica.
    writeManagedEnv(svc.id, { APP_NAME: { value: 'Uno', origin: 'value' } });
    reconcileOnDeploy(getService(svc.id)!, getService(svc.id)!.config as GitConfig, () => {});
    expect(getEnv(svc.id).APP_NAME).toBe('Dos');
  });
});

describe('alta desde un repositorio con el plan', () => {
  it('el asistente ve el plan antes de crear nada y el servicio nace con lo aprobado', async () => {
    repos.set('acme/tienda', {
      'skyway.json': MANIFIESTO,
      'package.json': JSON.stringify({ dependencies: { nodemailer: '6' } }),
    });
    const q = new URLSearchParams({ repo: 'acme/tienda', branch: 'main', name: 'Escaparate' });
    let r = await call('GET', `/api/projects/${projA.id}/github/needs?${q}`, memberA);
    expect(r.status, r.raw).toBe(200);
    expect(r.json.plan.source).toBe('manifest');
    expect(r.json.plan.canApprove).toBe(false);
    expect(r.json.plan.resources.find((x: Json) => x.key === 'postgres')).toMatchObject({ action: 'reuse', target: 'PostgreSQL' });
    expect(r.json.plan.vars.find((v: Json) => v.name === 'APP_URL').status).toBe('blocked');

    // Quien lo crea aprueba lo que ha visto (su huella). El buzón no-reply ya
    // existe (lo creó el plan de otra web): reutilizarlo se confirma aparte.
    const visto = await call('GET', `/api/projects/${projA.id}/github/needs?${q}`, ownerA);
    expect(visto.json.plan.canApprove).toBe(true);
    const correo = visto.json.plan.resources.find((x: Json) => x.key === 'mail');
    expect(correo).toMatchObject({ action: 'reuse', target: 'no-reply@tienda.es' });
    expect(correo.confirmation).toMatch(/acceso IMAP y SMTP a todo su correo/);
    r = await call('POST', `/api/projects/${projA.id}/services`, ownerA, {
      type: 'git',
      name: 'Escaparate',
      repoUrl: 'https://github.com/acme/tienda',
      branch: 'main',
      plan: { expect: visto.json.plan.fingerprint, confirmMailboxAccess: true },
    });
    expect(r.status, r.raw).toBe(201);
    await sleep(200);
    const id = r.json.service.id as string;
    expect(r.json.plan.error).toBeNull();
    expect(r.json.plan.result.errors, JSON.stringify(r.json.plan.result)).toEqual([]);
    expect(r.json.plan.result.applied).toEqual(expect.arrayContaining(['SESSION_SECRET', 'DATABASE_URL', 'SMTP_PASSWORD']));
    const env = getEnv(id);
    expect(env.DATABASE_URL).toBe('${{PostgreSQL.DATABASE_URL}}');
    expect(env.SMTP_PASSWORD).toMatch(/^ContraseñaDeAplicacion-Secreta-/);
    expect((getService(id)!.config as GitConfig).needs?.manifestFile).toBe('skyway.json');
    expect(r.raw).not.toContain('Secreta');
  });

  it('un miembro crea el servicio con la base conectada y el correo pendiente; «skip» omite recursos', async () => {
    repos.set('acme/miembro', { 'skyway.json': MANIFIESTO });
    const q = (name: string) => new URLSearchParams({ repo: 'acme/miembro', branch: 'main', name });
    const visto = await call('GET', `/api/projects/${projA.id}/github/needs?${q('Del miembro')}`, memberA);
    let r = await call('POST', `/api/projects/${projA.id}/services`, memberA, {
      type: 'git',
      name: 'Del miembro',
      repoUrl: 'acme/miembro',
      branch: 'main',
      plan: { expect: visto.json.plan.fingerprint },
    });
    expect(r.status, r.raw).toBe(201);
    await sleep(200);
    // Como antes con el asistente: el servicio nace con DATABASE_URL.
    expect(getEnv(r.json.service.id).DATABASE_URL).toBe('${{PostgreSQL.DATABASE_URL}}');
    expect(r.json.plan.result.pending.sort()).toEqual(['MAIL_FROM_ADDRESS', 'SMTP_LOGIN', 'SMTP_PASSWORD', 'SMTP_SERVER']);
    expect((getService(r.json.service.id)!.config as GitConfig).integrationsPending).not.toContain('DATABASE_URL');

    const vistoOwner = await call('GET', `/api/projects/${projA.id}/github/needs?${q('Sin correo')}`, ownerA);
    r = await call('POST', `/api/projects/${projA.id}/services`, ownerA, {
      type: 'git',
      name: 'Sin correo',
      repoUrl: 'acme/miembro',
      branch: 'main',
      plan: { skip: ['mail'], expect: vistoOwner.json.plan.fingerprint },
    });
    expect(r.status, r.raw).toBe(201);
    await sleep(200);
    expect(getEnv(r.json.service.id).SMTP_PASSWORD).toBeUndefined();
    expect(getEnv(r.json.service.id).DATABASE_URL).toBe('${{PostgreSQL.DATABASE_URL}}');

    // Un recurso desconocido en «skip» se rechaza antes de crear nada.
    const antes = listServices(projA.id).length;
    r = await call('POST', `/api/projects/${projA.id}/services`, ownerA, {
      type: 'git',
      name: 'Malo',
      repoUrl: 'acme/miembro',
      branch: 'main',
      plan: { skip: ['docker'] },
    });
    expect(r.status).toBe(400);
    expect(listServices(projA.id).length).toBe(antes);
  });

  it('si GitHub no responde, el servicio se crea igual y el plan lo explica', async () => {
    const r = await call('POST', `/api/projects/${projA.id}/services`, ownerA, {
      type: 'git',
      name: 'Sin repo',
      repoUrl: 'acme/no-existe',
      branch: 'main',
      plan: {},
    });
    expect(r.status, r.raw).toBe(201);
    await sleep(200);
    expect(r.json.plan.error).toMatch(/No se ha podido aplicar el plan/);
  });
});

// ======================= D) DNS unificado =======================

describe('fichero de zona con los registros web del proyecto', () => {
  it('función pura: A hacia la IP comentados, sin duplicar lo que trae el fichero, y el webmail', () => {
    const zone = ['$TTL 3600', 'tienda.es.\tIN\tMX\t10 mail.example.com.', 'autoconfig.tienda.es.\tIN\tCNAME\tmail.example.com.', ''].join('\n');
    const { zone: out, added } = appendWebRecords(zone, 'tienda.es', {
      serverIp: '203.0.113.5',
      hosts: ['www.tienda.es', 'tienda.es', 'autoconfig.tienda.es', 'otra.com', 'WWW.tienda.es'],
      webmail: { name: 'webmail.tienda.es', type: 'CNAME', value: 'mail.example.com.' },
    });
    // El importador añade y no sustituye: un A activo en el dominio raíz o en
    // www se sumaría al del hosting anterior y el tráfico se repartiría entre
    // los dos. Van comentados, con la instrucción de borrar antes el actual.
    expect(added).toBe(1);
    expect(out).toContain('; tienda.es.\t3600\tIN\tA\t203.0.113.5');
    expect(out).toContain('; www.tienda.es.\t3600\tIN\tA\t203.0.113.5');
    const activas = out.split('\n').filter((l) => l.trim() && !l.trim().startsWith(';'));
    expect(activas.some((l) => /\tIN\tA\t203\.0\.113\.5/.test(l))).toBe(false);
    expect(out).toMatch(/importar añade y no\n;  sustituye/);
    expect(out).toMatch(/bórralo antes en tu proveedor de DNS/);
    expect(out).toContain('webmail.tienda.es.\t3600\tIN\tCNAME\tmail.example.com.');
    expect(out).toContain('autoconfig.tienda.es: se omite');
    expect(out).not.toContain('otra.com');
    // Sin IP: los registros de los servicios se omiten y se avisa.
    const sinIp = appendWebRecords(zone, 'tienda.es', { serverIp: null, hosts: ['www.tienda.es'], webmail: null });
    expect(sinIp.added).toBe(0);
    expect(sinIp.zone).toMatch(/no hay IP pública del servidor configurada/);
  });

  it('la descarga incluye los servicios de ESTE proyecto, el webmail y nada de otros proyectos', async () => {
    createService(projA.id, 'Portada', 'portada', 'git', gitCfg(['tienda.es', 'www.tienda.es', 'blog.otraempresa.com']));
    createService(projB.id, 'Intruso', 'intruso', 'git', gitCfg(['intruso.tienda.es']));
    let r = await call('GET', `/api/projects/${projA.id}/mail/domains/${domainA}/zonefile`, memberA);
    expect(r.status, r.raw).toBe(200);
    expect(r.raw).toMatch(/no hay IP pública del servidor configurada/);
    expect(r.raw).not.toContain('intruso');

    setSetting('serverIp', '198.51.100.7');
    // Webmail del cliente dado de alta.
    expect((await call('POST', `/api/projects/${projA.id}/mail/domains/${domainA}/webmail`, ownerA)).status).toBe(201);
    r = await call('GET', `/api/projects/${projA.id}/mail/domains/${domainA}/zonefile`, memberA);
    expect(r.status, r.raw).toBe(200);
    expect(r.raw).toContain('; www.tienda.es.\t3600\tIN\tA\t198.51.100.7');
    expect(r.raw).toContain('; tienda.es.\t3600\tIN\tA\t198.51.100.7');
    expect(r.raw).toContain('webmail.tienda.es.\t3600\tIN\tCNAME\tmail.example.com.');
    expect(r.raw).not.toContain('intruso');
    expect(r.raw).not.toContain('otraempresa');
    // Los registros de correo siguen ahí.
    expect(r.raw).toContain('IN\tMX\t10 mail.example.com.');

    // Otro proyecto no descarga la zona de A (404 sin llegar a Mailway).
    mw.calls = [];
    r = await call('GET', `/api/projects/${projB.id}/mail/domains/${domainA}/zonefile`, ownerB);
    expect([404, 409]).toContain(r.status);
    expect(mw.calls.some((c) => c.path.includes('/zonefile'))).toBe(false);
  });

  it('función pura: una nota con saltos de línea no puede escribir registros fuera del comentario', () => {
    const { zone } = appendWebRecords('$TTL 3600\n', 'tienda.es', {
      serverIp: null,
      hosts: [],
      webmail: null,
      webmailNote: 'No se incluye webmail.tienda.es: x\ntienda.es. 60 IN MX 1 mx.atacante.example. ;\r\notra',
    });
    const lineas = zone.split('\n').filter((l) => l.includes('atacante'));
    expect(lineas.length).toBe(1);
    expect(lineas[0].startsWith(';')).toBe(true);
  });

  it('descargada por el administrador, no nombra servicios ni proyectos ajenos ni lleva líneas suyas', async () => {
    // Un servicio de B con el nombre del webmail de A y un salto de línea en el
    // nombre (guardado antes de que se validara): lo que intentaba colarse.
    const nombre = 'x\ntienda.es. 60 IN MX 1 mx.atacante.example. ;';
    createService(projB.id, nombre, 'colado', 'git', gitCfg(['webmail.tienda.es']));
    const r = await call('GET', `/api/projects/${projA.id}/mail/domains/${domainA}/zonefile`, admin());
    expect(r.status, r.raw).toBe(200);
    expect(r.raw).toMatch(/No se incluye webmail\.tienda\.es: El dominio webmail\.tienda\.es está asignado a un servicio de Skyway/);
    expect(r.raw).not.toContain('atacante');
    expect(r.raw).not.toContain('«Otro');
    expect(r.raw).not.toContain('webmail.tienda.es.\t3600');
  });

  it('los nombres de proyecto y de servicio no admiten saltos de línea ni caracteres de control', async () => {
    const svc = createService(projA.id, 'Normal', 'normal', 'git', gitCfg());
    let r = await call('PATCH', `/api/services/${svc.id}`, ownerA, { name: 'x\ntienda.es. 60 IN MX 1 mx.atacante.example.' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/saltos de línea ni caracteres de control/);
    expect(getService(svc.id)!.name).toBe('Normal');
    r = await call('POST', `/api/projects/${projA.id}/services`, ownerA, { type: 'image', name: 'a\u0000b', image: 'nginx' });
    expect(r.status).toBe(400);
    r = await call('POST', '/api/projects', admin(), { name: 'Proyecto\r\nfalso' });
    expect(r.status).toBe(400);
    r = await call('PATCH', `/api/projects/${projA.id}`, admin(), { name: 'Tienda\nfalsa' });
    expect(r.status).toBe(400);
    // Un nombre con tildes y espacios sigue valiendo.
    r = await call('PATCH', `/api/services/${svc.id}`, ownerA, { name: 'Página de inicio' });
    expect(r.status, r.raw).toBe(200);
  });
});
