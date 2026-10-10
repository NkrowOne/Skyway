/**
 * Parada limpia, identidad por copia y restos de intercambios.
 *
 *  - Cada copia que se para (la versión anterior, «--next», la réplica que
 *    falla, los restos, Detener) recibe el comando al parar, SIGTERM y la
 *    gracia del servicio antes del SIGKILL. Antes «--next», la réplica nueva
 *    que fallaba y los restos se retiraban con `remove --force` (SIGKILL
 *    directo) y la gracia era fija (10 s).
 *  - Todas las copias de un despliegue compartían `RAILWAY_REPLICA_ID` (el id
 *    del despliegue): dos réplicas no podían distinguirse ni repartirse el
 *    trabajo, ni la copia de validación de la que sirve.
 *  - Los restos «--next»/«--prev» de un intercambio cortado solo se limpiaban
 *    en el despliegue siguiente: un bot podía seguir con dos copias vivas, y
 *    Detener no los alcanzaba.
 *
 * Sin Docker: las funciones de `docker/containers.ts` se prueban contra un
 * cliente de Docker simulado; el desplegador y las rutas, contra un doble en
 * memoria de los contenedores que anota cada operación. La parada del doble
 * tarda y anota `parada:<nombre>` al terminar, para comprobar que se espera.
 */
import { Readable } from 'stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import {
  closeDb,
  createDeployment,
  createProject,
  createService,
  createUser,
  createWorkspaceRow,
  listAudit,
  getDeployment,
  getService,
  initDb,
  listDeployments,
  markStaleDeploymentsFailed,
  servicesWithPendingChanges,
  setEnv,
  setServiceStopped,
  updateDeployment,
} from '../src/db';
import {
  awaitDeployment,
  conIdentidad,
  limpiarIntercambiosAlArrancar,
  limpiarRestosIntercambio,
  resumeInterruptedDeployments,
  triggerDeploy,
} from '../src/deploy/deployer';
import { GRACIA_VALIDACION_MAXIMA } from '../src/deploy/estrategia';
import { readRailwayRepoConfig, hasRailwayConfig } from '../src/deploy/railwayconfig';
import type { RunSpec } from '../src/docker/containers';
import { hashPassword } from '../src/util';

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const m = vi.hoisted(() => ({
  eventos: [] as string[],
  /** `deployment`: la etiqueta `skyway.deployment` del contenedor. */
  contenedores: new Map<string, { running: boolean; serviceId: string; deployment?: string }>(),
  /** Spec con la que se creó cada contenedor (el último con ese nombre). */
  specs: new Map<string, any>(),
  /** Opciones con las que se paró cada copia. */
  paradas: new Map<string, { graciaSegundos: number; comando?: string | null; salidaComando?: boolean }>(),
  /** Cuánto tarda en pararse cada copia (ms); por defecto, 20. */
  espera: new Map<string, number>(),
  /** Copias que «terminan con SIGKILL» al pararlas. */
  forzadas: new Set<string>(),
}));

/** Cliente de Docker simulado para las funciones reales de `docker/containers.ts`. */
const d = vi.hoisted(() => ({
  creados: [] as any[],
  ordenes: [] as string[],
  execs: [] as { Cmd: string[]; Env?: string[] }[],
  estado: new Map<string, { running: boolean; exitCode: number; oom: boolean }>(),
  /** Cómo termina cada contenedor al pararlo y cuánto tarda (ms). */
  salida: new Map<string, { exitCode: number; oom?: boolean; tardaMs?: number }>(),
  salidaExec: 'línea 1\nadiós\n',
  codigoExec: 0 as number | null,
  lista: [] as { Names: string[]; Labels: Record<string, string> }[],
  /** Contenedores cuya consulta (`inspect`) falla con un error que no es 404. */
  fallaConsulta: new Set<string>(),
  /** Código con que falla `stop` en cada contenedor. */
  fallaStop: new Map<string, number>(),
}));

