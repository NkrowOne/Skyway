/**
 * Token de Cloudflare del administrador y DNS automático de los dominios.
 *
 * - Ajustes → Cloudflare: solo administrador, guardar y borrar con sesión de
 *   navegador, se verifica antes de guardar y el token nunca vuelve.
 * - `tools/cloudflare.ts conectar`: el token solo por la entrada estándar.
 * - DNS automático de los dominios de servicios: crea lo que falta, respeta
 *   lo que existe e informa de los conflictos, solo para un administrador.
 * - Lo esencial: con una acción de un propietario o de un miembro NO sale
 *   ninguna petición (se comprueba con un `fetch` que anota cualquier
 *   llamada), y el administrador tampoco crea registros de los dominios que
 *   un cliente ya había puesto al guardar otra cosa.
 * - Correo: `autoDns` solo viaja en true para el administrador.
 *
 * Cloudflare es el doble de `cloudflarefake.ts`; Mailway, el de `mailwayfake.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { API_TOKEN_PREFIX, hashApiToken } from '../src/auth';
import { aplicarDnsDominios } from '../src/cloudflaredns';
import {
  closeDb,
  createProject,
  createUser,
  createWorkspaceRow,
  deleteCloudflareDnsRecord,
  getCloudflareDnsRecord,
  getMailwayDnsReserva,
  getMailwayLink,
  getSetting,
  getUserByEmail,
  initDb,
  insertApiToken,
  listAudit,
  setSetting,
  setUserProjects,
} from '../src/db';
import { getInfo } from '../src/mailway';
import { ejecutarCloudflare } from '../src/tools/cloudflare';
import type { ProjectRow, UserRow } from '../src/types';
import { hashPassword, randomToken } from '../src/util';
import { CF_HOST, cf, cloudflareFetch, registro, reiniciarCloudflare, zona } from './cloudflarefake';
import { MW_BASE, MW_TOKEN, fakeFetch, mw } from './mailwayfake';

/**
 * La importación de Railway necesita su API: la prueba la sustituye por una
 * que crea el proyecto con los dominios que «trae» de Railway.
 */
const importacion = vi.hoisted(() => ({ dominios: [] as string[] }));
vi.mock('../src/railway/importer', async (original) => {
  const real = await original<typeof import('../src/railway/importer')>();
  const db = await import('../src/db');
  return {
    ...real,
    runRailwayImport: async (_token: string, _id: string, _env: string, opts: { projectName?: string }) => {
      const name = opts.projectName ?? 'importado';
      const project = db.createProject(name, `${name}-${Date.now()}`, null, null);
      db.createService(project.id, 'web', 'web', 'image', { image: 'nginx', port: 80, domains: importacion.dominios } as never);
      const report = { railwayProject: 'De Railway', environment: 'production', created: [{ name: 'web', kind: 'image', notes: [] }] };
      return { project, report };
    },
  };
});

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const IP = '203.0.113.10';
/** Token de usuario (40 caracteres) del operador, con dos zonas. */
const TOKEN_OP = 'OperadorTokenDeCloudflare0123456789abcde';
/** Token de cuenta (cfat_) con las mismas zonas. */
const TOKEN_CUENTA = 'cfat_TokenDeCuentaDelOperador_0123456789';
/** Token válido sin ninguna zona. */
const TOKEN_SIN_ZONAS = 'TokenSinNingunaZona_0123456789abcdefghij';
/** Token que Cloudflare no conoce. */
const TOKEN_DESCONOCIDO = 'TokenQueCloudflareNoConoce_0123456789abc';

let app: FastifyInstance;
let adminCookie = '';
let adminBearer: Record<string, string> = {};
let ownerA: Record<string, string> = {};
let memberA: Record<string, string> = {};
let projAdmin: ProjectRow;
let projA: ProjectRow;
/** Peticiones a los servicios de detección de la IP pública (ipify, ifconfig.me). */
let deteccionesIp = 0;

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
  let parsed: Json = null;
  try {
    parsed = r.json();
  } catch {
    /* sin JSON */
  }
  return { status: r.statusCode, json: parsed, raw: r.body };
}

/** `fetch` de las pruebas: Cloudflare y Mailway son dobles; la detección de la IP no llega a ninguna parte. */
async function fetchDoble(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.host === CF_HOST) return cloudflareFetch(url, init);
  if (url.host === 'api.ipify.org' || url.host === 'ifconfig.me') {
    deteccionesIp++;
    throw new TypeError('fetch failed');
  }
  return fakeFetch(input, init);
}

/** Zonas del operador y registros que ya existían antes de Skyway. */
function prepararCloudflare(): void {
  reiniciarCloudflare();
  const op = zona('operador.com');
  const otra = zona('plataforma.net');
  zona('ajena.org'); // existe en Cloudflare, pero el token no la ve
  cf.tokens.set(TOKEN_OP, { kind: 'user', accountId: 'cuenta1', zoneIds: [op.id, otra.id], status: 'active' });
  cf.tokens.set(TOKEN_CUENTA, { kind: 'account', accountId: 'cuenta1', zoneIds: [op.id, otra.id], status: 'active' });
  cf.tokens.set(TOKEN_SIN_ZONAS, { kind: 'user', accountId: 'cuenta2', zoneIds: [], status: 'active' });
  registro(op, { type: 'A', name: 'existente.operador.com', content: IP });
  registro(op, { type: 'CNAME', name: 'ocupado.operador.com', content: 'proyecto.up.railway.app' });
  registro(op, { type: 'A', name: 'doble.operador.com', content: IP });
  registro(op, { type: 'AAAA', name: 'doble.operador.com', content: '2001:db8::1' });
  registro(op, { type: 'A', name: '*.apps.operador.com', content: IP });
  registro(op, { type: 'TXT', name: 'txt.operador.com', content: 'v=spf1 -all' });
}

/** Registros y llamadas que dejan rastro: lo que Skyway ha escrito en Cloudflare. */
const escrituras = () => cf.calls.filter((c) => c.method !== 'GET');

beforeAll(async () => {
  initDb();
  vi.stubGlobal('fetch', vi.fn(fetchDoble));
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
  adminBearer = bearerFor(getUserByEmail('admin@example.com')!);

  const put = await call('PUT', '/api/mailway/config', admin(), { baseUrl: MW_BASE, token: MW_TOKEN });
  expect(put.status, put.raw).toBe(200);
  setSetting('serverIp', IP);

  projAdmin = createProject('Operador', 'operador', null, null);
  const wsA = createWorkspaceRow('Cliente', { modules_override: JSON.stringify(['mail', 'domains', 'databases']), max_services: 50 });
  projA = createProject('Tienda', 'tienda', null, wsA.id);
  ownerA = bearerFor(createUser('owner@example.com', hashPassword('contraseña1'), 'owner', wsA.id));
  const member = createUser('member@example.com', hashPassword('contraseña1'), 'member', wsA.id);
  setUserProjects(member.id, [projA.id]);
  memberA = bearerFor(member);
  prepararCloudflare();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  closeDb();
});

beforeEach(() => {
  cf.calls = [];
  mw.calls = [];
});

// ======================= Ajustes → Cloudflare =======================

