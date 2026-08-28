import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Building2, CalendarClock, Coins, CreditCard, Download, Landmark, Receipt, RefreshCw, Send, Trash2, Zap } from 'lucide-react';
import { api } from '../api';
import { Button, Field, NumberInput, Skeleton, StatusBadge, useToast } from '../components/ui';
import { RevenueBars } from '../components/BillingCharts';
import { AccountingInvoice, AccountingSummary, AiGatewayConfig, AiModelPrices, AiPriceSync, AiPriceSyncState, BillingAutomation, BillingProfile, BillingProfileResponse, InvoiceStatus } from '../types';
import { cx, fmtDate, fmtMoney, timeAgo } from '../utils';

const INV_TONE: Record<string, 'neutral' | 'info' | 'ok' | 'warn'> = { draft: 'neutral', issued: 'info', paid: 'ok', void: 'warn' };
const INV_LABEL: Record<string, string> = { draft: 'borrador', issued: 'emitida', paid: 'pagada', void: 'anulada' };
const monthLabel = (t: number) => new Date(t).toLocaleDateString('es', { month: 'short' });

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'acc' | 'warn' }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-subtle">{label}</p>
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
          <h1 className="text-2xl font-semibold">Contabilidad</h1>
          <p className="mt-1.5 text-sm text-sub">Ingresos de tu empresa: lo facturado a los clientes, lo cobrado y lo pendiente</p>
        </div>
        <a href="/api/accounting/export.csv" download className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface2 px-3.5 text-sm font-medium text-txt hover:border-acc/50">
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

          {/* Los importes NO se suman entre divisas: los totales de arriba son los de
              la moneda de la empresa y el resto se desglosa aparte. */}
          {(s!.byCurrency ?? []).filter((b) => b.currency !== cur).length > 0 && (
            <section className="card mt-3 px-4 py-3">
              <h2 className="text-sm font-semibold">Facturación en otras monedas</h2>
              <p className="mt-0.5 text-xs text-subtle">No se suman a los totales de arriba: cada divisa se contabiliza por separado.</p>
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1.5">
                {s!.byCurrency!.filter((b) => b.currency !== cur).map((b) => (
                  <span key={b.currency} className="text-xs tnum">
                    <span className="font-semibold">{b.currency}</span>
                    <span className="text-sub"> · facturado {fmtMoney(b.invoiced, b.currency)} · cobrado {fmtMoney(b.paid, b.currency)} · {b.count} fact.</span>
                  </span>
                ))}
              </div>
            </section>
          )}

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
                    <div key={`${c.workspaceId}-${c.currency ?? cur}`} className={cx('px-4 py-3', i > 0 && 'border-t border-line')}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium">
                          <Building2 size={12} className="shrink-0 text-subtle" /> {c.name}
                        </span>
                        <span className="shrink-0 text-sm font-semibold tnum">{fmtMoney(c.invoiced, c.currency ?? cur)}</span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface2">
                        <div className="h-full rounded-full bg-ok" style={{ width: `${pct}%` }} />
                      </div>
                      <p className="mt-1 text-xs text-subtle tnum">{money(c.paid)} cobrado · {pct}%</p>
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
                      className={cx('shrink-0 rounded-md px-2 py-0.5 text-xs transition-colors', statusFilter === f.key ? 'bg-acc/[.15] font-medium text-acc-soft' : 'text-subtle hover:text-txt')}
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
                        <p className="flex items-center gap-2 text-sm">
                          <span className="font-mono text-xs text-subtle">{inv.number ?? '—'}</span>
                          <span className="truncate">{inv.workspace_name ?? 'Sin cuenta'}</span>
                        </p>
                        <p className="text-xs text-subtle">{fmtDate(inv.period_start)}{inv.payment_method === 'stripe' ? ' · Stripe' : inv.payment_method === 'bank_transfer' ? ' · transferencia' : ''}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-sm font-semibold tnum">{fmtMoney(inv.total_cents, inv.currency)}</span>
                        <StatusBadge tone={INV_TONE[inv.status]} label={INV_LABEL[inv.status]} dot={false} className="text-micro" />
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

      <div className="mt-5">
        <BillingAutomationSettings />
      </div>

      <div className="mt-5">
        <AiGatewaySettings />
      </div>
    </div>
  );
}

