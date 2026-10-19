/**
 * Init de Docker en las copias de las aplicaciones.
 *
 * Sin init, la aplicación es el PID 1 del contenedor y el kernel descarta las
 * señales para las que no tiene manejador (Node, además, atiende SIGTERM solo
 * para restaurar el terminal y la relanza sin manejador). Reiniciar y Detener
 * esperaban la gracia entera (30 s por defecto) con la aplicación en marcha,
 * como si el botón no hiciera nada, y acababan en SIGKILL. Con `Init`, el PID 1
 * es el init de Docker, que le entrega la señal.
 *
 * Sin Docker: las funciones reales de `docker/containers.ts` y la ruta de
 * Reiniciar, contra un cliente de Docker simulado.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { closeDb, createProject, createService, initDb } from '../src/db';
import { initPropioDeLaImagen, pararConGracia, runServiceContainer } from '../src/docker/containers';

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

const d = vi.hoisted(() => ({
  creados: [] as any[],
  ordenes: [] as string[],
  /** Estado de cada contenedor y con qué se creó (lo que devuelve `inspect`). */
  estado: new Map<
    string,
    { running: boolean; exitCode: number; init: boolean; entrypoint?: string[]; cmd?: string[]; env?: string[] }
  >(),
  /** Cómo termina cada contenedor al pararlo y cuánto tarda (ms). */
  salida: new Map<string, { exitCode: number; tardaMs?: number }>(),
  /** El daemon no tiene el binario del init. */
  sinBinarioInit: false,
}));

vi.mock('../src/docker/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/docker/client')>();
  const contenedor = (name: string) => ({
    inspect: async () => {
      const st = d.estado.get(name);
      if (!st) throw Object.assign(new Error('no existe'), { statusCode: 404 });
      return {
        Config: { Labels: {}, Entrypoint: st.entrypoint ?? null, Cmd: st.cmd ?? ['node', 'bot.js'], Env: st.env ?? [] },
        HostConfig: st.init ? { Init: true } : {},
        State: { Running: st.running, ExitCode: st.exitCode, OOMKilled: false },
      };
    },
    stop: async (opts: { t: number }) => {
      d.ordenes.push(`stop:${name}:t=${opts.t}`);
      const st = d.estado.get(name);
      if (!st) throw Object.assign(new Error('no existe'), { statusCode: 404 });
      const fin = d.salida.get(name) ?? { exitCode: 143 };
      if (fin.tardaMs) await new Promise((r) => setTimeout(r, fin.tardaMs));
      d.estado.set(name, { ...st, running: false, exitCode: fin.exitCode });
    },
    start: async () => {
      d.ordenes.push(`start:${name}`);
      const st = d.estado.get(name);
      if (st) st.running = true;
    },
    remove: async () => {
      d.ordenes.push(`remove:${name}`);
      d.estado.delete(name);
    },
  });
  const consultas = Object.create(mod.dockerQuery);
  consultas.getContainer = (name: string) => contenedor(name);
  consultas.listContainers = async () => [];
  return {
    ...mod,
    dockerAvailable: vi.fn(async () => true),
    dockerQuery: consultas,
    docker: {
      createContainer: vi.fn(async (opts: any) => {
        d.creados.push(opts);
        const init = opts.HostConfig?.Init === true;
        return {
          id: `id-${opts.name}`,
          start: async () => {
            // Así responde el daemon a `--init` sin el binario: al arrancar.
            if (init && d.sinBinarioInit) throw new Error('exec: "docker-init": executable file not found in $PATH');
            d.estado.set(opts.name, { running: true, exitCode: 0, init });
          },
        };
      }),
      getContainer: vi.fn((name: string) => contenedor(name)),
    },
  };
});
vi.mock('../src/docker/containers', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/docker/containers')>();
  return {
    ...mod,
    getRuntime: vi.fn(async () => ({
      state: 'running',
      startedAt: new Date().toISOString(),
      exitCode: null,
      restartCount: 0,
      image: 'node:22-alpine',
    })),
  };
});

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
  d.creados.length = 0;
  d.ordenes.length = 0;
  d.estado.clear();
  d.salida.clear();
  d.sinBinarioInit = false;
});

function proyecto() {
  return createProject('Bots', `bots-${Math.random().toString(36).slice(2, 8)}`);
}

describe('initPropioDeLaImagen', () => {
  it('reconoce los procesos de inicio que ya trae la imagen', () => {
    expect(initPropioDeLaImagen(['/init'], [], [])).toBe('/init');
    expect(initPropioDeLaImagen(['/sbin/tini', '--'], ['node', 'index.js'], [])).toBe('/sbin/tini');
    expect(initPropioDeLaImagen(['dumb-init', '--'], ['python', 'bot.py'], [])).toBe('dumb-init');
    expect(initPropioDeLaImagen(null, ['/lib/systemd/systemd'], [])).toBe('/lib/systemd/systemd');
    // s6-overlay lanzado desde un script de entrada: lo delatan sus variables.
    expect(initPropioDeLaImagen(['/docker-entrypoint.sh'], [], ['PATH=/usr/bin', 'S6_VERBOSITY=1'])).toBe('s6-overlay');
  });

  it('una aplicación normal no trae init propio', () => {
    expect(initPropioDeLaImagen(['docker-entrypoint.sh'], ['node', 'index.js'], ['NODE_VERSION=22'])).toBeNull();
    expect(initPropioDeLaImagen(['/bin/bash', '-l', '-c'], ['npm start'], [])).toBeNull();
    expect(initPropioDeLaImagen([], ['sh', '-c', 'node bot.js'], [])).toBeNull();
    expect(initPropioDeLaImagen(null, null, null)).toBeNull();
    // Un script cuyo nombre contiene «init» no es un proceso de inicio.
    expect(initPropioDeLaImagen(['/app/init-db.sh'], [], [])).toBeNull();
  });
});