describe('Ajustes → Cloudflare: el token del administrador', () => {
  it('solo el administrador lo consulta o lo cambia; guardar y borrar exigen sesión de navegador', async () => {
    for (const [method, url] of [
      ['GET', '/api/cloudflare/config'],
      ['PUT', '/api/cloudflare/config'],
      ['DELETE', '/api/cloudflare/config'],
      ['POST', '/api/cloudflare/test'],
    ] as const) {
      for (const quien of [ownerA, memberA]) {
        const r = await call(method, url, quien, method === 'GET' || method === 'DELETE' ? undefined : { token: TOKEN_OP });
        expect(r.status, `${method} ${url}`).toBe(403);
      }
    }
    let r = await call('PUT', '/api/cloudflare/config', adminBearer, { token: TOKEN_OP });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/sesión de navegador/);
    r = await call('DELETE', '/api/cloudflare/config', adminBearer);
    expect(r.status).toBe(403);
    r = await call('GET', '/api/cloudflare/config', adminBearer);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ configured: false, hint: null, zones: null, lastError: null });
    expect(r.json.createTokenUrl).toMatch(/^https:\/\/dash\.cloudflare\.com\//);
    expect(cf.calls).toEqual([]);
    expect(getSetting('cloudflare.token')).toBeNull();
  });

  it('no guarda un token con mal formato, la clave global, uno que Cloudflare rechaza ni uno sin zonas', async () => {
    let r = await call('PUT', '/api/cloudflare/config', admin(), { token: 'corto' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/formato válido/);
    r = await call('PUT', '/api/cloudflare/config', admin(), { token: 'con espacios y símbolos que no son de un token' });
    expect(r.status).toBe(400);
    // La clave global se reconoce sin enviarla a Cloudflare.
    r = await call('PUT', '/api/cloudflare/config', admin(), { token: '0123456789abcdef0123456789abcdef01234' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/clave global/);
    expect(cf.calls).toEqual([]);

    r = await call('PUT', '/api/cloudflare/config', admin(), { token: TOKEN_DESCONOCIDO });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/no es válido/);
    expect(r.raw).not.toContain(TOKEN_DESCONOCIDO);
    r = await call('PUT', '/api/cloudflare/config', admin(), { token: TOKEN_SIN_ZONAS });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/ninguna zona/);

    expect(getSetting('cloudflare.token')).toBeNull();
    expect(listAudit({ action: 'cloudflare_token_saved' })).toEqual([]);
  });

  it('guarda el token verificado, nunca lo devuelve y lo audita sin él', async () => {
    const r = await call('PUT', '/api/cloudflare/config', admin(), { token: `  ${TOKEN_OP}\n` });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.config).toMatchObject({ configured: true, hint: TOKEN_OP.slice(-4), lastError: null });
    expect(r.json.config.zones).toMatchObject({ names: ['operador.com', 'plataforma.net'], total: 2 });
    expect(r.raw).not.toContain(TOKEN_OP);
    expect(getSetting('cloudflare.token')).toBe(TOKEN_OP);
    // Se ha verificado con el token como Bearer, y solo con lecturas.
    expect(cf.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /user/tokens/verify', 'GET /zones']);
    expect(cf.calls.every((c) => c.auth === `Bearer ${TOKEN_OP}`)).toBe(true);

    const g = await call('GET', '/api/cloudflare/config', admin());
    expect(g.raw).not.toContain(TOKEN_OP);
    const auditados = listAudit({ action: 'cloudflare_token_saved' });
    expect(auditados).toHaveLength(1);
    expect(auditados[0]).toMatchObject({ actor: 'admin@example.com', target_type: 'system', target_id: 'cloudflare', detail: '2 zona(s) visibles' });
    expect(JSON.stringify(listAudit({}))).not.toContain(TOKEN_OP);
  });

  it('«Probar» con un token escrito no lo guarda; sin token prueba el guardado y anota su fallo', async () => {
    let r = await call('POST', '/api/cloudflare/test', admin(), { token: TOKEN_CUENTA });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.zones.total).toBe(2);
    // Token de cuenta (cfat_): la cuenta sale de sus zonas y se verifica en la ruta de la cuenta.
    expect(cf.calls.map((c) => c.path)).toEqual(['/zones', '/accounts/cuenta1/tokens/verify', '/zones']);
    expect(getSetting('cloudflare.token')).toBe(TOKEN_OP);

    cf.tokens.get(TOKEN_OP)!.status = 'disabled';
    try {
      r = await call('POST', '/api/cloudflare/test', adminBearer, {});
      expect(r.status).toBe(400);
      expect(r.json.error).toMatch(/desactivado o ha caducado/);
      const g = await call('GET', '/api/cloudflare/config', admin());
      expect(g.json.lastError.message).toMatch(/desactivado o ha caducado/);
    } finally {
      cf.tokens.get(TOKEN_OP)!.status = 'active';
    }
    r = await call('POST', '/api/cloudflare/test', admin(), {});
    expect(r.status, r.raw).toBe(200);
    expect((await call('GET', '/api/cloudflare/config', admin())).json.lastError).toBeNull();
  });

  it('«Eliminar» lo borra con lo que se sabía de él y lo audita', async () => {
    let r = await call('DELETE', '/api/cloudflare/config', admin());
    expect(r.status).toBe(200);
    expect(r.json.config).toMatchObject({ configured: false, hint: null, zones: null });
    expect(getSetting('cloudflare.token')).toBeNull();
    expect(getSetting('cloudflare.zones')).toBeNull();
    expect(listAudit({ action: 'cloudflare_token_removed' })).toHaveLength(1);
    // Vuelve a guardarse para lo que sigue.
    r = await call('PUT', '/api/cloudflare/config', admin(), { token: TOKEN_OP });
    expect(r.status, r.raw).toBe(200);
  });
});

describe('la copia de skyway.db, que lleva el token, no sale con un token de API', () => {
  it('un token de API de administrador crea la copia pero no la descarga; la sesión de navegador sí', async () => {
    let r = await call('POST', '/api/system/backups', adminBearer, {});
    expect(r.status, r.raw).toBe(201);
    const fichero = r.json.backup.file as string;
    r = await call('GET', `/api/system/backups/${fichero}/download`, adminBearer);
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/sesión de navegador/);
    expect(r.raw).not.toContain(TOKEN_OP);
    r = await call('GET', `/api/system/backups/${fichero}/download`, admin());
    expect(r.status).toBe(200);
  });
});

// ======================= herramienta de terminal =======================

describe('herramienta cloudflare.js conectar', () => {
  function io(entrada: string) {
    const out: string[] = [];
    const err: string[] = [];
    const leerEntrada = vi.fn(async () => entrada);
    return { out, err, leerEntrada, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), leerEntrada } };
  }
  async function conectar(argv: string[], entrada: string) {
    const r = io(entrada);
    const code = await ejecutarCloudflare(argv, r.io);
    return { code, out: r.out, err: r.err, leerEntrada: r.leerEntrada };
  }

  it('el token jamás se acepta como argumento: ni se lee la entrada ni se llama a Cloudflare', async () => {
    setSetting('cloudflare.token', null);
    for (const argv of [
      ['conectar', '--token', TOKEN_OP],
      ['conectar', '--token'],
      ['conectar', TOKEN_OP],
      [TOKEN_OP, 'conectar'],
      ['conectar', TOKEN_CUENTA],
      ['conectar', 'cfk_clave'],
    ]) {
      const r = await conectar(argv, `${TOKEN_OP}\n`);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err.join('\n')).toMatch(/solo de la entrada estándar/);
      expect(r.err.join('\n')).not.toContain(TOKEN_OP);
      expect(r.out).toEqual([]);
      expect(r.leerEntrada).not.toHaveBeenCalled();
    }
    for (const argv of [[], ['estado'], ['conectar', '--nombre', 'x']]) {
      const r = await conectar(argv, `${TOKEN_OP}\n`);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err.join('\n')).toMatch(/^Uso:/);
      expect(r.leerEntrada).not.toHaveBeenCalled();
    }
    expect(cf.calls).toEqual([]);
    expect(getSetting('cloudflare.token')).toBeNull();
  });

  it('valida la entrada estándar sin repetirla y no guarda un token que Cloudflare rechaza', async () => {
    let r = await conectar(['conectar'], '');
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toMatch(/No ha llegado ningún token/);
    r = await conectar(['conectar'], 'esto no es un token secreto-de-otro\n');
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toMatch(/formato válido/);
    expect(r.err.join('\n')).not.toContain('secreto-de-otro');
    r = await conectar(['conectar'], 'x'.repeat(5000));
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toMatch(/demasiado larga/);
    expect(cf.calls).toEqual([]);

    r = await conectar(['conectar'], `${TOKEN_DESCONOCIDO}\n`);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toMatch(/^Cloudflare: El token de Cloudflare no es válido/);
    expect(r.err.join('\n')).not.toContain(TOKEN_DESCONOCIDO);
    expect(getSetting('cloudflare.token')).toBeNull();
  });

  it('verifica, guarda como Ajustes y audita como «sistema»; repetirlo no deja otra entrada', async () => {
    const antes = listAudit({ action: 'cloudflare_token_saved' }).length;
    let r = await conectar(['conectar'], `${TOKEN_OP}\n`);
    expect(r.code, r.err.join('\n')).toBe(0);
    expect(r.err).toEqual([]);
    expect(r.out).toEqual(['{"ok":true,"zones":2}']);
    expect(r.leerEntrada).toHaveBeenCalledTimes(1);
    expect(getSetting('cloudflare.token')).toBe(TOKEN_OP);
    const auditados = listAudit({ action: 'cloudflare_token_saved' });
    expect(auditados).toHaveLength(antes + 1);
    expect(auditados.find((a) => a.actor === 'sistema')).toMatchObject({ target_type: 'system', target_id: 'cloudflare', ip: null });

    r = await conectar(['conectar'], TOKEN_OP);
    expect(r.code).toBe(0);
    expect(listAudit({ action: 'cloudflare_token_saved' })).toHaveLength(antes + 1);
    const g = await call('GET', '/api/cloudflare/config', admin());
    expect(g.json).toMatchObject({ configured: true, hint: TOKEN_OP.slice(-4) });
  });
});

