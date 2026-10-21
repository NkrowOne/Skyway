/**
 * Bases PostgreSQL con pgvector (`extensions: ['vector']`): la imagen que
 * resulta, la validación al crear y en Ajustes (con el bloqueo del cambio de
 * alpine a Debian sobre datos), el manifiesto `skyway.json`, el plan de
 * integraciones, la detección de dependencias, la importación de Railway y la
 * copia de datos. Sin Docker: el despliegue se sustituye por la fila que crea.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import {
  closeDb,
  createDeployment,
  createProject,
  createService,
  getService,
  initDb,
  listServices,
  setEnv,
  updateDeployment,
} from '../src/db';
import { PG_EXTENSIONS_CHECK, planMigration } from '../src/datamigrate';
import { parseManifest } from '../src/manifest';
import { detectNeeds } from '../src/needs';
import { matchTemplate } from '../src/railway/importer';
import {
  dbImageFor,
  getTemplate,
  libcChangeError,
  normalizeDbConfig,
  postgresLibc,
  volumePathFor,
} from '../src/templates';
import type { DatabaseConfig, DetectedNeeds, GitConfig, ProjectRow } from '../src/types';

// Sin desplegar de verdad: se crea la fila, como haría triggerDeploy.
vi.mock('../src/deploy/deployer', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/deploy/deployer')>();
  const db = await import('../src/db');
  return {
    ...mod,
    triggerDeploy: vi.fn((serviceId: string, trigger: string) => db.createDeployment(serviceId, trigger, null)),
  };
});

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const pg = getTemplate('postgres')!;

let app: FastifyInstance;
let cookie = '';
let projectId = '';

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) {
  const r = await app.inject({
    method,
    url,
    headers: { cookie, ...SAME_ORIGIN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.statusCode, json: r.json() as Json, raw: r.body };
}

/** Despliegue correcto con esa imagen: lo que dice con qué imagen se escribieron los datos. */
function deployedWith(serviceId: string, image: string): void {
  const d = createDeployment(serviceId, 'manual', null);
  updateDeployment(d.id, { status: 'success', image_tag: image, finished_at: Date.now() });
}

function needsFrom(files: Record<string, string>): DetectedNeeds | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-pgvector-test-'));
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

function webService(project: ProjectRow, name: string, files: Record<string, string>) {
  const needs = needsFrom(files) ?? undefined;
  const cfg = { repoUrl: 'https://github.com/x/y', branch: 'main', port: 3000, domains: [], webhookSecret: 'w', ...(needs ? { needs } : {}) };
  return createService(project.id, name, name.toLowerCase(), 'git', cfg as GitConfig);
}

const MANIFIESTO_VECTOR = JSON.stringify({
  version: 1,
  integrations: { postgres: { extensions: ['vector'] } },
  env: { DATABASE_URL: { from: 'postgres.url' } },
});

beforeAll(async () => {
  initDb();
  app = buildApp();
  await app.ready();
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { email: 'admin@example.com', password: 'contraseña1' },
    headers: SAME_ORIGIN,
  });
  expect(setup.statusCode, setup.body).toBe(200);
  cookie = String(setup.headers['set-cookie']).split(';')[0];
  const r = await call('POST', '/api/projects', { name: 'Ivy' });
  expect(r.status, r.raw).toBe(201);
  projectId = r.json.project.id;
});

afterAll(async () => {
  await app.close();
  closeDb();
});

