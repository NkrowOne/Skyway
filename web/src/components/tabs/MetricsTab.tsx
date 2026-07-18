import { ArrowDown, ArrowUp } from 'lucide-react';
import { MetricPoint } from '../../pages/Project';
import { MetricsSnapshot } from '../../types';
import { fmtBytes } from '../../utils';
import MetricChart from '../MetricChart';

// Colores validados (dataviz) sobre superficie oscura #12141a.
const CPU_COLOR = '#8b5cf6';
const MEM_COLOR = '#0891b2';

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
    <div className="space-y-4 p-4">
      <MetricChart
        title="CPU"
        color={CPU_COLOR}
        points={history.map((p) => ({ ts: p.ts, value: p.cpu }))}
        format={(v) => `${v.toFixed(1)}%`}
      />
      <MetricChart
        title={memLimit ? `Memoria (límite ${fmtBytes(memLimit)})` : 'Memoria'}
        color={MEM_COLOR}
        points={history.map((p) => ({ ts: p.ts, value: p.mem }))}
        format={(v) => fmtBytes(v)}
        fixedMax={memLimit}
      />
      <div className="grid grid-cols-2 gap-4">
        <div className="card flex items-center gap-3 p-4">
          <ArrowDown size={16} className="text-ok" />
          <div>
            <p className="text-xs uppercase tracking-wide text-sub">Red — recibido</p>
            <p className="text-sm">{stats ? fmtBytes(stats.netRx) : '—'}</p>
          </div>
        </div>
        <div className="card flex items-center gap-3 p-4">
          <ArrowUp size={16} className="text-acc2" />
          <div>
            <p className="text-xs uppercase tracking-wide text-sub">Red — enviado</p>
            <p className="text-sm">{stats ? fmtBytes(stats.netTx) : '—'}</p>
          </div>
        </div>
      </div>
      <p className="text-center text-xs text-sub/70">Muestras cada 2,5 s · ventana de {Math.round((history.length * 2.5) / 60)} min</p>
    </div>
  );
}
