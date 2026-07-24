import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertWorkspaceAccess, currentUser, requireAdmin, requireAuth, requireSession } from '../auth';
import { audit } from '../audit';
import {
  countWorkspaceMembers,
  createUser,
  createWorkspaceRow,
  deleteUser,
  deleteWorkspace,
  getPlan,
  getProject,
  getUser,
  getUserByEmail,
  getWorkspace,
  listServices,
  listUserProjectIds,
  listWorkspaceAlerts,
  listWorkspaceProjects,
  listWorkspaceUsers,
  listWorkspaces,
  setProjectWorkspace,
  setUserProjects,
  transaction,
  updateUserPassword,
  updateUserRole,
  updateWorkspace,
  workspaceHasInvoices,
  workspaceUsageByProject,
  workspaceUsageRange,
  workspaceUsageSeries,
} from '../db';
import { grantedModules, workspaceQuotaSummary, workspacePlan } from '../quota';
import { MODULES, sanitizeModules } from '../modules';
import { UserRow, WorkspaceRow } from '../types';
import { hashPassword } from '../util';

const HOUR_MS = 3_600_000;

// --- esquemas ---
const nullableInt = (min: number, max: number) => z.coerce.number().int().min(min).max(max).nullable();

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1, 'Nombre requerido').max(80),
  planId: z.string().trim().nullable().optional(),
  billingEmail: z.string().email().nullable().optional(),
  billingDay: z.coerce.number().int().min(1).max(28).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const patchWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  planId: z.string().trim().nullable().optional(),
  cpuCores: z.coerce.number().min(0.1).max(256).nullable().optional(),
  memoryMb: nullableInt(128, 1024 * 1024).optional(),
  diskMb: nullableInt(256, 1024 * 1024 * 4).optional(),
  maxProjects: nullableInt(1, 1000).optional(),
  maxServices: nullableInt(1, 5000).optional(),
  maxMembers: nullableInt(1, 1000).optional(),
  modules: z.array(z.string()).max(50).nullable().optional(), // concesión del admin (null = hereda del plan)
  status: z.enum(['active', 'suspended']).optional(),
  billingEmail: z.string().email().nullable().optional(),
  // Datos fiscales del cliente (destinatario de la factura).
  billingTaxId: z.string().trim().max(60).nullable().optional(),
  billingAddress: z.string().trim().max(400).nullable().optional(),
  billingDay: z.coerce.number().int().min(1).max(28).optional(),
  // Descuento comercial de la cuenta (%); null = hereda el del plan.
  discountPct: z.coerce.number().min(0).max(100).nullable().optional(),
  // Exime a la cuenta del corte automático por impago (clientes de trato especial).
  dunningExempt: z.boolean().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const memberSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
  role: z.enum(['owner', 'member']).default('member'),
  projectIds: z.array(z.string()).default([]),
});

const patchMemberSchema = z.object({
  role: z.enum(['owner', 'member']).optional(),
  projectIds: z.array(z.string()).optional(),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').optional(),
});

// --- vistas ---
function publicWorkspace(ws: WorkspaceRow) {
  const summary = workspaceQuotaSummary(ws);
  return {
    id: ws.id,
    name: ws.name,
    slug: ws.slug,
    status: ws.status,
    plan_id: ws.plan_id,
    billing_email: ws.billing_email,
    billing_tax_id: ws.billing_tax_id,
    billing_address: ws.billing_address,
    billing_day: ws.billing_day,
    discount_pct: ws.discount_pct,
    notes: ws.notes,
    // Estado de morosidad (corte por impago).
    ai_suspended: ws.ai_suspended ?? 0,
    dunning_stage: ws.dunning_stage ?? 0,
    dunning_exempt: ws.dunning_exempt ?? 0,
    created_at: ws.created_at,
    ...summary,
  };
}

function publicMember(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    created_at: u.created_at,
    projectIds: u.role === 'member' ? listUserProjectIds(u.id) : [],
  };
}

