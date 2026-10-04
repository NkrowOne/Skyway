/**
 * Volver a versiones anteriores cuando su imagen ya se purgó.
 *
 * Solo se conservan las imágenes de las últimas versiones correctas, pero el
 * historial ofrecía «Volver a esta versión» en todas: el rollback creaba un
 * despliegue que fallaba («la imagen ya no existe») y lanzaba una alerta de
 * despliegue fallido en pleno incidente. Ahora se rechaza antes (409), el
 * historial dice qué versiones conservan imagen y se puede reconstruir un
 * commit concreto.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import {
  closeDb,
  createDeployment,
  createProject,
  createService,
  initDb,
  listAlerts,
  listDeployments,
  updateDeployment,
} from '../src/db';
import { cloneRepo } from '../src/deploy/builder';
import { DEFAULT_KEEP_IMAGES, keepImages } from '../src/deploy/deployer';

const m = vi.hoisted(() => ({ presentes: new Set<string>(), triggers: [] as unknown[] }));

vi.mock('../src/docker/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/docker/client')>()),
  dockerAvailable: vi.fn(async () => true),
}));
vi.mock('../src/docker/containers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/docker/containers')>()),
  imageExists: vi.fn(async (tag: string) => m.presentes.has(tag)),
  imageTagsOf: vi.fn(async () => new Set(m.presentes)),
  findContainer: vi.fn(async () => null),
}));
vi.mock('../src/docker/sampler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/docker/sampler')>()),
  dockerSnapshot: vi.fn(async () => ({ docker: true, at: Date.now(), services: new Map() })),
}));
// Sin desplegar de verdad: se crea la fila, como haría triggerDeploy, y se anota.
vi.mock('../src/deploy/deployer', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/deploy/deployer')>();
  const db = await import('../src/db');
  return {
    ...mod,
    triggerDeploy: vi.fn((serviceId: string, trigger: string, opts: { imageTag?: string; targetCommit?: string } = {}) => {
      m.triggers.push({ serviceId, trigger, ...opts });
      return db.createDeployment(serviceId, trigger, opts.imageTag ?? null, { targetCommit: opts.targetCommit ?? null });
    }),
  };
});

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
});

afterAll(async () => {
  await app.close();
  closeDb();
});

function servicioConVersiones() {
  const p = createProject('Tienda', `tienda-${Math.random().toString(36).slice(2, 8)}`);
  const s = createService(p.id, 'web', 'web', 'git', {
    repoUrl: 'https://github.com/acme/web',
    branch: 'main',
    port: 3000,
    domains: [],
    webhookSecret: 'x',
  } as any);
  const version = (n: number) => {
    const d = createDeployment(s.id, 'manual');
    updateDeployment(d.id, {
      status: 'success',
      commit_sha: String(n).repeat(40),
      image_tag: `skyway/tienda-web:v${n}`,
      finished_at: Date.now(),
    });
    return d.id;
  };
  return { s, vieja: version(1), reciente: version(2) };
}

describe('volver a una versión anterior', () => {
  it('sin la imagen: 409 sin crear despliegue ni alerta', async () => {
    const { s, vieja } = servicioConVersiones();
    m.presentes = new Set(['skyway/tienda-web:v2']);
    const antes = listDeployments(s.id, 50).length;

    const r = await app.inject({ method: 'POST', url: `/api/deployments/${vieja}/rollback`, headers: { cookie, ...SAME_ORIGIN } });
    expect(r.statusCode, r.body).toBe(409);
    const body = JSON.parse(r.body);
    expect(body.code).toBe('image_purged');
    expect(body.error).toMatch(/reconstruye el commit 1111111/);
    expect(listDeployments(s.id, 50)).toHaveLength(antes);
    expect(listAlerts({ openOnly: true }).filter((a) => a.service_id === s.id)).toHaveLength(0);
  });

  it('el historial dice qué versiones conservan la imagen', async () => {
    const { s, vieja, reciente } = servicioConVersiones();
    m.presentes = new Set(['skyway/tienda-web:v2']);
    const r = await app.inject({ method: 'GET', url: `/api/services/${s.id}/deployments`, headers: { cookie } });
    const lista = JSON.parse(r.body).deployments as { id: string; imageAvailable?: boolean }[];
    expect(lista.find((d) => d.id === vieja)?.imageAvailable).toBe(false);
    expect(lista.find((d) => d.id === reciente)?.imageAvailable).toBe(true);
  });

  it('con la imagen presente, el rollback sigue funcionando', async () => {
    const { vieja } = servicioConVersiones();
    m.presentes = new Set(['skyway/tienda-web:v1', 'skyway/tienda-web:v2']);
    const r = await app.inject({ method: 'POST', url: `/api/deployments/${vieja}/rollback`, headers: { cookie, ...SAME_ORIGIN } });
    expect(r.statusCode, r.body).toBe(202);
  });
});

describe('reconstruir un commit concreto', () => {
  it('crea un despliegue con ese commit; un SHA incompleto se rechaza', async () => {
    const { s } = servicioConVersiones();
    const malo = await app.inject({
      method: 'POST',
      url: `/api/services/${s.id}/deploy`,
      headers: { cookie, ...SAME_ORIGIN },
      payload: { commit: '1111111' },
    });
    expect(malo.statusCode).toBe(400);

    const sha = '1'.repeat(40);
    const r = await app.inject({ method: 'POST', url: `/api/services/${s.id}/deploy`, headers: { cookie, ...SAME_ORIGIN }, payload: { commit: sha } });
    expect(r.statusCode, r.body).toBe(202);
    expect(JSON.parse(r.body).deployment.target_commit).toBe(sha);
  });

  it('el clon deja el árbol en el commit pedido, no en la cabeza de la rama', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-repo-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'pruebas@example.com');
    git('config', 'user.name', 'Pruebas');
    // Como en GitHub: se puede pedir por su id cualquier commit alcanzable.
    git('config', 'uploadpack.allowReachableSHA1InWant', 'true');
    fs.writeFileSync(path.join(dir, 'version.txt'), 'uno');
    git('add', '.');
    git('commit', '-q', '-m', 'Primera versión');
    const primero = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'version.txt'), 'dos');
    git('commit', '-q', '-am', 'Segunda versión');

    const dest = path.join(os.tmpdir(), `skyway-clon-${Date.now()}`);
    try {
      const info = await cloneRepo({ repoUrl: `file://${dir}`, branch: 'main', token: null, dest, commit: primero }, () => {});
      expect(info.commitSha).toBe(primero);
      expect(fs.readFileSync(path.join(dest, 'version.txt'), 'utf8')).toBe('uno');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});

describe('versiones conservadas', () => {
  it('se configuran en Ajustes (1 a 50) y la purga las respeta', async () => {
    expect(keepImages()).toBe(DEFAULT_KEEP_IMAGES);
    const malo = await app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie, ...SAME_ORIGIN }, payload: { keepImages: '0' } });
    expect(malo.statusCode).toBe(400);
    const bueno = await app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie, ...SAME_ORIGIN }, payload: { keepImages: '12' } });
    expect(bueno.statusCode, bueno.body).toBe(200);
    expect(keepImages()).toBe(12);
  });
});
