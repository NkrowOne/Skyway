import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertWorkspaceAccess, requireAdmin, requireAuth } from '../auth';
import { audit, auditSystem } from '../audit';
import {
  assignSeriesNumber,
  createInvoice,
  deleteInvoice,
  getInvoice,
  getInvoiceByStripeSession,
  getPlan,
  getProduct,
  getWorkspace,
  invoiceExistsForCycle,
  listBillableSubscriptions,
  listInvoices,
  listPendingCharges,
  listRectificationsOf,
  listTiers,
  markChargesInvoiced,
  reopenChargesForInvoice,
  reopenChargesNotIn,
  transaction,
  updateInvoice,
  updateWorkspace,
  workspaceMeterUsage,
  workspaceUsageRange,
} from '../db';
import { getBillingProfile, getStripeSecretKey } from '../company';
import { priceTiers } from '../pricing';
import { reactivateWorkspaceIfCurrent } from '../billingauto';
import { StripeError, createStripeCheckout, stripeAmount } from '../stripe';
import { BillingProfile, InvoiceLine, InvoiceRow, InvoiceStatus, IssuerSnapshot, PlanRow, TaxBreakdownEntry, VatRegime, WorkspaceRow } from '../types';

const HOUR_MS = 3_600_000;

/** Error de negocio de facturación: la ruta lo traduce a 400 con su mensaje. */
export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingError';
  }
}

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
  // Tipo de retención de IRPF (%) de la línea: solo algunos conceptos (servicios
  // profesionales) retienen. Ausente = el tipo por defecto de la factura.
  irpfRate: z.coerce.number().min(0).max(100).optional(),
  // Cargo puntual del que procede la línea; viaja de ida y vuelta con el editor
  // para poder reabrir el cargo si se elimina su línea.
  chargeId: z.string().trim().max(60).optional(),
});

/** Acota a entero seguro: por encima de 2^53 se perdería precisión al almacenar. */
const clampSafe = (n: number): number => Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, n));

/**
 * Línea de trabajo del borrador de ciclo. `discountable` es transitorio (no viaja
 * en lineSchema ni se persiste): marca qué líneas admite el descuento comercial.
 * Se fija en el bucle de suscripciones porque en `rawLines` ya se ha perdido el
 * vínculo con la suscripción (tramos y cuota fija comparten kind:'subscription').
 */
type LineDraft = z.infer<typeof lineSchema> & { discountable?: boolean };

/**
 * Aplica el descuento comercial de la cuenta/plan (%) empujando UNA línea de
 * descuento por cada combinación de (tipo de IVA, tipo de IRPF) presente entre las
 * líneas descontables. Así los dos desgloses siguen cuadrando: computeTotals
 * agrupa por tipo y redondea la cuota una vez sobre cada base ya descontada. Se
 * agrupa también por IRPF porque, si no, el descuento reduciría la base de un tipo
 * de retención distinto al de la línea descontada. Se excluyen las líneas con
 * precio negociado por cliente (unit_cents) para no descontar dos veces. El clamp
 * por grupo evita bases negativas.
 */
function applyAccountDiscount(rawLines: LineDraft[], pct: number): void {
  if (!(pct > 0)) return;
  const clamped = Math.min(100, pct);
  const baseByRate = new Map<string, { taxRate: number; irpfRate: number | undefined; base: number }>();
  for (const l of rawLines) {
    if (!l.discountable) continue;
    const amount = Math.round(l.qty * l.unitCents);
    if (amount <= 0) continue; // solo se descuenta sobre importes positivos
    const taxRate = l.taxRate ?? 0;
    const key = `${taxRate}|${l.irpfRate ?? ''}`;
    const entry = baseByRate.get(key) ?? { taxRate, irpfRate: l.irpfRate, base: 0 };
    entry.base += amount;
    baseByRate.set(key, entry);
  }
  const multiRate = baseByRate.size > 1;
  for (const { taxRate, irpfRate, base } of baseByRate.values()) {
    if (base <= 0) continue;
    const disc = Math.min(base, Math.round((base * clamped) / 100)); // nunca supera la base del grupo
    if (disc <= 0) continue;
    rawLines.push({
      label: `Descuento ${clamped}%${multiRate ? ` (IVA ${taxRate}%)` : ''}`,
      kind: 'discount',
      qty: 1,
      unitCents: -disc,
      taxRate,
      irpfRate,
    });
  }
}

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
  /** Tipo de retención a guardar en la factura: el único si es uniforme, o el efectivo. */
  irpfRate: number;
  total: number;
}

