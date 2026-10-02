import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, PackageCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { IntegrationPlan, PlanApplyResult, PlanResource, PlanStatus, PlanVar } from '../types';
import { cx, Tone } from '../utils';
import { isModuleKind, ModuleLogo, moduleFg } from './ModuleIcon';
import { Button, Chip, useToast } from './ui';

/** Estado de un elemento del plan, en palabras y con su tono. */
function statusChip(status: PlanStatus, privileged: boolean, canApprove: boolean): { label: string; tone: Tone } {
  if (status === 'apply') return privileged && !canApprove ? { label: 'Requiere aprobación', tone: 'warn' } : { label: 'Se aplicará', tone: 'info' };
  if (status === 'done') return { label: 'Aplicada', tone: 'ok' };
  if (status === 'manual') return { label: 'Puesta a mano', tone: 'neutral' };
  return { label: 'Pendiente', tone: 'warn' };
}

/** Qué pone Skyway en la variable, en una frase corta. */
function originLabel(v: PlanVar): string {
  if (v.from === 'generate') return 'secreto generado';
  if (v.from === 'value') return 'valor';
  if (v.from === 'empty') return 'vacía';
  if (v.from === 'self.public_url') return 'URL pública propia';
  if (v.resource === 'mail') return 'correo';
  return 'base de datos';
}

function resourceText(r: PlanResource): string {
  if (r.key === 'mail') {
    const modo = r.mode === 'api' ? 'API de envío' : 'SMTP';
    if (r.action === 'create') return `Correo (${modo}): crear el buzón ${r.target} y su credencial`;
    if (r.action === 'reuse') return `Correo (${modo}): credencial del buzón ${r.target}`;
    return `Correo (${modo})`;
  }
  return r.action === 'reuse' ? `${r.label}: conectar a «${r.target}» del proyecto` : `${r.label}: crear la base en el proyecto`;
}

/** Recurso del que depende una variable privilegiada. */
function resourceOf(plan: IntegrationPlan, v: PlanVar): PlanResource | undefined {
  return plan.resources.find((r) => r.key === v.resource);
}

/** ¿Hay algo que quien mira el plan pueda aplicar ahora (lo inofensivo o lo que puede aprobar)? */
export function planHasApplicable(plan: IntegrationPlan): boolean {
  return plan.vars.some((v) => v.status === 'apply' && (!v.privileged || !!resourceOf(plan, v)?.canApprove));
}

/** Recurso que pide confirmar expresamente el acceso al buzón, si quien mira puede aprobarlo. */
export function mailConfirmation(plan: IntegrationPlan): PlanResource | null {
  return plan.resources.find((r) => r.key === 'mail' && r.status === 'apply' && r.canApprove && !!r.confirmation) ?? null;
}

/**
 * El plan de integraciones de una web (lo que pide su skyway.json o lo que se
 * ha detectado): recursos que se crean o reutilizan y variables que se
 * escriben, con su estado. Sin efectos: aplicarlo es cosa de quien lo enseña.
 * Con `onToggle`, cada recurso por aplicar lleva una casilla para omitirlo; con
 * `onConfirmMail`, el buzón que se reutiliza lleva la casilla que confirma el
 * acceso que da su credencial (sin marcarla, el correo queda pendiente).
 */
