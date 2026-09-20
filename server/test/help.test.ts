import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import {
  closeDb,
  createDeployment,
  createProject,
  createService,
  createUser,
  initDb,
  setDeploymentDiagnosis,
  setEnv,
  updateDeployment,
} from '../src/db';
import { FAQ, FAQ_CATEGORIES } from '../src/help/faq';
import { detectRuntimeIssues, maskSecrets } from '../src/help/runtime';
import { normalizeText, searchFaq } from '../src/help/assistant';
import { AskResponse, HelpIssue } from '../src/help/types';
import { GitConfig } from '../src/types';
import { hashPassword } from '../src/util';

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

let app: FastifyInstance;
let cookie = '';
let memberCookie = '';
let projectId = '';
let serviceId = '';
let healthyId = '';

async function login(email: string, password: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, headers: SAME_ORIGIN });
  expect(r.statusCode, r.body).toBe(200);
  return String(r.headers['set-cookie']).split(';')[0];
}

const gitConfig = (port = 3000): GitConfig => ({
  repoUrl: 'https://github.com/x/y',
  branch: 'main',
  port,
  domains: [],
  webhookSecret: 'whs',
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

  // Un miembro sin proyectos asignados: no ve nada de lo de arriba.
  createUser('miembro@example.com', hashPassword('contraseña1'), 'member');
  memberCookie = await login('miembro@example.com', 'contraseña1');

  // Los servicios se crean directamente en la BD: la ruta dispararía un
  // despliegue en segundo plano, y aquí el despliegue fallido se fabrica a mano.
  const project = createProject('Demo', 'demo');
  projectId = project.id;
  const api = createService(projectId, 'api', 'api', 'git', {
    ...gitConfig(),
    envImport: { pending: [{ key: 'STRIPE_KEY', file: '.env.example' }] },
  } as GitConfig);
  serviceId = api.id;
  setEnv(api.id, { DATABASE_URL: '${{Postgres.DATABASE_URL}}', NODE_ENV: 'production' });

  const dep = createDeployment(api.id, 'manual');
  updateDeployment(dep.id, {
    status: 'failed',
    error: 'La versión nueva no pasó la validación de salud. Se mantuvo la versión anterior.',
    logs: 'Construyendo…\nhealthcheck: GET /health → sin respuesta',
    finished_at: Date.now(),
  });
  setDeploymentDiagnosis(dep.id, {
    id: 'healthcheck-failed',
    title: 'La versión nueva no superó la validación de salud',
    cause: 'La sonda no respondió 2xx a tiempo.',
    fix: 'Comprueba la ruta de healthcheck y el puerto interno.',
  });

  const web = createService(projectId, 'web', 'web', 'git', gitConfig(8080));
  healthyId = web.id;
  const ok = createDeployment(web.id, 'manual');
  updateDeployment(ok.id, { status: 'success', finished_at: Date.now() });
});

afterAll(async () => {
  await app.close();
  closeDb();
});

describe('FAQ', () => {
  it('tiene al menos 30 entradas con ids únicos y categorías conocidas', () => {
    expect(FAQ.length).toBeGreaterThanOrEqual(30);
    const ids = new Set(FAQ.map((f) => f.id));
    expect(ids.size).toBe(FAQ.length);
    const categories = new Set(FAQ_CATEGORIES.map((c) => c.key));
    for (const f of FAQ) {
      expect(categories.has(f.category), f.id).toBe(true);
      expect(f.keywords.length, f.id).toBeGreaterThan(0);
    }
  });
});

describe('searchFaq', () => {
  it('normaliza acentos y plurales', () => {
    expect(normalizeText('Despliegues fallidos')).toEqual(normalizeText('despliegue fallido'));
    expect(normalizeText('Variables')).toEqual(normalizeText('variable'));
  });

  it('encuentra la entrada de dominios aunque se escriba sin acentos y en plural', () => {
    const ids = searchFaq('como añado dominios').map((f) => f.id);
    expect(ids[0]).toBe('anadir-dominio');
  });

  it('un error frecuente («502») lleva a la entrada de dominios con 502 por las palabras clave', () => {
    const ids = searchFaq('502 bad gateway').map((f) => f.id);
    expect(ids).toContain('dominio-502');
  });

  it('acepta sinónimos: «copia de seguridad» y «backup» llevan a la misma entrada', () => {
    expect(searchFaq('restaurar una copia de seguridad')[0].id).toBe('backups-y-restauracion');
    expect(searchFaq('backup')[0].id).toBe('backups-y-restauracion');
  });

  it('una frase de palabras clave con negación («no arranca») pesa más que las palabras sueltas', () => {
    expect(searchFaq('la app no arranca')[0].id).toBe('app-no-arranca');
  });

  it('devuelve como mucho tres y nada para una pregunta sin tokens útiles', () => {
    expect(searchFaq('despliegue variables dominio base de datos logs').length).toBeLessThanOrEqual(3);
    expect(searchFaq('¿qué?')).toEqual([]);
  });
});

