/**
 * Routers de Traefik con la huella de sus hosts (`traefikLabels`).
 *
 * Traefik borra un router que dos contenedores definen con el mismo nombre y
 * reglas distintas. Con el nombre fijo `skyway-<p>-<s>`, al cambiar los
 * dominios de un servicio la versión vieja y la nueva convivían durante el
 * relevo y todos los nombres del servicio daban 404. Con la huella en el
 * nombre, las dos versiones conviven: lo que comparten (servicio y
 * middlewares) es idéntico y Traefik lo fusiona.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, createProject, createService, initDb, setSetting } from '../src/db';
import { traefikLabels, traefikRouter, traefikServiceName } from '../src/docker/containers';
import { setTraefikAcmeStateForTests } from '../src/tls';
import type { ProjectRow, ServiceRow } from '../src/types';

let p: ProjectRow;
let s: ServiceRow;
let base = '';

beforeAll(() => {
  initDb();
  p = createProject('Tienda', 'tienda');
  s = createService(p.id, 'Web', 'web', 'git', {
    repoUrl: 'https://github.com/acme/web',
    branch: 'main',
    port: 3000,
    domains: ['www.dominio.es'],
    webhookSecret: 'x',
  } as never);
  base = `skyway-${p.slug}-${s.slug}`;
});

afterAll(() => closeDb());

const conTls = () => {
  setSetting('letsencryptEmail', 'ops@acme.es');
  setTraefikAcmeStateForTests({ status: 'ok', email: 'ops@acme.es', checkedAt: Date.now() });
};
const sinTls = () => {
  setSetting('letsencryptEmail', null);
  setTraefikAcmeStateForTests({ status: 'ok', email: 'ops@acme.es', checkedAt: Date.now() });
};

beforeEach(conTls);

/** Las claves `traefik.http.<tipo>.<nombre>` de unas etiquetas, con el nombre de cada objeto. */
function nombres(labels: Record<string, string>, tipo: 'routers' | 'middlewares' | 'services'): string[] {
  const out = new Set<string>();
  for (const k of Object.keys(labels)) {
    const m = new RegExp(`^traefik\\.http\\.${tipo}\\.([^.]+)\\.`).exec(k);
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}

describe('nombre del router', () => {
  it('los mismos hosts, en cualquier orden y con mayúsculas o repetidos, dan el mismo router y las mismas etiquetas', () => {
    const a = traefikLabels(p, s, ['www.dominio.es', 'dominio.es'], 3000);
    const b = traefikLabels(p, s, ['DOMINIO.es', ' www.dominio.es ', 'dominio.es'], 3000);
    expect(b).toEqual(a);
    const { router, hosts } = traefikRouter(p, s, ['www.dominio.es', 'dominio.es']);
    expect(hosts).toEqual(['dominio.es', 'www.dominio.es']);
    expect(router).toMatch(new RegExp(`^${base}-[0-9a-f]{8}$`));
    // La regla se escribe con los hosts ordenados: el mismo conjunto no puede dar dos reglas.
    expect(a[`traefik.http.routers.${router}.rule`]).toBe('Host(`dominio.es`) || Host(`www.dominio.es`)');
    expect(a[`traefik.http.routers.${router}-secure.rule`]).toBe('Host(`dominio.es`) || Host(`www.dominio.es`)');
  });

  it('con otros hosts, otro nombre', () => {
    const viejo = traefikRouter(p, s, ['www.dominio.es']).router;
    const nuevo = traefikRouter(p, s, ['www.dominio2.es']).router;
    const ambos = traefikRouter(p, s, ['www.dominio.es', 'www.dominio2.es']).router;
    expect(new Set([viejo, nuevo, ambos]).size).toBe(3);
  });

  it('sin dominios no hay etiquetas', () => {
    expect(traefikLabels(p, s, [], 3000)).toEqual({});
    expect(traefikLabels(p, s, [' '], 3000)).toEqual({});
  });
});

describe('servicio y middlewares con el nombre base', () => {
  it('el servicio y los middlewares conservan el nombre base, y los routers lo nombran explícitamente', () => {
    const labels = traefikLabels(p, s, ['www.dominio.es'], 3000);
    const { router } = traefikRouter(p, s, ['www.dominio.es']);
    expect(traefikServiceName(p, s)).toBe(base);
    expect(nombres(labels, 'services')).toEqual([base]);
    expect(nombres(labels, 'middlewares')).toEqual([`${base}-https`, `${base}-retry`]);
    expect(nombres(labels, 'routers')).toEqual([router, `${router}-secure`]);
    expect(labels[`traefik.http.services.${base}.loadbalancer.server.port`]).toBe('3000');
    // Con el router y el servicio con nombres distintos, Traefik ya no los empareja solo.
    expect(labels[`traefik.http.routers.${router}.service`]).toBe(base);
    expect(labels[`traefik.http.routers.${router}-secure.service`]).toBe(base);
    expect(labels[`traefik.http.routers.${router}-secure.tls.certresolver`]).toBe('le');
    expect(labels[`traefik.http.routers.${router}.middlewares`]).toBe(`${base}-https`);
    expect(labels[`traefik.http.middlewares.${base}-https.redirectscheme.scheme`]).toBe('https');
  });

  it('el «retry» del intercambio sigue en el router que sirve', () => {
    const { router } = traefikRouter(p, s, ['www.dominio.es']);
    const tls = traefikLabels(p, s, ['www.dominio.es'], 3000);
    expect(tls[`traefik.http.middlewares.${base}-retry.retry.attempts`]).toBe('3');
    expect(tls[`traefik.http.middlewares.${base}-retry.retry.initialinterval`]).toBe('100ms');
    expect(tls[`traefik.http.routers.${router}-secure.middlewares`]).toBe(`${base}-retry`);

    sinTls();
    const claro = traefikLabels(p, s, ['www.dominio.es'], 3000);
    expect(claro[`traefik.http.routers.${router}.middlewares`]).toBe(`${base}-retry`);
  });

  it('sin TLS, solo el router de `web`: ni router seguro ni redirección a https', () => {
    sinTls();
    const labels = traefikLabels(p, s, ['www.dominio.es'], 3000);
    const { router } = traefikRouter(p, s, ['www.dominio.es']);
    expect(nombres(labels, 'routers')).toEqual([router]);
    expect(labels[`traefik.http.routers.${router}.entrypoints`]).toBe('web');
    expect(labels[`traefik.http.routers.${router}.service`]).toBe(base);
    expect(Object.keys(labels).some((k) => k.includes('-secure') || k.includes('redirectscheme'))).toBe(false);
  });
});

describe('convivencia de dos versiones del contenedor', () => {
  /**
   * Lo que haría Traefik al juntar los dos contenedores: un objeto que
   * aparece en los dos con valores distintos se borra. Devuelve los nombres
   * que se borrarían.
   */
  function enConflicto(a: Record<string, string>, b: Record<string, string>): string[] {
    const conflicto = new Set<string>();
    const objeto = (k: string) => /^traefik\.http\.(?:routers|middlewares|services)\.[^.]+/.exec(k)?.[0];
    const deA = new Set(Object.keys(a).map(objeto).filter(Boolean));
    for (const obj of deA) {
      const claves = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => objeto(k) === obj));
      const enB = [...claves].some((k) => k in b);
      if (enB && [...claves].some((k) => a[k] !== b[k])) conflicto.add(obj!);
    }
    return [...conflicto];
  }

  it('con hosts distintos (pasar o volver) no comparten ningún router y lo que comparten es idéntico', () => {
    const viejo = traefikLabels(p, s, ['www.dominio.es', 'tienda.otro.es'], 3000);
    const nuevo = traefikLabels(p, s, ['www.dominio2.es', 'tienda.otro.es'], 3000);
    expect(enConflicto(viejo, nuevo)).toEqual([]);
    expect(nombres(viejo, 'routers').filter((r) => nombres(nuevo, 'routers').includes(r))).toEqual([]);
    expect(nombres(viejo, 'services')).toEqual(nombres(nuevo, 'services'));
    // Las dos reglas siguen sirviendo el nombre que no cambia.
    const reglas = (l: Record<string, string>) => Object.entries(l).filter(([k]) => k.endsWith('.rule')).map(([, v]) => v);
    expect(reglas(viejo).every((r) => r.includes('Host(`tienda.otro.es`)'))).toBe(true);
    expect(reglas(nuevo).every((r) => r.includes('Host(`tienda.otro.es`)'))).toBe(true);
  });

  it('con los mismos hosts (un despliegue normal) las etiquetas coinciden y Traefik las fusiona', () => {
    const a = traefikLabels(p, s, ['www.dominio.es'], 3000);
    const b = traefikLabels(p, s, ['www.dominio.es'], 3000);
    expect(enConflicto(a, b)).toEqual([]);
    expect(b).toEqual(a);
  });

  it('tras actualizar Skyway, el contenedor con el router antiguo y el nuevo no chocan', () => {
    // El contenedor anterior a la huella: router `skyway-<p>-<s>` sin servicio explícito.
    const antiguo: Record<string, string> = {
      [`traefik.http.routers.${base}.rule`]: 'Host(`www.dominio.es`)',
      [`traefik.http.routers.${base}.entrypoints`]: 'web',
      [`traefik.http.routers.${base}.middlewares`]: `${base}-https`,
      [`traefik.http.routers.${base}-secure.rule`]: 'Host(`www.dominio.es`)',
      [`traefik.http.routers.${base}-secure.entrypoints`]: 'websecure',
      [`traefik.http.routers.${base}-secure.tls.certresolver`]: 'le',
      [`traefik.http.routers.${base}-secure.middlewares`]: `${base}-retry`,
      [`traefik.http.middlewares.${base}-https.redirectscheme.scheme`]: 'https',
      [`traefik.http.middlewares.${base}-https.redirectscheme.permanent`]: 'true',
      [`traefik.http.middlewares.${base}-retry.retry.attempts`]: '3',
      [`traefik.http.middlewares.${base}-retry.retry.initialinterval`]: '100ms',
      [`traefik.http.services.${base}.loadbalancer.server.port`]: '3000',
    };
    expect(enConflicto(antiguo, traefikLabels(p, s, ['www.dominio.es'], 3000))).toEqual([]);
  });
});