describe('imagen de una base con pgvector', () => {
  it('usa pgvector/pgvector con la versión mayor y la distribución fijada', () => {
    expect(dbImageFor(pg, { template: 'postgres', version: '16-alpine' })).toBe('postgres:16-alpine');
    expect(dbImageFor(pg, { template: 'postgres', version: '16', extensions: ['vector'] })).toBe('pgvector/pgvector:pg16-trixie');
    expect(dbImageFor(pg, { template: 'postgres', version: '18', extensions: ['vector'] })).toBe('pgvector/pgvector:pg18-trixie');
    // Una extensión desconocida guardada a mano no cambia nada.
    expect(dbImageFor(pg, { template: 'postgres', version: '16-alpine', extensions: ['postgis' as never] })).toBe('postgres:16-alpine');
  });

  it('la ruta de datos sigue a la versión mayor, como en la imagen oficial (18+ cambia la ruta)', () => {
    expect(volumePathFor(pg, '16')).toBe('/var/lib/postgresql/data');
    expect(volumePathFor(pg, '18')).toBe('/var/lib/postgresql');
  });

  it('normaliza la versión al número mayor y rechaza las combinaciones que no existen', () => {
    expect(normalizeDbConfig(pg, undefined, ['vector'])).toEqual({ version: '16', extensions: ['vector'] });
    expect(normalizeDbConfig(pg, '17-alpine', ['vector', 'vector'])).toEqual({ version: '17', extensions: ['vector'] });
    expect(normalizeDbConfig(pg, '16-alpine', [])).toEqual({ version: '16-alpine' });
    expect(normalizeDbConfig(pg, 'latest', ['vector'])).toMatchObject({ error: expect.stringMatching(/13 a 18/) });
    expect(normalizeDbConfig(pg, '12', ['vector'])).toMatchObject({ error: expect.stringMatching(/13 a 18/) });
    expect(normalizeDbConfig(getTemplate('redis')!, undefined, ['vector'])).toMatchObject({ error: 'Redis no admite extensiones.' });
  });

  it('alpine es musl y el resto glibc: el cambio entre ellas sobre datos se rechaza', () => {
    expect(postgresLibc('postgres:16-alpine')).toBe('musl');
    expect(postgresLibc('postgres:16')).toBe('glibc');
    expect(postgresLibc('pgvector/pgvector:pg16-trixie')).toBe('glibc');
    expect(libcChangeError(null, 'pgvector/pgvector:pg16-trixie')).toBeNull();
    expect(libcChangeError('postgres:16', 'pgvector/pgvector:pg16-trixie')).toBeNull();
    expect(libcChangeError('postgres:16-alpine', 'pgvector/pgvector:pg16-trixie')).toMatch(/musl \(alpine\).*glibc \(Debian\)/);
  });
});

