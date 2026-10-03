/**
 * Borrar un proyecto o un servicio borra SIEMPRE sus datos, con confirmación
 * escribiendo su nombre, y los datos que dejaron los borrados anteriores se
 * pueden listar y eliminar desde Ajustes («Datos sin proyecto»).
 *
 * Sin Docker: se sustituye la capa de Docker por un doble en memoria
 * (volúmenes con sus etiquetas, qué contenedor monta cada uno, contenedores
 * de cada servicio) que anota cada borrado. Lo esencial que se comprueba es
 * lo que NO se toca: volúmenes de Compose (Skyway, Traefik, Mailway), los que
 * usa un contenedor, los que declara un servicio vivo y los de otros programas.
 */
import fs from 'fs';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { API_TOKEN_PREFIX, hashApiToken } from '../src/auth';
import { config } from '../src/config';
import {
  closeDb,
  createDeployment,
  getDeployment,
  createProject,
  createService,
  getCloudflareDnsRecord,
  getMailwayDnsReserva,
  getProject,
  getService,
  getSetting,
  getUserByEmail,
  initDb,
  insertAlert,
  insertApiToken,
  listAlerts,
  listAudit,
  reservarNombresMailway,
  setSetting,
  updateDeployment,
  upsertCloudflareDnsRecord,
} from '../src/db';
import { triggerDeploy } from '../src/deploy/deployer';
import type { DockerVolumeInfo } from '../src/docker/resources';
import { domainClaimError } from '../src/domainguard';
import { classifyOrphanVolumes, confirmsDeletion, isSkywayVolumeName } from '../src/purge';
import type { DatabaseConfig, GitConfig, ImageConfig, ProjectRow, ServiceRow } from '../src/types';
import { randomToken } from '../src/util';

// ---------- doble de Docker ----------

const docker = vi.hoisted(() => ({
  available: true,
  volumes: [] as { name: string; driver: string; labels: Record<string, string>; createdAt: string | null }[],
  /** volumen → contenedores que lo montan */
  inUse: new Map<string, string[]>(),
  /** servicio → sus contenedores */
  containers: new Map<string, { id: string; name: string }[]>(),
  /** Volúmenes que Docker se niega a borrar (como un 409). */
  failVolumes: new Set<string>(),
  /** Contenedores que Docker no deja retirar ni parar. */
  failContainers: new Set<string>(),
  /** Contenedores cuya parada falla (la retirada forzada sí funciona). */
  failStops: new Set<string>(),
  /** Si existe, el listado de contenedores espera a que se resuelva (para pruebas de concurrencia). */
  listGate: null as Promise<void> | null,
  deletedVolumes: [] as string[],
  removedContainers: [] as { name: string; opts: unknown }[],
  deletedNetworks: [] as string[],
  deletedImages: [] as string[],
}));

vi.mock('../src/docker/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/docker/client')>();
  return { ...mod, dockerAvailable: vi.fn(async () => docker.available) };
});
vi.mock('../src/docker/containers', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/docker/containers')>();
  return {
    ...mod,
    listServiceContainers: vi.fn(async (serviceId: string) => {
      if (docker.listGate) await docker.listGate;
      return docker.containers.get(serviceId) ?? [];
    }),
    stopContainer: vi.fn(async (name: string) => {
      if (docker.failStops.has(name) || docker.failContainers.has(name)) throw new Error('(HTTP code 500) no se puede parar');
    }),
    removeContainer: vi.fn(async (name: string, opts?: unknown) => {
      if (docker.failContainers.has(name)) {
        throw Object.assign(new Error('(HTTP code 500) device or resource busy'), { statusCode: 500, json: { message: 'device or resource busy' } });
      }
      docker.removedContainers.push({ name, opts });
      // Sin el contenedor, sus volúmenes dejan de estar en uso.
      for (const [vol, users] of docker.inUse) {
        const rest = users.filter((u) => u !== name);
        if (rest.length) docker.inUse.set(vol, rest);
        else docker.inUse.delete(vol);
      }
    }),
  };
});
vi.mock('../src/docker/resources', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/docker/resources')>();
  return {
    ...mod,
    listVolumes: vi.fn(async () => docker.volumes.map((v) => ({ ...v, labels: { ...v.labels } }))),
    volumesInUse: vi.fn(async () => new Map([...docker.inUse].map(([k, v]) => [k, [...v]]))),
    deleteVolume: vi.fn(async (name: string) => {
      if (docker.failVolumes.has(name)) {
        throw Object.assign(new Error('(HTTP code 409) volume is in use'), { statusCode: 409, json: { message: 'volume is in use' } });
      }
      const i = docker.volumes.findIndex((v) => v.name === name);
      if (i < 0) return 'missing';
      docker.volumes.splice(i, 1);
      docker.deletedVolumes.push(name);
      return 'removed';
    }),
    deleteNetwork: vi.fn(async (name: string) => {
      docker.deletedNetworks.push(name);
      return 'removed';
    }),
    deleteImage: vi.fn(async (tag: string) => {
      docker.deletedImages.push(tag);
      return 'removed';
    }),
  };
});
// Sin `docker system df`: los tamaños los da la prueba.
vi.mock('../src/disk', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/disk')>();
  return { ...mod, dockerVolumeSizes: vi.fn(async () => new Map(docker.volumes.map((v) => [v.name, 1024]))) };
});

