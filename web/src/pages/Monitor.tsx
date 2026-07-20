import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  ArrowUpRight,
  BellRing,
  Cpu,
  Database,
  HardDrive,
  MemoryStick,
  RefreshCw,
  ScrollText,
  Search,
  Server,
  TriangleAlert,
} from 'lucide-react';
import { api } from '../api';
import { ModuleChip, moduleKind } from '../components/ModuleIcon';
import { Button, Skeleton, StatusBadge, useToast } from '../components/ui';
import { LogSearchResult, MonitorOverview, MonitorService } from '../types';
import { cx, fmtBytes, fmtDateTime, STATE_LABEL, STATE_PULSE, STATE_TONE, timeAgo } from '../utils';

type StateFilter = 'all' | 'running' | 'down' | 'stopped';

/** Tarjeta de indicador del host con barra de progreso opcional. */
function StatTile({
  icon,
  label,
  value,
  detail,
  pct,
  tone = 'ok',
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  pct?: number | null;
  tone?: 'ok' | 'warn' | 'err';
}) {
  const barColor = tone === 'err' ? 'bg-err' : tone === 'warn' ? 'bg-warn' : 'bg-ok';
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[.07em] text-subtle">
        {icon} {label}
      </div>
      <p className="mt-2 text-lg font-semibold tracking-[-.01em] tnum">{value}</p>
      {detail && <p className="mt-0.5 text-[11px] text-subtle">{detail}</p>}
      {pct !== undefined && pct !== null && (
        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface2">
          <div className={cx('h-full rounded-full transition-[width] duration-500', barColor)} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      )}
    </div>
  );
}