describe('crear y ajustar la base por la API', () => {
  it('POST con extensions: ["vector"] crea la base con pgvector y la versión mayor', async () => {
    const r = await call('POST', `/api/projects/${projectId}/services`, { type: 'database', template: 'postgres', extensions: ['vector'] });
    expect(r.status, r.raw).toBe(201);
    expect(r.json.service.name).toBe('PostgreSQL');
    expect(r.json.service.config).toMatchObject({ template: 'postgres', version: '16', extensions: ['vector'] });

    const conVersion = await call('POST', `/api/projects/${projectId}/services`, {
      type: 'database',
      name: 'Vectores',
      template: 'postgres',
      version: '17-alpine',
      extensions: ['vector'],
    });
    expect(conVersion.status, conVersion.raw).toBe(201);
    expect(conVersion.json.service.config).toMatchObject({ version: '17', extensions: ['vector'] });
  });

  it.each([
    [{ template: 'postgres', extensions: ['postgis'] }, /Extensión no admitida/],
    [{ template: 'postgres', version: 'latest', extensions: ['vector'] }, /13 a 18/],
    [{ template: 'redis', extensions: ['vector'] }, /no admite extensiones/],
  ])('POST %j se rechaza', async (body, error) => {
    const r = await call('POST', `/api/projects/${projectId}/services`, { type: 'database', ...body });
    expect(r.status, r.raw).toBe(400);
    expect(JSON.stringify(r.json)).toMatch(error);
  });

  it('en Ajustes se activa en una base sin despliegues correctos y pide volver a desplegar', async () => {
    const c = await call('POST', `/api/projects/${projectId}/services`, { type: 'database', name: 'Nueva', template: 'postgres' });
    expect(c.status, c.raw).toBe(201);
    const id = c.json.service.id as string;
    const r = await call('PATCH', `/api/services/${id}`, { config: { version: '16-alpine', extensions: ['vector'] } });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.needsRedeploy).toBe(true);
    expect(getService(id)!.config).toMatchObject({ version: '16', extensions: ['vector'] });

    // Y se puede quitar mientras siga sin datos.
    const quitar = await call('PATCH', `/api/services/${id}`, { config: { version: '16-alpine', extensions: [] } });
    expect(quitar.status, quitar.raw).toBe(200);
    expect((getService(id)!.config as DatabaseConfig).extensions).toBeUndefined();
    expect((getService(id)!.config as DatabaseConfig).version).toBe('16-alpine');
  });

  it('sobre datos escritos con la imagen alpine, activarla responde 409 y no cambia nada', async () => {
    const c = await call('POST', `/api/projects/${projectId}/services`, { type: 'database', name: 'Con datos', template: 'postgres' });
    const id = c.json.service.id as string;
    deployedWith(id, 'postgres:16-alpine');
    const r = await call('PATCH', `/api/services/${id}`, { config: { extensions: ['vector'] } });
    expect(r.status, r.raw).toBe(409);
    expect(r.json.error).toMatch(/Copiar datos/);
    expect(getService(id)!.config).toMatchObject({ version: '16-alpine' });
    expect((getService(id)!.config as DatabaseConfig).extensions).toBeUndefined();
    // Guardar otra cosa (la versión de siempre, sin extensiones) sigue funcionando.
    const otra = await call('PATCH', `/api/services/${id}`, { config: { version: '16-alpine', backupRetention: 5 } });
    expect(otra.status, otra.raw).toBe(200);
  });

  it('con pgvector y datos, cambiar de versión mayor no lo bloquea la collation (lo comprueba el despliegue)', async () => {
    const c = await call('POST', `/api/projects/${projectId}/services`, { type: 'database', name: 'Vec', template: 'postgres', extensions: ['vector'] });
    const id = c.json.service.id as string;
    deployedWith(id, 'pgvector/pgvector:pg16-trixie');
    const r = await call('PATCH', `/api/services/${id}`, { config: { version: '17' } });
    expect(r.status, r.raw).toBe(200);
    expect(getService(id)!.config).toMatchObject({ version: '17', extensions: ['vector'] });
    // Quitar pgvector volvería a alpine: tampoco sobre datos.
    const quitar = await call('PATCH', `/api/services/${id}`, { config: { version: '17-alpine', extensions: [] } });
    expect(quitar.status, quitar.raw).toBe(409);
  });

  it('GET /api/templates enseña la variante de pgvector', async () => {
    const r = await call('GET', '/api/templates');
    const postgres = r.json.templates.find((t: Json) => t.key === 'postgres');
    expect(postgres.extensions).toEqual([
      expect.objectContaining({ key: 'vector', label: 'PostgreSQL con pgvector', image: 'pgvector/pgvector', defaultTag: 'pg16-trixie' }),
    ]);
  });
});

describe('manifiesto skyway.json', () => {
  it('admite integrations.postgres.extensions con valores conocidos', () => {
    const r = parseManifest(MANIFIESTO_VECTOR);
    expect(r.error).toBeNull();
    expect(r.manifest?.integrations?.postgres?.extensions).toEqual(['vector']);
  });

  it.each([
    [{ version: 1, integrations: { postgres: { extensions: ['postgis'] } } }, /Extensión no admitida/],
    [{ version: 1, integrations: { postgres: { extensions: 'vector' } } }, /integrations\.postgres\.extensions/],
    [{ version: 1, integrations: { postgres: { extension: ['vector'] } } }, /campo no admitido \(extension\)/],
    [{ version: 1, integrations: { redis: { extensions: ['vector'] } } }, /campo no admitido \(extensions\)/],
  ])('rechaza %j', (m, error) => {
    const r = parseManifest(JSON.stringify(m));
    expect(r.manifest).toBeNull();
    expect(r.error).toMatch(error);
  });
});

