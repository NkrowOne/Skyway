import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, CircleSlash, HelpCircle, Rocket } from 'lucide-react';
import { api } from '../api';
import { PublicServiceState, PublicStatus } from '../types';
import { cx } from '../utils';

const STATE_META: Record<PublicServiceState, { label: string; cls: string; dot: string }> = {
  operational: { label: 'Operativo', cls: 'text-ok', dot: 'bg-ok' },
  degraded: { label: 'Rendimiento degradado', cls: 'text-warn', dot: 'bg-warn' },
  down: { label: 'Caído', cls: 'text-err', dot: 'bg-err' },
  unknown: { label: 'Desconocido', cls: 'text-subtle', dot: 'bg-line' },
};

const OVERALL_META: Record<PublicServiceState, { label: string; icon: React.ReactNode; cls: string }> = {
  operational: {
    label: 'Todos los sistemas operativos',
    icon: <CheckCircle2 size={20} />,
    cls: 'border-ok/35 bg-ok/[.09] text-ok',
  },
  degraded: {
    label: 'Rendimiento degradado en algunos servicios',
    icon: <AlertCircle size={20} />,
    cls: 'border-warn/35 bg-warn/[.09] text-warn',
  },
  down: {
    label: 'Incidencia en curso',
    icon: <CircleSlash size={20} />,
    cls: 'border-err/35 bg-err/[.09] text-err',
  },
  unknown: {
    label: 'Estado desconocido',
    icon: <HelpCircle size={20} />,
    cls: 'border-line bg-surface text-sub',
  },
};

/** Color de cada barra diaria según su disponibilidad. */
function dayColor(pct: number | null): string {
  if (pct === null) return 'bg-surface2';
  if (pct >= 99.5) return 'bg-ok';
  if (pct >= 95) return 'bg-warn';
  return 'bg-err';
}

function fmtDay(ts: number): string {
  return new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'short' });
}

function fmtPct(pct: number | null): string {
  return pct === null ? '—' : `${pct.toFixed(pct >= 99.995 ? 0 : 2)}%`;
}

function UptimeBars({ days }: { days: { date: number; pct: number | null }[] }) {
  const [tip, setTip] = useState<{ idx: number; text: string } | null>(null);
  return (
    <div className="relative">
      {tip && (
        <div className="pointer-events-none absolute -top-8 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-surface2 px-2 py-1 text-[10.5px] text-txt shadow-lvl3"
          style={{ left: `${((tip.idx + 0.5) / days.length) * 100}%` }}
        >
          {tip.text}
        </div>
      )}
      <div className="flex h-8 items-stretch gap-px">
        {days.map((d, i) => (
          <div
            key={d.date}
            className={cx('min-w-0 flex-1 rounded-[2px] transition-opacity', dayColor(d.pct), tip && tip.idx !== i && 'opacity-70')}
            onMouseEnter={() => setTip({ idx: i, text: `${fmtDay(d.date)}: ${d.pct === null ? 'sin datos' : fmtPct(d.pct)}` })}
            onMouseLeave={() => setTip(null)}
          />
        ))}
      </div>
    </div>
  );
}

export default function PublicStatusPage() {
  const { token } = useParams<{ token: string }>();
  const [now, setNow] = useState(Date.now());

  const status = useQuery({
    queryKey: ['publicStatus', token],
    queryFn: () => api.get<PublicStatus>(`/public/status/${token}`),
    refetchInterval: 30_000,
    retry: 1,
  });

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (status.data) document.title = `Estado — ${status.data.project.name}`;
  }, [status.data]);

  if (status.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-sub">Cargando estado…</div>
    );
  }

  if (status.isError || !status.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <CircleSlash size={28} className="text-subtle" />
        <p className="text-sm text-sub">Esta página de estado no existe o ha sido desactivada.</p>
      </div>
    );
  }

  const data = status.data;
  const overall = OVERALL_META[data.overall];
  const open = data.incidents.filter((i) => !i.resolvedAt);
  const past = data.incidents.filter((i) => i.resolvedAt);
  const secondsAgo = Math.max(0, Math.round((now - data.generatedAt) / 1000));

  return (
    <div className="min-h-full overflow-y-auto bg-bg">
      <div className="mx-auto w-full max-w-[760px] px-4 py-10 sm:px-6 sm:py-14">
        <header className="mb-7">
          <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-subtle">Estado del servicio</p>
          <h1 className="mt-1.5 text-[26px] font-semibold leading-8 tracking-[-.02em]">{data.project.name}</h1>
          {data.project.client && <p className="mt-1 text-sm text-sub">{data.project.client}</p>}
        </header>

        <div className={cx('mb-7 flex items-center gap-3 rounded-2xl border px-5 py-4', overall.cls)}>
          {overall.icon}
          <span className="text-[15px] font-semibold">{overall.label}</span>
        </div>

        {open.length > 0 && (
          <section className="mb-7 rounded-2xl border border-err/30 bg-err/[.05] p-5">
            <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[.08em] text-err">Incidencias activas</h2>
            <div className="flex flex-col gap-2.5">
              {open.map((i) => (
                <div key={i.id}>
                  <p className="text-sm font-medium text-txt">{i.title}</p>
                  <p className="mt-0.5 text-xs text-sub">
                    Desde{' '}
                    {new Date(i.startedAt).toLocaleString('es', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="rounded-2xl border border-line bg-surface">
          {data.services.length === 0 && (
            <p className="px-5 py-10 text-center text-sm text-subtle">Aún no hay servicios publicados en esta página.</p>
          )}
          {data.services.map((s, idx) => {
            const meta = STATE_META[s.state];
            return (
              <div key={s.name} className={cx('px-5 py-4', idx > 0 && 'border-t border-line')}>
                <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <span className={cx('h-2 w-2 rounded-full', meta.dot, s.state !== 'operational' && s.state !== 'unknown' && 'pulse-soft')} />
                    {s.name}
                  </p>
                  <span className={cx('text-xs font-medium', meta.cls)}>{meta.label}</span>
                </div>
                <UptimeBars days={s.days} />
                <div className="mt-2 flex items-center justify-between text-[10.5px] text-subtle">
                  <span>hace 90 días</span>
                  <span className="tnum">
                    24 h: <span className="text-sub">{fmtPct(s.uptime24h)}</span> · 7 d:{' '}
                    <span className="text-sub">{fmtPct(s.uptime7d)}</span> · 90 d:{' '}
                    <span className="text-sub">{fmtPct(s.uptime90d)}</span>
                  </span>
                </div>
              </div>
            );
          })}
        </section>

        {past.length > 0 && (
          <section className="mt-7">
            <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[.08em] text-subtle">
              Incidencias recientes (7 días)
            </h2>
            <div className="flex flex-col gap-2">
              {past.map((i) => (
                <div key={i.id} className="rounded-xl border border-line bg-surface px-4 py-3">
                  <p className="text-[13px] font-medium text-txt">{i.title}</p>
                  <p className="mt-0.5 text-[11.5px] text-subtle">
                    {new Date(i.startedAt).toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    {' — resuelta '}
                    {i.resolvedAt &&
                      new Date(i.resolvedAt).toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        <footer className="mt-10 flex items-center justify-between text-[11px] text-subtle">
          <span>Actualizado hace {secondsAgo < 5 ? 'unos segundos' : `${secondsAgo} s`} · se refresca solo</span>
          <span className="flex items-center gap-1.5">
            <Rocket size={11} /> Skyway
          </span>
        </footer>
      </div>
    </div>
  );
}
