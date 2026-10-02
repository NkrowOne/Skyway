/**
 * Herramientas de terminal del servidor con las que el instalador de Mailway
 * empareja los dos paneles: `tools/token.ts` (token de API de corta duración)
 * y `tools/mailway.ts` (conectar Mailway como en Ajustes → Correo). Se llaman
 * sus funciones exportadas, sin lanzar procesos, y lo que crean se comprueba
 * contra las rutas reales con `app.inject()`. Mailway es el doble de
 * `mailwayfake.ts`.
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import {
  closeDb,
  createProject,
  createService,
  createUser,
  getApiToken,
  getSetting,
  initDb,
  listAudit,
  setSetting,
} from '../src/db';
import { resetMailwayCaches } from '../src/mailway';
import { resetMailwayTraefikState } from '../src/mailwaytraefik';
import { ejecutarMailway } from '../src/tools/mailway';
import { ejecutarToken } from '../src/tools/token';
import type { GitConfig, ServiceRow } from '../src/types';
import { hashPassword } from '../src/util';
import { MW_BASE, MW_TOKEN, TRAEFIK_TOKEN, fakeFetch, mw } from './mailwayfake';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

let app: FastifyInstance;
let adminCookie = '';
let panel: ServiceRow;

function gitCfg(domains: string[] = [], port = 3000): GitConfig {
  return { repoUrl: 'https://github.com/x/y', branch: 'main', port, domains, webhookSecret: 'w' } as GitConfig;
}

/** E/S de una ejecución: lo escrito en stdout y stderr, y la entrada estándar simulada. */
function io(entrada = '') {
  const out: string[] = [];
  const err: string[] = [];
  const leerEntrada = vi.fn(async () => entrada);
  return { out, err, leerEntrada, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), leerEntrada } };
}

function token(argv: string[]) {
  const r = io();
  const code = ejecutarToken(argv, r.io);
  return { code, out: r.out, err: r.err };
}

async function conectar(argv: string[], entrada: string) {
  const r = io(entrada);
  const code = await ejecutarMailway(argv, r.io);
  return { code, out: r.out, err: r.err, leerEntrada: r.leerEntrada };
}

