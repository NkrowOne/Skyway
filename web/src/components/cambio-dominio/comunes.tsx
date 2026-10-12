import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, CircleDashed, Info, Loader2 } from 'lucide-react';
import { textoWebhook, WebhookEnRiesgo } from '../../cambioDominio';
import { cx } from '../../utils';
import { Button } from '../ui';

/** Las cuatro fases del asistente, en el orden en que se recorren. */
const PASOS = ['Qué cambia', 'Preparar', 'En transición', 'Terminado'] as const;

/**
 * Dónde está el cambio. Sin barras de progreso ni porcentajes: cuatro rótulos,
 * el actual marcado, para que quien vuelve al asistente sepa en qué punto se
 * quedó.
 */
export function Pasos({ actual }: { actual: 0 | 1 | 2 | 3 }) {
  return (
    <ol className="mb-5 grid grid-cols-4 gap-1.5" aria-label="Fases del cambio de dominio">
      {PASOS.map((p, i) => (
        <li key={p} aria-current={i === actual ? 'step' : undefined} className="min-w-0">
          <span className={cx('block h-1 rounded-full', i < actual ? 'bg-acc/60' : i === actual ? 'bg-acc' : 'bg-line')} />
          <span className={cx('mt-1.5 block truncate text-xs', i === actual ? 'font-semibold text-txt' : 'text-subtle')}>
            {i + 1}. {p}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Línea plegable de un resumen («Web: 3 nombres pasan a…», «Revisar»). */
export function Desplegable({
  titulo,
  detalle,
  tono = 'neutral',
  children,
  abiertoInicial = false,
}: {
  titulo: React.ReactNode;
  detalle?: React.ReactNode;
  tono?: 'neutral' | 'err';
  children?: React.ReactNode;
  abiertoInicial?: boolean;
}) {
  const [abierto, setAbierto] = useState(abiertoInicial);
  const plegable = !!children;
  return (
    <div className={cx('rounded-lg border bg-bg', tono === 'err' ? 'border-err/40' : 'border-line')}>
      <button
        type="button"
        disabled={!plegable}
        onClick={() => setAbierto((a) => !a)}
        aria-expanded={plegable ? abierto : undefined}
        className="flex w-full min-w-0 items-center gap-2 px-3.5 py-2.5 text-left disabled:cursor-default"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-txt">{titulo}</span>
          {detalle && <span className="mt-0.5 block text-xs leading-5 text-subtle">{detalle}</span>}
        </span>
        {plegable && (
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-acc-soft">
            {abierto ? 'Ocultar' : 'Revisar'}
            <ChevronDown size={14} className={cx('transition-transform', abierto && 'rotate-180')} aria-hidden />
          </span>
        )}
      </button>
      {plegable && abierto && <div className="border-t border-line px-3.5 py-3">{children}</div>}
    </div>
  );
}

/** Caja de aviso: `err` para lo que impide seguir, `warn` para lo que conviene leer, `info` para el contexto. */
export function Aviso({ tono, children, className }: { tono: 'err' | 'warn' | 'info'; children: React.ReactNode; className?: string }) {
  const Icono = tono === 'info' ? Info : AlertTriangle;
  return (
    <div
      role={tono === 'err' ? 'alert' : undefined}
      className={cx(
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5',
        tono === 'err' && 'border-err/30 bg-err/[.07] text-txt',
        tono === 'warn' && 'border-warn/30 bg-warn/[.07] text-sub',
        tono === 'info' && 'border-line bg-bg text-sub',
        className,
      )}
    >
      <Icono size={14} className={cx('mt-0.5 shrink-0', tono === 'err' ? 'text-err' : tono === 'warn' ? 'text-warn' : 'text-subtle')} aria-hidden />
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

/** Lista de avisos (sin repetidos). */
export function Avisos({ avisos, tono = 'warn' }: { avisos: string[]; tono?: 'err' | 'warn' | 'info' }) {
  const unicos = [...new Set(avisos)];
  if (unicos.length === 0) return null;
  return (
    <Aviso tono={tono}>
      {unicos.length === 1 ? (
        unicos[0]
      ) : (
        <ul className="list-disc space-y-1 pl-4">
          {unicos.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}
    </Aviso>
  );
}

/** Una condición con su estado: hecha, pendiente o en curso. */
export function Condicion({
  estado,
  titulo,
  detalle,
}: {
  estado: 'ok' | 'pendiente' | 'en_curso' | 'aviso';
  titulo: React.ReactNode;
  detalle?: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-2.5 py-1.5">
      {estado === 'ok' ? (
        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" aria-label="Hecho" />
      ) : estado === 'en_curso' ? (
        <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-acc-soft" aria-label="En curso" />
      ) : estado === 'aviso' ? (
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" aria-label="Aviso" />
      ) : (
        <CircleDashed size={16} className="mt-0.5 shrink-0 text-subtle" aria-label="Pendiente" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm text-txt">{titulo}</span>
        {detalle && <span className="mt-0.5 block break-words text-xs leading-5 text-subtle">{detalle}</span>}
      </span>
    </li>
  );
}

/** Bloque con rótulo dentro de una fase. */
export function Bloque({ titulo, acciones, children }: { titulo: string; acciones?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle">{titulo}</h3>
        {acciones && <div className="flex flex-wrap items-center gap-1.5">{acciones}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * Un aviso por servicio con webhooks en nombres que redirigen (o redirigirán)
 * al pasar, con «Servir también»: el webhook registrado con la URL anterior no
 * sigue la redirección. `pasada`: el cambio ya ha pasado.
 */
export function AvisosWebhooks({
  webhooks,
  pasada = false,
  onServir,
  ocupado = null,
  deshabilitado = false,
}: {
  webhooks: WebhookEnRiesgo[];
  pasada?: boolean;
  onServir?: (w: WebhookEnRiesgo) => void;
  /** Servicio cuyo «Servir también» está en curso. */
  ocupado?: string | null;
  deshabilitado?: boolean;
}) {
  if (webhooks.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {webhooks.map((w) => (
        <Aviso key={w.serviceId} tono="warn">
          <p>{textoWebhook(w, pasada)}</p>
          {w.evidencias.length > 0 && (
            <p className="mt-0.5 break-words text-subtle">
              Detectado por <span className="font-mono">{w.evidencias.join(', ')}</span>.
            </p>
          )}
          {onServir && (
            <div className="mt-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onServir(w)}
                loading={ocupado === w.serviceId}
                disabled={deshabilitado || (!!ocupado && ocupado !== w.serviceId)}
              >
                Servir también
              </Button>
            </div>
          )}
        </Aviso>
      ))}
    </div>
  );
}
