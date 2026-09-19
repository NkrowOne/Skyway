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

/** Canal que falló y el motivo (sin URLs ni tokens: solo estado HTTP o código de red). */
export interface ChannelFailure {
  channel: string;
  error: string;
}

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  critical: '🔴',
  warning: '🟡',
  info: '🔵',
};

const TIMEOUT_MS = 6000;

/**
 * POST JSON con timeout. Consume SIEMPRE el cuerpo de la respuesta: undici
 * reserva la conexión del pool hasta que el cuerpo se lee o se cancela, y un
 * cuerpo abandonado la dejaba pinzada (con Telegram, que responde por keep-alive,
 * acababan agotándose). El texto leído sirve además para explicar un error HTTP.
 */
async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const detalle = await res.text().catch(() => {
    void res.body?.cancel().catch(() => undefined);
    return '';
  });
  if (!res.ok) {
    const resumen = detalle.replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error(`HTTP ${res.status}${resumen ? `: ${resumen}` : ''}`);
  }
}

/**
 * Describe un fallo de red sin filtrar la URL (la de Telegram lleva el token):
 * el mensaje de undici es genérico («fetch failed») y el código útil va en `cause`.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: unknown } }).cause;
    const code = typeof cause?.code === 'string' ? cause.code : err.name === 'TimeoutError' ? `timeout ${TIMEOUT_MS} ms` : null;
    return code ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}

/**
 * Envía la alerta a todos los canales configurados (best-effort) y devuelve los
 * que fallaron con su motivo. Los envíos van EN PARALELO: en serie, tres canales
 * con 6 s de timeout cada uno retenían al llamante hasta 18 s.
 */
export async function dispatchToChannelsDetailed(alert: OutgoingAlert): Promise<ChannelFailure[]> {
  const context = [alert.project, alert.service].filter(Boolean).join(' / ');
  const text = `${SEVERITY_EMOJI[alert.severity]} [Skyway] ${alert.title}${context ? ` — ${context}` : ''}\n${alert.message}${alert.explanation ? `\n\n${alert.explanation}` : ''}`;

  const envios: { channel: string; run: () => Promise<void> }[] = [];

  const generic = getSetting('alertWebhookUrl');
  if (generic) {
    envios.push({
      channel: 'webhook',
      run: () =>
        post(generic, {
          source: 'skyway',
          severity: alert.severity,
          title: alert.title,
          message: alert.message,
          explanation: alert.explanation ?? null,
          project: alert.project ?? null,
          service: alert.service ?? null,
          ts: Date.now(),
        }),
    });
  }

  const discord = getSetting('alertDiscordUrl');
  if (discord) {
    envios.push({ channel: 'discord', run: () => post(discord, { content: text.slice(0, 1900) }) });
  }

  const tgToken = getSetting('alertTelegramToken');
  const tgChat = getSetting('alertTelegramChat');
  if (tgToken && tgChat) {
    envios.push({
      channel: 'telegram',
      run: () => post(`https://api.telegram.org/bot${tgToken}/sendMessage`, { chat_id: tgChat, text: text.slice(0, 4000) }),
    });
  }

  const resultados = await Promise.allSettled(envios.map((e) => e.run()));
  const failures: ChannelFailure[] = [];
  resultados.forEach((r, i) => {
    if (r.status === 'rejected') failures.push({ channel: envios[i].channel, error: describeError(r.reason) });
  });
  return failures;
}

/**
 * Igual que `dispatchToChannelsDetailed`, pero devuelve solo los nombres de los
 * canales que fallaron (lo que muestra la UI de ajustes).
 */
export async function dispatchToChannels(alert: OutgoingAlert): Promise<string[]> {
  return (await dispatchToChannelsDetailed(alert)).map((f) => f.channel);
}

export function channelsConfigured(): string[] {
  const list: string[] = [];
  if (getSetting('alertWebhookUrl')) list.push('webhook');
  if (getSetting('alertDiscordUrl')) list.push('discord');
  if (getSetting('alertTelegramToken') && getSetting('alertTelegramChat')) list.push('telegram');
  return list;
}
