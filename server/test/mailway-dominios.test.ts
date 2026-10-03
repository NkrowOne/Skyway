/**
 * Asistente de dominios del correo: dominios sugeridos a partir de los
 * servicios del proyecto, fichero de zona (sin registros web del dominio raíz)
 * y webmail en `webmail.<dominio>` con la marca blanca de Mailway. Mismo doble
 * de Mailway que el resto de pruebas de la integración (`mailwayfake.ts`).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { API_TOKEN_PREFIX, hashApiToken } from '../src/auth';
import {
  closeDb,
  createProject,
  createService,
  createUser,
  createWorkspaceRow,
  getMailwayLink,
  getService,
  getSetting,
  initDb,
  insertApiToken,
  listAudit,
  setSetting,
  setUserProjects,
  updateService,
  updateWorkspace,
  getMailwayDnsReserva,
} from '../src/db';
import { domainClaimError } from '../src/domainguard';
import { stripWebRecords } from '../src/mailway';
import { mailwayPublishedHosts, resetMailwayTraefikState } from '../src/mailwaytraefik';
import type { GitConfig, ProjectRow, ServiceRow, UserRow } from '../src/types';
import { hashPassword, randomToken } from '../src/util';
import { MW_BASE, MW_TOKEN, fakeFetch, mw } from './mailwayfake';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const PANEL = 'panel.plataforma.com';

let app: FastifyInstance;
let adminCookie = '';
const admin = () => ({ cookie: adminCookie, ...SAME_ORIGIN });

let wsA: { id: string };
let projA: ProjectRow;
let projB: ProjectRow;
let svcA: ServiceRow;
let svcB: ServiceRow;
let ownerA: Record<string, string>;
let memberA: Record<string, string>;
let ownerB: Record<string, string>;
let domainEmpresa = '';
let domainPendiente = '';
let domainB = '';
let domainTienda = '';

function bearerFor(user: UserRow): Record<string, string> {
  const secret = `${API_TOKEN_PREFIX}${randomToken(24)}`;
  insertApiToken({ user_id: user.id, name: 'pruebas', token_hash: hashApiToken(secret), prefix: secret.slice(0, 12), expires_at: null });
  return { authorization: `Bearer ${secret}` };
}

async function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, headers: Record<string, string>, body?: unknown) {
  const r = await app.inject({
    method,
    url,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: Json = null;
  try {
    parsed = r.json();
  } catch {
    /* sin JSON (el fichero de zona es texto) */
  }
  return { status: r.statusCode, json: parsed, raw: r.body, headers: r.headers };
}

function gitCfg(domains: string[] = []): GitConfig {
  return { repoUrl: 'https://github.com/x/y', branch: 'main', port: 3000, domains, webhookSecret: 'w' } as GitConfig;
}

const clientOf = (projectId: string) => mw.clients.find((c) => c.id === getMailwayLink(projectId)?.client_id)!;
const whitelabelCalls = () => mw.calls.filter((c) => c.path.startsWith('/api/whitelabel'));
const webmailUrl = (projectId: string, domainId: string, accion = '') =>
  `/api/projects/${projectId}/mail/domains/${domainId}/webmail${accion}`;

