import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronDown, KeyRound, ScrollText } from 'lucide-react';
import { api } from '../api';
import { Button, Chip, ErrorState, Field, Skeleton, StatusBadge, useToast } from '../components/ui';
import { AuditEntry, SecurityFinding, SecurityReport } from '../types';
import { AUDIT_ACTION_LABEL, cx, fmtDateTime, SEVERITY_LABEL, SEVERITY_TONE } from '../utils';

const GRADE_COLOR: Record<string, string> = {
  A: 'var(--color-ok)',
  B: 'var(--color-info)',
  C: 'var(--color-warn)',
};

/** Anillo SVG de puntuación: progreso proporcional al score, en el tono de la nota. Se dibuja al entrar. */
function ScoreRing({ score, grade }: { score: number; grade: string }) {
  const color = GRADE_COLOR[grade] ?? 'var(--color-err)';
  const C = 238.7; // 2πr con r=38
  const offset = C * (1 - Math.max(0, Math.min(100, score)) / 100);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="relative h-[88px] w-[88px] shrink-0">
      <svg viewBox="0 0 88 88" className="block h-[88px] w-[88px] -rotate-90">
        <circle cx="44" cy="44" r="38" fill="none" stroke="var(--color-line)" strokeWidth="7" />
        <circle
          cx="44"
          cy="44"
          r="38"
          fill="none"
          stroke={color}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={drawn ? offset : C}
          className="transition-[stroke-dashoffset] duration-300 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold leading-none" style={{ color }}>
          {grade}
        </span>
        <span className="tnum text-xs text-subtle">{score}/100</span>
      </div>
    </div>
  );
}

/** Cabecera de sección: el icono anota el título a escala de texto, sin caja. */
function SectionHeader({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div>
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <span aria-hidden className="text-sub [&>svg]:block">
          {icon}
        </span>
        {title}
      </h2>
      <p className="mt-1 text-xs text-subtle">{description}</p>
    </div>
  );
}

function SecuritySkeleton() {
  return (
    <div aria-busy className="mx-auto flex max-w-[880px] flex-col gap-5 px-4 py-7 sm:px-6 sm:py-10">
      <div>
        <Skeleton className="h-7 w-64" />
        <Skeleton className="mt-2.5 h-4 w-96 max-w-full" />
      </div>
      <div className="card flex items-center gap-6 p-6">
        <Skeleton className="h-[88px] w-[88px] rounded-full" />
        <div className="flex-1">
          <div className="flex gap-2">
            <Skeleton className="h-6 w-20 rounded-full" />
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          <Skeleton className="mt-3 h-3.5 w-3/4" />
        </div>
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full rounded-xl" />
      ))}
    </div>
  );
}