vi.mock('../src/docker/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/docker/client')>();
  const contenedor = (name: string) => ({
    inspect: async () => {
      if (d.fallaConsulta.has(name)) throw Object.assign(new Error('tiempo de espera agotado'), { statusCode: undefined });
      const st = d.estado.get(name);
      if (!st) throw Object.assign(new Error('no existe'), { statusCode: 404 });
      return { Config: { Labels: {} }, State: { Running: st.running, ExitCode: st.exitCode, OOMKilled: st.oom } };
    },
    stop: async (opts: { t: number }) => {
      d.ordenes.push(`stop:${name}:t=${opts.t}`);
      const codigo = d.fallaStop.get(name);
      if (codigo) throw Object.assign(new Error(`stop ${codigo}`), { statusCode: codigo });
      const st = d.estado.get(name);
      if (!st) throw Object.assign(new Error('no existe'), { statusCode: 404 });
      const fin = d.salida.get(name) ?? { exitCode: 0 };
      if (fin.tardaMs) await new Promise((r) => setTimeout(r, fin.tardaMs));
      d.estado.set(name, { running: false, exitCode: fin.exitCode, oom: !!fin.oom });
    },
    restart: async (opts: { t: number }) => {
      d.ordenes.push(`restart:${name}:t=${opts.t}`);
    },
    remove: async () => {
      d.ordenes.push(`remove:${name}`);
      d.estado.delete(name);
    },
    exec: async (opts: { Cmd: string[]; Env?: string[] }) => {
      d.ordenes.push(`exec:${name}`);
      d.execs.push(opts);
      return {
        start: async () => Readable.from([Buffer.from(d.salidaExec)]),
        inspect: async () => ({ ExitCode: d.codigoExec, Running: false }),
      };
    },
  });
  const consultas = Object.create(mod.dockerQuery);
  consultas.getContainer = (name: string) => contenedor(name);
  consultas.listContainers = async () => d.lista;
  return {
    ...mod,
    dockerAvailable: vi.fn(async () => true),
    dockerQuery: consultas,
    docker: {
      createContainer: vi.fn(async (opts: any) => {
        d.creados.push(opts);
        return { id: `id-${opts.name}`, start: async () => undefined };
      }),
      getContainer: vi.fn((name: string) => contenedor(name)),
      // Copia lo que llega por el stream del exec a la salida estándar.
      modem: { demuxStream: (stream: NodeJS.ReadableStream, out: NodeJS.WritableStream) => stream.on('data', (c) => out.write(c)) },
    },
  };
});
vi.mock('../src/docker/networks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/docker/networks')>()),
  ensureNetwork: vi.fn(async () => undefined),
}));
vi.mock('../src/docker/containers', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/docker/containers')>();
  return {
    ...mod,
    findContainer: vi.fn(async (name: string) => {
      const c = m.contenedores.get(name);
      return c ? { Config: { Labels: { 'skyway.deployment': c.deployment ?? 'dep-anterior' } }, State: { Running: c.running } } : null;
    }),
    listServiceContainers: vi.fn(async (serviceId: string) =>
      [...m.contenedores].filter(([, c]) => c.serviceId === serviceId).map(([name]) => ({ id: `id-${name}`, name })),
    ),
    runServiceContainer: vi.fn(async (spec: RunSpec) => {
      const name = spec.nameOverride ?? mod.containerName(spec.project, spec.service);
      m.eventos.push(`crear:${name}`);
      m.contenedores.set(name, { running: true, serviceId: spec.service.id });
      m.specs.set(name, spec);
      return `id-${name}`;
    }),
    renameContainer: vi.fn(async (from: string, to: string) => {
      m.eventos.push(`renombrar:${from}>${to}`);
      const c = m.contenedores.get(from)!;
      m.contenedores.delete(from);
      m.contenedores.set(to, c);
    }),
    removeContainer: vi.fn(async (name: string) => {
      m.eventos.push(`borrar:${name}`);
      m.contenedores.delete(name);
    }),
    pararConGracia: vi.fn(
      async (name: string, opts: { graciaSegundos: number; comando?: string | null; salidaComando?: boolean }) => {
        const c = m.contenedores.get(name);
        if (!c) return { existia: false, forzada: false, comando: null };
        m.eventos.push(`parar:${name}(t=${opts.graciaSegundos})`);
        m.paradas.set(name, { graciaSegundos: opts.graciaSegundos, comando: opts.comando, salidaComando: opts.salidaComando });
        await new Promise((r) => setTimeout(r, m.espera.get(name) ?? 20));
        c.running = false;
        m.eventos.push(`parada:${name}`);
        return { existia: true, forzada: m.forzadas.has(name), comando: opts.comando ? 'ok' : null };
      },
    ),
    startContainer: vi.fn(async (name: string) => {
      m.eventos.push(`arrancar:${name}`);
      const c = m.contenedores.get(name);
      if (c) c.running = true;
    }),
    getRuntime: vi.fn(async (name: string) => {
      const c = m.contenedores.get(name);
      if (!c) return { state: 'not_created', startedAt: null, exitCode: null, restartCount: 0, image: null };
      return c.running
        ? { state: 'running', startedAt: new Date().toISOString(), exitCode: null, restartCount: 0, image: 'x' }
        : { state: 'exited', startedAt: null, exitCode: 0, restartCount: 0, image: 'x' };
    }),
    execInContainer: vi.fn(async () => ({ output: '', exitCode: 0, truncated: false, timedOut: false, durationMs: 1 })),
    imageExists: vi.fn(async () => true),
    imageExposedPorts: vi.fn(async () => []),
    imageDeclaredVolumes: vi.fn(async () => []),
    imageHealthcheckWindowMs: vi.fn(async () => null),
    containerHealth: vi.fn(async () => ({ state: 'running', exitCode: null, health: 'healthy' as const })),
    fetchLogsText: vi.fn(async (name: string) => {
      m.eventos.push(`archivar:${name}`);
      return '';
    }),
  };
});

/** Las funciones REALES de `docker/containers.ts`, contra el cliente simulado. */
const real = () => vi.importActual<typeof import('../src/docker/containers')>('../src/docker/containers');

let app: FastifyInstance;
let cookie = '';

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
});

afterAll(async () => {
  await app.close();
  closeDb();
});

beforeEach(() => {
  m.eventos.length = 0;
  m.contenedores.clear();
  m.specs.clear();
  m.paradas.clear();
  m.forzadas.clear();
  m.espera.clear();
  d.fallaConsulta.clear();
  d.fallaStop.clear();
  d.creados.length = 0;
  d.ordenes.length = 0;
  d.execs.length = 0;
  d.estado.clear();
  d.salida.clear();
  d.salidaExec = 'línea 1\nadiós\n';
  d.codigoExec = 0;
  d.lista = [];
});

function proyecto() {
  return createProject('Bots', `bots-${Math.random().toString(36).slice(2, 8)}`);
}

/** Bot de imagen sin puerto ni dominio, con `copias` réplicas ya en marcha. */
function bot(cfg: Record<string, unknown> = {}, copias = 1, p = proyecto()) {
  const s = createService(p.id, 'bot', 'bot', 'image', { image: 'busybox:stable', domains: [], ...cfg } as any);
  const base = `skyway-${p.slug}-bot`;
  for (let i = 1; i <= copias; i++) m.contenedores.set(i === 1 ? base : `${base}-r${i}`, { running: true, serviceId: s.id });
  return { p, s, base };
}

async function desplegar(serviceId: string) {
  const dep = triggerDeploy(serviceId, 'manual');
  const fin = await awaitDeployment(dep.id, 60_000);
  return getDeployment(fin!.id)!;
}

const idx = (evento: string) => m.eventos.indexOf(evento);

