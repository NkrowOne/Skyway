/**
 * Gateway de IA: configuración y medición. Skyway actúa de proxy multiplexado
 * ante Gemini (Google): guarda UNA clave de proyecto del operador (en `settings`,
 * nunca devuelta ni registrada) y emite una clave `skai_…` por cliente que abre
 * solo el proxy. Tras cada respuesta lee `usageMetadata` y registra el consumo en
 * la tubería de medición existente, de modo que se factura con el catálogo por uso.
 */
import { getProduct, getSetting, ingestUsageEvent, listActiveSubscriptions, listTiers, setSetting } from './db';

/** Prefijo de las claves de cliente. NO empieza por `sky_`: así nunca se resuelve como token de panel. */
export const PROXY_KEY_PREFIX = 'skai_';

/** Host por defecto de la Generative Language API (Google AI). Configurable (Vertex/regional/pruebas). */
const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com';

/**
 * Modelos permitidos por defecto (allowlist global del operador). Solo modelos
 * facturados por tokens; los de imagen u otros se dejan fuera a propósito
 * (fail-closed) para no tarifar mal. El operador puede editar la lista.
 */
const DEFAULT_ALLOWED_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
  'gemini-3-flash',
  'gemini-3-pro',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-pro',
];

export function getGeminiApiKey(): string | null {
  return getSetting('ai.geminiApiKey');
}
export function setGeminiApiKey(v: string | null): void {
  setSetting('ai.geminiApiKey', v);
}

export function getGeminiBaseUrl(): string {
  return (getSetting('ai.geminiBaseUrl') || DEFAULT_GEMINI_BASE).replace(/\/+$/, '');
}
export function setGeminiBaseUrl(v: string | null): void {
  setSetting('ai.geminiBaseUrl', v);
}

export function getAllowedModels(): string[] {
  const raw = getSetting('ai.allowedModels');
  if (!raw) return [...DEFAULT_ALLOWED_MODELS];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [...DEFAULT_ALLOWED_MODELS];
  } catch {
    return [...DEFAULT_ALLOWED_MODELS];
  }
}
export function setAllowedModels(models: string[]): void {
  setSetting('ai.allowedModels', JSON.stringify(models));
}

/**
 * ¿Se permite este modelo para esta clave? Fail-closed: debe estar en el
 * allowlist global del operador y, si la clave restringe modelos, también en el suyo.
 */
export function isModelAllowed(model: string, keyAllowed: string[]): boolean {
  const global = getAllowedModels();
  if (!global.includes(model)) return false;
  if (keyAllowed.length > 0 && !keyAllowed.includes(model)) return false;
  return true;
}

export interface TokenBreakdown {
  in: number;
  cacheIn: number;
  out: number;
  total: number;
}

/** Traduce el `usageMetadata` de Gemini a tokens facturables (entrada/cache/salida). */
export function tokensFromUsageMetadata(u: any): TokenBreakdown {
  const prompt = Number(u?.promptTokenCount ?? 0) || 0;
  const cache = Number(u?.cachedContentTokenCount ?? 0) || 0;
  const cand = Number(u?.candidatesTokenCount ?? 0) || 0;
  const thoughts = Number(u?.thoughtsTokenCount ?? 0) || 0;
  return {
    in: Math.max(0, prompt - cache), // entrada normal (la cache se tarifa aparte)
    cacheIn: Math.max(0, cache),
    out: Math.max(0, cand + thoughts), // el «thinking» se factura como salida
    total: Number(u?.totalTokenCount ?? prompt + cand + thoughts) || 0,
  };
}

/**
 * Registra el consumo de una llamada como eventos de uso idempotentes, atribuidos
 * al workspace. La clave de idempotencia deriva del id de respuesta de Google para
 * no doblar el cobro si el gateway reintenta el registro. Se factura después con
 * los productos «metered» del catálogo (ai_tokens_in / ai_tokens_cache_in / ai_tokens_out).
 */
