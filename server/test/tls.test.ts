/**
 * TLS automático: el correo de Let's Encrypt del panel solo decide las
 * etiquetas; los certificados los pide Traefik con el correo de su `.env`. Con
 * el `.env` vacío, Traefik arrancaba con `noreply@example.com` (Let's Encrypt lo
 * rechaza): ningún certificado, y aun así cada dominio redirigía a HTTPS y el
 * panel decía que TLS estaba activo. Ahora TLS deja de contar si Traefik tiene
 * un correo que Let's Encrypt rechaza; vacío no (la cuenta se registra sin
 * contacto y se emiten certificados), y si no se puede saber, se confía en el
 * ajuste como antes.
 */
import fs from 'fs';
import path from 'path';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { closeDb, createProject, createService, initDb, setSetting } from '../src/db';
import { traefikLabels, traefikRouter } from '../src/docker/containers';
import { acmeEmailFromTraefik, classifyAcmeEmail, setTraefikAcmeStateForTests, tlsBlocked, tlsEnabled } from '../src/tls';
import { systemVars } from '../src/variables';

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

beforeEach(() => {
  setSetting('letsencryptEmail', 'ops@acme.es');
});

const traefik = (status: 'ok' | 'missing' | 'invalid' | 'unknown', email: string | null = null) =>
  setTraefikAcmeStateForTests({ status, email, checkedAt: Date.now() });

function servicioConDominio() {
  const p = createProject('Web', `web-${Math.random().toString(36).slice(2, 8)}`);
  const s = createService(p.id, 'app', 'app', 'git', {
    repoUrl: 'https://github.com/acme/web',
    branch: 'main',
    port: 3000,
    domains: ['app.acme.es'],
    webhookSecret: 'x',
  } as any);
  return { p, s };
}

describe('correo de Let\'s Encrypt de Traefik', () => {
  it('reconoce los correos que Let\'s Encrypt rechaza', () => {
    expect(classifyAcmeEmail('')).toBe('missing');
    expect(classifyAcmeEmail(null)).toBe('missing');
    expect(classifyAcmeEmail('noreply@example.com')).toBe('invalid');
    expect(classifyAcmeEmail('yo@sub.example.org')).toBe('invalid');
    expect(classifyAcmeEmail('yo@acme.localhost')).toBe('invalid');
    expect(classifyAcmeEmail('sin-arroba')).toBe('invalid');
    expect(classifyAcmeEmail('ops@acme.es')).toBe('ok');
  });

  it('lo lee de la línea de órdenes o del entorno de Traefik', () => {
    const args = ['--providers.docker=true', '--certificatesresolvers.le.acme.email=ops@acme.es'];
    expect(acmeEmailFromTraefik(args, [])).toBe('ops@acme.es');
    expect(acmeEmailFromTraefik(['--certificatesResolvers.le.acme.email='], [])).toBe('');
    expect(acmeEmailFromTraefik([], ['TRAEFIK_CERTIFICATESRESOLVERS_LE_ACME_EMAIL=yo@acme.es'])).toBe('yo@acme.es');
    expect(acmeEmailFromTraefik(['--entrypoints.web.address=:80'], [])).toBeUndefined();
  });

  it('el docker-compose ya no da un correo de example.com por defecto', () => {
    const compose = fs.readFileSync(path.resolve(__dirname, '../../docker-compose.yml'), 'utf8');
    expect(compose).not.toMatch(/acme\.email=.*example/);
    expect(compose).toMatch(/--certificatesresolvers\.le\.acme\.email=\$\{LETSENCRYPT_EMAIL:-\}/);
  });
});

