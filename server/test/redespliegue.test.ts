/**
 * Redesplegar el mismo commit reutiliza la imagen ya construida (sin clonar ni
 * compilar), pero el manifiesto `skyway.json` se vuelve a aplicar: añadir el
 * dominio y redesplegar tiene que definir la URL propia, que es lo que promete
 * el plan («se definirá cuando lo tenga y vuelvas a desplegar»).
 *
 * Sin Docker: se sustituyen las llamadas a Docker, a GitHub y al constructor
 * (`cloneRepo` deja el repositorio simulado en el directorio de trabajo), y el
 * despliegue se detiene al preparar la red del contenedor, después de todo lo
 * que se quiere comprobar.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, createProject, createService, getDeployment, getEnv, getService, initDb, updateDeployment, updateService } from '../src/db';
import { cloneRepo, buildImage } from '../src/deploy/builder';
import { awaitDeployment, triggerDeploy } from '../src/deploy/deployer';
import type { GitConfig } from '../src/types';
import { resolveServiceEnv } from '../src/variables';

const mocks = vi.hoisted(() => ({ head: 'a'.repeat(40), repo: {} as Record<string, string> }));

vi.mock('../src/docker/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/docker/client')>();
  return { ...mod, dockerAvailable: vi.fn(async () => true) };
});
vi.mock('../src/docker/containers', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/docker/containers')>();
  return { ...mod, imageExists: vi.fn(async () => true) };
});
vi.mock('../src/docker/networks', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/docker/networks')>();
  return {
    ...mod,
    ensureNetwork: vi.fn(async () => {
      throw new Error('Sin Docker en las pruebas');
    }),
  };
});
vi.mock('../src/github/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/github/client')>();
  return { ...mod, apiHeadSha: vi.fn(async () => mocks.head) };
});
vi.mock('../src/deploy/builder', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/deploy/builder')>();
  return {
    ...mod,
    cloneRepo: vi.fn(async (opts: { dest: string }) => {
      fs.rmSync(opts.dest, { recursive: true, force: true });
      fs.mkdirSync(opts.dest, { recursive: true });
      for (const [name, text] of Object.entries(mocks.repo)) fs.writeFileSync(path.join(opts.dest, name), text);
      return { commitSha: mocks.head, commitMsg: 'Primera versión' };
    }),
    buildImage: vi.fn(async () => ({ varsDelBuild: {} })),
  };
});

beforeAll(() => {
  initDb();
});

afterAll(() => {
  closeDb();
});

beforeEach(() => {
  vi.mocked(cloneRepo).mockClear();
  vi.mocked(buildImage).mockClear();
});

/** Despliega y espera a que termine. Sin Docker acaba en «failed» al preparar la red, después del build. */
async function deploy(serviceId: string, trigger: string) {
  const dep = triggerDeploy(serviceId, trigger);
  const done = await awaitDeployment(dep.id, 15_000);
  expect(done?.status).toBe('failed');
  expect(done?.error).toMatch(/Sin Docker en las pruebas/);
  return getDeployment(dep.id)!;
}

/** Web con su manifiesto, desplegada una vez sin dominio; ese despliegue se da por correcto. */
async function deployedWithoutDomain(slug: string, manifest: unknown) {
  mocks.repo = { 'package.json': JSON.stringify({ name: slug }), 'skyway.json': JSON.stringify(manifest) };
  const project = createProject(`Proyecto ${slug}`, `proyecto-${slug}`);
  const cfg: GitConfig = { repoUrl: `https://github.com/acme/${slug}`, branch: 'main', port: 3000, domains: [], webhookSecret: 'w' };
  const svc = createService(project.id, slug, slug, 'git', cfg);
  const first = await deploy(svc.id, 'initial');
  expect(vi.mocked(cloneRepo)).toHaveBeenCalledTimes(1);
  expect(first.commit_sha).toBe(mocks.head);
  expect(first.image_tag).toBeTruthy();
  // Lo que habría hecho un despliegue con Docker: terminar bien con esa imagen.
  updateDeployment(first.id, { status: 'success' });
  // El usuario añade el dominio y pulsa «Redesplegar» (sin «Reconstruir»).
  const fresh = getService(svc.id)!;
  updateService(svc.id, fresh.name, { ...(fresh.config as GitConfig), domains: [`${slug}.example.com`] });
  vi.mocked(cloneRepo).mockClear();
  vi.mocked(buildImage).mockClear();
  return svc;
}

describe('redesplegar el mismo commit', () => {
  it('reutiliza la imagen y aun así aplica el manifiesto: la URL propia se define al tener dominio', async () => {
    const svc = await deployedWithoutDomain('tienda', { version: 1, env: { APP_URL: { from: 'self.public_url' }, SESSION_SECRET: { generate: {} } } });
    expect(getEnv(svc.id).APP_URL).toBeUndefined();
    const secreto = getEnv(svc.id).SESSION_SECRET;
    expect(secreto).toMatch(/^[0-9a-f]{64}$/);

    const second = await deploy(svc.id, 'manual');
    // Sin clonar ni compilar: la misma imagen.
    expect(vi.mocked(cloneRepo)).not.toHaveBeenCalled();
    expect(vi.mocked(buildImage)).not.toHaveBeenCalled();
    expect(second.logs).toMatch(/se reutiliza la imagen/);
    // Y con la URL propia, que llega al contenedor.
    expect(getEnv(svc.id).APP_URL).toBe('${{tienda.PUBLIC_URL}}');
    expect(resolveServiceEnv(getService(svc.id)!).APP_URL).toMatch(/^https?:\/\/tienda\.example\.com$/);
    expect(second.logs).toMatch(/se han definido APP_URL/);
    // Un secreto generado no se regenera.
    expect(getEnv(svc.id).SESSION_SECRET).toBe(secreto);
  });

  it('si el manifiesto define una variable de compilación, no reutiliza la imagen: compila con ella', async () => {
    const svc = await deployedWithoutDomain('portal', { version: 1, env: { NEXT_PUBLIC_SITE_URL: { from: 'self.public_url' } } });
    const second = await deploy(svc.id, 'manual');
    expect(second.logs).toMatch(/El manifiesto ha definido variables que forman parte de la compilación: se compila de nuevo/);
    expect(second.logs).not.toMatch(/se reutiliza la imagen/);
    expect(vi.mocked(cloneRepo)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildImage)).toHaveBeenCalledTimes(1);
    expect(getEnv(svc.id).NEXT_PUBLIC_SITE_URL).toBe('${{portal.PUBLIC_URL}}');
    // La compilación recibe el valor resuelto.
    const serviceEnv = vi.mocked(buildImage).mock.calls[0][0].serviceEnv;
    expect(serviceEnv?.NEXT_PUBLIC_SITE_URL).toMatch(/^https?:\/\/portal\.example\.com$/);
  });
});
