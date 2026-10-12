/**
 * Guardar Variables y «Cambios sin desplegar».
 *
 *  - El guardado de la pestaña Variables reemplazaba la lista entera (PUT) y
 *    borraba lo que se había escrito entre la carga y el guardado: lo que importa
 *    el primer despliegue, los secretos del manifiesto o las credenciales SMTP
 *    de Correo → Conectar. El PATCH aplica solo los cambios de quien edita.
 *  - El aviso de cambios sin aplicar era estado de React y se perdía al cerrar
 *    el panel. Ahora lo sabe el servidor: revisión de configuración por
 *    servicio frente a la que aplicó su último despliegue correcto.
 */
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import {
  closeDb,
  createDeployment,
  getEnv,
  getProjectVars,
  getService,
  initDb,
  setEnv,
  setProjectVars,
  updateDeployment,
  writeManagedEnv,
} from '../src/db';

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
let app: FastifyInstance;
let cookie = '';
let projectId = '';
let serviceId = '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  expect(setup.statusCode, setup.body).toBe(200);
  cookie = String(setup.headers['set-cookie']).split(';')[0];
  const project = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie, ...SAME_ORIGIN }, payload: { name: 'Demo' } });
  projectId = JSON.parse(project.body).project.id;
  const svc = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/services`,
    headers: { cookie, ...SAME_ORIGIN },
    payload: { type: 'git', name: 'web', repoUrl: 'https://github.com/acme/web', branch: 'main' },
  });
  expect(svc.statusCode, svc.body).toBe(201);
  serviceId = JSON.parse(svc.body).service.id;
  // Sin Docker el despliegue inicial falla en segundo plano: se le deja terminar.
  await sleep(300);
});

afterAll(async () => {
  await app.close();
  closeDb();
});

const send = (method: 'GET' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie, ...SAME_ORIGIN }, ...(payload !== undefined ? { payload: payload as any } : {}) });

/** Simula un despliegue correcto que aplicó la revisión de configuración actual. */
function desplegadoAhora(id: string) {
  const d = createDeployment(id, 'manual');
  updateDeployment(d.id, { status: 'success', config_rev: getService(id)!.config_rev ?? 0, finished_at: Date.now() });
}

describe('guardar Variables no borra lo que otro escribió entretanto', () => {
  it('el PATCH aplica solo los cambios de quien edita', async () => {
    setEnv(serviceId, { API_URL: 'https://viejo', BORRAR: '1' });
    // Mientras el formulario estaba abierto: Correo → Conectar escribe el SMTP.
    writeManagedEnv(serviceId, { SMTP_PASSWORD: { value: 'secreto', origin: 'mail.smtp.password' } });

    const r = await send('PATCH', `/api/services/${serviceId}/env`, { set: { API_URL: 'https://nuevo' }, unset: ['BORRAR'] });
    expect(r.statusCode, r.body).toBe(200);
    expect(JSON.parse(r.body).needsRedeploy).toBe(true);
    expect(getEnv(serviceId)).toEqual({ API_URL: 'https://nuevo', SMTP_PASSWORD: 'secreto' });
  });

  it('rechaza un nombre de variable no válido sin tocar nada', async () => {
    const antes = getEnv(serviceId);
    const r = await send('PATCH', `/api/services/${serviceId}/env`, { set: { 'MAL-NOMBRE': 'x' }, unset: [] });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).code).toBe('invalid_key');
    expect(getEnv(serviceId)).toEqual(antes);
  });

  it('las variables compartidas también se guardan por cambios', async () => {
    setProjectVars(projectId, { TZ: 'UTC' });
    // Otra pestaña añade una compartida mientras tanto.
    setProjectVars(projectId, { TZ: 'UTC', SMTP_HOST: 'smtp.acme.test' });
    const r = await send('PATCH', `/api/projects/${projectId}/vars`, { set: { TZ: 'Europe/Madrid' }, unset: [] });
    expect(r.statusCode, r.body).toBe(200);
    expect(getProjectVars(projectId)).toEqual({ TZ: 'Europe/Madrid', SMTP_HOST: 'smtp.acme.test' });
  });

  it('borra variables con nombre de propiedad de objeto (constructor, toString)', async () => {
    // `clave in set` miraba también el prototipo: estas no se borraban nunca y
    // la respuesta decía que no hacía falta redesplegar.
    setEnv(serviceId, { constructor: 'a', toString: 'b', QUEDA: 'c' });
    const r = await send('PATCH', `/api/services/${serviceId}/env`, { set: {}, unset: ['constructor', 'toString'] });
    expect(r.statusCode, r.body).toBe(200);
    expect(JSON.parse(r.body).needsRedeploy).toBe(true);
    expect(getEnv(serviceId)).toEqual({ QUEDA: 'c' });

    setProjectVars(projectId, { valueOf: 'x', TZ: 'UTC' });
    const p = await send('PATCH', `/api/projects/${projectId}/vars`, { set: {}, unset: ['valueOf'] });
    expect(p.statusCode, p.body).toBe(200);
    expect(JSON.parse(p.body).needsRedeploy).toBe(true);
    expect(getProjectVars(projectId)).toEqual({ TZ: 'UTC' });
  });
});

describe('cambios sin desplegar', () => {
  async function pendiente(): Promise<{ servicio: boolean; proyecto: boolean }> {
    const s = await send('GET', `/api/services/${serviceId}`);
    const p = await send('GET', `/api/projects/${projectId}`);
    return {
      servicio: JSON.parse(s.body).pendingChanges,
      proyecto: JSON.parse(p.body).services.find((x: { id: string }) => x.id === serviceId).pendingChanges,
    };
  }

  it('lo sabe el servidor: se ve en el servicio y en el proyecto hasta el siguiente despliegue', async () => {
    desplegadoAhora(serviceId);
    expect(await pendiente()).toEqual({ servicio: false, proyecto: false });

    await send('PATCH', `/api/services/${serviceId}/env`, { set: { NUEVA: '1' }, unset: [] });
    expect(await pendiente()).toEqual({ servicio: true, proyecto: true });

    desplegadoAhora(serviceId);
    expect(await pendiente()).toEqual({ servicio: false, proyecto: false });
  });

  it('las variables compartidas dejan pendientes los servicios del proyecto y la respuesta los enumera', async () => {
    desplegadoAhora(serviceId);
    const r = await send('PATCH', `/api/projects/${projectId}/vars`, { set: { LOG_LEVEL: 'debug' }, unset: [] });
    expect(JSON.parse(r.body).affected.map((s: { id: string }) => s.id)).toContain(serviceId);
    expect((await pendiente()).servicio).toBe(true);
  });

  it('un ajuste que exige redesplegar cuenta; uno que se aplica en caliente, no', async () => {
    desplegadoAhora(serviceId);
    await send('PATCH', `/api/services/${serviceId}`, { config: { alertsMuted: true } });
    expect((await pendiente()).servicio).toBe(false);
    await send('PATCH', `/api/services/${serviceId}`, { config: { port: 8080 } });
    expect((await pendiente()).servicio).toBe(true);
  });
});
