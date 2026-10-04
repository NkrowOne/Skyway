/**
 * Intercambio de versiones sin corte y validación sin healthcheck.
 *
 *  - El «intercambio sin corte» validaba la versión nueva en un contenedor
 *    `--next`, lo borraba, creaba en frío el que iba a servir y retiraba la
 *    versión anterior a los 1,5 s, sin comprobar que la nueva atendiera: una app
 *    que tardaba más en escuchar dejaba el dominio en 502 (o sin servidor, si la
 *    imagen trae HEALTHCHECK). Ahora la anterior no se retira hasta que ESTA
 *    copia pasa la misma sonda (o Docker la marca «healthy»).
 *  - Sin ruta de healthcheck, bastaba con que el proceso siguiera vivo 5 s: una
 *    app que escuchaba en otro puerto sustituía a la buena con el despliegue en
 *    verde. Con dominio, ahora se exige que el puerto interno acepte conexiones.
 *  - Las rutas VOLUME de la imagen sin volumen se avisan y quedan anotadas.
 *
 * Sin Docker: se sustituyen las llamadas al daemon por un registro de eventos,
 * y las sondas (`execInContainer`) responden según lo que pida cada prueba.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, createProject, createService, getDeployment, getService, initDb, setEnv } from '../src/db';
import { awaitDeployment, triggerDeploy } from '../src/deploy/deployer';

const m = vi.hoisted(() => ({
  eventos: [] as string[],
  vivos: new Set<string>(),
  sondeos: new Map<string, number>(),
  /** Intentos que fallan antes de responder, por destino de la sonda. */
  fallosAntes: new Map<string, number>(),
  puertoAbierto: true,
  healthcheck: false,
  salud: [] as string[],
  volumenes: [] as string[],
}));

vi.mock('../src/docker/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/docker/client')>();
  return {
    ...mod,
    dockerAvailable: vi.fn(async () => true),
    docker: {
      createContainer: vi.fn(async (opts: { name: string }) => ({ id: `id-${opts.name}`, start: async () => undefined })),
      getContainer: vi.fn(() => ({ remove: async () => undefined, logs: async () => Buffer.from('') })),
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
    findContainer: vi.fn(async (name: string) => (m.vivos.has(name) ? { Config: { Labels: {} }, State: { Running: true } } : null)),
    runServiceContainer: vi.fn(async (spec: Parameters<typeof mod.runServiceContainer>[0]) => {
      const name = spec.nameOverride ?? mod.containerName(spec.project, spec.service);
      m.eventos.push(`crear:${name}`);
      m.vivos.add(name);
      return `id-${name}`;
    }),
    renameContainer: vi.fn(async (from: string, to: string) => {
      m.eventos.push(`renombrar:${from}>${to}`);
      m.vivos.delete(from);
      m.vivos.add(to);
    }),
    removeContainer: vi.fn(async (name: string) => {
      m.eventos.push(`borrar:${name}`);
      m.vivos.delete(name);
    }),
    stopContainer: vi.fn(async (name: string) => {
      m.eventos.push(`parar:${name}`);
    }),
    getRuntime: vi.fn(async (name: string) =>
      m.vivos.has(name)
        ? { state: 'running', startedAt: new Date().toISOString(), exitCode: null, restartCount: 0, image: 'nginx:alpine' }
        : { state: 'not_created', startedAt: null, exitCode: null, restartCount: 0, image: null },
    ),
    execInContainer: vi.fn(async (_id: string, command: string, opts: { env?: string[] } = {}) => {
      const env = Object.fromEntries((opts.env ?? []).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
      const tcp = command.includes('nc -z');
      const destino = tcp ? `tcp://${env.SKYWAY_PROBE_HOST}:${env.SKYWAY_PROBE_PORT}` : env.SKYWAY_PROBE_URL;
      const n = (m.sondeos.get(destino) ?? 0) + 1;
      m.sondeos.set(destino, n);
      m.eventos.push(`sonda:${destino}`);
      const ok = n > (m.fallosAntes.get(destino) ?? 0) && (!tcp || m.puertoAbierto);
      return { output: '', exitCode: ok ? 0 : 1, truncated: false, timedOut: false, durationMs: 1 };
    }),
    imageExists: vi.fn(async () => true),
    imageDeclaredVolumes: vi.fn(async () => m.volumenes),
    imageHasHealthcheck: vi.fn(async () => m.healthcheck),
    containerHealth: vi.fn(async (name: string) => {
      m.eventos.push(`salud:${name}`);
      return { state: 'running', exitCode: null, health: (m.salud.shift() ?? 'healthy') as 'starting' | 'healthy' | 'unhealthy' };
    }),
    listServiceContainers: vi.fn(async () => []),
    fetchLogsText: vi.fn(async () => ''),
  };
});

