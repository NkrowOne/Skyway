/**
 * Dominio principal de un servicio y comprobación del DNS de sus dominios.
 *
 * - La regla (`ordenarDominios`/`dominioPrincipal`): www primero, el resto de
 *   dominios propios en su orden y el subdominio generado al final.
 * - Se aplica al guardar (alta y edición) y al leer: un servicio guardado con
 *   el orden antiguo publica ya el principal correcto en PUBLIC_URL,
 *   PUBLIC_DOMAIN, RAILWAY_PUBLIC_DOMAIN y RAILWAY_STATIC_URL.
 * - Un dominio detrás del proxy de Cloudflare tiene su propio diagnóstico.
 */
import dns from 'dns';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { closeDb, createProject, createService, getService, initDb, setEnv, setSetting, updateService } from '../src/db';
import { applyRailwayCompatEnv } from '../src/deploy/deployer';
import { dominioPrincipal, esSubdominioGenerado, ordenarDominios } from '../src/dominioprincipal';
import { checkDomain, clasificarDns, CLOUDFLARE_IPV4, esIpDeCloudflare, ipEnCidr } from '../src/domains';
import { buildPlan } from '../src/integrations';
import { adviseNeeds } from '../src/needs';
import type { DetectedNeeds, GitConfig } from '../src/types';
import { resolveServiceEnv, systemVars } from '../src/variables';

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const ROOT = 'apps.plataforma.com';
const IP = '203.0.113.10';

let app: FastifyInstance;
let cookie = '';
let projectId = '';

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
  const project = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie, ...SAME_ORIGIN }, payload: { name: 'Bufete' } });
  expect(project.statusCode, project.body).toBe(201);
  projectId = JSON.parse(project.body).project.id as string;
  setSetting('rootDomain', ROOT);
  setSetting('serverIp', IP);
});

afterAll(async () => {
  await app.close();
  closeDb();
});

describe('ordenarDominios y dominioPrincipal', () => {
  it('el dominio con www es el principal aunque se añadiera después', () => {
    expect(ordenarDominios(['codanuancelegal.com', 'www.codanuancelegal.com'], ROOT)).toEqual([
      'www.codanuancelegal.com',
      'codanuancelegal.com',
    ]);
    expect(dominioPrincipal(['codanuancelegal.com', 'www.codanuancelegal.com'], ROOT)).toBe('www.codanuancelegal.com');
  });

  it('el subdominio generado va al final, salvo que sea el único', () => {
    expect(ordenarDominios([`web.${ROOT}`, 'tienda.es', 'www.tienda.es'], ROOT)).toEqual(['www.tienda.es', 'tienda.es', `web.${ROOT}`]);
    expect(dominioPrincipal([`web.${ROOT}`, 'tienda.es'], ROOT)).toBe('tienda.es');
    expect(dominioPrincipal([`web.${ROOT}`], ROOT)).toBe(`web.${ROOT}`);
    // `www.<raíz>` es el dominio del operador, no uno generado.
    expect(esSubdominioGenerado(`www.${ROOT}`, ROOT)).toBe(false);
    expect(esSubdominioGenerado(`a.b.${ROOT}`, ROOT)).toBe(false);
    expect(esSubdominioGenerado(`web.${ROOT}`, null)).toBe(false);
  });

  it('dos dominios propios distintos conservan su orden', () => {
    expect(ordenarDominios(['b.ejemplo.com', 'a.ejemplo.com'], ROOT)).toEqual(['b.ejemplo.com', 'a.ejemplo.com']);
    expect(ordenarDominios(['www.uno.com', 'dos.com', 'www.dos.com'], ROOT)).toEqual(['www.uno.com', 'www.dos.com', 'dos.com']);
  });

  it('normaliza mayúsculas, espacios y el punto final, sin repetidos, y aplicarla dos veces da lo mismo', () => {
    const una = ordenarDominios([' Tienda.ES ', 'WWW.tienda.es.', 'tienda.es', ''], ROOT);
    expect(una).toEqual(['www.tienda.es', 'tienda.es']);
    expect(ordenarDominios(una, ROOT)).toEqual(una);
    expect(dominioPrincipal([], ROOT)).toBeNull();
    expect(dominioPrincipal(undefined, ROOT)).toBeNull();
  });
});

