import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../auth';
import { audit } from '../audit';
import { createProduct, deleteProduct, getProduct, listProducts, listTiers, productInUse, replaceTiers, updateProduct } from '../db';
import { sanitizeModules } from '../modules';
import { PriceTierRow, ProductRow } from '../types';

const MONEY = 100_000_00;

const tierSchema = z.object({
  upTo: z.coerce.number().int().positive().nullable(),
  unitCents: z.coerce.number().int().min(0).max(MONEY),
  flatCents: z.coerce.number().int().min(0).max(MONEY).default(0),
});

/**
 * Los tramos se tarifan en el orden en que llegan (`pricing.ts` los ordena por
 * `sort`, que es ese mismo orden): con topes no ascendentes o con más de un tramo
 * «sin tope» el reparto por tramos sale mal y nadie lo detectaría hasta ver la
 * factura. Se valida al guardarlos.
 */
function tiersError(tiers: { upTo: number | null; unitCents: number; flatCents: number }[]): string | null {
  let prev = 0;
  for (let i = 0; i < tiers.length; i++) {
    const { upTo } = tiers[i];
    if (upTo === null) {
      if (i !== tiers.length - 1) return 'Solo el ÚLTIMO tramo puede quedar sin tope; los anteriores deben tener un límite.';
      continue;
    }
    if (upTo <= prev) return `Los topes de los tramos deben ser crecientes: ${upTo} no supera a ${prev}.`;
    prev = upTo;
  }
  return null;
}

const productSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.enum(['web', 'ia', 'app', 'hosting', 'bbdd', 'dominio', 'soporte', 'custom']).default('custom'),
  billingModel: z.enum(['flat_one_off', 'subscription', 'metered', 'tiered']).default('flat_one_off'),
  priceCents: z.coerce.number().int().min(0).max(MONEY).default(0),
  currency: z.string().trim().length(3).toUpperCase().default('EUR'),
  interval: z.enum(['monthly', 'yearly', 'one_off', 'metered']).default('one_off'),
  unit: z.string().trim().max(40).default(''),
  unitSize: z.coerce.number().int().min(1).max(1_000_000_000).default(1),
  meter: z.enum(['cpu_core_hour', 'mem_gb_hour', 'ai_tokens_in', 'ai_tokens_cache_in', 'ai_tokens_out', 'ai_requests', 'ai_bytes', 'unit']).nullable().default(null),
  tierMode: z.enum(['graduated', 'volume']).nullable().default(null),
  taxRate: z.coerce.number().min(0).max(100).default(21),
  irpfRate: z.coerce.number().min(0).max(100).default(0),
  taxExempt: z.boolean().default(false),
  modules: z.array(z.string()).max(50).default([]),
  description: z.string().trim().max(1000).nullable().default(null),
  active: z.boolean().default(true),
  tiers: z.array(tierSchema).max(20).optional(),
});

function publicProduct(p: ProductRow, tiers: PriceTierRow[]) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    category: p.category,
    billing_model: p.billing_model,
    price_cents: p.price_cents,
    currency: p.currency,
    interval: p.interval,
    unit: p.unit,
    unit_size: p.unit_size,
    meter: p.meter,
    tier_mode: p.tier_mode,
    tax_rate: p.tax_rate,
    irpf_rate: p.irpf_rate,
    tax_exempt: p.tax_exempt,
    modules: JSON.parse(p.modules) as string[],
    description: p.description,
    active: p.active,
    archived: p.archived,
    in_use: productInUse(p.id),
    tiers: tiers.map((t) => ({ up_to: t.up_to, unit_cents: t.unit_cents, flat_cents: t.flat_cents })),
    created_at: p.created_at,
  };
}