/**
 * Normaliza líneas y calcula el total conforme a la normativa española: la cuota
 * de IVA se agrupa por tipo impositivo y se redondea UNA sola vez por cada base
 * (no por línea), la retención de IRPF se agrupa igual por tipo de retención (una
 * misma factura puede llevar conceptos sujetos a retención y otros no) y el total
 * es base + IVA − retención. Todo se recomputa siempre en el servidor.
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
    irpfRate: l.irpfRate ?? opts.irpfRate,
    ...(l.chargeId ? { chargeId: l.chargeId } : {}),
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
  // Retención por tipo: solo los conceptos sujetos (p. ej. servicios profesionales)
  // retienen, y cada base se redondea una sola vez.
  const byIrpf = new Map<number, number>();
  for (const l of lines) {
    const rate = l.irpfRate ?? 0;
    byIrpf.set(rate, (byIrpf.get(rate) ?? 0) + l.amountCents);
  }
  let irpf = 0;
  for (const [rate, base] of byIrpf) irpf += Math.round(base * (rate / 100));
  irpf = clampSafe(irpf);
  // Tipo a guardar en la cabecera: el único si todas las líneas comparten
  // retención; si no, el efectivo sobre la base (solo informativo: el importe
  // bueno es `irpf`, calculado por tramos).
  const rates = [...byIrpf.keys()];
  const irpfRate = rates.length === 1 ? rates[0] : subtotal !== 0 ? Math.round((irpf / subtotal) * 10000) / 100 : opts.irpfRate;
  const total = clampSafe(subtotal + tax - irpf);
  return { lines, subtotal, taxBreakdown, tax, irpf, irpfRate, total };
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

/**
 * Referencia obligatoria a la factura corregida (art. 15.2 RD 1619/2012). Se usa
 * al crear la rectificativa y al reconstruir sus menciones tras editar el
 * borrador, para que no se pierda por el camino.
 */
function rectifyNote(inv: InvoiceRow): string | null {
  if (inv.invoice_type !== 'rectificativa' || !inv.rectifies_invoice_id) return null;
  const original = getInvoice(inv.rectifies_invoice_id);
  const ref = original?.number ?? inv.rectifies_invoice_id;
  return `Rectifica la factura ${ref}. Motivo: ${inv.rectify_reason ?? 'sin especificar'}`;
}

/** Menciones legales completas de una factura: referencia rectificativa + régimen. */
function invoiceMentions(inv: InvoiceRow, regime: VatRegime): string | null {
  const mention = legalMention(regime);
  const ref = rectifyNote(inv);
  if (!ref) return mention;
  return mention ? `${ref} · ${mention}` : ref;
}

/**
 * Comprueba los datos que una factura completa debe llevar por normativa antes de
 * numerarla (art. 6 RD 1619/2012): identificación fiscal del emisor y, salvo en la
 * simplificada, también del destinatario. Devuelve el motivo del bloqueo o null.
 * Solo lo aplican los caminos de emisión deliberados: el webhook de cobro nunca
 * debe quedarse sin marcar un pago ya realizado por un dato de configuración.
 */
function fiscalBlocker(inv: InvoiceRow, profile: BillingProfile, ws: WorkspaceRow | undefined): string | null {
  if (!profile.companyName.trim() || !profile.taxId.trim()) {
    return 'Falta la razón social o el NIF del emisor. Complétalos en Contabilidad → Datos de la empresa antes de emitir.';
  }
  if (inv.invoice_type !== 'simplificada') {
    const taxId = inv.client_tax_id ?? ws?.billing_tax_id ?? '';
    if (!taxId.trim()) {
      return 'Falta el NIF/CIF del cliente, obligatorio en una factura completa. Rellénalo en la ficha de la cuenta o emítela como simplificada.';
    }
  }
  return null;
}

/**
 * Devuelve el ancla de facturación al inicio del periodo cuando la factura que lo
 * cerraba desaparece (se borra el borrador) o se anula. Sin esto, ese periodo
 * quedaría facturado «según el ancla» pero sin ninguna factura viva: nadie lo
 * volvería a facturar.
 */
