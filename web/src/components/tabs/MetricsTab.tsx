import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Cpu, HardDrive, MemoryStick, Network } from 'lucide-react';
import { api } from '../../api';
import { MetricPoint } from '../../pages/Project';
import { useLiveSnapshot } from '../../livemetrics';
import { Service, ServiceMetricHistory } from '../../types';
import { cx, EMPTY_LIST, fmtBytes, fmtCores, fmtRate } from '../../utils';
import MetricChart from '../MetricChart';
import { BandPoint, HistoryChart, NetBars, NetPoint } from '../HistoryChart';
import { Segmented } from '../ui';

type Mode = 'live' | 24 | 168 | 720;

// Formateadores fijos: pasados como funciones nuevas en cada render anulaban el memo de las gráficas.
const fmtCoresAxis = (v: number) => `${v.toFixed(v < 1 ? 2 : 1)}`;
const fmtBytesAxis = (v: number) => fmtBytes(v);
const fmtRateAxis = (v: number) => fmtRate(v);

const MODES: { key: Mode; label: string }[] = [
  { key: 'live', label: 'En vivo' },
  { key: 24, label: '24 h' },
  { key: 168, label: '7 días' },
  { key: 720, label: '30 días' },
];

/** Tarjeta de resumen: dato grande, contexto pequeño, sin adornos. */
function Tile({
  icon,
  label,
  value,
  sub,
  tone = 'txt',
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'txt' | 'warn' | 'err';
}) {
  return (
    <div className="rounded-xl border border-line bg-bg px-3.5 py-3">
      <p className="flex items-center gap-1.5 eyebrow text-subtle">
        {icon} {label}
      </p>
      <p className={cx('mt-1.5 text-lg font-semibold leading-none', tone === 'err' ? 'text-err' : tone === 'warn' ? 'text-warn' : 'text-txt')}>
        {value}
      </p>
      {sub && <p className="tnum mt-1 text-xs text-subtle">{sub}</p>}
    </div>
  );
}

