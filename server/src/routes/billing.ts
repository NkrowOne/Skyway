import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertWorkspaceAccess, requireAdmin, requireAuth } from '../auth';
import { audit } from '../audit';
import {
  createInvoice,
  deleteInvoice,
  getInvoice,
  getInvoiceByStripeSession,
  getWorkspace,
  listInvoices,
  nextInvoiceNumber,
  updateInvoice,
  workspaceUsageRange,
} from '../db';
import { getBillingProfile, getStripeSecretKey } from '../company';
import { workspacePlan } from '../quota';
import { StripeError, createStripeCheckout } from '../stripe';
import { InvoiceLine, InvoiceRow } from '../types';

const HOUR_MS = 3_600_000;

const lineSchema = z.object({
  label: z.string().trim().min(1).max(120),
  kind: z.enum(['plan', 'usage', 'custom']).default('custom'),
  qty: z.coerce.number().min(0).max(1_000_000).default(1),
  unitCents: z.coerce.number().int().min(-100_000_00).max(100_000_00).default(0),
});

/** Acota a entero seguro: por encima de 2^53 se perdería precisión al almacenar. */
const clampSafe = (n: number): number => Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, n));

/** Normaliza líneas + calcula subtotal, impuesto y total (todo se recomputa en servidor). */
function computeTotals(rawLines: z.infer<typeof lineSchema>[], taxRate: number): { lines: InvoiceLine[]; subtotal: number; tax: number; total: number } {
  const lines: InvoiceLine[] = rawLines.map((l) => ({
    label: l.label,
    kind: l.kind,
    qty: l.qty,
    unitCents: l.unitCents,
    amountCents: clampSafe(Math.round(l.qty * l.unitCents)),
  }));
  const subtotal = clampSafe(lines.reduce((sum, l) => sum + l.amountCents, 0));
  const tax = clampSafe(Math.round(subtotal * (taxRate / 100)));
  return { lines, subtotal, tax, total: clampSafe(subtotal + tax) };
}

function parseLines(json: string): InvoiceLine[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function publicInvoice(inv: InvoiceRow) {
  return {
    id: inv.id,
    workspace_id: inv.workspace_id,
    number: inv.number,
    period_start: inv.period_start,
    period_end: inv.period_end,
    status: inv.status,
    currency: inv.currency,
    subtotal_cents: inv.subtotal_cents,
    tax_cents: inv.tax_cents,
    tax_rate: inv.tax_rate,
    total_cents: inv.total_cents,
    lines: parseLines(inv.lines),
    plan_name: inv.plan_name,
    payment_method: inv.payment_method,
    stripe_url: inv.stripe_url,
    issued_at: inv.issued_at,
    paid_at: inv.paid_at,
    notes: inv.notes,
    created_at: inv.created_at,
  };
}

/** Ciclo de facturación actual anclado al día de facturación del workspace. */
function currentCycle(billingDay: number): { start: number; end: number } {
  const now = new Date();
  let start = new Date(now.getFullYear(), now.getMonth(), billingDay);
  if (now < start) start = new Date(now.getFullYear(), now.getMonth() - 1, billingDay);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, billingDay);
  return { start: start.getTime(), end: end.getTime() };
}

/** Asigna número de factura al emitir/pagar si aún no lo tiene. */
function ensureNumber(inv: InvoiceRow, fields: Record<string, unknown>): void {
  if (!inv.number && !fields.number) fields.number = nextInvoiceNumber(getBillingProfile().invoicePrefix);
}

/**
 * Marca una factura como pagada a partir de una sesión de Stripe completada.
 * La usa el webhook (verificado) de `routes/webhooks.ts`. Idempotente.
 */
