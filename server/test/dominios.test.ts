/**
 * Dominios de los servicios y pestaña Correo durante un traslado (auditoría
 * de cambio de proveedor y de dominio):
 *
 * - La comprobación del DNS mira también el AAAA (T11), los A de más y el
 *   CAA (T16), y dice la zona y el nombre buenos en .com.es o .co.uk (UI-03).
 * - Los dominios admiten acentos, «ñ» y la URL pegada (UI-10).
 * - El DNS automático ofrece reemplazar el A/AAAA/CNAME del hosting anterior,
 *   solo al administrador, con confirmación de los registros exactos, nunca en
 *   nombres de la plataforma y con copia para restaurar (T12, CD-12).
 * - Los nombres anteriores de Mailway siguen reservados (CD-13).
 * - Pestaña Correo: se sabe antes del alta si el dominio recibe en otro
 *   proveedor y el DNS automático no se pide sin decisión expresa (T10, T3),
 *   se avisa en la tarjeta (T2), los conflictos de Cloudflare se eligen uno a
 *   uno y se pueden deshacer (T5) y el SPF existente se combina (T6).
 *
 * Cloudflare y Mailway son los dobles de siempre; el DNS, el de `dnsfake.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { API_TOKEN_PREFIX, hashApiToken } from '../src/auth';
import {
  closeDb,
  createProject,
  createService,
  createUser,
  createWorkspaceRow,
  getCloudflareDnsRecord,
  getMailwayDnsReserva,
  getService,
  getSetting,
  getUserByEmail,
  initDb,
  insertApiToken,
  listAudit,
  setSetting,
} from '../src/db';
import { domainClaimError } from '../src/domainguard';
import { mismaIpv6, zonaDns } from '../src/domains';
import { fusionarSpf, getInfo, MAILWAY_SETTING, mailwayReservedHosts, rememberContainerHosts } from '../src/mailway';
import type { ProjectRow, UserRow } from '../src/types';
import { hashPassword, randomToken } from '../src/util';
import { CF_HOST, cf, cloudflareFetch, registro, reiniciarCloudflare, zona } from './cloudflarefake';
import { dnsFalso, reiniciarDns } from './dnsfake';
import { MW_BASE, MW_TOKEN, fakeFetch, mw } from './mailwayfake';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const IP = '203.0.113.10';
const TOKEN_OP = 'OperadorTokenDeCloudflare0123456789abcde';

let app: FastifyInstance;
let adminCookie = '';
let adminBearer: Record<string, string> = {};
let ownerA: Record<string, string> = {};
let projAdmin: ProjectRow;
let projA: ProjectRow;

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

async function fetchDoble(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.host === CF_HOST) return cloudflareFetch(url, init);
  if (url.host === 'api.ipify.org' || url.host === 'ifconfig.me') throw new TypeError('fetch failed');
  return fakeFetch(input, init);
}

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
  expect((await call('PUT', '/api/mailway/config', admin(), { baseUrl: MW_BASE, token: MW_TOKEN })).status).toBe(200);
  setSetting('serverIp', IP);

  reiniciarCloudflare();
  const op = zona('operador.com');
  cf.tokens.set(TOKEN_OP, { kind: 'user', accountId: 'cuenta1', zoneIds: [op.id], status: 'active' });
  const put = await call('PUT', '/api/cloudflare/config', admin(), { token: TOKEN_OP });
  expect(put.status, put.raw).toBe(200);

  projAdmin = createProject('Operador', 'operador', null, null);
  const wsA = createWorkspaceRow('Cliente', { modules_override: JSON.stringify(['mail', 'domains', 'databases']), max_services: 50 });
  projA = createProject('Tienda', 'tienda', null, wsA.id);
  ownerA = bearerFor(createUser('owner@example.com', hashPassword('contraseña1'), 'owner', wsA.id));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  closeDb();
});

beforeEach(() => {
  reiniciarDns();
  cf.calls = [];
  mw.calls = [];
});

// ======================= Comprobación del DNS de un dominio =======================

describe('comprobación del DNS de un dominio de servicio', () => {
  const comprobar = async (domain: string) => (await call('POST', '/api/domains/check', admin(), { domain })).json.check;

  it('UI-03: la zona y el nombre salen de la lista de sufijos públicos, no de las dos últimas etiquetas', async () => {
    expect(zonaDns('www.panaderiasol.com.es')).toEqual({ zone: 'panaderiasol.com.es', name: 'www' });
    expect(zonaDns('panaderiasol.com.es')).toEqual({ zone: 'panaderiasol.com.es', name: '@' });
    expect(zonaDns('tienda.ejemplo.co.uk')).toEqual({ zone: 'ejemplo.co.uk', name: 'tienda' });
    const check = await comprobar('www.panaderiasol.com.es');
    expect(check.status).toBe('no_record');
    expect(check.zone).toBe('panaderiasol.com.es');
    expect(check.name).toBe('www');
  });

  it('T11: un AAAA del hosting anterior no deja el dominio como correcto aunque el A ya apunte aquí', async () => {
    dnsFalso.a.set('web.cliente.es', [IP]);
    expect((await comprobar('web.cliente.es')).status).toBe('ok');

    dnsFalso.aaaa.set('web.cliente.es', ['2001:db8:dead::1']);
    let check = await comprobar('web.cliente.es');
    expect(check.status).toBe('wrong_ip');
    expect(check.resolvedIpv6).toEqual(['2001:db8:dead::1']);
    expect(check.message).toMatch(/IPv6 \(2001:db8:dead::1\) que no es de este servidor/);
    expect(check.message).toMatch(/elimina ese registro AAAA/);

    // Con la IPv6 del servidor indicada (escrita de otra forma), ese AAAA es el suyo.
    setSetting('serverIpv6', '2001:db8:dead:0:0:0:0:1');
    try {
      check = await comprobar('web.cliente.es');
      expect(check.status).toBe('ok');
    } finally {
      setSetting('serverIpv6', null);
    }

    // Un AAAA que no se pudo consultar no convierte en error un dominio correcto.
    dnsFalso.aaaa.delete('web.cliente.es');
    dnsFalso.fallan.add('AAAA:web.cliente.es');
    expect((await comprobar('web.cliente.es')).status).toBe('ok');
  });

  it('T11: una IPv6 con identificador de zona no se acepta y, si ya estaba guardada, no rompe la comprobación', async () => {
    const r = await call('PUT', '/api/settings', admin(), { serverIpv6: 'fe80::1%eth0' });
    expect(r.status).toBe(400);
    expect(r.raw).toMatch(/sin identificador de zona/);
    expect(getSetting('serverIpv6')).toBeNull();
    expect(mismaIpv6('fe80::1%eth0', 'fe80::1')).toBe(false);

    // Guardada por una versión anterior: se ignora (cualquier AAAA cuenta como ajeno) en lugar de responder 500.
    setSetting('serverIpv6', 'fe80::1%eth0');
    try {
      dnsFalso.a.set('v6.cliente.es', [IP]);
      dnsFalso.aaaa.set('v6.cliente.es', ['2001:db8::99']);
      const check = await call('POST', '/api/domains/check', admin(), { domain: 'v6.cliente.es' });
      expect(check.status, check.raw).toBe(200);
      expect(check.json.check.status).toBe('wrong_ip');
    } finally {
      setSetting('serverIpv6', null);
    }
    expect((await call('PUT', '/api/settings', admin(), { serverIpv6: '2001:DB8::10' })).status).toBe(200);
    expect(getSetting('serverIpv6')).toBe('2001:db8::10');
    setSetting('serverIpv6', null);
  });

  it('T11/T13: un A de más (el del hosting anterior que el importador no sustituye) se señala', async () => {
    dnsFalso.a.set('doble.cliente.es', [IP, '198.51.100.99']);
    const check = await comprobar('doble.cliente.es');
    expect(check.status).toBe('wrong_ip');
    expect(check.message).toMatch(/también a 198\.51\.100\.99: el tráfico se reparte/);
  });

  it('T16: un CAA del dominio padre que no autoriza a Let\'s Encrypt deja el dominio pendiente con el registro exacto', async () => {
    dnsFalso.a.set('www.caa.es', [IP]);
    dnsFalso.caa.set('caa.es', [{ critical: 0, issue: 'sectigo.com' }, { critical: 0, iodef: 'mailto:x@caa.es' }]);
    // Sin Let's Encrypt configurado no hay certificado que emitir: no se mira.
    expect((await comprobar('www.caa.es')).status).toBe('ok');

    setSetting('letsencryptEmail', 'ops@example.com');
    try {
      let check = await comprobar('www.caa.es');
      expect(check.status).toBe('caa');
      expect(check.caa).toEqual({ name: 'caa.es', issuers: ['sectigo.com'] });
      expect(check.message).toMatch(/añade en caa\.es el registro CAA 0 issue "letsencrypt\.org"/);

      // El CAA más cercano manda: uno propio que autoriza a Let's Encrypt vale.
      dnsFalso.caa.set('www.caa.es', [{ critical: 0, issue: 'letsencrypt.org; validationmethods=http-01' }]);
      expect((await comprobar('www.caa.es')).status).toBe('ok');

      // Solo issuewild: no restringe un nombre sin comodín.
      dnsFalso.caa.set('www.caa.es', [{ critical: 0, issuewild: 'sectigo.com' }]);
      expect((await comprobar('www.caa.es')).status).toBe('ok');

      // Un CAA que no se pudo consultar no lo impide.
      dnsFalso.caa.delete('www.caa.es');
      dnsFalso.fallan.add('CAA:www.caa.es');
      check = await comprobar('www.caa.es');
      expect(check.status).toBe('ok');
    } finally {
      setSetting('letsencryptEmail', null);
    }
  });
});

// ======================= Dominios con acentos y URL pegada =======================

describe('UI-10: dominios con acentos, «ñ» o la URL de la web', () => {
  it('se guardan en ASCII (punycode), sin esquema ni ruta, y lo que no es un dominio se rechaza con un mensaje útil', async () => {
    let r = await call('POST', `/api/projects/${projAdmin.id}/services`, admin(), {
      type: 'image',
      name: 'panaderia',
      image: 'nginx',
      port: 80,
      domains: ['https://Panadería.es/tienda?x=1', 'www.peña.es.'],
    });
    expect(r.status, r.raw).toBe(201);
    // Con la pareja con o sin www de cada uno (Skyway 0.38) y en el orden del dominio principal.
    expect(getService(r.json.service.id)!.config).toMatchObject({
      domains: ['www.xn--panadera-i2a.es', 'www.xn--pea-8ma.es', 'xn--panadera-i2a.es', 'xn--pea-8ma.es'],
    });

    r = await call('POST', `/api/projects/${projAdmin.id}/services`, admin(), {
      type: 'image',
      name: 'mala',
      image: 'nginx',
      port: 80,
      domains: ['no es un dominio'],
    });
    expect(r.status).toBe(400);
    expect(r.raw).toMatch(/escribe solo el nombre, por ejemplo app\.midominio\.com/);
  });
});

// ======================= Reemplazo del registro del hosting anterior =======================

describe('T12/CD-12: reemplazar en Cloudflare el registro del hosting anterior', () => {
  let servicio: string;

  beforeAll(async () => {
    const op = cf.zones.find((z) => z.name === 'operador.com')!;
    registro(op, { type: 'A', name: 'web.operador.com', content: '198.51.100.20', proxied: true, comment: 'hosting antiguo' });
    registro(op, { type: 'AAAA', name: 'web.operador.com', content: '2001:db8::20' });
    registro(op, { type: 'MX', name: 'web.operador.com', content: 'mx.antiguo.example' });
    const r = await call('POST', `/api/projects/${projAdmin.id}/services`, admin(), {
      type: 'image',
      name: 'web',
      image: 'nginx',
      port: 80,
      domains: ['web.operador.com'],
    });
    expect(r.status, r.raw).toBe(201);
    // El alta automática nunca toca lo que existe: conflicto, y ahora con salida.
    expect(r.json.dns).toEqual([expect.objectContaining({ domain: 'web.operador.com', action: 'conflict' })]);
    expect(r.json.dns[0].message).toMatch(/Reemplazar en Cloudflare/);
    servicio = r.json.service.id;
  });

  const url = () => `/api/services/${servicio}/cloudflare-dns/replace`;

  it('la revisión no toca nada y enseña los registros exactos, el proxy y el AAAA', async () => {
    const r = await call('GET', `${url()}?domain=web.operador.com`, admin());
    expect(r.status, r.raw).toBe(200);
    const plan = r.json.plan;
    expect(plan.motivo).toBeNull();
    expect(plan.ip).toBe(IP);
    expect(plan.actuales.map((x: Json) => `${x.type} ${x.content} ${x.proxied}`).sort()).toEqual([
      'A 198.51.100.20 true',
      'AAAA 2001:db8::20 false',
    ]);
    expect(plan.avisos.join(' ')).toMatch(/proxy de Cloudflare/);
    expect(plan.avisos.join(' ')).toMatch(/AAAA/);
    expect(escrituras()).toEqual([]);
  });

  it('solo el administrador, y la confirmación exige sesión de navegador', async () => {
    expect((await call('GET', `${url()}?domain=web.operador.com`, ownerA)).status).toBe(403);
    const plan = (await call('GET', `${url()}?domain=web.operador.com`, admin())).json.plan;
    const records = plan.actuales.map((x: Json) => ({ id: x.id, type: x.type, content: x.content }));
    expect((await call('POST', url(), ownerA, { domain: 'web.operador.com', records })).status).toBe(403);
    const r = await call('POST', url(), adminBearer, { domain: 'web.operador.com', records });
    expect(r.status).toBe(403);
    expect(r.raw).toMatch(/sesión de navegador/);
    expect(escrituras()).toEqual([]);
  });

  it('si los registros han cambiado desde la revisión, no se toca nada', async () => {
    const plan = (await call('GET', `${url()}?domain=web.operador.com`, admin())).json.plan;
    const solo = plan.actuales.filter((x: Json) => x.type === 'A').map((x: Json) => ({ id: x.id, type: x.type, content: x.content }));
    const r = await call('POST', url(), admin(), { domain: 'web.operador.com', records: solo });
    expect(r.status).toBe(409);
    expect(r.raw).toMatch(/han cambiado desde la revisión/);
    expect(escrituras()).toEqual([]);
  });

  it('sustituye A y AAAA por el A hacia este servidor en un solo lote, guarda copia y se puede restaurar', async () => {
    const plan = (await call('GET', `${url()}?domain=web.operador.com`, admin())).json.plan;
    const records = plan.actuales.map((x: Json) => ({ id: x.id, type: x.type, content: x.content }));
    let r = await call('POST', url(), admin(), { domain: 'web.operador.com', records });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.dns[0]).toMatchObject({ domain: 'web.operador.com', action: 'created' });
    expect(escrituras().map((c) => `${c.method} ${c.path}`)).toEqual(['POST /zones/zona_operador_com/dns_records/batch']);

    const nombre = () => cf.records.filter((x) => x.name === 'web.operador.com');
    expect(nombre().map((x) => `${x.type} ${x.content} ${x.proxied} ${x.comment}`).sort()).toEqual([
      `A ${IP} false Skyway`,
      'MX mx.antiguo.example false null',
    ]);
    const fila = getCloudflareDnsRecord('web.operador.com')!;
    expect(fila.project_id).toBe(projAdmin.id);
    expect(JSON.parse(fila.replaced!).previos).toHaveLength(2);
    expect(listAudit({ action: 'cloudflare_dns_replaced' })[0].detail).toMatch(/A 198\.51\.100\.20 \(proxy\), AAAA 2001:db8::20/);

    // Ajustes → Cloudflare lo enseña y permite restaurarlo (con sesión).
    const lista = (await call('GET', '/api/cloudflare/records', admin())).json.records;
    expect(lista.find((x: Json) => x.domain === 'web.operador.com').replaced).toHaveLength(2);
    expect((await call('POST', '/api/cloudflare/records/web.operador.com/restore', adminBearer)).status).toBe(403);
    cf.calls = [];
    r = await call('POST', '/api/cloudflare/records/web.operador.com/restore', admin());
    expect(r.status, r.raw).toBe(200);
    expect(escrituras().map((c) => `${c.method} ${c.path}`)).toEqual(['POST /zones/zona_operador_com/dns_records/batch']);
    expect(nombre().map((x) => `${x.type} ${x.content} ${x.proxied} ${x.comment}`).sort()).toEqual([
      'A 198.51.100.20 true hosting antiguo',
      'AAAA 2001:db8::20 false null',
      'MX mx.antiguo.example false null',
    ]);
    // Ya no apunta aquí: no hay nada que reservar.
    expect(getCloudflareDnsRecord('web.operador.com')).toBeUndefined();
    expect(listAudit({ action: 'cloudflare_dns_restored' })).toHaveLength(1);
  });

  /** Revisa y confirma el reemplazo de un nombre de un servicio, como la interfaz. */
  async function reemplazar(serviceId: string, domain: string) {
    const plan = (await call('GET', `/api/services/${serviceId}/cloudflare-dns/replace?domain=${domain}`, admin())).json.plan;
    const records = plan.actuales.map((x: Json) => ({ id: x.id, type: x.type, content: x.content }));
    return call('POST', `/api/services/${serviceId}/cloudflare-dns/replace`, admin(), { domain, records });
  }

  it('un segundo reemplazo del mismo nombre se suma a la copia: restaurar devuelve el registro original', async () => {
    const op = cf.zones.find((z) => z.name === 'operador.com')!;
    registro(op, { type: 'A', name: 'dos.operador.com', content: '198.51.100.40', proxied: true });
    const svc = createService(projAdmin.id, 'Dos', 'dos', 'image', { image: 'nginx', port: 80, domains: ['dos.operador.com'] } as never);
    expect((await reemplazar(svc.id, 'dos.operador.com')).status).toBe(200);

    // Alguien añade después un AAAA y se vuelve a reemplazar (el A de Skyway se conserva).
    registro(op, { type: 'AAAA', name: 'dos.operador.com', content: '2001:db8::40' });
    const r = await reemplazar(svc.id, 'dos.operador.com');
    expect(r.status, r.raw).toBe(200);
    const copia = JSON.parse(getCloudflareDnsRecord('dos.operador.com')!.replaced!);
    expect(copia.creado).toBe(true);
    expect(copia.previos.map((p: Json) => `${p.type} ${p.content} ${p.proxied}`)).toEqual([
      'A 198.51.100.40 true',
      'AAAA 2001:db8::40 false',
    ]);
    const vista = (await call('GET', '/api/cloudflare/records', admin())).json.records.find((x: Json) => x.domain === 'dos.operador.com');
    expect(vista.replacedCreated).toBe(true);

    const res = await call('POST', '/api/cloudflare/records/dos.operador.com/restore', admin());
    expect(res.status, res.raw).toBe(200);
    expect(cf.records.filter((x) => x.name === 'dos.operador.com').map((x) => `${x.type} ${x.content} ${x.proxied}`).sort()).toEqual([
      'A 198.51.100.40 true',
      'AAAA 2001:db8::40 false',
    ]);
    expect(getCloudflareDnsRecord('dos.operador.com')).toBeUndefined();
  });

  it('con un AAAA hacia la IPv6 de este servidor, el reemplazo lo conserva y restaurar también', async () => {
    const op = cf.zones.find((z) => z.name === 'operador.com')!;
    setSetting('serverIpv6', '2001:db8::10');
    try {
      registro(op, { type: 'A', name: 'seis.operador.com', content: '198.51.100.50' });
      registro(op, { type: 'AAAA', name: 'seis.operador.com', content: '2001:db8:0:0::10' });
      const svc = createService(projAdmin.id, 'Seis', 'seis', 'image', { image: 'nginx', port: 80, domains: ['seis.operador.com'] } as never);
      let r = await reemplazar(svc.id, 'seis.operador.com');
      expect(r.status, r.raw).toBe(200);
      const nombre = () => cf.records.filter((x) => x.name === 'seis.operador.com').map((x) => `${x.type} ${x.content}`).sort();
      expect(nombre()).toEqual([`A ${IP}`, 'AAAA 2001:db8:0:0::10']);

      r = await call('POST', '/api/cloudflare/records/seis.operador.com/restore', admin());
      expect(r.status, r.raw).toBe(200);
      expect(nombre()).toEqual(['A 198.51.100.50', 'AAAA 2001:db8:0:0::10']);
    } finally {
      setSetting('serverIpv6', null);
    }
  });

  it('nunca se reemplazan los nombres de la plataforma (panel, dominio raíz, Mailway)', async () => {
    const op = cf.zones.find((z) => z.name === 'operador.com')!;
    registro(op, { type: 'A', name: 'apps.operador.com', content: '198.51.100.30' });
    setSetting('rootDomain', 'apps.operador.com');
    const svc = createService(projAdmin.id, 'Raíz', 'raiz', 'image', { image: 'nginx', port: 80, domains: ['apps.operador.com'] } as never);
    try {
      const r = await call('GET', `/api/services/${svc.id}/cloudflare-dns/replace?domain=apps.operador.com`, admin());
      expect(r.status).toBe(200);
      expect(r.json.plan.motivo).toMatch(/dominio raíz/);
      const p = await call('POST', `/api/services/${svc.id}/cloudflare-dns/replace`, admin(), {
        domain: 'apps.operador.com',
        records: [{ id: 'x', type: 'A', content: '198.51.100.30' }],
      });
      expect(p.status).toBe(409);
      expect(escrituras()).toEqual([]);
    } finally {
      setSetting('rootDomain', null);
    }

    // Un nombre de Mailway (el servidor de correo que anuncia la instancia).
    await getInfo({ fresh: true });
    registro(op, { type: 'A', name: 'mail.example.com', content: '198.51.100.31' });
    const mail = createService(projAdmin.id, 'Correo', 'correo', 'image', { image: 'nginx', port: 80, domains: ['mail.example.com'] } as never);
    const r = await call('GET', `/api/services/${mail.id}/cloudflare-dns/replace?domain=mail.example.com`, admin());
    expect(r.json.plan.motivo).toMatch(/servicio de correo \(Mailway\)/);
  });
});