/** Convierte los campos del body al formato de columnas de la fila. */
function toRowFields(body: Partial<z.infer<typeof productSchema>>): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (body.name !== undefined) f.name = body.name;
  if (body.category !== undefined) f.category = body.category;
  if (body.billingModel !== undefined) f.billing_model = body.billingModel;
  if (body.priceCents !== undefined) f.price_cents = body.priceCents;
  if (body.currency !== undefined) f.currency = body.currency;
  if (body.interval !== undefined) f.interval = body.interval;
  if (body.unit !== undefined) f.unit = body.unit;
  if (body.unitSize !== undefined) f.unit_size = body.unitSize;
  if (body.meter !== undefined) f.meter = body.meter;
  if (body.tierMode !== undefined) f.tier_mode = body.tierMode;
  if (body.taxRate !== undefined) f.tax_rate = body.taxRate;
  if (body.irpfRate !== undefined) f.irpf_rate = body.irpfRate;
  if (body.taxExempt !== undefined) f.tax_exempt = body.taxExempt ? 1 : 0;
  if (body.modules !== undefined) f.modules = JSON.stringify(sanitizeModules(body.modules));
  if (body.description !== undefined) f.description = body.description;
  if (body.active !== undefined) f.active = body.active ? 1 : 0;
  return f;
}

export async function productRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // El catálogo lo consultan admin (gestión) y propietarios (para ver qué contratan).
  app.get('/api/products', async () => ({
    products: listProducts(true).map((p) => publicProduct(p, listTiers(p.id))),
  }));

  app.post('/api/products', { preHandler: requireAdmin }, async (req, reply) => {
    const body = productSchema.parse(req.body);
    const tiersBad = body.tiers ? tiersError(body.tiers) : null;
    if (tiersBad) return reply.code(400).send({ error: tiersBad });
    const p = createProduct({
      name: body.name,
      category: body.category,
      billing_model: body.billingModel,
      price_cents: body.priceCents,
      currency: body.currency,
      interval: body.interval,
      unit: body.unit,
      unit_size: body.unitSize,
      meter: body.meter,
      tier_mode: body.tierMode,
      tax_rate: body.taxRate,
      irpf_rate: body.irpfRate,
      tax_exempt: body.taxExempt ? 1 : 0,
      modules: JSON.stringify(sanitizeModules(body.modules)),
      description: body.description,
      active: body.active ? 1 : 0,
    });
    if (body.tiers) replaceTiers(p.id, body.tiers);
    audit(req, 'product_created', { type: 'product', id: p.id, detail: p.name });
    reply.code(201);
    return { product: publicProduct(p, listTiers(p.id)) };
  });

  app.patch('/api/products/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getProduct(id);
    if (!p) return reply.code(404).send({ error: 'Producto no encontrado' });
    const body = productSchema.partial().parse(req.body);
    const tiersBad = body.tiers ? tiersError(body.tiers) : null;
    if (tiersBad) return reply.code(400).send({ error: tiersBad });
    // La moneda de un producto ya contratado no puede cambiar: las suscripciones
    // vivas la tienen congelada y la factura acabaría mezclando divisas.
    if (body.currency && body.currency.toUpperCase() !== p.currency.toUpperCase() && productInUse(id)) {
      return reply.code(409).send({ error: 'El producto está contratado: no se puede cambiar su moneda. Archívalo y crea uno nuevo.' });
    }
    updateProduct(id, toRowFields(body));
    if (body.tiers !== undefined) replaceTiers(id, body.tiers);
    audit(req, 'product_updated', { type: 'product', id });
    const updated = getProduct(id)!;
    return { product: publicProduct(updated, listTiers(id)) };
  });

  app.delete('/api/products/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getProduct(id);
    if (!p) return reply.code(404).send({ error: 'Producto no encontrado' });
    // Si está contratado, se archiva (conserva el histórico); si no, se borra.
    if (productInUse(id)) {
      updateProduct(id, { archived: 1, active: 0 });
      audit(req, 'product_archived', { type: 'product', id, detail: p.name });
      return { ok: true, archived: true };
    }
    deleteProduct(id);
    audit(req, 'product_deleted', { type: 'product', id, detail: p.name });
    return { ok: true, archived: false };
  });
}
