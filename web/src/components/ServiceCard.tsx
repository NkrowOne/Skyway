import { BellRing, Database, GitBranch, Globe } from 'lucide-react';
import { ContainerState, Service, ServiceStats } from '../types';
import { cx, fmtBytes, STATE_COLOR, STATE_LABEL } from '../utils';
import { StatusDot } from './ui';

const TEMPLATE_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  redis: 'Redis',
  mysql: 'MySQL',
  mongo: 'MongoDB',
  minio: 'MinIO',
};

export default function ServiceCard({
  service,
  metrics,
  alertCount = 0,
  selected,
  onClick,
}: {
  service: Service;
  metrics: { state: ContainerState; stats: ServiceStats | null } | null;
  alertCount?: number;
  selected: boolean;
  onClick: () => void;
}) {
  const state = metrics?.state ?? service.runtime?.state ?? 'unknown';
  const stats = metrics?.stats ?? null;
  const isDb = service.type === 'database';
  const domain = !isDb ? service.config.domains?.[0] : undefined;

  return (
    <button
      onClick={onClick}
      className={cx(
        'card group relative p-4 text-left transition-all hover:border-acc/60',
        selected && 'border-acc/70 ring-1 ring-acc/30',
        alertCount > 0 && !selected && 'border-err/40',
      )}
    >
      {alertCount > 0 && (
        <span className="absolute -right-2 -top-2 flex items-center gap-1 rounded-full border border-err/40 bg-err/15 px-2 py-0.5 text-[10px] font-medium text-err">
          <BellRing size={10} /> {alertCount}
        </span>
      )}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span
            className={cx(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
              isDb ? 'bg-acc2/10 text-acc2' : 'bg-acc/15 text-acc',
            )}
          >
            {isDb ? <Database size={16} /> : <GitBranch size={16} />}
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium">{service.name}</h3>
            <p className="truncate text-xs text-sub">
              {isDb
                ? `${TEMPLATE_LABEL[service.config.template] ?? service.config.template}:${service.config.version}`
                : service.config.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '')}
            </p>
          </div>
        </div>
        <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-panel2 px-2 py-0.5 text-[11px] text-sub">
          <StatusDot colorClass={STATE_COLOR[state]} size={6} />
          {STATE_LABEL[state]}
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-sub">
        <div className="flex items-center gap-3">
          {stats ? (
            <>
              <span>
                CPU <span className="text-txt">{stats.cpuPercent}%</span>
              </span>
              <span>
                RAM <span className="text-txt">{fmtBytes(stats.memUsage)}</span>
              </span>
            </>
          ) : (
            <span className="text-sub/60">Sin métricas</span>
          )}
        </div>
        {domain && (
          <span className="flex items-center gap-1 text-acc2">
            <Globe size={12} />
            <span className="max-w-[140px] truncate">{domain}</span>
          </span>
        )}
      </div>
    </button>
  );
}