// ======================= DNS automático (administrador) =======================

describe('DNS automático de los dominios de servicios: administrador', () => {
  let servicioId = '';

  it('al crear un servicio crea lo que falta, respeta lo existente e informa de los conflictos', async () => {
    const dominios = [
      'nuevo.operador.com',
      'existente.operador.com',
      'ocupado.operador.com',
      'doble.operador.com',
      'web.apps.operador.com',
      'txt.operador.com',
      'operador.com',
      'tienda.ajena.org',
    ];
    const r = await call('POST', `/api/projects/${projAdmin.id}/services`, admin(), {
      type: 'image',
      name: 'web',
      image: 'nginx',
      port: 80,
      domains: dominios,
    });
    expect(r.status, r.raw).toBe(201);
    servicioId = r.json.service.id;
    expect(r.json.dns.map((d: Json) => [d.domain, d.action])).toEqual([
      ['nuevo.operador.com', 'created'],
      ['existente.operador.com', 'kept'],
      ['ocupado.operador.com', 'conflict'],
      ['doble.operador.com', 'conflict'],
      ['web.apps.operador.com', 'kept'],
      ['txt.operador.com', 'created'],
      ['operador.com', 'created'],
      ['tienda.ajena.org', 'skipped'],
    ]);
    const porDominio = Object.fromEntries(r.json.dns.map((d: Json) => [d.domain, d.message]));
    expect(porDominio['ocupado.operador.com']).toMatch(/CNAME hacia proyecto\.up\.railway\.app.*no se ha modificado/);
    expect(porDominio['doble.operador.com']).toMatch(/AAAA hacia 2001:db8::1/);
    expect(porDominio['web.apps.operador.com']).toMatch(/comodín \*\.apps\.operador\.com/);
    expect(porDominio['tienda.ajena.org']).toMatch(/Sin zona en tu Cloudflare/);

    // Solo altas, nunca cambios ni borrados: exactamente los tres registros que faltaban.
    expect(escrituras().map((c) => [c.method, (c.body as Json).name])).toEqual([
      ['POST', 'nuevo.operador.com'],
      ['POST', 'txt.operador.com'],
      ['POST', 'operador.com'],
    ]);
    expect(escrituras()[0].body).toEqual({ type: 'A', name: 'nuevo.operador.com', content: IP, ttl: 1, proxied: false, comment: 'Skyway' });
    expect(cf.records.filter((x) => x.name === 'ocupado.operador.com')).toEqual([
      expect.objectContaining({ type: 'CNAME', content: 'proyecto.up.railway.app' }),
    ]);
    expect(cf.calls.every((c) => c.auth === `Bearer ${TOKEN_OP}`)).toBe(true);

    const auditados = listAudit({ action: 'cloudflare_dns_applied' });
    expect(auditados[0]).toMatchObject({ target_type: 'service', target_id: servicioId, actor: 'admin@example.com' });
    expect(auditados[0].detail).toMatch(/^nuevo\.operador\.com: creado; existente\.operador\.com: ya estaba; ocupado\.operador\.com: conflicto/);
    expect(JSON.stringify(listAudit({}))).not.toContain(TOKEN_OP);
  });

  it('al editar, solo los dominios nuevos; guardar otra cosa no llama a Cloudflare', async () => {
    const antes = (await call('GET', `/api/services/${servicioId}`, admin())).json.service.config.domains as string[];
    let r = await call('PATCH', `/api/services/${servicioId}`, admin(), {
      config: { domains: [...antes, 'otro.operador.com'] },
      domainsBase: antes,
    });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.dns).toEqual([{ domain: 'otro.operador.com', action: 'created', message: expect.stringMatching(/creado en la zona operador\.com/) }]);
    expect(cf.calls.every((c) => c.path === '/zones' ? c.query.name !== 'nuevo.operador.com' : true)).toBe(true);
    expect(escrituras()).toHaveLength(1);

    cf.calls = [];
    r = await call('PATCH', `/api/services/${servicioId}`, admin(), {
      name: 'web2',
      config: { domains: [...antes, 'otro.operador.com'] },
      domainsBase: [...antes, 'otro.operador.com'],
    });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.dns).toBeUndefined();
    expect(cf.calls).toEqual([]);
  });

  it('reordenar los dominios no cuenta como añadir ni quitar: ni conflicto ni llamadas a Cloudflare', async () => {
    const antes = (await call('GET', `/api/services/${servicioId}`, admin())).json.service.config.domains as string[];
    expect(antes.length).toBeGreaterThan(1);
    cf.calls = [];
    const r = await call('PATCH', `/api/services/${servicioId}`, admin(), {
      config: { domains: [...antes].reverse() },
      // La base, en otro orden más: lo que cuenta es el conjunto.
      domainsBase: [...antes.slice(1), antes[0]],
    });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.dns).toBeUndefined();
    expect(cf.calls).toEqual([]);
    expect(new Set(r.json.service.config.domains)).toEqual(new Set(antes));
  });

  it('un comodín solo cuenta si resuelve el nombre: si apunta a otro sitio es un conflicto, y con otros registros en el nombre no se aplica', async () => {
    const op = cf.zones.find((z) => z.name === 'operador.com')!;
    const extra = [
      registro(op, { type: 'CNAME', name: '*.ext.operador.com', content: 'proyecto.up.railway.app' }),
      registro(op, { type: 'TXT', name: 'verif.apps.operador.com', content: 'google-site-verification=abc' }),
      registro(op, { type: 'TXT', name: '*.solotxt.operador.com', content: 'v=spf1 -all' }),
      registro(op, { type: 'A', name: '*.lejos.operador.com', content: '198.51.100.20' }),
    ];
    try {
      const r = await aplicarDnsDominios(TOKEN_OP, [
        'app.ext.operador.com',
        'verif.apps.operador.com',
        'x.solotxt.operador.com',
        'a.b.lejos.operador.com',
      ]);
      expect(r.map((d) => [d.domain, d.action])).toEqual([
        // El comodín lo manda a Railway: crear el A le cambiaría el destino.
        ['app.ext.operador.com', 'conflict'],
        // Con un TXT propio, el comodín (que apunta aquí) no se le aplica.
        ['verif.apps.operador.com', 'created'],
        // El comodín más cercano no tiene dirección: se crea el A.
        ['x.solotxt.operador.com', 'created'],
        // Un comodín de más arriba que apunta a otro sitio: ante la duda, conflicto.
        ['a.b.lejos.operador.com', 'conflict'],
      ]);
      expect(r[0].message).toMatch(/comodín \*\.ext\.operador\.com \(un registro CNAME hacia proyecto\.up\.railway\.app\).*no se ha modificado nada/);
      expect(r[3].message).toMatch(/\*\.lejos\.operador\.com/);
      expect(escrituras().map((c) => (c.body as Json).name)).toEqual(['verif.apps.operador.com', 'x.solotxt.operador.com']);
    } finally {
      const quitar = new Set([...extra.map((x) => x.id)]);
      cf.records = cf.records.filter((x) => !quitar.has(x.id) && !['verif.apps.operador.com', 'x.solotxt.operador.com'].includes(x.name));
      for (const d of ['verif.apps.operador.com', 'x.solotxt.operador.com']) deleteCloudflareDnsRecord(d);
    }
  });

  it('con un token de API de administrador también (el que usan el instalador y las automatizaciones)', async () => {
    const actual = (await call('GET', `/api/services/${servicioId}`, admin())).json.service.config.domains as string[];
    const r = await call('PATCH', `/api/services/${servicioId}`, adminBearer, {
      config: { domains: [...actual, 'api.plataforma.net'] },
      domainsBase: actual,
    });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.dns).toEqual([expect.objectContaining({ domain: 'api.plataforma.net', action: 'created' })]);
  });

  it('una pila con dominio', async () => {
    const r = await call('POST', `/api/projects/${projAdmin.id}/stacks`, admin(), { stack: 'n8n', domain: 'flujos.operador.com' });
    expect(r.status, r.raw).toBe(201);
    expect(r.json.dns).toEqual([expect.objectContaining({ domain: 'flujos.operador.com', action: 'created' })]);
    expect(listAudit({ action: 'cloudflare_dns_applied' }).find((a) => a.target_type === 'project')).toMatchObject({
      target_id: projAdmin.id,
      detail: 'flujos.operador.com: creado',
    });
  });

  it('sin la IP pública del servidor no se llama a Cloudflare y se explica', async () => {
    setSetting('serverIp', null);
    try {
      const r = await call('POST', `/api/projects/${projAdmin.id}/services`, admin(), {
        type: 'image',
        name: 'sin-ip',
        image: 'nginx',
        port: 80,
        domains: ['sinip.operador.com'],
      });
      expect(r.status, r.raw).toBe(201);
      expect(r.json.dns).toEqual([{ domain: 'sinip.operador.com', action: 'skipped', message: expect.stringMatching(/IP pública del servidor/) }]);
      expect(cf.calls).toEqual([]);
    } finally {
      setSetting('serverIp', IP);
    }
  });

  it('con el token revocado: el alta sigue, cada dominio dice el motivo y Ajustes lo muestra', async () => {
    const guardado = cf.tokens.get(TOKEN_OP)!;
    cf.tokens.delete(TOKEN_OP);
    try {
      const r = await call('POST', `/api/projects/${projAdmin.id}/services`, admin(), {
        type: 'image',
        name: 'revocado',
        image: 'nginx',
        port: 80,
        domains: ['uno.operador.com', 'dos.operador.com'],
      });
      expect(r.status, r.raw).toBe(201);
      expect(r.json.dns.map((d: Json) => d.action)).toEqual(['error', 'error']);
      expect(r.json.dns[1].message).toMatch(/no es válido/);
      // Con el token rechazado (Cloudflare responde 403/9109 en /zones) no se
      // insiste con el segundo dominio.
      expect(cf.calls).toHaveLength(1);
      expect(cf.calls[0].path).toBe('/zones');
      const g = await call('GET', '/api/cloudflare/config', admin());
      expect(g.json.lastError.message).toMatch(/no es válido/);
    } finally {
      cf.tokens.set(TOKEN_OP, guardado);
    }
  });

  it('un dominio que falló se puede reintentar: solo el administrador, solo ese dominio y solo si sigue en el servicio', async () => {
    const guardado = cf.tokens.get(TOKEN_OP)!;
    cf.tokens.delete(TOKEN_OP);
    let id = '';
    try {
      const r = await call('POST', `/api/projects/${projAdmin.id}/services`, admin(), {
        type: 'image',
        name: 'reintento',
        image: 'nginx',
        port: 80,
        domains: ['reintento.operador.com', 'reintento2.operador.com'],
      });
      expect(r.status, r.raw).toBe(201);
      expect(r.json.dns.map((d: Json) => d.action)).toEqual(['error', 'error']);
      id = r.json.service.id;
    } finally {
      cf.tokens.set(TOKEN_OP, guardado);
    }
    const url = `/api/services/${id}/cloudflare-dns`;
    cf.calls = [];
    for (const quien of [ownerA, memberA]) {
      const r = await call('POST', url, quien, { domain: 'reintento.operador.com' });
      expect(r.status).toBe(403);
    }
    let r = await call('POST', url, admin(), { domain: 'otro-que-no-esta.operador.com' });
    expect(r.status).toBe(404);
    expect(cf.calls).toEqual([]);

    r = await call('POST', url, adminBearer, { domain: ' Reintento.operador.com ' });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.dns).toEqual([expect.objectContaining({ domain: 'reintento.operador.com', action: 'created' })]);
    // Solo el dominio pedido: el otro del servicio no se toca.
    expect(escrituras().map((c) => (c.body as Json).name)).toEqual(['reintento.operador.com']);
    r = await call('POST', url, admin(), { domain: 'reintento.operador.com' });
    expect(r.json.dns).toEqual([expect.objectContaining({ action: 'kept' })]);

    setSetting('cloudflare.token', null);
    try {
      r = await call('POST', url, admin(), { domain: 'reintento2.operador.com' });
      expect(r.status).toBe(400);
      expect(r.json.error).toMatch(/Ajustes → Cloudflare/);
    } finally {
      setSetting('cloudflare.token', TOKEN_OP);
    }
  });

  it('con el token restringido a otras IP: corta el resto, lo explica y Ajustes lo muestra', async () => {
    cf.tokens.get(TOKEN_OP)!.ipRestringido = true;
    try {
      const r = await aplicarDnsDominios(TOKEN_OP, ['ip1.operador.com', 'ip2.operador.com']);
      expect(r.map((d) => d.action)).toEqual(['error', 'error']);
      expect(r[1].message).toMatch(/restringido a otras direcciones IP/);
      expect(cf.calls).toHaveLength(1);
      const g = await call('GET', '/api/cloudflare/config', admin());
      expect(g.json.lastError.message).toMatch(/restringido a otras direcciones IP/);
      // «Probar» da el mismo motivo, no el de un token sin permisos.
      const p = await call('POST', '/api/cloudflare/test', admin(), {});
      expect(p.status).toBe(400);
      expect(p.json.error).toMatch(/restringido a otras direcciones IP/);
    } finally {
      cf.tokens.get(TOKEN_OP)!.ipRestringido = false;
      await call('POST', '/api/cloudflare/test', admin(), {});
    }
  });

  it('el plazo total está acotado: si Cloudflare no responde, cada dominio vuelve con error', async () => {
    cf.hang = true;
    try {
      const inicio = Date.now();
      const r = await aplicarDnsDominios(TOKEN_OP, ['lento.operador.com', 'lento2.operador.com'], { plazoMs: 150 });
      expect(Date.now() - inicio).toBeLessThan(3000);
      expect(r.map((d) => d.action)).toEqual(['error', 'error']);
      expect(r[0].message).toMatch(/no ha respondido a tiempo/);
      expect(cf.calls).toHaveLength(1);
    } finally {
      cf.hang = false;
    }
  });

  it('sin token configurado no hace nada', async () => {
    setSetting('cloudflare.token', null);
    try {
      const r = await call('POST', `/api/projects/${projAdmin.id}/services`, admin(), {
        type: 'image',
        name: 'sin-token',
        image: 'nginx',
        port: 80,
        domains: ['sintoken.operador.com'],
      });
      expect(r.status, r.raw).toBe(201);
      expect(r.json.dns).toBeUndefined();
      expect(cf.calls).toEqual([]);
    } finally {
      setSetting('cloudflare.token', TOKEN_OP);
    }
  });
});

