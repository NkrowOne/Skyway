/**
 * Ajustes → Copias externas: lo que el panel lee de `<DATA_DIR>/copias/` (lo
 * escribe el host con `skyway copias`) y las peticiones que deja en
 * `copias/peticiones/`.
 *
 * - Sin instalar, con ficheros de ejemplo y con ficheros rotos o
 *   manipulados: nada de eso rompe la ruta.
 * - Permisos: todo es del administrador; la descarga del kit exige sesión de
 *   navegador, como la copia del panel.
 * - Peticiones: validación, una a la vez, nombre del fichero y contenido.
 * - Kit: descarga, nombres con `..` o enlaces simbólicos, borrado.
 * - Avisos de copias atrasadas o fallidas, sin duplicados.
 */
import fs from 'fs';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { API_TOKEN_PREFIX, hashApiToken } from '../src/auth';
import { config } from '../src/config';
import { ALERTA_COPIAS_ATRASADAS, ALERTA_COPIAS_FALLIDAS, comprobarCopiasExternas } from '../src/copiasexternas';
import {
  closeDb,
  createProject,
  createUser,
  createWorkspaceRow,
  getUserByEmail,
  initDb,
  insertApiToken,
  listAlerts,
  listAudit,
  resolveAlert,
  setUserProjects,
} from '../src/db';
import type { ProjectRow, UserRow } from '../src/types';
import { hashPassword, randomToken } from '../src/util';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const H = 3600_000;
const RUTA = '/api/system/copias-externas';
const ZIP = 'kit-20261013-033000-todo.zip';
const CONTENIDO_ZIP = Buffer.from('PK\u0003\u0004contenido cifrado del kit de pruebas');
/** Proyecto con un id bien formado que no existe en el panel. */
const PROYECTO_AJENO = 'prj_ffffffffffffffff';

let app: FastifyInstance;
let adminCookie = '';
let adminBearer: Record<string, string> = {};
let ownerA: Record<string, string> = {};
let memberA: Record<string, string> = {};
let proyecto: ProjectRow;

const admin = () => ({ cookie: adminCookie, ...SAME_ORIGIN });

function bearerFor(user: UserRow): Record<string, string> {
  const secret = `${API_TOKEN_PREFIX}${randomToken(24)}`;
  insertApiToken({ user_id: user.id, name: 'pruebas', token_hash: hashApiToken(secret), prefix: secret.slice(0, 12), expires_at: null });
  return { authorization: `Bearer ${secret}` };
}

