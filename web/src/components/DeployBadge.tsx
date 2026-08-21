import { cx } from '../utils';

/**
 * Cinta indeterminada para el borde superior de una tarjeta: la señal de «aquí
 * está pasando algo» sin ocupar sitio ni meter un recuadro dentro de otro.
 * La pintan la tarjeta de servicio y la de proyecto del panel general, así que
 * vive aparte para que sea literalmente la misma en los dos.
 *
 * Va inset a los lados para no pisar las esquinas redondeadas del borde.
 */
export function DeploySweep({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx('deploy-sweep pointer-events-none absolute inset-x-2.5 -top-px h-[2px] rounded-full', className)}
    />
  );
}
