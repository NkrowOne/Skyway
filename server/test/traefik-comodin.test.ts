/**
 * Certificado comodín del dominio raíz (`comodin.ts`).
 *
 * Con el resolutor `lecomodin` (DNS-01 de Cloudflare) en Traefik y el ajuste
 * activado, Skyway publica en su proveedor HTTP un router que pide el
 * certificado de `rootDomain` y `*.rootDomain`, y en las etiquetas de cada
 * servicio separa los subdominios generados (router con TLS y sin resolutor:
 * se sirven con el comodín) de los propios (router con `le`). Cada router
 * lleva la huella de sus hosts. Sin token en Traefik, todo sigue como siempre.
 */
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import {
  AJUSTE_COMODIN,
  RESOLUTOR_COMODIN,
  configuracionTraefikComodin,
  resolutorComodinDesdeTraefik,
  setEstadoComodinForTests,
  type ResolutorComodin,
} from '../src/comodin';
import { closeDb, createProject, createService, getSetting, initDb, listAudit, setSetting } from '../src/db';
import { traefikLabels, traefikRouter, traefikServiceName } from '../src/docker/containers';
import type { TraefikDynamicConfig } from '../src/mailwaytraefik';
import { configuracionTraefikSkyway, mezclarConfiguracion } from '../src/redirecciones';
import { setTraefikAcmeStateForTests } from '../src/tls';
import type { ProjectRow, ServiceRow } from '../src/types';

// Lo que devuelve el `docker inspect` de Traefik y el certificado que sirve por
// SNI: sin Docker ni Traefik en las pruebas, se fingen.
const m = vi.hoisted(() => ({
  traefik: null as { args: string[]; env: string[] } | null,
  tls: 'desconocido' as 'ok' | 'invalido' | 'desconocido',
  sni: [] as string[],
}));
vi.mock('../src/tls', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/tls')>();
  return { ...mod, leerTraefik: vi.fn(async () => m.traefik) };
});
vi.mock('../src/redirecciones', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/redirecciones')>();
  return {
    ...mod,
    comprobarTlsLocal: vi.fn(async (host: string) => {
      m.sni.push(host);
      return { estado: m.tls, detalle: '' };
    }),
  };
});

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const RAIZ = 'apps.acme.es';

/** Los flags del Traefik del docker-compose.yml (`- --algo=valor`), como los ve `docker inspect`. */
const compose = fs.readFileSync(path.resolve(__dirname, '../../docker-compose.yml'), 'utf8');
const flagsCompose = compose
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.startsWith('- --'))
  .map((l) => l.slice(2));

let app: FastifyInstance;
let cookie = '';
let raw: Database.Database;
let p: ProjectRow;
let s: ServiceRow;
let base = '';

/** Huella de un conjunto de hosts, como la calcula `traefikRouter`. */
const huella = (hosts: string[]) =>
  crypto
    .createHash('sha256')
    .update([...hosts].sort().join(','))
    .digest('hex')
    .slice(0, 8);

beforeAll(async () => {
  initDb();
  raw = new Database(path.join(process.env.DATA_DIR!, 'skyway.db'));
  app = buildApp();
  await app.ready();
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { email: 'admin@acme.es', password: 'contraseña1' },
    headers: SAME_ORIGIN,
  });
  cookie = String(setup.headers['set-cookie']).split(';')[0];
  p = createProject('Tienda', 'tienda');
  s = createService(p.id, 'Web', 'web', 'git', {
    repoUrl: 'https://github.com/acme/web',
    branch: 'main',
    port: 3000,
    domains: [`web.${RAIZ}`],
    webhookSecret: 'x',
  } as never);
  base = traefikServiceName(p, s);
});

afterAll(async () => {
  raw.close();
  await app.close();
  closeDb();
});

const conTls = () => {
  setSetting('letsencryptEmail', 'ops@acme.es');
  setTraefikAcmeStateForTests({ status: 'ok', email: 'ops@acme.es', checkedAt: Date.now() });
};

/** Comodín activado en el panel y lo que Traefik diga de su resolutor. */
const conComodin = (resolutor: ResolutorComodin | 'desconocido' = 'ok') => {
  setSetting('rootDomain', RAIZ);
  setSetting(AJUSTE_COMODIN, '1');
  setEstadoComodinForTests({ resolutor, checkedAt: Date.now() });
};

