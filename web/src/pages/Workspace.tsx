import { lazy, Suspense, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Boxes,
  CreditCard,
  Cpu,
  Download,
  Gauge,
  HardDrive,
  KeyRound,
  Layers,
  MemoryStick,
  Ban,
  Pause,
  Pencil,
  Play,
  Plus,
  Receipt,
  Send,
  TrendingDown,
  TrendingUp,
  Trash2,
  Undo2,
  Users2,
} from 'lucide-react';
import { api } from '../api';
import { COUNTRY_OPTIONS, DEFAULT_COUNTRY, countryName } from '../countries';
import { Button, Chip, ConfirmModal, CopyButton, EditorBar, ErrorState, Field, Modal, NumberInput, Skeleton, StatusBadge, Tabs, useToast } from '../components/ui';
import { QuotaMeter } from '../components/QuotaMeter';
// Gráficos de la pestaña «Uso» (no es la pestaña por defecto): carga diferida.
const UsageBars = lazy(() => import('../components/BillingCharts').then((m) => ({ default: m.UsageBars })));
import {
  BillingProfile,
  Invoice,
  InvoicesResponse,
  Me,
  ModuleDef,
  PaymentMethod,
  Plan,
  Product,
  Subscription,
  SubscriptionsResponse,
  WorkspaceAlert,
  WorkspaceApiKey,
  WorkspaceKeysResponse,
  UsageSeries,
  UserRole,
  Workspace,
  WorkspaceMember,
  WorkspaceProject,
  WorkspaceUsage,
} from '../types';
import { cx, fmtAxisTime, fmtDate, fmtMb, fmtMoney, timeAgo } from '../utils';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Tramo del historial de plan de la cuenta. `to` en null es el vigente. */
interface PlanPeriod {
  id: string;
  planId: string | null;
  planName: string | null;
  priceCents: number | null;
  currency: string | null;
  interval: string | null;
  from: number;
  to: number | null;
}

interface Detail {
  workspace: Workspace;
  projects: WorkspaceProject[];
  members: WorkspaceMember[];
  planHistory?: PlanPeriod[];
}

// ---------------- Resumen: cuota con redimensionado en vivo ----------------

type QuotaKey = 'cpuCores' | 'memoryMb' | 'diskMb' | 'maxProjects' | 'maxServices' | 'maxMembers';

const DIMS: {
  key: QuotaKey;
  alloc: 'cpuCores' | 'memoryMb' | 'diskMb' | 'projects' | 'services' | 'members';
  label: string;
  icon: React.ReactNode;
  fmt: (n: number) => string;
  step: number;
  min: number;
}[] = [
  { key: 'cpuCores', alloc: 'cpuCores', label: 'CPU', icon: <Cpu size={14} />, fmt: (n) => `${round2(n)} nú`, step: 0.5, min: 0.1 },
  { key: 'memoryMb', alloc: 'memoryMb', label: 'Memoria', icon: <MemoryStick size={14} />, fmt: fmtMb, step: 512, min: 128 },
  { key: 'diskMb', alloc: 'diskMb', label: 'Disco', icon: <HardDrive size={14} />, fmt: fmtMb, step: 1024, min: 256 },
  { key: 'maxProjects', alloc: 'projects', label: 'Proyectos', icon: <Boxes size={14} />, fmt: (n) => String(n), step: 1, min: 1 },
  { key: 'maxServices', alloc: 'services', label: 'Servicios', icon: <Layers size={14} />, fmt: (n) => String(n), step: 1, min: 1 },
  { key: 'maxMembers', alloc: 'members', label: 'Usuarios', icon: <Users2 size={14} />, fmt: (n) => String(n), step: 1, min: 1 },
];

