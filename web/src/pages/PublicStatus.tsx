import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, CircleSlash, HelpCircle, Megaphone, Rocket } from 'lucide-react';
import { api, ApiError } from '../api';
import { EmptyState, ErrorState, Skeleton } from '../components/ui';
import { useMediaQuery } from '../hooks';
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

/*
 * Formateadores fijos: cada barra lleva su fecha en el aria-label y son 90 por
 * servicio en cada refresco; `toLocaleString` creaba un formateador por llamada.
 */
const DAY_FMT = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' });
const STAMP_FMT = new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function fmtDay(ts: number): string {
  return DAY_FMT.format(new Date(ts));
}

function fmtStampCorto(ts: number): string {
  return STAMP_FMT.format(new Date(ts));
}

function fmtPct(pct: number | null): string {
  return pct === null ? '—' : `${pct.toFixed(pct >= 99.995 ? 0 : 2)}%`;
}

/** Por debajo de este ancho se enseñan solo los últimos 30 días. */
const MOVIL_QUERY = '(max-width: 639px)';

function UptimeBars({ days }: { days: { date: number; pct: number | null }[] }) {
  const [tip, setTip] = useState<{ idx: number; text: string } | null>(null);
  const movil = useMediaQuery(MOVIL_QUERY);
  /*
   * 90 barras en 328px salen a ~3px cada una: ni se distinguen ni se pulsan.
   * En móvil se enseñan los últimos 30 días (≥6px por barra con el hueco), que
   * es lo que cabe con dignidad; el rótulo de debajo dice qué ventana se ve.
   */
  const visibles = movil ? days.slice(-30) : days;

  // En táctil no hay hover: el toque fija el tip y un toque fuera lo quita.
  useEffect(() => {
    if (!tip) return;
    const fuera = () => setTip(null);
    window.addEventListener('pointerdown', fuera);
    return () => window.removeEventListener('pointerdown', fuera);
  }, [tip]);

  const texto = (d: { date: number; pct: number | null }) => `${fmtDay(d.date)}: ${d.pct === null ? 'sin datos' : fmtPct(d.pct)}`;

  return (
    <div className="relative">
      {tip && (
        <div
          role="tooltip"
          className="pointer-events-none absolute -top-8 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-surface2 px-2 py-1 text-micro text-txt shadow-lvl3"
          style={{ left: `${((tip.idx + 0.5) / visibles.length) * 100}%` }}
        >
          {tip.text}
        </div>
      )}
      <div className="flex h-8 items-stretch gap-px" onMouseLeave={() => setTip(null)}>
        {visibles.map((d, i) => (
          <button
            key={d.date}
            type="button"
            aria-label={texto(d)}
            className={cx(
              'min-w-0 flex-1 rounded-[2px] transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-acc',
              dayColor(d.pct),
              tip && tip.idx !== i && 'opacity-70',
            )}
            onMouseEnter={() => setTip({ idx: i, text: texto(d) })}
            onPointerDown={(e) => {
              // El listener de la ventana quitaría el tip en este mismo toque.
              e.stopPropagation();
              setTip({ idx: i, text: texto(d) });
            }}
            onFocus={() => setTip({ idx: i, text: texto(d) })}
            onBlur={() => setTip(null)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * «Actualizado hace N s» vive en su propia hoja: su temporizador de 10 s solo
 * repinta este texto, no la página entera con sus 90×N barras.
 */
function Actualizado({ generatedAt }: { generatedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  const secondsAgo = Math.max(0, Math.round((now - generatedAt) / 1000));
  return <span>Actualizado hace {secondsAgo < 5 ? 'unos segundos' : `${secondsAgo} s`} · se refresca solo</span>;
}

export default function PublicStatusPage() {
  const { token } = useParams<{ token: string }>();
  const movil = useMediaQuery(MOVIL_QUERY);

  const status = useQuery({
    queryKey: ['publicStatus', token],
    queryFn: () => api.get<PublicStatus>(`/public/status/${token}`),
    refetchInterval: 30_000,
    retry: 1,
  });

  // Al salir de la página se devuelve el título anterior: si no, el nombre del
  // proyecto se quedaba en la pestaña al volver al panel.
  const projectName = status.data?.project.name;
  useEffect(() => {
    if (!projectName) return;
    const previous = document.title;
    document.title = `Estado — ${projectName}`;
    return () => {
      document.title = previous;
    };
  }, [projectName]);

  if (status.isLoading) {
    // Misma silueta que la página final: nada salta al llegar los datos.
    return (
      <div aria-busy className="min-h-full overflow-y-auto bg-bg">
        <div className="mx-auto w-full max-w-[760px] px-4 py-10 sm:px-6 sm:py-14">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="mt-3 h-7 w-64" />
          <Skeleton className="mt-8 h-[58px] w-full rounded-2xl" />
          <div className="mt-7 rounded-2xl border border-line bg-surface p-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className={cx(i > 0 && 'mt-6')}>
                <Skeleton className="h-4 w-40" />
                <Skeleton className="mt-3 h-8 w-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Solo sin datos en caché: un refetch de fondo fallido (red inestable del
  // cliente) no debe convertir la página en "desactivada".
  if (!status.data) {
    // Y solo un 404 significa de verdad que no existe. Cualquier otro fallo es
    // un problema de conexión, y decirle al cliente que la página ha sido
    // desactivada sería mentirle sobre el servicio que ha contratado.
    const noExiste = status.error instanceof ApiError && status.error.status === 404;
    return (
      <div className="flex h-full flex-col items-center justify-center px-6">
        {noExiste ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <CircleSlash size={28} className="text-subtle" />
            <p className="text-sm text-sub">Esta página de estado no existe o ha sido desactivada.</p>
          </div>
        ) : (
          <ErrorState
            title="No se ha podido cargar el estado"
            error={status.error}
            onRetry={() => status.refetch()}
            retrying={status.isFetching}
          />
        )}
      </div>
    );
  }

  const data = status.data;
  const overall = OVERALL_META[data.overall];
  const open = data.incidents.filter((i) => !i.resolvedAt);
  const past = data.incidents.filter((i) => i.resolvedAt);

  return (
    <div className="min-h-full overflow-y-auto bg-bg">
      <div className="page-in mx-auto w-full max-w-[760px] px-4 py-10 sm:px-6 sm:py-14">
        <header className="mb-7">
          <p className="eyebrow text-subtle">Estado del servicio</p>
          <h1 className="mt-1.5 text-2xl font-semibold leading-8">{data.project.name}</h1>
          {data.project.client && <p className="mt-1 text-sm text-sub">{data.project.client}</p>}
        </header>

        <div className={cx('mb-7 flex items-center gap-3 rounded-2xl border px-5 py-4', overall.cls)}>
          {overall.icon}
          <span className="text-base font-semibold">{overall.label}</span>
        </div>

        {data.notice && (
          <div className="mb-7 flex items-start gap-3 rounded-2xl border border-info/35 bg-info/[.08] px-5 py-4">
            <Megaphone size={17} className="mt-0.5 shrink-0 text-info" />
            <div>
              <p className="eyebrow text-info">Aviso</p>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-txt">{data.notice}</p>
            </div>
          </div>
        )}

        {open.length > 0 && (
          <section className="mb-7 rounded-2xl border border-err/30 bg-err/[.05] p-5">
            <h2 className="mb-3 eyebrow text-err">Incidencias activas</h2>
            <div className="flex flex-col gap-2.5">
              {open.map((i) => (
                <div key={i.id}>
                  <p className="text-sm font-medium text-txt">{i.title}</p>
                  <p className="mt-0.5 text-xs text-sub">Desde {fmtStampCorto(i.startedAt)}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="rounded-2xl border border-line bg-surface">
          {data.services.length === 0 && (
            <EmptyState title="Aún no hay servicios publicados" description="Cuando se publique alguno, su estado aparecerá aquí." />
          )}
          {data.services.map((s, idx) => {
            const meta = STATE_META[s.state];
            // El nombre no es único (dos "PostgreSQL" en un proyecto): la key
            // lleva el índice, y el orden del servidor es estable (created_at).
            return (
              <div key={`${s.name}-${idx}`} className={cx('px-5 py-4', idx > 0 && 'border-t border-line')}>
                <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <span className={cx('h-2 w-2 rounded-full', meta.dot, s.state !== 'operational' && s.state !== 'unknown' && 'pulse-soft')} />
                    {s.name}
                  </p>
                  <span className={cx('text-xs font-medium', meta.cls)}>{meta.label}</span>
                </div>
                <UptimeBars days={s.days} />
                <div className="mt-2 flex items-center justify-between gap-2 text-micro text-subtle">
                  <span className="shrink-0">hace {movil ? 30 : 90} días</span>
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
            <h2 className="mb-3 eyebrow text-subtle">
              Incidencias recientes (7 días)
            </h2>
            <div className="flex flex-col gap-2">
              {past.map((i) => (
                <div key={i.id} className="rounded-xl border border-line bg-surface px-4 py-3">
                  <p className="text-sm font-medium text-txt">{i.title}</p>
                  <p className="mt-0.5 text-xs text-subtle">
                    {fmtStampCorto(i.startedAt)}
                    {' — resuelta '}
                    {i.resolvedAt && fmtStampCorto(i.resolvedAt)}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        <footer className="mt-10 flex flex-wrap items-center justify-between gap-2 text-xs text-subtle">
          <Actualizado generatedAt={data.generatedAt} />
          <span className="flex items-center gap-1.5">
            <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-[4px] bg-acc text-white">
              <Rocket size={9} />
            </span>
            Skyway
          </span>
        </footer>
      </div>
    </div>
  );
}