export function recordGeminiUsage(workspaceId: string, model: string, usageMetadata: any, requestId: string, estimated = false): TokenBreakdown {
  const t = tokensFromUsageMetadata(usageMetadata);
  const ts = Date.now();
  const meta = JSON.stringify({ model, estimated, breakdown: t });
  // Prefijo «gw:»: el espacio de nombres de la medición interna está separado del
  // de la ingesta por API (`routes/usage.ts`, prefijo «api:»). El id de respuesta
  // del que deriva la clave lo ve el cliente en el propio flujo SSE, así que sin
  // esta separación podría ocupar la clave con cantidad 0 y anular su consumo.
  const emit = (meter: string, quantity: number) => {
    if (quantity <= 0) return;
    ingestUsageEvent({ idempotencyKey: `gw:gemini:${requestId}:${meter}`, subjectType: 'workspace', subjectId: workspaceId, meter, quantity, productId: null, ts, metadata: meta });
  };
  emit('ai_tokens_in', t.in);
  emit('ai_tokens_cache_in', t.cacheIn);
  emit('ai_tokens_out', t.out);
  ingestUsageEvent({ idempotencyKey: `gw:gemini:${requestId}:req`, subjectType: 'workspace', subjectId: workspaceId, meter: 'ai_requests', quantity: 1, productId: null, ts, metadata: meta });
  return t;
}

// ---------- presupuesto y límite de ritmo (Fase 3) ----------

/** Inicio del ciclo de facturación actual anclado al día del workspace (para el reset del contador). */
export function currentCycleStartMs(billingDay: number): number {
  const now = new Date();
  let start = new Date(now.getFullYear(), now.getMonth(), billingDay);
  if (now < start) start = new Date(now.getFullYear(), now.getMonth() - 1, billingDay);
  return start.getTime();
}

/** Precio unitario y escala del medidor según la suscripción activa del workspace a un producto de ese medidor. */
function meterUnitPrice(workspaceId: string, meter: string): { unitCents: number; unitSize: number } | null {
  for (const sub of listActiveSubscriptions(workspaceId)) {
    const p = getProduct(sub.product_id);
    if (p && p.meter === meter && (p.billing_model === 'metered' || p.billing_model === 'tiered')) {
      if (p.billing_model === 'tiered') {
        const tiers = listTiers(p.id);
        return { unitCents: tiers.length ? tiers[0].unit_cents : p.price_cents, unitSize: p.unit_size };
      }
      return { unitCents: sub.unit_cents ?? p.price_cents, unitSize: p.unit_size };
    }
  }
  return null;
}

/**
 * Coste (en céntimos, CON fracción) que se imputará al cliente por los tokens de
 * una respuesta, según su catálogo. Aproximado para tramos (usa el primer tramo):
 * es guardarraíl del presupuesto, no el importe final de factura.
 */
export function estimateBudgetCostCents(workspaceId: string, b: TokenBreakdown): number {
  const price = (meter: string, tokens: number): number => {
    const pr = meterUnitPrice(workspaceId, meter);
    if (!pr || tokens <= 0) return 0;
    const units = pr.unitSize > 1 ? tokens / pr.unitSize : tokens;
    return units * pr.unitCents;
  };
  return price('ai_tokens_in', b.in) + price('ai_tokens_cache_in', b.cacheIn) + price('ai_tokens_out', b.out);
}

/**
 * Acumula fracciones de céntimo por clave y devuelve los céntimos ENTEROS a
 * persistir. Evita que peticiones de sub-céntimo (p. ej. 0,1 cént.) se pierdan al
 * redondear y nunca alcancen el presupuesto. El resto vive en memoria (aceptable
 * en un guardarraíl: se reinicia con el proceso, sin sobrecontar).
 */
const spendRemainder = new Map<string, number>();
export function accrueSpendCents(keyId: string, costCentsFloat: number): number {
  if (costCentsFloat <= 0) return 0;
  // Redondeo a micro-céntimo para que la suma de fracciones no derive por el error
  // de coma flotante (p. ej. 0,1 × 10 = 1,0 exacto, no 0,999…).
  const acc = Math.round(((spendRemainder.get(keyId) ?? 0) + costCentsFloat) * 1e6) / 1e6;
  const whole = Math.floor(acc);
  spendRemainder.set(keyId, acc - whole);
  return whole;
}

/** Token-bucket en memoria por clave (sin dependencias): limita peticiones por minuto. */
const rateBuckets = new Map<string, { tokens: number; ts: number }>();
export function allowRate(keyId: string, rpm: number | null): boolean {
  if (!rpm || rpm <= 0) return true; // null = sin límite
  const nowMs = Date.now();
  let b = rateBuckets.get(keyId);
  if (!b) {
    b = { tokens: rpm, ts: nowMs };
    rateBuckets.set(keyId, b);
  }
  b.tokens = Math.min(rpm, b.tokens + ((nowMs - b.ts) * rpm) / 60_000);
  b.ts = nowMs;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