beforeEach(() => {
  conTls();
  setSetting('rootDomain', RAIZ);
  setSetting(AJUSTE_COMODIN, null);
  setSetting('serverIp', null);
  setEstadoComodinForTests({ resolutor: 'ok', checkedAt: Date.now() });
  m.traefik = null;
  m.tls = 'desconocido';
  m.sni = [];
});

afterEach(() => {
  delete process.env.SKYWAY_TRAEFIK_WILDCARD;
});

/** Los nombres de los objetos `traefik.http.<tipo>.<nombre>` de unas etiquetas. */
function nombres(labels: Record<string, string>, tipo: 'routers' | 'middlewares' | 'services'): string[] {
  const out = new Set<string>();
  for (const k of Object.keys(labels)) {
    const r = new RegExp(`^traefik\\.http\\.${tipo}\\.([^.]+)\\.`).exec(k);
    if (r) out.add(r[1]);
  }
  return [...out].sort();
}

/**
 * Lo que haría Traefik al juntar los dos contenedores de un relevo: un objeto
 * que aparece en los dos con valores distintos se borra.
 */
function enConflicto(a: Record<string, string>, b: Record<string, string>): string[] {
  const conflicto = new Set<string>();
  const objeto = (k: string) => /^traefik\.http\.(?:routers|middlewares|services)\.[^.]+/.exec(k)?.[0];
  for (const obj of new Set(Object.keys(a).map(objeto).filter(Boolean))) {
    const claves = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => objeto(k) === obj));
    if ([...claves].some((k) => k in b) && [...claves].some((k) => a[k] !== b[k])) conflicto.add(obj!);
  }
  return [...conflicto];
}

const PROPIOS = ['tienda.es', 'www.tienda.es'];
const GENERADOS = [`web.${RAIZ}`];
/** Bajo el dominio raíz pero sin el comodín: la raíz, su www y lo que cuelga a dos niveles. */
const BAJO_RAIZ_CON_LE = [RAIZ, `www.${RAIZ}`, `a.b.${RAIZ}`];

