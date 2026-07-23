import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertWorkspaceAccess, requireAdmin, requireAuth } from '../auth';
import { audit } from '../audit';
import {
  assignSeriesNumber,
  createInvoice,
  deleteInvoice,
  getInvoice,
  getInvoiceByStripeSession,
  getProduct,
  getWorkspace,
  listActiveSubscriptions,
  listInvoices,
  listPendingCharges,
  listTiers,
  markChargesInvoiced,
  reopenChargesForInvoice,
  transaction,
  updateInvoice,
  workspaceMeterUsage,
  workspaceUsageRange,
} from '../db';
import { getBillingProfile, getStripeSecretKey } from '../company';
import { workspacePlan } from '../quota';
import { priceTiers } from '../pricing';
import { reactivateWorkspaceIfCurrent } from '../billingauto';
import { StripeError, createStripeCheckout } from '../stripe';
import { BillingProfile, InvoiceLine, InvoiceRow, InvoiceStatus, IssuerSnapshot, TaxBreakdownEntry, VatRegime, WorkspaceRow } from '../types';

const HOUR_MS = 3_600_000;

const VAT_REGIMES: [VatRegime, ...VatRegime[]] = [
  'general',
  'exento_intracom_art25',
  'exento_export_art21',
  'inversion_sujeto_pasivo',
  'recargo_equivalencia',
  'exento_otros',
  'no_sujeto',
];

const lineSchema = z.object({
  label: z.string().trim().min(1).max(120),
  kind: z.enum(['plan', 'usage', 'custom', 'product', 'subscription', 'discount']).default('custom'),
  qty: z.coerce.number().min(0).max(1_000_000).default(1),
  unitCents: z.coerce.number().int().min(-100_000_00).max(100_000_00).default(0),
  // Tipo de IVA (%) de la línea; permite facturas con varios tipos. Ausente = el de la factura.
  taxRate: z.coerce.number().min(0).max(100).optional(),
});

/** Acota a entero seguro: por encima de 2^53 se perdería precisión al almacenar. */
const clampSafe = (n: number): number => Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, n));

/** Transiciones de estado permitidas: una factura emitida no vuelve a borrador. */
const ALLOWED_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  draft: ['draft', 'issued', 'paid', 'void'],
  issued: ['issued', 'paid', 'void'],
  paid: ['paid'],
  void: ['void'],
};

/** ¿El régimen implica IVA a cero (exención, inversión del sujeto pasivo, no sujeción)? */
function isZeroVatRegime(regime: VatRegime): boolean {
  return regime !== 'general' && regime !== 'recargo_equivalencia';
}

/** Mención legal obligatoria en la factura según el régimen de IVA aplicado. */
function legalMention(regime: VatRegime): string | null {
  switch (regime) {
    case 'exento_intracom_art25':
      return 'Operación exenta de IVA por entrega intracomunitaria (art. 25 Ley 37/1992).';
    case 'exento_export_art21':
      return 'Operación exenta de IVA por exportación (art. 21 Ley 37/1992).';
    case 'inversion_sujeto_pasivo':
      return 'Operación con inversión del sujeto pasivo (art. 84.Uno.2.º Ley 37/1992): el IVA lo liquida el destinatario.';
    case 'exento_otros':
      return 'Operación exenta de IVA.';
    case 'no_sujeto':
      return 'Operación no sujeta a IVA.';
    default:
      return null;
  }
}

interface Totals {
  lines: InvoiceLine[];
  subtotal: number;
  taxBreakdown: TaxBreakdownEntry[];
  tax: number;
  irpf: number;
  total: number;
}

/**
 * Normaliza líneas y calcula el total conforme a la normativa española: la cuota
 * de IVA se agrupa por tipo impositivo y se redondea UNA sola vez por cada base
 * (no por línea), el IRPF se retiene sobre la base imponible y el total es
 * base + IVA − retención. Todo se recomputa siempre en el servidor.
 */
