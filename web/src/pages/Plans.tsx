import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowLeft, Check, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { api } from '../api';
import { Button, ConfirmModal, Field, Modal, useToast } from '../components/ui';
import { ModuleDef, Plan } from '../types';
import { cx, fmtMb, fmtMoney } from '../utils';

interface Draft {
  id?: string;
  name: string;
  priceUnits: string;
  currency: string;
  interval: 'monthly' | 'yearly';
  cpu_cores: string;
  memory_mb: string;
  disk_mb: string;
  max_projects: string;
  max_services: string;
  max_members: string;
  discount_pct: string;
  modules: string[];
  is_default: boolean;
  archived: boolean;
}

const EMPTY: Draft = {
  name: '', priceUnits: '0', currency: 'EUR', interval: 'monthly',
  cpu_cores: '2', memory_mb: '2048', disk_mb: '20480', max_projects: '5', max_services: '15', max_members: '5',
  discount_pct: '0', modules: [], is_default: false, archived: false,
};

function fromPlan(p: Plan): Draft {
  return {
    id: p.id, name: p.name, priceUnits: String(p.price_cents / 100), currency: p.currency, interval: p.interval,
    cpu_cores: String(p.cpu_cores), memory_mb: String(p.memory_mb), disk_mb: String(p.disk_mb),
    max_projects: String(p.max_projects), max_services: String(p.max_services), max_members: String(p.max_members),
    discount_pct: String(p.discount_pct ?? 0), modules: [...p.modules], is_default: p.is_default, archived: p.archived,
  };
}

