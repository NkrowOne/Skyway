/**
 * Dominio del panel y webhook de la GitHub App.
 *
 *  - `SKYWAY_DOMAIN` es UN nombre (va tal cual en la regla Host() del compose);
 *    la documentación decía que admitía una lista y así el panel dejaba de
 *    responder. Los nombres adicionales van en `SKYWAY_DOMAIN_EXTRA` y sus
 *    routers los publica Skyway en el proveedor dinámico de Traefik.
 *  - La URL del webhook de la App se mostraba calculada con el host de la
 *    petición como «ya configurada»; ahora se lee la que tiene GitHub y se
 *    puede corregir al dominio del panel.
 */
import { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { closeDb, initDb, setSetting } from '../src/db';
import { domainClaimError } from '../src/domainguard';
import { buildAppManifest } from '../src/github/app';
import { extraPanelDomains, isLocalOrIpHost, panelDomains, panelDomainWarning, primaryPanelDomain } from '../src/paneldomain';

const m = vi.hoisted(() => ({ actual: 'http://localhost:4000/api/webhooks/github/app', guardada: null as string | null }));
vi.mock('../src/github/app', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/github/app')>();
  return {
    ...mod,
    refreshAppInfo: vi.fn(async () => mod.githubAppConfig()),
    getAppWebhookUrl: vi.fn(async () => m.actual),
    setAppWebhookUrl: vi.fn(async (url: string) => {
      m.guardada = url;
      m.actual = url;
      return url;
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

afterEach(() => {
  delete process.env.SKYWAY_DOMAIN;
  delete process.env.SKYWAY_DOMAIN_EXTRA;
});

describe('dominios del panel', () => {
  it('SKYWAY_DOMAIN es el principal y SKYWAY_DOMAIN_EXTRA añade nombres', () => {
    process.env.SKYWAY_DOMAIN = 'panel.acme.es';
    process.env.SKYWAY_DOMAIN_EXTRA = 'viejo.acme.es, otro.acme.es,panel.acme.es';
    expect(primaryPanelDomain()).toBe('panel.acme.es');
    expect(extraPanelDomains()).toEqual(['viejo.acme.es', 'otro.acme.es']);
    expect([...panelDomains()].sort()).toEqual(['otro.acme.es', 'panel.acme.es', 'viejo.acme.es']);
    expect(panelDomainWarning()).toBeNull();
    // Ningún servicio puede quedarse con un nombre del panel, tampoco los adicionales.
    expect(domainClaimError(['viejo.acme.es'], { projectId: 'p', serviceId: null, isAdmin: true })).toMatch(/panel de Skyway/);
  });

  it('una lista en SKYWAY_DOMAIN se avisa al arrancar', () => {
    process.env.SKYWAY_DOMAIN = 'nuevo.acme.es,viejo.acme.es';
    expect(primaryPanelDomain()).toBe('nuevo.acme.es');
    expect(panelDomainWarning()).toMatch(/SKYWAY_DOMAIN_EXTRA/);
  });

  it('Traefik recibe un par de routers por cada nombre adicional, hacia el servicio del panel', async () => {
    process.env.SKYWAY_DOMAIN = 'panel.acme.es';
    process.env.SKYWAY_DOMAIN_EXTRA = 'viejo.acme.es';
    const r = await app.inject({ method: 'GET', url: '/api/traefik/mailway' });
    expect(r.statusCode).toBe(200);
    const routers = JSON.parse(r.body).http.routers;
    expect(routers['skyway-panel-extra-viejo-acme-es']).toEqual({
      rule: 'Host(`viejo.acme.es`)',
      entryPoints: ['web'],
      middlewares: ['skyway-https@docker'],
      service: 'skyway@docker',
    });
    expect(routers['skyway-panel-extra-viejo-acme-es-secure']).toMatchObject({
      entryPoints: ['websecure'],
      service: 'skyway@docker',
      tls: { certResolver: 'le' },
    });
  });

  it('sin nombres adicionales la configuración no cambia', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/traefik/mailway' });
    expect(JSON.parse(r.body)).toEqual({});
  });
});

describe('webhook de la GitHub App', () => {
  beforeAll(() => {
    setSetting('githubAppId', '123');
    setSetting('githubAppSlug', 'skyway-acme');
    setSetting('githubAppPrivateKey', 'clave');
  });

  it('se compara la URL que tiene GitHub con la del panel y se puede corregir', async () => {
    process.env.SKYWAY_DOMAIN = 'panel.acme.es';
    const estado = await app.inject({ method: 'GET', url: '/api/github/app', headers: { cookie } });
    const body = JSON.parse(estado.body);
    expect(body.webhookUrl).toBe('https://panel.acme.es/api/webhooks/github/app');
    expect(body.webhookUrlActual).toBe('http://localhost:4000/api/webhooks/github/app');
    expect(body.panelReachable).toBe(true);

    const r = await app.inject({ method: 'POST', url: '/api/github/app/webhook-url', headers: { cookie, ...SAME_ORIGIN } });
    expect(r.statusCode, r.body).toBe(200);
    expect(m.guardada).toBe('https://panel.acme.es/api/webhooks/github/app');
  });

  it('sin dominio público (túnel SSH) no se ofrece apuntar el webhook a localhost', async () => {
    m.guardada = null;
    const estado = await app.inject({ method: 'GET', url: '/api/github/app', headers: { cookie } });
    expect(JSON.parse(estado.body).panelReachable).toBe(false);
    const r = await app.inject({ method: 'POST', url: '/api/github/app/webhook-url', headers: { cookie, ...SAME_ORIGIN } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).code).toBe('panel_not_public');
    expect(m.guardada).toBeNull();
  });

  it('al crear la App por el túnel, el webhook va al dominio del panel y los retornos a donde está el navegador', () => {
    const manifest = buildAppManifest('http://localhost:4000', 'abcde', 'https://panel.acme.es');
    expect(manifest.hook_attributes.url).toBe('https://panel.acme.es/api/webhooks/github/app');
    expect(manifest.redirect_url).toBe('http://localhost:4000/api/github/app/setup');
  });

  it('reconoce las direcciones que GitHub no alcanza', () => {
    for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '[::1]', 'panel.localhost']) expect(isLocalOrIpHost(h)).toBe(true);
    expect(isLocalOrIpHost('panel.acme.es')).toBe(false);
  });
});
