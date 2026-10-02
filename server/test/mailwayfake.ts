/**
 * Doble en memoria de Mailway detrás de `fetch`, compartido por las pruebas de
 * la integración. Sigue el contrato de su API de integraciones (rutas, formas
 * de respuesta, errores `{error, code}`) y reproduce las validaciones de
 * Mailway que Skyway tiene que respetar: longitudes, formato del buzón,
 * límite de contraseñas de aplicación, 409 al borrar un buzón con claves.
 * Así se prueba también el cliente HTTP real (`mailway.ts`).
 */

export const MW_BASE = 'https://mail-panel.example.com';
export const MW_TOKEN = 'mwt_0123abcd_EsteEsElSecretoDeGestion';
export const TRAEFIK_TOKEN = 'traefik-token-secreto-1';

export interface FakeClient {
  id: string;
  name: string;
  slug: string;
  externalRef: string | null;
  suspended: boolean;
  planId: string;
}
export interface FakeDomain {
  id: string;
  clientId: string;
  domain: string;
  status: 'pending_dns' | 'active' | 'error';
  /** null = propiedad sin probar: Mailway no deja crear buzones. */
  ownershipVerifiedAt: number | null;
}
export interface FakeMailbox {
  id: string;
  domainId: string;
  domain: string;
  localPart: string;
  email: string;
  displayName: string;
  quotaMb: number;
  status: 'active';
  usedBytes: number | null;
}
export interface FakeApiKey {
  id: string;
  clientId: string;
  name: string;
  prefix: string;
  senderMailboxId: string;
  senderEmail: string;
  revokedAt: number | null;
  createdAt: number;
}
export interface FakeAppPassword {
  id: string;
  mailboxId: string;
  email: string;
  name: string;
  revokedAt: number | null;
  createdAt: number;
}
export interface FakeWhitelabel {
  id: string;
  clientId: string;
  hostname: string;
  kind: 'webmail' | 'panel';
  status: 'pending_dns' | 'issuing' | 'active' | 'error';
  detail: string;
  lastCheckedAt: number | null;
  activatedAt: number | null;
  createdAt: number;
  isPrimary: boolean;
}
export interface FakeCall {
  method: string;
  path: string;
  auth: string | null;
  traefik: string | null;
  host: string;
  /** Cuerpo JSON de la petición (undefined si no lo había). */
  body: unknown;
}

const PLANES = [
  { id: 'pln_1', name: 'Básico', maxDomains: 2, maxMailboxes: 10, maxAliases: 10, mailboxQuotaMb: 1024 },
  { id: 'pln_2', name: 'Empresa', maxDomains: 20, maxMailboxes: 500, maxAliases: 500, mailboxQuotaMb: 10240 },
];

export const mw = {
  role: 'admin' as 'admin' | 'client',
  traefikToken: TRAEFIK_TOKEN,
  down: false,
  plans: PLANES,
  clients: [] as FakeClient[],
  domains: [] as FakeDomain[],
  mailboxes: [] as FakeMailbox[],
  apiKeys: [] as FakeApiKey[],
  appPasswords: [] as FakeAppPassword[],
  /** Dominios propios de los clientes (marca blanca). */
  whitelabel: [] as FakeWhitelabel[],
  /**
   * Si es true, el DNS de los dominios propios ya apunta al servidor: cada
   * comprobación los avanza de «Esperando DNS» a «Emitiendo certificado» y
   * después a «En servicio», como el vigilante de Mailway.
   */
  whitelabelDnsOk: false,
  /** Líneas que se añaden al final del fichero de zona (registros que Mailway no debería enviar). */
  zoneExtra: [] as string[],
  traefikConfig: {} as unknown,
  /** Campos con los que se sobrescribe la respuesta de `/api/integrations/info`. */
  infoOverride: {} as Record<string, unknown>,
  /** Si es true, los dominios nuevos nacen con la propiedad pendiente (como Mailway). */
  requireOwnership: false,
  /** Si se indica, toda petición con Bearer recibe este 401 (token revocado, caducado…). */
  reject401: null as { error: string; code: string } | null,
  /** Peticiones recibidas: método, ruta (con consulta), cabeceras de autenticación y cuerpo. */
  calls: [] as FakeCall[],
  seq: 0,
  /** Hosts a los que «no se llega» (contenedores fuera de Docker). */
  unreachable: new Set<string>(),
};

