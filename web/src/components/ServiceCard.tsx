import { BellRing, Globe } from 'lucide-react';
import { ActiveDeploy, ContainerState, Service, ServiceStats } from '../types';
import { cx, DEPLOY_STATUS_LABEL, fmtBytes, fmtCores, fmtMb, STATE_LABEL, STATE_PULSE, STATE_TONE } from '../utils';
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
  const limiteMem = service.config.memoryMb ?? null;
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
               * El borde de color se reserva para lo que hay que encontrar de un
               * vistazo en una rejilla de veinte tarjetas: lo caído y lo que
               * tiene alertas. Un despliegue en marcha ya lo dicen la cinta
               * superior y su chapa; teñir además el borde era decirlo tres veces.
               */
              STATE_TONE[state] === 'err' || alertCount > 0
                ? 'border-err/40'
                : STATE_TONE[state] === 'warn'
                  ? 'border-warn/35'
                  : 'border-line',
            ),
      )}
    >
      {/* La cinta va antes que la chapa de alertas para que esta pinte encima. */}
      {deploy && <DeploySweep />}
      {/* El nombre reserva un mínimo: si las chapas no caben en lo que sobra,
          bajan de línea en vez de dejar el título en cuatro letras. */}
      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1.5">
        <div className="flex min-w-[9rem] flex-1 items-center gap-2.5">
          <ModuleChip kind={moduleKind(service)} size={36} />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-txt">{service.name}</h3>
            <p className="truncate font-mono text-xs text-subtle">{subtitle}</p>
          </div>
        </div>
        {/* Las chapas ceden y se envuelven en vez de aplastar el nombre: en la
            columna más estrecha el título llegaba a quedarse en cuatro letras. */}
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {alertCount > 0 && (
            <Chip tone="err" icon={<BellRing size={10} />} title={alertCount === 1 ? '1 alerta abierta' : `${alertCount} alertas abiertas`}>
              {alertCount}
            </Chip>
          )}
          {/*
           * La fase del despliegue se suma al estado, no lo sustituye: mientras
           * sale una versión —que es justo cuando más importa— la tarjeta dejaba
           * de decir si el servicio seguía en pie.
           */}
          {deploy && <Chip size="sm" tone="warn" dot pulse>{DEPLOY_STATUS_LABEL[deploy.status]}</Chip>}
          <StatusBadge
            tone={STATE_TONE[state]}
            label={STATE_LABEL[state]}
            pulse={STATE_PULSE[state]}
            replicas={metrics?.replicas}
          />
        </div>
      </div>

      {/*
        * Métricas y dominio en dos filas, no en una: a 250px de columna la fila
        * única partía «1,4 núcleos» y «412 MB/1 GB» en dos líneas cada una y
        * dejaba el dominio reducido a su icono.
        */}
      {/*
        * Un filo separa quién es el servicio de cómo va, y la telemetría se
        * reparte en dos columnas fijas: así CPU y RAM caen en la misma vertical
        * en todas las tarjetas de la rejilla y se pueden comparar de un barrido,
        * en vez de bailar según lo largo que sea cada valor.
        */}
      <div className="mt-3.5 grid grid-cols-2 gap-x-3 border-t border-line/70 pt-3 text-xs text-sub">
        {stats ? (
          <>
            <span
              className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap"
              title={limiteCpu ? `CPU: ${fmtCores(stats.cpuPercent)} de ${limiteCpu} reservados` : `CPU: ${fmtCores(stats.cpuPercent)}`}
            >
              <span className="text-subtle">CPU</span>
              <span className={cx('tnum font-medium', cpuEnAviso ? 'font-semibold text-warn' : 'text-txt')}>
                {(stats.cpuPercent / 100).toFixed(stats.cpuPercent < 100 ? 2 : 1)}
                {limiteCpu && <span className="font-normal text-subtle">/{limiteCpu}</span>}
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
            <span
              className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap"
              title={limiteMem ? `RAM: ${fmtBytes(stats.memUsage)} de ${fmtMb(limiteMem)}` : `RAM: ${fmtBytes(stats.memUsage)}`}
            >
              <span className="text-subtle">RAM</span>
              <span className="tnum font-medium text-txt">
                {fmtBytes(stats.memUsage)}
                {/* Sin su techo, «412 MB» no dice si sobra o falta. */}
                {limiteMem && <span className="font-normal text-subtle">/{fmtMb(limiteMem)}</span>}
              </span>
            </span>
          </>
        ) : (
          <span className="col-span-2 text-subtle">Sin métricas</span>
        )}
      </div>

      {domain && (
        <span className="mt-1.5 flex min-w-0 items-center gap-1 text-xs text-sub" title={`Dominio: ${domain}`}>
          <Globe size={11} className="shrink-0 text-subtle" aria-hidden />
          <span className="truncate font-mono">{domain}</span>
        </span>
      )}
    </button>
  );
}
