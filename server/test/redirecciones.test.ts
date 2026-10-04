/**
 * Prepublicación y redirecciones del cambio de dominio por el proveedor HTTP
 * de Traefik (`redirecciones.ts`), su mezcla con las rutas de Mailway en
 * `GET /api/traefik/mailway` y las reservas que imponen: `domainClaimError`
 * no deja asignar esos nombres a otro proyecto, `webmailHostError` no deja
 * usarlos para el webmail y Ajustes → Cloudflare no borra su registro. Las
 * filas de `domain_redirects` y
 * `domain_prepublished` se escriben aquí con SQL directo: solo se prueba quién
 * las lee.
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import tls from 'tls';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { borrarRegistroCreado } from '../src/cloudflaredns';
import {
  closeDb,
  createProject,
  createService,
  deleteService,
  initDb,
  setServiceStopped,
  setSetting,
  updateService,
  upsertCloudflareDnsRecord,
} from '../src/db';
import { traefikLabels, traefikServiceName } from '../src/docker/containers';
import { domainClaimError, webmailHostError } from '../src/domainguard';
import { resetMailwayTraefikState, TraefikDynamicConfig } from '../src/mailwaytraefik';
import { ConfigSkyway, comprobarTlsLocal, configuracionTraefikSkyway, mezclarConfiguracion } from '../src/redirecciones';
import { setTraefikAcmeStateForTests } from '../src/tls';
import type { ProjectRow, ServiceRow } from '../src/types';
import { MW_BASE, MW_TOKEN, fakeFetch, mw } from './mailwayfake';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const DIA = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let adminCookie = '';
let raw: Database.Database;
let projA: ProjectRow;
let projB: ProjectRow;
let webA: ServiceRow;
let sinDominiosA: ServiceRow;

const h8 = (host: string) => crypto.createHash('sha256').update(host).digest('hex').slice(0, 8);

function redireccion(
  host: string,
  projectId: string,
  toHost: string,
  permanentFrom: number,
  opts: { migracion?: string; creada?: number } = {},
): void {
  raw
    .prepare(
      'INSERT OR REPLACE INTO domain_redirects (host, project_id, to_host, migration_id, permanent_from, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(host, projectId, toHost, opts.migracion ?? 'mig_1', permanentFrom, opts.creada ?? Date.now());
}

function prepublicado(host: string, projectId: string, serviceId: string, dnsOkAt: number | null): void {
  raw
    .prepare(
      'INSERT OR REPLACE INTO domain_prepublished (host, project_id, service_id, migration_id, dns_ok_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(host, projectId, serviceId, 'mig_1', dnsOkAt, Date.now());
}

function vaciar(): void {
  raw.prepare('DELETE FROM domain_redirects').run();
  raw.prepare('DELETE FROM domain_prepublished').run();
}

const conTls = () => {
  setSetting('letsencryptEmail', 'ops@acme.es');
  setTraefikAcmeStateForTests({ status: 'ok', email: 'ops@acme.es', checkedAt: Date.now() });
};
const sinTls = () => setSetting('letsencryptEmail', null);

const sondeo = () => app.inject({ method: 'GET', url: '/api/traefik/mailway' });

/** Hosts de las reglas por punto de entrada: Traefik no debe tener que elegir entre dos reglas iguales. */
function hostsPorEntrada(cfg: ConfigSkyway): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of Object.values(cfg.http.routers)) {
    const hosts = [...r.rule.matchAll(/Host\(`([^`]+)`\)/g)].map((m) => m[1]);
    for (const e of r.entryPoints) (out[e] ??= []).push(...hosts);
  }
  return out;
}

function sinReglasRepetidas(cfg: ConfigSkyway): void {
  for (const hosts of Object.values(hostsPorEntrada(cfg))) expect(hosts.length).toBe(new Set(hosts).size);
}

/** Destino de cada redirección publicada, por host. */
function destinos(cfg: ConfigSkyway): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [nombre, r] of Object.entries(cfg.http.routers)) {
    if (!nombre.startsWith('skyway-redir-') || nombre.endsWith('-secure')) continue;
    const host = /Host\(`([^`]+)`\)/.exec(r.rule)![1];
    out[host] = cfg.http.middlewares[nombre].redirectRegex!.replacement.replace(/^https?:\/\//, '').replace('${1}', '');
  }
  return out;
}

beforeAll(async () => {
  initDb();
  raw = new Database(path.join(process.env.DATA_DIR!, 'skyway.db'));
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

  projA = createProject('Tienda', 'tienda');
  projB = createProject('Otra', 'otra');
  webA = createService(projA.id, 'Web', 'web', 'git', {
    repoUrl: 'https://github.com/acme/web',
    branch: 'main',
    port: 3000,
    // El estado tras pasar: el nombre viejo ya no lo sirve el servicio y redirige.
    domains: ['www.actual.es'],
    webhookSecret: 'x',
  } as never);
  sinDominiosA = createService(projA.id, 'Worker', 'worker', 'git', {
    repoUrl: 'https://github.com/acme/worker',
    branch: 'main',
    port: 3000,
    domains: [],
    webhookSecret: 'x',
  } as never);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  raw.close();
  await app.close();
  closeDb();
});

beforeEach(() => {
  vaciar();
  conTls();
});

describe('redirecciones', () => {
  it('prioridad 1, noop@internal y la ruta conservada con ${1}; temporales hasta permanent_from', () => {
    const ahora = Date.now();
    redireccion('www.viejo.es', projA.id, 'www.nuevo.es', ahora + 7 * DIA);
    const nombre = `skyway-redir-${h8('www.viejo.es')}`;

    const cfg = configuracionTraefikSkyway(ahora);
    expect(cfg.http.routers[nombre]).toEqual({
      rule: 'Host(`www.viejo.es`)',
      entryPoints: ['web'],
      priority: 1,
      service: 'noop@internal',
      middlewares: [nombre],
    });
    expect(cfg.http.routers[`${nombre}-secure`]).toEqual({
      rule: 'Host(`www.viejo.es`)',
      entryPoints: ['websecure'],
      priority: 1,
      service: 'noop@internal',
      middlewares: [nombre],
      tls: { certResolver: 'le' },
    });
    const mw = cfg.http.middlewares[nombre].redirectRegex!;
    expect(mw).toEqual({ regex: '^https?://[^/]+(.*)$', replacement: 'https://www.nuevo.es${1}', permanent: false });
    // La misma sustitución que hace Traefik: ruta y consulta intactas, de http o de https.
    const aplicar = (url: string) => url.replace(new RegExp(mw.regex), mw.replacement.replace('${1}', '$1'));
    expect(aplicar('http://www.viejo.es/tienda/zapatos?talla=42#x')).toBe('https://www.nuevo.es/tienda/zapatos?talla=42#x');
    expect(aplicar('https://www.viejo.es:443/')).toBe('https://www.nuevo.es/');

    // Siete días después, permanente (301/308), sin tareas programadas: se calcula en cada sondeo.
    expect(configuracionTraefikSkyway(ahora + 7 * DIA).http.middlewares[nombre].redirectRegex!.permanent).toBe(true);
    expect(configuracionTraefikSkyway(ahora + 7 * DIA - 1).http.middlewares[nombre].redirectRegex!.permanent).toBe(false);
  });

  it('sin TLS: solo el router de web y la redirección a http', () => {
    sinTls();
    redireccion('www.viejo.es', projA.id, 'www.nuevo.es', Date.now());
    const nombre = `skyway-redir-${h8('www.viejo.es')}`;
    const cfg = configuracionTraefikSkyway();
    expect(Object.keys(cfg.http.routers)).toEqual([nombre]);
    expect(cfg.http.middlewares[nombre].redirectRegex!.replacement).toBe('http://www.nuevo.es${1}');
  });

  it('no publica filas con hosts que alterarían la regla', () => {
    redireccion('www.viejo.es`) || PathPrefix(`/', projA.id, 'www.nuevo.es', Date.now());
    redireccion('bien.viejo.es', projA.id, 'mal`.es', Date.now());
    redireccion('igual.viejo.es', projA.id, 'igual.viejo.es', Date.now());
    expect(configuracionTraefikSkyway()).toEqual({ http: { routers: {}, middlewares: {} } });
  });

  it('cambio de vuelta: el nombre que se prepublica o se vuelve a servir no redirige, y nunca hay un bucle', () => {
    const ahora = Date.now();
    const redirUno = `skyway-redir-${h8('www.uno.es')}`;
    const redirDos = `skyway-redir-${h8('www.dos.es')}`;
    const preUno = `skyway-pre-${h8('www.uno.es')}`;
    // Un primer cambio de www.uno.es a www.dos.es, ya terminado: su redirección
    // se queda (al menos 12 meses) y ya es permanente.
    const cfgBlog = {
      repoUrl: 'https://github.com/acme/blog',
      branch: 'main',
      port: 3000,
      domains: ['www.dos.es'],
      webhookSecret: 'x',
    };
    const blog = createService(projA.id, 'Blog', 'blog', 'git', cfgBlog as never);
    redireccion('www.uno.es', projA.id, 'www.dos.es', ahora - 30 * DIA, { migracion: 'mig_ida', creada: ahora - 40 * DIA });
    let cfg = configuracionTraefikSkyway(ahora);
    expect(destinos(cfg)).toEqual({ 'www.uno.es': 'www.dos.es' });

    try {
      // Un segundo cambio de vuelta prepublica www.uno.es: lo publica la
      // prepublicación y la redirección vieja deja de publicarse.
      prepublicado('www.uno.es', projA.id, blog.id, ahora);
      cfg = configuracionTraefikSkyway(ahora);
      expect(cfg.http.routers[preUno]).toBeDefined();
      expect(cfg.http.routers[redirUno]).toBeUndefined();
      expect(cfg.http.middlewares[redirUno]).toBeUndefined();
      sinReglasRepetidas(cfg);

      // Al pasar, el servicio vuelve a tener www.uno.es y www.dos.es redirige a él.
      updateService(blog.id, 'Blog', { ...cfgBlog, domains: ['www.uno.es'] } as never);
      redireccion('www.dos.es', projA.id, 'www.uno.es', ahora + 7 * DIA, { migracion: 'mig_vuelta' });
      cfg = configuracionTraefikSkyway(ahora);
      expect(destinos(cfg)).toEqual({ 'www.dos.es': 'www.uno.es' });
      sinReglasRepetidas(cfg);
      // Desplegado el servicio, se retira la prepublicación: la redirección vieja sigue sin publicarse.
      raw.prepare('DELETE FROM domain_prepublished WHERE host = ?').run('www.uno.es');
      cfg = configuracionTraefikSkyway(ahora + 8 * DIA);
      expect(Object.keys(cfg.http.routers).sort()).toEqual([redirDos, `${redirDos}-secure`]);
      expect(cfg.http.middlewares[redirDos].redirectRegex!.permanent).toBe(true);

      // Parado (o entre dos contenedores), el servicio sigue teniendo el nombre
      // en sus dominios: no aparece la redirección vieja.
      setServiceStopped(blog.id, true);
      expect(destinos(configuracionTraefikSkyway(ahora + 8 * DIA))).toEqual({ 'www.dos.es': 'www.uno.es' });
    } finally {
      // Borrado el servicio, ninguno de los dos nombres se sirve: el ciclo se
      // rompe quitando la redirección más antigua, la que el cambio de vuelta deshizo.
      deleteService(blog.id);
    }
    cfg = configuracionTraefikSkyway(ahora + 8 * DIA);
    expect(destinos(cfg)).toEqual({ 'www.dos.es': 'www.uno.es' });
    sinReglasRepetidas(cfg);
  });

  it('un ciclo se rompe por la más antigua según permanent_from; las cadenas se publican tal cual', () => {
    const ahora = Date.now();
    // created_at no cambia al reutilizar la fila de un nombre: decide permanent_from.
    redireccion('a.ciclo.es', projA.id, 'b.ciclo.es', ahora + 1 * DIA, { creada: ahora - 90 * DIA });
    redireccion('b.ciclo.es', projA.id, 'c.ciclo.es', ahora - 20 * DIA, { creada: ahora - 30 * DIA });
    redireccion('c.ciclo.es', projA.id, 'a.ciclo.es', ahora - 10 * DIA, { creada: ahora - 20 * DIA });
    redireccion('x.cadena.es', projA.id, 'y.cadena.es', ahora);
    redireccion('y.cadena.es', projA.id, 'z.cadena.es', ahora);
    const cfg = configuracionTraefikSkyway(ahora);
    expect(destinos(cfg)).toEqual({
      'a.ciclo.es': 'b.ciclo.es',
      'c.ciclo.es': 'a.ciclo.es',
      'x.cadena.es': 'y.cadena.es',
      'y.cadena.es': 'z.cadena.es',
    });
    sinReglasRepetidas(cfg);

    // Dos nombres que se redirigen el uno al otro, sin servicio: queda la más reciente.
    vaciar();
    redireccion('ida.es', projA.id, 'vuelta.es', ahora - 1);
    redireccion('vuelta.es', projA.id, 'ida.es', ahora);
    expect(destinos(configuracionTraefikSkyway(ahora))).toEqual({ 'vuelta.es': 'ida.es' });
  });
});

describe('prepublicación', () => {
  it('solo con dns_ok_at, hacia el servicio @docker de las etiquetas, con TLS solo si está activo', () => {
    prepublicado('www.nuevo.es', projA.id, webA.id, null);
    expect(configuracionTraefikSkyway().http.routers).toEqual({});

    prepublicado('www.nuevo.es', projA.id, webA.id, Date.now());
    const nombre = `skyway-pre-${h8('www.nuevo.es')}`;
    const base = traefikServiceName(projA, webA);
    // Es el servicio que declaran las etiquetas del contenedor.
    expect(traefikLabels(projA, webA, ['www.actual.es'], 3000)).toHaveProperty(`traefik.http.services.${base}.loadbalancer.server.port`);

    let cfg = configuracionTraefikSkyway();
    expect(cfg.http.routers[nombre]).toEqual({
      rule: 'Host(`www.nuevo.es`)',
      entryPoints: ['web'],
      priority: 1,
      service: `${base}@docker`,
      middlewares: ['skyway-pre-https'],
    });
    expect(cfg.http.routers[`${nombre}-secure`]).toEqual({
      rule: 'Host(`www.nuevo.es`)',
      entryPoints: ['websecure'],
      priority: 1,
      service: `${base}@docker`,
      tls: { certResolver: 'le' },
    });
    expect(cfg.http.middlewares['skyway-pre-https']).toEqual({ redirectScheme: { scheme: 'https', permanent: true } });

    sinTls();
    cfg = configuracionTraefikSkyway();
    expect(cfg.http.routers).toEqual({
      [nombre]: { rule: 'Host(`www.nuevo.es`)', entryPoints: ['web'], priority: 1, service: `${base}@docker` },
    });
    expect(cfg.http.middlewares).toEqual({});
  });

  it('no señala a un servicio sin dominios (no tiene servicio @docker) ni de otro proyecto', () => {
    prepublicado('www.nuevo.es', projA.id, sinDominiosA.id, Date.now());
    prepublicado('api.nuevo.es', projB.id, webA.id, Date.now());
    expect(configuracionTraefikSkyway().http.routers).toEqual({});
  });
});

describe('mezcla con la configuración de Mailway', () => {
  const mailway: TraefikDynamicConfig = {
    http: {
      routers: {
        'mailway-webmail': { rule: 'Host(`webmail.cliente.com`)', entryPoints: ['websecure'], service: 'mailway-webmail', tls: { certResolver: 'le' } },
        'mailway-http': { rule: 'Host(`webmail.cliente.com`)', entryPoints: ['web'], service: 'mailway-webmail', middlewares: ['mailway-https'] },
        'skyway-redir-00000000': { rule: 'Host(`www.ajeno.es`)', entryPoints: ['web'], service: 'mailway-webmail' },
        'mailway-roba': { rule: 'Host(`antes.viejo.es`)', entryPoints: ['web'], service: 'mailway-webmail' },
        'mailway-mw': { rule: 'Host(`otro.cliente.com`)', entryPoints: ['web'], service: 'mailway-webmail', middlewares: ['skyway-pre-https'] },
        'mailway-svc': { rule: 'Host(`otro2.cliente.com`)', entryPoints: ['web'], service: 'skyway-tienda-web' },
      },
      services: {
        'mailway-webmail': { loadBalancer: { servers: [{ url: 'http://mailway-webmail:80' }] } },
        'skyway-tienda-web': { loadBalancer: { servers: [{ url: 'http://mailway-x:80' }] } },
      },
      middlewares: {
        'mailway-https': { redirectScheme: { scheme: 'https', permanent: true } },
        'skyway-pre-https': { redirectScheme: { scheme: 'https', permanent: false } },
      },
    },
  };

  it('descarta lo de Mailway que empieza por «skyway-», lo que depende de ello y lo que pisa un host propio; lo de Skyway gana', () => {
    redireccion('antes.viejo.es', projA.id, 'www.nuevo.es', Date.now() + DIA);
    prepublicado('www.nuevo.es', projA.id, webA.id, Date.now());
    const propia = configuracionTraefikSkyway();
    const out = mezclarConfiguracion(mailway, propia) as Json;
    expect(Object.keys(out.http.routers).sort()).toEqual(
      ['mailway-http', 'mailway-webmail', ...Object.keys(propia.http.routers)].sort(),
    );
    expect(Object.keys(out.http.services)).toEqual(['mailway-webmail']);
    expect(out.http.middlewares['mailway-https']).toEqual({ redirectScheme: { scheme: 'https', permanent: true } });
    expect(out.http.middlewares['skyway-pre-https']).toEqual({ redirectScheme: { scheme: 'https', permanent: true } });
    expect(JSON.stringify(out)).not.toContain('www.ajeno.es');
  });

  it('sin nada que publicar, una configuración vacía', () => {
    expect(mezclarConfiguracion({}, configuracionTraefikSkyway())).toEqual({});
  });

  it('los routers del panel (SKYWAY_DOMAIN_EXTRA) se conservan aunque empiecen por «skyway-»', () => {
    const panel: TraefikDynamicConfig = {
      http: { routers: { 'skyway-panel-extra-x': { rule: 'Host(`x.acme.es`)', entryPoints: ['web'], service: 'skyway@docker' } } },
    };
    const out = mezclarConfiguracion({}, configuracionTraefikSkyway(), panel) as Json;
    expect(Object.keys(out.http.routers)).toEqual(['skyway-panel-extra-x']);
  });
});

describe('GET /api/traefik/mailway', () => {
  it('sin Mailway configurado sirve igualmente las redirecciones', async () => {
    let r = await sondeo();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({});

    redireccion('www.viejo.es', projA.id, 'www.nuevo.es', Date.now() + DIA);
    r = await sondeo();
    expect(r.statusCode).toBe(200);
    const nombre = `skyway-redir-${h8('www.viejo.es')}`;
    expect(Object.keys(r.json().http.routers).sort()).toEqual([nombre, `${nombre}-secure`]);
    expect(r.json().http.middlewares[nombre].redirectRegex.permanent).toBe(false);
  });

  it('con Mailway, mezcla sus rutas y descarta las que se hacen pasar por Skyway', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/mailway/config',
      headers: { cookie: adminCookie, ...SAME_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ baseUrl: MW_BASE, token: MW_TOKEN }),
    });
    expect(put.statusCode, put.body).toBe(200);
    resetMailwayTraefikState();
    mw.traefikConfig = {
      http: {
        routers: {
          'mailway-bueno': { rule: 'Host(`webmail.cliente.com`)', entryPoints: ['websecure'], service: 'mailway-webmail', tls: { certResolver: 'le' } },
          'skyway-pre-falso': { rule: 'Host(`www.ajeno.es`)', entryPoints: ['web'], service: 'mailway-webmail' },
          'mailway-roba': { rule: 'Host(`tomado.viejo.es`)', entryPoints: ['web'], service: 'mailway-webmail' },
        },
        services: { 'mailway-webmail': { loadBalancer: { servers: [{ url: 'http://mailway-webmail:80' }] } } },
      },
    };
    redireccion('tomado.viejo.es', projA.id, 'www.nuevo.es', Date.now() + DIA);
    const r = await sondeo();
    expect(r.statusCode).toBe(200);
    const nombre = `skyway-redir-${h8('tomado.viejo.es')}`;
    expect(Object.keys(r.json().http.routers).sort()).toEqual(['mailway-bueno', nombre, `${nombre}-secure`]);
    expect(r.body).not.toContain('www.ajeno.es');
    // La redirección es la única ruta del host viejo.
    expect(r.json().http.routers[nombre].service).toBe('noop@internal');
  });
});

