/**
 * Enlace público y permanente de pago de una factura: `/pagar/<token>`.
 *
 * El correo de la factura lleva este enlace y no la sesión de Stripe Checkout,
 * que caduca a las 24 h. Al abrirlo, `routes/paylink.ts` reutiliza la sesión
 * abierta o crea otra (la misma lógica que «Cobrar» en el panel) y redirige a
 * Stripe; si la factura ya está pagada o anulada, enseña una página que lo dice.
 * Así el cliente puede pagar desde el correo cuando quiera, sin cuenta en el panel.
 *
 * El token es una credencial al portador y no se guarda en claro. Como con los
 * tokens de API, la base solo tiene su hash SHA-256, que es por lo que se busca.
 * A diferencia de ellos, el servidor puede volver a calcularlo: es el HMAC de un
 * secreto propio (`settings.payLinkKey`) con el id de la factura y un nonce
 * aleatorio de esa factura. Hace falta para que el reenvío del correo y el panel
 * den el MISMO enlace que el primer envío: si cada envío generase uno nuevo, el
 * enlace del correo anterior dejaría de funcionar y ya no sería permanente.
 *
 * Revocar es borrar la fila: el enlace deja de valer y el próximo uso crea otro.
 * Rotar es cambiar el nonce: el anterior deja de valer y el nuevo se calcula
 * igual. Se rota al anular la factura.
 */
import crypto from 'crypto';
import { deleteInvoicePayLink, getInvoiceByPayTokenHash, getInvoicePayLink, getSetting, setInvoicePayLink, setSetting } from './db';
import { isLocalOrIpHost, primaryPanelDomain } from './paneldomain';
import { InvoiceRow } from './types';
import { hmacSha256, randomToken, safeEqual } from './util';

const CLAVE_SETTING = 'payLinkKey';

/** Forma exacta del token (HMAC-SHA256 en hexadecimal): lo que no encaja ni se busca. */
const TOKEN_RE = /^[a-f0-9]{64}$/;

let claveCache: string | null = null;

/**
 * Secreto con el que se calculan los tokens. Propio y no el de las sesiones:
 * rotar el de las sesiones (cerrar todas) no debe matar los enlaces ya enviados.
 */
function claveEnlaces(): string {
  if (claveCache) return claveCache;
  let clave = getSetting(CLAVE_SETTING);
  if (!clave) {
    clave = randomToken(32);
    setSetting(CLAVE_SETTING, clave);
  }
  claveCache = clave;
  return clave;
}

function derivar(invoiceId: string, nonce: string): string {
  // Con prefijo propio: un HMAC calculado con este secreto para otro fin no
  // puede coincidir nunca con un token de pago.
  return hmacSha256(claveEnlaces(), `skyway:enlace-pago:v1:${invoiceId}:${nonce}`);
}

export function hashTokenPago(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Crea un enlace nuevo para la factura; si tenía otro, deja de valer en el acto. */
function nuevoToken(invoiceId: string): string {
  const nonce = randomToken(16);
  const token = derivar(invoiceId, nonce);
  setInvoicePayLink(invoiceId, hashTokenPago(token), nonce);
  return token;
}

/** Token vigente de la factura, o null si no tiene enlace. */
export function tokenPagoVigente(invoiceId: string): string | null {
  const fila = getInvoicePayLink(invoiceId);
  if (!fila) return null;
  const token = derivar(invoiceId, fila.nonce);
  // Si el secreto ya no es el que calculó el enlace (se borró de `settings`), el
  // hash guardado sigue abriendo el enlace enviado, pero no hay forma de
  // reproducirlo: se trata como si no hubiera enlace y el siguiente uso lo rota.
  return safeEqual(hashTokenPago(token), fila.token_hash) ? token : null;
}

/**
 * Token de la factura, creándolo si no tiene. Un borrador nunca tiene enlace:
 * abrirlo lo emitiría (alta antes del cobro), y bastaría con que la vista previa
 * de un chat o el antivirus de un correo siguiera el enlace para numerar una
 * factura que el operador aún está preparando.
 */
export function asegurarTokenPago(inv: InvoiceRow): { token: string; creado: boolean } | null {
  if (inv.status === 'draft') return null;
  const vigente = tokenPagoVigente(inv.id);
  if (vigente) return { token: vigente, creado: false };
  return { token: nuevoToken(inv.id), creado: true };
}

/** Rota el enlace si la factura tiene uno: el anterior deja de funcionar. */
export function rotarTokenPago(invoiceId: string): boolean {
  if (!getInvoicePayLink(invoiceId)) return false;
  nuevoToken(invoiceId);
  return true;
}

/** Revoca el enlace: deja de funcionar y el próximo envío lleva uno nuevo. */
export function revocarTokenPago(invoiceId: string): boolean {
  return deleteInvoicePayLink(invoiceId);
}

/**
 * Factura a la que da acceso un token. Se busca solo por el hash exacto: nunca
 * por id ni por prefijo, así que un token no lleva a ninguna otra factura.
 */
export function facturaPorTokenPago(token: string): InvoiceRow | undefined {
  // El token es hexadecimal: normalizar las mayúsculas no abre nada nuevo.
  const t = token.toLowerCase();
  if (!TOKEN_RE.test(t)) return undefined;
  return getInvoiceByPayTokenHash(hashTokenPago(t));
}

/**
 * Raíz pública para el enlace que se envía al cliente: `https://SKYWAY_DOMAIN`
 * o, sin él, el dominio por el que se usa el panel. Un túnel (`localhost`) o una
 * IP no sirven, porque el cliente no los puede abrir: entonces no hay enlace
 * (null). La facturación automática no tiene petición y solo usa el dominio.
 */
export function baseUrlPublica(req?: { protocol: string; host: string }): string | null {
  const dominio = primaryPanelDomain();
  if (dominio) return `https://${dominio}`;
  if (req?.host && !isLocalOrIpHost(req.host)) return `${req.protocol}://${req.host}`;
  return null;
}

export function urlEnlacePago(base: string, token: string): string {
  return `${base.replace(/\/+$/, '')}/pagar/${token}`;
}
