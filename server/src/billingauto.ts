/**
 * Automatización de facturación: corte por impago (dunning), reactivación al
 * pagar y generación automática del borrador del ciclo. Lo invoca el scheduler
 * (bucle de 10 min). Todo el estado de morosidad se persiste en `workspaces`
 * para que sea idempotente y sobreviva a reinicios; cada workspace se aísla en
 * su propio try/catch para que un fallo no detenga a los demás.
 */
import { auditSystem } from './audit';
import { fireWorkspaceAlert } from './alerts';
import { getBillingAutomation } from './billingsettings';
import { getBillingProfile } from './company';
import { generateCycleDraft, issueInvoice } from './routes/billing';
import {
  getWorkspace,
  invoiceExistsForCycle,
  listUnpaidIssuedInvoices,
  listWorkspaces,
  resolveAlertsByDedupe,
  setWorkspaceKeysStatus,
  setWorkspaceSubscriptionsStatus,
  updateWorkspace,
} from './db';
import { InvoiceRow } from './types';

const DAY = 86_400_000;

/** Condiciones de pago del perfil, admitiendo 0 (vencimiento en la expedición). */
function paymentTermsDays(): number {
  const n = getBillingProfile().paymentTermsDays;
  return Number.isFinite(n) ? n : 30;
}

/** Fecha de vencimiento de una factura = expedición + condiciones de pago del perfil. */
function invoiceDueMs(inv: InvoiceRow, termsDays: number): number {
  return (inv.issued_at ?? inv.created_at) + termsDays * DAY;
}

/**
 * Reactiva una cuenta cortada por impago SOLO si ya no tiene ninguna factura
 * vencida. Idempotente; el webhook de pago siempre gana la carrera pago-vs-corte.
 * Las claves REVOCADAS (cancelación) no vuelven: eso es terminal.
 */
export function reactivateWorkspaceIfCurrent(workspaceId: string): void {
  const ws = getWorkspace(workspaceId) as any;
  if (!ws) return;
  const stage = ws.dunning_stage ?? 0;
  if (stage === 0 && !ws.ai_suspended) return; // no estaba en mora
  const termsDays = paymentTermsDays();
  const nowMs = Date.now();
  const stillOverdue = listUnpaidIssuedInvoices().some((i) => i.workspace_id === workspaceId && invoiceDueMs(i, termsDays) < nowMs);
  if (stillOverdue) return; // sigue debiendo otra factura: no se levanta el corte
  // La cancelación (etapa 3) es TERMINAL: las claves revocadas y las suscripciones
  // canceladas no reviven solas; pagar no restaura el servicio, requiere alta manual.
  const wasCancelled = stage >= 3;
  setWorkspaceKeysStatus(workspaceId, 'suspended', 'active');
  setWorkspaceSubscriptionsStatus(workspaceId, 'paused', 'active');
  updateWorkspace(workspaceId, { dunning_stage: 0, dunning_since: null, ai_suspended: 0, last_dunning_action_at: nowMs });
  resolveAlertsByDedupe(`ws:${workspaceId}:overdue`);
  resolveAlertsByDedupe(`ws:${workspaceId}:suspended`);
  resolveAlertsByDedupe(`ws:${workspaceId}:cancelled`);
  if (wasCancelled) {
    fireWorkspaceAlert({
      severity: 'warning',
      workspaceId,
      type: 'ws_cancelled_paid',
      title: `Cuenta cancelada regularizada — ${ws.name}`,
      message: 'Pago recibido, pero la cuenta estaba cancelada: requiere alta manual (emitir nuevas claves y reactivar las suscripciones).',
      dedupeKey: `ws:${workspaceId}:cancelled_paid:${nowMs}`,
    });
    auditSystem('dunning_cancelled_paid', ws.name);
  } else {
    fireWorkspaceAlert({
      severity: 'info',
      workspaceId,
      type: 'ws_reactivated',
      title: `Servicio reactivado — ${ws.name}`,
      message: 'Pago regularizado: se reactivan las claves de IA y las suscripciones suspendidas.',
      dedupeKey: `ws:${workspaceId}:reactivated:${nowMs}`,
    });
    auditSystem('dunning_reactivated', ws.name);
  }
}

