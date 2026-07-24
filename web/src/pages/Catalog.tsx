import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { Button, ConfirmModal, Field, Modal, Skeleton, StatusBadge, useToast } from '../components/ui';
import { BillingModel, Product, ProductCategory, UsageMeter } from '../types';
import { cx, fmtMoney } from '../utils';

const CATS: Record<ProductCategory, string> = {
  web: 'Web', ia: 'IA', app: 'App', hosting: 'Hosting', bbdd: 'BBDD', dominio: 'Dominio', soporte: 'Soporte', custom: 'A medida',
};
const CAT_ORDER: ProductCategory[] = ['web', 'ia', 'app', 'hosting', 'bbdd', 'dominio', 'soporte', 'custom'];
const MODELS: Record<BillingModel, string> = { flat_one_off: 'Pago único', subscription: 'Suscripción', metered: 'Por uso', tiered: 'Por tramos' };
/** Explicación de cada modelo de precio (se muestra bajo el selector, para que quede claro cómo se cobra). */
const MODEL_HELP: Record<BillingModel, string> = {
  flat_one_off: 'Pago único: se cobra una sola vez. En una cuenta se añade con «Pago único» y aparece una vez en la próxima factura (no se repite).',
  subscription: 'Suscripción: cuota fija recurrente que se cobra cada mes o cada año mientras esté activa.',
  metered: 'Por uso: se cobra según el consumo medido en el ciclo (tokens de IA, CPU·h, unidades…), con un precio por unidad.',
  tiered: 'Por tramos: el precio por unidad cambia según el volumen consumido (progresivo o por volumen).',
};
const METERS: Record<UsageMeter, string> = {
  cpu_core_hour: 'CPU núcleo·h', mem_gb_hour: 'RAM GB·h', ai_tokens_in: 'IA tokens entrada', ai_tokens_cache_in: 'IA tokens entrada (caché)',
  ai_tokens_out: 'IA tokens salida', ai_requests: 'IA peticiones', ai_bytes: 'IA bytes', unit: 'Unidad',
};

function priceSummary(p: Product): string {
  if (p.billing_model === 'subscription') return `${fmtMoney(p.price_cents, p.currency)}/${p.interval === 'yearly' ? 'año' : 'mes'}`;
  if (p.billing_model === 'metered') return `${fmtMoney(p.price_cents, p.currency)}/${p.unit || 'ud'}`;
  if (p.billing_model === 'tiered') return `por tramos · ${p.unit || 'ud'}`;
  return `${fmtMoney(p.price_cents, p.currency)} · pago único`;
}

interface TierDraft {
  upTo: string; // '' = último tramo (sin tope)
  unitUnits: string; // precio por unidad, en la moneda
}

interface Draft {
  id?: string;
  name: string;
  category: ProductCategory;
  billingModel: BillingModel;
  priceUnits: string;
  currency: string;
  interval: 'monthly' | 'yearly';
  unit: string;
  unitSize: string;
  meter: UsageMeter | '';
  tierMode: 'graduated' | 'volume';
  taxRate: string;
  irpfRate: string;
  taxExempt: boolean;
  description: string;
  active: boolean;
  tiers: TierDraft[];
}

const EMPTY: Draft = {
  name: '', category: 'web', billingModel: 'subscription', priceUnits: '0', currency: 'EUR', interval: 'monthly',
  unit: 'mes', unitSize: '1', meter: 'ai_tokens_out', tierMode: 'graduated', taxRate: '21', irpfRate: '0', taxExempt: false,
  description: '', active: true, tiers: [{ upTo: '', unitUnits: '0' }],
};

