import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../auth';
import { audit } from '../audit';
import { getSetting, listAllInvoices, setSetting } from '../db';
import { getBillingAutomation, setBillingAutomation } from '../billingsettings';
import {
  getBillingProfile,
  getSmtpSettings,
  getStripePublishableKey,
  getStripeSecretKey,
  getStripeWebhookSecret,
  setBillingProfile,
  setSmtpSettings,
} from '../company';
import { MailError, verifySmtp } from '../mailer';
import { BillingProfile, InvoiceRow } from '../types';

const profileSchema = z.object({
  companyName: z.string().trim().max(120).optional(),
  taxId: z.string().trim().max(60).optional(),
  address: z.string().trim().max(400).optional(),
  email: z.union([z.string().trim().email(), z.literal('')]).optional(),
  phone: z.string().trim().max(60).optional(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  vatRate: z.coerce.number().min(0).max(100).optional(),
  // «REC» está reservado para la serie de rectificativas (art. 6.1.a RD 1619/2012):
  // usarlo como prefijo ordinario mezclaría ambas series correlativas.
  invoicePrefix: z
    .string()
    .trim()
    .max(12)
    .refine((v) => v.toUpperCase() !== 'REC', { message: 'El prefijo «REC» está reservado para la serie de facturas rectificativas.' })
    .optional(),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
  defaultIrpfRate: z.coerce.number().min(0).max(100).optional(),
  sifMode: z.enum(['verifactu', 'no_verifactu']).optional(),
  iban: z.string().trim().max(40).optional(),
  bic: z.string().trim().max(20).optional(),
  bankName: z.string().trim().max(120).optional(),
  footer: z.string().trim().max(600).optional(),
  // Claves de Stripe (opcionales): se guardan si se envían; nunca se devuelven.
  stripeSecretKey: z.string().trim().optional(),
  stripeWebhookSecret: z.string().trim().optional(),
  stripePublishableKey: z.string().trim().optional(),
  // Correo saliente para enviar la factura al cliente. La contraseña se guarda
  // pero nunca se devuelve (igual que las claves de Stripe).
  smtpHost: z.string().trim().max(200).optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).optional(),
  smtpSecure: z.boolean().optional(),
  smtpUser: z.string().trim().max(200).optional(),
  smtpPass: z.string().optional(),
  smtpFrom: z.union([z.string().trim().email(), z.literal('')]).optional(),
  smtpFromName: z.string().trim().max(120).optional(),
});

/** Agrupa las facturas por mes de su periodo, sumando facturado y cobrado. */
function revenueSeries(invoices: InvoiceRow[], months: number): { t: number; invoiced: number; paid: number }[] {
  const now = new Date();
  const buckets: { key: string; t: number; invoiced: number; paid: number }[] = [];
  const index = new Map<string, number>();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    index.set(key, buckets.length);
    buckets.push({ key, t: d.getTime(), invoiced: 0, paid: 0 });
  }
  for (const inv of invoices) {
    if (inv.status === 'draft' || inv.status === 'void') continue;
    const d = new Date(inv.period_start);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const bi = index.get(key);
    if (bi === undefined) continue;
    buckets[bi].invoiced += inv.total_cents;
    if (inv.status === 'paid') buckets[bi].paid += inv.total_cents;
  }
  return buckets.map((b) => ({ t: b.t, invoiced: b.invoiced, paid: b.paid }));
}

