/**
 * Asistente «Cambiar de dominio» de un proyecto (`domainmigration.ts` y sus
 * rutas): solo la web (plan, preparar, comprobar, pasar, volver y terminar) y
 * con el correo en Mailway (el doble de `mailwayfake.ts`): el cambio se abre
 * con `origen='skyway'`, un fallo al pasar el correo no toca la web y la baja
 * actualiza antes las aplicaciones que envían con un buzón pendiente.
 *
 * Sin Docker: el despliegue se sustituye (se crea la fila y se anota) y su
 * resultado lo decide cada prueba; el DNS es el falso de `dnsfake.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { API_TOKEN_PREFIX, hashApiToken } from '../src/auth';
import {
  closeDb,
  createDeployment,
  createProject,
  createService,
  createUser,
  createWorkspaceRow,
  getDomainMigration,
  getDomainRedirect,
  getEnv,
  getManagedEnv,
  getPrepublished,
  getProjectVars,
  getService,
  initDb,
  insertApiToken,
  insertDomainMigration,
  insertMailwayLink,
  listAudit,
  listDomainRedirects,
  listSnapshots,
  patchEnv,
  setEnv,
  setProjectVars,
  setSetting,
  setUserProjects,
  updateDeployment,
  writeManagedEnv,
} from '../src/db';
import { esperarTareasCambioDominio, INTERRUMPIDO, marcarCambiosInterrumpidos, resetCambioDominioCaches } from '../src/domainmigration';
import { MAILWAY_SETTING, projectExternalRef, resetMailwayCaches } from '../src/mailway';
import type { GitConfig, ProjectRow, ServiceRow, UserRow } from '../src/types';
import { hashPassword, randomToken } from '../src/util';
import { dnsFalso } from './dnsfake';
import { MW_BASE, MW_TOKEN, fakeFetch, marcarListo, mw } from './mailwayfake';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

const m = vi.hoisted(() => ({
  triggers: [] as { serviceId: string; trigger: string; imageTag?: string }[],
  resultado: 'success' as 'success' | 'failed',
}));

// Sin desplegar de verdad: se crea la fila, como haría triggerDeploy, y el
// resultado lo decide la prueba (`m.resultado`).
vi.mock('../src/deploy/deployer', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/deploy/deployer')>();
  const db = await import('../src/db');
  return {
    ...mod,
    triggerDeploy: vi.fn((serviceId: string, trigger: string, opts: { imageTag?: string } = {}) => {
      m.triggers.push({ serviceId, trigger, ...(opts.imageTag ? { imageTag: opts.imageTag } : {}) });
      return db.createDeployment(serviceId, trigger, opts.imageTag ?? null);
    }),
    awaitDeployment: vi.fn(async (id: string) => {
      db.updateDeployment(id, { status: m.resultado, error: m.resultado === 'failed' ? 'El contenedor no ha arrancado.' : null });
      return db.getDeployment(id);
    }),
  };
});
vi.mock('../src/docker/containers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/docker/containers')>()),
  imageExists: vi.fn(async () => true),
}));

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const IP = '203.0.113.10';

let app: FastifyInstance;
let adminCookie = '';
let ownerHeaders: Record<string, string>;
let memberHeaders: Record<string, string>;
let member: UserRow;
let workspaceId = '';

function bearerFor(user: UserRow): Record<string, string> {
  const secret = `${API_TOKEN_PREFIX}${randomToken(24)}`;
  insertApiToken({ user_id: user.id, name: 'pruebas', token_hash: hashApiToken(secret), prefix: secret.slice(0, 12), expires_at: null });
  return { authorization: `Bearer ${secret}` };
}

const admin = () => ({ cookie: adminCookie, ...SAME_ORIGIN });

async function call(method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: unknown) {
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

function gitCfg(domains: string[], extra: Partial<GitConfig> = {}): GitConfig {
  return { repoUrl: 'https://github.com/x/y', branch: 'main', port: 3000, domains, webhookSecret: 'w', ...extra } as GitConfig;
}

/** El DNS de esos nombres apunta a este servidor. */
function dnsAqui(...hosts: string[]) {
  for (const h of hosts) dnsFalso.a.set(h, [IP]);
}

const dominios = (s: ServiceRow) => (getService(s.id)!.config as GitConfig).domains;
const llamadas = (re: RegExp) => mw.calls.filter((c) => re.test(c.path));

beforeAll(async () => {
  initDb();
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
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
  setSetting(MAILWAY_SETTING.baseUrl, MW_BASE);
  setSetting(MAILWAY_SETTING.token, MW_TOKEN);
  resetMailwayCaches();
  const ws = createWorkspaceRow('Cliente', { modules_override: JSON.stringify(['mail', 'domains']) });
  workspaceId = ws.id;
  ownerHeaders = bearerFor(createUser('owner@example.com', hashPassword('contraseña1'), 'owner', ws.id));
  // El miembro opera los proyectos que se le asignen, pero no gestiona su estructura.
  member = createUser('member@example.com', hashPassword('contraseña1'), 'member', ws.id);
  memberHeaders = bearerFor(member);
});

afterAll(async () => {
  await esperarTareasCambioDominio();
  vi.unstubAllGlobals();
  await app.close();
  closeDb();
});

beforeEach(() => {
  mw.calls = [];
  m.triggers = [];
  m.resultado = 'success';
  resetCambioDominioCaches();
});

// ---------- solo la web ----------

