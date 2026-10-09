/**
 * La web con el proxy de Cloudflare (nube naranja):
 *
 * - El DNS automático del administrador crea el registro A con el proxy si la
 *   web va por HTTPS (sin HTTPS, sin proxy).
 * - Comprobar un dominio con el proxy: para el administrador se pregunta a la
 *   API de Cloudflare a dónde lleva (`verificarEnCloudflare`), y con HTTPS se
 *   detecta el bucle del modo «Flexible»; para cualquier otro, la comprobación
 *   de siempre, sin una sola petición a Cloudflare.
 * - «Activar proxy en Cloudflare»: solo el administrador, solo los A de ese
 *   nombre que apuntan aquí, nunca a medias y solo con HTTPS.
 *
 * Mismo doble de Cloudflare que `cloudflare.test.ts`; el DNS se simula
 * espiando el resolutor, como en `dominioprincipal.test.ts`.
 */
import dns from 'dns';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { API_TOKEN_PREFIX, hashApiToken } from '../src/auth';
import { aplicarDnsDominios, cubiertoPorCertificadoCloudflare, verificarEnCloudflare } from '../src/cloudflaredns';
import { closeDb, createProject, createUser, createWorkspaceRow, initDb, insertApiToken, listAudit, setSetting } from '../src/db';
import { bucleFlexible, completarConCloudflare, DomainCheck } from '../src/domains';
import type { ProjectRow, UserRow } from '../src/types';
import { hashPassword, randomToken } from '../src/util';
import { CF_HOST, cf, cloudflareFetch, registro, zona } from './cloudflarefake';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const IP = '203.0.113.10';
const IP_CF = '104.21.48.1';
const TOKEN = 'OperadorTokenDeCloudflare0123456789abcde';

let app: FastifyInstance;
let adminCookie = '';
let ownerA: Record<string, string> = {};
let projAdmin: ProjectRow;

/**
 * Respuesta de cada web pedida por HTTPS (el sondeo del modo «Flexible»), por
 * nombre: lo que no está aquí no responde.
 */
const webs = new Map<string, () => Response>();
const sondeos: string[] = [];

const admin = () => ({ cookie: adminCookie, ...SAME_ORIGIN });

function bearerFor(user: UserRow): Record<string, string> {
  const secret = `${API_TOKEN_PREFIX}${randomToken(24)}`;
  insertApiToken({ user_id: user.id, name: 'pruebas', token_hash: hashApiToken(secret), prefix: secret.slice(0, 12), expires_at: null });
  return { authorization: `Bearer ${secret}` };
}

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, headers: Record<string, string>, body?: unknown) {
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

async function fetchDoble(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.host === CF_HOST) return cloudflareFetch(url, init);
  if (url.protocol === 'https:' && webs.has(url.hostname)) {
    sondeos.push(url.href);
    return webs.get(url.hostname)!();
  }
  throw new TypeError('fetch failed');
}

const redireccion = (status: number, location: string) => () => new Response(null, { status, headers: { location } });
const reg = (name: string, type = 'A') => cf.records.find((x) => x.name === name && x.type === type)!;
const parches = () => cf.calls.filter((c) => c.method === 'PATCH');

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
  setSetting('serverIp', IP);
  setSetting('letsencryptEmail', 'tls@example.com');
  setSetting('cloudflare.token', TOKEN);

  projAdmin = createProject('Operador', 'operador', null, null);
  const ws = createWorkspaceRow('Cliente', { modules_override: JSON.stringify(['domains']), max_services: 20 });
  ownerA = bearerFor(createUser('owner@example.com', hashPassword('contraseña1'), 'owner', ws.id));

  const web = zona('bufete.es');
  const ajena = zona('ajena.es');
  zona('invisible.es'); // existe en Cloudflare, pero el token no la ve
  const pendiente = zona('pendiente.es', { status: 'pending' });
  cf.tokens.set(TOKEN, { kind: 'user', accountId: 'cuenta1', zoneIds: [web.id, ajena.id, pendiente.id], status: 'active' });
  registro(pendiente, { type: 'A', name: 'pendiente.es', content: IP, proxied: true });
  registro(web, { type: 'A', name: 'gris2.bufete.es', content: IP });
  registro(web, { type: 'A', name: 'bufete.es', content: IP, proxied: true });
  registro(web, { type: 'CNAME', name: 'www.bufete.es', content: 'bufete.es', proxied: true });
  registro(web, { type: 'A', name: 'otra.bufete.es', content: '198.51.100.9', proxied: true });
  registro(web, { type: 'A', name: 'doble.bufete.es', content: IP, proxied: true });
  registro(web, { type: 'AAAA', name: 'doble.bufete.es', content: '2001:db8::5', proxied: true });
  registro(web, { type: 'A', name: '*.apps.bufete.es', content: IP, proxied: true });
  registro(web, { type: 'TXT', name: 'txt.apps.bufete.es', content: 'v=spf1 -all' });
  registro(web, { type: 'CNAME', name: 'fuera.bufete.es', content: 'web.invisible.es', proxied: true });
  registro(web, { type: 'CNAME', name: 'ajeno.bufete.es', content: 'web.ajena.es', proxied: true });
  registro(ajena, { type: 'A', name: 'web.ajena.es', content: '198.51.100.20' });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  closeDb();
});