describe('docker/containers.ts: parada limpia', () => {
  it('runServiceContainer fija la gracia como StopTimeout y etiqueta la identidad de la copia', async () => {
    const { runServiceContainer } = await real();
    const p = proyecto();
    const s = createService(p.id, 'bot', 'bot', 'image', { image: 'busybox:stable', domains: [] } as any);
    await runServiceContainer({
      project: p,
      service: s,
      image: 'busybox:stable',
      env: {},
      deploymentId: 'dep-1',
      internalPort: null,
      domains: [],
      stopGraceSeconds: 45,
      identidad: { instancia: 'inst-1', replica: 2 },
    });
    const opts = d.creados.at(-1);
    expect(opts.StopTimeout).toBe(45);
    expect(opts.Labels['skyway.instance']).toBe('inst-1');
    expect(opts.Labels['skyway.replica']).toBe('2');
  });

  it('pararConGracia: con comando, lo ejecuta dentro (variable SKYWAY_STOP_CMD, orden fija) antes del stop con la gracia', async () => {
    const { pararConGracia } = await real();
    d.estado.set('c1', { running: true, exitCode: 0, oom: false });
    const log: string[] = [];
    const r = await pararConGracia('c1', { graciaSegundos: 30, comando: 'curl -X POST "$URL/baja"; echo adiós', log: (l) => log.push(l) });
    expect(r).toEqual({ existia: true, forzada: false, comando: 'ok' });
    expect(d.execs[0].Cmd).toEqual(['sh', '-c', 'eval "$SKYWAY_STOP_CMD"']);
    expect(d.execs[0].Env).toEqual(['SKYWAY_STOP_CMD=curl -X POST "$URL/baja"; echo adiós']);
    expect(d.ordenes.indexOf('exec:c1')).toBeLessThan(d.ordenes.indexOf('stop:c1:t=30'));
    // El código y la salida del comando quedan en el registro.
    expect(log.join('\n')).toMatch(/Comando al parar de c1 ejecutado \(código 0\)/);
    expect(log).toContain('  adiós');
  });

  it('pararConGracia: un comando que falla no impide la parada', async () => {
    const { pararConGracia } = await real();
    d.estado.set('c1', { running: true, exitCode: 0, oom: false });
    d.codigoExec = 127;
    d.salidaExec = 'sh: curl: not found\n';
    const log: string[] = [];
    const r = await pararConGracia('c1', { graciaSegundos: 5, comando: 'curl x', log: (l) => log.push(l) });
    expect(r.comando).toBe('fallo');
    expect(d.ordenes).toContain('stop:c1:t=5');
    expect(log.join('\n')).toMatch(/terminó con el código 127: se continúa con SIGTERM/);
  });

  it('pararConGracia: sin comando, o con la copia ya parada, no hay exec', async () => {
    const { pararConGracia } = await real();
    d.estado.set('c1', { running: true, exitCode: 0, oom: false });
    d.estado.set('c2', { running: false, exitCode: 0, oom: false });
    await pararConGracia('c1', { graciaSegundos: 30 });
    await pararConGracia('c2', { graciaSegundos: 30, comando: 'echo hola' });
    expect(d.execs).toHaveLength(0);
    expect(d.ordenes).toEqual(['stop:c1:t=30', 'stop:c2:t=30']);
  });

  it('pararConGracia: un contenedor que no existe no lanza', async () => {
    const { pararConGracia } = await real();
    await expect(pararConGracia('no-existe', { graciaSegundos: 30, comando: 'x' })).resolves.toEqual({
      existia: false,
      forzada: false,
      comando: null,
    });
    expect(d.ordenes).toEqual([]);
  });

  it('pararConGracia: 137 sin OOM tras agotar la gracia es una parada forzada, y se avisa', async () => {
    const { pararConGracia } = await real();
    d.estado.set('sordo', { running: true, exitCode: 0, oom: false });
    d.salida.set('sordo', { exitCode: 137, tardaMs: 950 });
    const log: string[] = [];
    const r = await pararConGracia('sordo', { graciaSegundos: 1, log: (l) => log.push(l) });
    expect(r.forzada).toBe(true);
    expect(log.join('\n')).toMatch(
      /⚠ sordo no terminó con SIGTERM en 1 s y se detuvo con SIGKILL\. Si la aplicación es el proceso principal del contenedor, tiene que atender SIGTERM \(cerrar y salir\): sin un manejador, el sistema descarta la señal\. Si el comando de arranque es una sola orden, empiézalo con «exec»\. Aumenta la gracia de parada en Ajustes del servicio solo si el proceso ya atiende SIGTERM/,
    );
  });

  it('pararConGracia: si no se puede consultar el contenedor (no es un 404), lo para igualmente y sin el comando', async () => {
    const { pararConGracia } = await real();
    d.estado.set('lento', { running: true, exitCode: 0, oom: false });
    d.fallaConsulta.add('lento');
    const log: string[] = [];
    const r = await pararConGracia('lento', { graciaSegundos: 30, comando: 'echo adiós', log: (l) => log.push(l) });
    expect(r.existia).toBe(true);
    expect(d.ordenes).toEqual(['stop:lento:t=30']);
    expect(d.execs).toHaveLength(0);
    expect(log.join('\n')).toMatch(/No se pudo consultar el estado de lento \(tiempo de espera agotado\): se detiene igualmente/);
  });

  it('pararConGracia: un fallo de la parada se propaga; un 404 en la parada es «no existe»', async () => {
    const { pararConGracia } = await real();
    d.estado.set('roto', { running: true, exitCode: 0, oom: false });
    d.fallaStop.set('roto', 500);
    await expect(pararConGracia('roto', { graciaSegundos: 5 })).rejects.toThrow(/stop 500/);
    d.estado.set('ido', { running: true, exitCode: 0, oom: false });
    d.fallaStop.set('ido', 404);
    await expect(pararConGracia('ido', { graciaSegundos: 5 })).resolves.toMatchObject({ existia: false });
  });

  it('ejecutarComandoParada con salida: false registra el código pero no lo que escribe', async () => {
    const { pararConGracia } = await real();
    d.estado.set('c1', { running: true, exitCode: 0, oom: false });
    d.salidaExec = 'TOKEN=secreto\n';
    const log: string[] = [];
    await pararConGracia('c1', { graciaSegundos: 5, comando: 'env', log: (l) => log.push(l), salidaComando: false });
    expect(log.join('\n')).toMatch(/Comando al parar de c1 ejecutado \(código 0\)/);
    expect(log.join('\n')).not.toMatch(/secreto/);
  });

  it('ejecutarComandoParada en una imagen sin «sh»: lo dice claro y la parada sigue', async () => {
    const { pararConGracia } = await real();
    d.estado.set('sinsh', { running: true, exitCode: 0, oom: false });
    // Lo que devuelve Docker 29 con una imagen sin /bin/sh (visto en la prueba
    // real de scripts/prueba-real-bots.mjs): código 127 y el error del runtime.
    d.salidaExec = 'OCI runtime exec failed: exec failed: unable to start container process: exec: "sh": executable file not found in $PATH\r\n';
    d.codigoExec = 127;
    const log: string[] = [];
    const r = await pararConGracia('sinsh', { graciaSegundos: 5, comando: 'echo hola', log: (l) => log.push(l) });
    expect(r).toMatchObject({ existia: true, comando: 'fallo' });
    expect(log.join('\n')).toMatch(/La imagen de sinsh no incluye «sh»: el comando al parar no se puede ejecutar/);
    expect(log.join('\n')).not.toMatch(/OCI runtime|código 127/);
    expect(d.ordenes).toContain('stop:sinsh:t=5');
    // Un 127 del propio comando (una orden que no existe dentro del shell) sigue
    // contándose como siempre, con su salida.
    d.estado.set('consh', { running: true, exitCode: 0, oom: false });
    d.salidaExec = 'sh: vaciar-cola: not found\n';
    const log2: string[] = [];
    await pararConGracia('consh', { graciaSegundos: 5, comando: 'vaciar-cola', log: (l) => log2.push(l) });
    expect(log2.join('\n')).toMatch(/terminó con el código 127: se continúa con SIGTERM/);
    expect(log2.join('\n')).toMatch(/vaciar-cola: not found/);
  });

  it('pararConGracia: 137 por falta de memoria, o inmediato, no es una parada forzada', async () => {
    const { pararConGracia } = await real();
    d.estado.set('oom', { running: true, exitCode: 0, oom: false });
    d.salida.set('oom', { exitCode: 137, oom: true, tardaMs: 950 });
    d.estado.set('rapido', { running: true, exitCode: 0, oom: false });
    d.salida.set('rapido', { exitCode: 137 });
    const log: string[] = [];
    expect((await pararConGracia('oom', { graciaSegundos: 1, log: (l) => log.push(l) })).forzada).toBe(false);
    expect((await pararConGracia('rapido', { graciaSegundos: 30, log: (l) => log.push(l) })).forzada).toBe(false);
    expect(log.join('\n')).not.toMatch(/SIGKILL/);
  });

  it('stopContainer y restartContainer llevan la gracia que se les pide', async () => {
    const { stopContainer, restartContainer } = await real();
    d.estado.set('c1', { running: true, exitCode: 0, oom: false });
    await stopContainer('c1', 45);
    await restartContainer('c1', 12);
    await stopContainer('c1');
    expect(d.ordenes).toEqual(['stop:c1:t=45', 'restart:c1:t=12', 'stop:c1:t=10']);
  });
});