describe('solo la web', () => {
  let proj: ProjectRow;
  let web: ServiceRow;
  let api: ServiceRow;
  let base = '';
  let mid = '';

  beforeAll(() => {
    proj = createProject('Web', 'web-solo', null, workspaceId);
    web = createService(proj.id, 'Web', 'web', 'git', gitCfg(['www.dominio.es', 'dominio.es'], { buildArgs: { NEXT_PUBLIC_URL: 'https://www.dominio.es' } }));
    api = createService(proj.id, 'API', 'api', 'git', gitCfg(['api.dominio.es']));
    createService(proj.id, 'Base', 'db', 'database', { template: 'postgres', version: '16', domains: [] });
    setEnv(web.id, {
      APP_URL: 'https://www.dominio.es',
      DATABASE_URL: 'postgres://u:clave@db.dominio.es:5432/app',
      COOKIE_DOMAIN: '.dominio.es',
    });
    setEnv(api.id, { CORS_ORIGIN: 'https://www.dominio.es' });
    setProjectVars(proj.id, { SITE: 'https://www.dominio.es/' });
    base = `/api/projects/${proj.id}/domain-migrations`;
  });

  it('plan: mapa de nombres, variables con sus notas y la huella', async () => {
    const r = await call('POST', `${base}/plan`, admin(), { fromDomain: 'dominio.es', toDomain: 'Dominio2.es' });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.toDomain).toBe('dominio2.es');
    expect(r.json.correoDisponible).toBe('no_vinculado');
    expect(r.json.correo).toBeNull();
    expect(r.json.bloqueos).toEqual([]);
    expect(r.json.avisos).toContain('Solo la web: el correo de dominio.es no está en Mailway.');
    expect(r.json.avisos).toContain('Las sesiones abiertas se cerrarán al pasar.');
    expect(r.json.hosts.map((h: Json) => [h.serviceName, h.from, h.to, h.modo, h.error])).toEqual([
      ['Web', 'www.dominio.es', 'www.dominio2.es', 'redirigir', null],
      ['Web', 'dominio.es', 'dominio2.es', 'redirigir', null],
      ['API', 'api.dominio.es', 'api.dominio2.es', 'redirigir', null],
    ]);
    expect(r.json.dnsWeb.map((d: Json) => [d.host, d.ip])).toEqual([
      ['www.dominio2.es', IP],
      ['dominio2.es', IP],
      ['api.dominio2.es', IP],
    ]);
    const cambios = r.json.variables.cambios.map((c: Json) => [c.ambito, c.key, c.antes, c.despues]);
    expect(cambios).toEqual(
      expect.arrayContaining([
        ['project', 'SITE', 'https://www.dominio.es/', 'https://www.dominio2.es/'],
        ['service', 'APP_URL', 'https://www.dominio.es', 'https://www.dominio2.es'],
        ['service', 'COOKIE_DOMAIN', '.dominio.es', '.dominio2.es'],
        ['service', 'CORS_ORIGIN', 'https://www.dominio.es', 'https://www.dominio2.es'],
        // Los argumentos de compilación no enseñan su valor (la API nunca los devuelve).
        ['build', 'NEXT_PUBLIC_URL', null, null],
      ]),
    );
    expect(r.json.variables.cambios.some((c: Json) => c.key === 'DATABASE_URL')).toBe(false);
    expect(r.json.variables.notas.map((n: Json) => n.texto)).toContain(
      'db.dominio.es aparece en DATABASE_URL, pero no lo sirve este proyecto: no se cambia.',
    );
    expect(r.json.servicios.map((s: Json) => s.nombre).sort()).toEqual(['API', 'Web']);
    expect(r.json.expect).toMatch(/^[0-9a-f]{64}$/);
  });

  it('dominios relacionados: bloqueo', async () => {
    const r = await call('POST', `${base}/plan`, admin(), { fromDomain: 'dominio.es', toDomain: 'nuevo.dominio.es' });
    expect(r.status).toBe(200);
    expect(r.json.bloqueos).toContain('El dominio nuevo no puede ser un subdominio del actual, ni al revés.');
  });

  it('preparar: con la huella vieja, 409 plan_changed; con la buena, 201 y prepublicación sin desplegar', async () => {
    const plan = (await call('POST', `${base}/plan`, admin(), { fromDomain: 'dominio.es', toDomain: 'dominio2.es' })).json;
    const hosts = plan.hosts.map((h: Json) => ({ serviceId: h.serviceId, from: h.from, to: h.to, modo: h.from === 'api.dominio.es' ? 'servir' : h.modo }));
    const viejo = await call('POST', base, admin(), { fromDomain: 'dominio.es', toDomain: 'dominio2.es', hosts, excluidas: [], expect: plan.expect });
    expect(viejo.status).toBe(409);
    expect(viejo.json.code).toBe('plan_changed');

    const plan2 = (await call('POST', `${base}/plan`, admin(), { fromDomain: 'dominio.es', toDomain: 'dominio2.es', hosts })).json;
    const r = await call('POST', base, admin(), { fromDomain: 'dominio.es', toDomain: 'dominio2.es', hosts, excluidas: [], expect: plan2.expect });
    expect(r.status, r.raw).toBe(201);
    mid = r.json.id;
    expect(r.json.soloWeb).toBe(true);
    expect(r.json.estado).toBe('preparando');
    expect(r.json.compuertas.find((c: Json) => c.id === 'dns_web')).toMatchObject({ ok: false, bloquea: true });
    expect(getPrepublished('www.dominio2.es')).toMatchObject({ project_id: proj.id, service_id: web.id, migration_id: mid, dns_ok_at: null });
    expect(getPrepublished('api.dominio2.es')?.service_id).toBe(api.id);
    expect(m.triggers).toEqual([]);
    expect(dominios(web)).toEqual(['www.dominio.es', 'dominio.es']);

    // Repetir la misma petición devuelve el mismo cambio.
    const otra = await call('POST', base, admin(), { fromDomain: 'dominio.es', toDomain: 'dominio2.es', hosts, excluidas: [], expect: plan2.expect });
    expect(otra.status).toBe(200);
    expect(otra.json.id).toBe(mid);
    expect(listAudit({ action: 'domain_migration_created' }).some((a) => a.target_id === proj.id && a.detail === 'dominio.es → dominio2.es')).toBe(
      true,
    );
  });

  it('comprobar: con el DNS apuntando aquí, «lista» y la prepublicación se publica', async () => {
    dnsAqui('www.dominio2.es', 'dominio2.es', 'api.dominio2.es');
    const r = await call('POST', `${base}/${mid}/check`, admin());
    expect(r.status, r.raw).toBe(200);
    expect(r.json.estado).toBe('lista');
    expect(r.json.puedePasar).toBe(true);
    expect(r.json.hosts.every((h: Json) => h.dns === 'ok' && h.certificado === 'sin_tls')).toBe(true);
    expect(getPrepublished('www.dominio2.es')?.dns_ok_at).toBeGreaterThan(0);
  });

  it('pasar: 409 con una huella que no es la de la confirmación; después dominios, variables, redirecciones y despliegues', async () => {
    const malo = await call('POST', `${base}/${mid}/switch`, admin(), { expect: 'otra' });
    expect(malo.status).toBe(409);
    expect(malo.json.code).toBe('plan_changed');

    const vista = (await call('GET', `${base}/${mid}`, admin())).json;
    expect(vista.variables.cambios.length).toBeGreaterThan(0);
    const antes = Date.now();
    const r = await call('POST', `${base}/${mid}/switch`, admin(), { expect: vista.variables.huella });
    expect(r.status, r.raw).toBe(202);
    expect(r.json.estado).toBe('pasada');

    // En su sitio (el principal pasa al nuevo); «servir» deja el viejo al final, sin redirigir.
    expect(dominios(web)).toEqual(['www.dominio2.es', 'dominio2.es']);
    expect(dominios(api)).toEqual(['api.dominio2.es', 'api.dominio.es']);
    expect(getEnv(web.id).APP_URL).toBe('https://www.dominio2.es');
    expect(getEnv(web.id).DATABASE_URL).toBe('postgres://u:clave@db.dominio.es:5432/app');
    expect(getEnv(api.id).CORS_ORIGIN).toBe('https://www.dominio2.es');
    expect(getProjectVars(proj.id).SITE).toBe('https://www.dominio2.es/');
    expect((getService(web.id)!.config as GitConfig).buildArgs?.NEXT_PUBLIC_URL).toBe('https://www.dominio2.es');

    const snaps = listSnapshots(mid);
    expect(snaps.find((s) => s.ambito === 'domains' && s.service_id === web.id)?.valor_original).toBe(JSON.stringify(['www.dominio.es', 'dominio.es']));
    expect(snaps.find((s) => s.key === 'APP_URL')).toMatchObject({ valor_original: 'https://www.dominio.es', valor_escrito: 'https://www.dominio2.es' });

    const redir = getDomainRedirect('www.dominio.es')!;
    expect(redir).toMatchObject({ project_id: proj.id, to_host: 'www.dominio2.es', migration_id: mid });
    expect(redir.permanent_from).toBeGreaterThanOrEqual(antes + 7 * 24 * 3600_000);
    expect(redir.permanent_from).toBeLessThanOrEqual(Date.now() + 7 * 24 * 3600_000);
    expect(getDomainRedirect('dominio.es')?.to_host).toBe('dominio2.es');
    expect(getDomainRedirect('api.dominio.es')).toBeUndefined();

    expect(m.triggers.map((t) => [t.serviceId, t.trigger]).sort()).toEqual(
      [
        [api.id, 'cambio-de-dominio'],
        [web.id, 'cambio-de-dominio'],
      ].sort(),
    );
    await esperarTareasCambioDominio();
    const tras = getDomainMigration(mid)!;
    expect(tras.servicios[web.id]?.estado).toBe('ok');
    // El servicio ya sirve los nombres nuevos: la prepublicación sobra.
    expect(getPrepublished('www.dominio2.es')).toBeUndefined();
    expect(listAudit({ action: 'service_env_replaced' }).some((a) => a.target_id === web.id && /APP_URL/.test(a.detail ?? ''))).toBe(true);
  });

  it('volver: los viejos en su sitio y los nuevos como secundarios; clave a clave, con aviso de la tocada a mano', async () => {
    patchEnv(api.id, { CORS_ORIGIN: 'https://www.dominio2.es,https://otra.es' }, []);
    const r = await call('POST', `${base}/${mid}/rollback`, admin());
    expect(r.status, r.raw).toBe(202);
    expect(r.json.estado).toBe('lista');
    expect(dominios(web)).toEqual(['www.dominio.es', 'dominio.es', 'www.dominio2.es', 'dominio2.es']);
    expect(dominios(api)).toEqual(['api.dominio.es', 'api.dominio2.es']);
    expect(getEnv(web.id).APP_URL).toBe('https://www.dominio.es');
    expect(getProjectVars(proj.id).SITE).toBe('https://www.dominio.es/');
    expect((getService(web.id)!.config as GitConfig).buildArgs?.NEXT_PUBLIC_URL).toBe('https://www.dominio.es');
    expect(getEnv(api.id).CORS_ORIGIN).toBe('https://www.dominio2.es,https://otra.es');
    expect(r.json.avisos).toContain('No se ha restaurado CORS_ORIGIN en «API»: cambió después del cambio de dominio.');
    expect(listDomainRedirects(mid)).toEqual([]);
    expect(listSnapshots(mid)).toEqual([]);
    expect(m.triggers.length).toBe(2);
  });

  it('pasar otra vez y terminar: las redirecciones se quedan; después se pueden quitar', async () => {
    const vista = (await call('POST', `${base}/${mid}/check`, admin())).json;
    expect(vista.estado).toBe('lista');
    const r = await call('POST', `${base}/${mid}/switch`, admin(), { expect: vista.variables.huella });
    expect(r.status, r.raw).toBe(202);
    expect(dominios(web)).toEqual(['www.dominio2.es', 'dominio2.es']);
    await esperarTareasCambioDominio();

    const mal = await call('POST', `${base}/${mid}/finish`, admin(), { confirm: 'dominio2.es' });
    expect(mal.status).toBe(400);
    expect(mal.json.code).toBe('confirm_mismatch');
    const fin = await call('POST', `${base}/${mid}/finish`, admin(), { confirm: 'dominio.es' });
    expect(fin.status, fin.raw).toBe(200);
    expect(fin.json.estado).toBe('terminada');
    expect(listSnapshots(mid)).toEqual([]);
    expect(listDomainRedirects(mid).length).toBe(2);

    const lista = (await call('GET', base, admin())).json;
    expect(lista.abierta).toBeNull();
    expect(lista.anteriores[0].id).toBe(mid);

    const quitar = await call('POST', `${base}/${mid}/redirects/remove`, admin(), { confirm: 'dominio.es' });
    expect(quitar.status, quitar.raw).toBe(200);
    expect(listDomainRedirects(mid)).toEqual([]);
    expect(listAudit({ action: 'domain_redirects_removed' }).length).toBe(1);
  });

  it('sin permisos de gestión (miembro del proyecto): 403', async () => {
    setUserProjects(member.id, [proj.id]);
    const r = await call('GET', base, memberHeaders);
    expect(r.status).toBe(403);
    const p = await call('POST', `${base}/plan`, memberHeaders, { fromDomain: 'dominio2.es', toDomain: 'dominio3.es' });
    expect(p.status).toBe(403);
  });
});

