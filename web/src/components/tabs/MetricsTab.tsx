import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Cpu, HardDrive, MemoryStick, Network } from 'lucide-react';
import { api } from '../../api';
import { MetricPoint } from '../../pages/Project';
import { MetricsSnapshot, Service, ServiceMetricHistory } from '../../types';
import { cx, fmtBytes, fmtCores, fmtRate } from '../../utils';
import MetricChart from '../MetricChart';
import { BandPoint, HistoryChart, NetBars, NetPoint } from '../HistoryChart';

type Mode = 'live' | 24 | 168 | 720;

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
      <p className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[.06em] text-subtle">
        {icon} {label}
      </p>
      <p className={cx('mt-1.5 text-[17px] font-semibold leading-none', tone === 'err' ? 'text-err' : tone === 'warn' ? 'text-warn' : 'text-txt')}>
        {value}
      </p>
      {sub && <p className="tnum mt-1 text-[11px] text-subtle">{sub}</p>}
    </div>
  );
}

function LiveView({
  serviceId,
  latest,
  history,
  service,
}: {
  serviceId: string;
  latest: MetricsSnapshot | null;
  history: MetricPoint[];
  service: Service;
}) {
  const entry = latest?.services[serviceId];
  const stats = entry?.stats ?? null;
  const cpus = service.config.cpus ?? null;
  const hostCores = latest?.host?.cpus ?? null;
  const memLimit = stats?.memLimit && stats.memLimit > 0 ? stats.memLimit : undefined;
  const memoryMb = service.config.memoryMb ?? null;

  if (latest && !latest.docker) {
    return <p className="p-6 text-center text-sm text-sub">Docker no está disponible: sin métricas.</p>;
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

  // Caudal de red: netRx/netTx son contadores ACUMULADOS del contenedor, así que
  // el dato útil («cuánto se descarga/sube ahora») es su derivada. Se calcula el
  // delta entre muestras consecutivas dividido por el tiempo; se recorta a 0 para
  // no pintar picos negativos cuando el contador se reinicia (reinicio del contenedor).
  const netRate: { ts: number; rx: number; tx: number }[] = [];
  for (let i = 1; i < history.length; i++) {
    const dt = (history[i].ts - history[i - 1].ts) / 1000;
    if (dt <= 0) continue;
    netRate.push({
      ts: history[i].ts,
      rx: Math.max(0, history[i].rx - history[i - 1].rx) / dt,
      tx: Math.max(0, history[i].tx - history[i - 1].tx) / dt,
    });
  }
  const lastRate = netRate.length ? netRate[netRate.length - 1] : null;

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
          sub={stats ? `${fmtBytes(stats.netRx)} en total` : 'recopilando…'}
        />
        <Tile
          icon={<ArrowUp size={12} className="text-info" />}
          label="Red · subida"
          value={stats && lastRate ? fmtRate(lastRate.tx) : '—'}
          sub={stats ? `${fmtBytes(stats.netTx)} en total` : 'recopilando…'}
        />
      </div>

      <MetricChart
        title="CPU · núcleos usados"
        color="var(--color-acc)"
        fillOpacity={0.14}
        points={history.map((p) => ({ ts: p.ts, value: p.cpu / 100 }))}
        format={(v) => `${v.toFixed(v < 1 ? 2 : 1)}`}
        fixedMax={cpus ?? undefined}
      />
      <MetricChart
        title={memLimit ? `Memoria · límite ${fmtBytes(memLimit)}` : 'Memoria'}
        color="var(--color-info)"
        fillOpacity={0.12}
        points={history.map((p) => ({ ts: p.ts, value: p.mem }))}
        format={(v) => fmtBytes(v)}
        fixedMax={memLimit}
      />
      <MetricChart
        title="Red · descarga"
        color="var(--color-ok)"
        fillOpacity={0.12}
        points={netRate.map((p) => ({ ts: p.ts, value: p.rx }))}
        format={(v) => fmtRate(v)}
      />
      <MetricChart
        title="Red · subida"
        color="var(--color-info)"
        fillOpacity={0.12}
        points={netRate.map((p) => ({ ts: p.ts, value: p.tx }))}
        format={(v) => fmtRate(v)}
      />
      <p className="text-center text-[11px] text-subtle">
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
  const points = q.data?.points ?? [];
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
    return <p className="p-6 text-center text-sm text-warn">No se pudo cargar el histórico: {(q.error as Error).message}</p>;
  }

  const memLimitBytes = memoryMb ? memoryMb * 1024 * 1024 : null;
  const quotaBytes = diskMb ? diskMb * 1024 * 1024 : null;

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
        color="var(--color-acc)"
        format={(v) => v.toFixed(v < 1 ? 2 : 1)}
        threshold={cpus ? { value: cpus, label: `límite ${cpus}` } : null}
      />
      {/* Sin fixedMax: si un pico supera el límite, la banda lo muestra por
          encima de la línea de umbral en vez de aplastarlo contra el techo. */}
      <HistoryChart
        title="Memoria"
        points={memPoints}
        hours={hours}
        color="var(--color-info)"
        format={(v) => fmtBytes(v)}
        threshold={memLimitBytes ? { value: memLimitBytes, label: `límite ${memoryMb} MB` } : null}
      />
      <NetBars points={netPoints} hours={hours} format={(v) => fmtBytes(v)} />
      <HistoryChart
        title="Disco ocupado"
        points={diskPoints}
        hours={hours}
        color="var(--color-ok)"
        format={(v) => fmtBytes(v)}
        threshold={quotaBytes ? { value: quotaBytes, label: `cuota ${diskMb} MB` } : null}
      />
      <p className="text-center text-[11px] text-subtle">
        Muestras del monitor cada 30 s, agrupadas por {hours <= 24 ? 'hora' : hours <= 168 ? '6 h' : 'día'}. La banda va de la
        media al pico.
      </p>
    </div>
  );
}

export default function MetricsTab({
  serviceId,
  service,
  latest,
  historyRef,
}: {
  serviceId: string;
  service: Service;
  latest: MetricsSnapshot | null;
  historyRef: React.MutableRefObject<Map<string, MetricPoint[]>>;
}) {
  const [mode, setMode] = useState<Mode>('live');
  const history = historyRef.current.get(serviceId) ?? [];

  return (
    <div className="flex flex-col gap-3.5 p-4 sm:px-5">
      <div className="flex items-center gap-1 self-start rounded-xl border border-line bg-surface p-1 text-[13px]">
        {MODES.map((m) => (
          <button
            key={String(m.key)}
            onClick={() => setMode(m.key)}
            className={cx(
              'press rounded-lg px-3 py-1 transition-colors',
              mode === m.key ? 'bg-acc/[.16] font-medium text-acc-soft' : 'text-sub hover:text-txt',
            )}
          >
            {m.key === 'live' && <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-ok align-middle pulse-soft" aria-hidden />}
            {m.label}
          </button>
        ))}
      </div>

      <div key={String(mode)} className="tab-in">
        {mode === 'live' ? (
          <LiveView serviceId={serviceId} latest={latest} history={history} service={service} />
        ) : (
          <HistoryView serviceId={serviceId} service={service} hours={mode} />
        )}
      </div>
    </div>
  );
}