async function call(method: 'GET' | 'POST' | 'DELETE', url: string, headers: Record<string, string>, body?: unknown) {
  const r = await app.inject({
    method,
    url,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: Json = null;
  try {
    parsed = r.json();
  } catch {
    /* sin JSON (la descarga del kit) */
  }
  return { status: r.statusCode, json: parsed, raw: r.rawPayload, headers: r.headers };
}

const carpeta = (...partes: string[]) => path.join(config.dataDir, 'copias', ...partes);
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function escribir(nombre: string, contenido: unknown): void {
  const ruta = carpeta(nombre);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, typeof contenido === 'string' || Buffer.isBuffer(contenido) ? contenido : JSON.stringify(contenido));
}

function peticiones(): string[] {
  try {
    return fs.readdirSync(carpeta('peticiones')).sort();
  } catch {
    return [];
  }
}

function estadoEjemplo(cambios: Record<string, unknown> = {}, ahora = Date.now()) {
  return {
    formato: 1,
    configuradas: true,
    destino: { endpoint: 'https://s3.cubbit.eu', bucket: 'mi-bucket', prefijo: 'skyway' },
    programacion: { activa: true, hora: '03:30', proxima: iso(ahora + 12 * H) },
    ultima: {
      id: '20261013-033000',
      inicio: iso(ahora - 6 * H),
      fin: iso(ahora - 5.8 * H),
      resultado: 'correcta',
      motivo: 'programada',
      alcance: 'todo',
      detalle: '12 elementos, 340 MB nuevos',
      avisos: ['Volumen sin regla copiado: foo'],
      elementos: 12,
      bytesNuevos: 356515840,
      duracionS: 668,
    },
    ultimaCorrecta: { id: '20261013-033000', fin: iso(ahora - 5.8 * H) },
    enCurso: null,
    ultimaComprobacion: { fecha: iso(ahora - 30 * H), resultado: 'correcta', detalle: 'Repositorio sin errores' },
    ultimaPruebaRestauracion: {
      fecha: iso(ahora - 5.7 * H),
      ejecucion: '20261013-033000',
      resultado: 'correcta',
      detalle: 'La base del panel de la copia 20261013-033000 se restaura y se abre bien (integridad: ok).',
    },
    ultimaPeticion: null,
    actualizado: iso(ahora - 5.8 * H),
    ...cambios,
  };
}

function ejecucionesEjemplo() {
  return {
    formato: 1,
    actualizado: iso(Date.now()),
    ejecuciones: [
      {
        id: '20261013-033000',
        fecha: '2026-10-13T03:30:02Z',
        motivo: 'programada',
        alcance: 'todo',
        resultado: 'correcta',
        elementos: 12,
        tamano: 1234567890,
        versiones: { skyway: '0.41.0', mailway: '1.9.0' },
        proyectos: [
          { id: proyecto.id, nombre: 'Web de Acme', slug: 'web-acme' },
          { id: PROYECTO_AJENO, nombre: 'Proyecto eliminado', slug: 'eliminado' },
          // Un slug que no es de Skyway no puede acabar en una orden para copiar en la terminal.
          { id: 'prj_0123456789abcdef', nombre: 'Malicioso', slug: 'x; rm -rf /' },
          { id: '../../etc', nombre: 'Id inválido', slug: 'otro' },
        ],
        correo: true,
      },
      // Sin id válido: se descarta sin perder las demás.
      { id: 'malo', fecha: '2026-10-12T03:30:00Z' },
      {
        id: '20261012-033000',
        fecha: '2026-10-12T03:30:01Z',
        motivo: 'panel',
        alcance: 'todo',
        resultado: 'incompleta',
        tamano: 'mucho',
        proyectos: 'no es una lista',
        correo: false,
      },
    ],
  };
}

function kitEjemplo(cambios: Record<string, unknown> = {}) {
  return {
    formato: 1,
    estado: 'listo',
    fichero: ZIP,
    tamano: CONTENIDO_ZIP.length,
    ejecucion: '20261013-033000',
    alcance: 'todo',
    creado: iso(Date.now() - H),
    caduca: iso(Date.now() + 23 * H),
    detalle: null,
    ...cambios,
  };
}

/** Copias instaladas con estado, ejecuciones y un kit listo. */
function instalar(estado: Record<string, unknown> = estadoEjemplo()): void {
  escribir('estado.json', estado);
  escribir('ejecuciones.json', ejecucionesEjemplo());
  escribir('kit.json', kitEjemplo());
  escribir(`kits/${ZIP}`, CONTENIDO_ZIP);
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
  adminBearer = bearerFor(getUserByEmail('admin@example.com')!);

  proyecto = createProject('Web de Acme', 'web-acme', null, null);
  const ws = createWorkspaceRow('Cliente');
  const projCliente = createProject('Tienda', 'tienda', null, ws.id);
  ownerA = bearerFor(createUser('owner@example.com', hashPassword('contraseña1'), 'owner', ws.id));
  const member = createUser('member@example.com', hashPassword('contraseña1'), 'member', ws.id);
  setUserProjects(member.id, [projCliente.id]);
  memberA = bearerFor(member);
});

afterAll(async () => {
  await app.close();
  closeDb();
});

beforeEach(() => {
  fs.rmSync(carpeta(), { recursive: true, force: true });
});

// ======================= lectura =======================

describe('sin copias instaladas', () => {
  it('la situación lo dice y no se admite ninguna petición', async () => {
    const r = await call('GET', RUTA, adminBearer);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      instalada: false,
      estadoIlegible: false,
      estado: null,
      ejecuciones: null,
      kit: null,
      kitDisponible: false,
      peticionesPendientes: 0,
      peticiones: [],
      ocupada: false,
    });

    const p = await call('POST', `${RUTA}/peticiones`, admin(), { accion: 'copia' });
    expect(p.status).toBe(409);
    expect(p.json.code).toBe('copias_no_instaladas');
    expect(p.json.error).toMatch(/sudo skyway copias configurar/);
    expect(peticiones()).toEqual([]);

    expect((await call('GET', `${RUTA}/kit`, admin())).status).toBe(404);
    const d = await call('DELETE', `${RUTA}/kit`, admin());
    expect(d.status).toBe(404);
    expect(d.json.code).toBe('kit_no_disponible');
  });

  it('con «configuradas: false» tampoco cuenta como instalada', async () => {
    escribir('estado.json', estadoEjemplo({ configuradas: false }));
    const r = await call('GET', RUTA, adminBearer);
    expect(r.json).toMatchObject({ instalada: false, estadoIlegible: false });
    expect((await call('POST', `${RUTA}/peticiones`, admin(), { accion: 'copia' })).json.code).toBe('copias_no_instaladas');
  });
});