/** Barra pequeña uso/límite para RAM y disco de la tabla. */
function UsageBar({ pct, tone }: { pct: number; tone: 'ok' | 'warn' | 'err' }) {
  const color = tone === 'err' ? 'bg-err' : tone === 'warn' ? 'bg-warn' : 'bg-acc';
  return (
    <div className="mt-1 h-1 w-full max-w-[90px] overflow-hidden rounded-full bg-surface2">
      <div className={cx('h-full rounded-full', color)} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

function LogSearchPanel() {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const navigate = useNavigate();

  const search = useQuery({
    queryKey: ['logSearch', submitted],
    queryFn: () =>
      api.get<{ results: LogSearchResult[]; scanned: number; truncated: boolean }>(
        `/monitor/logs/search?q=${encodeURIComponent(submitted)}`,
      ),
    enabled: submitted.length >= 2,
    staleTime: 10_000,
    retry: false,
  });

  const highlight = (line: string) => {
    const idx = line.toLowerCase().indexOf(submitted.toLowerCase());
    if (idx < 0) return line;
    return (
      <>
        {line.slice(0, idx)}
        <mark className="rounded-sm bg-warn/30 px-0.5 text-warn">{line.slice(idx, idx + submitted.length)}</mark>
        {line.slice(idx + submitted.length)}
      </>
    );
  };

  return (
    <section className="card p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-info/[.14] text-info">
          <ScrollText size={14} />
        </span>
        <div>
          <h2 className="text-[13px] font-semibold">Buscar en los logs de todos los servicios</h2>
          <p className="text-[11px] text-subtle">
            ¿Un error y no sabes de dónde viene? Busca el texto en las últimas ~400 líneas de cada contenedor.
          </p>
        </div>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(q.trim());
        }}
      >
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            className="input pl-9 font-mono text-xs"
            placeholder='p. ej. "ECONNREFUSED", "500", "out of memory"…'
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Button type="submit" loading={search.isFetching} disabled={q.trim().length < 2}>
          Buscar
        </Button>
      </form>

      {search.isError && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-err">
          <TriangleAlert size={13} /> {(search.error as Error).message}
        </p>
      )}

      {search.data && (
        <div className="mt-3.5">
          <p className="mb-2 text-[11px] text-subtle">
            {search.data.results.length === 0
              ? `Sin coincidencias de «${submitted}» en ${search.data.scanned} contenedor(es).`
              : `${search.data.results.length}${search.data.truncated ? '+' : ''} coincidencia(s) en ${search.data.scanned} contenedor(es).`}
          </p>
          <div className="max-h-[380px] overflow-y-auto rounded-lg border border-line bg-bg">
            {search.data.results.map((r, i) => (
              <button
                key={i}
                onClick={() => navigate(`/projects/${r.projectId}?s=${r.serviceId}`)}
                className="block w-full border-b border-line/60 px-3.5 py-2 text-left transition-colors last:border-0 hover:bg-surface"
                title="Abrir el servicio"
              >
                <div className="flex items-center gap-2 text-[10.5px] text-subtle">
                  <span className="font-medium text-acc-soft">{r.serviceName}</span>
                  {r.replica && <span>réplica {r.replica}</span>}
                  <span>· {r.projectName}</span>
                  {r.ts && <span className="ml-auto tnum">{fmtDateTime(r.ts)}</span>}
                </div>
                <p className="mt-0.5 break-all font-mono text-[11px] leading-relaxed text-sub">{highlight(r.line)}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function ServiceRow({ s, onRestart, restarting }: { s: MonitorService; onRestart: () => void; restarting: boolean }) {
  const navigate = useNavigate();
  const memPct = s.stats && s.stats.memLimit > 0 ? (s.stats.memUsage / s.stats.memLimit) * 100 : null;
  const diskPct = s.disk.totalBytes !== null && s.disk.quotaMb ? (s.disk.totalBytes / (s.disk.quotaMb * 1024 * 1024)) * 100 : null;
  const isDown = s.state === 'exited' || s.state === 'dead';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/projects/${s.projectId}?s=${s.id}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') navigate(`/projects/${s.projectId}?s=${s.id}`);
      }}
      className={cx(
        'grid cursor-pointer grid-cols-[minmax(180px,2fr)_110px_minmax(90px,1fr)_minmax(110px,1fr)_minmax(100px,1fr)_84px] items-center gap-3 border-b border-line/70 px-4 py-2.5 transition-colors last:border-0 hover:bg-surface',
        isDown && 'bg-err/[.035]',
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <ModuleChip kind={moduleKind({ type: s.type, config: { template: s.template, image: s.image } as any })} size={30} radius={8} />
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-[13px] font-medium">
            {s.name}
            {s.alerts > 0 && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-err/[.14] px-1.5 py-px text-[10px] font-semibold text-err">
                <BellRing size={9} /> {s.alerts}
              </span>
            )}
          </p>
          <p className="truncate text-[11px] text-subtle">
            {s.projectName}
            {s.client ? ` · ${s.client}` : ''}
          </p>
        </div>
      </div>

      <div>
        <StatusBadge tone={STATE_TONE[s.state]} label={STATE_LABEL[s.state]} pulse={STATE_PULSE[s.state]} replicas={s.replicas} />
        {isDown && s.exitCode !== null && <p className="mt-1 text-[10px] text-err">código {s.exitCode}</p>}
      </div>

      <div className="text-xs text-sub tnum">
        {s.stats ? `${s.stats.cpuPercent.toFixed(1)}%` : '—'}
        {s.cpus ? <span className="text-[10px] text-subtle"> / {s.cpus} CPU</span> : null}
      </div>

      <div className="text-xs text-sub">
        {s.stats ? (
          <>
            <span className="tnum">{fmtBytes(s.stats.memUsage)}</span>
            {s.memoryMb ? <span className="text-[10px] text-subtle"> / {s.memoryMb} MB</span> : null}
            {memPct !== null && s.memoryMb ? <UsageBar pct={memPct} tone={memPct > 90 ? 'err' : memPct > 75 ? 'warn' : 'ok'} /> : null}
          </>
        ) : (
          '—'
        )}
      </div>

      <div className="text-xs text-sub">
        {s.disk.totalBytes !== null ? (
          <>
            <span className="tnum">{fmtBytes(s.disk.totalBytes)}</span>
            {s.disk.quotaMb ? <span className="text-[10px] text-subtle"> / {s.disk.quotaMb} MB</span> : null}
            {diskPct !== null && <UsageBar pct={diskPct} tone={diskPct > 100 ? 'err' : diskPct > 80 ? 'warn' : 'ok'} />}
          </>
        ) : (
          '—'
        )}
      </div>

      <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        {s.state !== 'not_created' && (
          <button
            onClick={onRestart}
            disabled={restarting}
            className="rounded-lg p-1.5 leading-none text-subtle transition-colors hover:bg-surface2 hover:text-txt disabled:opacity-40"
            title="Reiniciar"
          >
            <RefreshCw size={13} className={cx(restarting && 'animate-spin')} />
          </button>
        )}
        <Link
          to={`/projects/${s.projectId}?s=${s.id}`}
          className="rounded-lg p-1.5 leading-none text-subtle transition-colors hover:bg-surface2 hover:text-txt"
          title="Abrir servicio"
        >
          <ArrowUpRight size={13} />
        </Link>
      </div>
    </div>
  );
}

export default function MonitorPage() {
  const [text, setText] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const toast = useToast();
  const queryClient = useQueryClient();

  const overview = useQuery({
    queryKey: ['monitorOverview'],
    queryFn: () => api.get<MonitorOverview>('/monitor/overview'),
    refetchInterval: 6000,
  });

  const restart = useMutation({
    mutationFn: (serviceId: string) => api.post(`/services/${serviceId}/restart`),
    onSuccess: () => {
      toast('Servicio reiniciado', 'ok');
      queryClient.invalidateQueries({ queryKey: ['monitorOverview'] });
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const services = overview.data?.services ?? [];
  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    return services.filter((s) => {
      if (stateFilter === 'running' && s.state !== 'running' && s.state !== 'restarting') return false;
      if (stateFilter === 'down' && s.state !== 'exited' && s.state !== 'dead' && s.state !== 'restarting') return false;
      if (
        stateFilter === 'stopped' &&
        s.state !== 'not_created' &&
        s.state !== 'created' &&
        s.state !== 'paused' &&
        s.state !== 'unknown'
      )
        return false;
      if (!q) return true;
      return `${s.name} ${s.projectName} ${s.client ?? ''} ${s.image ?? ''} ${s.domains.join(' ')}`.toLowerCase().includes(q);
    });
  }, [services, text, stateFilter]);

  const running = services.filter((s) => s.state === 'running').length;
  const down = services.filter((s) => s.state === 'exited' || s.state === 'dead' || s.state === 'restarting').length;
  const alerts = services.reduce((acc, s) => acc + s.alerts, 0);
  const host = overview.data?.host;
  const memPct = host ? ((host.totalMem - host.freeMem) / host.totalMem) * 100 : null;
  const diskPct = host?.disk ? ((host.disk.total - host.disk.free) / host.disk.total) * 100 : null;
  const cpuPct = host ? (host.load / host.cpus) * 100 : null;

  const chip = (key: StateFilter, label: string, count?: number) => (
    <button
      onClick={() => setStateFilter(key)}
      className={cx(
        'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-[5px] text-xs transition-colors duration-150',
        stateFilter === key
          ? 'border-acc/55 bg-acc/[.16] font-medium text-acc-soft'
          : 'border-line bg-surface text-sub hover:border-[color-mix(in_oklab,#6e56cf_40%,var(--color-line))] hover:text-txt',
      )}
    >
      {label}
      {count !== undefined && <span className="opacity-70 tnum">{count}</span>}
    </button>
  );

  return (
    <div className="mx-auto max-w-[1180px] px-4 py-7 sm:px-6 sm:py-9">
      <div className="mb-6">
        <h1 className="flex items-center gap-2.5 text-2xl font-semibold leading-[30px] tracking-[-.02em]">
          <Activity size={22} className="text-acc-soft" /> Monitor
        </h1>
        <p className="mt-1.5 text-sm text-sub">
          Todos los servicios del servidor de un vistazo: estado, consumo, espacio y una lupa para los logs
        </p>
      </div>

      {overview.isLoading && (
        <div aria-busy className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      )}

      {overview.data && (
        <>
          {!overview.data.docker && (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-warn/30 bg-warn/10 px-4 py-2.5 text-xs text-warn">
              <TriangleAlert size={14} /> Docker no está disponible: los estados no son en vivo.
            </div>
          )}

          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile
              icon={<Server size={12} />}
              label="Servicios"
              value={`${running}/${services.length}`}
              detail="en ejecución"
              tone={running === services.length ? 'ok' : 'warn'}
            />
            <StatTile
              icon={<TriangleAlert size={12} />}
              label="Con problemas"
              value={down}
              detail={down === 0 ? 'todo en orden' : 'caídos o reiniciando'}
              tone={down > 0 ? 'err' : 'ok'}
            />
            <StatTile
              icon={<BellRing size={12} />}
              label="Alertas abiertas"
              value={alerts}
              detail={
                alerts > 0 ? (
                  <Link to="/alerts" className="text-acc-soft hover:underline">
                    ver alertas →
                  </Link>
                ) : (
                  'sin alertas'
                )
              }
              tone={alerts > 0 ? 'warn' : 'ok'}
            />
            <StatTile
              icon={<Cpu size={12} />}
              label="CPU host"
              value={host ? `${host.load}` : '—'}
              detail={host ? `carga / ${host.cpus} núcleos` : undefined}
              pct={cpuPct}
              tone={cpuPct !== null && cpuPct > 90 ? 'err' : cpuPct !== null && cpuPct > 70 ? 'warn' : 'ok'}
            />
            <StatTile
              icon={<MemoryStick size={12} />}
              label="RAM host"
              value={host ? fmtBytes(host.totalMem - host.freeMem) : '—'}
              detail={host ? `de ${fmtBytes(host.totalMem)}` : undefined}
              pct={memPct}
              tone={memPct !== null && memPct > 90 ? 'err' : memPct !== null && memPct > 75 ? 'warn' : 'ok'}
            />
            <StatTile
              icon={<HardDrive size={12} />}
              label="Disco"
              value={host?.disk ? fmtBytes(host.disk.free) : '—'}
              detail="libres"
              pct={diskPct}
              tone={diskPct !== null && diskPct > 92 ? 'err' : diskPct !== null && diskPct > 80 ? 'warn' : 'ok'}
            />
          </div>

          <section className="card mb-6 overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
              <div className="relative min-w-[180px] flex-1">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
                <input
                  className="input h-8 pl-8 text-xs"
                  placeholder="Filtrar por nombre, proyecto, cliente o dominio…"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
                {chip('all', 'Todos', services.length)}
                {chip('running', 'Activos', running)}
                {chip('down', 'Con problemas', down)}
                {chip('stopped', 'Parados', services.length - running - down)}
              </div>
            </div>

            <div className="hidden grid-cols-[minmax(180px,2fr)_110px_minmax(90px,1fr)_minmax(110px,1fr)_minmax(100px,1fr)_84px] gap-3 border-b border-line bg-bg px-4 py-2 text-[10.5px] font-semibold uppercase tracking-[.07em] text-subtle md:grid">
              <span>Servicio</span>
              <span>Estado</span>
              <span>CPU</span>
              <span>RAM</span>
              <span>Disco</span>
              <span className="text-right">Acciones</span>
            </div>

            <div className="overflow-x-auto">
              <div className="min-w-[760px]">
                {filtered.length === 0 && (
                  <p className="px-4 py-10 text-center text-xs text-subtle">
                    {services.length === 0 ? 'Aún no hay servicios desplegados.' : 'Ningún servicio coincide con el filtro.'}
                  </p>
                )}
                {filtered.map((s) => (
                  <ServiceRow
                    key={s.id}
                    s={s}
                    onRestart={() => restart.mutate(s.id)}
                    restarting={restart.isPending && restart.variables === s.id}
                  />
                ))}
              </div>
            </div>

            {down > 0 && (
              <div className="border-t border-line bg-err/[.04] px-4 py-3">
                {services
                  .filter((s) => (s.state === 'exited' || s.state === 'dead') && s.exitExplanation)
                  .slice(0, 3)
                  .map((s) => (
                    <p key={s.id} className="flex items-start gap-2 py-1 text-[11.5px] leading-relaxed text-sub">
                      <Database size={12} className="mt-0.5 shrink-0 text-err" />
                      <span>
                        <Link to={`/projects/${s.projectId}?s=${s.id}`} className="font-medium text-err hover:underline">
                          {s.name}
                        </Link>
                        {' — '}
                        {s.exitExplanation}
                      </span>
                    </p>
                  ))}
              </div>
            )}
          </section>

          <LogSearchPanel />
        </>
      )}

      {services.length > 0 && overview.data && (
        <p className="mt-4 text-right text-[10.5px] text-subtle">
          Actualización automática cada 6 s · {filtered.length !== services.length ? `${filtered.length} de ` : ''}
          {services.length} servicios
          {services.some((s) => s.startedAt && s.state === 'running')
            ? ` · el más reciente arrancó ${timeAgo(Math.max(...services.filter((s) => s.startedAt).map((s) => Date.parse(s.startedAt!))))}`
            : ''}
        </p>
      )}
    </div>
  );
}