/** Interruptor accesible y compacto, en el estilo del panel. */
function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc',
        checked ? 'bg-acc' : 'bg-surface2',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span className={cx('inline-block h-[16px] w-[16px] rounded-full bg-white shadow transition-transform duration-200', checked ? 'translate-x-[19px]' : 'translate-x-[3px]')} />
    </button>
  );
}

/**
 * Automatización de la facturación: cuánto hace Skyway solo (generar el borrador
 * del ciclo, emitirlo) y la política de morosidad. Explicativo a propósito: cada
 * opción dice qué pasa y cuándo. Los valores por defecto son seguros (genera pero
 * no emite sin intervención).
 */
function BillingAutomationSettings() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['billing-automation'], queryFn: () => api.get<{ automation: BillingAutomation }>('/billing/automation') });
  const profile = useQuery({ queryKey: ['billing-profile'], queryFn: () => api.get<BillingProfileResponse>('/billing/profile') });
  const [draft, setDraft] = useState<BillingAutomation | null>(null);
  if (q.data && !draft) setDraft(q.data.automation);

  const save = useMutation({
    mutationFn: () => api.put('/billing/automation', draft),
    onSuccess: () => { toast('Automatización guardada', 'ok'); queryClient.invalidateQueries({ queryKey: ['billing-automation'] }); },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  if (!draft) return <Skeleton className="h-72 w-full" />;
  const set = (patch: Partial<BillingAutomation>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const terms = profile.data?.profile.paymentTermsDays ?? 30;
  const invalid = draft.dunningCancelDays < draft.dunningGraceDays;

  return (
    <section className="card p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold"><CalendarClock size={15} className="text-acc-soft" /> Automatización de facturación</h2>
      <p className="mt-1 max-w-2xl text-xs text-subtle">
        Skyway lleva la facturación recurrente por ti. Aquí decides cuánto hace solo —desde preparar el borrador hasta emitirlo— y qué ocurre cuando un cliente no paga. El scheduler lo revisa cada 10 minutos.
      </p>

      <div className="mt-4 flex flex-col divide-y divide-line rounded-xl border border-line">
        <div className="flex items-start justify-between gap-4 p-3.5">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-medium"><CalendarClock size={14} className="text-subtle" /> Generar el borrador del ciclo automáticamente</p>
            <p className="mt-1 text-xs text-subtle">En el día de facturación de cada cuenta, Skyway reúne el plan, las suscripciones, el uso medido y los pagos únicos pendientes en un borrador de factura (no lo emite).</p>
          </div>
          <Toggle checked={draft.autoGenerate} onChange={(v) => set({ autoGenerate: v })} />
        </div>
        <div className={cx('flex items-start justify-between gap-4 p-3.5', !draft.autoGenerate && 'opacity-60')}>
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-medium"><Zap size={14} className="text-warn" /> Emitir la factura automáticamente</p>
            <p className="mt-1 text-xs text-subtle">Además de generarla, la <b>emite</b>: le asigna número de serie y la bloquea (inmutable). La emisión es un acto legal irreversible; actívalo solo si quieres que cada ciclo se numere y emita sin revisión previa. Apagado: revisas el borrador y lo emites tú.</p>
          </div>
          <Toggle checked={draft.autoIssue} disabled={!draft.autoGenerate} onChange={(v) => set({ autoIssue: v })} />
        </div>
        <div className="flex items-start justify-between gap-4 border-t border-line p-3.5">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-medium"><Send size={14} className="text-info" /> Enviar la factura al cliente al emitirla</p>
            <p className="mt-1 text-xs text-subtle">
              Manda la factura en PDF al email de facturación de la cuenta, en cuanto se emite (a mano o automáticamente).
              Requiere el servidor de correo configurado en «Datos de la empresa». Siempre puedes reenviarla desde la ficha de la cuenta.
            </p>
          </div>
          <Toggle checked={draft.emailOnIssue} onChange={(v) => set({ emailOnIssue: v })} />
        </div>
      </div>

      <h3 className="mt-5 flex items-center gap-2 text-sm font-medium"><Ban size={14} className="text-err" /> Impago (corte progresivo)</h3>
      <p className="mt-1 text-xs text-subtle">
        Una factura emitida y no cobrada vence a los <b className="tnum text-sub">{terms}</b> días (condiciones de pago, en «Datos de la empresa»). Contando desde ese vencimiento:
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Días para suspender el servicio" hint="suspende las claves de IA y pausa las suscripciones; reversible al pagar">
          <NumberInput className="input tnum" min={0} max={365} value={draft.dunningGraceDays} onChange={(v) => set({ dunningGraceDays: v })} />
        </Field>
        <Field label="Días para cancelar la cuenta" hint="revoca las claves y cancela las suscripciones; requiere alta manual">
          <NumberInput className={cx('input tnum', invalid && 'border-err')} min={0} max={365} value={draft.dunningCancelDays} onChange={(v) => set({ dunningCancelDays: v })} />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-subtle">
        <span className="rounded bg-surface2 px-2 py-0.5">Vence a +{terms}d</span>
        <span className="text-line">→</span>
        <span className="rounded bg-warn/[.15] px-2 py-0.5 text-warn">Aviso al vencer</span>
        <span className="text-line">→</span>
        <span className="rounded bg-warn/[.15] px-2 py-0.5 text-warn">Suspensión +{draft.dunningGraceDays}d</span>
        <span className="text-line">→</span>
        <span className="rounded bg-err/[.15] px-2 py-0.5 text-err">Cancelación +{draft.dunningCancelDays}d</span>
      </div>
      {invalid && <p className="mt-2 text-xs text-err">Los días para cancelar deben ser ≥ los días para suspender.</p>}

      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-xs text-subtle">Al cobrarse una factura vencida, el servicio se reactiva solo (salvo cuentas ya canceladas, que requieren alta manual).</p>
        <Button size="sm" onClick={() => save.mutate()} loading={save.isPending} disabled={invalid}>Guardar</Button>
      </div>
    </section>
  );
}

/** Configuración del gateway de IA: clave de Gemini del operador y modelos permitidos. */
function AiGatewaySettings() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['ai-gateway-config'], queryFn: () => api.get<AiGatewayConfig>('/ai/gateway/config') });
  const [key, setKey] = useState('');
  const [models, setModels] = useState('');
  const [loaded, setLoaded] = useState(false);
  if (q.data && !loaded) { setModels(q.data.allowedModels.join(', ')); setLoaded(true); }

  const save = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = { allowedModels: models.split(',').map((m) => m.trim()).filter(Boolean) };
      if (key.trim()) payload.geminiApiKey = key.trim();
      return api.put('/ai/gateway/config', payload);
    },
    onSuccess: () => { toast('Gateway de IA guardado', 'ok'); setKey(''); queryClient.invalidateQueries({ queryKey: ['ai-gateway-config'] }); },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  if (!q.data) return <Skeleton className="h-48 w-full" />;
  return (
    <>
      <section className="card p-5">
        <h2 className="text-base font-semibold">Gateway de IA (Gemini)</h2>
        <p className="mt-1 text-xs text-subtle">
          Tu clave de Google Gemini. Skyway proxya las peticiones de los clientes con ella (nunca se expone), mide los tokens y los factura por cuenta. Cada cliente usa una clave <span className="font-mono">skai_…</span> propia, revocable. Admite <span className="font-mono">generateContent</span>, streaming SSE y API compatible con OpenAI.
        </p>
        <div className="mt-4 grid gap-3">
          <Field label="Clave de Gemini (API key de Google AI)" hint={q.data.hasGeminiKey ? 'ya configurada; vacío = no cambiar' : 'necesaria para que el proxy funcione'}>
            <input className="input font-mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={q.data.hasGeminiKey ? '•••••••• configurada' : 'AIza…'} />
          </Field>
          <Field label="Modelos permitidos" hint="separados por comas; los de imagen u otros quedan fuera a propósito">
            <textarea className="input min-h-16 font-mono text-xs" value={models} onChange={(e) => setModels(e.target.value)} placeholder="gemini-2.5-flash, gemini-2.5-pro" />
          </Field>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <p className="text-xs text-subtle">Los precios de venta se definen como productos de categoría IA en el <a href="/catalog" className="text-acc-soft hover:underline">catálogo</a>.</p>
          <Button size="sm" onClick={() => save.mutate()} loading={save.isPending}>Guardar</Button>
        </div>
      </section>
      <ModelCostMargin allowedModels={q.data.allowedModels} />
    </>
  );
}