// ---------- con el correo en Mailway ----------

interface ProyectoConCorreo {
  proj: ProjectRow;
  web: ServiceRow;
  clientId: string;
  buzonId: string;
  base: string;
}

/** Proyecto vinculado a un cliente de Mailway con el dominio `dominio`, un buzón usado por la web para enviar y su DNS nuevo apuntando aquí. */
function proyectoConCorreo(slug: string, dominio: string): ProyectoConCorreo {
  const proj = createProject(`Tienda ${slug}`, slug, null, workspaceId);
  const web = createService(proj.id, 'Web', 'web', 'git', gitCfg([`www.${dominio}`]));
  const clientId = `cli_${slug}`;
  mw.clients.push({ id: clientId, name: slug, slug, externalRef: projectExternalRef(proj.id), suspended: false, planId: 'pln_2' });
  insertMailwayLink({ project_id: proj.id, client_id: clientId, client_name: slug, created_by: null });
  const domId = `dom_${slug}`;
  mw.domains.push({ id: domId, clientId, domain: dominio, status: 'active', ownershipVerifiedAt: 1 });
  const buzonId = `mbx_${slug}`;
  mw.mailboxes.push({
    id: buzonId,
    domainId: domId,
    domain: dominio,
    localPart: 'tienda',
    email: `tienda@${dominio}`,
    displayName: '',
    quotaMb: 1024,
    status: 'active',
    usedBytes: null,
  });
  mw.appPasswords.push({ id: `app_${slug}`, mailboxId: buzonId, email: `tienda@${dominio}`, name: 'skyway:web', revokedAt: null, createdAt: 1 });
  writeManagedEnv(web.id, {
    SMTP_USER: { value: `tienda@${dominio}`, origin: 'mail.smtp.user' },
    SMTP_FROM: { value: `tienda@${dominio}`, origin: 'mail.smtp.from' },
    SMTP_PASS: { value: 'ContraseñaDeAplicacion', origin: 'mail.smtp.password' },
  });
  patchEnv(web.id, { ADMIN_EMAIL: `tienda@${dominio}`, CONTACTO: `hola@${dominio}` }, []);
  // La versión en marcha: la baja vuelve a desplegar esta imagen.
  const dep = createDeployment(web.id, 'manual');
  updateDeployment(dep.id, { status: 'success', image_tag: `skyway/${slug}-web:v1`, finished_at: Date.now() });
  return { proj, web, clientId, buzonId, base: `/api/projects/${proj.id}/domain-migrations` };
}

