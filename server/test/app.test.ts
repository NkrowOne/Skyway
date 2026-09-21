import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { closeDb, createProject, initDb } from '../src/db';

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

let app: FastifyInstance;
// Estado que se encadena entre bloques: la cookie de sesión vigente va
// cambiando (login → cambio de contraseña → reset propio) y los bloques
// posteriores usan la última.
let cookie = '';

beforeAll(async () => {
  initDb();
  app = buildApp();
  // Rutas de prueba para el manejador de errores: se registran antes de `ready()`.
  app.get('/api/_boom_type', async () => {
    const x = undefined as unknown as { y: { z: number } };
    return x.y.z;
  });
  app.get('/api/_boom_plain', async () => {
    throw new Error('Mensaje pensado para el usuario');
  });
  app.get('/api/_boom_sqlite', async () => {
    createProject('dup', 'dup');
    createProject('dup', 'dup');
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeDb();
});

describe('cabeceras', () => {
  it('health responde con no-store y X-Frame-Options DENY', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.headers['cache-control']).toBe('no-store');
    expect(health.headers['x-frame-options']).toBe('DENY');
  });
});

describe('setup y login', () => {
  it('el setup solo funciona una vez', async () => {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { email: 'Admin@Example.com', password: 'contraseña1' },
      headers: SAME_ORIGIN,
    });
    expect(setup.statusCode, setup.body).toBe(200);
    const setup2 = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { email: 'b@b.com', password: 'contraseña1' },
    });
    expect(setup2.statusCode).toBe(403);
  });

  it('un login fallido responde igual exista o no el usuario', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.com', password: 'incorrecta' },
    });
    expect(bad.statusCode).toBe(401);
    const nouser = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nadie@example.com', password: 'incorrecta' },
    });
    expect(nouser.statusCode).toBe(401);
    expect(nouser.body).toBe(bad.body);
  });

  it('el login correcto deja una cookie HttpOnly SameSite=Lax y /me la reconoce', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.com', password: 'contraseña1' },
    });
    expect(login.statusCode, login.body).toBe(200);
    const setCookie = String(login.headers['set-cookie']);
    cookie = setCookie.split(';')[0];
    expect(cookie.startsWith('skyway_token=')).toBe(true);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(JSON.parse(me.body).user.email).toBe('admin@example.com');
  });
});

describe('guarda CSRF', () => {
  const casos: [string, Record<string, string>, number][] = [
    ['same-origin', { 'sec-fetch-site': 'same-origin' }, 200],
    ['none', { 'sec-fetch-site': 'none' }, 200],
    ['same-site (subdominio)', { 'sec-fetch-site': 'same-site', origin: 'http://localhost:80' }, 403],
    ['cross-site', { 'sec-fetch-site': 'cross-site' }, 403],
    ['Origin coincide con Host', { origin: 'http://localhost:80' }, 200],
    ['Origin sin puerto por defecto y en mayúsculas', { origin: 'http://LOCALHOST' }, 200],
    ['Origin https contra Host :80 (otro puerto)', { origin: 'https://localhost' }, 403],
    ['Origin ajeno', { origin: 'http://evil.example' }, 403],
    ['Origin null', { origin: 'null' }, 403],
    ['sin Origin ni Sec-Fetch-Site', {}, 200],
  ];

  it.each(casos)('POST con cookie y %s', async (_label, headers, expected) => {
    const r = await app.inject({ method: 'POST', url: '/api/alerts/read-all', headers: { cookie, ...headers } });
    expect(r.statusCode, r.body).toBe(expected);
  });

  it('sin cookie (webhook) con Origin ajeno no se aplica la guarda', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/alerts/read-all', headers: { origin: 'http://evil.example' } });
    expect(r.statusCode).toBe(401);
  });

  it('un GET nunca se bloquea', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/alerts', headers: { cookie, origin: 'http://evil.example' } });
    expect(r.statusCode).toBe(200);
  });
});

describe('tokens de API', () => {
  it('crear exige sesión; usarlo con Bearer se salta la guarda de origen', async () => {
    const tok = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie, ...SAME_ORIGIN },
      payload: { name: 'agente' },
    });
    expect(tok.statusCode, tok.body).toBe(201);
    const token = JSON.parse(tok.body).token as string;

    const viaToken = await app.inject({
      method: 'POST',
      url: '/api/alerts/read-all',
      headers: { authorization: `Bearer ${token}`, origin: 'http://evil.example' },
    });
    expect(viaToken.statusCode, viaToken.body).toBe(200);

    const tokCreateViaToken = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'x' },
    });
    expect(tokCreateViaToken.statusCode).toBe(403);
  });
});

describe('cambio de contraseña y usuarios', () => {
  it('cambiar la contraseña renueva la cookie e invalida la anterior (epoch)', async () => {
    const chg = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie, ...SAME_ORIGIN },
      payload: { current: 'contraseña1', next: 'contraseña2' },
    });
    expect(chg.statusCode, chg.body).toBe(200);

    const meOld = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(JSON.parse(meOld.body).user).toBeNull();

    cookie = String(chg.headers['set-cookie']).split(';')[0];
    const meNew = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(JSON.parse(meNew.body).user.email).toBe('admin@example.com');
  });

  it('el admin que se cambia su propia contraseña por /api/users/:id recibe cookie renovada', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    const myId = JSON.parse(me.body).user.id as string;
    const selfReset = await app.inject({
      method: 'PATCH',
      url: `/api/users/${myId}`,
      headers: { cookie, ...SAME_ORIGIN },
      payload: { password: 'contraseña3' },
    });
    expect(selfReset.statusCode, selfReset.body).toBe(200);
    const setCookie = String(selfReset.headers['set-cookie'] ?? '');
    expect(setCookie.startsWith('skyway_token=')).toBe(true);
    cookie = setCookie.split(';')[0];
  });

  it('crear un usuario con email duplicado (distinta capitalización) responde 409, no 500', async () => {
    const u1 = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie, ...SAME_ORIGIN },
      payload: { email: 'm@x.com', password: 'contraseña1', role: 'member' },
    });
    expect(u1.statusCode, u1.body).toBe(201);
    const u2 = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie, ...SAME_ORIGIN },
      payload: { email: 'M@x.com', password: 'contraseña1', role: 'member' },
    });
    expect(u2.statusCode, u2.body).toBe(409);
  });
});

describe('manejador de errores', () => {
  it('un TypeError interno se oculta como «Error interno»', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/_boom_type' });
    expect(r.statusCode).toBe(500);
    expect(JSON.parse(r.body).error).toBe('Error interno');
  });

  it('un Error de la app llega con su mensaje', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/_boom_plain' });
    expect(r.statusCode).toBe(500);
    expect(JSON.parse(r.body).error).toBe('Mensaje pensado para el usuario');
  });

  it('un error de SQLite se oculta como «Error interno»', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/_boom_sqlite' });
    expect(r.statusCode).toBe(500);
    expect(JSON.parse(r.body).error).toBe('Error interno');
  });

  it('un cuerpo que no pasa la validación responde 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'no-es-email', password: 'x' } });
    expect(r.statusCode).toBe(400);
  });
});

// Va el último: una vez bloqueada la IP ya no se puede iniciar sesión.
describe('bloqueo por IP', () => {
  it('tras 8 fallos de login la IP recibe 429 aunque la contraseña sea correcta', async () => {
    for (let i = 0; i < 8; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'admin@example.com', password: 'incorrecta' },
      });
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.com', password: 'contraseña3' },
    });
    expect(blocked.statusCode).toBe(429);
  });
});