describe('reservas de los nombres en uso', () => {
  it('domainClaimError rechaza los hosts de redirección y de prepublicación de otro proyecto, también a la administración', () => {
    // Nombres que ya no tiene ningún servicio: los publica Skyway por su cuenta.
    redireccion('antes.viejo.es', projA.id, 'www.nuevo.es', Date.now());
    prepublicado('www.nuevo.es', projA.id, webA.id, null);
    const mensaje = (d: string) =>
      `El dominio ${d} lo utiliza otro proyecto (redirección o cambio de dominio en curso) y no se puede asignar a este servicio.`;
    for (const isAdmin of [false, true]) {
      expect(domainClaimError(['ANTES.viejo.es'], { projectId: projB.id, serviceId: null, isAdmin })).toBe(mensaje('antes.viejo.es'));
      expect(domainClaimError(['www.nuevo.es'], { projectId: projB.id, serviceId: null, isAdmin })).toBe(mensaje('www.nuevo.es'));
    }
    // Lo que ya tenía el servicio no se vuelve a comprobar.
    expect(domainClaimError(['www.nuevo.es'], { projectId: projB.id, serviceId: null, isAdmin: false, current: ['www.nuevo.es'] })).toBeNull();
    // El propio proyecto sí (el asistente los pone en sus servicios al pasar y al volver).
    expect(domainClaimError(['www.nuevo.es'], { projectId: projA.id, serviceId: webA.id, isAdmin: false })).toBeNull();
    expect(domainClaimError(['antes.viejo.es'], { projectId: projA.id, serviceId: sinDominiosA.id, isAdmin: false })).toBeNull();
  });

  it('borrarRegistroCreado se niega con un host que redirige', async () => {
    // Ningún servicio usa el nombre viejo: solo la redirección lo retiene.
    upsertCloudflareDnsRecord({
      domain: 'antes.viejo.es',
      zone_id: 'zona_viejo',
      zone_name: 'viejo.es',
      record_id: 'rec_1',
      content: '203.0.113.10',
      project_id: projA.id,
    });
    redireccion('antes.viejo.es', projA.id, 'www.nuevo.es', Date.now());
    const auditar = vi.fn();
    await expect(borrarRegistroCreado('antes.viejo.es', auditar)).rejects.toMatchObject({
      statusCode: 409,
      message: 'El dominio antes.viejo.es redirige a otro nombre; quita antes la redirección.',
    });
    expect(auditar).not.toHaveBeenCalled();
  });

  it('borrarRegistroCreado se niega con un host que se prepublica, aunque su DNS aún no dé ok', async () => {
    // El registro lo crea el asistente al preparar; ningún servicio tiene el nombre hasta pasar.
    upsertCloudflareDnsRecord({
      domain: 'www.prep.es',
      zone_id: 'zona_prep',
      zone_name: 'prep.es',
      record_id: 'rec_2',
      content: '203.0.113.10',
      project_id: projA.id,
    });
    prepublicado('www.prep.es', projA.id, webA.id, null);
    const auditar = vi.fn();
    await expect(borrarRegistroCreado('www.prep.es', auditar)).rejects.toMatchObject({
      statusCode: 409,
      message: 'El dominio www.prep.es se está preparando en un cambio de dominio; cancela antes el cambio.',
    });
    expect(auditar).not.toHaveBeenCalled();
  });

  it('webmailHostError rechaza los hosts de redirección y de prepublicación, también del mismo proyecto', () => {
    redireccion('webmail.viejo.es', projA.id, 'webmail.nuevo.es', Date.now());
    prepublicado('webmail.prep.es', projA.id, webA.id, null);
    for (const host of ['webmail.viejo.es', 'WEBMAIL.prep.es']) {
      const h = host.toLowerCase();
      expect(webmailHostError(host, { isAdmin: false })).toBe(
        `El dominio ${h} lo utiliza un cambio de dominio de Skyway (redirección o nombre en preparación) y no se puede utilizar para el webmail.`,
      );
      // Solo la administración ve de qué proyecto es.
      expect(webmailHostError(host, { isAdmin: true })).toBe(
        `El dominio ${h} lo utiliza un cambio de dominio del proyecto «Tienda» (redirección o nombre en preparación) y no se puede utilizar para el webmail.`,
      );
    }
    expect(webmailHostError('webmail.libre.es', { isAdmin: false })).toBeNull();
  });
});