export function markInvoicePaidByStripeSession(sessionId: string): boolean {
  const inv = getInvoiceByStripeSession(sessionId);
  if (!inv) return false;
  if (inv.status === 'paid') return true;
  const fields: Record<string, unknown> = { status: 'paid', payment_method: 'stripe', paid_at: Date.now() };
  if (!inv.issued_at) fields.issued_at = Date.now();
  ensureNumber(inv, fields);
  updateInvoice(inv.id, fields);
  return true;
}

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Facturas del workspace + datos del emisor (para pintar la factura) + estado de Stripe.
  app.get('/api/workspaces/:id/invoices', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = getWorkspace(id);
    if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
    if (!assertWorkspaceAccess(req, reply, id)) return reply;
    return {
      invoices: listInvoices(id).map(publicInvoice),
      issuer: getBillingProfile(),
      client: { name: ws.name, billing_email: ws.billing_email },
      stripeEnabled: !!getStripeSecretKey(),
    };
  });

  // Genera la factura del ciclo: plan (usos incluidos) + uso, con IVA del perfil.
  app.post('/api/workspaces/:id/invoices/generate', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = getWorkspace(id);
    if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
    const plan = workspacePlan(ws);
    const profile = getBillingProfile();
    const cycle = currentCycle(ws.billing_day);
    const usage = workspaceUsageRange(id, Math.floor(cycle.start / HOUR_MS), Math.floor(cycle.end / HOUR_MS));
    const currency = plan?.currency ?? profile.currency;

    const rawLines: z.infer<typeof lineSchema>[] = [];
    if (plan) {
      rawLines.push({
        label: `Plan ${plan.name} (${plan.interval === 'yearly' ? 'anual' : 'mensual'})`,
        kind: 'plan',
        qty: 1,
        unitCents: plan.price_cents,
      });
    }
    rawLines.push(
      { label: 'CPU consumida (núcleo·h)', kind: 'usage', qty: Math.round((usage.cpuCorePctHours / 100) * 100) / 100, unitCents: 0 },
      { label: 'Memoria consumida (GB·h)', kind: 'usage', qty: Math.round((usage.memByteHours / 1e9) * 100) / 100, unitCents: 0 },
    );

    const { lines, subtotal, tax, total } = computeTotals(rawLines, profile.vatRate);
    const inv = createInvoice({
      workspace_id: id,
      number: null,
      period_start: cycle.start,
      period_end: cycle.end,
      status: 'draft',
      currency,
      subtotal_cents: subtotal,
      tax_cents: tax,
      tax_rate: profile.vatRate,
      total_cents: total,
      lines: JSON.stringify(lines),
      plan_name: plan?.name ?? null,
      payment_method: null,
      stripe_session_id: null,
      stripe_url: null,
      issued_at: null,
      paid_at: null,
      notes: null,
    });
    audit(req, 'invoice_generated', { type: 'invoice', id: inv.id, detail: `${ws.name} · ${currency} ${(total / 100).toFixed(2)}` });
    reply.code(201);
    return { invoice: publicInvoice(inv) };
  });

  // Crea una factura totalmente a medida (líneas libres).
  app.post('/api/workspaces/:id/invoices', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = getWorkspace(id);
    if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
    const plan = workspacePlan(ws);
    const profile = getBillingProfile();
    const cycle = currentCycle(ws.billing_day);
    const body = z
      .object({
        lines: z.array(lineSchema).max(100).default([]),
        periodStart: z.coerce.number().int().optional(),
        periodEnd: z.coerce.number().int().optional(),
        currency: z.string().trim().length(3).toUpperCase().optional(),
        taxRate: z.coerce.number().min(0).max(100).optional(),
        notes: z.string().trim().max(2000).nullable().optional(),
      })
      .parse(req.body);
    const taxRate = body.taxRate ?? profile.vatRate;
    const { lines, subtotal, tax, total } = computeTotals(body.lines, taxRate);
    const inv = createInvoice({
      workspace_id: id,
      number: null,
      period_start: body.periodStart ?? cycle.start,
      period_end: body.periodEnd ?? cycle.end,
      status: 'draft',
      currency: body.currency ?? plan?.currency ?? profile.currency,
      subtotal_cents: subtotal,
      tax_cents: tax,
      tax_rate: taxRate,
      total_cents: total,
      lines: JSON.stringify(lines),
      plan_name: plan?.name ?? null,
      payment_method: null,
      stripe_session_id: null,
      stripe_url: null,
      issued_at: null,
      paid_at: null,
      notes: body.notes ?? null,
    });
    audit(req, 'invoice_created', { type: 'invoice', id: inv.id, detail: ws.name });
    reply.code(201);
    return { invoice: publicInvoice(inv) };
  });

  // Edita una factura: líneas, estado, método de pago y notas. Solo admin.
  app.patch('/api/invoices/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inv = getInvoice(id);
    if (!inv) return reply.code(404).send({ error: 'Factura no encontrada' });
    const body = z
      .object({
        lines: z.array(lineSchema).max(100).optional(),
        status: z.enum(['draft', 'issued', 'paid', 'void']).optional(),
        paymentMethod: z.enum(['bank_transfer', 'stripe', 'card', 'cash', 'other']).nullable().optional(),
        taxRate: z.coerce.number().min(0).max(100).optional(),
        notes: z.string().trim().max(2000).nullable().optional(),
        currency: z.string().trim().length(3).toUpperCase().optional(),
      })
      .parse(req.body);

    const fields: Record<string, unknown> = {};
    const taxRate = body.taxRate ?? inv.tax_rate;
    if (body.lines || body.taxRate !== undefined) {
      const raw = body.lines ?? parseLines(inv.lines);
      const { lines, subtotal, tax, total } = computeTotals(raw as z.infer<typeof lineSchema>[], taxRate);
      fields.lines = JSON.stringify(lines);
      fields.subtotal_cents = subtotal;
      fields.tax_cents = tax;
      fields.tax_rate = taxRate;
      fields.total_cents = total;
    }
    if (body.currency) fields.currency = body.currency;
    if (body.notes !== undefined) fields.notes = body.notes;
    if (body.paymentMethod !== undefined) fields.payment_method = body.paymentMethod;
    if (body.status && body.status !== inv.status) {
      fields.status = body.status;
      if (body.status === 'issued' || body.status === 'paid') {
        if (!inv.issued_at) fields.issued_at = Date.now();
        ensureNumber(inv, fields); // asigna número de factura al emitir/pagar
      }
      if (body.status === 'paid') fields.paid_at = Date.now();
    }
    updateInvoice(id, fields);
    audit(req, 'invoice_updated', { type: 'invoice', id, detail: body.status ?? 'edición' });
    return { invoice: publicInvoice(getInvoice(id)!) };
  });

  app.delete('/api/invoices/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inv = getInvoice(id);
    if (!inv) return reply.code(404).send({ error: 'Factura no encontrada' });
    deleteInvoice(id);
    audit(req, 'invoice_deleted', { type: 'invoice', id });
    return { ok: true };
  });

  // Crea (o reutiliza) un enlace de pago con Stripe para la factura. Solo admin.
  app.post('/api/invoices/:id/stripe-link', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inv = getInvoice(id);
    if (!inv) return reply.code(404).send({ error: 'Factura no encontrada' });
    if (inv.status === 'paid') return reply.code(400).send({ error: 'La factura ya está pagada.' });
    const secret = getStripeSecretKey();
    if (!secret) return reply.code(400).send({ error: 'Configura primero la clave de Stripe en Contabilidad.' });
    const ws = getWorkspace(inv.workspace_id);
    const origin = `${req.protocol}://${req.headers.host}`;

    const fields: Record<string, unknown> = {};
    if (!inv.number) fields.number = nextInvoiceNumber(getBillingProfile().invoicePrefix);
    if (!inv.issued_at) fields.issued_at = Date.now();
    if (inv.status === 'draft') fields.status = 'issued';
    const number = (fields.number as string) ?? inv.number ?? inv.id;

    try {
      const session = await createStripeCheckout(secret, {
        amountCents: inv.total_cents,
        currency: inv.currency,
        invoiceNumber: number,
        invoiceId: inv.id,
        successUrl: `${origin}/workspaces/${inv.workspace_id}?paid=1`,
        cancelUrl: `${origin}/workspaces/${inv.workspace_id}`,
        customerEmail: ws?.billing_email ?? null,
      });
      fields.stripe_session_id = session.id;
      fields.stripe_url = session.url;
      fields.payment_method = 'stripe';
      updateInvoice(id, fields);
      audit(req, 'invoice_stripe_link', { type: 'invoice', id, detail: number });
      return { url: session.url, invoice: publicInvoice(getInvoice(id)!) };
    } catch (err: any) {
      if (err instanceof StripeError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });
}