beforeAll(async () => {
  process.env.SKYWAY_DOMAIN = PANEL;
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

  const put = await call('PUT', '/api/mailway/config', admin(), { baseUrl: MW_BASE, token: MW_TOKEN });
  expect(put.status, put.raw).toBe(200);
  // Aprende los hosts de la instancia (mail-panel., webmail. y mail.example.com).
  expect((await call('POST', '/api/mailway/test', admin(), {})).status).toBe(200);
  // Dominio raíz con el que la plataforma genera los subdominios de los servicios.
  setSetting('rootDomain', 'apps.nube.com');

  wsA = createWorkspaceRow('Cliente Correo', { modules_override: JSON.stringify(['mail', 'domains']) });
  projA = createProject('Tienda', 'tienda', null, wsA.id);
  ownerA = bearerFor(createUser('owner@example.com', hashPassword('contraseña1'), 'owner', wsA.id));
  const member = createUser('member@example.com', hashPassword('contraseña1'), 'member', wsA.id);
  setUserProjects(member.id, [projA.id]);
  memberA = bearerFor(member);
  svcA = createService(
    projA.id,
    'Web',
    'web',
    'git',
    gitCfg([
      'www.tienda.es',
      'api.empresa.com',
      'pruebas.apps.nube.com', // dominio raíz de la plataforma
      'estado.plataforma.com', // dominio del panel
      'algo.example.com', // dominio de la instancia de Mailway
      'miapp.github.io', // sufijo privado: el dominio es del proveedor
      'app.tienda.co.uk',
      'tienda.es',
    ]),
  );

  const wsB = createWorkspaceRow('Otro inquilino', { modules_override: JSON.stringify(['mail', 'domains']) });
  projB = createProject('Otro', 'otro', null, wsB.id);
  ownerB = bearerFor(createUser('ownerb@example.com', hashPassword('contraseña1'), 'owner', wsB.id));
  // Un servicio de otro proyecto que ya sirve el nombre del webmail de un dominio de A.
  svcB = createService(projB.id, 'Web', 'web', 'git', gitCfg(['webmail.otraempresa.com']));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.SKYWAY_DOMAIN;
  await app.close();
  closeDb();
});

beforeEach(() => {
  mw.calls = [];
});

// ======================= filtro del fichero de zona (función pura) =======================

describe('stripWebRecords', () => {
  it('sin registros web en el dominio raíz devuelve el fichero tal cual', () => {
    const zone = ['$TTL 3600', 'empresa.com.\t3600\tIN\tMX\t10 mail.example.com.', 'autoconfig.empresa.com. IN CNAME mail.example.com.', ''].join('\n');
    expect(stripWebRecords(zone, 'empresa.com')).toEqual({ zone, removed: 0 });
  });

  it('entiende nombres relativos, «@», $ORIGIN, líneas sin propietario y paréntesis', () => {
    const zone = [
      '$TTL 3600',
      'empresa.com. IN MX 10 mail.example.com.',
      '\tIN A 192.0.2.1', // hereda empresa.com
      '$ORIGIN empresa.com.',
      'www IN CNAME web.example.net.',
      'correo IN A 192.0.2.2',
      '@ 60 IN AAAA (',
      '  2001:db8::1 )',
      'empresa.com. IN TXT "v=spf1 mx -all ; A 192.0.2.9"',
      '$ORIGIN sub.empresa.com.',
      '@ IN A 192.0.2.3',
    ].join('\n');
    const { zone: out, removed } = stripWebRecords(zone, 'Empresa.com.');
    expect(removed).toBe(3);
    expect(out).not.toContain('192.0.2.1');
    expect(out).not.toContain('web.example.net');
    expect(out).not.toContain('2001:db8::1');
    expect(out).toContain('correo IN A 192.0.2.2');
    expect(out).toContain('@ IN A 192.0.2.3');
    expect(out).toContain('IN MX 10 mail.example.com.');
    expect(out).toContain('"v=spf1 mx -all ; A 192.0.2.9"');
    expect(out.split('\n')[0]).toMatch(/^;\s+Skyway ha retirado 3 registro\(s\)/);
  });
});

// ======================= dominios sugeridos =======================

