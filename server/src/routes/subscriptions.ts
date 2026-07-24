import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertWorkspaceAccess, requireAdmin, requireAuth } from '../auth';
import { audit } from '../audit';
import {
  cancelPendingCharge,
  createPendingCharge,
  createSubscription,
  deleteSubscription,
  getPendingCharge,
  getProduct,
  getSubscription,
  getWorkspace,
  listPendingCharges,
  listProducts,
  listSubscriptions,
  updateSubscription,
} from '../db';
import { getBillingProfile } from '../company';
import { workspacePlan } from '../quota';
import { PendingChargeRow, ProductRow, SubscriptionRow, WorkspaceRow } from '../types';

const MONEY = 100_000_00;

/**
 * Moneda de facturación de la cuenta: la de su plan o, sin plan, la del emisor.
 * Una factura tiene una sola moneda, así que contratar un producto en otra divisa
 * sumaría céntimos de monedas distintas sin conversión.
 */
function workspaceCurrency(ws: WorkspaceRow): string {
  return (workspacePlan(ws)?.currency ?? getBillingProfile().currency).toUpperCase();
}

function publicSubscription(s: SubscriptionRow, product: ProductRow | undefined) {
  return {
    id: s.id,
    workspace_id: s.workspace_id,
    product_id: s.product_id,
    product_name: product?.name ?? 'Producto eliminado',
    category: product?.category ?? 'custom',
    billing_model: product?.billing_model ?? 'subscription',
    meter: product?.meter ?? null,
    unit: product?.unit ?? '',
    service_id: s.service_id,
    qty: s.qty,
    // Precio efectivo: el congelado si existe, o el vivo del catálogo.
    unit_cents: s.unit_cents ?? product?.price_cents ?? 0,
    frozen: s.unit_cents !== null,
    currency: s.currency,
    interval: s.interval,
    status: s.status,
    anchor_day: s.anchor_day,
    started_at: s.started_at,
    cancelled_at: s.cancelled_at,
  };
}

function publicCharge(c: PendingChargeRow) {
  return {
    id: c.id,
    label: c.label,
    kind: c.kind,
    qty: c.qty,
    unit_cents: c.unit_cents,
    tax_rate: c.tax_rate,
    irpf_rate: c.irpf_rate,
    status: c.status,
    created_at: c.created_at,
  };
}