describe('al guardar, la lista queda en el orden del dominio principal', () => {
  it('alta de un servicio con el dominio sin www primero', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/services`,
      headers: { cookie, ...SAME_ORIGIN },
      payload: { type: 'image', name: 'web', image: 'nginx', port: 80, domains: [`web.${ROOT}`, 'Bufete.es', 'www.bufete.es'] },
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = JSON.parse(r.body).service.id as string;
    expect((getService(id)!.config as GitConfig).domains).toEqual(['www.bufete.es', 'bufete.es', `web.${ROOT}`]);
  });

  it('edición: se ordena, y reordenar no obliga a volver a desplegar', async () => {
    const project = createProject('Orden', `orden-${Date.now()}`);
    const svc = createService(project.id, 'web', 'web', 'image', { image: 'nginx', port: 80, domains: [] });
    // Guardado con el orden antiguo, como un servicio de antes de esta regla.
    updateService(svc.id, 'web', { image: 'nginx', port: 80, domains: ['abogados.es', 'www.abogados.es'] });

    let r = await app.inject({
      method: 'PATCH',
      url: `/api/services/${svc.id}`,
      headers: { cookie, ...SAME_ORIGIN },
      payload: { config: { domains: ['abogados.es', 'www.abogados.es'] }, domainsBase: ['www.abogados.es', 'abogados.es'] },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(JSON.parse(r.body).needsRedeploy).toBe(false);
    expect(JSON.parse(r.body).service.config.domains).toEqual(['www.abogados.es', 'abogados.es']);

    // Añadir uno sí es un cambio.
    r = await app.inject({
      method: 'PATCH',
      url: `/api/services/${svc.id}`,
      headers: { cookie, ...SAME_ORIGIN },
      payload: { config: { domains: [`abogados.${ROOT}`, 'abogados.es', 'www.abogados.es'] }, domainsBase: ['www.abogados.es', 'abogados.es'] },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(JSON.parse(r.body).needsRedeploy).toBe(true);
    expect((getService(svc.id)!.config as GitConfig).domains).toEqual(['www.abogados.es', 'abogados.es', `abogados.${ROOT}`]);
  });
});

describe('dirección pública: el principal también con el orden antiguo guardado', () => {
  it('PUBLIC_URL y PUBLIC_DOMAIN, también al referenciarlas desde otro servicio', () => {
    const project = createProject('Antiguo', `antiguo-${Date.now()}`);
    const web = createService(project.id, 'web', 'web', 'image', { image: 'nginx', port: 80, domains: [] });
    updateService(web.id, 'web', { image: 'nginx', port: 80, domains: [`web.${ROOT}`, 'codanuancelegal.com', 'www.codanuancelegal.com'] });
    const fresh = getService(web.id)!;
    const vars = systemVars(fresh);
    expect(vars.PUBLIC_DOMAIN).toBe('www.codanuancelegal.com');
    expect(vars.PUBLIC_URL).toBe('http://www.codanuancelegal.com');

    setSetting('letsencryptEmail', 'tls@example.com');
    try {
      expect(systemVars(fresh).PUBLIC_URL).toBe('https://www.codanuancelegal.com');
      const otro = createService(project.id, 'api', 'api', 'image', { image: 'nginx', port: 80, domains: [] });
      updateService(otro.id, 'api', { image: 'nginx', port: 80, domains: [] });
      // Una referencia a la variable de sistema de otro servicio.
      setEnv(otro.id, { SITIO: '${{web.PUBLIC_URL}}' });
      expect(resolveServiceEnv(getService(otro.id)!).SITIO).toBe('https://www.codanuancelegal.com');
    } finally {
      setSetting('letsencryptEmail', null);
    }
  });

  it('RAILWAY_PUBLIC_DOMAIN y RAILWAY_STATIC_URL, sin sobrescribir lo definido a mano', () => {
    const project = createProject('Railway', `railway-${Date.now()}`);
    const svc = createService(project.id, 'web', 'web', 'image', { image: 'nginx', port: 80, domains: [] });
    const domains = ['codanuancelegal.com', 'www.codanuancelegal.com'];
    const env: Record<string, string> = {};
    applyRailwayCompatEnv(env, project, svc, 'dep-inexistente', domains, 80);
    expect(env.RAILWAY_PUBLIC_DOMAIN).toBe('www.codanuancelegal.com');
    expect(env.RAILWAY_STATIC_URL).toBe('http://www.codanuancelegal.com');

    const propio: Record<string, string> = { RAILWAY_PUBLIC_DOMAIN: 'otra.com' };
    applyRailwayCompatEnv(propio, project, svc, 'dep-inexistente', domains, 80);
    expect(propio.RAILWAY_PUBLIC_DOMAIN).toBe('otra.com');
  });

  it('las propuestas de variables y el plan del manifiesto referencian PUBLIC_URL si hay dominio', () => {
    const needs: DetectedNeeds = { engines: [], expectedVars: ['APP_URL'], envFile: '.env.example', sources: [], detectedAt: 0 };
    const con = adviseNeeds(needs, { serviceName: 'web', domains: [`web.${ROOT}`, 'www.bufete.es'], defined: new Set() }, []);
    expect(con.suggestions).toEqual([expect.objectContaining({ key: 'APP_URL', value: '${{web.PUBLIC_URL}}', refVar: 'PUBLIC_URL' })]);
    const sin = adviseNeeds(needs, { serviceName: 'web', domains: [], defined: new Set() }, []);
    expect(sin.suggestions).toEqual([]);
    expect(sin.missing).toEqual(['APP_URL']);

    const project = createProject('Plan', `plan-${Date.now()}`);
    const svc = createService(project.id, 'web', 'web', 'git', {
      repoUrl: 'https://github.com/x/y',
      branch: 'main',
      port: 3000,
      domains: [],
      webhookSecret: 'w',
    } as GitConfig);
    const manifiesto: DetectedNeeds = {
      ...needs,
      expectedVars: [],
      manifest: { version: 1, env: { APP_URL: { from: 'self.public_url' } } },
      manifestFile: 'skyway.json',
    };
    const plan = buildPlan({ project, user: null, target: { service: svc, domains: ['bufete.es', 'www.bufete.es'] }, needs: manifiesto, mail: null });
    expect(plan.vars.find((v) => v.name === 'APP_URL')).toMatchObject({ status: 'apply', detail: '${{web.PUBLIC_URL}}' });
  });
});

describe('proxy de Cloudflare', () => {
  it('ipEnCidr y los rangos publicados', () => {
    expect(ipEnCidr('104.21.5.9', '104.16.0.0/13')).toBe(true);
    expect(ipEnCidr('104.24.0.1', '104.16.0.0/13')).toBe(false);
    expect(ipEnCidr('10.0.0.1', '0.0.0.0/0')).toBe(true);
    expect(ipEnCidr('10.0.0.1', '10.0.0.1/32')).toBe(true);
    expect(ipEnCidr('10.0.0.2', '10.0.0.1/32')).toBe(false);
    expect(ipEnCidr('300.0.0.1', '0.0.0.0/0')).toBe(false);
    expect(ipEnCidr('2606:4700::1', '104.16.0.0/13')).toBe(false);
    expect(CLOUDFLARE_IPV4).toHaveLength(15);
    for (const ip of ['172.67.150.20', '104.21.48.1', '188.114.97.3', '162.159.1.1', '131.0.75.255', '173.245.63.255']) {
      expect(esIpDeCloudflare(ip), ip).toBe(true);
    }
    for (const ip of [IP, '8.8.8.8', '172.72.0.1', '173.245.64.0', '131.0.76.0']) {
      expect(esIpDeCloudflare(ip), ip).toBe(false);
    }
  });

  it('clasificarDns: correcto, proxy de Cloudflare, otra IP y sin IP del servidor', () => {
    expect(clasificarDns('a.es', [IP], IP).status).toBe('ok');
    const proxy = clasificarDns('a.es', ['104.21.48.1', '172.67.150.20'], IP);
    expect(proxy.status).toBe('cloudflare_proxy');
    expect(proxy.message).toMatch(/proxy de Cloudflare/);
    expect(proxy.message).toMatch(/«Full \(strict\)» o «Full»/);
    expect(proxy.message).toMatch(/acme-challenge/);
    expect(proxy.message).toMatch(/«Solo DNS» \(nube gris\)/);
    // Se sabe que pasa por Cloudflare aunque no se conozca la IP del servidor.
    expect(clasificarDns('a.es', ['104.21.48.1'], null).status).toBe('cloudflare_proxy');
    // Mezclado con una IP que no es de Cloudflare: es otra IP.
    expect(clasificarDns('a.es', ['104.21.48.1', '198.51.100.1'], IP).status).toBe('wrong_ip');
    expect(clasificarDns('a.es', ['198.51.100.1'], IP).status).toBe('wrong_ip');
    expect(clasificarDns('a.es', ['198.51.100.1'], null).status).toBe('unknown');
  });

  it('checkDomain y POST /api/domains/check con el resolutor simulado', async () => {
    const espia = vi.spyOn(dns.promises.Resolver.prototype, 'resolve4');
    try {
      espia.mockResolvedValueOnce(['104.21.48.1'] as never);
      expect((await checkDomain('www.bufete.es')).status).toBe('cloudflare_proxy');

      espia.mockResolvedValueOnce([IP] as never);
      const r = await app.inject({ method: 'POST', url: '/api/domains/check', headers: { cookie, ...SAME_ORIGIN }, payload: { domain: 'bufete.es' } });
      expect(r.statusCode, r.body).toBe(200);
      expect(JSON.parse(r.body).check).toMatchObject({ domain: 'bufete.es', status: 'ok', expectedIp: IP });

      espia.mockRejectedValueOnce(Object.assign(new Error('sin registro'), { code: 'ENOTFOUND' }));
      expect((await checkDomain('nuevo.bufete.es')).status).toBe('no_record');
    } finally {
      espia.mockRestore();
    }
  });
});
