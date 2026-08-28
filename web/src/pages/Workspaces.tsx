import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Building2, CreditCard, Plus, SlidersHorizontal } from 'lucide-react';
import { api } from '../api';
import { Button, Field, Modal, Skeleton, StatusBadge, useToast } from '../components/ui';
import { MiniMeter } from '../components/QuotaMeter';
import { Me, Plan, Workspace } from '../types';
import { cx, fmtMb, fmtMoney } from '../utils';

const round2 = (n: number) => Math.round(n * 100) / 100;

function PlanPill({ workspace }: { workspace: Workspace }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-acc/[.14] px-2 py-0.5 text-micro font-semibold text-acc-soft">
      <CreditCard size={9} /> {workspace.plan ? workspace.plan.name : 'sin plan'}
    </span>
  );
}

function WorkspaceCard({ workspace }: { workspace: Workspace }) {
  const q = workspace.quota;
  const a = workspace.allocation;
  const suspended = workspace.status === 'suspended';
  const countTone = (used: number, max: number) => (used > max ? 'text-err' : 'text-sub');
  return (
    <Link to={`/workspaces/${workspace.id}`} className="card card-hover block p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-line bg-surface2 text-acc-soft">
            <Building2 size={16} />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold">{workspace.name}</h3>
            <p className="font-mono text-xs text-subtle">{workspace.slug}</p>
          </div>
        </div>
        <StatusBadge tone={suspended ? 'warn' : 'ok'} label={suspended ? 'suspendida' : 'activa'} dot={!suspended} pulse={false} />
      </div>

      <div className="mt-4 flex flex-col gap-2.5">
        <MiniMeter label="CPU" used={a.cpuCores} ceiling={q.cpuCores} format={(n) => `${round2(n)}`} />
        <MiniMeter label="RAM" used={a.memoryMb} ceiling={q.memoryMb} format={fmtMb} />
        <MiniMeter label="Disco" used={a.diskMb} ceiling={q.diskMb} format={fmtMb} />
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-xs text-subtle">
        <div className="flex items-center gap-3">
          <span className={cx('tnum', countTone(a.projects, q.maxProjects))}>{a.projects}/{q.maxProjects} proy.</span>
          <span className={cx('tnum', countTone(a.services, q.maxServices))}>{a.services}/{q.maxServices} serv.</span>
          <span className={cx('tnum', countTone(a.members, q.maxMembers))}>{a.members}/{q.maxMembers} usu.</span>
        </div>
        <PlanPill workspace={workspace} />
      </div>
    </Link>
  );
}

interface Draft {
  name: string;
  planId: string;
  billingEmail: string;
  billingDay: string;
}
const EMPTY: Draft = { name: '', planId: '', billingEmail: '', billingDay: '1' };

export default function WorkspacesPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), staleTime: 60_000 });
  const isAdmin = me.data?.user?.role === 'admin';
  const isOwner = me.data?.user?.role === 'owner';

  // El propietario no ve un listado: va directo a su cuenta.
  useEffect(() => {
    if (isOwner && me.data?.user?.workspaceId) navigate(`/workspaces/${me.data.user.workspaceId}`, { replace: true });
  }, [isOwner, me.data, navigate]);

  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.get<{ workspaces: Workspace[] }>('/workspaces'),
    enabled: !isOwner,
  });
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api.get<{ plans: Plan[] }>('/plans'), enabled: isAdmin });

  const [draft, setDraft] = useState<Draft | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ workspace: Workspace }>('/workspaces', {
        name: draft!.name.trim(),
        planId: draft!.planId || null,
        billingEmail: draft!.billingEmail.trim() || null,
        billingDay: Number(draft!.billingDay) || 1,
      }),
    onSuccess: (res) => {
      toast('Cuenta creada', 'ok');
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      navigate(`/workspaces/${res.workspace.id}`);
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const list = workspaces.data?.workspaces ?? [];

  if (isOwner) return null; // redirigiendo

  return (
    <div className="mx-auto max-w-[1120px] px-4 py-7 sm:px-6 sm:py-10">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Cuentas y clientes</h1>
          <p className="mt-1.5 text-sm text-sub">
            Cada cuenta agrupa los proyectos de un cliente bajo una cuota de recursos compartida y su facturación
          </p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => navigate('/plans')}>
              <SlidersHorizontal size={15} /> Planes
            </Button>
            <Button onClick={() => setDraft({ ...EMPTY, planId: plans.data?.plans.find((p) => p.is_default)?.id ?? '' })}>
              <Plus size={15} /> Nueva cuenta
            </Button>
          </div>
        )}
      </div>

      {workspaces.isLoading && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card p-5">
              <div className="flex items-center gap-2.5">
                <Skeleton className="h-9 w-9 rounded-[10px]" />
                <Skeleton className="h-4 w-32" />
              </div>
              <Skeleton className="mt-5 h-2.5 w-full rounded-full" />
              <Skeleton className="mt-2.5 h-2.5 w-full rounded-full" />
              <Skeleton className="mt-2.5 h-2.5 w-full rounded-full" />
            </div>
          ))}
        </div>
      )}

      {workspaces.data && list.length === 0 && (
        <div className="card flex flex-col items-center gap-3 py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-surface2 text-acc-soft">
            <Building2 size={22} />
          </span>
          <p className="max-w-sm text-sm text-sub">
            Aún no hay cuentas de cliente. Crea una para asignarle recursos, módulos y usuarios propios.
          </p>
          {isAdmin && (
            <Button onClick={() => setDraft({ ...EMPTY, planId: plans.data?.plans.find((p) => p.is_default)?.id ?? '' })}>
              <Plus size={15} /> Nueva cuenta
            </Button>
          )}
        </div>
      )}

      {list.length > 0 && (
        <div className="stagger grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
          {list.map((w) => (
            <WorkspaceCard key={w.id} workspace={w} />
          ))}
        </div>
      )}

      <Modal open={!!draft} onClose={() => setDraft(null)} title="Nueva cuenta de cliente">
        {draft && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.name.trim()) create.mutate();
            }}
            className="flex flex-col gap-3.5"
          >
            <Field label="Nombre del cliente" hint="Ej: Acme S.L.">
              <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus required />
            </Field>
            <Field label="Plan" hint="Define los usos incluidos y el precio; se puede ajustar luego a medida">
              <select className="input" value={draft.planId} onChange={(e) => setDraft({ ...draft, planId: e.target.value })}>
                <option value="">Sin plan (cuota mínima)</option>
                {(plans.data?.plans ?? [])
                  .filter((p) => !p.archived)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.price_cents === 0 ? 'gratis' : fmtMoney(p.price_cents, p.currency)}
                    </option>
                  ))}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Email de facturación" hint="opcional">
                <input className="input" type="email" value={draft.billingEmail} onChange={(e) => setDraft({ ...draft, billingEmail: e.target.value })} placeholder="pagos@acme.com" />
              </Field>
              <Field label="Día de cobro" hint="1–28 del mes">
                <input className="input tnum" type="number" min={1} max={28} value={draft.billingDay} onChange={(e) => setDraft({ ...draft, billingDay: e.target.value })} />
              </Field>
            </div>
            <div className="mt-1.5 flex justify-end gap-2">
              <Button variant="ghost" type="button" onClick={() => setDraft(null)}>
                Cancelar
              </Button>
              <Button type="submit" loading={create.isPending} disabled={!draft.name.trim()}>
                Crear cuenta
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