describe('comprobarTlsLocal', () => {
  it('desconocido sin Traefik (no resuelve el nombre o nadie escucha)', async () => {
    const sinTraefik = await comprobarTlsLocal('www.nuevo.es', { plazoMs: 3000 });
    expect(sinTraefik.estado).toBe('desconocido');

    const libre = await new Promise<number>((resolve) => {
      const srv = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = srv.address() as net.AddressInfo;
        srv.close(() => resolve(port));
      });
    });
    const cerrado = await comprobarTlsLocal('www.nuevo.es', { destino: '127.0.0.1', puerto: libre });
    expect(cerrado).toEqual({ estado: 'desconocido', detalle: 'No se ha podido conectar con Traefik para comprobar el certificado de www.nuevo.es.' });
  });

  const hayOpenssl = (() => {
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  describe.skipIf(!hayOpenssl)('contra un servidor TLS local', () => {
    let servidor: tls.Server;
    let puerto = 0;
    let cert = '';
    let dir = '';

    beforeAll(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-tls-'));
      execFileSync(
        'openssl',
        [
          'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
          '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '2',
          '-subj', '/CN=www.nuevo.es', '-addext', 'subjectAltName=DNS:www.nuevo.es',
        ],
        { stdio: 'ignore' },
      );
      cert = fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8');
      const key = fs.readFileSync(path.join(dir, 'key.pem'), 'utf8');
      servidor = tls.createServer({ key, cert }, (s) => s.end());
      await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', () => resolve()));
      puerto = (servidor.address() as net.AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => servidor.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('ok con un certificado válido para el nombre', async () => {
      const r = await comprobarTlsLocal('www.nuevo.es', { destino: '127.0.0.1', puerto, ca: cert });
      expect(r).toEqual({ estado: 'ok', detalle: 'Certificado válido para www.nuevo.es.' });
    });

    it('invalido con el certificado por defecto (autofirmado) o con uno que no incluye el nombre', async () => {
      const porDefecto = await comprobarTlsLocal('www.nuevo.es', { destino: '127.0.0.1', puerto });
      expect(porDefecto.estado).toBe('invalido');
      expect(porDefecto.detalle).toMatch(/todavía no tiene el certificado de www\.nuevo\.es/);
      const otroNombre = await comprobarTlsLocal('tienda.nuevo.es', { destino: '127.0.0.1', puerto, ca: cert });
      expect(otroNombre).toEqual({ estado: 'invalido', detalle: 'El certificado que sirve Traefik no incluye tienda.nuevo.es.' });
    });
  });
});