describe('gracia de parada y comando al parar en el despliegue', () => {
  it('por defecto, 30 s', async () => {
    const { s, base } = bot();
    const dep = await desplegar(s.id);
    expect(dep.status, dep.error ?? '').toBe('success');
    expect(m.paradas.get(`${base}--prev`)?.graciaSegundos).toBe(30);
    expect(m.specs.get(base).stopGraceSeconds).toBe(30);
  });

  it('la del servicio manda; si no hay, RAILWAY_DEPLOYMENT_DRAINING_SECONDS', async () => {
    const propio = bot({ stopGraceSeconds: 12 });
    setEnv(propio.s.id, { RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '45' });
    const dep1 = await desplegar(propio.s.id);
    expect(dep1.status, dep1.error ?? '').toBe('success');
    expect(m.paradas.get(`${propio.base}--prev`)?.graciaSegundos).toBe(12);
    expect(m.specs.get(propio.base).stopGraceSeconds).toBe(12);

    const railway = bot();
    setEnv(railway.s.id, { RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '45' });
    const dep2 = await desplegar(railway.s.id);
    expect(dep2.status, dep2.error ?? '').toBe('success');
    expect(m.paradas.get(`${railway.base}--prev`)?.graciaSegundos).toBe(45);
    expect(m.specs.get(railway.base).stopGraceSeconds).toBe(45);
    expect(dep2.logs).toMatch(/Parada: SIGTERM y 45 s de gracia \(RAILWAY_DEPLOYMENT_DRAINING_SECONDS\)\./);
  }, 40_000);

  it('el comando al parar llega a cada parada y se anuncia en el registro', async () => {
    const { s, base } = bot({ stopCommand: 'kill -USR1 1' });
    const dep = await desplegar(s.id);
    expect(dep.status, dep.error ?? '').toBe('success');
    expect(m.paradas.get(`${base}--prev`)?.comando).toBe('kill -USR1 1');
    expect(dep.logs).toMatch(/Parada: comando al parar, SIGTERM y 30 s de gracia\./);
  });

  it('RAILWAY_DEPLOYMENT_OVERLAP_SECONDS no se aplica, pero se dice', async () => {
    const { s } = bot();
    setEnv(s.id, { RAILWAY_DEPLOYMENT_OVERLAP_SECONDS: '0' });
    const dep = await desplegar(s.id);
    expect(dep.status, dep.error ?? '').toBe('success');
    expect(dep.logs).toMatch(/ℹ Skyway no aplica RAILWAY_DEPLOYMENT_OVERLAP_SECONDS: .*Ajustes del servicio → Despliegue y parada\./);
    expect(dep.logs).toMatch(/Estrategia: una sola copia/);
  });
});

describe('identidad por copia', () => {
  it('conIdentidad devuelve una copia y no toca el entorno de partida', () => {
    const env = { A: '1', SKYWAY_VALIDATION: 'x' };
    const a = conIdentidad(env, { replica: 2, total: 3 });
    expect(env).toEqual({ A: '1', SKYWAY_VALIDATION: 'x' });
    expect(a.env).toMatchObject({ A: '1', SKYWAY_REPLICA: '2', SKYWAY_REPLICAS: '3', SKYWAY_INSTANCE_ID: a.instancia, RAILWAY_REPLICA_ID: a.instancia });
    expect(a.env.SKYWAY_VALIDATION).toBeUndefined();
    expect(a.instancia).toMatch(UUID);
    expect(conIdentidad(env, { replica: 1, total: 1, validacion: true }).env.SKYWAY_VALIDATION).toBe('1');
    expect(conIdentidad({ RAILWAY_REPLICA_ID: 'mio' }, { replica: 1, total: 1 }).env.RAILWAY_REPLICA_ID).toBe('mio');
  });

  it('cada réplica y cada despliegue tienen su instancia; índice y total en el entorno', async () => {
    const { s, base } = bot({ replicas: 2 }, 2);
    const dep1 = await desplegar(s.id);
    expect(dep1.status, dep1.error ?? '').toBe('success');
    const r1 = m.specs.get(base);
    const r2 = m.specs.get(`${base}-r2`);
    expect(r1.env.SKYWAY_INSTANCE_ID).toMatch(UUID);
    expect(r2.env.SKYWAY_INSTANCE_ID).toMatch(UUID);
    expect(r1.env.SKYWAY_INSTANCE_ID).not.toBe(r2.env.SKYWAY_INSTANCE_ID);
    expect([r1.env.SKYWAY_REPLICA, r2.env.SKYWAY_REPLICA]).toEqual(['1', '2']);
    expect([r1.env.SKYWAY_REPLICAS, r2.env.SKYWAY_REPLICAS]).toEqual(['2', '2']);
    expect(r1.env.RAILWAY_REPLICA_ID).toBe(r1.env.SKYWAY_INSTANCE_ID);
    expect(r2.env.RAILWAY_REPLICA_ID).toBe(r2.env.SKYWAY_INSTANCE_ID);
    expect(r1.env.SKYWAY_VALIDATION).toBeUndefined();
    expect(r1.identidad).toEqual({ instancia: r1.env.SKYWAY_INSTANCE_ID, replica: 1 });
    expect(r2.identidad).toEqual({ instancia: r2.env.SKYWAY_INSTANCE_ID, replica: 2 });
    // El id del despliegue sigue siendo el mismo en las dos copias.
    expect(r1.env.SKYWAY_DEPLOYMENT).toBe(r2.env.SKYWAY_DEPLOYMENT);

    const dep2 = await desplegar(s.id);
    expect(dep2.status, dep2.error ?? '').toBe('success');
    expect(m.specs.get(base).env.SKYWAY_INSTANCE_ID).not.toBe(r1.env.SKYWAY_INSTANCE_ID);
  }, 40_000);

  it('SKYWAY_VALIDATION=1 solo en la copia de validación «--next»', async () => {
    const { s, base } = bot({ image: 'nginx:alpine', port: 80, domains: ['bot.acme.es'] });
    const dep = await desplegar(s.id);
    expect(dep.status, dep.error ?? '').toBe('success');
    const next = m.specs.get(`${base}--next`);
    const nueva = m.specs.get(base);
    expect(next.env.SKYWAY_VALIDATION).toBe('1');
    expect(next.env.SKYWAY_REPLICA).toBe('1');
    expect(nueva.env.SKYWAY_VALIDATION).toBeUndefined();
    expect(next.env.SKYWAY_INSTANCE_ID).not.toBe(nueva.env.SKYWAY_INSTANCE_ID);
    // La «--next» nunca atendió: gracia corta (antes, la del servicio entera).
    expect(m.paradas.get(`${base}--next`)?.graciaSegundos).toBe(GRACIA_VALIDACION_MAXIMA);
    expect(m.paradas.get(`${base}--prev`)?.graciaSegundos).toBe(30);
  });

  it('un RAILWAY_REPLICA_ID definido por el usuario se respeta', async () => {
    const { s, base } = bot();
    setEnv(s.id, { RAILWAY_REPLICA_ID: 'el-mio' });
    const dep = await desplegar(s.id);
    expect(dep.status, dep.error ?? '').toBe('success');
    expect(m.specs.get(base).env.RAILWAY_REPLICA_ID).toBe('el-mio');
    expect(m.specs.get(base).env.SKYWAY_INSTANCE_ID).toMatch(UUID);
  });
});