describe('runServiceContainer', () => {
  function spec(init: boolean | undefined, log?: (l: string) => void) {
    const p = proyecto();
    const s = createService(p.id, 'bot', 'bot', 'image', { image: 'node:22-alpine', domains: [] } as any);
    return {
      project: p,
      service: s,
      image: 'node:22-alpine',
      env: {},
      deploymentId: 'dep-1',
      internalPort: null,
      domains: [],
      ...(init === undefined ? {} : { init }),
      ...(log ? { log } : {}),
    };
  }

  it('con `init`, el contenedor se crea con el init de Docker', async () => {
    await runServiceContainer(spec(true));
    expect(d.creados.at(-1).HostConfig.Init).toBe(true);
  });

  it('sin `init`, como siempre', async () => {
    await runServiceContainer(spec(false));
    await runServiceContainer(spec(undefined));
    for (const opts of d.creados) expect(opts.HostConfig.Init).toBeUndefined();
  });

  it('si el daemon no tiene el init, lo crea otra vez sin él y lo avisa: el despliegue no falla', async () => {
    d.sinBinarioInit = true;
    const log: string[] = [];
    const s = spec(true, (l) => log.push(l));
    await expect(runServiceContainer(s)).resolves.toBe(`id-skyway-${s.project.slug}-bot`);
    expect(d.creados.map((o) => o.HostConfig.Init === true)).toEqual([true, false]);
    expect(d.estado.get(`skyway-${s.project.slug}-bot`)?.running).toBe(true);
    expect(log.join('\n')).toMatch(/Docker no tiene el init \(docker-init\)/);
  });

  it('otro fallo al arrancar no se oculta', async () => {
    const { docker } = await import('../src/docker/client');
    vi.mocked(docker.createContainer).mockImplementationOnce(async (opts: any) => {
      d.creados.push(opts);
      return { id: 'x', start: async () => Promise.reject(new Error('port is already allocated')) } as any;
    });
    await expect(runServiceContainer(spec(true))).rejects.toThrow(/port is already allocated/);
    expect(d.creados).toHaveLength(1);
  });
});

describe('pararConGracia: parada forzada según el init', () => {
  /** Una copia que no termina con SIGTERM: agota la gracia (1 s) y acaba con 137. */
  function forzada(name: string, extra: { init: boolean; entrypoint?: string[]; env?: string[] }) {
    d.estado.set(name, { running: true, exitCode: 0, ...extra });
    d.salida.set(name, { exitCode: 137, tardaMs: 950 });
  }

  it('creada sin init en un servicio que ya lo lleva: `sinInit` y el aviso dice que basta con volver a desplegar', async () => {
    forzada('c-sin', { init: false });
    const log: string[] = [];
    const r = await pararConGracia('c-sin', { graciaSegundos: 1, log: (l) => log.push(l), initEnServicio: true });
    expect(r).toMatchObject({ existia: true, forzada: true, sinInit: true });
    expect(log.join('\n')).toMatch(/se creó sin init/);
    expect(log.join('\n')).toMatch(/tras volver a desplegar, la parada es inmediata/);
  });

  it('con init: la aplicación recibe la señal y es ella la que no cierra', async () => {
    forzada('c-con', { init: true });
    const log: string[] = [];
    const r = await pararConGracia('c-con', { graciaSegundos: 1, log: (l) => log.push(l), initEnServicio: true });
    expect(r).toMatchObject({ forzada: true, sinInit: false });
    expect(log.join('\n')).toMatch(/La aplicación recibe SIGTERM/);
  });

  it('una base de datos, o una imagen con su propio init, no se marca `sinInit`', async () => {
    forzada('c-base', { init: false });
    forzada('c-s6', { init: false, entrypoint: ['/init'] });
    const log: string[] = [];
    const base = await pararConGracia('c-base', { graciaSegundos: 1, log: (l) => log.push(l) });
    const s6 = await pararConGracia('c-s6', { graciaSegundos: 1, initEnServicio: true });
    expect(base).toMatchObject({ forzada: true, sinInit: false });
    expect(s6).toMatchObject({ forzada: true, sinInit: false });
    expect(log.join('\n')).toMatch(/tiene que atender SIGTERM/);
  });
});

describe('POST /api/services/:id/restart', () => {
  async function reiniciar(conInit: boolean) {
    const p = proyecto();
    const s = createService(p.id, 'bot', 'bot', 'image', { image: 'node:22-alpine', domains: [], stopGraceSeconds: 1 } as any);
    const nombre = `skyway-${p.slug}-bot`;
    d.estado.set(nombre, { running: true, exitCode: 0, init: conInit });
    d.salida.set(nombre, { exitCode: 137, tardaMs: 950 });
    const res = await app.inject({
      method: 'POST',
      url: `/api/services/${s.id}/restart`,
      headers: { ...SAME_ORIGIN, cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return { body: res.json(), nombre };
  }

  it('una copia creada sin init y detenida con SIGKILL: responde `initOnRedeploy` para que el panel diga cómo arreglarlo', async () => {
    const { body, nombre } = await reiniciar(false);
    expect(body.forced).toEqual([nombre]);
    expect(body.initOnRedeploy).toBe(true);
    expect(d.ordenes).toEqual([`stop:${nombre}:t=1`, `start:${nombre}`]);
  });

  it('con init, una parada forzada es cosa de la aplicación: sin `initOnRedeploy`', async () => {
    const { body, nombre } = await reiniciar(true);
    expect(body.forced).toEqual([nombre]);
    expect(body.initOnRedeploy).toBe(false);
  });
});
