/**
 * Enlace público y permanente de pago de las facturas (`/pagar/<token>`).
 *
 * Stripe se simula sustituyendo `fetch` por las tres llamadas que hace Skyway
 * (crear, consultar y caducar una Checkout Session) y el correo sustituyendo
 * `sendMail`: aquí importa qué sesión se crea, a dónde se redirige, qué página
 * ve el cliente y qué enlace lleva el correo.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ correos: [] as { to: string; subject: string; text: string }[] }));
vi.mock('../src/mailer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/mailer')>()),
  sendMail: vi.fn(async (_cfg: unknown, msg: { to: string; subject: string; text: string }) => {
    m.correos.push({ to: msg.to, subject: msg.subject, text: msg.text });
  }),
}));

import { buildApp } from '../src/app';
import { API_TOKEN_PREFIX, hashApiToken } from '../src/auth';
import { billingCycleTick } from '../src/billingauto';
import {
  closeDb,
  createPlan,
  createUser,
  createWorkspaceRow,
  getInvoice,
  getInvoicePayLink,
  initDb,
  insertApiToken,
  listAudit,
  listInvoices,
  listWorkspaceAlerts,
  recordPlanChange,
  setInvoicePayLink,
  setSetting,
  updateWorkspace,
} from '../src/db';
import { hashTokenPago } from '../src/enlacepago';
import { markInvoicePaidByStripeSession } from '../src/routes/billing';
import { hashPassword, randomToken } from '../src/util';

// El correo de la facturación automática no tiene petición: el enlace sale del dominio del panel.
process.env.SKYWAY_DOMAIN = 'panel.ejemplo.test';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

const ENLACE_RE = /https:\/\/panel\.ejemplo\.test\/pagar\/([a-f0-9]{64})/;
const STRIPE = 'https://api.stripe.com/v1/checkout/sessions';

interface SesionFalsa {
  id: string;
  status: 'open' | 'complete' | 'expired';
  url: string;
  params: URLSearchParams;
}

const stripe = {
  sesiones: new Map<string, SesionFalsa>(),
  creadas: [] as SesionFalsa[],
  consultas: [] as string[],
  caducadas: [] as string[],
  caido: false,
  /** Si existe, la creación espera a que se resuelva: sirve para probar el cerrojo. */
  pausa: null as Promise<void> | null,
  /** Avisa cuando llega una petición de creación (antes de la pausa). */
  alCrear: null as (() => void) | null,
};

function respuesta(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function fetchFalso(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(STRIPE)) throw new Error(`fetch inesperado en la prueba: ${url}`);
  if (stripe.caido) throw new TypeError('fetch failed');
  const metodo = init?.method ?? 'GET';
  const resto = url.slice(STRIPE.length);
  if (metodo === 'POST' && resto === '') {
    stripe.alCrear?.();
    if (stripe.pausa) await stripe.pausa;
    const id = `cs_test_${stripe.creadas.length + 1}`;
    const s: SesionFalsa = { id, status: 'open', url: `https://checkout.stripe.com/c/pay/${id}`, params: new URLSearchParams(String(init?.body ?? '')) };
    stripe.sesiones.set(id, s);
    stripe.creadas.push(s);
    return respuesta(200, { id, url: s.url, status: 'open' });
  }
  const caducar = /^\/(\w+)\/expire$/.exec(resto);
  if (metodo === 'POST' && caducar) {
    const s = stripe.sesiones.get(caducar[1]);
    if (!s) return respuesta(404, { error: { message: 'No such checkout.session' } });
    if (s.status !== 'open') return respuesta(400, { error: { message: 'Only Checkout Sessions with a status of open can be expired.' } });
    s.status = 'expired';
    stripe.caducadas.push(s.id);
    return respuesta(200, { id: s.id, status: 'expired', url: null });
  }
  const consulta = /^\/(\w+)$/.exec(resto);
  if (metodo === 'GET' && consulta) {
    stripe.consultas.push(consulta[1]);
    const s = stripe.sesiones.get(consulta[1]);
    if (!s) return respuesta(404, { error: { message: 'No such checkout.session' } });
    return respuesta(200, { id: s.id, status: s.status, url: s.status === 'open' ? s.url : null });
  }
  throw new Error(`llamada a Stripe inesperada en la prueba: ${metodo} ${url}`);
}