describe('restos de un intercambio interrumpido', () => {
  it('«--next» y «--prev» con su copia nueva: se paran con la gracia y se retiran', async () => {
    const { s, base } = bot({ stopGraceSeconds: 7 });
    m.contenedores.set(`${base}--next`, { running: true, serviceId: s.id });
    m.contenedores.set(`${base}--prev`, { running: true, serviceId: s.id });
    const hecho = await limpiarRestosIntercambio(getService(s.id)!);
    expect(hecho).toHaveLength(2);
    expect(idx(`parar:${base}--next(t=7)`)).toBeLessThan(idx(`borrar:${base}--next`));
    expect(idx(`parar:${base}--prev(t=7)`)).toBeLessThan(idx(`borrar:${base}--prev`));
    expect(m.contenedores.get(base)?.running).toBe(true);
  });

  it('«--prev» del último despliegue correcto y base de uno que no terminó: se recupera la anterior', async () => {
    // Skyway cayó mientras validaba la versión nueva (una sola copia): la base
    // es la nueva, sin validar y quizá parada; la «--prev», la que funcionaba.
    const { s, base } = bot({ stopCommand: 'echo adiós' }, 0);
    const bueno = createDeployment(s.id, 'manual');
    updateDeployment(bueno.id, { status: 'success' });
    const cortado = createDeployment(s.id, 'manual');
    updateDeployment(cortado.id, { status: 'canceled' });
    m.contenedores.set(base, { running: false, serviceId: s.id, deployment: cortado.id });
    m.contenedores.set(`${base}--prev`, { running: false, serviceId: s.id, deployment: bueno.id });
    const hecho = await limpiarRestosIntercambio(getService(s.id)!);
    expect(hecho.join('\n')).toMatch(/Recuperada la versión anterior de un despliegue interrumpido.*vuelve a su nombre y queda en marcha/);
    expect(m.eventos).toEqual([
      `parar:${base}(t=30)`,
      `parada:${base}`,
      `archivar:${base}`,
      `borrar:${base}`,
      `renombrar:${base}--prev>${base}`,
      `arrancar:${base}`,
    ]);
    expect(m.contenedores.get(base)).toMatchObject({ running: true, deployment: bueno.id });
  });

  it('lo mismo pedido por Detener: la anterior vuelve a su nombre sin arrancarse', async () => {
    const { s, base } = bot({}, 0);
    const bueno = createDeployment(s.id, 'manual');
    updateDeployment(bueno.id, { status: 'success' });
    const cortado = createDeployment(s.id, 'manual');
    updateDeployment(cortado.id, { status: 'failed' });
    m.contenedores.set(base, { running: true, serviceId: s.id, deployment: cortado.id });
    m.contenedores.set(`${base}--prev`, { running: false, serviceId: s.id, deployment: bueno.id });
    await limpiarRestosIntercambio(getService(s.id)!, undefined, { sinArrancar: true });
    expect(m.eventos).not.toContain(`arrancar:${base}`);
    expect(m.contenedores.get(base)?.deployment).toBe(bueno.id);
  });

  it('base de un despliegue correcto: se retira la «--prev»', async () => {
    const { s, base } = bot({}, 0);
    const viejo = createDeployment(s.id, 'manual');
    updateDeployment(viejo.id, { status: 'success' });
    const nuevo = createDeployment(s.id, 'manual');
    updateDeployment(nuevo.id, { status: 'success' });
    m.contenedores.set(base, { running: true, serviceId: s.id, deployment: nuevo.id });
    m.contenedores.set(`${base}--prev`, { running: true, serviceId: s.id, deployment: viejo.id });
    await limpiarRestosIntercambio(getService(s.id)!);
    expect(m.eventos).toEqual([`parar:${base}--prev(t=30)`, `parada:${base}--prev`, `borrar:${base}--prev`]);
    expect(m.contenedores.get(base)?.deployment).toBe(nuevo.id);
  });

  it('la «--next» de un resto se para sin el comando al parar', async () => {
    const { s, base } = bot({ stopCommand: 'curl -s "$URL/deleteWebhook"' });
    m.contenedores.set(`${base}--next`, { running: true, serviceId: s.id });
    await limpiarRestosIntercambio(getService(s.id)!);
    expect(m.paradas.get(`${base}--next`)?.comando).toBeNull();
  });

  it('«--prev» sin copia nueva: vuelve a su nombre y se arranca', async () => {
    const { s, base } = bot({}, 0);
    m.contenedores.set(`${base}--prev`, { running: false, serviceId: s.id });
    await limpiarRestosIntercambio(getService(s.id)!);
    expect(m.eventos).toEqual([`renombrar:${base}--prev>${base}`, `arrancar:${base}`]);
  });

  it('«--prev» sin copia nueva de un servicio parado a propósito: vuelve a su nombre sin arrancarse', async () => {
    const { s, base } = bot({}, 0);
    setServiceStopped(s.id, true);
    m.contenedores.set(`${base}--prev`, { running: false, serviceId: s.id });
    await limpiarRestosIntercambio(getService(s.id)!);
    expect(m.eventos).toEqual([`renombrar:${base}--prev>${base}`]);
  });

  it('al arrancar Skyway: la limpieza se encola antes del reintento del despliegue cortado', async () => {
    const { s, base } = bot();
    m.contenedores.set(`${base}--next`, { running: true, serviceId: s.id });
    d.lista = [
      { Names: [`/${base}--next`], Labels: { 'skyway.managed': 'true', 'skyway.service': s.id } },
      { Names: [`/${base}`], Labels: { 'skyway.managed': 'true', 'skyway.service': s.id } },
      { Names: ['/skyway-viejo-api--prev'], Labels: { 'skyway.managed': 'true', 'skyway.service': 'servicio-borrado' } },
    ];
    const cortado = createDeployment(s.id, 'manual');
    updateDeployment(cortado.id, { status: 'deploying' });
    expect(markStaleDeploymentsFailed()).toBeGreaterThanOrEqual(1);

    const avisos: string[] = [];
    const r = await limpiarIntercambiosAlArrancar((l) => avisos.push(l));
    expect(r).toEqual({ servicios: 1, contenedores: 1 });
    expect(avisos.join('\n')).toMatch(/servicio que ya no existe: skyway-viejo-api--prev/);
    expect(resumeInterruptedDeployments().retried).toBe(1);

    const reintento = listDeployments(s.id, 5).find((x) => x.trigger === 'reintento')!;
    const fin = getDeployment((await awaitDeployment(reintento.id, 60_000))!.id)!;
    expect(fin.status, fin.error ?? '').toBe('success');
    // La «--next» la retiró la limpieza (con SIGTERM), no el reintento: el
    // registro del despliegue no la menciona.
    expect(idx(`parar:${base}--next(t=30)`)).toBeLessThan(idx(`borrar:${base}--next`));
    expect(idx(`borrar:${base}--next`)).toBeLessThan(idx(`renombrar:${base}>${base}--prev`));
    expect(avisos.join('\n')).toMatch(/«bot»: Retirada la copia de validación/);
    expect(fin.logs).not.toMatch(/Retirada la copia de validación/);
  });
});

