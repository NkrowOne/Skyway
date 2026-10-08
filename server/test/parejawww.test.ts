/**
 * Pareja con o sin www de los dominios de un servicio.
 *
 * - La regla pura (`completarParejasWww`, `limpiarSinPareja`): al añadir un
 *   dominio propio registrable o su www, la otra mitad llega con él, salvo
 *   renuncia expresa; en una sola pasada, sin repetidos y sin crecer al
 *   aplicarla otra vez.
 * - Las rutas la aplican como red de seguridad (alta, edición y pilas), solo a
 *   los dominios nuevos: reordenar o guardar otra cosa no añade nada.
 * - Una pareja que usa otro servicio se omite sin error.
 * - La lista de renuncias se guarda limpia y acotada por la de dominios.
 */
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { closeDb, createService, initDb, listServices, setSetting } from '../src/db';
import { completarParejasWww, limpiarSinPareja, parejaWww } from '../src/dominioprincipal';
import { analyzeRailwayProject, runRailwayImport } from '../src/railway/importer';

/** Un proyecto de Railway con un servicio de imagen y sus dominios propios. */
vi.mock('../src/railway/client', async (original) => {
  const real = await original<typeof import('../src/railway/client')>();
  return {
    ...real,
    getRailwayVariables: async () => ({}),
    getRailwayProject: async () => ({
      id: 'rw1',
      name: 'De Railway',
      environments: [{ id: 'env1', name: 'production' }],
      services: [
        {
          id: 's1',
          name: 'web',
          repo: null,
          image: 'nginx:alpine',
          branch: null,
          startCommand: null,
          rootDirectory: null,
          buildCommand: null,
          customDomains: ['importado.es', 'app.importado.es', 'www.ocupado-rw.es'],
          serviceDomains: [],
          volumeMounts: [],
          healthcheckPath: null,
          numReplicas: null,
          restartPolicyType: null,
          cronSchedule: null,
          builder: null,
          domainPort: 80,
        },
      ],
    }),
  };
});

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const ROOT = 'apps.plataforma.com';

let app: FastifyInstance;
let cookie = '';
let projectId = '';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const r = await app.inject({ method, url, headers: { cookie, ...SAME_ORIGIN }, payload: body as never });
  return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : null };
}

const crear = (name: string, body: Record<string, unknown>) =>
  call('POST', `/api/projects/${projectId}/services`, { type: 'image', name, image: 'nginx', port: 80, ...body });

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
  const project = await call('POST', '/api/projects', { name: 'Bufete' });
  expect(project.status).toBe(201);
  projectId = project.json.project.id;
  setSetting('rootDomain', ROOT);
});

afterAll(async () => {
  await app.close();
  closeDb();
});

describe('regla pura', () => {
  it('parejaWww: solo el dominio registrable y su www', () => {
    expect(parejaWww('Bufete.ES')).toEqual({ falta: 'www.bufete.es', tipo: 'www' });
    expect(parejaWww('www.shop.co.uk')).toEqual({ falta: 'shop.co.uk', tipo: 'raiz' });
    expect(parejaWww('app.bufete.es')).toBeNull();
    expect(parejaWww('www.app.bufete.es')).toBeNull();
    expect(parejaWww(`web.${ROOT}`, ROOT)).toBeNull();
    expect(parejaWww(`www.${ROOT}`, ROOT)).toBeNull();
    expect(parejaWww('com.es')).toBeNull();
  });

  it('completa cada dominio propio, en el orden del dominio principal, y aplicarla otra vez no cambia nada', () => {
    const r = completarParejasWww(['bufete.es', 'www.tienda.com', 'app.bufete.es', `web.${ROOT}`], { rootDomain: ROOT });
    // Cada pareja hereda el puesto de su dominio: la del primero va delante.
    expect(r.domains).toEqual(['www.bufete.es', 'www.tienda.com', 'bufete.es', 'tienda.com', 'app.bufete.es', `web.${ROOT}`]);
    expect(r.anadidos).toEqual(['www.bufete.es', 'tienda.com']);
    const otra = completarParejasWww(r.domains, { rootDomain: ROOT });
    expect(otra).toEqual({ domains: r.domains, anadidos: [] });
    // La pareja ya presente (en otra forma) no se repite.
    expect(completarParejasWww(['bufete.es', 'WWW.Bufete.es.'], { rootDomain: ROOT })).toEqual({
      domains: ['www.bufete.es', 'bufete.es'],
      anadidos: [],
    });
  });

  it('respeta las renuncias, solo completa los nuevos y omite la pareja que no se puede asignar', () => {
    expect(completarParejasWww(['bufete.es'], { sinPareja: ['BUFETE.es'] }).domains).toEqual(['bufete.es']);
    expect(completarParejasWww(['bufete.es', 'tienda.com'], { nuevos: ['tienda.com'] }).domains).toEqual([
      'www.tienda.com',
      'bufete.es',
      'tienda.com',
    ]);
    expect(completarParejasWww(['bufete.es'], { disponible: (d) => d !== 'www.bufete.es' }).domains).toEqual(['bufete.es']);
  });

  it('limpiarSinPareja: solo dominios de la lista a los que les falta la pareja, sin repetidos', () => {
    expect(limpiarSinPareja(['bufete.es', 'bufete.es', 'quitado.es', 'app.bufete.es', 'tienda.com'], ['bufete.es', 'app.bufete.es', 'tienda.com', 'www.tienda.com'])).toEqual([
      'bufete.es',
    ]);
  });
});

