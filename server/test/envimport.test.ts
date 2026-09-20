import fs from 'fs';
import os from 'os';
import path from 'path';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { closeDb, createProject, createService, getEnv, getService, initDb, listAlerts, setEnv, setProjectVars } from '../src/db';
import { getRepoFile, listRepoDir } from '../src/github/client';
import {
  EnvFileSource,
  importRepoEnv,
  isPlaceholder,
  parseEnvFile,
  planEnvImport,
  scanRepoEnvFiles,
} from '../src/deploy/envimport';
import { GitConfig } from '../src/types';

// La importación manual lee el repo por la API de GitHub: aquí no hay red, así
// que se sustituyen solo las dos funciones de lectura y se deja el resto del
// cliente (parseGithubSlug…) tal cual.
vi.mock('../src/github/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/github/client')>();
  return { ...mod, listRepoDir: vi.fn(), getRepoFile: vi.fn() };
});

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

let app: FastifyInstance;
let cookie = '';
let projectId = '';
let gitId = '';
let dbId = '';
let gitlabId = '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Repo simulado: rutas de fichero → contenido. Los directorios se deducen. */
function mockRepo(files: Record<string, string>): void {
  vi.mocked(listRepoDir).mockImplementation(async (_t, _o, _r, dir) => {
    const names = Object.keys(files)
      .filter((f) => path.posix.dirname(f) === (dir || '.'))
      .map((f) => path.posix.basename(f));
    return names.length > 0 ? names : dir === '' ? [] : null;
  });
  vi.mocked(getRepoFile).mockImplementation(async (_t, _o, _r, file) => files[file] ?? null);
}

