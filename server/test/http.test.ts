import crypto from 'crypto';
import type net from 'net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { signToken } from '../src/auth';
import { closeDb, createProject, createUser, initDb, setSetting } from '../src/db';
import { closeAllSse } from '../src/sse';
import { hashPassword } from '../src/util';

/**
 * Comportamiento HTTP que un cambio de versión de Fastify o de sus plugins
 * puede alterar sin que falle nada más: cookies, límites y análisis de cuerpos,
 * cuerpo crudo de los webhooks, redirecciones y streams SSE.
 */

const SO = { 'sec-fetch-site': 'same-origin' };

let app: FastifyInstance;
let cookie = '';
let adminId = '';

beforeAll(async () => {
  initDb();
  const admin = createUser('admin@example.com', hashPassword('contraseña1'), 'admin');
  adminId = admin.id;
  cookie = `skyway_token=${signToken(admin.id)}`;
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeDb();
});

describe('cookie de sesión', () => {
  it('el login la emite con los mismos atributos', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@example.com', password: 'contraseña1' } });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['set-cookie'])).toMatch(/^skyway_token=[^;]+; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax$/);
  });

  it('cerrar sesión la borra en la misma ruta', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, ...SO } });
    expect(r.statusCode).toBe(200);
    const borrado = String(r.headers['set-cookie']);
    expect(borrado).toMatch(/^skyway_token=;/);
    expect(borrado).toContain('Path=/');
    expect(borrado).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  });

  it('se lee entre otras cookies', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `tema=oscuro; ${cookie}; otra=1` } });
    expect(r.json().user.id).toBe(adminId);
  });

  it('con dos cookies de sesión cuenta la primera, como antes', async () => {
    // El navegador envía primero la de ruta más específica: una cookie inyectada
    // desde un subdominio con `Path=/api` no puede colarse detrás de la buena.
    const r = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `skyway_token=no-vale; ${cookie}` } });
    expect(r.json().user).toBeNull();
    const r2 = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `${cookie}; skyway_token=no-vale` } });
    expect(r2.json().user.id).toBe(adminId);
  });
});

describe('cuerpos de las peticiones', () => {
  it('un JSON de más de 1 MB responde 413', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: JSON.stringify({ email: 'x'.repeat(1100 * 1024), password: 'x' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(413);
    expect(typeof r.json().error).toBe('string');
  });

  it('un JSON mal formado responde 400 con { error }', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: '{', headers: { 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(400);
    expect(typeof r.json().error).toBe('string');
  });

  it('un tipo de contenido que no se admite responde 415', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: 'hola', headers: { 'content-type': 'application/x-cosa' } });
    expect(r.statusCode).toBe(415);
  });

  it('un DELETE sin cuerpo con Content-Type JSON se atiende como antes', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/api/auth/passkeys/no-existe', headers: { cookie, ...SO, 'content-type': 'application/json' } });
    expect(r.statusCode, r.body).toBe(404);
    expect(r.json()).toEqual({ error: 'Passkey no encontrada' });
    // Con cuerpo, como siempre, se analiza.
    const conCuerpo = await app.inject({ method: 'DELETE', url: '/api/auth/passkeys/no-existe', headers: { cookie, ...SO }, payload: {} });
    expect(conCuerpo.statusCode).toBe(404);
    const roto = await app.inject({
      method: 'DELETE',
      url: '/api/auth/passkeys/no-existe',
      headers: { cookie, ...SO, 'content-type': 'application/json', 'content-length': '1' },
      payload: '{',
    });
    expect(roto.statusCode).toBe(400);
  });

  it('la subida de archivos admite más de 1 MB y corta pasados 100 MB', async () => {
    const subir = (bytes: number) =>
      app.inject({
        method: 'POST',
        url: '/api/services/no-existe/files/upload?path=/&name=a.bin',
        payload: Buffer.alloc(bytes, 1),
        headers: { cookie, ...SO, 'content-type': 'application/octet-stream' },
      });
    // Llega a la ruta (que no encuentra el servicio): el límite global de 1 MB no se aplica aquí.
    expect((await subir(2 * 1024 * 1024)).statusCode).toBe(404);
    expect((await subir(100 * 1024 * 1024 + 1)).statusCode).toBe(413);
  });
});

describe('gateway de IA', () => {
  it('una clave inválida se rechaza antes de leer el cuerpo, sea del tamaño que sea', async () => {
    // La autenticación va en onRequest: un cuerpo de 9 MB (más que su límite de
    // 8 MB) sin clave válida recibe 401, no 413, y no se llega a bufferizar.
    const r = await app.inject({
      method: 'POST',
      url: '/gw/v1beta/openai/chat/completions',
      payload: Buffer.alloc(9 * 1024 * 1024, 0x20),
      headers: { 'content-type': 'application/json', authorization: 'Bearer no-vale' },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: { code: 401, message: 'Clave de API no válida.' } });
  });
});