function rewindAnchorIfLast(inv: InvoiceRow): void {
  const ws = getWorkspace(inv.workspace_id);
  if (!ws || ws.last_billed_period_end !== inv.period_end) return;
  updateWorkspace(ws.id, { last_billed_period_end: inv.period_start });
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

/**
 * El plan CONTRATADO por la cuenta. A diferencia de `workspacePlan` (quota.ts),
 * que cae al plan por defecto como respaldo informativo de cuotas, aquí no hay
 * respaldo: una cuenta sin plan asignado no se factura ningún plan.
 */
function contractedPlan(ws: WorkspaceRow): PlanRow | undefined {
  return ws.plan_id ? getPlan(ws.plan_id) : undefined;
}

/**
 * ¿Toca cobrar en este ciclo una cuota ANUAL contratada en `sinceMs`?
 *
 * El ciclo de facturación es mensual, así que una cuota anual solo se devenga en
 * el ciclo que contiene su aniversario (o el del alta, la primera vez). Sin esto,
 * una cuota anual se cobraría íntegra los doce meses.
 */
function annualDueInCycle(sinceMs: number, cycle: { start: number; end: number }): boolean {
  if (sinceMs >= cycle.end) return false; // contratado después de este ciclo
  if (sinceMs >= cycle.start) return true; // alta dentro del ciclo: primera anualidad
  const since = new Date(sinceMs);
  for (const year of [new Date(cycle.start).getFullYear(), new Date(cycle.end).getFullYear()]) {
    const anniversary = new Date(year, since.getMonth(), since.getDate()).getTime();
    if (anniversary >= cycle.start && anniversary < cycle.end) return true;
  }
  return false;
}

/**
 * Corte de facturación más reciente YA VENCIDO, anclado al día de facturación.
 * Es el fin del último periodo cerrado.
 */
export function lastCutoff(billingDay: number, now = new Date()): number {
  let cut = new Date(now.getFullYear(), now.getMonth(), billingDay);
  if (cut.getTime() > now.getTime()) cut = new Date(now.getFullYear(), now.getMonth() - 1, billingDay);
  return cut.getTime();
}

/** Próximo corte de facturación (fin del periodo en curso). */
function nextCutoff(billingDay: number, now = new Date()): number {
  let cut = new Date(now.getFullYear(), now.getMonth(), billingDay);
  if (cut.getTime() <= now.getTime()) cut = new Date(now.getFullYear(), now.getMonth() + 1, billingDay);
  return cut.getTime();
}

/**
 * Inicio del periodo a facturar: el ANCLA persistente (fin de lo último
 * facturado). Derivarlo de `billing_day` como se hacía antes refacturaba el tramo
 * solapado al cambiar el día de facturación y perdía el ciclo entero si el
 * servidor estaba caído justo el día de cierre. Sin ancla (cuentas anteriores a
 * la columna) se cae al comportamiento previo.
 */
export function cycleAnchor(ws: WorkspaceRow, now = new Date()): number {
  if (ws.last_billed_period_end != null) return ws.last_billed_period_end;
  const cut = lastCutoff(ws.billing_day, now);
  const prev = new Date(cut);
  return new Date(prev.getFullYear(), prev.getMonth() - 1, ws.billing_day).getTime();
}

/** Periodo EN CURSO del workspace: desde lo último facturado hasta el próximo corte. */
function currentCycle(ws: WorkspaceRow, now = new Date()): { start: number; end: number } {
  return { start: cycleAnchor(ws, now), end: nextCutoff(ws.billing_day, now) };
}

/**
 * Duración del periodo mensual COMPLETO que cierra en `end`, anclado al día de
 * facturación. Es el denominador del prorrateo: una cuota mensual cubre un mes
 * entero, así que hay que escalarla contra el mes, nunca contra un ciclo ya
 * recortado (si no, un alta a mitad de mes pagaría la cuota completa por medio mes).
 */
function nominalPeriodMs(end: number, billingDay: number): number {
  const e = new Date(end);
  const inicio = new Date(e.getFullYear(), e.getMonth() - 1, billingDay).getTime();
  return Math.max(1, end - inicio);
}

/**
 * Fracción de MES realmente servida dentro del ciclo, para prorratear por días.
 * Devuelve 1 (sin prorrateo) cuando se cubre el mes entero, y 0 si no se sirvió nada.
 */
function prorationFactor(from: number, to: number, cycle: { start: number; end: number }, nominalMs: number): number {
  const desde = Math.max(from, cycle.start);
  const hasta = Math.min(to, cycle.end);
  if (hasta <= desde) return 0;
  const f = (hasta - desde) / nominalMs;
  // Tolerancia para no marcar como «prorrateado» un mes completo por unos ms.
  return f >= 0.9995 ? Math.min(1, f) : Math.round(f * 1e6) / 1e6;
}

/** Sufijo de la línea prorrateada, con los días servidos, para que el cliente lo entienda. */
function prorationLabel(factor: number, nominalMs: number): string {
  const total = Math.max(1, Math.round(nominalMs / 86_400_000));
  const dias = Math.max(1, Math.round((nominalMs * factor) / 86_400_000));
  return ` · prorrateado ${dias}/${total} días`;
}

/**
 * Emite una factura de forma atómica: congela los datos fiscales del emisor y del
 * destinatario, asigna el número de la serie que corresponda (por ejercicio) y la
 * bloquea (inmutable). Idempotente sobre lo ya congelado/numerado; sirve para los
 * tres caminos de emisión (edición de estado, enlace de Stripe y webhook de pago).
 */
function performEmission(inv: InvoiceRow, target: 'issued' | 'paid', extra: Record<string, unknown> = {}, opts: { requireFiscalData?: boolean } = {}): InvoiceRow {
  const profile = getBillingProfile();
  const ws = getWorkspace(inv.workspace_id);
  if (opts.requireFiscalData && !inv.issued_at) {
    const blocker = fiscalBlocker(inv, profile, ws);
    if (blocker) throw new BillingError(blocker);
  }
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

/** Datos del `checkout.session` de Stripe que necesita la conciliación del cobro. */
export interface StripeSessionRef {
  id: string;
  client_reference_id?: string | null;
  metadata?: { invoiceId?: string } | null;
  amount_total?: number | null;
  currency?: string | null;
}

export type StripePaymentOutcome =
  | { result: 'pagada'; invoice: InvoiceRow }
  | { result: 'ya_pagada'; invoice: InvoiceRow }
  | { result: 'sin_factura' }
  | { result: 'anulada'; invoice: InvoiceRow }
  | { result: 'importe_no_cuadra'; invoice: InvoiceRow; detail: string };

/**
 * Concilia un cobro de Stripe con su factura y la marca como pagada.
 * La usa el webhook (verificado) de `routes/webhooks.ts`. Idempotente.
 *
 * La factura se busca PRIMERO por el identificador propio que viaja en la sesión
 * (`metadata.invoiceId` / `client_reference_id`, puestos en `stripe.ts`) y solo
 * después por `stripe_session_id`: si se regeneró el enlace de cobro, la columna
 * apunta a la última sesión y un pago hecho con un enlace anterior quedaría
 * huérfano. Antes de dar por cobrada la factura se comprueba que el importe y la
 * moneda coinciden, y una factura ANULADA nunca resucita: es un estado terminal
 * (el dinero está en Stripe y hay que devolverlo a mano).
 */
export function markInvoicePaidByStripeSession(session: StripeSessionRef): StripePaymentOutcome {
  const byRef = session.metadata?.invoiceId ?? session.client_reference_id ?? null;
  const inv = (byRef ? getInvoice(byRef) : undefined) ?? getInvoiceByStripeSession(session.id);
  if (!inv) return { result: 'sin_factura' };
  if (inv.status === 'paid') return { result: 'ya_pagada', invoice: inv };
  if (inv.status === 'void') return { result: 'anulada', invoice: inv };
  if (session.amount_total != null) {
    const esperado = stripeAmount(inv.total_cents, inv.currency);
    const monedaOk = !session.currency || session.currency.toLowerCase() === inv.currency.toLowerCase();
    if (session.amount_total !== esperado || !monedaOk) {
      return {
        result: 'importe_no_cuadra',
        invoice: inv,
        detail: `cobrado ${session.amount_total} ${session.currency ?? '?'} · facturado ${esperado} ${inv.currency}`,
      };
    }
  }
  const paid = performEmission(inv, 'paid', { payment_method: 'stripe', stripe_session_id: session.id });
  reactivateWorkspaceIfCurrent(inv.workspace_id); // levanta el corte por impago si ya no debe nada
  return { result: 'pagada', invoice: paid };
}

/**
 * Emite (numera y bloquea) un borrador. La usa la facturación automática cuando el
 * operador activa la auto-emisión; idempotente (si ya está emitida, la devuelve).
 * Devuelve null si la factura no existe. Lanza `BillingError` si falta un dato
 * fiscal obligatorio (la auto-emisión lo audita y deja el borrador intacto).
 */
export function issueInvoice(invoiceId: string): InvoiceRow | null {
  const inv = getInvoice(invoiceId);
  if (!inv) return null;
  if (inv.status !== 'draft') return inv;
  return performEmission(inv, 'issued', {}, { requireFiscalData: true });
}

/**
 * Ensambla el borrador de factura del ciclo actual del workspace: plan +
 * suscripciones activas (recurrentes, por uso medido y por tramos) + cargos
 * puntuales pendientes. Queda en DRAFT (no emite). Lo usan la ruta manual
 * «Generar ciclo» y la facturación automática del scheduler.
 */
export function generateCycleDraft(ws: WorkspaceRow, cycle = currentCycle(ws)): InvoiceRow | null {
  const plan = contractedPlan(ws);
  const profile = getBillingProfile();
  const fromHour = Math.floor(cycle.start / HOUR_MS);
  const toHour = Math.floor(cycle.end / HOUR_MS);
  const usage = workspaceUsageRange(ws.id, fromHour, toHour);
  const currency = plan?.currency ?? profile.currency;
  // Una factura tiene UNA moneda: no se pueden sumar céntimos de divisas
  // distintas. Se recogen las divergencias para abortar con un error accionable
  // en vez de emitir un importe sin sentido.
  const otherCurrencies = new Set<string>();
  const checkCurrency = (c: string | null | undefined, concepto: string): boolean => {
    if (c && c.toUpperCase() !== currency.toUpperCase()) {
      otherCurrencies.add(`${concepto} (${c.toUpperCase()})`);
      return false;
    }
    return true;
  };

  const rawLines: LineDraft[] = [];
  const planDesde = ws.plan_since ?? ws.created_at;
  // Denominador del prorrateo: el mes completo que cierra este ciclo.
  const nominalMs = nominalPeriodMs(cycle.end, ws.billing_day);
  if (plan) {
    // Una cuota anual se devenga una vez al año, en el ciclo de su aniversario, y
    // se cobra entera (la anualidad cubre los doce meses siguientes). La mensual
    // se prorratea por los días efectivamente servidos dentro del ciclo.
    const anual = plan.interval === 'yearly';
    const factor = anual ? (annualDueInCycle(planDesde, cycle) ? 1 : 0) : prorationFactor(planDesde, cycle.end, cycle, nominalMs);
    if (factor > 0) {
      rawLines.push({
        label: `Plan ${plan.name} (${anual ? 'anual' : 'mensual'})${factor < 1 ? prorationLabel(factor, nominalMs) : ''}`.slice(0, 120),
        kind: 'plan',
        qty: 1,
        unitCents: Math.round(plan.price_cents * factor),
        taxRate: profile.vatRate,
        discountable: true,
      });
    }
  }
  // Un medidor se factura UNA sola vez por ciclo: dos suscripciones a productos
  // que comparten medidor (o dos suscripciones al mismo producto) cobrarían el
  // mismo consumo dos veces. Tarifa la suscripción más antigua, que es también la
  // que usa el guardarraíl de presupuesto del gateway (`meterUnitPrice`).
  const meteredDone = new Set<string>();
  // Incluye las bajas y pausas ocurridas DENTRO del ciclo: el servicio se prestó
  // hasta ese momento y se cobra prorrateado.
  for (const sub of listBillableSubscriptions(ws.id, cycle.start)) {
    const product = getProduct(sub.product_id);
    if (!product) continue;
    // Fin del servicio: el cambio de estado si dejó de estar activa, o el cierre
    // del ciclo. `status_changed_at` cae de nuevo en `cancelled_at` para las
    // suscripciones anteriores a esa columna.
    const hasta = sub.status === 'active' ? cycle.end : sub.status_changed_at ?? sub.cancelled_at ?? cycle.end;
    const negotiated = sub.unit_cents != null; // precio pactado por cliente: no se le suma el descuento
    const unitPrice = sub.unit_cents ?? product.price_cents;
    const rate = product.tax_exempt ? 0 : product.tax_rate;
    const irpf = product.irpf_rate || 0;
    // La moneda efectiva es la del precio que se aplica: la congelada en la
    // suscripción si hay precio pactado, la del producto si sigue la tarifa.
    if (!checkCurrency(negotiated ? sub.currency : product.currency, product.name)) continue;
    if ((product.billing_model === 'metered' || product.billing_model === 'tiered') && product.meter) {
      if (meteredDone.has(product.meter)) continue;
      meteredDone.add(product.meter);
      const raw = meterQuantity(product.meter, ws.id, fromHour, toHour, usage) * sub.qty;
      if (raw <= 0) continue;
      // Cantidad en unidades de precio (p. ej. 1M tokens): el precio es por unidad.
      const units = Math.round((product.unit_size > 1 ? raw / product.unit_size : raw) * 1e6) / 1e6;
      if (product.billing_model === 'tiered') {
        const amount = priceTiers(listTiers(product.id), units, product.tier_mode ?? 'graduated');
        // Los tramos no admiten override unit_cents: el precio es de tarifa → descontable.
        rawLines.push({ label: `${product.name} · ${units} ${product.unit || 'ud'}`, kind: 'subscription', qty: 1, unitCents: amount, taxRate: rate, irpfRate: irpf, discountable: true });
      } else {
        rawLines.push({ label: `${product.name} (${product.unit || 'uso'})`, kind: 'usage', qty: units, unitCents: unitPrice, taxRate: rate, irpfRate: irpf, discountable: !negotiated });
      }
    } else {
      // Cuota fija: anual una vez al año (entera), mensual prorrateada por los días
      // servidos entre el alta (o el inicio del ciclo) y la baja (o su cierre).
      const anual = sub.interval === 'yearly';
      const factor = anual ? (annualDueInCycle(sub.started_at, cycle) ? 1 : 0) : prorationFactor(sub.started_at, hasta, cycle, nominalMs);
      if (factor <= 0) continue;
      rawLines.push({
        label: `${product.name} (${anual ? 'anual' : 'mensual'})${factor < 1 ? prorationLabel(factor, nominalMs) : ''}`.slice(0, 120),
        kind: 'subscription',
        qty: sub.qty,
        unitCents: Math.round(unitPrice * factor),
        taxRate: rate,
        irpfRate: irpf,
        discountable: !negotiated,
      });
    }
  }
  const charges = listPendingCharges(ws.id, 'pending');
  for (const c of charges) {
    rawLines.push({ label: c.label, kind: c.kind === 'product' ? 'product' : 'custom', qty: c.qty, unitCents: c.unit_cents, taxRate: c.tax_rate, irpfRate: c.irpf_rate || 0, chargeId: c.id, discountable: true });
  }
  if (otherCurrencies.size > 0) {
    throw new BillingError(
      `No se puede facturar: hay conceptos en una moneda distinta de la de la cuenta (${currency}): ${[...otherCurrencies].join(', ')}. Unifica la moneda del catálogo y del plan.`,
    );
  }

  // Descuento comercial de la cuenta (override) o, si no lo tiene, del plan.
  const discountPct = ws.discount_pct ?? plan?.discount_pct ?? 0;
  applyAccountDiscount(rawLines, discountPct);

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
      irpf_rate: totals.irpfRate,
      irpf_cents: totals.irpf,
      total_cents: totals.total,
      lines: JSON.stringify(totals.lines),
      plan_name: plan?.name ?? null,
    });
    if (charges.length > 0) markChargesInvoiced(charges.map((c) => c.id), inv.id);
    // El ancla solo avanza con periodos CERRADOS. Una previsión del periodo en
    // curso no debe consumir el ciclo: si lo hiciera, el consumo desde la
    // previsión hasta el cierre no se facturaría nunca.
    if (cycle.end <= Date.now() && cycle.end > (ws.last_billed_period_end ?? 0)) {
      updateWorkspace(ws.id, { last_billed_period_end: cycle.end });
    }
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
    // Si hay un periodo ya CERRADO sin facturar, se factura ese (es el que toca y
    // el que avanza el ancla); si no, se genera la previsión del periodo en curso.
    // Sin esta distinción, una previsión que se solapa con el periodo cerrado
    // bloquearía después la facturación automática de ese ciclo.
    const anchor = cycleAnchor(ws);
    const cerrado = lastCutoff(ws.billing_day);
    const cycle = cerrado > anchor ? { start: anchor, end: cerrado } : currentCycle(ws);
    // Idempotencia: sin esto, dos pulsaciones seguidas crean dos facturas del
    // mismo periodo (con el plan y los cargos duplicados en la segunda).
    if (invoiceExistsForCycle(id, cycle.start)) {
      return reply.code(409).send({ error: 'Ya existe una factura para este periodo. Edítala o anúlala antes de generar otra.' });
    }
    let inv: InvoiceRow | null;
    try {
      inv = generateCycleDraft(ws, cycle);
    } catch (err) {
      if (err instanceof BillingError) return reply.code(400).send({ error: err.message });
      throw err;
    }
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
    const plan = contractedPlan(ws);
    const profile = getBillingProfile();
    const cycle = currentCycle(ws);
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
      irpf_rate: totals.irpfRate,
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
      // Recalcular las menciones SIN perder la referencia a la factura rectificada:
      // es obligatoria (art. 15.2 RD 1619/2012) y antes se borraba al editar.
      fields.legal_mentions = invoiceMentions(inv, regime);
      fields.irpf_rate = totals.irpfRate;
      fields.irpf_cents = totals.irpf;
      fields.total_cents = totals.total;
      if (body.currency) fields.currency = body.currency;
      if (body.operationDate !== undefined) fields.operation_date = body.operationDate;
      // Si el operador ha quitado la línea de un cargo puntual, ese cargo vuelve a
      // «pendiente» y entra en el ciclo siguiente. Antes se quedaba marcado como
      // facturado en una factura que ya no lo contenía: se perdía sin traza.
      if (body.lines !== undefined) {
        reopenChargesNotIn(id, totals.lines.map((l) => l.chargeId).filter((c): c is string => !!c));
      }
    }
    if (body.notes !== undefined) fields.notes = body.notes;
    if (body.paymentMethod !== undefined) fields.payment_method = body.paymentMethod;

    // Aplicar la transición de estado.
    if ((target === 'issued' || target === 'paid') && (inv.status === 'draft' || inv.status === 'issued')) {
      try {
        performEmission(inv, target, fields, { requireFiscalData: true });
      } catch (err) {
        if (err instanceof BillingError) return reply.code(409).send({ error: err.message });
        throw err;
      }
    } else {
      if (target !== inv.status) fields.status = target; // draft/issued → void
      updateInvoice(id, fields);
      // Al anular, los cargos puntuales enlazados vuelven a pendientes (no se
      // pierden) y el periodo vuelve a estar sin facturar.
      if (target === 'void' && inv.status !== 'void') {
        reopenChargesForInvoice(id);
        rewindAnchorIfLast(inv);
      }
    }
    // Cobro manual: levanta el corte por impago si la cuenta ya no debe nada.
    // Anular la factura también salda la deuda: sin esto, una factura vencida que
    // se anula (o se sustituye por una rectificativa) dejaba al cliente cortado.
    if ((target === 'paid' && inv.status !== 'paid') || (target === 'void' && inv.status !== 'void')) {
      reactivateWorkspaceIfCurrent(inv.workspace_id);
    }
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
    deleteInvoice(id); // devuelve además sus cargos puntuales a 'pending'
    rewindAnchorIfLast(inv);
    audit(req, 'invoice_deleted', { type: 'invoice', id });
    return { ok: true };
  });

  // Crea una factura RECTIFICATIVA (art. 15 RD 1619/2012) que corrige una factura
  // ya emitida (que es inmutable). Nace en borrador: revierte por completo la
  // original y añade —si se indican— las líneas correctas, de modo que el neto es
  // la corrección (rectificación por diferencias); sin líneas correctas es una
  // anulación total. Al emitirla toma número de la serie REC. La original se
  // conserva intacta y queda enlazada por `rectifies_invoice_id`.
  app.post('/api/invoices/:id/rectify', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const original = getInvoice(id);
    if (!original) return reply.code(404).send({ error: 'Factura no encontrada' });
    if (original.status !== 'issued' && original.status !== 'paid') {
      return reply.code(409).send({ error: 'Solo se rectifican facturas emitidas; un borrador se edita directamente.' });
    }
    if (original.invoice_type === 'rectificativa') {
      return reply.code(409).send({ error: 'Una rectificativa no se rectifica; corrija la factura original.' });
    }
    // Esta rectificativa revierte ÍNTEGRAMENTE la original. Emitir una segunda
    // sobre la misma factura abonaría dos veces la misma operación (base e IVA en
    // negativo por duplicado). Si de verdad hay que volver a corregir, primero se
    // anula la rectificativa anterior.
    const previas = listRectificationsOf(original.id);
    if (previas.length > 0) {
      const ref = previas[0].number ?? previas[0].id;
      return reply.code(409).send({
        error: `Esta factura ya está rectificada por ${ref}, que revierte su importe completo. Anula esa rectificativa antes de emitir otra, o corrígela por diferencias sobre ella.`,
      });
    }
    const body = z
      .object({
        reason: z.string().trim().min(3).max(500),
        // Líneas CORRECTAS (lo que la factura debería decir). Vacío = anulación total.
        lines: z.array(lineSchema).max(100).default([]),
        operationDate: z.coerce.number().int().nullable().optional(),
      })
      .parse(req.body);

    // Reversa de la original: se niega el IMPORTE ya calculado de cada línea, no
    // el precio unitario. Negar `unitCents` y volver a multiplicar por `qty`
    // reintroduce el redondeo con signo contrario y deja céntimos residuales que
    // impiden que una anulación total neteé exactamente cero.
    const reversal: z.infer<typeof lineSchema>[] = parseLines(original.lines).map((l) => ({
      label: `Anula: ${l.label}`.slice(0, 120),
      kind: l.kind,
      qty: 1,
      unitCents: -(l.amountCents ?? Math.round(l.qty * l.unitCents)),
      taxRate: l.taxRate,
      irpfRate: l.irpfRate,
    }));
    const regime = original.vat_regime as VatRegime;
    const totals = computeTotals([...reversal, ...body.lines], { defaultTaxRate: original.tax_rate, irpfRate: original.irpf_rate, regime });

    const refNote = `Rectifica la factura ${original.number ?? original.id}. Motivo: ${body.reason}`;
    const mention = legalMention(regime);
    const inv = createInvoice({
      workspace_id: original.workspace_id,
      period_start: original.period_start,
      period_end: original.period_end,
      operation_date: body.operationDate ?? original.operation_date ?? null,
      status: 'draft',
      invoice_type: 'rectificativa',
      rectifies_invoice_id: original.id,
      rectify_reason: body.reason,
      currency: original.currency,
      subtotal_cents: totals.subtotal,
      tax_cents: totals.tax,
      tax_rate: original.tax_rate,
      tax_breakdown: JSON.stringify(totals.taxBreakdown),
      vat_regime: regime,
      legal_mentions: mention ? `${refNote} · ${mention}` : refNote,
      irpf_rate: totals.irpfRate,
      irpf_cents: totals.irpf,
      total_cents: totals.total,
      lines: JSON.stringify(totals.lines),
      plan_name: original.plan_name,
    });
    audit(req, 'invoice_rectified', { type: 'invoice', id: inv.id, detail: `rectifica ${original.number ?? original.id}` });
    reply.code(201);
    return { invoice: publicInvoice(inv) };
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

    // Reutilizar el enlace vigente en vez de crear otra sesión: cada sesión nueva
    // sobrescribía `stripe_session_id` y el cobro hecho con el enlace anterior
    // quedaba sin factura a la que imputarse. (El webhook concilia además por el
    // id de factura, así que un enlace viejo tampoco se pierde.)
    if (inv.stripe_url && inv.stripe_session_id) {
      return { url: inv.stripe_url, invoice: publicInvoice(inv), reused: true };
    }

    // Emitir la factura antes de cobrar (alta antes del pago): asigna número/serie
    // y la congela. Si ya estaba emitida, no reasigna nada.
    let issued: InvoiceRow;
    try {
      issued = inv.status === 'draft' ? performEmission(inv, 'issued', {}, { requireFiscalData: true }) : inv;
    } catch (err) {
      if (err instanceof BillingError) return reply.code(409).send({ error: err.message });
      throw err;
    }
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
