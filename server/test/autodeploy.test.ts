/**
 * Auto-deploy por sondeo a través de un reinicio de Skyway.
 *
 * La línea base del sondeo («última cabeza tratada») vivía solo en memoria: el
 * primer sondeo tras arrancar la fijaba en la cabeza ACTUAL, así que un push
 * hecho con Skyway parado (un `skyway update`) no se desplegaba nunca. Aquí el
 * reinicio se simula de verdad: `vi.resetModules()` y se vuelven a importar los
 * módulos, con la memoria del proceso anterior perdida y la base intacta.
 *
 * Sin Docker ni red: se sustituyen la consulta de la cabeza (`remoteHeadSha`) y
 * `triggerDeploy`, que solo anota qué servicio se habría desplegado.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ heads: {} as Record<string, string | null>, calls: [] as string[] }));

vi.mock('../src/docker/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/docker/client')>()),
  dockerAvailable: vi.fn(async () => true),
}));
vi.mock('../src/deploy/builder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/deploy/builder')>()),
  remoteHeadSha: vi.fn(async (repoUrl: string) => m.heads[repoUrl] ?? null),
}));
vi.mock('../src/deploy/deployer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/deploy/deployer')>()),
  triggerDeploy: vi.fn((serviceId: string) => {
    m.calls.push(serviceId);
    return { id: 'dep_falso', status: 'queued' };
  }),
}));

type Db = typeof import('../src/db');
type AutoDeploy = typeof import('../src/autodeploy');

/** Un «proceso» de Skyway: módulos recién importados, sin nada en memoria. */
async function arrancar(): Promise<{ db: Db; autodeploy: AutoDeploy }> {
  vi.resetModules();
  const db = await import('../src/db');
  db.initDb();
  const autodeploy = await import('../src/autodeploy');
  return { db, autodeploy };
}

/** Deja correr el sondeo (el primero sale a los 10 s del arranque, después cada 60 s). */
async function sondear(autodeploy: AutoDeploy, ms: number): Promise<void> {
  vi.useFakeTimers();
  try {
    autodeploy.startAutoDeploy({ warn: () => {} });
    await vi.advanceTimersByTimeAsync(ms);
  } finally {
    autodeploy.stopAutoDeploy();
    vi.useRealTimers();
  }
}

function crearServicio(db: Db, repoUrl: string) {
  const project = db.createProject(`P ${repoUrl.slice(-12)}`, `p-${Math.random().toString(36).slice(2, 8)}`);
  return db.createService(project.id, 'web', 'web', 'git', {
    repoUrl,
    branch: 'main',
    port: 3000,
    domains: [],
    webhookSecret: 'x',
    autoDeploy: true,
  } as any);
}

function desplegadoCon(db: Db, serviceId: string, sha: string, trigger = 'manual') {
  const d = db.createDeployment(serviceId, trigger);
  db.updateDeployment(d.id, { status: 'success', commit_sha: sha, finished_at: Date.now() });
}

beforeAll(async () => {
  await arrancar();
});

afterEach(() => {
  m.calls.length = 0;
});

describe('auto-deploy tras un reinicio', () => {
  it('despliega el commit que llegó mientras Skyway estaba parado', async () => {
    const url = 'https://example.com/acme/uno.git';
    let proceso = await arrancar();
    const s = crearServicio(proceso.db, url);
    desplegadoCon(proceso.db, s.id, 'a'.repeat(40));
    m.heads[url] = 'a'.repeat(40);
    await sondear(proceso.autodeploy, 11_000);
    expect(m.calls).toEqual([]); // la cabeza ya estaba desplegada

    // Push durante el `skyway update`: el proceso nuevo no lo ha visto llegar.
    m.heads[url] = 'b'.repeat(40);
    proceso = await arrancar();
    await sondear(proceso.autodeploy, 11_000);
    expect(m.calls).toEqual([s.id]);
  });

  it('un reinicio después de volver a una versión anterior no despliega otra vez la cabeza', async () => {
    const url = 'https://example.com/acme/dos.git';
    let proceso = await arrancar();
    const s = crearServicio(proceso.db, url);
    desplegadoCon(proceso.db, s.id, 'b'.repeat(40));
    m.heads[url] = 'b'.repeat(40);
    await sondear(proceso.autodeploy, 11_000);
    // Vuelta atrás al commit «a»: la cabeza de la rama sigue siendo «b».
    desplegadoCon(proceso.db, s.id, 'a'.repeat(40), 'rollback');

    proceso = await arrancar();
    await sondear(proceso.autodeploy, 11_000 + 3 * 60_000);
    expect(m.calls).toEqual([]);
  });

  it('al activar el auto-deploy, el primer sondeo solo fija la línea base', async () => {
    const url = 'https://example.com/acme/tres.git';
    const proceso = await arrancar();
    const s = crearServicio(proceso.db, url);
    desplegadoCon(proceso.db, s.id, 'a'.repeat(40));
    m.heads[url] = 'c'.repeat(40);
    await sondear(proceso.autodeploy, 11_000);
    expect(m.calls).toEqual([]);
    expect(proceso.db.getAutoDeployState(s.id)?.last_seen_sha).toBe('c'.repeat(40));

    // Lo que llegue después sí se despliega.
    m.heads[url] = 'd'.repeat(40);
    await sondear(proceso.autodeploy, 61_000);
    expect(m.calls).toEqual([s.id]);
  });
});