describe('resolutor del comodín en Traefik', () => {
  const resolutor = [
    `--certificatesresolvers.${RESOLUTOR_COMODIN}.acme.email=`,
    `--certificatesresolvers.${RESOLUTOR_COMODIN}.acme.storage=/letsencrypt/acme.json`,
    `--certificatesresolvers.${RESOLUTOR_COMODIN}.acme.dnschallenge.provider=cloudflare`,
  ];

  it('con reto DNS de Cloudflare y token, disponible; con la variable vacía (la del compose sin valor), sin token', () => {
    expect(resolutorComodinDesdeTraefik(resolutor, ['CF_DNS_API_TOKEN=cf-token-de-prueba'])).toBe('ok');
    expect(resolutorComodinDesdeTraefik(resolutor, ['CF_DNS_API_TOKEN='])).toBe('sin_token');
    expect(resolutorComodinDesdeTraefik(resolutor, ['CF_DNS_API_TOKEN=   '])).toBe('sin_token');
    expect(resolutorComodinDesdeTraefik(resolutor, [])).toBe('sin_token');
  });

  it('acepta los otros nombres del token de lego y su variante _FILE, pero no la clave global ni otra grafía', () => {
    expect(resolutorComodinDesdeTraefik(resolutor, ['CLOUDFLARE_DNS_API_TOKEN=x'])).toBe('ok');
    expect(resolutorComodinDesdeTraefik(resolutor, ['CF_DNS_API_TOKEN_FILE=/run/secrets/cf'])).toBe('ok');
    // La clave global da acceso a toda la cuenta: para esto basta un token de la zona.
    expect(resolutorComodinDesdeTraefik(resolutor, ['CF_API_KEY=x', 'CF_API_EMAIL=ops@acme.es'])).toBe('sin_token');
    // lego solo lee el nombre exacto.
    expect(resolutorComodinDesdeTraefik(resolutor, ['cf_dns_api_token=x'])).toBe('sin_token');
  });

  it('sin el resolutor, o con él sin reto DNS, no está; las opciones de Traefik no distinguen mayúsculas', () => {
    expect(resolutorComodinDesdeTraefik(['--certificatesresolvers.le.acme.httpchallenge=true'], ['CF_DNS_API_TOKEN=x'])).toBe(
      'sin_resolutor',
    );
    expect(
      resolutorComodinDesdeTraefik([`--certificatesresolvers.${RESOLUTOR_COMODIN}.acme.storage=/letsencrypt/acme.json`], ['CF_DNS_API_TOKEN=x']),
    ).toBe('sin_resolutor');
    expect(
      resolutorComodinDesdeTraefik([`--certificatesResolvers.${RESOLUTOR_COMODIN}.acme.dnsChallenge.provider=Cloudflare`], ['CF_DNS_API_TOKEN=x']),
    ).toBe('ok');
  });

  it('el resolutor también puede venir del entorno de Traefik; con otro proveedor de DNS se confía en quien lo configuró', () => {
    expect(
      resolutorComodinDesdeTraefik([], ['TRAEFIK_CERTIFICATESRESOLVERS_LECOMODIN_ACME_DNSCHALLENGE_PROVIDER=cloudflare', 'CF_DNS_API_TOKEN=x']),
    ).toBe('ok');
    expect(resolutorComodinDesdeTraefik([`--certificatesresolvers.${RESOLUTOR_COMODIN}.acme.dnschallenge.provider=route53`], [])).toBe('ok');
  });

  it('el docker-compose.yml define el resolutor que busca Skyway, con el token solo en el entorno de Traefik', () => {
    const del = (f: string) => flagsCompose.filter((x) => x.startsWith(`--certificatesresolvers.${RESOLUTOR_COMODIN}.acme.${f}=`));
    expect(del('dnschallenge.provider')).toEqual([`--certificatesresolvers.${RESOLUTOR_COMODIN}.acme.dnschallenge.provider=cloudflare`]);
    // Comparte acme.json y el correo con «le»: cada resolutor guarda allí su parte.
    expect(del('storage')).toEqual([`--certificatesresolvers.${RESOLUTOR_COMODIN}.acme.storage=/letsencrypt/acme.json`]);
    expect(flagsCompose).toContain('--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json');
    expect(del('email')).toEqual([`--certificatesresolvers.${RESOLUTOR_COMODIN}.acme.email=\${LETSENCRYPT_EMAIL:-}`]);
    // Sin reto HTTP en este resolutor: el comodín solo se puede validar por DNS.
    expect(del('httpchallenge')).toEqual([]);

    const bloque = (servicio: string) => {
      const inicio = compose.indexOf(`\n  ${servicio}:\n`);
      expect(inicio).toBeGreaterThan(-1);
      const resto = compose.slice(inicio + 1);
      const fin = resto.slice(1).search(/\n {2}[a-z][\w-]*:\n|\n[a-z]/);
      return fin === -1 ? resto : resto.slice(0, fin + 1);
    };
    // Sin valor en el .env, la variable llega vacía: Skyway lo ve como «sin token».
    expect(bloque('traefik')).toContain('CF_DNS_API_TOKEN: ${CF_DNS_API_TOKEN:-}');
    expect(resolutorComodinDesdeTraefik(flagsCompose, ['CF_DNS_API_TOKEN='])).toBe('sin_token');
    expect(resolutorComodinDesdeTraefik(flagsCompose, ['CF_DNS_API_TOKEN=cf-token-de-prueba'])).toBe('ok');
    // El panel no recibe el token: solo lo usa Traefik.
    expect(bloque('skyway')).not.toContain('CF_DNS_API_TOKEN');
  });
});