export function IntegrationPlanView({
  plan,
  skip,
  onToggle,
  confirmMail,
  onConfirmMail,
}: {
  plan: IntegrationPlan;
  skip?: ReadonlySet<string>;
  onToggle?: (key: string, include: boolean) => void;
  confirmMail?: boolean;
  onConfirmMail?: (confirmed: boolean) => void;
}) {
  if (plan.manifestError) {
    return (
      <p className="text-xs text-warn">
        {plan.manifestError} Corrígelo en el repositorio: mientras tanto no se aplica nada del manifiesto.
      </p>
    );
  }
  const hasEmpty = plan.vars.some((v) => v.from === 'empty' && v.status === 'apply');
  const harmless = plan.vars.filter((v) => !v.privileged);
  const noApprovable = plan.resources.filter((r) => r.status === 'apply' && !r.canApprove);
  return (
    <div className="flex flex-col gap-2.5 text-xs">
      {plan.resources.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {plan.resources.map((r) => {
            const chip = statusChip(r.status, true, r.canApprove);
            const togglable = !!onToggle && r.status === 'apply';
            const confirm = r.status === 'apply' && r.canApprove && r.confirmation && !skip?.has(r.key) ? r.confirmation : null;
            const kind = isModuleKind(r.key) ? r.key : null;
            const body = (
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="shrink-0" style={kind ? { color: moduleFg(kind) } : undefined}>
                    {kind ? <ModuleLogo kind={kind} size={13} /> : <Mail size={13} className="text-acc-soft" aria-hidden />}
                  </span>
                  <span className="text-txt">{resourceText(r)}</span>
                  <Chip size="sm" tone={chip.tone}>
                    {chip.label}
                  </Chip>
                </span>
                {r.reason && <span className="text-subtle">{r.reason}</span>}
                <span className="break-words font-mono text-subtle">
                  {plan.vars
                    .filter((v) => v.resource === r.key)
                    .map((v) => v.name)
                    .join(', ')}
                </span>
              </span>
            );
            const row = togglable ? (
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-acc"
                  checked={!skip?.has(r.key)}
                  onChange={(e) => onToggle?.(r.key, e.target.checked)}
                />
                {body}
              </label>
            ) : (
              <div className="flex items-start gap-2">{body}</div>
            );
            return (
              <div key={r.key} className="flex flex-col gap-1">
                {row}
                {confirm &&
                  (onConfirmMail ? (
                    <label className="ml-5 flex cursor-pointer items-start gap-2 rounded-md border border-warn/35 bg-warn/[.07] px-2.5 py-2 text-warn">
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-acc"
                        checked={!!confirmMail}
                        onChange={(e) => onConfirmMail(e.target.checked)}
                      />
                      <span>{confirm} Marca la casilla para confirmarlo; si no, el correo queda pendiente.</span>
                    </label>
                  ) : (
                    <p className="ml-5 text-warn">{confirm}</p>
                  ))}
              </div>
            );
          })}
        </div>
      )}

      {harmless.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-subtle">Sin aprobación (no dan acceso a nada nuevo):</p>
          {harmless.map((v) => {
            const chip = statusChip(v.status, false, plan.canApprove);
            const omitted = v.from === 'empty' && skip?.has('empty');
            return (
              <div key={v.name} className={cx('flex flex-wrap items-center gap-1.5', omitted && 'opacity-50')} title={v.reason ?? undefined}>
                <span className="font-mono font-semibold text-txt">{v.name}</span>
                <span className="text-subtle">{originLabel(v)}</span>
                {v.detail && v.from !== 'empty' && <span className="break-all font-mono text-info">{v.detail}</span>}
                <Chip size="sm" tone={chip.tone}>
                  {chip.label}
                </Chip>
                {v.status === 'blocked' && v.reason && <span className="w-full text-subtle">{v.reason}</span>}
              </div>
            );
          })}
          {hasEmpty && onToggle && (
            <label className="mt-0.5 flex cursor-pointer items-center gap-2 text-sub">
              <input type="checkbox" className="accent-acc" checked={!skip?.has('empty')} onChange={(e) => onToggle('empty', e.target.checked)} />
              Añadir vacías las variables sin valor propuesto
            </label>
          )}
        </div>
      )}

      {noApprovable.length > 0 && (
        <p className="text-subtle">
          El correo lo aprueba quien gestiona el proyecto (propietario de la cuenta o administrador): hasta entonces, el servicio
          se despliega con lo demás.
        </p>
      )}
    </div>
  );
}

/** ¿Hay algo que enseñar en el plan? */
export function planHasContent(plan: IntegrationPlan | null | undefined): plan is IntegrationPlan {
  return !!plan && (!!plan.manifestError || plan.resources.length > 0 || plan.vars.length > 0);
}

