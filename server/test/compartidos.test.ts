/**
 * Servicios compartidos entre proyectos.
 *
 * Cada proyecto tiene su red privada y sus servicios se llaman por el slug.
 * Dos proyectos con una base `postgresql` cada uno: desde el segundo,
 * `postgresql` es SU base, y la cadena de conexión de la del primero, copiada
 * a mano, acababa en la base equivocada («password authentication failed»).
 * Compartir el servicio le da un nombre que no choca (`postgresql.ebuttons`) y
 * deja referenciar sus variables como `${{ebuttons/postgresql.DATABASE_URL}}`.
 */
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import {
  closeDb,
  createProject,
  createWorkspaceRow,
  deleteProject,
  getEnv,
  getProject,
  getService,
  initDb,
  listServiceShares,
  setProjectVars,
} from '../src/db';
import { redesCompartidas, reescribirHost } from '../src/shares';
import { resolveServiceEnv } from '../src/variables';

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
let app: FastifyInstance;
let cookie = '';
let ebuttons = '';
let emesh = '';
let baseEbuttons = '';
let bot = '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const send = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie, ...SAME_ORIGIN }, ...(payload !== undefined ? { payload: payload as any } : {}) });

async function alta(projectId: string, payload: Record<string, unknown>): Promise<string> {
  const r = await send('POST', `/api/projects/${projectId}/services`, payload);
  expect(r.statusCode, r.body).toBe(201);
  return JSON.parse(r.body).service.id;
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
  ebuttons = JSON.parse((await send('POST', '/api/projects', { name: 'eButtons' })).body).project.id;
  emesh = JSON.parse((await send('POST', '/api/projects', { name: 'eMesh' })).body).project.id;
  baseEbuttons = await alta(ebuttons, { type: 'database', template: 'postgres', name: 'PostgreSQL' });
  await alta(emesh, { type: 'database', template: 'postgres', name: 'PostgreSQL' });
  bot = await alta(emesh, { type: 'git', name: 'bot', repoUrl: 'https://github.com/acme/bot', branch: 'main' });
  // Sin Docker los despliegues iniciales fallan en segundo plano: se les deja terminar.
  await sleep(300);
});

afterAll(async () => {
  await app.close();
  closeDb();
});

const resueltas = async (vars: Record<string, string>) => {
  const put = await send('PUT', `/api/services/${bot}/env`, { vars });
  expect(put.statusCode, put.body).toBe(200);
  return JSON.parse((await send('GET', `/api/services/${bot}/env`)).body) as {
    resolved: Record<string, string>;
    references: { service: string; vars: string[]; connect: string[] }[];
  };
};

