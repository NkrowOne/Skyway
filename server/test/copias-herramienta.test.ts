/**
 * Herramienta de las copias externas (`tools/copias.ts`), con la que el
 * orquestador del host (`scripts/copias/copias.sh`) sabe qué copiar y, tras
 * restaurar en otro servidor, lleva la IP del servidor anterior a la nueva. Se
 * llama a `ejecutarCopias` sin lanzar procesos.
 *
 * - `inventario`: proyectos y servicios de todos los tipos, con réplicas,
 *   volúmenes, órdenes de volcado y la imagen que corre; sin Docker (aquí el
 *   cliente de Docker falla con cualquier uso: con el panel parado se ejecuta
 *   sin el socket), sin red y sin un solo secreto en la salida.
 * - `repuntar`: simulación y aplicación sobre el doble de Cloudflare de
 *   `cloudflarefake.ts`, al que la prueba añade lo único que escribe la
 *   herramienta (un PATCH cuyo cuerpo es solo `content`); sin token de
 *   Cloudflare; fallos de Cloudflare; argumentos no válidos.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOUDFLARE_SETTING } from '../src/cloudflareconfig';
import { config } from '../src/config';
import {
  closeDb,
  createDeployment,
  createProject,
  createService,
  getCloudflareDnsRecord,
  getSetting,
  initDb,
  listAudit,
  setEnv,
  setProjectVars,
  setServiceStopped,
  setSetting,
  updateDeployment,
  upsertCloudflareDnsRecord,
} from '../src/db';
import { dockerQuery } from '../src/docker/client';
import { ejecutarCopias } from '../src/tools/copias';
import type { GitConfig, ProjectRow, ServiceRow } from '../src/types';
import { CF_HOST, type CfRegistroFalso, type CfZonaFalsa, cf, cloudflareFetch, registro, reiniciarCloudflare, zona } from './cloudflarefake';

/** Usos del cliente de Docker: el inventario no puede tener ninguno. */
const usosDocker = vi.hoisted(() => [] as string[]);
vi.mock('../src/docker/client', () => {
  const cliente = new Proxy(
    {},
    {
      get(_objeto, prop) {
        // Lo que mira cualquier herramienta al inspeccionar un valor no es un uso.
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        usosDocker.push(String(prop));
        throw new Error(`Docker no está disponible en esta prueba (${String(prop)}).`);
      },
    },
  );
  return {
    docker: cliente,
    dockerQuery: cliente,
    dockerAvailable: async () => {
      usosDocker.push('dockerAvailable');
      return false;
    },
  };
});

// El cuerpo de una respuesta JSON es frontera: se inspecciona sin tipar.
type Json = any;

const TOKEN_CF = 'TokenDeCloudflareDeLasCopias_0123456789';
const ANTERIOR = '198.51.100.7';
const NUEVA = '203.0.113.20';
const SECRETOS = [
  TOKEN_CF,
  'secreto-de-postgres',
  'secreto-del-webhook',
  'secreto-de-compilacion',
  'secreto-del-proyecto',
  'ghp_secretoDeGitHub0123456789',
  'secreto-de-telegram',
];

/** Registros cuyo cambio de destino rechaza Cloudflare. */
const rechazados = new Set<string>();
/** Zonas cuyos registros el token no puede leer (las ve en el listado de zonas, pero sin permiso de DNS). */
const sinPermisoDns = new Set<string>();

function respuesta(status: number, cuerpo: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ success: status < 400, errors: [], messages: [], result: null, ...cuerpo }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fallo = (status: number, code: number, message: string) => respuesta(status, { errors: [{ code, message }] });

/**
 * Cambio de destino de un registro, con las comprobaciones del doble: token
 * activo, zona visible y registro existente. Lo demás del registro no cambia.
 */
function cambiarDestino(zoneId: string, recordId: string, content: string, auth: string | null): Response {
  const token = cf.tokens.get((auth ?? '').replace(/^Bearer /, ''));
  if (!token || token.status !== 'active') return fallo(403, 9109, 'Invalid access token');
  if (!token.zoneIds.includes(zoneId)) return fallo(403, 10000, 'Authentication error');
  const r = cf.records.find((x) => x.zoneId === zoneId && x.id === recordId);
  if (!r) return fallo(404, 81044, 'Record does not exist.');
  if (rechazados.has(recordId)) return fallo(400, 1004, 'DNS Validation Error');
  r.content = content;
  return respuesta(200, { result: r });
}

