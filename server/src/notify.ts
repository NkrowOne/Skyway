import { getSetting } from './db';
import { AlertSeverity } from './types';

export interface OutgoingAlert {
  severity: AlertSeverity;
  title: string;
  message: string;
  explanation?: string | null;
  project?: string | null;
  service?: string | null;
}

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  critical: '🔴',
  warning: '🟡',
  info: '🔵',
};

function timeout(): AbortSignal {
  return AbortSignal.timeout(6000);
}

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: timeout(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/**
 * Envía la alerta a todos los canales configurados (best-effort).
 * Devuelve la lista de canales que fallaron, para poder informar en la UI.
 */
export async function dispatchToChannels(alert: OutgoingAlert): Promise<string[]> {
  const failures: string[] = [];
  const context = [alert.project, alert.service].filter(Boolean).join(' / ');
  const text = `${SEVERITY_EMOJI[alert.severity]} [Skyway] ${alert.title}${context ? ` — ${context}` : ''}\n${alert.message}${alert.explanation ? `\n\n${alert.explanation}` : ''}`;

  const generic = getSetting('alertWebhookUrl');
  if (generic) {
    try {
      await post(generic, {
        source: 'skyway',
        severity: alert.severity,
        title: alert.title,
        message: alert.message,
        explanation: alert.explanation ?? null,
        project: alert.project ?? null,
        service: alert.service ?? null,
        ts: Date.now(),
      });
    } catch {
      failures.push('webhook');
    }
  }

  const discord = getSetting('alertDiscordUrl');
  if (discord) {
    try {
      await post(discord, { content: text.slice(0, 1900) });
    } catch {
      failures.push('discord');
    }
  }

  const tgToken = getSetting('alertTelegramToken');
  const tgChat = getSetting('alertTelegramChat');
  if (tgToken && tgChat) {
    try {
      await post(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        chat_id: tgChat,
        text: text.slice(0, 4000),
      });
    } catch {
      failures.push('telegram');
    }
  }

  return failures;
}

export function channelsConfigured(): string[] {
  const list: string[] = [];
  if (getSetting('alertWebhookUrl')) list.push('webhook');
  if (getSetting('alertDiscordUrl')) list.push('discord');
  if (getSetting('alertTelegramToken') && getSetting('alertTelegramChat')) list.push('telegram');
  return list;
}
