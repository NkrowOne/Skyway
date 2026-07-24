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
import { BillingError, cycleAnchor, generateCycleDraft, issueInvoice, lastCutoff } from './routes/billing';
import {
  deleteInvoice,
  getWorkspace,
  invoiceExistsForCycle,
  listUnpaidIssuedInvoices,
  listWorkspaces,
  openDraftForCycle,
  resolveAlertsByDedupe,
  reviveDunningKeys,
  reviveDunningSubscriptions,
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
 * Saldo vencido de una cuenta, en céntimos. Suma las facturas de CARGO vencidas y
 * resta los ABONOS emitidos y no cobrados (rectificativas a la baja, con
 * `total_cents` negativo). Un abono no es una deuda: sin esta compensación, emitir
 * una rectificativa metía al cliente en mora por el importe que se le devolvía.
 */
function overdueBalance(invoices: InvoiceRow[], workspaceId: string, termsDays: number, nowMs: number): { saldo: number; vencidas: InvoiceRow[] } {
  const propias = invoices.filter((i) => i.workspace_id === workspaceId);
  const vencidas = propias.filter((i) => i.total_cents > 0 && invoiceDueMs(i, termsDays) < nowMs);
  const abonos = propias.filter((i) => i.total_cents <= 0).reduce((s, i) => s + i.total_cents, 0);
  return { saldo: vencidas.reduce((s, i) => s + i.total_cents, 0) + abonos, vencidas };
}

/**
 * Reactiva una cuenta cortada por impago SOLO si ya no tiene saldo vencido.
 * Idempotente; el webhook de pago siempre gana la carrera pago-vs-corte.
 * Las claves REVOCADAS (cancelación) no vuelven: eso es terminal.
 */
export function reactivateWorkspaceIfCurrent(workspaceId: string): void {
  const ws = getWorkspace(workspaceId) as any;
  if (!ws) return;
  const stage = ws.dunning_stage ?? 0;
  if (stage === 0 && !ws.ai_suspended) return; // no estaba en mora
  const termsDays = paymentTermsDays();
  const nowMs = Date.now();
  const { saldo } = overdueBalance(listUnpaidIssuedInvoices(), workspaceId, termsDays, nowMs);
  if (saldo > 0) return; // sigue debiendo: no se levanta el corte
  // La cancelación (etapa 3) es TERMINAL: las claves revocadas y las suscripciones
  // canceladas no reviven solas; pagar no restaura el servicio, requiere alta manual.
  const wasCancelled = stage >= 3;
  // Solo revive lo que cortó la MOROSIDAD: si el operador había suspendido una
  // clave o pausado una suscripción a mano, pagar no debe deshacer su decisión.
  reviveDunningKeys(workspaceId, 'suspended');
  reviveDunningSubscriptions(workspaceId, 'paused');
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
  const pendientes = listUnpaidIssuedInvoices();
  const workspaceIds = new Set(pendientes.map((i) => i.workspace_id));
  for (const workspaceId of workspaceIds) {
    try {
      // Solo entra en mora quien tiene saldo vencido NETO: las rectificativas y
      // demás abonos emitidos compensan la deuda antes de cortar el servicio.
      const { saldo, vencidas } = overdueBalance(pendientes, workspaceId, termsDays, nowMs);
      if (saldo <= 0 || vencidas.length === 0) {
        reactivateWorkspaceIfCurrent(workspaceId); // deshace un corte anterior ya compensado
        continue;
      }
      dunningForWorkspace(workspaceId, vencidas, graceDays, cancelDays, nowMs, termsDays);
    } catch (err: any) {
      auditSystem('dunning_error', `${workspaceId}: ${(err?.message || err).toString().slice(0, 200)}`);
    }
  }
}

/**
 * Genera el borrador del periodo CERRADO que quede pendiente en cada cuenta (plan
 * + suscripciones + uso medido + cargos). Se crea en DRAFT y, SOLO si el operador
 * ha activado la auto-emisión, se emite (numera y bloquea): la emisión es un acto
 * legal irreversible, por eso es opt-in.
 *
 * El periodo va del ANCLA persistente (fin de lo último facturado) al último corte
 * vencido, no del día del mes. Así, cambiar el día de facturación no refactura el
 * tramo solapado, y si el servidor estuvo caído el día de cierre el ciclo se
 * recupera en el primer tick que corra, en vez de perderse para siempre.
 */
export function billingCycleTick(now: Date): void {
  const auto = getBillingAutomation();
  if (!auto.autoGenerate) return; // generación automática desactivada por el operador
  for (const ws of listWorkspaces()) {
    try {
      if (ws.status !== 'active') continue;
      const cycle = { start: cycleAnchor(ws, now), end: lastCutoff(ws.billing_day, now) };
      if (cycle.end <= cycle.start) continue; // no hay ningún periodo cerrado pendiente
      // Idempotencia sobre el ciclo YA CERRADO: un borrador creado a mitad de mes
      // (una previsión del operador) no cuenta como facturado, porque le falta el
      // consumo del resto del periodo. Se sustituye por el definitivo.
      if (invoiceExistsForCycle(ws.id, cycle.start, cycle.end)) continue;
      const previo = openDraftForCycle(ws.id, cycle.start);
      // `deleteInvoice` devuelve sus cargos puntuales a 'pending', así que el
      // borrador nuevo vuelve a incluirlos: no se pierde nada por el camino.
      if (previo) {
        deleteInvoice(previo.id);
        auditSystem('invoice_draft_replaced', `${ws.name} · borrador parcial sustituido por la factura del ciclo cerrado`);
      }
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
      // Un error de negocio (moneda mezclada, dato fiscal ausente) es accionable
      // por el operador: se audita con su mensaje y NO avanza el ancla, así que el
      // periodo se reintenta en el tick siguiente una vez corregido.
      const prefijo = err instanceof BillingError ? 'revisar' : 'error';
      auditSystem('billing_cycle_error', `${ws.name}: [${prefijo}] ${(err?.message || err).toString().slice(0, 200)}`);
    }
  }
}

/** Tarea de facturación del scheduler: primero genera el ciclo, luego evalúa el impago. */
export function billingAutomationTick(now: Date): void {
  billingCycleTick(now);
  dunningTick(now.getTime());
}
