/**
 * Ajustes de automatización de facturación. Se guardan en `settings` como claves
 * `billing.*` sueltas (leídas también por `billingauto.ts`). Fuente única para el
 * scheduler y para el endpoint de configuración, con valores por defecto seguros:
 * se genera el borrador automáticamente, pero NO se emite sin intervención humana.
 */
import { getSetting, setSetting } from './db';

export interface BillingAutomation {
  /** Generar el borrador del ciclo en el día de facturación de cada cuenta. */
  autoGenerate: boolean;
  /** Emitir (numerar y bloquear) el borrador generado. Acto legal: opt-in. */
  autoIssue: boolean;
  /** Días de impago (desde el vencimiento) para suspender el servicio. */
  dunningGraceDays: number;
  /** Días de impago (desde el vencimiento) para cancelar la cuenta. */
  dunningCancelDays: number;
  /** Enviar la factura en PDF al cliente por email al emitirla. Requiere SMTP. */
  emailOnIssue: boolean;
}

export const DEFAULT_AUTOMATION: BillingAutomation = {
  autoGenerate: true,
  autoIssue: false,
  dunningGraceDays: 14,
  dunningCancelDays: 44,
  emailOnIssue: false,
};

/** Lee un booleano de settings admitiendo «1»/«true»; ausente = valor por defecto. */
function boolSetting(key: string, fallback: boolean): boolean {
  const v = getSetting(key);
  if (v === null) return fallback;
  return v === '1' || v === 'true';
}

/** Lee un entero de settings admitiendo el 0; ausente/no numérico = valor por defecto. */
function intSetting(key: string, fallback: number): number {
  const n = parseInt(getSetting(key) ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export function getBillingAutomation(): BillingAutomation {
  return {
    autoGenerate: boolSetting('billing.autoGenerate', DEFAULT_AUTOMATION.autoGenerate),
    autoIssue: boolSetting('billing.autoIssue', DEFAULT_AUTOMATION.autoIssue),
    dunningGraceDays: intSetting('billing.dunningGraceDays', DEFAULT_AUTOMATION.dunningGraceDays),
    dunningCancelDays: intSetting('billing.dunningCancelDays', DEFAULT_AUTOMATION.dunningCancelDays),
    emailOnIssue: boolSetting('billing.emailOnIssue', DEFAULT_AUTOMATION.emailOnIssue),
  };
}

export function setBillingAutomation(patch: Partial<BillingAutomation>): BillingAutomation {
  if (patch.autoGenerate !== undefined) setSetting('billing.autoGenerate', patch.autoGenerate ? '1' : '0');
  if (patch.autoIssue !== undefined) setSetting('billing.autoIssue', patch.autoIssue ? '1' : '0');
  if (patch.dunningGraceDays !== undefined) setSetting('billing.dunningGraceDays', String(patch.dunningGraceDays));
  if (patch.dunningCancelDays !== undefined) setSetting('billing.dunningCancelDays', String(patch.dunningCancelDays));
  if (patch.emailOnIssue !== undefined) setSetting('billing.emailOnIssue', patch.emailOnIssue ? '1' : '0');
  return getBillingAutomation();
}
