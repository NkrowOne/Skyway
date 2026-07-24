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