/** Aplica la etapa de dunning que corresponda a un workspace con facturas vencidas. */
function dunningForWorkspace(workspaceId: string, overdue: InvoiceRow[], graceDays: number, cancelDays: number, nowMs: number, termsDays: number): void {
  const ws = getWorkspace(workspaceId) as any;
  if (!ws || ws.dunning_exempt) return;
  const oldestDue = Math.min(...overdue.map((i) => invoiceDueMs(i, termsDays)));
  const daysOverdue = Math.floor((nowMs - oldestDue) / DAY);
  let target = 1; // vencida (aviso)
  if (daysOverdue >= cancelDays) target = 3; // cancelación
  else if (daysOverdue >= graceDays) target = 2; // suspensión
  const stage = ws.dunning_stage ?? 0;
  if (target <= stage) return; // ya está en esa etapa o más avanzada

  const fields: Record<string, unknown> = { dunning_stage: target, last_dunning_action_at: nowMs };
  if (!ws.dunning_since) fields.dunning_since = nowMs;
  const totalCents = overdue.reduce((s, i) => s + i.total_cents, 0);
  const money = `${(totalCents / 100).toFixed(2)} ${overdue[0].currency}`;

  if (target === 1) {
    fireWorkspaceAlert({
      severity: 'warning',
      workspaceId,
      type: 'ws_invoice_overdue',
      title: `Factura vencida — ${ws.name}`,
      message: `${overdue.length} factura(s) vencida(s) por ${money}.`,
      explanation: `Recordatorio de pago. El servicio de IA se suspenderá a los ${graceDays} días de impago.`,
      dedupeKey: `ws:${workspaceId}:overdue`,
    });
  } else if (target === 2) {
    setWorkspaceKeysStatus(workspaceId, 'active', 'suspended');
    setWorkspaceSubscriptionsStatus(workspaceId, 'active', 'paused');
    fields.ai_suspended = 1;
    fireWorkspaceAlert({
      severity: 'critical',
      workspaceId,
      type: 'ws_ai_suspended',
      title: `Servicio suspendido por impago — ${ws.name}`,
      message: `Suspendidas las claves de IA y las suscripciones por impago (${money}, ${daysOverdue} días).`,
      explanation: `Se reactivará automáticamente al pagar. Cancelación a los ${cancelDays} días.`,
      dedupeKey: `ws:${workspaceId}:suspended`,
    });
    auditSystem('dunning_suspended', `${ws.name} (${daysOverdue}d, ${money})`);
  } else {
    // Cancelación: revoca las claves (terminal) y cancela las suscripciones.
    setWorkspaceKeysStatus(workspaceId, 'active', 'revoked');
    setWorkspaceKeysStatus(workspaceId, 'suspended', 'revoked');
    setWorkspaceSubscriptionsStatus(workspaceId, 'active', 'cancelled');
    setWorkspaceSubscriptionsStatus(workspaceId, 'paused', 'cancelled');
    fields.ai_suspended = 1;
    fireWorkspaceAlert({
      severity: 'critical',
      workspaceId,
      type: 'ws_cancelled',
      title: `Cuenta cancelada por impago — ${ws.name}`,
      message: `Claves revocadas y suscripciones canceladas tras ${daysOverdue} días de impago (${money}).`,
      explanation: 'Las facturas emitidas se conservan por obligación fiscal; si procede, emite una rectificativa o dótala como incobrable.',
      dedupeKey: `ws:${workspaceId}:cancelled`,
    });
    auditSystem('dunning_cancelled', `${ws.name} (${daysOverdue}d, ${money})`);
  }
  updateWorkspace(workspaceId, fields);
}

/** Recorre las facturas vencidas y avanza la etapa de dunning de cada cuenta. */
export function dunningTick(nowMs: number): void {
  const termsDays = paymentTermsDays();
  const { dunningGraceDays: graceDays, dunningCancelDays: cancelDays } = getBillingAutomation();
  const byWs = new Map<string, InvoiceRow[]>();
  for (const inv of listUnpaidIssuedInvoices()) {
    if (invoiceDueMs(inv, termsDays) >= nowMs) continue; // aún no vencida
    const list = byWs.get(inv.workspace_id) ?? [];
    list.push(inv);
    byWs.set(inv.workspace_id, list);
  }
  for (const [workspaceId, overdue] of byWs) {
    try {
      dunningForWorkspace(workspaceId, overdue, graceDays, cancelDays, nowMs, termsDays);
    } catch (err: any) {
      auditSystem('dunning_error', `${workspaceId}: ${(err?.message || err).toString().slice(0, 200)}`);
    }
  }
}

/** Ciclo COMPLETO anterior anclado al día de facturación (el que se factura al llegar ese día). */
function previousCycle(billingDay: number, now: Date): { start: number; end: number } {
  const start = new Date(now.getFullYear(), now.getMonth() - 1, billingDay);
  const end = new Date(now.getFullYear(), now.getMonth(), billingDay);
  return { start: start.getTime(), end: end.getTime() };
}

/**
 * En el día de facturación de cada cuenta, genera el borrador del ciclo COMPLETO
 * anterior (plan + suscripciones + uso medido + cargos) si aún no existe. Se crea
 * en DRAFT y, SOLO si el operador ha activado la auto-emisión, se emite (numera y
 * bloquea): la emisión es un acto legal irreversible, por eso es opt-in.
 */
export function billingCycleTick(now: Date): void {
  const auto = getBillingAutomation();
  if (!auto.autoGenerate) return; // generación automática desactivada por el operador
  const day = now.getDate();
  for (const ws of listWorkspaces()) {
    try {
      if (ws.billing_day !== day || ws.status !== 'active') continue;
      const cycle = previousCycle(ws.billing_day, now);
      if (invoiceExistsForCycle(ws.id, cycle.start)) continue; // ya generada (idempotente)
      const inv = generateCycleDraft(ws, cycle);
      if (!inv) continue; // nada que facturar: no se crea un borrador vacío
      const money = `${inv.currency} ${(inv.total_cents / 100).toFixed(2)}`;
      if (auto.autoIssue) {
        const issued = issueInvoice(inv.id) ?? inv;
        auditSystem('invoice_auto_issued', `${ws.name} · ${issued.number ?? issued.id} · ${money} (emitida automáticamente)`);
        fireWorkspaceAlert({
          severity: 'info',
          workspaceId: ws.id,
          type: 'invoice_auto_issued',
          title: `Factura emitida automáticamente — ${ws.name}`,
          message: `Factura ${issued.number ?? issued.id} por ${money}.`,
          explanation: 'Auto-emisión activada: revísala en la cuenta y envía el enlace de pago si procede.',
          dedupeKey: `ws:${ws.id}:auto_issued:${issued.id}`,
        });
      } else {
        auditSystem('invoice_auto_generated', `${ws.name} · ${money} (borrador del ciclo)`);
      }
    } catch (err: any) {
      auditSystem('billing_cycle_error', `${ws.id}: ${(err?.message || err).toString().slice(0, 200)}`);
    }
  }
}

/** Tarea de facturación del scheduler: primero genera el ciclo, luego evalúa el impago. */
export function billingAutomationTick(now: Date): void {
  billingCycleTick(now);
  dunningTick(now.getTime());
}