function fromProduct(p: Product): Draft {
  return {
    id: p.id, name: p.name, category: p.category, billingModel: p.billing_model,
    priceUnits: String(p.price_cents / 100), currency: p.currency,
    interval: p.interval === 'yearly' ? 'yearly' : 'monthly', unit: p.unit, unitSize: String(p.unit_size || 1),
    meter: p.meter ?? 'ai_tokens_out', tierMode: p.tier_mode ?? 'graduated',
    taxRate: String(p.tax_rate), irpfRate: String(p.irpf_rate), taxExempt: !!p.tax_exempt,
    description: p.description ?? '', active: !!p.active,
    tiers: p.tiers.length ? p.tiers.map((t) => ({ upTo: t.up_to === null ? '' : String(t.up_to), unitUnits: String(t.unit_cents / 100) })) : [{ upTo: '', unitUnits: '0' }],
  };
}

export default function CatalogPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['products'], queryFn: () => api.get<{ products: Product[] }>('/products') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toDelete, setToDelete] = useState<Product | null>(null);
  const isEdit = !!draft?.id;
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['products'] });

  const save = useMutation({
    mutationFn: () => {
      const d = draft!;
      const metered = d.billingModel === 'metered' || d.billingModel === 'tiered';
      const payload: Record<string, unknown> = {
        name: d.name.trim(),
        category: d.category,
        billingModel: d.billingModel,
        priceCents: Math.round(Number(d.priceUnits) * 100) || 0,
        currency: d.currency.trim().toUpperCase() || 'EUR',
        interval: d.billingModel === 'subscription' ? d.interval : d.billingModel === 'flat_one_off' ? 'one_off' : 'metered',
        unit: d.unit.trim(),
        unitSize: metered ? Number(d.unitSize) || 1 : 1,
        meter: metered ? d.meter || null : null,
        tierMode: d.billingModel === 'tiered' ? d.tierMode : null,
        taxRate: Number(d.taxRate) || 0,
        irpfRate: Number(d.irpfRate) || 0,
        taxExempt: d.taxExempt,
        description: d.description.trim() || null,
        active: d.active,
      };
      if (d.billingModel === 'tiered') {
        payload.tiers = d.tiers
          .filter((t) => t.unitUnits !== '')
          .map((t) => ({ upTo: t.upTo.trim() ? Number(t.upTo) : null, unitCents: Math.round(Number(t.unitUnits) * 100) || 0, flatCents: 0 }));
      }
      return d.id ? api.patch(`/products/${d.id}`, payload) : api.post('/products', payload);
    },
    onSuccess: () => { toast(isEdit ? 'Producto actualizado' : 'Producto creado', 'ok'); setDraft(null); invalidate(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del<{ archived?: boolean }>(`/products/${id}`),
    onSuccess: (res) => { toast(res.archived ? 'Producto archivado (estaba en uso)' : 'Producto eliminado', 'ok'); setToDelete(null); invalidate(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setTier = (i: number, patch: Partial<TierDraft>) => setDraft((d) => (d ? { ...d, tiers: d.tiers.map((t, idx) => (idx === i ? { ...t, ...patch } : t)) } : d));

  const list = q.data?.products ?? [];
  const byCat = CAT_ORDER.map((c) => ({ cat: c, items: list.filter((p) => p.category === c) })).filter((g) => g.items.length);
  const metered = draft && (draft.billingModel === 'metered' || draft.billingModel === 'tiered');

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-7 sm:px-6 sm:py-10">
      <Link to="/workspaces" className="mb-4 inline-flex items-center gap-1.5 text-xs text-subtle hover:text-txt">
        <ArrowLeft size={13} /> Cuentas y clientes
      </Link>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-.02em]">Catálogo</h1>
          <p className="mt-1.5 text-sm text-sub">Los servicios que facturas: web, IA, hosting, bases de datos, dominios, soporte… con su modelo de precio. Se contratan por cuenta.</p>
        </div>
        <Button onClick={() => setDraft({ ...EMPTY })}>
          <Plus size={15} /> Nuevo producto
        </Button>
      </div>

      {q.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : byCat.length === 0 ? (
        <div className="card p-10 text-center text-sm text-subtle">Sin productos todavía. Crea el primero para empezar a facturar servicios.</div>
      ) : (
        <div className="flex flex-col gap-6">
          {byCat.map((g) => (
            <section key={g.cat}>
              <h2 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[.09em] text-subtle">{CATS[g.cat]}</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
                {g.items.map((p) => (
                  <div key={p.id} className={cx('card p-4', !!p.archived && 'opacity-60')}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="truncate text-[14px] font-semibold">{p.name}</h3>
                        <p className="mt-0.5 text-[13px] text-sub tnum">{priceSummary(p)}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button onClick={() => setDraft(fromProduct(p))} className="rounded-md p-1.5 text-subtle hover:bg-surface2 hover:text-txt" title="Editar"><Pencil size={14} /></button>
                        <button onClick={() => setToDelete(p)} className="rounded-md p-1.5 text-subtle hover:bg-err/[.12] hover:text-err" title={p.in_use ? 'En uso: se archivará' : 'Eliminar'}><Trash2 size={14} /></button>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px]">
                      <StatusBadge tone="info" label={MODELS[p.billing_model]} dot={false} className="text-[10px]" />
                      {p.meter && <span className="rounded border border-line bg-bg px-1.5 py-0.5 text-subtle">{METERS[p.meter]}</span>}
                      {p.tax_exempt ? <span className="text-subtle">exento IVA</span> : <span className="text-subtle">IVA {p.tax_rate}%</span>}
                      {!!p.archived && <span className="text-warn">archivado</span>}
                      {p.in_use && !p.archived && <span className="text-subtle">· contratado</span>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <Modal open={!!draft} onClose={() => setDraft(null)} title={isEdit ? `Editar ${draft?.name || 'producto'}` : 'Nuevo producto'} wide>
        {draft && (
          <div className="flex flex-col gap-3.5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="col-span-2"><Field label="Nombre"><input className="input" value={draft.name} onChange={(e) => set({ name: e.target.value })} autoFocus placeholder="Hosting Pro, IA GPT-4o…" /></Field></div>
              <Field label="Categoría">
                <select className="input" value={draft.category} onChange={(e) => set({ category: e.target.value as ProductCategory })}>
                  {CAT_ORDER.map((c) => <option key={c} value={c}>{CATS[c]}</option>)}
                </select>
              </Field>
              <Field label="Modelo">
                <select className="input" value={draft.billingModel} onChange={(e) => set({ billingModel: e.target.value as BillingModel })}>
                  {(Object.keys(MODELS) as BillingModel[]).map((m) => <option key={m} value={m}>{MODELS[m]}</option>)}
                </select>
              </Field>
            </div>

            <p className="rounded-md border border-line bg-bg px-3 py-2 text-[12px] text-sub">{MODEL_HELP[draft.billingModel]}</p>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {draft.billingModel !== 'tiered' && (
                <Field label={draft.billingModel === 'metered' ? 'Precio / unidad' : 'Precio'}><input className="input tnum" type="number" min={0} step="0.01" value={draft.priceUnits} onChange={(e) => set({ priceUnits: e.target.value })} /></Field>
              )}
              <Field label="Moneda"><input className="input" maxLength={3} value={draft.currency} onChange={(e) => set({ currency: e.target.value })} /></Field>
              <Field label="Unidad" hint="mes, 1k tokens, hora…"><input className="input" value={draft.unit} onChange={(e) => set({ unit: e.target.value })} /></Field>
              {draft.billingModel === 'subscription' && (
                <Field label="Periodo">
                  <select className="input" value={draft.interval} onChange={(e) => set({ interval: e.target.value as 'monthly' | 'yearly' })}>
                    <option value="monthly">Mensual</option>
                    <option value="yearly">Anual</option>
                  </select>
                </Field>
              )}
            </div>

            {metered && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label="Medidor">
                  <select className="input" value={draft.meter} onChange={(e) => set({ meter: e.target.value as UsageMeter })}>
                    {(Object.keys(METERS) as UsageMeter[]).map((m) => <option key={m} value={m}>{METERS[m]}</option>)}
                  </select>
                </Field>
                <Field label="Precio por cada" hint="unidades del medidor · 1000000 = por 1M tokens">
                  <input className="input tnum" type="number" min={1} step={1} value={draft.unitSize} onChange={(e) => set({ unitSize: e.target.value })} />
                </Field>
                {draft.billingModel === 'tiered' && (
                  <Field label="Modo de tramos">
                    <select className="input" value={draft.tierMode} onChange={(e) => set({ tierMode: e.target.value as 'graduated' | 'volume' })}>
                      <option value="graduated">Progresivo</option>
                      <option value="volume">Por volumen</option>
                    </select>
                  </Field>
                )}
              </div>
            )}

            {draft.billingModel === 'tiered' && (
              <Field label="Tramos de precio" hint="«hasta» vacío = último tramo (sin tope)">
                <div className="flex flex-col gap-1.5">
                  <div className="grid grid-cols-[1fr_1fr_28px] items-center gap-2 px-1 text-[11px] text-subtle">
                    <span>Hasta (unidades)</span><span>Precio / unidad</span><span />
                  </div>
                  {draft.tiers.map((t, i) => (
                    <div key={i} className="grid grid-cols-[1fr_1fr_28px] items-center gap-2">
                      <input className="input tnum" type="number" min={1} placeholder="∞" value={t.upTo} onChange={(e) => setTier(i, { upTo: e.target.value })} />
                      <input className="input tnum" type="number" min={0} step="0.001" value={t.unitUnits} onChange={(e) => setTier(i, { unitUnits: e.target.value })} />
                      <button type="button" onClick={() => set({ tiers: draft.tiers.filter((_, idx) => idx !== i) })} className="rounded-md p-1.5 text-subtle hover:bg-err/[.12] hover:text-err" disabled={draft.tiers.length <= 1}><Trash2 size={13} /></button>
                    </div>
                  ))}
                  <button type="button" onClick={() => set({ tiers: [...draft.tiers, { upTo: '', unitUnits: '0' }] })} className="mt-1 inline-flex w-fit items-center gap-1 text-[12px] text-acc-soft hover:underline"><Plus size={12} /> Añadir tramo</button>
                </div>
              </Field>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="IVA (%)"><input className="input tnum" type="number" min={0} max={100} value={draft.taxRate} onChange={(e) => set({ taxRate: e.target.value })} disabled={draft.taxExempt} /></Field>
              <Field label="IRPF (%)"><input className="input tnum" type="number" min={0} max={100} value={draft.irpfRate} onChange={(e) => set({ irpfRate: e.target.value })} /></Field>
              <label className="mt-6 flex cursor-pointer items-center gap-2 text-[13px] text-sub">
                <input type="checkbox" checked={draft.taxExempt} onChange={(e) => set({ taxExempt: e.target.checked })} className="accent-acc" /> Exento de IVA
              </label>
              <label className="mt-6 flex cursor-pointer items-center gap-2 text-[13px] text-sub">
                <input type="checkbox" checked={draft.active} onChange={(e) => set({ active: e.target.checked })} className="accent-acc" /> Activo
              </label>
            </div>

            <Field label="Descripción"><textarea className="input min-h-14" value={draft.description} onChange={(e) => set({ description: e.target.value })} placeholder="Qué incluye, para el cliente…" /></Field>

            <div className="mt-1.5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDraft(null)}>Cancelar</Button>
              <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!draft.name.trim()}>{isEdit ? 'Guardar' : 'Crear producto'}</Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
        title={toDelete?.in_use ? 'Archivar producto' : 'Eliminar producto'}
        message={toDelete?.in_use
          ? `«${toDelete?.name}» está contratado por alguna cuenta: se archivará (se conserva el histórico) en vez de borrarse.`
          : `El producto «${toDelete?.name}» se elimina del catálogo.`}
        loading={remove.isPending}
      />
    </div>
  );
}
