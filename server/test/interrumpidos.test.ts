/**
 * Despliegues cortados por un reinicio de Skyway (un `skyway update` a mitad de
 * un build): antes quedaban como fallidos sin alerta ni reintento, y el servicio
 * seguía en la versión anterior sin que nadie lo supiera. Ahora, al arrancar,
 * cada servicio cuyo último despliegue quedó cortado recibe una alerta y, una
 * sola vez, un reintento (si el reintento también se corta, solo la alerta: un
 * build que tumba Skyway reintentado siempre sería un bucle de reinicios).
 *
 * Sin Docker: los reintentos fallan enseguida («Docker no está disponible»),
 * que aquí no importa; lo que se comprueba es qué se encola y qué se avisa.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDb,
  createDeployment,
  createProject,
  createService,
  initDb,
  listAlerts,
  listDeployments,
  markStaleDeploymentsFailed,
  updateDeployment,
} from '../src/db';
import { awaitDeployment, resumeInterruptedDeployments, RETRY_TRIGGER, triggerDeploy } from '../src/deploy/deployer';

beforeAll(() => {
  initDb();
});

afterAll(() => {
  closeDb();
});

function servicio(nombre: string) {
  const p = createProject(nombre, nombre.toLowerCase());
  return createService(p.id, 'web', 'web', 'git', {
    repoUrl: 'https://github.com/acme/web',
    branch: 'main',
    port: 3000,
    domains: [],
    webhookSecret: 'x',
  } as any);
}

/** Espera a que terminen los reintentos encolados (sin Docker fallan al momento). */
async function esperarReintentos(serviceId: string) {
  for (const d of listDeployments(serviceId, 10).filter((d) => d.trigger === RETRY_TRIGGER)) {
    await awaitDeployment(d.id, 10_000);
  }
}

describe('despliegues interrumpidos por un reinicio', () => {
  it('al arrancar se avisa y se reintentan una vez; un segundo arranque no repite nada', async () => {
    const s = servicio('Uno');
    const cortado = createDeployment(s.id, 'webhook');
    updateDeployment(cortado.id, { status: 'building', commit_sha: 'a'.repeat(40) });

    expect(markStaleDeploymentsFailed()).toBeGreaterThanOrEqual(1);
    const r = resumeInterruptedDeployments();
    expect(r.retried).toBe(1);
    expect(r.alerted).toBe(1);

    const reintentos = listDeployments(s.id, 10).filter((d) => d.trigger === RETRY_TRIGGER);
    expect(reintentos).toHaveLength(1);
    const alerta = listAlerts({ openOnly: true }).find((a) => a.service_id === s.id && a.type === 'deploy_interrupted');
    expect(alerta?.message).toMatch(/se ha vuelto a lanzar una vez/i);
    await esperarReintentos(s.id);

    // Ya tratado: el siguiente arranque no lo vuelve a reintentar.
    expect(resumeInterruptedDeployments()).toEqual({ retried: 0, alerted: 0 });
  });

  it('si el reintento también se corta, no se reintenta otra vez', async () => {
    const s = servicio('Dos');
    const reintento = createDeployment(s.id, RETRY_TRIGGER);
    updateDeployment(reintento.id, { status: 'deploying' });

    markStaleDeploymentsFailed();
    const r = resumeInterruptedDeployments();
    expect(r.retried).toBe(0);
    expect(r.alerted).toBe(1);
    expect(listDeployments(s.id, 10)).toHaveLength(1);
    const alerta = listAlerts({ openOnly: true }).find((a) => a.service_id === s.id && a.type === 'deploy_interrupted');
    expect(alerta?.message).toMatch(/no se vuelve a intentar/i);
    // No volvía a ninguna versión: se ofrece «Desplegar».
    expect(alerta?.rollback_to ?? null).toBeNull();
    expect(alerta?.explanation).toMatch(/pulsa «Desplegar»/);
  });

  it('si se corta el reintento de una vuelta atrás, la alerta ofrece volver a esa versión, no desplegar la cabeza', async () => {
    const s = servicio('Cinco');
    const buena = createDeployment(s.id, 'manual');
    updateDeployment(buena.id, { status: 'success', image_tag: 'skyway/cinco-web:aaaa1111', commit_sha: 'a'.repeat(40), finished_at: Date.now() });
    await new Promise((r) => setTimeout(r, 5));
    const reintento = createDeployment(s.id, RETRY_TRIGGER, 'skyway/cinco-web:aaaa1111');
    updateDeployment(reintento.id, { status: 'deploying' });

    markStaleDeploymentsFailed();
    expect(resumeInterruptedDeployments().retried).toBe(0);
    const alerta = listAlerts({ openOnly: true }).find((a) => a.service_id === s.id && a.type === 'deploy_interrupted');
    expect(alerta?.rollback_to).toBe(buena.id);
    expect(alerta?.explanation).toMatch(/«Volver a esta versión»/);
  });

  it('la alerta de una vuelta atrás fallida apunta a la versión a la que se volvía', async () => {
    const s = servicio('Seis');
    const buena = createDeployment(s.id, 'manual');
    updateDeployment(buena.id, { status: 'success', image_tag: 'skyway/seis-web:bbbb2222', commit_sha: 'b'.repeat(40), finished_at: Date.now() });

    // Sin Docker falla al momento; lo que importa es la alerta.
    const vuelta = triggerDeploy(s.id, 'rollback', { imageTag: 'skyway/seis-web:bbbb2222' });
    await awaitDeployment(vuelta.id, 10_000);
    const alerta = listAlerts({ openOnly: true }).find((a) => a.service_id === s.id && a.type === 'deploy_failed');
    expect(alerta?.rollback_to).toBe(buena.id);
  });

  it('una vuelta atrás cortada se reintenta como vuelta atrás, con la misma imagen', async () => {
    const s = servicio('Tres');
    const vuelta = createDeployment(s.id, 'rollback', 'skyway/tres-web:12345678');
    updateDeployment(vuelta.id, { status: 'building' });

    markStaleDeploymentsFailed();
    resumeInterruptedDeployments();
    const reintento = listDeployments(s.id, 10).find((d) => d.trigger === RETRY_TRIGGER);
    expect(reintento?.image_tag).toBe('skyway/tres-web:12345678');
    await esperarReintentos(s.id);
  });

  it('solo cuenta el ÚLTIMO despliegue de cada servicio: si después hubo otro, no hay nada que reanudar', async () => {
    const s = servicio('Cuatro');
    const viejo = createDeployment(s.id, 'manual');
    updateDeployment(viejo.id, { status: 'building' });
    markStaleDeploymentsFailed();
    // Un despliegue posterior (lanzado a mano antes del tratamiento, por ejemplo).
    await new Promise((r) => setTimeout(r, 5));
    const nuevo = createDeployment(s.id, 'manual');
    updateDeployment(nuevo.id, { status: 'success', finished_at: Date.now() });

    expect(resumeInterruptedDeployments().retried).toBe(0);
  });
});