function ResumenTab({ detail, isAdmin, plans, onSaved }: { detail: Detail; isAdmin: boolean; plans: Plan[]; onSaved: () => void }) {
  const toast = useToast();
  const ws = detail.workspace;
  type Row = { inherit: boolean; value: number };
  const initial = useMemo(() => {
    const rows: Record<QuotaKey, Row> = {} as any;
    for (const d of DIMS) rows[d.key] = { inherit: (ws.inheriting as any)[d.key], value: (ws.quota as any)[d.key] };
    return rows;
  }, [ws]);
  const [rows, setRows] = useState<Record<QuotaKey, Row>>(initial);
  const [planId, setPlanId] = useState<string>(ws.plan_id ?? '');

  const dirty =
    planId !== (ws.plan_id ?? '') ||
    DIMS.some((d) => rows[d.key].inherit !== initial[d.key].inherit || (!rows[d.key].inherit && rows[d.key].value !== initial[d.key].value));

  const save = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = { planId: planId || null };
      for (const d of DIMS) payload[d.key] = rows[d.key].inherit ? null : rows[d.key].value;
      return api.patch(`/workspaces/${ws.id}`, payload);
    },
    onSuccess: () => {
      toast('Cuota actualizada', 'ok');
      onSaved();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const setRow = (key: QuotaKey, patch: Partial<Row>) => setRows((r) => ({ ...r, [key]: { ...r[key], ...patch } }));

  return (
    <div className="flex flex-col gap-5">
      <section className="card p-5">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-base font-semibold">Cuota de recursos</h2>
          {isAdmin && (
            <select
              className="input h-8 w-auto py-0 text-sm"
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
              aria-label="Plan de la cuenta"
            >
              <option value="">Sin plan</option>
              {plans.filter((p) => !p.archived || p.id === ws.plan_id).map((p) => (
                <option key={p.id} value={p.id}>Plan {p.name}</option>
              ))}
            </select>
          )}
        </div>
        <p className="mb-4 text-xs text-subtle">
          Acotada a todos los proyectos del cliente en total.{' '}
          {isAdmin ? 'Amplíala o recórtala en vivo; los límites por servicio ya en marcha se aplican al volver a desplegar.' : 'La define tu proveedor.'}
        </p>

        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {DIMS.map((d) => {
            const row = rows[d.key];
            const used = (ws.allocation as any)[d.alloc] as number;
            // Al heredar, el techo real lo pone el plan (cambia con él): se muestra el
            // valor efectivo actual, no el buffer local (que solo importa al fijar override).
            const effectiveNow = (ws.quota as any)[d.key] as number;
            const ceiling = row.inherit ? effectiveNow : row.value;
            return (
              <div key={d.key}>
                <QuotaMeter label={d.label} icon={d.icon} used={used} ceiling={ceiling} format={d.fmt} inheriting={row.inherit} />
                {isAdmin && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="flex items-center overflow-hidden rounded-lg border border-line">
                      <button
                        type="button"
                        disabled={row.inherit}
                        onClick={() => setRow(d.key, { value: Math.max(d.min, round2(row.value - d.step)) })}
                        className="press h-8 w-8 text-sub hover:bg-surface2 hover:text-txt disabled:opacity-40"
                      >
                        −
                      </button>
                      <NumberInput
                        disabled={row.inherit}
                        value={ceiling}
                        min={d.min}
                        emptyValue={d.min}
                        onChange={(v) => setRow(d.key, { value: Math.max(d.min, v) })}
                        className="tnum h-8 w-20 border-x border-line bg-bg px-2 text-center text-sm text-txt outline-none disabled:opacity-40"
                      />
                      <button
                        type="button"
                        disabled={row.inherit}
                        onClick={() => setRow(d.key, { value: round2(row.value + d.step) })}
                        className="press h-8 w-8 text-sub hover:bg-surface2 hover:text-txt disabled:opacity-40"
                      >
                        +
                      </button>
                    </div>
                    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-subtle">
                      {/* Al dejar de heredar, el override arranca desde el valor efectivo actual. */}
                      <input
                        type="checkbox"
                        checked={row.inherit}
                        onChange={(e) => setRow(d.key, e.target.checked ? { inherit: true } : { inherit: false, value: effectiveNow })}
                        className="accent-acc"
                      />
                      heredar del plan
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {(ws.allocation.unlimited.cpu > 0 || ws.allocation.unlimited.memory > 0) && (
          <p className="mt-4 rounded-lg border border-warn/25 bg-warn/[.08] px-3 py-2 text-xs text-warn">
            Hay servicios sin límite de recursos: no reservan cuota, pero pueden crecer sin tope. Asígnales CPU/RAM en sus ajustes para acotarlos.
          </p>
        )}
        {isAdmin && dirty && (
          <div className="mt-4">
            <EditorBar dirty={dirty} saving={save.isPending} onSave={() => save.mutate()} onDiscard={() => { setRows(initial); setPlanId(ws.plan_id ?? ''); }} saveLabel="Aplicar cuota" />
          </div>
        )}
      </section>

      <section className="card p-5">
        <h2 className="mb-3 text-base font-semibold">Proyectos del cliente</h2>
        {detail.projects.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line bg-bg px-4 py-5 text-center text-xs text-subtle">
            Sin proyectos todavía en esta cuenta.
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-line">
            {detail.projects.map((p) => (
              <Link key={p.id} to={`/projects/${p.id}`} className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 hover:bg-surface2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{p.name}</p>
                  <p className="font-mono text-xs text-subtle">{p.slug}</p>
                </div>
                <span className="shrink-0 text-xs text-subtle tnum">{p.serviceCount === 1 ? '1 servicio' : `${p.serviceCount} servicios`}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------- Módulos ----------------

function ModulosTab({ detail, isAdmin, modules, onSaved }: { detail: Detail; isAdmin: boolean; modules: ModuleDef[]; onSaved: () => void }) {
  const toast = useToast();
  const ws = detail.workspace;
  const [granted, setGranted] = useState<Set<string>>(new Set(ws.modules.granted));
  const [disabled, setDisabled] = useState<Set<string>>(new Set(ws.modules.disabled));

  const dirtyGrant = isAdmin && !sameSet(granted, new Set(ws.modules.granted));
  const dirtyDisabled = !sameSet(disabled, new Set(ws.modules.disabled));

  const saveGrant = useMutation({
    mutationFn: () => api.patch(`/workspaces/${ws.id}`, { modules: [...granted] }),
    onSuccess: () => { toast('Módulos concedidos actualizados', 'ok'); onSaved(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const saveDisabled = useMutation({
    mutationFn: () => api.patch(`/workspaces/${ws.id}/modules`, { disabled: [...disabled] }),
    onSuccess: () => { toast('Módulos actualizados', 'ok'); onSaved(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const groups = useMemo(() => {
    const map = new Map<string, ModuleDef[]>();
    for (const m of modules) map.set(m.group, [...(map.get(m.group) ?? []), m]);
    return [...map.entries()];
  }, [modules]);

  return (
    <div className="flex flex-col gap-5">
      <section className="card p-5">
        <h2 className="text-base font-semibold">Módulos</h2>
        <p className="mt-1 text-xs text-subtle">
          {isAdmin
            ? 'Concede o retira los módulos de esta cuenta. El cliente puede acotar (desactivar) los concedidos, nunca ampliarlos.'
            : 'Activa o desactiva bajo tu cuenta los módulos incluidos en tu plan. No puedes activar los que no tengas concedidos.'}
        </p>
        <div className="mt-4 flex flex-col gap-5">
          {groups.map(([group, mods]) => (
            <div key={group}>
              <p className="mb-2 eyebrow text-subtle">{group}</p>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {mods.map((m) => {
                  const isGranted = granted.has(m.key);
                  const isDisabled = disabled.has(m.key);
                  const effective = isGranted && !isDisabled;
                  // Admin controla la concesión; el propietario, el acotado sobre lo concedido.
                  const checked = isAdmin ? isGranted : effective;
                  const toggle = () => {
                    if (isAdmin) {
                      setGranted((s) => toggleSet(s, m.key));
                    } else {
                      if (!isGranted) return; // no puede activar lo no concedido
                      setDisabled((s) => toggleSet(s, m.key, /* add when */ effective));
                    }
                  };
                  const locked = !isAdmin && !isGranted;
                  return (
                    <button
                      key={m.key}
                      type="button"
                      onClick={toggle}
                      disabled={locked}
                      className={cx(
                        'flex items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
                        checked ? 'border-acc/55 bg-acc/[.08]' : 'border-line bg-bg hover:border-subtle',
                        locked && 'opacity-45',
                      )}
                    >
                      <span
                        className={cx(
                          'mt-0.5 flex h-4.5 w-8 shrink-0 items-center rounded-full p-0.5 transition-colors',
                          checked ? 'bg-acc' : 'bg-surface2',
                        )}
                      >
                        <span className={cx('h-3.5 w-3.5 rounded-full bg-white transition-transform', checked && 'translate-x-3.5')} />
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-2 text-sm font-semibold">
                          {m.label}
                          {isAdmin && isGranted && isDisabled && (
                            <span className="rounded-md border border-warn/25 bg-warn/10 px-1.5 py-px text-micro font-medium text-warn">acotado por el cliente</span>
                          )}
                          {locked && <span className="rounded-md border border-line bg-surface2 px-1.5 py-px text-micro text-subtle">no incluido</span>}
                        </span>
                        <span className="mt-0.5 block text-xs leading-snug text-subtle">{m.description}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {(dirtyGrant || dirtyDisabled) && (
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setGranted(new Set(ws.modules.granted)); setDisabled(new Set(ws.modules.disabled)); }}>
              Descartar
            </Button>
            {isAdmin && dirtyGrant && (
              <Button size="sm" loading={saveGrant.isPending} onClick={() => saveGrant.mutate()}>
                Guardar concesión
              </Button>
            )}
            {dirtyDisabled && (
              <Button size="sm" variant={dirtyGrant ? 'secondary' : 'primary'} loading={saveDisabled.isPending} onClick={() => saveDisabled.mutate()}>
                {isAdmin ? 'Guardar acotado' : 'Guardar cambios'}
              </Button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function toggleSet(set: Set<string>, key: string, addWhen?: boolean): Set<string> {
  const next = new Set(set);
  const shouldAdd = addWhen === undefined ? !next.has(key) : addWhen;
  if (shouldAdd) next.add(key);
  else next.delete(key);
  return next;
}
function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ---------------- Usuarios ----------------

interface MemberDraft {
  id?: string;
  email: string;
  password: string;
  role: UserRole;
  projectIds: string[];
}

function UsuariosTab({ detail, isAdmin, onSaved }: { detail: Detail; isAdmin: boolean; onSaved: () => void }) {
  const toast = useToast();
  const ws = detail.workspace;
  const [draft, setDraft] = useState<MemberDraft | null>(null);
  const [toDelete, setToDelete] = useState<WorkspaceMember | null>(null);
  const isEdit = !!draft?.id;

  const save = useMutation({
    mutationFn: () => {
      const d = draft!;
      const projectIds = d.role === 'member' ? d.projectIds : [];
      if (d.id) {
        return api.patch(`/workspaces/${ws.id}/members/${d.id}`, {
          ...(isAdmin ? { role: d.role } : {}),
          projectIds,
          ...(d.password ? { password: d.password } : {}),
        });
      }
      return api.post(`/workspaces/${ws.id}/members`, { email: d.email.trim(), password: d.password, role: d.role, projectIds });
    },
    onSuccess: () => { toast(isEdit ? 'Usuario actualizado' : 'Usuario creado', 'ok'); setDraft(null); onSaved(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/workspaces/${ws.id}/members/${id}`),
    onSuccess: () => { toast('Usuario eliminado', 'ok'); setToDelete(null); onSaved(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const projectName = (id: string) => detail.projects.find((p) => p.id === id)?.name ?? id;
  const toggleProject = (id: string) =>
    setDraft((d) => (d ? { ...d, projectIds: d.projectIds.includes(id) ? d.projectIds.filter((p) => p !== id) : [...d.projectIds, id] } : d));

  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="text-base font-semibold">Usuarios de la cuenta</h2>
          <p className="mt-0.5 text-xs text-subtle">
            {ws.allocation.members} de {ws.quota.maxMembers} · propietarios y miembros con acceso a proyectos de esta cuenta
          </p>
        </div>
        <Button size="sm" onClick={() => setDraft({ email: '', password: '', role: 'member', projectIds: [] })}>
          <Plus size={13} /> Nuevo usuario
        </Button>
      </div>
      {detail.members.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-subtle">Sin usuarios. Crea uno para dar acceso a esta cuenta.</p>
      ) : (
        detail.members.map((m, i) => (
          <div key={m.id} className={cx('flex flex-wrap items-center gap-3 px-4 py-3', i > 0 && 'border-t border-line')}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium">{m.email}</span>
                <Chip size="sm" tone={m.role === 'owner' ? 'info' : 'neutral'}>
                  {m.role === 'owner' ? 'propietario' : 'miembro'}
                </Chip>
              </div>
              <p className="mt-0.5 text-xs text-subtle">
                {m.role === 'owner'
                  ? 'acceso a todos los proyectos de la cuenta'
                  : m.projectIds.length === 0
                    ? 'sin proyectos asignados'
                    : m.projectIds.map(projectName).join(', ')}
                {' · '}alta {timeAgo(m.created_at)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button onClick={() => setDraft({ id: m.id, email: m.email, password: '', role: m.role, projectIds: m.projectIds })} className="rounded-md p-1.5 text-subtle hover:bg-surface2 hover:text-txt" title="Editar">
                <Pencil size={14} />
              </button>
              <button onClick={() => setToDelete(m)} className="rounded-md p-1.5 text-subtle hover:bg-err/[.12] hover:text-err" title="Eliminar">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))
      )}

      <Modal open={!!draft} onClose={() => setDraft(null)} title={isEdit ? `Editar ${draft?.email}` : 'Nuevo usuario'}>
        {draft && (
          <div className="flex flex-col gap-3.5">
            {!isEdit && (
              <Field label="Email">
                <input className="input" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} autoFocus />
              </Field>
            )}
            <Field label={isEdit ? 'Nueva contraseña' : 'Contraseña'} hint={isEdit ? 'vacío = no cambiarla' : 'mínimo 8 caracteres'}>
              <input className="input" type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
            </Field>
            {isAdmin && (
              <Field label="Rol">
                <div className="grid grid-cols-2 gap-2">
                  {(['member', 'owner'] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setDraft({ ...draft, role: r })}
                      className={cx('rounded-lg border px-3 py-2.5 text-left transition-colors', draft.role === r ? 'border-acc bg-acc/[.10]' : 'border-line bg-bg hover:border-subtle')}
                    >
                      <p className="text-sm font-semibold">{r === 'owner' ? 'Propietario' : 'Miembro'}</p>
                      <p className="mt-0.5 text-xs leading-snug text-subtle">
                        {r === 'owner' ? 'Gestiona la cuenta y sus proyectos' : 'Acceso a los proyectos que le asignes'}
                      </p>
                    </button>
                  ))}
                </div>
              </Field>
            )}
            {draft.role === 'member' && (
              <Field label="Proyectos con acceso" hint={detail.projects.length ? undefined : 'aún no hay proyectos en la cuenta'}>
                <div className="flex max-h-44 flex-col gap-1 overflow-y-auto rounded-lg border border-line bg-bg p-2">
                  {detail.projects.map((p) => (
                    <label key={p.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface2">
                      <input type="checkbox" checked={draft.projectIds.includes(p.id)} onChange={() => toggleProject(p.id)} className="accent-acc" />
                      <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                    </label>
                  ))}
                </div>
              </Field>
            )}
            <div className="mt-1.5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDraft(null)}>Cancelar</Button>
              <Button
                onClick={() => save.mutate()}
                loading={save.isPending}
                disabled={isEdit ? !!draft.password && draft.password.length < 8 : !draft.email.trim() || draft.password.length < 8}
              >
                {isEdit ? 'Guardar' : 'Crear usuario'}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
        title="Eliminar usuario"
        message={`«${toDelete?.email}» perderá el acceso al momento. Sus proyectos y servicios no se tocan.`}
        loading={remove.isPending}
      />
    </section>
  );
}

// ---------------- Uso e insights ----------------

function trendPct(vals: number[]): number | null {
  if (vals.length < 4) return null;
  const half = Math.floor(vals.length / 2);
  const first = vals.slice(0, half).reduce((a, b) => a + b, 0);
  const last = vals.slice(half).reduce((a, b) => a + b, 0);
  if (first <= 0) return last > 0 ? 100 : null;
  return Math.round(((last - first) / first) * 100);
}

function Insight({ label, value, unit, trend, hint }: { label: string; value: string; unit?: string; trend?: number | null; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-bg px-4 py-3">
      <p className="text-xs text-subtle">{label}</p>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="tnum text-xl font-semibold leading-none">{value}</span>
        {unit && <span className="text-xs text-subtle">{unit}</span>}
        {trend != null && trend !== 0 && (
          <span className={cx('ml-auto flex items-center gap-0.5 text-xs font-medium', trend > 0 ? 'text-warn' : 'text-ok')}>
            {trend > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {Math.abs(trend)}%
          </span>
        )}
      </div>
      {hint && <p className="mt-1 text-micro leading-snug text-subtle">{hint}</p>}
    </div>
  );
}

const DAY_RANGES = [
  { days: 7, label: '7 días' },
  { days: 30, label: '30 días' },
  { days: 90, label: '90 días' },
];

function UsoTab({ detail }: { detail: Detail }) {
  const ws = detail.workspace;
  const [days, setDays] = useState(30);
  const usage = useQuery({ queryKey: ['ws-usage-series', ws.id, days], queryFn: () => api.get<UsageSeries>(`/workspaces/${ws.id}/usage/series?days=${days}`) });
  const data = usage.data;
  const series = data?.series ?? [];
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const cpuTotal = series.reduce((a, p) => a + p.cpuCoreHours, 0);
  const ramTotal = series.reduce((a, p) => a + p.ramGbHours, 0);
  const reservedCpuH = ws.quota.cpuCores * days * 24;
  const util = reservedCpuH > 0 ? Math.round((cpuTotal / reservedCpuH) * 100) : 0;
  const cpuTrend = trendPct(series.map((p) => p.cpuCoreHours));
  const ramTrend = trendPct(series.map((p) => p.ramGbHours));
  const monthlyCpu = days > 0 ? round1((cpuTotal / days) * 30) : 0;
  const labelFor = (t: number) => fmtAxisTime(t, days * 24);
  const maxProj = Math.max(1e-9, ...(data?.byProject ?? []).map((p) => p.cpuCoreHours));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm text-sub">
          <Gauge size={15} className="text-acc-soft" /> Consumo agregado de la cuenta en el tiempo
        </p>
        <div className="flex gap-1">
          {DAY_RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              className={cx('rounded-lg border px-2.5 py-1 text-xs transition-colors', days === r.days ? 'border-acc/55 bg-acc/[.12] font-medium text-acc-soft' : 'border-line text-sub hover:text-txt')}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {usage.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : usage.isError ? (
        <div className="card">
          <ErrorState
            title="No se ha podido cargar el consumo"
            error={usage.error}
            onRetry={() => usage.refetch()}
            retrying={usage.isFetching}
          />
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Insight label="CPU acumulada" value={String(round1(cpuTotal))} unit="núcleo·h" trend={cpuTrend} />
            <Insight label="Memoria acumulada" value={String(round1(ramTotal))} unit="GB·h" trend={ramTrend} />
            <Insight label="Utilización de CPU" value={`${util}%`} hint={`de la reservada (${ws.quota.cpuCores} núcleos)`} />
            <Insight label="Estimación mensual" value={String(monthlyCpu)} unit="núcleo·h/mes" hint="al ritmo actual" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Suspense fallback={<><Skeleton className="h-56 w-full" /><Skeleton className="h-56 w-full" /></>}>
              <UsageBars title="CPU consumida (núcleo·h)" points={series.map((p) => ({ t: p.t, value: p.cpuCoreHours }))} color="var(--color-chart-1)" format={(v) => String(round1(v))} labelFor={labelFor} />
              <UsageBars title="Memoria consumida (GB·h)" points={series.map((p) => ({ t: p.t, value: p.ramGbHours }))} color="var(--color-chart-2)" format={(v) => String(round1(v))} labelFor={labelFor} />
            </Suspense>
          </div>

          <section className="card p-5">
            <h2 className="mb-3 text-base font-semibold">Proyectos por consumo de CPU</h2>
            {(data?.byProject ?? []).length === 0 ? (
              <p className="rounded-lg border border-dashed border-line bg-bg px-4 py-5 text-center text-xs text-subtle">
                Aún no hay datos de consumo por proyecto (necesita histórico del monitor).
              </p>
            ) : (
              <div className="flex flex-col gap-2.5">
                {data!.byProject.map((p) => (
                  <div key={p.projectId} className="flex items-center gap-3">
                    <span className="w-36 shrink-0 truncate text-sm">{p.name}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface2">
                      <div className="h-full rounded-full bg-acc transition-[width] duration-500" style={{ width: `${Math.min(100, (p.cpuCoreHours / maxProj) * 100)}%` }} />
                    </div>
                    <span className="w-24 shrink-0 text-right text-xs tnum text-sub">{round1(p.cpuCoreHours)} núcleo·h</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// ---------------- Facturación ----------------

const INV_TONE: Record<string, 'neutral' | 'info' | 'ok' | 'warn'> = {
  draft: 'neutral',
  issued: 'info',
  paid: 'ok',
  void: 'warn',
};
const INV_LABEL: Record<string, string> = { draft: 'borrador', issued: 'emitida', paid: 'pagada', void: 'anulada' };

/**
 * Historial de plan por tramos. Explica por qué una factura reparte el mes entre
 * dos planes: cada tramo se cobra por los días servidos a su propio precio. Solo
 * se pinta si ha habido algún cambio (con un único tramo no aporta nada).
 */
function HistorialPlan({ detail }: { detail: Detail }) {
  const tramos = detail.planHistory ?? [];
  if (tramos.length < 2) return null;
  const ancla = detail.workspace.last_billed_period_end;
  return (
    <section className="card overflow-hidden">
      <h2 className="border-b border-line px-4 py-2.5 eyebrow text-subtle">Historial de plan</h2>
      {tramos.map((t, i) => (
        <div key={t.id} className={cx('flex flex-wrap items-baseline gap-x-2 px-4 py-2.5 text-sm', i > 0 && 'border-t border-line')}>
          <span className="font-medium">{t.planName ?? 'Sin plan'}</span>
          {t.priceCents != null && t.currency && (
            <span className="text-xs text-sub">{fmtMoney(t.priceCents, t.currency)}/{t.interval === 'yearly' ? 'año' : 'mes'}</span>
          )}
          {t.to === null && <span className="rounded-md border border-ok/25 bg-ok/10 px-1.5 py-0.5 text-micro font-medium text-ok">vigente</span>}
          <span className="ml-auto text-xs text-subtle">
            {fmtDate(t.from)} → {t.to === null ? 'hoy' : fmtDate(t.to)}
          </span>
        </div>
      ))}
      <p className="border-t border-line px-4 py-2 text-xs text-subtle">
        Cada tramo se factura por los días servidos a su propio precio.
        {ancla != null && ` Facturado hasta el ${fmtDate(ancla)}.`}
      </p>
    </section>
  );
}

function FacturacionTab({ detail, isAdmin, onSaved }: { detail: Detail; isAdmin: boolean; onSaved: () => void }) {
  const toast = useToast();
  const ws = detail.workspace;
  const queryClient = useQueryClient();
  const usage = useQuery({ queryKey: ['ws-usage', ws.id], queryFn: () => api.get<WorkspaceUsage>(`/workspaces/${ws.id}/usage?days=30`) });
  const invoicesQ = useQuery({ queryKey: ['ws-invoices', ws.id], queryFn: () => api.get<InvoicesResponse>(`/workspaces/${ws.id}/invoices`) });
  const data = invoicesQ.data;
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [viewing, setViewing] = useState<Invoice | null>(null);
  const [rectifying, setRectifying] = useState<Invoice | null>(null);

  // Generar, anular o borrar una factura mueve también los CARGOS PUNTUALES (pasan
  // a facturados o vuelven a pendientes), así que hay que refrescar las dos listas:
  // si no, «Servicios contratados» sigue ofreciendo eliminar un cargo ya facturado.
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['ws-invoices', ws.id] });
    queryClient.invalidateQueries({ queryKey: ['ws-subs', ws.id] });
  };

  const email = useMutation({
    mutationFn: (id: string) => api.post(`/invoices/${id}/email`),
    onSuccess: () => toast('Factura enviada al cliente', 'ok'),
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const generate = useMutation({
    mutationFn: () => api.post(`/workspaces/${ws.id}/invoices/generate`),
    onSuccess: () => { toast('Factura del ciclo generada', 'ok'); invalidate(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patch(`/invoices/${id}`, { status }),
    onSuccess: () => { toast('Factura actualizada', 'ok'); invalidate(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/invoices/${id}`),
    onSuccess: () => { toast('Factura eliminada', 'ok'); invalidate(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const stripeLink = useMutation({
    mutationFn: (id: string) => api.post<{ url: string }>(`/invoices/${id}/stripe-link`),
    onSuccess: (res) => { window.open(res.url, '_blank', 'noopener'); toast('Enlace de pago de Stripe creado', 'ok'); invalidate(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const alertsQ = useQuery({ queryKey: ['ws-alerts', ws.id], queryFn: () => api.get<{ alerts: WorkspaceAlert[] }>(`/workspaces/${ws.id}/alerts`) });
  const u = usage.data;
  const alerts = alertsQ.data?.alerts ?? [];
  const dunLabel = ws.dunning_stage >= 3 ? 'Cuenta cancelada por impago' : ws.dunning_stage === 2 ? 'Servicio de IA suspendido por impago' : ws.dunning_stage === 1 ? 'Factura vencida' : null;
  return (
    <div className="flex flex-col gap-5">
      {dunLabel && (
        <div className={cx('flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm', ws.dunning_stage >= 2 ? 'border-err/40 bg-err/[.10] text-err' : 'border-warn/40 bg-warn/[.10] text-warn')}>
          <span className="font-semibold">{dunLabel}.</span>
          <span className="text-sub">{ws.dunning_stage >= 2 ? 'Se reactivará automáticamente al cobrar las facturas pendientes.' : 'Recordatorio enviado; el servicio se suspenderá si no se paga.'}</span>
        </div>
      )}
      {alerts.length > 0 && (
        <section className="card overflow-hidden">
          <h2 className="border-b border-line px-4 py-2.5 eyebrow text-subtle">Avisos de la cuenta</h2>
          {alerts.slice(0, 5).map((a, i) => (
            <div key={a.id} className={cx('px-4 py-2.5', i > 0 && 'border-t border-line')}>
              <div className="flex items-center gap-2">
                <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', a.severity === 'critical' || a.severity === 'serious' ? 'bg-err' : a.severity === 'warning' ? 'bg-warn' : 'bg-info')} />
                <span className="text-sm font-medium">{a.title}</span>
                <span className="ml-auto text-xs text-subtle">{timeAgo(a.ts)}</span>
              </div>
              <p className="mt-0.5 pl-3.5 text-xs text-sub">{a.message}</p>
            </div>
          ))}
        </section>
      )}
      <section className="card p-5">
        <h2 className="mb-3 text-base font-semibold">Uso de los últimos 30 días</h2>
        {usage.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="CPU" value={u ? `${u.cpuCoreHours}` : '—'} unit="núcleo·h" />
            <Stat label="Memoria" value={u ? `${u.ramGbHours}` : '—'} unit="GB·h" />
            <Stat label="Pico CPU" value={u ? `${u.cpuMaxCores}` : '—'} unit="núcleos" />
            <Stat label="Pico disco" value={u ? `${u.diskMaxGb}` : '—'} unit="GB" />
          </div>
        )}
        <p className="mt-3 text-xs text-subtle">
          Plan {ws.plan ? `${ws.plan.name} · ${ws.plan.price_cents === 0 ? 'gratis' : `${fmtMoney(ws.plan.price_cents, ws.plan.currency)}/${ws.plan.interval === 'yearly' ? 'año' : 'mes'}`}` : 'sin asignar'}. El uso incluido lo cubre el plan; lo que exceda se tarifica en la factura. Detalle en la pestaña «Uso».
        </p>
      </section>

      <HistorialPlan detail={detail} />

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-base font-semibold">Facturas</h2>
          {isAdmin && (
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setEditing(EMPTY_INVOICE(ws.id, ws.plan?.currency ?? 'EUR'))}>
                <Plus size={13} /> A medida
              </Button>
              <Button size="sm" loading={generate.isPending} onClick={() => generate.mutate()}>
                <Receipt size={13} /> Generar ciclo
              </Button>
            </div>
          )}
        </div>
        {(data?.invoices ?? []).length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-subtle">Sin facturas todavía.</p>
        ) : (
          data!.invoices.map((inv, i) => (
            <div key={inv.id} className={cx('flex flex-wrap items-center gap-3 px-4 py-3', i > 0 && 'border-t border-line')}>
              <button onClick={() => setViewing(inv)} className="min-w-0 flex-1 text-left">
                <div className="flex flex-wrap items-center gap-2">
                  {inv.number && <span className="font-mono text-xs text-subtle">{inv.number}</span>}
                  <span className="text-sm font-semibold tnum">{fmtMoney(inv.total_cents, inv.currency)}</span>
                  <StatusBadge tone={INV_TONE[inv.status]} label={INV_LABEL[inv.status]} dot={false} className="text-micro" />
                </div>
                <p className="mt-0.5 text-xs text-subtle">
                  {inv.invoice_type === 'rectificativa' ? 'Rectificativa · ' : ''}
                  {fmtDate(inv.period_start)} – {fmtDate(inv.period_end)}
                  {/* !== 0: en una rectificativa el IVA y el IRPF son NEGATIVOS y
                      con «> 0» desaparecían de la línea. */}
                  {inv.tax_cents !== 0 ? ` · IVA ${fmtMoney(inv.tax_cents, inv.currency)}` : ''}
                  {inv.irpf_cents !== 0 ? ` · IRPF ${inv.irpf_cents > 0 ? '−' : '+'}${fmtMoney(Math.abs(inv.irpf_cents), inv.currency)}` : ''}
                  {inv.paid_at ? ` · pagada ${timeAgo(inv.paid_at)}` : inv.issued_at ? ` · emitida ${timeAgo(inv.issued_at)}` : ''}
                </p>
              </button>
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                {/* La factura en PDF la descarga TAMBIÉN el cliente: es suya. El
                    resto de acciones (cobrar, emitir, rectificar) son del admin. */}
                <a
                  href={`/api/invoices/${inv.id}/pdf`}
                  download
                  className="rounded-md p-1.5 text-subtle hover:bg-surface2 hover:text-txt"
                  title="Descargar la factura en PDF"
                >
                  <Download size={14} />
                </a>
              </div>
              {isAdmin && (
                <div className="flex shrink-0 flex-wrap items-center gap-1">
                  {data?.stripeEnabled && inv.status !== 'paid' && inv.status !== 'void' && inv.total_cents > 0 && (
                    <Button size="sm" variant="ghost" loading={stripeLink.isPending} onClick={() => stripeLink.mutate(inv.id)}>
                      <CreditCard size={13} /> Cobrar
                    </Button>
                  )}
                  {inv.status !== 'draft' && inv.status !== 'void' && (
                    <button
                      onClick={() => email.mutate(inv.id)}
                      disabled={email.isPending}
                      className="rounded-md p-1.5 text-subtle hover:bg-surface2 hover:text-txt disabled:opacity-50"
                      title="Enviar la factura al email de facturación del cliente"
                    >
                      <Send size={14} />
                    </button>
                  )}
                  {/* Una factura emitida es inmutable: solo se editan/borran los borradores. */}
                  {inv.status === 'draft' && (
                    <>
                      <button onClick={() => setEditing(inv)} className="rounded-md p-1.5 text-subtle hover:bg-surface2 hover:text-txt" title="Editar líneas">
                        <Pencil size={14} />
                      </button>
                      {/* Emitir es un acto legal IRREVERSIBLE: numera la factura en
                          la serie y la congela. A partir de ahí solo se corrige con
                          una rectificativa, así que se confirma antes. */}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (confirm(`Se va a EMITIR esta factura por ${fmtMoney(inv.total_cents, inv.currency)}.\n\nAl emitirla toma número de serie y queda bloqueada: ya no podrá editarse ni borrarse, solo corregirse con una factura rectificativa.\n\n¿Emitir?`)) {
                            setStatus.mutate({ id: inv.id, status: 'issued' });
                          }
                        }}
                      >
                        Emitir
                      </Button>
                      <button onClick={() => remove.mutate(inv.id)} className="rounded-md p-1.5 text-subtle hover:bg-err/[.12] hover:text-err" title="Eliminar borrador">
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                  {inv.status === 'issued' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        // «Pagada» es un estado terminal: no admite vuelta atrás.
                        if (confirm(`Marcar como COBRADA la factura ${inv.number ?? ''} por ${fmtMoney(inv.total_cents, inv.currency)}.\n\nEs un estado definitivo: no se puede deshacer.\n\n¿Continuar?`)) {
                          setStatus.mutate({ id: inv.id, status: 'paid' });
                        }
                      }}
                    >
                      Marcar pagada
                    </Button>
                  )}
                  {/* Una factura emitida no se edita: se corrige con una rectificativa. */}
                  {(inv.status === 'issued' || inv.status === 'paid') && inv.invoice_type !== 'rectificativa' && (
                    <button onClick={() => setRectifying(inv)} className="rounded-md p-1.5 text-subtle hover:bg-surface2 hover:text-txt" title="Emitir factura rectificativa">
                      <Undo2 size={14} />
                    </button>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </section>

      {isAdmin && <SubscriptionsSection workspaceId={ws.id} currency={ws.plan?.currency ?? 'EUR'} onChanged={invalidate} />}

      {isAdmin && <AiKeysSection workspaceId={ws.id} currency={ws.plan?.currency ?? 'EUR'} />}

      {isAdmin && <AiPricingSection workspaceId={ws.id} currency={ws.plan?.currency ?? 'EUR'} />}

      {isAdmin && <BillingSettings detail={detail} onSaved={onSaved} />}

      {viewing && data && <InvoiceView invoice={viewing} issuer={data.issuer} client={data.client} onClose={() => setViewing(null)} />}
      {editing && <InvoiceEditor invoice={editing} workspaceId={ws.id} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); invalidate(); }} />}
      {rectifying && <RectifyModal invoice={rectifying} onClose={() => setRectifying(null)} onSaved={() => { setRectifying(null); invalidate(); }} />}
    </div>
  );
}

/**
 * Emite una factura rectificativa sobre una factura ya emitida (inmutable). Por
 * defecto anula la original por completo; si se corrigen los importes, el sistema
 * factura la diferencia (revierte la original y aplica las líneas correctas).
 */
function RectifyModal({ invoice, onClose, onSaved }: { invoice: Invoice; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [correct, setCorrect] = useState(false);
  const [lines, setLines] = useState(invoice.lines.map((l) => ({ label: l.label, qty: l.qty, unit: l.unitCents / 100, taxRate: l.taxRate ?? invoice.tax_rate, irpfRate: l.irpfRate ?? 0 })));

  const rectify = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = { reason: reason.trim() };
      if (correct) {
        payload.lines = lines
          .filter((l) => l.label.trim())
          .map((l) => ({ label: l.label.trim(), kind: 'custom', qty: l.qty, unitCents: Math.round(l.unit * 100), taxRate: l.taxRate, irpfRate: l.irpfRate }));
      }
      return api.post(`/invoices/${invoice.id}/rectify`, payload);
    },
    onSuccess: () => { toast('Rectificativa creada en borrador', 'ok'); onSaved(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const setLine = (i: number, patch: Partial<{ label: string; qty: number; unit: number; taxRate: number; irpfRate: number }>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  return (
    <Modal open onClose={onClose} title={`Rectificar ${invoice.number ?? 'factura'}`} wide>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-sub">
          La factura emitida es inmutable. Se creará una <strong>factura rectificativa</strong> (serie REC) enlazada a la original; nace en borrador para que la revises antes de emitirla.
        </p>
        <Field label="Motivo de la rectificación" hint="obligatorio; aparece en la factura">
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej: Error en el importe, descuento acordado, pedido cancelado…" />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={correct} onChange={(e) => setCorrect(e.target.checked)} />
          Corregir importes (si no, se anula la factura por completo)
        </label>
        {correct && (
          <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
            <p className="text-xs text-subtle">Importes <strong>correctos</strong> (lo que la factura debería decir). Se facturará la diferencia respecto a la original.</p>
            <div className="grid grid-cols-[1fr_64px_84px_64px_28px] items-center gap-2 px-1 text-xs font-medium text-subtle">
              <span>Concepto</span><span className="text-right">Cant.</span><span className="text-right">Precio</span><span className="text-right">IVA%</span><span />
            </div>
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[1fr_64px_84px_64px_28px] items-center gap-2">
                <input className="input h-9" value={l.label} onChange={(e) => setLine(i, { label: e.target.value })} placeholder="Concepto" />
                <NumberInput className="input h-9 tnum text-right" value={l.qty} min={0} onChange={(v) => setLine(i, { qty: v })} />
                <NumberInput className="input h-9 tnum text-right" value={l.unit} step="0.01" onChange={(v) => setLine(i, { unit: v })} />
                <NumberInput className="input h-9 tnum text-right" value={l.taxRate} min={0} max={100} onChange={(v) => setLine(i, { taxRate: v })} />
                <button onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))} className="rounded-md p-1 text-subtle hover:text-err" title="Quitar línea">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <button onClick={() => setLines((ls) => [...ls, { label: '', qty: 1, unit: 0, taxRate: invoice.tax_rate, irpfRate: 0 }])} className="mt-1 self-start text-xs font-semibold text-acc-soft hover:underline">
              + Añadir línea
            </button>
          </div>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button loading={rectify.isPending} disabled={reason.trim().length < 3} onClick={() => rectify.mutate()}>
            {correct ? 'Crear rectificativa' : 'Anular con rectificativa'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Vista de factura completa: emisor, cliente, líneas, impuestos y método de pago. */
function InvoiceView({ invoice, issuer, client, onClose }: { invoice: Invoice; issuer: BillingProfile; client: InvoicesResponse['client']; onClose: () => void }) {
  // Datos congelados al emitir (si existen); en borrador, los vivos del perfil/cliente.
  const em = invoice.issuer_snapshot ?? { companyName: issuer.companyName, taxId: issuer.taxId, address: issuer.address, email: issuer.email };
  const clientName = invoice.client_name ?? client.name;
  const clientTaxId = invoice.client_tax_id ?? client.billing_tax_id;
  const clientAddress = invoice.client_address ?? client.billing_address;
  const clientCountry = countryName(invoice.client_country ?? client.billing_country);
  const title = invoice.invoice_type === 'rectificativa' ? 'Factura rectificativa' : invoice.invoice_type === 'simplificada' ? 'Factura simplificada' : 'Factura';
  // Desglose de IVA; para facturas antiguas sin desglose, se sintetiza uno con el tipo único.
  const breakdown = invoice.tax_breakdown.length > 0
    ? invoice.tax_breakdown
    : invoice.tax_cents !== 0
      ? [{ rate: invoice.tax_rate, base_cents: invoice.subtotal_cents, quota_cents: invoice.tax_cents }]
      : [];
  return (
    <Modal open onClose={onClose} title={invoice.number ? `${title} ${invoice.number}` : `${title} (borrador)`} wide>
      <div className="flex flex-col gap-4 text-sm">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="mb-1 eyebrow text-subtle">Emisor</p>
            <p className="font-semibold">{em.companyName || 'Tu empresa'}</p>
            {em.taxId && <p className="text-subtle">NIF {em.taxId}</p>}
            {em.address && <p className="whitespace-pre-line text-subtle">{em.address}</p>}
            {em.email && <p className="text-subtle">{em.email}</p>}
          </div>
          <div className="text-right">
            <p className="mb-1 eyebrow text-subtle">Cliente</p>
            <p className="font-semibold">{clientName}</p>
            {clientTaxId && <p className="text-subtle">NIF {clientTaxId}</p>}
            {clientAddress && <p className="whitespace-pre-line text-subtle">{clientAddress}</p>}
            <p className="text-subtle">{clientCountry}</p>
            {!clientTaxId && <p className="text-xs text-warn">Falta el NIF del cliente para una factura completa.</p>}
            <p className="mt-2 text-subtle">
              {invoice.issued_at ? `Expedida ${fmtDate(invoice.issued_at)}` : 'Sin emitir'}
              {invoice.operation_date ? ` · operación ${fmtDate(invoice.operation_date)}` : ''}
            </p>
            <p className="text-xs text-subtle">Periodo {fmtDate(invoice.period_start)} – {fmtDate(invoice.period_end)}</p>
            <StatusBadge tone={INV_TONE[invoice.status]} label={INV_LABEL[invoice.status]} dot={false} className="mt-1 text-micro" />
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-line">
          <table className="w-full text-left text-xs">
            <thead className="bg-surface2 text-subtle">
              <tr>
                <th className="px-3 py-1.5 font-medium">Concepto</th>
                <th className="px-3 py-1.5 text-right font-medium">Cant.</th>
                <th className="px-3 py-1.5 text-right font-medium">Precio</th>
                <th className="px-3 py-1.5 text-right font-medium">IVA</th>
                <th className="px-3 py-1.5 text-right font-medium">Importe</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {invoice.lines.map((l, i) => (
                <tr key={i} className="border-t border-line/60">
                  <td className="px-3 py-1.5">{l.label}</td>
                  <td className="px-3 py-1.5 text-right text-sub">{l.qty}</td>
                  <td className="px-3 py-1.5 text-right text-sub">{fmtMoney(l.unitCents, invoice.currency)}</td>
                  <td className="px-3 py-1.5 text-right text-sub">{l.taxRate ?? invoice.tax_rate}%</td>
                  <td className="px-3 py-1.5 text-right">{fmtMoney(l.amountCents, invoice.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {invoice.legal_mentions && (
          <p className="rounded-md border border-line bg-bg px-3 py-2 text-xs leading-snug text-sub">{invoice.legal_mentions}</p>
        )}

        <div className="ml-auto w-full max-w-[280px] text-sm tnum">
          <div className="flex justify-between py-0.5 text-sub"><span>Base imponible</span><span>{fmtMoney(invoice.subtotal_cents, invoice.currency)}</span></div>
          {/* Desglose de IVA por tipo (obligatorio si concurren varios tipos). */}
          {breakdown.filter((b) => b.quota_cents !== 0 || b.rate > 0).map((b) => (
            <div key={b.rate} className="flex justify-between py-0.5 text-sub">
              <span>IVA {b.rate}% (s/ {fmtMoney(b.base_cents, invoice.currency)})</span>
              <span>{fmtMoney(b.quota_cents, invoice.currency)}</span>
            </div>
          ))}
          {invoice.irpf_cents !== 0 && (
            <div className="flex justify-between py-0.5 text-sub"><span>Retención IRPF ({invoice.irpf_rate}%)</span><span>{invoice.irpf_cents > 0 ? '−' : '+'}{fmtMoney(Math.abs(invoice.irpf_cents), invoice.currency)}</span></div>
          )}
          <div className="mt-1 flex justify-between border-t border-line pt-1.5 text-base font-semibold"><span>Total</span><span>{fmtMoney(invoice.total_cents, invoice.currency)}</span></div>
        </div>

        {invoice.status !== 'paid' && invoice.status !== 'void' && (issuer.iban || invoice.stripe_url) && (
          <div className="rounded-lg border border-line bg-bg p-3.5">
            <p className="mb-2 eyebrow text-subtle">Cómo pagar</p>
            {issuer.iban && (
              <div className="flex items-center justify-between gap-2 text-xs">
                <div>
                  <p className="text-sub">Transferencia a {issuer.bankName || 'nuestra cuenta'}</p>
                  <p className="font-mono">{issuer.iban}{issuer.bic ? ` · ${issuer.bic}` : ''}</p>
                </div>
                <CopyButton value={issuer.iban} title="Copiar IBAN" />
              </div>
            )}
            {invoice.stripe_url && (
              <a href={invoice.stripe_url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-acc-soft hover:underline">
                <CreditCard size={13} /> Pagar con tarjeta (Stripe) →
              </a>
            )}
          </div>
        )}
        {issuer.footer && <p className="text-xs leading-snug text-subtle">{issuer.footer}</p>}
      </div>
    </Modal>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="rounded-lg border border-line bg-bg px-3 py-2.5">
      <p className="text-xs text-subtle">{label}</p>
      <p className="mt-0.5 tnum text-lg font-semibold leading-none">{value}</p>
      <p className="mt-1 text-micro text-subtle">{unit}</p>
    </div>
  );
}

function EMPTY_INVOICE(workspaceId: string, currency: string): Invoice {
  return {
    id: '', workspace_id: workspaceId, series_id: null, number: null, invoice_type: 'normal',
    rectifies_invoice_id: null, rectify_reason: null, period_start: Date.now(), period_end: Date.now(),
    operation_date: null, status: 'draft', currency, subtotal_cents: 0, tax_cents: 0, tax_rate: 0,
    tax_breakdown: [], vat_regime: 'general', legal_mentions: null, irpf_rate: 0, irpf_cents: 0, total_cents: 0,
    lines: [{ label: '', kind: 'custom', qty: 1, unitCents: 0, amountCents: 0 }], plan_name: null,
    issuer_snapshot: null, client_name: null, client_tax_id: null, client_address: null,
    payment_method: null, stripe_url: null, issued_at: null, paid_at: null, locked: 0, notes: null, created_at: Date.now(),
  };
}

function InvoiceEditor({ invoice, workspaceId, onClose, onSaved }: { invoice: Invoice; workspaceId: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  // Se conservan el TIPO de IVA y la NATURALEZA de cada línea: el servidor
  // recompone la factura con lo que llega, así que omitirlos aplicaba el tipo por
  // defecto a todo y una línea exenta pasaba a tributar al 21 %.
  const [lines, setLines] = useState(
    // El IRPF viaja por línea igual que el IVA: omitirlo hacía que el servidor
    // aplicara el tipo EFECTIVO de la cabecera a todas las líneas, retenciones
    // incluidas donde no las había.
    invoice.lines.map((l) => ({
      label: l.label, kind: l.kind ?? 'custom', qty: l.qty, unit: l.unitCents / 100,
      taxRate: l.taxRate ?? invoice.tax_rate, irpfRate: l.irpfRate ?? 0, chargeId: l.chargeId,
    })),
  );
  const base = lines.reduce((s, l) => s + Math.round(l.qty * l.unit * 100), 0);
  const isNew = !invoice.id;

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        lines: lines
          .filter((l) => l.label.trim())
          // `chargeId` viaja de vuelta: es lo que dice al servidor qué cargos
          // puntuales siguen en la factura y cuáles vuelven a estar pendientes.
          .map((l) => ({ label: l.label.trim(), kind: l.kind, qty: l.qty, unitCents: Math.round(l.unit * 100), taxRate: l.taxRate, irpfRate: l.irpfRate, chargeId: l.chargeId })),
      };
      return isNew ? api.post(`/workspaces/${workspaceId}/invoices`, payload) : api.patch(`/invoices/${invoice.id}`, payload);
    },
    onSuccess: () => { toast(isNew ? 'Factura creada' : 'Factura actualizada', 'ok'); onSaved(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const setLine = (i: number, patch: Partial<{ label: string; qty: number; unit: number; taxRate: number; irpfRate: number }>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  return (
    <Modal open onClose={onClose} title={isNew ? 'Nueva factura a medida' : 'Editar factura'} wide>
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-[1fr_64px_86px_62px_62px_88px_28px] items-center gap-2 px-1 text-xs font-medium text-subtle">
          <span>Concepto</span><span className="text-right">Cant.</span><span className="text-right">Precio</span><span className="text-right">IVA %</span><span className="text-right">IRPF %</span><span className="text-right">Importe</span><span />
        </div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1fr_64px_86px_62px_62px_88px_28px] items-center gap-2">
            <input className="input h-9" value={l.label} onChange={(e) => setLine(i, { label: e.target.value })} placeholder="Ej: Plan Pro (mensual)" />
            <NumberInput className="input h-9 tnum text-right" value={l.qty} min={0} onChange={(v) => setLine(i, { qty: v })} />
            <NumberInput className="input h-9 tnum text-right" value={l.unit} step="0.01" onChange={(v) => setLine(i, { unit: v })} />
            <NumberInput className="input h-9 tnum text-right" value={l.taxRate} min={0} max={100} onChange={(v) => setLine(i, { taxRate: v })} />
            <NumberInput className="input h-9 tnum text-right" value={l.irpfRate} min={0} max={100} onChange={(v) => setLine(i, { irpfRate: v })} />
            <span className="tnum text-right text-sm">{fmtMoney(Math.round(l.qty * l.unit * 100), invoice.currency)}</span>
            <button onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))} className="rounded-md p-1 text-subtle hover:text-err" title="Quitar línea">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <button onClick={() => setLines((ls) => [...ls, { label: '', kind: 'custom', qty: 1, unit: 0, taxRate: invoice.tax_rate, irpfRate: 0, chargeId: undefined }])} className="mt-1 self-start text-xs font-semibold text-acc-soft hover:underline">
          + Añadir línea
        </button>
        {/* La suma de las líneas es la BASE IMPONIBLE, no el total: rotularla
            «Total» hacía creer que era el importe que se cobra. El total con IVA e
            IRPF lo calcula el servidor al guardar. */}
        <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
          <span className="text-sm text-sub">Base imponible</span>
          <span className="tnum text-lg font-semibold">{fmtMoney(base, invoice.currency)}</span>
        </div>
        <p className="text-xs text-subtle">El IVA, la retención de IRPF y el total los recalcula el servidor al guardar.</p>
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>{isNew ? 'Crear factura' : 'Guardar'}</Button>
        </div>
      </div>
    </Modal>
  );
}

const SUB_STATUS: Record<Subscription['status'], { tone: 'ok' | 'warn' | 'neutral'; label: string }> = {
  active: { tone: 'ok', label: 'activa' },
  paused: { tone: 'warn', label: 'pausada' },
  cancelled: { tone: 'neutral', label: 'cancelada' },
};

/** Suscripciones y cargos puntuales que el cliente tiene contratados del catálogo. */
function SubscriptionsSection({ workspaceId, currency, onChanged }: { workspaceId: string; currency: string; onChanged: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const subsQ = useQuery({ queryKey: ['ws-subs', workspaceId], queryFn: () => api.get<SubscriptionsResponse>(`/workspaces/${workspaceId}/subscriptions`) });
  const productsQ = useQuery({ queryKey: ['products'], queryFn: () => api.get<{ products: Product[] }>('/products'), staleTime: 60_000 });
  const [adding, setAdding] = useState(false);
  const [charge, setCharge] = useState(false);

  const invalidate = () => { queryClient.invalidateQueries({ queryKey: ['ws-subs', workspaceId] }); onChanged(); };
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patch(`/subscriptions/${id}`, { status }),
    onSuccess: () => { toast('Suscripción actualizada', 'ok'); invalidate(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const delSub = useMutation({
    mutationFn: (id: string) => api.del(`/subscriptions/${id}`),
    onSuccess: () => { toast('Suscripción eliminada', 'ok'); invalidate(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const delCharge = useMutation({
    mutationFn: (id: string) => api.del(`/charges/${id}`),
    onSuccess: () => { toast('Cargo eliminado', 'ok'); invalidate(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const subs = subsQ.data?.subscriptions ?? [];
  const charges = subsQ.data?.charges ?? [];
  const activeProducts = (productsQ.data?.products ?? []).filter((p) => !p.archived && p.active);
  // Un producto de pago único se contrata como cargo puntual (una vez), no como
  // suscripción recurrente; el resto (recurrentes, por uso, por tramos) sí se suscribe.
  const subscribable = activeProducts.filter((p) => p.billing_model !== 'flat_one_off');
  const oneOffProducts = activeProducts.filter((p) => p.billing_model === 'flat_one_off');

  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="flex items-center gap-2 text-base font-semibold"><Boxes size={15} className="text-acc-soft" /> Servicios contratados</h2>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => setCharge(true)}><Plus size={13} /> Pago único</Button>
          <Button size="sm" onClick={() => setAdding(true)} disabled={subscribable.length === 0}><Plus size={13} /> Suscribir</Button>
        </div>
      </div>

      {subsQ.isLoading ? (
        <Skeleton className="m-4 h-16" />
      ) : subs.length === 0 && charges.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-subtle">
          Sin servicios contratados. {activeProducts.length === 0 ? 'Crea productos en el catálogo primero.' : 'Suscribe a un producto recurrente o añade un pago único del catálogo.'}
        </p>
      ) : (
        <>
          {subs.map((s, i) => (
            <div key={s.id} className={cx('flex flex-wrap items-center gap-3 px-4 py-3', i > 0 && 'border-t border-line')}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{s.product_name}</span>
                  <StatusBadge tone={SUB_STATUS[s.status].tone} label={SUB_STATUS[s.status].label} dot={false} className="text-micro" />
                </div>
                <p className="mt-0.5 text-xs text-subtle tnum">
                  {s.billing_model === 'metered' || s.billing_model === 'tiered'
                    ? `${fmtMoney(s.unit_cents, s.currency)}/${s.unit || 'ud'} · por uso`
                    : `${fmtMoney(s.unit_cents, s.currency)} × ${s.qty}/${s.interval === 'yearly' ? 'año' : 'mes'}`}
                  {s.frozen ? ' · precio fijo' : ' · precio de catálogo'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {s.status === 'active' ? (
                  <button onClick={() => setStatus.mutate({ id: s.id, status: 'paused' })} className="rounded-md p-1.5 text-subtle hover:bg-surface2 hover:text-txt" title="Pausar"><Pause size={14} /></button>
                ) : s.status === 'paused' ? (
                  <button onClick={() => setStatus.mutate({ id: s.id, status: 'active' })} className="rounded-md p-1.5 text-subtle hover:bg-surface2 hover:text-txt" title="Reanudar"><Play size={14} /></button>
                ) : null}
                <button onClick={() => delSub.mutate(s.id)} className="rounded-md p-1.5 text-subtle hover:bg-err/[.12] hover:text-err" title="Eliminar"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
          {charges.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{c.label}</span>
                  <StatusBadge tone="info" label="cargo pendiente" dot={false} className="text-micro" />
                </div>
                <p className="mt-0.5 text-xs text-subtle tnum">{fmtMoney(c.unit_cents, currency)} × {c.qty} · IVA {c.tax_rate}%</p>
              </div>
              <button onClick={() => delCharge.mutate(c.id)} className="rounded-md p-1.5 text-subtle hover:bg-err/[.12] hover:text-err" title="Quitar cargo"><Trash2 size={14} /></button>
            </div>
          ))}
        </>
      )}
      <p className="border-t border-line px-4 py-2.5 text-xs text-subtle">Al generar la factura del ciclo se incluyen estas suscripciones (con su uso medido) y los pagos únicos pendientes (una sola vez).</p>

      {adding && <AddSubscriptionModal workspaceId={workspaceId} products={subscribable} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); invalidate(); }} />}
      {charge && <AddChargeModal workspaceId={workspaceId} products={oneOffProducts} onClose={() => setCharge(false)} onSaved={() => { setCharge(false); invalidate(); }} />}
    </section>
  );
}

function AddSubscriptionModal({ workspaceId, products, onClose, onSaved }: { workspaceId: string; products: Product[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [productId, setProductId] = useState(products[0]?.id ?? '');
  const [qty, setQty] = useState('1');
  const [customPrice, setCustomPrice] = useState('');
  const product = products.find((p) => p.id === productId);
  const metered = product && (product.billing_model === 'metered' || product.billing_model === 'tiered');

  const save = useMutation({
    mutationFn: () => api.post(`/workspaces/${workspaceId}/subscriptions`, {
      productId,
      qty: Number(qty) || 1,
      unitCents: customPrice.trim() ? Math.round(Number(customPrice) * 100) : undefined,
    }),
    onSuccess: () => { toast('Servicio contratado', 'ok'); onSaved(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  return (
    <Modal open onClose={onClose} title="Suscribir a un producto">
      <div className="flex flex-col gap-3.5">
        <Field label="Producto del catálogo">
          <select className="input" value={productId} onChange={(e) => setProductId(e.target.value)}>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name} · {fmtMoney(p.price_cents, p.currency)}{p.billing_model === 'subscription' ? `/${p.interval === 'yearly' ? 'año' : 'mes'}` : p.unit ? `/${p.unit}` : ''}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cantidad" hint={metered ? 'multiplica el uso medido' : 'nº de unidades'}><input className="input tnum" type="number" min={0} step="0.5" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
          <Field label="Precio a medida" hint="vacío = precio del catálogo"><input className="input tnum" type="number" min={0} step="0.01" value={customPrice} onChange={(e) => setCustomPrice(e.target.value)} placeholder={product ? String(product.price_cents / 100) : ''} /></Field>
        </div>
        {product?.description && <p className="rounded-md border border-line bg-bg px-3 py-2 text-xs text-sub">{product.description}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!productId}>Contratar</Button>
        </div>
      </div>
    </Modal>
  );
}

function AddChargeModal({ workspaceId, products, onClose, onSaved }: { workspaceId: string; products: Product[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [productId, setProductId] = useState(''); // '' = cargo libre a medida
  const [label, setLabel] = useState('');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('0');
  const [taxRate, setTaxRate] = useState('21');

  // Al elegir un producto de pago único del catálogo, autocompleta concepto,
  // precio e IVA (siguen siendo editables por si hay que ajustarlos).
  const pickProduct = (id: string) => {
    setProductId(id);
    const p = products.find((x) => x.id === id);
    if (p) {
      setLabel(p.name);
      setPrice(String(p.price_cents / 100));
      setTaxRate(String(p.tax_exempt ? 0 : p.tax_rate));
    }
  };

  const save = useMutation({
    mutationFn: () => api.post(`/workspaces/${workspaceId}/charges`, {
      productId: productId || undefined,
      label: label.trim(),
      qty: Number(qty) || 1,
      unitCents: Math.round(Number(price) * 100) || 0,
      taxRate: Number(taxRate) || 0,
    }),
    onSuccess: () => { toast('Pago único añadido', 'ok'); onSaved(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  return (
    <Modal open onClose={onClose} title="Añadir pago único">
      <div className="flex flex-col gap-3.5">
        {products.length > 0 && (
          <Field label="Producto de pago único (catálogo)" hint="autocompleta concepto y precio; o déjalo en «cargo libre»">
            <select className="input" value={productId} onChange={(e) => pickProduct(e.target.value)}>
              <option value="">— Cargo libre (a medida) —</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name} · {fmtMoney(p.price_cents, p.currency)}</option>)}
            </select>
          </Field>
        )}
        <Field label="Concepto"><input className="input" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus placeholder="Consultoría, migración, dominio…" /></Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Cantidad"><input className="input tnum" type="number" min={0} step="0.5" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
          <Field label="Precio unidad"><input className="input tnum" type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
          <Field label="IVA (%)"><input className="input tnum" type="number" min={0} max={100} value={taxRate} onChange={(e) => setTaxRate(e.target.value)} /></Field>
        </div>
        <p className="text-xs text-subtle">Se cobra una sola vez en la próxima factura del ciclo que generes (no se repite).</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!label.trim()}>Añadir</Button>
        </div>
      </div>
    </Modal>
  );
}

const KEY_STATUS: Record<WorkspaceApiKey['status'], { tone: 'ok' | 'warn' | 'neutral'; label: string }> = {
  active: { tone: 'ok', label: 'activa' },
  suspended: { tone: 'warn', label: 'suspendida' },
  revoked: { tone: 'neutral', label: 'revocada' },
};

/** Claves de API de IA del cliente: acceso al proxy de Gemini, con corte reversible. */
function AiKeysSection({ workspaceId, currency }: { workspaceId: string; currency: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['ws-keys', workspaceId], queryFn: () => api.get<WorkspaceKeysResponse>(`/workspaces/${workspaceId}/keys`) });
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [budget, setBudget] = useState('');
  const [rpm, setRpm] = useState('');
  const [secret, setSecret] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['ws-keys', workspaceId] });
  const create = useMutation({
    mutationFn: () => api.post<{ key: string }>(`/workspaces/${workspaceId}/keys`, {
      name: newName.trim(),
      budgetCentsMonth: budget.trim() ? Math.round(Number(budget) * 100) : null,
      rateLimitRpm: rpm.trim() ? Number(rpm) : null,
    }),
    onSuccess: (res) => { setSecret(res.key); setCreating(false); setNewName(''); setBudget(''); setRpm(''); invalidate(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const block = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => api.post(`/workspaces/${workspaceId}/keys/${id}/${on ? 'block' : 'unblock'}`),
    onSuccess: () => { toast('Clave actualizada', 'ok'); invalidate(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/workspaces/${workspaceId}/keys/${id}`),
    onSuccess: () => { toast('Clave revocada', 'ok'); invalidate(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const keys = q.data?.keys ?? [];

  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="flex items-center gap-2 text-base font-semibold"><KeyRound size={15} className="text-acc-soft" /> Claves de IA (Gemini)</h2>
        <Button size="sm" onClick={() => setCreating(true)}><Plus size={13} /> Nueva clave</Button>
      </div>

      {q.data && !q.data.geminiConfigured && (
        <p className="border-b border-line bg-warn/[.08] px-4 py-2 text-xs text-warn">
          El gateway de IA aún no tiene configurada la clave de Gemini (en Contabilidad → Gateway de IA). Las claves emitidas no funcionarán hasta entonces.
        </p>
      )}

      {q.isLoading ? (
        <Skeleton className="m-4 h-14" />
      ) : keys.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-subtle">Sin claves. Emite una para que el cliente consuma Gemini por el proxy y se le facture el uso.</p>
      ) : (
        keys.map((k, i) => (
          <div key={k.id} className={cx('flex flex-wrap items-center gap-3 px-4 py-3', i > 0 && 'border-t border-line')}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{k.name}</span>
                <span className="font-mono text-xs text-subtle">{k.prefix}…</span>
                <StatusBadge tone={KEY_STATUS[k.status].tone} label={KEY_STATUS[k.status].label} dot={false} className="text-micro" />
              </div>
              <p className="mt-0.5 text-xs text-subtle">
                {k.allowed_models.length ? `${k.allowed_models.length} modelo(s) · ` : 'todos los modelos · '}
                {k.rate_limit_rpm ? `${k.rate_limit_rpm}/min · ` : ''}
                {k.last_used_at ? `último uso ${timeAgo(k.last_used_at)}` : 'sin uso aún'}
              </p>
              {k.budget_cents_month != null && (
                <div className="mt-1.5 max-w-[220px]">
                  <div className="flex items-center justify-between text-micro text-subtle tnum">
                    <span>{fmtMoney(k.spend_cents_cycle, currency)} / {fmtMoney(k.budget_cents_month, currency)}</span>
                    <span>{Math.min(100, Math.round((k.spend_cents_cycle / Math.max(1, k.budget_cents_month)) * 100))}%</span>
                  </div>
                  <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-surface2">
                    <div className={cx('h-full rounded-full', k.spend_cents_cycle >= k.budget_cents_month ? 'bg-err' : 'bg-acc')} style={{ width: `${Math.min(100, (k.spend_cents_cycle / Math.max(1, k.budget_cents_month)) * 100)}%` }} />
                  </div>
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {k.status === 'active' ? (
                <button onClick={() => block.mutate({ id: k.id, on: true })} className="rounded-md p-1.5 text-subtle hover:bg-surface2 hover:text-txt" title="Suspender (corte manual)"><Ban size={14} /></button>
              ) : k.status === 'suspended' ? (
                <button onClick={() => block.mutate({ id: k.id, on: false })} className="rounded-md p-1.5 text-subtle hover:bg-surface2 hover:text-txt" title="Reactivar"><Play size={14} /></button>
              ) : null}
              <button onClick={() => revoke.mutate(k.id)} className="rounded-md p-1.5 text-subtle hover:bg-err/[.12] hover:text-err" title="Revocar (irreversible)"><Trash2 size={14} /></button>
            </div>
          </div>
        ))
      )}
      <p className="border-t border-line px-4 py-2.5 text-xs text-subtle">
        El cliente usa la clave contra <span className="font-mono">/gw/v1beta/models/&lt;modelo&gt;:generateContent</span>. El consumo se mide y se factura con los productos de IA del catálogo. El corte por impago es automático.
      </p>

      {/* Modal: crear clave */}
      <Modal open={creating} onClose={() => setCreating(false)} title="Nueva clave de IA">
        <div className="flex flex-col gap-3.5">
          <Field label="Nombre" hint="para identificarla (p. ej. «Producción»)"><input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus placeholder="Producción" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={`Presupuesto/mes (${currency})`} hint="vacío = sin tope"><input className="input tnum" type="number" min={0} step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="p. ej. 50" /></Field>
            <Field label="Límite (pet./min)" hint="vacío = sin límite"><input className="input tnum" type="number" min={1} value={rpm} onChange={(e) => setRpm(e.target.value)} placeholder="p. ej. 60" /></Field>
          </div>
          <p className="text-xs text-subtle">Al superar el presupuesto del ciclo, el proxy rechaza (402) hasta el siguiente periodo; el límite por minuto protege de picos.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancelar</Button>
            <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!newName.trim()}>Crear clave</Button>
          </div>
        </div>
      </Modal>

      {/* Modal: mostrar el secreto una sola vez */}
      <Modal open={!!secret} onClose={() => setSecret(null)} title="Copia la clave ahora">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-sub">Esta es la única vez que se muestra la clave. Guárdala en un lugar seguro; no podrás volver a verla.</p>
          <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-bg px-3 py-2.5">
            <code className="min-w-0 flex-1 truncate font-mono text-xs">{secret}</code>
            {secret && <CopyButton value={secret} title="Copiar clave" />}
          </div>
          <div className="flex justify-end"><Button onClick={() => setSecret(null)}>Listo</Button></div>
        </div>
      </Modal>
    </section>
  );
}

/**
 * Precios de IA de este cliente: activa (a un clic) la facturación de IA dándolo de
 * alta a los productos de IA del catálogo al precio global, y permite fijarle un
 * precio propio por medidor. Vacío = precio global del catálogo. Se apoya en el
 * override `unit_cents` de la suscripción; no cambia la lógica de facturación.
 */
function AiPricingSection({ workspaceId, currency }: { workspaceId: string; currency: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const productsQ = useQuery({ queryKey: ['products'], queryFn: () => api.get<{ products: Product[] }>('/products'), staleTime: 60_000 });
  const subsQ = useQuery({ queryKey: ['ws-subs', workspaceId], queryFn: () => api.get<SubscriptionsResponse>(`/workspaces/${workspaceId}/subscriptions`) });
  const [drafts, setDrafts] = useState<Record<string, string>>({}); // subId → € por unidad de precio
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['ws-subs', workspaceId] });

  const iaProducts = (productsQ.data?.products ?? []).filter((p) => p.meter?.startsWith('ai_') && p.active && !p.archived && (p.billing_model === 'metered' || p.billing_model === 'tiered'));
  const iaSubs = (subsQ.data?.subscriptions ?? []).filter((s) => s.meter?.startsWith('ai_'));
  const productById = new Map(iaProducts.map((p) => [p.id, p]));
  const assigned = new Set(iaSubs.map((s) => s.product_id));
  const unassigned = iaProducts.filter((p) => !assigned.has(p.id));

  const assign = useMutation({
    mutationFn: () => Promise.all(unassigned.map((p) => api.post(`/workspaces/${workspaceId}/subscriptions`, { productId: p.id }))),
    onSuccess: () => { toast('IA activada para este cliente', 'ok'); invalidate(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const setPrice = useMutation({
    mutationFn: ({ subId, unitCents }: { subId: string; unitCents: number | null }) => api.patch(`/subscriptions/${subId}`, { unitCents }),
    onSuccess: () => { toast('Precio del cliente guardado', 'ok'); invalidate(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const clearDraft = (subId: string) => setDrafts((prev) => { const n = { ...prev }; delete n[subId]; return n; });

  if (iaProducts.length === 0 && iaSubs.length === 0) {
    return (
      <section className="card p-5">
        <h2 className="text-base font-semibold">Precios de IA de este cliente</h2>
        <p className="mt-2 text-xs text-subtle">Crea primero productos de IA (medidos por tokens) en el <a href="/catalog" className="text-acc-soft hover:underline">catálogo</a>. Luego podrás activarlos para este cliente en un clic y darle un precio propio.</p>
      </section>
    );
  }

  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-base font-semibold">Precios de IA de este cliente</h2>
        {unassigned.length > 0 && (
          <Button size="sm" onClick={() => assign.mutate()} loading={assign.isPending}>
            <Plus size={13} /> {iaSubs.length === 0 ? 'Facturar IA a este cliente' : 'Añadir productos nuevos'}
          </Button>
        )}
      </div>

      {iaSubs.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-subtle">Este cliente aún no factura IA. Actívalo para cobrarle el consumo a los precios del catálogo; después puedes darle un precio propio por medidor.</p>
      ) : (
        iaSubs.map((s, i) => {
          const prod = productById.get(s.product_id);
          const globalCents = prod?.price_cents ?? s.unit_cents; // PVP global de referencia
          const val = drafts[s.id] !== undefined ? drafts[s.id] : s.frozen ? String(s.unit_cents / 100) : '';
          const savePrice = () => {
            // Se guarda lo que MUESTRA el campo (`val`), no solo el borrador: si el
            // operador pulsaba Guardar sin tocar nada, `drafts[s.id]` estaba vacío y
            // el precio pactado se borraba volviendo al del catálogo.
            const raw = val.trim();
            const unitCents = raw === '' ? null : Math.max(0, Math.round((parseFloat(raw.replace(',', '.')) || 0) * 100));
            setPrice.mutate({ subId: s.id, unitCents });
            clearDraft(s.id);
          };
          return (
            <div key={s.id} className={cx('flex flex-wrap items-center gap-3 px-4 py-3', i > 0 && 'border-t border-line')}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{s.product_name}</span>
                  <StatusBadge tone={s.frozen ? 'info' : 'neutral'} label={s.frozen ? 'precio propio' : 'precio global'} dot={false} className="text-micro" />
                </div>
                <p className="mt-0.5 text-xs text-subtle tnum">Global {fmtMoney(globalCents, currency)} · por {prod?.unit || 'ud'}</p>
              </div>
              {/* Un producto por TRAMOS se tarifa siempre con su tabla de tramos:
                  el precio por cuenta no lo aplica el motor de facturación, así que
                  no se ofrece aquí (prometía un descuento que no se cobraría). */}
              {prod?.billing_model === 'tiered' ? (
                <p className="shrink-0 text-xs text-subtle">
                  Precio por tramos: se edita en el <a href="/catalog" className="text-acc-soft hover:underline">catálogo</a>.
                </p>
              ) : (
                <div className="flex shrink-0 items-center gap-1.5">
                  <div className="relative">
                    <input className="input h-8 w-28 tnum pr-7" inputMode="decimal" value={val} placeholder={String(globalCents / 100)}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [s.id]: e.target.value }))} />
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-subtle">{currency === 'EUR' ? '€' : currency}</span>
                  </div>
                  <Button size="sm" variant="ghost" loading={setPrice.isPending && setPrice.variables?.subId === s.id} onClick={savePrice}>Guardar</Button>
                  {s.frozen && (
                    <button className="rounded p-1.5 text-subtle hover:bg-surface2 hover:text-txt" title="Volver al precio global" onClick={() => { setPrice.mutate({ subId: s.id, unitCents: null }); clearDraft(s.id); }}><Undo2 size={14} /></button>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
      <p className="border-t border-line px-4 py-2.5 text-xs text-subtle">
        Deja el precio vacío para usar el <a href="/catalog" className="text-acc-soft hover:underline">precio global</a> del catálogo. Un precio propio solo afecta a este cliente y no recibe el descuento por cuenta (ya es un precio pactado).
      </p>
    </section>
  );
}

function BillingSettings({ detail, onSaved }: { detail: Detail; onSaved: () => void }) {
  const toast = useToast();
  const ws = detail.workspace;
  const [email, setEmail] = useState(ws.billing_email ?? '');
  const [taxId, setTaxId] = useState(ws.billing_tax_id ?? '');
  const [address, setAddress] = useState(ws.billing_address ?? '');
  const [country, setCountry] = useState(ws.billing_country ?? DEFAULT_COUNTRY);
  const [day, setDay] = useState(String(ws.billing_day));
  const initDisc = ws.discount_pct == null ? '' : String(ws.discount_pct);
  const [disc, setDisc] = useState(initDisc);
  const [notes, setNotes] = useState(ws.notes ?? '');
  const dirty =
    email !== (ws.billing_email ?? '') ||
    taxId !== (ws.billing_tax_id ?? '') ||
    address !== (ws.billing_address ?? '') ||
    country !== (ws.billing_country ?? DEFAULT_COUNTRY) ||
    day !== String(ws.billing_day) ||
    disc !== initDisc ||
    notes !== (ws.notes ?? '');
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/workspaces/${ws.id}`, {
        billingEmail: email.trim() || null,
        billingTaxId: taxId.trim() || null,
        billingAddress: address.trim() || null,
        billingCountry: country,
        billingDay: Number(day) || 1,
        // Vacío = hereda el descuento del plan (null); un número lo sobreescribe.
        discountPct: disc.trim() === '' ? null : Math.max(0, Math.min(100, Number(disc) || 0)),
        notes: notes.trim() || null,
      }),
    onSuccess: () => { toast('Datos de facturación guardados', 'ok'); onSaved(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  return (
    <section className="card p-5">
      <h2 className="mb-3 text-base font-semibold">Datos de facturación del cliente</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="NIF / CIF" hint="Obligatorio en factura completa"><input className="input" value={taxId} onChange={(e) => setTaxId(e.target.value)} placeholder="B12345678" /></Field>
        <Field label="Email de facturación"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="pagos@cliente.com" /></Field>
      </div>
      <Field label="Domicilio fiscal"><textarea className="input min-h-14" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Calle, nº · CP Población · Provincia" /></Field>
      <Field label="País" hint="Determina el régimen de IVA aplicable">
        <select className="input" value={country} onChange={(e) => setCountry(e.target.value)}>
          {COUNTRY_OPTIONS.map((c) => (
            <option key={c.code} value={c.code}>{c.name}</option>
          ))}
        </select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Día de cobro" hint="1–28"><input className="input tnum" type="number" min={1} max={28} value={day} onChange={(e) => setDay(e.target.value)} /></Field>
        <Field label="Descuento (%)" hint="vacío = hereda el del plan"><input className="input tnum" type="number" min={0} max={100} step="0.5" value={disc} onChange={(e) => setDisc(e.target.value)} placeholder="del plan" /></Field>
      </div>
      <Field label="Notas internas"><textarea className="input min-h-16" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Condiciones, contacto, referencia…" /></Field>
      <div className="mt-3 flex justify-end">
        <Button size="sm" onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>Guardar</Button>
      </div>
    </section>
  );
}

// ---------------- Página ----------------

export default function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('resumen');
  const [toDelete, setToDelete] = useState(false);

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), staleTime: 60_000 });
  const isAdmin = me.data?.user?.role === 'admin';

  const detail = useQuery({ queryKey: ['workspace', id], queryFn: () => api.get<Detail>(`/workspaces/${id}`) });
  const modules = useQuery({ queryKey: ['modules'], queryFn: () => api.get<{ modules: ModuleDef[] }>('/modules'), staleTime: 300_000 });
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api.get<{ plans: Plan[] }>('/plans'), enabled: isAdmin });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['workspace', id] });
    queryClient.invalidateQueries({ queryKey: ['workspaces'] });
  };

  const setStatus = useMutation({
    mutationFn: (status: 'active' | 'suspended') => api.patch(`/workspaces/${id}`, { status }),
    onSuccess: (_r, status) => { toast(status === 'suspended' ? 'Cuenta suspendida' : 'Cuenta reactivada', 'ok'); refresh(); },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/workspaces/${id}`),
    onSuccess: () => { toast('Cuenta eliminada', 'ok'); queryClient.invalidateQueries({ queryKey: ['workspaces'] }); navigate('/workspaces'); },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  if (detail.isLoading) {
    return (
      <div className="mx-auto max-w-[900px] px-4 py-8 sm:px-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-6 h-64 w-full" />
      </div>
    );
  }
  if (detail.isError || !detail.data) {
    return <p className="mx-auto max-w-[900px] px-6 py-10 text-sm text-sub">No se pudo cargar la cuenta. {String((detail.error as Error)?.message ?? '')}</p>;
  }

  const d = detail.data;
  const ws = d.workspace;
  const suspended = ws.status === 'suspended';

  const tabs = [
    { key: 'resumen', label: 'Resumen y cuota' },
    { key: 'uso', label: 'Uso' },
    { key: 'modulos', label: 'Módulos' },
    { key: 'usuarios', label: 'Usuarios' },
    { key: 'facturacion', label: 'Facturación' },
  ];

  return (
    <div className="mx-auto max-w-[900px] px-4 py-7 sm:px-6 sm:py-9">
      <Link to="/workspaces" className="mb-4 inline-flex items-center gap-1.5 text-xs text-subtle hover:text-txt">
        <ArrowLeft size={13} /> Cuentas y clientes
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold">{ws.name}</h1>
            <StatusBadge tone={suspended ? 'warn' : 'ok'} label={suspended ? 'suspendida' : 'activa'} dot={!suspended} />
          </div>
          <p className="mt-1 text-sm text-sub">
            {ws.plan ? `Plan ${ws.plan.name}` : 'Sin plan'} · {ws.allocation.projects} proyectos · {ws.allocation.members} usuarios
          </p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            {suspended ? (
              <Button size="sm" variant="secondary" onClick={() => setStatus.mutate('active')} loading={setStatus.isPending}>
                <Play size={13} /> Reactivar
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setStatus.mutate('suspended')} loading={setStatus.isPending}>
                <Pause size={13} /> Suspender
              </Button>
            )}
            <button onClick={() => setToDelete(true)} className="rounded-lg border border-err/35 bg-err/[.10] p-2 text-err hover:bg-err/20" title="Eliminar cuenta">
              <Trash2 size={15} />
            </button>
          </div>
        )}
      </div>

      {suspended && (
        <div className="mb-5 flex items-center gap-2 rounded-xl border border-warn/30 bg-warn/[.09] px-4 py-2.5 text-xs text-warn">
          <Pause size={14} /> Cuenta suspendida: los despliegues y las operaciones nuevas están detenidos hasta reactivarla. Los servicios en marcha siguen vivos.
        </div>
      )}

      <Tabs tabs={tabs} active={tab} onChange={setTab} className="mb-5" />
      {/* La clave incluye el id: al cambiar de cuenta se remonta el contenido y
          se reinicia el estado derivado (cuota editable, módulos, borradores). */}
      <div key={`${ws.id}:${tab}`} className="tab-in">
        {tab === 'resumen' && <ResumenTab detail={d} isAdmin={!!isAdmin} plans={plans.data?.plans ?? []} onSaved={refresh} />}
        {tab === 'uso' && <UsoTab detail={d} />}
        {tab === 'modulos' && <ModulosTab detail={d} isAdmin={!!isAdmin} modules={modules.data?.modules ?? []} onSaved={refresh} />}
        {tab === 'usuarios' && <UsuariosTab detail={d} isAdmin={!!isAdmin} onSaved={refresh} />}
        {tab === 'facturacion' && <FacturacionTab detail={d} isAdmin={!!isAdmin} onSaved={refresh} />}
      </div>

      <ConfirmModal
        open={toDelete}
        onClose={() => setToDelete(false)}
        onConfirm={() => remove.mutate()}
        title="Eliminar cuenta"
        message={`«${ws.name}» y sus ${d.members.length} usuario(s) se eliminan. Sus ${d.projects.length} proyecto(s) quedan sin asignar (no se borran).`}
        loading={remove.isPending}
      />
    </div>
  );
}
