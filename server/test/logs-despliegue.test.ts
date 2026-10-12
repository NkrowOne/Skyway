/**
 * Registro de un despliegue sin la salida de la aplicación.
 *
 * La lista de despliegues abre sola la primera tarjeta, y su registro
 * mezclaba la compilación con la salida en vivo de la aplicación: lo primero
 * que se veía al entrar en un servicio eran logs de la aplicación. Con
 * `?runtime=0` la ruta devuelve solo compilación y despliegue, y no le pide a
 * Docker las 3000 líneas de la aplicación.
 */
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { closeDb, createDeployment, createProject, createService, initDb, updateDeployment } from '../src/db';
import { fetchLogsText } from '../src/docker/containers';

const m = vi.hoisted(() => ({ deploymentId: '' }));

vi.mock('../src/docker/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/docker/client')>()),
  dockerAvailable: vi.fn(async () => true),
}));
vi.mock('../src/docker/containers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/docker/containers')>()),
  findContainer: vi.fn(async () => ({ Config: { Labels: { 'skyway.deployment': m.deploymentId } }, State: { Running: true } })),
  fetchLogsText: vi.fn(async () => '2026-10-12T12:00:00.000000000Z servidor escuchando en :3000\n'),
}));

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
let app: FastifyInstance;
let cookie = '';

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
  cookie = String(setup.headers['set-cookie']).split(';')[0];

  const p = createProject('Tienda', 'tienda');
  const s = createService(p.id, 'web', 'web', 'git', {
    repoUrl: 'https://github.com/acme/web',
    branch: 'main',
    port: 3000,
    domains: [],
    webhookSecret: 'x',
  } as any);
  const d = createDeployment(s.id, 'manual');
  updateDeployment(d.id, {
    status: 'success',
    logs: '2026-10-12T11:59:00.000Z Clonando el repositorio\n2026-10-12T11:59:30.000Z ✔ Despliegue completado\n',
    finished_at: Date.now(),
  });
  m.deploymentId = d.id;
});

afterAll(async () => {
  await app.close();
  closeDb();
});

beforeEach(() => {
  vi.mocked(fetchLogsText).mockClear();
});

describe('GET /api/deployments/:id/logs', () => {
  it('por defecto incluye la salida de la aplicación del contenedor de esa versión', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/deployments/${m.deploymentId}/logs`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.buildLogs).toContain('Clonando el repositorio');
    expect(body.runtimeLogs).toContain('servidor escuchando');
    expect(body.isLiveRuntime).toBe(true);
    expect(fetchLogsText).toHaveBeenCalledTimes(1);
  });

  it('con runtime=0 devuelve solo compilación y despliegue, sin pedir nada a Docker', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/deployments/${m.deploymentId}/logs?runtime=0`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.buildLogs).toContain('✔ Despliegue completado');
    expect(body.runtimeLogs).toBeNull();
    expect(body.isLiveRuntime).toBe(false);
    expect(fetchLogsText).not.toHaveBeenCalled();
  });

  it('rechaza un valor de runtime que no es 0 ni 1', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/deployments/${m.deploymentId}/logs?runtime=no`, headers: { cookie } });
    expect(r.statusCode).toBe(400);
  });
});