const nextId = (p: string) => `${p}_${++mw.seq}`;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const badRequest = (error: string, code = 'bad_request') => json(400, { error, code });

function domainRecord(d: FakeDomain) {
  return {
    ...d,
    dkimSelector: 'mw1',
    dnsStatus: { checks: [], requiredTotal: 4, requiredOk: d.status === 'active' ? 4 : 1, allRequiredOk: d.status === 'active', checkedAt: 1 },
    lastCheckedAt: null,
    verifiedAt: null,
    createdAt: 1,
    cloudflare: null,
    ownershipVerifiedAt: d.ownershipVerifiedAt,
    ownershipRecord: { type: 'TXT', name: `_mailway.${d.domain}`, content: `mailway-verificacion=${d.id}` },
  };
}

/** Mismo patrón que `mailboxes.ts` de Mailway. */
const LOCAL_PART_MAILWAY = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;

/** Mismo patrón que `whitelabel.ts` de Mailway. */
const HOSTNAME_MAILWAY = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

function instrucciones(hostname: string) {
  return [
    {
      type: 'CNAME',
      name: hostname,
      value: 'mail.example.com.',
      recommended: true,
      help: 'Opción recomendada: si algún día se cambia de servidor, no será necesario modificar este registro.',
    },
    { type: 'A', name: hostname, value: '203.0.113.10', recommended: false, help: 'Alternativa: apunta directamente a la IP del servidor.' },
  ];
}

/** Siguiente estado de un dominio propio al comprobarlo (refreshClientDomain de Mailway, simplificado). */
function comprobarDominioPropio(w: FakeWhitelabel): void {
  w.lastCheckedAt = Date.now();
  if (!mw.whitelabelDnsOk) {
    w.status = 'pending_dns';
    w.detail = 'El dominio todavía no existe en el DNS. Cree el registro y espere unos minutos.';
  } else if (w.status === 'pending_dns' || w.status === 'error') {
    w.status = 'issuing';
    w.detail = 'El certificado todavía no está emitido. Vuelva a comprobarlo en un minuto.';
  } else {
    w.status = 'active';
    w.detail = 'HTTPS responde correctamente (HTTP 200).';
    w.activatedAt ??= Date.now();
  }
}

/** Fichero de zona como el de `zonefile.ts` de Mailway (cabecera abreviada). */
function ficheroDeZona(d: FakeDomain, nivel: string): string {
  return [
    `;  Registros DNS de correo para ${d.domain}`,
    `;  Generados por Mailway · nivel: ${nivel}`,
    ';  IMPORTACIÓN EN CLOUDFLARE',
    ';    DNS  →  Records  →  Import and Export  →  Import DNS records',
    '',
    '$TTL 3600',
    '',
    `${d.domain}.\t3600\tIN\tMX\t10 mail.example.com.`,
    `${d.domain}.\t3600\tIN\tTXT\t"v=spf1 mx -all"`,
    `mw1._domainkey.${d.domain}.\t3600\tIN\tTXT\t"v=DKIM1; k=rsa; p=MIIBIjANBgkq"`,
    `_dmarc.${d.domain}.\t3600\tIN\tTXT\t"v=DMARC1; p=quarantine"`,
    ...(nivel === 'obligatorios'
      ? []
      : [
          `autoconfig.${d.domain}.\t3600\tIN\tCNAME\tmail.example.com.`,
          `_imaps._tcp.${d.domain}.\t3600\tIN\tSRV\t0 1 993 mail.example.com.`,
          `_mailway.${d.domain}.\t3600\tIN\tTXT\t"mailway-verificacion=${d.id}"`,
        ]),
    ...mw.zoneExtra,
    '',
  ].join('\n');
}