describe('detectRuntimeIssues', () => {
  it('detecta la variable de entorno ausente y la nombra', () => {
    const found = detectRuntimeIssues('2024-01-01T00:00:00Z Error: DATABASE_URL is not defined\n    at Object.<anonymous>');
    expect(found.map((f) => f.id)).toEqual(['env-missing']);
    expect(found[0].title).toContain('DATABASE_URL');
    expect(found[0].evidence).toBe('Error: DATABASE_URL is not defined');
  });

  it('detecta conexión rechazada, puerto ocupado y escucha en localhost sin repetir reglas', () => {
    const logs = [
      'Server running at http://localhost:3000',
      'Error: connect ECONNREFUSED 127.0.0.1:5432',
      'Error: connect ECONNREFUSED 127.0.0.1:5432',
      'Error: listen EADDRINUSE: address already in use :::3000',
    ].join('\n');
    const ids = detectRuntimeIssues(logs).map((f) => f.id);
    expect(ids).toEqual(['db-connection-refused', 'port-in-use', 'listen-localhost']);
  });

  it('un KeyError de Python cuenta como variable ausente y el traceback como excepción', () => {
    const logs = 'Traceback (most recent call last):\n  File "app.py", line 3\nKeyError: \'SECRET_KEY\'';
    const ids = detectRuntimeIssues(logs).map((f) => f.id);
    expect(ids).toEqual(['env-missing', 'unhandled-exception']);
  });

  it('enmascara secretos en la evidencia y la recorta a 200 caracteres', () => {
    const logs =
      'Error: connect ECONNREFUSED postgres://admin:supersecreta@db:5432/app password=otra token=abc123 ' +
      'x'.repeat(300);
    const [f] = detectRuntimeIssues(logs);
    expect(f.evidence).not.toContain('supersecreta');
    expect(f.evidence).not.toContain('otra');
    expect(f.evidence).not.toContain('abc123');
    expect(f.evidence).toContain('admin:•••@db');
    expect(f.evidence.length).toBeLessThanOrEqual(200);
  });

  it('maskSecrets tapa claves con prefijo y cabeceras Bearer', () => {
    const out = maskSecrets('Authorization: Bearer eyJhbGciOi.xxx key ghp_abcdefghijklmnop');
    expect(out).not.toContain('eyJhbGciOi');
    expect(out).not.toContain('abcdefghijklmnop');
  });

  it('no devuelve más de cinco hallazgos', () => {
    const logs = [
      'X is not defined',
      'ECONNREFUSED',
      'password authentication failed for user "app"',
      'relation "users" does not exist',
      'EADDRINUSE',
      'EACCES: permission denied',
      'Cannot find module "express"',
    ].join('\n');
    expect(detectRuntimeIssues(logs).length).toBe(5);
  });
});

