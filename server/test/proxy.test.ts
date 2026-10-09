import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { signToken } from '../src/auth';
import { config, parseTrustProxy } from '../src/config';
import { closeDb, createUser, initDb, listAudit } from '../src/db';
import { hashPassword } from '../src/util';

/**
 * IP, protocolo y host del cliente según `TRUST_PROXY`: de ellos dependen el
 * límite de intentos de login, la auditoría, la cookie `Secure`, HSTS, la guarda
 * CSRF y las URLs públicas del panel. Se prueban a través de esas funciones,
 * no de las propiedades de Fastify, que cambiaron de nombre entre versiones.
 */

const MAL = { email: 'admin@example.com', password: 'incorrecta' };
const BIEN = { email: 'admin@example.com', password: 'contraseña1' };

let app: FastifyInstance;
let cookie = '';

beforeAll(async () => {
  initDb();
  const admin = createUser('admin@example.com', hashPassword('contraseña1'), 'admin');
  cookie = `skyway_token=${signToken(admin.id)}`;
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeDb();
});

/** Intento de login fallido; devuelve el código y la IP con la que quedó auditado. */
async function loginFallido(
  destino: FastifyInstance,
  opts: { xff?: string; remoteAddress?: string },
): Promise<{ status: number; ip: string | null }> {
  const r = await destino.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: MAL,
    headers: opts.xff ? { 'x-forwarded-for': opts.xff } : {},
    remoteAddress: opts.remoteAddress,
  });
  return { status: r.statusCode, ip: listAudit({ action: 'login_failed', limit: 1 })[0]?.ip ?? null };
}

async function urlPublica(headers: Record<string, string>, remoteAddress?: string): Promise<string> {
  const r = await app.inject({ method: 'GET', url: '/api/github/app', headers: { cookie, ...headers }, remoteAddress });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().webhookUrl;
}

describe('IP del cliente con TRUST_PROXY por defecto (rangos privados y loopback)', () => {
  it('detrás de Traefik o de un túnel local, la IP es la de X-Forwarded-For', async () => {
    expect(await loginFallido(app, { xff: '203.0.113.7' })).toEqual({ status: 401, ip: '203.0.113.7' });
    // Traefik en la red de Docker (172.16.0.0/12).
    expect(await loginFallido(app, { xff: '203.0.113.8', remoteAddress: '172.18.0.3' })).toEqual({ status: 401, ip: '203.0.113.8' });
  });

  it('una cadena de proxies se recorre solo mientras sean de confianza', async () => {
    expect((await loginFallido(app, { xff: '198.51.100.20, 10.0.0.2' })).ip).toBe('198.51.100.20');
    // Un salto público en medio es el cliente: lo que diga a su izquierda no cuenta.
    expect((await loginFallido(app, { xff: '198.51.100.21, 203.0.113.50' })).ip).toBe('203.0.113.50');
  });

  it('un cliente de internet no puede falsear su IP con X-Forwarded-For', async () => {
    expect((await loginFallido(app, { xff: '10.0.0.1', remoteAddress: '198.51.100.9' })).ip).toBe('198.51.100.9');
  });

  it('el límite de login cuenta por IP real', async () => {
    for (let i = 0; i < 8; i++) expect((await loginFallido(app, { xff: '203.0.113.70' })).status).toBe(401);
    expect((await loginFallido(app, { xff: '203.0.113.70' })).status).toBe(429);
    // Otro cliente detrás del mismo proxy no hereda el bloqueo.
    expect((await loginFallido(app, { xff: '203.0.113.71' })).status).toBe(401);
    // Y rotar X-Forwarded-For desde internet no lo evita.
    for (let i = 1; i <= 8; i++) {
      expect((await loginFallido(app, { xff: `192.0.2.${i}`, remoteAddress: '198.51.100.90' })).status).toBe(401);
    }
    expect((await loginFallido(app, { xff: '192.0.2.99', remoteAddress: '198.51.100.90' })).status).toBe(429);
  });
});

