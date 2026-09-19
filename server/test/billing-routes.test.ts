import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { API_TOKEN_PREFIX, hashApiToken } from '../src/auth';
import { closeDb, createUser, getInvoice, initDb, insertApiToken, recordPlanChange, setSetting, updateWorkspace } from '../src/db';
import { lastCutoff } from '../src/routes/billing';
import { hashPassword, randomToken } from '../src/util';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

let app: FastifyInstance;
let headers: Record<string, string>;

async function call(method: Method, url: string, body?: unknown): Promise<{ status: number; json: Json }> {
  // Sin cuerpo no se anuncia JSON: Fastify rechaza un JSON vacío con 400 y
  // enmascararía el motivo real de la respuesta.
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

beforeAll(async () => {
  initDb();
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
});

describe('rutas de facturación', () => {
  let planId = '';
  let archivadoId = '';
  let wsId = '';
  let prodId = '';
  let suscId = '';
  let usdId = '';
  let sinPlanId = '';
  let invId = '';
  let original: Json;
  let rect: Json;

  it('guarda el perfil del emisor con NIF (la emisión lo exige)', async () => {
    const r = await call('PUT', '/api/billing/profile', { companyName: 'Emisor SL', taxId: 'B12345678', currency: 'EUR' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  });

  it('crea un plan EUR, uno archivado y una cuenta con NIF', async () => {
    let r = await call('POST', '/api/plans', { name: 'Pro', price_cents: 10000, currency: 'EUR' });
    expect(r.status).toBe(201);
    planId = r.json.plan.id;
    r = await call('POST', '/api/plans', { name: 'Viejo', price_cents: 5000, currency: 'EUR', archived: true });
    expect(r.status).toBe(201);
    archivadoId = r.json.plan.id;
    r = await call('POST', '/api/workspaces', { name: 'Cliente', planId, billingDay: 1 });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    wsId = r.json.workspace.id;
    r = await call('PATCH', `/api/workspaces/${wsId}`, { billingTaxId: 'A11111111' });
    expect(r.status).toBe(200);
  });

  it('un plan archivado no se contrata (alta ni cambio), pero reenviar el actual sigue valiendo', async () => {
    let r = await call('POST', '/api/workspaces', { name: 'Otro', planId: archivadoId });
    expect(r.status, 'alta con plan archivado').toBe(400);
    r = await call('PATCH', `/api/workspaces/${wsId}`, { planId: archivadoId });
    expect(r.status, 'cambio a plan archivado').toBe(400);
    r = await call('PATCH', `/api/workspaces/${wsId}`, { planId });
    expect(r.status, 'reenviar el plan actual').toBe(200);
  });

  it('la moneda de un plan contratado está bloqueada; la de uno libre, no', async () => {
    let r = await call('PATCH', `/api/plans/${planId}`, { currency: 'USD' });
    expect(r.status, 'moneda de plan contratado').toBe(409);
    r = await call('PATCH', `/api/plans/${archivadoId}`, { currency: 'USD' });
    expect(r.status, 'moneda de plan libre').toBe(200);
  });

  it('un producto por uso sin medidor se rechaza al crear y al cambiar el modelo', async () => {
    let r = await call('POST', '/api/products', { name: 'Tokens', billingModel: 'metered', priceCents: 100 });
    expect(r.status, 'metered sin meter').toBe(400);
    r = await call('POST', '/api/products', { name: 'Tokens', billingModel: 'metered', meter: 'ai_tokens_out', priceCents: 100, unitSize: 1000000 });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    prodId = r.json.product.id;
    r = await call('PATCH', `/api/products/${prodId}`, { meter: null });
    expect(r.status, 'quitar el meter a un metered').toBe(400);
    r = await call('POST', '/api/products', { name: 'Soporte', billingModel: 'subscription', interval: 'monthly', priceCents: 2000 });
    expect(r.status).toBe(201);
    suscId = r.json.product.id;
    r = await call('POST', '/api/products', { name: 'USD sub', billingModel: 'subscription', interval: 'monthly', priceCents: 2000, currency: 'USD' });
    expect(r.status).toBe(201);
    usdId = r.json.product.id;
  });

  it('una suscripción en otra divisa se rechaza; sin plan se valida contra la moneda del emisor', async () => {
    let r = await call('POST', `/api/workspaces/${wsId}/subscriptions`, { productId: usdId });
    expect(r.status, 'USD en cuenta EUR').toBe(400);
    r = await call('POST', '/api/workspaces', { name: 'Sin plan' });
    expect(r.status).toBe(201);
    sinPlanId = r.json.workspace.id;
    r = await call('POST', `/api/workspaces/${sinPlanId}/subscriptions`, { productId: usdId });
    expect(r.status, 'USD en cuenta sin plan (emisor EUR)').toBe(400);
    r = await call('POST', `/api/workspaces/${sinPlanId}/subscriptions`, { productId: suscId });
    expect(r.status, 'EUR en cuenta sin plan').toBe(201);
  });

  it('una factura a medida con el periodo invertido → 400', async () => {
    const ahora = Date.now();
    const r = await call('POST', `/api/workspaces/${wsId}/invoices`, {
      lines: [{ label: 'x', unitCents: 100 }],
      periodStart: ahora,
      periodEnd: ahora - 1000,
    });
    expect(r.status).toBe(400);
  });

  it('una factura con dos tipos de IVA y retención calcula las cuotas por grupo y expone due_at', async () => {
    const r = await call('POST', `/api/workspaces/${wsId}/invoices`, {
      lines: [
        { label: 'Hosting', qty: 1, unitCents: 1005, taxRate: 10, irpfRate: 0 },
        { label: 'Consultoría', qty: 2.5, unitCents: 1999, taxRate: 21, irpfRate: 15 },
        { label: 'Exento', qty: 1, unitCents: 3333, taxRate: 0, irpfRate: 0 },
      ],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    invId = r.json.invoice.id;
    // 10 % de 1005 = 100,5 → 101; 21 % de 4998 = 1049,58 → 1050; 15 % de 4998 = 749,7 → 750
    expect(r.json.invoice.tax_cents).toBe(101 + 1050);
    expect(r.json.invoice.irpf_cents).toBe(750);
    expect('due_at' in r.json.invoice, 'due_at expuesto').toBe(true);
  });

  it('el enlace de Stripe sobre un borrador con total cero → 400 y el borrador no se emite', async () => {
    let r = await call('POST', `/api/workspaces/${wsId}/invoices`, { lines: [{ label: 'gratis', unitCents: 0 }] });
    expect(r.status).toBe(201);
    const ceroId: string = r.json.invoice.id;
    setSetting('stripeSecretKey', 'sk_test_x');
    r = await call('POST', `/api/invoices/${ceroId}/stripe-link`);
    expect(r.status, 'total cero').toBe(400);
    expect(r.json.error).toMatch(/total positivo/);
    expect(getInvoice(ceroId)!.status, 'no se emite por un enlace fallido').toBe('draft');
  });

  it('emitir numera en la serie FRA y congela due_at', async () => {
    const r = await call('PATCH', `/api/invoices/${invId}`, { status: 'issued' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.invoice.number).toMatch(/^FRA-\d{4}-0001$/);
    expect(r.json.invoice.due_at, 'due_at congelado').toBeGreaterThan(r.json.invoice.issued_at);
    original = r.json.invoice;
  });

  it('la rectificativa de anulación total netea base, IVA, IRPF y total exactamente a cero', async () => {
    let r = await call('POST', `/api/invoices/${invId}/rectify`, { reason: 'Anulación de prueba' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    rect = r.json.invoice;
    expect(rect.subtotal_cents + original.subtotal_cents, 'base').toBe(0);
    expect(rect.tax_cents + original.tax_cents, `IVA: ${rect.tax_cents} vs ${original.tax_cents}`).toBe(0);
    expect(rect.irpf_cents + original.irpf_cents, `IRPF: ${rect.irpf_cents} vs ${original.irpf_cents}`).toBe(0);
    expect(rect.total_cents + original.total_cents, 'total').toBe(0);
    r = await call('PATCH', `/api/invoices/${rect.id}`, { status: 'issued' });
    expect(r.status).toBe(200);
    expect(r.json.invoice.number).toMatch(/^REC-\d{4}-0001$/);
  });

  it('anular la original con la rectificativa viva → 409; anulada la rectificativa, sí', async () => {
    let r = await call('PATCH', `/api/invoices/${invId}`, { status: 'void' });
    expect(r.status, 'anular con rectificativa viva').toBe(409);
    r = await call('PATCH', `/api/invoices/${rect.id}`, { status: 'void' });
    expect(r.status).toBe(200);
    r = await call('PATCH', `/api/invoices/${invId}`, { status: 'void' });
    expect(r.status, 'anular tras anular la rectificativa').toBe(200);
  });

  it('«Generar ciclo» crea la previsión del periodo en curso y la segunda pulsación → 409', async () => {
    // La cuenta se dio de alta hoy: sin ancla, el periodo cerrado anterior no
    // tiene plan y no habría nada que facturar. Se ancla el plan al último corte
    // para que el único ciclo generable sea el que está en curso.
    const corte = lastCutoff(1);
    recordPlanChange(wsId, planId, corte);
    updateWorkspace(wsId, { plan_since: corte, last_billed_period_end: corte });
    let r = await call('POST', `/api/workspaces/${wsId}/invoices/generate`);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.invoice.status).toBe('draft');
    expect(r.json.invoice.period_start).toBe(corte);
    r = await call('POST', `/api/workspaces/${wsId}/invoices/generate`);
    expect(r.status, 'segunda generación').toBe(409);
  });

  it('el listado de contabilidad expone due_at en todas las facturas', async () => {
    const r = await call('GET', '/api/accounting/invoices');
    expect(r.status).toBe(200);
    expect(r.json.invoices.length).toBeGreaterThan(0);
    expect(r.json.invoices.every((i: Json) => 'due_at' in i), 'due_at en contabilidad').toBe(true);
  });
});