beforeEach(() => {
  cf.calls = [];
  sondeos.length = 0;
  webs.clear();
});

describe('verificarEnCloudflare: a dónde lleva un nombre con el proxy', () => {
  it('un A hacia este servidor, también a través de un CNAME o del comodín, con su proxy', async () => {
    expect(await verificarEnCloudflare('bufete.es')).toEqual({ estado: 'aqui', proxied: true });
    expect(await verificarEnCloudflare('www.bufete.es')).toEqual({ estado: 'aqui', proxied: true });
    expect(await verificarEnCloudflare('tienda.apps.bufete.es')).toEqual({ estado: 'aqui', proxied: true });
    expect(await verificarEnCloudflare('gris2.bufete.es')).toEqual({ estado: 'aqui', proxied: false });
    // Solo lee: ni crea, ni cambia, ni borra nada.
    expect(cf.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('a otro sitio: otra IP, un AAAA o un CNAME hacia otra web de una zona visible', async () => {
    expect(await verificarEnCloudflare('otra.bufete.es')).toEqual({ estado: 'otro', detalle: 'un registro A hacia 198.51.100.9' });
    expect(await verificarEnCloudflare('doble.bufete.es')).toEqual({ estado: 'otro', detalle: 'un registro AAAA hacia 2001:db8::5' });
    expect(await verificarEnCloudflare('ajeno.bufete.es')).toEqual({ estado: 'otro', detalle: 'un registro A hacia 198.51.100.20' });
  });

  it('no se puede saber: zona que el token no ve o aún pendiente, CNAME hacia una que no ve, nombre sin dirección, sin token o sin IP', async () => {
    expect(await verificarEnCloudflare('web.invisible.es')).toBeNull();
    // Con la zona aún pendiente en Cloudflare, sus registros no deciden nada todavía.
    expect(await verificarEnCloudflare('pendiente.es')).toBeNull();
    expect(await verificarEnCloudflare('fuera.bufete.es')).toBeNull();
    // Con un TXT propio, el comodín no se aplica y el nombre no tiene dirección.
    expect(await verificarEnCloudflare('txt.apps.bufete.es')).toBeNull();
    setSetting('cloudflare.token', null);
    try {
      expect(await verificarEnCloudflare('bufete.es')).toBeNull();
    } finally {
      setSetting('cloudflare.token', TOKEN);
    }
    setSetting('serverIp', null);
    try {
      // Sin IP configurada se intenta detectar; en las pruebas no hay salida.
      expect(await verificarEnCloudflare('bufete.es')).toBeNull();
    } finally {
      setSetting('serverIp', IP);
    }
  });

  it('un token revocado no rompe nada: no se puede saber', async () => {
    cf.tokens.get(TOKEN)!.status = 'disabled';
    try {
      expect(await verificarEnCloudflare('bufete.es')).toBeNull();
    } finally {
      cf.tokens.get(TOKEN)!.status = 'active';
    }
  });
});

describe('bucleFlexible: el bucle de redirecciones del modo «Flexible»', () => {
  it('una redirección a la misma dirección es el bucle; a otra, una respuesta normal o un fallo, no', async () => {
    webs.set('bufete.es', redireccion(301, 'https://bufete.es/'));
    expect(await bucleFlexible('bufete.es')).toBe(true);
    webs.set('bufete.es', redireccion(308, '/'));
    expect(await bucleFlexible('bufete.es')).toBe(true);
    // La pareja con o sin www redirige a otro nombre: no es un bucle.
    webs.set('bufete.es', redireccion(308, 'https://www.bufete.es/'));
    expect(await bucleFlexible('bufete.es')).toBe(false);
    webs.set('bufete.es', redireccion(302, 'https://bufete.es/inicio'));
    expect(await bucleFlexible('bufete.es')).toBe(false);
    webs.set('bufete.es', () => new Response('hola', { status: 200 }));
    expect(await bucleFlexible('bufete.es')).toBe(false);
    // Certificado aún en camino o desafío contra bots: no es el bucle.
    webs.set('bufete.es', () => new Response('', { status: 526 }));
    expect(await bucleFlexible('bufete.es')).toBe(false);
    webs.delete('bufete.es');
    expect(await bucleFlexible('bufete.es')).toBe(false);
  });
});

describe('completarConCloudflare', () => {
  const base = (status: DomainCheck['status'] = 'cloudflare_proxy'): DomainCheck => ({
    domain: 'bufete.es',
    status,
    resolvedIps: [IP_CF],
    expectedIp: IP,
    message: 'mensaje de partida',
  });

  it('solo actúa con quien puede usar la API y sobre un nombre que resuelve aquí o al proxy', async () => {
    const verificar = vi.fn(async () => ({ estado: 'aqui' as const, proxied: true }));
    expect(await completarConCloudflare(base('wrong_ip'), { verificar })).toEqual(base('wrong_ip'));
    expect(await completarConCloudflare(base('no_record'), { verificar })).toEqual(base('no_record'));
    expect(await completarConCloudflare(base(), {})).toEqual(base());
    expect(await completarConCloudflare({ ...base(), expectedIp: null }, { verificar })).toEqual({ ...base(), expectedIp: null });
    expect(verificar).not.toHaveBeenCalled();
    expect(await completarConCloudflare(base(), { verificar: async () => null })).toEqual(base());
    expect(
      await completarConCloudflare(base(), {
        verificar: async () => {
          throw new Error('caída');
        },
      }),
    ).toEqual(base());
  });

  it('a otro sitio es una IP equivocada, con lo que hay en Cloudflare', async () => {
    const r = await completarConCloudflare(base(), { verificar: async () => ({ estado: 'otro', detalle: 'un registro A hacia 198.51.100.9' }) });
    expect(r).toMatchObject({
      status: 'wrong_ip',
      message: `En Cloudflare, bufete.es tiene un registro A hacia 198.51.100.9 en lugar de un registro A hacia ${IP}.`,
    });
    expect(r.viaCloudflare).toBeUndefined();
  });

  it('la API manda sobre el proxy mientras el DNS público se pone al día', async () => {
    // Recién activado: fuera aún resuelve a la IP del servidor.
    const sondear = vi.fn(async () => true);
    expect(await completarConCloudflare(base('ok'), { verificar: async () => ({ estado: 'aqui', proxied: true }), sondear })).toMatchObject({
      status: 'ok',
      viaCloudflare: true,
      message: 'El dominio apunta a este servidor con el proxy de Cloudflare activado; desde fuera puede tardar unos minutos en verse.',
    });
    // Sin pasar por Cloudflare no hay bucle que buscar.
    expect(sondear).not.toHaveBeenCalled();
    // Sin el proxy en Cloudflare, lo de siempre.
    expect(await completarConCloudflare(base('ok'), { verificar: async () => ({ estado: 'aqui', proxied: false }) })).toEqual(base('ok'));
    expect(await completarConCloudflare(base('ok'), { verificar: async () => ({ estado: 'otro', detalle: 'x' }) })).toEqual(base('ok'));
    // Recién quitado: fuera aún se ven las IP de Cloudflare.
    const quitado = await completarConCloudflare(base(), { verificar: async () => ({ estado: 'aqui', proxied: false }), sondear });
    expect(quitado).toMatchObject({
      status: 'ok',
      message: 'El dominio apunta a este servidor sin el proxy de Cloudflare; desde fuera puede tardar unos minutos en verse.',
    });
    expect(quitado.viaCloudflare).toBeUndefined();
    expect(sondear).not.toHaveBeenCalled();
  });

  it('aquí: correcto, salvo el bucle del modo «Flexible», que solo se busca con HTTPS', async () => {
    const verificar = async () => ({ estado: 'aqui' as const, proxied: true });
    expect(await completarConCloudflare(base(), { verificar, sondear: async () => false })).toMatchObject({
      status: 'ok',
      viaCloudflare: true,
      message: 'El dominio apunta a este servidor a través del proxy de Cloudflare.',
    });
    const flexible = await completarConCloudflare(base(), { verificar, sondear: async () => true });
    expect(flexible).toMatchObject({ status: 'cloudflare_flexible', viaCloudflare: true });
    expect(flexible.message).toMatch(/«Flexible».*«Completo \(estricto\)»/);

    setSetting('letsencryptEmail', null);
    try {
      const sondear = vi.fn(async () => true);
      expect(await completarConCloudflare(base(), { verificar, sondear })).toMatchObject({ status: 'ok', viaCloudflare: true });
      expect(sondear).not.toHaveBeenCalled();
    } finally {
      setSetting('letsencryptEmail', 'tls@example.com');
    }
  });
});

describe('POST /api/domains/check con el proxy de Cloudflare', () => {
  const comprobar = (headers: Record<string, string>, domain: string) => call('POST', '/api/domains/check', headers, { domain });

  it('al administrador se le comprueba con la API: aquí, en bucle o a otro sitio', async () => {
    const espia = vi.spyOn(dns.promises.Resolver.prototype, 'resolve4').mockResolvedValue([IP_CF] as never);
    try {
      webs.set('www.bufete.es', () => new Response('ok', { status: 200 }));
      let r = await comprobar(admin(), 'www.bufete.es');
      expect(r.status, r.raw).toBe(200);
      expect(r.json.check).toMatchObject({ domain: 'www.bufete.es', status: 'ok', viaCloudflare: true, expectedIp: IP });
      expect(sondeos).toEqual(['https://www.bufete.es/']);

      webs.set('bufete.es', redireccion(301, 'https://bufete.es/'));
      r = await comprobar(admin(), 'bufete.es');
      expect(r.json.check).toMatchObject({ status: 'cloudflare_flexible', viaCloudflare: true });

      r = await comprobar(admin(), 'otra.bufete.es');
      expect(r.json.check).toMatchObject({ status: 'wrong_ip' });
      expect(r.json.check.message).toMatch(/198\.51\.100\.9/);

      r = await comprobar(admin(), 'web.invisible.es');
      expect(r.json.check).toMatchObject({ status: 'cloudflare_proxy' });
      expect(r.json.check.viaCloudflare).toBeUndefined();
    } finally {
      espia.mockRestore();
    }
  });

  it('a un propietario, la comprobación de siempre: ni una petición a Cloudflare ni a la web', async () => {
    const espia = vi.spyOn(dns.promises.Resolver.prototype, 'resolve4').mockResolvedValue([IP_CF] as never);
    try {
      webs.set('bufete.es', redireccion(301, 'https://bufete.es/'));
      const r = await comprobar(ownerA, 'bufete.es');
      expect(r.status, r.raw).toBe(200);
      expect(r.json.check).toMatchObject({ status: 'cloudflare_proxy' });
      expect(r.json.check.message).toMatch(/no se puede comprobar/);
      expect(r.json.check.viaCloudflare).toBeUndefined();
      expect(cf.calls).toEqual([]);
      expect(sondeos).toEqual([]);
    } finally {
      espia.mockRestore();
    }
  });
});

describe('DNS automático: el registro A de la web con el proxy', () => {
  it('con HTTPS se crea con el proxy y lo dice', async () => {
    const r = await aplicarDnsDominios(TOKEN, ['nueva.bufete.es']);
    expect(r).toEqual([
      { domain: 'nueva.bufete.es', action: 'created', message: `Registro A hacia ${IP} creado en la zona bufete.es, con el proxy de Cloudflare.` },
    ]);
    expect(cf.calls.find((c) => c.method === 'POST')!.body).toEqual({
      type: 'A',
      name: 'nueva.bufete.es',
      content: IP,
      ttl: 1,
      proxied: true,
      comment: 'Skyway',
    });
    expect(reg('nueva.bufete.es').proxied).toBe(true);
  });

  it('sin HTTPS, sin proxy: Cloudflare solo podría entregar la web en modo «Flexible»', async () => {
    setSetting('letsencryptEmail', null);
    try {
      const r = await aplicarDnsDominios(TOKEN, ['plana.bufete.es']);
      expect(r[0]).toMatchObject({ action: 'created', message: `Registro A hacia ${IP} creado en la zona bufete.es.` });
      expect(reg('plana.bufete.es').proxied).toBe(false);
    } finally {
      setSetting('letsencryptEmail', 'tls@example.com');
    }
  });

  it('un nombre a dos niveles de la zona va sin proxy: el certificado gratuito de Cloudflare no lo cubre', async () => {
    expect(cubiertoPorCertificadoCloudflare('bufete.es', 'bufete.es')).toBe(true);
    expect(cubiertoPorCertificadoCloudflare('www.bufete.es.', 'Bufete.es')).toBe(true);
    expect(cubiertoPorCertificadoCloudflare('api.tienda.bufete.es', 'bufete.es')).toBe(false);
    expect(cubiertoPorCertificadoCloudflare('xbufete.es', 'bufete.es')).toBe(false);
    const r = await aplicarDnsDominios(TOKEN, ['api.tienda.bufete.es']);
    expect(r[0]).toMatchObject({
      action: 'created',
      message: `Registro A hacia ${IP} creado en la zona bufete.es, sin el proxy de Cloudflare: su certificado gratuito solo cubre bufete.es y un nivel de subdominio.`,
    });
    expect(reg('api.tienda.bufete.es').proxied).toBe(false);
  });

  it('uno que ya existía sin el proxy no se toca y se dice', async () => {
    registro(cf.zones.find((z) => z.name === 'bufete.es')!, { type: 'A', name: 'gris.bufete.es', content: IP });
    const r = await aplicarDnsDominios(TOKEN, ['gris.bufete.es']);
    expect(r[0]).toMatchObject({ action: 'kept', message: `El registro A hacia ${IP} ya existía (sin el proxy de Cloudflare).` });
    expect(cf.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(reg('gris.bufete.es').proxied).toBe(false);
  });
});

describe('«Activar proxy en Cloudflare»', () => {
  let servicioId = '';
  const activar = (headers: Record<string, string>, domain: string) =>
    call('POST', `/api/services/${servicioId}/cloudflare-proxy`, headers, { domain, proxied: true });

  beforeAll(async () => {
    const z = cf.zones.find((x) => x.name === 'bufete.es')!;
    registro(z, { type: 'A', name: 'sinproxy.bufete.es', content: IP });
    registro(z, { type: 'A', name: 'mezcla.bufete.es', content: IP });
    registro(z, { type: 'A', name: 'mezcla.bufete.es', content: '198.51.100.30' });
    registro(z, { type: 'CNAME', name: 'alias.bufete.es', content: 'bufete.es' });
    registro(z, { type: 'A', name: 'hondo.tienda.bufete.es', content: IP });
    const r = await call('POST', `/api/projects/${projAdmin.id}/services`, admin(), {
      type: 'image',
      name: 'web',
      image: 'nginx',
      port: 80,
      domains: ['sinproxy.bufete.es', 'mezcla.bufete.es', 'alias.bufete.es', 'hondo.tienda.bufete.es'],
    });
    expect(r.status, r.raw).toBe(201);
    servicioId = r.json.service.id;
  });

  it('solo el administrador, con sesión de navegador y con un dominio del servicio', async () => {
    let r = await activar(ownerA, 'sinproxy.bufete.es');
    expect(r.status).toBe(403);
    r = await activar(admin(), 'bufete.es');
    expect(r.status).toBe(404);
    expect(parches()).toEqual([]);
    expect(listAudit({ action: 'cloudflare_proxy_enabled' })).toEqual([]);
  });

  it('pone el proxy solo en los A de ese nombre que apuntan aquí, lo audita y vuelve a comprobar con la API', async () => {
    const espia = vi.spyOn(dns.promises.Resolver.prototype, 'resolve4').mockResolvedValue([IP_CF] as never);
    try {
      webs.set('sinproxy.bufete.es', () => new Response('ok', { status: 200 }));
      const r = await activar(admin(), 'sinproxy.bufete.es');
      expect(r.status, r.raw).toBe(200);
      expect(r.json.result).toMatchObject({ domain: 'sinproxy.bufete.es', changed: 1 });
      expect(r.json.result.message).toMatch(/Proxy activado en el registro A de sinproxy\.bufete\.es/);
      expect(r.json.check).toMatchObject({ status: 'ok', viaCloudflare: true });
      expect(parches()).toEqual([
        expect.objectContaining({ path: `/zones/zona_bufete_es/dns_records/${reg('sinproxy.bufete.es').id}`, body: { proxied: true } }),
      ]);
      expect(reg('sinproxy.bufete.es')).toMatchObject({ proxied: true, content: IP, type: 'A' });
      expect(listAudit({ action: 'cloudflare_proxy_enabled' })[0]).toMatchObject({
        target_type: 'service',
        target_id: servicioId,
        detail: 'sinproxy.bufete.es: 1 registro(s)',
      });

      cf.calls = [];
      const otra = await activar(admin(), 'sinproxy.bufete.es');
      expect(otra.json.result).toMatchObject({ changed: 0, message: 'El registro A de sinproxy.bufete.es ya tiene el proxy activado.' });
      expect(parches()).toEqual([]);

      // Con el DNS público aún desfasado (resuelve a la IP del servidor), la
      // comprobación del administrador dice lo que hay en Cloudflare: el
      // botón que se ofrece es el de desactivarlo.
      espia.mockResolvedValue([IP] as never);
      const comprobacion = await call('POST', '/api/domains/check', admin(), { domain: 'sinproxy.bufete.es' });
      expect(comprobacion.json.check).toMatchObject({ status: 'ok', viaCloudflare: true });
      expect(comprobacion.json.check.message).toMatch(/puede tardar unos minutos/);
    } finally {
      espia.mockRestore();
    }
  });

  it('un nombre que el certificado gratuito de Cloudflare no cubre no se pone detrás del proxy', async () => {
    const r = await activar(admin(), 'hondo.tienda.bufete.es');
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/solo cubre bufete\.es y un nivel de subdominio.*error de certificado/);
    expect(parches()).toEqual([]);
    expect(reg('hondo.tienda.bufete.es').proxied).toBe(false);
  });

  it('nunca a medias: con otro A hacia otro sitio, o un CNAME, no se toca nada y se explica', async () => {
    let r = await activar(admin(), 'mezcla.bufete.es');
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/A hacia 198\.51\.100\.30.*no se ha modificado nada/);
    r = await activar(admin(), 'alias.bufete.es');
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/es un CNAME hacia bufete\.es y no se ha modificado/);
    expect(parches()).toEqual([]);
    expect(cf.records.filter((x) => x.name === 'mezcla.bufete.es').every((x) => !x.proxied)).toBe(true);
  });

  it('sin HTTPS no se activa: Cloudflare solo podría entregar la web en modo «Flexible»', async () => {
    setSetting('letsencryptEmail', null);
    try {
      const r = await activar(admin(), 'sinproxy.bufete.es');
      expect(r.status).toBe(409);
      expect(r.json.error).toMatch(/configura antes HTTPS/);
      expect(cf.calls).toEqual([]);
    } finally {
      setSetting('letsencryptEmail', 'tls@example.com');
    }
  });

  it('«Desactivar proxy» sigue igual sin indicar nada (compatibilidad)', async () => {
    const espia = vi.spyOn(dns.promises.Resolver.prototype, 'resolve4').mockResolvedValue([IP] as never);
    try {
      const r = await call('POST', `/api/services/${servicioId}/cloudflare-proxy`, admin(), { domain: 'sinproxy.bufete.es' });
      expect(r.status, r.raw).toBe(200);
      expect(r.json.result).toMatchObject({ changed: 1 });
      expect(r.json.result.message).toMatch(/Proxy desactivado/);
      expect(r.json.check).toMatchObject({ status: 'ok' });
      expect(reg('sinproxy.bufete.es').proxied).toBe(false);
      expect(listAudit({ action: 'cloudflare_proxy_disabled' })[0]).toMatchObject({ detail: 'sinproxy.bufete.es: 1 registro(s)' });
    } finally {
      espia.mockRestore();
    }
  });
});