export default function PlansPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api.get<{ plans: Plan[] }>('/plans') });
  const modules = useQuery({ queryKey: ['modules'], queryFn: () => api.get<{ modules: ModuleDef[] }>('/modules'), staleTime: 300_000 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toDelete, setToDelete] = useState<Plan | null>(null);
  const isEdit = !!draft?.id;
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['plans'] });

  const save = useMutation({
    mutationFn: () => {
      const d = draft!;
      const payload = {
        name: d.name.trim(),
        price_cents: Math.round(Number(d.priceUnits) * 100) || 0,
        currency: d.currency.trim().toUpperCase() || 'EUR',
        interval: d.interval,
        cpu_cores: Number(d.cpu_cores) || 1,
        memory_mb: Number(d.memory_mb) || 1024,
        disk_mb: Number(d.disk_mb) || 10240,
        max_projects: Number(d.max_projects) || 1,
        max_services: Number(d.max_services) || 1,
        max_members: Number(d.max_members) || 1,
        discount_pct: Math.max(0, Math.min(100, Number(d.discount_pct) || 0)),
        modules: d.modules,
        is_default: d.is_default,
        archived: d.archived,
      };
      return d.id ? api.patch(`/plans/${d.id}`, payload) : api.post('/plans', payload);
    },
    onSuccess: () => { toast(isEdit ? 'Plan actualizado' : 'Plan creado', 'ok'); setDraft(null); invalidate(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/plans/${id}`),
    onSuccess: () => { toast('Plan eliminado', 'ok'); setToDelete(null); invalidate(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const toggleModule = (key: string) =>
    setDraft((d) => (d ? { ...d, modules: d.modules.includes(key) ? d.modules.filter((k) => k !== key) : [...d.modules, key] } : d));

  const list = plans.data?.plans ?? [];

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-7 sm:px-6 sm:py-10">
      <Link to="/workspaces" className="mb-4 inline-flex items-center gap-1.5 text-xs text-subtle hover:text-txt">
        <ArrowLeft size={13} /> Cuentas y clientes
      </Link>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-.02em]">Planes</h1>
          <p className="mt-1.5 text-sm text-sub">Los usos incluidos y el precio que hereda cada cuenta. Se pueden ajustar a medida por cliente.</p>
        </div>
        <Button onClick={() => setDraft({ ...EMPTY, modules: modules.data?.modules.map((m) => m.key) ?? [] })}>
          <Plus size={15} /> Nuevo plan
        </Button>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
        {list.map((p) => (
          <div key={p.id} className={cx('card p-5', p.archived && 'opacity-60')}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="flex items-center gap-1.5 text-base font-semibold">
                  {p.name}
                  {p.is_default && <Star size={12} className="text-warn" fill="currentColor" />}
                </h3>
                <p className="mt-0.5 text-sm text-sub tnum">
                  {p.price_cents === 0 ? 'Gratis' : `${fmtMoney(p.price_cents, p.currency)}`}
                  <span className="text-subtle">/{p.interval === 'yearly' ? 'año' : 'mes'}</span>
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => setDraft(fromPlan(p))} className="rounded-md p-1.5 text-subtle hover:bg-surface2 hover:text-txt" title="Editar">
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => setToDelete(p)}
                  disabled={p.inUse > 0}
                  className="rounded-md p-1.5 text-subtle hover:bg-err/[.12] hover:text-err disabled:opacity-30"
                  title={p.inUse > 0 ? 'En uso: archívalo o reasigna sus cuentas' : 'Eliminar'}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
              <Row label="CPU" value={`${p.cpu_cores} nú`} />
              <Row label="RAM" value={fmtMb(p.memory_mb)} />
              <Row label="Disco" value={fmtMb(p.disk_mb)} />
              <Row label="Proyectos" value={String(p.max_projects)} />
              <Row label="Servicios" value={String(p.max_services)} />
              <Row label="Usuarios" value={String(p.max_members)} />
            </dl>
            <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-xs text-subtle">
              <span>{p.modules.length} módulos</span>
              <span>{p.archived ? 'archivado' : p.inUse > 0 ? `${p.inUse} cuenta${p.inUse === 1 ? '' : 's'}` : 'sin uso'}</span>
            </div>
          </div>
        ))}
      </div>

      <Modal open={!!draft} onClose={() => setDraft(null)} title={isEdit ? `Editar ${draft?.name || 'plan'}` : 'Nuevo plan'} wide>
        {draft && (
          <div className="flex flex-col gap-3.5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Nombre"><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus /></Field>
              <Field label="Precio"><input className="input tnum" type="number" min={0} step="0.01" value={draft.priceUnits} onChange={(e) => setDraft({ ...draft, priceUnits: e.target.value })} /></Field>
              <Field label="Moneda"><input className="input" maxLength={3} value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })} /></Field>
              <Field label="Periodo">
                <select className="input" value={draft.interval} onChange={(e) => setDraft({ ...draft, interval: e.target.value as 'monthly' | 'yearly' })}>
                  <option value="monthly">Mensual</option>
                  <option value="yearly">Anual</option>
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="CPU (núcleos)"><input className="input tnum" type="number" min={0.1} step="0.5" value={draft.cpu_cores} onChange={(e) => setDraft({ ...draft, cpu_cores: e.target.value })} /></Field>
              <Field label="RAM (MB)"><input className="input tnum" type="number" min={128} step={256} value={draft.memory_mb} onChange={(e) => setDraft({ ...draft, memory_mb: e.target.value })} /></Field>
              <Field label="Disco (MB)"><input className="input tnum" type="number" min={256} step={1024} value={draft.disk_mb} onChange={(e) => setDraft({ ...draft, disk_mb: e.target.value })} /></Field>
              <Field label="Proyectos"><input className="input tnum" type="number" min={1} value={draft.max_projects} onChange={(e) => setDraft({ ...draft, max_projects: e.target.value })} /></Field>
              <Field label="Servicios"><input className="input tnum" type="number" min={1} value={draft.max_services} onChange={(e) => setDraft({ ...draft, max_services: e.target.value })} /></Field>
              <Field label="Usuarios"><input className="input tnum" type="number" min={1} value={draft.max_members} onChange={(e) => setDraft({ ...draft, max_members: e.target.value })} /></Field>
              <Field label="Descuento (%)" hint="rebaja las facturas de sus cuentas"><input className="input tnum" type="number" min={0} max={100} step="0.5" value={draft.discount_pct} onChange={(e) => setDraft({ ...draft, discount_pct: e.target.value })} /></Field>
            </div>
            <Field label="Módulos incluidos">
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {(modules.data?.modules ?? []).map((m) => {
                  const on = draft.modules.includes(m.key);
                  return (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => toggleModule(m.key)}
                      className={cx('flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors', on ? 'border-acc/55 bg-acc/[.10] text-txt' : 'border-line bg-bg text-sub hover:border-subtle')}
                    >
                      <span className={cx('flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border', on ? 'border-acc bg-acc text-white' : 'border-line')}>
                        {on && <Check size={10} />}
                      </span>
                      <span className="truncate">{m.label}</span>
                    </button>
                  );
                })}
              </div>
            </Field>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-sub">
                <input type="checkbox" checked={draft.is_default} onChange={(e) => setDraft({ ...draft, is_default: e.target.checked })} className="accent-acc" /> Plan por defecto
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-sub">
                <input type="checkbox" checked={draft.archived} onChange={(e) => setDraft({ ...draft, archived: e.target.checked })} className="accent-acc" /> Archivado
              </label>
            </div>
            <div className="mt-1.5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDraft(null)}>Cancelar</Button>
              <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!draft.name.trim()}>{isEdit ? 'Guardar' : 'Crear plan'}</Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
        title="Eliminar plan"
        message={`El plan «${toDelete?.name}» se elimina. Esta acción no afecta a cuentas (ninguna lo usa).`}
        loading={remove.isPending}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-subtle">{label}</dt>
      <dd className="text-right font-medium tnum">{value}</dd>
    </>
  );
}
