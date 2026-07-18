import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { KeyRound, ScrollText, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { Button, Field, Spinner, useToast } from '../components/ui';
import { AuditEntry, SecurityReport } from '../types';
import { AUDIT_ACTION_LABEL, cx, fmtDateTime, SEVERITY_LABEL, SEVERITY_STYLE } from '../utils';

function ScoreBadge({ score, grade }: { score: number; grade: string }) {
  const color =
    grade === 'A' ? 'text-ok border-ok/50' : grade === 'B' ? 'text-acc2 border-acc2/50' : grade === 'C' ? 'text-warn border-warn/50' : 'text-err border-err/50';
  return (
    <div className={cx('flex h-20 w-20 flex-col items-center justify-center rounded-2xl border-2 bg-panel2', color)}>
      <span className="text-2xl font-bold">{grade}</span>
      <span className="text-[11px] text-sub">{score}/100</span>
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

  if (report.isLoading) return <Spinner label="Analizando seguridad..." />;
  if (!report.data) return <p className="p-8 text-center text-sm text-sub">No se pudo cargar el informe.</p>;

  const { findings, score, grade } = report.data;
  const bySeverity = { critical: findings.filter((f) => f.severity === 'critical'), warning: findings.filter((f) => f.severity === 'warning'), info: findings.filter((f) => f.severity === 'info') };

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <div className="flex items-center gap-3">
        <ShieldCheck size={22} className="text-acc" />
        <div>
          <h1 className="text-xl font-semibold">Panel de seguridad</h1>
          <p className="text-sm text-sub">Revisión continua de la configuración de todos los proyectos</p>
        </div>
      </div>

      <section className="card flex items-center gap-5 p-6">
        <ScoreBadge score={score} grade={grade} />
        <div className="text-sm">
          <p>
            <span className="text-err">{bySeverity.critical.length} crítico(s)</span> ·{' '}
            <span className="text-warn">{bySeverity.warning.length} aviso(s)</span> ·{' '}
            <span className="text-acc2">{bySeverity.info.length} informativo(s)</span>
          </p>
          <p className="mt-1 text-xs text-sub">
            La puntuación baja con cada hallazgo crítico (−25) o aviso (−10). Corrige los hallazgos y el análisis se
            actualiza al momento.
          </p>
        </div>
      </section>

      <section className="space-y-3">
        {(['critical', 'warning', 'info'] as const).map((sev) =>
          bySeverity[sev].map((f) => (
            <details key={f.id} className="card group p-4" open={sev === 'critical'}>
              <summary className="flex cursor-pointer list-none items-center gap-3">
                <span className={cx('shrink-0 rounded-full border px-2 py-0.5 text-[11px]', SEVERITY_STYLE[sev])}>
                  {SEVERITY_LABEL[sev]}
                </span>
                <span className="text-sm font-medium">{f.title}</span>
                {f.projectId && (
                  <Link
                    to={`/projects/${f.projectId}${f.serviceId ? `?s=${f.serviceId}` : ''}`}
                    onClick={(e) => e.stopPropagation()}
                    className="ml-auto shrink-0 text-xs text-acc hover:underline"
                  >
                    {f.projectName} →
                  </Link>
                )}
              </summary>
              <div className="mt-3 space-y-2 border-t border-line pt-3 text-sm">
                <p className="text-sub">{f.detail}</p>
                <p>
                  <span className="font-medium text-ok">Cómo arreglarlo: </span>
                  <span className="text-sub">{f.fix}</span>
                </p>
              </div>
            </details>
          )),
        )}
      </section>

      <section className="card p-6">
        <div className="mb-4 flex items-center gap-2">
          <KeyRound size={16} className="text-acc" />
          <h2 className="text-sm font-semibold">Cuenta y sesiones</h2>
        </div>
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            changePassword.mutate();
          }}
        >
          <Field label="Contraseña actual">
            <input className="input" type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} required />
          </Field>
          <Field label="Nueva contraseña" hint="Mínimo 8 caracteres; usa una larga y única">
            <input className="input" type="password" value={nextPw} onChange={(e) => setNextPw(e.target.value)} required minLength={8} />
          </Field>
          <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-3">
            <Button type="submit" loading={changePassword.isPending}>
              Cambiar contraseña
            </Button>
            <Button
              type="button"
              variant="outline"
              loading={rotateSessions.isPending}
              onClick={() => rotateSessions.mutate()}
              title="Invalida las cookies de sesión en todos los navegadores excepto este"
            >
              Cerrar sesión en todos los dispositivos
            </Button>
          </div>
        </form>
      </section>

      <section className="card p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ScrollText size={16} className="text-acc" />
            <h2 className="text-sm font-semibold">Registro de actividad</h2>
          </div>
          <select className="input w-auto text-xs" value={auditFilter} onChange={(e) => setAuditFilter(e.target.value)}>
            <option value="">Todo</option>
            <option value="login">Accesos</option>
            <option value="service">Servicios</option>
            <option value="project">Proyectos</option>
            <option value="settings">Ajustes</option>
            <option value="webhook">Webhooks</option>
          </select>
        </div>
        <div className="max-h-96 overflow-y-auto rounded-lg border border-line">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-panel2 text-sub">
              <tr>
                <th className="px-3 py-2 font-medium">Cuándo</th>
                <th className="px-3 py-2 font-medium">Quién</th>
                <th className="px-3 py-2 font-medium">Acción</th>
                <th className="px-3 py-2 font-medium">Detalle</th>
                <th className="px-3 py-2 font-medium">IP</th>
              </tr>
            </thead>
            <tbody>
              {(auditLog.data?.entries ?? []).map((entry) => (
                <tr key={entry.id} className="border-t border-line/60">
                  <td className="whitespace-nowrap px-3 py-2 text-sub">{fmtDateTime(entry.ts)}</td>
                  <td className="px-3 py-2">{entry.actor}</td>
                  <td className="px-3 py-2">
                    <span
                      className={cx(
                        entry.action.includes('failed') || entry.action.includes('blocked') ? 'text-err' : 'text-txt',
                      )}
                    >
                      {AUDIT_ACTION_LABEL[entry.action] ?? entry.action}
                    </span>
                  </td>
                  <td className="max-w-[260px] truncate px-3 py-2 text-sub">{entry.detail ?? entry.target_id ?? ''}</td>
                  <td className="px-3 py-2 font-mono text-sub">{entry.ip ?? ''}</td>
                </tr>
              ))}
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
