import { BellRing, Globe } from 'lucide-react';
import { ActiveDeploy, ContainerState, Service, ServiceStats } from '../types';
import { cx, DEPLOY_STATUS_LABEL, fmtBytes, fmtCores, fmtMb, serviceStatus } from '../utils';
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
  // El estado vivo viene del stream; el porqué (código de salida, parada
  // manual) viaja con el servicio. Juntos distinguen «parado» de «caído».
  const status = serviceStatus(state, { exitCode: service.runtime?.exitCode, stoppedAt: service.stopped_at });
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
  const apagado = status.kind === 'stopped' || status.kind === 'none';

  return (
    <button
      onClick={onClick}
      className={cx(
        'group relative rounded-xl border p-4 text-left',
        selected
          ? 'lit lit-bajo border-acc bg-surface2'
          : cx(
              'card-hover lit lit-bajo bg-surface',
              /*
               * El borde de color se reserva para lo que hay que encontrar de un
               * vistazo en una rejilla de veinte tarjetas: lo caído y lo que
               * tiene alertas. Un servicio parado adrede no pide atención, así
               * que va con el borde de siempre y la chapa en gris.
               */
              status.kind === 'down' || alertCount > 0
                ? 'border-err/40'
                : status.tone === 'warn'
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
          {/* Un servicio parado se apaga también en el logo: la rejilla dice
              de un barrido qué está en pie sin leer ninguna chapa. */}
          <ModuleChip kind={moduleKind(service)} size={36} className={cx(apagado && 'opacity-55 saturate-50')} />
          <div className="min-w-0">
            <h3 className={cx('truncate text-sm font-semibold', apagado ? 'text-sub' : 'text-txt')}>{service.name}</h3>
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
            pill
            tone={status.tone}
            label={status.label}
            pulse={status.pulse}
            title={status.detail}
            replicas={metrics?.replicas}
          />
        </div>
      </div>

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
                    className={cx('h-full rounded-full transition-[width] duration-[--dur-3]', cpuEnAviso ? 'bg-warn' : 'bg-acc-soft/70')}
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
          /* Sin métricas no es un misterio: el hueco dice por qué. */
          <span className="col-span-2 text-subtle">
            {status.kind === 'stopped'
              ? status.detail
                ? `Detenido · ${status.detail}`
                : 'Detenido · no consume recursos'
              : status.kind === 'down'
                ? status.detail
                  ? `Se paró solo · ${status.detail}`
                  : 'Se paró solo'
                : state === 'not_created'
                  ? 'Todavía sin desplegar'
                  : 'Sin métricas'}
          </span>
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