function vol(name: string, labels: Record<string, string> = {}, driver = 'local') {
  return { name, driver, labels, createdAt: '2026-09-01T10:00:00Z' };
}

const COMPOSE = (project: string) => ({ 'com.docker.compose.project': project, 'com.docker.compose.volume': 'x' });

/** Volúmenes que nunca se pueden tocar, presentes en todas las pruebas. */
function ajenos() {
  return [
    vol('skyway_skyway-data', COMPOSE('skyway')),
    vol('skyway_traefik-letsencrypt', COMPOSE('skyway')),
    vol('mailway-mail-data', COMPOSE('mailway')),
    vol('mailway-webmail-db', COMPOSE('mailway')),
    vol('deploy_mailway-panel', COMPOSE('deploy')),
    vol('a'.repeat(64), { 'com.docker.volume.anonymous': '' }),
    vol('skyway-data'),
    vol('otra-app-data'),
  ];
}
const AJENOS = ajenos().map((v) => v.name);

function resetDocker() {
  docker.available = true;
  docker.volumes = ajenos();
  docker.inUse = new Map([
    ['skyway_skyway-data', ['skyway']],
    ['skyway_traefik-letsencrypt', ['skyway-traefik']],
  ]);
  docker.containers = new Map();
  docker.failVolumes = new Set();
  docker.failContainers = new Set();
  docker.failStops = new Set();
  docker.listGate = null;
  docker.deletedVolumes = [];
  docker.removedContainers = [];
  docker.deletedNetworks = [];
  docker.deletedImages = [];
}

// ---------- aplicación ----------

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
let app: FastifyInstance;
let adminCookie = '';
let adminToken = '';
const admin = () => ({ cookie: adminCookie, ...SAME_ORIGIN });

async function call(method: 'GET' | 'POST' | 'DELETE', url: string, headers: Record<string, string>, body?: unknown) {
  const r = await app.inject({
    method,
    url,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = r.json();
  } catch {
    /* sin JSON */
  }
  return { status: r.statusCode, json, raw: r.body };
}

const dbCfg = (): DatabaseConfig => ({ template: 'postgres', version: '16' }) as DatabaseConfig;
const gitCfg = (volumes?: { name: string; containerPath: string }[]): GitConfig =>
  ({ repoUrl: 'https://github.com/x/y', branch: 'main', port: 3000, domains: [], webhookSecret: 'w', volumes }) as GitConfig;
const imageCfg = (volumes?: { name: string; containerPath: string }[]): ImageConfig =>
  ({ image: 'nginx', port: 80, domains: [], volumes }) as ImageConfig;

function backupDir(serviceId: string) {
  return path.join(config.dataDir, 'backups', serviceId);
}
function crearCopia(serviceId: string) {
  fs.mkdirSync(backupDir(serviceId), { recursive: true });
  fs.writeFileSync(path.join(backupDir(serviceId), 'postgres-x-2026-09-01.sql.gz'), 'datos');
}

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
  const secret = `${API_TOKEN_PREFIX}${randomToken(24)}`;
  insertApiToken({
    user_id: getUserByEmail('admin@example.com')!.id,
    name: 'automatización',
    token_hash: hashApiToken(secret),
    prefix: secret.slice(0, 12),
    expires_at: null,
  });
  adminToken = `Bearer ${secret}`;
});

afterAll(async () => {
  await app.close();
  closeDb();
});

beforeEach(() => {
  resetDocker();
});

// ======================= borrado de proyectos =======================

