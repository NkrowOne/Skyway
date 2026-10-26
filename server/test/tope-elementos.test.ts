import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROXY_KEY_PREFIX } from '../src/aigateway';
import { buildApp } from '../src/app';
import { API_TOKEN_PREFIX, hashApiToken } from '../src/auth';
import { closeDb, createUser, createWorkspaceApiKey, createWorkspaceRow, initDb, insertApiToken } from '../src/db';
import { superaTopeElementos, TOPE_ELEMENTOS_CUERPO } from '../src/topecuerpo';
import { hashPassword, randomToken } from '../src/util';

/**
 * Tope de elementos del cuerpo (aviso GHSA-mrhx-c7xc-m3w5 de zod 3): una lista
 * enorme se rechaza antes de que zod la recorra elemento a elemento, y las
 * rutas que no validan con zod (gateway de IA, webhooks, subida de archivos)
 * no se ven afectadas.
 */

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

let app: FastifyInstance;
let headers: Record<string, string>;
let claveGateway = '';

/** Lista de `n` ceros como texto JSON, sin construir el array en memoria dos veces. */
const ceros = (n: number): string => `[${new Array(n).fill('0').join(',')}]`;

async function post(url: string, payload: string, extra: Record<string, string> = headers): Promise<{ status: number; json: Json }> {
  const r = await app.inject({ method: 'POST', url, payload, headers: { ...extra, 'content-type': 'application/json' } });
  let json: Json = null;
  try {
    json = r.json();
  } catch {
    /* sin cuerpo JSON */
  }
  return { status: r.statusCode, json };
}

beforeAll(async () => {
  initDb();
  const admin = createUser('admin@test.local', hashPassword('secreto123'), 'admin');
  const secret = `${API_TOKEN_PREFIX}${randomToken(24)}`;
  insertApiToken({ user_id: admin.id, name: 'pruebas', token_hash: hashApiToken(secret), prefix: secret.slice(0, 12), expires_at: null });
  headers = { authorization: `Bearer ${secret}` };

  const ws = createWorkspaceRow('Cuenta del gateway');
  claveGateway = `${PROXY_KEY_PREFIX}${randomToken(24)}`;
  createWorkspaceApiKey({ workspace_id: ws.id, name: 'pruebas', key_hash: hashApiToken(claveGateway), prefix: claveGateway.slice(0, 13) });

  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeDb();
});

describe('superaTopeElementos', () => {
  it('un cuerpo normal no lo supera', () => {
    expect(superaTopeElementos({ email: 'a@b.es', projectIds: ['p1', 'p2'], config: { domains: ['a.es'], env: { A: '1' } } })).toBe(false);
    expect(superaTopeElementos({})).toBe(false);
    expect(superaTopeElementos([])).toBe(false);
  });

  it('cuenta elementos de lista y claves de objeto de todo el cuerpo', () => {
    expect(superaTopeElementos(new Array(TOPE_ELEMENTOS_CUERPO).fill(0))).toBe(false);
    expect(superaTopeElementos(new Array(TOPE_ELEMENTOS_CUERPO + 1).fill(0))).toBe(true);
    // Dos listas por debajo del tope que juntas lo pasan (más las dos claves).
    const mitad = TOPE_ELEMENTOS_CUERPO / 2;
    expect(superaTopeElementos({ a: new Array(mitad).fill(0), b: new Array(mitad).fill(0) })).toBe(true);
    expect(superaTopeElementos({ a: new Array(mitad - 1).fill(0), b: new Array(mitad - 1).fill(0) })).toBe(false);
    // Claves de un objeto, también sin prototipo.
    const claves: Record<string, number> = Object.create(null);
    for (let i = 0; i <= TOPE_ELEMENTOS_CUERPO; i++) claves[`k${i}`] = i;
    expect(superaTopeElementos(claves)).toBe(true);
    expect(superaTopeElementos([{ a: 1, b: 2 }], 2)).toBe(true);
    expect(superaTopeElementos([{ a: 1 }], 2)).toBe(false);
  });

  it('un anidamiento muy profundo no desborda la pila', () => {
    let profundo: unknown = [];
    for (let i = 0; i < 100_000; i++) profundo = [profundo];
    expect(() => superaTopeElementos(profundo)).not.toThrow();
    expect(superaTopeElementos(profundo)).toBe(true);

    let porDebajo: unknown = {};
    for (let i = 0; i < TOPE_ELEMENTOS_CUERPO - 1; i++) porDebajo = { x: porDebajo };
    expect(superaTopeElementos(porDebajo)).toBe(false);
  });

  it('no recorre textos, Buffers ni otros objetos', () => {
    expect(superaTopeElementos('x'.repeat(1024 * 1024))).toBe(false);
    expect(superaTopeElementos(Buffer.alloc(1024 * 1024))).toBe(false);
    expect(superaTopeElementos({ contenido: Buffer.alloc(1024 * 1024) })).toBe(false);
    expect(superaTopeElementos(new Uint8Array(1024 * 1024))).toBe(false);
    expect(superaTopeElementos(new Map(new Array(TOPE_ELEMENTOS_CUERPO + 1).fill(0).map((_, i) => [i, i])))).toBe(false);
    expect(superaTopeElementos(undefined)).toBe(false);
    expect(superaTopeElementos(null)).toBe(false);
    expect(superaTopeElementos(42)).toBe(false);
  });
});