function csvEscape(v: unknown): string {
  let s = v == null ? '' : String(v);
  // Anti-inyección de fórmulas: Excel/Sheets ejecutan como fórmula una celda que
  // empiece por = + @ (o tab/CR) —o por - cuando no es un número—. Se antepone un
  // apóstrofo para neutralizarla, respetando los importes negativos legítimos.
  if (/^[=+@\t\r]/.test(s) || (s[0] === '-' && !/^-\d/.test(s))) s = `'${s}`;
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function accountingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireAdmin);

  // Perfil de la empresa emisora + estado de Stripe (claves como booleanos).
  app.get('/api/billing/profile', async () => ({
    profile: getBillingProfile(),
    stripe: {
      hasSecretKey: !!getStripeSecretKey(),
      hasWebhookSecret: !!getStripeWebhookSecret(),
      publishableKey: getStripePublishableKey() ?? '',
    },
    invoiceSeq: parseInt(getSetting('billing.invoiceSeq') || '0', 10) || 0,
    smtp: (() => {
      const cfg = getSmtpSettings();
      return {
        configured: !!cfg,
        host: cfg?.host ?? '',
        port: cfg?.port ?? 587,
        secure: cfg?.secure ?? false,
        user: cfg?.user ?? '',
        from: cfg?.from ?? '',
        fromName: cfg?.fromName ?? '',
        hasPassword: !!cfg?.pass,
      };
    })(),
  }));

  app.put('/api/billing/profile', async (req) => {
    const body = profileSchema.parse(req.body ?? {});
    const current = getBillingProfile();
    const next: BillingProfile = {
      companyName: body.companyName ?? current.companyName,
      taxId: body.taxId ?? current.taxId,
      address: body.address ?? current.address,
      email: body.email ?? current.email,
      phone: body.phone ?? current.phone,
      currency: body.currency ?? current.currency,
      vatRate: body.vatRate ?? current.vatRate,
      invoicePrefix: body.invoicePrefix ?? current.invoicePrefix,
      paymentTermsDays: body.paymentTermsDays ?? current.paymentTermsDays,
      defaultIrpfRate: body.defaultIrpfRate ?? current.defaultIrpfRate,
      sifMode: body.sifMode ?? current.sifMode,
      iban: body.iban ?? current.iban,
      bic: body.bic ?? current.bic,
      bankName: body.bankName ?? current.bankName,
      footer: body.footer ?? current.footer,
    };
    setBillingProfile(next);
    // Claves de Stripe: se actualizan solo si se envían; '' las borra.
    if (body.stripeSecretKey !== undefined) setSetting('stripeSecretKey', body.stripeSecretKey || null);
    if (body.stripeWebhookSecret !== undefined) setSetting('stripeWebhookSecret', body.stripeWebhookSecret || null);
    if (body.stripePublishableKey !== undefined) setSetting('stripePublishableKey', body.stripePublishableKey || null);
    setSmtpSettings({
      host: body.smtpHost,
      port: body.smtpPort,
      secure: body.smtpSecure,
      user: body.smtpUser,
      pass: body.smtpPass,
      from: body.smtpFrom,
      fromName: body.smtpFromName,
    });
    audit(req, 'billing_profile_updated', { type: 'system', id: 'billing' });
    return { ok: true, profile: next };
  });

  // Automatización de la facturación: generación/emisión automática del ciclo y
  // umbrales de morosidad (los honra el scheduler en `billingauto.ts`).
  app.get('/api/billing/automation', async () => ({ automation: getBillingAutomation() }));

  app.put('/api/billing/automation', async (req, reply) => {
    const body = z
      .object({
        autoGenerate: z.boolean().optional(),
        autoIssue: z.boolean().optional(),
        dunningGraceDays: z.coerce.number().int().min(0).max(365).optional(),
        dunningCancelDays: z.coerce.number().int().min(0).max(365).optional(),
        emailOnIssue: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    // La cancelación nunca puede preceder a la suspensión: se validan los valores ya fusionados.
    const merged = { ...getBillingAutomation(), ...body };
    if (merged.dunningCancelDays < merged.dunningGraceDays) {
      return reply.code(400).send({ error: 'Los días para cancelar deben ser ≥ los días para suspender.' });
    }
    // Activar el envío sin servidor de correo dejaría a cada emisión fallando en
    // silencio: se corta aquí, donde el operador puede leerlo.
    if (merged.emailOnIssue && !getSmtpSettings()) {
      return reply.code(400).send({ error: 'Configura primero el servidor de correo saliente para poder enviar las facturas.' });
    }
    const automation = setBillingAutomation(body);
    audit(req, 'billing_automation_updated', { type: 'system', id: 'billing', detail: `auto-emisión ${automation.autoIssue ? 'on' : 'off'}` });
    return { ok: true, automation };
  });

  // Prueba de conexión con el servidor de correo: conecta y autentica sin enviar
  // nada. Acepta una configuración de prueba en el cuerpo para poder validarla
  // ANTES de guardarla (la contraseña, si se omite, sale de la ya guardada).
  app.post('/api/billing/smtp/test', async (req, reply) => {
    const body = z
      .object({
        host: z.string().trim().max(200).optional(),
        port: z.coerce.number().int().min(1).max(65535).optional(),
        secure: z.boolean().optional(),
        user: z.string().trim().max(200).optional(),
        pass: z.string().optional(),
        from: z.union([z.string().trim().email(), z.literal('')]).optional(),
        fromName: z.string().trim().max(120).optional(),
      })
      .parse(req.body ?? {});
    const guardada = getSmtpSettings();
    const cfg = {
      host: body.host ?? guardada?.host ?? '',
      port: body.port ?? guardada?.port ?? 587,
      secure: body.secure ?? guardada?.secure ?? false,
      user: body.user ?? guardada?.user ?? '',
      pass: body.pass || guardada?.pass || '',
      from: body.from ?? guardada?.from ?? '',
      fromName: body.fromName ?? guardada?.fromName ?? '',
    };
    try {
      await verifySmtp(cfg);
      audit(req, 'smtp_tested', { type: 'system', id: 'billing', detail: cfg.host });
      return { ok: true };
    } catch (err: any) {
      const detalle = err instanceof MailError ? err.message : (err?.message || 'error desconocido');
      return reply.code(502).send({ error: detalle });
    }
  });

  // Resumen de contabilidad de la empresa: totales, serie mensual y por cliente.
  // Los importes se agrupan POR MONEDA: sumar céntimos de divisas distintas en un
  // mismo total (y etiquetarlo con la moneda del emisor) da una cifra falsa.
  app.get('/api/accounting/summary', async (req) => {
    const { months } = z.object({ months: z.coerce.number().int().min(1).max(36).default(12) }).parse(req.query);
    const all = listAllInvoices();
    const principal = getBillingProfile().currency.toUpperCase();
    const emptyTotals = () => ({ invoiced: 0, paid: 0, pending: 0, draft: 0, void: 0, count: 0 });
    const porMoneda = new Map<string, ReturnType<typeof emptyTotals>>();
    const byClient = new Map<string, { workspaceId: string; name: string; currency: string; invoiced: number; paid: number }>();
    for (const inv of all) {
      const cur = inv.currency.toUpperCase();
      const t = porMoneda.get(cur) ?? emptyTotals();
      t.count += 1;
      if (inv.status === 'issued' || inv.status === 'paid') t.invoiced += inv.total_cents;
      if (inv.status === 'paid') t.paid += inv.total_cents;
      if (inv.status === 'issued') t.pending += inv.total_cents;
      if (inv.status === 'draft') t.draft += inv.total_cents;
      if (inv.status === 'void') t.void += inv.total_cents;
      porMoneda.set(cur, t);
      if (inv.status === 'issued' || inv.status === 'paid') {
        const key = `${inv.workspace_id}|${cur}`;
        const e = byClient.get(key) ?? { workspaceId: inv.workspace_id, name: (inv as any).workspace_name ?? 'Sin cuenta', currency: cur, invoiced: 0, paid: 0 };
        e.invoiced += inv.total_cents;
        if (inv.status === 'paid') e.paid += inv.total_cents;
        byClient.set(key, e);
      }
    }
    return {
      currency: principal,
      // `totals` sigue siendo el de la moneda del emisor (lo que ya pintaba la UI);
      // `byCurrency` expone el resto para que ninguna factura quede fuera del cuadro.
      totals: porMoneda.get(principal) ?? emptyTotals(),
      byCurrency: [...porMoneda.entries()].map(([currency, t]) => ({ currency, ...t })).sort((a, b) => (a.currency === principal ? -1 : b.currency === principal ? 1 : b.invoiced - a.invoiced)),
      series: revenueSeries(all.filter((i) => i.currency.toUpperCase() === principal), months),
      byClient: [...byClient.values()].sort((a, b) => b.invoiced - a.invoiced).slice(0, 12),
    };
  });

  // Todas las facturas de todos los clientes (para la lista y auditoría contable).
  app.get('/api/accounting/invoices', async (req) => {
    const { status } = z.object({ status: z.enum(['draft', 'issued', 'paid', 'void']).optional() }).parse(req.query);
    return {
      invoices: listAllInvoices({ status }).map((i) => ({
        id: i.id,
        number: i.number,
        invoice_type: i.invoice_type,
        workspace_id: i.workspace_id,
        workspace_name: (i as any).workspace_name,
        client_tax_id: i.client_tax_id,
        status: i.status,
        currency: i.currency,
        subtotal_cents: i.subtotal_cents,
        tax_cents: i.tax_cents,
        irpf_cents: i.irpf_cents,
        total_cents: i.total_cents,
        payment_method: i.payment_method,
        period_start: i.period_start,
        period_end: i.period_end,
        issued_at: i.issued_at,
        paid_at: i.paid_at,
      })),
    };
  });

  // Exportación CSV para la contabilidad de la empresa.
  app.get('/api/accounting/export.csv', async (req, reply) => {
    // El libro registro recoge las facturas EXPEDIDAS: los borradores no lo son
    // (no tienen número ni fecha de expedición) y colarlos descuadra el libro.
    // Las anuladas sí constan, con su número, para justificar el hueco en la serie.
    const rows = listAllInvoices()
      .filter((i) => i.status !== 'draft')
      .sort((a, b) => (a.issued_at ?? a.created_at) - (b.issued_at ?? b.created_at) || (a.number ?? '').localeCompare(b.number ?? ''));
    // Libro registro de facturas emitidas: nº, tipo, NIF del receptor, base, IVA,
    // IRPF y total, según lo que la AEAT espera para la contabilidad.
    const header = ['numero', 'tipo', 'cliente', 'nif_cliente', 'estado', 'fecha_expedicion', 'periodo_inicio', 'periodo_fin', 'base_imponible', 'iva', 'irpf', 'total', 'moneda', 'metodo_pago', 'pagada'];
    const iso = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
    const money = (c: number) => (c / 100).toFixed(2);
    const lines = [header.join(',')];
    for (const i of rows) {
      lines.push(
        [
          i.number ?? '',
          i.invoice_type,
          (i as any).workspace_name ?? '',
          i.client_tax_id ?? '',
          i.status,
          iso(i.issued_at),
          iso(i.period_start),
          iso(i.period_end),
          money(i.subtotal_cents),
          money(i.tax_cents),
          money(i.irpf_cents),
          money(i.total_cents),
          i.currency,
          i.payment_method ?? '',
          iso(i.paid_at),
        ]
          .map(csvEscape)
          .join(','),
      );
    }
    audit(req, 'accounting_exported', { type: 'system', id: 'accounting', detail: `${rows.length} facturas` });
    reply.header('Content-Disposition', 'attachment; filename="contabilidad-skyway.csv"');
    reply.type('text/csv; charset=utf-8');
    return lines.join('\n');
  });
}
