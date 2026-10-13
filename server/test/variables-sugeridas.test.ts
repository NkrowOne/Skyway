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
  it('quita lo ya definido, lo que pone Skyway y lo que proponen el correo o el manifiesto', async () => {
    const p = createProject('Bot', 'bot');
    const pending = ['DISCORD_TOKEN', 'API_SECRET', 'SENTRY_DSN', 'PUBLIC_URL', 'PORT', 'SMTP_HOST', 'STRIPE_KEY'];
    const s = createService(p.id, 'bot', 'bot', 'git', {
      repoUrl: 'https://github.com/acme/bot',
      branch: 'main',
      port: 3000,
      domains: [],
      webhookSecret: 'x',
      needs: {
        engines: [],
        expectedVars: [],
        envFile: '.env.example',
        sources: ['.env.example'],
        mail: { mode: 'smtp', vars: [{ name: 'SMTP_HOST', role: 'host' }], evidence: ['nodemailer'] },
        manifest: { version: 1, env: { STRIPE_KEY: { secret: true } } },
      },
      envImport: {
        files: ['.env.example'],
        imported: [],
        pending: pending.map((key) => ({ key, file: '.env.example' })),
        skipped: [],
        at: Date.now(),
        applied: false,
        handled: pending,
        source: 'deploy',
      },
    } as any);
    // Una propia del servicio y otra compartida del proyecto, añadidas después del despliegue.
    setEnv(s.id, { API_SECRET: 'x' });
    setProjectVars(p.id, { SENTRY_DSN: 'https://sentry.example' });

    const r = await app.inject({ method: 'GET', url: `/api/services/${s.id}/env`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json().repoPending).toEqual([{ key: 'DISCORD_TOKEN', file: '.env.example' }]);
  });

  it('un servicio que no es de repositorio no tiene pendientes', async () => {
    const p = createProject('Datos', 'datos');
    const s = createService(p.id, 'cache', 'cache', 'database', { template: 'redis' } as any);
    const r = await app.inject({ method: 'GET', url: `/api/services/${s.id}/env`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json().repoPending).toEqual([]);
  });
});
