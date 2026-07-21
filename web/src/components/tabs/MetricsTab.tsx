import { ArrowDown, ArrowUp } from 'lucide-react';
import { MetricPoint } from '../../pages/Project';
import { MetricsSnapshot } from '../../types';
import { fmtBytes } from '../../utils';
import MetricChart from '../MetricChart';

function NetTile({ dir, value }: { dir: 'rx' | 'tx'; value: string }) {
  const rx = dir === 'rx';
  return (
    <div className="rounded-xl border border-line bg-bg px-4 py-3.5">
      <p className="flex items-center gap-1.5 text-[11px] text-subtle">
        {rx ? <ArrowDown size={12} className="text-ok" /> : <ArrowUp size={12} className="text-info" />}
        Red — {rx ? 'recibido' : 'enviado'}
      </p>
      <p className="tnum mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}

export default function MetricsTab({
  serviceId,
  latest,
  historyRef,
}: {
  serviceId: string;
  latest: MetricsSnapshot | null;
  historyRef: React.MutableRefObject<Map<string, MetricPoint[]>>;
}) {
  const history = historyRef.current.get(serviceId) ?? [];
  const entry = latest?.services[serviceId];
  const stats = entry?.stats ?? null;

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

  const memLimit = stats?.memLimit && stats.memLimit > 0 ? stats.memLimit : undefined;

  return (
    <div className="flex flex-col gap-3.5 p-4 sm:px-5">
      <MetricChart
        title="CPU"
        color="var(--color-acc)"
        fillOpacity={0.14}
        points={history.map((p) => ({ ts: p.ts, value: p.cpu }))}
        format={(v) => `${v.toFixed(1)}%`}
      />
      <MetricChart
        title={memLimit ? `Memoria · límite ${fmtBytes(memLimit)}` : 'Memoria'}
        color="var(--color-info)"
        fillOpacity={0.12}
        points={history.map((p) => ({ ts: p.ts, value: p.mem }))}
        format={(v) => fmtBytes(v)}
        fixedMax={memLimit}
      />
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <NetTile dir="rx" value={stats ? fmtBytes(stats.netRx) : '—'} />
        <NetTile dir="tx" value={stats ? fmtBytes(stats.netTx) : '—'} />
      </div>
      <p className="text-center text-[11px] text-subtle">
        Muestras cada 2,5 s · ventana de {Math.max(1, Math.round((history.length * 2.5) / 60))} min
      </p>
    </div>
  );
}
