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
  /** Cuenta de Cloudflare asociada al dominio (Mailway la guarda al aplicar su DNS). */
  cloudflareAccountId?: string | null;
  /** Comprobaciones DNS que devuelve Mailway (vacías si no se indican). */
  checks?: Record<string, unknown>[];
  /** Mailway posterior a la 1.2: el correo se recibe en otro servidor. Ausente = Mailway anterior. */
  recepcionExterna?: boolean;
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
  /**
   * Usuario del motor cuando NO coincide con la dirección (`usuario_motor` de
   * Mailway 1.3): tras pasar a un dominio nuevo, la dirección anterior hasta
   * «Actualizar mis dispositivos». Ausente o null = entra con su dirección.
   */
  usuarioMotor?: string | null;
}
/** Alias del cliente (solo lo que usa el cambio de dominio). */
export interface FakeAlias {
  id: string;
  domainId: string;
  localPart: string;
  email: string;
}
/** Cambio de dominio de Mailway 1.3 (`domain_migrations`), simplificado. */
export interface FakeMigracion {
  id: string;
  clientId: string;
  fromDomainId: string | null;
  toDomainId: string | null;
  fromDomain: string;
  toDomain: string;
  estado: 'preparando' | 'listo' | 'pasando' | 'pasado' | 'volviendo' | 'dando_de_baja' | 'dado_de_baja' | 'cancelada';
  error: string | null;
  origen: 'panel' | 'skyway';
  referenciaExterna: string | null;
  /** El destino lo dio de alta este cambio (cancelar lo elimina). */
  creoDestino: boolean;
  /** Pre-recepción hecha: las direcciones nuevas ya reciben. */
  recepcionPreparada: boolean;
  /** `marcarListo(id)`: las compuertas están bien y la próxima comprobación pasa a «listo». */
  compuertasOk: boolean;
  /** Buzones y alias que se mudan (los del origen al crear el cambio). */
  items: { tipo: 'buzon' | 'alias'; id: string; localPart: string }[];
  autoDns: boolean;
  soloCliente: boolean;
  nombresCloudflare: string[];
  creado: number;
  listoAt: number | null;
  pasadoAt: number | null;
  terminadoAt: number | null;
}
/** Acciones del cambio de dominio en las que se puede inyectar un fallo (`mw.fallosCambio`). */
export type AccionCambio = 'plan' | 'create' | 'get' | 'check' | 'switch' | 'rollback' | 'cancel' | 'retire' | 'login-update';
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
  /** Respuesta de `/api/domains/:id/conflicto` por nombre de dominio (sin entrada: no hay otro proveedor). */
  conflictos: new Map<string, Record<string, unknown>>(),
  /**
   * Como un Mailway posterior a la 1.2: el plan de Cloudflare trae el MX ajeno como conflicto
   * reemplazable del cambio de proveedor y la copia del último cambio
   * (`copia`); aplicar admite `replace` y existe `cloudflare/undo`.
   */
  cloudflarePorRegistro: false,
  /** Copia del último cambio que devuelve el plan (con `cloudflarePorRegistro`). */
  copia: null as null | { createdAt: number; borrados: { type: string; name: string; content: string; priority?: number }[] },
  /** Cuentas de Cloudflare conectadas en Mailway (clientId null = de la instancia). */
  cloudflareAccounts: [] as { id: string; clientId: string | null; label: string }[],
  /** Peticiones recibidas: método, ruta (con consulta), cabeceras de autenticación y cuerpo. */
  calls: [] as FakeCall[],
  seq: 0,
  /** Hosts a los que «no se llega» (contenedores fuera de Docker). */
  unreachable: new Set<string>(),
  /**
   * Como Mailway 1.3: declara `features.domainMigrations`, atiende
   * `/api/domain-migrations` y `/login-update`, y el resumen trae `login` y
   * `loginPending` en los buzones y `migracion` en los dominios. En false, como
   * un Mailway anterior (rutas 404 y sin esos campos).
   */
  cambiosDeDominio: true,
  aliases: [] as FakeAlias[],
  migraciones: [] as FakeMigracion[],
  /** Fallo que devuelve la PRÓXIMA petición de esa acción (se consume al usarlo). */
  fallosCambio: new Map<AccionCambio, { status: number; error: string; code: string }>(),
  /** El MX del dominio anterior aún apunta al servidor: la baja responde 409 `migration_old_mx_here`. */
  mxViejoAqui: false,
  /** El DNS no se puede consultar: la baja responde 503 `dns_unknown`. */
  dnsDesconocido: false,
  /** El MX del dominio nuevo ya apunta al servidor: cancelar (con la pre-recepción hecha) responde 409. */
  mxNuevoAqui: false,
};