/** Todos los proyectos de un workspace deben pertenecer a él (para asignar a un miembro). */
function projectsInWorkspace(projectIds: string[], workspaceId: string): { ok: boolean; bad?: string } {
  for (const pid of projectIds) {
    const project = getProject(pid);
    if (!project || project.workspace_id !== workspaceId) return { ok: false, bad: pid };
  }
  return { ok: true };
}

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Catálogo de módulos (para etiquetas de la UI de admin y propietario).
  app.get('/api/modules', async () => ({ modules: MODULES }));

  // Lista: admin ve todos; propietario ve el suyo; miembro no gestiona workspaces.
  app.get('/api/workspaces', async (req) => {
    const user = currentUser(req)!;
    if (user.role === 'admin') return { workspaces: listWorkspaces().map(publicWorkspace) };
    if (user.role === 'owner' && user.workspace_id) {
      const ws = getWorkspace(user.workspace_id);
      return { workspaces: ws ? [publicWorkspace(ws)] : [] };
    }
    return { workspaces: [] };
  });

  app.post('/api/workspaces', { preHandler: requireAdmin }, async (req, reply) => {
    const body = createWorkspaceSchema.parse(req.body);
    if (body.planId && !getPlan(body.planId)) return reply.code(400).send({ error: 'Plan desconocido' });
    const ws = createWorkspaceRow(body.name, {
      // Cadena vacía = sin plan (no se escribe '' en la clave foránea).
      plan_id: body.planId || null,
      billing_email: body.billingEmail ?? null,
      billing_day: body.billingDay,
      notes: body.notes ?? null,
    });
    audit(req, 'workspace_created', { type: 'workspace', id: ws.id, detail: ws.name });
    reply.code(201);
    return { workspace: publicWorkspace(ws) };
  });

  app.get('/api/workspaces/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = getWorkspace(id);
    if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
    if (!assertWorkspaceAccess(req, reply, id)) return reply;
    const projects = listWorkspaceProjects(id).map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      serviceCount: listServices(p.id).length,
      created_at: p.created_at,
    }));
    const members = listWorkspaceUsers(id).map(publicMember);
    return { workspace: publicWorkspace(ws), projects, members };
  });

  // Live resize + gestión del workspace (cuotas, plan, concesión de módulos, estado, facturación). Solo admin.
  app.patch('/api/workspaces/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = getWorkspace(id);
    if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
    const body = patchWorkspaceSchema.parse(req.body);
    if (body.planId && !getPlan(body.planId)) return reply.code(400).send({ error: 'Plan desconocido' });

    const fields: Record<string, unknown> = {};
    if (body.name !== undefined) fields.name = body.name;
    if (body.planId !== undefined) {
      fields.plan_id = body.planId || null; // '' → sin plan (no rompe la FK)
      // Cambiar de plan reancla el aniversario de la cuota anual: si no, un plan
      // anual nuevo heredaría la fecha del anterior y podría cobrarse dos veces
      // en el mismo año natural.
      if ((body.planId || null) !== ws.plan_id) fields.plan_since = body.planId ? Date.now() : null;
    }
    if (body.cpuCores !== undefined) fields.cpu_cores = body.cpuCores;
    if (body.memoryMb !== undefined) fields.memory_mb = body.memoryMb;
    if (body.diskMb !== undefined) fields.disk_mb = body.diskMb;
    if (body.maxProjects !== undefined) fields.max_projects = body.maxProjects;
    if (body.maxServices !== undefined) fields.max_services = body.maxServices;
    if (body.maxMembers !== undefined) fields.max_members = body.maxMembers;
    if (body.modules !== undefined) fields.modules_override = body.modules === null ? null : JSON.stringify(sanitizeModules(body.modules));
    if (body.status !== undefined) fields.status = body.status;
    if (body.billingEmail !== undefined) fields.billing_email = body.billingEmail;
    if (body.billingTaxId !== undefined) fields.billing_tax_id = body.billingTaxId;
    if (body.billingAddress !== undefined) fields.billing_address = body.billingAddress;
    if (body.billingDay !== undefined) fields.billing_day = body.billingDay;
    if (body.discountPct !== undefined) fields.discount_pct = body.discountPct;
    if (body.dunningExempt !== undefined) fields.dunning_exempt = body.dunningExempt ? 1 : 0;
    if (body.notes !== undefined) fields.notes = body.notes;

    updateWorkspace(id, fields);
    if (body.status === 'suspended') {
      audit(req, 'workspace_suspended', { type: 'workspace', id, detail: ws.name });
    } else {
      audit(req, 'workspace_updated', { type: 'workspace', id, detail: ws.name });
    }
    return { workspace: publicWorkspace(getWorkspace(id)!) };
  });

  // Acotar módulos: el propietario desactiva módulos bajo su cuenta (subconjunto
  // de lo concedido). El admin también puede hacerlo en su nombre. NO amplía nada.
  app.patch('/api/workspaces/:id/modules', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = getWorkspace(id);
    if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
    if (!assertWorkspaceAccess(req, reply, id)) return reply;
    const body = z.object({ disabled: z.array(z.string()).max(50) }).parse(req.body);
    // Solo se pueden acotar módulos que estén concedidos: intersección con la concesión.
    const granted = new Set(grantedModules(ws, workspacePlan(ws)));
    const disabled = sanitizeModules(body.disabled).filter((k) => granted.has(k));
    updateWorkspace(id, { owner_disabled_modules: JSON.stringify(disabled) });
    audit(req, 'workspace_modules_limited', { type: 'workspace', id, detail: `${disabled.length} módulos acotados` });
    return { workspace: publicWorkspace(getWorkspace(id)!) };
  });

  app.delete('/api/workspaces/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = getWorkspace(id);
    if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
    // Conservación fiscal: una cuenta con facturas emitidas NO se borra (la BD
    // las eliminaría en cascada). Debe suspenderse para preservar el histórico.
    if (workspaceHasInvoices(id, true)) {
      return reply.code(409).send({ error: 'La cuenta tiene facturas emitidas y no puede borrarse (conservación fiscal). Suspéndela en su lugar.' });
    }
    // Los proyectos quedan sin asignar; sus sub-usuarios se eliminan (perderían su ámbito).
    const members = listWorkspaceUsers(id);
    transaction(() => {
      for (const m of members) deleteUser(m.id);
      deleteWorkspace(id); // desasigna proyectos y borra el workspace
    });
    audit(req, 'workspace_deleted', { type: 'workspace', id, detail: `${ws.name} (${members.length} usuarios)` });
    return { ok: true };
  });

  // Uso agregado del workspace en una ventana (para facturación por uso).
  app.get('/api/workspaces/:id/usage', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = getWorkspace(id);
    if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
    if (!assertWorkspaceAccess(req, reply, id)) return reply;
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    const nowHour = Math.floor(Date.now() / HOUR_MS);
    const usage = workspaceUsageRange(id, nowHour - days * 24, nowHour + 1);
    return {
      days,
      cpuCoreHours: Math.round((usage.cpuCorePctHours / 100) * 100) / 100,
      ramGbHours: Math.round((usage.memByteHours / 1e9) * 100) / 100,
      cpuMaxCores: Math.round((usage.cpuMax / 100) * 100) / 100,
      ramMaxGb: Math.round((usage.memMax / 1e9) * 100) / 100,
      diskMaxGb: Math.round((usage.diskMax / 1e9) * 100) / 100,
    };
  });

  // Serie temporal de consumo (para las gráficas) + consumo por proyecto (insights).
  app.get('/api/workspaces/:id/usage/series', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = getWorkspace(id);
    if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
    if (!assertWorkspaceAccess(req, reply, id)) return reply;
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    const nowHour = Math.floor(Date.now() / HOUR_MS);
    const fromHour = nowHour - days * 24 + 1;
    const bucketHours = days <= 2 ? 1 : days <= 14 ? 6 : 24;
    const series = workspaceUsageSeries(id, fromHour, nowHour + 1, bucketHours);
    const byProject = workspaceUsageByProject(id, fromHour, nowHour + 1)
      .slice(0, 8)
      .map((p) => ({
        projectId: p.projectId,
        name: p.name,
        cpuCoreHours: Math.round(p.cpuCoreHours * 100) / 100,
        ramGbHours: Math.round(p.ramGbHours * 100) / 100,
      }));
    return { days, bucketHours, series, byProject };
  });

  // Alertas de la cuenta (facturación, uso, morosidad): las ve el propietario.
  app.get('/api/workspaces/:id/alerts', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = getWorkspace(id);
    if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
    if (!assertWorkspaceAccess(req, reply, id)) return reply;
    return {
      alerts: listWorkspaceAlerts(id).map((a) => ({
        id: a.id,
        ts: a.ts,
        severity: a.severity,
        type: a.type,
        title: a.title,
        message: a.message,
        explanation: a.explanation,
      })),
    };
  });

  // ---- sub-usuarios del workspace (requisito 4: crear solo para su workspace) ----
  // Crear un sub-usuario acuña una credencial de acceso: exige sesión de
  // navegador (no un token de API), igual que crear tokens o passkeys.
  app.post('/api/workspaces/:id/members', { preHandler: requireSession }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = getWorkspace(id);
    if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
    if (!assertWorkspaceAccess(req, reply, id)) return reply;
    const body = memberSchema.parse(req.body);
    const email = body.email.toLowerCase();
    if (getUserByEmail(email)) return reply.code(409).send({ error: 'Ya existe un usuario con ese email' });

    // Solo un administrador de plataforma puede crear otros propietarios; un
    // propietario únicamente crea miembros bajo su workspace.
    const callerIsAdmin = currentUser(req)!.role === 'admin';
    const role = callerIsAdmin ? body.role : 'member';

    const summary = workspaceQuotaSummary(ws);
    if (countWorkspaceMembers(id) >= summary.quota.maxMembers) {
      return reply.code(409).send({ error: `El workspace ha alcanzado su límite de ${summary.quota.maxMembers} usuarios. Un administrador puede ampliarlo.` });
    }
    if (role === 'member' && body.projectIds.length > 0) {
      const check = projectsInWorkspace(body.projectIds, id);
      if (!check.ok) return reply.code(400).send({ error: 'Solo puedes asignar proyectos de este workspace' });
    }

    const user = createUser(email, hashPassword(body.password), role, id);
    if (role === 'member') setUserProjects(user.id, body.projectIds);
    audit(req, 'workspace_member_created', { type: 'user', id: user.id, detail: `${email} (${role}) en ${ws.name}` });
    reply.code(201);
    return { member: publicMember(user) };
  });

  app.patch('/api/workspaces/:id/members/:userId', async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const ws = getWorkspace(id);
    if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
    if (!assertWorkspaceAccess(req, reply, id)) return reply;
    const target = getUser(userId);
    // Un miembro/propietario solo se gestiona dentro de SU propio workspace.
    if (!target || target.workspace_id !== id || target.role === 'admin') {
      return reply.code(404).send({ error: 'Usuario no encontrado en este workspace' });
    }
    const me = currentUser(req)!;
    if (target.id === me.id) return reply.code(400).send({ error: 'No puedes cambiar tu propia cuenta desde aquí' });
    // Un propietario no gestiona a otros propietarios: eso queda para el administrador.
    if (me.role !== 'admin' && target.role === 'owner') {
      return reply.code(403).send({ error: 'Solo un administrador puede gestionar a otro propietario.' });
    }
    const body = patchMemberSchema.parse(req.body);
    // Cambiar la contraseña de otro usuario es acuñar una credencial: exige sesión.
    if (body.password && req.authMethod !== 'cookie') {
      return reply.code(403).send({ error: 'Restablecer la contraseña requiere una sesión de navegador, no un token de API' });
    }
    // Solo un admin puede ascender a propietario; un propietario mantiene el rol como mucho a miembro.
    const callerIsAdmin = me.role === 'admin';
    const requestedRole = callerIsAdmin ? body.role : body.role ? 'member' : undefined;
    const nextRole = requestedRole ?? (target.role as 'owner' | 'member');
    if (body.projectIds && nextRole === 'member') {
      const check = projectsInWorkspace(body.projectIds, id);
      if (!check.ok) return reply.code(400).send({ error: 'Solo puedes asignar proyectos de este workspace' });
    }

    transaction(() => {
      if (requestedRole && requestedRole !== target.role) updateUserRole(userId, requestedRole);
      // Un propietario no tiene asignaciones de proyecto; un miembro sí.
      if (nextRole === 'owner') setUserProjects(userId, []);
      else if (body.projectIds) setUserProjects(userId, body.projectIds);
      if (body.password) updateUserPassword(userId, hashPassword(body.password));
    });
    audit(req, 'workspace_member_updated', { type: 'user', id: userId, detail: `${target.email} en ${ws.name}` });
    return { member: publicMember(getUser(userId)!) };
  });

  app.delete('/api/workspaces/:id/members/:userId', async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const ws = getWorkspace(id);
    if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado' });
    if (!assertWorkspaceAccess(req, reply, id)) return reply;
    const target = getUser(userId);
    if (!target || target.workspace_id !== id || target.role === 'admin') {
      return reply.code(404).send({ error: 'Usuario no encontrado en este workspace' });
    }
    const me = currentUser(req)!;
    if (target.id === me.id) return reply.code(400).send({ error: 'No puedes eliminar tu propia cuenta' });
    if (me.role !== 'admin' && target.role === 'owner') {
      return reply.code(403).send({ error: 'Solo un administrador puede eliminar a otro propietario.' });
    }
    deleteUser(userId);
    audit(req, 'workspace_member_deleted', { type: 'user', id: userId, detail: `${target.email} de ${ws.name}` });
    return { ok: true };
  });
}