// ======================= importación de Railway =======================

describe('importación de Railway: solo los dominios que el administrador marca', () => {
  it('sin marcar ninguno no se llama a Cloudflare; marcados, solo los del proyecto importado', async () => {
    // Quien añadió dominios al proyecto en Railway pudo poner un nombre libre
    // de las zonas del operador (Railway no exige demostrar la propiedad).
    importacion.dominios = ['rw-login.operador.com', 'tienda-rw.operador.com', 'ocupado.operador.com'];
    const cuerpo = { token: 'token-de-railway-0123', projectId: 'rw1', environmentId: 'env1' };
    let r = await call('POST', '/api/import/railway/run', admin(), { ...cuerpo, projectName: 'rw-uno' });
    expect(r.status, r.raw).toBe(201);
    expect(r.json.dns).toBeUndefined();
    expect(cf.calls).toEqual([]);

    importacion.dominios = ['rw-login2.operador.com', 'tienda2-rw.operador.com', 'ocupado.operador.com'];
    r = await call('POST', '/api/import/railway/run', admin(), {
      ...cuerpo,
      projectName: 'rw-dos',
      // Uno que no está en el proyecto importado no se configura aunque se envíe.
      dnsDomains: ['tienda2-rw.operador.com', 'OCUPADO.operador.com', 'inventado.operador.com'],
    });
    expect(r.status, r.raw).toBe(201);
    expect(r.json.dns.map((d: Json) => [d.domain, d.action])).toEqual([
      ['tienda2-rw.operador.com', 'created'],
      ['ocupado.operador.com', 'conflict'],
    ]);
    expect(escrituras().map((c) => (c.body as Json).name)).toEqual(['tienda2-rw.operador.com']);
    expect(cf.calls.some((c) => JSON.stringify(c).includes('rw-login2') || JSON.stringify(c).includes('inventado'))).toBe(false);
  });
});

