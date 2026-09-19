import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE, getBillingProfile, setBillingProfile } from '../src/company';
import {
  closeDb,
  createPlan,
  createWorkspaceRow,
  getInvoice,
  getWorkspace,
  initDb,
  listInvoices,
  recordPlanChange,
  setSetting,
  updateInvoice,
  updateWorkspace,
} from '../src/db';
import { cycleAnchor, generateCycleDraft, issueInvoice, lastCutoff, pendingPeriods } from '../src/routes/billing';
import type { InvoiceRow } from '../src/types';

beforeAll(() => initDb());
afterAll(() => closeDb());

describe('perfil fiscal', () => {
  it('tolera un JSON de otra forma y vuelve a los valores por defecto', () => {
    setSetting('billingProfile', '"cadena"');
    expect(getBillingProfile()).toEqual(DEFAULT_PROFILE);
    setSetting('billingProfile', '[1,2]');
    expect(getBillingProfile()).toEqual(DEFAULT_PROFILE);
  });

  it('guarda y devuelve el perfil del emisor', () => {
    setBillingProfile({ ...DEFAULT_PROFILE, companyName: 'Emisor SL', taxId: 'B12345678' });
    expect(getBillingProfile().companyName).toBe('Emisor SL');
  });
});

describe('ciclo de facturación', () => {
  const now = new Date();
  const haceTres = new Date(now.getFullYear(), now.getMonth() - 3, 1).getTime();
  let wsId = '';
  let pendientes: { start: number; end: number }[] = [];
  let inv1: InvoiceRow;
  let inv2: InvoiceRow;

  beforeAll(() => {
    const plan = createPlan('Pro', {
      price_cents: 10000,
      currency: 'EUR',
      interval: 'monthly',
      cpu_cores: 1,
      memory_mb: 1024,
      disk_mb: 10240,
      max_projects: 3,
      max_services: 10,
      max_members: 3,
      modules: '[]',
      is_default: 0,
      archived: 0,
      discount_pct: 0,
    });
    // Cuenta contratada hace tres meses: el plan y su tramo de historial se
    // retrotraen a esa fecha (una cuenta creada hoy no tiene nada que facturar
    // de hace tres meses y `generateCycleDraft` devolvería null con razón).
    const ws = createWorkspaceRow('Cliente', { billing_day: 1 });
    wsId = ws.id;
    recordPlanChange(ws.id, plan.id, haceTres);
    updateWorkspace(ws.id, { plan_id: plan.id, plan_since: haceTres, billing_tax_id: 'A11111111', last_billed_period_end: haceTres });
  });

  it('con el ancla tres meses atrás los periodos pendientes salen de uno en uno', () => {
    pendientes = pendingPeriods(getWorkspace(wsId)!);
    expect(pendientes).toHaveLength(3);
    expect(pendientes[0].start).toBe(haceTres);
    expect(pendientes[2].end).toBe(lastCutoff(1));
  });

  it('el primer periodo cerrado genera un borrador con la cuota entera y avanza el ancla', () => {
    const inv = generateCycleDraft(getWorkspace(wsId)!, pendientes[0]);
    expect(inv).not.toBeNull();
    inv1 = inv!;
    expect(inv1.status).toBe('draft');
    expect(inv1.subtotal_cents, 'cuota entera, no prorrateada').toBe(10000);
    expect(inv1.tax_cents).toBe(2100);
    expect(getWorkspace(wsId)!.last_billed_period_end).toBe(pendientes[0].end);
  });

  it('emitir numera, bloquea, fija due_at y no retrocede el ancla', () => {
    const emitida = issueInvoice(inv1.id)!;
    expect(emitida.status).toBe('issued');
    expect(emitida.number ?? '').toMatch(/^FRA-\d{4}-0001$/);
    expect(emitida.locked).toBe(1);
    expect(emitida.due_at).toBeTruthy();
    expect(emitida.due_at!).toBeGreaterThan(emitida.issued_at!);
    expect(getWorkspace(wsId)!.last_billed_period_end).toBe(pendientes[0].end);
  });

  it('el segundo periodo se emite y el ancla avanza a su fin', () => {
    inv2 = generateCycleDraft(getWorkspace(wsId)!, pendientes[1])!;
    issueInvoice(inv2.id);
    expect(getWorkspace(wsId)!.last_billed_period_end).toBe(pendientes[1].end);
  });

  it('detecta el solape de otro documento vivo sobre el periodo', () => {
    // `rewindAnchorIfLast` no es pública: se replica su comprobación de solape
    // (misma consulta, `listInvoices`); la ruta real se cubre en billing-routes.
    const solapa = (inv: { id: string; period_start: number; period_end: number }) =>
      listInvoices(wsId).some(
        (o) => o.id !== inv.id && o.status !== 'draft' && o.status !== 'void' && o.period_start < inv.period_end && o.period_end > inv.period_start,
      );
    expect(solapa(getInvoice(inv1.id)!), 'inv2 no solapa a inv1 (periodos contiguos)').toBe(false);
    updateInvoice(inv2.id, { period_start: inv1.period_start + 86_400_000 * 5 });
    expect(solapa(getInvoice(inv1.id)!), 'con inv2 desplazada sí hay solape').toBe(true);
  });

  it('desde el ancla actual solo queda un periodo pendiente', () => {
    expect(pendingPeriods(getWorkspace(wsId)!)).toHaveLength(1);
    expect(cycleAnchor(getWorkspace(wsId)!)).toBe(pendientes[1].end);
  });
});
