import Fastify, { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, createProject, createService, createUser, createWorkspaceRow, initDb } from '../src/db';
import { mailwayRoutes } from '../src/routes/mailway';
import type { UserRow } from '../src/types';

let app: FastifyInstance;
let serviceId: string;
let user: UserRow | null;
let admin: UserRow;
let owner: UserRow;
let outsider: UserRow;
let member: UserRow;
const token = 'integration-test-token-with-at-least-32-characters';
const fetchMock = vi.fn();
const payload = { domain: 'codanuancelegal.com', accounts: ['info', 'no-reply', 'postmaster'].map(localPart => ({ localPart, password: 'test-password-long-enough' })) };
const proxyHeaders = { 'x-skyway-mailway-token': token };
function post(action: string, body: Record<string, unknown> = payload) {
  return app.inject({ method: 'POST', url: `/api/services/${serviceId}/mailway/${action}`, payload: body });
}
beforeAll(async () => {
  initDb();
  process.env.MAILWAY_URL = 'http://mailway:4100';
  process.env.MAILWAY_INTEGRATION_TOKEN = token;
  process.env.MAILWAY_INSTANCE_ID = 'test-skyway';
  const workspace = createWorkspaceRow('Company');
  const other = createWorkspaceRow('Other');
  const project = createProject('Website', 'website', null, workspace.id);
  serviceId = createService(project.id, 'Website', 'website', 'image', { image: 'nginx:alpine', port: 80,
    domains: ['codanuancelegal.com', 'www.codanuancelegal.com', 'company.co.uk'] }).id;
  admin = createUser('admin@example.com', 'unused', 'admin');
  owner = createUser('owner@example.com', 'unused', 'owner', workspace.id);
  outsider = createUser('other@example.com', 'unused', 'owner', other.id);
  member = createUser('member@example.com', 'unused', 'member', workspace.id);
  app = Fastify();
  // Conserva la autorización real, sustituyendo solo la resolución de sesión.
  app.addHook('onRequest', async req => { req.authUser = user; });
  app.register(mailwayRoutes);
  await app.ready();
});
beforeEach(() => {
  user = admin;
  fetchMock.mockReset().mockResolvedValue(Response.json({ configured: true, domain: payload.domain, accounts: payload.accounts.map(a => `${a.localPart}@${payload.domain}`) }));
  vi.stubGlobal('fetch', fetchMock);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.MAILWAY_URL; delete process.env.MAILWAY_INTEGRATION_TOKEN; delete process.env.MAILWAY_INSTANCE_ID;
  await app.close(); closeDb();
});

describe('asistente Mailway', () => {
  it('ofrece dominios raíz guardados y nunca devuelve el secreto al navegador', async () => {
    const r = await app.inject({ url: `/api/services/${serviceId}/mailway` });
    expect(r.json().domains).toEqual(['codanuancelegal.com', 'company.co.uk']);
    expect(r.body).not.toContain(token);
  });
  it('bloquea anónimos, otros workspaces y miembros', async () => {
    for (const identity of [null, outsider, member]) {
      user = identity;
      expect((await post('provision')).statusCode).toBe(identity ? 403 : 401);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('no acepta dominios ajenos o subdominios aunque estén guardados', async () => {
    for (const domain of ['other.com', 'www.codanuancelegal.com', 'co.uk']) expect((await post('provision', { ...payload, domain })).statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('espera la conexión autenticada de Traefik antes de crear buzones', async () => {
    expect((await post('provision')).statusCode).toBe(409);
    expect((await app.inject({ url: '/api/mailway/traefik' })).statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(Response.json({ http: { routers: {}, services: {} } }));
    expect((await app.inject({ url: '/api/mailway/traefik', headers: proxyHeaders })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/services/${serviceId}/mailway` })).json().routingConnected).toBe(true);
  });
  it('el propietario puede crear; Skyway fija la identidad y usa el secreto solo en servidor', async () => {
    user = owner;
    const r = await post('provision', { ...payload, source: 'spoofed', serviceId: 'other' });
    expect(r.statusCode, r.body).toBe(200);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://mailway:4100/api/integrations/skyway/provision');
    expect(options.headers.Authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(options.body)).toEqual({ ...payload, source: 'test-skyway', serviceId });
    expect(options.redirect).toBe('error');
    expect(r.body).not.toContain(token);
    expect(r.headers['cache-control']).toBe('no-store');
  });
  it('una credencial de integración incorrecta no cierra la sesión del usuario', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'Integración no autorizada' }, { status: 401 }));
    expect((await post('status')).statusCode).toBe(502);
  });
  it('un fallo de Mailway no publica una configuración vacía que borre las rutas', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    expect((await app.inject({ url: '/api/mailway/traefik', headers: proxyHeaders })).statusCode).toBe(503);
    expect((await post('verify')).statusCode).toBe(502);
  });
});