describe('plan de integraciones con pgvector', () => {
  let proj: ProjectRow;

  beforeAll(() => {
    proj = createProject('Plan', 'plan-pgvector', null, null);
  });

  it('sin base en el proyecto, el plan crea PostgreSQL con pgvector y la huella lo distingue', async () => {
    const conVector = webService(proj, 'Ivy', { 'skyway.json': MANIFIESTO_VECTOR });
    const sinVector = webService(proj, 'Otra', {
      'skyway.json': JSON.stringify({ version: 1, integrations: { postgres: {} }, env: { DATABASE_URL: { from: 'postgres.url' } } }),
    });
    const plan = (await call('GET', `/api/services/${conVector.id}/integrations`)).json.plan;
    expect(plan.resources.find((x: Json) => x.key === 'postgres')).toMatchObject({
      action: 'create',
      status: 'apply',
      label: 'PostgreSQL con pgvector',
      target: 'PostgreSQL',
      extensions: ['vector'],
    });
    const otro = (await call('GET', `/api/services/${sinVector.id}/integrations`)).json.plan;
    expect(otro.resources.find((x: Json) => x.key === 'postgres')).toMatchObject({ action: 'create', extensions: [] });
    expect(plan.fingerprint).not.toBe(otro.fingerprint);

    // Al aprobarlo, la base nace con pgvector.
    const r = await call('POST', `/api/services/${conVector.id}/integrations/apply`, { expect: plan.fingerprint });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.result.created).toEqual(['PostgreSQL']);
    const db = listServices(proj.id).find((s) => s.type === 'database')!;
    expect(db.config).toMatchObject({ template: 'postgres', version: '16', extensions: ['vector'] });
  });

  it('con una base del proyecto sin pgvector, no la conecta: lo dice en el plan con el motivo', async () => {
    const p = createProject('Sin vector', 'sin-vector', null, null);
    const db = createService(p.id, 'Postgres', 'postgres', 'database', { template: 'postgres', version: '16-alpine' });
    setEnv(db.id, { DATABASE_URL: 'postgresql://x' });
    const web = webService(p, 'Ivy', { 'skyway.json': MANIFIESTO_VECTOR });
    const plan = (await call('GET', `/api/services/${web.id}/integrations`)).json.plan;
    const res = plan.resources.find((x: Json) => x.key === 'postgres');
    expect(res).toMatchObject({ action: 'reuse', target: 'Postgres', status: 'blocked', extensions: ['vector'] });
    expect(res.reason).toMatch(/«Postgres» del proyecto no tiene pgvector/);
    expect(plan.vars.find((v: Json) => v.name === 'DATABASE_URL')).toMatchObject({ status: 'blocked' });
    expect(plan.pendingApproval).toEqual([]);

    // Con otra base que sí lo tiene, se reutiliza esa.
    createService(p.id, 'Vectores', 'vectores', 'database', { template: 'postgres', version: '16', extensions: ['vector'] });
    const despues = (await call('GET', `/api/services/${web.id}/integrations`)).json.plan;
    expect(despues.resources.find((x: Json) => x.key === 'postgres')).toMatchObject({ action: 'reuse', target: 'Vectores', status: 'apply' });
  });

  it('ya conectada a una base sin pgvector: queda bloqueada con el motivo, no «hecha»', async () => {
    const p = createProject('Conectada', 'conectada', null, null);
    createService(p.id, 'Postgres', 'postgres', 'database', { template: 'postgres', version: '16-alpine' });
    const web = webService(p, 'Ivy', { 'skyway.json': MANIFIESTO_VECTOR });
    setEnv(web.id, { DATABASE_URL: '${{Postgres.DATABASE_URL}}' });
    const plan = (await call('GET', `/api/services/${web.id}/integrations`)).json.plan;
    expect(plan.vars.find((v: Json) => v.name === 'DATABASE_URL')).toMatchObject({
      status: 'blocked',
      reason: expect.stringMatching(/no tiene pgvector/),
    });
  });

  it('sin manifiesto, la detección de pgvector en package.json también pide la base con pgvector', async () => {
    const p = createProject('Deteccion', 'deteccion', null, null);
    const web = webService(p, 'Bot', {
      'package.json': JSON.stringify({ dependencies: { pg: '^8', pgvector: '^0.2', 'discord.js': '^14' } }),
      '.env.example': 'DATABASE_URL=\nDISCORD_TOKEN=tu_token_aqui\n',
    });
    const plan = (await call('GET', `/api/services/${web.id}/integrations`)).json.plan;
    expect(plan.source).toBe('detection');
    expect(plan.resources.find((x: Json) => x.key === 'postgres')).toMatchObject({ action: 'create', extensions: ['vector'] });
  });
});