let app: FastifyInstance;
let headers: Record<string, string>;
let wsId = '';
/** Cada prueba abre los enlaces desde su propia IP: el límite por IP es de la ruta. */
let ultimaIp = 10;
const nuevaIp = (): string => `198.51.100.${++ultimaIp}`;

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const r = await app.inject({
    method,
    url,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Json = null;
  try {
    json = r.json();
  } catch {
    /* sin cuerpo JSON */
  }
  return { status: r.statusCode, json };
}

/** Petición SIN credenciales, como la del cliente que abre el enlace del correo. */
function abrir(ruta: string, ip = nuevaIp(), method: 'GET' | 'HEAD' = 'GET') {
  return app.inject({ method, url: ruta, remoteAddress: ip });
}

function tokenDe(url: string): string {
  const t = ENLACE_RE.exec(url);
  if (!t) throw new Error(`no es un enlace de pago: ${url}`);
  return t[1];
}

/**
 * Periodo propio para cada factura a medida: el de por defecto es el del ciclo en
 * curso, y emitir la primera empuja el ancla hasta su fin (el resto quedaría con
 * un periodo vacío).
 */
let diasAtras = 400;
function periodo(): { periodStart: number; periodEnd: number } {
  const fin = Date.now() - diasAtras-- * 86_400_000;
  return { periodStart: fin - 86_400_000, periodEnd: fin };
}

async function facturaEmitida(importe: number): Promise<Json> {
  let r = await call('POST', `/api/workspaces/${wsId}/invoices`, { lines: [{ label: 'Servicio', unitCents: importe, taxRate: 21 }], ...periodo() });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  r = await call('PATCH', `/api/invoices/${r.json.invoice.id}`, { status: 'issued' });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.invoice;
}

async function enlaceDelPanel(invoiceId: string): Promise<string> {
  const r = await call('POST', `/api/invoices/${invoiceId}/pay-link`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return tokenDe(r.json.url);
}

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(fetchFalso));
  initDb();
  const admin = createUser('admin@test.local', hashPassword('secreto123'), 'admin');
  const secret = `${API_TOKEN_PREFIX}${randomToken(24)}`;
  insertApiToken({ user_id: admin.id, name: 'pruebas', token_hash: hashApiToken(secret), prefix: secret.slice(0, 12), expires_at: null });
  headers = { authorization: `Bearer ${secret}` };
  app = buildApp();
  await app.ready();

  let r = await call('PUT', '/api/billing/profile', {
    companyName: 'Emisor SL',
    taxId: 'B12345678',
    address: 'Calle Mayor 1, 28001 Madrid',
    email: 'facturas@emisor.test',
    iban: 'ES9121000418450200051332',
    bankName: 'Banco de Pruebas',
    currency: 'EUR',
  });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  setSetting('smtpHost', 'smtp.emisor.test');
  setSetting('smtpFrom', 'facturas@emisor.test');
  setSetting('stripeSecretKey', 'sk_test_falsa');
  r = await call('POST', '/api/workspaces', { name: 'Cliente Pago SL', billingEmail: 'pagos@cliente.test' });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  wsId = r.json.workspace.id;
  r = await call('PATCH', `/api/workspaces/${wsId}`, { billingTaxId: 'A11111111', billingAddress: 'Calle Cliente 9, Sevilla' });
  expect(r.status).toBe(200);
});

afterAll(async () => {
  await app.close();
  closeDb();
  vi.unstubAllGlobals();
});