describe('borrar un proyecto', () => {
  /** Proyecto con una base de datos, una web con volumen y dos servicios de pila que comparten uno. */
  function proyectoCompleto(nombre: string, slug: string) {
    const project = createProject(nombre, slug);
    const db = createService(project.id, 'Postgres', 'postgres', 'database', dbCfg());
    const web = createService(project.id, 'Web', 'web', 'git', gitCfg([{ name: `skyway-${slug}-web-data`, containerPath: '/data' }]));
    const compartido = `skyway-${slug}__supa__storage`;
    const storage = createService(project.id, 'supa-storage', 'supa-storage', 'image', imageCfg([{ name: compartido, containerPath: '/s' }]));
    const imgproxy = createService(project.id, 'supa-imgproxy', 'supa-imgproxy', 'image', imageCfg([{ name: compartido, containerPath: '/s' }]));
    docker.volumes.push(vol(`skyway-${slug}-postgres-data`), vol(`skyway-${slug}-web-data`), vol(compartido));
    docker.containers.set(db.id, [{ id: 'c1', name: `skyway-${slug}-postgres` }]);
    docker.containers.set(web.id, [
      { id: 'c2', name: `skyway-${slug}-web` },
      { id: 'c3', name: `skyway-${slug}-web-r2` },
    ]);
    docker.inUse.set(`skyway-${slug}-postgres-data`, [`skyway-${slug}-postgres`]);
    docker.inUse.set(`skyway-${slug}-web-data`, [`skyway-${slug}-web`, `skyway-${slug}-web-r2`]);
    return { project, db, web, storage, imgproxy, compartido };
  }

  it('sin confirmación: 400 y no se borra nada', async () => {
    const { project, db } = proyectoCompleto('Sin Confirmar', 'sin-confirmar');
    const r = await call('DELETE', `/api/projects/${project.id}`, admin());
    expect(r.status, r.raw).toBe(400);
    expect(r.json.error).toMatch(/confirma con su nombre/);
    expect(getProject(project.id)).toBeTruthy();
    expect(getService(db.id)).toBeTruthy();
    expect(docker.deletedVolumes).toEqual([]);
    expect(docker.removedContainers).toEqual([]);
    expect(docker.deletedNetworks).toEqual([]);
  });

  it('el antiguo ?volumes=true sin confirmación tampoco borra nada', async () => {
    const { project } = proyectoCompleto('Cliente Viejo', 'cliente-viejo');
    const r = await call('DELETE', `/api/projects/${project.id}?volumes=true`, admin());
    expect(r.status).toBe(400);
    expect(getProject(project.id)).toBeTruthy();
    expect(docker.deletedVolumes).toEqual([]);
  });

  it('con una confirmación que no coincide: 400 y no se borra nada', async () => {
    const { project } = proyectoCompleto('Tienda', 'tienda');
    for (const intento of ['tienda online', 'TIENDA', 'Tiend', 'otro']) {
      const r = await call('DELETE', `/api/projects/${project.id}?confirm=${encodeURIComponent(intento)}`, admin());
      expect(r.status, intento).toBe(400);
      expect(r.json.error).toMatch(/no coincide/);
    }
    expect(getProject(project.id)).toBeTruthy();
    expect(docker.deletedVolumes).toEqual([]);
    expect(docker.removedContainers).toEqual([]);
  });

  it('sin Docker: 503 y no se borra nada (ni las filas)', async () => {
    const { project } = proyectoCompleto('Sin Docker', 'sin-docker');
    docker.available = false;
    const r = await call('DELETE', `/api/projects/${project.id}?confirm=${encodeURIComponent('Sin Docker')}`, admin());
    expect(r.status).toBe(503);
    expect(getProject(project.id)).toBeTruthy();
    expect(docker.deletedVolumes).toEqual([]);
  });

  it('con el nombre: borra contenedores, volúmenes de todos los servicios, imágenes, copias, red y referencias', async () => {
    const { project, db, web, storage, imgproxy, compartido } = proyectoCompleto('Tienda Online', 'tienda-online');
    // Otro proyecto vivo cuyo slug empieza igual: lo suyo no se toca.
    const vecino = createProject('Tienda Online 2', 'tienda-online-2');
    createService(vecino.id, 'API', 'api', 'database', dbCfg());
    docker.volumes.push(vol('skyway-tienda-online-2-api-data'));
    // Restos de antes: una ruta quitada en Ajustes y un volumen de pila de un
    // proyecto anterior con el mismo nombre, borrado sin sus datos.
    docker.volumes.push(vol('skyway-tienda-online-web-data2'), vol('skyway-tienda-online__viejo__db'));
    // Imágenes: una construida para la web y una de un servicio de imagen (compartida).
    const dep = createDeployment(web.id, 'manual', 'skyway/tienda-online-web:abcd1234');
    updateDeployment(dep.id, { status: 'success' });
    const depImg = createDeployment(storage.id, 'manual', 'nginx');
    updateDeployment(depImg.id, { status: 'success' });
    // Un despliegue en cola: se cancela antes de retirar nada (la prueba de
    // «no se puede retirar un contenedor» comprueba su estado, que aquí se
    // borra en cascada con el servicio).
    createDeployment(web.id, 'manual');
    crearCopia(db.id);
    insertAlert({ severity: 'critical', type: 'down', project_id: project.id, service_id: db.id, title: 'Caído', message: 'x' });
    setSetting(`importReport:${project.id}`, JSON.stringify({ comandos: ['PGPASSWORD=secreto psql …'] }));
    setSetting('mailway.serviceId', web.id);
    upsertCloudflareDnsRecord({
      domain: 'tienda.operador.example',
      zone_id: 'z1',
      zone_name: 'operador.example',
      record_id: 'r1',
      content: '203.0.113.10',
      project_id: project.id,
    });
    reservarNombresMailway(['autoconfig.tienda.example'], project.id);

    const r = await call('DELETE', `/api/projects/${project.id}?confirm=${encodeURIComponent('Tienda Online')}`, admin());
    expect(r.status, r.raw).toBe(200);
    expect(r.json.warnings).toEqual([]);

    // Filas fuera.
    expect(getProject(project.id)).toBeUndefined();
    for (const s of [db, web, storage, imgproxy]) expect(getService(s.id)).toBeUndefined();

    // Contenedores retirados con sus volúmenes anónimos.
    expect(docker.removedContainers.map((c) => c.name).sort()).toEqual(
      ['skyway-tienda-online-postgres', 'skyway-tienda-online-web', 'skyway-tienda-online-web-r2'].sort(),
    );
    for (const c of docker.removedContainers) expect(c.opts).toEqual({ anonymousVolumes: true });

    // Volúmenes de todos los servicios (el compartido, una sola vez) y los restos.
    expect([...docker.deletedVolumes].sort()).toEqual(
      [
        'skyway-tienda-online-postgres-data',
        'skyway-tienda-online-web-data',
        compartido,
        'skyway-tienda-online-web-data2',
        'skyway-tienda-online__viejo__db',
      ].sort(),
    );
    expect(r.json.removed.volumes).toHaveLength(5);
    // Lo del vecino y lo ajeno, intacto.
    const quedan = docker.volumes.map((v) => v.name);
    expect(quedan).toContain('skyway-tienda-online-2-api-data');
    for (const n of AJENOS) expect(quedan).toContain(n);

    // Imágenes: solo la construida por Skyway.
    expect(docker.deletedImages).toEqual(['skyway/tienda-online-web:abcd1234']);
    expect(r.json.removed.images).toBe(1);
    // Red del proyecto.
    expect(docker.deletedNetworks).toEqual(['skyway-tienda-online']);
    // Copias de seguridad en disco.
    expect(fs.existsSync(backupDir(db.id))).toBe(false);
    expect(r.json.removed.backups).toBe(1);

    // Referencias que quedaban sueltas.
    expect(listAlerts({ openOnly: true }).filter((a) => a.project_id === project.id)).toEqual([]);
    expect(getSetting(`importReport:${project.id}`)).toBeNull();
    expect(getSetting('mailway.serviceId')).toBeNull();

    // Reservas de dominio: siguen (el registro sigue en Cloudflare), sin proyecto.
    expect(getCloudflareDnsRecord('tienda.operador.example')?.project_id).toBeNull();
    expect(getMailwayDnsReserva('autoconfig.tienda.example')?.project_id).toBeNull();

    // Auditoría con el slug.
    const entrada = listAudit({ action: 'project_deleted' }).find((a) => a.target_id === project.id);
    expect(entrada?.detail).toBe('Tienda Online (tienda-online) · 4 servicios, 5 volúmenes, 1 imagen, 1 carpeta de copias');
  });

  it('las reservas liberadas siguen protegidas: un cliente no puede asignarse el nombre, el administrador sí', async () => {
    const project = createProject('Reservas', 'reservas');
    upsertCloudflareDnsRecord({
      domain: 'reservado.operador.example',
      zone_id: 'z1',
      zone_name: 'operador.example',
      record_id: 'r2',
      content: '203.0.113.10',
      project_id: project.id,
    });
    reservarNombresMailway(['webmail.reservado.example'], project.id);
    const r = await call('DELETE', `/api/projects/${project.id}?confirm=reservas`, admin());
    expect(r.status, r.raw).toBe(200);

    const otro = createProject('Cliente nuevo', 'cliente-nuevo');
    for (const nombre of ['reservado.operador.example', 'webmail.reservado.example']) {
      expect(domainClaimError([nombre], { projectId: otro.id, serviceId: null, isAdmin: false })).toMatch(/reservado por el administrador/);
      expect(domainClaimError([nombre], { projectId: otro.id, serviceId: null, isAdmin: true })).toBeNull();
    }
  });

  it('acepta el slug como confirmación (para scripts)', async () => {
    const { project } = proyectoCompleto('Ñandú Café', 'nandu-cafe');
    const r = await call('DELETE', `/api/projects/${project.id}?confirm=nandu-cafe`, admin());
    expect(r.status, r.raw).toBe(200);
    expect(getProject(project.id)).toBeUndefined();
  });

  it('lo que no se puede borrar vuelve como aviso, y el proyecto se borra igualmente', async () => {
    const { project } = proyectoCompleto('Con Aviso', 'con-aviso');
    docker.failVolumes.add('skyway-con-aviso-postgres-data');
    const r = await call('DELETE', `/api/projects/${project.id}?confirm=${encodeURIComponent('Con Aviso')}`, admin());
    expect(r.status, r.raw).toBe(200);
    expect(r.json.warnings).toHaveLength(1);
    expect(r.json.warnings[0]).toMatch(/Postgres: no se ha podido borrar el volumen skyway-con-aviso-postgres-data: volume is in use/);
    expect(getProject(project.id)).toBeUndefined();
    expect(docker.deletedVolumes).toContain('skyway-con-aviso-web-data');
    // El texto del aviso queda en la auditoría: el toast de la web se cierra.
    const entrada = listAudit({ action: 'project_deleted' }).find((a) => a.target_id === project.id);
    expect(entrada?.detail).toMatch(/avisos: Postgres: no se ha podido borrar el volumen skyway-con-aviso-postgres-data/);
  });

  it('un volumen que usa un contenedor ajeno no se intenta borrar: aviso', async () => {
    const { project } = proyectoCompleto('Montado', 'montado');
    docker.inUse.set('skyway-montado-web-data', ['contenedor-ajeno']);
    const r = await call('DELETE', `/api/projects/${project.id}?confirm=Montado`, admin());
    expect(r.status, r.raw).toBe(200);
    expect(r.json.warnings.join('\n')).toMatch(/skyway-montado-web-data lo utiliza el contenedor contenedor-ajeno/);
    expect(docker.deletedVolumes).not.toContain('skyway-montado-web-data');
  });

  it('un volumen cuyo nombre coincide con el de otro proyecto vivo se conserva', async () => {
    // «acme» + «prod-web» y «acme-prod» + «web» dan el mismo nombre.
    const acme = createProject('Acme', 'acme');
    createService(acme.id, 'prod-web', 'prod-web', 'database', dbCfg());
    const acmeProd = createProject('Acme Prod', 'acme-prod');
    createService(acmeProd.id, 'web', 'web', 'database', dbCfg());
    docker.volumes.push(vol('skyway-acme-prod-web-data'));
    const r = await call('DELETE', `/api/projects/${acme.id}?confirm=Acme`, admin());
    expect(r.status, r.raw).toBe(200);
    expect(docker.deletedVolumes).toEqual([]);
    expect(r.json.warnings.join('\n')).toMatch(/también lo declara el servicio «Acme Prod \/ web»: se conserva/);
  });

  it('si un contenedor no se puede retirar, no borra datos ni filas: 409 y se puede reintentar', async () => {
    const { project, db, web } = proyectoCompleto('Zombi', 'zombi');
    const enCola = createDeployment(web.id, 'manual');
    docker.failContainers.add('skyway-zombi-postgres');
    const r = await call('DELETE', `/api/projects/${project.id}?confirm=Zombi`, admin());
    expect(r.status, r.raw).toBe(409);
    expect(r.json.error).toMatch(/no se han eliminado los datos ni el proyecto/);
    expect(r.json.warnings.join('\n')).toMatch(/Postgres: no se ha podido retirar el contenedor skyway-zombi-postgres: device or resource busy/);
    expect(getProject(project.id)).toBeTruthy();
    expect(getService(db.id)).toBeTruthy();
    expect(docker.deletedVolumes).toEqual([]);
    expect(docker.deletedNetworks).toEqual([]);
    // El despliegue en cola se canceló antes de retirar nada.
    expect(getDeployment(enCola.id)?.status).toBe('canceled');
    // Ninguna entrada de auditoría de un borrado que no ha ocurrido.
    expect(listAudit({ action: 'project_deleted' }).some((a) => a.target_id === project.id)).toBe(false);

    // Docker vuelve a dejar retirarlo: el reintento lo completa.
    docker.failContainers.clear();
    const otra = await call('DELETE', `/api/projects/${project.id}?confirm=Zombi`, admin());
    expect(otra.status, otra.raw).toBe(200);
    expect(getProject(project.id)).toBeUndefined();
    expect(docker.deletedVolumes).toContain('skyway-zombi-postgres-data');
  });

  it('si falla la parada de un contenedor, lo retira igualmente a la fuerza', async () => {
    const { project } = proyectoCompleto('Terco', 'terco');
    docker.failStops.add('skyway-terco-postgres');
    const r = await call('DELETE', `/api/projects/${project.id}?confirm=Terco`, admin());
    expect(r.status, r.raw).toBe(200);
    expect(docker.removedContainers.map((c) => c.name)).toContain('skyway-terco-postgres');
    expect(docker.deletedVolumes).toContain('skyway-terco-postgres-data');
  });

  it('mientras se elimina: un segundo DELETE da 409 y un despliegue nuevo nace cancelado', async () => {
    const { project, web } = proyectoCompleto('Lento', 'lento');
    let abrir!: () => void;
    docker.listGate = new Promise<void>((resolve) => {
      abrir = resolve;
    });
    const primero = call('DELETE', `/api/projects/${project.id}?confirm=Lento`, admin());
    // Se deja avanzar al primero hasta que espera a Docker.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const segundo = await call('DELETE', `/api/projects/${project.id}?confirm=Lento`, admin());
    expect(segundo.status, segundo.raw).toBe(409);
    // Un push a GitHub en plena eliminación no vuelve a crear el contenedor.
    const colado = triggerDeploy(web.id, 'webhook');
    expect(colado.status).toBe('canceled');
    expect(colado.error).toMatch(/se está eliminando/);
    abrir();
    const r = await primero;
    expect(r.status, r.raw).toBe(200);
    expect(getProject(project.id)).toBeUndefined();
  });

  it('nunca borra un volumen que puede ser de un servicio de otro proyecto (a / b-c frente a a-b / c)', async () => {
    // «A B» + «c» tenía una ruta que quitó: `skyway-a-b-c-data2` se conserva.
    const ab = createProject('A B', 'a-b');
    const victima = createService(ab.id, 'c', 'c', 'git', gitCfg());
    docker.volumes.push(vol('skyway-a-b-c-data2'));
    // «A» + «b-c» declara esos mismos nombres (los que genera añadir dos rutas).
    const a = createProject('A', 'a');
    const atacante = createService(
      a.id,
      'b-c',
      'b-c',
      'git',
      gitCfg([
        { name: 'skyway-a-b-c-data', containerPath: '/x' },
        { name: 'skyway-a-b-c-data2', containerPath: '/y' },
      ]),
    );
    // Ni borrando el servicio…
    let r = await call('DELETE', `/api/services/${atacante.id}?confirm=b-c`, admin());
    expect(r.status, r.raw).toBe(200);
    expect(docker.deletedVolumes).toEqual([]);
    expect(r.json.warnings.join('\n')).toMatch(/skyway-a-b-c-data2 puede pertenecer al servicio «A B \/ c», de otro proyecto: se conserva/);
    // …ni el proyecto entero.
    const atacante2 = createService(a.id, 'b-c', 'b-c', 'git', gitCfg([{ name: 'skyway-a-b-c-data2', containerPath: '/y' }]));
    r = await call('DELETE', `/api/projects/${a.id}?confirm=A`, admin());
    expect(r.status, r.raw).toBe(200);
    expect(getService(atacante2.id)).toBeUndefined();
    expect(docker.deletedVolumes).toEqual([]);
    expect(docker.volumes.map((v) => v.name)).toContain('skyway-a-b-c-data2');
    expect(getService(victima.id)).toBeTruthy();
  });

  it('nunca borra la red compartida con Traefik (proyecto «edge»)', async () => {
    const edge = createProject('Edge', 'edge');
    const r = await call('DELETE', `/api/projects/${edge.id}?confirm=Edge`, admin());
    expect(r.status, r.raw).toBe(200);
    expect(docker.deletedNetworks).toEqual([]);
  });
});