describe('webhook de la GitHub App (firma sobre el cuerpo crudo)', () => {
  const SECRETO = 'secreto-del-webhook';
  const ping = '{"zen":"Keep it logically awesome.",  "hook_id": 1}';
  const firma = (cuerpo: string) => `sha256=${crypto.createHmac('sha256', SECRETO).update(cuerpo).digest('hex')}`;
  const enviar = (cuerpo: string, firmaHeader: string, contentType = 'application/json') =>
    app.inject({
      method: 'POST',
      url: '/api/webhooks/github/app',
      payload: cuerpo,
      headers: { 'content-type': contentType, 'x-hub-signature-256': firmaHeader, 'x-github-event': 'ping' },
    });

  beforeAll(() => {
    setSetting('githubAppId', '1');
    setSetting('githubAppSlug', 'skyway-pruebas');
    setSetting('githubAppPrivateKey', 'no-se-usa');
    setSetting('githubAppWebhookSecret', SECRETO);
  });

  it('con la firma del cuerpo tal cual llegó, se acepta', async () => {
    const r = await enviar(ping, firma(ping));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ ok: true, pong: true });
    expect((await enviar(ping, firma(ping), 'application/json; charset=utf-8')).statusCode).toBe(200);
  });

  it('se firma el cuerpo crudo, no el JSON vuelto a serializar', async () => {
    const r = await enviar(ping, firma(JSON.stringify(JSON.parse(ping))));
    expect(r.statusCode).toBe(401);
  });

  it('sin firma o con otra, 401', async () => {
    expect((await enviar(ping, 'sha256=00')).statusCode).toBe(401);
    expect((await enviar(ping, '')).statusCode).toBe(401);
  });
});

describe('redirecciones', () => {
  it('la vuelta de GitHub con un estado inválido redirige al panel con 302', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/github/app/setup?state=malo&code=x', headers: { cookie } });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/settings?github=estado_invalido#github');
  });
});

describe('rutas', () => {
  it('el punto y coma ya no separa la query: /api/health;x no es /api/health', async () => {
    // Fastify 5 dejó de tratar `;` como separador (useSemicolonDelimiter) y se
    // mantiene así: ningún cliente de Skyway lo usa y evita que el panel y un
    // proxy interpreten distinto la misma ruta.
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    const r = await app.inject({ method: 'GET', url: '/api/health;x' });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'No encontrado' });
  });
});

describe('stream SSE sobre una conexión real', () => {
  let servidor: FastifyInstance;
  let base = '';
  let proyectoId = '';

  beforeAll(async () => {
    proyectoId = createProject('Demo SSE', 'demo-sse').id;
    servidor = buildApp();
    await servidor.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(servidor.server.address() as net.AddressInfo).port}`;
  });

  afterAll(async () => {
    closeAllSse();
    await servidor.close();
  });

  async function leerHasta(reader: ReadableStreamDefaultReader<Uint8Array>, texto: string): Promise<string> {
    let leido = '';
    const limite = Date.now() + 5000;
    while (!leido.includes(texto) && Date.now() < limite) {
      const { value, done } = await reader.read();
      if (done) break;
      leido += Buffer.from(value).toString('utf8');
    }
    return leido;
  }

  it('abre el stream con sus cabeceras y envía el estado inicial', async () => {
    const corte = new AbortController();
    const r = await fetch(`${base}/api/projects/${proyectoId}/deploys/stream`, { headers: { cookie }, signal: corte.signal });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    expect(r.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(r.headers.get('x-accel-buffering')).toBe('no');
    const leido = await leerHasta(r.body!.getReader(), 'event: snapshot');
    expect(leido).toBe(':ok\n\nevent: snapshot\ndata: {"deploys":[]}\n\n');
    corte.abort();
  });

  it('sin sesión no se abre', async () => {
    const r = await fetch(`${base}/api/projects/${proyectoId}/deploys/stream`);
    expect(r.status).toBe(401);
  });

  it('el apagado ordenado cierra los streams abiertos', async () => {
    const r = await fetch(`${base}/api/projects/${proyectoId}/deploys/stream`, { headers: { cookie } });
    const reader = r.body!.getReader();
    await leerHasta(reader, 'event: snapshot');
    closeAllSse();
    let terminado = false;
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
      terminado = true;
    } catch {
      terminado = true;
    }
    expect(terminado).toBe(true);
  });
});
