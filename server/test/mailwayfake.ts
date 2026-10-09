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
  contactEmail?: string;
  /** Interruptor del webmail automático del cliente (activado si no se indica, como en Mailway). */
  webmailAutomatico?: boolean;
}
export interface FakeDomain {
  id: string;
  clientId: string;
  domain: string;
  status: 'pending_dns' | 'active' | 'error';
  /** null = propiedad sin probar: Mailway no deja crear buzones. */
  ownershipVerifiedAt: number | null;
  /** Cuenta de Cloudflare asociada al dominio (Mailway la guarda al aplicar su DNS). */
  cloudflareAccountId?: string | null;
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
  /** Lo dio de alta el webmail automático (se retira al apagarlo). */
  automatico?: boolean;
}
/** Enlace de bienvenida de un cliente (`invitaciones.ts` de Mailway). */
export interface FakeInvite {
  id: string;
  clientId: string;
  email: string;
  name: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  openedAt: number | null;
  acceptedAt: number | null;
  revokedAt: number | null;
  /** false = Mailway ya no conserva la URL (no se puede volver a mostrar). */
  recoverable: boolean;
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
   * El Mailway conectado tiene el webmail automático: lo declara en
   * `features.webmailAutomatico`, lo incluye en el resumen y admite su
   * interruptor. false = un Mailway anterior.
   */
  webmailAutoSoportado: true,
  /** Interruptor global del webmail automático de la instancia. */
  webmailAutoGlobal: true,
  /** El Mailway conectado declara `features.invites` (enlaces de bienvenida). false = uno anterior. */
  invitesSoportado: true,
  /** Enlaces de bienvenida de los clientes. */
  invites: [] as FakeInvite[],
  /** Usuarios del panel de Mailway (para `user_exists` y `existingUser`). */
  panelUsers: [{ email: 'admin@mail.example.com', role: 'admin', clientId: null }] as {
    email: string;
    role: 'admin' | 'client';
    clientId: string | null;
  }[],
  /**
   * Si es true, el DNS de los dominios propios ya apunta al servidor: cada
   * comprobación los avanza de «Esperando DNS» a «Emitiendo certificado» y
   * después a «En servicio», como el vigilante de Mailway.
   */
  whitelabelDnsOk: false,
  /** Líneas que se añaden al final del fichero de zona (registros que Mailway no debería enviar). */
  zoneExtra: [] as string[],
  /**
   * Retraso de la lista de dominios propios de TODOS los clientes (la del
   * puente). La lista se calcula ANTES de esperar, como una respuesta que salió
   * de Mailway antes de un alta posterior.
   */
  whitelabelListDelayMs: 0,
  traefikConfig: {} as unknown,
  /** Campos con los que se sobrescribe la respuesta de `/api/integrations/info`. */
  infoOverride: {} as Record<string, unknown>,
  /** Si es true, los dominios nuevos nacen con la propiedad pendiente (como Mailway). */
  requireOwnership: false,
  /** Con `autoDns`, Mailway crea también los CNAME de autoconfiguración (como el real con los recomendados). */
  autoDnsConAutoconfig: false,
  /** Si se indica, toda petición con Bearer recibe este 401 (token revocado, caducado…). */
  reject401: null as { error: string; code: string } | null,
  /** Cuentas de Cloudflare conectadas en Mailway (clientId null = de la instancia). */
  cloudflareAccounts: [] as { id: string; clientId: string | null; label: string }[],
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

function domainRecord(fake: FakeDomain) {
  const { cloudflareAccountId, ...d } = fake;
  return {
    ...d,
    dkimSelector: 'mw1',
    dnsStatus: { checks: [], requiredTotal: 4, requiredOk: d.status === 'active' ? 4 : 1, allRequiredOk: d.status === 'active', checkedAt: 1 },
    lastCheckedAt: null,
    verifiedAt: null,
    createdAt: 1,
    cloudflare: cloudflareAccountId ? { accountId: cloudflareAccountId, zoneId: 'z1' } : null,
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

/** Webmail de marca de un cliente como lo resumen Mailway (resumen e interruptor del webmail automático). */
function webmailDelCliente(clientId: string) {
  return mw.whitelabel
    .filter((w) => w.clientId === clientId && w.kind === 'webmail')
    .map((w) => ({ id: w.id, hostname: w.hostname, status: w.status, detail: w.detail, automatico: !!w.automatico, isPrimary: w.isPrimary }));
}

/** Estado de un enlace de bienvenida, como `estado()` de `invitaciones.ts`. */
function estadoInvitacion(i: FakeInvite): 'pending' | 'accepted' | 'expired' | 'revoked' {
  if (i.acceptedAt) return 'accepted';
  if (i.revokedAt) return 'revoked';
  if (i.expiresAt <= Date.now()) return 'expired';
  return 'pending';
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
    // Como Mailway 1.1: declara `cloudflareSoloCrear` (el DNS automático solo
    // crea lo que falta). Para simular uno anterior, `mw.infoOverride` con
    // otra versión y sin esa bandera.
    return json(200, {
      version: '1.1.0',
      brandName: 'Correo Demo',
      mailHostname: 'mail.example.com',
      webmailUrl: 'https://webmail.example.com',
      panelUrl: MW_BASE,
      imap: { host: 'mail.example.com', port: 993, security: 'SSL/TLS' },
      smtp: { host: 'mail.example.com', port: 465, security: 'SSL/TLS' },
      submission: { host: 'mail.example.com', port: 587, security: 'STARTTLS' },
      user: { id: 'usr_1', email: 'admin@mail.example.com', name: 'Admin', role: mw.role, clientId: null },
      features: {
        cloudflare: true,
        autoconfig: true,
        portal: true,
        cloudflareSoloCrear: true,
        ...(mw.webmailAutoSoportado ? { webmailAutomatico: mw.webmailAutoGlobal } : {}),
        ...(mw.invitesSoportado ? { invites: true } : {}),
      },
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
      contactEmail: typeof b.contactEmail === 'string' ? b.contactEmail : '',
    };
    mw.clients.push(client);
    return json(200, { client, created: true });
  }
  if (path === '/api/integrations/clients/by-ref') {
    if (!admin) return forbidden();
    const client = mw.clients.find((c) => c.externalRef === url.searchParams.get('externalRef'));
    return client ? json(200, { client }) : json(404, { error: 'Cliente no encontrado.', code: 'client_not_found' });
  }
  if ((m = path.match(/^\/api\/integrations\/clients\/([^/]+)\/link$/))) {
    if (!admin) return forbidden();
    const client = mw.clients.find((c) => c.id === m![1]);
    if (!client) return json(404, { error: 'Cliente no encontrado.' });
    if (method === 'PUT') {
      const otro = mw.clients.find((c) => c.id !== client.id && c.externalRef === b.externalRef);
      if (otro) {
        return json(409, {
          error: `La referencia externa ya está vinculada a otro cliente («${otro.name}»). Desvincúlala antes de asignarla a este.`,
          code: 'external_ref_in_use',
        });
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
      // Como Mailway: el cliente del resumen no lleva el correo de contacto ni el plan.
      client: {
        id: client.id,
        name: client.name,
        slug: client.slug,
        externalRef: client.externalRef,
        suspended: client.suspended,
        ...(mw.webmailAutoSoportado ? { webmailAutomatico: client.webmailAutomatico !== false } : {}),
      },
      plan,
      usage: { domains: domains.length, mailboxes: mailboxes.length },
      domains: domains.map(domainRecord),
      mailboxes,
      apiKeys: mw.apiKeys.filter((k) => k.clientId === client.id),
      appPasswords: mw.appPasswords.filter((a) => boxIds.has(a.mailboxId)),
      connection: { imap: null, submission: null, webmailUrl: mw.infoOverride.webmailUrl ?? 'https://webmail.example.com' },
      ...(mw.webmailAutoSoportado ? { webmailDomains: webmailDelCliente(client.id) } : {}),
    });
  }
  if ((m = path.match(/^\/api\/clients\/([^/]+)$/)) && (method === 'GET' || method === 'PATCH')) {
    if (!admin) return forbidden();
    const client = mw.clients.find((c) => c.id === m![1]);
    if (!client) return json(404, { error: 'Cliente no encontrado.', code: 'not_found' });
    if (method === 'PATCH') {
      // Como Mailway: parcial, y el nombre entre 2 y 80 caracteres.
      if (b.name !== undefined) {
        const name = typeof b.name === 'string' ? b.name.trim() : '';
        if (name.length < 2) return badRequest('El nombre del cliente debe tener al menos 2 caracteres.');
        if (name.length > 80) return badRequest('El nombre del cliente no puede superar los 80 caracteres.');
        client.name = name;
      }
    }
    const plan = mw.plans.find((p) => p.id === client.planId) ?? mw.plans[0];
    const full = { ...client, contactEmail: client.contactEmail ?? '', plan, users: [] };
    return json(200, method === 'GET' ? { client: full, plan, users: [] } : { client: full });
  }
  if ((m = path.match(/^\/api\/clients\/([^/]+)\/webmail-automatico$/)) && method === 'PUT' && mw.webmailAutoSoportado) {
    if (!admin) return forbidden();
    const client = mw.clients.find((c) => c.id === m![1]);
    if (!client) return json(404, { error: 'Cliente no encontrado.', code: 'not_found' });
    if (typeof b.activo !== 'boolean') return badRequest('Indica si el webmail automático debe estar activado.');
    client.webmailAutomatico = b.activo;
    if (!b.activo) {
      // Retira los que creó solo; los dados de alta a mano se quedan.
      mw.whitelabel = mw.whitelabel.filter((w) => !(w.clientId === client.id && w.automatico));
    } else if (mw.webmailAutoGlobal) {
      // Prepara en el momento webmail.<dominio> de cada dominio con la propiedad comprobada.
      for (const d of mw.domains.filter((x) => x.clientId === client.id && x.ownershipVerifiedAt !== null)) {
        const hostname = `webmail.${d.domain.toLowerCase()}`;
        if (mw.whitelabel.some((w) => w.hostname === hostname)) continue;
        const w: FakeWhitelabel = {
          id: nextId('wld'),
          clientId: client.id,
          hostname,
          kind: 'webmail',
          status: 'pending_dns',
          detail: '',
          lastCheckedAt: null,
          activatedAt: null,
          createdAt: Date.now(),
          isPrimary: false,
          automatico: true,
        };
        comprobarDominioPropio(w);
        mw.whitelabel.push(w);
      }
    }
    return json(200, { webmailAutomatico: client.webmailAutomatico, global: mw.webmailAutoGlobal, webmailDomains: webmailDelCliente(client.id) });
  }
  if ((m = path.match(/^\/api\/clients\/([^/]+)\/invites$/))) {
    if (!admin) return forbidden();
    const client = mw.clients.find((c) => c.id === m![1]);
    if (!client) return json(404, { error: 'Cliente no encontrado.', code: 'not_found' });
    if (method === 'GET') {
      const invites = mw.invites
        .filter((i) => i.clientId === client.id)
        .sort((a, z) => z.createdAt - a.createdAt)
        .slice(0, 50)
        .map((i) => {
          const status = estadoInvitacion(i);
          return {
            id: i.id,
            email: i.email,
            name: i.name,
            createdAt: i.createdAt,
            expiresAt: i.expiresAt,
            openedAt: i.openedAt,
            acceptedAt: i.acceptedAt,
            revokedAt: i.revokedAt,
            status,
            recoverable: status === 'pending' && i.recoverable,
          };
        });
      return json(200, { invites });
    }
    if (method === 'POST') {
      const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest('El correo de la persona de contacto no es válido.');
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (name.length > 80) return badRequest('El nombre no puede superar los 80 caracteres.');
      const ttlHours = b.ttlHours === undefined ? 168 : b.ttlHours;
      if (typeof ttlHours !== 'number' || !Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 720) {
        return badRequest('La validez máxima del enlace es de 720 horas (30 días).');
      }
      if (client.suspended) {
        return badRequest('El cliente está suspendido. Reactívalo antes de enviarle un enlace de bienvenida.', 'client_suspended');
      }
      const usuario = mw.panelUsers.find((u) => u.email.toLowerCase() === email);
      if (usuario && !(usuario.role === 'client' && usuario.clientId === client.id)) {
        return json(409, { error: 'Ya existe un usuario con ese correo.', code: 'user_exists' });
      }
      const ahora = Date.now();
      // Un solo enlace válido por persona: el nuevo sustituye a los pendientes.
      for (const i of mw.invites) {
        if (i.clientId === client.id && i.email === email && !i.acceptedAt && !i.revokedAt) i.revokedAt = ahora;
      }
      const invite: FakeInvite = {
        id: nextId('inv'),
        clientId: client.id,
        email,
        name,
        token: `tok-bienvenida-${mw.seq}`,
        createdAt: ahora,
        expiresAt: ahora + ttlHours * 3_600_000,
        openedAt: null,
        acceptedAt: null,
        revokedAt: null,
        recoverable: true,
      };
      mw.invites.push(invite);
      return json(200, {
        invite: {
          id: invite.id,
          url: `${MW_BASE}/bienvenida/${invite.token}`,
          email,
          name,
          expiresAt: invite.expiresAt,
          existingUser: !!usuario,
        },
      });
    }
  }
  if ((m = path.match(/^\/api\/clients\/([^/]+)\/invites\/([^/]+)(\/url)?$/))) {
    if (!admin) return forbidden();
    const invite = mw.invites.find((i) => i.id === m![2] && i.clientId === m![1]);
    if (!invite) return json(404, { error: 'Enlace de bienvenida no encontrado.', code: 'not_found' });
    if (m[3] && method === 'GET') {
      if (estadoInvitacion(invite) !== 'pending') {
        return json(404, {
          error: 'Este enlace de bienvenida no es válido o ha caducado. Solicita uno nuevo a tu proveedor de correo.',
          code: 'invite_invalid',
        });
      }
      if (!invite.recoverable) {
        return json(409, { error: 'Este enlace ya no se puede volver a enviar. Crea uno nuevo.', code: 'invite_not_recoverable' });
      }
      return json(200, {
        invite: { id: invite.id, url: `${MW_BASE}/bienvenida/${invite.token}`, email: invite.email, name: invite.name, expiresAt: invite.expiresAt },
      });
    }
    if (!m[3] && method === 'DELETE') {
      if (!invite.acceptedAt) invite.revokedAt ??= Date.now();
      return json(200, { ok: true });
    }
  }
  if (path === '/api/cloudflare/accounts' && method === 'GET') {
    // Como Mailway: el administrador filtra por cliente con ?clientId.
    const clientId = url.searchParams.get('clientId');
    const accounts = mw.cloudflareAccounts.filter((a) => (admin ? !clientId || a.clientId === clientId : false));
    return json(200, { accounts: accounts.map((a) => ({ ...a, tokenHint: 'abcd', createdAt: 1, lastVerifiedAt: null, lastError: null })) });
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
    // Como Mailway: con `autoDns` aplica los registros que faltan sin reemplazar
    // nada (aquí, siempre el MX); sin él, `cloudflare: null`.
    const aplicados = [{ action: 'create', type: 'MX', name: d.domain }];
    if (mw.autoDnsConAutoconfig) {
      aplicados.push({ action: 'create', type: 'CNAME', name: `autoconfig.${d.domain}` });
      aplicados.push({ action: 'create', type: 'CNAME', name: `autodiscover.${d.domain}` });
    }
    const cloudflare = b.autoDns === true ? { applied: aplicados, errors: [], skipped: [] } : null;
    return json(200, { domain: domainRecord(d), cloudflare });
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
    // Como Mailway con un token de administrador: con `clientId`, los de ese
    // cliente; sin él, los de TODOS los clientes en cualquier estado (la lista
    // con la que Skyway reserva los nombres que aún esperan DNS).
    if (!admin) return forbidden();
    const clientId = url.searchParams.get('clientId');
    const respuesta = json(200, { domains: mw.whitelabel.filter((w) => !clientId || w.clientId === clientId) });
    if (!clientId && mw.whitelabelListDelayMs > 0) await new Promise((r) => setTimeout(r, mw.whitelabelListDelayMs));
    return respuesta;
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