describe('etiquetas sin el comodín', () => {
  const todos = [...PROPIOS, ...GENERADOS, ...BAJO_RAIZ_CON_LE];

  /** Las etiquetas de siempre: un router con todos los hosts que pide su certificado a `le`. */
  function comoSiempre(labels: Record<string, string>): void {
    const { router } = traefikRouter(p, s, todos);
    expect(router).toBe(`${base}-${huella(todos)}`);
    expect(nombres(labels, 'routers')).toEqual([router, `${router}-secure`]);
    expect(labels[`traefik.http.routers.${router}-secure.tls.certresolver`]).toBe('le');
    expect(Object.keys(labels).some((k) => k.includes('-comodin') || k.endsWith('.tls'))).toBe(false);
  }

  it('sin el ajuste, un solo router con todos los hosts y `le`, como siempre', () => {
    comoSiempre(traefikLabels(p, s, todos, 3000));
  });

  it('con el ajuste pero sin token o sin resolutor en Traefik, exactamente las mismas etiquetas', () => {
    const antes = traefikLabels(p, s, todos, 3000);
    for (const resolutor of ['sin_token', 'sin_resolutor'] as const) {
      conComodin(resolutor);
      expect(traefikLabels(p, s, todos, 3000)).toEqual(antes);
    }
  });

  it('con el ajuste pero sin dominio raíz o sin HTTPS, tampoco', () => {
    const antes = traefikLabels(p, s, todos, 3000);
    conComodin();
    setSetting('rootDomain', null);
    expect(traefikLabels(p, s, todos, 3000)).toEqual(antes);

    conComodin();
    setSetting('letsencryptEmail', null);
    const claro = traefikLabels(p, s, todos, 3000);
    expect(nombres(claro, 'routers')).toEqual([traefikRouter(p, s, todos).router]);
    expect(Object.keys(claro).some((k) => k.includes('-secure') || k.includes('-comodin'))).toBe(false);
  });
});

describe('etiquetas con el comodín', () => {
  it('los generados van en su router, con TLS y sin resolutor; los propios, en otro con `le`', () => {
    conComodin();
    const propios = [...PROPIOS, ...BAJO_RAIZ_CON_LE];
    const labels = traefikLabels(p, s, [...propios, ...GENERADOS], 3000);
    const rPropios = `${base}-${huella(propios)}`;
    const rGenerados = `${base}-${huella(GENERADOS)}-comodin`;
    expect(nombres(labels, 'routers')).toEqual([rPropios, `${rPropios}-secure`, rGenerados, `${rGenerados}-secure`].sort());

    const regla = (hosts: string[]) => [...hosts].sort().map((h) => `Host(\`${h}\`)`).join(' || ');
    expect(labels[`traefik.http.routers.${rPropios}.rule`]).toBe(regla(propios));
    expect(labels[`traefik.http.routers.${rPropios}-secure.rule`]).toBe(regla(propios));
    expect(labels[`traefik.http.routers.${rPropios}-secure.tls.certresolver`]).toBe('le');
    expect(labels[`traefik.http.routers.${rPropios}-secure.tls`]).toBeUndefined();

    expect(labels[`traefik.http.routers.${rGenerados}.rule`]).toBe(regla(GENERADOS));
    expect(labels[`traefik.http.routers.${rGenerados}-secure.rule`]).toBe(regla(GENERADOS));
    expect(labels[`traefik.http.routers.${rGenerados}-secure.tls`]).toBe('true');
    expect(labels[`traefik.http.routers.${rGenerados}-secure.tls.certresolver`]).toBeUndefined();
    expect(Object.entries(labels).filter(([k, v]) => k.endsWith('.tls.certresolver') && v !== 'le')).toEqual([]);

    // Lo compartido conserva el nombre base, y los dos pares de routers lo usan igual.
    expect(nombres(labels, 'services')).toEqual([base]);
    expect(nombres(labels, 'middlewares')).toEqual([`${base}-https`, `${base}-retry`]);
    for (const r of [rPropios, rGenerados]) {
      expect(labels[`traefik.http.routers.${r}.entrypoints`]).toBe('web');
      expect(labels[`traefik.http.routers.${r}.service`]).toBe(base);
      expect(labels[`traefik.http.routers.${r}.middlewares`]).toBe(`${base}-https`);
      expect(labels[`traefik.http.routers.${r}-secure.entrypoints`]).toBe('websecure');
      expect(labels[`traefik.http.routers.${r}-secure.service`]).toBe(base);
      expect(labels[`traefik.http.routers.${r}-secure.middlewares`]).toBe(`${base}-retry`);
    }
    expect(labels[`traefik.http.services.${base}.loadbalancer.server.port`]).toBe('3000');
  });

  it('el nombre de cada router lleva la huella de sus hosts, en cualquier orden y con mayúsculas o repetidos', () => {
    conComodin();
    const a = traefikLabels(p, s, ['tienda.es', `web.${RAIZ}`, `api.${RAIZ}`], 3000);
    const b = traefikLabels(p, s, [` API.${RAIZ.toUpperCase()} `, 'tienda.es', `web.${RAIZ}`, 'TIENDA.es'], 3000);
    expect(b).toEqual(a);
    const generados = [`api.${RAIZ}`, `web.${RAIZ}`];
    expect(nombres(a, 'routers')).toEqual(
      [`${base}-${huella(['tienda.es'])}`, `${base}-${huella(['tienda.es'])}-secure`, `${base}-${huella(generados)}-comodin`, `${base}-${huella(generados)}-comodin-secure`].sort(),
    );
    for (const r of nombres(a, 'routers')) expect(r).toMatch(new RegExp(`^${base}-[0-9a-f]{8}(-comodin)?(-secure)?$`));
    // Otros generados, otro nombre: nunca un nombre fijo.
    const otro = traefikLabels(p, s, ['tienda.es', `web.${RAIZ}`], 3000);
    expect(nombres(otro, 'routers')).toContain(`${base}-${huella([`web.${RAIZ}`])}-comodin`);
    expect(nombres(otro, 'routers')).not.toContain(`${base}-${huella(generados)}-comodin`);
  });

  it('con solo subdominios generados, solo el router del comodín; con solo propios, el de siempre', () => {
    conComodin();
    const generados = traefikLabels(p, s, GENERADOS, 3000);
    expect(nombres(generados, 'routers')).toEqual([`${base}-${huella(GENERADOS)}-comodin`, `${base}-${huella(GENERADOS)}-comodin-secure`]);
    const propios = traefikLabels(p, s, PROPIOS, 3000);
    setSetting(AJUSTE_COMODIN, null);
    expect(propios).toEqual(traefikLabels(p, s, PROPIOS, 3000));
  });

  it('si no se puede preguntar a Traefik, se confía en el ajuste, como con el correo de Let\'s Encrypt', () => {
    conComodin('desconocido');
    expect(nombres(traefikLabels(p, s, GENERADOS, 3000), 'routers')).toEqual([
      `${base}-${huella(GENERADOS)}-comodin`,
      `${base}-${huella(GENERADOS)}-comodin-secure`,
    ]);
  });

  it('activar o desactivar el comodín entre dos versiones del contenedor no define dos veces el mismo router', () => {
    for (const hosts of [GENERADOS, [...PROPIOS, ...GENERADOS], PROPIOS]) {
      setSetting(AJUSTE_COMODIN, null);
      const antes = traefikLabels(p, s, hosts, 3000);
      conComodin();
      const despues = traefikLabels(p, s, hosts, 3000);
      expect(enConflicto(antes, despues)).toEqual([]);
      expect(enConflicto(despues, antes)).toEqual([]);
    }
  });
});

