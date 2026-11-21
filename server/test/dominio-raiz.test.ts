/**
 * Dominios raíz anteriores (`dominioraiz.ts`):
 *
 * - Al cambiar el dominio raíz con `PUT /settings`, el anterior pasa a
 *   `rootDomainAnteriores`; volver a uno de la lista lo quita, y con la lista
 *   llena el cambio se rechaza sin tocar nada. La administración la ve con
 *   cuántos servicios la usan y quita entradas; todo queda auditado.
 * - Sus subdominios de un nivel siguen contando como generados: un servicio
 *   con `web.<raíz anterior>` y un dominio propio conserva el propio como
 *   dominio principal (PUBLIC_URL) tras cambiar el dominio raíz.
 * - El asistente «Cambiar de dominio» ofrece el raíz anterior como dominio
 *   actual y propone el actual como dominio nuevo.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { API_TOKEN_PREFIX, hashApiToken } from '../src/auth';
import {
  closeDb,
  createProject,
  createService,
  createUser,
  createWorkspaceRow,
  getService,
  getSetting,
  initDb,
  insertApiToken,
  listAudit,
  setSetting,
} from '../src/db';
import { dominioPrincipal, esSubdominioGenerado, ordenarDominios, parejaWww } from '../src/dominioprincipal';
import { MAX_RAICES_ANTERIORES, raicesAnteriores, raicesGeneradas, SETTING_RAICES_ANTERIORES } from '../src/dominioraiz';
import type { GitConfig, ImageConfig, UserRow } from '../src/types';
import { hashPassword, randomToken } from '../src/util';
import { systemVars } from '../src/variables';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const IP = '203.0.113.10';
const ANTERIOR = 'apps.midominio.com';
const NUEVA = 'apps.otrodominio.com';

let app: FastifyInstance;
let adminCookie = '';
let ownerHeaders: Record<string, string> = {};

const admin = () => ({ cookie: adminCookie, ...SAME_ORIGIN });

function bearerFor(user: UserRow): Record<string, string> {
  const secret = `${API_TOKEN_PREFIX}${randomToken(24)}`;
  insertApiToken({ user_id: user.id, name: 'pruebas', token_hash: hashApiToken(secret), prefix: secret.slice(0, 12), expires_at: null });
  return { authorization: `Bearer ${secret}` };
}

async function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, headers: Record<string, string>, body?: unknown) {
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
    /* sin JSON */
  }
  return { status: r.statusCode, json, raw: r.body };
}

const cambiarRaiz = (rootDomain: string) => call('PUT', '/api/settings', admin(), { rootDomain });
const imagen = (domains: string[]): ImageConfig => ({ image: 'nginx', port: 80, domains }) as ImageConfig;

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
  adminCookie = String(setup.headers['set-cookie']).split(';')[0];
  setSetting('serverIp', IP);
  const ws = createWorkspaceRow('Cliente', { modules_override: JSON.stringify(['domains']) });
  ownerHeaders = bearerFor(createUser('owner@example.com', hashPassword('contraseña1'), 'owner', ws.id));
});

afterAll(async () => {
  await app.close();
  closeDb();
});

beforeEach(() => {
  setSetting('rootDomain', null);
  setSetting(SETTING_RAICES_ANTERIORES, null);
});

describe('la regla con varios dominios raíz', () => {
  it('los subdominios de un nivel de cualquiera de ellos son generados; www y los más profundos, no', () => {
    const raices = [NUEVA, ANTERIOR];
    expect(esSubdominioGenerado(`web.${ANTERIOR}`, raices)).toBe(true);
    expect(esSubdominioGenerado(`web.${NUEVA}`, raices)).toBe(true);
    expect(esSubdominioGenerado(`www.${ANTERIOR}`, raices)).toBe(false);
    expect(esSubdominioGenerado(`a.b.${ANTERIOR}`, raices)).toBe(false);
    expect(esSubdominioGenerado(`web.${ANTERIOR}`, NUEVA)).toBe(false);
    expect(ordenarDominios([`web.${ANTERIOR}`, `web.${NUEVA}`, 'tienda.es', 'www.tienda.es'], raices)).toEqual([
      'www.tienda.es',
      'tienda.es',
      `web.${ANTERIOR}`,
      `web.${NUEVA}`,
    ]);
    expect(dominioPrincipal([`web.${ANTERIOR}`, 'tienda.es'], raices)).toBe('tienda.es');
    // Sin pareja con www lo que cuelga de un dominio raíz, también de uno anterior.
    expect(parejaWww('midominio-apps.com', ['nuevo-apps.com', 'midominio-apps.com'])).toBeNull();
    expect(parejaWww('midominio-apps.com', 'nuevo-apps.com')).toEqual({ falta: 'www.midominio-apps.com', tipo: 'www' });
  });
});