describe('dominios sugeridos', () => {
  it('antes de activar el correo: los registrables de los servicios, sin los de la plataforma ni sufijos privados', async () => {
    for (const headers of [ownerA, memberA]) {
      const r = await call('GET', `/api/projects/${projA.id}/mail`, headers);
      expect(r.status, r.raw).toBe(200);
      expect(r.json.linked).toBe(false);
      expect(r.json.suggestedDomains).toEqual(['tienda.es', 'empresa.com', 'tienda.co.uk']);
    }
    // Sin el módulo o sin Mailway no se calcula nada.
    const sinCorreo = createProject('Sin correo', 'sin-correo', null, createWorkspaceRow('Sin módulo', { modules_override: JSON.stringify(['domains']) }).id);
    const owner = bearerFor(createUser('owner3@example.com', hashPassword('contraseña1'), 'owner', sinCorreo.workspace_id));
    const r = await call('GET', `/api/projects/${sinCorreo.id}/mail`, owner);
    expect(r.json.moduleEnabled).toBe(false);
    expect(r.json.suggestedDomains).toEqual([]);
  });

  it('con el correo activado no se sugieren los dominios que ya tiene el cliente', async () => {
    let r = await call('POST', `/api/projects/${projA.id}/mail/link`, ownerA, { mode: 'create' });
    expect(r.status, r.raw).toBe(201);
    r = await call('POST', `/api/projects/${projA.id}/mail/domains`, ownerA, { domain: 'empresa.com' });
    expect(r.status, r.raw).toBe(201);
    domainEmpresa = r.json.domain.id;
    r = await call('GET', `/api/projects/${projA.id}/mail`, memberA);
    expect(r.json.summary.domains.map((d: Json) => d.domain)).toEqual(['empresa.com']);
    expect(r.json.suggestedDomains).toEqual(['tienda.es', 'tienda.co.uk']);

    // El otro proyecto, con su propio dominio de correo (para las pruebas de aislamiento).
    expect((await call('POST', `/api/projects/${projB.id}/mail/link`, ownerB, { mode: 'create' })).status).toBe(201);
    r = await call('POST', `/api/projects/${projB.id}/mail/domains`, ownerB, { domain: 'ajeno.com' });
    expect(r.status, r.raw).toBe(201);
    domainB = r.json.domain.id;
  });
});

// ======================= fichero de zona =======================

describe('fichero de zona', () => {
  it('se descarga el fichero de Mailway con el nombre del dominio; un miembro también puede', async () => {
    let r = await call('GET', `/api/projects/${projA.id}/mail/domains/${domainEmpresa}/zonefile`, memberA);
    expect(r.status, r.raw).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
    expect(r.headers['content-disposition']).toBe('attachment; filename="empresa.com-mailway-recomendados.txt"');
    expect(r.raw).toContain('empresa.com.\t3600\tIN\tMX\t10 mail.example.com.');
    expect(r.raw).toContain('autoconfig.empresa.com.\t3600\tIN\tCNAME\tmail.example.com.');
    expect(r.raw).toContain('_mailway.empresa.com.');
    expect(r.raw).not.toContain('Skyway ha retirado');
    expect(mw.calls.filter((c) => c.path.includes('/zonefile')).map((c) => c.path)).toEqual([
      `/api/domains/${domainEmpresa}/zonefile?nivel=recomendados`,
    ]);

    r = await call('GET', `/api/projects/${projA.id}/mail/domains/${domainEmpresa}/zonefile?nivel=obligatorios`, memberA);
    expect(r.status, r.raw).toBe(200);
    expect(r.headers['content-disposition']).toBe('attachment; filename="empresa.com-mailway-obligatorios.txt"');
    expect(r.raw).not.toContain('_mailway.');

    mw.calls = [];
    r = await call('GET', `/api/projects/${projA.id}/mail/domains/${domainEmpresa}/zonefile?nivel=todo`, memberA);
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/Nivel no válido/);
    expect(mw.calls).toEqual([]);
  });

  it('retira los registros web del dominio raíz y de www que pudiera traer el fichero', async () => {
    mw.zoneExtra = [
      'empresa.com.\t300\tIN\tA\t203.0.113.7',
      '@\tIN\tAAAA\t2001:db8::7',
      'www\t3600\tIN\tCNAME\totra-web.example.net.',
      'empresa.com. 3600 IN HTTPS 1 . alpn=h2',
      'tienda.empresa.com.\t3600\tIN\tA\t203.0.113.8',
    ];
    try {
      const r = await call('GET', `/api/projects/${projA.id}/mail/domains/${domainEmpresa}/zonefile`, ownerA);
      expect(r.status, r.raw).toBe(200);
      for (const fuera of ['203.0.113.7', '2001:db8::7', 'otra-web.example.net', 'alpn=h2']) expect(r.raw).not.toContain(fuera);
      expect(r.raw).toContain('tienda.empresa.com.\t3600\tIN\tA\t203.0.113.8');
      expect(r.raw).toContain('empresa.com.\t3600\tIN\tMX\t10 mail.example.com.');
      expect(r.raw.split('\n')[0]).toMatch(/Skyway ha retirado 4 registro\(s\)/);
    } finally {
      mw.zoneExtra = [];
    }
  });

  it('el fichero de un dominio de otro proyecto no se descarga ni llega a pedirse a Mailway', async () => {
    let r = await call('GET', `/api/projects/${projA.id}/mail/domains/${domainB}/zonefile`, ownerA);
    expect(r.status, r.raw).toBe(404);
    r = await call('GET', `/api/projects/${projB.id}/mail/domains/${domainB}/zonefile`, ownerA);
    expect(r.status).toBe(403);
    expect(mw.calls.filter((c) => c.path.includes('/zonefile'))).toEqual([]);
  });
});