describe('router del comodín en el proveedor HTTP', () => {
  const nombre = `skyway-comodin-${huella([RAIZ, `*.${RAIZ}`])}`;
  const sondeo = async (): Promise<Json> => (await app.inject({ method: 'GET', url: '/api/traefik/mailway' })).json();

  it('pide a `lecomodin` el certificado de la raíz y *.raíz con un router que no atiende peticiones reales', async () => {
    conComodin();
    const cfg = await sondeo();
    expect(cfg.http.routers[nombre]).toEqual({
      rule: `Host(\`${RAIZ}\`) && Path(\`/.well-known/skyway-comodin\`)`,
      entryPoints: ['websecure'],
      priority: 1,
      service: 'noop@internal',
      tls: { certResolver: RESOLUTOR_COMODIN, domains: [{ main: RAIZ, sans: [`*.${RAIZ}`] }] },
    });
    expect(Object.keys(cfg.http.routers).filter((n) => n.startsWith('skyway-comodin-'))).toEqual([nombre]);
  });

  it('el nombre lleva la huella de sus dominios: con otro dominio raíz, otro router', () => {
    conComodin();
    setSetting('rootDomain', 'apps.otra.es');
    const routers = Object.keys(configuracionTraefikComodin().http?.routers ?? {});
    expect(routers).toEqual([`skyway-comodin-${huella(['apps.otra.es', '*.apps.otra.es'])}`]);
  });

  it('sin el ajuste, sin token, sin resolutor, sin dominio raíz o sin HTTPS, no se publica nada', async () => {
    expect(await sondeo()).toEqual({});
    for (const resolutor of ['sin_token', 'sin_resolutor'] as const) {
      conComodin(resolutor);
      expect(await sondeo()).toEqual({});
    }
    conComodin();
    setSetting('rootDomain', null);
    expect(await sondeo()).toEqual({});
    conComodin();
    setSetting('letsencryptEmail', null);
    expect(await sondeo()).toEqual({});
  });

  it('no le quita la raíz a una ruta de Mailway: su regla no cuenta como nombre propio de Skyway', () => {
    conComodin();
    const mailway: TraefikDynamicConfig = {
      http: {
        routers: { webmail: { rule: `Host(\`${RAIZ}\`)`, entryPoints: ['websecure'], service: 'webmail', tls: { certResolver: 'le' } } },
        services: { webmail: { loadBalancer: { servers: [{ url: 'http://mailway-webmail:80' }] } } },
      },
    };
    const mezcla = mezclarConfiguracion(mailway, configuracionTraefikSkyway(), {}, configuracionTraefikComodin());
    expect(Object.keys(mezcla.http?.routers ?? {}).sort()).toEqual([nombre, 'webmail']);
    expect(Object.keys(mezcla.http?.services ?? {})).toEqual(['webmail']);
  });

  it('la prepublicación de un subdominio generado usa el comodín; la de un dominio propio, `le`', () => {
    conComodin();
    const insertar = raw.prepare(
      'INSERT OR REPLACE INTO domain_prepublished (host, project_id, service_id, migration_id, dns_ok_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insertar.run(`nuevo.${RAIZ}`, p.id, s.id, 'mig_1', Date.now(), Date.now());
    insertar.run('nuevo-propio.es', p.id, s.id, 'mig_1', Date.now(), Date.now());
    try {
      const routers = configuracionTraefikSkyway().http.routers;
      const seguro = (host: string) => routers[`skyway-pre-${crypto.createHash('sha256').update(host).digest('hex').slice(0, 8)}-secure`];
      expect(seguro(`nuevo.${RAIZ}`).tls).toEqual({});
      expect(seguro('nuevo-propio.es').tls).toEqual({ certResolver: 'le' });

      setSetting(AJUSTE_COMODIN, null);
      const sinComodin = configuracionTraefikSkyway().http.routers;
      expect(sinComodin[`skyway-pre-${crypto.createHash('sha256').update(`nuevo.${RAIZ}`).digest('hex').slice(0, 8)}-secure`].tls).toEqual({
        certResolver: 'le',
      });
    } finally {
      raw.prepare('DELETE FROM domain_prepublished').run();
    }
  });
});

describe('Ajustes → Dominios y TLS', () => {
  const ajustes = async (): Promise<Json> => (await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).json();
  const guardar = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie, ...SAME_ORIGIN }, payload });
  const traefikCon = (env: string[]) => {
    m.traefik = { args: flagsCompose, env };
  };

  it('GET /settings dice si Traefik tiene el resolutor, si el comodín está en uso y si Traefik ya lo sirve', async () => {
    setEstadoComodinForTests({ resolutor: 'sin_token', checkedAt: Date.now() });
    const sinToken = await ajustes();
    expect(sinToken.settings[AJUSTE_COMODIN]).toBeNull();
    expect(sinToken.comodin).toEqual({
      resolver: RESOLUTOR_COMODIN,
      resolutor: 'sin_token',
      declarado: false,
      disponible: false,
      enUso: null,
      certificado: null,
    });
    // Sin comodín en uso no se pregunta nada a Traefik.
    expect(m.sni).toEqual([]);

    conComodin();
    m.tls = 'invalido';
    const enUso = await ajustes();
    expect(enUso.settings[AJUSTE_COMODIN]).toBe('1');
    expect(enUso.comodin).toEqual({
      resolver: RESOLUTOR_COMODIN,
      resolutor: 'ok',
      declarado: false,
      disponible: true,
      enUso: RAIZ,
      certificado: 'invalido',
    });
    // Por SNI, con un nombre de un nivel bajo la raíz: lo cubre el comodín y ningún otro.
    expect(m.sni).toEqual([`skyway-comodin.${RAIZ}`]);
    m.tls = 'ok';
    expect((await ajustes()).comodin.certificado).toBe('ok');
    // Del token no sale nada: ni su valor ni su nombre de variable con valor.
    expect(JSON.stringify(enUso)).not.toContain('cf-token');
  });

  it('activarlo exige un dominio raíz; sin él, 400 y no se guarda nada', async () => {
    traefikCon(['CF_DNS_API_TOKEN=cf-token-de-prueba']);
    setSetting('rootDomain', null);
    const r = await guardar({ wildcardCert: true, serverIp: '203.0.113.10' });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('wildcard_needs_root_domain');
    expect(getSetting(AJUSTE_COMODIN)).toBeNull();
    expect(getSetting('serverIp')).toBeNull();
  });

  it('sin el token en Traefik, 400 con lo que hay que hacer, y no se guarda nada', async () => {
    traefikCon(['CF_DNS_API_TOKEN=']);
    const r = await guardar({ wildcardCert: true, rootDomain: 'apps.nueva.es' });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('wildcard_unavailable');
    expect(r.json().error).toMatch(/CF_DNS_API_TOKEN/);
    expect(r.json().error).toMatch(/docker compose up -d traefik/);
    expect(getSetting(AJUSTE_COMODIN)).toBeNull();
    expect(getSetting('rootDomain')).toBe(RAIZ);

    m.traefik = { args: ['--certificatesresolvers.le.acme.httpchallenge=true'], env: ['CF_DNS_API_TOKEN=x'] };
    const sinResolutor = await guardar({ wildcardCert: true });
    expect(sinResolutor.statusCode).toBe(400);
    expect(sinResolutor.json().error).toMatch(new RegExp(`no tiene el resolutor «${RESOLUTOR_COMODIN}»`));
  });

  it('con el resolutor y el token, se activa y se desactiva, y queda en la auditoría', async () => {
    traefikCon(['CF_DNS_API_TOKEN=cf-token-de-prueba']);
    const r = await guardar({ wildcardCert: true });
    expect(r.statusCode).toBe(200);
    expect(getSetting(AJUSTE_COMODIN)).toBe('1');
    const alta = listAudit({ action: 'wildcard_cert_enabled' });
    expect(alta).toHaveLength(1);
    expect(alta[0].detail).toBe(RAIZ);
    expect(JSON.stringify(alta)).not.toContain('cf-token');
    expect((await ajustes()).comodin.enUso).toBe(RAIZ);

    // Reenviar lo que ya está no vuelve a comprobar Traefik ni deja otra entrada.
    m.traefik = null;
    expect((await guardar({ wildcardCert: true, serverIp: '203.0.113.10' })).statusCode).toBe(200);
    expect(getSetting('serverIp')).toBe('203.0.113.10');
    expect(listAudit({ action: 'wildcard_cert_enabled' })).toHaveLength(1);

    expect((await guardar({ wildcardCert: false })).statusCode).toBe(200);
    expect(getSetting(AJUSTE_COMODIN)).toBeNull();
    expect(listAudit({ action: 'wildcard_cert_disabled' })).toHaveLength(1);
  });

  it('SKYWAY_TRAEFIK_WILDCARD lo declara cuando no se puede preguntar a Traefik, pero lo que se ve en Traefik manda', async () => {
    process.env.SKYWAY_TRAEFIK_WILDCARD = '1';
    m.traefik = null;
    const declarado = await guardar({ wildcardCert: true });
    expect(declarado.statusCode).toBe(200);
    expect((await ajustes()).comodin).toMatchObject({ resolutor: 'desconocido', declarado: true, disponible: true });
    setSetting(AJUSTE_COMODIN, null);

    traefikCon(['CF_DNS_API_TOKEN=']);
    const r = await guardar({ wildcardCert: true });
    expect(r.statusCode).toBe(400);
    expect(getSetting(AJUSTE_COMODIN)).toBeNull();
  });

  it('el informe de seguridad avisa si está activado y Traefik ya no tiene el token', async () => {
    const informe = async (): Promise<string[]> =>
      ((await app.inject({ method: 'GET', url: '/api/security', headers: { cookie } })).json() as Json).findings.map((f: Json) => f.id);
    conComodin('sin_token');
    expect(await informe()).toContain('wildcard-unavailable');
    conComodin('ok');
    expect(await informe()).not.toContain('wildcard-unavailable');
    setSetting(AJUSTE_COMODIN, null);
    setEstadoComodinForTests({ resolutor: 'sin_token', checkedAt: Date.now() });
    expect(await informe()).not.toContain('wildcard-unavailable');
  });
});