/**
 * `fetch` de la prueba: solo existe el Cloudflare de `cloudflarefake.ts`, que
 * únicamente admite PATCH de `proxied`; aquí se le añade un PATCH cuyo cuerpo
 * es exactamente `{ content }`. Cualquier otro cambio lo rechaza el doble
 * (405). Nada sale a la red.
 */
async function fetchDoble(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.host !== CF_HOST) throw new TypeError('fetch failed');
  const method = (init.method ?? 'GET').toUpperCase();
  const ruta = url.pathname.replace(/^\/client\/v4/, '');
  const auth = new Headers(init.headers).get('authorization');
  const cuerpo = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
  const lista = ruta.match(/^\/zones\/([^/]+)\/dns_records$/);
  if (method === 'GET' && lista && sinPermisoDns.has(lista[1])) {
    cf.calls.push({ method, path: ruta, query: Object.fromEntries(url.searchParams.entries()), auth, body: undefined });
    return fallo(403, 10000, 'Authentication error');
  }
  const uno = ruta.match(/^\/zones\/([^/]+)\/dns_records\/([^/]+)$/);
  if (method === 'PATCH' && uno && cuerpo && Object.keys(cuerpo).join(',') === 'content' && typeof cuerpo.content === 'string') {
    cf.calls.push({ method, path: ruta, query: {}, auth, body: cuerpo });
    return cambiarDestino(uno[1], uno[2], cuerpo.content, auth);
  }
  return cloudflareFetch(url, init);
}

const fetchFalso = vi.fn(fetchDoble);