/** Plan y preparar como propietario del workspace (no administración). */
async function preparar(p: ProyectoConCorreo, from: string, to: string): Promise<{ mid: string; mailwayId: string }> {
  const plan = await call('POST', `${p.base}/plan`, ownerHeaders, { fromDomain: from, toDomain: to });
  expect(plan.status, plan.raw).toBe(200);
  const r = await call('POST', p.base, ownerHeaders, {
    fromDomain: from,
    toDomain: to,
    hosts: plan.json.hosts.map((h: Json) => ({ serviceId: h.serviceId, from: h.from, to: h.to, modo: h.modo })),
    excluidas: [],
    expect: plan.json.expect,
  });
  expect(r.status, r.raw).toBe(201);
  return { mid: r.json.id, mailwayId: getDomainMigration(r.json.id)!.mailway_migration_id! };
}

/** Hasta «pasada»: DNS aquí, Mailway listo y pasar. */
async function hastaPasada(p: ProyectoConCorreo, from: string, to: string): Promise<{ mid: string; mailwayId: string }> {
  const ids = await preparar(p, from, to);
  dnsAqui(`www.${to}`);
  marcarListo(ids.mailwayId);
  const vista = (await call('POST', `${p.base}/${ids.mid}/check`, ownerHeaders)).json;
  expect(vista.estado).toBe('lista');
  const r = await call('POST', `${p.base}/${ids.mid}/switch`, ownerHeaders, { expect: vista.variables.huella });
  expect(r.status, r.raw).toBe(202);
  await esperarTareasCambioDominio();
  return ids;
}