// ======================= borrado de servicios =======================

describe('borrar un servicio', () => {
  it('exige confirmación con su nombre y borra siempre sus datos, salvo lo que comparte con un hermano', async () => {
    const project = createProject('Pila', 'pila');
    const compartido = 'skyway-pila__supa__storage';
    const storage = createService(project.id, 'supa-storage', 'supa-storage', 'image', imageCfg([{ name: compartido, containerPath: '/s' }]));
    const imgproxy = createService(project.id, 'supa-imgproxy', 'supa-imgproxy', 'image', imageCfg([{ name: compartido, containerPath: '/s' }]));
    const db = createService(project.id, 'Base', 'base', 'database', dbCfg());
    docker.volumes.push(vol(compartido), vol('skyway-pila-base-data'), vol('skyway-pila-base-data2'));
    crearCopia(db.id);

    let r = await call('DELETE', `/api/services/${db.id}`, admin());
    expect(r.status).toBe(400);
    r = await call('DELETE', `/api/services/${db.id}?confirm=Pila`, admin());
    expect(r.status).toBe(400);
    expect(getService(db.id)).toBeTruthy();
    expect(docker.deletedVolumes).toEqual([]);

    r = await call('DELETE', `/api/services/${db.id}?confirm=Base`, admin());
    expect(r.status, r.raw).toBe(200);
    expect(getService(db.id)).toBeUndefined();
    // El suyo y el resto que quedó fuera de su configuración.
    expect([...docker.deletedVolumes].sort()).toEqual(['skyway-pila-base-data', 'skyway-pila-base-data2']);
    expect(fs.existsSync(backupDir(db.id))).toBe(false);

    // El compartido se queda mientras viva el otro servicio, sin aviso.
    r = await call('DELETE', `/api/services/${storage.id}?confirm=supa-storage`, admin());
    expect(r.status, r.raw).toBe(200);
    expect(r.json.warnings).toEqual([]);
    expect(docker.deletedVolumes).not.toContain(compartido);
    // Con el último, se va.
    r = await call('DELETE', `/api/services/${imgproxy.id}?confirm=supa-imgproxy`, admin());
    expect(r.status, r.raw).toBe(200);
    expect(docker.deletedVolumes).toContain(compartido);
    expect(getProject(project.id)).toBeTruthy();
  });

  it('el barrido de restos no toca los volúmenes de un hermano cuyo slug empieza igual', async () => {
    const project = createProject('Hermanos', 'hermanos');
    const web = createService(project.id, 'web', 'web', 'git', gitCfg());
    createService(project.id, 'web-2', 'web-2', 'git', gitCfg([{ name: 'skyway-hermanos-web-2-data', containerPath: '/d' }]));
    // Una ruta que «web-2» quitó en Ajustes: sus datos se conservan mientras viva.
    docker.volumes.push(vol('skyway-hermanos-web-2-data'), vol('skyway-hermanos-web-2-data3'), vol('skyway-hermanos-web-data'));
    const r = await call('DELETE', `/api/services/${web.id}?confirm=web`, admin());
    expect(r.status, r.raw).toBe(200);
    expect(docker.deletedVolumes).toEqual(['skyway-hermanos-web-data']);
  });
});

