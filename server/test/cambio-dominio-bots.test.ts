/**
 * Cambio de dominio con bots y workers (`domainmigration.ts`):
 *
 * - webhooks registrados con la URL anterior (por las variables, por las
 *   dependencias y por el entorno resuelto) y «Servir también», antes y
 *   después de pasar;
 * - servicios que referencian la dirección de otro que cambia de nombre
 *   (`${{api.PUBLIC_URL}}`): se vuelven a desplegar al pasar y al volver;
 * - usuarios SMTP que Skyway no gestiona (`TG_SMTP_LOGIN`, un `SMTP_USER` con
 *   una contraseña creada a mano, una URL SMTP, una compartida): se enseñan y
 *   se ponen al día en «Actualizar ahora» y en la baja;
 * - el reintento automático del despliegue con el usuario nuevo y la alerta si
 *   vuelve a fallar.
 *
 * Sin Docker: el despliegue se sustituye (se crea la fila y se anota) y su
 * resultado lo decide cada prueba; el DNS es el falso de `dnsfake.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import {
  closeDb,
  createDeployment,
  createProject,
  createService,
  createWorkspaceRow,
  getDomainMigration,
  getDomainRedirect,
  getEnv,
  getManagedEnv,
  getPrepublished,
  getProjectVars,
  getService,
  initDb,
  insertMailwayLink,
  listAlerts,
  listAudit,
  patchEnv,
  ServicioMigracion,
  setDomainMigrationServicio,
  setProjectVars,
  setSetting,
  updateDeployment,
  writeManagedEnv,
} from '../src/db';
import { esperarTareasCambioDominio, marcarCambiosInterrumpidos, resetCambioDominioCaches } from '../src/domainmigration';
import { appPasswordName, reescribirUsuariosSinGestionar, usuarioDeUrlSmtp } from '../src/mailconnect';
import { MAILWAY_SETTING, projectExternalRef, resetMailwayCaches } from '../src/mailway';
import type { DetectedNeeds, GitConfig, ImageConfig, ProjectRow, ServiceRow } from '../src/types';
import { dnsFalso } from './dnsfake';
import { MW_BASE, MW_TOKEN, fakeFetch, marcarListo, mw } from './mailwayfake';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

const m = vi.hoisted(() => ({
  triggers: [] as { serviceId: string; trigger: string; imageTag?: string }[],
  resultado: 'success' as 'success' | 'failed',
  /** Resultados de los próximos despliegues, en orden; vacía, `resultado`. */
  resultados: [] as ('success' | 'failed')[],
  /** Mientras exista, los despliegues no terminan (para ver lo que pasa durante uno). */
  espera: null as Promise<void> | null,
}));

// Sin desplegar de verdad: se crea la fila, como haría triggerDeploy, y el
// resultado lo decide la prueba.
vi.mock('../src/deploy/deployer', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/deploy/deployer')>();
  const db = await import('../src/db');
  return {
    ...mod,
    triggerDeploy: vi.fn((serviceId: string, trigger: string, opts: { imageTag?: string } = {}) => {
      m.triggers.push({ serviceId, trigger, ...(opts.imageTag ? { imageTag: opts.imageTag } : {}) });
      return db.createDeployment(serviceId, trigger, opts.imageTag ?? null);
    }),
    awaitDeployment: vi.fn(async (id: string) => {
      if (m.espera) await m.espera;
      const resultado = m.resultados.shift() ?? m.resultado;
      db.updateDeployment(id, { status: resultado, error: resultado === 'failed' ? 'El contenedor no ha arrancado.' : null });
      return db.getDeployment(id);
    }),
  };
});
vi.mock('../src/docker/containers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/docker/containers')>()),
  imageExists: vi.fn(async () => true),
}));

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const IP = '203.0.113.10';

let app: FastifyInstance;
let adminCookie = '';
let workspaceId = '';

const admin = () => ({ cookie: adminCookie, ...SAME_ORIGIN });