async function copias(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await ejecutarCopias(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

/** Lo que la herramienta ha escrito en Cloudflare. */
const escrituras = () => cf.calls.filter((c) => c.method !== 'GET');

/** Entradas de auditoría de `repuntar` que no estaban en `previas`. */
function auditoriaNueva(previas: Set<string>) {
  return listAudit({ action: 'server_ip_repointed' }).filter((a) => !previas.has(a.id));
}

const idsAuditoria = () => new Set(listAudit({ action: 'server_ip_repointed' }).map((a) => a.id));

function gitCfg(extra: Partial<GitConfig> = {}): GitConfig {
  return { repoUrl: 'https://github.com/acme/web', branch: 'main', port: 3000, domains: [], webhookSecret: 'w', ...extra };
}

beforeAll(() => {
  initDb();
  vi.stubGlobal('fetch', fetchFalso);
});

afterAll(() => {
  vi.unstubAllGlobals();
  closeDb();
});

// ======================= inventario =======================

describe('inventario: lo que hay que copiar, sin Docker ni secretos', () => {
  let acme: ProjectRow;
  let vacio: ProjectRow;
  let pg: ServiceRow;
  let cache: ServiceRow;
  let docs: ServiceRow;
  let web: ServiceRow;
  let worker: ServiceRow;
  let ficheros: ServiceRow;
  let desplegado: string;

  beforeAll(() => {
    setSetting('serverIp', ANTERIOR);
    setSetting('serverIpv6', '2001:db8::7');
    setSetting('rootDomain', 'ejemplo.com');
    setSetting(CLOUDFLARE_SETTING.token, TOKEN_CF);
    setSetting('githubToken', 'ghp_secretoDeGitHub0123456789');
    setSetting('alertTelegramToken', '123456:secreto-de-telegram');

    acme = createProject('Web de Acme', 'web-acme', 'Acme', null);
    pg = createService(acme.id, 'Base de datos', 'db', 'database', { template: 'postgres', version: '16' });
    setEnv(pg.id, { POSTGRES_PASSWORD: 'secreto-de-postgres' });
    cache = createService(acme.id, 'Caché', 'cache', 'database', { template: 'redis', version: '7' });
    docs = createService(acme.id, 'Documentos', 'docs', 'database', { template: 'mongo', version: '7' });
    web = createService(
      acme.id,
      'Web',
      'web',
      'git',
      gitCfg({
        replicas: 2,
        volumes: [{ name: 'skyway-web-acme-web-data', containerPath: '/app/data' }],
        webhookSecret: 'secreto-del-webhook',
        buildArgs: { NPM_TOKEN: 'secreto-de-compilacion' },
      }),
    );
    setProjectVars(acme.id, { API_KEY: 'secreto-del-proyecto' });

    // El último correcto con imagen es el que corre: ni uno anterior, ni uno
    // fallido, ni uno correcto sin imagen, ni uno en marcha lo sustituyen.
    const viejo = createDeployment(web.id, 'manual');
    updateDeployment(viejo.id, { status: 'success', image_tag: 'skyway/web-acme-web:aaaa1111', commit_sha: 'a'.repeat(40) });
    const bueno = createDeployment(web.id, 'webhook');
    updateDeployment(bueno.id, { status: 'success', image_tag: 'skyway/web-acme-web:bbbb2222', commit_sha: 'b'.repeat(40) });
    desplegado = bueno.id;
    const fallido = createDeployment(web.id, 'manual');
    updateDeployment(fallido.id, { status: 'failed', image_tag: 'skyway/web-acme-web:cccc3333', commit_sha: 'c'.repeat(40) });
    const sinImagen = createDeployment(web.id, 'manual');
    updateDeployment(sinImagen.id, { status: 'success', commit_sha: 'd'.repeat(40) });
    const enMarcha = createDeployment(web.id, 'manual');
    updateDeployment(enMarcha.id, { status: 'building', image_tag: 'skyway/web-acme-web:eeee5555' });

    // Sin ningún despliegue correcto todavía.
    worker = createService(acme.id, 'Worker', 'worker', 'git', gitCfg());
    const roto = createDeployment(worker.id, 'manual');
    updateDeployment(roto.id, { status: 'failed', image_tag: 'skyway/web-acme-worker:ffff6666' });

    ficheros = createService(acme.id, 'Ficheros', 'ficheros', 'image', {
      image: 'nginx:1.27',
      port: 80,
      domains: [],
      replicas: 3,
      volumes: [
        { name: 'skyway-web-acme-ficheros-html', containerPath: '/usr/share/nginx/html' },
        { name: 'skyway-web-acme-ficheros-conf', containerPath: '/etc/nginx/conf.d' },
      ],
    });
    // Los servicios de imagen también despliegan, pero lo que cuenta es la imagen configurada.
    const img = createDeployment(ficheros.id, 'manual', 'nginx:1.27');
    updateDeployment(img.id, { status: 'success' });
    setServiceStopped(ficheros.id, true);

    vacio = createProject('Proyecto vacío', 'vacio', null, null);
  });

  it('el cliente de Docker de la prueba falla con cualquier uso', () => {
    expect(() => dockerQuery.ping()).toThrow(/Docker no está disponible/);
    usosDocker.length = 0;
  });

  it('una línea JSON con los ajustes, los proyectos y cada servicio', async () => {
    const llamadas = fetchFalso.mock.calls.length;
    const r = await copias(['inventario']);
    expect(r.code, r.err.join('\n')).toBe(0);
    expect(r.err).toEqual([]);
    expect(r.out).toHaveLength(1);
    expect(r.out[0]).not.toContain('\n');
    // Ni Docker ni red.
    expect(usosDocker).toEqual([]);
    expect(fetchFalso.mock.calls.length).toBe(llamadas);

    const inv = JSON.parse(r.out[0]) as Json;
    expect(Object.keys(inv)).toEqual(['formato', 'producto', 'version', 'ajustes', 'proyectos']);
    expect(inv).toMatchObject({ formato: 1, producto: 'skyway', version: config.version });
    expect(inv.ajustes).toEqual({ serverIp: ANTERIOR, serverIpv6: '2001:db8::7', rootDomain: 'ejemplo.com', cloudflare: true });

    expect(inv.proyectos.map((p: Json) => p.id).sort()).toEqual([acme.id, vacio.id].sort());
    expect(inv.proyectos.find((p: Json) => p.id === vacio.id)).toEqual({
      id: vacio.id,
      nombre: 'Proyecto vacío',
      slug: 'vacio',
      cliente: null,
      servicios: [],
    });

    const proyecto = inv.proyectos.find((p: Json) => p.id === acme.id);
    expect(proyecto).toMatchObject({ nombre: 'Web de Acme', slug: 'web-acme', cliente: 'Acme' });
    expect(Object.keys(proyecto)).toEqual(['id', 'nombre', 'slug', 'cliente', 'servicios']);
    const servicio = (s: ServiceRow) => proyecto.servicios.find((x: Json) => x.id === s.id);
    expect(proyecto.servicios.map((s: Json) => s.id).sort()).toEqual([pg.id, cache.id, docs.id, web.id, worker.id, ficheros.id].sort());

    // Base con copia: las mismas órdenes que la copia de Skyway (`backups.ts`).
    expect(servicio(pg)).toEqual({
      id: pg.id,
      nombre: 'Base de datos',
      slug: 'db',
      tipo: 'database',
      plantilla: 'postgres',
      versionPlantilla: '16',
      detenido: false,
      contenedores: ['skyway-web-acme-db'],
      volumenes: ['skyway-web-acme-db-data'],
      volcado: {
        orden: 'pg_dump -U skyway -d skyway --no-owner --no-acl',
        restaurar: 'psql -U skyway -d skyway -q -v ON_ERROR_STOP=0',
        extension: 'sql.gz',
      },
      despliegue: null,
      imagen: null,
    });
    expect(servicio(docs)).toMatchObject({
      plantilla: 'mongo',
      volumenes: ['skyway-web-acme-docs-data'],
      volcado: { orden: expect.stringMatching(/^mongodump /), restaurar: expect.stringMatching(/^mongorestore /), extension: 'archive.gz' },
    });
    // Redis no tiene volcado: basta con su volumen.
    expect(servicio(cache)).toEqual({
      id: cache.id,
      nombre: 'Caché',
      slug: 'cache',
      tipo: 'database',
      plantilla: 'redis',
      versionPlantilla: '7',
      detenido: false,
      contenedores: ['skyway-web-acme-cache'],
      volumenes: ['skyway-web-acme-cache-data'],
      volcado: null,
      despliegue: null,
      imagen: null,
    });
    // Repositorio: réplicas, volumen persistente y el despliegue que corre.
    expect(servicio(web)).toEqual({
      id: web.id,
      nombre: 'Web',
      slug: 'web',
      tipo: 'git',
      plantilla: null,
      versionPlantilla: null,
      detenido: false,
      contenedores: ['skyway-web-acme-web', 'skyway-web-acme-web-r2'],
      volumenes: ['skyway-web-acme-web-data'],
      volcado: null,
      despliegue: { id: desplegado, imagen: 'skyway/web-acme-web:bbbb2222', commit: 'b'.repeat(40) },
      imagen: null,
    });
    expect(servicio(worker)).toMatchObject({ contenedores: ['skyway-web-acme-worker'], volumenes: [], despliegue: null, imagen: null });
    // Imagen: la configurada, detenido adrede, con sus réplicas y volúmenes.
    expect(servicio(ficheros)).toEqual({
      id: ficheros.id,
      nombre: 'Ficheros',
      slug: 'ficheros',
      tipo: 'image',
      plantilla: null,
      versionPlantilla: null,
      detenido: true,
      contenedores: ['skyway-web-acme-ficheros', 'skyway-web-acme-ficheros-r2', 'skyway-web-acme-ficheros-r3'],
      volumenes: ['skyway-web-acme-ficheros-html', 'skyway-web-acme-ficheros-conf'],
      volcado: null,
      despliegue: null,
      imagen: 'nginx:1.27',
    });
  });

  it('no lleva ningún secreto: ni variables, ni tokens, ni la configuración de los servicios', async () => {
    const r = await copias(['inventario']);
    expect(r.code).toBe(0);
    for (const secreto of SECRETOS) expect(r.out[0], secreto).not.toContain(secreto);
    for (const nombre of ['POSTGRES_PASSWORD', 'API_KEY', 'NPM_TOKEN', 'webhookSecret', 'buildArgs', 'repoUrl']) {
      expect(r.out[0], nombre).not.toContain(nombre);
    }
  });

  it('sin token de Cloudflare lo indica en los ajustes', async () => {
    setSetting(CLOUDFLARE_SETTING.token, null);
    setSetting('serverIpv6', null);
    const r = await copias(['inventario']);
    expect(JSON.parse(r.out[0]).ajustes).toEqual({ serverIp: ANTERIOR, serverIpv6: null, rootDomain: 'ejemplo.com', cloudflare: false });
  });
});

// ======================= repuntar =======================

describe('repuntar: la IP del servidor anterior pasa a la nueva', () => {
  let ej: CfZonaFalsa;
  let otra: CfZonaFalsa;
  let raiz: CfRegistroFalso;
  let www: CfRegistroFalso;
  let mail: CfRegistroFalso;
  /** Estado de los registros antes de cada prueba. */
  let previos: CfRegistroFalso[];
  const aplicar = ['repuntar', '--ip-anterior', ANTERIOR, '--ip-nueva', NUEVA, '--aplicar', 'si'];
  const simular = ['repuntar', '--ip-anterior', ANTERIOR, '--ip-nueva', NUEVA];

  beforeEach(() => {
    reiniciarCloudflare();
    rechazados.clear();
    sinPermisoDns.clear();
    ej = zona('ejemplo.com');
    otra = zona('otra.net');
    const ajena = zona('ajena.org'); // existe en Cloudflare, pero el token no la ve
    cf.tokens.set(TOKEN_CF, { kind: 'user', accountId: 'cuenta1', zoneIds: [ej.id, otra.id], status: 'active' });
    raiz = registro(ej, { type: 'A', name: 'ejemplo.com', content: ANTERIOR, proxied: true, comment: 'Web principal' });
    www = registro(ej, { type: 'A', name: 'www.ejemplo.com', content: ANTERIOR, comment: 'Skyway' });
    registro(ej, { type: 'A', name: 'api.ejemplo.com', content: '192.0.2.50', proxied: true });
    // Empieza igual que la IP anterior, pero no es la misma.
    registro(ej, { type: 'A', name: 'parecida.ejemplo.com', content: `${ANTERIOR}0` });
    registro(ej, { type: 'AAAA', name: 'ejemplo.com', content: '2001:db8::7' });
    registro(ej, { type: 'TXT', name: 'ejemplo.com', content: `v=spf1 ip4:${ANTERIOR} -all` });
    registro(ej, { type: 'CNAME', name: 'blog.ejemplo.com', content: 'ejemplo.com' });
    mail = registro(otra, { type: 'A', name: 'mail.otra.net', content: ANTERIOR, comment: 'Mailway' });
    mail.ttl = 300;
    const fuera = registro(ajena, { type: 'A', name: 'ajena.org', content: ANTERIOR });
    previos = cf.records.map((r) => ({ ...r }));

    setSetting('serverIp', ANTERIOR);
    setSetting(CLOUDFLARE_SETTING.token, TOKEN_CF);
    // Registros que creó el DNS automático de Skyway (Ajustes → Cloudflare).
    upsertCloudflareDnsRecord({ domain: 'www.ejemplo.com', zone_id: ej.id, zone_name: 'ejemplo.com', record_id: www.id, content: ANTERIOR, project_id: null });
    upsertCloudflareDnsRecord({ domain: 'ajena.org', zone_id: ajena.id, zone_name: 'ajena.org', record_id: fuera.id, content: ANTERIOR, project_id: null });
  });

  /** Cada registro está como antes, salvo los indicados, que solo cambian de destino. */
  function soloCambiaElDestinoDe(...cambiados: CfRegistroFalso[]): void {
    const ids = new Set(cambiados.map((r) => r.id));
    expect(cf.records).toHaveLength(previos.length);
    for (const previo of previos) {
      const ahora = cf.records.find((r) => r.id === previo.id);
      expect(ahora, previo.name).toEqual(ids.has(previo.id) ? { ...previo, content: NUEVA } : previo);
    }
  }

  it('sin --aplicar si solo simula: lista los registros A con la IP anterior y no cambia nada', async () => {
    const auditoria = idsAuditoria();
    const r = await copias(simular);
    expect(r.code, r.err.join('\n')).toBe(0);
    expect(r.err).toEqual([]);
    expect(r.out).toHaveLength(1);
    expect(JSON.parse(r.out[0])).toEqual({
      ok: true,
      aplicado: false,
      serverIp: { antes: ANTERIOR, despues: NUEVA, cambia: true },
      cloudflare: {
        configurado: true,
        error: null,
        registros: [
          { zona: 'ejemplo.com', nombre: 'ejemplo.com', proxied: true, estado: 'pendiente' },
          { zona: 'ejemplo.com', nombre: 'www.ejemplo.com', proxied: false, estado: 'pendiente' },
          { zona: 'otra.net', nombre: 'mail.otra.net', proxied: false, estado: 'pendiente' },
        ],
      },
    });
    expect(getSetting('serverIp')).toBe(ANTERIOR);
    expect(escrituras()).toEqual([]);
    soloCambiaElDestinoDe();
    expect(getCloudflareDnsRecord('www.ejemplo.com')?.content).toBe(ANTERIOR);
    expect(auditoriaNueva(auditoria)).toEqual([]);
  });

  it('con --aplicar si cambia la IP de Ajustes y solo el destino de esos registros, y lo audita', async () => {
    const auditoria = idsAuditoria();
    const r = await copias(aplicar);
    expect(r.code, r.err.join('\n')).toBe(0);
    expect(r.err).toEqual([]);
    expect(JSON.parse(r.out[0])).toEqual({
      ok: true,
      aplicado: true,
      serverIp: { antes: ANTERIOR, despues: NUEVA, cambia: true },
      cloudflare: {
        configurado: true,
        error: null,
        registros: [
          { zona: 'ejemplo.com', nombre: 'ejemplo.com', proxied: true, estado: 'cambiado' },
          { zona: 'ejemplo.com', nombre: 'www.ejemplo.com', proxied: false, estado: 'cambiado' },
          { zona: 'otra.net', nombre: 'mail.otra.net', proxied: false, estado: 'cambiado' },
        ],
      },
    });
    expect(getSetting('serverIp')).toBe(NUEVA);

    // Un PATCH por registro con solo el destino: el proxy, el TTL y el comentario se conservan.
    expect(escrituras().map((c) => [c.method, c.path, c.body])).toEqual([
      ['PATCH', `/zones/${ej.id}/dns_records/${raiz.id}`, { content: NUEVA }],
      ['PATCH', `/zones/${ej.id}/dns_records/${www.id}`, { content: NUEVA }],
      ['PATCH', `/zones/${otra.id}/dns_records/${mail.id}`, { content: NUEVA }],
    ]);
    expect(escrituras().every((c) => c.auth === `Bearer ${TOKEN_CF}`)).toBe(true);
    // Los demás (otra IP, una que solo empieza igual, AAAA, TXT, CNAME y la zona que el token no ve), intactos.
    soloCambiaElDestinoDe(raiz, www, mail);

    // El registro que creó Skyway sigue siendo suyo (la limpieza de Ajustes → Cloudflare lo reconoce).
    expect(getCloudflareDnsRecord('www.ejemplo.com')?.content).toBe(NUEVA);
    expect(getCloudflareDnsRecord('ajena.org')?.content).toBe(ANTERIOR);

    const nuevas = auditoriaNueva(auditoria);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ actor: 'sistema', target_type: 'system', target_id: 'server_ip', ip: null });
    expect(nuevas[0].detail).toBe(
      `${ANTERIOR} → ${NUEVA} · IP del servidor de Ajustes cambiada · 3 registro(s) A cambiado(s) en Cloudflare, desde la terminal del servidor`,
    );
    expect(JSON.stringify([r.out, r.err, nuevas])).not.toContain(TOKEN_CF);

    // Repetirlo no cambia nada más ni deja otra entrada de auditoría.
    cf.calls = [];
    const otraVez = await copias(aplicar);
    expect(otraVez.code).toBe(0);
    expect(otraVez.err).toEqual([]);
    expect(JSON.parse(otraVez.out[0])).toEqual({
      ok: true,
      aplicado: true,
      serverIp: { antes: NUEVA, despues: NUEVA, cambia: false },
      cloudflare: { configurado: true, error: null, registros: [] },
    });
    expect(escrituras()).toEqual([]);
    expect(auditoriaNueva(auditoria)).toHaveLength(1);
  });

  it('una IP de Ajustes distinta de la anterior se mantiene, con un aviso; vacía, no se toca', async () => {
    setSetting('serverIp', '192.0.2.99');
    let r = await copias(aplicar);
    expect(r.code, r.err.join('\n')).toBe(0);
    expect(r.err).toEqual(['Aviso: La IP del servidor de Ajustes (192.0.2.99) no es la anterior: se mantiene.']);
    let res = JSON.parse(r.out[0]) as Json;
    expect(res.serverIp).toEqual({ antes: '192.0.2.99', despues: '192.0.2.99', cambia: false });
    expect(getSetting('serverIp')).toBe('192.0.2.99');
    // Cloudflare se cambia igualmente.
    expect(res.cloudflare.registros.map((x: Json) => x.estado)).toEqual(['cambiado', 'cambiado', 'cambiado']);

    // Sin IP en Ajustes se detecta sola: en el servidor nuevo ya saldrá la nueva.
    setSetting('serverIp', null);
    r = await copias(simular);
    expect(r.code).toBe(0);
    expect(r.err).toEqual([]);
    res = JSON.parse(r.out[0]) as Json;
    expect(res.serverIp).toEqual({ antes: null, despues: null, cambia: false });
    expect(getSetting('serverIp')).toBeNull();
  });

  it('sin token de Cloudflare cambia la IP de Ajustes y avisa de que el DNS se cambia en su proveedor', async () => {
    setSetting(CLOUDFLARE_SETTING.token, null);
    const auditoria = idsAuditoria();
    const r = await copias(aplicar);
    expect(r.code, r.err.join('\n')).toBe(0);
    expect(JSON.parse(r.out[0])).toEqual({
      ok: true,
      aplicado: true,
      serverIp: { antes: ANTERIOR, despues: NUEVA, cambia: true },
      cloudflare: { configurado: false, error: null, registros: [] },
    });
    expect(r.err).toEqual([
      'Aviso: No hay ningún token de Cloudflare configurado (Ajustes → Cloudflare): los registros DNS que apuntan a la IP anterior se cambian en su proveedor.',
    ]);
    expect(getSetting('serverIp')).toBe(NUEVA);
    expect(cf.calls).toEqual([]);
    soloCambiaElDestinoDe();
    const nuevas = auditoriaNueva(auditoria);
    expect(nuevas.map((a) => a.detail)).toEqual([`${ANTERIOR} → ${NUEVA} · IP del servidor de Ajustes cambiada, desde la terminal del servidor`]);
  });

  it('un registro que Cloudflare rechaza: los demás se cambian, código 1 y el motivo en stderr', async () => {
    rechazados.add(www.id);
    const auditoria = idsAuditoria();
    const r = await copias(aplicar);
    expect(r.code).toBe(1);
    const res = JSON.parse(r.out[0]) as Json;
    expect(res.ok).toBe(false);
    expect(res.cloudflare.error).toBeNull();
    expect(res.cloudflare.registros).toEqual([
      { zona: 'ejemplo.com', nombre: 'ejemplo.com', proxied: true, estado: 'cambiado' },
      {
        zona: 'ejemplo.com',
        nombre: 'www.ejemplo.com',
        proxied: false,
        estado: 'error',
        error: 'Cloudflare ha rechazado el registro DNS (DNS Validation Error).',
      },
      { zona: 'otra.net', nombre: 'mail.otra.net', proxied: false, estado: 'cambiado' },
    ]);
    expect(r.err).toEqual([
      'Cloudflare: No se ha podido cambiar el registro A de www.ejemplo.com (zona ejemplo.com): Cloudflare ha rechazado el registro DNS (DNS Validation Error).',
    ]);
    soloCambiaElDestinoDe(raiz, mail);
    // El que no ha cambiado sigue anotado con la IP anterior.
    expect(getCloudflareDnsRecord('www.ejemplo.com')?.content).toBe(ANTERIOR);
    expect(auditoriaNueva(auditoria).map((a) => a.detail)).toEqual([
      `${ANTERIOR} → ${NUEVA} · IP del servidor de Ajustes cambiada · 2 registro(s) A cambiado(s) en Cloudflare, 1 con error, desde la terminal del servidor`,
    ]);

    // Al repetirlo, solo queda el que faltaba.
    rechazados.clear();
    const otraVez = await copias(aplicar);
    expect(otraVez.code).toBe(0);
    expect(JSON.parse(otraVez.out[0]).cloudflare.registros).toEqual([
      { zona: 'ejemplo.com', nombre: 'www.ejemplo.com', proxied: false, estado: 'cambiado' },
    ]);
    soloCambiaElDestinoDe(raiz, www, mail);
  });

  it('una zona cuyos registros no se pueden leer no impide cambiar las demás, y se indica', async () => {
    sinPermisoDns.add(otra.id);
    const r = await copias(aplicar);
    expect(r.code).toBe(1);
    const res = JSON.parse(r.out[0]) as Json;
    expect(res.ok).toBe(false);
    expect(res.cloudflare.error).toMatch(
      /^No se han podido leer los registros de la zona otra\.net: El token de Cloudflare es válido, pero no tiene permiso sobre esta zona\./,
    );
    expect(res.cloudflare.registros.map((x: Json) => [x.nombre, x.estado])).toEqual([
      ['ejemplo.com', 'cambiado'],
      ['www.ejemplo.com', 'cambiado'],
    ]);
    expect(r.err).toEqual([`Cloudflare: ${res.cloudflare.error}`]);
    soloCambiaElDestinoDe(raiz, www);
  });

  it('con el token revocado no cambia nada en Cloudflare y lo explica', async () => {
    cf.tokens.delete(TOKEN_CF);
    const r = await copias(simular);
    expect(r.code).toBe(1);
    const res = JSON.parse(r.out[0]) as Json;
    expect(res).toEqual({
      ok: false,
      aplicado: false,
      serverIp: { antes: ANTERIOR, despues: NUEVA, cambia: true },
      cloudflare: {
        configurado: true,
        error: expect.stringMatching(/^No se han podido consultar las zonas: El token de Cloudflare no es válido\./),
        registros: [],
      },
    });
    expect(r.err).toEqual([`Cloudflare: ${res.cloudflare.error}`]);
    expect(escrituras()).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(TOKEN_CF);
  });

  it('valida los argumentos antes de tocar nada', async () => {
    const auditoria = idsAuditoria();
    const casos: [string[], RegExp][] = [
      [[], /^Uso:/],
      [['restaurar'], /^Uso:/],
      [['inventario', '--json', 'si'], /Opción desconocida: --json/],
      [['inventario', 'todo'], /Argumento no reconocido/],
      [['repuntar'], /Indica la IP anterior del servidor con --ip-anterior\./],
      [['repuntar', '--ip-anterior', ANTERIOR], /Indica la IP nueva del servidor con --ip-nueva\./],
      [['repuntar', '--ip-anterior', '198.51.100', '--ip-nueva', NUEVA], /--ip-anterior no es una dirección IPv4 válida/],
      [['repuntar', '--ip-anterior', '198.51.100.07', '--ip-nueva', NUEVA], /--ip-anterior no es una dirección IPv4 válida/],
      [['repuntar', '--ip-anterior', ANTERIOR, '--ip-nueva', '256.0.113.20'], /--ip-nueva no es una dirección IPv4 válida/],
      [['repuntar', '--ip-anterior', ANTERIOR, '--ip-nueva', '2001:db8::20'], /--ip-nueva no es una dirección IPv4 válida/],
      [['repuntar', '--ip-anterior', ANTERIOR, '--ip-nueva', '0.0.0.0'], /--ip-nueva no es la de un servidor/],
      [['repuntar', '--ip-anterior', ANTERIOR, '--ip-nueva', '127.0.0.1'], /--ip-nueva no es la de un servidor/],
      [['repuntar', '--ip-anterior', ANTERIOR, '--ip-nueva', '255.255.255.255'], /--ip-nueva no es la de un servidor/],
      [['repuntar', '--ip-anterior', ANTERIOR, '--ip-nueva', ANTERIOR], /La IP nueva es la misma que la anterior/],
      [['repuntar', '--ip-anterior', ANTERIOR, '--ip-nueva', NUEVA, '--aplicar', 'no'], /--aplicar solo admite «si»/],
      [['repuntar', '--ip-anterior', ANTERIOR, '--ip-nueva', NUEVA, '--aplicar'], /Falta el valor de --aplicar/],
      [['repuntar', '--ip-anterior', ANTERIOR, '--ip-nueva', NUEVA, '--zona', 'ejemplo.com'], /Opción desconocida: --zona/],
      [['repuntar', '--ip-anterior', ANTERIOR, '--ip-anterior', ANTERIOR, '--ip-nueva', NUEVA], /--ip-anterior está repetida/],
      [['repuntar', ANTERIOR, NUEVA], /Argumento no reconocido/],
    ];
    for (const [argv, motivo] of casos) {
      const r = await copias(argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.out, argv.join(' ')).toEqual([]);
      expect(r.err.join('\n'), argv.join(' ')).toMatch(motivo);
    }
    expect(getSetting('serverIp')).toBe(ANTERIOR);
    expect(cf.calls).toEqual([]);
    expect(auditoriaNueva(auditoria)).toEqual([]);
  });
});