beforeAll(() => {
  initDb();
});

afterAll(() => {
  closeDb();
});

beforeEach(() => {
  m.eventos.length = 0;
  m.vivos.clear();
  m.sondeos.clear();
  m.fallosAntes.clear();
  m.puertoAbierto = true;
  m.healthcheck = false;
  m.salud = [];
  m.volumenes = [];
});

/** Servicio de imagen con dominio; `enMarcha` = ya tiene una versión sirviendo. */
function servicio(cfg: { healthcheckPath?: string } = {}, enMarcha = true) {
  const p = createProject('Web', `web-${Math.random().toString(36).slice(2, 8)}`);
  const s = createService(p.id, 'web', 'web', 'image', {
    image: 'nginx:alpine',
    port: 80,
    domains: ['app.acme.es'],
    ...cfg,
  } as any);
  const nombre = `skyway-${p.slug}-web`;
  if (enMarcha) m.vivos.add(nombre);
  return { s, nombre };
}

async function desplegar(serviceId: string) {
  const dep = triggerDeploy(serviceId, 'manual');
  const fin = await awaitDeployment(dep.id, 30_000);
  return getDeployment(fin!.id)!;
}

describe('intercambio sin corte', () => {
  it('no retira la versión anterior hasta que la copia que va a servir responde al healthcheck', async () => {
    const { s, nombre } = servicio({ healthcheckPath: '/health' });
    const real = `http://${nombre}:80/health`;
    m.fallosAntes.set(real, 2); // tarda en escuchar: dos intentos fallidos

    const dep = await desplegar(s.id);
    expect(dep.status, dep.error ?? '').toBe('success');

    const ultimaSonda = m.eventos.lastIndexOf(`sonda:${real}`);
    const parada = m.eventos.indexOf(`parar:${nombre}--prev`);
    expect(m.sondeos.get(real)).toBe(3);
    expect(parada).toBeGreaterThan(ultimaSonda);
    expect(dep.logs).toMatch(/Intercambio completado sin interrupción/);
  });

  it('si la copia nueva no llega a responder, se restaura la anterior', async () => {
    const { s, nombre } = servicio({ healthcheckPath: '/health' });
    setEnv(s.id, { RAILWAY_HEALTHCHECK_TIMEOUT_SEC: '5' });
    m.fallosAntes.set(`http://${nombre}:80/health`, 1000);

    const dep = await desplegar(s.id);
    expect(dep.status).toBe('failed');
    expect(dep.error).toMatch(/Su versión anterior sigue en ejecución/);
    expect(m.eventos).toContain(`renombrar:${nombre}--prev>${nombre}`);
    expect(m.eventos).not.toContain(`parar:${nombre}--prev`);
  });

  it('con HEALTHCHECK en la imagen, espera a que Docker la marque «healthy»', async () => {
    const { s, nombre } = servicio({ healthcheckPath: '/health' });
    m.healthcheck = true;
    m.salud = ['starting', 'starting', 'healthy'];

    const dep = await desplegar(s.id);
    expect(dep.status, dep.error ?? '').toBe('success');
    const sano = m.eventos.lastIndexOf(`salud:${nombre}`);
    expect(m.eventos.filter((e) => e === `salud:${nombre}`)).toHaveLength(3);
    expect(m.eventos.indexOf(`parar:${nombre}--prev`)).toBeGreaterThan(sano);
  });

  it('anota y avisa las rutas VOLUME de la imagen que no tienen volumen', async () => {
    const { s } = servicio({ healthcheckPath: '/health' });
    m.volumenes = ['/data'];
    const dep = await desplegar(s.id);
    expect(dep.status, dep.error ?? '').toBe('success');
    expect(dep.logs).toMatch(/La imagen guarda datos en \/data \(VOLUME\)/);
    expect((getService(s.id)!.config as { imageVolumes?: string[] }).imageVolumes).toEqual(['/data']);
  });
});

describe('sin ruta de healthcheck', () => {
  it('con dominio, una app que no escucha en el puerto interno no se da por buena', async () => {
    const { s } = servicio({}, false);
    setEnv(s.id, { RAILWAY_HEALTHCHECK_TIMEOUT_SEC: '5' });
    m.puertoAbierto = false;

    const dep = await desplegar(s.id);
    expect(dep.status).toBe('failed');
    expect(dep.error).toMatch(/el puerto interno 80 no aceptó conexiones/);
    expect([...m.sondeos.keys()].some((k) => k.startsWith('tcp://web:80'))).toBe(true);
  });

  it('con dominio y el puerto abierto, el despliegue sale bien', async () => {
    const { s } = servicio({}, false);
    const dep = await desplegar(s.id);
    expect(dep.status, dep.error ?? '').toBe('success');
    expect(dep.logs).toMatch(/El puerto 80 acepta conexiones/);
  });
});