describe('rutas de ayuda', () => {
  it('exigen sesión', async () => {
    for (const url of ['/api/help/faq', '/api/help/issues']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(401);
    }
    const ask = await app.inject({ method: 'POST', url: '/api/help/ask', payload: { question: 'hola' } });
    expect(ask.statusCode).toBe(401);
  });

  it('GET /api/help/faq devuelve categorías y entradas', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/help/faq', headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    const body = JSON.parse(r.body) as { categories: unknown[]; entries: unknown[] };
    expect(body.categories.length).toBe(FAQ_CATEGORIES.length);
    expect(body.entries.length).toBe(FAQ.length);
  });

  it('POST /api/help/ask devuelve coincidencias de las FAQ y una respuesta', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/help/ask',
      headers: { cookie, ...SAME_ORIGIN },
      payload: { question: '¿Cómo añado un dominio?' },
    });
    expect(r.statusCode, r.body).toBe(200);
    const body = JSON.parse(r.body) as AskResponse;
    expect(body.matches[0].id).toBe('anadir-dominio');
    expect(body.answer).toContain('Esto puede ayudarte');
    expect(body.issues).toEqual([]);
  });

  it('POST /api/help/ask con servicio e intención de error revisa el servicio', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/help/ask',
      headers: { cookie, ...SAME_ORIGIN },
      payload: { question: 'Mi despliegue falla', serviceId },
    });
    expect(r.statusCode, r.body).toBe(200);
    const body = JSON.parse(r.body) as AskResponse;
    expect(body.answer).toContain('He revisado **api**');
    expect(body.issues.map((i) => i.id)).toContain('deploy-failed:healthcheck-failed');
    expect(body.issues[0].severity).toBe('critical');
    expect(body.links.some((l) => l.to.includes(`s=${serviceId}`))).toBe(true);
  });

  it('POST /api/help/ask sin servicio reconoce el servicio por su nombre', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/help/ask',
      headers: { cookie, ...SAME_ORIGIN },
      payload: { question: 'el servicio api no arranca' },
    });
    expect(r.statusCode, r.body).toBe(200);
    const body = JSON.parse(r.body) as AskResponse;
    expect(body.issues.every((i) => i.serviceId === serviceId)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it('POST /api/help/ask valida el cuerpo y responde 404 con un servicio ajeno', async () => {
    const empty = await app.inject({ method: 'POST', url: '/api/help/ask', headers: { cookie, ...SAME_ORIGIN }, payload: { question: '  ' } });
    expect(empty.statusCode).toBe(400);
    const foreign = await app.inject({
      method: 'POST',
      url: '/api/help/ask',
      headers: { cookie: memberCookie, ...SAME_ORIGIN },
      payload: { question: 'falla', serviceId },
    });
    expect(foreign.statusCode, foreign.body).toBe(404);
  });

  it('GET /api/help/issues?serviceId= devuelve el despliegue fallido, la referencia sin resolver y las pendientes', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/help/issues?serviceId=${serviceId}`, headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    const body = JSON.parse(r.body) as { issues: HelpIssue[]; scanned: number };
    expect(body.scanned).toBe(1);
    const ids = body.issues.map((i) => i.id);
    expect(ids[0]).toBe('deploy-failed:healthcheck-failed');
    expect(ids).toContain('env:unresolved-ref');
    expect(ids).toContain('env:pending');
    const failed = body.issues[0];
    expect(failed.serviceName).toBe('api');
    expect(failed.projectId).toBe(projectId);
    expect(failed.links.some((l) => l.to === `/projects/${projectId}?s=${serviceId}&tab=deployments`)).toBe(true);
    expect(failed.evidence).toContain('validación de salud');
    const unresolved = body.issues.find((i) => i.id === 'env:unresolved-ref')!;
    expect(unresolved.evidence).toContain('DATABASE_URL → ${{Postgres.DATABASE_URL}}');
    const pending = body.issues.find((i) => i.id === 'env:pending')!;
    expect(pending.links[0].to).toContain('tab=variables');
  });

  it('GET /api/help/issues sin servicio escanea todos los accesibles y un servicio sano no aporta nada', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/help/issues', headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    const body = JSON.parse(r.body) as { issues: HelpIssue[]; scanned: number };
    expect(body.scanned).toBe(2);
    expect(body.issues.some((i) => i.serviceId === serviceId)).toBe(true);
    expect(body.issues.some((i) => i.serviceId === healthyId)).toBe(false);
  });

  it('GET /api/help/issues responde 404 con un servicio ajeno y vacío para quien no ve nada', async () => {
    const foreign = await app.inject({ method: 'GET', url: `/api/help/issues?serviceId=${serviceId}`, headers: { cookie: memberCookie } });
    expect(foreign.statusCode).toBe(404);
    const nothing = await app.inject({ method: 'GET', url: '/api/help/issues', headers: { cookie: memberCookie } });
    expect(nothing.statusCode).toBe(200);
    expect(JSON.parse(nothing.body)).toEqual({ issues: [], scanned: 0 });
  });
});
