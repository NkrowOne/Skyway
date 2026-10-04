/**
 * Webhook de GitHub por servicio: qué push despliegan y cuáles no.
 *
 *  - Un commit cuyo despliegue falló (o lo cortó un reinicio) no está
 *    «ya desplegado»: reenviar el push desde GitHub tiene que lanzarlo otra vez.
 *  - Con la GitHub App y el webhook manual configurados, cada push llegaba dos
 *    veces y se desplegaba dos veces: con uno en curso que va a clonar la
 *    cabeza, el segundo se ignora.
 *
 * `triggerDeploy` se sustituye: aquí solo importa qué se habría desplegado.
 */
import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { closeDb, createDeployment, createProject, createService, initDb, lastBuiltCommitSha, updateDeployment } from '../src/db';

const m = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../src/deploy/deployer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/deploy/deployer')>()),
  triggerDeploy: vi.fn((serviceId: string) => {
    m.calls.push(serviceId);
    return { id: 'dep_falso', status: 'queued' };
  }),
}));

const SECRETO = 'secreto-del-webhook';
let app: FastifyInstance;

beforeAll(async () => {
  initDb();
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeDb();
});

beforeEach(() => {
  m.calls.length = 0;
});

function servicio() {
  const p = createProject('Web', `web-${Math.random().toString(36).slice(2, 8)}`);
  return createService(p.id, 'app', 'app', 'git', {
    repoUrl: 'https://github.com/acme/web',
    branch: 'main',
    port: 3000,
    domains: [],
    webhookSecret: SECRETO,
    autoDeploy: true,
  } as any);
}

async function push(serviceId: string, sha: string) {
  const body = JSON.stringify({ ref: 'refs/heads/main', after: sha });
  const firma = 'sha256=' + crypto.createHmac('sha256', SECRETO).update(body).digest('hex');
  const r = await app.inject({
    method: 'POST',
    url: `/api/webhooks/github/${serviceId}`,
    payload: body,
    headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': firma },
  });
  expect(r.statusCode, r.body).toBe(200);
  return JSON.parse(r.body) as { ok: boolean; ignored?: string; deployment?: unknown };
}

describe('webhook por servicio', () => {
  it('el reenvío de un push cuyo despliegue falló vuelve a desplegar', async () => {
    const s = servicio();
    const d = createDeployment(s.id, 'webhook');
    updateDeployment(d.id, { status: 'failed', commit_sha: 'f'.repeat(40), error: 'Interrumpido por reinicio del servidor', finished_at: Date.now() });
    expect(lastBuiltCommitSha(s.id)).toBeNull();

    const r = await push(s.id, 'f'.repeat(40));
    expect(r.ignored).toBeUndefined();
    expect(m.calls).toEqual([s.id]);
  });

  it('el commit ya desplegado con éxito no se repite', async () => {
    const s = servicio();
    const d = createDeployment(s.id, 'webhook');
    updateDeployment(d.id, { status: 'success', commit_sha: 'a'.repeat(40), finished_at: Date.now() });

    const r = await push(s.id, 'a'.repeat(40));
    expect(r.ignored).toMatch(/ya desplegado/);
    expect(m.calls).toEqual([]);
  });

  it('con un despliegue en cola que aún no ha clonado, el push no encola otro (App y webhook a la vez)', async () => {
    const s = servicio();
    createDeployment(s.id, 'webhook'); // el que lanzó el webhook de la App: clonará la cabeza

    const r = await push(s.id, 'b'.repeat(40));
    expect(r.ignored).toMatch(/despliegue en curso/);
    expect(m.calls).toEqual([]);
  });

  it('con un despliegue en curso de OTRO commit ya clonado, el push nuevo sí se encola', async () => {
    const s = servicio();
    const d = createDeployment(s.id, 'webhook');
    updateDeployment(d.id, { status: 'building', commit_sha: 'c'.repeat(40) });

    const mismo = await push(s.id, 'c'.repeat(40));
    expect(mismo.ignored).toMatch(/ya desplegado/);
    const nuevo = await push(s.id, 'd'.repeat(40));
    expect(nuevo.ignored).toBeUndefined();
    expect(m.calls).toEqual([s.id]);
  });
});