describe('PUT /settings: el dominio raíz anterior pasa a la lista', () => {
  it('el cambio guarda el anterior, se ve con sus servicios y se audita', async () => {
    expect((await cambiarRaiz(ANTERIOR)).status).toBe(200);
    // Del vacío a uno: no hay anterior que guardar.
    expect(raicesAnteriores()).toEqual([]);
    const project = createProject('Lista', 'lista');
    createService(project.id, 'web', 'web', 'image', imagen([`web.${ANTERIOR}`, 'tienda.es']));
    createService(project.id, 'api', 'api', 'image', imagen([`api.${ANTERIOR}`]));

    const r = await cambiarRaiz(NUEVA);
    expect(r.status, r.raw).toBe(200);
    expect(getSetting('rootDomain')).toBe(NUEVA);
    expect(raicesAnteriores()).toEqual([ANTERIOR]);
    expect(raicesGeneradas()).toEqual([NUEVA, ANTERIOR]);

    const ajustes = await call('GET', '/api/settings', admin());
    expect(ajustes.status).toBe(200);
    expect(ajustes.json.rootDomainAnteriores).toEqual([{ domain: ANTERIOR, services: 2 }]);
    const auditados = listAudit({ action: 'root_domain_changed' });
    expect(auditados.map((a) => a.detail).sort()).toEqual([`(vacío) → ${ANTERIOR}`, `${ANTERIOR} → ${NUEVA}`].sort());

    // Guardar otra vez el mismo dominio (escrito de otra forma) no es un cambio.
    expect((await cambiarRaiz('Apps.OtroDominio.com.')).status).toBe(200);
    expect(raicesAnteriores()).toEqual([ANTERIOR]);
    expect(listAudit({ action: 'root_domain_changed' }).length).toBe(auditados.length);
  });

  it('volver al dominio raíz anterior lo quita de la lista; vaciarlo guarda el que había', async () => {
    await cambiarRaiz(ANTERIOR);
    await cambiarRaiz(NUEVA);
    expect(raicesAnteriores()).toEqual([ANTERIOR]);

    expect((await cambiarRaiz(ANTERIOR)).status).toBe(200);
    expect(raicesAnteriores()).toEqual([NUEVA]);

    expect((await cambiarRaiz('')).status).toBe(200);
    expect(getSetting('rootDomain')).toBeNull();
    // El más reciente primero.
    expect(raicesAnteriores()).toEqual([ANTERIOR, NUEVA]);
    expect(raicesGeneradas()).toEqual([ANTERIOR, NUEVA]);
  });

  it(`con ${MAX_RAICES_ANTERIORES} anteriores, otro cambio se rechaza sin tocar nada; volver a uno de ellos, no`, async () => {
    const llenos = Array.from({ length: MAX_RAICES_ANTERIORES }, (_, i) => `apps${i}.ejemplo.com`);
    await cambiarRaiz(ANTERIOR);
    setSetting(SETTING_RAICES_ANTERIORES, JSON.stringify(llenos));

    const r = await call('PUT', '/api/settings', admin(), { rootDomain: NUEVA, serverIp: '198.51.100.7' });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('too_many_previous_root_domains');
    expect(getSetting('rootDomain')).toBe(ANTERIOR);
    expect(getSetting('serverIp')).toBe(IP);
    expect(raicesAnteriores()).toEqual(llenos);

    expect((await cambiarRaiz(llenos[3])).status).toBe(200);
    expect(raicesAnteriores()).toEqual([ANTERIOR, ...llenos.filter((d) => d !== llenos[3])]);
  });
});

describe('DELETE /settings/previous-root-domains/:domain', () => {
  it('la administración quita una entrada, con auditoría; otra que no está, 404; un nombre no válido, 400', async () => {
    await cambiarRaiz(ANTERIOR);
    await cambiarRaiz(NUEVA);
    const r = await call('DELETE', `/api/settings/previous-root-domains/${encodeURIComponent('Apps.MiDominio.com')}`, admin());
    expect(r.status, r.raw).toBe(200);
    expect(r.json.rootDomainAnteriores).toEqual([]);
    expect(raicesAnteriores()).toEqual([]);
    expect(listAudit({ action: 'previous_root_domain_removed' })[0]).toMatchObject({ detail: ANTERIOR });

    const otra = await call('DELETE', `/api/settings/previous-root-domains/${ANTERIOR}`, admin());
    expect(otra.status).toBe(404);
    const mala = await call('DELETE', `/api/settings/previous-root-domains/${encodeURIComponent('no válido!')}`, admin());
    expect(mala.status).toBe(400);
  });

  it('fuera de la administración, 403; la lista sí la ve el editor de dominios de cualquiera', async () => {
    await cambiarRaiz(ANTERIOR);
    await cambiarRaiz(NUEVA);
    const r = await call('DELETE', `/api/settings/previous-root-domains/${ANTERIOR}`, ownerHeaders);
    expect(r.status).toBe(403);
    expect(raicesAnteriores()).toEqual([ANTERIOR]);
    const cfg = await call('GET', '/api/domains/config', ownerHeaders);
    expect(cfg.status).toBe(200);
    expect(cfg.json).toMatchObject({ rootDomain: NUEVA, rootDomainAnteriores: [ANTERIOR] });
  });
});