describe('TLS efectivo', () => {
  it('con el correo de Traefik de ejemplo: ni router HTTPS ni redirección, y las URL públicas en http', () => {
    traefik('invalid', 'noreply@example.com');
    const { p, s } = servicioConDominio();
    expect(tlsEnabled()).toBe(false);
    expect(tlsBlocked()).toBe(true);
    const labels = traefikLabels(p, s, ['app.acme.es'], 3000);
    expect(Object.keys(labels).some((k) => k.includes('-secure'))).toBe(false);
    expect(Object.keys(labels).some((k) => k.includes('redirectscheme'))).toBe(false);
    expect(systemVars(s).PUBLIC_URL).toBe('http://app.acme.es');
  });

  it('con un correo válido, vacío o sin poder comprobarlo, HTTPS y redirección como siempre', () => {
    // Vacío NO bloquea: Traefik (lego) registra la cuenta sin contacto, que
    // Let's Encrypt acepta, y el propio panel tiene certificado. Quitar el
    // HTTPS de todas las webs por eso las dejaba en HTTP plano.
    for (const estado of ['ok', 'missing', 'unknown'] as const) {
      traefik(estado, estado === 'ok' ? 'ops@acme.es' : null);
      expect(tlsBlocked()).toBe(false);
      expect(tlsEnabled()).toBe(true);
      const { p, s } = servicioConDominio();
      const labels = traefikLabels(p, s, ['app.acme.es'], 3000);
      // Routers con la huella de sus hosts; middlewares con el nombre base (traefik-huella.test.ts).
      const { router } = traefikRouter(p, s, ['app.acme.es']);
      const base = `skyway-${p.slug}-${s.slug}`;
      expect(labels[`traefik.http.routers.${router}-secure.tls.certresolver`]).toBe('le');
      expect(labels[`traefik.http.routers.${router}.middlewares`]).toBe(`${base}-https`);
      expect(systemVars(s).PUBLIC_URL).toBe('https://app.acme.es');
    }
  });

  it('sin el ajuste del panel no hay TLS, aunque Traefik tenga correo', () => {
    setSetting('letsencryptEmail', null);
    traefik('ok', 'ops@acme.es');
    expect(tlsEnabled()).toBe(false);
    expect(tlsBlocked()).toBe(false);
  });

  it('el editor de dominios y Ajustes lo dicen', async () => {
    traefik('invalid', 'noreply@example.com');
    const config = await app.inject({ method: 'GET', url: '/api/domains/config', headers: { cookie } });
    expect(JSON.parse(config.body)).toMatchObject({ tls: false, tlsBlocked: true });
    const ajustes = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(JSON.parse(ajustes.body).traefikAcme).toEqual({ status: 'invalid', email: 'noreply@example.com' });

    // Sin correo: Ajustes lo informa, pero el editor no lo da por bloqueado.
    traefik('missing');
    const config2 = await app.inject({ method: 'GET', url: '/api/domains/config', headers: { cookie } });
    expect(JSON.parse(config2.body)).toMatchObject({ tls: true, tlsBlocked: false });
    const ajustes2 = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(JSON.parse(ajustes2.body).traefikAcme).toEqual({ status: 'missing', email: null });
  });

  it('el informe de seguridad no da TLS por activo con un correo de ejemplo, y no avisa sin correo', async () => {
    traefik('invalid', 'noreply@example.com');
    servicioConDominio();
    const r = await app.inject({ method: 'GET', url: '/api/security', headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    const ids = (JSON.parse(r.body).findings as { id: string }[]).map((f) => f.id);
    expect(ids).toContain('tls-blocked');

    traefik('missing');
    const r2 = await app.inject({ method: 'GET', url: '/api/security', headers: { cookie } });
    const ids2 = (JSON.parse(r2.body).findings as { id: string }[]).map((f) => f.id);
    expect(ids2).not.toContain('tls-blocked');
  });
});

describe('reintento en Traefik durante el intercambio', () => {
  it('cada servicio con dominio lleva un middleware «retry» en el router que sirve', () => {
    traefik('ok', 'ops@acme.es');
    const { p, s } = servicioConDominio();
    const { router } = traefikRouter(p, s, ['app.acme.es']);
    const base = `skyway-${p.slug}-${s.slug}`;
    const conTls = traefikLabels(p, s, ['app.acme.es'], 3000);
    expect(conTls[`traefik.http.middlewares.${base}-retry.retry.attempts`]).toBe('3');
    expect(conTls[`traefik.http.routers.${router}-secure.middlewares`]).toBe(`${base}-retry`);

    setSetting('letsencryptEmail', null);
    const sinTls = traefikLabels(p, s, ['app.acme.es'], 3000);
    expect(sinTls[`traefik.http.routers.${router}.middlewares`]).toBe(`${base}-retry`);
  });
});
