import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth';
import { audit } from '../audit';
import {
  countWorkspacesOnPlan,
  createPlan,
  deletePlan,
  getPlan,
  listPlans,
  updatePlan,
} from '../db';
import { sanitizeModules } from '../modules';
import { PlanRow } from '../types';

const modulesSchema = z.array(z.string()).max(50).transform((arr) => sanitizeModules(arr));

const planSchema = z.object({
  name: z.string().trim().min(1, 'Nombre requerido').max(60),
  price_cents: z.coerce.number().int().min(0).max(100_000_00).default(0),
  currency: z.string().trim().length(3).toUpperCase().default('EUR'),
  interval: z.enum(['monthly', 'yearly']).default('monthly'),
  cpu_cores: z.coerce.number().min(0.1).max(256).default(1),
  memory_mb: z.coerce.number().int().min(128).max(1024 * 1024).default(1024),
  disk_mb: z.coerce.number().int().min(256).max(1024 * 1024 * 4).default(10240),
  max_projects: z.coerce.number().int().min(1).max(1000).default(3),
  max_services: z.coerce.number().int().min(1).max(5000).default(10),
  max_members: z.coerce.number().int().min(1).max(1000).default(3),
  modules: modulesSchema.default([]),
  is_default: z.boolean().default(false),
  archived: z.boolean().default(false),
  discount_pct: z.coerce.number().min(0).max(100).default(0),
});

function publicPlan(p: PlanRow) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    price_cents: p.price_cents,
    currency: p.currency,
    interval: p.interval,
    cpu_cores: p.cpu_cores,
    memory_mb: p.memory_mb,
    disk_mb: p.disk_mb,
    max_projects: p.max_projects,
    max_services: p.max_services,
    max_members: p.max_members,
    modules: sanitizeModules(safeParse(p.modules)),
    is_default: !!p.is_default,
    archived: !!p.archived,
    discount_pct: p.discount_pct,
    created_at: p.created_at,
    inUse: countWorkspacesOnPlan(p.id),
  };
}

function safeParse(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Planes de facturación: catálogo de usos incluidos. Solo administradores. */
export async function planRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  app.get('/api/plans', async () => ({ plans: listPlans().map(publicPlan) }));

  app.post('/api/plans', async (req, reply) => {
    const body = planSchema.parse(req.body);
    const plan = createPlan(body.name, {
      price_cents: body.price_cents,
      currency: body.currency,
      interval: body.interval,
      cpu_cores: body.cpu_cores,
      memory_mb: body.memory_mb,
      disk_mb: body.disk_mb,
      max_projects: body.max_projects,
      max_services: body.max_services,
      max_members: body.max_members,
      modules: JSON.stringify(body.modules),
      is_default: body.is_default ? 1 : 0,
      archived: body.archived ? 1 : 0,
      discount_pct: body.discount_pct,
    });
    audit(req, 'plan_created', { type: 'plan', id: plan.id, detail: plan.name });
    reply.code(201);
    return { plan: publicPlan(plan) };
  });

  app.patch('/api/plans/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const plan = getPlan(id);
    if (!plan) return reply.code(404).send({ error: 'Plan no encontrado' });
    const body = planSchema.partial().parse(req.body);
    const fields: Record<string, unknown> = {};
    if (body.name !== undefined) fields.name = body.name;
    if (body.price_cents !== undefined) fields.price_cents = body.price_cents;
    if (body.currency !== undefined) fields.currency = body.currency;
    if (body.interval !== undefined) fields.interval = body.interval;
    if (body.cpu_cores !== undefined) fields.cpu_cores = body.cpu_cores;
    if (body.memory_mb !== undefined) fields.memory_mb = body.memory_mb;
    if (body.disk_mb !== undefined) fields.disk_mb = body.disk_mb;
    if (body.max_projects !== undefined) fields.max_projects = body.max_projects;
    if (body.max_services !== undefined) fields.max_services = body.max_services;
    if (body.max_members !== undefined) fields.max_members = body.max_members;
    if (body.modules !== undefined) fields.modules = JSON.stringify(body.modules);
    if (body.is_default !== undefined) fields.is_default = body.is_default ? 1 : 0;
    if (body.archived !== undefined) fields.archived = body.archived ? 1 : 0;
    if (body.discount_pct !== undefined) fields.discount_pct = body.discount_pct;
    updatePlan(id, fields);
    audit(req, 'plan_updated', { type: 'plan', id, detail: getPlan(id)!.name });
    return { plan: publicPlan(getPlan(id)!) };
  });

  app.delete('/api/plans/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const plan = getPlan(id);
    if (!plan) return reply.code(404).send({ error: 'Plan no encontrado' });
    // Borrar un plan en uso desengancharía sus workspaces (plan_id → NULL) y
    // podría cambiar sus módulos concedidos: se bloquea. Archívalo o reasigna
    // sus workspaces primero.
    const inUse = countWorkspacesOnPlan(id);
    if (inUse > 0) {
      return reply.code(409).send({
        error: `No se puede borrar: ${inUse} workspace${inUse === 1 ? '' : 's'} usa${inUse === 1 ? '' : 'n'} este plan. Archívalo o reasigna esos workspaces a otro plan primero.`,
      });
    }
    deletePlan(id);
    audit(req, 'plan_deleted', { type: 'plan', id, detail: plan.name });
    return { ok: true };
  });
}