describe('detección de pgvector (needs.ts)', () => {
  it.each([
    [{ 'package.json': JSON.stringify({ dependencies: { pgvector: '^0.2' } }) }, 'package.json: pgvector'],
    [{ 'requirements.txt': 'psycopg[binary]>=3\npgvector==0.3.0\n' }, 'requirements.txt: pgvector'],
    [{ 'go.mod': 'module x\nrequire github.com/pgvector/pgvector-go v0.2.0\n' }, 'go.mod: github.com/pgvector/pgvector-go'],
    [{ 'docker-compose.yml': 'services:\n  db:\n    image: pgvector/pgvector:pg16\n' }, 'docker-compose.yml: imagen pgvector'],
  ])('%j pide PostgreSQL con vector', (files, evidence) => {
    const needs = needsFrom(files)!;
    const postgres = needs.engines.find((e) => e.template === 'postgres');
    expect(postgres?.extensions).toEqual(['vector']);
    expect(postgres?.evidence).toContain(evidence);
  });

  it('sin pgvector, Postgres no lleva extensiones', () => {
    const needs = needsFrom({ 'package.json': JSON.stringify({ dependencies: { pg: '^8' } }) })!;
    expect(needs.engines).toEqual([{ template: 'postgres', evidence: 'package.json: pg' }]);
  });
});

describe('importación de Railway', () => {
  it.each([
    ['pgvector/pgvector:pg17', { template: 'postgres', version: '17', extensions: ['vector'] }],
    ['pgvector/pgvector:0.8.0-pg15-bookworm', { template: 'postgres', version: '15', extensions: ['vector'] }],
    ['ankane/pgvector', { template: 'postgres', version: '16', extensions: ['vector'] }],
    // La imagen de Postgres de Railway instala pgvector en todas sus versiones.
    ['ghcr.io/railwayapp-templates/postgres-ssl:16', { template: 'postgres', version: '16', extensions: ['vector'] }],
    ['ghcr.io/railwayapp-templates/postgres-ssl:18.1', { template: 'postgres', version: '18', extensions: ['vector'] }],
  ])('%s se importa como base gestionada con pgvector', (image, expected) => {
    expect(matchTemplate(image)).toMatchObject(expected);
  });

  it('la imagen oficial de Postgres sigue siendo la plantilla de siempre, sin extensiones', () => {
    const m = matchTemplate('postgres:16-alpine');
    expect(m).toMatchObject({ template: 'postgres', version: '16-alpine', exact: true });
    expect(m?.extensions).toBeUndefined();
    expect(matchTemplate('postgis/postgis:16-3.4')).toBeNull();
  });
});

describe('copia de datos', () => {
  it('hacia una base con pgvector usa su imagen y comprueba antes las extensiones del origen', () => {
    const p = createProject('Copia', 'copia', null, null);
    const db = createService(p.id, 'PostgreSQL', 'postgresql', 'database', { template: 'postgres', version: '16', extensions: ['vector'] });
    setEnv(db.id, pg.makeEnv('postgresql'));
    const plan = planMigration(getService(db.id)!, p, 'postgresql://u:p@origen.example.com:5432/railway');
    expect(plan.image).toBe('pgvector/pgvector:pg16-trixie');
    expect(plan.script.startsWith(PG_EXTENSIONS_CHECK)).toBe(true);
    expect(plan.script).toMatch(/pg_dump .* && psql /);
    // La URL de origen nunca entra en el comando: viaja por el entorno.
    expect(plan.script).not.toContain('origen.example.com');
    expect(plan.env.SRC).toBe('postgresql://u:p@origen.example.com:5432/railway');
  });

  it('la comprobación compara nombres en el shell, sin meterlos en ninguna consulta', () => {
    expect(PG_EXTENSIONS_CHECK).toContain('pg_available_extensions');
    expect(PG_EXTENSIONS_CHECK).toContain('grep -qxF -- "$e"');
    expect(PG_EXTENSIONS_CHECK).toContain('exit 3');
    expect(PG_EXTENSIONS_CHECK).not.toMatch(/\$e'|'\$e/);
  });
});