/**
 * Integraciones de un servicio existente con `skyway.json`: el plan contra lo
 * que ya tiene, «Cambios pendientes de aprobar» si el manifiesto pide algo
 * nuevo y un solo botón para aplicarlo. Con cambios sin guardar en el editor
 * de variables no se aplica: guardar después pisaría lo escrito.
 */
export function IntegrationsPanel({ serviceId, dirty }: { serviceId: string; dirty: boolean }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['integrations', serviceId],
    queryFn: () => api.get<{ plan: IntegrationPlan | null; pending: string[] }>(`/services/${serviceId}/integrations`),
    staleTime: 30_000,
  });
  const plan = q.data?.plan;
  // La confirmación del buzón vale para el plan que se ha visto: otro plan, otra casilla.
  const [confirmMail, setConfirmMail] = useState(false);
  useEffect(() => setConfirmMail(false), [plan?.fingerprint]);
  const apply = useMutation({
    // La huella liga la aprobación a lo que se ve: si el plan ha cambiado
    // desde entonces (un push con otro manifiesto), el servidor no aplica nada.
    mutationFn: (p: IntegrationPlan) =>
      api.post<{ result: PlanApplyResult; plan: IntegrationPlan; needsRedeploy: boolean; deploymentId: string | null }>(
        `/services/${serviceId}/integrations/apply`,
        { redeploy: true, expect: p.fingerprint, ...(mailConfirmation(p) ? { confirmMailboxAccess: confirmMail } : {}) },
      ),
    onSuccess: (res) => {
      queryClient.setQueryData(['integrations', serviceId], { plan: res.plan, pending: res.result.pending });
      queryClient.invalidateQueries({ queryKey: ['env', serviceId] });
      queryClient.invalidateQueries({ queryKey: ['service', serviceId] });
      const partes: string[] = [];
      if (res.result.applied.length > 0) partes.push(`Se han aplicado ${res.result.applied.length} variable(s)${res.deploymentId ? ' y se ha iniciado un despliegue' : ''}.`);
      if (res.result.pending.length > 0) partes.push(`Quedan ${res.result.pending.length} pendientes de aprobar.`);
      if (res.result.errors.length > 0) partes.push(res.result.errors.join(' '));
      toast(partes.join(' ') || 'No había nada que aplicar.', res.result.errors.length > 0 ? 'err' : 'ok');
    },
    onError: (err: Error) => {
      // El plan ha cambiado: se vuelve a pedir y el botón no vuelve hasta tenerlo.
      if (err instanceof ApiError && err.status === 409) queryClient.invalidateQueries({ queryKey: ['integrations', serviceId] });
      toast(err.message, 'err');
    },
  });

  if (!plan || plan.source !== 'manifest' || !planHasContent(plan)) return null;
  const porAplicar = planHasApplicable(plan);
  const pendientes = plan.pendingApproval.length > 0;
  const aprueba = pendientes && plan.resources.some((r) => r.status === 'apply' && r.canApprove);

  return (
    <div className={cx('rounded-xl border p-3.5', pendientes ? 'border-warn/35 bg-warn/[.07]' : 'border-line bg-surface')}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className={cx('flex items-center gap-1.5 text-xs font-semibold', pendientes ? 'text-warn' : 'text-txt')}>
          <PackageCheck size={14} aria-hidden />
          {pendientes ? 'Cambios pendientes de aprobar' : 'Integraciones'}
          <span className="font-normal text-subtle">· según {plan.manifestFile}</span>
        </p>
        {porAplicar && (
          <Button
            size="sm"
            variant={aprueba ? 'primary' : 'secondary'}
            loading={apply.isPending}
            disabled={dirty || q.isFetching}
            title={dirty ? 'Guarda o descarta los cambios antes de aplicar el plan' : undefined}
            onClick={() => apply.mutate(plan)}
          >
            {aprueba ? 'Aprobar y aplicar' : 'Aplicar'}
          </Button>
        )}
      </div>
      <IntegrationPlanView plan={plan} confirmMail={confirmMail} onConfirmMail={setConfirmMail} />
    </div>
  );
}