describe('rutas del servicio', () => {
  const pedir = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: method === 'GET' ? { cookie } : { cookie, ...SAME_ORIGIN }, ...(payload ? { payload } : {}) });

  it('Detener sin despliegue en curso alcanza «--next» y «--prev», con la gracia, y archiva después de parar', async () => {
    const { s, base } = bot({ stopGraceSeconds: 20, replicas: 2 }, 2);
    m.contenedores.set(`${base}--next`, { running: true, serviceId: s.id });
    m.contenedores.set(`${base}-r2--prev`, { running: true, serviceId: s.id });
    m.forzadas.add(`${base}-r2`);
    const r = await pedir('POST', `/api/services/${s.id}/stop`);
    expect(r.statusCode, r.body).toBe(200);
    expect(JSON.parse(r.body).forced).toEqual([`${base}-r2`]);
    expect(idx(`parar:${base}--next(t=20)`)).toBeLessThan(idx(`borrar:${base}--next`));
    expect(idx(`parar:${base}-r2--prev(t=20)`)).toBeLessThan(idx(`borrar:${base}-r2--prev`));
    expect(idx(`parar:${base}(t=20)`)).toBeGreaterThan(-1);
    expect(idx(`parar:${base}-r2(t=20)`)).toBeGreaterThan(-1);
    expect(idx(`archivar:${base}`)).toBeGreaterThan(idx(`parada:${base}`));
    // Todas a la vez: las dos réplicas empiezan a pararse antes de que termine ninguna.
    const primeraParada = m.eventos.findIndex((e) => e === `parada:${base}` || e === `parada:${base}-r2`);
    expect(idx(`parar:${base}(t=20)`)).toBeLessThan(primeraParada);
    expect(idx(`parar:${base}-r2(t=20)`)).toBeLessThan(primeraParada);
    // Al registro del servidor solo va el resultado del comando al parar.
    expect(m.paradas.get(base)?.salidaComando).toBe(false);
    expect([...m.contenedores.values()].some((c) => c.serviceId === s.id && c.running)).toBe(false);
    expect(getService(s.id)!.stopped_at).toBeTruthy();
  });

  it('Detener también para una réplica sobrante que sigue en marcha', async () => {
    const { s, base } = bot({}, 1);
    m.contenedores.set(`${base}-r3`, { running: true, serviceId: s.id });
    const r = await pedir('POST', `/api/services/${s.id}/stop`);
    expect(r.statusCode, r.body).toBe(200);
    expect(m.contenedores.get(`${base}-r3`)?.running).toBe(false);
  });

  it('con un despliegue en curso, Detener no toca sus «--next»/«--prev»', async () => {
    const { s, base } = bot();
    m.contenedores.set(`${base}--next`, { running: true, serviceId: s.id });
    const enCurso = createDeployment(s.id, 'manual');
    updateDeployment(enCurso.id, { status: 'deploying' });
    try {
      const r = await pedir('POST', `/api/services/${s.id}/stop`);
      expect(r.statusCode, r.body).toBe(200);
      expect(m.eventos.some((e) => e.includes('--next'))).toBe(false);
      expect(idx(`parar:${base}(t=30)`)).toBeGreaterThan(-1);
    } finally {
      updateDeployment(enCurso.id, { status: 'failed' });
    }
  });

  it('Iniciar recupera una «--prev» sin copia nueva', async () => {
    const { s, base } = bot({}, 0);
    setServiceStopped(s.id, true);
    m.contenedores.set(`${base}--prev`, { running: false, serviceId: s.id });
    const r = await pedir('POST', `/api/services/${s.id}/start`);
    expect(r.statusCode, r.body).toBe(200);
    expect(m.eventos).toEqual([`renombrar:${base}--prev>${base}`, `arrancar:${base}`]);
  });

  it('Reiniciar con «una sola copia» para todas las copias a la vez con el comando y la gracia, y no arranca ninguna hasta pararlas todas', async () => {
    const { s, base } = bot({ stopGraceSeconds: 15, stopCommand: 'echo adiós', replicas: 2 }, 2);
    m.forzadas.add(`${base}-r2`);
    m.espera.set(`${base}-r2`, 80);
    const r = await pedir('POST', `/api/services/${s.id}/restart`);
    expect(r.statusCode, r.body).toBe(200);
    expect(JSON.parse(r.body).forced).toEqual([`${base}-r2`]);
    expect(m.paradas.get(base)).toEqual({ graciaSegundos: 15, comando: 'echo adiós', salidaComando: false });
    const primeraParada = m.eventos.findIndex((e) => e.startsWith('parada:'));
    expect(idx(`parar:${base}(t=15)`)).toBeLessThan(primeraParada);
    expect(idx(`parar:${base}-r2(t=15)`)).toBeLessThan(primeraParada);
    // La primera copia no vuelve a arrancar mientras la segunda sigue parándose.
    expect(idx(`arrancar:${base}`)).toBeGreaterThan(idx(`parada:${base}-r2`));
    expect(idx(`arrancar:${base}-r2`)).toBeGreaterThan(idx(`parada:${base}-r2`));
    // El mismo contenedor (conserva su identidad), sin archivar su registro.
    expect(m.eventos.some((e) => e.startsWith('crear:') || e.startsWith('archivar:'))).toBe(false);
    expect([...m.contenedores.values()].every((c) => c.running)).toBe(true);
  });

  it('Reiniciar con «sin corte» va réplica a réplica: siempre queda una en servicio', async () => {
    const p = proyecto();
    const web = createService(p.id, 'web', 'web', 'image', { image: 'nginx', port: 80, domains: ['web.acme.es'], replicas: 3 } as any);
    const base = `skyway-${p.slug}-web`;
    for (const n of [base, `${base}-r2`, `${base}-r3`]) m.contenedores.set(n, { running: true, serviceId: web.id });
    const r = await pedir('POST', `/api/services/${web.id}/restart`);
    expect(r.statusCode, r.body).toBe(200);
    // Cada réplica vuelve a arrancar antes de que se pare la siguiente.
    expect(idx(`arrancar:${base}`)).toBeLessThan(idx(`parar:${base}-r2(t=30)`));
    expect(idx(`arrancar:${base}-r2`)).toBeLessThan(idx(`parar:${base}-r3(t=30)`));
    expect(idx(`arrancar:${base}-r3`)).toBeGreaterThan(idx(`parada:${base}-r3`));
    expect([...m.contenedores.values()].every((c) => c.running)).toBe(true);
  });

  it('Detener justo después del arranque de Skyway no trata dos veces los mismos restos', async () => {
    const { s, base } = bot();
    m.contenedores.set(`${base}--next`, { running: true, serviceId: s.id });
    m.espera.set(`${base}--next`, 150);
    d.lista = [{ Names: [`/${base}--next`], Labels: { 'skyway.managed': 'true', 'skyway.service': s.id } }];
    await limpiarIntercambiosAlArrancar(() => undefined);
    const r = await pedir('POST', `/api/services/${s.id}/stop`);
    expect(r.statusCode, r.body).toBe(200);
    expect(m.eventos.filter((e) => e === `parar:${base}--next(t=30)`)).toHaveLength(1);
    expect(m.eventos.filter((e) => e === `borrar:${base}--next`)).toHaveLength(1);
    // La acción esperó a la limpieza encolada: la «--next» ya no estaba al parar.
    expect(idx(`borrar:${base}--next`)).toBeLessThan(idx(`parar:${base}(t=30)`));
  });

  it('PATCH valida y guarda la estrategia, la gracia y el comando al parar', async () => {
    const { s } = bot();
    const patch = (config: Record<string, unknown>) => pedir('PATCH', `/api/services/${s.id}`, { config });
    const cfg = () => getService(s.id)!.config as unknown as Record<string, unknown>;

    let r = await patch({ deployStrategy: 'recreate', stopGraceSeconds: 20, stopCommand: '  echo adiós  ' });
    expect(r.statusCode, r.body).toBe(200);
    // Valen desde el próximo despliegue o la próxima parada: no piden volver a desplegar.
    expect(JSON.parse(r.body).needsRedeploy).toBe(false);
    expect(cfg()).toMatchObject({ deployStrategy: 'recreate', stopGraceSeconds: 20, stopCommand: 'echo adiós' });

    r = await patch({ deployStrategy: 'auto', stopGraceSeconds: null, stopCommand: '' });
    expect(r.statusCode, r.body).toBe(200);
    expect(cfg().deployStrategy).toBeUndefined();
    expect(cfg().stopGraceSeconds).toBeUndefined();
    expect(cfg().stopCommand).toBeUndefined();

    for (const malo of [{ deployStrategy: 'rolling' }, { stopGraceSeconds: 601 }, { stopGraceSeconds: -1 }, { stopGraceSeconds: 1.5 }, { stopCommand: 'x'.repeat(1001) }]) {
      r = await patch(malo);
      expect(r.statusCode, JSON.stringify(malo)).toBe(400);
    }
    r = await patch({ stopGraceSeconds: 0, stopCommand: null });
    expect(r.statusCode, r.body).toBe(200);
    expect(cfg().stopGraceSeconds).toBe(0);

    // Las cifras como texto valen; un texto vacío la deja sin fijar (antes: 0,
    // SIGKILL inmediato en cada parada), y un booleano no es una gracia.
    r = await patch({ stopGraceSeconds: '25' });
    expect(r.statusCode, r.body).toBe(200);
    expect(cfg().stopGraceSeconds).toBe(25);
    r = await patch({ stopGraceSeconds: '' });
    expect(r.statusCode, r.body).toBe(200);
    expect(cfg().stopGraceSeconds).toBeUndefined();
    for (const malo of [true, '2x', 'abc']) {
      r = await patch({ stopGraceSeconds: malo });
      expect(r.statusCode, JSON.stringify(malo)).toBe(400);
    }
  });

  it('el comando al parar queda en la auditoría y exige el módulo «Terminal de comandos»', async () => {
    const { s } = bot();
    let r = await pedir('PATCH', `/api/services/${s.id}`, { config: { stopCommand: 'node scripts/vaciar-cola.js' } });
    expect(r.statusCode, r.body).toBe(200);
    const entrada = listAudit({ action: 'service_stop_command' }).find((a) => a.target_id === s.id);
    expect(entrada?.detail).toBe('bot: node scripts/vaciar-cola.js');

    // Propietario de un workspace sin el módulo: no puede poner uno nuevo, pero
    // sí guardar el resto de ajustes con el que ya hay, y quitarlo.
    const ws = createWorkspaceRow('Sin terminal', { modules_override: JSON.stringify(['domains']) });
    const p = createProject('Bots sin terminal', `sin-terminal-${Math.random().toString(36).slice(2, 8)}`, null, ws.id);
    const svc = createService(p.id, 'bot', 'bot', 'image', { image: 'busybox:stable', domains: [], stopCommand: 'echo de antes' } as any);
    const email = `owner-${Math.random().toString(36).slice(2, 8)}@example.com`;
    createUser(email, hashPassword('contraseña1'), 'owner', ws.id);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'contraseña1' }, headers: SAME_ORIGIN });
    expect(login.statusCode, login.body).toBe(200);
    const suya = String(login.headers['set-cookie']).split(';')[0];
    const patchSuyo = (config: Record<string, unknown>) =>
      app.inject({ method: 'PATCH', url: `/api/services/${svc.id}`, headers: { cookie: suya, ...SAME_ORIGIN }, payload: { config } });
    r = await patchSuyo({ stopCommand: 'curl -s https://x' });
    expect(r.statusCode, r.body).toBe(403);
    expect(JSON.parse(r.body).error).toMatch(/Terminal de comandos/);
    r = await patchSuyo({ stopCommand: 'echo de antes', stopGraceSeconds: 12 });
    expect(r.statusCode, r.body).toBe(200);
    r = await patchSuyo({ stopCommand: null });
    expect(r.statusCode, r.body).toBe(200);
    expect((getService(svc.id)!.config as unknown as Record<string, unknown>).stopCommand).toBeUndefined();
  });

  it('PATCH de una base de datos: solo la gracia', async () => {
    const p = proyecto();
    const db = createService(p.id, 'postgres', 'postgres', 'database', { template: 'postgres' } as any);
    let r = await pedir('PATCH', `/api/services/${db.id}`, { config: { deployStrategy: 'overlap', stopGraceSeconds: 60, stopCommand: 'x' } });
    expect(r.statusCode, r.body).toBe(200);
    const cfg = getService(db.id)!.config as unknown as Record<string, unknown>;
    expect(cfg.stopGraceSeconds).toBe(60);
    expect(cfg.deployStrategy).toBeUndefined();
    expect(cfg.stopCommand).toBeUndefined();
    // Una base de datos nunca se para con menos de 10 s.
    r = await pedir('PATCH', `/api/services/${db.id}`, { config: { stopGraceSeconds: 5 } });
    expect(r.statusCode, r.body).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/de 10 a 600 segundos/);
    r = await pedir('PATCH', `/api/services/${db.id}`, { config: { stopGraceSeconds: 10 } });
    expect(r.statusCode, r.body).toBe(200);
  });

  it('GET trae cómo se despliega y se para el servicio', async () => {
    const { p, s } = bot();
    let r = await pedir('GET', `/api/services/${s.id}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(JSON.parse(r.body).deploy).toEqual({
      strategy: 'recreate',
      reason: 'sin_trafico',
      automatic: true,
      calledByOthers: false,
      repoHealthcheckPath: null,
      botLibraries: [],
      stopGraceSeconds: 30,
      stopGraceSource: 'defecto',
    });

    // Otro servicio lo llama por la red interna: pasa a «sin corte».
    const web = createService(p.id, 'web', 'web', 'image', { image: 'nginx', port: 80, domains: [] } as any);
    setEnv(web.id, { BOT_URL: '${{bot.INTERNAL_URL}}' });
    setEnv(s.id, { RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '50' });
    r = await pedir('GET', `/api/services/${s.id}`);
    expect(JSON.parse(r.body).deploy).toMatchObject({
      strategy: 'overlap',
      reason: 'con_trafico',
      calledByOthers: true,
      stopGraceSeconds: 50,
      stopGraceSource: 'railway',
    });
  });

  it('PATCH de dominios deja con cambios sin desplegar a los servicios que referencian su dirección', async () => {
    const p = proyecto();
    const web = createService(p.id, 'web', 'web', 'image', { image: 'nginx', port: 80, domains: ['web.acme.es'] } as any);
    const tg = createService(p.id, 'tg', 'tg', 'image', { image: 'bot', domains: [] } as any);
    const ajeno = createService(p.id, 'otro', 'otro', 'image', { image: 'bot', domains: [] } as any);
    setEnv(tg.id, { WEBHOOK_URL: '${{web.PUBLIC_URL}}/telegram' });
    setEnv(ajeno.id, { NADA: 'que ver' });
    // Un despliegue correcto de cada uno: sin él no hay «cambios sin desplegar».
    for (const id of [web.id, tg.id, ajeno.id]) {
      const dep = createDeployment(id, 'manual');
      updateDeployment(dep.id, { status: 'success', config_rev: 0 });
    }
    const r = await pedir('PATCH', `/api/services/${web.id}`, { config: { domains: ['web.acme2.es'] }, domainsBase: ['web.acme.es'] });
    expect(r.statusCode, r.body).toBe(200);
    const pendientes = servicesWithPendingChanges([getService(web.id)!, getService(tg.id)!, getService(ajeno.id)!]);
    expect(pendientes.has(tg.id)).toBe(true);
    expect(pendientes.has(web.id)).toBe(true);
    expect(pendientes.has(ajeno.id)).toBe(false);
  });
});

describe('railway.json: drainingSeconds y overlapSeconds se leen (solo para informar)', () => {
  it('JSON y TOML', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'railwaycfg-'));
    try {
      fs.writeFileSync(path.join(dir, 'railway.json'), JSON.stringify({ deploy: { drainingSeconds: 20, overlapSeconds: 0 } }));
      const json = readRailwayRepoConfig(dir);
      expect([json.drainingSeconds, json.overlapSeconds]).toEqual([20, 0]);
      expect(hasRailwayConfig(json)).toBe(true);
      fs.rmSync(path.join(dir, 'railway.json'));
      fs.writeFileSync(path.join(dir, 'railway.toml'), '[deploy]\ndrainingSeconds = 15\n');
      const toml = readRailwayRepoConfig(dir);
      expect([toml.drainingSeconds, toml.overlapSeconds]).toEqual([15, null]);
      expect(hasRailwayConfig(toml)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