// ======================= clientes: nunca el token del operador =======================

describe('propietarios y miembros: nunca se usa el token del operador', () => {
  it('ni al crear servicios o pilas ni al editar dominios sale una sola petición, aunque el dominio viva en las zonas del operador', async () => {
    expect(getSetting('cloudflare.token')).toBe(TOKEN_OP);
    // Cualquier llamada de red queda anotada (y falla): no debe haber ninguna.
    const llamadas: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        llamadas.push(String(input instanceof Request ? input.url : input));
        throw new Error('Llamada de red prohibida en esta prueba');
      }),
    );
    try {
      let r = await call('POST', `/api/projects/${projA.id}/services`, ownerA, {
        type: 'image',
        name: 'web',
        image: 'nginx',
        port: 80,
        domains: ['cliente1.operador.com'],
      });
      expect(r.status, r.raw).toBe(201);
      expect(r.json.dns).toBeUndefined();
      const id = r.json.service.id as string;

      r = await call('PATCH', `/api/services/${id}`, memberA, { config: { domains: ['cliente1.operador.com', 'cliente2.operador.com'] } });
      expect(r.status, r.raw).toBe(200);
      expect(r.json.dns).toBeUndefined();
      r = await call('PATCH', `/api/services/${id}`, ownerA, {
        config: { domains: ['cliente1.operador.com', 'cliente2.operador.com', 'cliente3.plataforma.net'] },
      });
      expect(r.status, r.raw).toBe(200);
      expect(r.json.dns).toBeUndefined();

      r = await call('POST', `/api/projects/${projA.id}/stacks`, memberA, { stack: 'n8n', domain: 'cliente4.operador.com' });
      expect(r.status, r.raw).toBe(201);
      expect(r.json.dns).toBeUndefined();

      expect(llamadas).toEqual([]);
      expect(listAudit({ action: 'cloudflare_dns_applied' }).filter((a) => /cliente\d/.test(String(a.detail)))).toEqual([]);

      // Un administrador que después guarda ese servicio (con otro dominio
      // nuevo) no crea los registros de los dominios que puso el cliente.
      vi.stubGlobal('fetch', vi.fn(fetchDoble));
      cf.calls = [];
      r = await call('PATCH', `/api/services/${id}`, admin(), {
        config: { domains: ['cliente1.operador.com', 'cliente2.operador.com', 'cliente3.plataforma.net', 'admin.operador.com'] },
        domainsBase: ['cliente1.operador.com', 'cliente2.operador.com', 'cliente3.plataforma.net'],
      });
      expect(r.status, r.raw).toBe(200);
      expect(r.json.dns.map((d: Json) => d.domain)).toEqual(['admin.operador.com']);
      expect(cf.calls.some((c) => JSON.stringify(c).includes('cliente'))).toBe(false);
      expect(cf.records.filter((x) => x.name.startsWith('cliente'))).toEqual([]);
    } finally {
      vi.stubGlobal('fetch', vi.fn(fetchDoble));
    }
  });
});

// ======================= correo =======================