// ======================= webmail con el dominio del cliente =======================

describe('webmail en webmail.<dominio>', () => {
  it('sin configurar: indica el nombre y que se puede utilizar', async () => {
    const r = await call('GET', webmailUrl(projA.id, domainEmpresa), memberA);
    expect(r.status, r.raw).toBe(200);
    expect(r.json).toEqual({ hostname: 'webmail.empresa.com', webmail: null, conflict: null });
    expect(whitelabelCalls().map((c) => c.path)).toEqual([`/api/whitelabel/domains?clientId=${clientOf(projA.id).id}`]);
  });

  it('un miembro no lo crea; con la propiedad del dominio pendiente, se muestra el error de Mailway', async () => {
    let r = await call('POST', webmailUrl(projA.id, domainEmpresa), memberA);
    expect(r.status).toBe(403);
    expect(whitelabelCalls()).toEqual([]);

    mw.requireOwnership = true;
    try {
      r = await call('POST', `/api/projects/${projA.id}/mail/domains`, ownerA, { domain: 'pendiente.com' });
      expect(r.status, r.raw).toBe(201);
      domainPendiente = r.json.domain.id;
    } finally {
      mw.requireOwnership = false;
    }
    r = await call('POST', webmailUrl(projA.id, domainPendiente), ownerA);
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/propiedad del dominio de correo pendiente\.com/);
    expect(mw.whitelabel).toEqual([]);
  });

  it('el propietario lo crea en el cliente del proyecto, con el registro DNS que indica Mailway', async () => {
    let r = await call('POST', webmailUrl(projA.id, domainEmpresa), ownerA);
    expect(r.status, r.raw).toBe(201);
    expect(r.json.webmail).toMatchObject({ hostname: 'webmail.empresa.com', kind: 'webmail', status: 'pending_dns', url: null, isPrimary: false });
    expect(r.json.webmail.instructions[0]).toEqual({
      type: 'CNAME',
      name: 'webmail.empresa.com',
      value: 'mail.example.com.',
      recommended: true,
      help: expect.any(String),
    });
    const alta = whitelabelCalls().find((c) => c.method === 'POST');
    expect(alta?.body).toEqual({ hostname: 'webmail.empresa.com', clientId: clientOf(projA.id).id, kind: 'webmail' });
    expect(listAudit({ action: 'mailway_webmail_created' }).map((a) => a.detail)).toEqual(['Tienda: webmail.empresa.com']);

    r = await call('POST', webmailUrl(projA.id, domainEmpresa), ownerA);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/ya está configurado/);
    expect(mw.whitelabel).toHaveLength(1);

    r = await call('GET', webmailUrl(projA.id, domainEmpresa), memberA);
    expect(r.json.webmail.status).toBe('pending_dns');
    expect(r.json.webmail.instructions.map((i: Json) => i.type)).toEqual(['CNAME', 'A']);
  });

  it('«Comprobar» avanza el estado: Esperando DNS → Emitiendo certificado → En servicio', async () => {
    let r = await call('POST', webmailUrl(projA.id, domainEmpresa, '/verify'), memberA);
    expect(r.status, r.raw).toBe(200);
    expect(r.json.webmail.status).toBe('pending_dns');
    expect(r.json.webmail.detail).toMatch(/todavía no existe en el DNS/);
    mw.whitelabelDnsOk = true;
    r = await call('POST', webmailUrl(projA.id, domainEmpresa, '/verify'), memberA);
    expect(r.json.webmail.status).toBe('issuing');
    expect(r.json.webmail.url).toBeNull();
    r = await call('POST', webmailUrl(projA.id, domainEmpresa, '/verify'), memberA);
    expect(r.json.webmail).toMatchObject({ status: 'active', url: 'https://webmail.empresa.com' });
    expect(r.json.conflict).toBeNull();
  });

  it('Cloudflare: solo quien gestiona el proyecto y, si no es administrador, con las cuentas del cliente', async () => {
    const id = mw.whitelabel[0].id;
    let r = await call('POST', webmailUrl(projA.id, domainEmpresa, '/cloudflare'), memberA);
    expect(r.status).toBe(403);
    r = await call('POST', webmailUrl(projA.id, domainEmpresa, '/cloudflare'), ownerA);
    expect(r.status, r.raw).toBe(200);
    expect(r.json.applied).toEqual([{ action: 'create', type: 'CNAME', name: 'webmail.empresa.com' }]);
    expect(r.json.skipped).toEqual([]);
    expect(r.json.webmail.hostname).toBe('webmail.empresa.com');
    expect(whitelabelCalls().filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      `/api/whitelabel/domains/${id}/cloudflare?soloCliente=1`,
    ]);
    mw.calls = [];
    r = await call('POST', webmailUrl(projA.id, domainEmpresa, '/cloudflare'), admin());
    expect(r.status, r.raw).toBe(200);
    expect(whitelabelCalls().filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([`/api/whitelabel/domains/${id}/cloudflare`]);
    const auditados = listAudit({ action: 'mailway_webmail_dns_applied' });
    expect(auditados).toHaveLength(2);
    expect(String(auditados[0].detail)).toMatch(/^webmail\.empresa\.com: 1 cambio/);
  });

  it('el propietario lo marca como webmail principal del cliente', async () => {
    let r = await call('POST', webmailUrl(projA.id, domainEmpresa, '/primary'), memberA);
    expect(r.status).toBe(403);
    r = await call('POST', webmailUrl(projA.id, domainEmpresa, '/primary'), ownerA);
    expect(r.status, r.raw).toBe(200);
    expect(r.json.webmail.isPrimary).toBe(true);
    expect(listAudit({ action: 'mailway_webmail_primary' })).toHaveLength(1);
  });

  it('aislamiento: un propietario no consulta, crea ni toca el webmail de un dominio de otro proyecto', async () => {
    const ajenas: ['GET' | 'POST', string][] = [
      ['GET', ''],
      ['POST', ''],
      ['POST', '/verify'],
      ['POST', '/cloudflare'],
      ['POST', '/primary'],
    ];
    for (const [method, accion] of ajenas) {
      mw.calls = [];
      let r = await call(method, webmailUrl(projA.id, domainB, accion), ownerA);
      expect(r.status, `${method} ${accion}: ${r.raw}`).toBe(404);
      r = await call(method, webmailUrl(projB.id, domainB, accion), ownerA);
      expect(r.status, `${method} ${accion} en el proyecto ajeno`).toBe(403);
      expect(whitelabelCalls(), `${method} ${accion}`).toEqual([]);
    }
    expect(mw.whitelabel.filter((w) => w.clientId === clientOf(projB.id).id)).toEqual([]);
  });

  it('un nombre que ya sirve otro servicio de Skyway, o el del panel, no se puede utilizar', async () => {
    let r = await call('POST', `/api/projects/${projA.id}/mail/domains`, ownerA, { domain: 'otraempresa.com' });
    expect(r.status, r.raw).toBe(201);
    const otra = r.json.domain.id;

    r = await call('GET', webmailUrl(projA.id, otra), ownerA);
    expect(r.json.webmail).toBeNull();
    expect(r.json.conflict).toMatch(/webmail\.otraempresa\.com está asignado a un servicio de Skyway/);
    expect(r.json.conflict).not.toMatch(/Otro/); // no revela de quién es
    mw.calls = [];
    r = await call('POST', webmailUrl(projA.id, otra), ownerA);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/asignado a un servicio de Skyway/);
    r = await call('POST', webmailUrl(projA.id, otra), admin());
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/«Otro \/ Web»/);
    expect(whitelabelCalls().filter((c) => c.method === 'POST')).toEqual([]);

    // El dominio del panel de Skyway tampoco (aquí, un panel en webmail.tienda.es).
    process.env.SKYWAY_DOMAIN = `${PANEL},webmail.tienda.es`;
    try {
      r = await call('POST', `/api/projects/${projA.id}/mail/domains`, ownerA, { domain: 'tienda.es' });
      expect(r.status, r.raw).toBe(201);
      domainTienda = r.json.domain.id;
      r = await call('POST', webmailUrl(projA.id, domainTienda), ownerA);
      expect(r.status).toBe(409);
      expect(r.json.error).toMatch(/es el del panel de Skyway/);
    } finally {
      process.env.SKYWAY_DOMAIN = PANEL;
    }
    expect(mw.whitelabel.map((w) => w.hostname)).toEqual(['webmail.empresa.com']);

    // Un servicio que ya tenía el nombre de un webmail creado (de antes de esta
    // regla): se avisa, y ni se marca como principal ni se crea su registro.
    const previo = createService(projB.id, 'Previo', 'previo', 'git', gitCfg(['webmail.empresa.com']));
    try {
      r = await call('POST', webmailUrl(projA.id, domainEmpresa, '/verify'), ownerA);
      expect(r.status, r.raw).toBe(200);
      expect(r.json.conflict).toMatch(/asignado a un servicio de Skyway/);
      mw.calls = [];
      for (const accion of ['/primary', '/cloudflare']) {
        r = await call('POST', webmailUrl(projA.id, domainEmpresa, accion), ownerA);
        expect(r.status, accion).toBe(409);
      }
      expect(whitelabelCalls().filter((c) => c.method === 'POST')).toEqual([]);
    } finally {
      updateService(previo.id, previo.name, gitCfg([]));
    }
  });

  it('con la cuenta suspendida no se crea', async () => {
    updateWorkspace(wsA.id, { status: 'suspended' });
    try {
      mw.calls = [];
      const r = await call('POST', webmailUrl(projA.id, domainPendiente), ownerA);
      expect(r.status).toBe(403);
      expect(r.json.error).toMatch(/suspendida/);
      expect(whitelabelCalls()).toEqual([]);
    } finally {
      updateWorkspace(wsA.id, { status: 'active' });
    }
  });
});