describe('permisos', () => {
  it('sin sesión 401; un propietario o un miembro, 403 en todo', async () => {
    instalar();
    const rutas = [
      ['GET', RUTA],
      ['POST', `${RUTA}/peticiones`],
      ['GET', `${RUTA}/kit`],
      ['DELETE', `${RUTA}/kit`],
    ] as const;
    for (const [method, url] of rutas) {
      const body = method === 'POST' ? { accion: 'copia' } : undefined;
      expect((await call(method, url, {}, body)).status, `${method} ${url}`).toBe(401);
      for (const quien of [ownerA, memberA]) {
        expect((await call(method, url, quien, body)).status, `${method} ${url}`).toBe(403);
      }
    }
    expect(peticiones()).toEqual([]);
    expect(fs.existsSync(carpeta('kit.json'))).toBe(true);
  });

  it('el token de administrador consulta y pide, pero no descarga el kit', async () => {
    instalar();
    expect((await call('GET', RUTA, adminBearer)).status).toBe(200);
    const kit = await call('GET', `${RUTA}/kit`, adminBearer);
    expect(kit.status).toBe(403);
    expect(kit.json.error).toMatch(/sesión de navegador/);
    expect(listAudit({ action: 'copias_externas_kit_descargado' })).toEqual([]);

    const p = await call('POST', `${RUTA}/peticiones`, adminBearer, { accion: 'comprobar' });
    expect(p.status, p.raw.toString()).toBe(202);
    expect(p.json.peticion).toMatchObject({ accion: 'comprobar', solicitadoPor: 'admin@example.com' });
  });
});

describe('copias instaladas', () => {
  it('devuelve el estado, las ejecuciones válidas y el kit', async () => {
    instalar(estadoEjemplo({ enCurso: null }));
    const r = await call('GET', RUTA, admin());
    expect(r.status).toBe(200);
    const d = r.json;
    expect(d).toMatchObject({ instalada: true, estadoIlegible: false, kitDisponible: true, ocupada: false, enCurso: false });
    expect(d.estado).toMatchObject({
      formato: 1,
      destino: { endpoint: 'https://s3.cubbit.eu', bucket: 'mi-bucket', prefijo: 'skyway' },
      programacion: { activa: true, hora: '03:30' },
      ultima: { id: '20261013-033000', resultado: 'correcta', avisos: ['Volumen sin regla copiado: foo'], bytesNuevos: 356515840 },
      ultimaCorrecta: { id: '20261013-033000' },
      enCurso: null,
      ultimaPeticion: null,
    });

    // La ejecución sin id válido se descarta; las demás llegan, con lo que se pueda leer de cada una.
    expect(d.ejecuciones.map((e: Json) => e.id)).toEqual(['20261013-033000', '20261012-033000']);
    const [primera, segunda] = d.ejecuciones;
    expect(primera.versiones).toEqual({ skyway: '0.41.0', mailway: '1.9.0' });
    expect(primera.proyectos).toEqual([
      { id: proyecto.id, nombre: 'Web de Acme', slug: 'web-acme', enPanel: true },
      { id: PROYECTO_AJENO, nombre: 'Proyecto eliminado', slug: 'eliminado', enPanel: false },
      { id: 'prj_0123456789abcdef', nombre: 'Malicioso', slug: null, enPanel: false },
    ]);
    expect(segunda).toMatchObject({ resultado: 'incompleta', tamano: null, proyectos: [], correo: false, versiones: null });

    expect(d.kit).toMatchObject({ estado: 'listo', fichero: ZIP, ejecucion: '20261013-033000', alcance: 'todo' });
  });

  it('el pid del host no sale del servidor', async () => {
    instalar(estadoEjemplo({ enCurso: { accion: 'copia', inicio: iso(Date.now() - H), paso: 'Volumen skyway-web-db-data', pid: 1234 } }));
    const d = (await call('GET', RUTA, admin())).json;
    expect(d.estado.enCurso).toEqual({ accion: 'copia', inicio: expect.any(String), paso: 'Volumen skyway-web-db-data' });
    expect(d).toMatchObject({ enCurso: true, enCursoInterrumpido: false, ocupada: true });
  });

  it('un campo con un tipo inesperado queda en null sin invalidar el resto', async () => {
    instalar(
      estadoEjemplo({
        programacion: 'todas las noches',
        destino: { endpoint: 42, bucket: 'mi-bucket', prefijo: null },
        ultima: { id: '20261013-033000', resultado: 'correcta', bytesNuevos: 'mucho', avisos: [1, 'aviso', null], fin: 'ayer' },
        actualizado: 'no es una fecha',
        campoNuevoDelHost: { lo: 'que sea' },
      }),
    );
    const d = (await call('GET', RUTA, admin())).json;
    expect(d.instalada).toBe(true);
    expect(d.estado.programacion).toBeNull();
    expect(d.estado.destino).toEqual({ endpoint: null, bucket: 'mi-bucket', prefijo: null });
    expect(d.estado.ultima).toMatchObject({ id: '20261013-033000', bytesNuevos: null, avisos: ['aviso'], fin: null });
    expect(d.estado.actualizado).toBeNull();
    expect(d.estado).not.toHaveProperty('campoNuevoDelHost');
  });
});