describe('compartir un servicio con otro proyecto', () => {
  it('sin compartir, la referencia a otro proyecto no se resuelve', async () => {
    const env = await resueltas({ EBUTTONS_DATABASE_URL: '${{ebuttons/postgresql.DATABASE_URL}}' });
    expect(env.resolved.EBUTTONS_DATABASE_URL).toBe('${{ebuttons/postgresql.DATABASE_URL}}');
    expect(env.references.map((g) => g.service)).not.toContain('ebuttons/postgresql');
  });

  it('enseña el nombre compartido y los proyectos de la misma empresa', async () => {
    const r = await send('GET', `/api/services/${baseEbuttons}/shares`);
    expect(r.statusCode, r.body).toBe(200);
    const body = JSON.parse(r.body);
    expect(body).toMatchObject({ alias: 'postgresql.ebuttons', port: 5432, reference: 'ebuttons/postgresql', canManage: true });
    expect(body.projects).toEqual([{ id: emesh, name: 'eMesh', slug: 'emesh', shared: false }]);
  });

  it('compartido: la URL de la otra base lleva su nombre compartido y la propia sigue igual', async () => {
    const put = await send('PUT', `/api/services/${baseEbuttons}/shares`, { projectIds: [emesh] });
    expect(put.statusCode, put.body).toBe(200);
    expect(listServiceShares(baseEbuttons)).toEqual([emesh]);
    expect(redesCompartidas(getService(baseEbuttons)!, getProject(ebuttons)!)).toEqual([
      { red: 'skyway-emesh', alias: 'postgresql.ebuttons' },
    ]);

    const clave = getEnv(baseEbuttons).PGPASSWORD;
    const env = await resueltas({
      EBUTTONS_DATABASE_URL: '${{ebuttons/postgresql.DATABASE_URL}}',
      POR_NOMBRE: '${{eButtons/PostgreSQL.PGHOST}}:${{ebuttons/postgresql.PGPORT}}',
      BASE: '${{ebuttons/postgresql.PGDATABASE}}',
      DATABASE_URL: '${{PostgreSQL.DATABASE_URL}}',
    });
    expect(env.resolved.EBUTTONS_DATABASE_URL).toBe(`postgresql://skyway:${clave}@postgresql.ebuttons:5432/skyway`);
    expect(env.resolved.POR_NOMBRE).toBe('postgresql.ebuttons:5432');
    expect(env.resolved.BASE).toBe('skyway');
    // La base del propio proyecto se sigue llamando por su slug, y es otra.
    expect(env.resolved.DATABASE_URL).toMatch(/@postgresql:5432\/skyway$/);
    expect(env.resolved.DATABASE_URL).not.toContain(clave);

    const grupo = env.references.find((g) => g.service === 'ebuttons/postgresql');
    // Sin conexión de un clic: pisaría la DATABASE_URL de la base propia.
    expect(grupo?.connect).toEqual([]);
    expect(grupo?.vars).toContain('PGHOST');
  });

  it('no deja leer las variables compartidas del proyecto de origen', async () => {
    setProjectVars(ebuttons, { SECRETO: 'solo-de-ebuttons' });
    const env = await resueltas({ X: '${{ebuttons/postgresql.SECRETO}}' });
    expect(env.resolved.X).toBe('${{ebuttons/postgresql.SECRETO}}');
  });

  it('un ciclo de referencias entre proyectos no cuelga la resolución', async () => {
    await send('PUT', `/api/services/${bot}/shares`, { projectIds: [ebuttons] });
    const web = await alta(ebuttons, { type: 'git', name: 'web', repoUrl: 'https://github.com/acme/web', branch: 'main' });
    await sleep(300);
    await send('PUT', `/api/services/${web}/shares`, { projectIds: [emesh] });
    await send('PUT', `/api/services/${web}/env`, { vars: { A: '${{emesh/bot.B}}' } });
    await send('PUT', `/api/services/${bot}/env`, { vars: { B: '${{ebuttons/web.A}}' } });
    expect(resolveServiceEnv(getService(bot)!).B).toContain('${{');
  });

  it('solo entre proyectos de la misma empresa', async () => {
    const otra = createWorkspaceRow('Otra empresa');
    const ajeno = createProject('Ajeno', 'ajeno', null, otra.id);
    const r = await send('PUT', `/api/services/${baseEbuttons}/shares`, { projectIds: [ajeno.id] });
    expect(r.statusCode, r.body).toBe(400);
    expect(JSON.parse(r.body).code).toBe('invalid_project');
    expect((await send('PUT', `/api/services/${baseEbuttons}/shares`, { projectIds: [ebuttons] })).statusCode).toBe(400);
    expect((await send('PUT', `/api/services/${baseEbuttons}/shares`, { projectIds: ['prj_no_existe'] })).statusCode).toBe(400);
    expect(listServiceShares(baseEbuttons)).toEqual([emesh]);
  });

  it('dejar de compartir y borrar el proyecto que lo recibía', async () => {
    let r = await send('PUT', `/api/services/${baseEbuttons}/shares`, { projectIds: [] });
    expect(r.statusCode, r.body).toBe(200);
    expect(listServiceShares(baseEbuttons)).toEqual([]);
    const env = await resueltas({ EBUTTONS_DATABASE_URL: '${{ebuttons/postgresql.DATABASE_URL}}' });
    expect(env.resolved.EBUTTONS_DATABASE_URL).toContain('${{');

    r = await send('PUT', `/api/services/${baseEbuttons}/shares`, { projectIds: [emesh] });
    expect(listServiceShares(baseEbuttons)).toEqual([emesh]);
    deleteProject(emesh);
    expect(listServiceShares(baseEbuttons)).toEqual([]);
  });
});

describe('reescribirHost', () => {
  const r = (clave: string, valor: string) => reescribirHost(clave, valor, 'postgres', 'postgres.tienda');

  it('en una URL cambia solo el host, no el usuario ni la base', () => {
    expect(r('DATABASE_URL', 'postgres://postgres:postgres@postgres:5432/postgres')).toBe(
      'postgres://postgres:postgres@postgres.tienda:5432/postgres',
    );
    expect(r('URL', 'http://postgres/postgres')).toBe('http://postgres.tienda/postgres');
    expect(r('URL', 'http://postgres.railway.internal:80/x')).toBe('http://postgres.tienda:80/x');
    expect(r('MONGO_URL', 'mongodb://u:p@otro:27017,postgres:27017/db')).toBe('mongodb://u:p@otro:27017,postgres.tienda:27017/db');
    expect(r('URL', 'https://example.com/postgres')).toBe('https://example.com/postgres');
  });

  it('fuera de una URL, solo host:puerto o una variable de host', () => {
    expect(r('REDIS_ADDR', 'postgres:6379')).toBe('postgres.tienda:6379');
    expect(r('PGHOST', 'postgres')).toBe('postgres.tienda');
    expect(r('INTERNAL_HOST', 'postgres')).toBe('postgres.tienda');
    expect(r('PGDATABASE', 'postgres')).toBe('postgres');
    expect(r('PGUSER', 'postgres')).toBe('postgres');
    expect(r('NOTA', 'usa postgres siempre')).toBe('usa postgres siempre');
  });
});
