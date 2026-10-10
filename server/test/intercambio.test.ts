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
 * Las paradas van por `pararConGracia` (SIGTERM con la gracia del servicio) y
 * el registro de la versión anterior se archiva después de pararla.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, createDeployment, createProject, createService, getDeployment, getService, initDb, listAlerts, setEnv, updateDeployment } from '../src/db';
import { awaitDeployment, triggerDeploy } from '../src/deploy/deployer';
import { AUTODEPLOY_ALERT_TYPE, fireAlert } from '../src/alerts';

const m = vi.hoisted(() => ({
  eventos: [] as string[],
  vivos: new Set<string>(),
  sondeos: new Map<string, number>(),
  /** Intentos que fallan antes de responder, por destino de la sonda. */
  fallosAntes: new Map<string, number>(),
  puertoAbierto: true,
  healthcheck: false,
  /** Lo que Docker puede tardar en decidir con el HEALTHCHECK de la imagen. */
  ventanaSalud: 180_000,
  salud: [] as string[],
  volumenes: [] as string[],
  /** Estados que irá devolviendo `getRuntime` para un contenedor antes de «running». */
  estados: new Map<string, { state: string; exitCode: number | null; restartCount?: number }[]>(),
  /** Gracia con la que se paró cada copia. */
  gracias: new Map<string, number>(),
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
    findContainer: vi.fn(async (name: string) =>
      m.vivos.has(name) ? { Config: { Labels: { 'skyway.deployment': 'dep-anterior' } }, State: { Running: true } } : null,
    ),
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
    pararConGracia: vi.fn(async (name: string, opts: { graciaSegundos: number }) => {
      if (!m.vivos.has(name)) return { existia: false, forzada: false, comando: null };
      m.eventos.push(`parar:${name}`);
      m.gracias.set(name, opts.graciaSegundos);
      return { existia: true, forzada: false, comando: null };
    }),
    getRuntime: vi.fn(async (name: string) => {
      const siguiente = m.vivos.has(name) ? m.estados.get(name)?.shift() : undefined;
      if (siguiente) return { startedAt: null, restartCount: 0, image: 'nginx:alpine', ...siguiente };
      return m.vivos.has(name)
        ? { state: 'running', startedAt: new Date().toISOString(), exitCode: null, restartCount: 0, image: 'nginx:alpine' }
        : { state: 'not_created', startedAt: null, exitCode: null, restartCount: 0, image: null };
    }),
    startContainer: vi.fn(async (name: string) => {
      m.eventos.push(`arrancar:${name}`);
    }),
    imageExposedPorts: vi.fn(async () => []),
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
    imageHealthcheckWindowMs: vi.fn(async () => (m.healthcheck ? m.ventanaSalud : null)),
    containerHealth: vi.fn(async (name: string) => {
      m.eventos.push(`salud:${name}`);
      return { state: 'running', exitCode: null, health: (m.salud.shift() ?? 'healthy') as 'starting' | 'healthy' | 'unhealthy' };
    }),
    listServiceContainers: vi.fn(async () => []),
    fetchLogsText: vi.fn(async (name: string) => {
      m.eventos.push(`archivar:${name}`);
      return '';
    }),
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
  m.ventanaSalud = 180_000;
  m.salud = [];
  m.volumenes = [];
  m.estados.clear();
  m.gracias.clear();
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
    // Parada limpia con la gracia por defecto y, DESPUÉS, el archivo del
    // registro (conserva lo que escribió al recibir SIGTERM) y la retirada.
    expect(m.gracias.get(`${nombre}--prev`)).toBe(30);
    expect(m.eventos.indexOf(`archivar:${nombre}--prev`)).toBeGreaterThan(parada);
    expect(m.eventos.indexOf(`borrar:${nombre}--prev`)).toBeGreaterThan(m.eventos.indexOf(`archivar:${nombre}--prev`));
    // La copia de validación también se para con SIGTERM antes de retirarla.
    expect(m.eventos.indexOf(`parar:${nombre}--next`)).toBeGreaterThan(-1);
    expect(m.eventos.indexOf(`parar:${nombre}--next`)).toBeLessThan(m.eventos.indexOf(`borrar:${nombre}--next`));
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

  it('con HEALTHCHECK, espera lo que Docker tarda en decidir aunque el plazo del servicio sea menor', async () => {
    // HEALTHCHECK con interval de 30 s y RAILWAY_HEALTHCHECK_TIMEOUT_SEC=5: la
    // copia nueva validaba, pero la espera al «healthy» cortaba a los 5 s,
    // antes del primer chequeo de Docker, y se restauraba la versión anterior.
    const { s, nombre } = servicio({ healthcheckPath: '/health' });
    setEnv(s.id, { RAILWAY_HEALTHCHECK_TIMEOUT_SEC: '5' });
    m.healthcheck = true;
    m.ventanaSalud = 20_000;
    m.salud = Array.from({ length: 6 }, () => 'starting').concat('healthy');

    const dep = await desplegar(s.id);
    expect(dep.status, dep.error ?? '').toBe('success');
    expect(dep.logs).toMatch(/como «healthy» \(hasta 20s\)/);
    expect(m.eventos).toContain(`parar:${nombre}--prev`);
  });

  it('un despliegue correcto cierra las alertas del servicio, pero no la del sondeo del auto-deploy', async () => {
    // Cerrarla aquí no arreglaba el sondeo: el siguiente ciclo abría otra
    // alerta (con su racha de fallos antigua) y volvía a notificar.
    const { s } = servicio({ healthcheckPath: '/health' });
    for (const type of ['service_down', AUTODEPLOY_ALERT_TYPE]) {
      fireAlert({ severity: 'warning', type, serviceId: s.id, title: type, message: type, dedupe: true, quiet: true });
    }
    const dep = await desplegar(s.id);
    expect(dep.status, dep.error ?? '').toBe('success');
    const abiertas = listAlerts({ openOnly: true }).filter((a) => a.service_id === s.id).map((a) => a.type);
    expect(abiertas).toEqual([AUTODEPLOY_ALERT_TYPE]);
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

describe('política de reinicio del repositorio con la sonda TCP', () => {
  // Servicio de repositorio con dominio, sin healthcheck y con volumen (sin
  // solape): se valida con la sonda TCP. Se despliega volviendo a una imagen
  // ya construida, que es lo que permite probar la config-as-code sin build.
  function servicioGit(railway: { restartPolicyType: string; restartPolicyMaxRetries?: number }, enMarcha: boolean) {
    const p = createProject('Api', `api-${Math.random().toString(36).slice(2, 8)}`);
    const s = createService(p.id, 'api', 'api', 'git', {
      repoUrl: 'https://github.com/acme/api',
      branch: 'main',
      port: 3000,
      domains: ['api.acme.es'],
      volumes: [{ name: `vol-${p.slug}`, containerPath: '/data' }],
      webhookSecret: 'x',
    } as any);
    const imagen = `skyway/${p.slug}-api:abc1234`;
    const previo = createDeployment(s.id, 'manual');
    updateDeployment(previo.id, {
      status: 'success',
      image_tag: imagen,
      commit_sha: 'abc1234',
      repo_config: JSON.stringify({
        builder: null,
        buildCommand: null,
        dockerfilePath: null,
        watchPatterns: [],
        startCommand: null,
        preDeployCommand: null,
        healthcheckPath: null,
        healthcheckTimeout: null,
        numReplicas: null,
        restartPolicyType: railway.restartPolicyType,
        restartPolicyMaxRetries: railway.restartPolicyMaxRetries ?? null,
        cronSchedule: null,
        source: 'railway.json',
      }),
    });
    const nombre = `skyway-${p.slug}-api`;
    if (enMarcha) m.vivos.add(nombre);
    return { s, nombre, imagen };
  }

  async function volverA(serviceId: string, imagen: string) {
    const dep = triggerDeploy(serviceId, 'rollback', { imageTag: imagen });
    const fin = await awaitDeployment(dep.id, 30_000);
    return getDeployment(fin!.id)!;
  }

  it('una caída al arrancar que Docker reintenta (ON_FAILURE) no tumba el despliegue', async () => {
    // La app sale con código 1 porque la base aún no está lista y arranca bien
    // al reintentar. Antes, con la sonda TCP, el primer «restarting» ya era un
    // fallo, aunque el periodo de gracia (el camino de antes) lo toleraba.
    const { s, nombre, imagen } = servicioGit({ restartPolicyType: 'ON_FAILURE' }, true);
    m.estados.set(nombre, [
      { state: 'restarting', exitCode: 1, restartCount: 1 },
      { state: 'exited', exitCode: 1, restartCount: 1 },
    ]);

    const dep = await volverA(s.id, imagen);
    expect(dep.status, dep.error ?? '').toBe('success');
    expect(dep.logs).toMatch(/Docker lo reintenta según la política del repositorio/);
    expect(dep.logs).toMatch(/El puerto 3000 acepta conexiones/);
    expect(m.eventos).not.toContain(`renombrar:${nombre}--prev>${nombre}`);
  });

  it('sin política que reintente, la caída al arrancar sigue siendo un fallo inmediato', async () => {
    const { s, nombre, imagen } = servicioGit({ restartPolicyType: 'NEVER' }, true);
    m.estados.set(nombre, [{ state: 'exited', exitCode: 1 }]);

    const dep = await volverA(s.id, imagen);
    expect(dep.status).toBe('failed');
    expect(dep.error).toMatch(/el proceso finalizó durante el arranque \(código 1\)/);
    expect(m.eventos).toContain(`renombrar:${nombre}--prev>${nombre}`);
  });

  it('con los reintentos de ON_FAILURE agotados, no se espera más', async () => {
    const { s, nombre, imagen } = servicioGit({ restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 2 }, false);
    setEnv(s.id, { RAILWAY_HEALTHCHECK_TIMEOUT_SEC: '20' });
    m.estados.set(nombre, [
      { state: 'restarting', exitCode: 1, restartCount: 1 },
      { state: 'exited', exitCode: 1, restartCount: 2 },
      { state: 'exited', exitCode: 1, restartCount: 2 },
    ]);

    const inicio = Date.now();
    const dep = await volverA(s.id, imagen);
    expect(dep.status).toBe('failed');
    expect(dep.error).toMatch(/continúa finalizando y reiniciándose \(código 1\)/);
    expect(Date.now() - inicio).toBeLessThan(10_000);
  });
});