describe('correo: el DNS automático de Mailway solo lo pide el administrador', () => {
  it('el administrador manda autoDns true; propietario y miembro, false y con soloCliente', async () => {
    let r = await call('POST', `/api/projects/${projA.id}/mail/link`, ownerA, { mode: 'create' });
    expect(r.status, r.raw).toBe(201);
    mw.calls = [];

    r = await call('POST', `/api/projects/${projA.id}/mail/domains`, admin(), { domain: 'correo-admin.com' });
    expect(r.status, r.raw).toBe(201);
    expect(r.json.cloudflare).toEqual({ applied: [{ action: 'create', type: 'MX', name: 'correo-admin.com' }], errors: [], skipped: [] });
    expect(r.json.cloudflareReason).toBeNull();
    r = await call('POST', `/api/projects/${projA.id}/mail/domains`, ownerA, { domain: 'correo-owner.com' });
    expect(r.status, r.raw).toBe(201);
    expect(r.json.cloudflare).toBeNull();
    r = await call('POST', `/api/projects/${projA.id}/mail/domains`, memberA, { domain: 'correo-member.com' });
    expect(r.status, r.raw).toBe(201);
    expect(r.json.cloudflare).toBeNull();

    const clientId = getMailwayLink(projA.id)!.client_id;
    const altas = mw.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/api/domains'));
    expect(altas.map((c) => [c.path, c.body])).toEqual([
      ['/api/domains', { domain: 'correo-admin.com', clientId, autoDns: true }],
      ['/api/domains?soloCliente=1', { domain: 'correo-owner.com', clientId, autoDns: false }],
      ['/api/domains?soloCliente=1', { domain: 'correo-member.com', clientId, autoDns: false }],
    ]);
    // Skyway no llama a Cloudflare por su cuenta para el correo: lo hace Mailway.
    expect(cf.calls).toEqual([]);
    expect(listAudit({ action: 'mailway_domain_added' }).map((a) => a.detail)).toEqual(
      expect.arrayContaining(['Tienda: correo-admin.com (DNS en Cloudflare: 1 cambio(s))', 'Tienda: correo-owner.com']),
    );
  });

  it('un dominio que el administrador asoció a una cuenta de la instancia: sin cuenta propia, el cliente no pide ni el plan ni la aplicación', async () => {
    const clientId = getMailwayLink(projA.id)!.client_id;
    const dom = mw.domains.find((d) => d.domain === 'correo-admin.com')!;
    const url = `/api/projects/${projA.id}/mail/domains/${dom.id}/cloudflare`;
    const planes = () => mw.calls.filter((c) => c.path.startsWith(`/api/domains/${dom.id}/cloudflare`));
    // Como deja Mailway el dominio tras aplicar el DNS automático del administrador.
    mw.cloudflareAccounts = [{ id: 'cfa_instancia', clientId: null, label: 'Operador' }];
    dom.cloudflareAccountId = 'cfa_instancia';
    try {
      for (const quien of [ownerA, memberA]) {
        mw.calls = [];
        const r = await call('GET', url, quien);
        expect(r.status, r.raw).toBe(200);
        expect(r.json).toMatchObject({ available: false, account: null, zone: null, changes: [] });
        expect(r.json.reason).toMatch(/lo gestiona el administrador de la plataforma.*Conecta en Mailway una cuenta de Cloudflare del cliente/);
        expect(planes()).toEqual([]);
        // Solo se han consultado las cuentas del propio cliente.
        expect(mw.calls.filter((c) => c.path.startsWith('/api/cloudflare/accounts')).map((c) => c.path)).toEqual([
          `/api/cloudflare/accounts?clientId=${clientId}`,
        ]);
      }
      mw.calls = [];
      let r = await call('POST', `${url}/apply`, ownerA, {});
      expect(r.status).toBe(409);
      expect(r.json.error).toMatch(/lo gestiona el administrador de la plataforma/);
      expect(planes()).toEqual([]);

      // El administrador sí (es su cuenta).
      mw.calls = [];
      r = await call('GET', url, admin());
      expect(r.status, r.raw).toBe(200);
      expect(planes().map((c) => c.path)).toEqual([`/api/domains/${dom.id}/cloudflare`]);

      // Asociado a una cuenta del propio cliente, el cliente la usa (con soloCliente).
      mw.cloudflareAccounts.push({ id: 'cfa_cliente', clientId, label: 'Del cliente' });
      dom.cloudflareAccountId = 'cfa_cliente';
      mw.calls = [];
      r = await call('GET', url, ownerA);
      expect(r.status, r.raw).toBe(200);
      expect(r.json.available).toBe(true);
      expect(planes().map((c) => c.path)).toEqual([`/api/domains/${dom.id}/cloudflare?soloCliente=1`]);
    } finally {
      dom.cloudflareAccountId = null;
      mw.cloudflareAccounts = [];
    }
  });

  it('con una cuenta propia conectada, el cliente deja de estar bloqueado solo si Mailway garantiza no usar la de la instancia', async () => {
    const clientId = getMailwayLink(projA.id)!.client_id;
    const dom = mw.domains.find((d) => d.domain === 'correo-admin.com')!;
    const url = `/api/projects/${projA.id}/mail/domains/${dom.id}/cloudflare`;
    const planes = () => mw.calls.filter((c) => c.path.startsWith(`/api/domains/${dom.id}/cloudflare`));
    mw.cloudflareAccounts = [
      { id: 'cfa_instancia', clientId: null, label: 'Operador' },
      { id: 'cfa_cliente', clientId, label: 'Del cliente' },
    ];
    dom.cloudflareAccountId = 'cfa_instancia';
    try {
      // Mailway 1.1 (`cloudflareSoloCrear`): con soloCliente ignora la cuenta
      // de la instancia y prueba las del cliente, así que se le llama.
      mw.calls = [];
      let r = await call('GET', url, ownerA);
      expect(r.status, r.raw).toBe(200);
      expect(r.json.available).toBe(true);
      r = await call('POST', `${url}/apply`, ownerA, {});
      expect(r.status, r.raw).toBe(200);
      expect(planes().map((c) => c.path)).toEqual([
        `/api/domains/${dom.id}/cloudflare?soloCliente=1`,
        `/api/domains/${dom.id}/cloudflare/apply?soloCliente=1`,
      ]);

      // Un Mailway anterior usaría la cuenta guardada del operador también con
      // soloCliente: no se le llama, y el mensaje no promete que conectar una
      // cuenta propia lo resuelva.
      mw.infoOverride = { version: '1.0.0', features: { cloudflare: true, autoconfig: true, portal: true } };
      await call('POST', '/api/mailway/test', admin(), {});
      mw.calls = [];
      r = await call('GET', url, ownerA);
      expect(r.status, r.raw).toBe(200);
      expect(r.json.available).toBe(false);
      expect(r.json.reason).toMatch(/Solicita al administrador que aplique los cambios/);
      expect(r.json.reason).not.toMatch(/Conecta/);
      r = await call('POST', `${url}/apply`, ownerA, {});
      expect(r.status).toBe(409);
      expect(planes()).toEqual([]);
    } finally {
      mw.infoOverride = {};
      await call('POST', '/api/mailway/test', admin(), {});
      dom.cloudflareAccountId = null;
      mw.cloudflareAccounts = [];
    }
  });

  it('con un Mailway anterior a la 1.1 (sin cloudflareSoloCrear) no se pide el DNS automático y se explica; sin Cloudflare en Mailway, ni se pide ni se avisa', async () => {
    const altas = () => mw.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/api/domains'));
    const registrosWebmail = () => mw.calls.filter((c) => c.method === 'POST' && /^\/api\/whitelabel\/domains\/[^/]+\/cloudflare/.test(c.path));
    const idDe = async (d: string) =>
      ((await call('GET', `/api/projects/${projA.id}/mail`, admin())).json.summary.domains as Json[]).find((x) => x.domain === d).id as string;
    try {
      mw.infoOverride = { version: '1.0.0', features: { cloudflare: true, autoconfig: true, portal: true } };
      await call('POST', '/api/mailway/test', admin(), {});
      mw.calls = [];
      let r = await call('POST', `/api/projects/${projA.id}/mail/domains`, admin(), { domain: 'correo-antiguo.com' });
      expect(r.status, r.raw).toBe(201);
      expect(r.json.cloudflare).toBeNull();
      expect(r.json.cloudflareReason).toMatch(/versión de Mailway conectada \(1\.0\.0\) no garantiza.*1\.1 o posterior.*Configurar en Cloudflare/);
      expect(altas().map((c) => (c.body as Json).autoDns)).toEqual([false]);

      // El registro del webmail tampoco se pide (Mailway le quitaría el proxy a uno existente).
      mw.calls = [];
      r = await call('POST', `/api/projects/${projA.id}/mail/domains/${await idDe('correo-antiguo.com')}/webmail`, admin());
      expect(r.status, r.raw).toBe(201);
      expect(r.json.cloudflare).toBeNull();
      expect(r.json.cloudflareReason).toMatch(/no garantiza.*Crear registro en Cloudflare/);
      expect(registrosWebmail()).toEqual([]);

      // Sin ninguna cuenta de Cloudflare en Mailway: no se pide y no hay aviso que remita a otra pantalla.
      mw.infoOverride = { features: { cloudflare: false, autoconfig: true, portal: true, cloudflareSoloCrear: true } };
      await call('POST', '/api/mailway/test', admin(), {});
      mw.calls = [];
      r = await call('POST', `/api/projects/${projA.id}/mail/domains`, admin(), { domain: 'correo-sin-cf.com' });
      expect(r.status, r.raw).toBe(201);
      expect(r.json.cloudflare).toBeNull();
      expect(r.json.cloudflareReason).toBeNull();
      expect(altas().map((c) => (c.body as Json).autoDns)).toEqual([false]);
    } finally {
      mw.infoOverride = {};
      await call('POST', '/api/mailway/test', admin(), {});
    }
    // De vuelta a Mailway 1.1: el administrador lo pide.
    mw.calls = [];
    const r = await call('POST', `/api/projects/${projA.id}/mail/domains`, admin(), { domain: 'correo-nuevo.com' });
    expect(r.status, r.raw).toBe(201);
    expect(altas().map((c) => (c.body as Json).autoDns)).toEqual([true]);
  });

  it('el webmail con dominio propio: el registro se crea solo cuando lo configura el administrador', async () => {
    const dominios = (await call('GET', `/api/projects/${projA.id}/mail`, admin())).json.summary.domains as Json[];
    const idDe = (d: string) => dominios.find((x) => x.domain === d).id as string;
    const cloudflareCalls = () => mw.calls.filter((c) => c.method === 'POST' && /^\/api\/whitelabel\/domains\/[^/]+\/cloudflare/.test(c.path));

    let r = await call('POST', `/api/projects/${projA.id}/mail/domains/${idDe('correo-owner.com')}/webmail`, ownerA);
    expect(r.status, r.raw).toBe(201);
    expect(r.json.cloudflare).toBeUndefined();
    expect(cloudflareCalls()).toEqual([]);

    r = await call('POST', `/api/projects/${projA.id}/mail/domains/${idDe('correo-admin.com')}/webmail`, admin());
    expect(r.status, r.raw).toBe(201);
    expect(r.json.cloudflare).toEqual({ applied: [{ action: 'create', type: 'CNAME', name: 'webmail.correo-admin.com' }], errors: [], skipped: [] });
    // Sin soloCliente: es el administrador quien lo pide.
    expect(cloudflareCalls().map((c) => c.path)).toEqual([expect.stringMatching(/^\/api\/whitelabel\/domains\/[^/?]+\/cloudflare$/)]);
    // Automático: solo crear, sin modificar un registro que ya exista (ni su proxy).
    expect(cloudflareCalls()[0].body).toEqual({ soloCrear: true });
    expect(listAudit({ action: 'mailway_webmail_dns_applied' })[0].detail).toMatch(/automático al configurarlo/);

    // Si Mailway no tiene ninguna cuenta de Cloudflare, ni se intenta.
    mw.infoOverride = { features: { cloudflare: false, autoconfig: true, portal: true } };
    try {
      await call('POST', '/api/mailway/test', admin(), {});
      mw.calls = [];
      r = await call('POST', `/api/projects/${projA.id}/mail/domains/${idDe('correo-member.com')}/webmail`, admin());
      expect(r.status, r.raw).toBe(201);
      expect(r.json.cloudflare).toBeUndefined();
      expect(cloudflareCalls()).toEqual([]);
    } finally {
      mw.infoOverride = {};
    }
  });
});

// ======================= concurrencia: lo que el administrador no ha escrito =======================

