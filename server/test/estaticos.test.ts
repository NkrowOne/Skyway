import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import { closeDb, initDb } from '../src/db';

/**
 * La web compilada (`web/dist`) servida por @fastify/static con la vuelta a
 * `index.html` de la SPA. Se monta una web de prueba en una carpeta temporal,
 * con un fichero «secreto» FUERA de ella que ninguna ruta debe poder servir.
 */

const MARCA = 'MARCA-SECRETA-FUERA-DE-LA-WEB';
const INDEX = '<!doctype html><html><head><script type="module" src="/assets/app-abc123.js"></script></head><body><div id="root"></div></body></html>';

let base = '';
let app: FastifyInstance;
let puerto = 0;
const webDistOriginal = config.webDist;

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-web-'));
  const dist = path.join(base, 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), INDEX);
  fs.writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log("app");');
  fs.writeFileSync(path.join(dist, 'assets', 'estilo-abc123.css'), 'body{margin:0}');
  fs.writeFileSync(path.join(base, 'secreto.txt'), MARCA);
  config.webDist = dist;
  initDb();
  app = buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  puerto = (app.server.address() as net.AddressInfo).port;
});

afterAll(async () => {
  await app.close();
  closeDb();
  config.webDist = webDistOriginal;
  fs.rmSync(base, { recursive: true, force: true });
});

/** Petición HTTP cruda: la ruta va tal cual, sin la normalización de `inject` ni de `fetch`. */
function cruda(ruta: string): Promise<{ status: number; headers: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(puerto, '127.0.0.1');
    let datos = '';
    socket.on('data', (d) => (datos += d.toString('latin1')));
    socket.on('end', () => {
      const corte = datos.indexOf('\r\n\r\n');
      const headers = datos.slice(0, corte);
      resolve({ status: Number(headers.split(' ')[1]), headers, body: datos.slice(corte + 4) });
    });
    socket.on('error', reject);
    socket.write(`GET ${ruta} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
  });
}

describe('web compilada', () => {
  it('la raíz sirve index.html sin caché y con las cabeceras de seguridad', async () => {
    const r = await app.inject({ method: 'GET', url: '/' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe(INDEX);
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('los assets con hash llevan caché inmutable de un año', async () => {
    const js = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(js.statusCode).toBe(200);
    expect(js.body).toBe('console.log("app");');
    expect(js.headers['content-type']).toMatch(/^(application|text)\/javascript/);
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const css = await app.inject({ method: 'GET', url: '/assets/estilo-abc123.css' });
    expect(css.headers['content-type']).toMatch(/^text\/css/);
    expect(css.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('un asset sin cambios responde 304 con su ETag', async () => {
    const primera = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    const r = await app.inject({ method: 'GET', url: '/assets/app-abc123.js', headers: { 'if-none-match': String(primera.headers.etag) } });
    expect(r.statusCode).toBe(304);
    expect(r.body).toBe('');
  });

  it('HEAD de la raíz responde sin cuerpo', async () => {
    const r = await app.inject({ method: 'HEAD', url: '/' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('');
  });

  it('las rutas de la SPA devuelven index.html sin caché', async () => {
    for (const url of ['/projects/abc', '/login?x=1', '/settings', '/assets/no-existe.js']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(200);
      expect(r.body, url).toBe(INDEX);
      expect(r.headers['cache-control'], url).toBe('no-cache, no-store, must-revalidate');
    }
  });

  it('lo que no existe bajo /api o con otro método es un 404 en JSON', async () => {
    for (const [method, url] of [['GET', '/api/no-existe'], ['POST', '/api/no-existe'], ['POST', '/projects/abc'], ['DELETE', '/']] as const) {
      const r = await app.inject({ method, url });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
      expect(r.json(), `${method} ${url}`).toEqual({ error: 'No encontrado' });
    }
  });
});

describe('recorridos de ruta (peticiones crudas)', () => {
  const rutas = [
    '/../secreto.txt',
    '/assets/../../secreto.txt',
    '/%2e%2e/secreto.txt',
    '/%2E%2E/secreto.txt',
    '/..%2fsecreto.txt',
    '/assets/..%2f..%2fsecreto.txt',
    '/%2e%2e%2fsecreto.txt',
    '/..\\secreto.txt',
    '/%5c..%5csecreto.txt',
    '//../secreto.txt',
    '/assets/%2e%2e/%2e%2e/secreto.txt',
    `/${'../'.repeat(12)}etc/passwd`,
  ];

  it.each(rutas)('%s no sale de la carpeta de la web', async (ruta) => {
    const r = await cruda(ruta);
    expect(r.body).not.toContain(MARCA);
    expect(r.body).not.toMatch(/root:.*:0:0:/);
    expect([200, 400, 403, 404]).toContain(r.status);
    // Si responde 200 es la SPA, nunca otro fichero.
    if (r.status === 200) expect(r.body).toBe(INDEX);
  });

  it('una ruta no canónica no sirve ficheros: la rechaza @fastify/static 10', async () => {
    for (const ruta of ['//assets/app-abc123.js', '/./index.html', '/assets/../index.html', '/assets/./app-abc123.js']) {
      const r = await cruda(ruta);
      expect(r.status, ruta).toBe(403);
      expect(JSON.parse(r.body), ruta).toEqual({ error: 'Forbidden' });
    }
  });
});