describe('dirección pública al cambiar el dominio raíz', () => {
  it('un servicio con web.<raíz anterior> y un dominio propio mantiene el propio como principal', async () => {
    await cambiarRaiz(ANTERIOR);
    const project = createProject('Tienda', 'tienda');
    // Guardado con el subdominio generado delante, como un servicio de antes
    // de la regla del dominio principal: la regla lo deja al final al leer.
    const web = createService(project.id, 'web', 'web', 'image', imagen([`web.${ANTERIOR}`, 'tienda.es']));
    expect(systemVars(getService(web.id)!).PUBLIC_DOMAIN).toBe('tienda.es');

    const r = await cambiarRaiz(NUEVA);
    expect(r.status, r.raw).toBe(200);
    expect(systemVars(getService(web.id)!).PUBLIC_DOMAIN).toBe('tienda.es');

    // Guardar la misma lista lo deja en el orden de la regla, sin pedir otro despliegue.
    const p = await call('PATCH', `/api/services/${web.id}`, admin(), {
      config: { domains: [`web.${ANTERIOR}`, 'tienda.es'] },
      domainsBase: [`web.${ANTERIOR}`, 'tienda.es'],
    });
    expect(p.status, p.raw).toBe(200);
    expect(p.json.needsRedeploy).toBe(false);
    expect((getService(web.id)!.config as GitConfig).domains).toEqual(['tienda.es', `web.${ANTERIOR}`]);

    // Ya fuera de la lista, el subdominio cuenta como un dominio propio más.
    expect((await call('DELETE', `/api/settings/previous-root-domains/${ANTERIOR}`, admin())).status).toBe(200);
    expect(systemVars(getService(web.id)!).PUBLIC_DOMAIN).toBe('tienda.es');
    expect(dominioPrincipal([`web.${ANTERIOR}`, 'tienda.es'], raicesGeneradas())).toBe(`web.${ANTERIOR}`);
  });
});

describe('«Cambiar de dominio» con un dominio raíz anterior', () => {
  it('ofrece el raíz anterior como dominio actual, propone el actual como nuevo y mueve todos sus subdominios', async () => {
    await cambiarRaiz(ANTERIOR);
    await cambiarRaiz(NUEVA);
    const project = createProject('Traslado', 'traslado');
    const web = createService(project.id, 'Web', 'web', 'image', imagen(['www.tienda.es', 'tienda.es', `web.${ANTERIOR}`]));
    const api = createService(project.id, 'API', 'api', 'image', imagen([`api.${ANTERIOR}`]));
    createService(project.id, 'Blog', 'blog', 'image', imagen([`blog.${NUEVA}`]));
    createService(project.id, 'Base', 'db', 'database', { template: 'postgres', version: '16', domains: [] } as never);
    const base = `/api/projects/${project.id}/domain-migrations`;

    const lista = await call('GET', base, admin());
    expect(lista.status, lista.raw).toBe(200);
    // El raíz anterior entero (no midominio.com) y el primero; nada del raíz actual.
    expect(lista.json.dominios).toEqual([ANTERIOR, 'tienda.es']);
    expect(lista.json.propuestas).toEqual({ [ANTERIOR]: NUEVA });

    const plan = await call('POST', `${base}/plan`, admin(), { fromDomain: ANTERIOR, toDomain: NUEVA });
    expect(plan.status, plan.raw).toBe(200);
    expect(plan.json.bloqueos).toEqual([]);
    expect(plan.json.hosts.map((h: Json) => [h.serviceId, h.from, h.to, h.modo])).toEqual([
      [web.id, `web.${ANTERIOR}`, `web.${NUEVA}`, 'redirigir'],
      [api.id, `api.${ANTERIOR}`, `api.${NUEVA}`, 'redirigir'],
    ]);

    // «Servir también» el subdominio anterior no le quita la PUBLIC_URL al nuevo: no hay aviso.
    const hosts = plan.json.hosts.map((h: Json) => ({ serviceId: h.serviceId, from: h.from, to: h.to, modo: h.serviceId === api.id ? 'servir' : h.modo }));
    const servir = await call('POST', `${base}/plan`, admin(), { fromDomain: ANTERIOR, toDomain: NUEVA, hosts });
    expect(servir.status, servir.raw).toBe(200);
    expect(servir.json.avisos.some((a: string) => a.includes('seguirá siendo el dominio principal'))).toBe(false);
  });

  it('sin dominio raíz actual, el anterior se ofrece pero no hay dominio nuevo que proponer', async () => {
    await cambiarRaiz(ANTERIOR);
    await cambiarRaiz('');
    const project = createProject('Sin raíz', 'sin-raiz');
    createService(project.id, 'Web', 'web', 'image', imagen([`web.${ANTERIOR}`]));
    const lista = await call('GET', `/api/projects/${project.id}/domain-migrations`, admin());
    expect(lista.json.dominios).toEqual([ANTERIOR]);
    expect(lista.json.propuestas).toEqual({});
  });
});
