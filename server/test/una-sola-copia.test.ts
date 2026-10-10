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
 * y cuántas copias del servicio hay en marcha a la vez. La parada del doble
 * tarda (como la de verdad) y anota `parada:<nombre>` al terminar: si el
 * desplegador no la esperara, el arranque de la nueva quedaría delante.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, createDeployment, createProject, createService, getDeployment, initDb, updateDeployment } from '../src/db';
import { awaitDeployment, cancelDeployment, triggerDeploy } from '../src/deploy/deployer';

const m = vi.hoisted(() => ({
  eventos: [] as string[],
  /** Contenedores que existen: en marcha o no, y de qué servicio son. */
  contenedores: new Map<string, { running: boolean; serviceId: string }>(),
  /** Máximo de copias en marcha a la vez, por servicio. */
  maximo: new Map<string, number>(),
  /** Estados que irá devolviendo `getRuntime` para un contenedor antes de «running». */
  estados: new Map<string, { state: string; exitCode: number | null }[]>(),
  /** Cuánto tarda en pararse cada copia (ms); por defecto, 20. */
  espera: new Map<string, number>(),
  /** Copias cuya parada falla (el daemon no responde). */
  fallan: new Set<string>(),
  /** Comando al parar con el que se paró cada copia. */
  comandos: new Map<string, string | null | undefined>(),
  /** Se llama al empezar cada parada (para cancelar a mitad). */
  alParar: null as ((nombre: string) => void) | null,
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
    pararConGracia: vi.fn(async (name: string, opts: { graciaSegundos: number; comando?: string | null }) => {
      const c = m.contenedores.get(name);
      if (!c) return { existia: false, forzada: false, comando: null };
      m.eventos.push(`parar:${name}(t=${opts.graciaSegundos})`);
      m.comandos.set(name, opts.comando);
      m.alParar?.(name);
      await new Promise((r) => setTimeout(r, m.espera.get(name) ?? 20));
      if (m.fallan.has(name)) {
        m.eventos.push(`fallo-parada:${name}`);
        throw new Error('el daemon no responde');
      }
      c.running = false;
      m.eventos.push(`parada:${name}`);
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
  m.espera.clear();
  m.fallan.clear();
  m.comandos.clear();
  m.alParar = null;
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
function servicioGit(cfg: Record<string, unknown> = {}) {
  const p = createProject('Bot', `bot-${Math.random().toString(36).slice(2, 8)}`);
  const s = createService(p.id, 'bot', 'bot', 'git', {
    repoUrl: 'https://github.com/acme/bot',
    branch: 'main',
    port: 3000,
    domains: [],
    webhookSecret: 'x',
    ...cfg,
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
    const parada = idx(`parada:${base}--prev`);
    const crear = idx(`crear:${base}`);
    expect(renombrar).toBeGreaterThan(-1);
    expect(parar).toBeGreaterThan(renombrar);
    // Se ESPERA a que la anterior termine antes de crear la nueva.
    expect(parada).toBeGreaterThan(parar);
    expect(crear).toBeGreaterThan(parada);
    // El registro se archiva después de parar (conserva el cierre) y antes de arrancar la nueva.
    expect(idx(`archivar:${base}--prev`)).toBeGreaterThan(parada);
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
    expect(idx(`parada:${base}--prev`)).toBeGreaterThan(-1);
    expect(idx(`parada:${base}--prev`)).toBeLessThan(primerCrear);
    expect(idx(`parada:${base}-r2--prev`)).toBeGreaterThan(-1);
    expect(idx(`parada:${base}-r2--prev`)).toBeLessThan(primerCrear);
    // En paralelo: las dos paradas empiezan antes de que termine ninguna.
    const primeraParada = m.eventos.findIndex((e) => e.startsWith('parada:'));
    expect(idx(`parar:${base}--prev(t=30)`)).toBeLessThan(primeraParada);
    expect(idx(`parar:${base}-r2--prev(t=30)`)).toBeLessThan(primeraParada);
    expect(m.eventos.filter((e) => e.startsWith('crear:'))).toEqual([`crear:${base}`, `crear:${base}-r2`]);
    expect(m.maximo.get(s.id)).toBe(2);
    // Sin tráfico y con varias réplicas: el registro avisa de las copias permanentes.
    expect(dep.logs).toMatch(/con 2 réplicas hay 2 copias en marcha a la vez de forma permanente/);
  });

  it('al reducir réplicas, la sobrante también se para antes de arrancar y no vuelve', async () => {
    const { s, base } = servicioImagen({ replicas: 1 }, 2);
    const dep = await desplegar(s.id);
    expect(dep.status, dep.error ?? '').toBe('success');
    expect(idx(`parada:${base}-r2--prev`)).toBeLessThan(idx(`crear:${base}`));
    expect(m.contenedores.has(`${base}-r2`)).toBe(false);
    expect(m.contenedores.has(`${base}-r2--prev`)).toBe(false);
  });

  it('si una copia nueva falla, se paran y retiran las nuevas y se restauran TODAS las anteriores', async () => {
    const { s, base } = servicioImagen({ replicas: 2 }, 2);
    m.estados.set(`${base}-r2`, Array.from({ length: 10 }, () => ({ state: 'exited', exitCode: 1 })));
    const dep = await desplegar(s.id);
    expect(dep.status).toBe('failed');
    expect(dep.error).toMatch(/La versión nueva falló \(réplica 2\/2: .*código 1.*\)\. Se restauró la versión anterior automáticamente\./);

    const ultimaParada = Math.max(idx(`parada:${base}`), idx(`parada:${base}-r2`));
    expect(idx(`parar:${base}(t=30)`)).toBeGreaterThan(idx(`crear:${base}`));
    expect(idx(`parar:${base}-r2(t=30)`)).toBeGreaterThan(idx(`crear:${base}-r2`));
    expect(idx(`borrar:${base}`)).toBeGreaterThan(idx(`parada:${base}`));
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
    expect(idx(`borrar:${base}--next`)).toBeGreaterThan(idx(`parada:${base}--next`));
    // La anterior se retira después de que la nueva esté en marcha, y se
    // archiva y se borra después de pararla.
    expect(idx(`parar:${base}--prev(t=30)`)).toBeGreaterThan(idx(`crear:${base}`));
    expect(idx(`archivar:${base}--prev`)).toBeGreaterThan(idx(`parada:${base}--prev`));
    expect(idx(`borrar:${base}--prev`)).toBeGreaterThan(idx(`parada:${base}--prev`));
    // La anterior y la nueva; y, unos instantes, la «--next» validada, que ya
    // ha recibido SIGTERM y se para en segundo plano mientras sigue el relevo.
    expect(m.maximo.get(s.id)).toBeGreaterThanOrEqual(2);
    expect(m.maximo.get(s.id)).toBeLessThanOrEqual(3);
  });

  it('la parada de la «--next» validada no retrasa el relevo, pero el despliegue la espera; y va sin el comando al parar', async () => {
    const { s, base } = servicioImagen({ image: 'nginx:alpine', port: 80, domains: ['bot.acme.es'], stopCommand: 'curl -s "$URL/deleteWebhook"' });
    m.espera.set(`${base}--next`, 300);
    const dep = await desplegar(s.id);
    expect(dep.status, dep.error ?? '').toBe('success');
    // La copia nueva se crea mientras la «--next» aún se está parando…
    expect(idx(`crear:${base}`)).toBeGreaterThan(idx(`parar:${base}--next(t=30)`));
    expect(idx(`crear:${base}`)).toBeLessThan(idx(`parada:${base}--next`));
    // …y el despliegue no termina sin haberla retirado.
    expect(idx(`borrar:${base}--next`)).toBeGreaterThan(idx(`parada:${base}--next`));
    expect(m.contenedores.has(`${base}--next`)).toBe(false);
    // El comando al parar no se ejecuta en la copia de validación; sí en la anterior.
    expect(m.comandos.get(`${base}--next`)).toBeNull();
    expect(m.comandos.get(`${base}--prev`)).toBe('curl -s "$URL/deleteWebhook"');
    expect(dep.logs).toMatch(/Con «sin corte», el comando al parar de la versión anterior se ejecuta cuando la nueva ya está en servicio/);
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

describe('paradas que fallan y cancelaciones', () => {
  it('si una parada falla, se espera a las demás y se restauran todas sin arrancar la nueva', async () => {
    const { s, base } = servicioImagen({ replicas: 2 }, 2);
    m.fallan.add(`${base}-r2--prev`);
    m.espera.set(`${base}-r2--prev`, 5);
    m.espera.set(`${base}--prev`, 120);
    const dep = await desplegar(s.id);
    expect(dep.status).toBe('failed');
    expect(dep.error).toMatch(/No se pudo detener la versión anterior \(el daemon no responde\): sigue en servicio y no se ha arrancado la nueva/);
    expect(m.eventos.some((e) => e.startsWith('crear:'))).toBe(false);
    // La restauración espera a la parada lenta: si no, la copia «restaurada»
    // caería después por su parada pendiente.
    expect(idx(`renombrar:${base}--prev>${base}`)).toBeGreaterThan(idx(`parada:${base}--prev`));
    expect(idx(`renombrar:${base}-r2--prev>${base}-r2`)).toBeGreaterThan(idx(`parada:${base}--prev`));
    expect(m.contenedores.get(base)?.running).toBe(true);
    expect(m.contenedores.get(`${base}-r2`)?.running).toBe(true);
  });

  it('«Cancelar» durante la parada surte efecto al terminarla: se restaura la anterior y el despliegue queda cancelado', async () => {
    const { s, base } = servicioImagen({});
    const dep = triggerDeploy(s.id, 'manual');
    m.alParar = (nombre) => {
      if (nombre === `${base}--prev`) cancelDeployment(dep.id);
    };
    const fin = getDeployment((await awaitDeployment(dep.id, 60_000))!.id)!;
    expect(fin.status).toBe('canceled');
    expect(fin.logs).toMatch(/Despliegue cancelado: restaurando la versión anterior/);
    expect(fin.logs).not.toMatch(/La versión nueva falló/);
    expect(m.eventos.some((e) => e.startsWith('crear:'))).toBe(false);
    expect(idx(`arrancar:${base}`)).toBeGreaterThan(idx(`parada:${base}--prev`));
    expect(m.contenedores.get(base)?.running).toBe(true);
  });
});

describe('lo que la regla automática no ve, en el registro', () => {
  it('un servicio con puerto que pasa solo a una sola copia: se explica cómo volver a «sin corte»', async () => {
    const { s, imagen } = servicioGit();
    const dep = await desplegar(s.id, 'rollback', imagen);
    expect(dep.status, dep.error ?? '').toBe('success');
    expect(dep.logs).toMatch(/ℹ Una sola copia elegida automáticamente: .*elige «Sin corte» en Ajustes del servicio → Despliegue y parada/);
  });

  it('un bot con healthcheck queda «sin corte»: el registro avisa del 409 de la segunda copia', async () => {
    const { s, base, imagen } = servicioGit({
      healthcheckPath: '/health',
      needs: { engines: [], sources: [], bots: [{ proveedor: 'telegram', evidencia: 'package.json: telegraf' }], detectedAt: 1 },
    });
    const dep = await desplegar(s.id, 'rollback', imagen);
    expect(dep.status, dep.error ?? '').toBe('success');
    expect(dep.logs).toMatch(/Estrategia: sin corte/);
    expect(dep.logs).toMatch(
      /ℹ El repositorio usa una biblioteca de bots \(package\.json: telegraf\) y el servicio se despliega «sin corte» por su ruta de healthcheck: .*409.*«Una sola copia»/,
    );
    expect(idx(`crear:${base}--next`)).toBeGreaterThan(-1);
    // Con una biblioteca de bots no se sugiere «sin corte».
    expect(dep.logs).not.toMatch(/Una sola copia elegida automáticamente/);
  });
});