// ======================= Nombres anteriores de Mailway =======================

describe('CD-13: los nombres anteriores de Mailway siguen reservados', () => {
  const claim = (domain: string) => domainClaimError([domain], { projectId: projA.id, serviceId: null, isAdmin: false });

  it('al cambiar de nombre, el anterior queda reservado hasta que el administrador lo libera', async () => {
    mw.infoOverride = { mailHostname: 'mail.viejo.com', webmailUrl: 'https://webmail.viejo.com' };
    await getInfo({ fresh: true });
    expect(claim('mail.viejo.com')).toMatch(/Mailway/);

    mw.infoOverride = { mailHostname: 'mail.nuevo.com', webmailUrl: 'https://webmail.nuevo.com' };
    await getInfo({ fresh: true });
    try {
      expect(claim('mail.nuevo.com')).toMatch(/Mailway/);
      // Antes se sustituía la lista y estos quedaban libres para cualquier cliente.
      expect(claim('mail.viejo.com')).toMatch(/Mailway/);
      expect(claim('webmail.viejo.com')).toMatch(/Mailway/);

      const cfg = (await call('GET', '/api/mailway/config', admin())).json;
      expect(cfg.previousHosts.map((h: Json) => h.host)).toEqual(expect.arrayContaining(['mail.viejo.com', 'webmail.viejo.com']));
      expect(cfg.previousHosts.map((h: Json) => h.host)).not.toContain('mail.nuevo.com');

      // Liberar: solo el administrador con sesión de navegador.
      expect((await call('DELETE', '/api/mailway/previous-hosts/mail.viejo.com', adminBearer)).status).toBe(403);
      expect((await call('DELETE', '/api/mailway/previous-hosts/mail.viejo.com', ownerA)).status).toBe(403);
      const r = await call('DELETE', '/api/mailway/previous-hosts/mail.viejo.com', admin());
      expect(r.status, r.raw).toBe(200);
      expect(r.json.config.previousHosts.map((h: Json) => h.host)).toContain('webmail.viejo.com');
      expect(r.json.config.previousHosts.map((h: Json) => h.host)).not.toContain('mail.viejo.com');
      expect(claim('mail.viejo.com')).toBeNull();
      expect(claim('webmail.viejo.com')).toMatch(/Mailway/);
      expect(listAudit({ action: 'mailway_host_released' })[0].detail).toBe('mail.viejo.com');
      expect((await call('DELETE', '/api/mailway/previous-hosts/mail.viejo.com', admin())).status).toBe(404);
    } finally {
      mw.infoOverride = {};
      await getInfo({ fresh: true });
    }
  });

  it('también los de las rutas de Traefik de los contenedores de Mailway, aunque desaparezcan', () => {
    rememberContainerHosts(['mail.contenedor.com']);
    expect(mailwayReservedHosts()).toContain('mail.contenedor.com');
    expect(claim('mail.contenedor.com')).toMatch(/Mailway/);
    rememberContainerHosts([]);
    expect(claim('mail.contenedor.com')).toMatch(/Mailway/);
    expect(getSetting(MAILWAY_SETTING.containerHosts)).toBe('[]');
  });

  it('desconectar Mailway no libera sus nombres: siguen apuntando aquí', async () => {
    await getInfo({ fresh: true });
    const r = await call('POST', '/api/mailway/disconnect', admin());
    expect(r.status, r.raw).toBe(200);
    try {
      expect(getSetting(MAILWAY_SETTING.hosts)).toBeNull();
      expect(claim('webmail.example.com')).toMatch(/Mailway/);
      expect(claim('mail-panel.example.com')).toMatch(/Mailway/);
    } finally {
      expect((await call('PUT', '/api/mailway/config', admin(), { baseUrl: MW_BASE, token: MW_TOKEN })).status).toBe(200);
    }
  });
});