async function createViaApi(payload: Record<string, unknown>) {
  const r = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/services`,
    headers: { cookie, ...SAME_ORIGIN },
    payload,
  });
  expect(r.statusCode, r.body).toBe(201);
  // Sin Docker el despliegue inicial falla en segundo plano: se le da margen.
  await sleep(200);
  return JSON.parse(r.body).service.id as string;
}

async function importRepo(id: string, apply?: boolean) {
  return app.inject({
    method: 'POST',
    url: `/api/services/${id}/env/import-repo`,
    headers: { cookie, ...SAME_ORIGIN },
    payload: apply === undefined ? {} : { apply },
  });
}

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

  const project = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { cookie, ...SAME_ORIGIN },
    payload: { name: 'Demo' },
  });
  expect(project.statusCode, project.body).toBe(201);
  projectId = JSON.parse(project.body).project.id as string;

  gitId = await createViaApi({ type: 'git', name: 'api', repoUrl: 'https://github.com/acme/app', branch: 'main' });
  gitlabId = await createViaApi({ type: 'git', name: 'otro', repoUrl: 'https://gitlab.com/acme/app', branch: 'main' });
  dbId = await createViaApi({ type: 'database', template: 'postgres' });
});

afterAll(async () => {
  await app.close();
  closeDb();
});

describe('parseEnvFile', () => {
  it('entiende comentarios, export, espacios, vacíos y comillas', () => {
    const entries = parseEnvFile(
      [
        '# comentario',
        '',
        'export A=1',
        '  B = dos  ',
        'C=',
        "D='con # almohadilla'",
        'E="línea\\nsalto \\"citada\\""',
        'F=valor # comentario al final',
        'G=http://x/#ancla',
        'sin-igual',
      ].join('\n'),
    );
    expect(Object.fromEntries(entries.map((e) => [e.key, e.value]))).toEqual({
      A: '1',
      B: 'dos',
      C: '',
      D: 'con # almohadilla',
      E: 'línea\nsalto "citada"',
      F: 'valor',
      G: 'http://x/#ancla',
    });
  });

  it('admite valores multilínea entre comillas dobles y CRLF', () => {
    const entries = parseEnvFile('KEY="-----BEGIN-----\r\nabc\r\n-----END-----"\r\nOTRA=x\r\n');
    expect(entries).toEqual([
      { key: 'KEY', value: '-----BEGIN-----\nabc\n-----END-----' },
      { key: 'OTRA', value: 'x' },
    ]);
  });

  it('la última ocurrencia de una clave manda y las claves inválidas se conservan para avisar', () => {
    const entries = parseEnvFile('A=1\nA=2\n1MAL=3\nB-C=4');
    expect(entries).toEqual([
      { key: 'A', value: '2' },
      { key: '1MAL', value: '3' },
      { key: 'B-C', value: '4' },
    ]);
  });
});

describe('isPlaceholder', () => {
  it.each([
    '',
    '   ',
    '<tu-clave>',
    '{{ SECRET }}',
    'xxx',
    'XXXXXXXX',
    '...',
    'todo',
    'changeme',
    'CHANGE-ME',
    'please_change_me',
    'your-api-key',
    'https://your-app.example.com',
    'tu_contraseña',
    'replace-with-real',
    'https://api.example.com',
    'usuario@ejemplo.com',
    'insert_key',
    'my_secret_here',
    'sk-xxxxxxxx',
    '********',
  ])('%j es un placeholder', (v) => {
    expect(isPlaceholder(v)).toBe(true);
  });

  it.each(['production', 'postgres://u:p@db.internal:5432/app', '${{Postgres.DATABASE_URL}}', '${{ shared.API_KEY }}', 'sk-live-abc123', 'status_ok'])(
    '%j no es un placeholder',
    (v) => {
      expect(isPlaceholder(v)).toBe(false);
    },
  );
});

describe('planEnvImport', () => {
  const ejemplo: EnvFileSource = {
    file: '.env.example',
    entries: parseEnvFile(
      [
        'PORT=3000',
        'RAILWAY_TOKEN=abc',
        '1MAL=x',
        'YA_EXISTE=nuevo',
        'COMPARTIDA=nuevo',
        'TRATADA=valor',
        'STRIPE_KEY=',
        'SMTP_PASS=<tu-clave>',
        'DB_HOST=localhost',
        'REDIS_URL=redis://127.0.0.1:6379',
        'DATABASE_URL=${{Postgres.DATABASE_URL}}',
        'NODE_ENV=production',
      ].join('\n'),
    ),
  };

  it('clasifica cada clave en su orden', () => {
    const plan = planEnvImport([ejemplo], { existing: ['YA_EXISTE', 'COMPARTIDA'], handled: ['TRATADA'] });
    expect(plan.files).toEqual(['.env.example']);
    expect(plan.imported.map((i) => [i.key, i.value])).toEqual([
      ['DATABASE_URL', '${{Postgres.DATABASE_URL}}'],
      ['NODE_ENV', 'production'],
    ]);
    expect(plan.pending.map((p) => p.key)).toEqual(['STRIPE_KEY', 'SMTP_PASS']);
    expect(plan.skipped).toEqual([
      { key: 'PORT', file: '.env.example', reason: 'reserved' },
      { key: 'RAILWAY_TOKEN', file: '.env.example', reason: 'reserved' },
      { key: '1MAL', file: '.env.example', reason: 'invalid_key' },
      { key: 'YA_EXISTE', file: '.env.example', reason: 'exists' },
      { key: 'COMPARTIDA', file: '.env.example', reason: 'exists' },
      { key: 'TRATADA', file: '.env.example', reason: 'handled' },
      { key: 'DB_HOST', file: '.env.example', reason: 'localhost' },
      { key: 'REDIS_URL', file: '.env.example', reason: 'localhost' },
    ]);
  });

  it('el .env manda sobre el .env.example, salvo que traiga un valor vacío o de ejemplo', () => {
    const real: EnvFileSource = {
      file: '.env',
      entries: parseEnvFile('API_URL=https://api.real.io\nNODE_ENV=\nSECRET=def'),
    };
    const example: EnvFileSource = {
      file: '.env.example',
      entries: parseEnvFile('API_URL=https://api.example.com\nNODE_ENV=production\nSECRET=abc'),
    };
    const plan = planEnvImport([example, real], { existing: [] });
    expect(plan.files).toEqual(['.env.example', '.env']);
    expect(plan.imported).toEqual([
      { key: 'API_URL', file: '.env', value: 'https://api.real.io' },
      { key: 'NODE_ENV', file: '.env.example', value: 'production' },
      { key: 'SECRET', file: '.env', value: 'def' },
    ]);
    expect(plan.pending).toEqual([]);
  });

  it('una clave pendiente de la pasada anterior sigue pendiente mientras no se defina', () => {
    const plan = planEnvImport([ejemplo], { existing: [], handled: ['STRIPE_KEY', 'SMTP_PASS'], pending: ['STRIPE_KEY', 'SMTP_PASS'] });
    expect(plan.pending.map((p) => p.key)).toEqual(['STRIPE_KEY', 'SMTP_PASS']);
    const definida = planEnvImport([ejemplo], { existing: ['STRIPE_KEY'], handled: ['STRIPE_KEY', 'SMTP_PASS'], pending: ['STRIPE_KEY', 'SMTP_PASS'] });
    expect(definida.pending.map((p) => p.key)).toEqual(['SMTP_PASS']);
    expect(definida.skipped).toContainEqual({ key: 'STRIPE_KEY', file: '.env.example', reason: 'handled' });
  });
});

describe('importRepoEnv (checkout en disco)', () => {
  let workDir = '';
  let serviceId = '';

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-envimport-'));
    fs.mkdirSync(path.join(workDir, 'apps', 'api'), { recursive: true });
    fs.writeFileSync(path.join(workDir, '.env.example'), 'SHARED_FROM_ROOT=raiz\nAPI_KEY=<your-key>\nPORT=8080\n');
    fs.writeFileSync(path.join(workDir, 'apps', 'api', '.env.example'), 'API_KEY=\nSMTP_HOST=smtp.mailgun.org\nDB_HOST=localhost\n');
    fs.writeFileSync(path.join(workDir, 'apps', 'api', '.env'), 'SMTP_HOST=smtp.real.io\nSMTP_PASS=supersecreto\n');
    // Un fichero enorme no es un .env: se ignora.
    fs.writeFileSync(path.join(workDir, '.env.dist'), 'GRANDE=1\n' + '#'.repeat(70 * 1024));
    // Un enlace simbólico podría apuntar fuera del repositorio: tampoco se lee.
    fs.symlinkSync(path.join(workDir, 'apps', 'api', '.env'), path.join(workDir, '.env'));

    const project = createProject('Disco', 'disco');
    setProjectVars(project.id, { COMPARTIDA: 'x' });
    const cfg: GitConfig = { repoUrl: 'https://github.com/acme/mono', branch: 'main', rootDir: 'apps/api', port: 3000, domains: [], webhookSecret: 's' };
    serviceId = createService(project.id, 'api', 'api', 'git', cfg).id;
    setEnv(serviceId, { YA_ESTABA: '1' });
  });

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('encuentra los ficheros de la raíz y del contexto, en orden, y salta los grandes y los enlaces', () => {
    const files = scanRepoEnvFiles(workDir, path.join(workDir, 'apps/api'));
    expect(files.map((f) => f.file)).toEqual(['.env.example', 'apps/api/.env.example', 'apps/api/.env']);
  });

  it('rechaza un contexto fuera del repositorio', () => {
    expect(() => scanRepoEnvFiles(workDir, path.join(workDir, '..'))).toThrow('rootDir fuera del repositorio');
  });

  it('importa, deja pendientes, persiste el informe sin valores y no escribe valores en el log', () => {
    const lines: string[] = [];
    const service = getService(serviceId)!;
    const report = importRepoEnv({ service, workDir, contextDir: path.join(workDir, 'apps/api'), log: (l) => lines.push(l) });
    expect(report).not.toBeNull();
    expect(report!.applied).toBe(true);
    expect(report!.source).toBe('deploy');
    expect(report!.imported).toEqual([
      { key: 'SHARED_FROM_ROOT', file: '.env.example' },
      { key: 'SMTP_HOST', file: 'apps/api/.env' },
      { key: 'SMTP_PASS', file: 'apps/api/.env' },
    ]);
    expect(report!.pending).toEqual([{ key: 'API_KEY', file: 'apps/api/.env.example' }]);
    expect(report!.skipped).toEqual([
      { key: 'PORT', file: '.env.example', reason: 'reserved' },
      { key: 'DB_HOST', file: 'apps/api/.env.example', reason: 'localhost' },
    ]);
    expect(report!.handled).toEqual(['API_KEY', 'DB_HOST', 'PORT', 'SHARED_FROM_ROOT', 'SMTP_HOST', 'SMTP_PASS']);

    expect(getEnv(serviceId)).toEqual({
      YA_ESTABA: '1',
      SHARED_FROM_ROOT: 'raiz',
      SMTP_HOST: 'smtp.real.io',
      SMTP_PASS: 'supersecreto',
    });
    const persisted = (getService(serviceId)!.config as GitConfig).envImport!;
    expect(persisted.imported).toEqual(report!.imported);
    expect(JSON.stringify(persisted)).not.toContain('supersecreto');
    // La copia en memoria de quien llama también lleva el informe.
    expect((service.config as GitConfig).envImport).toBe(report);

    expect(lines).toEqual([
      'Variables: encontrados .env.example, apps/api/.env.example y apps/api/.env en el repositorio.',
      'Variables: importadas 3 (SHARED_FROM_ROOT, SMTP_HOST, SMTP_PASS).',
      'Variables: 1 pendiente de valor (API_KEY): rellénala en la pestaña Variables.',
      'Variables: 2 ignoradas (PORT: reservada, DB_HOST: apunta a localhost).',
    ]);
    expect(lines.join('\n')).not.toContain('supersecreto');

    const alert = listAlerts({ openOnly: true }).find((a) => a.type === 'env_imported' && a.service_id === serviceId);
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe('warning');
    expect(alert!.message).not.toContain('supersecreto');
  });

  it('en la segunda pasada no vuelve a proponer nada, pero la pendiente sigue pendiente', () => {
    const lines: string[] = [];
    const report = importRepoEnv({ service: getService(serviceId)!, workDir, contextDir: path.join(workDir, 'apps/api'), log: (l) => lines.push(l) });
    expect(report!.applied).toBe(false);
    expect(report!.imported).toEqual([]);
    expect(report!.pending).toEqual([{ key: 'API_KEY', file: 'apps/api/.env.example' }]);
    // DB_HOST ya se trató (fue `localhost` en la primera pasada): `handled` va antes que `localhost`.
    expect(report!.skipped.map((s) => [s.key, s.reason])).toEqual([
      ['SHARED_FROM_ROOT', 'handled'],
      ['PORT', 'reserved'],
      ['SMTP_HOST', 'handled'],
      ['DB_HOST', 'handled'],
      ['SMTP_PASS', 'handled'],
    ]);
    expect(lines.some((l) => l.includes('1 pendiente de valor (API_KEY)'))).toBe(true);
  });

  it('sin ficheros candidatos devuelve null y no escribe nada', () => {
    const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-envimport-vacio-'));
    try {
      const lines: string[] = [];
      expect(importRepoEnv({ service: getService(serviceId)!, workDir: vacio, contextDir: vacio, log: (l) => lines.push(l) })).toBeNull();
      expect(lines).toEqual([]);
    } finally {
      fs.rmSync(vacio, { recursive: true, force: true });
    }
  });
});

describe('POST /api/services/:id/env/import-repo', () => {
  const ENV_EXAMPLE = 'DATABASE_URL=${{Postgres.DATABASE_URL}}\nSTRIPE_KEY=sk-xxxx\nAPP_URL=https://app.real.io\nPORT=3000\n';

  it('exige sesión', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/services/${gitId}/env/import-repo`, payload: {}, headers: SAME_ORIGIN });
    expect(r.statusCode).toBe(401);
  });

  it('responde 400 en un servicio que no es git o cuyo repo no es de GitHub', async () => {
    const msg = 'Solo se puede importar de servicios desplegados desde un repositorio de GitHub';
    const db = await importRepo(dbId);
    expect(db.statusCode, db.body).toBe(400);
    expect(JSON.parse(db.body).error).toBe(msg);
    const gitlab = await importRepo(gitlabId);
    expect(gitlab.statusCode, gitlab.body).toBe(400);
    expect(JSON.parse(gitlab.body).error).toBe(msg);
    expect(listRepoDir).not.toHaveBeenCalled();
  });

  it('sin ficheros en el repo lo dice y no persiste nada', async () => {
    mockRepo({ 'README.md': '# hola' });
    const r = await importRepo(gitId, true);
    expect(r.statusCode, r.body).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.message).toContain('No se ha encontrado ningún fichero .env');
    expect(body.report.files).toEqual([]);
    expect(body.needsRedeploy).toBeUndefined();
    expect((getService(gitId)!.config as GitConfig).envImport).toBeUndefined();
  });

  it('la vista previa trae los valores y no escribe nada', async () => {
    mockRepo({ '.env.example': ENV_EXAMPLE, 'README.md': '# hola' });
    const r = await importRepo(gitId);
    expect(r.statusCode, r.body).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.message).toBe('Se importarían 2 variables; 1 pendiente de valor.');
    expect(body.needsRedeploy).toBeUndefined();
    expect(body.report.applied).toBe(false);
    expect(body.report.source).toBe('manual');
    expect(body.report.imported).toEqual([
      { key: 'DATABASE_URL', file: '.env.example', value: '${{Postgres.DATABASE_URL}}' },
      { key: 'APP_URL', file: '.env.example', value: 'https://app.real.io' },
    ]);
    expect(body.report.pending).toEqual([{ key: 'STRIPE_KEY', file: '.env.example' }]);
    expect(body.report.skipped).toEqual([{ key: 'PORT', file: '.env.example', reason: 'reserved' }]);
    expect(getEnv(gitId)).toEqual({});
    expect((getService(gitId)!.config as GitConfig).envImport).toBeUndefined();
    // Solo se descargan los candidatos que el listado dice que existen.
    expect(vi.mocked(getRepoFile).mock.calls.map((c) => c[3])).toEqual(['.env.example']);
  });

  it('con apply escribe las variables, persiste el informe sin valores y pide redesplegar', async () => {
    mockRepo({ '.env.example': ENV_EXAMPLE });
    const r = await importRepo(gitId, true);
    expect(r.statusCode, r.body).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.needsRedeploy).toBe(true);
    expect(body.message).toBe('Importadas 2 variables; 1 pendiente de valor. Redespliega el servicio para que el contenedor las reciba.');
    expect(body.report.applied).toBe(true);
    expect(body.report.imported).toEqual([
      { key: 'DATABASE_URL', file: '.env.example' },
      { key: 'APP_URL', file: '.env.example' },
    ]);
    expect(getEnv(gitId)).toEqual({ DATABASE_URL: '${{Postgres.DATABASE_URL}}', APP_URL: 'https://app.real.io' });
    const persisted = (getService(gitId)!.config as GitConfig).envImport!;
    expect(persisted.source).toBe('manual');
    expect(persisted.handled).toEqual(['APP_URL', 'DATABASE_URL', 'PORT', 'STRIPE_KEY']);
    expect(JSON.stringify(persisted)).not.toContain('app.real.io');

    const detail = await app.inject({ method: 'GET', url: `/api/services/${gitId}`, headers: { cookie } });
    expect(JSON.parse(detail.body).service.config.envImport.pending).toEqual([{ key: 'STRIPE_KEY', file: '.env.example' }]);
  });

  it('una segunda vista previa no vuelve a proponer lo ya tratado y mantiene la pendiente', async () => {
    mockRepo({ '.env.example': ENV_EXAMPLE });
    const r = await importRepo(gitId);
    expect(r.statusCode, r.body).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.report.imported).toEqual([]);
    expect(body.report.pending).toEqual([{ key: 'STRIPE_KEY', file: '.env.example' }]);
    expect(body.report.skipped.map((s: { key: string; reason: string }) => [s.key, s.reason])).toEqual([
      ['DATABASE_URL', 'handled'],
      ['APP_URL', 'handled'],
      ['PORT', 'reserved'],
    ]);
  });
});

describe('autoImportEnv en el PATCH del servicio', () => {
  it('se guarda en servicios git y se ignora en el resto', async () => {
    const git = await app.inject({ method: 'PATCH', url: `/api/services/${gitId}`, headers: { cookie, ...SAME_ORIGIN }, payload: { config: { autoImportEnv: false } } });
    expect(git.statusCode, git.body).toBe(200);
    expect((getService(gitId)!.config as GitConfig).autoImportEnv).toBe(false);

    const db = await app.inject({ method: 'PATCH', url: `/api/services/${dbId}`, headers: { cookie, ...SAME_ORIGIN }, payload: { config: { autoImportEnv: false } } });
    expect(db.statusCode, db.body).toBe(200);
    expect(getService(dbId)!.config).not.toHaveProperty('autoImportEnv');
  });

  it('envImport no se puede escribir desde el PATCH', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/services/${gitlabId}`,
      headers: { cookie, ...SAME_ORIGIN },
      payload: { config: { envImport: { files: [], imported: [], pending: [], skipped: [], at: 1, applied: true, handled: [], source: 'manual' } } },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect((getService(gitlabId)!.config as GitConfig).envImport).toBeUndefined();
  });
});