describe('con el correo en Mailway', () => {
  let p: ProyectoConCorreo;
  let mid = '';
  let mailwayId = '';

  beforeAll(() => {
    p = proyectoConCorreo('correo', 'correo.es');
  });

  it('plan: el correo de Mailway (con soloCliente para quien no administra), y la dirección del buzón en las variables', async () => {
    const r = await call('POST', `${p.base}/plan`, ownerHeaders, { fromDomain: 'correo.es', toDomain: 'correo2.es' });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.correoDisponible).toBe('si');
    expect(r.json.correo.buzones.map((b: Json) => [b.de, b.a, b.usadoPorApps])).toEqual([['tienda@correo.es', 'tienda@correo2.es', ['skyway:web']]]);
    expect(llamadas(/^\/api\/domain-migrations\/plan/)[0].path).toBe('/api/domain-migrations/plan?soloCliente=1');
    const cambios = r.json.variables.cambios.map((c: Json) => [c.key, c.despues]);
    expect(cambios).toContainEqual(['ADMIN_EMAIL', 'tienda@correo2.es']);
    // Las de correo que escribió Skyway las cambia el correo (el remitente al pasar; el usuario, en la baja).
    expect(cambios.some((c: Json) => c[0] === 'SMTP_USER' || c[0] === 'SMTP_FROM')).toBe(false);
    expect(r.json.variables.notas.map((n: Json) => n.texto)).toContain(
      'hola@correo.es aparece en CONTACTO, pero no es un buzón ni un alias que se mude: no se cambia.',
    );
  });

  it('preparar: el cambio se abre en Mailway con origen skyway, la referencia del proyecto y soloCliente', async () => {
    ({ mid, mailwayId } = await preparar(p, 'correo.es', 'correo2.es'));
    const [crear] = llamadas(/^\/api\/domain-migrations(\?|$)/).filter((c) => c.method === 'POST');
    expect(crear.path).toBe('/api/domain-migrations?soloCliente=1');
    expect(crear.body).toMatchObject({ fromDomainId: 'dom_correo', toDomain: 'correo2.es', origen: 'skyway', referenciaExterna: projectExternalRef(p.proj.id) });
    const c = mw.migraciones.find((x) => x.id === mailwayId)!;
    expect(c).toMatchObject({ origen: 'skyway', soloCliente: true });
    expect(getDomainMigration(mid)).toMatchObject({ mailway_client_id: p.clientId, solo_web: false });
  });

  it('comprobar: hasta que Mailway está listo, el correo bloquea', async () => {
    dnsAqui('www.correo2.es');
    const antes = (await call('POST', `${p.base}/${mid}/check`, ownerHeaders)).json;
    expect(antes.estado).toBe('preparando');
    expect(antes.compuertas.find((c: Json) => c.id === 'correo')).toMatchObject({ ok: false, bloquea: true });
    marcarListo(mailwayId);
    const despues = (await call('POST', `${p.base}/${mid}/check`, ownerHeaders)).json;
    expect(despues.estado).toBe('lista');
    expect(despues.correo.estado).toBe('listo');
  });

  it('si el correo no pasa en Mailway, la web no se toca', async () => {
    const vista = (await call('GET', `${p.base}/${mid}`, ownerHeaders)).json;
    mw.fallosCambio.set('switch', { status: 409, code: 'migration_not_ready', error: 'Todavía no se puede pasar a correo2.es: el DNS no está completo.' });
    const r = await call('POST', `${p.base}/${mid}/switch`, ownerHeaders, { expect: vista.variables.huella });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('migration_not_ready');
    const row = getDomainMigration(mid)!;
    expect(row.estado).toBe('lista');
    expect(row.error).toMatch(/Todavía no se puede pasar/);
    expect(dominios(p.web)).toEqual(['www.correo.es']);
    expect(getEnv(p.web.id).SMTP_FROM).toBe('tienda@correo.es');
    expect(listDomainRedirects(mid)).toEqual([]);
    expect(m.triggers).toEqual([]);
  });

  it('pasar: el remitente pasa a la dirección nueva y el usuario SMTP sigue siendo el anterior', async () => {
    const vista = (await call('GET', `${p.base}/${mid}`, ownerHeaders)).json;
    const r = await call('POST', `${p.base}/${mid}/switch`, ownerHeaders, { expect: vista.variables.huella });
    expect(r.status, r.raw).toBe(202);
    expect(r.json.estado).toBe('pasada');
    expect(r.json.error).toBeNull();
    expect(getEnv(p.web.id)).toMatchObject({ SMTP_FROM: 'tienda@correo2.es', SMTP_USER: 'tienda@correo.es', ADMIN_EMAIL: 'tienda@correo2.es' });
    // Sigue siendo de Skyway: la baja podrá cambiar el usuario.
    expect(getManagedEnv(p.web.id).SMTP_FROM.origin).toBe('mail.smtp.from');
    expect(r.json.correo.buzones.lista[0]).toMatchObject({ email: 'tienda@correo2.es', login: 'tienda@correo.es', pendiente: true });
    expect(r.json.puedeDarDeBaja).toBe(true);
    await esperarTareasCambioDominio();
  });

  it('dar de baja: la aplicación pasa al usuario nuevo, se despliega con la imagen en marcha y después Mailway da de baja', async () => {
    const mal = await call('POST', `${p.base}/${mid}/retire`, ownerHeaders, { confirm: 'correo2.es' });
    expect(mal.status).toBe(400);
    expect(mal.json.code).toBe('confirm_mismatch');

    const r = await call('POST', `${p.base}/${mid}/retire`, ownerHeaders, { confirm: 'correo.es' });
    expect(r.status, r.raw).toBe(202);
    expect(r.json.estado).toBe('dando_de_baja');
    await esperarTareasCambioDominio();

    const orden = mw.calls.filter((c) => /login-update|\/retire$/.test(c.path)).map((c) => c.path);
    expect(orden).toEqual([`/api/mailboxes/${p.buzonId}/login-update`, `/api/domain-migrations/${mailwayId}/retire`]);
    expect(getEnv(p.web.id).SMTP_USER).toBe('tienda@correo2.es');
    expect(m.triggers).toEqual([{ serviceId: p.web.id, trigger: 'cambio-de-dominio', imageTag: 'skyway/correo-web:v1' }]);
    const row = getDomainMigration(mid)!;
    expect(row.estado).toBe('terminada');
    expect(row.error).toBeNull();
    expect(mw.migraciones.find((x) => x.id === mailwayId)?.estado).toBe('dado_de_baja');
    // Las redirecciones se quedan.
    expect(getDomainRedirect('www.correo.es')?.to_host).toBe('www.correo2.es');
    expect(listAudit({ action: 'domain_migration_retired' }).some((a) => a.target_id === p.proj.id)).toBe(true);
  });
});