describe('protocolo y host detrás de un proxy', () => {
  it('con HTTPS en un proxy de confianza, la cookie es Secure y se envía HSTS', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: BIEN, headers: { 'x-forwarded-proto': 'https' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(String(r.headers['set-cookie'])).toMatch(/^skyway_token=[^;]+; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    expect(r.headers['strict-transport-security']).toBe('max-age=15552000; includeSubDomains');
  });

  it('sin proxy por HTTP (túnel SSH), ni Secure ni HSTS', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: BIEN });
    expect(String(r.headers['set-cookie'])).toMatch(/^skyway_token=[^;]+; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax$/);
    expect(r.headers['strict-transport-security']).toBeUndefined();
  });

  it('X-Forwarded-Proto de un cliente de internet no cuenta', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: BIEN,
      headers: { 'x-forwarded-proto': 'https' },
      remoteAddress: '198.51.100.30',
    });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['set-cookie'])).not.toMatch(/Secure/);
    expect(r.headers['strict-transport-security']).toBeUndefined();
  });

  it('la URL pública del panel conserva el puerto del Host', async () => {
    expect(await urlPublica({ host: 'localhost:4000' })).toBe('http://localhost:4000/api/webhooks/github/app');
  });

  it('con X-Forwarded-Host y -Proto de un proxy de confianza, es la URL del navegador', async () => {
    const headers = { host: 'skyway:4000', 'x-forwarded-host': 'panel.example.com:8443', 'x-forwarded-proto': 'https' };
    expect(await urlPublica(headers)).toBe('https://panel.example.com:8443/api/webhooks/github/app');
  });

  it('un cliente de internet no puede cambiarla con X-Forwarded-Host', async () => {
    const headers = { host: 'skyway:4000', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' };
    expect(await urlPublica(headers, '198.51.100.31')).toBe('http://skyway:4000/api/webhooks/github/app');
  });
});

describe('guarda CSRF detrás de un proxy', () => {
  const leerAvisos = (headers: Record<string, string>, remoteAddress?: string) =>
    app.inject({ method: 'POST', url: '/api/alerts/read-all', headers: { cookie, ...headers }, remoteAddress });

  it('panel en un puerto propio: Origin con puerto igual al Host', async () => {
    expect((await leerAvisos({ host: 'localhost:4000', origin: 'http://localhost:4000' })).statusCode).toBe(200);
    expect((await leerAvisos({ host: 'localhost:4000', origin: 'http://localhost:4001' })).statusCode).toBe(403);
  });

  it('Origin igual al X-Forwarded-Host (con puerto) del proxy de confianza', async () => {
    const headers = { host: 'skyway:4000', 'x-forwarded-host': 'panel.example.com:8443', origin: 'https://panel.example.com:8443' };
    expect((await leerAvisos(headers)).statusCode).toBe(200);
  });

  it('el X-Forwarded-Host de un cliente de internet no vale para pasar la guarda', async () => {
    const headers = { host: 'skyway:4000', 'x-forwarded-host': 'evil.example', origin: 'https://evil.example' };
    expect((await leerAvisos(headers, '198.51.100.32')).statusCode).toBe(403);
  });
});

describe('TRUST_PROXY', () => {
  it('sin valor: rangos privados y loopback', () => {
    expect(parseTrustProxy(undefined)).toEqual(['loopback', 'linklocal', 'uniquelocal']);
    expect(parseTrustProxy('  ')).toEqual(['loopback', 'linklocal', 'uniquelocal']);
  });

  it('true, false y listas de CIDR', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('10.0.0.0/8, 192.168.1.1')).toEqual(['10.0.0.0/8', '192.168.1.1']);
  });

  it('un número de saltos se convierte en la función de siempre (0 es no confiar)', () => {
    expect(parseTrustProxy('0')).toBe(false);
    const dos = parseTrustProxy('2') as (address: string, hop: number) => boolean;
    expect(typeof dos).toBe('function');
    expect([0, 1, 2].map((hop) => dos('203.0.113.1', hop))).toEqual([true, true, false]);
  });

  it('con un número de saltos la IP sigue saliendo de X-Forwarded-For', async () => {
    const original = config.trustProxy;
    const apps: FastifyInstance[] = [];
    try {
      const conSaltos = async (valor: string): Promise<FastifyInstance> => {
        config.trustProxy = parseTrustProxy(valor);
        const a = buildApp();
        apps.push(a);
        await a.ready();
        return a;
      };
      // Un salto: el proxy inmediato (sea cual sea su dirección) y el cliente es el último de la lista.
      const uno = await conSaltos('1');
      expect((await loginFallido(uno, { xff: '198.51.100.1, 203.0.113.9', remoteAddress: '198.51.100.200' })).ip).toBe('203.0.113.9');
      const dos = await conSaltos('2');
      expect((await loginFallido(dos, { xff: '198.51.100.1, 203.0.113.9', remoteAddress: '198.51.100.200' })).ip).toBe('198.51.100.1');
      const ninguno = await conSaltos('0');
      expect((await loginFallido(ninguno, { xff: '198.51.100.1', remoteAddress: '198.51.100.201' })).ip).toBe('198.51.100.201');
    } finally {
      config.trustProxy = original;
      for (const a of apps) await a.close();
    }
  });
});
