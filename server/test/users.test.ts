import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { API_TOKEN_PREFIX, hashApiToken } from '../src/auth';
import { closeDb, createProject, createUser, createWorkspaceRow, getUser, initDb, insertApiToken, listUserProjectIds } from '../src/db';
import type { ProjectRow, WorkspaceRow } from '../src/types';
import { hashPassword, randomToken } from '../src/util';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

let app: FastifyInstance;
let headers: Record<string, string>;
let adminId = '';

async function call(method: Method, url: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const r = await app.inject({
    method,
    url,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
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
  adminId = admin.id;
  const secret = `${API_TOKEN_PREFIX}${randomToken(24)}`;
  insertApiToken({ user_id: admin.id, name: 'pruebas', token_hash: hashApiToken(secret), prefix: secret.slice(0, 12), expires_at: null });
  headers = { authorization: `Bearer ${secret}` };
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeDb();
});

describe('cuenta de cliente de los usuarios (/api/users)', () => {
  // Dos cuentas con un proyecto cada una; la segunda con cuota de un solo usuario.
  // Se crean en beforeAll: el cuerpo del describe corre antes de initDb().
  let wsA: WorkspaceRow;
  let wsB: WorkspaceRow;
  let proyectoA: ProjectRow;
  let proyectoB: ProjectRow;
  let miembroId = '';

  beforeAll(() => {
    wsA = createWorkspaceRow('Cuenta A');
    wsB = createWorkspaceRow('Cuenta B', { max_members: 1 });
    proyectoA = createProject('Proyecto A', 'proyecto-a', null, wsA.id);
    proyectoB = createProject('Proyecto B', 'proyecto-b', null, wsB.id);
  });

  it('crea un miembro dentro de una cuenta con proyectos de esa cuenta', async () => {
    const r = await call('POST', '/api/users', {
      email: 'miembro@test.local',
      password: 'contraseña1',
      role: 'member',
      workspaceId: wsA.id,
      projectIds: [proyectoA.id],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    miembroId = r.json.user.id;
    expect(getUser(miembroId)?.workspace_id).toBe(wsA.id);
    const lista = await call('GET', '/api/users');
    const fila = lista.json.users.find((u: Json) => u.id === miembroId);
    expect(fila.workspaceId).toBe(wsA.id);
    expect(fila.workspaceName).toBe('Cuenta A');
  });

  it('rechaza proyectos de otra cuenta, cuentas desconocidas y administradores con cuenta', async () => {
    let r = await call('POST', '/api/users', {
      email: 'cruzado@test.local',
      password: 'contraseña1',
      workspaceId: wsA.id,
      projectIds: [proyectoB.id],
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/proyectos de la cuenta/);
    r = await call('POST', '/api/users', { email: 'x@test.local', password: 'contraseña1', workspaceId: 'wsp_no_existe' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/desconocida/);
    // Un administrador nunca lleva cuenta: se rechaza al crear y al editar.
    r = await call('POST', '/api/users', { email: 'admin2@test.local', password: 'contraseña1', role: 'admin', workspaceId: wsA.id });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/administrador/);
    r = await call('POST', '/api/users', { email: 'admin2@test.local', password: 'contraseña1', role: 'admin' });
    expect(r.status).toBe(201);
    expect(r.json.user.workspaceId).toBeNull();
    r = await call('PATCH', `/api/users/${r.json.user.id}`, { workspaceId: wsA.id });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/administrador/);
  });

  it('mueve al miembro a otra cuenta y vacía sus asignaciones antiguas', async () => {
    const r = await call('PATCH', `/api/users/${miembroId}`, { workspaceId: wsB.id });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.user.workspaceId).toBe(wsB.id);
    expect(listUserProjectIds(miembroId)).toEqual([]);
  });

  it('acepta proyectos de la cuenta nueva en la misma petición y rechaza los de la antigua', async () => {
    let r = await call('PATCH', `/api/users/${miembroId}`, { workspaceId: wsA.id, projectIds: [proyectoB.id] });
    expect(r.status).toBe(400);
    r = await call('PATCH', `/api/users/${miembroId}`, { workspaceId: wsA.id, projectIds: [proyectoA.id] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(listUserProjectIds(miembroId)).toEqual([proyectoA.id]);
  });

  it('respeta la cuota de usuarios de la cuenta de destino', async () => {
    // La cuenta B admite un usuario: se ocupa la plaza y el traslado siguiente choca.
    createUser('ocupa@test.local', hashPassword('contraseña1'), 'member', wsB.id);
    const r = await call('PATCH', `/api/users/${miembroId}`, { workspaceId: wsB.id });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/límite de 1 usuarios/);
    expect(getUser(miembroId)?.workspace_id).toBe(wsA.id);
  });

  it('un propietario no puede quedarse sin cuenta y nadie cambia la suya propia', async () => {
    const owner = createUser('owner@test.local', hashPassword('contraseña1'), 'owner', wsA.id);
    let r = await call('PATCH', `/api/users/${owner.id}`, { workspaceId: null });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/propietario/);
    r = await call('PATCH', `/api/users/${adminId}`, { workspaceId: wsA.id });
    expect(r.status).toBe(400);
  });

  it('un miembro puede quedar sin cuenta (null) y pasar a administrador lo desliga', async () => {
    let r = await call('PATCH', `/api/users/${miembroId}`, { workspaceId: null });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(getUser(miembroId)?.workspace_id).toBeNull();
    r = await call('PATCH', `/api/users/${miembroId}`, { workspaceId: wsA.id, projectIds: [proyectoA.id] });
    expect(r.status).toBe(200);
    r = await call('PATCH', `/api/users/${miembroId}`, { role: 'admin' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(getUser(miembroId)?.workspace_id).toBeNull();
    expect(listUserProjectIds(miembroId)).toEqual([]);
  });
});