describe('baja con el despliegue de la aplicación fallido', () => {
  it('no se llama a la baja de Mailway y el cambio vuelve a «pasada» con el error', async () => {
    const p = proyectoConCorreo('fallida', 'fallida.es');
    const { mid, mailwayId } = await hastaPasada(p, 'fallida.es', 'fallida2.es');
    mw.calls = [];
    m.triggers = [];
    m.resultado = 'failed';
    const r = await call('POST', `${p.base}/${mid}/retire`, ownerHeaders, { confirm: 'fallida.es' });
    expect(r.status, r.raw).toBe(202);
    await esperarTareasCambioDominio();

    expect(llamadas(/login-update/).length).toBe(1);
    expect(getEnv(p.web.id).SMTP_USER).toBe('tienda@fallida2.es');
    expect(m.triggers).toEqual([{ serviceId: p.web.id, trigger: 'cambio-de-dominio', imageTag: 'skyway/fallida-web:v1' }]);
    expect(llamadas(/\/retire$/)).toEqual([]);
    const row = getDomainMigration(mid)!;
    expect(row.estado).toBe('pasada');
    expect(row.error).toMatch(/no se ha dado de baja fallida\.es/);
    expect(row.servicios[p.web.id]).toMatchObject({ estado: 'error', error: 'El contenedor no ha arrancado.' });
    expect(mw.migraciones.find((x) => x.id === mailwayId)?.estado).toBe('pasado');

    // Reintentar el servicio y volver a dar de baja: ya no hay buzones pendientes con aplicaciones.
    m.resultado = 'success';
    const re = await call('POST', `${p.base}/${mid}/services/${p.web.id}/retry`, ownerHeaders);
    expect(re.status, re.raw).toBe(202);
    await esperarTareasCambioDominio();
    expect(getDomainMigration(mid)!.servicios[p.web.id]?.estado).toBe('ok');
    const otra = await call('POST', `${p.base}/${mid}/retire`, ownerHeaders, { confirm: 'fallida.es' });
    expect(otra.status, otra.raw).toBe(202);
    await esperarTareasCambioDominio();
    expect(getDomainMigration(mid)!.estado).toBe('terminada');
  });
});