describe('ficheros rotos o manipulados', () => {
  it('un estado.json roto no rompe nada: las copias constan como no instaladas e ilegibles', async () => {
    escribir('estado.json', '{"formato": 1, "configuradas": tr');
    const r = await call('GET', RUTA, admin());
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ instalada: false, estadoIlegible: true, estado: null });
    expect((await call('POST', `${RUTA}/peticiones`, admin(), { accion: 'copia' })).json.code).toBe('copias_no_instaladas');
  });

  it('un JSON válido sin formato, uno desmesurado o un enlace simbólico tampoco valen', async () => {
    escribir('estado.json', {});
    expect((await call('GET', RUTA, admin())).json).toMatchObject({ instalada: false, estadoIlegible: true });

    escribir('estado.json', { ...estadoEjemplo(), relleno: 'x'.repeat(1024 * 1024) });
    expect((await call('GET', RUTA, admin())).json).toMatchObject({ instalada: false, estadoIlegible: true });

    escribir('original.json', estadoEjemplo());
    fs.rmSync(carpeta('estado.json'));
    fs.symlinkSync(carpeta('original.json'), carpeta('estado.json'));
    expect((await call('GET', RUTA, admin())).json).toMatchObject({ instalada: false, estadoIlegible: true });
  });

  it('con ejecuciones.json o kit.json rotos, el resto se sigue leyendo', async () => {
    instalar();
    escribir('ejecuciones.json', '[[[');
    escribir('kit.json', '{"formato":1,"estado":"listo","fichero":');
    const d = (await call('GET', RUTA, admin())).json;
    expect(d).toMatchObject({ instalada: true, ejecuciones: null, kit: null, kitDisponible: false });
    expect(d.estado.ultima.id).toBe('20261013-033000');
    expect(d.estado.ultimaPruebaRestauracion).toMatchObject({ ejecucion: '20261013-033000', resultado: 'correcta' });
    expect((await call('GET', `${RUTA}/kit`, admin())).status).toBe(404);
  });
});

// ======================= peticiones =======================