describe('auto-deploy frente a un despliegue manual fallido', () => {
  it('no vuelve a lanzar una cabeza nueva que alguien desplegó a mano y falló', async () => {
    // Push de un commit roto y «Desplegar» al momento, antes de que el sondeo
    // lo vea: el despliegue manual falla. Al cotejar solo con los correctos, el
    // siguiente sondeo lanzaba otro build del mismo commit, que fallaba igual.
    const url = 'https://example.com/acme/manual.git';
    const proceso = await arrancar();
    const s = crearServicio(proceso.db, url);
    desplegadoCon(proceso.db, s.id, 'a'.repeat(40));
    m.heads[url] = 'a'.repeat(40);
    await sondear(proceso.autodeploy, 11_000);

    m.heads[url] = 'e'.repeat(40);
    const d = proceso.db.createDeployment(s.id, 'manual');
    proceso.db.updateDeployment(d.id, { status: 'failed', commit_sha: 'e'.repeat(40), finished_at: Date.now() });
    await sondear(proceso.autodeploy, 61_000);
    expect(m.calls).toEqual([]);

    // El siguiente push sí se despliega.
    m.heads[url] = 'f'.repeat(40);
    await sondear(proceso.autodeploy, 61_000);
    expect(m.calls).toEqual([s.id]);
  });
});

describe('auto-deploy que no puede leer la rama', () => {
  it('guarda el error y avisa con una alerta pasados 15 minutos; al recuperarse la cierra', async () => {
    const url = 'https://example.com/acme/cuatro.git';
    const proceso = await arrancar();
    const s = crearServicio(proceso.db, url);
    m.heads[url] = null; // token caducado, App sin acceso o rama inexistente

    await sondear(proceso.autodeploy, 11_000 + 5 * 60_000);
    const estado = proceso.db.getAutoDeployState(s.id);
    expect(estado?.error).toMatch(/no se ha podido leer la rama «main»/);
    expect(estado?.failing_since).not.toBeNull();
    const abiertas = () => proceso.db.listAlerts({ openOnly: true }).filter((a) => a.service_id === s.id && a.type === 'autodeploy_failing');
    expect(abiertas()).toHaveLength(0); // aún no: un GitHub caído unos minutos no merece aviso

    await sondear(proceso.autodeploy, 16 * 60_000);
    expect(abiertas()).toHaveLength(1);
    expect(abiertas()[0].explanation).toMatch(/token de GitHub ha caducado/);

    m.heads[url] = 'e'.repeat(40);
    await sondear(proceso.autodeploy, 11_000);
    expect(abiertas()).toHaveLength(0);
    expect(proceso.db.getAutoDeployState(s.id)?.error).toBeNull();
  });

  it('al desactivar el auto-deploy se cierra su alerta, que ya no aplica', async () => {
    const url = 'https://example.com/acme/cinco.git';
    const proceso = await arrancar();
    const s = crearServicio(proceso.db, url);
    m.heads[url] = null;
    await sondear(proceso.autodeploy, 11_000 + 16 * 60_000);
    const abiertas = () => proceso.db.listAlerts({ openOnly: true }).filter((a) => a.service_id === s.id && a.type === 'autodeploy_failing');
    expect(abiertas()).toHaveLength(1);

    // Antes se borraba el estado pero la alerta seguía abierta hasta un despliegue correcto.
    proceso.db.updateService(s.id, s.name, { ...(s.config as object), autoDeploy: false } as any);
    await sondear(proceso.autodeploy, 61_000);
    expect(proceso.db.getAutoDeployState(s.id)).toBeUndefined();
    expect(abiertas()).toHaveLength(0);
  });
});
