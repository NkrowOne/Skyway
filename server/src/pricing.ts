/**
 * Cálculo de precios por tramos para los productos del catálogo con
 * `billing_model='tiered'`. Dos modos:
 *  - `graduated`: cada tramo tarifa solo la porción de cantidad que cae en él.
 *  - `volume`: toda la cantidad se tarifa al precio del tramo en el que cae el total.
 * Todo en céntimos enteros; el redondeo vive aquí y se documenta.
 */
import { PriceTierRow } from './types';

export function priceTiers(tiers: PriceTierRow[], qty: number, mode: 'graduated' | 'volume'): number {
  if (tiers.length === 0 || qty <= 0) return 0;
  const sorted = [...tiers].sort((a, b) => a.sort - b.sort);
  if (mode === 'volume') {
    const tier = sorted.find((t) => t.up_to === null || qty <= t.up_to) ?? sorted[sorted.length - 1];
    return Math.round(qty * tier.unit_cents) + tier.flat_cents;
  }
  // graduated
  let remaining = qty;
  let prev = 0;
  let total = 0;
  for (const t of sorted) {
    const cap = t.up_to === null ? Infinity : t.up_to;
    const span = Math.max(0, Math.min(remaining, cap - prev));
    if (span > 0) {
      total += Math.round(span * t.unit_cents) + t.flat_cents;
      remaining -= span;
    }
    prev = cap;
    if (remaining <= 0) break;
  }
  // Si el último tramo tiene tope finito y la cantidad lo supera, el excedente se
  // cobra al precio del último tramo (no se factura gratis por un hueco de config).
  if (remaining > 0) total += Math.round(remaining * sorted[sorted.length - 1].unit_cents);
  return total;
}
