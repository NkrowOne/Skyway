/**
 * Variables sugeridas sin redundancias.
 *
 * Lo que el `.env` del repositorio deja sin valor se guarda al desplegar
 * (`envImport.pending`) y la pestaña Variables lo seguía proponiendo aunque
 * después existiera: como variable compartida del proyecto, porque la pone
 * Skyway sola (`PUBLIC_URL`, `PORT`) o porque ya la proponen el correo o el
 * plan del manifiesto. `GET /services/:id/env` devuelve en `repoPending` solo
 * lo que sigue sin cubrir.
 */
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { closeDb, createProject, createService, initDb, setEnv, setProjectVars } from '../src/db';

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

describe('GET /api/services/:id/env · repoPending', () => {
  const report = (keys: string[]) => ({
    files: ['.env.example'],
    imported: [],
    pending: keys.map((key) => ({ key, file: '.env.example' })),
    skipped: [],
    at: Date.now(),
    applied: false,
    handled: keys,
    source: 'deploy',
  });
  const git = (extra: Record<string, unknown>) => ({
    repoUrl: 'https://github.com/acme/bot',
    branch: 'main',
    port: 3000,
    webhookSecret: 'x',
    ...extra,
  });
  const repoPending = async (serviceId: string) => {
    const r = await app.inject({ method: 'GET', url: `/api/services/${serviceId}/env`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    return (r.json().repoPending as { key: string }[]).map((p) => p.key);
  };

  it('quita lo definido (propio o compartido), lo que pone Skyway y lo que propone el correo', async () => {
    const p = createProject('Web', 'web');
    const s = createService(p.id, 'web', 'web', 'git', {
      ...git({ domains: ['web.example.com'] }),
      needs: {
        engines: [],
        expectedVars: [],
        envFile: '.env.example',
        sources: ['.env.example'],
        mail: { mode: 'smtp', vars: [{ name: 'SMTP_HOST', role: 'host' }], evidence: ['nodemailer'] },
      },
      envImport: report([
        'DISCORD_TOKEN',
        'API_SECRET',
        'SENTRY_DSN',
        'PUBLIC_URL',
        'SMTP_HOST',
        'SKYWAY_SERVICE',
        'SKYWAY_CONNECT_URL',
        'HOST',
      ]),
    } as any);
    // Una propia del servicio y otra compartida del proyecto, añadidas después del despliegue.
    setEnv(s.id, { API_SECRET: 'x' });
    setProjectVars(p.id, { SENTRY_DSN: 'https://sentry.example' });
    // Las SKYWAY_* que pone Skyway no; las de la aplicación (Skyway webtools) sí. HOST no la pone Skyway.
    expect(await repoPending(s.id)).toEqual(['DISCORD_TOKEN', 'SKYWAY_CONNECT_URL', 'HOST']);
  });

  it('sin dominio no hay PUBLIC_URL de sistema: se sigue proponiendo', async () => {
    const p = createProject('Bot', 'bot');
    const s = createService(p.id, 'bot', 'bot', 'git', {
      ...git({ domains: [] }),
      envImport: report(['PUBLIC_URL', 'INTERNAL_HOST']),
    } as any);
    expect(await repoPending(s.id)).toEqual(['PUBLIC_URL']);
  });

  it('con un skyway.json válido, las de correo que no declara se proponen', async () => {
    const p = createProject('Tienda', 'tienda');
    const s = createService(p.id, 'tienda', 'tienda', 'git', {
      ...git({ domains: [] }),
      needs: {
        engines: [],
        expectedVars: [],
        envFile: '.env.example',
        sources: ['.env.example', 'skyway.json'],
        mail: { mode: 'smtp', vars: [{ name: 'SMTP_HOST', role: 'host' }], evidence: ['nodemailer'] },
        manifest: { version: 1, env: { STRIPE_KEY: { generate: { bytes: 32 } } } },
        manifestFile: 'skyway.json',
      },
      envImport: report(['STRIPE_KEY', 'SMTP_HOST']),
    } as any);
    expect(await repoPending(s.id)).toEqual(['SMTP_HOST']);
  });

  it('un servicio que no es de repositorio no tiene pendientes', async () => {
    const p = createProject('Datos', 'datos');
    const s = createService(p.id, 'cache', 'cache', 'database', { template: 'redis' } as any);
    expect(await repoPending(s.id)).toEqual([]);
  });
});
