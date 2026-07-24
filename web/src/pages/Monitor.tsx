import { lazy, Suspense, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  ArrowDownWideNarrow,
  ArrowUpRight,
  BellRing,
  Boxes,
  Cpu,
  Database,
  HardDrive,
  Layers,
  MemoryStick,
  RefreshCw,
  ScrollText,
  Search,
  Server,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { api } from '../api';
import { ModuleChip, moduleKind } from '../components/ModuleIcon';
import type { BandPoint } from '../components/HistoryChart';
import { Button, ConfirmModal, Skeleton, StatusBadge, useToast } from '../components/ui';
import { DiskBreakdown, HostMetricHistory, LogSearchResult, Me, MonitorOverview, MonitorService } from '../types';
import { cx, fmtBytes, fmtDateTime, STATE_LABEL, STATE_PULSE, STATE_TONE, timeAgo } from '../utils';

// El histórico del host solo se ve en la vista «host» (la vista por defecto es
// «services»), así que su gráfico se carga bajo demanda al abrirla.
const HistoryChart = lazy(() => import('../components/HistoryChart').then((m) => ({ default: m.HistoryChart })));

type StateFilter = 'all' | 'running' | 'down' | 'stopped';
type SortKey = 'default' | 'cpu' | 'mem' | 'disk';
type View = 'services' | 'host' | 'disk';

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

function LogSearchPanel({ projects }: { projects: { id: string; name: string }[] }) {
  const [q, setQ] = useState('');
  const [projectId, setProjectId] = useState('');
  const [submitted, setSubmitted] = useState<{ q: string; projectId: string }>({ q: '', projectId: '' });
  const navigate = useNavigate();

  const search = useQuery({
    queryKey: ['logSearch', submitted],
    queryFn: () =>
      api.get<{ results: LogSearchResult[]; scanned: number; truncated: boolean }>(
        `/monitor/logs/search?q=${encodeURIComponent(submitted.q)}${submitted.projectId ? `&projectId=${submitted.projectId}` : ''}`,
      ),
    enabled: submitted.q.length >= 2,
    staleTime: 10_000,
    retry: false,
  });

  const highlight = (line: string) => {
    const needle = submitted.q;
    const idx = line.toLowerCase().indexOf(needle.toLowerCase());
    if (idx < 0) return line;
    return (
      <>
        {line.slice(0, idx)}
        <mark className="rounded-sm bg-warn/30 px-0.5 text-warn">{line.slice(idx, idx + needle.length)}</mark>
        {line.slice(idx + needle.length)}
      </>
    );
  };

  return (
    <section className="card p-4 sm:p-5">
      <div className="mb-3">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold">
          <ScrollText size={14} className="text-info" />
          Buscar en los logs de todos los servicios
        </h2>
        <p className="mt-1 text-[11px] text-subtle">
          ¿Un error y no sabes de dónde viene? Busca el texto en las últimas ~400 líneas de cada contenedor.
        </p>
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted({ q: q.trim(), projectId });
        }}
      >
        <div className="relative min-w-[200px] flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            className="input pl-9 font-mono text-xs"
            placeholder='p. ej. "ECONNREFUSED", "500", "out of memory"…'
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {projects.length > 1 && (
          <select className="input w-auto max-w-[180px] text-xs" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Todos los proyectos</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
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
              ? `Sin coincidencias de «${submitted.q}» en ${search.data.scanned} contenedor(es).`
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
        // Solo si el foco está en la fila: Enter sobre un botón interno
        // (p. ej. Reiniciar) no debe además navegar fuera de la página.
        if (e.key === 'Enter' && e.target === e.currentTarget) navigate(`/projects/${s.projectId}?s=${s.id}`);
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
        {isDown && s.exitCode !== null ? (
          <p className="mt-1 text-[10px] text-err">código {s.exitCode}</p>
        ) : (
          s.uptime24h !== null && (
            <p className={cx('tnum mt-1 text-[10px]', s.uptime24h < 99 ? 'text-warn' : 'text-subtle')} title="Disponibilidad en las últimas 24 h">
              {s.uptime24h.toFixed(s.uptime24h >= 99.995 ? 0 : 1)}% · 24 h
            </p>
          )
        )}
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
            className="press rounded-lg p-1.5 leading-none text-subtle hover:bg-surface2 hover:text-txt disabled:opacity-40"
            title="Reiniciar"
          >
            <RefreshCw size={13} className={cx(restarting && 'animate-spin')} />
          </button>
        )}
        <Link
          to={`/projects/${s.projectId}?s=${s.id}`}
          className="press rounded-lg p-1.5 leading-none text-subtle hover:bg-surface2 hover:text-txt"
          title="Abrir servicio"
        >
          <ArrowUpRight size={13} />
        </Link>
      </div>
    </div>
  );
}

