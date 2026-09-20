import { lazy, memo, Suspense, useMemo, useState } from 'react';
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
import { useMediaQuery } from '../hooks';
import { ModuleChip, moduleKind } from '../components/ModuleIcon';
import type { BandPoint } from '../components/HistoryChart';
import { Button, Chip, ConfirmModal, EmptyState, ErrorState, Segmented, Skeleton, StatusBadge, useToast } from '../components/ui';
import { DiskBreakdown, HostMetricHistory, LogSearchResult, Me, MonitorOverview, MonitorService } from '../types';
import { cx, EMPTY_LIST, fmtBytes, fmtDateTime, serviceStatus, timeAgo } from '../utils';

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
      <div className="flex items-center gap-2 eyebrow text-subtle">
        {icon} {label}
      </div>
      <p className="mt-2 text-lg font-semibold tnum">{value}</p>
      {detail && <p className="mt-0.5 text-xs text-subtle">{detail}</p>}
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
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <ScrollText size={14} className="text-info" />
          Buscar en los registros de todos los servicios
        </h2>
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
            placeholder='Por ejemplo: ECONNREFUSED, 500, out of memory'
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
      <p className="mt-1.5 text-micro text-subtle">Se buscan las últimas ~400 líneas de cada contenedor.</p>

      {search.isError && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-err">
          <TriangleAlert size={13} /> {(search.error as Error).message}
        </p>
      )}

      {search.data && (
        <div className="mt-3.5">
          <p className="mb-2 text-xs text-subtle">
            {search.data.results.length === 0
              ? `No hay coincidencias de «${submitted.q}» en ${search.data.scanned} contenedor(es).`
              : `${search.data.results.length}${search.data.truncated ? '+' : ''} coincidencia(s) en ${search.data.scanned} contenedor(es).`}
          </p>
          <div className="max-h-[380px] overflow-y-auto rounded-lg border border-line bg-bg">
            {search.data.results.map((r, i) => (
              <button
                // Con solo el índice, una nueva búsqueda reciclaba los nodos de la anterior.
                key={`${r.serviceId}-${r.ts ?? 'sin-ts'}-${i}`}
                onClick={() => navigate(`/projects/${r.projectId}?s=${r.serviceId}`)}
                className="block w-full border-b border-line/60 px-3.5 py-2 text-left transition-colors last:border-0 hover:bg-surface"
                title="Abrir el servicio"
              >
                <div className="flex items-center gap-2 text-micro text-subtle">
                  <span className="font-medium text-acc-soft">{r.serviceName}</span>
                  {r.replica && <span>réplica {r.replica}</span>}
                  <span>· {r.projectName}</span>
                  {r.ts && <span className="ml-auto tnum">{fmtDateTime(r.ts)}</span>}
                </div>
                <p className="mt-0.5 break-all font-mono text-xs leading-relaxed text-sub">{highlight(r.line)}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Una fila del monitor. Por debajo de 640px la fila de seis columnas no cabe
 * —la tabla pedía 760px y había que arrastrar de lado para ver el estado, que
 * es justo a lo que se entra—, así que ahí se pinta como tarjeta. Las celdas
 * son las mismas piezas en los dos casos: cambia la composición, no el dato.
 *
 * Memoizada: el overview llega cada 6 s y react-query conserva la identidad de
 * los servicios que no cambian, así que solo se repintan las filas con datos
 * nuevos. `onRestart` recibe el servicio para que la función sea estable.
 */
const ServiceRow = memo(function ServiceRow({
  s,
  onRestart,
  restarting,
  isMobile,
}: {
  s: MonitorService;
  onRestart: (s: MonitorService) => void;
  restarting: boolean;
  /** Lo decide el padre una vez: cada fila con su propio `matchMedia` era un oyente por servicio. */
  isMobile: boolean;
}) {
  const navigate = useNavigate();
  const memPct = s.stats && s.stats.memLimit > 0 ? (s.stats.memUsage / s.stats.memLimit) * 100 : null;
  const diskPct = s.disk.totalBytes !== null && s.disk.quotaMb ? (s.disk.totalBytes / (s.disk.quotaMb * 1024 * 1024)) * 100 : null;
  const status = serviceStatus(s.state, { exitCode: s.exitCode, stoppedAt: s.stoppedAt });
  // Solo lo que se cayó solo se tiñe de rojo; una parada a mano no es un incidente.
  const isDown = status.kind === 'down';

  const identidad = (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <ModuleChip
        kind={moduleKind({ type: s.type, config: { template: s.template, image: s.image } as any })}
        size={30}
        radius={8}
        className={cx(status.kind === 'stopped' && 'opacity-55 saturate-50')}
      />
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 truncate text-sm font-medium">
          {s.name}
          {s.alerts > 0 && (
            <Chip size="sm" tone="err" icon={<BellRing size={9} aria-hidden />}>{s.alerts}</Chip>
          )}
        </p>
        <p className="truncate text-xs text-subtle">
          {s.projectName}
          {s.client ? ` · ${s.client}` : ''}
        </p>
      </div>
    </div>
  );

  const estado = (
    <div>
      <StatusBadge tone={status.tone} label={status.label} pulse={status.pulse} replicas={s.replicas} />
      {isDown && s.exitCode !== null ? (
        <p className="mt-1 text-micro text-err">código {s.exitCode}</p>
      ) : status.kind === 'stopped' && s.stoppedAt ? (
        <p className="mt-1 text-micro text-subtle">detenido desde el panel · {timeAgo(s.stoppedAt)}</p>
      ) : (
        s.uptime24h !== null && (
          <p className={cx('tnum mt-1 text-micro', s.uptime24h < 99 ? 'text-warn' : 'text-subtle')} title="Disponibilidad en las últimas 24 h">
            {s.uptime24h.toFixed(s.uptime24h >= 99.995 ? 0 : 1)}% · 24 h
          </p>
        )
      )}
    </div>
  );

  const cpu = (
    <div className="text-xs text-sub tnum">
      {s.stats ? `${s.stats.cpuPercent.toFixed(1)}%` : '—'}
      {s.cpus ? <span className="text-micro text-subtle"> / {s.cpus} CPU</span> : null}
    </div>
  );

  const ram = (
    <div className="text-xs text-sub">
      {s.stats ? (
        <>
          <span className="tnum">{fmtBytes(s.stats.memUsage)}</span>
          {s.memoryMb ? <span className="text-micro text-subtle"> / {s.memoryMb} MB</span> : null}
          {memPct !== null && s.memoryMb ? <UsageBar pct={memPct} tone={memPct > 90 ? 'err' : memPct > 75 ? 'warn' : 'ok'} /> : null}
        </>
      ) : (
        '—'
      )}
    </div>
  );

  const disco = (
    <div className="text-xs text-sub">
      {s.disk.totalBytes !== null ? (
        <>
          <span className="tnum">{fmtBytes(s.disk.totalBytes)}</span>
          {s.disk.quotaMb ? <span className="text-micro text-subtle"> / {s.disk.quotaMb} MB</span> : null}
          {diskPct !== null && <UsageBar pct={diskPct} tone={diskPct > 100 ? 'err' : diskPct > 80 ? 'warn' : 'ok'} />}
        </>
      ) : (
        '—'
      )}
    </div>
  );

  const reiniciar = s.state !== 'not_created' && (
    <button
      onClick={() => onRestart(s)}
      disabled={restarting}
      className="press flex items-center justify-center rounded-lg p-1.5 leading-none text-subtle hover:bg-surface2 hover:text-txt disabled:opacity-40 max-sm:h-10 max-sm:w-10 max-sm:p-0"
      title="Reiniciar"
      aria-label={`Reiniciar ${s.name}`}
    >
      <RefreshCw size={13} className={cx(restarting && 'animate-spin')} />
    </button>
  );

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
        'cursor-pointer border-b border-line/70 transition-colors last:border-0 hover:bg-surface',
        isDown && 'bg-err/[.035]',
      )}
    >
      {/* Se pinta solo una de las dos vistas: tenerlas ambas en el DOM y ocultar
          una por CSS duplicaba el trabajo de cada fila en listas largas. */}
      {isMobile ? (
        /* Móvil: tarjeta. Quién es y cómo está arriba; el consumo, en tres columnas. */
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-start gap-2">
            {identidad}
            <span className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
              {reiniciar}
            </span>
          </div>
          {estado}
          <div className="grid grid-cols-3 gap-3 border-t border-line/70 pt-3">
            <div className="min-w-0">
              <p className="eyebrow text-subtle">CPU</p>
              {cpu}
            </div>
            <div className="min-w-0">
              <p className="eyebrow text-subtle">RAM</p>
              {ram}
            </div>
            <div className="min-w-0">
              <p className="eyebrow text-subtle">Disco</p>
              {disco}
            </div>
          </div>
        </div>
      ) : (
        /* Escritorio: la fila de la tabla, con sus columnas alineadas. */
        <div className="grid grid-cols-[minmax(180px,2fr)_110px_minmax(90px,1fr)_minmax(110px,1fr)_minmax(100px,1fr)_84px] items-center gap-3 px-4 py-2.5">
          {identidad}
          {estado}
          {cpu}
          {ram}
          {disco}
          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            {reiniciar}
            <Link
              to={`/projects/${s.projectId}?s=${s.id}`}
              className="press rounded-lg p-1.5 leading-none text-subtle hover:bg-surface2 hover:text-txt"
              title="Abrir servicio"
              aria-label={`Abrir ${s.name}`}
            >
              <ArrowUpRight size={13} />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
});

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
      toast(`Espacio liberado: ${res.reclaimed}`, 'ok');
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
      <div className="card">
        <ErrorState
          compact
          title="No se ha podido medir el espacio"
          error={disk.error}
          onRetry={() => disk.refetch()}
          retrying={disk.isFetching}
        />
      </div>
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
                  <p className="flex items-center gap-1.5 eyebrow text-subtle">
                    {t.icon} {t.label}
                  </p>
                  <p className="tnum mt-1 text-base font-semibold">
                    {fmtBytes(t.value)}
                    {t.count !== undefined && <span className="ml-1 text-micro font-normal text-subtle">× {t.count}</span>}
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
                title="Elimina imágenes sin referencia y la caché de compilación. No afecta a los volúmenes."
              >
                <Trash2 size={13} /> Liberar espacio
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <p className="text-sm font-semibold">Espacio por servicio</p>
          <p className="text-xs text-subtle">
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
          <EmptyState compact icon={<Activity />} title="No hay servicios que medir" description="Despliegue un servicio y sus métricas se mostrarán aquí." />
        )}
        {/* En móvil la fila se parte en dos líneas (nombre + barra arriba, tamaño
            debajo) en vez de obligar a arrastrar de lado una tabla de 640px. */}
        <div className="sm:overflow-x-auto">
          <div className="sm:min-w-[640px]">
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
                  className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 border-b border-line/70 px-4 py-3 text-left transition-colors last:border-0 hover:bg-surface sm:grid-cols-[minmax(160px,1.4fr)_minmax(220px,2fr)_minmax(90px,auto)] sm:gap-3 sm:py-2.5"
                  title={`${s.volumes.length} volumen(es): ${fmtBytes(volBytes)} · contenedor: ${fmtBytes(s.containerBytes)}${s.logBytes !== null ? ` · registros: ${fmtBytes(s.logBytes)}` : ''}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{s.name}</span>
                    <span className="block truncate text-micro text-subtle">{s.projectName}</span>
                  </span>
                  {/* En móvil la barra baja a la segunda línea y ocupa todo el ancho. */}
                  <span className="order-3 col-span-2 flex items-center gap-2 sm:order-none sm:col-span-1">
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
                  <span className="tnum shrink-0 text-right text-xs text-sub">
                    {fmtBytes(s.totalBytes)}
                    {s.quotaMb && (
                      <span className={cx('block text-micro', pctOfQuota! > 100 ? 'text-err' : 'text-subtle')}>
                        de {s.quotaMb} MB ({Math.round(pctOfQuota!)}%)
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <p className="border-t border-line px-4 py-2.5 text-micro leading-relaxed text-subtle">
          Se miden los volúmenes y la capa de escritura del contenedor (y los registros, si son legibles). La cuota se asigna
          en Ajustes del servicio → Recursos; al superarla se genera una alerta.
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

  const points = q.data?.points ?? EMPTY_LIST;
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
      <Segmented
        className="self-start"
        label="Ventana del histórico"
        value={hours}
        onChange={setHours}
        options={ranges.map((r) => ({ key: r.h, label: r.label }))}
      />

      {q.isLoading ? (
        <div aria-busy className="flex flex-col gap-3.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[208px] w-full rounded-xl" />
          ))}
        </div>
      ) : q.isError ? (
        <div className="card">
          <ErrorState
            compact
            title="No se ha podido cargar el histórico"
            error={q.error}
            onRetry={() => q.refetch()}
            retrying={q.isFetching}
          />
        </div>
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
          {/* La explicación de qué es la carga va en el title: quien la conoce no la quiere leer cada vez. */}
          <div title="Media de procesos en espera de CPU. Por encima del número de núcleos, el servidor está saturado.">
            <HistoryChart
              title={`Carga del sistema${cpus ? ` · ${cpus} núcleos` : ''}`}
              points={loadPoints}
              hours={hours}
              color="var(--color-chart-1)"
              format={(v) => v.toFixed(v < 10 ? 2 : 1)}
              threshold={cpus ? { value: cpus, label: `${cpus} núcleos` } : null}
            />
          </div>
          <HistoryChart
            title="RAM del servidor"
            points={memPoints}
            hours={hours}
            color="var(--color-chart-2)"
            format={(v) => fmtBytes(v)}
            threshold={memTotal ? { value: memTotal, label: `total ${fmtBytes(memTotal)}` } : null}
            fixedMax={memTotal ?? undefined}
          />
          <HistoryChart
            title="Disco del servidor · ocupado"
            points={diskPoints}
            hours={hours}
            color="var(--color-chart-5)"
            format={(v) => fmtBytes(v)}
            threshold={diskTotal ? { value: diskTotal, label: `total ${fmtBytes(diskTotal)}` } : null}
            fixedMax={diskTotal ?? undefined}
          />
          <p className="text-center text-xs text-subtle">La banda abarca desde la media hasta el máximo.</p>
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
  // Una sola consulta de anchura para todas las filas.
  const isMobile = useMediaQuery('(max-width: 639px)');
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

  const services = overview.data?.services ?? EMPTY_LIST;
  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    // Partición exacta en tres grupos: cada servicio cae en un único chip y
    // los contadores cuadran con las filas listadas.
    const bucket = (s: MonitorService): StateFilter => {
      if (s.state === 'running') return 'running';
      if (s.state === 'restarting') return 'down';
      const kind = serviceStatus(s.state, { exitCode: s.exitCode, stoppedAt: s.stoppedAt }).kind;
      return kind === 'down' ? 'down' : 'stopped';
    };
    const list = services.filter((s) => {
      if (stateFilter !== 'all' && bucket(s) !== stateFilter) return false;
      if (!q) return true;
      return `${s.name} ${s.projectName} ${s.client ?? ''} ${s.image ?? ''} ${s.domains.join(' ')}`.toLowerCase().includes(q);
    });
    if (sortKey === 'default') {
      /*
       * Orden «por estado»: lo que falla arriba, luego lo que corre, al final lo
       * parado; dentro de cada grupo por proyecto y nombre. Antes se respetaba
       * el orden del servidor y un servicio caído podía quedar en la pantalla
       * de abajo del móvil.
       */
      const rango = (s: MonitorService) => {
        const b = bucket(s);
        return b === 'down' ? 0 : b === 'running' ? 1 : 2;
      };
      return [...list].sort(
        (a, b) => rango(a) - rango(b) || a.projectName.localeCompare(b.projectName, 'es') || a.name.localeCompare(b.name, 'es'),
      );
    }
    const value = (s: MonitorService) =>
      sortKey === 'cpu' ? s.stats?.cpuPercent ?? -1 : sortKey === 'mem' ? s.stats?.memUsage ?? -1 : s.disk.totalBytes ?? -1;
    return [...list].sort((a, b) => value(b) - value(a));
  }, [services, text, stateFilter, sortKey]);

  const projects = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of services) seen.set(s.projectId, s.projectName);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }, [services]);

  const running = services.filter((s) => s.state === 'running').length;
  // Una parada a mano no cuenta como problema: va con los detenidos.
  const down = services.filter(
    (s) => s.state === 'restarting' || serviceStatus(s.state, { exitCode: s.exitCode, stoppedAt: s.stoppedAt }).kind === 'down',
  ).length;
  const alerts = services.reduce((acc, s) => acc + s.alerts, 0);
  const host = overview.data?.host;
  const memPct = host ? ((host.totalMem - host.freeMem) / host.totalMem) * 100 : null;
  const diskPct = host?.disk ? ((host.disk.total - host.disk.free) / host.disk.total) * 100 : null;
  const cpuPct = host ? (host.load / host.cpus) * 100 : null;

  const chip = (key: StateFilter, label: string, count?: number) => (
    <Chip tone="info" active={stateFilter === key} onClick={() => setStateFilter(key)}>
      {label}
      {count !== undefined && <span className="tnum opacity-70">{count}</span>}
    </Chip>
  );

  return (
    <div className="mx-auto max-w-[1180px] px-4 py-7 sm:px-6 sm:py-9">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Monitor</h1>
        <p className="mt-1.5 text-sm text-sub">
          Todos los servicios del servidor: estado, consumo, espacio y búsqueda en los registros
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
            No se ha podido cargar el monitor: {(overview.error as Error).message}
          </p>
          <Button variant="secondary" size="sm" onClick={() => overview.refetch()}>
            <RefreshCw size={13} /> Reintentar
          </Button>
        </div>
      )}

      {overview.data && (
        <>
          {/* Sin aviso de Docker aquí: Layout ya pinta uno global para toda la app. */}
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
              label="Caídos"
              value={down}
              detail={down === 0 ? 'ninguno' : 'requieren atención'}
              tone={down > 0 ? 'err' : 'ok'}
            />
            <StatTile
              icon={<BellRing size={12} />}
              label="Alertas abiertas"
              value={alerts}
              detail={
                alerts > 0 ? (
                  <Link to="/alerts" className="tap text-acc-soft hover:underline">
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
              value={host?.disk ? fmtBytes(host.disk.total - host.disk.free) : '—'}
              detail={host?.disk ? `de ${fmtBytes(host.disk.total)}` : undefined}
              pct={diskPct}
              tone={diskPct !== null && diskPct > 92 ? 'err' : diskPct !== null && diskPct > 80 ? 'warn' : 'ok'}
            />
          </div>

          <Segmented
            className="mb-4 sm:w-fit"
            full
            label="Vista del monitor"
            value={view}
            onChange={(k) => setView(k as View)}
            options={[
              { key: 'services', label: 'Servicios', icon: <Server size={13} aria-hidden /> },
              { key: 'host', label: 'Servidor', icon: <Cpu size={13} aria-hidden /> },
              { key: 'disk', label: 'Espacio', icon: <HardDrive size={13} aria-hidden /> },
            ]}
          />

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
                      placeholder="Filtrar por nombre, proyecto, cliente o dominio"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                    />
                  </div>
                  <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
                    {chip('all', 'Todos', services.length)}
                    {chip('running', 'Activos', running)}
                    {chip('down', 'Caídos', down)}
                    {chip('stopped', 'Detenidos', services.length - running - down)}
                  </div>
                  {/* En móvil no hay cabecera de columnas donde pulsar para ordenar:
                      el control vive aquí, solo por debajo de sm. */}
                  <Segmented
                    className="sm:hidden"
                    full
                    size="sm"
                    label="Ordenar servicios"
                    value={sortKey}
                    onChange={setSortKey}
                    options={[
                      { key: 'default', label: 'Estado' },
                      { key: 'cpu', label: 'CPU' },
                      { key: 'mem', label: 'RAM' },
                      { key: 'disk', label: 'Disco' },
                    ]}
                  />
                </div>

                <div className="sm:overflow-x-auto">
                  <div className="sm:min-w-[760px]">
                    {/* La cabecera de columnas solo existe donde hay columnas
                        —y donde hay filas debajo que encabezar. */}
                    <div className={cx(
                      'hidden grid-cols-[minmax(180px,2fr)_110px_minmax(90px,1fr)_minmax(110px,1fr)_minmax(100px,1fr)_84px] gap-3 border-b border-line bg-bg px-4 py-2 eyebrow text-subtle',
                      filtered.length > 0 && 'sm:grid',
                    )}>
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
                            'eyebrow flex items-center gap-1 text-left transition-colors hover:text-txt',
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

                    {filtered.length === 0 &&
                      (services.length === 0 ? (
                        <EmptyState
                          compact
                          icon={<Server />}
                          title="Todavía no hay servicios desplegados"
                          action={
                            <Link to="/" className="text-xs font-semibold text-acc-soft hover:underline">
                              Ir a proyectos →
                            </Link>
                          }
                        />
                      ) : (
                        <EmptyState
                          compact
                          icon={<Search />}
                          title="Ningún servicio coincide"
                          action={
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setText('');
                                setStateFilter('all');
                              }}
                            >
                              Quitar filtros
                            </Button>
                          }
                        />
                      ))}
                    {filtered.map((s) => (
                      <ServiceRow key={s.id} s={s} isMobile={isMobile} onRestart={setConfirmRestart} restarting={restarting.has(s.id)} />
                    ))}
                  </div>
                </div>

                {down > 0 && (
                  <div className="border-t border-line bg-err/[.04] px-4 py-3">
                    {services
                      .filter((s) => (s.state === 'exited' || s.state === 'dead') && s.exitExplanation)
                      .slice(0, 3)
                      .map((s) => (
                        <p key={s.id} className="flex items-start gap-2 py-1 text-xs leading-relaxed text-sub">
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
        <p className="mt-4 text-right text-micro text-subtle">
          Actualización automática cada 6 s · {filtered.length !== services.length ? `${filtered.length} de ` : ''}
          {services.length} servicios
          {services.some((s) => s.startedAt && s.state === 'running')
            ? ` · el más reciente se inició ${timeAgo(Math.max(...services.filter((s) => s.startedAt).map((s) => Date.parse(s.startedAt!))))}`
            : ''}
        </p>
      )}

      <ConfirmModal
        open={confirmRestart !== null}
        onClose={() => setConfirmRestart(null)}
        onConfirm={() => confirmRestart && restart.mutate(confirmRestart.id)}
        loading={!!confirmRestart && restarting.has(confirmRestart.id)}
        title={`Reiniciar «${confirmRestart?.name ?? ''}»`}
        message="El servicio dejará de responder durante unos segundos mientras se reinicia."
        confirmLabel="Reiniciar"
        confirmVariant="primary"
      />
    </div>
  );
}