export default function SecurityPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [currentPw, setCurrentPw] = useState('');
  const [nextPw, setNextPw] = useState('');
  const [auditFilter, setAuditFilter] = useState('');

  const report = useQuery({
    queryKey: ['security'],
    queryFn: () => api.get<SecurityReport>('/security'),
    refetchInterval: 60_000,
  });

  const auditLog = useQuery({
    queryKey: ['audit', auditFilter],
    queryFn: () => api.get<{ entries: AuditEntry[] }>(`/audit?limit=100${auditFilter ? `&action=${auditFilter}` : ''}`),
  });

  const changePassword = useMutation({
    mutationFn: () => api.post('/auth/password', { current: currentPw, next: nextPw }),
    onSuccess: () => {
      setCurrentPw('');
      setNextPw('');
      toast('Contraseña actualizada', 'ok');
      queryClient.invalidateQueries({ queryKey: ['audit'] });
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const rotateSessions = useMutation({
    mutationFn: () => api.post('/security/rotate-sessions'),
    onSuccess: () => {
      toast('Todas las demás sesiones han sido invalidadas', 'ok');
      queryClient.invalidateQueries({ queryKey: ['audit'] });
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  if (report.isLoading) return <SecuritySkeleton />;
  if (!report.data)
    return (
      <ErrorState
        title="No se ha podido cargar el informe de seguridad"
        error={report.error}
        onRetry={() => report.refetch()}
        retrying={report.isFetching}
      />
    );

  const { findings, score, grade } = report.data;
  const counts = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
  const ordered = (['critical', 'warning', 'info'] as const).flatMap((sev) => findings.filter((f) => f.severity === sev));

  // Los hallazgos repetidos del mismo tipo (p. ej. «Sin límites de recursos: <servicio>» por cada
  // servicio) se agrupan en una sola tarjeta con chips: la lista respira y la severidad se lee.
  const groups: { kind: string; base: string; items: SecurityFinding[] }[] = [];
  for (const f of ordered) {
    const base = f.title.split(':')[0].trim();
    const kind = `${f.severity}|${base}`;
    const g = groups.find((x) => x.kind === kind);
    if (g) g.items.push(f);
    else groups.push({ kind, base, items: [f] });
  }

  return (
    <div className="mx-auto flex max-w-[880px] flex-col gap-5 px-4 py-7 sm:px-6 sm:py-10">
      <div className="mb-2">
        <h1 className="text-2xl font-semibold">Panel de seguridad</h1>
        <p className="mt-1.5 text-sm text-sub">Revisión continua de la configuración de todos los proyectos</p>
      </div>

      <section className="card flex flex-wrap items-center gap-6 p-6">
        <ScoreRing score={score} grade={grade} />
        <div className="min-w-[240px] flex-1">
          <div className="flex flex-wrap gap-2">
            {counts.critical > 0 && (
              <Chip tone="err">
                <span className="tnum">{counts.critical}</span> crítico{counts.critical !== 1 && 's'}
              </Chip>
            )}
            {counts.warning > 0 && (
              <Chip tone="warn">
                <span className="tnum">{counts.warning}</span> aviso{counts.warning !== 1 && 's'}
              </Chip>
            )}
            {counts.info > 0 && (
              <Chip tone="info">
                <span className="tnum">{counts.info}</span> informativo{counts.info !== 1 && 's'}
              </Chip>
            )}
            {findings.length === 0 && (
              <Chip tone="ok" dot>
                Sin hallazgos: todo en orden
              </Chip>
            )}
          </div>
          <p className="mt-2.5 text-xs text-sub">
            La puntuación baja con cada hallazgo crítico (−25) o aviso (−10). Corrige los hallazgos y el análisis se
            actualiza al momento.
          </p>
        </div>
      </section>

      {ordered.length > 0 && (
        <section className="flex flex-col gap-2.5">
          {groups.map((g) => {
            const f = g.items[0];
            // A partir de 3 repeticiones, una tarjeta agrupada con un chip por servicio afectado.
            if (g.items.length >= 3) {
              return (
                <details
                  key={g.kind}
                  open={f.severity === 'critical'}
                  className={cx(
                    'group animate-details rounded-xl border bg-surface p-4',
                    f.severity === 'critical' ? 'border-err/35' : 'border-line',
                  )}
                >
                  <summary className="flex cursor-pointer items-center gap-3">
                    <StatusBadge tone={SEVERITY_TONE[f.severity]} label={SEVERITY_LABEL[f.severity]} dot={false} className="font-semibold" />
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{g.base}</span>
                    <span className="tnum ml-auto shrink-0 rounded-md border border-line bg-surface2 px-1.5 py-0.5 text-xs font-medium text-sub">
                      {g.items.length} servicios
                    </span>
                    <ChevronDown
                      size={14}
                      className="shrink-0 text-subtle transition-transform duration-200 ease-out group-open:rotate-180"
                    />
                  </summary>
                  <div className="details-body mt-3 flex flex-col gap-2.5 border-t border-line pt-3 text-sm">
                    <div className="flex flex-wrap gap-1.5">
                      {g.items.map((i) => (
                        <Link
                          key={i.id}
                          to={i.projectId ? `/projects/${i.projectId}${i.serviceId ? `?s=${i.serviceId}` : ''}` : '#'}
                          className="rounded-md border border-line bg-bg px-1.5 py-0.5 font-mono text-xs text-sub transition-colors duration-[--dur-1] hover:border-line2 hover:text-txt"
                        >
                          {i.title.includes(':') ? i.title.split(':').slice(1).join(':').trim() : i.projectName ?? i.title}
                          {i.projectName ? ` · ${i.projectName}` : ''}
                        </Link>
                      ))}
                    </div>
                    <p>
                      <span className="font-semibold text-ok">Cómo arreglarlo: </span>
                      <span className="text-sub">{f.fix}</span>
                    </p>
                  </div>
                </details>
              );
            }
            return g.items.map((f) => (
              <details
                key={f.id}
                open={f.severity === 'critical'}
                className={cx(
                  'group animate-details rounded-xl border bg-surface p-4',
                  f.severity === 'critical' ? 'border-err/35' : 'border-line',
                )}
              >
                <summary className="flex cursor-pointer items-center gap-3">
                  <StatusBadge tone={SEVERITY_TONE[f.severity]} label={SEVERITY_LABEL[f.severity]} dot={false} className="font-semibold" />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{f.title}</span>
                  {f.projectId && (
                    <Link
                      to={`/projects/${f.projectId}${f.serviceId ? `?s=${f.serviceId}` : ''}`}
                      onClick={(e) => e.stopPropagation()}
                      className="ml-auto shrink-0 text-xs text-acc-soft hover:underline"
                    >
                      {f.projectName} →
                    </Link>
                  )}
                  <ChevronDown
                    size={14}
                    className={cx('shrink-0 text-subtle transition-transform duration-200 ease-out group-open:rotate-180', !f.projectId && 'ml-auto')}
                  />
                </summary>
                <div className="details-body mt-3 flex flex-col gap-2 border-t border-line pt-3 text-sm">
                  <p className="text-sub">{f.detail}</p>
                  <p>
                    <span className="font-semibold text-ok">Cómo arreglarlo: </span>
                    <span className="text-sub">{f.fix}</span>
                  </p>
                </div>
              </details>
            ));
          })}
        </section>
      )}

      <section className="card p-5">
        <div className="mb-4">
          <SectionHeader
            icon={<KeyRound size={15} />}
            title="Cuenta y sesiones"
            description="Cambia la contraseña o invalida las sesiones abiertas en otros navegadores"
          />
        </div>
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            changePassword.mutate();
          }}
        >
          <Field label="Contraseña actual">
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={currentPw}
              onChange={(e) => setCurrentPw(e.target.value)}
              required
            />
          </Field>
          <Field label="Nueva contraseña" hint="Mínimo 8 caracteres; usa una larga y única">
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={nextPw}
              onChange={(e) => setNextPw(e.target.value)}
              required
              minLength={8}
            />
          </Field>
          <div className="flex flex-wrap items-center justify-between gap-3 sm:col-span-2">
            <Button type="submit" size="sm" loading={changePassword.isPending}>
              Cambiar contraseña
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              loading={rotateSessions.isPending}
              onClick={() => rotateSessions.mutate()}
              title="Invalida las cookies de sesión en todos los navegadores excepto este"
            >
              Cerrar sesión en todos los dispositivos
            </Button>
          </div>
        </form>
      </section>

      <section className="card p-5">
        <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
          <SectionHeader
            icon={<ScrollText size={15} />}
            title="Registro de actividad"
            description="Auditoría completa: accesos, despliegues, cambios de configuración"
          />
          <select className="input w-auto text-xs" value={auditFilter} onChange={(e) => setAuditFilter(e.target.value)}>
            <option value="">Todo</option>
            <option value="login">Accesos</option>
            <option value="service">Servicios</option>
            <option value="project">Proyectos</option>
            <option value="settings">Ajustes</option>
            <option value="webhook">Webhooks</option>
          </select>
        </div>
        <div className="max-h-[380px] overflow-y-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-[1] bg-surface2 text-sub">
              <tr>
                {['Cuándo', 'Quién', 'Acción', 'Detalle', 'IP'].map((h) => (
                  <th key={h} className="px-3.5 py-2 eyebrow">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(auditLog.data?.entries ?? []).map((entry) => {
                const failed = entry.action.includes('failed') || entry.action.includes('blocked');
                return (
                  <tr key={entry.id} className={cx('border-t border-line', failed && 'bg-err/[.04]')}>
                    <td className="whitespace-nowrap px-3.5 py-2 font-mono text-xs text-subtle">{fmtDateTime(entry.ts)}</td>
                    <td className="px-3.5 py-2">{entry.actor}</td>
                    <td className="px-3.5 py-2">
                      <span className={cx(failed && 'font-medium text-err')}>
                        {AUDIT_ACTION_LABEL[entry.action] ?? entry.action}
                      </span>
                    </td>
                    <td className="max-w-[240px] truncate px-3.5 py-2 text-sub">{entry.detail ?? entry.target_id ?? ''}</td>
                    <td className="px-3.5 py-2 font-mono text-xs text-subtle">{entry.ip ?? ''}</td>
                  </tr>
                );
              })}
              {(auditLog.data?.entries ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-sub">
                    Sin actividad registrada
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