// ======================= datos sin proyecto =======================

describe('datos sin proyecto', () => {
  let vivo: ProjectRow;
  let vivoApi: ServiceRow;

  beforeAll(() => {
    vivo = createProject('Vivo', 'vivo');
    vivoApi = createService(vivo.id, 'api', 'api', 'database', dbCfg());
    createService(vivo.id, 'web', 'web', 'git', gitCfg());
  });

  function escenario() {
    docker.volumes.push(
      vol('skyway-viejo-panel-data'), // proyecto borrado sin sus datos
      vol('skyway-viejo__supa__db'), // pila de un proyecto borrado
      vol('skyway-vivo-api-data'), // lo declara un servicio vivo
      vol('skyway-vivo-web-data3'), // ruta quitada de un servicio vivo
      vol('skyway-vivo__supa__storage'), // de una pila de un proyecto vivo
      vol('skyway-usado-x-data'), // lo monta un contenedor (parado)
      vol('skyway-compose-x-data', COMPOSE('otro')), // de Compose
      vol('skyway-nfs-x-data', {}, 'nfs'), // otro controlador
    );
    docker.inUse.set('skyway-usado-x-data', ['contenedor-parado']);
  }

  it('lista solo lo que es de Skyway, no lo declara nadie y no lo usa ningún contenedor', async () => {
    escenario();
    const huerfana = 'svc_0123456789abcdef';
    fs.mkdirSync(backupDir(huerfana), { recursive: true });
    fs.writeFileSync(path.join(backupDir(huerfana), 'mysql-x.sql.gz'), 'datos');
    crearCopia(vivoApi.id);
    fs.mkdirSync(path.join(config.dataDir, 'backups', 'skyway'), { recursive: true });

    const r = await call('GET', '/api/system/orphans', admin());
    expect(r.status, r.raw).toBe(200);
    expect(r.json.docker).toBe(true);
    expect(r.json.volumes.map((v: { name: string }) => v.name)).toEqual(['skyway-viejo-panel-data', 'skyway-viejo__supa__db']);
    expect(r.json.volumes[0]).toMatchObject({ sizeBytes: 1024, createdAt: '2026-09-01T10:00:00Z' });
    expect(r.json.backups.map((b: { serviceId: string }) => b.serviceId)).toEqual([huerfana]);
    expect(r.json.backups[0]).toMatchObject({ files: 1, sizeBytes: 5, latestFile: 'mysql-x.sql.gz' });
  });

  it('un token de API (aunque sea de administrador) no puede listarlos ni borrarlos', async () => {
    escenario();
    const headers = { authorization: adminToken };
    expect((await call('GET', '/api/system/orphans', headers)).status).toBe(403);
    const r = await call('POST', '/api/system/orphans/purge', headers, { confirm: 'eliminar', volumes: ['skyway-viejo-panel-data'] });
    expect(r.status).toBe(403);
    expect(docker.deletedVolumes).toEqual([]);
  });

  it('sin la palabra de confirmación no se borra nada', async () => {
    escenario();
    for (const confirm of ['', 'borrar', 'eliminarlos']) {
      const r = await call('POST', '/api/system/orphans/purge', admin(), { confirm, volumes: ['skyway-viejo-panel-data'] });
      expect(r.status, confirm).toBe(400);
    }
    expect(docker.deletedVolumes).toEqual([]);
  });

  it('el servidor recalcula: solo borra lo que sigue siendo huérfano y audita cada borrado', async () => {
    escenario();
    const r = await call('POST', '/api/system/orphans/purge', admin(), {
      confirm: 'Eliminar',
      volumes: [
        'skyway-viejo-panel-data',
        'skyway-vivo-api-data',
        'skyway-vivo-web-data3',
        'skyway-vivo__supa__storage',
        'skyway-usado-x-data',
        'skyway-compose-x-data',
        'skyway_skyway-data',
        'mailway-mail-data',
        'skyway-no-existe-data',
      ],
    });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.deleted.volumes).toEqual(['skyway-viejo-panel-data']);
    expect(docker.deletedVolumes).toEqual(['skyway-viejo-panel-data']);
    const motivos = Object.fromEntries(r.json.skipped.map((s: { name: string; reason: string }) => [s.name, s.reason]));
    expect(motivos['skyway-vivo-api-data']).toMatch(/Pertenece al servicio «Vivo \/ api»/);
    expect(motivos['skyway-vivo-web-data3']).toMatch(/servicio o un proyecto que sigue existiendo/);
    expect(motivos['skyway-vivo__supa__storage']).toMatch(/servicio o un proyecto que sigue existiendo/);
    expect(motivos['skyway-usado-x-data']).toMatch(/Lo utiliza el contenedor contenedor-parado/);
    expect(motivos['skyway-compose-x-data']).toMatch(/etiquetas/);
    expect(motivos['skyway_skyway-data']).toMatch(/formato/);
    expect(motivos['mailway-mail-data']).toMatch(/formato/);
    expect(motivos['skyway-no-existe-data']).toMatch(/Ya no existe/);
    const auditados = listAudit({ action: 'orphan_volume_deleted' }).map((a) => a.detail);
    expect(auditados.some((d) => d?.startsWith('skyway-viejo-panel-data'))).toBe(true);
  });

  it('rechaza un nombre que ha dejado de ser huérfano entre el listado y el borrado', async () => {
    docker.volumes.push(vol('skyway-renace-panel-data'));
    const lista = await call('GET', '/api/system/orphans', admin());
    expect(lista.json.volumes.map((v: { name: string }) => v.name)).toContain('skyway-renace-panel-data');
    // Entre medias se vuelve a crear el proyecto con su servicio (p. ej., al reinstalar).
    const renace = createProject('Renace', 'renace');
    createService(renace.id, 'panel', 'panel', 'database', dbCfg());
    const r = await call('POST', '/api/system/orphans/purge', admin(), { confirm: 'eliminar', volumes: ['skyway-renace-panel-data'] });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.deleted.volumes).toEqual([]);
    expect(r.json.skipped[0].reason).toMatch(/Pertenece al servicio «Renace \/ panel»/);
    expect(docker.deletedVolumes).toEqual([]);
  });

  it('borra las carpetas de copias de servicios que ya no existen, nunca las de uno vivo', async () => {
    const huerfana = 'svc_fedcba9876543210';
    fs.mkdirSync(path.join(config.dataDir, 'backups', 'skyway'), { recursive: true });
    fs.mkdirSync(backupDir(huerfana), { recursive: true });
    fs.writeFileSync(path.join(backupDir(huerfana), 'pg.sql.gz'), 'x');
    crearCopia(vivoApi.id);
    const r = await call('POST', '/api/system/orphans/purge', admin(), {
      confirm: 'eliminar',
      backups: [huerfana, vivoApi.id, 'skyway', '../skyway'],
    });
    expect(r.status, r.raw).toBe(200);
    expect(r.json.deleted.backups).toEqual([huerfana]);
    expect(fs.existsSync(backupDir(huerfana))).toBe(false);
    expect(fs.existsSync(backupDir(vivoApi.id))).toBe(true);
    const motivos = Object.fromEntries(r.json.skipped.map((s: { name: string; reason: string }) => [s.name, s.reason]));
    expect(motivos[vivoApi.id]).toMatch(/servicio que existe/);
    expect(motivos['skyway']).toMatch(/No es una carpeta de copias de seguridad de un servicio/);
    expect(motivos['../skyway']).toMatch(/No es una carpeta de copias de seguridad de un servicio/);
    expect(fs.existsSync(path.join(config.dataDir, 'backups', 'skyway'))).toBe(true);
    expect(listAudit({ action: 'orphan_backup_deleted' }).some((a) => a.detail?.startsWith(huerfana))).toBe(true);
  });

  it('sin Docker no se borra ningún volumen', async () => {
    escenario();
    docker.available = false;
    const r = await call('POST', '/api/system/orphans/purge', admin(), { confirm: 'eliminar', volumes: ['skyway-viejo-panel-data'] });
    expect(r.status).toBe(503);
    expect(docker.deletedVolumes).toEqual([]);
  });
});