/** Las compuertas del cambio pasan a estar bien: la próxima comprobación lo deja «listo». */
export function marcarListo(id: string): void {
  const c = mw.migraciones.find((x) => x.id === id);
  if (!c) throw new Error(`Cambio de dominio desconocido: ${id}`);
  c.compuertasOk = true;
}

const nextId = (p: string) => `${p}_${++mw.seq}`;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const badRequest = (error: string, code = 'bad_request') => json(400, { error, code });

const ABIERTO = (c: FakeMigracion) => c.estado !== 'dado_de_baja' && c.estado !== 'cancelada';

/** `migracion` del dominio, como Mailway 1.3 (sin la bandera, el campo no existe). */
function migracionDe(domainId: string) {
  const c = mw.migraciones.find((x) => ABIERTO(x) && (x.fromDomainId === domainId || x.toDomainId === domainId));
  if (!c) return null;
  const origen = c.fromDomainId === domainId;
  return { id: c.id, rol: origen ? 'origen' : 'destino', estado: c.estado, pareja: origen ? c.toDomain : c.fromDomain, cuentaEnPlan: !origen };
}

/** Buzón como lo devuelve Mailway: con `login` y `loginPending` desde la 1.3. */
function mailboxRecord(box: FakeMailbox) {
  const { usuarioMotor, ...rest } = box;
  if (!mw.cambiosDeDominio) return rest;
  return { ...rest, login: usuarioMotor ?? box.email, loginPending: !!usuarioMotor };
}

/** Contraseñas de aplicación activas que creó Skyway en el buzón («skyway:…»). */
const appsSkyway = (mailboxId: string) =>
  mw.appPasswords.filter((a) => a.mailboxId === mailboxId && !a.revokedAt && a.name.startsWith('skyway:')).map((a) => a.name);