describe('alta y edición de un servicio', () => {
  it('el alta añade la pareja; con renuncia, no, y la renuncia se guarda limpia', async () => {
    let r = await crear('web', { domains: ['bufete.es', 'app.bufete.es'] });
    expect(r.status).toBe(201);
    expect(r.json.service.config.domains).toEqual(['www.bufete.es', 'bufete.es', 'app.bufete.es']);

    r = await crear('solo', { domains: ['www.solo.es'], dominiosSinPareja: ['www.solo.es', 'otro.es'] });
    expect(r.status).toBe(201);
    expect(r.json.service.config.domains).toEqual(['www.solo.es']);
    expect(r.json.service.config.dominiosSinPareja).toEqual(['www.solo.es']);
  });

  it('quitar una mitad con renuncia no la vuelve a añadir; volver a añadirla borra la renuncia', async () => {
    let r = await crear('quitar', { domains: ['quitar.es'] });
    const id = r.json.service.id as string;
    expect(r.json.service.config.domains).toEqual(['www.quitar.es', 'quitar.es']);

    r = await call('PATCH', `/api/services/${id}`, { config: { domains: ['quitar.es'], dominiosSinPareja: ['quitar.es'] } });
    expect(r.status).toBe(200);
    expect(r.json.service.config.domains).toEqual(['quitar.es']);
    expect(r.json.service.config.dominiosSinPareja).toEqual(['quitar.es']);

    // Guardar otra cosa con la lista entera (como hace Ajustes) conserva la renuncia.
    r = await call('PATCH', `/api/services/${id}`, { config: { domains: ['quitar.es'], healthcheckPath: '/salud' } });
    expect(r.json.service.config.domains).toEqual(['quitar.es']);
    expect(r.json.service.config.dominiosSinPareja).toEqual(['quitar.es']);

    // Quitar y volver a poner el mismo dominio no es un dominio nuevo.
    r = await call('PATCH', `/api/services/${id}`, { config: { domains: ['quitar.es'], dominiosSinPareja: [] } });
    expect(r.json.service.config.domains).toEqual(['quitar.es']);
    expect(r.json.service.config.dominiosSinPareja).toBeUndefined();

    r = await call('PATCH', `/api/services/${id}`, { config: { domains: ['quitar.es', 'www.quitar.es'], dominiosSinPareja: ['quitar.es'] } });
    expect(r.json.service.config.domains).toEqual(['www.quitar.es', 'quitar.es']);
    // Con la pareja presente, la renuncia sobra.
    expect(r.json.service.config.dominiosSinPareja).toBeUndefined();
  });

  it('un servicio antiguo sin pareja no la recibe al reordenar ni al guardar otra cosa: ni redespliegue', async () => {
    const generado = `antiguo.${ROOT}`;
    const antiguo = createService(projectId, 'antiguo', 'antiguo', 'image', { image: 'nginx', port: 80, domains: ['antiguo.es', generado] });
    // El subdominio generado delante: la regla lo devuelve al final, así que no es un cambio.
    let r = await call('PATCH', `/api/services/${antiguo.id}`, { config: { domains: [generado, 'antiguo.es'] } });
    expect(r.status).toBe(200);
    expect(r.json.needsRedeploy).toBe(false);
    expect(r.json.service.config.domains).toEqual(['antiguo.es', generado]);
    r = await call('PATCH', `/api/services/${antiguo.id}`, { config: { domains: ['antiguo.es', generado], startCmd: null } });
    expect(r.json.needsRedeploy).toBe(false);
    expect(r.json.service.config.domains).toEqual(['antiguo.es', generado]);
    // Añadir otro dominio solo completa ese.
    r = await call('PATCH', `/api/services/${antiguo.id}`, { config: { domains: ['antiguo.es', generado, 'nuevo.es'] } });
    expect(r.json.needsRedeploy).toBe(true);
    expect(r.json.service.config.domains).toEqual(['www.nuevo.es', 'antiguo.es', 'nuevo.es', generado]);
  });

  it('la pareja que usa otro servicio se omite sin error', async () => {
    let r = await crear('dueno-www', { domains: ['www.compartido.es'], dominiosSinPareja: ['www.compartido.es'] });
    expect(r.status).toBe(201);
    r = await crear('raiz', { domains: ['compartido.es'] });
    expect(r.status).toBe(201);
    expect(r.json.service.config.domains).toEqual(['compartido.es']);
    // Pedirla expresamente sí es un conflicto.
    r = await call('PATCH', `/api/services/${r.json.service.id}`, { config: { domains: ['compartido.es', 'www.compartido.es'] } });
    expect(r.status).toBe(409);
  });

  it('la lista de renuncias está acotada en la petición y nunca crece más que la de dominios', async () => {
    const muchos = Array.from({ length: 201 }, (_, i) => `d${i}.es`);
    let r = await crear('tope', { domains: ['tope.es'], dominiosSinPareja: muchos });
    expect(r.status).toBe(400);
    r = await crear('acotada', { domains: ['acotada.es'], dominiosSinPareja: [...muchos.slice(0, 199), 'acotada.es'] });
    expect(r.status).toBe(201);
    expect(r.json.service.config.dominiosSinPareja).toEqual(['acotada.es']);
    r = await call('PATCH', `/api/services/${r.json.service.id}`, { config: { dominiosSinPareja: muchos.slice(0, 50) } });
    expect(r.status).toBe(200);
    expect(r.json.service.config.dominiosSinPareja).toBeUndefined();
    expect(r.json.needsRedeploy).toBe(false);
  });

  it('una pila con dominio propio también recibe la pareja y se configura con el principal', async () => {
    const r = await call('POST', `/api/projects/${projectId}/stacks`, { stack: 'n8n', domain: 'flujos.es' });
    expect(r.status).toBe(201);
    expect(r.json.publicUrl).toMatch(/^https?:\/\/www\.flujos\.es$/);
    const publicos = r.json.services.filter((s: Json) => (s.config?.domains ?? []).length > 0);
    expect(publicos.map((s: Json) => s.config.domains)).toEqual([['www.flujos.es', 'flujos.es']]);
  });

  it('la importación de Railway enseña la pareja en la vista previa y la omite si la usa otro servicio', async () => {
    const plan = await analyzeRailwayProject('token-de-railway', 'rw1', 'env1');
    const web = plan.services.find((x) => x.railwayName === 'web')!;
    expect(web.domains).toEqual(['www.importado.es', 'www.ocupado-rw.es', 'importado.es', 'app.importado.es', 'ocupado-rw.es']);
    expect(web.notes).toEqual(
      expect.arrayContaining([expect.stringMatching(/Se añade también www\.importado\.es/), expect.stringMatching(/Se añade también ocupado-rw\.es/)]),
    );

    const otro = await crear('ocupa', { domains: ['ocupado-rw.es'], dominiosSinPareja: ['ocupado-rw.es'] });
    expect(otro.status).toBe(201);
    const { project, report } = await runRailwayImport('token-de-railway', 'rw1', 'env1', { projectName: 'importado' });
    const servicio = listServices(project.id).find((x) => x.name === 'web')!;
    expect((servicio.config as { domains: string[] }).domains).toEqual(['www.importado.es', 'www.ocupado-rw.es', 'importado.es', 'app.importado.es']);
    expect(report.created[0].notes).toEqual(expect.arrayContaining([expect.stringMatching(/Dominio omitido: El dominio ocupado-rw\.es ya está asignado/)]));
  });
});