describe('el administrador solo crea registros de los dominios que añade él en esa petición', () => {
  it('un formulario abierto antes de que el cliente quitara un dominio no lo vuelve a poner ni crea su registro', async () => {
    let r = await call('POST', `/api/projects/${projA.id}/services`, ownerA, {
      type: 'image',
      name: 'formulario',
      image: 'nginx',
      port: 80,
      domains: ['login.operador.com'],
    });
    expect(r.status, r.raw).toBe(201);
    const id = r.json.service.id as string;
    // El administrador abre Ajustes: el formulario carga la lista de ahora.
    const formulario = (await call('GET', `/api/services/${id}`, admin())).json.service.config as Json;
    expect(formulario.domains).toEqual(['login.operador.com']);
    // Mientras edita otra cosa, el cliente quita el dominio.
    r = await call('PATCH', `/api/services/${id}`, ownerA, { config: { domains: [] }, domainsBase: ['login.operador.com'] });
    expect(r.status, r.raw).toBe(200);

    // Guarda la memoria (la web reenvía la lista que cargó y su base): los
    // dominios actuales se conservan y no sale ninguna petición a Cloudflare.
    cf.calls = [];
    r = await call('PATCH', `/api/services/${id}`, admin(), {
      config: { port: 80, memoryMb: 512, domains: formulario.domains },
      domainsBase: formulario.domains,
    });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.service.config.domains).toEqual([]);
    expect(r.json.service.config.memoryMb).toBe(512);
    expect(r.json.dns).toBeUndefined();
    expect(cf.calls).toEqual([]);

    // Si además había tocado los dominios, se le pide recargar: nada cambia.
    r = await call('PATCH', `/api/services/${id}`, admin(), {
      config: { domains: ['login.operador.com', 'nuevo-admin.operador.com'] },
      domainsBase: ['login.operador.com'],
    });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/han cambiado mientras los editabas/);
    expect((await call('GET', `/api/services/${id}`, admin())).json.service.config.domains).toEqual([]);
    expect(cf.calls).toEqual([]);
    expect(cf.records.filter((x) => x.name === 'login.operador.com')).toEqual([]);
  });

  it('sin domainsBase (una automatización que lee y reenvía la lista) no se usa el token y se explica', async () => {
    let r = await call('POST', `/api/projects/${projA.id}/services`, ownerA, {
      type: 'image',
      name: 'automatizacion',
      image: 'nginx',
      port: 80,
    });
    expect(r.status, r.raw).toBe(201);
    const id = r.json.service.id as string;
    cf.calls = [];
    r = await call('PATCH', `/api/services/${id}`, adminBearer, { config: { domains: ['cuenta.operador.com'] } });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.service.config.domains).toEqual(['cuenta.operador.com']);
    expect(r.json.dns).toEqual([{ domain: 'cuenta.operador.com', action: 'skipped', message: expect.stringMatching(/domainsBase/) }]);
    expect(cf.calls).toEqual([]);
    // Un propietario sin base: ni petición ni explicación (nunca hay DNS para él).
    r = await call('PATCH', `/api/services/${id}`, ownerA, { config: { domains: ['cuenta.operador.com', 'otra-cuenta.operador.com'] } });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.dns).toBeUndefined();
    expect(cf.calls).toEqual([]);
  });

  it('el alta con plan usa los dominios de la petición, no los que el cliente añade mientras se consulta GitHub', async () => {
    let liberar: (() => void) | null = null;
    let avisar: (() => void) | null = null;
    const consultando = new Promise<void>((resolve) => (avisar = resolve));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.host === 'api.github.com') {
          avisar?.();
          await new Promise<void>((resolve) => (liberar = resolve));
          return new Response(JSON.stringify({ tree: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return fetchDoble(input, init);
      }),
    );
    try {
      cf.calls = [];
      const alta = call('POST', `/api/projects/${projA.id}/services`, admin(), {
        type: 'git',
        name: 'con-plan',
        repoUrl: 'https://github.com/cliente/web',
        domains: ['plan.ajena.org'],
        plan: {},
      });
      await consultando;
      const servicio = (await call('GET', `/api/projects/${projA.id}`, admin())).json.services.find((s: Json) => s.name === 'con-plan');
      const r1 = await call('PATCH', `/api/services/${servicio.id}`, ownerA, {
        config: { domains: ['plan.ajena.org', 'durante-el-plan.operador.com'] },
        domainsBase: ['plan.ajena.org'],
      });
      expect(r1.status, r1.raw).toBe(200);
      liberar!();
      const r = await alta;
      expect(r.status, r.raw).toBe(201);
      expect(r.json.dns.map((d: Json) => d.domain)).toEqual(['plan.ajena.org']);
      expect(cf.calls.some((c) => JSON.stringify(c).includes('durante-el-plan'))).toBe(false);
      expect(cf.records.filter((x) => x.name === 'durante-el-plan.operador.com')).toEqual([]);
    } finally {
      vi.stubGlobal('fetch', vi.fn(fetchDoble));
    }
  });
});

// ======================= registros creados: reserva y limpieza =======================

