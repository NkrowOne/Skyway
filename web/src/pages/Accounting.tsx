import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, CreditCard, Download, Landmark, Receipt } from 'lucide-react';
import { api } from '../api';
import { Button, Field, Skeleton, StatusBadge, useToast } from '../components/ui';
import { RevenueBars } from '../components/BillingCharts';
import { AccountingInvoice, AccountingSummary, BillingProfile, BillingProfileResponse, InvoiceStatus } from '../types';
import { cx, fmtDate, fmtMoney } from '../utils';

const INV_TONE: Record<string, 'neutral' | 'info' | 'ok' | 'warn'> = { draft: 'neutral', issued: 'info', paid: 'ok', void: 'warn' };
const INV_LABEL: Record<string, string> = { draft: 'borrador', issued: 'emitida', paid: 'pagada', void: 'anulada' };
const monthLabel = (t: number) => new Date(t).toLocaleDateString('es', { month: 'short' });

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'acc' | 'warn' }) {
  return (
    <div className="card p-4">
      <p className="text-[11px] text-subtle">{label}</p>
      <p className={cx('mt-1 tnum text-2xl font-semibold leading-none', tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : 'text-txt')}>{value}</p>
    </div>
  );
}

export default function AccountingPage() {
  const summary = useQuery({ queryKey: ['accounting-summary'], queryFn: () => api.get<AccountingSummary>('/accounting/summary?months=12') });
  const [statusFilter, setStatusFilter] = useState<'' | InvoiceStatus>('');
  const invoicesQ = useQuery({
    queryKey: ['accounting-invoices', statusFilter],
    queryFn: () => api.get<{ invoices: AccountingInvoice[] }>(`/accounting/invoices${statusFilter ? `?status=${statusFilter}` : ''}`),
  });

  const s = summary.data;
  const cur = s?.currency ?? 'EUR';
  const money = (c: number) => fmtMoney(c, cur);

  const FILTERS: { key: '' | InvoiceStatus; label: string }[] = [
    { key: '', label: 'Todas' },
    { key: 'issued', label: 'Emitidas' },
    { key: 'paid', label: 'Pagadas' },
    { key: 'draft', label: 'Borradores' },
    { key: 'void', label: 'Anuladas' },
  ];

  return (
    <div className="mx-auto max-w-[1120px] px-4 py-7 sm:px-6 sm:py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-.02em]">Contabilidad</h1>
          <p className="mt-1.5 text-sm text-sub">Ingresos de tu empresa: lo facturado a los clientes, lo cobrado y lo pendiente</p>
        </div>
        <a href="/api/accounting/export.csv" download className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface2 px-3.5 text-[13px] font-medium text-txt hover:border-acc/50">
          <Download size={15} /> Exportar CSV
        </a>
      </div>

      {summary.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi label="Facturado" value={money(s!.totals.invoiced)} />
            <Kpi label="Cobrado" value={money(s!.totals.paid)} tone="ok" />
            <Kpi label="Pendiente de cobro" value={money(s!.totals.pending)} tone={s!.totals.pending > 0 ? 'warn' : undefined} />
            <Kpi label="Facturas" value={String(s!.totals.count)} />
          </div>

          <div className="mt-5">
            <RevenueBars points={s!.series} format={money} labelFor={monthLabel} />
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <section className="card overflow-hidden">
              <div className="border-b border-line px-4 py-3">
                <h2 className="text-sm font-semibold">Por cliente</h2>
              </div>
              {s!.byClient.length === 0 ? (
                <p className="px-4 py-8 text-center text-xs text-subtle">Aún no hay facturación por cliente.</p>
              ) : (
                s!.byClient.map((c, i) => {
                  const pct = c.invoiced > 0 ? Math.round((c.paid / c.invoiced) * 100) : 0;
                  return (
                    <div key={c.workspaceId} className={cx('px-4 py-3', i > 0 && 'border-t border-line')}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5 truncate text-[13px] font-medium">
                          <Building2 size={12} className="shrink-0 text-subtle" /> {c.name}
                        </span>
                        <span className="shrink-0 text-[13px] font-semibold tnum">{money(c.invoiced)}</span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface2">
                        <div className="h-full rounded-full bg-ok" style={{ width: `${pct}%` }} />
                      </div>
                      <p className="mt-1 text-[11px] text-subtle tnum">{money(c.paid)} cobrado · {pct}%</p>
                    </div>
                  );
                })
              )}
            </section>

            <section className="card overflow-hidden">
              <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
                <h2 className="text-sm font-semibold">Facturas</h2>
                <div className="flex gap-1 overflow-x-auto [scrollbar-width:none]">
                  {FILTERS.map((f) => (
                    <button
                      key={f.key || 'all'}
                      onClick={() => setStatusFilter(f.key)}
                      className={cx('shrink-0 rounded-md px-2 py-0.5 text-[11px] transition-colors', statusFilter === f.key ? 'bg-acc/[.15] font-medium text-acc-soft' : 'text-subtle hover:text-txt')}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="max-h-[360px] overflow-y-auto">
                {(invoicesQ.data?.invoices ?? []).length === 0 ? (
                  <p className="px-4 py-8 text-center text-xs text-subtle">Sin facturas.</p>
                ) : (
                  invoicesQ.data!.invoices.map((inv, i) => (
                    <div key={inv.id} className={cx('flex items-center justify-between gap-2 px-4 py-2.5', i > 0 && 'border-t border-line')}>
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-[13px]">
                          <span className="font-mono text-[11px] text-subtle">{inv.number ?? '—'}</span>
                          <span className="truncate">{inv.workspace_name ?? 'Sin cuenta'}</span>
                        </p>
                        <p className="text-[11px] text-subtle">{fmtDate(inv.period_start)}{inv.payment_method === 'stripe' ? ' · Stripe' : inv.payment_method === 'bank_transfer' ? ' · transferencia' : ''}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-[13px] font-semibold tnum">{fmtMoney(inv.total_cents, inv.currency)}</span>
                        <StatusBadge tone={INV_TONE[inv.status]} label={INV_LABEL[inv.status]} dot={false} className="text-[10px]" />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </>
      )}

      <div className="mt-5">
        <CompanyProfile />
      </div>
    </div>
  );
}

interface ProfileDraft extends BillingProfile {
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  stripePublishableKey: string;
}

function CompanyProfile() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['billing-profile'], queryFn: () => api.get<BillingProfileResponse>('/billing/profile') });
  const [draft, setDraft] = useState<ProfileDraft | null>(null);

  // Sincroniza el borrador local cuando llegan los datos (una vez).
  if (q.data && !draft) {
    setDraft({ ...q.data.profile, stripeSecretKey: '', stripeWebhookSecret: '', stripePublishableKey: q.data.stripe.publishableKey });
  }

  const save = useMutation({
    mutationFn: () => {
      const d = draft!;
      const payload: Record<string, unknown> = {
        companyName: d.companyName, taxId: d.taxId, address: d.address, email: d.email, phone: d.phone,
        currency: d.currency, vatRate: d.vatRate, invoicePrefix: d.invoicePrefix, paymentTermsDays: d.paymentTermsDays,
        defaultIrpfRate: d.defaultIrpfRate, sifMode: d.sifMode,
        iban: d.iban, bic: d.bic, bankName: d.bankName, footer: d.footer, stripePublishableKey: d.stripePublishableKey,
      };
      // Las claves secretas solo se envían si se han escrito (no se sobreescriben con vacío por error).
      if (d.stripeSecretKey.trim()) payload.stripeSecretKey = d.stripeSecretKey.trim();
      if (d.stripeWebhookSecret.trim()) payload.stripeWebhookSecret = d.stripeWebhookSecret.trim();
      return api.put('/billing/profile', payload);
    },
    onSuccess: () => { toast('Datos de la empresa guardados', 'ok'); queryClient.invalidateQueries({ queryKey: ['billing-profile'] }); },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  if (!draft || !q.data) return <Skeleton className="h-64 w-full" />;
  const set = (patch: Partial<ProfileDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const stripe = q.data.stripe;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="card p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Building2 size={15} className="text-acc-soft" /> Datos de la empresa emisora</h2>
        <p className="mt-1 text-xs text-subtle">Aparecen en cada factura. Tú facturas a tus clientes.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Nombre / razón social"><input className="input" value={draft.companyName} onChange={(e) => set({ companyName: e.target.value })} placeholder="Skyway Cloud S.L." /></Field>
          <Field label="NIF / CIF"><input className="input" value={draft.taxId} onChange={(e) => set({ taxId: e.target.value })} placeholder="B12345678" /></Field>
          <Field label="Email"><input className="input" type="email" value={draft.email} onChange={(e) => set({ email: e.target.value })} /></Field>
          <Field label="Teléfono"><input className="input" value={draft.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
        </div>
        <Field label="Dirección"><textarea className="input min-h-16" value={draft.address} onChange={(e) => set({ address: e.target.value })} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Moneda"><input className="input" maxLength={3} value={draft.currency} onChange={(e) => set({ currency: e.target.value })} /></Field>
          <Field label="Prefijo de serie" hint="Ej: FRA · numeración por ejercicio"><input className="input" maxLength={12} value={draft.invoicePrefix} onChange={(e) => set({ invoicePrefix: e.target.value })} /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="IVA por defecto (%)"><input className="input tnum" type="number" min={0} max={100} value={draft.vatRate} onChange={(e) => set({ vatRate: Number(e.target.value) || 0 })} /></Field>
          <Field label="IRPF por defecto (%)" hint="0 si eres sociedad"><input className="input tnum" type="number" min={0} max={100} value={draft.defaultIrpfRate} onChange={(e) => set({ defaultIrpfRate: Number(e.target.value) || 0 })} /></Field>
          <Field label="Modo Verifactu" hint="Remisión a la AEAT">
            <select className="input" value={draft.sifMode} onChange={(e) => set({ sifMode: e.target.value as BillingProfile['sifMode'] })}>
              <option value="no_verifactu">No Veri*factu (local)</option>
              <option value="verifactu">Veri*factu (AEAT)</option>
            </select>
          </Field>
        </div>
        <Field label="Pie de factura"><textarea className="input min-h-14" value={draft.footer} onChange={(e) => set({ footer: e.target.value })} placeholder="Condiciones, agradecimiento…" /></Field>
      </section>

      <div className="flex flex-col gap-5">
        <section className="card p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Landmark size={15} className="text-info" /> Transferencia bancaria</h2>
          <p className="mt-1 text-xs text-subtle">Los datos que ve el cliente para pagar por transferencia.</p>
          <div className="mt-4 grid gap-3">
            <Field label="IBAN"><input className="input font-mono" value={draft.iban} onChange={(e) => set({ iban: e.target.value })} placeholder="ES91 2100 0418 4502 0005 1332" /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="BIC / SWIFT"><input className="input" value={draft.bic} onChange={(e) => set({ bic: e.target.value })} /></Field>
              <Field label="Banco"><input className="input" value={draft.bankName} onChange={(e) => set({ bankName: e.target.value })} /></Field>
            </div>
          </div>
        </section>

        <section className="card p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><CreditCard size={15} className="text-acc-soft" /> Stripe (pago con tarjeta)</h2>
          <p className="mt-1 text-xs text-subtle">
            Cobra facturas con tarjeta. Configura el webhook <span className="font-mono">/api/webhooks/stripe</span> en Stripe con el secreto de firma.
          </p>
          <div className="mt-4 grid gap-3">
            <Field label="Clave secreta (sk_…)" hint={stripe.hasSecretKey ? 'ya configurada; vacío = no cambiar' : 'necesaria para crear enlaces de pago'}>
              <input className="input font-mono" type="password" value={draft.stripeSecretKey} onChange={(e) => set({ stripeSecretKey: e.target.value })} placeholder={stripe.hasSecretKey ? '•••••••• configurada' : 'sk_live_…'} />
            </Field>
            <Field label="Secreto del webhook (whsec_…)" hint={stripe.hasWebhookSecret ? 'ya configurado; vacío = no cambiar' : 'verifica los eventos de pago'}>
              <input className="input font-mono" type="password" value={draft.stripeWebhookSecret} onChange={(e) => set({ stripeWebhookSecret: e.target.value })} placeholder={stripe.hasWebhookSecret ? '•••••••• configurado' : 'whsec_…'} />
            </Field>
            <Field label="Clave publicable (pk_…)"><input className="input font-mono" value={draft.stripePublishableKey} onChange={(e) => set({ stripePublishableKey: e.target.value })} placeholder="pk_live_…" /></Field>
          </div>
        </section>

        <div className="flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-[11px] text-subtle"><Receipt size={12} /> Numeración correlativa por serie y ejercicio</p>
          <Button onClick={() => save.mutate()} loading={save.isPending}>Guardar</Button>
        </div>
      </div>
    </div>
  );
}