async function call(method: 'GET' | 'POST', url: string, body?: unknown) {
  const r = await app.inject({
    method,
    url,
    headers: body === undefined ? admin() : { ...admin(), 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Json = null;
  try {
    json = r.json();
  } catch {
    /* sin JSON */
  }
  return { status: r.statusCode, json, raw: r.body };
}

function gitCfg(domains: string[], extra: Partial<GitConfig> = {}): GitConfig {
  return { repoUrl: 'https://github.com/x/y', branch: 'main', port: 3000, domains, webhookSecret: 'w', ...extra } as GitConfig;
}

function needs(bots: DetectedNeeds['bots']): DetectedNeeds {
  return { engines: [], expectedVars: [], envFile: null, sources: ['package.json'], ...(bots ? { bots } : {}), detectedAt: 1 };
}

/** La versión en marcha: «Servir también» y la baja vuelven a desplegar esta imagen. */
function enMarcha(s: ServiceRow, tag: string): void {
  const dep = createDeployment(s.id, 'manual');
  updateDeployment(dep.id, { status: 'success', image_tag: tag, finished_at: Date.now() });
}

function dnsAqui(...hosts: string[]) {
  for (const h of hosts) dnsFalso.a.set(h, [IP]);
}

const hostsDe = (plan: Json) => plan.hosts.map((h: Json) => ({ serviceId: h.serviceId, from: h.from, to: h.to, modo: h.modo }));
const dominios = (s: ServiceRow) => (getService(s.id)!.config as GitConfig).domains;
const revision = (s: ServiceRow) => getService(s.id)!.config_rev ?? 0;
const llamadas = (re: RegExp) => mw.calls.filter((c) => re.test(c.path));

beforeAll(async () => {
  initDb();
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
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
  setSetting('serverIp', IP);
  setSetting(MAILWAY_SETTING.baseUrl, MW_BASE);
  setSetting(MAILWAY_SETTING.token, MW_TOKEN);
  resetMailwayCaches();
  workspaceId = createWorkspaceRow('Cliente', { modules_override: JSON.stringify(['mail', 'domains']) }).id;
});

afterAll(async () => {
  await esperarTareasCambioDominio();
  vi.unstubAllGlobals();
  await app.close();
  closeDb();
});

beforeEach(() => {
  mw.calls = [];
  m.triggers = [];
  m.resultado = 'success';
  m.resultados = [];
  resetCambioDominioCaches();
});

// ---------- webhooks, «Servir también» y referencias (solo la web) ----------

describe('webhooks y referencias', () => {
  let proj: ProjectRow;
  let tg: ServiceRow;
  let api: ServiceRow;
  let hook: ServiceRow;
  let poll: ServiceRow;
  let pagos: ServiceRow;
  let tienda: ServiceRow;
  let www: ServiceRow;
  let alertas: ServiceRow;
  let base = '';
  let mid = '';

  beforeAll(() => {
    proj = createProject('Bots web', 'bots-web', null, workspaceId);
    // Telegram con dominio propio.
    tg = createService(proj.id, 'Telegram', 'tg', 'git', gitCfg(['tg.bots.es']));
    patchEnv(tg.id, { TELEGRAM_BOT_TOKEN: '123:abc' }, []);
    enMarcha(tg, 'skyway/bots-web-tg:v1');
    api = createService(proj.id, 'API', 'api', 'git', gitCfg(['api.bots.es']));
    // Un bot sin dominio que registra su webhook en el nombre de la API.
    hook = createService(proj.id, 'Hook', 'hook', 'git', gitCfg([]));
    patchEnv(hook.id, { TELEGRAM_BOT_TOKEN: '456:def', WEBHOOK_URL: '${{api.PUBLIC_URL}}/tg' }, []);
    // Un bot de polling: sin dominio ni URL a un nombre del proyecto, no recibe webhooks.
    poll = createService(proj.id, 'Polling', 'poll', 'image', { image: 'busybox:stable', port: null, domains: [] } as ImageConfig);
    patchEnv(poll.id, { TELEGRAM_BOT_TOKEN: '789:ghi' }, []);
    // Por sus dependencias.
    pagos = createService(proj.id, 'Pagos', 'pagos', 'git', gitCfg(['pagos.bots.es'], { needs: needs([{ proveedor: 'discord', evidencia: 'package.json: discord.js' }]) }));
    // Stripe por sus variables.
    tienda = createService(proj.id, 'Tienda', 'tienda', 'git', gitCfg(['shop.bots.es']));
    patchEnv(tienda.id, { STRIPE_WEBHOOK_SECRET: 'whsec_x' }, []);
    // Un nombre «www» que pasa a otro sin «www»: servirlo también lo haría principal.
    www = createService(proj.id, 'Portada', 'portada', 'git', gitCfg(['www.bots.es']));
    patchEnv(www.id, { SLACK_SIGNING_SECRET: 's' }, []);
    // Solo publica en Slack y en Discord (webhooks de salida): no recibe nada.
    alertas = createService(proj.id, 'Alertas', 'alertas', 'git', gitCfg(['alertas.bots.es']));
    patchEnv(alertas.id, { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T0/B0/x', AVISOS_WEBHOOK: 'https://discord.com/api/webhooks/1/y' }, []);
    base = `/api/projects/${proj.id}/domain-migrations`;
  });

  /** El mapa por defecto, con la portada pasando a app.bots2.es. */
  const mapa = (plan: Json) =>
    hostsDe(plan).map((h: Json) => (h.from === 'www.bots.es' ? { ...h, to: 'app.bots2.es' } : h));

  it('plan: webhooks por variables, por el entorno resuelto y por dependencias; el bot de polling no sale', async () => {
    const r0 = await call('POST', `${base}/plan`, { fromDomain: 'bots.es', toDomain: 'bots2.es' });
    expect(r0.status, r0.raw).toBe(200);
    const r = await call('POST', `${base}/plan`, { fromDomain: 'bots.es', toDomain: 'bots2.es', hosts: mapa(r0.json) });
    expect(r.status, r.raw).toBe(200);
    const webhooks = r.json.webhooks as Json[];
    expect(webhooks.find((w) => w.serviceId === tg.id)).toEqual({
      serviceId: tg.id,
      serviceName: 'Telegram',
      proveedores: ['telegram'],
      evidencias: ['TELEGRAM_BOT_TOKEN'],
      hosts: [{ serviceId: tg.id, from: 'tg.bots.es', to: 'tg.bots2.es' }],
    });
    expect(webhooks.find((w) => w.serviceId === hook.id)).toMatchObject({
      proveedores: ['telegram'],
      evidencias: ['TELEGRAM_BOT_TOKEN', 'WEBHOOK_URL'],
      hosts: [{ serviceId: api.id, from: 'api.bots.es', to: 'api.bots2.es' }],
    });
    expect(webhooks.find((w) => w.serviceId === pagos.id)).toMatchObject({ proveedores: ['discord'], evidencias: ['package.json: discord.js'] });
    expect(webhooks.find((w) => w.serviceId === tienda.id)).toMatchObject({ proveedores: ['stripe'], evidencias: ['STRIPE_WEBHOOK_SECRET'] });
    expect(webhooks.some((w) => w.serviceId === poll.id || w.serviceId === api.id)).toBe(false);
    expect(webhooks.some((w) => w.serviceId === alertas.id)).toBe(false);

    // El bot sin dominio se vuelve a desplegar porque usa la dirección de la API, con una sola copia.
    const servicios = r.json.servicios as Json[];
    expect(servicios.find((s) => s.serviceId === hook.id)).toEqual({ serviceId: hook.id, nombre: 'Hook', reinicio: true, motivos: ['referencias'] });
    expect(servicios.find((s) => s.serviceId === api.id)).toEqual({ serviceId: api.id, nombre: 'API', reinicio: false, motivos: ['dominios'] });
    expect(servicios.some((s) => s.serviceId === poll.id)).toBe(false);

    // «Servir también» en la vista previa: el nombre deja de estar en riesgo.
    const servir = await call('POST', `${base}/plan`, {
      fromDomain: 'bots.es',
      toDomain: 'bots2.es',
      hosts: mapa(r0.json).map((h: Json) => (h.from === 'tg.bots.es' ? { ...h, modo: 'servir' } : h)),
    });
    expect(servir.status, servir.raw).toBe(200);
    expect((servir.json.webhooks as Json[]).some((w) => w.serviceId === tg.id)).toBe(false);
    // Servir también el nombre que es el principal lo deja como PUBLIC_URL: se avisa.
    const principal = await call('POST', `${base}/plan`, {
      fromDomain: 'bots.es',
      toDomain: 'bots2.es',
      hosts: mapa(r0.json).map((h: Json) => (h.from === 'www.bots.es' ? { ...h, modo: 'servir' } : h)),
    });
    expect(principal.json.avisos).toContain(
      'Con «Servir también», www.bots.es seguirá siendo el dominio principal de «Portada»: su PUBLIC_URL no pasará a app.bots2.es.',
    );
    expect(r.json.avisos.some((a: string) => a.startsWith('Con «Servir también»'))).toBe(false);

    const creada = await call('POST', base, { fromDomain: 'bots.es', toDomain: 'bots2.es', hosts: mapa(r0.json), excluidas: [], expect: r.json.expect });
    expect(creada.status, creada.raw).toBe(201);
    mid = creada.json.id;
    expect((creada.json.webhooks as Json[]).map((w) => w.serviceId).sort()).toEqual([hook.id, pagos.id, tg.id, tienda.id, www.id].sort());
  });

  it('preparado: «Servir también» cambia el modo del nombre en los dos sentidos, sin desplegar', async () => {
    const servir = await call('POST', `${base}/${mid}/hosts/mode`, { serviceId: tg.id, from: 'tg.bots.es', modo: 'servir' });
    expect(servir.status, servir.raw).toBe(200);
    expect(getDomainMigration(mid)!.hosts.find((h) => h.from === 'tg.bots.es')?.modo).toBe('servir');
    expect((servir.json.webhooks as Json[]).some((w) => w.serviceId === tg.id)).toBe(false);
    // Repetirlo no cambia nada.
    expect((await call('POST', `${base}/${mid}/hosts/mode`, { serviceId: tg.id, from: 'tg.bots.es', modo: 'servir' })).status).toBe(200);

    const redirigir = await call('POST', `${base}/${mid}/hosts/mode`, { serviceId: tg.id, from: 'TG.bots.es', modo: 'redirigir' });
    expect(redirigir.status, redirigir.raw).toBe(200);
    expect(getDomainMigration(mid)!.hosts.find((h) => h.from === 'tg.bots.es')?.modo).toBe('redirigir');
    expect((redirigir.json.webhooks as Json[]).some((w) => w.serviceId === tg.id)).toBe(true);
    expect(m.triggers).toEqual([]);
    expect(listAudit({ action: 'domain_migration_host_mode' }).map((a) => a.detail)).toEqual(
      expect.arrayContaining(['«tg.bots.es»: redirigir → servir', '«tg.bots.es»: servir → redirigir']),
    );

    // La portada, servida también, seguiría con www.bots.es como principal:
    // se admite con el mismo aviso que en la vista previa, y se puede deshacer.
    const principal = await call('POST', `${base}/${mid}/hosts/mode`, { serviceId: www.id, from: ['www.bots.es'], modo: 'servir' });
    expect(principal.status, principal.raw).toBe(200);
    expect(principal.json.avisos).toContain(
      'Con «Servir también», www.bots.es seguirá siendo el dominio principal de «Portada»: su PUBLIC_URL no pasará a app.bots2.es.',
    );
    const deshecho = await call('POST', `${base}/${mid}/hosts/mode`, { serviceId: www.id, from: 'www.bots.es', modo: 'redirigir' });
    expect(deshecho.status, deshecho.raw).toBe(200);
    expect((deshecho.json.avisos as string[]).some((a) => a.startsWith('Con «Servir también»'))).toBe(false);

    const ajeno = await call('POST', `${base}/${mid}/hosts/mode`, { serviceId: tg.id, from: 'otro.bots.es', modo: 'servir' });
    expect(ajeno.status).toBe(404);
    expect(ajeno.json.code).toBe('not_found');
    const malo = await call('POST', `${base}/${mid}/hosts/mode`, { serviceId: tg.id, from: 'tg.bots.es', modo: 'no_cambiar' });
    expect(malo.status).toBe(400);
    expect((await call('POST', `${base}/${mid}/hosts/mode`, { serviceId: tg.id, from: [], modo: 'servir' })).status).toBe(400);
  });

  it('pasar: los que referencian la dirección de un servicio que cambia se despliegan y suben su revisión', async () => {
    dnsAqui('tg.bots2.es', 'api.bots2.es', 'pagos.bots2.es', 'shop.bots2.es', 'app.bots2.es', 'alertas.bots2.es');
    const vista = (await call('POST', `${base}/${mid}/check`)).json;
    expect(vista.estado).toBe('lista');
    expect((vista.alPasar as Json[]).find((s) => s.serviceId === hook.id)?.motivos).toEqual(['referencias']);
    const antes = revision(hook);
    const r = await call('POST', `${base}/${mid}/switch`, { expect: vista.variables.huella });
    expect(r.status, r.raw).toBe(202);
    await esperarTareasCambioDominio();
    expect(m.triggers.map((t) => t.serviceId)).toContain(hook.id);
    expect(m.triggers.map((t) => t.serviceId)).not.toContain(poll.id);
    expect(revision(hook)).toBe(antes + 1);
    // Tras pasar siguen en riesgo los que reciben en nombres que redirigen.
    const pasada = (await call('GET', `${base}/${mid}`)).json;
    expect(pasada.estado).toBe('pasada');
    expect((pasada.webhooks as Json[]).find((w) => w.serviceId === hook.id)?.hosts).toEqual([
      { serviceId: api.id, from: 'api.bots.es', to: 'api.bots2.es' },
    ]);
  });

  it('pasada: «Servir también» vuelve a servir el nombre anterior, sin redirección, prepublicado y desplegado con la imagen en marcha', async () => {
    expect(getDomainRedirect('tg.bots.es')?.to_host).toBe('tg.bots2.es');
    m.triggers = [];
    let terminar: () => void = () => {};
    m.espera = new Promise<void>((r) => {
      terminar = r;
    });
    const r = await call('POST', `${base}/${mid}/hosts/mode`, { serviceId: tg.id, from: 'tg.bots.es', modo: 'servir' });
    expect(r.status, r.raw).toBe(202);
    expect(dominios(tg)).toEqual(['tg.bots2.es', 'tg.bots.es']);
    expect(getDomainRedirect('tg.bots.es')).toBeUndefined();
    expect(getPrepublished('tg.bots.es')).toMatchObject({ service_id: tg.id, migration_id: mid });
    expect(getPrepublished('tg.bots.es')?.dns_ok_at).toBeTypeOf('number');
    expect(m.triggers).toEqual([{ serviceId: tg.id, trigger: 'cambio-de-dominio', imageTag: 'skyway/bots-web-tg:v1' }]);
    expect(getDomainMigration(mid)!.hosts.find((h) => h.from === 'tg.bots.es')?.modo).toBe('servir');
    expect((r.json.webhooks as Json[]).some((w) => w.serviceId === tg.id)).toBe(false);
    m.espera = null;
    terminar();
    await esperarTareasCambioDominio();
    // Desplegado: el contenedor ya sirve el nombre y la prepublicación sobra.
    expect(getPrepublished('tg.bots.es')).toBeUndefined();

    // Tras pasar no se vuelve a redirigir desde el asistente.
    const atras = await call('POST', `${base}/${mid}/hosts/mode`, { serviceId: tg.id, from: 'tg.bots.es', modo: 'redirigir' });
    expect(atras.status).toBe(409);
    expect(atras.json.code).toBe('migration_state');

    // La portada (www.bots.es → app.bots2.es): servirla la haría principal.
    const principal = await call('POST', `${base}/${mid}/hosts/mode`, { serviceId: www.id, from: 'www.bots.es', modo: 'servir' });
    expect(principal.status).toBe(409);
    expect(principal.json.code).toBe('host_principal');
    expect(dominios(www)).toEqual(['app.bots2.es']);
    expect(getDomainRedirect('www.bots.es')?.to_host).toBe('app.bots2.es');
  });

  it('volver: los nombres en su sitio (también el servido) y los que referencian se despliegan otra vez', async () => {
    m.triggers = [];
    const antes = revision(hook);
    const r = await call('POST', `${base}/${mid}/rollback`);
    expect(r.status, r.raw).toBe(202);
    expect(dominios(tg)).toEqual(['tg.bots.es', 'tg.bots2.es']);
    expect(getDomainRedirect('tg.bots.es')).toBeUndefined();
    expect(m.triggers.map((t) => t.serviceId)).toContain(hook.id);
    expect(revision(hook)).toBe(antes + 1);
    await esperarTareasCambioDominio();
    expect(getDomainMigration(mid)!.estado).toBe('lista');
  });
});

describe('«Servir también» varios nombres de un servicio tras pasar', () => {
  it('van en una sola petición: los dos se sirven, sin redirección, con un solo despliegue', async () => {
    const proj = createProject('Tienda dos nombres', 'tienda-dos', null, workspaceId);
    const web = createService(proj.id, 'Web', 'web', 'git', gitCfg(['www.ea.es', 'ea.es']));
    patchEnv(web.id, { STRIPE_WEBHOOK_SECRET: 'whsec_x' }, []);
    enMarcha(web, 'skyway/tienda-dos-web:v1');
    const base = `/api/projects/${proj.id}/domain-migrations`;
    const plan = await call('POST', `${base}/plan`, { fromDomain: 'ea.es', toDomain: 'ea2.es' });
    expect(plan.status, plan.raw).toBe(200);
    const creada = await call('POST', base, { fromDomain: 'ea.es', toDomain: 'ea2.es', hosts: hostsDe(plan.json), excluidas: [], expect: plan.json.expect });
    expect(creada.status, creada.raw).toBe(201);
    const mid = creada.json.id as string;
    dnsAqui('www.ea2.es', 'ea2.es');
    const vista = (await call('POST', `${base}/${mid}/check`)).json;
    expect(vista.estado).toBe('lista');
    const sw = await call('POST', `${base}/${mid}/switch`, { expect: vista.variables.huella });
    expect(sw.status, sw.raw).toBe(202);
    await esperarTareasCambioDominio();
    const pasada = (await call('GET', `${base}/${mid}`)).json;
    const aviso = (pasada.webhooks as Json[]).find((w) => w.serviceId === web.id);
    expect(aviso.hosts.map((h: Json) => h.from)).toEqual(['www.ea.es', 'ea.es']);

    m.triggers = [];
    let terminar: () => void = () => {};
    m.espera = new Promise<void>((res) => {
      terminar = res;
    });
    const r = await call('POST', `${base}/${mid}/hosts/mode`, { serviceId: web.id, from: aviso.hosts.map((h: Json) => h.from), modo: 'servir' });
    expect(r.status, r.raw).toBe(202);
    expect(dominios(web)).toEqual(['www.ea2.es', 'ea2.es', 'www.ea.es', 'ea.es']);
    expect(getDomainRedirect('www.ea.es')).toBeUndefined();
    expect(getDomainRedirect('ea.es')).toBeUndefined();
    expect(getPrepublished('www.ea.es')?.dns_ok_at).toBeTypeOf('number');
    expect(getPrepublished('ea.es')?.dns_ok_at).toBeTypeOf('number');
    expect(m.triggers).toEqual([{ serviceId: web.id, trigger: 'cambio-de-dominio', imageTag: 'skyway/tienda-dos-web:v1' }]);
    expect((r.json.webhooks as Json[]).some((w) => w.serviceId === web.id)).toBe(false);
    expect(listAudit({ action: 'domain_migration_host_mode' }).map((a) => a.detail)).toContain(
      '«www.ea.es»: redirigir → servir, «ea.es»: redirigir → servir',
    );
    m.espera = null;
    terminar();
    await esperarTareasCambioDominio();
    // Repetirlo no despliega otra vez.
    m.triggers = [];
    const otra = await call('POST', `${base}/${mid}/hosts/mode`, { serviceId: web.id, from: ['www.ea.es', 'ea.es'], modo: 'servir' });
    expect(otra.status, otra.raw).toBe(200);
    expect(m.triggers).toEqual([]);
  });
});

// ---------- usuarios SMTP que Skyway no gestiona ----------

interface ProyectoBots {
  proj: ProjectRow;
  base: string;
  clientId: string;
}

let n = 0;

/** Proyecto vinculado a un cliente de Mailway con el dominio `dominio` y estos buzones (parte local → id). */
function proyectoConBuzones(slug: string, dominio: string, locales: string[]): ProyectoBots & { buzon: Record<string, string> } {
  const proj = createProject(`Bots ${slug}`, slug, null, workspaceId);
  const clientId = `cli_${slug}`;
  mw.clients.push({ id: clientId, name: slug, slug, externalRef: projectExternalRef(proj.id), suspended: false, planId: 'pln_2' });
  insertMailwayLink({ project_id: proj.id, client_id: clientId, client_name: slug, created_by: null });
  const domId = `dom_${slug}`;
  mw.domains.push({ id: domId, clientId, domain: dominio, status: 'active', ownershipVerifiedAt: 1 });
  const buzon: Record<string, string> = {};
  for (const local of locales) {
    const id = `mbx_${slug}_${local}`;
    buzon[local] = id;
    mw.mailboxes.push({ id, domainId: domId, domain: dominio, localPart: local, email: `${local}@${dominio}`, displayName: '', quotaMb: 1024, status: 'active', usedBytes: null });
  }
  return { proj, base: `/api/projects/${proj.id}/domain-migrations`, clientId, buzon };
}

function appManual(mailboxId: string, email: string, name: string): void {
  n += 1;
  mw.appPasswords.push({ id: `app_m${n}`, mailboxId, email, name, revokedAt: null, createdAt: n });
}

/** Plan, preparar, comprobar y pasar (sin web: solo el correo). */
async function pasar(p: ProyectoBots, from: string, to: string): Promise<{ mid: string; mailwayId: string; plan: Json }> {
  const plan = await call('POST', `${p.base}/plan`, { fromDomain: from, toDomain: to });
  expect(plan.status, plan.raw).toBe(200);
  const r = await call('POST', p.base, { fromDomain: from, toDomain: to, hosts: hostsDe(plan.json), excluidas: [], expect: plan.json.expect });
  expect(r.status, r.raw).toBe(201);
  const mid = r.json.id as string;
  const mailwayId = getDomainMigration(mid)!.mailway_migration_id!;
  marcarListo(mailwayId);
  const vista = (await call('POST', `${p.base}/${mid}/check`)).json;
  expect(vista.estado).toBe('lista');
  const sw = await call('POST', `${p.base}/${mid}/switch`, { expect: vista.variables.huella });
  expect(sw.status, sw.raw).toBe(202);
  await esperarTareasCambioDominio();
  return { mid, mailwayId, plan: plan.json };
}

describe('usuarios SMTP que Skyway no gestiona', () => {
  let p: ProyectoBots & { buzon: Record<string, string> };
  let web: ServiceRow;
  let bot1: ServiceRow;
  let bot2: ServiceRow;
  let bot3: ServiceRow;
  let mid = '';
  let mailwayId = '';

  beforeAll(() => {
    p = proyectoConBuzones('smtp-bots', 'b.es', ['tienda', 'avisos', 'tg', 'externo']);
    // Una web conectada por Skyway (credencial skyway:*): la pone al día su credencial.
    web = createService(p.proj.id, 'Web', 'web', 'git', gitCfg([]));
    mw.appPasswords.push({ id: 'app_web', mailboxId: p.buzon.tienda, email: 'tienda@b.es', name: appPasswordName(web), revokedAt: null, createdAt: 1 });
    writeManagedEnv(web.id, {
      SMTP_USER: { value: 'tienda@b.es', origin: 'mail.smtp.user' },
      SMTP_FROM: { value: 'tienda@b.es', origin: 'mail.smtp.from' },
      SMTP_PASS: { value: 'x', origin: 'mail.smtp.password' },
    });
    enMarcha(web, 'skyway/smtp-bots-web:v1');
    // Un bot con una contraseña de aplicación creada a mano en Mailway.
    bot1 = createService(p.proj.id, 'Avisos', 'avisos', 'git', gitCfg([]));
    appManual(p.buzon.avisos, 'avisos@b.es', 'bot-avisos-a-mano');
    patchEnv(bot1.id, { SMTP_USER: 'avisos@b.es', SMTP_PASS: 'manual', SMTP_FROM: 'avisos@b.es' }, []);
    enMarcha(bot1, 'skyway/smtp-bots-avisos:v1');
    // Un bot de Telegram con sus propios nombres.
    bot2 = createService(p.proj.id, 'Telegram', 'tg', 'git', gitCfg([]));
    patchEnv(bot2.id, { TG_SMTP_LOGIN: 'tg@b.es', BOT_SMTP_USER: 'TG@b.es', MAIL_FROM: 'tg@b.es', TELEGRAM_BOT_TOKEN: 't' }, []);
    enMarcha(bot2, 'skyway/smtp-bots-tg:v1');
    // Un worker con la URL SMTP codificada, como la escribe Skyway.
    bot3 = createService(p.proj.id, 'Worker', 'worker', 'git', gitCfg([]));
    patchEnv(bot3.id, { SMTP_URL: 'smtp://avisos%40b.es:clave%2F1@mail.b.es:587' }, []);
    enMarcha(bot3, 'skyway/smtp-bots-worker:v1');
    // Un buzón que solo usan aplicaciones de fuera de Skyway.
    appManual(p.buzon.externo, 'externo@b.es', 'n8n-a-mano');
  });

  it('pasar: TG_SMTP_LOGIN y BOT_SMTP_USER no cambian (son el usuario para entrar) y el remitente sí', async () => {
    ({ mid, mailwayId } = await pasar(p, 'b.es', 'b2.es').then(({ mid: m1, mailwayId: w, plan }) => {
      const cambios = (plan.variables.cambios as Json[]).map((c) => c.key);
      expect(cambios).toContain('MAIL_FROM');
      expect(cambios).not.toContain('TG_SMTP_LOGIN');
      expect(cambios).not.toContain('BOT_SMTP_USER');
      expect(cambios).not.toContain('SMTP_URL');
      const notas = (plan.variables.notas as Json[]).map((x) => x.texto);
      expect(notas).toContain(
        'tg@b.es aparece en TG_SMTP_LOGIN como usuario para entrar en el correo: no se cambia al pasar. El buzón sigue entrando con ese usuario hasta que se actualice o se dé de baja b.es.',
      );
      expect(notas.some((t: string) => t.startsWith('tg@b.es aparece en BOT_SMTP_USER como usuario para entrar'))).toBe(true);
      return { mid: m1, mailwayId: w };
    }));
    expect(getEnv(bot2.id)).toMatchObject({ TG_SMTP_LOGIN: 'tg@b.es', BOT_SMTP_USER: 'TG@b.es', MAIL_FROM: 'tg@b2.es' });
    expect(getEnv(bot3.id).SMTP_URL).toBe('smtp://avisos%40b.es:clave%2F1@mail.b.es:587');
  });

  it('la vista enseña los usos sin gestionar (no la credencial de Skyway) y las contraseñas creadas a mano de fuera', async () => {
    const v = (await call('GET', `${p.base}/${mid}`)).json;
    expect(v.estado).toBe('pasada');
    const porBuzon = new Map((v.usuariosSinGestionar as Json[]).map((u) => [u.email, u]));
    expect([...porBuzon.keys()].sort()).toEqual(['avisos@b2.es', 'tg@b2.es']);
    expect(porBuzon.get('avisos@b2.es')).toMatchObject({ mailboxId: p.buzon.avisos, login: 'avisos@b.es', pendiente: true });
    expect(porBuzon.get('avisos@b2.es').usos).toEqual([
      { ambito: 'service', serviceId: bot1.id, serviceName: 'Avisos', key: 'SMTP_USER', usuario: 'avisos@b.es', estado: 'cambiara' },
      { ambito: 'service', serviceId: bot3.id, serviceName: 'Worker', key: 'SMTP_URL', usuario: 'avisos@b.es', estado: 'cambiara' },
    ]);
    expect(porBuzon.get('tg@b2.es').usos.map((u: Json) => [u.key, u.usuario, u.estado])).toEqual([
      ['BOT_SMTP_USER', 'tg@b.es', 'cambiara'],
      ['TG_SMTP_LOGIN', 'tg@b.es', 'cambiara'],
    ]);
    expect(v.appsManuales).toEqual([{ mailboxId: p.buzon.externo, email: 'externo@b2.es', apps: ['n8n-a-mano'] }]);
  });

  it('«Actualizar ahora» reescribe esas variables (la URL, codificada) y despliega con la imagen en marcha', async () => {
    const r = await call('POST', `${p.base}/${mid}/mailboxes/${p.buzon.avisos}/login-update`);
    expect(r.status, r.raw).toBe(200);
    expect(llamadas(/login-update/).map((c) => c.path)).toEqual([`/api/mailboxes/${p.buzon.avisos}/login-update`]);
    expect(getEnv(bot1.id)).toMatchObject({ SMTP_USER: 'avisos@b2.es', SMTP_PASS: 'manual' });
    expect(getEnv(bot3.id).SMTP_URL).toBe('smtp://avisos%40b2.es:clave%2F1@mail.b.es:587');
    // Puestas a mano: siguen siéndolo.
    expect(getManagedEnv(bot1.id).SMTP_USER).toBeUndefined();
    expect(m.triggers).toEqual([
      { serviceId: bot1.id, trigger: 'cambio-de-dominio', imageTag: 'skyway/smtp-bots-avisos:v1' },
      { serviceId: bot3.id, trigger: 'cambio-de-dominio', imageTag: 'skyway/smtp-bots-worker:v1' },
    ]);
    await esperarTareasCambioDominio();
    const v = (await call('GET', `${p.base}/${mid}`)).json;
    expect((v.usuariosSinGestionar as Json[]).map((u) => u.email)).toEqual(['tg@b2.es']);
  });

  it('la baja pone al día también los usos sin gestionar antes de pedirla a Mailway', async () => {
    m.triggers = [];
    const r = await call('POST', `${p.base}/${mid}/retire`, { confirm: 'b.es' });
    expect(r.status, r.raw).toBe(202);
    await esperarTareasCambioDominio();
    const orden = llamadas(/login-update|\/retire$/).map((c) => c.path);
    expect(orden.at(-1)).toBe(`/api/domain-migrations/${mailwayId}/retire`);
    expect(orden).toEqual(
      expect.arrayContaining([`/api/mailboxes/${p.buzon.tienda}/login-update`, `/api/mailboxes/${p.buzon.tg}/login-update`]),
    );
    expect(getEnv(bot2.id)).toMatchObject({ TG_SMTP_LOGIN: 'tg@b2.es', BOT_SMTP_USER: 'tg@b2.es' });
    expect(getEnv(web.id).SMTP_USER).toBe('tienda@b2.es');
    expect(m.triggers).toEqual(
      expect.arrayContaining([
        { serviceId: web.id, trigger: 'cambio-de-dominio', imageTag: 'skyway/smtp-bots-web:v1' },
        { serviceId: bot2.id, trigger: 'cambio-de-dominio', imageTag: 'skyway/smtp-bots-tg:v1' },
      ]),
    );
    expect(m.triggers).toHaveLength(2);
    expect(getDomainMigration(mid)!.estado).toBe('terminada');
  });
});

describe('usuario SMTP compartido', () => {
  it('«Actualizar ahora» reescribe la compartida y despliega los servicios que la heredan', async () => {
    const p = proyectoConBuzones('compartida', 'c.es', ['avisos']);
    const worker = createService(p.proj.id, 'Worker', 'worker', 'git', gitCfg([]));
    enMarcha(worker, 'skyway/compartida-worker:v1');
    const propio = createService(p.proj.id, 'Propio', 'propio', 'git', gitCfg([]));
    patchEnv(propio.id, { SMTP_USER: 'otro@externo.com' }, []);
    setProjectVars(p.proj.id, { SMTP_USER: 'avisos@c.es', SMTP_PASS: 'manual' });
    const { mid } = await pasar(p, 'c.es', 'c2.es');
    expect(getProjectVars(p.proj.id).SMTP_USER).toBe('avisos@c.es');
    const v = (await call('GET', `${p.base}/${mid}`)).json;
    expect(v.usuariosSinGestionar[0].usos).toEqual([
      { ambito: 'project', serviceId: null, serviceName: null, key: 'SMTP_USER', usuario: 'avisos@c.es', estado: 'cambiara' },
    ]);
    m.triggers = [];
    const r = await call('POST', `${p.base}/${mid}/mailboxes/${p.buzon.avisos}/login-update`);
    expect(r.status, r.raw).toBe(200);
    expect(getProjectVars(p.proj.id).SMTP_USER).toBe('avisos@c2.es');
    expect(getEnv(propio.id).SMTP_USER).toBe('otro@externo.com');
    expect(m.triggers).toEqual([{ serviceId: worker.id, trigger: 'cambio-de-dominio', imageTag: 'skyway/compartida-worker:v1' }]);
    await esperarTareasCambioDominio();
  });
});

describe('usuario SMTP por referencia', () => {
  it('pasar no cambia la variable a la que apunta un usuario; «Actualizar ahora» la reescribe y despliega a quien la usa', async () => {
    const p = proyectoConBuzones('referencias', 'xc.es', ['avisos', 'alertas']);
    setProjectVars(p.proj.id, { SMTP_USER: 'avisos@xc.es', SMTP_PASS: 'manual', MAIL_LOGIN_COMUN: 'alertas@xc.es' });
    // Toma la compartida por referencia (la define, así que no la «hereda»).
    const worker = createService(p.proj.id, 'Worker', 'worker', 'git', gitCfg([]));
    patchEnv(worker.id, { SMTP_USER: '${{shared.SMTP_USER}}' }, []);
    enMarcha(worker, 'skyway/referencias-worker:v1');
    // Referencia a la de otro servicio, que a su vez referencia la compartida.
    const cron = createService(p.proj.id, 'Cron', 'cron', 'git', gitCfg([]));
    patchEnv(cron.id, { SMTP_USER: '${{worker.SMTP_USER}}' }, []);
    enMarcha(cron, 'skyway/referencias-cron:v1');
    // Un usuario con una compartida cuyo nombre no dice que sea un usuario.
    const bot = createService(p.proj.id, 'Bot', 'bot', 'git', gitCfg([]));
    patchEnv(bot.id, { SMTP_USER: '${{shared.MAIL_LOGIN_COMUN}}', SMTP_PASS: 'manual' }, []);
    enMarcha(bot, 'skyway/referencias-bot:v1');
    // Nunca desplegado: hereda la compartida, pero no hay contenedor que poner al día.
    const nuevo = createService(p.proj.id, 'Nuevo', 'nuevo', 'git', gitCfg([]));

    const { mid, plan } = await pasar(p, 'xc.es', 'xc2.es');
    expect((plan.variables.cambios as Json[]).map((c) => c.key)).not.toContain('MAIL_LOGIN_COMUN');
    expect((plan.variables.notas as Json[]).map((x) => x.texto)).toContain(
      'alertas@xc.es aparece en MAIL_LOGIN_COMUN como usuario para entrar en el correo: no se cambia al pasar. El buzón sigue entrando con ese usuario hasta que se actualice o se dé de baja xc.es.',
    );
    expect(getProjectVars(p.proj.id)).toMatchObject({ SMTP_USER: 'avisos@xc.es', MAIL_LOGIN_COMUN: 'alertas@xc.es' });

    const v = (await call('GET', `${p.base}/${mid}`)).json;
    const porBuzon = new Map((v.usuariosSinGestionar as Json[]).map((u) => [u.email, u]));
    expect(porBuzon.get('avisos@xc2.es').usos.map((u: Json) => [u.serviceName, u.key, u.usuario])).toEqual([
      ['Worker', 'SMTP_USER', 'avisos@xc.es'],
      ['Cron', 'SMTP_USER', 'avisos@xc.es'],
      [null, 'SMTP_USER', 'avisos@xc.es'],
    ]);
    expect(porBuzon.get('alertas@xc2.es').usos.map((u: Json) => [u.serviceName, u.key, u.usuario])).toEqual([
      ['Bot', 'SMTP_USER', 'alertas@xc.es'],
      [null, 'MAIL_LOGIN_COMUN', 'alertas@xc.es'],
    ]);

    m.triggers = [];
    const revNuevo = revision(nuevo);
    const r = await call('POST', `${p.base}/${mid}/mailboxes/${p.buzon.avisos}/login-update`);
    expect(r.status, r.raw).toBe(200);
    expect(getProjectVars(p.proj.id).SMTP_USER).toBe('avisos@xc2.es');
    expect(getEnv(worker.id).SMTP_USER).toBe('${{shared.SMTP_USER}}');
    expect(m.triggers).toEqual([
      { serviceId: worker.id, trigger: 'cambio-de-dominio', imageTag: 'skyway/referencias-worker:v1' },
      { serviceId: cron.id, trigger: 'cambio-de-dominio', imageTag: 'skyway/referencias-cron:v1' },
    ]);
    // Sin versión en marcha: queda pendiente, sin compilar nada.
    expect(revision(nuevo)).toBe(revNuevo + 1);
    await esperarTareasCambioDominio();

    m.triggers = [];
    const r2 = await call('POST', `${p.base}/${mid}/mailboxes/${p.buzon.alertas}/login-update`);
    expect(r2.status, r2.raw).toBe(200);
    expect(getProjectVars(p.proj.id).MAIL_LOGIN_COMUN).toBe('alertas@xc2.es');
    // Todo servicio recibe las compartidas que no define: el entorno de los
    // tres cambia y se despliegan los tres (el nuevo sigue sin desplegar).
    expect(m.triggers).toEqual([
      { serviceId: worker.id, trigger: 'cambio-de-dominio', imageTag: 'skyway/referencias-worker:v1' },
      { serviceId: cron.id, trigger: 'cambio-de-dominio', imageTag: 'skyway/referencias-cron:v1' },
      { serviceId: bot.id, trigger: 'cambio-de-dominio', imageTag: 'skyway/referencias-bot:v1' },
    ]);
    await esperarTareasCambioDominio();
    expect((await call('GET', `${p.base}/${mid}`)).json.usuariosSinGestionar).toEqual([]);
  });
});

describe('despliegue con el usuario nuevo: reintento y alerta', () => {
  function botConLogin(slug: string, dominio: string) {
    const p = proyectoConBuzones(slug, dominio, ['bot']);
    const bot = createService(p.proj.id, 'Bot', 'bot', 'git', gitCfg([]));
    patchEnv(bot.id, { TG_SMTP_LOGIN: `bot@${dominio}`, SMTP_PASS: 'manual' }, []);
    enMarcha(bot, `skyway/${slug}-bot:v1`);
    return { p, bot };
  }

  it('si el despliegue falla una vez, se reintenta con la misma imagen y la baja sigue', async () => {
    const { p, bot } = botConLogin('reintento', 'r.es');
    const { mid, mailwayId } = await pasar(p, 'r.es', 'r2.es');
    m.triggers = [];
    m.resultados = ['failed', 'success'];
    const r = await call('POST', `${p.base}/${mid}/retire`, { confirm: 'r.es' });
    expect(r.status, r.raw).toBe(202);
    await esperarTareasCambioDominio();
    const conImagen = { serviceId: bot.id, trigger: 'cambio-de-dominio', imageTag: 'skyway/reintento-bot:v1' };
    expect(m.triggers).toEqual([conImagen, conImagen]);
    expect(getEnv(bot.id).TG_SMTP_LOGIN).toBe('bot@r2.es');
    expect(getDomainMigration(mid)!).toMatchObject({ estado: 'terminada', error: null });
    expect(mw.migraciones.find((x) => x.id === mailwayId)?.estado).toBe('dado_de_baja');
    expect(listAlerts({ openOnly: true }).some((a) => a.service_id === bot.id)).toBe(false);
  });

  it('si vuelve a fallar: alerta crítica, el error dice qué pasa y cómo seguir, y la baja no se pide', async () => {
    const { p, bot } = botConLogin('dosfallos', 'd.es');
    const { mid, mailwayId } = await pasar(p, 'd.es', 'd2.es');
    m.triggers = [];
    mw.calls = [];
    m.resultado = 'failed';
    const r = await call('POST', `${p.base}/${mid}/retire`, { confirm: 'd.es' });
    expect(r.status, r.raw).toBe(202);
    await esperarTareasCambioDominio();
    expect(m.triggers).toHaveLength(2);
    expect(llamadas(/\/retire$/)).toEqual([]);
    expect(mw.migraciones.find((x) => x.id === mailwayId)?.estado).toBe('pasado');
    const row = getDomainMigration(mid)!;
    expect(row.estado).toBe('pasada');
    expect(row.servicios[bot.id]).toMatchObject({
      estado: 'error',
      error:
        'El despliegue ha fallado dos veces y «Bot» no puede enviar correo: su usuario ya es bot@d2.es y el contenedor en marcha sigue con bot@d.es. Pulsa «Reintentar este servicio».',
    });
    expect(row.error).toMatch(/^El despliegue ha fallado dos veces y «Bot» no puede enviar correo.*No se ha dado de baja d\.es/);
    const alerta = listAlerts({ openOnly: true }).find((a) => a.service_id === bot.id && a.type === 'mail_login_deploy_failed');
    expect(alerta).toMatchObject({
      severity: 'critical',
      title: '«Bot» no puede enviar correo',
      message:
        'El usuario de correo de «Bot» ha cambiado a bot@d2.es y su despliegue ha fallado dos veces: el contenedor en marcha sigue entrando con bot@d.es, que ya no es válido.',
    });
    // Una sola alerta aunque se repita.
    expect(listAlerts({ openOnly: true }).filter((a) => a.service_id === bot.id && a.type === 'mail_login_deploy_failed')).toHaveLength(1);
  });
});

describe('despliegue con el usuario nuevo tras un reinicio de Skyway', () => {
  function botConLogin(slug: string, dominio: string) {
    const p = proyectoConBuzones(slug, dominio, ['bot']);
    const bot = createService(p.proj.id, 'Bot', 'bot', 'git', gitCfg([]));
    patchEnv(bot.id, { TG_SMTP_LOGIN: `bot@${dominio}`, SMTP_PASS: 'manual' }, []);
    enMarcha(bot, `skyway/${slug}-bot:v1`);
    return { p, bot };
  }

  /** La entrada del servicio como la deja el despliegue con el usuario nuevo justo antes del reinicio. */
  function cortado(mid: string, bot: ServiceRow, dominio: string, tag: string): string {
    const dep = createDeployment(bot.id, 'cambio-de-dominio', tag);
    // `markStaleDeploymentsFailed`: el reinicio lo deja fallido.
    updateDeployment(dep.id, { status: 'failed', error: 'Interrumpido por un reinicio de Skyway.' });
    const entrada = {
      deploymentId: dep.id,
      estado: 'desplegando',
      error: null,
      correo: { de: `bot@${dominio}`, a: `bot@${dominio.replace('.es', '2.es')}`, imageTag: tag, reintento: false },
    };
    setDomainMigrationServicio(mid, bot.id, entrada as ServicioMigracion);
    return dep.id;
  }

  const alertaDe = (bot: ServiceRow) => listAlerts({ openOnly: true }).find((a) => a.service_id === bot.id && a.type === 'mail_login_deploy_failed');

  it('«Actualizar ahora» guarda con el despliegue lo necesario para retomarlo', async () => {
    const { p, bot } = botConLogin('guarda', 'g.es');
    const { mid } = await pasar(p, 'g.es', 'g2.es');
    let soltar: () => void = () => {};
    m.espera = new Promise<void>((r) => {
      soltar = r;
    });
    const r = await call('POST', `${p.base}/${mid}/mailboxes/${p.buzon.bot}/login-update`);
    expect(r.status, r.raw).toBe(200);
    expect(getDomainMigration(mid)!.servicios[bot.id]).toMatchObject({
      estado: 'desplegando',
      correo: { de: 'bot@g.es', a: 'bot@g2.es', imageTag: 'skyway/guarda-bot:v1', reintento: false },
    });
    m.espera = null;
    soltar();
    await esperarTareasCambioDominio();
    expect(getDomainMigration(mid)!.servicios[bot.id]).toMatchObject({ estado: 'ok' });
  });

  it('el reintento automático del arranque hace de reintento: si falla, alerta crítica sin desplegar otra vez', async () => {
    const { p, bot } = botConLogin('rearranque', 'h.es');
    const { mid } = await pasar(p, 'h.es', 'h2.es');
    cortado(mid, bot, 'h.es', 'skyway/rearranque-bot:v1');
    // `resumeInterruptedDeployments` lo vuelve a lanzar con la misma imagen.
    const retry = createDeployment(bot.id, 'retry', 'skyway/rearranque-bot:v1');
    m.triggers = [];
    m.resultado = 'failed';
    marcarCambiosInterrumpidos();
    expect(getDomainMigration(mid)!.servicios[bot.id]).toMatchObject({ deploymentId: retry.id, estado: 'desplegando', correo: { reintento: true } });
    await esperarTareasCambioDominio();
    expect(m.triggers).toEqual([]);
    expect(getDomainMigration(mid)!.servicios[bot.id]).toMatchObject({
      deploymentId: retry.id,
      estado: 'error',
      error:
        'El despliegue no ha terminado bien tras un reinicio de Skyway y «Bot» no puede enviar correo: su usuario ya es bot@h2.es y el contenedor en marcha sigue con bot@h.es. Pulsa «Reintentar este servicio».',
    });
    expect(alertaDe(bot)).toMatchObject({
      severity: 'critical',
      message:
        'El usuario de correo de «Bot» ha cambiado a bot@h2.es y su despliegue no ha terminado bien tras un reinicio de Skyway: el contenedor en marcha sigue entrando con bot@h.es, que ya no es válido.',
    });
  });

  it('si el reinicio no deja ningún despliegue en curso, la alerta salta al arrancar', async () => {
    const { p, bot } = botConLogin('sinreintento', 'q.es');
    const { mid } = await pasar(p, 'q.es', 'q2.es');
    const depId = cortado(mid, bot, 'q.es', 'skyway/sinreintento-bot:v1');
    m.triggers = [];
    marcarCambiosInterrumpidos();
    expect(getDomainMigration(mid)!.servicios[bot.id]).toMatchObject({ deploymentId: depId, estado: 'error' });
    expect(getDomainMigration(mid)!.servicios[bot.id].error).toMatch(/^El despliegue no ha terminado bien tras un reinicio de Skyway y «Bot»/);
    expect(alertaDe(bot)?.severity).toBe('critical');
    await esperarTareasCambioDominio();
    expect(m.triggers).toEqual([]);
  });
});

describe('utilidades del usuario SMTP', () => {
  it('usuarioDeUrlSmtp: codificado, sin codificar y lo que no es una URL SMTP', () => {
    expect(usuarioDeUrlSmtp('smtp://bot%40b.es:clave@mail.b.es:587')).toBe('bot@b.es');
    expect(usuarioDeUrlSmtp('smtps://bot@b.es:cl@ve@mail.b.es:465')).toBe('bot@b.es');
    expect(usuarioDeUrlSmtp('smtp://mail.b.es:587')).toBeNull();
    expect(usuarioDeUrlSmtp('https://bot%40b.es:clave@b.es')).toBeNull();
  });

  it('reescribirUsuariosSinGestionar: la gestionada conserva su origen; la que no es de usuario no cambia', () => {
    const proj = createProject('Utilidades', 'utilidades', null, workspaceId);
    const s = createService(proj.id, 'S', 's', 'git', gitCfg([]));
    writeManagedEnv(s.id, { SMTP_USER: { value: 'a@x.es', origin: 'mail.smtp.user' } });
    patchEnv(s.id, { NOTIFY_TO: 'a@x.es', MAILER_DSN: 'smtp://a%40x.es:k@mail.x.es:587' }, []);
    const cambiadas = reescribirUsuariosSinGestionar(s.id, new Map([['A@x.es', 'a@y.es']]), new Set());
    expect(cambiadas).toEqual(['MAILER_DSN', 'SMTP_USER']);
    expect(getEnv(s.id)).toMatchObject({ SMTP_USER: 'a@y.es', NOTIFY_TO: 'a@x.es', MAILER_DSN: 'smtp://a%40y.es:k@mail.x.es:587' });
    expect(getManagedEnv(s.id).SMTP_USER.origin).toBe('mail.smtp.user');
    expect(reescribirUsuariosSinGestionar(s.id, new Map([['a@y.es', 'a@z.es']]), new Set(['SMTP_USER', 'MAILER_DSN']))).toEqual([]);
  });
});
