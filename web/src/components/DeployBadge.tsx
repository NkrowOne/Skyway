import { Hammer, ListStart, Rocket } from 'lucide-react';
import { ActiveDeploy } from '../types';
import { cx, DEPLOY_STATUS_LABEL, DEPLOY_TRIGGER_LABEL } from '../utils';

/**
 * Señales compartidas de «hay una versión nueva saliendo». Viven aparte de
 * ServiceCard porque las pinta también la cabecera del proyecto y el panel del
 * servicio: el aviso tiene que ser el mismo en los tres sitios o deja de leerse
 * como un único estado.
 */

const PHASE_ICON: Record<string, typeof Rocket> = {
  queued: ListStart,
  building: Hammer,
  deploying: Rocket,
};

/**
 * Cinta indeterminada para el borde superior de una tarjeta. Va inset a los
 * lados para no pisar las esquinas redondeadas del borde.
 */
export function DeploySweep({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx('deploy-sweep pointer-events-none absolute inset-x-2.5 -top-px h-[2px] rounded-full', className)}
    />
  );
}

/** Fase + commit del despliegue vivo, en una línea. */
export function DeployLine({ deploy, className }: { deploy: ActiveDeploy; className?: string }) {
  const Icon = PHASE_ICON[deploy.status] ?? Rocket;
  const detail = deploy.commitMsg || (deploy.commitSha ? deploy.commitSha.slice(0, 7) : null);
  return (
    <span className={cx('flex min-w-0 items-center gap-1.5 text-[11px] leading-4', className)}>
      <Icon size={11} className="shrink-0 text-warn" />
      <span className="shrink-0 font-medium text-warn">{DEPLOY_STATUS_LABEL[deploy.status]}</span>
      <span className="min-w-0 truncate text-subtle">
        · {DEPLOY_TRIGGER_LABEL[deploy.trigger] ?? deploy.trigger}
        {detail && ` · ${detail}`}
      </span>
    </span>
  );
}

/** La misma línea dentro de su franja ámbar, para meterla en una tarjeta. */
export function DeployBanner({ deploy, className }: { deploy: ActiveDeploy; className?: string }) {
  return (
    <div
      className={cx(
        'flex items-center gap-2 overflow-hidden rounded-lg border border-warn/25 bg-warn/[.07] px-2 py-1.5',
        className,
      )}
    >
      <DeployLine deploy={deploy} />
    </div>
  );
}