describe('peticiones al servidor', () => {
  it('escribe la petición con el nombre y el contenido que espera el host, y la audita', async () => {
    instalar();
    const antes = Date.now();
    const r = await call('POST', `${RUTA}/peticiones`, admin(), { accion: 'copia' });
    expect(r.status, r.raw.toString()).toBe(202);

    const ficheros = peticiones();
    expect(ficheros).toHaveLength(1);
    expect(ficheros[0]).toMatch(/^[0-9]{13}-[0-9a-f]{4}\.json$/);
    const id = ficheros[0].replace(/\.json$/, '');
    expect(Number(id.slice(0, 13))).toBeGreaterThanOrEqual(antes);
    expect(r.json.peticion.id).toBe(id);

    const contenido = JSON.parse(fs.readFileSync(carpeta('peticiones', ficheros[0]), 'utf8'));
    expect(contenido).toEqual({ formato: 1, accion: 'copia', solicitadoPor: 'admin@example.com', fecha: expect.any(String) });
    expect(contenido.fecha).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    const auditoria = listAudit({ action: 'copias_externas_peticion' });
    expect(auditoria[0]).toMatchObject({ actor: 'admin@example.com', target_id: 'copias-externas' });
    expect(auditoria[0].detail).toContain(`${id}: copia`);

    // La situación la cuenta como pendiente y no admite otra.
    const d = (await call('GET', RUTA, admin())).json;
    expect(d).toMatchObject({ peticionesPendientes: 1, ocupada: true });
    expect(d.peticiones).toEqual([
      { id, accion: 'copia', alcance: null, proyecto: null, ejecucion: null, solicitadoPor: 'admin@example.com', fecha: contenido.fecha },
    ]);
    const otra = await call('POST', `${RUTA}/peticiones`, admin(), { accion: 'comprobar' });
    expect(otra.status).toBe(409);
    expect(otra.json.code).toBe('copias_ocupadas');
    expect(otra.json.error).toMatch(/petición pendiente/);
    expect(peticiones()).toEqual(ficheros);
  });

  it('con una operación en marcha está ocupada; pasadas 12 h se da por interrumpida', async () => {
    const ahora = Date.now();
    instalar(estadoEjemplo({ enCurso: { accion: 'copia', inicio: iso(ahora - 2 * H), paso: 'Volumen skyway-web-db-data' } }));
    let r = await call('POST', `${RUTA}/peticiones`, admin(), { accion: 'copia' });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: 'copias_ocupadas' });
    expect(r.json.error).toMatch(/una copia en curso/);

    instalar(estadoEjemplo({ enCurso: { accion: 'copia', inicio: iso(ahora - 13 * H), paso: 'Volumen skyway-web-db-data' } }));
    const d = (await call('GET', RUTA, admin())).json;
    expect(d).toMatchObject({ enCurso: false, enCursoInterrumpido: true, ocupada: false });
    r = await call('POST', `${RUTA}/peticiones`, admin(), { accion: 'comprobar' });
    expect(r.status, r.raw.toString()).toBe(202);
  });

  it('un kit en preparación también la ocupa, salvo que lleve más de 12 h', async () => {
    instalar();
    escribir('kit.json', kitEjemplo({ estado: 'preparando', fichero: null, creado: iso(Date.now() - H) }));
    let r = await call('POST', `${RUTA}/peticiones`, admin(), { accion: 'kit', alcance: 'todo' });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('copias_ocupadas');

    escribir('kit.json', kitEjemplo({ estado: 'preparando', fichero: null, creado: iso(Date.now() - 13 * H) }));
    expect((await call('GET', RUTA, admin())).json).toMatchObject({ kitPreparando: false, kitInterrumpido: true });
    r = await call('POST', `${RUTA}/peticiones`, admin(), { accion: 'kit', alcance: 'todo' });
    expect(r.status, r.raw.toString()).toBe(202);
  });

  it('con la copia diaria desactivada el host no atiende peticiones: se rechazan', async () => {
    instalar(estadoEjemplo({ programacion: { activa: false, hora: null, proxima: null } }));
    const r = await call('POST', `${RUTA}/peticiones`, admin(), { accion: 'copia' });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('copias_desactivadas');
    expect(r.json.error).toMatch(/sudo skyway copias activar/);
    expect(peticiones()).toEqual([]);
  });

  it('rechaza los cuerpos no válidos sin escribir nada', async () => {
    instalar();
    const auditadas = listAudit({ action: 'copias_externas_peticion' }).length;
    const malos: unknown[] = [
      {},
      { accion: 'borrar' },
      { accion: 'copia', alcance: 'todo' },
      { accion: 'comprobar', ejecucion: '20261013-033000' },
      { accion: 'kit' },
      { accion: 'kit', alcance: 'servidor' },
      { accion: 'kit', alcance: 'proyecto' },
      { accion: 'kit', alcance: 'todo', proyecto: proyecto.id },
      { accion: 'kit', alcance: 'proyecto', proyecto: '../../estado' },
      { accion: 'kit', alcance: 'proyecto', proyecto: 5 },
      { accion: 'kit', alcance: 'todo', ejecucion: '2026-10-13' },
      { accion: 'kit', alcance: 'todo', ejecucion: '20261013-033000; rm -rf /' },
      { accion: 'kit', alcance: 'todo', orden: 'rm -rf /' },
    ];
    for (const cuerpo of malos) {
      const r = await call('POST', `${RUTA}/peticiones`, admin(), cuerpo);
      expect(r.status, JSON.stringify(cuerpo)).toBe(400);
      expect(r.json.code, JSON.stringify(cuerpo)).toBe('peticion_no_valida');
      expect(r.json.error).not.toMatch(/Expected|Invalid|Required/);
    }
    expect(peticiones()).toEqual([]);
    expect(listAudit({ action: 'copias_externas_peticion' })).toHaveLength(auditadas);
  });

  it('un kit de un proyecto exige que el proyecto exista en el panel', async () => {
    instalar();
    const r = await call('POST', `${RUTA}/peticiones`, admin(), { accion: 'kit', alcance: 'proyecto', proyecto: PROYECTO_AJENO });
    expect(r.status).toBe(404);
    expect(r.json.code).toBe('proyecto_no_encontrado');
    expect(peticiones()).toEqual([]);

    const ok = await call('POST', `${RUTA}/peticiones`, admin(), {
      accion: 'kit',
      alcance: 'proyecto',
      proyecto: proyecto.id,
      ejecucion: '20261013-033000',
    });
    expect(ok.status, ok.raw.toString()).toBe(202);
    const [fichero] = peticiones();
    expect(JSON.parse(fs.readFileSync(carpeta('peticiones', fichero), 'utf8'))).toEqual({
      formato: 1,
      accion: 'kit',
      alcance: 'proyecto',
      proyecto: proyecto.id,
      ejecucion: '20261013-033000',
      solicitadoPor: 'admin@example.com',
      fecha: expect.any(String),
    });
    expect(listAudit({ action: 'copias_externas_peticion' })[0].detail).toContain(`kit · proyecto · ${proyecto.id} · ejecución 20261013-033000`);
  });

  it('un kit completo sin ejecución no lleva la clave (el host usa la última completa)', async () => {
    instalar();
    const r = await call('POST', `${RUTA}/peticiones`, admin(), { accion: 'kit', alcance: 'todo' });
    expect(r.status).toBe(202);
    const [fichero] = peticiones();
    const contenido = JSON.parse(fs.readFileSync(carpeta('peticiones', fichero), 'utf8'));
    expect(contenido).toEqual({ formato: 1, accion: 'kit', alcance: 'todo', solicitadoPor: 'admin@example.com', fecha: expect.any(String) });
    // Ni restos del temporal: el host solo debe ver peticiones completas.
    expect(peticiones()).toEqual([fichero]);
    expect(fs.readdirSync(carpeta()).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

// ======================= kit =======================

describe('kit', () => {
  it('se descarga con sesión de navegador, con su nombre, y queda auditado', async () => {
    instalar();
    const r = await call('GET', `${RUTA}/kit`, admin());
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    expect(r.headers['content-disposition']).toBe(`attachment; filename="${ZIP}"`);
    expect(Number(r.headers['content-length'])).toBe(CONTENIDO_ZIP.length);
    expect(Buffer.compare(r.raw, CONTENIDO_ZIP)).toBe(0);
    expect(listAudit({ action: 'copias_externas_kit_descargado' })[0]).toMatchObject({ actor: 'admin@example.com', detail: ZIP });
  });

  it('un nombre con ruta en kit.json nunca sale de copias/kits', async () => {
    instalar();
    const descargas = listAudit({ action: 'copias_externas_kit_descargado' }).length;
    // Un fichero que no debe poder descargarse a través del kit.
    escribir('secreto.zip', 'no es del kit');
    for (const fichero of [
      '../estado.json',
      '../secreto.zip',
      `${ZIP}/../../estado.json`,
      '/etc/passwd',
      'kit-20261013-033000-..zip',
      'kit-20261013-033000-todo.zip\u0000.txt',
      'KIT-20261013-033000-TODO.ZIP',
    ]) {
      escribir('kit.json', kitEjemplo({ fichero }));
      const d = (await call('GET', RUTA, admin())).json;
      expect(d.kit, fichero).toMatchObject({ estado: 'listo', fichero: null });
      expect(d.kitDisponible, fichero).toBe(false);
      expect((await call('GET', `${RUTA}/kit`, admin())).status, fichero).toBe(404);
    }
    expect(listAudit({ action: 'copias_externas_kit_descargado' })).toHaveLength(descargas);
  });

  it('un enlace simbólico con el nombre del kit no se sigue', async () => {
    instalar();
    fs.rmSync(carpeta('kits', ZIP));
    fs.symlinkSync(carpeta('estado.json'), carpeta('kits', ZIP));
    expect((await call('GET', RUTA, admin())).json.kitDisponible).toBe(false);
    expect((await call('GET', `${RUTA}/kit`, admin())).status).toBe(404);
  });

  it('un kit en preparación o fallido no se descarga', async () => {
    instalar();
    escribir('kit.json', kitEjemplo({ estado: 'preparando' }));
    expect((await call('GET', `${RUTA}/kit`, admin())).status).toBe(404);
    escribir('kit.json', kitEjemplo({ estado: 'fallido', detalle: 'No queda espacio en el disco' }));
    const d = (await call('GET', RUTA, admin())).json;
    expect(d).toMatchObject({ kitDisponible: false, kit: { estado: 'fallido', detalle: 'No queda espacio en el disco' } });
    expect((await call('GET', `${RUTA}/kit`, admin())).status).toBe(404);
  });

  it('se elimina (zip y kit.json) y queda auditado', async () => {
    instalar();
    const r = await call('DELETE', `${RUTA}/kit`, adminBearer);
    expect(r.status, r.raw.toString()).toBe(200);
    expect(fs.existsSync(carpeta('kits', ZIP))).toBe(false);
    expect(fs.existsSync(carpeta('kit.json'))).toBe(false);
    expect(listAudit({ action: 'copias_externas_kit_eliminado' })[0]).toMatchObject({ actor: expect.stringContaining('admin@example.com'), detail: ZIP });

    expect((await call('DELETE', `${RUTA}/kit`, admin())).status).toBe(404);
    expect((await call('GET', `${RUTA}/kit`, admin())).status).toBe(404);
    expect((await call('GET', RUTA, admin())).json).toMatchObject({ kit: null, kitDisponible: false });
  });

  it('con un nombre manipulado se retira kit.json y nada más', async () => {
    instalar();
    escribir('kit.json', kitEjemplo({ fichero: '../estado.json' }));
    expect((await call('DELETE', `${RUTA}/kit`, admin())).status).toBe(200);
    expect(fs.existsSync(carpeta('kit.json'))).toBe(false);
    expect(fs.existsSync(carpeta('estado.json'))).toBe(true);

    // Un kit.json ilegible también se puede retirar.
    escribir('kit.json', '{roto');
    expect((await call('DELETE', `${RUTA}/kit`, admin())).status).toBe(200);
    expect(fs.existsSync(carpeta('kit.json'))).toBe(false);
  });

  it('no se elimina mientras se prepara, salvo que lleve más de 12 h', async () => {
    instalar();
    escribir('kit.json', kitEjemplo({ estado: 'preparando', creado: iso(Date.now() - H) }));
    const r = await call('DELETE', `${RUTA}/kit`, admin());
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('kit_en_preparacion');
    expect(fs.existsSync(carpeta('kit.json'))).toBe(true);

    escribir('kit.json', kitEjemplo({ estado: 'preparando', creado: iso(Date.now() - 13 * H) }));
    expect((await call('DELETE', `${RUTA}/kit`, admin())).status).toBe(200);
  });
});

// ======================= avisos =======================

describe('avisos de copias atrasadas o fallidas', () => {
  const abiertas = (tipo: string) => listAlerts({ openOnly: true, limit: 200 }).filter((a) => a.type === tipo);
  const todas = (tipo: string) => listAlerts({ limit: 200 }).filter((a) => a.type === tipo);
  const t0 = Date.parse('2026-10-13T12:00:00Z');

  /** Estado con la última copia correcta terminada `horas` antes de `t0`. */
  function conUltimaCorrecta(id: string, horas: number, cambios: Record<string, unknown> = {}) {
    const fin = iso(t0 - horas * H);
    return estadoEjemplo(
      {
        ultima: { id, inicio: fin, fin, resultado: 'correcta', motivo: 'programada' },
        ultimaCorrecta: { id, fin },
        ...cambios,
      },
      t0,
    );
  }

  it('sin copias instaladas no avisa de nada', () => {
    comprobarCopiasExternas(new Date(t0));
    escribir('estado.json', '{roto');
    comprobarCopiasExternas(new Date(t0));
    expect(todas(ALERTA_COPIAS_ATRASADAS)).toEqual([]);
    expect(todas(ALERTA_COPIAS_FALLIDAS)).toEqual([]);
  });

  it('avisa una vez cuando la última correcta tiene más de 26 h, y se resuelve con una copia nueva', () => {
    escribir('estado.json', conUltimaCorrecta('20261012-033000', 10));
    comprobarCopiasExternas(new Date(t0));
    expect(todas(ALERTA_COPIAS_ATRASADAS)).toEqual([]);

    escribir('estado.json', conUltimaCorrecta('20261012-033000', 30));
    for (let i = 0; i < 3; i++) comprobarCopiasExternas(new Date(t0 + i * 600_000));
    expect(todas(ALERTA_COPIAS_ATRASADAS)).toHaveLength(1);
    const [alerta] = abiertas(ALERTA_COPIAS_ATRASADAS);
    expect(alerta).toMatchObject({ severity: 'warning', title: 'Copias externas atrasadas', project_id: null, service_id: null });
    expect(alerta.message).toContain('12/10/2026 a las 06:00 UTC');

    // Un estado.json que un momento no se puede leer no retira el aviso ni lo duplica después.
    escribir('estado.json', '{roto');
    comprobarCopiasExternas(new Date(t0 + H));
    expect(abiertas(ALERTA_COPIAS_ATRASADAS)).toHaveLength(1);
    escribir('estado.json', conUltimaCorrecta('20261012-033000', 30));
    comprobarCopiasExternas(new Date(t0 + H));
    expect(todas(ALERTA_COPIAS_ATRASADAS)).toHaveLength(1);

    // Resuelta a mano mientras nada cambia: no vuelve a aparecer en la vuelta siguiente.
    resolveAlert(alerta.id);
    comprobarCopiasExternas(new Date(t0 + H));
    expect(abiertas(ALERTA_COPIAS_ATRASADAS)).toEqual([]);
    expect(todas(ALERTA_COPIAS_ATRASADAS)).toHaveLength(1);

    // Una copia correcta nueva: al día.
    escribir('estado.json', conUltimaCorrecta('20261013-033000', 1));
    comprobarCopiasExternas(new Date(t0));
    expect(abiertas(ALERTA_COPIAS_ATRASADAS)).toEqual([]);

    // Si esa también se queda vieja, es otro aviso; con una copia en marcha se espera a que termine.
    const despues = new Date(t0 + 30 * H);
    escribir(
      'estado.json',
      conUltimaCorrecta('20261013-033000', 1, { enCurso: { accion: 'copia', inicio: iso(t0 + 29 * H), paso: 'Subida' } }),
    );
    comprobarCopiasExternas(despues);
    expect(abiertas(ALERTA_COPIAS_ATRASADAS)).toEqual([]);
    escribir('estado.json', conUltimaCorrecta('20261013-033000', 1));
    comprobarCopiasExternas(despues);
    comprobarCopiasExternas(despues);
    expect(abiertas(ALERTA_COPIAS_ATRASADAS)).toHaveLength(1);
    expect(todas(ALERTA_COPIAS_ATRASADAS)).toHaveLength(2);

    // Copia diaria desactivada: el aviso de atraso deja de aplicar.
    escribir('estado.json', conUltimaCorrecta('20261013-033000', 1, { programacion: { activa: false } }));
    comprobarCopiasExternas(despues);
    expect(abiertas(ALERTA_COPIAS_ATRASADAS)).toEqual([]);
  });

  it('sin ninguna copia correcta cuenta desde que el panel ve activa la copia diaria', () => {
    escribir('estado.json', estadoEjemplo({ ultima: null, ultimaCorrecta: null }, t0));
    const antes = todas(ALERTA_COPIAS_ATRASADAS).length;
    comprobarCopiasExternas(new Date(t0));
    comprobarCopiasExternas(new Date(t0 + 20 * H));
    expect(todas(ALERTA_COPIAS_ATRASADAS)).toHaveLength(antes);
    comprobarCopiasExternas(new Date(t0 + 27 * H));
    comprobarCopiasExternas(new Date(t0 + 28 * H));
    expect(todas(ALERTA_COPIAS_ATRASADAS)).toHaveLength(antes + 1);
    const [aviso] = abiertas(ALERTA_COPIAS_ATRASADAS);
    expect(abiertas(ALERTA_COPIAS_ATRASADAS)).toHaveLength(1);
    expect(aviso.message).toMatch(/No consta ninguna copia externa correcta/);

    escribir('estado.json', conUltimaCorrecta('20261014-033000', -26));
    comprobarCopiasExternas(new Date(t0 + 28 * H));
    expect(abiertas(ALERTA_COPIAS_ATRASADAS)).toEqual([]);
  });

  it('avisa una vez por cada copia fallida y se resuelve con una correcta', () => {
    const fallida = (id: string) =>
      estadoEjemplo(
        { ultima: { id, inicio: iso(t0 - H), fin: iso(t0), resultado: 'fallida', motivo: 'programada', detalle: 'El bucket no responde' } },
        t0,
      );
    escribir('estado.json', fallida('20261013-033000'));
    comprobarCopiasExternas(new Date(t0));
    comprobarCopiasExternas(new Date(t0));
    expect(todas(ALERTA_COPIAS_FALLIDAS)).toHaveLength(1);
    const [primera] = abiertas(ALERTA_COPIAS_FALLIDAS);
    expect(primera.title).toBe('Copia externa fallida');
    expect(primera.message).toBe('La copia externa 20261013-033000 (programada) ha fallado: El bucket no responde');
    expect(primera.explanation).toContain('sudo skyway copias ver 20261013-033000');

    // Resuelta a mano: la misma ejecución no vuelve a avisar.
    resolveAlert(primera.id);
    comprobarCopiasExternas(new Date(t0));
    expect(todas(ALERTA_COPIAS_FALLIDAS)).toHaveLength(1);

    // Otra fallida: un aviso nuevo, que sustituye al anterior.
    escribir('estado.json', fallida('20261014-033000'));
    comprobarCopiasExternas(new Date(t0));
    comprobarCopiasExternas(new Date(t0));
    expect(todas(ALERTA_COPIAS_FALLIDAS)).toHaveLength(2);
    expect(abiertas(ALERTA_COPIAS_FALLIDAS).map((a) => a.message)).toEqual([
      'La copia externa 20261014-033000 (programada) ha fallado: El bucket no responde',
    ]);

    // Una correcta después: el aviso se resuelve.
    escribir('estado.json', conUltimaCorrecta('20261015-033000', 1));
    comprobarCopiasExternas(new Date(t0));
    expect(abiertas(ALERTA_COPIAS_FALLIDAS)).toEqual([]);
    expect(todas(ALERTA_COPIAS_FALLIDAS)).toHaveLength(2);
  });
});