function LiveView({ serviceId, history, service }: { serviceId: string; history: MetricPoint[]; service: Service }) {
  // La vista en vivo es la que sí quiere repintarse con cada foto del stream.
  const latest = useLiveSnapshot();
  const entry = latest?.services[serviceId];
  const stats = entry?.stats ?? null;
  const cpus = service.config.cpus ?? null;
  const hostCores = latest?.host?.cpus ?? null;
  const memLimit = stats?.memLimit && stats.memLimit > 0 ? stats.memLimit : undefined;
  const memoryMb = service.config.memoryMb ?? null;

  // Caudal de red: netRx/netTx son contadores ACUMULADOS del contenedor, así que
  // el dato útil («cuánto se descarga/sube ahora») es su derivada. Se calcula el
  // delta entre muestras consecutivas dividido por el tiempo; se recorta a 0 para
  // no pintar picos negativos cuando el contador se reinicia (reinicio del contenedor).
  //
  // `history` es el MISMO array mutado por el stream, así que la identidad no
  // sirve como dependencia: se usa su longitud y el sello de la última muestra.
  // El hook va ANTES de los returns tempranos (reglas de hooks).
  const lastTs = history.length ? history[history.length - 1].ts : 0;
  const { netRate, cpuPts, memPts, rxPts, txPts } = useMemo(() => {
    const rate: { ts: number; rx: number; tx: number }[] = [];
    for (let i = 1; i < history.length; i++) {
      const dt = (history[i].ts - history[i - 1].ts) / 1000;
      if (dt <= 0) continue;
      rate.push({
        ts: history[i].ts,
        rx: Math.max(0, history[i].rx - history[i - 1].rx) / dt,
        tx: Math.max(0, history[i].tx - history[i - 1].tx) / dt,
      });
    }
    return {
      netRate: rate,
      cpuPts: history.map((p) => ({ ts: p.ts, value: p.cpu / 100 })),
      memPts: history.map((p) => ({ ts: p.ts, value: p.mem })),
      rxPts: rate.map((p) => ({ ts: p.ts, value: p.rx })),
      txPts: rate.map((p) => ({ ts: p.ts, value: p.tx })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, history.length, lastTs]);
  const lastRate = netRate.length ? netRate[netRate.length - 1] : null;

  if (latest && !latest.docker) {
    return <p className="p-6 text-center text-sm text-sub">Docker no está disponible. No hay métricas.</p>;
  }
  if (!stats && history.length === 0) {
    return (
      <p className="p-6 text-center text-sm text-sub">
        El servicio no está en ejecución. Las métricas aparecerán cuando el contenedor esté activo.
      </p>
    );
  }

  // % del límite (o del host si no hay límite) — el número que de verdad dice «cuánto».
  const allowance = cpus ? cpus * 100 : hostCores ? hostCores * 100 : null;
  const cpuPctOfLimit = stats && allowance ? (stats.cpuPercent / allowance) * 100 : null;
  const memPct = stats && memLimit ? (stats.memUsage / memLimit) * 100 : null;

  return (
    <div className="flex flex-col gap-3.5">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Tile
          icon={<Cpu size={12} />}
          label="CPU"
          value={stats ? fmtCores(stats.cpuPercent) : '—'}
          sub={
            cpuPctOfLimit !== null
              ? `${cpuPctOfLimit.toFixed(0)}% ${cpus ? `de ${cpus} núcl.` : 'del host'}`
              : cpus
                ? `límite ${cpus} núcl.`
                : 'sin límite'
          }
          tone={cpuPctOfLimit !== null && cpuPctOfLimit > 90 ? 'err' : cpuPctOfLimit !== null && cpuPctOfLimit > 75 ? 'warn' : 'txt'}
        />
        <Tile
          icon={<MemoryStick size={12} />}
          label="Memoria"
          value={stats ? fmtBytes(stats.memUsage) : '—'}
          sub={
            memoryMb
              ? memPct !== null
                ? `${memPct.toFixed(0)}% de ${memoryMb} MB`
                : `límite ${memoryMb} MB`
              : memLimit
                ? `${memPct !== null ? `${memPct.toFixed(0)}% del host` : 'sin límite'}`
                : 'sin límite'
          }
          tone={memoryMb && memPct !== null && memPct > 90 ? 'err' : memoryMb && memPct !== null && memPct > 75 ? 'warn' : 'txt'}
        />
        <Tile
          icon={<ArrowDown size={12} className="text-ok" />}
          label="Red · descarga"
          value={stats && lastRate ? fmtRate(lastRate.rx) : '—'}
          sub={stats ? `${fmtBytes(stats.netRx)} en total` : 'Recopilando datos…'}
        />
        <Tile
          icon={<ArrowUp size={12} className="text-info" />}
          label="Red · subida"
          value={stats && lastRate ? fmtRate(lastRate.tx) : '—'}
          sub={stats ? `${fmtBytes(stats.netTx)} en total` : 'Recopilando datos…'}
        />
      </div>

      <MetricChart
        title="CPU · núcleos usados"
        color="var(--color-chart-1)"
        fillOpacity={0.14}
        points={cpuPts}
        format={fmtCoresAxis}
        fixedMax={cpus ?? undefined}
      />
      <MetricChart
        title={memLimit ? `Memoria · límite ${fmtBytes(memLimit)}` : 'Memoria'}
        color="var(--color-chart-2)"
        fillOpacity={0.12}
        points={memPts}
        format={fmtBytesAxis}
        fixedMax={memLimit}
      />
      <MetricChart
        title="Red · descarga"
        color="var(--color-chart-3)"
        fillOpacity={0.12}
        points={rxPts}
        format={fmtRateAxis}
      />
      <MetricChart
        title="Red · subida"
        color="var(--color-chart-4)"
        fillOpacity={0.12}
        points={txPts}
        format={fmtRateAxis}
      />
      <p className="text-center text-xs text-subtle">
        Muestras cada 2,5 s · ventana de {Math.max(1, Math.round((history.length * 2.5) / 60))} min
      </p>
    </div>
  );
}

function HistoryView({ serviceId, service, hours }: { serviceId: string; service: Service; hours: number }) {
  const cpus = service.config.cpus ?? null;
  const memoryMb = service.config.memoryMb ?? null;
  const diskMb = service.config.diskMb ?? null;

  const q = useQuery({
    queryKey: ['metricsHistory', serviceId, hours],
    queryFn: () => api.get<ServiceMetricHistory>(`/services/${serviceId}/metrics/history?hours=${hours}`),
    refetchInterval: 60_000,
    retry: false,
  });

  // Agregados y series memoizados: el drawer re-renderiza con cada snapshot SSE
  // (~2,5 s) pero el histórico solo cambia cada 60 s. El hook va ANTES de los
  // returns tempranos (reglas de hooks); `points` es [] mientras carga.
  const points = q.data?.points ?? EMPTY_LIST;
  const { cpuAvg, cpuMax, memAvg, memMax, rxTotal, txTotal, diskLast, diskDelta, cpuPoints, memPoints, netPoints, diskPoints } = useMemo(() => {
    // Media del periodo PONDERADA por muestras: un cubo parcial del borde (con una
    // sola muestra) no debe pesar igual que uno lleno, o el número se dispara.
    const cpuValid = points.filter((p) => p.cpuAvg !== null);
    const memValid = points.filter((p) => p.memAvg !== null);
    const cpuSamples = cpuValid.reduce((a, p) => a + p.samples, 0);
    const memSamples = memValid.reduce((a, p) => a + p.samples, 0);
    const diskPts = points.filter((p) => p.disk !== null);
    const dLast = diskPts.length ? diskPts[diskPts.length - 1].disk : null;
    const dFirst = diskPts.length ? diskPts[0].disk : null;
    return {
      cpuAvg: cpuSamples ? cpuValid.reduce((a, p) => a + (p.cpuAvg ?? 0) * p.samples, 0) / cpuSamples : null,
      cpuMax: points.reduce((a, p) => Math.max(a, p.cpuMax ?? 0), 0),
      memAvg: memSamples ? memValid.reduce((a, p) => a + (p.memAvg ?? 0) * p.samples, 0) / memSamples : null,
      memMax: points.reduce((a, p) => Math.max(a, p.memMax ?? 0), 0),
      rxTotal: points.reduce((a, p) => a + p.netRx, 0),
      txTotal: points.reduce((a, p) => a + p.netTx, 0),
      diskLast: dLast,
      diskDelta: dLast !== null && dFirst !== null ? dLast - dFirst : null,
      cpuPoints: points.map((p) => ({ t: p.t, avg: p.cpuAvg === null ? null : p.cpuAvg / 100, max: p.cpuMax === null ? null : p.cpuMax / 100 })) as BandPoint[],
      memPoints: points.map((p) => ({ t: p.t, avg: p.memAvg, max: p.memMax })) as BandPoint[],
      netPoints: points.map((p) => ({ t: p.t, rx: p.netRx, tx: p.netTx })) as NetPoint[],
      diskPoints: points.map((p) => ({ t: p.t, avg: p.disk, max: p.disk })) as BandPoint[],
    };
  }, [points]);

  const memLimitBytes = memoryMb ? memoryMb * 1024 * 1024 : null;
  const quotaBytes = diskMb ? diskMb * 1024 * 1024 : null;
  // Objetos estables para el memo de las gráficas. También ANTES de los returns
  // tempranos: un hook tras un return condicional rompe el orden de hooks.
  const cpuThreshold = useMemo(() => (cpus ? { value: cpus, label: `límite ${cpus}` } : null), [cpus]);
  const memThreshold = useMemo(() => (memLimitBytes ? { value: memLimitBytes, label: `límite ${memoryMb} MB` } : null), [memLimitBytes, memoryMb]);
  const diskThreshold = useMemo(() => (quotaBytes ? { value: quotaBytes, label: `cuota ${diskMb} MB` } : null), [quotaBytes, diskMb]);

  if (q.isLoading) {
    return (
      <div aria-busy className="flex flex-col gap-3.5">
        <div className="h-[74px] animate-pulse rounded-xl bg-surface2/50" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[208px] animate-pulse rounded-xl bg-surface2/50" />
        ))}
      </div>
    );
  }
  if (q.isError) {
    return <p className="p-6 text-center text-sm text-warn">No se ha podido cargar el histórico: {(q.error as Error).message}</p>;
  }

  return (
    <div className="flex flex-col gap-3.5">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Tile
          icon={<Cpu size={12} />}
          label="CPU media"
          value={cpuAvg !== null ? fmtCores(cpuAvg) : '—'}
          sub={cpuMax > 0 ? `pico ${fmtCores(cpuMax)}` : cpus ? `límite ${cpus} núcl.` : undefined}
        />
        <Tile
          icon={<MemoryStick size={12} />}
          label="RAM media"
          value={memAvg !== null ? fmtBytes(memAvg) : '—'}
          sub={memMax > 0 ? `pico ${fmtBytes(memMax)}` : memoryMb ? `límite ${memoryMb} MB` : undefined}
        />
        <Tile icon={<Network size={12} />} label="Red total" value={fmtBytes(rxTotal + txTotal)} sub={`↓ ${fmtBytes(rxTotal)} · ↑ ${fmtBytes(txTotal)}`} />
        <Tile
          icon={<HardDrive size={12} />}
          label="Disco"
          value={diskLast !== null ? fmtBytes(diskLast) : '—'}
          sub={
            diskDelta !== null && Math.abs(diskDelta) > 1024
              ? `${diskDelta >= 0 ? '+' : '−'}${fmtBytes(Math.abs(diskDelta))} en el periodo`
              : quotaBytes
                ? `cuota ${diskMb} MB`
                : undefined
          }
        />
      </div>

      <HistoryChart
        title="CPU · núcleos"
        points={cpuPoints}
        hours={hours}
        color="var(--color-chart-1)"
        format={fmtCoresAxis}
        threshold={cpuThreshold}
      />
      {/* Sin fixedMax: si un pico supera el límite, la banda lo muestra por
          encima de la línea de umbral en vez de aplastarlo contra el techo. */}
      <HistoryChart
        title="Memoria"
        points={memPoints}
        hours={hours}
        color="var(--color-chart-2)"
        format={fmtBytesAxis}
        threshold={memThreshold}
      />
      <NetBars points={netPoints} hours={hours} format={fmtBytesAxis} />
      <HistoryChart
        title="Disco ocupado"
        points={diskPoints}
        hours={hours}
        color="var(--color-chart-5)"
        format={fmtBytesAxis}
        threshold={diskThreshold}
      />
      <p className="text-center text-xs text-subtle">La banda representa el intervalo entre la media y el pico.</p>
    </div>
  );
}

export default function MetricsTab({
  serviceId,
  service,
  historyRef,
}: {
  serviceId: string;
  service: Service;
  historyRef: React.MutableRefObject<Map<string, MetricPoint[]>>;
}) {
  const [mode, setMode] = useState<Mode>('live');
  const history = historyRef.current.get(serviceId) ?? [];

  return (
    <div className="flex flex-col gap-3.5 p-4 sm:px-5">
      <Segmented
        className="self-start"
        label="Ventana de las métricas"
        value={mode}
        onChange={setMode}
        options={MODES.map((m) => ({
          key: m.key,
          label: m.label,
          icon: m.key === 'live' ? <span className="pulse-soft h-1.5 w-1.5 rounded-full bg-ok" aria-hidden /> : undefined,
        }))}
      />

      <div key={String(mode)} className="tab-in">
        {mode === 'live' ? (
          <LiveView serviceId={serviceId} history={history} service={service} />
        ) : (
          <HistoryView serviceId={serviceId} service={service} hours={mode} />
        )}
      </div>
    </div>
  );
}
