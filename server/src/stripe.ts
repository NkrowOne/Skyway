/**
 * Cliente mínimo de Stripe para cobrar facturas: crea una Checkout Session de
 * pago único y verifica la firma de los webhooks. Sin dependencias: usa la API
 * REST de Stripe con `fetch` (form-urlencoded, como espera Stripe).
 *
 * Todo es opcional: si no hay clave configurada, la ruta lo indica y sigue
 * ofreciéndose la transferencia bancaria. Nunca se registran las claves.
 */
import { hmacSha256, safeEqual } from './util';

const STRIPE_API = 'https://api.stripe.com/v1';

export class StripeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeError';
  }
}

export interface StripeCheckoutOpts {
  amountCents: number;
  currency: string;
  invoiceNumber: string;
  invoiceId: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string | null;
}

/** Crea una Checkout Session de pago único para una factura. Devuelve {id, url}. */
export async function createStripeCheckout(secretKey: string, opts: StripeCheckoutOpts): Promise<{ id: string; url: string }> {
  if (!secretKey) throw new StripeError('No hay ninguna clave secreta de Stripe configurada.');
  if (opts.amountCents <= 0) throw new StripeError('La factura no tiene importe a cobrar.');
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', opts.successUrl);
  params.set('cancel_url', opts.cancelUrl);
  params.set('client_reference_id', opts.invoiceId);
  params.set('metadata[invoiceId]', opts.invoiceId);
  params.set('line_items[0][quantity]', '1');
  params.set('line_items[0][price_data][currency]', opts.currency.toLowerCase());
  params.set('line_items[0][price_data][unit_amount]', String(Math.round(opts.amountCents)));
  params.set('line_items[0][price_data][product_data][name]', `Factura ${opts.invoiceNumber}`);
  if (opts.customerEmail) params.set('customer_email', opts.customerEmail);

  let res: Response;
  try {
    res = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    throw new StripeError(`No se pudo conectar con Stripe: ${err?.message || 'error de red'}`);
  }
  const body: any = await res.json().catch(() => ({}));
  if (res.status === 401) throw new StripeError('Stripe rechazó la clave secreta (401).');
  if (!res.ok) throw new StripeError(body?.error?.message || `Stripe respondió HTTP ${res.status}`);
  if (!body?.id || !body?.url) throw new StripeError('Stripe no devolvió una sesión de pago válida.');
  return { id: body.id, url: body.url };
}

/**
 * Verifica la firma de un webhook de Stripe (cabecera `Stripe-Signature`, formato
 * `t=<ts>,v1=<hmac>`): HMAC-SHA256 de `${t}.${rawBody}` con el secreto del
 * endpoint, comparado en tiempo constante, y con tolerancia de tiempo (anti-replay).
 */
export function verifyStripeSignature(
  rawBody: string,
  sigHeader: string | undefined,
  secret: string,
  toleranceSec = 300,
): boolean {
  if (!sigHeader || !secret) return false;
  const parts: Record<string, string> = {};
  for (const seg of sigHeader.split(',')) {
    const i = seg.indexOf('=');
    if (i > 0) parts[seg.slice(0, i).trim()] = seg.slice(i + 1).trim();
  }
  const t = parts['t'];
  const v1 = parts['v1'];
  if (!t || !v1) return false;
  const ts = parseInt(t, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
  const expected = hmacSha256(secret, `${t}.${rawBody}`);
  return safeEqual(v1, expected);
}