describe('los registros que crea el DNS automático quedan reservados hasta que el administrador los borra', () => {
  let projB: ProjectRow;
  let ownerB: Record<string, string> = {};

  beforeAll(() => {
    const wsB = createWorkspaceRow('Otro cliente', { modules_override: JSON.stringify(['domains', 'databases']), max_services: 50 });
    projB = createProject('Otra tienda', 'otra-tienda', null, wsB.id);
    ownerB = bearerFor(createUser('owner-b@example.com', hashPassword('contraseña1'), 'owner', wsB.id));
  });

  it('otro cliente no puede asignarse un nombre del operador que el administrador creó para un proyecto', async () => {
    // El administrador da al servicio del cliente A un nombre de su zona.
    let r = await call('POST', `/api/projects/${projA.id}/services`, admin(), {
      type: 'image',
      name: 'reservado',
      image: 'nginx',
      port: 80,
      domains: ['clientea.operador.com'],
    });
    expect(r.status, r.raw).toBe(201);
    expect(r.json.dns).toEqual([expect.objectContaining({ domain: 'clientea.operador.com', action: 'created' })]);
    const idA = r.json.service.id as string;
    // Se quita del servicio: el registro A sigue apuntando aquí.
    r = await call('PATCH', `/api/services/${idA}`, ownerA, { config: { domains: [] }, domainsBase: ['clientea.operador.com'] });
    expect(r.status, r.raw).toBe(200);
    expect(cf.records.filter((x) => x.name === 'clientea.operador.com')).toHaveLength(1);

    // El cliente B no puede quedárselo, ni al crear ni al editar.
    r = await call('POST', `/api/projects/${projB.id}/services`, ownerB, {
      type: 'image',
      name: 'toma',
      image: 'nginx',
      port: 80,
      domains: ['clientea.operador.com'],
    });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/reservado por el administrador/);
    r = await call('POST', `/api/projects/${projB.id}/services`, ownerB, { type: 'image', name: 'toma', image: 'nginx', port: 80 });
    expect(r.status, r.raw).toBe(201);
    const idB = r.json.service.id as string;
    r = await call('PATCH', `/api/services/${idB}`, ownerB, { config: { domains: ['clientea.operador.com'] } });
    expect(r.status).toBe(409);
    r = await call('POST', `/api/projects/${projB.id}/stacks`, ownerB, { stack: 'n8n', domain: 'clientea.operador.com' });
    expect(r.status).toBe(409);

    // El proyecto para el que se creó sí puede volver a usarlo.
    r = await call('PATCH', `/api/services/${idA}`, ownerA, { config: { domains: ['clientea.operador.com'] }, domainsBase: [] });
    expect(r.status, r.raw).toBe(200);
  });

  it('si Cloudflare crea el registro pero la respuesta se pierde, al reintentarlo queda reservado igual', async () => {
    cf.cortarTrasCrear = true;
    let r = await call('POST', `/api/projects/${projA.id}/services`, admin(), {
      type: 'image',
      name: 'perdida',
      image: 'nginx',
      port: 80,
      domains: ['perdida.operador.com'],
    });
    expect(r.status, r.raw).toBe(201);
    expect(r.json.dns).toEqual([expect.objectContaining({ domain: 'perdida.operador.com', action: 'error' })]);
    // El registro existe en la zona del operador, pero Skyway no llegó a anotarlo.
    expect(cf.records.filter((x) => x.name === 'perdida.operador.com')).toHaveLength(1);
    expect(getCloudflareDnsRecord('perdida.operador.com')).toBeUndefined();
    const id = r.json.service.id as string;

    // El reintento lo encuentra (es suyo, lleva el comentario de Skyway) y lo reserva.
    r = await call('POST', `/api/services/${id}/cloudflare-dns`, admin(), { domain: 'perdida.operador.com' });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.dns).toEqual([expect.objectContaining({ domain: 'perdida.operador.com', action: 'kept' })]);
    expect(getCloudflareDnsRecord('perdida.operador.com')?.project_id).toBe(projA.id);

    // Se quita del servicio y otro cliente no puede quedárselo.
    r = await call('PATCH', `/api/services/${id}`, ownerA, { config: { domains: [] }, domainsBase: ['perdida.operador.com'] });
    expect(r.status, r.raw).toBe(200);
    r = await call('POST', `/api/projects/${projB.id}/services`, ownerB, {
      type: 'image',
      name: 'toma-perdida',
      image: 'nginx',
      port: 80,
      domains: ['perdida.operador.com'],
    });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/reservado por el administrador/);
  });

  it('un A ajeno hacia este servidor (sin el comentario de Skyway) no se reserva al reintentarlo', async () => {
    const z = cf.zones.find((x) => x.name === 'operador.com')!;
    registro(z, { type: 'A', name: 'a-mano.operador.com', content: '203.0.113.10', comment: 'puesto a mano' });
    const r = await call('POST', `/api/projects/${projA.id}/services`, admin(), {
      type: 'image',
      name: 'a-mano',
      image: 'nginx',
      port: 80,
      domains: ['a-mano.operador.com'],
    });
    expect(r.status, r.raw).toBe(201);
    expect(r.json.dns).toEqual([expect.objectContaining({ action: 'kept' })]);
    expect(getCloudflareDnsRecord('a-mano.operador.com')).toBeUndefined();
  });

  it('los nombres que Mailway crea para el administrador (autoconfig, autodiscover, webmail) tampoco se los queda otro cliente', async () => {
    let r: Awaited<ReturnType<typeof call>>;
    // El correo del proyecto puede estar ya activado por una prueba anterior.
    if (!getMailwayLink(projA.id)) {
      r = await call('POST', `/api/projects/${projA.id}/mail/link`, ownerA, { mode: 'create' });
      expect(r.status, r.raw).toBe(201);
    }
    // Mailway 1.1 con Cloudflare (otra prueba pudo dejar en la caché una información anterior).
    mw.infoOverride = {};
    await getInfo({ fresh: true });
    mw.autoDnsConAutoconfig = true;
    try {
      r = await call('POST', `/api/projects/${projA.id}/mail/domains`, admin(), { domain: 'reservas.operador.com' });
      expect(r.json.cloudflare?.applied).toHaveLength(3);
      expect(r.status, r.raw).toBe(201);
    } finally {
      mw.autoDnsConAutoconfig = false;
    }
    expect(getMailwayDnsReserva('autoconfig.reservas.operador.com')?.project_id).toBe(projA.id);
    expect(getMailwayDnsReserva('autodiscover.reservas.operador.com')?.project_id).toBe(projA.id);
    // El MX no es un nombre que un servicio pueda usar: no se reserva.
    expect(getMailwayDnsReserva('reservas.operador.com')).toBeUndefined();

    // Aunque el dominio de correo se borre y el puente deje de publicarlos, otro cliente no puede asignárselos.
    mw.domains = mw.domains.filter((d) => d.domain !== 'reservas.operador.com');
    for (const nombre of ['autoconfig.reservas.operador.com', 'autodiscover.reservas.operador.com']) {
      r = await call('POST', `/api/projects/${projB.id}/services`, ownerB, {
        type: 'image',
        name: `toma-${nombre.split('.')[0]}`,
        image: 'nginx',
        port: 80,
        domains: [nombre],
      });
      expect(r.status, nombre).toBe(409);
      expect(r.json.error).toMatch(/reservado por el administrador/);
    }
    // El proyecto para el que se crearon sí puede usarlos.
    r = await call('POST', `/api/projects/${projA.id}/services`, ownerA, {
      type: 'image',
      name: 'autoconfig-propio',
      image: 'nginx',
      port: 80,
      domains: ['autoconfig.reservas.operador.com'],
    });
    expect(r.status, r.raw).toBe(201);
  });

  it('lo que crea un cliente con su propia cuenta no se reserva (es su zona)', async () => {
    const r = await call('POST', `/api/projects/${projA.id}/mail/domains`, ownerA, { domain: 'propio-cliente.com' });
    expect(r.status, r.raw).toBe(201);
    expect(getMailwayDnsReserva('autoconfig.propio-cliente.com')).toBeUndefined();
  });

  it('Ajustes → Cloudflare los lista y los borra solo si nadie los usa ni los ha cambiado', async () => {
    // Solo el administrador.
    expect((await call('GET', '/api/cloudflare/records', ownerA)).status).toBe(403);
    expect((await call('DELETE', '/api/cloudflare/records/clientea.operador.com', ownerA)).status).toBe(403);

    let r = await call('GET', '/api/cloudflare/records', admin());
    expect(r.status, r.raw).toBe(200);
    const fila = (r.json.records as Json[]).find((x) => x.domain === 'clientea.operador.com');
    expect(fila).toMatchObject({ zone: 'operador.com', content: IP, project: { id: projA.id, name: 'Tienda' } });
    expect(fila.usedBy).toMatchObject({ name: 'reservado', project: 'Tienda' });
    expect(JSON.stringify(r.json)).not.toContain(TOKEN_OP);

    // En uso: no se borra nada.
    cf.calls = [];
    r = await call('DELETE', '/api/cloudflare/records/clientea.operador.com', admin());
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/sigue asignado al servicio «Tienda \/ reservado»/);
    expect(cf.calls).toEqual([]);

    const svc = (await call('GET', `/api/projects/${projA.id}`, admin())).json.services.find((s: Json) => s.name === 'reservado');
    r = await call('PATCH', `/api/services/${svc.id}`, ownerA, { config: { domains: [] }, domainsBase: ['clientea.operador.com'] });
    expect(r.status, r.raw).toBe(200);

    // Modificado en Cloudflare (otro comentario) y apuntando aquí: no se toca y sigue reservado.
    const enCf = cf.records.find((x) => x.name === 'clientea.operador.com')!;
    enCf.comment = 'Lo uso para otra cosa';
    r = await call('DELETE', '/api/cloudflare/records/clientea.operador.com', admin());
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/se ha modificado en Cloudflare/);
    expect(cf.records).toContain(enCf);
    expect(cf.calls.filter((c) => c.method === 'DELETE')).toEqual([]);

    // Tal como lo creó Skyway: se borra y el nombre queda libre.
    enCf.comment = 'Skyway';
    r = await call('DELETE', '/api/cloudflare/records/clientea.operador.com', admin());
    expect(r.status, r.raw).toBe(200);
    expect(r.json.result).toBe('deleted');
    expect(cf.records.filter((x) => x.name === 'clientea.operador.com')).toEqual([]);
    expect(cf.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`/zones/zona_operador_com/dns_records/${enCf.id}`]);
    expect(listAudit({ action: 'cloudflare_dns_record_deleted' })[0]).toMatchObject({ detail: 'clientea.operador.com: registro borrado' });
    expect((r.json.records as Json[]).some((x) => x.domain === 'clientea.operador.com')).toBe(false);

    r = await call('POST', `/api/projects/${projB.id}/services`, ownerB, {
      type: 'image',
      name: 'libre',
      image: 'nginx',
      port: 80,
      domains: ['clientea.operador.com'],
    });
    expect(r.status, r.raw).toBe(201);
  });

  it('si el administrador asigna el nombre a otro proyecto, la reserva pasa a ese proyecto', async () => {
    let r = await call('POST', `/api/projects/${projAdmin.id}/services`, admin(), {
      type: 'image',
      name: 'mover',
      image: 'nginx',
      port: 80,
      domains: ['mover.operador.com'],
    });
    expect(r.status, r.raw).toBe(201);
    const id = r.json.service.id as string;
    r = await call('PATCH', `/api/services/${id}`, admin(), { config: { domains: [] }, domainsBase: ['mover.operador.com'] });
    expect(r.status, r.raw).toBe(200);
    // El administrador lo da al proyecto del cliente B: ahora es suyo, no del A.
    r = await call('POST', `/api/projects/${projB.id}/services`, admin(), {
      type: 'image',
      name: 'movido',
      image: 'nginx',
      port: 80,
      domains: ['mover.operador.com'],
    });
    expect(r.status, r.raw).toBe(201);
    expect(r.json.dns).toEqual([expect.objectContaining({ domain: 'mover.operador.com', action: 'kept' })]);
    const recs = (await call('GET', '/api/cloudflare/records', admin())).json.records as Json[];
    expect(recs.find((x) => x.domain === 'mover.operador.com').project).toMatchObject({ id: projB.id });
  });
});
