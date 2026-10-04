/**
 * Modelo del cambio de dominio en la base de Skyway (`db.ts`): las tablas, un
 * solo cambio abierto por proyecto, las funciones de acceso, los nombres que
 * Skyway publica (`listAssignedDomains`, que usa el puente de Traefik de
 * Mailway para no ceder ninguno) y el borrado en cascada con el proyecto.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDb,
  createProject,
  createService,
  deletePrepublished,
  deleteDomainRedirects,
  deleteProject,
  deleteService,
  findServiceIdByDomain,
  getDomainMigration,
  getDomainRedirect,
  getOpenDomainMigration,
  getPrepublished,
  initDb,
  insertDomainMigration,
  insertDomainRedirects,
  listAssignedDomains,
  listDomainMigrations,
  listDomainMigrationsByEstado,
  listDomainRedirects,
  listPrepublished,
  listSnapshots,
  markPrepublishedDns,
  purgeSnapshots,
  putSnapshot,
  serviceIdsForDomain,
  setDomainMigrationServicio,
  updateDomainMigration,
  upsertPrepublished,
} from '../src/db';
import type { GitConfig, ProjectRow, ServiceRow } from '../src/types';

function gitCfg(domains: string[]): GitConfig {
  return { repoUrl: 'https://github.com/x/y', branch: 'main', port: 3000, domains, webhookSecret: 'w' } as GitConfig;
}

let proj: ProjectRow;
let otro: ProjectRow;
let web: ServiceRow;
let api: ServiceRow;

const nuevo = (projectId: string, extra: Partial<Parameters<typeof insertDomainMigration>[0]> = {}) =>
  insertDomainMigration({
    project_id: projectId,
    from_domain: 'Dominio.es.',
    to_domain: 'dominio2.es',
    hosts: [{ serviceId: web.id, from: 'www.dominio.es', to: 'www.dominio2.es', modo: 'redirigir' }],
    env: { excluidas: [{ ambito: 'service', serviceId: web.id, key: 'COOKIE_DOMAIN' }], huella: 'h1' },
    created_by: 'usr_1',
    ...extra,
  });

beforeAll(() => {
  initDb();
  proj = createProject('Tienda', 'tienda', null, null);
  otro = createProject('Blog', 'blog', null, null);
  web = createService(proj.id, 'Web', 'web', 'git', gitCfg(['www.dominio.es', 'dominio.es']));
  api = createService(proj.id, 'API', 'api', 'git', gitCfg(['api.dominio.es']));
});

afterAll(() => {
  closeDb();
});

describe('domain_migrations', () => {
  it('crea el cambio con los JSON leídos y los nombres normalizados', () => {
    const m = nuevo(proj.id);
    expect(m).toMatchObject({
      project_id: proj.id,
      from_domain: 'dominio.es',
      to_domain: 'dominio2.es',
      estado: 'preparando',
      paso: '',
      error: null,
      solo_web: false,
      mailway_client_id: null,
      mailway_migration_id: null,
      servicios: {},
      created_by: 'usr_1',
      pasada_at: null,
      terminada_at: null,
    });
    expect(m.id).toMatch(/^dmig_/);
    expect(m.hosts).toEqual([{ serviceId: web.id, from: 'www.dominio.es', to: 'www.dominio2.es', modo: 'redirigir' }]);
    expect(m.env).toEqual({ excluidas: [{ ambito: 'service', serviceId: web.id, key: 'COOKIE_DOMAIN' }], huella: 'h1' });
    expect(getDomainMigration(m.id)).toEqual(m);
    expect(getOpenDomainMigration(proj.id)?.id).toBe(m.id);
    expect(getOpenDomainMigration(otro.id)).toBeUndefined();
  });

  it('un solo cambio abierto por proyecto; cerrado el anterior, se puede abrir otro', () => {
    const abierto = getOpenDomainMigration(proj.id)!;
    expect(() => nuevo(proj.id)).toThrow(/UNIQUE/);
    // Otro proyecto no se ve afectado.
    const delOtro = nuevo(otro.id, { solo_web: true, hosts: [] });
    expect(delOtro.solo_web).toBe(true);

    expect(updateDomainMigration(abierto.id, { estado: 'cancelada', terminada_at: 123 })).toBe(true);
    expect(getOpenDomainMigration(proj.id)).toBeUndefined();
    const segundo = nuevo(proj.id, { to_domain: 'dominio3.es' });
    expect(getOpenDomainMigration(proj.id)?.id).toBe(segundo.id);
    expect(listDomainMigrations(proj.id).map((m) => m.id)).toEqual([segundo.id, abierto.id]);
    expect(listDomainMigrations(proj.id, 1).map((m) => m.id)).toEqual([segundo.id]);
  });

  it('actualiza con lista blanca, sube updated_at y admite la condición de estado', () => {
    const m = getOpenDomainMigration(proj.id)!;
    const ok = updateDomainMigration(m.id, {
      estado: 'pasando',
      paso: 'servicios 1/2',
      error: 'fallo',
      mailway_client_id: 'cli_1',
      mailway_migration_id: 'dmg_1',
      hosts: [{ serviceId: api.id, from: 'api.dominio.es', to: 'api.dominio2.es', modo: 'servir' }],
      env: { excluidas: [], huella: 'h2' },
      servicios: { [web.id]: { deploymentId: 'dep_1', estado: 'building', error: null } },
      // Lo que no es un campo del parche se ignora (el SQL se monta con nombres de la lista blanca).
      ...({ project_id: otro.id, 'estado = 1; --': 'x' } as object),
    });
    expect(ok).toBe(true);
    const leido = getDomainMigration(m.id)!;
    expect(leido).toMatchObject({
      project_id: proj.id,
      estado: 'pasando',
      paso: 'servicios 1/2',
      error: 'fallo',
      mailway_client_id: 'cli_1',
      mailway_migration_id: 'dmg_1',
      env: { excluidas: [], huella: 'h2' },
    });
    expect(leido.hosts[0].modo).toBe('servir');
    expect(leido.updated_at).toBeGreaterThanOrEqual(m.updated_at);

    // Solo si el estado sigue siendo uno de esos.
    expect(updateDomainMigration(m.id, { estado: 'pasada' }, { siEstado: ['lista'] })).toBe(false);
    expect(getDomainMigration(m.id)?.estado).toBe('pasando');
    expect(updateDomainMigration(m.id, { estado: 'pasada', pasada_at: 1000, error: null }, { siEstado: ['lista', 'pasando'] })).toBe(true);
    expect(getDomainMigration(m.id)).toMatchObject({ estado: 'pasada', pasada_at: 1000, error: null });
    expect(updateDomainMigration('no-existe', { paso: 'x' })).toBe(false);
  });

  it('cada servicio anota su despliegue sin pisar los demás', () => {
    const m = getOpenDomainMigration(proj.id)!;
    setDomainMigrationServicio(m.id, api.id, { deploymentId: 'dep_2', estado: 'success', error: null });
    setDomainMigrationServicio(m.id, web.id, { deploymentId: 'dep_1', estado: 'failed', error: 'sin respuesta' });
    expect(getDomainMigration(m.id)?.servicios).toEqual({
      [web.id]: { deploymentId: 'dep_1', estado: 'failed', error: 'sin respuesta' },
      [api.id]: { deploymentId: 'dep_2', estado: 'success', error: null },
    });
    setDomainMigrationServicio(m.id, web.id, null);
    expect(Object.keys(getDomainMigration(m.id)!.servicios)).toEqual([api.id]);
  });

  it('lista los que quedaron a medias en cualquier proyecto', () => {
    const m = getOpenDomainMigration(proj.id)!;
    updateDomainMigration(m.id, { estado: 'volviendo' });
    const delOtro = getOpenDomainMigration(otro.id)!;
    updateDomainMigration(delOtro.id, { estado: 'dando_de_baja' });
    expect(listDomainMigrationsByEstado(['pasando', 'volviendo', 'dando_de_baja']).map((x) => x.id).sort()).toEqual([m.id, delOtro.id].sort());
    expect(listDomainMigrationsByEstado([])).toEqual([]);
  });

  it('una columna JSON con otra forma se lee vacía en lugar de fallar', () => {
    const m = getOpenDomainMigration(proj.id)!;
    // `hosts` guardado como objeto (una fila editada a mano, una versión futura…).
    updateDomainMigration(m.id, { hosts: { roto: true } as never, env: [] as never });
    expect(getDomainMigration(m.id)).toMatchObject({ hosts: [], env: { excluidas: [], huella: '' } });
  });
});

describe('instantáneas', () => {
  it('guardan, sustituyen, se listan por cambio y se purgan', () => {
    const m = getOpenDomainMigration(proj.id)!;
    putSnapshot({ migration_id: m.id, ambito: 'service', service_id: web.id, key: 'APP_URL', valor_original: 'https://www.dominio.es' });
    putSnapshot({ migration_id: m.id, ambito: 'project', key: 'BASE_URL', valor_original: 'https://dominio.es', valor_escrito: 'https://dominio2.es' });
    putSnapshot({ migration_id: m.id, ambito: 'domains', service_id: web.id, key: 'domains', valor_original: '["www.dominio.es"]' });
    // Pasar otra vez tras «Volver»: la fila se sustituye.
    putSnapshot({
      migration_id: m.id,
      ambito: 'service',
      service_id: web.id,
      key: 'APP_URL',
      valor_original: 'https://www.dominio.es',
      valor_escrito: 'https://www.dominio2.es',
    });
    const filas = listSnapshots(m.id);
    expect(filas.map((f) => `${f.ambito}/${f.service_id}/${f.key}`)).toEqual([
      `domains/${web.id}/domains`,
      'project//BASE_URL',
      `service/${web.id}/APP_URL`,
    ]);
    expect(filas.find((f) => f.key === 'APP_URL')).toMatchObject({ valor_original: 'https://www.dominio.es', valor_escrito: 'https://www.dominio2.es' });
    expect(filas.find((f) => f.key === 'domains')?.valor_escrito).toBeNull();
    expect(listSnapshots('otro')).toEqual([]);
    expect(purgeSnapshots(m.id)).toBe(3);
    expect(listSnapshots(m.id)).toEqual([]);
  });
});

describe('redirecciones y prepublicación', () => {
  it('redirecciones: alta normalizada, reintento que sustituye y nunca se apropia de otro proyecto', () => {
    const m = getOpenDomainMigration(proj.id)!;
    insertDomainRedirects([
      { host: 'WWW.Dominio.es.', project_id: proj.id, to_host: 'www.dominio2.es', migration_id: m.id, permanent_from: 5000 },
      { host: 'dominio.es', project_id: proj.id, to_host: 'dominio2.es', migration_id: m.id, permanent_from: 5000 },
    ]);
    expect(getDomainRedirect('www.dominio.es')).toMatchObject({
      host: 'www.dominio.es',
      project_id: proj.id,
      to_host: 'www.dominio2.es',
      migration_id: m.id,
      permanent_from: 5000,
    });
    // Reintento: se sustituye.
    insertDomainRedirects([{ host: 'www.dominio.es', project_id: proj.id, to_host: 'www.dominio2.es', migration_id: m.id, permanent_from: 9000 }]);
    expect(getDomainRedirect('www.dominio.es')?.permanent_from).toBe(9000);
    // Otro proyecto no se lo queda.
    insertDomainRedirects([{ host: 'www.dominio.es', project_id: otro.id, to_host: 'robado.es', migration_id: 'x', permanent_from: 1 }]);
    expect(getDomainRedirect('www.dominio.es')).toMatchObject({ project_id: proj.id, to_host: 'www.dominio2.es' });
    insertDomainRedirects([{ host: 'blog.viejo.es', project_id: otro.id, to_host: 'blog.nuevo.es', permanent_from: 1 }]);
    expect(getDomainRedirect('blog.viejo.es')?.migration_id).toBeNull();

    expect(listDomainRedirects().map((r) => r.host)).toEqual(['blog.viejo.es', 'dominio.es', 'www.dominio.es']);
    expect(listDomainRedirects(m.id).map((r) => r.host)).toEqual(['dominio.es', 'www.dominio.es']);
  });

  it('prepublicación: alta, DNS que se marca y se desmarca, y borrado por servicio', () => {
    const m = getOpenDomainMigration(proj.id)!;
    upsertPrepublished([
      { host: 'www.dominio2.es', project_id: proj.id, service_id: web.id, migration_id: m.id },
      { host: 'api.dominio2.es', project_id: proj.id, service_id: api.id, migration_id: m.id },
    ]);
    expect(getPrepublished('WWW.dominio2.es')).toMatchObject({ project_id: proj.id, service_id: web.id, migration_id: m.id, dns_ok_at: null });
    markPrepublishedDns('www.dominio2.es', 7000);
    // Repetir el alta conserva el DNS comprobado.
    upsertPrepublished([{ host: 'www.dominio2.es', project_id: proj.id, service_id: web.id, migration_id: m.id }]);
    expect(getPrepublished('www.dominio2.es')?.dns_ok_at).toBe(7000);
    // Otro proyecto no se lo queda.
    upsertPrepublished([{ host: 'www.dominio2.es', project_id: otro.id, service_id: web.id, migration_id: 'x' }]);
    expect(getPrepublished('www.dominio2.es')?.project_id).toBe(proj.id);
    markPrepublishedDns('api.dominio2.es', 8000);
    markPrepublishedDns('api.dominio2.es', null);
    expect(getPrepublished('api.dominio2.es')?.dns_ok_at).toBeNull();
    expect(listPrepublished().map((p) => p.host)).toEqual(['api.dominio2.es', 'www.dominio2.es']);
    expect(listPrepublished(m.id)).toHaveLength(2);
    expect(listPrepublished('otro')).toEqual([]);

    expect(deletePrepublished(m.id, api.id)).toBe(1);
    expect(listPrepublished(m.id).map((p) => p.host)).toEqual(['www.dominio2.es']);
  });

  it('listAssignedDomains suma las redirecciones y la prepublicación; los servicios siguen siendo solo los suyos', () => {
    const asignados = listAssignedDomains();
    for (const h of ['www.dominio.es', 'dominio.es', 'api.dominio.es', 'blog.viejo.es', 'www.dominio2.es']) expect(asignados).toContain(h);
    expect(new Set(asignados).size).toBe(asignados.length);
    // Una redirección no es de ningún servicio.
    expect(findServiceIdByDomain('blog.viejo.es')).toBeUndefined();
    expect(serviceIdsForDomain('www.dominio2.es')).toEqual([]);
    expect(findServiceIdByDomain('www.dominio.es')).toBe(web.id);
  });

  it('borrar las redirecciones del cambio deja las demás', () => {
    const m = getOpenDomainMigration(proj.id)!;
    expect(deleteDomainRedirects(m.id)).toBe(2);
    expect(listDomainRedirects().map((r) => r.host)).toEqual(['blog.viejo.es']);
    expect(listAssignedDomains()).not.toContain('dominio2.es');
  });
});

describe('borrados en cascada', () => {
  it('la prepublicación muere con su servicio; las redirecciones no', () => {
    const m = getOpenDomainMigration(proj.id)!;
    const efimero = createService(proj.id, 'Efímero', 'efimero', 'git', gitCfg(['efimero.dominio.es']));
    upsertPrepublished([{ host: 'efimero.dominio2.es', project_id: proj.id, service_id: efimero.id, migration_id: m.id }]);
    insertDomainRedirects([{ host: 'efimero.dominio.es', project_id: proj.id, to_host: 'efimero.dominio2.es', migration_id: m.id, permanent_from: 1 }]);
    deleteService(efimero.id);
    expect(getPrepublished('efimero.dominio2.es')).toBeUndefined();
    expect(getDomainRedirect('efimero.dominio.es')).toBeDefined();
  });

  it('borrar el proyecto borra sus cambios, instantáneas, redirecciones y prepublicación', () => {
    const m = getOpenDomainMigration(proj.id)!;
    putSnapshot({ migration_id: m.id, ambito: 'service', service_id: web.id, key: 'X', valor_original: 'y' });
    upsertPrepublished([{ host: 'www.dominio2.es', project_id: proj.id, service_id: web.id, migration_id: m.id }]);
    deleteProject(proj.id);
    expect(getDomainMigration(m.id)).toBeUndefined();
    expect(listDomainMigrations(proj.id)).toEqual([]);
    expect(listSnapshots(m.id)).toEqual([]);
    expect(getDomainRedirect('efimero.dominio.es')).toBeUndefined();
    expect(getPrepublished('www.dominio2.es')).toBeUndefined();
    // Lo del otro proyecto sigue.
    expect(getDomainRedirect('blog.viejo.es')).toBeDefined();
    expect(getOpenDomainMigration(otro.id)).toBeDefined();
  });
});