function computeTotals(
  rawLines: z.infer<typeof lineSchema>[],
  opts: { defaultTaxRate: number; irpfRate: number; regime: VatRegime },
): Totals {
  const zeroVat = isZeroVatRegime(opts.regime);
  const lines: InvoiceLine[] = rawLines.map((l) => ({
    label: l.label,
    kind: l.kind,
    qty: l.qty,
    unitCents: l.unitCents,
    amountCents: clampSafe(Math.round(l.qty * l.unitCents)),
    taxRate: zeroVat ? 0 : l.taxRate ?? opts.defaultTaxRate,
  }));
  const subtotal = clampSafe(lines.reduce((sum, l) => sum + l.amountCents, 0));
  // Bases agrupadas por tipo; la cuota se redondea una vez sobre la base del tipo.
  const byRate = new Map<number, number>();
  for (const l of lines) {
    const rate = l.taxRate ?? 0;
    byRate.set(rate, (byRate.get(rate) ?? 0) + l.amountCents);
  }
  const taxBreakdown: TaxBreakdownEntry[] = [...byRate.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, base]) => ({
      rate,
      base_cents: clampSafe(base),
      quota_cents: clampSafe(Math.round(base * (rate / 100))),
    }));
  const tax = clampSafe(taxBreakdown.reduce((sum, b) => sum + b.quota_cents, 0));
  const irpf = clampSafe(Math.round(subtotal * (opts.irpfRate / 100)));
  const total = clampSafe(subtotal + tax - irpf);
  return { lines, subtotal, taxBreakdown, tax, irpf, total };
}