async function get(url: string, headers: Record<string, string>) {
  const r = await app.inject({ method: 'GET', url, headers });
  let json: Json = null;
  try {
    json = r.json();
  } catch {
    /* sin JSON */
  }
  return { status: r.statusCode, json };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const admin = () => ({ cookie: adminCookie, ...SAME_ORIGIN });

/** La configuración de Mailway vuelve a estar vacía (cada prueba de conexión parte de cero). */
function olvidarMailway(): void {
  for (const k of ['mailway.baseUrl', 'mailway.token', 'mailway.serviceId', 'mailway.traefikToken', 'mailway.hosts']) setSetting(k, null);
  resetMailwayCaches();
  resetMailwayTraefikState();
}

beforeAll(async () => {
  initDb();
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  closeDb();
});

beforeEach(() => {
  mw.calls = [];
});

// ======================= token.js =======================

describe('herramienta token: crear y revocar tokens de API', () => {
  it('sin ningún administrador no crea nada', () => {
    const r = token(['crear', '--nombre', 'Instalador', '--caduca-min', '60']);
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err.join('\n')).toMatch(/ningún administrador/);
  });

  it('crea un token sky_ con caducidad para el primer administrador, que funciona en la API', async () => {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { email: 'admin@example.com', password: 'contraseña1' },
      headers: SAME_ORIGIN,
    });
    expect(setup.statusCode, setup.body).toBe(200);
    adminCookie = String(setup.headers['set-cookie']).split(';')[0];
    createUser('admin2@example.com', hashPassword('contraseña1'), 'admin');

    const antes = Date.now();
    const r = token(['crear', '--nombre', 'Instalador de Mailway', '--caduca-min', '60']);
    expect(r.code, r.err.join('\n')).toBe(0);
    expect(r.err).toEqual([]);
    // Una sola línea JSON con exactamente {id, token}.
    expect(r.out).toHaveLength(1);
    const res = JSON.parse(r.out[0]) as { id: string; token: string };
    expect(Object.keys(res).sort()).toEqual(['id', 'token']);
    expect(res.id).toMatch(/^tok_/);
    expect(res.token).toMatch(/^sky_[0-9a-f]{48}$/);

    const row = getApiToken(res.id)!;
    expect(row.name).toBe('Instalador de Mailway');
    expect(row.token_hash).not.toBe(res.token);
    expect(row.expires_at).toBeGreaterThanOrEqual(antes + 60 * 60_000);
    expect(row.expires_at).toBeLessThanOrEqual(Date.now() + 60 * 60_000);

    // Es del primer administrador y la API lo acepta como cualquier token de Mi perfil.
    const me = await get('/api/auth/me', bearer(res.token));
    expect(me.status).toBe(200);
    expect(JSON.stringify(me.json)).toContain('admin@example.com');
    const lista = await get('/api/tokens', bearer(res.token));
    expect(lista.status).toBe(200);
    expect(lista.json.tokens.map((t: Json) => t.id)).toContain(res.id);

    // Auditado como «sistema», sin el valor del token.
    const audit = listAudit({ action: 'token_created' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'sistema', target_type: 'token', target_id: res.id });
    expect(audit[0].detail).toContain('admin@example.com');
    expect(audit[0].detail).not.toContain(res.token);
  });

  it('con --email el token es de ese administrador; no se emite para quien no lo es', async () => {
    const r = token(['crear', '--nombre', 'Otro', '--caduca-min', '5', '--email', 'ADMIN2@example.com']);
    expect(r.code, r.err.join('\n')).toBe(0);
    const { token: t } = JSON.parse(r.out[0]) as { token: string };
    expect(JSON.stringify((await get('/api/auth/me', bearer(t))).json)).toContain('admin2@example.com');

    createUser('miembro@example.com', hashPassword('contraseña1'), 'member');
    const miembro = token(['crear', '--nombre', 'X', '--caduca-min', '5', '--email', 'miembro@example.com']);
    expect(miembro.code).toBe(1);
    expect(miembro.out).toEqual([]);
    expect(miembro.err.join('\n')).toMatch(/no es administrador/);

    const nadie = token(['crear', '--nombre', 'X', '--caduca-min', '5', '--email', 'nadie@example.com']);
    expect(nadie.code).toBe(1);
    expect(nadie.err.join('\n')).toMatch(/No existe ningún usuario/);
  });

  it('valida las opciones: caducidad obligatoria y acotada, nombre, opciones desconocidas o repetidas', () => {
    const casos: [string[], RegExp][] = [
      [['crear', '--nombre', 'X'], /caducidad en minutos/],
      [['crear', '--nombre', 'X', '--caduca-min', '0'], /entre 1 y/],
      [['crear', '--nombre', 'X', '--caduca-min', '-5'], /número entero/],
      [['crear', '--nombre', 'X', '--caduca-min', '1.5'], /número entero/],
      [['crear', '--nombre', 'X', '--caduca-min', '9999999'], /entre 1 y/],
      [['crear', '--caduca-min', '5'], /Required|requerido/i],
      [['crear', '--nombre', '   ', '--caduca-min', '5'], /Nombre requerido/],
      [['crear', '--nombre', 'x'.repeat(61), '--caduca-min', '5'], /hasta 60 caracteres/],
      [['crear', '--nombre', 'X', '--caduca-min', '5', '--rol', 'admin'], /Opción desconocida: --rol/],
      [['crear', '--nombre', 'X', '--nombre', 'Y', '--caduca-min', '5'], /repetida/],
      [['crear', 'suelto', '--nombre', 'X', '--caduca-min', '5'], /Argumento no reconocido/],
      [['crear', '--nombre'], /Falta el valor de --nombre/],
      [['crear', '--nombre', 'X', '--caduca-min', '5', '--email', 'no-es-un-correo'], /correo de --email/],
      [[], /Uso:/],
      [['borrar', '--id', 'tok_1'], /Uso:/],
    ];
    const total = listAudit({ action: 'token_created' }).length;
    for (const [argv, motivo] of casos) {
      const r = token(argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.out, argv.join(' ')).toEqual([]);
      expect(r.err.join('\n'), argv.join(' ')).toMatch(motivo);
    }
    expect(listAudit({ action: 'token_created' })).toHaveLength(total);
  });

  it('el token caduca a los N minutos', async () => {
    const r = token(['crear', '--nombre', 'Breve', '--caduca-min', '1']);
    const { token: t } = JSON.parse(r.out[0]) as { token: string };
    expect((await get('/api/auth/me', bearer(t))).status).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      expect((await get('/api/tokens', bearer(t))).status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it('un token creado desde la terminal no puede hacer lo que exige sesión de navegador', async () => {
    const { token: t } = JSON.parse(token(['crear', '--nombre', 'Sin sesión', '--caduca-min', '5']).out[0]) as { token: string };
    const nuevo = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { ...bearer(t), 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Otro más' }),
    });
    expect(nuevo.statusCode).toBe(403);
    const cfg = await app.inject({
      method: 'PUT',
      url: '/api/mailway/config',
      headers: { ...bearer(t), 'content-type': 'application/json' },
      payload: JSON.stringify({ baseUrl: MW_BASE, token: MW_TOKEN }),
    });
    expect(cfg.statusCode).toBe(403);
    expect(getSetting('mailway.token')).toBeNull();
  });

  it('revocar corta el acceso al instante, queda auditado y repetirlo no es un fallo', async () => {
    const { id, token: t } = JSON.parse(token(['crear', '--nombre', 'Temporal', '--caduca-min', '60']).out[0]) as {
      id: string;
      token: string;
    };
    expect((await get('/api/auth/me', bearer(t))).status).toBe(200);

    let r = token(['revocar', '--id', id]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out[0])).toEqual({ ok: true, revoked: true });
    expect(getApiToken(id)).toBeUndefined();
    expect((await get('/api/tokens', bearer(t))).status).toBe(401);
    const audit = listAudit({ action: 'token_deleted' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'sistema', target_type: 'token', target_id: id });

    // Ya no existe: código 0 y sin otra entrada de auditoría.
    r = token(['revocar', '--id', id]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out[0])).toEqual({ ok: true, revoked: false });
    expect(listAudit({ action: 'token_deleted' })).toHaveLength(1);

    expect(token(['revocar']).code).toBe(1);
    const malo = token(['revocar', '--id', "tok_1' OR 1=1"]);
    expect(malo.code).toBe(1);
    expect(malo.err.join('\n')).toMatch(/identificador del token no es válido/);
  });
});

