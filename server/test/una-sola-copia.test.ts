/**
 * «Una sola copia» (estrategia 'recreate').
 *
 * Un bot de polling o un worker sin dominio se desplegaba siempre «sin corte»:
 * la copia de validación «--next» arrancaba con el mismo entorno mientras la
 * anterior seguía en marcha, así que durante el intercambio había DOS copias
 * del bot (Telegram responde 409 a la segunda que pide actualizaciones) y la
 * «--next» se retiraba con SIGKILL. Ahora, sin dominio, healthcheck ni
 * llamadas de otros servicios, se detiene la versión anterior (con parada
 * limpia) antes de arrancar la nueva, sin «--next», por cualquier camino que
 * despliegue (manual, volver atrás, cambio de dominio, pestaña Correo…).
 *
 * Sin Docker: un doble en memoria anota cada operación sobre los contenedores
 * y cuántas copias del servicio hay en marcha a la vez.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, createDeployment, createProject, createService, getDeployment, initDb, updateDeployment } from '../src/db';
import { awaitDeployment, triggerDeploy } from '../src/deploy/deployer';

const m = vi.hoisted(() => ({
  eventos: [] as string[],
  /** Contenedores que existen: en marcha o no, y de qué servicio son. */
  contenedores: new Map<string, { running: boolean; serviceId: string }>(),
  /** Máximo de copias en marcha a la vez, por servicio. */
  maximo: new Map<string, number>(),
  /** Estados que irá devolviendo `getRuntime` para un contenedor antes de «running». */
  estados: new Map<string, { state: string; exitCode: number | null }[]>(),
}));