export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Suscripciones + cargos pendientes de un workspace (los ve la cuenta; los gestiona el admin).
  app.get('/api/workspaces/:id/subscriptions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = getWorkspace(id);
    if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
    if (!assertWorkspaceAccess(req, reply, id)) return reply;
    const products = new Map(listProducts(true).map((p) => [p.id, p]));
    return {
      subscriptions: listSubscriptions(id).map((s) => publicSubscription(s, products.get(s.product_id))),
      charges: listPendingCharges(id, 'pending').map(publicCharge),
    };
  });

  app.post('/api/workspaces/:id/subscriptions', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = getWorkspace(id);
    if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
    const body = z
      .object({
        productId: z.string().trim().min(1),
        qty: z.coerce.number().min(0).max(1_000_000).default(1),
        serviceId: z.string().trim().nullable().optional(),
        // Precio a congelar; omitir para seguir el precio vivo del catálogo.
        unitCents: z.coerce.number().int().min(0).max(MONEY).nullable().optional(),
      })
      .parse(req.body);
    const product = getProduct(body.productId);
    if (!product || product.archived) return reply.code(400).send({ error: 'Producto del catálogo no válido' });
    // Un producto de pago único NO es una suscripción: como línea recurrente se
    // cobraría en cada ciclo. Se contrata como cargo puntual (`/charges`), que lo
    // incluye una sola vez en la próxima factura.
    if (product.billing_model === 'flat_one_off') {
      return reply.code(400).send({ error: 'Es un producto de pago único: añádelo como cargo puntual, no como suscripción (se cobraría cada ciclo).' });
    }
    const currency = workspaceCurrency(ws);
    if (product.currency.toUpperCase() !== currency) {
      return reply.code(400).send({ error: `El producto está en ${product.currency.toUpperCase()} y esta cuenta factura en ${currency}. Una factura no puede mezclar monedas.` });
    }
    const interval: SubscriptionRow['interval'] = product.interval === 'yearly' ? 'yearly' : 'monthly';
    const sub = createSubscription({
      workspace_id: id,
      product_id: product.id,
      service_id: body.serviceId ?? null,
      qty: body.qty,
      unit_cents: body.unitCents ?? null,
      currency: product.currency,
      interval,
      status: 'active',
      anchor_day: ws.billing_day,
      started_at: Date.now(),
      cancelled_at: null,
    });
    audit(req, 'subscription_created', { type: 'workspace', id, detail: product.name });
    reply.code(201);
    return { subscription: publicSubscription(sub, product) };
  });

  app.patch('/api/subscriptions/:subId', { preHandler: requireAdmin }, async (req, reply) => {
    const { subId } = req.params as { subId: string };
    const sub = getSubscription(subId);
    if (!sub) return reply.code(404).send({ error: 'Suscripción no encontrada' });
    const body = z
      .object({
        qty: z.coerce.number().min(0).max(1_000_000).optional(),
        unitCents: z.coerce.number().int().min(0).max(MONEY).nullable().optional(),
        status: z.enum(['active', 'paused', 'cancelled']).optional(),
      })
      .parse(req.body);
    const fields: Record<string, unknown> = {};
    if (body.qty !== undefined) fields.qty = body.qty;
    if (body.unitCents !== undefined) fields.unit_cents = body.unitCents;
    if (body.status !== undefined) {
      fields.status = body.status;
      if (body.status === 'cancelled') fields.cancelled_at = Date.now();
    }
    updateSubscription(subId, fields);
    audit(req, 'subscription_updated', { type: 'workspace', id: sub.workspace_id, detail: body.status ?? 'edición' });
    const product = getProduct(sub.product_id);
    return { subscription: publicSubscription(getSubscription(subId)!, product) };
  });

  app.delete('/api/subscriptions/:subId', { preHandler: requireAdmin }, async (req, reply) => {
    const { subId } = req.params as { subId: string };
    const sub = getSubscription(subId);
    if (!sub) return reply.code(404).send({ error: 'Suscripción no encontrada' });
    deleteSubscription(subId);
    audit(req, 'subscription_deleted', { type: 'workspace', id: sub.workspace_id });
    return { ok: true };
  });

  // Cargo puntual: se acumula para la próxima factura del ciclo.
  app.post('/api/workspaces/:id/charges', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = getWorkspace(id);
    if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
    const body = z
      .object({
        // Producto del catálogo (p. ej. de pago único): autocompleta concepto, precio e impuestos.
        productId: z.string().trim().nullable().optional(),
        label: z.string().trim().min(1).max(120).optional(),
        qty: z.coerce.number().min(0).max(1_000_000).default(1),
        unitCents: z.coerce.number().int().min(-MONEY).max(MONEY).optional(),
        taxRate: z.coerce.number().min(0).max(100).optional(),
        irpfRate: z.coerce.number().min(0).max(100).optional(),
      })
      .parse(req.body);
    const product = body.productId ? getProduct(body.productId) : undefined;
    if (body.productId && (!product || product.archived)) {
      return reply.code(400).send({ error: 'Producto del catálogo no válido' });
    }
    const currency = workspaceCurrency(ws);
    if (product && product.currency.toUpperCase() !== currency) {
      return reply.code(400).send({ error: `El producto está en ${product.currency.toUpperCase()} y esta cuenta factura en ${currency}. Una factura no puede mezclar monedas.` });
    }
    // Con producto: concepto, precio e IVA salen del catálogo (editables). Sin
    // producto: cargo libre, que exige un concepto. El precio pactado por línea
    // (unitCents) siempre prevalece sobre el del catálogo.
    const label = (body.label ?? product?.name ?? '').trim();
    if (!label) return reply.code(400).send({ error: 'Indica un concepto para el cargo.' });
    const defaultRate = product ? (product.tax_exempt ? 0 : product.tax_rate) : 21;
    const charge = createPendingCharge({
      workspace_id: id,
      product_id: product?.id ?? null,
      label,
      kind: product ? 'product' : 'custom',
      qty: body.qty,
      unit_cents: body.unitCents ?? product?.price_cents ?? 0,
      tax_rate: body.taxRate ?? defaultRate,
      irpf_rate: body.irpfRate ?? product?.irpf_rate ?? 0,
    });
    audit(req, 'charge_added', { type: 'workspace', id, detail: label });
    reply.code(201);
    return { charge: publicCharge(charge) };
  });

  app.delete('/api/charges/:chargeId', { preHandler: requireAdmin }, async (req, reply) => {
    const { chargeId } = req.params as { chargeId: string };
    const charge = getPendingCharge(chargeId);
    if (!charge) return reply.code(404).send({ error: 'Cargo no encontrado' });
    cancelPendingCharge(chargeId);
    audit(req, 'charge_cancelled', { type: 'workspace', id: charge.workspace_id });
    return { ok: true };
  });
}