// ======================= Pestaña Correo =======================

describe('pestaña Correo con el dominio recibiendo en otro proveedor', () => {
  beforeAll(async () => {
    const r = await call('POST', `/api/projects/${projA.id}/mail/link`, ownerA, { mode: 'create' });
    expect(r.status, r.raw).toBe(201);
  });

  /** Altas de dominios que han llegado a Mailway. */
  const altas = () => mw.calls.filter((c) => c.method === 'POST' && /^\/api\/domains(\?|$)/.test(c.path));

  it('T10: antes del alta se sabe dónde recibe el correo, sin dar de alta nada', async () => {
    dnsFalso.mx.set('cliente.es', [
      { exchange: 'alt1.aspmx.l.google.com', priority: 5 },
      { exchange: 'aspmx.l.google.com', priority: 1 },
    ]);
    let r = await call('GET', `/api/projects/${projA.id}/mail/domain-check?domain=Cliente.es`, admin());
    expect(r.status, r.raw).toBe(200);
    expect(r.json).toEqual({ domain: 'cliente.es', recepcion: 'otro', mx: ['aspmx.l.google.com', 'alt1.aspmx.l.google.com'], dnsAutomatico: true });
    // Al propietario no se le ofrece el DNS automático (no es suyo).
    r = await call('GET', `/api/projects/${projA.id}/mail/domain-check?domain=cliente.es`, ownerA);
    expect(r.json.dnsAutomatico).toBe(false);

    dnsFalso.mx.set('propio.es', [{ exchange: 'mail.example.com.', priority: 10 }]);
    expect((await call('GET', `/api/projects/${projA.id}/mail/domain-check?domain=propio.es`, admin())).json.recepcion).toBe('aqui');
    expect((await call('GET', `/api/projects/${projA.id}/mail/domain-check?domain=nuevo.es`, admin())).json.recepcion).toBe('sin_mx');
    dnsFalso.fallan.add('caido.es');
    expect((await call('GET', `/api/projects/${projA.id}/mail/domain-check?domain=caido.es`, admin())).json.recepcion).toBe('desconocido');
    expect(altas()).toEqual([]);
  });

  it('T3/T10: sin decisión expresa, un dominio con el MX en otro proveedor se da de alta sin DNS automático', async () => {
    dnsFalso.mx.set('cliente.es', [{ exchange: 'aspmx.l.google.com', priority: 1 }]);
    let r = await call('POST', `/api/projects/${projA.id}/mail/domains`, admin(), { domain: 'cliente.es' });
    expect(r.status, r.raw).toBe(201);
    expect(altas().at(-1)?.body).toMatchObject({ domain: 'cliente.es', autoDns: false });
    expect(r.json.cloudflare).toBeNull();
    expect(r.json.cloudflareReason).toMatch(/recibe hoy el correo en aspmx\.l\.google\.com/);

    // Con la casilla marcada, el administrador lo pide igualmente.
    dnsFalso.mx.set('decidido.es', [{ exchange: 'aspmx.l.google.com', priority: 1 }]);
    r = await call('POST', `/api/projects/${projA.id}/mail/domains`, admin(), { domain: 'decidido.es', autoDns: true });
    expect(r.status, r.raw).toBe(201);
    expect(altas().at(-1)?.body).toMatchObject({ domain: 'decidido.es', autoDns: true });

    // Sin MX ajeno, como siempre.
    r = await call('POST', `/api/projects/${projA.id}/mail/domains`, admin(), { domain: 'nuevo-sin-mx.es' });
    expect(altas().at(-1)?.body).toMatchObject({ domain: 'nuevo-sin-mx.es', autoDns: true });

    // Si no se sabe dónde recibe (el DNS no responde), tampoco: puede haber un proveedor que no se ve.
    dnsFalso.fallan.add('MX:mudo.es');
    r = await call('POST', `/api/projects/${projA.id}/mail/domains`, admin(), { domain: 'mudo.es' });
    expect(r.status, r.raw).toBe(201);
    expect(altas().at(-1)?.body).toMatchObject({ domain: 'mudo.es', autoDns: false });
    expect(r.json.cloudflareReason).toMatch(/No se ha podido comprobar dónde recibe hoy el correo mudo\.es/);

    // Un propietario no lo pide nunca, aunque lo mande.
    r = await call('POST', `/api/projects/${projA.id}/mail/domains`, ownerA, { domain: 'del-cliente.es', autoDns: true });
    expect(r.status, r.raw).toBe(201);
    expect(altas().at(-1)?.body).toMatchObject({ domain: 'del-cliente.es', autoDns: false });
    expect(altas().at(-1)?.path).toContain('soloCliente=1');
  });

  it('T2: la tarjeta sabe si el dominio recibe en otro proveedor y si Mailway encamina allí lo que se le envía', async () => {
    const d = mw.domains.find((x) => x.domain === 'cliente.es')!;
    mw.conflictos.set('cliente.es', {
      hayOtroProveedor: true,
      mxActuales: ['aspmx.l.google.com', 'x\ny'],
      spfActual: 'v=spf1 include:_spf.google.com ~all',
      dmarcPolitica: 'reject',
      aviso: 'texto de Mailway',
      avisoMtaSts: 'Actualiza la política MTA-STS antes del cambio.',
      campoDesconocido: 'no sale',
    });
    let r = await call('GET', `/api/projects/${projA.id}/mail/domains/${d.id}/conflicto`, ownerA);
    expect(r.status, r.raw).toBe(200);
    expect(r.json).toEqual({
      hayOtroProveedor: true,
      mxActuales: ['aspmx.l.google.com'],
      spfActual: 'v=spf1 include:_spf.google.com ~all',
      dmarcPolitica: 'reject',
      avisoMtaSts: 'Actualiza la política MTA-STS antes del cambio.',
    });

    // Un Mailway anterior no dice `recepcionExterna` (null: lo entrega en local); uno nuevo, sí.
    let mail = (await call('GET', `/api/projects/${projA.id}/mail`, ownerA)).json;
    expect(mail.summary.domains.find((x: Json) => x.id === d.id).recepcionExterna).toBeNull();
    d.recepcionExterna = true;
    mail = (await call('GET', `/api/projects/${projA.id}/mail`, ownerA)).json;
    expect(mail.summary.domains.find((x: Json) => x.id === d.id).recepcionExterna).toBe(true);

    // Otro proyecto, con el correo vinculado a otro cliente, no puede preguntar por un dominio ajeno.
    const otro = createProject('Otro', 'otro', null, null);
    const link = await call('POST', `/api/projects/${otro.id}/mail/link`, admin(), { mode: 'create' });
    expect(link.status, link.raw).toBe(201);
    mw.calls = [];
    r = await call('GET', `/api/projects/${otro.id}/mail/domains/${d.id}/conflicto`, admin());
    expect(r.status, r.raw).toBe(404);
    expect(mw.calls.some((c) => c.path.includes('/conflicto'))).toBe(false);
  });

  it('T6: el SPF existente se combina en vez de sustituirse por el del servidor', async () => {
    expect(fusionarSpf('v=spf1 include:_spf.google.com include:_spf.hosting.es ~all', 'v=spf1 mx ra=postmaster -all')).toBe(
      'v=spf1 include:_spf.google.com include:_spf.hosting.es mx ~all',
    );
    expect(fusionarSpf('v=spf1 mx ~all', 'v=spf1 mx -all')).toBeNull();
    expect(fusionarSpf('v=spf1 a ~all | v=spf1 mx -all', 'v=spf1 mx -all')).toBeNull();
    expect(fusionarSpf('v=spf1 include:x.com', 'v=spf1 a:mail.example.com ~all')).toBe('v=spf1 include:x.com a:mail.example.com');

    const d = mw.domains.find((x) => x.domain === 'cliente.es')!;
    // Mailway hasta la 1.2: no informa `recepcionExterna` ni calcula el SPF combinado.
    delete d.recepcionExterna;
    const spf = {
      id: 'spf:cliente.es',
      label: 'SPF',
      type: 'TXT',
      name: 'cliente.es',
      expected: 'v=spf1 mx ra=postmaster -all',
      found: 'v=spf1 include:_spf.google.com ~all',
      status: 'mismatch',
      required: true,
      help: 'Añade «mx» delante de «all».',
    } as Record<string, unknown>;
    const mxCheck = (status: string) => ({ id: 'mx:cliente.es', label: 'MX', type: 'MX', name: 'cliente.es', expected: '10 mail.example.com', status, required: true });
    const sugerido = async () => {
      const mail = (await call('GET', `/api/projects/${projA.id}/mail`, ownerA)).json;
      return mail.summary.domains.find((x: Json) => x.id === d.id).dns.checks.find((c: Json) => c.id === 'spf:cliente.es').suggested;
    };

    // Con el MX en Google, «mx» autorizaría a los servidores de entrada de Google: se autoriza el servidor de correo por su nombre.
    d.checks = [mxCheck('mismatch'), spf];
    expect(await sugerido()).toBe('v=spf1 include:_spf.google.com a:mail.example.com ~all');
    // Con el MX ya aquí, «mx» vale.
    d.checks = [mxCheck('ok'), spf];
    expect(await sugerido()).toBe('v=spf1 include:_spf.google.com mx ~all');

    // Un Mailway posterior a la 1.2 lo calcula él: el suyo tiene preferencia y, si no manda ninguno, no se inventa otro.
    d.recepcionExterna = true;
    d.checks = [mxCheck('mismatch'), spf];
    expect(await sugerido()).toBeNull();
    d.checks = [mxCheck('mismatch'), { ...spf, suggested: 'v=spf1 include:_spf.google.com ip4:203.0.113.10 ~all' }];
    expect(await sugerido()).toBe('v=spf1 include:_spf.google.com ip4:203.0.113.10 ~all');
    delete d.recepcionExterna;
  });

  it('T5: con un Mailway que lo admite, los conflictos se eligen uno a uno y el cambio se puede deshacer', async () => {
    const d = mw.domains.find((x) => x.domain === 'cliente.es')!;
    // Mailway anterior: sin elección por registro.
    let plan = (await call('GET', `/api/projects/${projA.id}/mail/domains/${d.id}/cloudflare`, admin())).json;
    expect(plan.porRegistro).toBe(false);
    expect(plan.copia).toBeNull();

    mw.cloudflarePorRegistro = true;
    mw.copia = null;
    try {
      plan = (await call('GET', `/api/projects/${projA.id}/mail/domains/${d.id}/cloudflare`, admin())).json;
      expect(plan.porRegistro).toBe(true);
      expect(plan.changes.map((c: Json) => `${c.type}:${c.reemplazable}:${c.alCambiar}`)).toEqual([
        'MX:true:true',
        'TXT:false:false',
        'CNAME:true:false',
      ]);

      // Solo el MX: el autodiscover del proveedor anterior se conserva.
      let r = await call('POST', `/api/projects/${projA.id}/mail/domains/${d.id}/cloudflare/apply`, admin(), {
        replace: ['MX:cliente.es'],
      });
      expect(r.status, r.raw).toBe(200);
      expect(mw.calls.find((c) => c.path.includes('/cloudflare/apply'))?.body).toEqual({ replaceConflicts: false, replace: ['MX:cliente.es'] });
      expect(r.json.applied).toEqual([{ action: 'replace', type: 'MX', name: 'cliente.es' }]);
      expect(listAudit({ action: 'mailway_dns_applied' })[0].detail).toMatch(/reemplazando MX:cliente\.es/);

      r = await call('POST', `/api/projects/${projA.id}/mail/domains/${d.id}/cloudflare/apply`, admin(), { replace: ['no vale'] });
      expect(r.status).toBe(400);

      plan = (await call('GET', `/api/projects/${projA.id}/mail/domains/${d.id}/cloudflare`, admin())).json;
      expect(plan.copia.borrados).toEqual([{ type: 'MX', name: 'cliente.es', content: 'anterior', priority: null }]);

      // Deshacer: quien gestiona el proyecto; un propietario, solo con sus cuentas.
      mw.calls = [];
      r = await call('POST', `/api/projects/${projA.id}/mail/domains/${d.id}/cloudflare/undo`, ownerA);
      expect(r.status, r.raw).toBe(200);
      expect(r.json.restaurados).toEqual([{ type: 'MX', name: 'cliente.es' }]);
      expect(mw.calls.find((c) => c.path.includes('/cloudflare/undo'))?.path).toContain('soloCliente=1');
      expect(listAudit({ action: 'mailway_dns_undone' })).toHaveLength(1);
      r = await call('POST', `/api/projects/${projA.id}/mail/domains/${d.id}/cloudflare/undo`, ownerA);
      expect(r.status).toBe(409);

      // Lo que sustituye un reemplazo apunta aquí igual que lo creado: queda reservado al proyecto.
      expect(getMailwayDnsReserva('autodiscover.cliente.es')).toBeUndefined();
      r = await call('POST', `/api/projects/${projA.id}/mail/domains/${d.id}/cloudflare/apply`, admin(), {
        replace: ['CNAME:autodiscover.cliente.es'],
      });
      expect(r.status, r.raw).toBe(200);
      expect(r.json.applied).toEqual([{ action: 'replace', type: 'CNAME', name: 'autodiscover.cliente.es' }]);
      expect(getMailwayDnsReserva('autodiscover.cliente.es')?.project_id).toBe(projA.id);
      expect(domainClaimError(['autodiscover.cliente.es'], { projectId: projAdmin.id, serviceId: null, isAdmin: false })).toBeTruthy();
    } finally {
      mw.cloudflarePorRegistro = false;
      mw.copia = null;
    }
  });
});