describe('tope de elementos en las rutas', () => {
  it('una lista por encima del tope responde 400 demasiados_elementos sin llegar a zod', async () => {
    const r = await post('/api/users', `{"email":"a@b.es","password":"contraseña1","role":"member","projectIds":${ceros(TOPE_ELEMENTOS_CUERPO + 1)}}`);
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: 'La petición incluye demasiados elementos.', code: 'demasiados_elementos' });
  });

  it('medio millón de ceros (~1 MB) se rechaza con una respuesta corta', async () => {
    // Sin el tope, zod creaba medio millón de issues (unos 200 MB y más de
    // medio segundo) y el manejador de errores los unía en una respuesta de 17 MB.
    const r = await app.inject({
      method: 'POST',
      url: '/api/users',
      payload: `{"email":"a@b.es","password":"contraseña1","projectIds":${ceros(500_000)}}`,
      headers: { ...headers, 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('demasiados_elementos');
    expect(r.body.length).toBeLessThan(200);
  });

  it('también en rutas de plugins anidados y en las públicas', async () => {
    const importar = await post('/api/import/railway/run', `{"token":"xxxxxxxxxxxx","projectId":"p","environmentId":"e","dnsDomains":${ceros(TOPE_ELEMENTOS_CUERPO + 1)}}`);
    expect(importar.status).toBe(400);
    expect(importar.json.code).toBe('demasiados_elementos');
    // El login no exige sesión y valida con zod: el tope va antes.
    const login = await post('/api/auth/login', `{"email":${ceros(TOPE_ELEMENTOS_CUERPO + 1)},"password":"x"}`, {});
    expect(login.status).toBe(400);
    expect(login.json.code).toBe('demasiados_elementos');
  });

  it('justo en el tope, o con un cuerpo normal, la petición sigue su curso', async () => {
    // 4 claves + 19 996 elementos = 20 000: llega a la ruta, que no conoce el proyecto.
    const ids = JSON.stringify(new Array(TOPE_ELEMENTOS_CUERPO - 4).fill('no-existe'));
    const enTope = await post('/api/users', `{"email":"b@b.es","password":"contraseña1","role":"member","projectIds":${ids}}`);
    expect(enTope.status).toBe(400);
    expect(enTope.json).toEqual({ error: 'Proyecto desconocido: no-existe' });

    const normal = await post('/api/users', JSON.stringify({ email: 'c@b.es', password: 'contraseña1', role: 'admin', projectIds: [] }));
    expect(normal.status, JSON.stringify(normal.json)).toBe(201);
  });

  it('el gateway de IA admite un cuerpo con más elementos que el tope', async () => {
    // Una conversación de 30 000 mensajes (90 000 elementos, ~1 MB) llega al
    // proxy, que responde por el modelo: el tope no se aplica.
    const mensajes = new Array(30_000).fill({ role: 'user', content: 'x' });
    const r = await post('/gw/v1beta/openai/chat/completions', JSON.stringify({ model: 'modelo-de-prueba', messages: mensajes }), {
      authorization: `Bearer ${claveGateway}`,
    });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: { code: 403, message: 'Modelo no permitido para esta clave: modelo-de-prueba.' } });
  });

  it('los webhooks admiten un push con más archivos que el tope', async () => {
    const push = `{"ref":"refs/heads/main","commits":[{"id":"abc","added":${JSON.stringify(new Array(TOPE_ELEMENTOS_CUERPO + 1).fill('a.txt'))}}]}`;
    const r = await post('/api/webhooks/github/no-existe', push, { 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=00' });
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: 'Servicio no encontrado' });
  });

  it('la subida de archivos recibe el contenido sin analizarlo', async () => {
    // El texto de una lista enorme como archivo binario: llega a la ruta (que
    // no encuentra el servicio) en lugar de responder demasiados_elementos.
    const r = await app.inject({
      method: 'POST',
      url: '/api/services/no-existe/files/upload?path=/&name=lista.json',
      payload: Buffer.from(ceros(500_000)),
      headers: { ...headers, 'content-type': 'application/octet-stream' },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'Servicio no encontrado' });
  });
});
