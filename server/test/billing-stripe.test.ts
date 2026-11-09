import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { API_TOKEN_PREFIX, hashApiToken } from '../src/auth';
import { closeDb, createUser, initDb, insertApiToken, setSetting } from '../src/db';
import { hashPassword, randomToken } from '../src/util';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';
// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

let app: FastifyInstance;
let headers: Record<string, string>;

/** Lo que Skyway pide a Stripe al crear cada sesión de Checkout. */
const sesionesPedidas: { successUrl: string | null; cancelUrl: string | null; invoiceId: string | null }[] = [];

/** Stripe falso: crea sesiones de Checkout y anota con qué URL de vuelta se pidieron. */
async function stripeFalso(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === 'https://api.stripe.com/v1/checkout/sessions' && init.method === 'POST') {
    const form = new URLSearchParams(String(init.body));
    sesionesPedidas.push({ successUrl: form.get('success_url'), cancelUrl: form.get('cancel_url'), invoiceId: form.get('client_reference_id') });
    const id = `cs_test_${sesionesPedidas.length}`;
    return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}` }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: { message: `Ruta no simulada: ${url}` } }), { status: 404, headers: { 'content-type': 'application/json' } });
}

async function call(method: Method, url: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: Json }> {
  // Sin cuerpo no se anuncia JSON: Fastify rechaza un JSON vacío con 400.
  const r = await app.inject({
    method,
    url,
    headers: body === undefined ? { ...headers, ...extra } : { ...headers, ...extra, 'content-type': 'application/json' },
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

beforeAll(async () => {
  initDb();
  vi.stubGlobal('fetch', vi.fn(stripeFalso));
  const admin = createUser('admin@test.local', hashPassword('secreto123'), 'admin');
  const secret = `${API_TOKEN_PREFIX}${randomToken(24)}`;
  insertApiToken({ user_id: admin.id, name: 'pruebas', token_hash: hashApiToken(secret), prefix: secret.slice(0, 12), expires_at: null });
  headers = { authorization: `Bearer ${secret}` };
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeDb();
  vi.unstubAllGlobals();
});

describe('página de vuelta tras pagar con Stripe', () => {
  // Con «&» y «+» en el prefijo, el número de factura exige codificarse en la URL.
  const PREFIJO = 'F&R+1';
  const PAGINA = 'https://www.empresa.es/pago?origen=factura&s={CHECKOUT_SESSION_ID}';
  let wsId = '';

  /**
   * Borrador de 10 € en la cuenta de pruebas, listo para cobrar. Con periodo
   * propio: el de por defecto es el ciclo en curso, y emitir la primera factura
   * lleva el ancla a su final y deja ese periodo vacío para la siguiente.
   */
  async function borrador(): Promise<string> {
    const ahora = Date.now();
    const r = await call('POST', `/api/workspaces/${wsId}/invoices`, {
      lines: [{ label: 'Hosting', unitCents: 1000 }],
      periodStart: ahora - 86_400_000,
      periodEnd: ahora,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.invoice.id;
  }

  it('el perfil acepta una página https y la vacía', async () => {
    let r = await call('PUT', '/api/billing/profile', { paymentReturnUrl: '  https://www.empresa.es/gracias  ' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.profile.paymentReturnUrl).toBe('https://www.empresa.es/gracias');
    r = await call('GET', '/api/billing/profile');
    expect(r.json.profile.paymentReturnUrl).toBe('https://www.empresa.es/gracias');
    r = await call('PUT', '/api/billing/profile', { paymentReturnUrl: '' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.profile.paymentReturnUrl).toBe('');
  });

  it('el perfil rechaza http://, javascript: y una URL con credenciales, sin tocar lo guardado', async () => {
    let r = await call('PUT', '/api/billing/profile', { paymentReturnUrl: PAGINA });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    for (const mala of ['http://www.empresa.es/pago', 'javascript:alert(1)', 'https://usuario:clave@www.empresa.es/pago', 'www.empresa.es/pago']) {
      r = await call('PUT', '/api/billing/profile', { paymentReturnUrl: mala, companyName: 'No se guarda' });
      expect(r.status, mala).toBe(400);
      expect(r.json.error, mala).toBe('La página de vuelta tras pagar debe ser una URL https:// válida, sin usuario ni contraseña, o quedar vacía.');
    }
    r = await call('GET', '/api/billing/profile');
    expect(r.json.profile.paymentReturnUrl).toBe(PAGINA);
    expect(r.json.profile.companyName, 'una petición rechazada no guarda nada').toBe('');
  });

  it('prepara el emisor, la cuenta con NIF y la clave de Stripe', async () => {
    let r = await call('PUT', '/api/billing/profile', { companyName: 'Emisor SL', taxId: 'B12345678', currency: 'EUR', invoicePrefix: PREFIJO, paymentReturnUrl: '' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    r = await call('POST', '/api/workspaces', { name: 'Cliente' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    wsId = r.json.workspace.id;
    r = await call('PATCH', `/api/workspaces/${wsId}`, { billingTaxId: 'A11111111' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    setSetting('stripeSecretKey', 'sk_test_x');
  });

  it('sin página de vuelta, Stripe devuelve al panel como siempre', async () => {
    const id = await borrador();
    const r = await call('POST', `/api/invoices/${id}/stripe-link`, undefined, { host: 'panel.example.com' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.url).toBe(`https://checkout.stripe.com/c/pay/cs_test_${sesionesPedidas.length}`);
    expect(sesionesPedidas.at(-1)).toEqual({
      successUrl: `http://panel.example.com/workspaces/${wsId}?paid=1`,
      cancelUrl: `http://panel.example.com/workspaces/${wsId}`,
      invoiceId: id,
    });
  });

  it('con página de vuelta, Stripe devuelve a ella con el estado y el número de factura codificado', async () => {
    let r = await call('PUT', '/api/billing/profile', { paymentReturnUrl: PAGINA });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const id = await borrador();
    r = await call('POST', `/api/invoices/${id}/stripe-link`, undefined, { host: 'panel.example.com' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const numero: string = r.json.invoice.number;
    expect(numero).toMatch(/^F&R\+1-\d{4}-0002$/);
    const factura = encodeURIComponent(numero);
    expect(factura, '«&» y «+» van codificados').toMatch(/^F%26R%2B1-\d{4}-0002$/);
    // Se conservan los parámetros de la página, y `{CHECKOUT_SESSION_ID}` sigue
    // con llaves literales para que Stripe lo sustituya.
    expect(sesionesPedidas.at(-1)).toEqual({
      successUrl: `https://www.empresa.es/pago?origen=factura&s={CHECKOUT_SESSION_ID}&estado=pagado&factura=${factura}`,
      cancelUrl: `https://www.empresa.es/pago?origen=factura&s={CHECKOUT_SESSION_ID}&estado=cancelado&factura=${factura}`,
      invoiceId: id,
    });
    const vuelta = new URL(sesionesPedidas.at(-1)!.successUrl!);
    expect(vuelta.searchParams.get('factura'), 'la página lee el número tal cual').toBe(numero);
  });
});
