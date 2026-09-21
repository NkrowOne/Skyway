import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { closeDb, getService, initDb } from '../src/db';
import { GitConfig } from '../src/types';

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const TAPADO = '•••';

let app: FastifyInstance;
let cookie = '';
let projectId = '';
let gitId = '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function createService(payload: Record<string, unknown>) {
  const r = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/services`,
    headers: { cookie, ...SAME_ORIGIN },
    payload,
  });
  // Sin Docker el despliegue inicial falla en segundo plano: se le da margen
  // para que termine antes de seguir, y no se comprueba su resultado.
  if (r.statusCode === 201) await sleep(200);
  return r;
}

async function patchService(id: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'PATCH', url: `/api/services/${id}`, headers: { cookie, ...SAME_ORIGIN }, payload });
}

async function readService(id: string) {
  const r = await app.inject({ method: 'GET', url: `/api/services/${id}`, headers: { cookie } });
  expect(r.statusCode, r.body).toBe(200);
  return JSON.parse(r.body).service as { id: string; config: Record<string, unknown> };
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

  const git = await createService({ type: 'git', name: 'api', repoUrl: 'https://github.com/x/y', branch: 'main' });
  expect(git.statusCode, git.body).toBe(201);
  gitId = JSON.parse(git.body).service.id as string;
});

afterAll(async () => {
  await app.close();
  closeDb();
});

describe('dominios', () => {
  const invalidos = ['x`) || PathPrefix(`/', '-bad.com', 'a..b'];

  it.each(invalidos)('se rechaza el dominio %j al crear el servicio', async (dominio) => {
    const r = await createService({ type: 'git', name: 'malo', repoUrl: 'https://github.com/x/y', branch: 'main', domains: [dominio] });
    expect(r.statusCode, r.body).toBe(400);
  });

  it.each(invalidos)('se rechaza el dominio %j al editar el servicio', async (dominio) => {
    const r = await patchService(gitId, { config: { domains: [dominio] } });
    expect(r.statusCode, r.body).toBe(400);
  });

  it('los dominios válidos se guardan en minúsculas', async () => {
    const r = await patchService(gitId, { config: { domains: ['App.Example.COM', 'WWW.example.com'] } });
    expect(r.statusCode, r.body).toBe(200);
    const service = await readService(gitId);
    expect(service.config.domains).toEqual(['app.example.com', 'www.example.com']);
  });
});

describe('secretos en la configuración', () => {
  it('el detalle conserva webhookSecret y tapa los buildArgs', async () => {
    const r = await patchService(gitId, { config: { buildArgs: { TOKEN: 'secreto' } } });
    expect(r.statusCode, r.body).toBe(200);
    expect(JSON.parse(r.body).service.config.buildArgs).toEqual({ TOKEN: TAPADO });

    const service = await readService(gitId);
    expect(typeof service.config.webhookSecret).toBe('string');
    expect(String(service.config.webhookSecret).length).toBeGreaterThan(0);
    expect(service.config.buildArgs).toEqual({ TOKEN: TAPADO });
  });

  it('reenviar los buildArgs tapados conserva el valor real', async () => {
    const r = await patchService(gitId, { config: { buildArgs: { TOKEN: TAPADO } } });
    expect(r.statusCode, r.body).toBe(200);
    const cfg = getService(gitId)!.config as GitConfig;
    expect(cfg.buildArgs).toEqual({ TOKEN: 'secreto' });
  });

  it('el listado de proyectos no incluye webhookSecret en la config de los servicios', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    const projects = JSON.parse(r.body).projects as { id: string; services: { id: string; config: Record<string, unknown> }[] }[];
    const project = projects.find((p) => p.id === projectId);
    expect(project).toBeDefined();
    const git = project!.services.find((s) => s.id === gitId);
    expect(git).toBeDefined();
    expect(git!.config).not.toHaveProperty('webhookSecret');
    expect(git!.config.buildArgs).toEqual({ TOKEN: TAPADO });
  });
});

describe('servicios de imagen', () => {
  it('añadir un dominio a un servicio sin puerto interno responde 400 con el aviso de Traefik', async () => {
    const created = await createService({ type: 'image', name: 'worker', image: 'busybox' });
    expect(created.statusCode, created.body).toBe(201);
    const id = JSON.parse(created.body).service.id as string;

    const r = await patchService(id, { config: { domains: ['worker.example.com'] } });
    expect(r.statusCode, r.body).toBe(400);
    expect(JSON.parse(r.body).error).toContain('Traefik');
  });
});

describe('acciones sobre el contenedor sin Docker', () => {
  it.each(['start', 'stop', 'restart'])('POST /api/services/:id/%s responde 503', async (action) => {
    const r = await app.inject({ method: 'POST', url: `/api/services/${gitId}/${action}`, headers: { cookie, ...SAME_ORIGIN } });
    expect(r.statusCode, r.body).toBe(503);
    expect(JSON.parse(r.body).error).toBe('Docker no está disponible');
  });
});