function domainRecord(fake: FakeDomain) {
  const { cloudflareAccountId, checks, ...d } = fake;
  return {
    ...(mw.cambiosDeDominio ? { migracion: migracionDe(fake.id) } : {}),
    ...d,
    dkimSelector: 'mw1',
    dnsStatus: { checks: checks ?? [], requiredTotal: 4, requiredOk: d.status === 'active' ? 4 : 1, allRequiredOk: d.status === 'active', checkedAt: 1 },
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
        ...(mw.cambiosDeDominio ? { domainMigrations: true } : {}),
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
      mailboxes: mailboxes.map(mailboxRecord),
      apiKeys: mw.apiKeys.filter((k) => k.clientId === client.id),
      appPasswords: mw.appPasswords.filter((a) => boxIds.has(a.mailboxId)),
      connection: { imap: null, submission: null, webmailUrl: mw.infoOverride.webmailUrl ?? 'https://webmail.example.com' },
    });
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
  if ((m = path.match(/^\/api\/domains\/([^/]+)\/(verify|dns|cloudflare|cloudflare\/apply|cloudflare\/undo|conflicto)$/))) {
    const d = mw.domains.find((x) => x.id === m![1]);
    if (!d) return json(404, { error: 'Dominio no encontrado.' });
    if (m[2] === 'conflicto') {
      return json(
        200,
        mw.conflictos.get(d.domain) ?? {
          hayOtroProveedor: false,
          mxActuales: [],
          spfActual: null,
          dmarcPolitica: null,
          aviso: null,
          mxInternos: [],
          avisoServidor: null,
        },
      );
    }
    if (m[2] === 'cloudflare/undo') {
      if (!mw.cloudflarePorRegistro) return json(404, { error: `Ruta no simulada: ${method} ${path}` });
      if (!mw.copia) return json(409, { error: 'No hay ningún cambio guardado que deshacer.', code: 'cloudflare_nothing_to_undo' });
      const restaurados = mw.copia.borrados.map((x) => ({ type: x.type, name: x.name }));
      mw.copia = null;
      return json(200, { restaurados, retirados: [{ type: 'MX', name: d.domain }], domain: domainRecord(d) });
    }
    if (m[2] === 'cloudflare' && mw.cloudflarePorRegistro) {
      return json(200, {
        available: true,
        account: { id: 'cfa_1', label: 'Cuenta' },
        zone: { id: 'z1', name: d.domain, status: 'active' },
        changes: [
          { action: 'conflict', type: 'MX', name: d.domain, content: 'mail.example.com', priority: 10, current: '1 aspmx.l.google.com', reason: 'Otro proveedor', required: true, reemplazable: true, alCambiar: true },
          { action: 'conflict', type: 'TXT', name: d.domain, content: 'v=spf1 a:mail.example.com ~all', reason: 'Dos SPF', required: true, reemplazable: false, alCambiar: false },
          { action: 'conflict', type: 'CNAME', name: `autodiscover.${d.domain}`, content: 'mail.example.com', current: 'autodiscover.outlook.com', reason: 'Otro destino', required: false, reemplazable: true, alCambiar: false },
        ],
        summary: { create: 0, update: 0, keep: 0, conflict: 3 },
        copia: mw.copia,
      });
    }
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
    if (mw.cloudflarePorRegistro && Array.isArray(b.replace)) {
      // Como un Mailway posterior a la 1.2: solo se reemplaza lo elegido, con copia para deshacer.
      const elegidos = (b.replace as string[]).filter((k) => k === `MX:${d.domain}` || k === `CNAME:autodiscover.${d.domain}`);
      mw.copia = {
        createdAt: Date.now(),
        borrados: elegidos.map((k) => ({ type: k.split(':')[0], name: k.split(':').slice(1).join(':'), content: 'anterior' })),
      };
      return json(200, {
        applied: elegidos.map((k) => ({ action: 'replace', type: k.split(':')[0], name: k.split(':').slice(1).join(':') })),
        errors: [],
        domain: domainRecord(d),
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
    return json(200, { mailbox: mailboxRecord(box), password: 'Contraseña-Del-Buzon-1' });
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
  if (mw.cambiosDeDominio && (path.startsWith('/api/domain-migrations') || /^\/api\/mailboxes\/[^/]+\/login-update$/.test(path))) {
    const r = rutaCambioDeDominio(path, method, b, url);
    if (r) return r;
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

// ---------- cambio de dominio (Mailway 1.3) ----------

const TITULOS_COMPUERTA = {
  motor: 'Servidor de correo disponible',
  cliente: 'Cliente activo',
  propiedad: 'Propiedad del dominio nuevo comprobada',
  recepcion: 'El dominio nuevo ya recibe en los buzones',
  dns: 'DNS del dominio nuevo completo (MX, SPF y DKIM)',
} as const;

function normalizarDominio(d: unknown): string {
  return String(d ?? '').trim().toLowerCase().replace(/\.$/, '');
}

/** Buzones y alias que se mudan, con sus direcciones de ahora en el dominio de origen y en el de destino. */
function itemsDe(c: FakeMigracion) {
  return c.items.map((i) => ({ ...i, de: `${i.localPart}@${c.fromDomain}`, a: `${i.localPart}@${c.toDomain}` }));
}

function bloqueosBaja(c: FakeMigracion) {
  const out: { code: string; mensaje: string }[] = [];
  for (const i of c.items) {
    const box = i.tipo === 'buzon' ? mw.mailboxes.find((x) => x.id === i.id) : undefined;
    if (box?.usuarioMotor && appsSkyway(box.id).length > 0) {
      out.push({ code: 'mailbox_used_by_app', mensaje: `${box.email} lo usa una aplicación para enviar. Actualízalo desde Skyway.` });
    }
  }
  return out;
}

/** `CambioDominioVista` de Mailway 1.3 (lo que Skyway enseña tal cual). */
export function vistaCambio(c: FakeMigracion) {
  const buzones = c.items
    .filter((i) => i.tipo === 'buzon')
    .map((i) => mw.mailboxes.find((x) => x.id === i.id))
    .filter((x): x is FakeMailbox => !!x);
  const lista = buzones.map((b) => ({
    id: b.id,
    email: b.email,
    login: b.usuarioMotor ?? b.email,
    pendiente: !!b.usuarioMotor,
    usadoPorApps: appsSkyway(b.id),
  }));
  const ok = c.compuertasOk;
  const compuertas = (Object.keys(TITULOS_COMPUERTA) as (keyof typeof TITULOS_COMPUERTA)[]).map((id) => ({
    id,
    ok: id === 'motor' || id === 'cliente' ? true : ok,
    bloquea: true,
    titulo: TITULOS_COMPUERTA[id],
    detalle: '',
  }));
  const bloqueos = bloqueosBaja(c);
  return {
    id: c.id,
    clientId: c.clientId,
    origen: c.origen,
    referenciaExterna: c.referenciaExterna,
    desde: { domainId: c.fromDomainId, domain: c.fromDomain },
    hacia: { domainId: c.toDomainId, domain: c.toDomain, cloudflare: false, recibeEnOtroProveedor: false },
    estado: c.estado,
    paso: '',
    error: c.error,
    recepcionPreparada: c.recepcionPreparada,
    compuertas,
    puedePasar: c.estado === 'listo' && ok,
    puedeVolver: c.estado === 'pasado' || (c.estado === 'pasando' && !!c.error),
    puedeCancelar: c.estado === 'preparando' || c.estado === 'listo',
    puedeDarDeBaja: c.estado === 'pasado' && bloqueos.length === 0,
    bloqueosBaja: bloqueos,
    buzones: { total: lista.length, pendientes: lista.filter((b) => b.pendiente).length, lista },
    alias: { total: c.items.filter((i) => i.tipo === 'alias').length },
    webmail: { viejo: null, nuevo: null },
    nombresCloudflare: c.nombresCloudflare,
    avisos: [],
    fechas: { creado: c.creado, listo: c.listoAt, pasado: c.pasadoAt, terminado: c.terminadoAt },
  };
}

/** Bloqueos del plan, en el orden de Mailway (el primero es el error de la creación). */
function bloqueosPlan(from: FakeDomain, to: string) {
  const out: { code: string; mensaje: string; status: number }[] = [];
  const client = mw.clients.find((x) => x.id === from.clientId);
  if (to.startsWith('www.')) out.push({ code: 'domain_www', mensaje: `Escribe el dominio sin «www.»: ${to.slice(4)}.`, status: 400 });
  if (to === from.domain) {
    out.push({ code: 'migration_same_domain', mensaje: 'El dominio nuevo tiene que ser distinto del actual.', status: 400 });
  } else if (to.endsWith(`.${from.domain}`) || from.domain.endsWith(`.${to}`)) {
    out.push({ code: 'migration_related_domains', mensaje: 'El dominio nuevo no puede ser un subdominio del actual, ni al revés.', status: 400 });
  }
  const destino = to === from.domain ? undefined : mw.domains.find((d) => d.domain === to);
  if (destino && destino.clientId !== from.clientId) {
    out.push({ code: 'domain_exists', mensaje: 'Ese dominio ya está dado de alta en la plataforma.', status: 409 });
  } else if (destino && (mw.mailboxes.some((x) => x.domainId === destino.id) || mw.aliases.some((x) => x.domainId === destino.id))) {
    out.push({
      code: 'migration_destination_in_use',
      mensaje: `${to} ya tiene buzones o alias. Elige un dominio sin buzones ni alias, o elimínalos antes.`,
      status: 409,
    });
  }
  const abierto = mw.migraciones.find(
    (c) => ABIERTO(c) && [c.fromDomain, c.toDomain].some((d) => d === from.domain || d === to),
  );
  if (abierto) {
    const afectado = [abierto.fromDomain, abierto.toDomain].includes(from.domain) ? from.domain : to;
    out.push({ code: 'migration_exists', mensaje: `${afectado} ya está en un cambio de dominio abierto.`, status: 409 });
  }
  if (from.ownershipVerifiedAt === null) {
    out.push({ code: 'ownership_required', mensaje: `Comprueba primero la propiedad de ${from.domain}.`, status: 409 });
  }
  if (client?.suspended) out.push({ code: 'client_suspended', mensaje: 'El cliente está suspendido.', status: 409 });
  return out;
}

function planCambio(from: FakeDomain, to: string) {
  const destino = mw.domains.find((d) => d.domain === to) ?? null;
  const buzones = mw.mailboxes.filter((x) => x.domainId === from.id);
  const aliases = mw.aliases.filter((x) => x.domainId === from.id);
  const conApps = buzones.filter((x) => appsSkyway(x.id).length > 0);
  return {
    desde: { domainId: from.id, domain: from.domain },
    hacia: { domain: to, existe: !!destino, domainId: destino?.id ?? null },
    buzones: buzones.map((x) => ({ id: x.id, de: x.email, a: `${x.localPart}@${to}`, usadoPorApps: appsSkyway(x.id) })),
    alias: aliases.map((x) => ({ id: x.id, de: x.email, a: `${x.localPart}@${to}` })),
    formularios: [],
    webmail: { viejo: null, nuevo: null },
    avisos: conApps.length > 0 ? [{ code: 'apps_smtp', mensaje: `${conApps.length} buzones los usan aplicaciones para enviar.` }] : [],
    bloqueos: bloqueosPlan(from, to).map(({ code, mensaje }) => ({ code, mensaje })),
  };
}

const errorEstado = () =>
  json(409, { error: 'Esta acción no está disponible en el estado actual del cambio de dominio.', code: 'migration_state' });

/** Mueve los buzones y alias del cambio a `domainId`/`dominio` (la transacción de pasar y la de volver). */
function moverItems(c: FakeMigracion, domainId: string, dominio: string, usuario: (box: FakeMailbox, de: string, a: string) => string | null) {
  for (const i of itemsDe(c)) {
    if (i.tipo === 'buzon') {
      const box = mw.mailboxes.find((x) => x.id === i.id);
      if (!box || box.domainId === domainId) continue;
      box.usuarioMotor = usuario(box, i.de, i.a);
      box.domainId = domainId;
      box.domain = dominio;
      box.email = `${i.localPart}@${dominio}`;
      for (const app of mw.appPasswords) if (app.mailboxId === box.id) app.email = box.email;
      for (const k of mw.apiKeys) if (k.senderMailboxId === box.id) k.senderEmail = box.email;
    } else {
      const alias = mw.aliases.find((x) => x.id === i.id);
      if (!alias || alias.domainId === domainId) continue;
      alias.domainId = domainId;
      alias.email = `${i.localPart}@${dominio}`;
    }
  }
}

function rutaCambioDeDominio(path: string, method: string, b: Record<string, unknown>, url: URL): Response | null {
  let m: RegExpMatchArray | null;
  const fallo = (accion: AccionCambio): Response | null => {
    const f = mw.fallosCambio.get(accion);
    if (!f) return null;
    mw.fallosCambio.delete(accion);
    return json(f.status, { error: f.error, code: f.code });
  };

  if ((m = path.match(/^\/api\/mailboxes\/([^/]+)\/login-update$/)) && method === 'POST') {
    const f = fallo('login-update');
    if (f) return f;
    const box = mw.mailboxes.find((x) => x.id === m![1]);
    if (!box) return json(404, { error: 'Buzón no encontrado.', code: 'not_found' });
    box.usuarioMotor = null;
    return json(200, { mailbox: mailboxRecord(box) });
  }

  if ((path === '/api/domain-migrations/plan' || path === '/api/domain-migrations') && method === 'POST') {
    const accion: AccionCambio = path.endsWith('/plan') ? 'plan' : 'create';
    const f = fallo(accion);
    if (f) return f;
    const from = mw.domains.find((d) => d.id === b.fromDomainId);
    if (!from) return json(404, { error: 'Dominio no encontrado.', code: 'not_found' });
    const to = normalizarDominio(b.toDomain);
    if (accion === 'plan') return json(200, planCambio(from, to));
    const repetido = mw.migraciones.find((c) => ABIERTO(c) && c.fromDomainId === from.id && c.toDomain === to);
    if (repetido) return json(200, vistaCambio(repetido));
    const [bloqueo] = bloqueosPlan(from, to);
    if (bloqueo) return json(bloqueo.status, { error: bloqueo.mensaje, code: bloqueo.code });
    let destino = mw.domains.find((d) => d.domain === to);
    const creoDestino = !destino;
    if (!destino) {
      destino = { id: nextId('dom'), clientId: from.clientId, domain: to, status: 'pending_dns', ownershipVerifiedAt: null };
      mw.domains.push(destino);
    }
    const autoDns = b.autoDns !== false;
    const c: FakeMigracion = {
      id: nextId('dmg'),
      clientId: from.clientId,
      fromDomainId: from.id,
      toDomainId: destino.id,
      fromDomain: from.domain,
      toDomain: to,
      estado: 'preparando',
      error: null,
      origen: b.origen === 'skyway' ? 'skyway' : 'panel',
      referenciaExterna: typeof b.referenciaExterna === 'string' ? b.referenciaExterna : null,
      creoDestino,
      recepcionPreparada: false,
      compuertasOk: false,
      items: [
        ...mw.mailboxes.filter((x) => x.domainId === from.id).map((x) => ({ tipo: 'buzon' as const, id: x.id, localPart: x.localPart })),
        ...mw.aliases.filter((x) => x.domainId === from.id).map((x) => ({ tipo: 'alias' as const, id: x.id, localPart: x.localPart })),
      ],
      autoDns,
      soloCliente: url.searchParams.get('soloCliente') === '1',
      // Como Mailway con `autoDns` y una zona en Cloudflare: los nombres de autoconfiguración que creó.
      nombresCloudflare: autoDns && mw.autoDnsConAutoconfig ? [`autoconfig.${to}`, `autodiscover.${to}`] : [],
      creado: Date.now(),
      listoAt: null,
      pasadoAt: null,
      terminadoAt: null,
    };
    mw.migraciones.push(c);
    return json(201, vistaCambio(c));
  }

  if (!(m = path.match(/^\/api\/domain-migrations\/([^/]+)(?:\/(check|switch|rollback|cancel|retire))?$/))) return null;
  const c = mw.migraciones.find((x) => x.id === m![1]);
  const accion = (m[2] ?? 'get') as AccionCambio;
  if (accion === 'get' && method !== 'GET') return null;
  if (accion !== 'get' && method !== 'POST') return null;
  const f = fallo(accion);
  if (f) return f;
  if (!c) return json(404, { error: 'Cambio de dominio no encontrado.', code: 'not_found' });
  const destino = mw.domains.find((d) => d.id === c.toDomainId);

  if (accion === 'get') return json(200, vistaCambio(c));

  if (accion === 'check') {
    if ((c.estado === 'preparando' || c.estado === 'listo') && c.compuertasOk) {
      c.recepcionPreparada = true;
      if (destino) {
        destino.status = 'active';
        destino.ownershipVerifiedAt ??= Date.now();
      }
      if (c.estado === 'preparando') {
        c.estado = 'listo';
        c.listoAt = Date.now();
      }
    }
    return json(200, vistaCambio(c));
  }

  if (accion === 'switch') {
    if (c.estado === 'pasado') return json(200, vistaCambio(c));
    if (c.estado !== 'listo' && c.estado !== 'pasando') return errorEstado();
    if (!c.compuertasOk) {
      return json(409, { error: `Todavía no se puede pasar a ${c.toDomain}: el DNS no está completo.`, code: 'migration_not_ready' });
    }
    moverItems(c, c.toDomainId!, c.toDomain, (box, de, a) => {
      const login = box.usuarioMotor ?? de;
      return login === a ? null : login;
    });
    c.estado = 'pasado';
    c.error = null;
    c.pasadoAt = Date.now();
    return json(200, vistaCambio(c));
  }

  if (accion === 'rollback') {
    if (c.estado !== 'pasado' && !(c.estado === 'pasando' && c.error)) return errorEstado();
    moverItems(c, c.fromDomainId!, c.fromDomain, (box, de, a) => {
      if (box.usuarioMotor === de) return null;
      if (!box.usuarioMotor) return a;
      return box.usuarioMotor;
    });
    c.estado = 'listo';
    c.error = null;
    c.pasadoAt = null;
    return json(200, vistaCambio(c));
  }

  if (accion === 'cancel') {
    if (c.estado !== 'preparando' && c.estado !== 'listo') return errorEstado();
    if (c.creoDestino && c.recepcionPreparada && mw.mxNuevoAqui) {
      return json(409, {
        error: `El MX de ${c.toDomain} ya apunta a este servidor. Cámbialo o quítalo antes de cancelar: si no, el correo que llegue a @${c.toDomain} se rechazaría.`,
        code: 'migration_new_mx_here',
      });
    }
    const propios = destino && (mw.mailboxes.some((x) => x.domainId === destino.id) || mw.aliases.some((x) => x.domainId === destino.id));
    if (c.creoDestino && destino && !propios) mw.domains = mw.domains.filter((d) => d.id !== destino.id);
    c.estado = 'cancelada';
    c.terminadoAt = Date.now();
    return json(200, vistaCambio(c));
  }

  // retire
  if (c.estado !== 'pasado') return errorEstado();
  if (b.confirm !== c.fromDomain) {
    return badRequest(`Escribe ${c.fromDomain} exactamente para confirmar.`, 'confirm_mismatch');
  }
  const [conApp] = bloqueosBaja(c);
  if (conApp) {
    return json(409, {
      error: 'Este buzón lo usa una aplicación para enviar (tienda). Actualízalo desde Skyway para que la aplicación no deje de enviar, o revoca antes sus contraseñas de aplicación «skyway:…».',
      code: 'mailbox_used_by_app',
    });
  }
  if (mw.dnsDesconocido) {
    return json(503, { error: `No se ha podido consultar el DNS de ${c.fromDomain}. Vuelve a intentarlo en unos minutos.`, code: 'dns_unknown' });
  }
  if (mw.mxViejoAqui) {
    return json(409, { error: `El MX de ${c.fromDomain} todavía apunta a este servidor.`, code: 'migration_old_mx_here' });
  }
  for (const i of c.items) {
    const box = i.tipo === 'buzon' ? mw.mailboxes.find((x) => x.id === i.id) : undefined;
    if (box) box.usuarioMotor = null;
  }
  mw.domains = mw.domains.filter((d) => d.id !== c.fromDomainId);
  c.fromDomainId = null;
  c.estado = 'dado_de_baja';
  c.terminadoAt = Date.now();
  return json(200, vistaCambio(c));
}