describe('vínculo ajeno y arranque', () => {
  it('un cliente de Mailway vinculado a otra integración: el plan responde con el error', async () => {
    const proj = createProject('Ajeno', 'ajeno', null, workspaceId);
    createService(proj.id, 'Web', 'web', 'git', gitCfg(['www.ajeno.es']));
    mw.clients.push({ id: 'cli_ajeno', name: 'Ajeno', slug: 'ajeno', externalRef: 'skyway:project:otro', suspended: false, planId: 'pln_2' });
    insertMailwayLink({ project_id: proj.id, client_id: 'cli_ajeno', client_name: 'Ajeno', created_by: null });
    mw.domains.push({ id: 'dom_ajeno', clientId: 'cli_ajeno', domain: 'ajeno.es', status: 'active', ownershipVerifiedAt: 1 });
    const r = await call('POST', `/api/projects/${proj.id}/domain-migrations/plan`, admin(), { fromDomain: 'ajeno.es', toDomain: 'ajeno2.es' });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/vinculado a otra integración/);
    expect(llamadas(/^\/api\/domain-migrations/)).toEqual([]);
    // «Solo la web» no consulta el correo: se puede cambiar la web igualmente.
    const web = await call('POST', `/api/projects/${proj.id}/domain-migrations/plan`, admin(), {
      fromDomain: 'ajeno.es',
      toDomain: 'ajeno2.es',
      soloWeb: true,
    });
    expect(web.status, web.raw).toBe(200);
    expect(web.json.bloqueos).toEqual([]);
  });

  it('marcarCambiosInterrumpidos: los que estaban a mitad quedan con el error para reintentar', () => {
    const proj = createProject('Reinicio', 'reinicio', null, workspaceId);
    const otro = createProject('Reinicio 2', 'reinicio-2', null, workspaceId);
    const a = insertDomainMigration({ project_id: proj.id, from_domain: 'a.es', to_domain: 'b.es', estado: 'pasando', hosts: [], env: { excluidas: [], huella: '' } });
    const b = insertDomainMigration({
      project_id: otro.id,
      from_domain: 'c.es',
      to_domain: 'd.es',
      estado: 'volviendo',
      error: 'Mailway no responde.',
      hosts: [],
      env: { excluidas: [], huella: '' },
    });
    const r = marcarCambiosInterrumpidos();
    expect(r.interrumpidos).toBe(1);
    expect(getDomainMigration(a.id)).toMatchObject({ estado: 'pasando', error: INTERRUMPIDO });
    expect(getDomainMigration(b.id)?.error).toBe('Mailway no responde.');
  });
});

describe('WordPress y fichero de zona (solo la web)', () => {
  let proj: ProjectRow;
  let wp: ServiceRow;
  let base = '';
  let mid = '';

  beforeAll(() => {
    proj = createProject('WordPress', 'wordpress-solo', null, workspaceId);
    wp = createService(proj.id, 'Blog', 'blog', 'image', {
      image: 'wordpress:6-php8.3-apache',
      port: 80,
      stack: 'wordpress',
      domains: ['www.wp-viejo.es'],
      volumes: [{ name: 'skyway-wp-blog-data', containerPath: '/var/www/html' }],
    });
    base = `/api/projects/${proj.id}/domain-migrations`;
  });

  it('plan: fija la URL de WordPress, avisa del reinicio y da la orden de wp search-replace con sus nombres', async () => {
    const r = await call('POST', `${base}/plan`, admin(), { fromDomain: 'wp-viejo.es', toDomain: 'wp-nuevo.es' });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.variables.wordpress).toEqual([{ serviceId: wp.id, serviceName: 'Blog', url: 'http://www.wp-nuevo.es' }]);
    expect(r.json.servicios).toEqual([{ serviceId: wp.id, nombre: 'Blog', reinicio: true }]);
    expect(r.json.avisos.some((a: string) => a.includes("wp search-replace 'https://www.wp-viejo.es' 'https://www.wp-nuevo.es'"))).toBe(true);
    const creada = await call('POST', base, admin(), {
      fromDomain: 'wp-viejo.es',
      toDomain: 'wp-nuevo.es',
      hosts: r.json.hosts.map((h: Json) => ({ serviceId: h.serviceId, from: h.from, to: h.to, modo: h.modo })),
      excluidas: [],
      expect: r.json.expect,
    });
    expect(creada.status, creada.raw).toBe(201);
    mid = creada.json.id;
  });

  it('fichero de zona: los registros A de la web, comentados, hacia la IP del servidor', async () => {
    const r = await app.inject({ method: 'GET', url: `${base}/${mid}/zonefile`, headers: admin() });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/plain/);
    expect(r.headers['content-disposition']).toMatch(/wp-nuevo\.es-cambio-de-dominio\.txt/);
    expect(r.body).toContain(`; www.wp-nuevo.es.\t3600\tIN\tA\t${IP}`);
  });

  it('pasar añade el bloque de WordPress; volver lo quita (la variable no existía)', async () => {
    dnsAqui('www.wp-nuevo.es');
    const vista = (await call('POST', `${base}/${mid}/check`, admin())).json;
    expect(vista.estado).toBe('lista');
    expect(vista.alPasar).toEqual([{ serviceId: wp.id, nombre: 'Blog', reinicio: true }]);
    const r = await call('POST', `${base}/${mid}/switch`, admin(), { expect: vista.variables.huella });
    expect(r.status, r.raw).toBe(202);
    expect(getEnv(wp.id).WORDPRESS_CONFIG_EXTRA).toBe(
      "/* skyway:cambio-de-dominio */define('WP_HOME','http://www.wp-nuevo.es');define('WP_SITEURL','http://www.wp-nuevo.es');/* fin */",
    );
    await esperarTareasCambioDominio();
    const v = await call('POST', `${base}/${mid}/rollback`, admin());
    expect(v.status, v.raw).toBe(202);
    expect(getEnv(wp.id).WORDPRESS_CONFIG_EXTRA).toBeUndefined();
    expect(dominios(wp)).toEqual(['www.wp-viejo.es', 'www.wp-nuevo.es']);
    await esperarTareasCambioDominio();
    // Antes de pasar se puede cancelar: los nombres nuevos siguen en el servicio.
    const c = await call('POST', `${base}/${mid}/cancel`, admin());
    expect(c.status, c.raw).toBe(200);
    expect(c.json.estado).toBe('cancelada');
    expect(getPrepublished('www.wp-nuevo.es')).toBeUndefined();
  });
});