// ======================= mailway.js =======================

describe('herramienta mailway: conectar con el token de la entrada estándar', () => {
  beforeAll(() => {
    const correo = createProject('Correo', 'correo', null, null);
    // El panel tiene el dominio de la URL pública: su dirección interna se
    // intenta primero y, como en desarrollo no resuelve, se usa la pública.
    panel = createService(correo.id, 'Panel', 'panel', 'git', gitCfg(['mail-panel.example.com'], 8080));
    createService(correo.id, 'Datos', 'datos', 'database', { template: 'postgres', version: '16' });
    const tienda = createProject('Tienda', 'tienda', null, null);
    createService(tienda.id, 'Web', 'web', 'git', gitCfg(['tienda.example.com']));
    // Mismo slug que el panel en otro proyecto (sin dominio: sin dirección interna), para la ambigüedad.
    const otro = createProject('Otro', 'otro', null, null);
    createService(otro.id, 'Panel', 'panel', 'git', gitCfg());
    mw.unreachable.add('skyway-correo-panel');
  });

  afterEach(() => {
    mw.role = 'admin';
  });

  it('el token jamás se acepta como argumento: ni se lee la entrada ni se llama a Mailway', async () => {
    olvidarMailway();
    const casos = [
      ['conectar', '--servicio', 'panel', '--proyecto', 'correo', '--token', MW_TOKEN],
      ['conectar', '--servicio', 'panel', '--token'],
      ['conectar', MW_TOKEN, '--servicio', 'panel', '--proyecto', 'correo'],
      [MW_TOKEN, 'conectar', '--servicio', 'panel'],
      ['conectar', '--servicio', 'panel', '--proyecto', 'correo', '--url', `${MW_BASE}/?t=${MW_TOKEN}`],
    ];
    for (const argv of casos) {
      const r = await conectar(argv, `${MW_TOKEN}\n`);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err.join('\n')).toMatch(/solo de la entrada estándar/);
      expect(r.err.join('\n')).not.toContain(MW_TOKEN);
      expect(r.out).toEqual([]);
      expect(r.leerEntrada).not.toHaveBeenCalled();
    }
    expect(mw.calls).toEqual([]);
    expect(getSetting('mailway.token')).toBeNull();
  });

  it('valida la entrada estándar sin repetirla', async () => {
    let r = await conectar(['conectar', '--servicio', 'panel', '--proyecto', 'correo'], '');
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toMatch(/No ha llegado ningún token/);
    r = await conectar(['conectar', '--servicio', 'panel', '--proyecto', 'correo'], 'sky_0123456789abcdef secreto-de-otro\n');
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toMatch(/debe empezar por «mwt_»/);
    expect(r.err.join('\n')).not.toContain('secreto-de-otro');
    r = await conectar(['conectar', '--servicio', 'panel', '--proyecto', 'correo'], `${MW_TOKEN}${'x'.repeat(5000)}`);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toMatch(/demasiado larga/);
    expect(mw.calls).toEqual([]);
    expect(getSetting('mailway.token')).toBeNull();
  });

  it('valida la orden, el servicio y el proyecto antes de leer el token', async () => {
    const casos: [string[], RegExp][] = [
      [[], /Uso:/],
      [['probar', '--servicio', 'panel'], /Uso:/],
      [['conectar'], /Indica el servicio/],
      [['conectar', '--servicio', 'no existe'], /id o un slug/],
      [['conectar', '--servicio', 'fantasma'], /No existe ningún servicio/],
      [['conectar', '--servicio', 'panel'], /Hay 2 servicios con el slug «panel» \(proyectos: correo, otro\)/],
      [['conectar', '--servicio', 'panel', '--proyecto', 'nada'], /No existe ningún proyecto/],
      [['conectar', '--servicio', 'web', '--proyecto', 'correo'], /no tiene ningún servicio/],
      [['conectar', '--servicio', 'datos', '--proyecto', 'correo'], /base de datos/],
      [['conectar', '--servicio', 'panel', '--proyecto', 'correo', '--url', ''], /no puede estar vacía/],
      [['conectar', '--servicio', 'panel', '--proyecto', 'correo', '--url', 'ftp://mail-panel.example.com'], /https:\/\/ o http:\/\//],
      [['conectar', '--servicio', 'panel', '--proyecto', 'correo', '--clave', 'x'], /Opción desconocida/],
    ];
    for (const [argv, motivo] of casos) {
      const r = await conectar(argv, `${MW_TOKEN}\n`);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.out, argv.join(' ')).toEqual([]);
      expect(r.err.join('\n'), argv.join(' ')).toMatch(motivo);
      expect(r.leerEntrada, argv.join(' ')).not.toHaveBeenCalled();
    }
    expect(mw.calls).toEqual([]);
    expect(getSetting('mailway.token')).toBeNull();
    expect(listAudit({ action: 'mailway_config_updated' })).toEqual([]);
  });

  it('si Mailway rechaza el token no se guarda nada', async () => {
    olvidarMailway();
    const r = await conectar(
      ['conectar', '--servicio', 'panel', '--proyecto', 'correo', '--url', MW_BASE],
      'mwt_ffffffff_otroSecretoCualquiera\n',
    );
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toMatch(/Mailway ha rechazado el token de gestión \(401\)/);
    expect(r.err.join('\n')).not.toContain('otroSecretoCualquiera');
    expect(getSetting('mailway.token')).toBeNull();
    expect(getSetting('mailway.baseUrl')).toBeNull();
    expect(listAudit({ action: 'mailway_config_updated' })).toEqual([]);
  });

  it('no envía el token por una URL pública que sirve otro servicio de Skyway', async () => {
    olvidarMailway();
    // Ese «panel» no tiene dominio (sin dirección interna) y la URL es la de la web de otro proyecto.
    const r = await conectar(
      ['conectar', '--servicio', 'panel', '--proyecto', 'otro', '--url', 'https://tienda.example.com'],
      `${MW_TOKEN}\n`,
    );
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toMatch(/lo sirve el servicio «Tienda \/ Web»/);
    expect(mw.calls).toEqual([]);
    expect(getSetting('mailway.token')).toBeNull();
  });

  it('prueba, guarda como Ajustes → Correo y audita como «sistema»', async () => {
    olvidarMailway();
    setSetting('mailway.traefikToken', 'token-de-traefik-anterior');
    const r = await conectar(
      ['conectar', '--servicio', panel.slug, '--proyecto', 'correo', '--url', `${MW_BASE}/`],
      `${MW_TOKEN}\n`,
    );
    expect(r.code, r.err.join('\n')).toBe(0);
    expect(r.err).toEqual([]);
    expect(r.out).toHaveLength(1);
    expect(JSON.parse(r.out[0])).toEqual({ ok: true, version: '1.0.0', brandName: 'Correo Demo' });
    expect(r.out[0]).not.toContain(MW_TOKEN);
    expect(r.leerEntrada).toHaveBeenCalledTimes(1);
    // Interna primero (no resuelve fuera de Docker) y después la pública, con el token como Bearer.
    expect(mw.calls.map((c) => c.host)).toEqual(['skyway-correo-panel:8080', 'mail-panel.example.com']);
    expect(mw.calls[1].auth).toBe(`Bearer ${MW_TOKEN}`);

    expect(getSetting('mailway.token')).toBe(MW_TOKEN);
    expect(getSetting('mailway.baseUrl')).toBe(MW_BASE);
    expect(getSetting('mailway.serviceId')).toBe(panel.id);
    // Otra conexión: el token de Traefik anterior ya no vale.
    expect(getSetting('mailway.traefikToken')).toBeNull();

    const audit = listAudit({ action: 'mailway_config_updated' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'sistema', target_type: 'system', target_id: 'mailway', ip: null });
    expect(audit[0].detail).toBe('URL del panel, token de gestión, servicio del panel');

    // El panel lo ve como si lo hubiera guardado un administrador.
    const cfg = await get('/api/mailway/config', admin());
    expect(cfg.json).toMatchObject({ configured: true, baseUrl: MW_BASE, serviceId: panel.id, hasToken: true, serviceName: 'Correo / Panel' });
    expect(JSON.stringify(cfg.json)).not.toContain(MW_TOKEN);
    // Y el puente de Traefik pide el token de Traefik vigente con la conexión nueva.
    mw.calls = [];
    const tr = await app.inject({ method: 'GET', url: '/api/traefik/mailway' });
    expect(tr.statusCode).toBe(200);
    expect(getSetting('mailway.traefikToken')).toBe(TRAEFIK_TOKEN);
    expect(mw.calls.some((c) => c.traefik === TRAEFIK_TOKEN)).toBe(true);
  });

  it('repetirlo con los mismos valores no deja otra entrada de auditoría', async () => {
    const r = await conectar(['conectar', '--servicio', panel.id, '--url', MW_BASE], MW_TOKEN);
    expect(r.code, r.err.join('\n')).toBe(0);
    expect(listAudit({ action: 'mailway_config_updated' })).toHaveLength(1);
  });

  it('sin --url conserva la URL guardada y prueba con ella', async () => {
    const r = await conectar(['conectar', '--servicio', 'panel', '--proyecto', 'correo'], `${MW_TOKEN}\n`);
    expect(r.code, r.err.join('\n')).toBe(0);
    expect(getSetting('mailway.baseUrl')).toBe(MW_BASE);
  });

  it('un token que no es de administrador se guarda con el aviso en stderr, como «Probar conexión»', async () => {
    mw.role = 'client';
    resetMailwayCaches();
    const r = await conectar(['conectar', '--servicio', 'panel', '--proyecto', 'correo', '--url', MW_BASE], `${MW_TOKEN}\n`);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out[0])).toMatchObject({ ok: true });
    expect(r.err.join('\n')).toMatch(/^Aviso: .*no es administrador de Mailway/);
  });

  it('con Mailway caído no guarda nada y explica el motivo', async () => {
    olvidarMailway();
    mw.down = true;
    try {
      const r = await conectar(['conectar', '--servicio', 'panel', '--proyecto', 'correo', '--url', MW_BASE], `${MW_TOKEN}\n`);
      expect(r.code).toBe(1);
      expect(r.err.join('\n')).toMatch(/No se ha podido conectar con Mailway/);
      expect(getSetting('mailway.token')).toBeNull();
    } finally {
      mw.down = false;
    }
  });
});