// ======================= reglas puras =======================

describe('regla de los volúmenes huérfanos', () => {
  const v = (name: string, labels: Record<string, string> = {}, driver = 'local'): DockerVolumeInfo => ({ name, driver, labels, createdAt: null });

  it('reconoce solo los nombres que genera Skyway', () => {
    for (const n of ['skyway-a-b-data', 'skyway-a-b-c-data2', 'skyway-a-b-data10', 'skyway-a__supa__storage', 'skyway-a-b__p-q__db-config']) {
      expect(isSkywayVolumeName(n), n).toBe(true);
    }
    for (const n of [
      'skyway-data',
      'skyway-x-data',
      'skyway_skyway-data',
      'skyway-x_traefik-letsencrypt',
      'skyway-a-b-data1',
      'skyway-a-b-data0',
      'skyway-a--b-data',
      'skyway-A-b-data',
      'skyway-a__b',
      'mailway-mail-data',
      'deploy_mailway-db',
      'a'.repeat(64),
    ]) {
      expect(isSkywayVolumeName(n), n).toBe(false);
    }
  });

  it('clasifica sin Docker', () => {
    const p = { id: 'prj_1', name: 'P', slug: 'p' } as ProjectRow;
    const s = { id: 'svc_1', project_id: 'prj_1', name: 'db', slug: 'db', type: 'database', config: {} } as unknown as ServiceRow;
    const huerfanos = classifyOrphanVolumes(
      [
        v('skyway-q-db-data'),
        v('skyway-p-db-data'),
        v('skyway-p-db-data2'), // ruta quitada del servicio vivo «db»
        v('skyway-p-otro-data'), // de un servicio «otro» de P que ya no existe
        v('skyway-p__x__y'), // pila de un proyecto vivo
        v('skyway-q__x__y'),
        v('skyway-q-z-data', { 'com.docker.compose.project': 'q' }),
        v('skyway-q-w-data'),
        v('skyway-q-n-data', {}, 'nfs'),
      ],
      { projects: [p], services: [s] },
      new Map([['skyway-q-w-data', ['parado']]]),
    );
    expect(huerfanos.map((x) => x.name)).toEqual(['skyway-q-db-data', 'skyway-p-otro-data', 'skyway-q__x__y']);
  });

  it('la confirmación es el nombre exacto o el slug', () => {
    const t = { name: 'Mi Tienda', slug: 'mi-tienda' };
    expect(confirmsDeletion('Mi Tienda', t)).toBe(true);
    expect(confirmsDeletion('  Mi Tienda ', t)).toBe(true);
    expect(confirmsDeletion('mi-tienda', t)).toBe(true);
    expect(confirmsDeletion('mi tienda', t)).toBe(false);
    expect(confirmsDeletion('', t)).toBe(false);
    expect(confirmsDeletion(undefined, t)).toBe(false);
    expect(confirmsDeletion(['Mi Tienda'], t)).toBe(false);
  });
});