describe('con el correo: cancelar, fichero de zona y actualizar una persona', () => {
  it('cancelar con el MX nuevo apuntando aquí: el error de Mailway tal cual y nada cambia; sin él, se cancela', async () => {
    const p = proyectoConCorreo('cancela', 'cancela.es');
    const { mid, mailwayId } = await preparar(p, 'cancela.es', 'cancela2.es');
    const zona = await app.inject({ method: 'GET', url: `${p.base}/${mid}/zonefile`, headers: ownerHeaders });
    expect(zona.statusCode, zona.body).toBe(200);
    expect(zona.body).toContain('cancela2.es.\t3600\tIN\tMX\t10 mail.example.com.');
    expect(zona.body).toContain(`; www.cancela2.es.\t3600\tIN\tA\t${IP}`);

    dnsAqui('www.cancela2.es');
    marcarListo(mailwayId);
    expect((await call('POST', `${p.base}/${mid}/check`, ownerHeaders)).json.estado).toBe('lista');
    mw.mxNuevoAqui = true;
    try {
      const r = await call('POST', `${p.base}/${mid}/cancel`, ownerHeaders);
      expect(r.status).toBe(409);
      expect(r.json.code).toBe('migration_new_mx_here');
      expect(getDomainMigration(mid)?.estado).toBe('lista');
      expect(getPrepublished('www.cancela2.es')?.migration_id).toBe(mid);
    } finally {
      mw.mxNuevoAqui = false;
    }
    const ok = await call('POST', `${p.base}/${mid}/cancel`, ownerHeaders);
    expect(ok.status, ok.raw).toBe(200);
    expect(ok.json.estado).toBe('cancelada');
    expect(getPrepublished('www.cancela2.es')).toBeUndefined();
    expect(mw.migraciones.find((x) => x.id === mailwayId)?.estado).toBe('cancelada');
    expect(dominios(p.web)).toEqual(['www.cancela.es']);
  });

  it('«Actualizar ahora»: sin aplicaciones, solo el usuario; con ellas, también sus variables y un despliegue con la imagen en marcha', async () => {
    const p = proyectoConCorreo('persona', 'persona.es');
    mw.mailboxes.push({
      id: 'mbx_persona_ana',
      domainId: 'dom_persona',
      domain: 'persona.es',
      localPart: 'ana',
      email: 'ana@persona.es',
      displayName: '',
      quotaMb: 1024,
      status: 'active',
      usedBytes: null,
    });
    const { mid } = await hastaPasada(p, 'persona.es', 'persona2.es');
    mw.calls = [];
    m.triggers = [];
    const ana = await call('POST', `${p.base}/${mid}/mailboxes/mbx_persona_ana/login-update`, ownerHeaders);
    expect(ana.status, ana.raw).toBe(200);
    expect(mw.mailboxes.find((x) => x.id === 'mbx_persona_ana')?.usuarioMotor).toBeNull();
    expect(m.triggers).toEqual([]);
    expect(getEnv(p.web.id).SMTP_USER).toBe('tienda@persona.es');

    const tienda = await call('POST', `${p.base}/${mid}/mailboxes/${p.buzonId}/login-update`, ownerHeaders);
    expect(tienda.status, tienda.raw).toBe(200);
    expect(getEnv(p.web.id).SMTP_USER).toBe('tienda@persona2.es');
    expect(m.triggers).toEqual([{ serviceId: p.web.id, trigger: 'cambio-de-dominio', imageTag: 'skyway/persona-web:v1' }]);
    await esperarTareasCambioDominio();
    expect(getDomainMigration(mid)!.servicios[p.web.id]?.estado).toBe('ok');
    const ajeno = await call('POST', `${p.base}/${mid}/mailboxes/mbx_otro/login-update`, ownerHeaders);
    expect(ajeno.status).toBe(404);
  });

  it('con un cambio abierto, el plan de otro destino lo bloquea', async () => {
    const p = proyectoConCorreo('abierto', 'abierto.es');
    await preparar(p, 'abierto.es', 'abierto2.es');
    const r = await call('POST', `${p.base}/plan`, ownerHeaders, { fromDomain: 'abierto.es', toDomain: 'abierto3.es', soloWeb: true });
    expect(r.status).toBe(200);
    expect(r.json.bloqueos[0]).toMatch(/ya tiene un cambio de dominio abierto \(abierto\.es → abierto2\.es\)/);
  });
});

describe('arranque: seguir los despliegues que estaban en curso', () => {
  it('vuelve a esperar el despliegue y anota su resultado', async () => {
    const proj = createProject('Seguir', 'seguir', null, workspaceId);
    const s = createService(proj.id, 'Web', 'web', 'git', gitCfg([]));
    const dep = createDeployment(s.id, 'cambio-de-dominio');
    const row = insertDomainMigration({
      project_id: proj.id,
      from_domain: 'e.es',
      to_domain: 'f.es',
      estado: 'pasada',
      hosts: [],
      env: { excluidas: [], huella: '' },
      servicios: { [s.id]: { deploymentId: dep.id, estado: 'desplegando', error: null } },
    });
    expect(marcarCambiosInterrumpidos().seguidos).toBeGreaterThanOrEqual(1);
    await esperarTareasCambioDominio();
    expect(getDomainMigration(row.id)!.servicios[s.id]).toMatchObject({ estado: 'ok', deploymentId: dep.id });
  });
});