function parseLines(json: string): InvoiceLine[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function parseBreakdown(json: string): TaxBreakdownEntry[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function issuerSnapshot(profile: BillingProfile): IssuerSnapshot {
  return {
    companyName: profile.companyName,
    taxId: profile.taxId,
    address: profile.address,
    email: profile.email,
    phone: profile.phone,
  };
}

function publicInvoice(inv: InvoiceRow) {
  return {
    id: inv.id,
    workspace_id: inv.workspace_id,
    series_id: inv.series_id,
    number: inv.number,
    invoice_type: inv.invoice_type,
    rectifies_invoice_id: inv.rectifies_invoice_id,
    rectify_reason: inv.rectify_reason,
    period_start: inv.period_start,
    period_end: inv.period_end,
    operation_date: inv.operation_date,
    status: inv.status,
    currency: inv.currency,
    subtotal_cents: inv.subtotal_cents,
    tax_cents: inv.tax_cents,
    tax_rate: inv.tax_rate,
    tax_breakdown: parseBreakdown(inv.tax_breakdown),
    vat_regime: inv.vat_regime,
    legal_mentions: inv.legal_mentions,
    irpf_rate: inv.irpf_rate,
    irpf_cents: inv.irpf_cents,
    total_cents: inv.total_cents,
    lines: parseLines(inv.lines),
    plan_name: inv.plan_name,
    issuer_snapshot: inv.issuer_snapshot ? (JSON.parse(inv.issuer_snapshot) as IssuerSnapshot) : null,
    client_name: inv.client_name,
    client_tax_id: inv.client_tax_id,
    client_address: inv.client_address,
    payment_method: inv.payment_method,
    stripe_url: inv.stripe_url,
    issued_at: inv.issued_at,
    paid_at: inv.paid_at,
    locked: inv.locked,
    notes: inv.notes,
    created_at: inv.created_at,
  };
}

/**
 * Cantidad consumida de un medidor en el ciclo. Los medidores de infraestructura
 * salen de service_metrics_hourly (ya capturado); el resto (IA/lógicos) de
 * usage_meter_hourly (ingesta por API).
 */
function meterQuantity(
  meter: string,
  workspaceId: string,
  fromHour: number,
  toHour: number,
  usage: { cpuCorePctHours: number; memByteHours: number },
): number {
  const round2 = (x: number) => Math.round(x * 100) / 100;
  switch (meter) {
    case 'cpu_core_hour':
      return round2(usage.cpuCorePctHours / 100);
    case 'mem_gb_hour':
      return round2(usage.memByteHours / 1e9);
    default:
      return round2(workspaceMeterUsage(workspaceId, meter, fromHour, toHour));
  }
}

/** Ciclo de facturación actual anclado al día de facturación del workspace. */
function currentCycle(billingDay: number): { start: number; end: number } {
  const now = new Date();
  let start = new Date(now.getFullYear(), now.getMonth(), billingDay);
  if (now < start) start = new Date(now.getFullYear(), now.getMonth() - 1, billingDay);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, billingDay);
  return { start: start.getTime(), end: end.getTime() };
}

/**
 * Emite una factura de forma atómica: congela los datos fiscales del emisor y del
 * destinatario, asigna el número de la serie que corresponda (por ejercicio) y la
 * bloquea (inmutable). Idempotente sobre lo ya congelado/numerado; sirve para los
 * tres caminos de emisión (edición de estado, enlace de Stripe y webhook de pago).
 */
function performEmission(inv: InvoiceRow, target: 'issued' | 'paid', extra: Record<string, unknown> = {}): InvoiceRow {
  const profile = getBillingProfile();
  const ws = getWorkspace(inv.workspace_id);
  return transaction(() => {
    const fields: Record<string, unknown> = { ...extra };
    const issuedAt = (extra.issued_at as number | undefined) ?? inv.issued_at ?? Date.now();
    // Congelar emisor y destinatario la primera vez que se emite.
    if (!inv.issued_at) {
      fields.issued_at = issuedAt;
      fields.issuer_snapshot = JSON.stringify(issuerSnapshot(profile));
      if (ws) {
        fields.client_name = ws.name;
        fields.client_tax_id = ws.billing_tax_id;
        fields.client_address = ws.billing_address;
      }
    }
    // Asignar el número de serie si aún no lo tiene (una vez por factura).
    if (!inv.number) {
      const isRect = inv.invoice_type === 'rectificativa';
      const code = isRect ? 'REC' : (profile.invoicePrefix || 'FRA').trim() || 'FRA';
      const assigned = assignSeriesNumber({
        code,
        year: new Date(issuedAt).getFullYear(),
        prefix: code,
        kind: isRect ? 'rectificativa' : inv.invoice_type === 'simplificada' ? 'simplificada' : 'ordinaria',
      });
      fields.number = assigned.number;
      fields.series_id = assigned.seriesId;
    }
    fields.status = target;
    fields.locked = 1;
    if (target === 'paid' && !inv.paid_at) fields.paid_at = (extra.paid_at as number | undefined) ?? Date.now();
    updateInvoice(inv.id, fields);
    return getInvoice(inv.id)!;
  });
}

/**
 * Marca una factura como pagada a partir de una sesión de Stripe completada.
 * La usa el webhook (verificado) de `routes/webhooks.ts`. Idempotente y, si por
 * lo que fuera la factura no estaba emitida, la emite (alta antes del cobro).
 */
export function markInvoicePaidByStripeSession(sessionId: string): boolean {
  const inv = getInvoiceByStripeSession(sessionId);
  if (!inv) return false;
  if (inv.status === 'paid') return true;
  performEmission(inv, 'paid', { payment_method: 'stripe' });
  reactivateWorkspaceIfCurrent(inv.workspace_id); // levanta el corte por impago si ya no debe nada
  return true;
}

/**
 * Ensambla el borrador de factura del ciclo actual del workspace: plan +
 * suscripciones activas (recurrentes, por uso medido y por tramos) + cargos
 * puntuales pendientes. Queda en DRAFT (no emite). Lo usan la ruta manual
 * «Generar ciclo» y la facturación automática del scheduler.
 */
export function generateCycleDraft(ws: WorkspaceRow, cycle = currentCycle(ws.billing_day)): InvoiceRow | null {
  const plan = workspacePlan(ws);
  const profile = getBillingProfile();
  const fromHour = Math.floor(cycle.start / HOUR_MS);
  const toHour = Math.floor(cycle.end / HOUR_MS);
  const usage = workspaceUsageRange(ws.id, fromHour, toHour);
  const currency = plan?.currency ?? profile.currency;

  const rawLines: z.infer<typeof lineSchema>[] = [];
  if (plan) {
    rawLines.push({
      label: `Plan ${plan.name} (${plan.interval === 'yearly' ? 'anual' : 'mensual'})`,
      kind: 'plan',
      qty: 1,
      unitCents: plan.price_cents,
      taxRate: profile.vatRate,
    });
  }
  for (const sub of listActiveSubscriptions(ws.id)) {
    const product = getProduct(sub.product_id);
    if (!product) continue;
    const unitPrice = sub.unit_cents ?? product.price_cents;
    const rate = product.tax_exempt ? 0 : product.tax_rate;
    if ((product.billing_model === 'metered' || product.billing_model === 'tiered') && product.meter) {
      const raw = meterQuantity(product.meter, ws.id, fromHour, toHour, usage) * sub.qty;
      if (raw <= 0) continue;
      // Cantidad en unidades de precio (p. ej. 1M tokens): el precio es por unidad.
      const units = Math.round((product.unit_size > 1 ? raw / product.unit_size : raw) * 1e6) / 1e6;
      if (product.billing_model === 'tiered') {
        const amount = priceTiers(listTiers(product.id), units, product.tier_mode ?? 'graduated');
        rawLines.push({ label: `${product.name} · ${units} ${product.unit || 'ud'}`, kind: 'subscription', qty: 1, unitCents: amount, taxRate: rate });
      } else {
        rawLines.push({ label: `${product.name} (${product.unit || 'uso'})`, kind: 'usage', qty: units, unitCents: unitPrice, taxRate: rate });
      }
    } else {
      rawLines.push({ label: `${product.name} (${sub.interval === 'yearly' ? 'anual' : 'mensual'})`, kind: 'subscription', qty: sub.qty, unitCents: unitPrice, taxRate: rate });
    }
  }
  const charges = listPendingCharges(ws.id, 'pending');
  for (const c of charges) {
    rawLines.push({ label: c.label, kind: c.kind === 'product' ? 'product' : 'custom', qty: c.qty, unitCents: c.unit_cents, taxRate: c.tax_rate });
  }

  // Nada que facturar este ciclo (sin plan, sin suscripciones con consumo, sin
  // cargos): no se crea un borrador vacío que se acumularía mes a mes.
  if (rawLines.length === 0) return null;

  const totals = computeTotals(rawLines, { defaultTaxRate: profile.vatRate, irpfRate: profile.defaultIrpfRate, regime: 'general' });
  // Factura y marcado de cargos, atómicos: no pueden divergir ante un fallo.
  return transaction(() => {
    const inv = createInvoice({
      workspace_id: ws.id,
      period_start: cycle.start,
      period_end: cycle.end,
      status: 'draft',
      currency,
      subtotal_cents: totals.subtotal,
      tax_cents: totals.tax,
      tax_rate: profile.vatRate,
      tax_breakdown: JSON.stringify(totals.taxBreakdown),
      vat_regime: 'general',
      legal_mentions: legalMention('general'),
      irpf_rate: profile.defaultIrpfRate,
      irpf_cents: totals.irpf,
      total_cents: totals.total,
      lines: JSON.stringify(totals.lines),
      plan_name: plan?.name ?? null,
    });
    if (charges.length > 0) markChargesInvoiced(charges.map((c) => c.id), inv.id);
    return inv;
  });
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
      client: {
        name: ws.name,
        billing_email: ws.billing_email,
        billing_tax_id: ws.billing_tax_id,
        billing_address: ws.billing_address,
      },
      stripeEnabled: !!getStripeSecretKey(),
    };
  });

  // Genera el borrador del ciclo (plan + suscripciones + cargos). En DRAFT para revisar.
  app.post('/api/workspaces/:id/invoices/generate', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = getWorkspace(id);
    if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
    const inv = generateCycleDraft(ws);
    if (!inv) return reply.code(400).send({ error: 'No hay nada que facturar en este ciclo (sin plan, suscripciones ni cargos).' });
    audit(req, 'invoice_generated', { type: 'invoice', id: inv.id, detail: `${ws.name} · ${inv.currency} ${(inv.total_cents / 100).toFixed(2)}` });
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
        operationDate: z.coerce.number().int().nullable().optional(),
        currency: z.string().trim().length(3).toUpperCase().optional(),
        taxRate: z.coerce.number().min(0).max(100).optional(),
        irpfRate: z.coerce.number().min(0).max(100).optional(),
        vatRegime: z.enum(VAT_REGIMES).optional(),
        notes: z.string().trim().max(2000).nullable().optional(),
      })
      .parse(req.body);
    const defaultTaxRate = body.taxRate ?? profile.vatRate;
    const irpfRate = body.irpfRate ?? profile.defaultIrpfRate;
    const regime = body.vatRegime ?? 'general';
    const totals = computeTotals(body.lines, { defaultTaxRate, irpfRate, regime });
    const inv = createInvoice({
      workspace_id: id,
      period_start: body.periodStart ?? cycle.start,
      period_end: body.periodEnd ?? cycle.end,
      operation_date: body.operationDate ?? null,
      status: 'draft',
      currency: body.currency ?? plan?.currency ?? profile.currency,
      subtotal_cents: totals.subtotal,
      tax_cents: totals.tax,
      tax_rate: defaultTaxRate,
      tax_breakdown: JSON.stringify(totals.taxBreakdown),
      vat_regime: regime,
      legal_mentions: legalMention(regime),
      irpf_rate: irpfRate,
      irpf_cents: totals.irpf,
      total_cents: totals.total,
      lines: JSON.stringify(totals.lines),
      plan_name: plan?.name ?? null,
      notes: body.notes ?? null,
    });
    audit(req, 'invoice_created', { type: 'invoice', id: inv.id, detail: ws.name });
    reply.code(201);
    return { invoice: publicInvoice(inv) };
  });

  // Edita una factura. El CONTENIDO fiscal solo es editable en borrador; una
  // factura emitida es inmutable (solo se corrige con una rectificativa). Sí se
  // admiten transiciones de estado válidas, método de pago y notas.
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
        irpfRate: z.coerce.number().min(0).max(100).optional(),
        vatRegime: z.enum(VAT_REGIMES).optional(),
        operationDate: z.coerce.number().int().nullable().optional(),
        notes: z.string().trim().max(2000).nullable().optional(),
        currency: z.string().trim().length(3).toUpperCase().optional(),
      })
      .parse(req.body);

    const editsContent =
      body.lines !== undefined ||
      body.taxRate !== undefined ||
      body.irpfRate !== undefined ||
      body.vatRegime !== undefined ||
      body.operationDate !== undefined ||
      body.currency !== undefined;
    if (inv.status !== 'draft' && editsContent) {
      return reply.code(409).send({ error: 'Una factura emitida es inmutable; corríjala emitiendo una factura rectificativa.' });
    }
    const target = body.status ?? inv.status;
    if (target !== inv.status && !ALLOWED_TRANSITIONS[inv.status].includes(target)) {
      return reply.code(409).send({ error: `Transición de estado no permitida (${inv.status} → ${target}).` });
    }

    const fields: Record<string, unknown> = {};
    if (inv.status === 'draft' && editsContent) {
      const regime = body.vatRegime ?? inv.vat_regime;
      const defaultTaxRate = body.taxRate ?? inv.tax_rate;
      const irpfRate = body.irpfRate ?? inv.irpf_rate;
      const raw = (body.lines ?? parseLines(inv.lines)) as z.infer<typeof lineSchema>[];
      const totals = computeTotals(raw, { defaultTaxRate, irpfRate, regime });
      fields.lines = JSON.stringify(totals.lines);
      fields.subtotal_cents = totals.subtotal;
      fields.tax_cents = totals.tax;
      fields.tax_rate = defaultTaxRate;
      fields.tax_breakdown = JSON.stringify(totals.taxBreakdown);
      fields.vat_regime = regime;
      fields.legal_mentions = legalMention(regime);
      fields.irpf_rate = irpfRate;
      fields.irpf_cents = totals.irpf;
      fields.total_cents = totals.total;
      if (body.currency) fields.currency = body.currency;
      if (body.operationDate !== undefined) fields.operation_date = body.operationDate;
    }
    if (body.notes !== undefined) fields.notes = body.notes;
    if (body.paymentMethod !== undefined) fields.payment_method = body.paymentMethod;

    // Aplicar la transición de estado.
    if ((target === 'issued' || target === 'paid') && (inv.status === 'draft' || inv.status === 'issued')) {
      performEmission(inv, target, fields);
    } else {
      if (target !== inv.status) fields.status = target; // draft/issued → void
      updateInvoice(id, fields);
      // Al anular, los cargos puntuales enlazados vuelven a pendientes (no se pierden).
      if (target === 'void' && inv.status !== 'void') reopenChargesForInvoice(id);
    }
    // Cobro manual: levanta el corte por impago si la cuenta ya no debe nada.
    if (target === 'paid' && inv.status !== 'paid') reactivateWorkspaceIfCurrent(inv.workspace_id);
    audit(req, 'invoice_updated', { type: 'invoice', id, detail: body.status ?? 'edición' });
    return { invoice: publicInvoice(getInvoice(id)!) };
  });

  // Solo se pueden borrar borradores; una factura emitida se conserva (se anula).
  app.delete('/api/invoices/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inv = getInvoice(id);
    if (!inv) return reply.code(404).send({ error: 'Factura no encontrada' });
    if (inv.status !== 'draft') {
      return reply.code(409).send({ error: 'Solo se pueden borrar borradores. Una factura emitida debe anularse o rectificarse, nunca borrarse.' });
    }
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
    if (inv.status === 'void') return reply.code(400).send({ error: 'La factura está anulada.' });
    const secret = getStripeSecretKey();
    if (!secret) return reply.code(400).send({ error: 'Configura primero la clave de Stripe en Contabilidad.' });
    const ws = getWorkspace(inv.workspace_id);
    const origin = `${req.protocol}://${req.headers.host}`;

    // Emitir la factura antes de cobrar (alta antes del pago): asigna número/serie
    // y la congela. Si ya estaba emitida, no reasigna nada.
    const issued = inv.status === 'draft' ? performEmission(inv, 'issued') : inv;
    const number = issued.number ?? issued.id;

    try {
      const session = await createStripeCheckout(secret, {
        amountCents: issued.total_cents,
        currency: issued.currency,
        invoiceNumber: number,
        invoiceId: issued.id,
        successUrl: `${origin}/workspaces/${issued.workspace_id}?paid=1`,
        cancelUrl: `${origin}/workspaces/${issued.workspace_id}`,
        customerEmail: ws?.billing_email ?? null,
      });
      updateInvoice(id, { stripe_session_id: session.id, stripe_url: session.url, payment_method: 'stripe' });
      audit(req, 'invoice_stripe_link', { type: 'invoice', id, detail: number });
      return { url: session.url, invoice: publicInvoice(getInvoice(id)!) };
    } catch (err: any) {
      if (err instanceof StripeError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });
}
