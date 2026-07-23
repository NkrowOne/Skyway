import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertWorkspaceAccess, requireAdmin, requireAuth } from '../auth';
import { audit } from '../audit';
import {
  createInvoice,
  deleteInvoice,
  getInvoice,
  getWorkspace,
  listInvoices,
  updateInvoice,
  workspaceUsageRange,
} from '../db';
import { workspacePlan } from '../quota';
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

/** Normaliza las líneas y calcula importes y total (el importe se recomputa en servidor). */
function computeLines(rawLines: z.infer<typeof lineSchema>[]): { lines: InvoiceLine[]; total: number } {
  const lines: InvoiceLine[] = rawLines.map((l) => ({
    label: l.label,
    kind: l.kind,
    qty: l.qty,
    unitCents: l.unitCents,
    amountCents: clampSafe(Math.round(l.qty * l.unitCents)),
  }));
  const total = clampSafe(lines.reduce((sum, l) => sum + l.amountCents, 0));
  return { lines, total };
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
    period_start: inv.period_start,
    period_end: inv.period_end,
    status: inv.status,
    currency: inv.currency,
    subtotal_cents: inv.subtotal_cents,
    total_cents: inv.total_cents,
    lines: parseLines(inv.lines),
    plan_name: inv.plan_name,
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

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Facturas del workspace: admin o propietario (este último, solo lectura).
  app.get('/api/workspaces/:id/invoices', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = getWorkspace(id);
    if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
    if (!assertWorkspaceAccess(req, reply, id)) return reply;
    return { invoices: listInvoices(id).map(publicInvoice) };
  });

  // Genera una factura borrador del ciclo actual: precio del plan (usos incluidos)
  // + resumen de uso como líneas a coste 0, que el admin puede tarificar.
  app.post('/api/workspaces/:id/invoices/generate', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = getWorkspace(id);
    if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
    const plan = workspacePlan(ws);
    const cycle = currentCycle(ws.billing_day);
    const usage = workspaceUsageRange(id, Math.floor(cycle.start / HOUR_MS), Math.floor(cycle.end / HOUR_MS));
    const currency = plan?.currency ?? 'EUR';

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

    const { lines, total } = computeLines(rawLines);
    const inv = createInvoice({
      workspace_id: id,
      period_start: cycle.start,
      period_end: cycle.end,
      status: 'draft',
      currency,
      subtotal_cents: total,
      total_cents: total,
      lines: JSON.stringify(lines),
      plan_name: plan?.name ?? null,
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
    const cycle = currentCycle(ws.billing_day);
    const body = z
      .object({
        lines: z.array(lineSchema).max(100).default([]),
        periodStart: z.coerce.number().int().optional(),
        periodEnd: z.coerce.number().int().optional(),
        currency: z.string().trim().length(3).toUpperCase().optional(),
        notes: z.string().trim().max(2000).nullable().optional(),
      })
      .parse(req.body);
    const { lines, total } = computeLines(body.lines);
    const inv = createInvoice({
      workspace_id: id,
      period_start: body.periodStart ?? cycle.start,
      period_end: body.periodEnd ?? cycle.end,
      status: 'draft',
      currency: body.currency ?? plan?.currency ?? 'EUR',
      subtotal_cents: total,
      total_cents: total,
      lines: JSON.stringify(lines),
      plan_name: plan?.name ?? null,
      issued_at: null,
      paid_at: null,
      notes: body.notes ?? null,
    });
    audit(req, 'invoice_created', { type: 'invoice', id: inv.id, detail: ws.name });
    reply.code(201);
    return { invoice: publicInvoice(inv) };
  });

  // Edita una factura: líneas, estado (emitir/pagar/anular) y notas. Solo admin.
  app.patch('/api/invoices/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inv = getInvoice(id);
    if (!inv) return reply.code(404).send({ error: 'Factura no encontrada' });
    const body = z
      .object({
        lines: z.array(lineSchema).max(100).optional(),
        status: z.enum(['draft', 'issued', 'paid', 'void']).optional(),
        notes: z.string().trim().max(2000).nullable().optional(),
        currency: z.string().trim().length(3).toUpperCase().optional(),
      })
      .parse(req.body);

    const fields: Record<string, unknown> = {};
    if (body.lines) {
      const { lines, total } = computeLines(body.lines);
      fields.lines = JSON.stringify(lines);
      fields.subtotal_cents = total;
      fields.total_cents = total;
    }
    if (body.currency) fields.currency = body.currency;
    if (body.notes !== undefined) fields.notes = body.notes;
    if (body.status && body.status !== inv.status) {
      fields.status = body.status;
      // Marcas de tiempo al pasar de estado (se conservan si ya existían).
      if (body.status === 'issued' && !inv.issued_at) fields.issued_at = Date.now();
      if (body.status === 'paid') {
        if (!inv.issued_at) fields.issued_at = Date.now();
        fields.paid_at = Date.now();
      }
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
}