// ======================= rutas citadas =======================

describe('rutas de las herramientas en la documentación y en la interfaz', () => {
  const raiz = path.resolve(__dirname, '../..');
  const leer = (rel: string) => fs.readFileSync(path.join(raiz, rel), 'utf8');

  it('la imagen deja el servidor compilado en /app/server/dist', () => {
    const dockerfile = leer('Dockerfile');
    expect(dockerfile).toMatch(/^WORKDIR \/app$/m);
    expect(dockerfile).toMatch(/^COPY --from=build \/app\/server\/dist server\/dist$/m);
  });

  it('cada «node …tools/x.js» citado es server/dist/tools/x.js de una herramienta que existe', () => {
    const fuentes = fs.readdirSync(path.join(raiz, 'server/src/tools')).map((f) => `server/src/tools/${f}`);
    const ficheros = ['README.md', 'docs/FUNCIONALIDAD.md', 'docs/CONTROL-REMOTO.md', 'web/src/pages/Login.tsx', ...fuentes];
    let citas = 0;
    for (const rel of ficheros) {
      for (const m of leer(rel).matchAll(/node\s+(\S*tools\/([a-z-]+)\.js)/g)) {
        citas++;
        // Antes, «dist/tools/…» (sin «server/»): en la imagen esa ruta no existe.
        expect(m[1], `${rel}: ${m[0]}`).toBe(`server/dist/tools/${m[2]}.js`);
        expect(fs.existsSync(path.join(raiz, 'server/src/tools', `${m[2]}.ts`)), `${rel}: ${m[2]}`).toBe(true);
      }
    }
    expect(citas).toBeGreaterThanOrEqual(6);
  });
});