/** Desglose de espacio: qué ocupa cada servicio y qué ocupa Docker. */
function DiskPanel({ isAdmin }: { isAdmin: boolean }) {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const disk = useQuery({
    queryKey: ['monitorDisk'],
    queryFn: () => api.get<DiskBreakdown>('/monitor/disk'),
    refetchInterval: 60_000,
    retry: false,
  });

  const prune = useMutation({
    mutationFn: () => api.post<{ ok: boolean; reclaimed: string }>('/system/prune'),
    onSuccess: (res) => {
      toast(`Espacio liberado: ${res.reclaimed}. Los volúmenes no se tocan.`, 'ok');
      queryClient.invalidateQueries({ queryKey: ['monitorDisk'] });
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  if (disk.isLoading) {
    return (
      <div aria-busy className="space-y-3">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-60 w-full rounded-xl" />
      </div>
    );
  }
  if (disk.isError) {
    return (
      <p className="card flex items-center gap-2 px-4 py-8 text-xs text-warn">
        <TriangleAlert size={14} /> {(disk.error as Error).message}
      </p>
    );
  }

  const data = disk.data!;
  const maxBytes = Math.max(1, ...data.services.map((s) => s.totalBytes));
  const measured = data.services.reduce((acc, s) => acc + s.totalBytes, 0);

  return (
    <div className="flex flex-col gap-4">
      {data.docker && (
        <div className="card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: 'Imágenes', icon: <Layers size={12} />, value: data.docker.images.size, count: data.docker.images.count },
                { label: 'Volúmenes', icon: <Database size={12} />, value: data.docker.volumes.size, count: data.docker.volumes.count },
                { label: 'Caché de build', icon: <Boxes size={12} />, value: data.docker.buildCache.size },
                { label: 'Contenedores (escritura)', icon: <HardDrive size={12} />, value: data.docker.containers.size, count: data.docker.containers.count },
              ].map((t) => (
                <div key={t.label}>
                  <p className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[.07em] text-subtle">
                    {t.icon} {t.label}
                  </p>
                  <p className="tnum mt-1 text-[15px] font-semibold">
                    {fmtBytes(t.value)}
                    {t.count !== undefined && <span className="ml-1 text-[10.5px] font-normal text-subtle">× {t.count}</span>}
                  </p>
                </div>
              ))}
            </div>
            {isAdmin && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => prune.mutate()}
                loading={prune.isPending}
                title="Elimina imágenes colgantes y caché de build. Nunca toca volúmenes."
              >
                <Trash2 size={13} /> Liberar espacio
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <p className="text-[13px] font-semibold">Espacio por servicio</p>
          <p className="text-[11px] text-subtle">
            medido: <span className="tnum text-sub">{fmtBytes(measured)}</span>
            {data.host && (
              <>
                {' '}
                · libre en disco: <span className="tnum text-sub">{fmtBytes(data.host.free)}</span>
              </>
            )}
          </p>
        </div>
        {data.services.length === 0 && (
          <p className="px-4 py-10 text-center text-xs text-subtle">Sin servicios que medir todavía.</p>
        )}
        <div className="overflow-x-auto">
          <div className="min-w-[640px]">
            {data.services.map((s) => {
              const quotaBytes = s.quotaMb ? s.quotaMb * 1024 * 1024 : null;
              const pctOfQuota = quotaBytes ? (s.totalBytes / quotaBytes) * 100 : null;
              const width = quotaBytes
                ? Math.min(100, (s.totalBytes / quotaBytes) * 100)
                : (s.totalBytes / maxBytes) * 100;
              const volBytes = s.volumes.reduce((acc, v) => acc + v.sizeBytes, 0);
              return (
                <button
                  key={s.serviceId}
                  onClick={() => navigate(`/projects/${s.projectId}?s=${s.serviceId}`)}
                  className="grid w-full grid-cols-[minmax(160px,1.4fr)_minmax(220px,2fr)_minmax(90px,auto)] items-center gap-3 border-b border-line/70 px-4 py-2.5 text-left transition-colors last:border-0 hover:bg-surface"
                  title={`${s.volumes.length} volumen(es): ${fmtBytes(volBytes)} · contenedor: ${fmtBytes(s.containerBytes)}${s.logBytes !== null ? ` · logs: ${fmtBytes(s.logBytes)}` : ''}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] font-medium">{s.name}</span>
                    <span className="block truncate text-[10.5px] text-subtle">{s.projectName}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface2">
                      <span
                        className={cx(
                          'block h-full rounded-full',
                          pctOfQuota !== null && pctOfQuota > 100 ? 'bg-err' : pctOfQuota !== null && pctOfQuota > 80 ? 'bg-warn' : 'bg-acc',
                        )}
                        style={{ width: `${Math.max(1, width)}%` }}
                      />
                    </span>
                  </span>
                  <span className="tnum text-right text-xs text-sub">
                    {fmtBytes(s.totalBytes)}
                    {s.quotaMb && (
                      <span className={cx('block text-[10px]', pctOfQuota! > 100 ? 'text-err' : 'text-subtle')}>
                        de {s.quotaMb} MB ({Math.round(pctOfQuota!)}%)
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <p className="border-t border-line px-4 py-2.5 text-[10.5px] leading-relaxed text-subtle">
          Se mide volúmenes + capa de escritura del contenedor (y logs si son legibles). La cuota se asigna en Ajustes
          del servicio → Recursos; al superarla salta una alerta.
        </p>
      </div>
    </div>
  );
}

/** Histórico del servidor: carga, RAM y disco a lo largo del tiempo. */
function HostHistoryPanel({ cpus }: { cpus: number | undefined }) {
  const [hours, setHours] = useState(24);
  const ranges = [
    { h: 24, label: '24 h' },
    { h: 168, label: '7 días' },
    { h: 720, label: '30 días' },
  ];

  const q = useQuery({
    queryKey: ['hostHistory', hours],
    queryFn: () => api.get<HostMetricHistory>(`/monitor/host-history?hours=${hours}`),
    refetchInterval: 60_000,
    retry: false,
  });

  const points = q.data?.points ?? [];
  // Derivaciones memoizadas: el panel re-renderiza cada 6 s (overview del padre)
  // pero el histórico solo cambia cada 60 s; sin memo se recalculaban 3 map + 2
  // reverse en cada render y se desestabilizaban las props de los HistoryChart.
  const { memTotal, diskTotal, loadPoints, memPoints, diskPoints } = useMemo(
    () => ({
      memTotal: [...points].reverse().find((p) => p.memTotal)?.memTotal ?? null,
      diskTotal: [...points].reverse().find((p) => p.diskTotal)?.diskTotal ?? null,
      loadPoints: points.map((p) => ({ t: p.t, avg: p.loadAvg, max: p.loadMax })) as BandPoint[],
      memPoints: points.map((p) => ({ t: p.t, avg: p.memUsedAvg, max: p.memUsedMax })) as BandPoint[],
      diskPoints: points.map((p) => ({ t: p.t, avg: p.diskUsed, max: p.diskUsed })) as BandPoint[],
    }),
    [points],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1 self-start rounded-xl border border-line bg-surface p-1 text-[13px]">
        {ranges.map((r) => (
          <button
            key={r.h}
            onClick={() => setHours(r.h)}
            className={cx(
              'press rounded-lg px-3 py-1 transition-colors',
              hours === r.h ? 'bg-acc/[.16] font-medium text-acc-soft' : 'text-sub hover:text-txt',
            )}
          >
            {r.label}
          </button>
        ))}
      </div>

      {q.isLoading ? (
        <div aria-busy className="flex flex-col gap-3.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[208px] w-full rounded-xl" />
          ))}
        </div>
      ) : q.isError ? (
        <p className="card flex items-center gap-2 px-4 py-8 text-xs text-warn">
          <TriangleAlert size={14} /> {(q.error as Error).message}
        </p>
      ) : (
        <Suspense
          fallback={
            <div aria-busy className="flex flex-col gap-3.5">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-[208px] w-full rounded-xl" />
              ))}
            </div>
          }
        >
          <HistoryChart
            title={`Carga del sistema${cpus ? ` · ${cpus} núcleos` : ''}`}
            points={loadPoints}
            hours={hours}
            color="var(--color-acc)"
            format={(v) => v.toFixed(v < 10 ? 2 : 1)}
            threshold={cpus ? { value: cpus, label: `${cpus} núcleos` } : null}
          />
          <HistoryChart
            title="RAM del servidor"
            points={memPoints}
            hours={hours}
            color="var(--color-info)"
            format={(v) => fmtBytes(v)}
            threshold={memTotal ? { value: memTotal, label: `total ${fmtBytes(memTotal)}` } : null}
            fixedMax={memTotal ?? undefined}
          />
          <HistoryChart
            title="Disco del servidor · ocupado"
            points={diskPoints}
            hours={hours}
            color="var(--color-warn)"
            format={(v) => fmtBytes(v)}
            threshold={diskTotal ? { value: diskTotal, label: `total ${fmtBytes(diskTotal)}` } : null}
            fixedMax={diskTotal ?? undefined}
          />
          <p className="text-center text-[11px] text-subtle">
            La carga del sistema es el número medio de procesos esperando CPU; si supera el número de núcleos, el servidor va
            saturado. La banda va de la media al pico de cada periodo.
          </p>
        </Suspense>
      )}
    </div>
  );
}

export default function MonitorPage() {
  const [text, setText] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('default');
  const [view, setView] = useState<View>('services');
  const toast = useToast();
  const queryClient = useQueryClient();

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), staleTime: 60_000 });
  const isAdmin = me.data?.user?.role === 'admin';

  const overview = useQuery({
    queryKey: ['monitorOverview'],
    queryFn: () => api.get<MonitorOverview>('/monitor/overview'),
    refetchInterval: 6000,
  });

  // Un Set de ids en curso: `mutation.variables` solo refleja la ÚLTIMA
  // llamada y mentiría al reiniciar dos servicios seguidos.
  const [restarting, setRestarting] = useState<Set<string>>(new Set());
  // Servicio pendiente de confirmar el reinicio: una lista larga es fácil de pulsar por error.
  const [confirmRestart, setConfirmRestart] = useState<MonitorService | null>(null);
  const restart = useMutation({
    mutationFn: (serviceId: string) => api.post(`/services/${serviceId}/restart`),
    onMutate: (serviceId) => setRestarting((prev) => new Set(prev).add(serviceId)),
    onSettled: (_d, _e, serviceId) =>
      setRestarting((prev) => {
        const next = new Set(prev);
        next.delete(serviceId);
        return next;
      }),
    onSuccess: () => {
      setConfirmRestart(null);
      toast('Servicio reiniciado', 'ok');
      queryClient.invalidateQueries({ queryKey: ['monitorOverview'] });
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const services = overview.data?.services ?? [];
  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    // Partición exacta en tres grupos: cada servicio cae en un único chip y
    // los contadores cuadran con las filas listadas.
    const bucket = (s: MonitorService): StateFilter =>
      s.state === 'running' ? 'running' : s.state === 'exited' || s.state === 'dead' || s.state === 'restarting' ? 'down' : 'stopped';
    const list = services.filter((s) => {
      if (stateFilter !== 'all' && bucket(s) !== stateFilter) return false;
      if (!q) return true;
      return `${s.name} ${s.projectName} ${s.client ?? ''} ${s.image ?? ''} ${s.domains.join(' ')}`.toLowerCase().includes(q);
    });
    if (sortKey === 'default') return list;
    const value = (s: MonitorService) =>
      sortKey === 'cpu' ? s.stats?.cpuPercent ?? -1 : sortKey === 'mem' ? s.stats?.memUsage ?? -1 : s.disk.totalBytes ?? -1;
    return [...list].sort((a, b) => value(b) - value(a));
  }, [services, text, stateFilter, sortKey]);

  const projects = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of services) seen.set(s.projectId, s.projectName);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [services]);

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
          : 'border-line bg-surface text-sub hover:border-[color-mix(in_oklab,var(--color-acc)_40%,var(--color-line))] hover:text-txt',
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

      {overview.isError && !overview.data && (
        <div className="card flex flex-col items-center gap-3 py-14 text-center">
          <TriangleAlert size={22} className="text-warn" />
          <p className="max-w-sm text-sm text-sub">
            No se pudo cargar el monitor: {(overview.error as Error).message}
          </p>
          <Button variant="secondary" size="sm" onClick={() => overview.refetch()}>
            <RefreshCw size={13} /> Reintentar
          </Button>
        </div>
      )}

      {overview.data && (
        <>
          {!overview.data.docker && (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-warn/30 bg-warn/10 px-4 py-2.5 text-xs text-warn">
              <TriangleAlert size={14} /> Docker no está disponible: los estados no son en vivo.
            </div>
          )}

          <div className="stagger mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
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
              label="Carga CPU"
              value={host ? `${host.load}` : '—'}
              detail={host ? `${cpuPct !== null ? `${Math.round(cpuPct)}% de ` : ''}${host.cpus} núcleos` : undefined}
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

          <div className="mb-4 flex items-center gap-1 rounded-xl border border-line bg-surface p-1 text-[13px] sm:w-fit">
            {(
              [
                { key: 'services', label: 'Servicios', icon: <Server size={13} /> },
                { key: 'host', label: 'Servidor', icon: <Cpu size={13} /> },
                { key: 'disk', label: 'Espacio', icon: <HardDrive size={13} /> },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                onClick={() => setView(t.key)}
                className={cx(
                  'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-4 py-1.5 transition-colors sm:flex-none',
                  view === t.key ? 'bg-acc/[.16] font-medium text-acc-soft' : 'text-sub hover:text-txt',
                )}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </div>

          {/* La clave por vista relanza una aparición breve al cambiar Servicios ↔ Espacio. */}
          <div key={view} className="tab-in">
          {view === 'host' && <HostHistoryPanel cpus={host?.cpus} />}

          {view === 'disk' && <DiskPanel isAdmin={!!isAdmin} />}

          {view === 'services' && (
            <>
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
                  {(
                    [
                      { key: 'cpu', label: 'CPU' },
                      { key: 'mem', label: 'RAM' },
                      { key: 'disk', label: 'Disco' },
                    ] as const
                  ).map((c) => (
                    <button
                      key={c.key}
                      onClick={() => setSortKey(sortKey === c.key ? 'default' : c.key)}
                      className={cx(
                        'flex items-center gap-1 text-left uppercase tracking-[.07em] transition-colors hover:text-txt',
                        sortKey === c.key ? 'text-acc-soft' : 'text-subtle',
                      )}
                      title={sortKey === c.key ? 'Quitar ordenación' : `Ordenar por ${c.label} (mayor primero)`}
                    >
                      {c.label}
                      {sortKey === c.key && <ArrowDownWideNarrow size={11} />}
                    </button>
                  ))}
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
                      <ServiceRow key={s.id} s={s} onRestart={() => setConfirmRestart(s)} restarting={restarting.has(s.id)} />
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
                          <TriangleAlert size={12} className="mt-0.5 shrink-0 text-err" />
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

              <LogSearchPanel projects={projects} />
            </>
          )}
          </div>
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

      <ConfirmModal
        open={confirmRestart !== null}
        onClose={() => setConfirmRestart(null)}
        onConfirm={() => confirmRestart && restart.mutate(confirmRestart.id)}
        loading={!!confirmRestart && restarting.has(confirmRestart.id)}
        title={`Reiniciar "${confirmRestart?.name ?? ''}"`}
        message="El servicio quedará unos segundos sin responder mientras vuelve a arrancar."
        confirmLabel="Reiniciar"
        confirmVariant="primary"
      />
    </div>
  );
}