export async function fakeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  mw.calls.push({
    method,
    path: url.pathname + url.search,
    auth: headers.get('authorization'),
    traefik: headers.get('x-mailway-token'),
    host: url.host,
    body,
  });
  if (mw.unreachable.has(url.hostname)) {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  }
  if (mw.down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  if (url.origin !== MW_BASE) return json(404, { error: 'Host desconocido' });

  const path = url.pathname;
  const b = (body ?? {}) as Record<string, unknown>;

  if (path === '/api/traefik/config') {
    if (headers.get('x-mailway-token') !== mw.traefikToken) return json(401, { error: 'Token no válido.' });
    return json(200, mw.traefikConfig);
  }
  if (mw.reject401) return json(401, mw.reject401);
  if (headers.get('authorization') !== `Bearer ${MW_TOKEN}`) return json(401, { error: 'No autenticado', code: 'unauthorized' });

  const admin = mw.role === 'admin';
  const forbidden = () => json(403, { error: 'No tienes permiso para hacer esto.', code: 'forbidden' });
  let m: RegExpMatchArray | null;

  if (path === '/api/integrations/info' && method === 'GET') {
    return json(200, {
      version: '1.0.0',
      brandName: 'Correo Demo',
      mailHostname: 'mail.example.com',
      webmailUrl: 'https://webmail.example.com',
      panelUrl: MW_BASE,
      imap: { host: 'mail.example.com', port: 993, security: 'SSL/TLS' },
      smtp: { host: 'mail.example.com', port: 465, security: 'SSL/TLS' },
      submission: { host: 'mail.example.com', port: 587, security: 'STARTTLS' },
      user: { id: 'usr_1', email: 'admin@mail.example.com', name: 'Admin', role: mw.role, clientId: null },
      features: { cloudflare: true, autoconfig: true, portal: true },
      traefik: admin ? { configPath: '/api/traefik/config', token: mw.traefikToken } : null,
      ...mw.infoOverride,
    });
  }
  if (path === '/api/plans') {
    if (!admin) return forbidden();
    return json(200, { plans: mw.plans });
  }
  if (path === '/api/clients' && method === 'GET') {
    if (!admin) return forbidden();
    return json(200, { clients: mw.clients });
  }
  if (path === '/api/integrations/clients/ensure' && method === 'POST') {
    if (!admin) return forbidden();
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (name.length < 2) return badRequest('El nombre del cliente es demasiado corto.');
    if (name.length > 80) return badRequest('El nombre del cliente no puede superar los 80 caracteres.');
    if (b.planId !== undefined && !mw.plans.some((p) => p.id === b.planId)) return badRequest('El plan indicado no existe.', 'plan_not_found');
    const existing = mw.clients.find((c) => c.externalRef === b.externalRef);
    if (existing) return json(200, { client: existing, created: false });
    const client: FakeClient = {
      id: nextId('cli'),
      name,
      slug: name.toLowerCase(),
      externalRef: String(b.externalRef),
      suspended: false,
      planId: typeof b.planId === 'string' ? b.planId : 'pln_1',
    };
    mw.clients.push(client);
    return json(200, { client, created: true });
  }
  if (path === '/api/integrations/clients/by-ref') {
    if (!admin) return forbidden();
    const client = mw.clients.find((c) => c.externalRef === url.searchParams.get('externalRef'));
    return client ? json(200, { client }) : json(404, { error: 'Cliente no encontrado.', code: 'not_found' });
  }
  if ((m = path.match(/^\/api\/integrations\/clients\/([^/]+)\/link$/))) {
    if (!admin) return forbidden();
    const client = mw.clients.find((c) => c.id === m![1]);
    if (!client) return json(404, { error: 'Cliente no encontrado.' });
    if (method === 'PUT') {
      if (mw.clients.some((c) => c.id !== client.id && c.externalRef === b.externalRef)) {
        return json(409, { error: 'Otro cliente ya usa esa referencia.', code: 'conflict' });
      }
      client.externalRef = String(b.externalRef);
    } else {
      // Como Mailway: con ?externalRef solo se borra si sigue siendo esa.
      const expected = url.searchParams.get('externalRef');
      if (expected !== null && client.externalRef !== null && client.externalRef !== expected) {
        return json(409, { error: 'Referencia distinta.', code: 'external_ref_mismatch' });
      }
      client.externalRef = null;
    }
    return json(200, { client });
  }
  if ((m = path.match(/^\/api\/integrations\/clients\/([^/]+)\/summary$/))) {
    const client = mw.clients.find((c) => c.id === m![1]);
    if (!client) return json(404, { error: 'Cliente no encontrado.', code: 'not_found' });
    const domains = mw.domains.filter((d) => d.clientId === client.id);
    const ids = new Set(domains.map((d) => d.id));
    const mailboxes = mw.mailboxes.filter((x) => ids.has(x.domainId));
    const boxIds = new Set(mailboxes.map((x) => x.id));
    const plan = mw.plans.find((p) => p.id === client.planId) ?? mw.plans[0];
    return json(200, {
      client,
      plan,
      usage: { domains: domains.length, mailboxes: mailboxes.length },
      domains: domains.map(domainRecord),
      mailboxes,
      apiKeys: mw.apiKeys.filter((k) => k.clientId === client.id),
      appPasswords: mw.appPasswords.filter((a) => boxIds.has(a.mailboxId)),
      connection: { imap: null, submission: null, webmailUrl: mw.infoOverride.webmailUrl ?? 'https://webmail.example.com' },
    });
  }
  if (path === '/api/domains' && method === 'POST') {
    const d: FakeDomain = {
      id: nextId('dom'),
      clientId: String(b.clientId),
      domain: String(b.domain),
      status: 'pending_dns',
      ownershipVerifiedAt: mw.requireOwnership ? null : 1,
    };
    mw.domains.push(d);
    return json(200, { domain: domainRecord(d) });
  }
  if ((m = path.match(/^\/api\/domains\/([^/]+)\/(verify|dns|cloudflare|cloudflare\/apply)$/))) {
    const d = mw.domains.find((x) => x.id === m![1]);
    if (!d) return json(404, { error: 'Dominio no encontrado.' });
    if (m[2] === 'verify') {
      d.status = 'active';
      d.ownershipVerifiedAt ??= Date.now();
      return json(200, { domain: domainRecord(d) });
    }
    if (m[2] === 'dns') return json(200, { records: [{ type: 'MX', name: d.domain, content: '10 mail.example.com' }] });
    if (m[2] === 'cloudflare') {
      return json(200, {
        available: true,
        account: { id: 'cfa_1', label: 'Cuenta' },
        zone: { id: 'z1', name: d.domain, status: 'active' },
        changes: [{ action: 'create', type: 'MX', name: d.domain, content: 'mail.example.com', priority: 10, reason: 'Falta', required: true }],
        summary: { create: 1, update: 0, keep: 0, conflict: 0 },
      });
    }
    return json(200, { applied: [{ action: 'create', type: 'MX', name: d.domain }], errors: [], domain: domainRecord(d) });
  }
  if ((m = path.match(/^\/api\/domains\/([^/]+)\/zonefile$/)) && method === 'GET') {
    const d = mw.domains.find((x) => x.id === m![1]);
    if (!d) return json(404, { error: 'Dominio no encontrado.', code: 'not_found' });
    const nivel = url.searchParams.get('nivel') ?? 'recomendados';
    return new Response(ficheroDeZona(d, nivel), {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="${d.domain}-mailway-${nivel}.txt"`,
      },
    });
  }
  if (path === '/api/whitelabel/domains' && method === 'GET') {
    // Como Mailway con un token de administrador: filtra por `clientId` si se indica.
    if (!admin) return forbidden();
    const clientId = url.searchParams.get('clientId');
    return json(200, { domains: mw.whitelabel.filter((w) => !clientId || w.clientId === clientId) });
  }
  if (path === '/api/whitelabel/domains' && method === 'POST') {
    const clientId = typeof b.clientId === 'string' ? b.clientId : '';
    if (!clientId) return badRequest('Indique a qué cliente pertenece el dominio.', 'client_required');
    if (!mw.clients.some((c) => c.id === clientId)) return json(404, { error: 'Cliente no encontrado.', code: 'not_found' });
    const hostname = String(b.hostname ?? '').trim().toLowerCase();
    if (!HOSTNAME_MAILWAY.test(hostname)) {
      return badRequest('El dominio no es válido. Escriba solo el nombre, por ejemplo: webmail.suempresa.com');
    }
    if (['autoconfig', 'autodiscover', 'mta-sts'].includes(hostname.split('.')[0])) {
      return badRequest('Ese nombre está reservado para la configuración automática.', 'reserved_hostname');
    }
    const parent = mw.domains
      .filter((d) => d.clientId === clientId && hostname.endsWith(`.${d.domain}`))
      .sort((a, z) => z.domain.length - a.domain.length)[0];
    if (!parent) {
      return badRequest('El nombre debe ser un subdominio de uno de los dominios de correo del cliente.', 'hostname_not_owned');
    }
    if (parent.ownershipVerifiedAt === null) {
      return badRequest(
        `Todavía no se ha comprobado la propiedad del dominio de correo ${parent.domain}. Compruébela primero en su ficha, en «Dominios».`,
        'domain_not_verified',
      );
    }
    if (mw.whitelabel.some((w) => w.hostname === hostname)) return json(409, { error: 'Ese dominio ya está dado de alta.', code: 'conflict' });
    if (mw.whitelabel.filter((w) => w.clientId === clientId).length >= 5) {
      return badRequest('Se ha alcanzado el máximo de 5 dominios propios por cliente.', 'whitelabel_limit');
    }
    const w: FakeWhitelabel = {
      id: nextId('wld'),
      clientId,
      hostname,
      kind: b.kind === 'panel' ? 'panel' : 'webmail',
      status: 'pending_dns',
      detail: '',
      lastCheckedAt: null,
      activatedAt: null,
      createdAt: Date.now(),
      isPrimary: false,
    };
    comprobarDominioPropio(w);
    mw.whitelabel.push(w);
    return json(200, { domain: w, instructions: instrucciones(hostname) });
  }
  if ((m = path.match(/^\/api\/whitelabel\/domains\/([^/]+)(\/verify|\/cloudflare|\/primary)?$/))) {
    const w = mw.whitelabel.find((x) => x.id === m![1]);
    if (!w) return json(404, { error: 'Dominio no encontrado.', code: 'not_found' });
    if (!m[2] && method === 'GET') return json(200, { domain: w, instructions: instrucciones(w.hostname) });
    if (m[2] === '/verify' && method === 'POST') {
      comprobarDominioPropio(w);
      return json(200, { domain: w, instructions: instrucciones(w.hostname) });
    }
    if (m[2] === '/cloudflare' && method === 'POST') {
      return json(200, { applied: [{ action: 'create', type: 'CNAME', name: w.hostname }], errors: [], skipped: [], domain: w });
    }
    if (m[2] === '/primary' && method === 'POST') {
      if (w.kind !== 'webmail' || w.status !== 'active') {
        return badRequest('Compruebe primero que este dominio de webmail funciona con HTTPS.', 'webmail_not_active');
      }
      for (const o of mw.whitelabel) if (o.clientId === w.clientId && o.kind === 'webmail') o.isPrimary = false;
      w.isPrimary = true;
      return json(200, { domain: w });
    }
  }
  if (path === '/api/mailboxes' && method === 'POST') {
    const d = mw.domains.find((x) => x.id === b.domainId);
    if (!d) return json(404, { error: 'Dominio no encontrado.' });
    if (d.ownershipVerifiedAt === null) {
      return json(409, {
        error: `Antes de crear buzones o alias en ${d.domain} es necesario comprobar que el dominio es suyo.`,
        code: 'domain_ownership_pending',
      });
    }
    const localPart = String(b.localPart ?? '');
    if (!LOCAL_PART_MAILWAY.test(localPart)) {
      return badRequest('El nombre del buzón solo puede contener letras minúsculas, números, puntos, guiones y guiones bajos.');
    }
    if (typeof b.displayName === 'string' && b.displayName.length > 80) {
      return badRequest('El nombre visible no puede superar los 80 caracteres.');
    }
    const box: FakeMailbox = {
      id: nextId('mbx'),
      domainId: d.id,
      domain: d.domain,
      localPart,
      email: `${localPart}@${d.domain}`,
      displayName: typeof b.displayName === 'string' ? b.displayName : '',
      quotaMb: 1024,
      status: 'active',
      usedBytes: 2048,
    };
    mw.mailboxes.push(box);
    return json(200, { mailbox: box, password: 'Contraseña-Del-Buzon-1' });
  }
  if ((m = path.match(/^\/api\/mailboxes\/([^/]+)\/app-passwords\/([^/]+)$/)) && method === 'DELETE') {
    const app = mw.appPasswords.find((a) => a.id === m![2] && a.mailboxId === m![1]);
    if (!app) return json(404, { error: 'Contraseña de aplicación no encontrada.', code: 'not_found' });
    app.revokedAt ??= Date.now();
    return json(200, { ok: true });
  }
  if ((m = path.match(/^\/api\/mailboxes\/([^/]+)(\/password|\/setup-links|\/app-passwords)?$/))) {
    const box = mw.mailboxes.find((x) => x.id === m![1]);
    if (!box) return json(404, { error: 'Buzón no encontrado.' });
    if (!m[2] && method === 'DELETE') {
      const enUso = mw.apiKeys.filter((k) => k.senderMailboxId === box.id && !k.revokedAt);
      if (enUso.length > 0) {
        return json(409, {
          error: `El buzón es el remitente de ${enUso.length} clave(s) de API activas. Revoque esas claves antes de eliminarlo.`,
          code: 'mailbox_in_use',
        });
      }
      mw.mailboxes = mw.mailboxes.filter((x) => x.id !== box.id);
      return json(200, { ok: true });
    }
    if (m[2] === '/password') return json(200, { ok: true, password: 'Contraseña-Nueva-2' });
    if (m[2] === '/setup-links') {
      return json(200, { link: { id: 'lnk_1', url: `${MW_BASE}/conectar/tok-secreto`, expiresAt: 99, hasPassword: !!b.password } });
    }
    if (m[2] === '/app-passwords' && method === 'POST') {
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!name || name.length > 60) return badRequest('El nombre no puede superar los 60 caracteres.');
      if (mw.appPasswords.filter((a) => a.mailboxId === box.id && !a.revokedAt).length >= 25) {
        return json(409, { error: 'Este buzón ya tiene 25 contraseñas de aplicación activas.', code: 'app_password_limit' });
      }
      const app: FakeAppPassword = { id: nextId('app'), mailboxId: box.id, email: box.email, name, revokedAt: null, createdAt: Date.now() };
      mw.appPasswords.push(app);
      return json(200, { appPassword: app, password: `ContraseñaDeAplicacion-Secreta-${app.id}` });
    }
  }
  if (path === '/api/apikeys' && method === 'POST') {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) return badRequest('Indica un nombre para la clave.');
    if (name.length > 60) return badRequest('El nombre admite como máximo 60 caracteres.');
    const sender = mw.mailboxes.find((x) => x.id === b.senderMailboxId);
    if (!sender) return json(404, { error: 'Buzón no encontrado.' });
    const key: FakeApiKey = {
      id: nextId('key'),
      clientId: String(b.clientId),
      name,
      prefix: 'mw_Clav',
      senderMailboxId: sender.id,
      senderEmail: sender.email,
      revokedAt: null,
      createdAt: Date.now(),
    };
    mw.apiKeys.push(key);
    return json(200, { key: `mw_ClaveApiSecreta_${key.id}`, info: key });
  }
  if ((m = path.match(/^\/api\/apikeys\/([^/]+)$/)) && method === 'DELETE') {
    const key = mw.apiKeys.find((k) => k.id === m![1]);
    if (!key) return json(404, { error: 'Clave no encontrada.', code: 'not_found' });
    if (key.revokedAt) return json(409, { error: 'Esta clave ya estaba revocada.', code: 'conflict' });
    key.revokedAt = Date.now();
    return json(200, { ok: true });
  }
  return json(404, { error: `Ruta no simulada: ${method} ${path}` });
}