// ======================= restos de borrados anteriores =======================

describe('referencias de proyectos borrados antes de la 0.36', () => {
  it('al arrancar, las reservas pasan al administrador y las alertas abiertas se cierran', () => {
    const vivo = createProject('Sigue', 'sigue');
    upsertCloudflareDnsRecord({
      domain: 'viejo.operador.example',
      zone_id: 'z1',
      zone_name: 'operador.example',
      record_id: 'r9',
      content: '203.0.113.10',
      project_id: 'prj_borrado_antes',
    });
    upsertCloudflareDnsRecord({
      domain: 'sigue.operador.example',
      zone_id: 'z1',
      zone_name: 'operador.example',
      record_id: 'r10',
      content: '203.0.113.10',
      project_id: vivo.id,
    });
    reservarNombresMailway(['webmail.viejo.example'], 'prj_borrado_antes');
    insertAlert({ severity: 'critical', type: 'down', project_id: 'prj_borrado_antes', service_id: 'svc_borrado_antes', title: 'Caído', message: 'x' });
    insertAlert({ severity: 'warning', type: 'down', project_id: vivo.id, service_id: null, title: 'Vivo', message: 'x' });

    // Como al actualizar: la migración corre en el arranque siguiente.
    setSetting('migrations:deleted_project_refs_v1', null);
    closeDb();
    initDb();

    expect(getCloudflareDnsRecord('viejo.operador.example')?.project_id).toBeNull();
    expect(getCloudflareDnsRecord('sigue.operador.example')?.project_id).toBe(vivo.id);
    expect(getMailwayDnsReserva('webmail.viejo.example')?.project_id).toBeNull();
    const abiertas = listAlerts({ openOnly: true });
    expect(abiertas.some((a) => a.project_id === 'prj_borrado_antes')).toBe(false);
    expect(abiertas.some((a) => a.project_id === vivo.id)).toBe(true);
  });
});