describe('enlace público de pago: recorrido de una factura', () => {
  let inv: Json;
  let token = '';

  it('el correo manual lleva el enlace permanente (no la sesión de Stripe) y el reenvío lleva el mismo', async () => {
    inv = await facturaEmitida(10000);
    let r = await call('POST', `/api/invoices/${inv.id}/email`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const correo = m.correos.at(-1)!;
    expect(correo.to).toBe('pagos@cliente.test');
    token = tokenDe(correo.text);
    expect(correo.text).toContain(`con tarjeta en este enlace: https://panel.ejemplo.test/pagar/${token}`);
    expect(correo.text, 'nunca la sesión de Checkout, que caduca').not.toContain('checkout.stripe.com');
    expect(stripe.creadas, 'enviar el correo no crea sesiones de Stripe').toHaveLength(0);

    r = await call('POST', `/api/invoices/${inv.id}/email`);
    expect(r.status).toBe(200);
    expect(tokenDe(m.correos.at(-1)!.text), 'el mismo enlace en cada envío').toBe(token);

    // Como un token de API: en la base solo está su hash.
    const fila = getInvoicePayLink(inv.id)!;
    expect(fila.token_hash).toBe(hashTokenPago(token));
    expect(JSON.stringify(fila)).not.toContain(token);
    expect(listAudit({ action: 'invoice_pay_link_created' }).filter((a) => a.target_id === inv.id)).toHaveLength(1);
  });

  it('token válido: crea la sesión de Checkout, la audita y redirige a Stripe', async () => {
    const ip = nuevaIp();
    const r = await abrir(`/pagar/${token}`, ip);
    expect(r.statusCode).toBe(303);
    expect(stripe.creadas).toHaveLength(1);
    const s = stripe.creadas[0];
    expect(r.headers.location).toBe(s.url);
    expect(r.headers['cache-control']).toBe('no-store');
    // La vuelta va a la página pública del mismo enlace, no al panel.
    expect(s.params.get('success_url')).toBe(`https://panel.ejemplo.test/pagar/${token}?estado=pagado`);
    expect(s.params.get('cancel_url')).toBe(`https://panel.ejemplo.test/pagar/${token}?estado=cancelado`);
    expect(s.params.get('line_items[0][price_data][unit_amount]')).toBe(String(inv.total_cents));
    expect(s.params.get('metadata[invoiceId]')).toBe(inv.id);
    expect(s.params.get('customer_email')).toBe('pagos@cliente.test');
    expect(getInvoice(inv.id)!.stripe_session_id).toBe(s.id);
    const traza = listAudit({ action: 'invoice_stripe_link' }).find((a) => a.target_id === inv.id);
    expect(traza?.actor).toBe('enlace público de pago');
    expect(traza?.ip).toBe(ip);
    expect(traza?.detail).toContain(s.id);
  });

  it('mientras la sesión sigue abierta, se reutiliza', async () => {
    const r = await abrir(`/pagar/${token}`);
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(stripe.creadas[0].url);
    expect(stripe.creadas).toHaveLength(1);
  });

  it('sesión caducada: se crea otra, se redirige a la nueva y se audita', async () => {
    stripe.sesiones.get(stripe.creadas[0].id)!.status = 'expired';
    const r = await abrir(`/pagar/${token}`);
    expect(r.statusCode).toBe(303);
    expect(stripe.creadas).toHaveLength(2);
    expect(r.headers.location).toBe(stripe.creadas[1].url);
    expect(getInvoice(inv.id)!.stripe_session_id).toBe(stripe.creadas[1].id);
    expect(listAudit({ action: 'invoice_stripe_link_expired' }).some((a) => a.target_id === inv.id)).toBe(true);
  });

  it('un HEAD (vista previa, antivirus) no consulta a Stripe ni crea sesiones', async () => {
    const consultas = stripe.consultas.length;
    const r = await abrir(`/pagar/${token}`, nuevaIp(), 'HEAD');
    expect(r.statusCode).toBe(200);
    expect(stripe.consultas).toHaveLength(consultas);
    expect(stripe.creadas).toHaveLength(2);
  });

  it('la vuelta de Stripe enseña una página y no redirige otra vez a pagar', async () => {
    let r = await abrir(`/pagar/${token}?estado=pagado`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Pago en proceso de confirmación');
    r = await abrir(`/pagar/${token}?estado=cancelado`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Pago no completado');
    expect(r.body).toContain(`href="/pagar/${token}"`);
    expect(r.body, 'datos de transferencia del emisor').toContain('ES9121000418450200051332');
    expect(stripe.creadas).toHaveLength(2);
  });

  it('factura pagada: página pública con el emisor, sin nada del panel ni del cliente', async () => {
    const s = stripe.creadas[1];
    const cobro = markInvoicePaidByStripeSession({ id: s.id, metadata: { invoiceId: inv.id }, amount_total: inv.total_cents, currency: 'eur' });
    expect(cobro.result).toBe('pagada');
    const consultas = stripe.consultas.length;
    // Las mayúsculas no cambian el token (es hexadecimal).
    const r = await abrir(`/pagar/${token.toUpperCase()}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-robots-tag']).toContain('noindex');
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
    expect(r.body).toContain('Factura pagada');
    expect(r.body).toContain(inv.number);
    expect(r.body).toContain('121,00 €');
    expect(r.body).toContain('Emisor SL');
    expect(r.body).toContain('B12345678');
    for (const dato of ['Cliente Pago SL', 'A11111111', 'pagos@cliente.test', 'Calle Cliente', wsId, inv.id, s.id, 'checkout.stripe.com']) {
      expect(r.body, `no debe aparecer «${dato}»`).not.toContain(dato);
    }
    expect(r.body).not.toMatch(/<script|\/assets\//i);
    expect(stripe.consultas, 'una factura pagada no consulta a Stripe').toHaveLength(consultas);
    expect(stripe.creadas).toHaveLength(2);
  });
});

describe('enlace público de pago: casos límite', () => {
  it('token inexistente o mal formado: la misma página 404, sin datos de nadie', async () => {
    const otra = await facturaEmitida(2000);
    const valido = await enlaceDelPanel(otra.id);
    const rutas = [`/pagar/${randomToken(32)}`, '/pagar/abc', `/pagar/${valido}0`, `/pagar/${valido.slice(0, 63)}`, '/pagar/', '/pagar', `/pagar/${valido}/x`];
    for (const ruta of rutas) {
      const r = await abrir(ruta);
      expect(r.statusCode, ruta).toBe(404);
      expect(r.headers['content-type'], ruta).toMatch(/^text\/html/);
      expect(r.body, ruta).toContain('Enlace no válido');
      expect(r.body, ruta).not.toContain('Emisor SL');
      expect(r.body, ruta).not.toContain(otra.number);
    }
    expect(stripe.creadas.filter((s) => s.params.get('metadata[invoiceId]') === otra.id), 'ningún intento llega a Stripe').toHaveLength(0);
  });

  it('anular la factura rota el enlace: el anterior deja de valer, el nuevo dice «anulada» y la sesión abierta se cierra', async () => {
    const f = await facturaEmitida(5000);
    const viejo = await enlaceDelPanel(f.id);
    let r = await abrir(`/pagar/${viejo}`);
    expect(r.statusCode).toBe(303);
    const sesion = stripe.creadas.at(-1)!;
    expect(sesion.params.get('metadata[invoiceId]')).toBe(f.id);

    const anular = await call('PATCH', `/api/invoices/${f.id}`, { status: 'void' });
    expect(anular.status, JSON.stringify(anular.json)).toBe(200);
    expect(listAudit({ action: 'invoice_pay_link_rotated' }).some((a) => a.target_id === f.id)).toBe(true);
    await vi.waitFor(() => expect(stripe.caducadas).toContain(sesion.id));

    r = await abrir(`/pagar/${viejo}`);
    expect(r.statusCode, 'el enlace del correo anterior ya no vale').toBe(404);
    const nuevo = await enlaceDelPanel(f.id);
    expect(nuevo).not.toBe(viejo);
    r = await abrir(`/pagar/${nuevo}`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Factura anulada');
    expect(r.body).toContain(f.number);
    expect(r.body).toContain('Emisor SL');
  });

  it('un borrador con enlace se emite antes de cobrar, como en «Cobrar», y el enlace no se rota', async () => {
    const r = await call('POST', `/api/workspaces/${wsId}/invoices`, { lines: [{ label: 'Borrador', unitCents: 2500 }], ...periodo() });
    expect(r.status).toBe(201);
    const borrador = r.json.invoice;
    // El panel no da enlace a un borrador…
    const panel = await call('POST', `/api/invoices/${borrador.id}/pay-link`);
    expect(panel.status).toBe(409);
    // …ni lo crea ningún otro camino: se fuerza para probar la ruta pública.
    const t = randomToken(32);
    setInvoicePayLink(borrador.id, hashTokenPago(t), 'nonce-de-prueba');
    const p = await abrir(`/pagar/${t}`);
    expect(p.statusCode).toBe(303);
    const emitida = getInvoice(borrador.id)!;
    expect(emitida.status).toBe('issued');
    expect(emitida.number).toMatch(/^FRA-\d{4}-\d{4}$/);
    expect(stripe.creadas.at(-1)!.params.get('success_url')).toBe(`https://panel.ejemplo.test/pagar/${t}?estado=pagado`);
    expect(getInvoicePayLink(borrador.id)!.token_hash, 'abrir el enlace no lo cambia').toBe(hashTokenPago(t));
    expect(listAudit({ action: 'invoice_issued' }).some((a) => a.target_id === borrador.id)).toBe(true);
  });

  it('dos aperturas a la vez comparten una sola sesión, y «Cobrar» del panel recibe 409 mientras tanto', async () => {
    const f = await facturaEmitida(7000);
    const t = await enlaceDelPanel(f.id);
    const creadas = stripe.creadas.length;
    const consultas = stripe.consultas.length;
    let soltar = (): void => {};
    stripe.pausa = new Promise<void>((resolve) => {
      soltar = resolve;
    });
    const llegada = new Promise<void>((resolve) => {
      stripe.alCrear = resolve;
    });
    try {
      const a = abrir(`/pagar/${t}`);
      await llegada; // la primera ya espera a Stripe con el cerrojo tomado
      const b = abrir(`/pagar/${t}`);
      const panel = await call('POST', `/api/invoices/${f.id}/stripe-link`);
      expect(panel.status).toBe(409);
      expect(panel.json.error).toMatch(/Ya se está generando/);
      stripe.pausa = null;
      soltar();
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra.statusCode).toBe(303);
      expect(rb.statusCode).toBe(303);
      expect(rb.headers.location).toBe(ra.headers.location);
    } finally {
      stripe.pausa = null;
      stripe.alCrear = null;
      soltar();
    }
    expect(stripe.creadas, 'una sola sesión').toHaveLength(creadas + 1);
    expect(stripe.consultas, 'la segunda esperó a la primera, no consultó otra vez').toHaveLength(consultas);
  });

  it('Stripe no responde: página 502 para el cliente y alerta para el operador', async () => {
    const f = await facturaEmitida(3000);
    const t = await enlaceDelPanel(f.id);
    stripe.caido = true;
    try {
      const r = await abrir(`/pagar/${t}`);
      expect(r.statusCode).toBe(502);
      expect(r.body).toContain('No se ha podido conectar con la pasarela de pago');
      expect(r.body).toContain(`href="/pagar/${t}"`);
    } finally {
      stripe.caido = false;
    }
    expect(getInvoice(f.id)!.stripe_session_id).toBeNull();
    expect(listWorkspaceAlerts(wsId).some((a) => a.type === 'invoice_pay_link_failed' && a.title.includes(f.number))).toBe(true);
    expect(listAudit({ action: 'invoice_pay_link_failed' }).some((a) => a.target_id === f.id)).toBe(true);
  });

  it('sin Stripe configurado: página 503 con la transferencia, y el correo vuelve a lo de antes', async () => {
    const f = await facturaEmitida(3100);
    const t = await enlaceDelPanel(f.id);
    setSetting('stripeSecretKey', null);
    try {
      const r = await abrir(`/pagar/${t}`);
      expect(r.statusCode).toBe(503);
      expect(r.body).toContain('Pago con tarjeta no disponible');
      expect(r.body).toContain('ES9121000418450200051332');
      const correo = await call('POST', `/api/invoices/${f.id}/email`);
      expect(correo.status).toBe(200);
      expect(m.correos.at(-1)!.text).not.toMatch(ENLACE_RE);
    } finally {
      setSetting('stripeSecretKey', 'sk_test_falsa');
    }
  });

  it('una factura sin importe no se manda a Stripe ni su correo invita a pagar', async () => {
    let r = await call('POST', `/api/workspaces/${wsId}/invoices`, { lines: [{ label: 'Abono', unitCents: -1000 }], ...periodo() });
    expect(r.status).toBe(201);
    r = await call('PATCH', `/api/invoices/${r.json.invoice.id}`, { status: 'issued' });
    expect(r.status).toBe(200);
    const abono = r.json.invoice;
    const correo = await call('POST', `/api/invoices/${abono.id}/email`);
    expect(correo.status).toBe(200);
    expect(m.correos.at(-1)!.text).not.toMatch(ENLACE_RE);
    const t = await enlaceDelPanel(abono.id);
    const p = await abrir(`/pagar/${t}`);
    expect(p.statusCode).toBe(200);
    expect(p.body).toContain('Sin importe pendiente');
  });

  it('revocar desde el panel: el enlace deja de valer y el siguiente es otro', async () => {
    const f = await facturaEmitida(3300);
    const primero = await call('POST', `/api/invoices/${f.id}/pay-link`);
    expect(primero.json.created).toBe(true);
    const repetido = await call('POST', `/api/invoices/${f.id}/pay-link`);
    expect(repetido.json.created).toBe(false);
    expect(repetido.json.url, 'siempre el mismo enlace').toBe(primero.json.url);
    const t = tokenDe(primero.json.url);

    const revocar = await call('DELETE', `/api/invoices/${f.id}/pay-link`);
    expect(revocar.status).toBe(200);
    expect(revocar.json.revoked).toBe(true);
    expect(listAudit({ action: 'invoice_pay_link_revoked' }).some((a) => a.target_id === f.id)).toBe(true);
    expect((await abrir(`/pagar/${t}`)).statusCode).toBe(404);
    const otro = await enlaceDelPanel(f.id);
    expect(otro).not.toBe(t);
  });

  it('«Cobrar» del panel devuelve el enlace permanente; la API solo dice si existe, nunca el token ni su hash', async () => {
    const f = await facturaEmitida(4200);
    const r = await call('POST', `/api/invoices/${f.id}/stripe-link`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const t = tokenDe(r.json.payUrl);
    expect(r.json.url).toBe(stripe.creadas.at(-1)!.url);
    expect(stripe.creadas.at(-1)!.params.get('success_url')).toBe(`https://panel.ejemplo.test/pagar/${t}?estado=pagado`);
    const lista = await call('GET', `/api/workspaces/${wsId}/invoices`);
    expect(lista.status).toBe(200);
    expect(lista.json.invoices.find((i: Json) => i.id === f.id).pay_link).toBe(true);
    const texto = JSON.stringify(lista.json);
    expect(texto).not.toContain(t);
    expect(texto).not.toContain(hashTokenPago(t));
  });

  it('límite por IP: la petición 31 en diez minutos recibe 429 en HTML; otra IP sigue pasando', async () => {
    const ip = '203.0.113.50';
    for (let i = 0; i < 30; i++) {
      expect((await abrir(`/pagar/${randomToken(32)}`, ip)).statusCode).toBe(404);
    }
    const r = await abrir(`/pagar/${randomToken(32)}`, ip);
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.body).toContain('Demasiadas solicitudes');
    expect((await abrir(`/pagar/${randomToken(32)}`, '203.0.113.51')).statusCode).toBe(404);
  });
});

describe('correo automático de la factura', () => {
  it('al emitir con el envío activado, el correo lleva el enlace', async () => {
    setSetting('billing.emailOnIssue', '1');
    try {
      const antes = m.correos.length;
      const f = await facturaEmitida(1500);
      await vi.waitFor(() => expect(m.correos.length).toBe(antes + 1));
      const t = tokenDe(m.correos.at(-1)!.text);
      expect(getInvoicePayLink(f.id)!.token_hash).toBe(hashTokenPago(t));
    } finally {
      setSetting('billing.emailOnIssue', '0');
    }
  });

  it('la factura que emite la automatización del ciclo sale con su enlace, y el enlace abre esa factura', async () => {
    const plan = createPlan('Pro', {
      price_cents: 10000,
      currency: 'EUR',
      interval: 'monthly',
      cpu_cores: 1,
      memory_mb: 1024,
      disk_mb: 10240,
      max_projects: 3,
      max_services: 10,
      max_members: 3,
      modules: '[]',
      is_default: 0,
      archived: 0,
      discount_pct: 0,
    });
    const hoy = new Date();
    const haceUnMes = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1).getTime();
    const ws = createWorkspaceRow('Cliente Ciclo', { billing_day: 1, billing_email: 'ciclo@cliente.test' });
    recordPlanChange(ws.id, plan.id, haceUnMes);
    updateWorkspace(ws.id, { plan_id: plan.id, plan_since: haceUnMes, billing_tax_id: 'A22222222', last_billed_period_end: haceUnMes });
    setSetting('billing.autoIssue', '1');
    setSetting('billing.emailOnIssue', '1');
    try {
      billingCycleTick(hoy);
      await vi.waitFor(() => expect(m.correos.some((c) => c.to === 'ciclo@cliente.test')).toBe(true));
    } finally {
      setSetting('billing.autoIssue', '0');
      setSetting('billing.emailOnIssue', '0');
    }
    const emitida = listInvoices(ws.id).find((i) => i.status === 'issued')!;
    expect(emitida.number).toBeTruthy();
    const correo = m.correos.find((c) => c.to === 'ciclo@cliente.test')!;
    expect(correo.text).not.toContain('checkout.stripe.com');
    const t = tokenDe(correo.text);
    const r = await abrir(`/pagar/${t}`);
    expect(r.statusCode).toBe(303);
    expect(stripe.creadas.at(-1)!.params.get('metadata[invoiceId]')).toBe(emitida.id);
    expect(stripe.creadas.at(-1)!.params.get('line_items[0][price_data][unit_amount]')).toBe(String(emitida.total_cents));
  });
});
