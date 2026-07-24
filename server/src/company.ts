/**
 * Perfil fiscal de la empresa emisora (nosotros) y claves de Stripe. Se guardan
 * en `settings`; las claves secretas nunca se devuelven por la API (se exponen
 * como booleanos, igual que el token de GitHub).
 */
import { getSetting, setSetting } from './db';
import { BillingProfile } from './types';

export const DEFAULT_PROFILE: BillingProfile = {
  companyName: '',
  taxId: '',
  address: '',
  email: '',
  phone: '',
  currency: 'EUR',
  vatRate: 21,
  invoicePrefix: 'FRA',
  paymentTermsDays: 30,
  defaultIrpfRate: 0,
  sifMode: 'no_verifactu',
  iban: '',
  bic: '',
  bankName: '',
  footer: '',
};

export function getBillingProfile(): BillingProfile {
  const raw = getSetting('billingProfile');
  if (!raw) return { ...DEFAULT_PROFILE };
  try {
    return { ...DEFAULT_PROFILE, ...(JSON.parse(raw) as Partial<BillingProfile>) };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

export function setBillingProfile(profile: BillingProfile): void {
  setSetting('billingProfile', JSON.stringify(profile));
}

export function getStripeSecretKey(): string | null {
  return getSetting('stripeSecretKey');
}

export function getStripeWebhookSecret(): string | null {
  return getSetting('stripeWebhookSecret');
}

export function getStripePublishableKey(): string | null {
  return getSetting('stripePublishableKey');
}

/**
 * Servidor de correo saliente para enviar la factura al cliente. Como las claves
 * de Stripe, vive en `settings` y la contraseña nunca se devuelve por la API (se
 * expone como booleano). Sin `host` o sin `from` no hay envío: es opcional.
 */
export interface SmtpSettings {
  host: string;
  port: number;
  /** true = TLS directo (465); false = texto plano con STARTTLS (587/25). */
  secure: boolean;
  user: string;
  pass: string;
  /** Dirección remitente. Debe ser una que el servidor autorice. */
  from: string;
  fromName: string;
}

export function getSmtpSettings(): SmtpSettings | null {
  const host = getSetting('smtpHost');
  const from = getSetting('smtpFrom');
  if (!host || !from) return null;
  const port = parseInt(getSetting('smtpPort') ?? '', 10);
  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 587,
    secure: getSetting('smtpSecure') === '1',
    user: getSetting('smtpUser') ?? '',
    pass: getSetting('smtpPass') ?? '',
    from,
    fromName: getSetting('smtpFromName') ?? '',
  };
}

export function setSmtpSettings(patch: Partial<SmtpSettings>): void {
  if (patch.host !== undefined) setSetting('smtpHost', patch.host || null);
  if (patch.port !== undefined) setSetting('smtpPort', String(patch.port));
  if (patch.secure !== undefined) setSetting('smtpSecure', patch.secure ? '1' : '0');
  if (patch.user !== undefined) setSetting('smtpUser', patch.user || null);
  if (patch.pass !== undefined) setSetting('smtpPass', patch.pass || null);
  if (patch.from !== undefined) setSetting('smtpFrom', patch.from || null);
  if (patch.fromName !== undefined) setSetting('smtpFromName', patch.fromName || null);
}