/**
 * «Cuánto ganas por modelo»: calculadora de beneficio para revender IA. El operador
 * escribe lo que le cuesta cada modelo en Google y el margen que quiere; la tarjeta
 * muestra el precio de venta y el beneficio, con una barra coste/beneficio. Es una
 * guía de precios (el PVP real se fija en el catálogo); no interviene en la factura.
 */
const COST_TYPES = [
  { key: 'out' as const, label: 'Salida', hint: 'lo que responde el modelo' },
  { key: 'in' as const, label: 'Entrada', hint: 'el prompt que envías' },
  { key: 'cache' as const, label: 'Caché', hint: 'contexto cacheado, más barato' },
];

const usdM = (n: number) => n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const CUR_SYM: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };

function ModelCostMargin({ allowedModels }: { allowedModels: string[] }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['ai-model-prices'], queryFn: () => api.get<AiModelPrices>('/ai/gateway/prices') });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const save = useMutation({
    mutationFn: (model: string) => {
      const d = drafts[model] ?? EMPTY_DRAFT;
      const toCents = (v: string) => Math.max(0, Math.round((parseFloat(v.replace(',', '.')) || 0) * 100 * 100) / 100);
      return api.put(`/ai/gateway/prices/${encodeURIComponent(model)}`, {
        costCentsMtokIn: toCents(d.in), costCentsMtokCache: toCents(d.cache), costCentsMtokOut: toCents(d.out),
        marginPct: Math.max(0, Math.min(95, parseFloat(d.margin.replace(',', '.')) || 0)),
      });
    },
    onSuccess: () => { toast('Precio del modelo guardado', 'ok'); queryClient.invalidateQueries({ queryKey: ['ai-model-prices'] }); },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const del = useMutation({
    mutationFn: (model: string) => api.del(`/ai/gateway/prices/${encodeURIComponent(model)}`),
    onSuccess: (_r, model: string) => {
      toast('Modelo restablecido: vuelve a la tarifa automática', 'ok');
      setDrafts((prev) => { const next = { ...prev }; delete next[model]; return next; });
      queryClient.invalidateQueries({ queryKey: ['ai-model-prices'] });
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  // Refresco de la tarifa: al terminar se tiran los borradores locales, porque si
  // no las tarjetas seguirían enseñando el coste viejo que el operador tecleó.
  const sync = useMutation({
    mutationFn: () => api.post<AiPriceSync>('/ai/gateway/prices/sync', {}),
    onSuccess: (r) => {
      setDrafts({});
      queryClient.invalidateQueries({ queryKey: ['ai-model-prices'] });
      if (!r.ok) return toast(r.error || 'No se pudo actualizar la tarifa', 'err');
      const changed = r.added.length + r.updated.length;
      toast(changed ? `Tarifa actualizada (${changed} modelo${changed > 1 ? 's' : ''}, fuente ${r.source})` : 'La tarifa ya estaba al día', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const cfg = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.put('/ai/gateway/prices/config', patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-model-prices'] }),
    onError: (err: Error) => toast(err.message, 'err'),
  });

  if (!q.data) return <Skeleton className="h-40 w-full" />;
  const s = q.data.sync;
  const byModel = new Map(q.data.models.map((m) => [m.model, m]));
  const num = (v: string) => parseFloat(v.replace(',', '.')) || 0;
  const cur = (currency: string) => CUR_SYM[currency] ?? currency;
  const eurMd = (perM: number, currency = s.currency) =>
    `${perM.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${cur(currency)}/M`;
  const draftFor = (model: string): Draft => {
    const d = drafts[model];
    if (d) return d;
    const c = byModel.get(model);
    // céntimos/Mtok → unidades/Mtok redondeando a la millonésima: dividir entre 100
    // en coma flotante deja restos («0,0263689999…») en el campo de texto.
    const perM = (cents: number) => String(Math.round(cents * 1e4) / 1e6);
    return c
      ? { in: perM(c.cost_cents_mtok_in), cache: perM(c.cost_cents_mtok_cache), out: perM(c.cost_cents_mtok_out), margin: c.margin_pct ? String(c.margin_pct) : '' }
      : { ...EMPTY_DRAFT };
  };
  const setDraft = (model: string, patch: Partial<Draft>) =>
    setDrafts((prev) => ({ ...prev, [model]: { ...draftFor(model), ...patch } }));
  // Precio de venta para un margen sobre venta: precio = coste/(1−m/100). En €/M.
  const priceOf = (cost: number, margin: number): number | null => (cost > 0 && margin > 0 && margin < 100 ? cost / (1 - margin / 100) : null);

  const rows = allowedModels.length ? allowedModels : q.data.models.map((m) => m.model);
  return (
    <section className="card p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold"><Coins size={15} className="text-ok" /> Cuánto ganas por modelo</h2>
      <p className="mt-1 max-w-2xl text-xs text-subtle">
        Skyway trae el coste de cada modelo desde la tarifa vigente de Google; tú pones el margen que quieres. Te decimos a qué precio venderlo y cuánto ganas por millón de tokens. Después pon ese precio en el producto de IA del <a href="/catalog" className="text-acc-soft hover:underline">catálogo</a> para cobrarlo.
      </p>

      <PriceSyncBar
        sync={s}
        onRefresh={() => sync.mutate()}
        refreshing={sync.isPending}
        onConfig={(patch) => cfg.mutate(patch)}
        savingConfig={cfg.isPending}
      />

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {rows.map((model) => {
          const d = draftFor(model);
          const existing = byModel.get(model);
          const margin = num(d.margin);
          const costOut = num(d.out);
          const priceOut = priceOf(costOut, margin);
          const profitOut = priceOut != null ? priceOut - costOut : null;
          const costFrac = priceOut && priceOut > 0 ? Math.min(1, costOut / priceOut) : 1;
          const ref = q.data.list_usd[model];
          const currency = existing?.currency ?? s.currency;
          return (
            <div key={model} className="rounded-xl border border-line bg-bg/40 p-4">
              {/* Cabecera: modelo + beneficio como cifra protagonista. */}
              <div className="flex items-start justify-between gap-3">
                <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="font-mono text-sm">{model}</span>
                  {existing && (
                    <span
                      className={cx('rounded px-1.5 py-0.5 text-micro leading-none', existing.source === 'auto' ? 'bg-info/[.15] text-info' : 'bg-surface2 text-subtle')}
                      title={
                        existing.source === 'auto'
                          ? `Coste tomado de la tarifa de Google${existing.synced_at ? ` (${timeAgo(existing.synced_at)})` : ''}. Si lo editas, pasa a manual.`
                          : 'Coste fijado por ti: la actualización automática no lo toca. Restablece el modelo para volver al automático.'
                      }
                    >
                      {existing.source === 'auto' ? 'auto' : 'manual'}
                    </span>
                  )}
                </span>
                <div className="text-right">
                  {profitOut != null ? (
                    <>
                      <p className="tnum text-lg font-semibold leading-none text-ok">{eurMd(profitOut, currency)}</p>
                      <p className="mt-1 eyebrow text-subtle">ganas en salida</p>
                    </>
                  ) : (
                    <p className="text-xs text-subtle">Añade coste y margen</p>
                  )}
                </div>
              </div>

              {/* Barra coste vs beneficio (sobre el precio de salida). */}
              <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-surface2" title="Reparto del precio de salida entre coste y beneficio">
                <div className="h-full bg-subtle/50" style={{ width: `${costFrac * 100}%` }} />
                <div className="h-full bg-ok" style={{ width: `${(1 - costFrac) * 100}%` }} />
              </div>
              <div className="mt-1 flex justify-between text-micro text-subtle">
                <span>Coste {costOut > 0 ? eurMd(costOut, currency) : '—'}</span>
                <span className="text-ok">Beneficio {profitOut != null ? eurMd(profitOut, currency) : '—'}</span>
              </div>

              {/* Margen: deslizador (simple) + valor exacto. */}
              <div className="mt-4 flex items-center gap-3">
                <span className="w-16 shrink-0 text-xs text-subtle">Margen</span>
                <input type="range" min={0} max={90} step={1} value={Math.min(90, Math.round(margin))} onChange={(e) => setDraft(model, { margin: e.target.value })} className="h-1.5 flex-1 accent-acc" />
                <div className="relative">
                  <input className="input h-8 w-16 tnum pr-6 text-right" inputMode="decimal" value={d.margin} onChange={(e) => setDraft(model, { margin: e.target.value })} placeholder="0" />
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-subtle">%</span>
                </div>
              </div>

              {/* Coste → precio de venta, por tipo de token. */}
              <div className="mt-3 grid grid-cols-[64px_1fr_1fr] items-center gap-x-2 gap-y-1.5">
                <span />
                <span className="eyebrow text-subtle">Te cuesta {cur(currency)}/M</span>
                <span className="text-right eyebrow text-subtle">Vendes a</span>
                {COST_TYPES.map((t) => {
                  const price = priceOf(num(d[t.key]), margin);
                  return (
                    <Fragment key={t.key}>
                      <span className="text-xs text-subtle" title={t.hint}>{t.label}</span>
                      <input className="input h-8 tnum" inputMode="decimal" value={d[t.key]} onChange={(e) => setDraft(model, { [t.key]: e.target.value })} placeholder="0" />
                      <span className="tnum text-right text-sm text-acc-soft">{price == null ? '—' : eurMd(price, currency)}</span>
                    </Fragment>
                  );
                })}
              </div>

              {/* Precio de lista de Google (referencia en USD) para comparar con tu coste. */}
              {ref && (
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-micro text-subtle">
                  <span className="eyebrow">Lista Google · $/M</span>
                  <span className="tnum">entrada {usdM(ref.in)} · caché {usdM(ref.cache)} · salida {usdM(ref.out)}</span>
                  <button className="text-acc-soft hover:underline" title="Copiar estos precios a los campos de coste (ajústalos a tu coste real en €)" onClick={() => setDraft(model, { in: String(ref.in), cache: String(ref.cache), out: String(ref.out) })}>usar</button>
                </div>
              )}

              <div className="mt-3 flex items-center justify-end gap-1 border-t border-line/60 pt-3">
                {existing && (
                  <button
                    className="mr-auto rounded p-1.5 text-subtle hover:text-err"
                    title={existing.source === 'manual' ? 'Descartar tu coste y volver a la tarifa automática de Google' : 'Borrar el coste guardado (la próxima actualización lo repone)'}
                    onClick={() => del.mutate(model)}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
                <Button size="sm" onClick={() => save.mutate(model)} loading={save.isPending && save.variables === model}>Guardar</Button>
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-subtle">
        «Lista Google» es la tarifa publicada en USD, antes de convertir a {s.currency}; tu coste real puede variar por volumen o por acuerdos con Google. Consulta el precio vigente en <a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" rel="noopener noreferrer" className="text-acc-soft hover:underline">ai.google.dev</a>.
      </p>
    </section>
  );
}

/**
 * Estado de la autoactualización de la tarifa: cuándo se miró por última vez, de
 * dónde salió el precio y qué se quedó fuera. Lo que no se puede resolver solo
 * (un modelo sin tarifa publicada, un cambio de divisa sin red) se dice aquí en
 * vez de dejar que el margen mienta en silencio.
 */
function PriceSyncBar({
  sync,
  onRefresh,
  refreshing,
  onConfig,
  savingConfig,
}: {
  sync: AiPriceSyncState;
  onRefresh: () => void;
  refreshing: boolean;
  onConfig: (patch: Record<string, unknown>) => void;
  savingConfig: boolean;
}) {
  // Ambos campos se escriben en un borrador y se envían al salir: cada tecla no
  // puede ser un PUT.
  const [fx, setFx] = useState('');
  const [margin, setMargin] = useState('');
  const last = sync.last;
  const failed = !!last && !last.ok;
  return (
    <div className="mt-4 rounded-xl border border-line bg-bg/40 p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium">
            <RefreshCw size={14} className={cx('text-info', refreshing && 'animate-spin')} /> Tarifa de Google al día
          </p>
          <p className="mt-1 text-xs text-subtle">
            {sync.lastAt ? (
              <>
                Última comprobación {timeAgo(sync.lastAt)}
                {last && last.ok && (
                  <>
                    {' '}· fuente <span className="text-sub">{last.source}</span>
                    {/* Sin salida a internet el coste viene del catálogo interno: su fecha dice cómo de viejo es. */}
                    {last.source === 'catálogo' && <> ({sync.catalogDate})</>}
                  </>
                )}
                {sync.auto && <> · se repite sola cada día</>}
              </>
            ) : (
              <>Todavía sin comprobar. Se hará sola en cuanto arranque el ciclo diario, o púlsalo ahora.</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Toggle checked={sync.auto} onChange={(v) => onConfig({ auto: v })} />
          <Button size="sm" variant="secondary" onClick={onRefresh} loading={refreshing}>Actualizar ahora</Button>
        </div>
      </div>

      {failed && <p className="mt-2 text-xs text-err">{last?.error}</p>}

      {last && last.ok && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
          {!!last.updated.length && <span className="rounded bg-ok/[.15] px-2 py-0.5 text-ok">{last.updated.length} actualizado(s)</span>}
          {!!last.added.length && <span className="rounded bg-info/[.15] px-2 py-0.5 text-info">{last.added.length} nuevo(s)</span>}
          {!!last.manual.length && <span className="rounded bg-surface2 px-2 py-0.5" title={last.manual.join(', ')}>{last.manual.length} a mano (respetado)</span>}
          {!!last.missing.length && (
            <span className="rounded bg-warn/[.15] px-2 py-0.5 text-warn" title="Google no publica tarifa por token para estos modelos; su coste se queda como esté">
              sin tarifa: {last.missing.join(', ')}
            </span>
          )}
        </div>
      )}

      {!!last?.discovered.length && (
        <p className="mt-2 text-xs text-warn">
          Modelos nuevos en Google con tarifa conocida: <span className="font-mono">{last.discovered.join(', ')}</span>. Añádelos arriba en «Modelos permitidos» si quieres venderlos.
        </p>
      )}

      <label className="mt-2 flex items-center gap-2 text-xs text-subtle">
        <input type="checkbox" className="accent-acc" checked={sync.autoAllow} onChange={(e) => onConfig({ autoAllow: e.target.checked })} disabled={savingConfig} />
        Permitir solos los modelos nuevos que Google publique con tarifa conocida (si no, solo se avisa)
      </label>

      {/* Los dos ajustes que la automatización no puede adivinar. */}
      <div className="mt-3 grid gap-3 border-t border-line/60 pt-3 sm:grid-cols-2">
        <Field label={`Cambio 1 USD → ${sync.currency}`} hint={sync.fxAt ? `referencia del BCE, ${timeAgo(sync.fxAt)}` : 'sin cambio guardado: fíjalo si el servidor no sale a internet'}>
          <input
            className="input h-8 tnum"
            inputMode="decimal"
            value={fx}
            onChange={(e) => setFx(e.target.value)}
            onBlur={() => {
              const v = parseFloat(fx.replace(',', '.'));
              if (fx.trim() && v > 0) onConfig({ fxRate: v });
              setFx('');
            }}
            placeholder={sync.fxRate ? String(sync.fxRate) : '0,92'}
            disabled={savingConfig}
          />
        </Field>
        <Field label="Margen para modelos nuevos" hint="el que se estrena cuando aparece un modelo; los que ya tienen margen lo conservan">
          <div className="relative">
            <input
              className="input h-8 tnum pr-6"
              inputMode="decimal"
              value={margin}
              onChange={(e) => setMargin(e.target.value)}
              onBlur={() => {
                const v = parseFloat(margin.replace(',', '.'));
                if (margin.trim() && v >= 0 && v <= 95 && v !== sync.defaultMarginPct) onConfig({ defaultMarginPct: v });
                setMargin('');
              }}
              placeholder={String(sync.defaultMarginPct)}
              disabled={savingConfig}
            />
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-subtle">%</span>
          </div>
        </Field>
      </div>
    </div>
  );
}

interface Draft { in: string; cache: string; out: string; margin: string }
const EMPTY_DRAFT: Draft = { in: '', cache: '', out: '', margin: '' };

interface ProfileDraft extends BillingProfile {
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  stripePublishableKey: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  smtpFromName: string;
}

function CompanyProfile() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['billing-profile'], queryFn: () => api.get<BillingProfileResponse>('/billing/profile') });
  const [draft, setDraft] = useState<ProfileDraft | null>(null);

  // Sincroniza el borrador local cuando llegan los datos (una vez).
  if (q.data && !draft) {
    setDraft({
      ...q.data.profile,
      stripeSecretKey: '', stripeWebhookSecret: '', stripePublishableKey: q.data.stripe.publishableKey,
      smtpHost: q.data.smtp.host, smtpPort: q.data.smtp.port, smtpSecure: q.data.smtp.secure,
      smtpUser: q.data.smtp.user, smtpPass: '', smtpFrom: q.data.smtp.from, smtpFromName: q.data.smtp.fromName,
    });
  }

  const test = useMutation({
    mutationFn: () => {
      const d = draft!;
      // Se prueba lo que hay EN PANTALLA, para poder validar antes de guardar; la
      // contraseña vacía significa «usa la ya guardada», no «sin contraseña».
      const payload: Record<string, unknown> = {
        host: d.smtpHost, port: d.smtpPort, secure: d.smtpSecure, user: d.smtpUser,
        from: d.smtpFrom, fromName: d.smtpFromName,
      };
      if (d.smtpPass.trim()) payload.pass = d.smtpPass.trim();
      return api.post('/billing/smtp/test', payload);
    },
    onSuccess: () => toast('Conexión con el servidor de correo correcta', 'ok'),
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const save = useMutation({
    mutationFn: () => {
      const d = draft!;
      const payload: Record<string, unknown> = {
        companyName: d.companyName, taxId: d.taxId, address: d.address, email: d.email, phone: d.phone,
        currency: d.currency, vatRate: d.vatRate, invoicePrefix: d.invoicePrefix, paymentTermsDays: d.paymentTermsDays,
        defaultIrpfRate: d.defaultIrpfRate, sifMode: d.sifMode,
        iban: d.iban, bic: d.bic, bankName: d.bankName, footer: d.footer, stripePublishableKey: d.stripePublishableKey,
        smtpHost: d.smtpHost, smtpPort: d.smtpPort, smtpSecure: d.smtpSecure, smtpUser: d.smtpUser,
        smtpFrom: d.smtpFrom, smtpFromName: d.smtpFromName,
      };
      // Las claves secretas solo se envían si se han escrito (no se sobreescriben con vacío por error).
      if (d.stripeSecretKey.trim()) payload.stripeSecretKey = d.stripeSecretKey.trim();
      if (d.stripeWebhookSecret.trim()) payload.stripeWebhookSecret = d.stripeWebhookSecret.trim();
      if (d.smtpPass.trim()) payload.smtpPass = d.smtpPass.trim();
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
          <Field label="IVA por defecto (%)"><NumberInput className="input tnum" min={0} max={100} value={draft.vatRate} onChange={(v) => set({ vatRate: v })} /></Field>
          <Field label="IRPF por defecto (%)" hint="0 si eres sociedad"><NumberInput className="input tnum" min={0} max={100} value={draft.defaultIrpfRate} onChange={(v) => set({ defaultIrpfRate: v })} /></Field>
          {/* El registro encadenado (invoice_ledger) está creado como reserva, pero
              la huella, el QR y la remisión a la AEAT aún no se implementan: el
              selector solo deja constancia de la intención, no activa nada. */}
          <Field label="Modo Verifactu" hint="Preparado, aún no operativo">
            <select className="input" value={draft.sifMode} onChange={(e) => set({ sifMode: e.target.value as BillingProfile['sifMode'] })}>
              <option value="no_verifactu">No Verifactu (local)</option>
              <option value="verifactu">Verifactu (AEAT) — pendiente de activar</option>
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

        <section className="card p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Send size={15} className="text-info" /> Correo saliente (envío de facturas)</h2>
          <p className="mt-1 text-xs text-subtle">
            Servidor SMTP con el que se envía la factura en PDF al email de facturación del cliente.
          </p>
          <div className="mt-4 grid gap-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_100px]">
              <Field label="Servidor"><input className="input" value={draft.smtpHost} onChange={(e) => set({ smtpHost: e.target.value })} placeholder="smtp.tuproveedor.com" /></Field>
              <Field label="Puerto"><NumberInput className="input tnum" min={1} max={65535} value={draft.smtpPort} emptyValue={587} onChange={(v) => set({ smtpPort: v })} /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.smtpSecure} onChange={(e) => set({ smtpSecure: e.target.checked })} />
              <span>TLS directo (puerto 465). Desmarcado usa STARTTLS si el servidor lo ofrece.</span>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Usuario"><input className="input" value={draft.smtpUser} onChange={(e) => set({ smtpUser: e.target.value })} /></Field>
              <Field label="Contraseña" hint={q.data.smtp.hasPassword ? 'ya configurada; vacío = no cambiar' : ''}>
                <input className="input font-mono" type="password" value={draft.smtpPass} onChange={(e) => set({ smtpPass: e.target.value })} placeholder={q.data.smtp.hasPassword ? '•••••••• configurada' : ''} />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Remitente" hint="Debe estar autorizado por el servidor"><input className="input" type="email" value={draft.smtpFrom} onChange={(e) => set({ smtpFrom: e.target.value })} placeholder="facturacion@tuempresa.com" /></Field>
              <Field label="Nombre del remitente"><input className="input" value={draft.smtpFromName} onChange={(e) => set({ smtpFromName: e.target.value })} placeholder="Facturación Skyway" /></Field>
            </div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-subtle">La prueba conecta y autentica, sin enviar ningún correo.</p>
              <Button size="sm" variant="secondary" loading={test.isPending} onClick={() => test.mutate()}>Probar conexión</Button>
            </div>
          </div>
        </section>

        <div className="flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-xs text-subtle"><Receipt size={12} /> Numeración correlativa por serie y ejercicio</p>
          <Button onClick={() => save.mutate()} loading={save.isPending}>Guardar</Button>
        </div>
      </div>
    </div>
  );
}