// ======================= nombres de marca blanca reservados =======================

describe('nombres de marca blanca reservados (también los que esperan DNS)', () => {
  const MAILWAY_USA = /lo utiliza el servicio de correo \(Mailway\)/;
  const claim = (domain: string, projectId: string, isAdmin = false) =>
    domainClaimError([domain], { projectId, serviceId: null, isAdmin });
  /** Añade un dominio a los que ya tiene el servicio (PATCH, como la interfaz). */
  const addDomain = (headers: Record<string, string>, svc: ServiceRow, domain: string) => {
    const actuales = ((getService(svc.id)!.config as GitConfig).domains ?? []) as string[];
    return call('PATCH', `/api/services/${svc.id}`, headers, { config: { domains: [...actuales, domain] } });
  };
  /** Una lectura del puente, como la que hace Traefik cada 15 s. */
  const sondeoTraefik = () => app.inject({ method: 'GET', url: '/api/traefik/mailway' });

  it('el webmail creado desde Skyway queda reservado al momento, sin esperar a la lectura del puente', async () => {
    // El puente aún no ha leído nada en estas pruebas: la reserva es la del alta.
    expect(mailwayPublishedHosts()).toEqual([]);
    expect(JSON.parse(getSetting('mailway.whitelabelHosts') ?? '[]')).toEqual(['webmail.empresa.com']);
    const r = await addDomain(ownerB, svcB, 'webmail.empresa.com');
    expect(r.status, r.raw).toBe(409);
    expect(r.json.error).toMatch(MAILWAY_USA);
  });

  it('un nombre de otro cliente que espera DNS no se puede asignar a un servicio (salvo el administrador)', async () => {
    mw.whitelabel.push({
      id: 'wld_pendiente',
      clientId: clientOf(projB.id).id,
      hostname: 'webmail.ajeno.com',
      kind: 'webmail',
      status: 'pending_dns',
      detail: '',
      lastCheckedAt: null,
      activatedAt: null,
      createdAt: 1,
      isPrimary: false,
    });
    // Antes de la siguiente lectura, Skyway aún no lo conoce.
    expect(claim('webmail.ajeno.com', projA.id)).toBeNull();

    const t = await sondeoTraefik();
    expect(t.statusCode).toBe(200);
    // Toda la instancia: la consulta va sin `clientId`.
    expect(mw.calls.filter((c) => c.path.startsWith('/api/whitelabel/domains')).map((c) => c.path)).toEqual(['/api/whitelabel/domains']);
    expect(JSON.parse(getSetting('mailway.whitelabelHosts') ?? '[]')).toEqual(['webmail.ajeno.com', 'webmail.empresa.com']);

    let r = await addDomain(ownerA, svcA, 'webmail.ajeno.com');
    expect(r.status, r.raw).toBe(409);
    expect(r.json.error).toMatch(MAILWAY_USA);
    r = await call('POST', `/api/projects/${projA.id}/services`, ownerA, {
      type: 'image',
      name: 'Suplantador',
      image: 'nginx',
      port: 80,
      domains: ['webmail.ajeno.com'],
    });
    expect(r.status, r.raw).toBe(409);
    expect(r.json.error).toMatch(MAILWAY_USA);
    // Las pilas y las plantillas pasan por la misma comprobación; el administrador, no.
    expect(claim('webmail.ajeno.com', projA.id)).toMatch(MAILWAY_USA);
    expect(claim('webmail.ajeno.com', projA.id, true)).toBeNull();
  });

  it('con Mailway caído se conserva la última lista (también tras reiniciar el panel)', async () => {
    resetMailwayTraefikState(); // sin memoria: como tras un reinicio
    mw.down = true;
    try {
      const t = await sondeoTraefik();
      expect(t.statusCode).toBe(200);
      expect(claim('webmail.ajeno.com', projA.id)).toMatch(MAILWAY_USA);
      const r = await addDomain(ownerA, svcA, 'webmail.ajeno.com');
      expect(r.status).toBe(409);
    } finally {
      mw.down = false;
    }
  });

  it('un nombre que Mailway ya no tiene se libera en la siguiente lectura', async () => {
    mw.whitelabel = mw.whitelabel.filter((w) => w.id !== 'wld_pendiente');
    resetMailwayTraefikState();
    expect((await sondeoTraefik()).statusCode).toBe(200);
    expect(claim('webmail.ajeno.com', projA.id)).toBeNull();
    expect(claim('webmail.empresa.com', projB.id)).toMatch(MAILWAY_USA);
  });

  it('un alta durante una lectura en curso no se pierde cuando la lectura termina', async () => {
    resetMailwayTraefikState();
    mw.whitelabelListDelayMs = 80;
    try {
      const lectura = sondeoTraefik();
      // La lectura del puente ya tiene su lista (sin el alta) y está esperando.
      await vi.waitFor(() => expect(mw.calls.some((c) => c.path === '/api/whitelabel/domains')).toBe(true));
      const r = await call('POST', webmailUrl(projA.id, domainTienda), ownerA);
      expect(r.status, r.raw).toBe(201);
      expect((await lectura).statusCode).toBe(200);
    } finally {
      mw.whitelabelListDelayMs = 0;
    }
    expect(JSON.parse(getSetting('mailway.whitelabelHosts') ?? '[]')).toContain('webmail.tienda.es');
    expect(claim('webmail.tienda.es', projB.id)).toMatch(MAILWAY_USA);
  });

  it('«Desconectar Mailway» libera los nombres reservados, salvo los que su DNS creó el administrador', async () => {
    // webmail.empresa.com lo creó el administrador con el registro automático
    // en Cloudflare: el CNAME sigue en la zona aunque se desconecte Mailway.
    // webmail.tienda.es lo creó el propietario sin Cloudflare.
    expect(getMailwayDnsReserva('webmail.empresa.com')).toBeTruthy();
    expect(getMailwayDnsReserva('webmail.tienda.es')).toBeUndefined();
    const r = await call('POST', '/api/mailway/disconnect', admin());
    expect(r.status, r.raw).toBe(200);
    expect(getSetting('mailway.whitelabelHosts')).toBeNull();
    expect(claim('webmail.tienda.es', projB.id)).toBeNull();
    expect(claim('webmail.empresa.com', projB.id)).toMatch(/reservado por el administrador/);
    const p = await addDomain(ownerB, svcB, 'webmail.tienda.es');
    expect(p.status, p.raw).toBe(200);
  });
});
