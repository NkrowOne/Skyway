import { BellRing, Globe } from 'lucide-react';
import { ActiveDeploy, ContainerState, Service, ServiceStats } from '../types';
import { cx, DEPLOY_STATUS_LABEL, fmtBytes, fmtCores, STATE_LABEL, STATE_PULSE, STATE_TONE } from '../utils';
import { DeploySweep } from './DeployBadge';
import { ModuleChip, moduleKind } from './ModuleIcon';
import { Chip, StatusBadge } from './ui';

const TEMPLATE_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  redis: 'Redis',
  mysql: 'MySQL',
  mongo: 'MongoDB',
  minio: 'MinIO',
};

/** Fracción del límite de CPU a partir de la cual el dato se marca en aviso. */
const CPU_ALERT = 0.9;

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
  /*
   * Docker cuenta la CPU con 100 = un núcleo, así que un servicio de cuatro
   * núcleos a tope reporta 400. La tarjeta lo pintaba como «400 %» sobre una
   * barra tope 100 y saltaba a aviso a partir de 0,9 núcleos. Ahora va en
   * núcleos, como en el resto de la aplicación, y el umbral es relativo al
   * límite reservado.
   */
  const limiteCpu = service.config.cpus ?? null;
  const cpuEnAviso = !!(stats && limiteCpu && stats.cpuPercent / 100 >= limiteCpu * CPU_ALERT);
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
        'group relative rounded-xl border p-4 text-left',
        selected
          ? 'border-acc bg-surface2'
          : cx(
              'card-hover bg-surface',
              /*
               * El borde solo cambia cuando hay algo que mirar, y estar caído
               * es lo primero: antes un servicio muerto se veía igual que uno
               * sano y había que leer la píldora de cada tarjeta para dar con él.
               */
              STATE_TONE[state] === 'err' || alertCount > 0
                ? 'border-err/45'
                : deploy || STATE_TONE[state] === 'warn'
                  ? 'border-warn/45'
                  : 'border-line',
            ),
      )}
    >
      {/* La cinta va antes que la chapa de alertas para que esta pinte encima. */}
      {deploy && <DeploySweep />}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <ModuleChip kind={moduleKind(service)} size={36} />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-txt">{service.name}</h3>
            <p className="truncate font-mono text-xs text-subtle">{subtitle}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {alertCount > 0 && (
            <Chip tone="err" icon={<BellRing size={10} />} title={alertCount === 1 ? '1 alerta abierta' : `${alertCount} alertas abiertas`}>
              {alertCount}
            </Chip>
          )}
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
      </div>

      <div className="mt-3.5 flex items-center justify-between gap-2 text-xs text-sub">
        {stats ? (
          <div className="tnum flex items-center gap-3">
            <span
              className="inline-flex items-center gap-1.5"
              title={limiteCpu ? `CPU: ${fmtCores(stats.cpuPercent)} de ${limiteCpu} reservados` : `CPU: ${fmtCores(stats.cpuPercent)}`}
            >
              <span className="text-xs text-subtle">CPU</span>
              <span className={cx('tnum text-xs font-medium', cpuEnAviso ? 'font-semibold text-warn' : 'text-txt')}>
                {fmtCores(stats.cpuPercent)}
              </span>
              {/* La barra solo aparece cuando hay un límite contra el que medir:
                  sin denominador honesto es un adorno que además mentía. */}
              {limiteCpu && (
                <span className="inline-flex h-1 w-8 overflow-hidden rounded-full bg-surface3">
                  <span
                    className={cx('h-full rounded-full transition-[width] duration-[--dur-3]', cpuEnAviso ? 'bg-warn' : 'bg-sub')}
                    style={{ width: `${Math.min(100, Math.max(8, (stats.cpuPercent / 100 / limiteCpu) * 100))}%` }}
                  />
                </span>
              )}
            </span>
            <span className="inline-flex items-center gap-1.5" title={`Uso de RAM: ${fmtBytes(stats.memUsage)}`}>
              <span className="text-xs text-subtle">RAM</span>
              <span className="tnum text-xs font-medium text-txt">{fmtBytes(stats.memUsage)}</span>
            </span>
          </div>
        ) : (
          <span className="text-xs text-subtle">Sin métricas</span>
        )}
        {domain && (
          <span className="flex min-w-0 items-center gap-1 text-sub" title={`Dominio: ${domain}`}>
            <Globe size={11} className="shrink-0 text-subtle" />
            <span className="max-w-[130px] truncate font-mono text-xs">{domain}</span>
          </span>
        )}
      </div>
    </button>
  );
}
