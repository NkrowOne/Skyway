import { BellRing, Globe } from 'lucide-react';
import { ActiveDeploy, ContainerState, Service, ServiceStats } from '../types';
import { cx, DEPLOY_STATUS_LABEL, fmtBytes, STATE_LABEL, STATE_PULSE, STATE_TONE } from '../utils';
import { DeploySweep } from './DeployBadge';
import { ModuleChip, moduleKind } from './ModuleIcon';
import { StatusBadge } from './ui';

const TEMPLATE_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  redis: 'Redis',
  mysql: 'MySQL',
  mongo: 'MongoDB',
  minio: 'MinIO',
};

/** Umbral visual: CPU al límite se marca en warn. */
const CPU_ALERT = 90;

export default function ServiceCard({
  service,
  metrics,
  alertCount = 0,
  deploy = null,
  selected,
  onClick,
}: {
  service: Service;
  metrics: { state: ContainerState; stats: ServiceStats | null; replicas?: { running: number; total: number } } | null;
  alertCount?: number;
  /** Despliegue vivo del servicio, si lo hay. */
  deploy?: ActiveDeploy | null;
  selected: boolean;
  onClick: () => void;
}) {
  const state = metrics?.state ?? service.runtime?.state ?? 'unknown';
  const stats = metrics?.stats ?? null;
  const isDb = service.type === 'database';
  const domain = !isDb ? service.config.domains?.[0] : undefined;
  const subtitle = isDb
    ? `${(TEMPLATE_LABEL[service.config.template] ?? service.config.template).toLowerCase()}:${service.config.version}`
    : service.type === 'image'
      ? service.config.image ?? ''
      : service.config.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '');

  return (
    <button
      onClick={onClick}
      className={cx(
        'group relative rounded-xl border bg-surface p-4 text-left transition-all duration-200',
        selected
          ? 'border-acc/70 shadow-[0_0_20px_-4px_color-mix(in_oklab,var(--color-acc)_35%,transparent)] bg-surface2/40'
          : cx(
              'card-hover shadow-lvl1 hover:border-line/90',
              alertCount > 0
                ? 'border-[color-mix(in_oklab,var(--color-err)_45%,var(--color-line))]'
                : deploy
                  ? 'border-[color-mix(in_oklab,var(--color-warn)_45%,var(--color-line))]'
                  : 'border-line',
            ),
      )}
    >
      {/* La cinta va antes que la chapa de alertas para que esta pinte encima. */}
      {deploy && <DeploySweep />}
      {alertCount > 0 && (
        <span className="absolute -top-[9px] right-3 flex items-center gap-1 rounded-full bg-err px-2 py-0.5 text-[10px] font-semibold text-white shadow-[0_2px_8px_-2px_color-mix(in_oklab,var(--color-err)_60%,transparent)]">
          <BellRing size={10} /> {alertCount === 1 ? '1 alerta' : `${alertCount} alertas`}
        </span>
      )}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <ModuleChip kind={moduleKind(service)} size={36} />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-txt group-hover:text-acc-soft transition-colors">
              {service.name}
            </h3>
            <p className="truncate font-mono text-[11px] text-subtle">{subtitle}</p>
          </div>
        </div>
        {/* Con un despliegue vivo, la chapa dice la fase en vez del estado */}
        {deploy ? (
          <StatusBadge tone="warn" label={DEPLOY_STATUS_LABEL[deploy.status]} pulse />
        ) : (
          <StatusBadge
            tone={STATE_TONE[state]}
            label={STATE_LABEL[state]}
            pulse={STATE_PULSE[state]}
            replicas={metrics?.replicas}
          />
        )}
      </div>

      <div className="mt-3.5 flex items-center justify-between gap-2 text-xs text-sub">
        {stats ? (
          <div className="tnum flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5">
              <span className="text-subtle">CPU</span>
              <span className={cx('font-medium', stats.cpuPercent >= CPU_ALERT ? 'font-semibold text-warn' : 'text-txt')}>
                {stats.cpuPercent}%
              </span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="text-subtle">RAM</span>
              <span className="font-medium text-txt">{fmtBytes(stats.memUsage)}</span>
            </span>
          </div>
        ) : (
          <span className="text-subtle">Sin métricas</span>
        )}
        {domain && (
          <span className="flex min-w-0 items-center gap-1 text-sub group-hover:text-txt transition-colors">
            <Globe size={11} className="shrink-0" />
            <span className="max-w-[120px] truncate text-[11px] font-mono">{domain}</span>
          </span>
        )}
      </div>
    </button>
  );
}