function contar(serviceId: string): void {
  const n = [...m.contenedores.values()].filter((c) => c.serviceId === serviceId && c.running).length;
  m.maximo.set(serviceId, Math.max(m.maximo.get(serviceId) ?? 0, n));
}

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
vi.mock('../src/monitor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/monitor')>()),
  markManualAction: vi.fn(() => {
    m.eventos.push('accion-manual');
  }),
}));
vi.mock('../src/docker/containers', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/docker/containers')>();
  return {
    ...mod,
    findContainer: vi.fn(async (name: string) => {
      const c = m.contenedores.get(name);
      return c ? { Config: { Labels: { 'skyway.deployment': 'dep-anterior' } }, State: { Running: c.running } } : null;
    }),
    listServiceContainers: vi.fn(async (serviceId: string) =>
      [...m.contenedores].filter(([, c]) => c.serviceId === serviceId).map(([name]) => ({ id: `id-${name}`, name })),
    ),
    runServiceContainer: vi.fn(async (spec: Parameters<typeof mod.runServiceContainer>[0]) => {
      const name = spec.nameOverride ?? mod.containerName(spec.project, spec.service);
      m.eventos.push(`crear:${name}`);
      m.contenedores.set(name, { running: true, serviceId: spec.service.id });
      contar(spec.service.id);
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
    pararConGracia: vi.fn(async (name: string, opts: { graciaSegundos: number }) => {
      const c = m.contenedores.get(name);
      if (!c) return { existia: false, forzada: false, comando: null };
      m.eventos.push(`parar:${name}(t=${opts.graciaSegundos})`);
      c.running = false;
      return { existia: true, forzada: false, comando: null };
    }),
    startContainer: vi.fn(async (name: string) => {
      m.eventos.push(`arrancar:${name}`);
      const c = m.contenedores.get(name);
      if (c) {
        c.running = true;
        contar(c.serviceId);
      }
    }),
    getRuntime: vi.fn(async (name: string) => {
      const c = m.contenedores.get(name);
      const siguiente = c ? m.estados.get(name)?.shift() : undefined;
      if (siguiente) return { startedAt: null, restartCount: 0, image: 'x', ...siguiente };
      if (!c) return { state: 'not_created', startedAt: null, exitCode: null, restartCount: 0, image: null };
      return c.running
        ? { state: 'running', startedAt: new Date().toISOString(), exitCode: null, restartCount: 0, image: 'x' }
        : { state: 'exited', startedAt: null, exitCode: 0, restartCount: 0, image: 'x' };
    }),
    // Sondas TCP/HTTP de la validación: siempre responden.
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

beforeAll(() => {
  initDb();
});

afterAll(() => {
  closeDb();
});

beforeEach(() => {
  m.eventos.length = 0;
  m.contenedores.clear();
  m.maximo.clear();
  m.estados.clear();
});

/** Proyecto nuevo con un servicio de imagen; `copias` = réplicas ya en marcha. */
function servicioImagen(cfg: Record<string, unknown>, copias = 1) {
  const p = createProject('Bots', `bots-${Math.random().toString(36).slice(2, 8)}`);
  const s = createService(p.id, 'bot', 'bot', 'image', { image: 'busybox:stable', domains: [], ...cfg } as any);
  const base = `skyway-${p.slug}-bot`;
  for (let i = 1; i <= copias; i++) m.contenedores.set(i === 1 ? base : `${base}-r${i}`, { running: true, serviceId: s.id });
  return { s, base };
}

/** Servicio de repositorio sin dominio con una versión ya construida (para volver a ella sin build). */
function servicioGit() {
  const p = createProject('Bot', `bot-${Math.random().toString(36).slice(2, 8)}`);
  const s = createService(p.id, 'bot', 'bot', 'git', {
    repoUrl: 'https://github.com/acme/bot',
    branch: 'main',
    port: 3000,
    domains: [],
    webhookSecret: 'x',
  } as any);
  const imagen = `skyway/${p.slug}-bot:abc1234`;
  const previo = createDeployment(s.id, 'manual');
  updateDeployment(previo.id, { status: 'success', image_tag: imagen, commit_sha: 'abc1234' });
  const base = `skyway-${p.slug}-bot`;
  m.contenedores.set(base, { running: true, serviceId: s.id });
  return { s, base, imagen };
}

async function desplegar(serviceId: string, trigger = 'manual', imageTag?: string) {
  const dep = triggerDeploy(serviceId, trigger, imageTag ? { imageTag } : {});
  const fin = await awaitDeployment(dep.id, 60_000);
  return getDeployment(fin!.id)!;
}

const idx = (evento: string) => m.eventos.indexOf(evento);

describe('una sola copia por defecto en servicios sin tráfico', () => {
  it('un bot sin puerto ni dominio: se para la versión anterior antes de crear la nueva, sin «--next»', async () => {
    const { s, base } = servicioImagen({});
    const dep = await desplegar(s.id);
    expect(dep.status, dep.error ?? '').toBe('success');

    const renombrar = idx(`renombrar:${base}>${base}--prev`);
    const parar = idx(`parar:${base}--prev(t=30)`);
    const crear = idx(`crear:${base}`);
    expect(renombrar).toBeGreaterThan(-1);
    expect(parar).toBeGreaterThan(renombrar);
    expect(crear).toBeGreaterThan(parar);
    // El registro se archiva después de parar (conserva el cierre) y antes de arrancar la nueva.
    expect(idx(`archivar:${base}--prev`)).toBeGreaterThan(parar);
    expect(idx(`borrar:${base}--prev`)).toBeGreaterThan(crear);
    expect(m.eventos.some((e) => e.includes('--next'))).toBe(false);
    expect(m.maximo.get(s.id)).toBe(1);
    expect(dep.logs).toMatch(/Estrategia: una sola copia \(sin dominio, healthcheck ni llamadas de otros servicios\)\. Parada: SIGTERM y 30 s de gracia\./);
    expect(dep.logs).toMatch(/Una sola copia: se detiene la versión anterior antes de arrancar la nueva/);
    expect(dep.logs).toMatch(/Versión nueva en marcha \(una sola copia: la anterior se detuvo antes de arrancarla\)/);
  });

  it('marca la acción manual antes de parar: el monitor no abre una caída', async () => {
    const { s, base } = servicioImagen({});
    const dep = await desplegar(s.id);
    expect(dep.status, dep.error ?? '').toBe('success');
    const manual = m.eventos.lastIndexOf('accion-manual', idx(`parar:${base}--prev(t=30)`));
    expect(manual).toBeGreaterThan(idx(`renombrar:${base}>${base}--prev`));
  });

  it('con 2 réplicas, las dos copias anteriores se paran antes del primer arranque', async () => {
    const { s, base } = servicioImagen({ replicas: 2 }, 2);
    const dep = await desplegar(s.id);
    expect(dep.status, dep.error ?? '').toBe('success');

    const primerCrear = m.eventos.findIndex((e) => e.startsWith('crear:'));
    expect(idx(`parar:${base}--prev(t=30)`)).toBeGreaterThan(-1);
    expect(idx(`parar:${base}--prev(t=30)`)).toBeLessThan(primerCrear);
    expect(idx(`parar:${base}-r2--prev(t=30)`)).toBeGreaterThan(-1);
    expect(idx(`parar:${base}-r2--prev(t=30)`)).toBeLessThan(primerCrear);
    expect(m.eventos.filter((e) => e.startsWith('crear:'))).toEqual([`crear:${base}`, `crear:${base}-r2`]);
    expect(m.maximo.get(s.id)).toBe(2);
    // Sin tráfico y con varias réplicas: el registro avisa de las copias permanentes.
    expect(dep.logs).toMatch(/con 2 réplicas hay 2 copias en marcha a la vez de forma permanente/);
  });

  it('al reducir réplicas, la sobrante también se para antes de arrancar y no vuelve', async () => {
    const { s, base } = servicioImagen({ replicas: 1 }, 2);
    const dep = await desplegar(s.id);
    expect(dep.status, dep.error ?? '').toBe('success');
    expect(idx(`parar:${base}-r2--prev(t=30)`)).toBeLessThan(idx(`crear:${base}`));
    expect(m.contenedores.has(`${base}-r2`)).toBe(false);
    expect(m.contenedores.has(`${base}-r2--prev`)).toBe(false);
  });

  it('si una copia nueva falla, se paran y retiran las nuevas y se restauran TODAS las anteriores', async () => {
    const { s, base } = servicioImagen({ replicas: 2 }, 2);
    m.estados.set(`${base}-r2`, Array.from({ length: 10 }, () => ({ state: 'exited', exitCode: 1 })));
    const dep = await desplegar(s.id);
    expect(dep.status).toBe('failed');
    expect(dep.error).toMatch(/La versión nueva falló \(réplica 2\/2: .*código 1.*\)\. Se restauró la versión anterior automáticamente\./);

    const ultimaParada = Math.max(idx(`parar:${base}(t=30)`), idx(`parar:${base}-r2(t=30)`));
    expect(idx(`parar:${base}(t=30)`)).toBeGreaterThan(idx(`crear:${base}`));
    expect(idx(`parar:${base}-r2(t=30)`)).toBeGreaterThan(idx(`crear:${base}-r2`));
    expect(idx(`borrar:${base}`)).toBeGreaterThan(idx(`parar:${base}(t=30)`));
    expect(idx(`renombrar:${base}--prev>${base}`)).toBeGreaterThan(ultimaParada);
    expect(idx(`renombrar:${base}-r2--prev>${base}-r2`)).toBeGreaterThan(ultimaParada);
    expect(m.eventos).toContain(`arrancar:${base}`);
    expect(m.eventos).toContain(`arrancar:${base}-r2`);
    expect(m.contenedores.get(base)?.running).toBe(true);
    expect(m.contenedores.get(`${base}-r2`)?.running).toBe(true);
    // Nunca más de dos copias en marcha a la vez (las anteriores, o las nuevas).
    expect(m.maximo.get(s.id)).toBe(2);
  });

  it('primer despliegue que falla: sin anteriores que restaurar', async () => {
    const { s, base } = servicioImagen({}, 0);
    m.estados.set(base, [{ state: 'exited', exitCode: 1 }]);
    const dep = await desplegar(s.id);
    expect(dep.status).toBe('failed');
    expect(dep.error).toMatch(/El contenedor terminó inesperadamente \(.*\)\. Consulta el registro del servicio\./);
    expect(m.contenedores.has(base)).toBe(false);
  });
});

describe('sin corte y estrategia elegida', () => {
  it('una web con dominio sigue «sin corte», y la «--next» se para con gracia antes de retirarla', async () => {
    const { s, base } = servicioImagen({ image: 'nginx:alpine', port: 80, domains: ['bot.acme.es'] });
    const dep = await desplegar(s.id);
    expect(dep.status, dep.error ?? '').toBe('success');
    expect(dep.logs).toMatch(/Estrategia: sin corte \(recibe tráfico: dominio, healthcheck o llamadas de otros servicios\)/);
    expect(idx(`crear:${base}--next`)).toBeGreaterThan(-1);
    expect(idx(`parar:${base}--next(t=30)`)).toBeGreaterThan(idx(`crear:${base}--next`));
    expect(idx(`borrar:${base}--next`)).toBeGreaterThan(idx(`parar:${base}--next(t=30)`));
    // La anterior se retira después de que la nueva esté en marcha.
    expect(idx(`parar:${base}--prev(t=30)`)).toBeGreaterThan(idx(`crear:${base}`));
    expect(m.maximo.get(s.id)).toBe(2);
  });

  it('una web con «Una sola copia» elegida en Ajustes no crea «--next»', async () => {
    const { s, base } = servicioImagen({ image: 'nginx:alpine', port: 80, domains: ['bot.acme.es'], deployStrategy: 'recreate' });
    const dep = await desplegar(s.id);
    expect(dep.status, dep.error ?? '').toBe('success');
    expect(dep.logs).toMatch(/Estrategia: una sola copia \(elegida en Ajustes\)/);
    expect(m.eventos.some((e) => e.includes('--next'))).toBe(false);
    expect(idx(`parar:${base}--prev(t=30)`)).toBeLessThan(idx(`crear:${base}`));
    expect(m.maximo.get(s.id)).toBe(1);
  });

  it('«Sin corte» elegido con un volumen se despliega con una sola copia', async () => {
    const { s, base } = servicioImagen({ deployStrategy: 'overlap', volumes: [{ name: 'vol-bot', containerPath: '/data' }] });
    const dep = await desplegar(s.id);
    expect(dep.status, dep.error ?? '').toBe('success');
    expect(dep.logs).toMatch(/Estrategia: una sola copia \(tiene volúmenes o puerto público\)/);
    expect(m.eventos.some((e) => e.includes('--next'))).toBe(false);
    expect(idx(`parar:${base}--prev(t=30)`)).toBeLessThan(idx(`crear:${base}`));
  });
});

describe('todos los caminos que despliegan siguen la misma estrategia', () => {
  it.each(['rollback', 'cambio-de-dominio', 'mailway'])('«%s» con la imagen en marcha: una sola copia', async (trigger) => {
    const { s, base, imagen } = servicioGit();
    const dep = await desplegar(s.id, trigger, imagen);
    expect(dep.status, dep.error ?? '').toBe('success');
    expect(dep.logs).toMatch(/Estrategia: una sola copia/);
    expect(m.eventos.some((e) => e.includes('--next'))).toBe(false);
    expect(idx(`parar:${base}--prev(t=30)`)).toBeGreaterThan(-1);
    expect(idx(`parar:${base}--prev(t=30)`)).toBeLessThan(idx(`crear:${base}`));
    expect(m.maximo.get(s.id)).toBe(1);
  });
});
