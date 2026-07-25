/**
 * Precios de Gemini autoactualizables. `ai_model_prices` guarda lo que Google nos
 * cobra por modelo; si esa cifra se queda congelada, el margen y el PVP sugerido
 * mienten. Este módulo la refresca con la tarifa vigente y recalcula el PVP con el
 * margen que ya tenga cada modelo (el margen es del operador: nunca se toca).
 *
 * Tres fuentes, por orden: la que configure el operador (un JSON propio), la
 * página oficial de precios de Google y el catálogo interno (con fecha) como red
 * de seguridad sin conexión. Regla dura: **nunca se inventa un precio**. El modelo
 * que no aparece en ninguna fuente se queda exactamente como estaba y se reporta
 * como «sin tarifa». Un precio puesto a mano tampoco se pisa (queda `manual`).
 */
import { auditSystem } from './audit';
import { getSetting, listModelPrices, setModelPrice, setSetting } from './db';
import { getAllowedModels, getGeminiApiKey, getGeminiBaseUrl, setAllowedModels } from './aigateway';

/** Tarifa de lista en USD por millón de tokens. */
export interface ListPrice {
  in: number;
  cache: number;
  out: number;
}

/** Página oficial de la que se leen los precios cuando el operador no fija otra fuente. */
const GOOGLE_PRICING_URL = 'https://ai.google.dev/gemini-api/docs/pricing';
/** Referencia del BCE (sin clave ni registro) para convertir la tarifa a la moneda del operador. */
const FX_URL = 'https://api.frankfurter.app/latest';
const FETCH_TIMEOUT_MS = 15_000;
/** Periodo del refresco automático. Google no cambia la tarifa a diario. */
export const SYNC_INTERVAL_MS = 24 * 3600_000;

/**
 * Catálogo interno de tarifas de lista (USD por millón de tokens), última red de
 * seguridad cuando no hay salida a internet. Solo modelos cuya tarifa está
 * verificada; los que no estén aquí se resuelven por la fuente remota o se dejan
 * en paz. Se marca con fecha porque envejece con cada anuncio de Google.
 */
export const GEMINI_LIST_DATE = '2026-07';
export const GEMINI_LIST_USD: Record<string, ListPrice> = {
  'gemini-3.6-flash': { in: 1.5, cache: 0.15, out: 7.5 },
  'gemini-3.5-flash': { in: 1.5, cache: 0.15, out: 9 },
  'gemini-3.5-flash-lite': { in: 0.3, cache: 0.03, out: 2.5 },
  'gemini-3.1-pro': { in: 2, cache: 0.2, out: 12 },
  'gemini-3.1-pro-preview': { in: 2, cache: 0.2, out: 12 },
  'gemini-3.1-flash-lite': { in: 0.25, cache: 0.025, out: 1.5 },
  'gemini-3-flash': { in: 0.5, cache: 0.05, out: 3 },
  'gemini-3-flash-preview': { in: 0.5, cache: 0.05, out: 3 },
  'gemini-2.5-pro': { in: 1.25, cache: 0.125, out: 10 },
  'gemini-2.5-flash': { in: 0.3, cache: 0.03, out: 2.5 },
  'gemini-2.5-flash-lite': { in: 0.1, cache: 0.01, out: 0.4 },
  'gemini-2.0-flash': { in: 0.1, cache: 0.025, out: 0.4 },
  'gemini-2.0-flash-lite': { in: 0.075, cache: 0, out: 0.3 },
};

// ---------- configuración ----------

export interface PricesConfig {
  /** Refresco automático diario (por defecto, sí). */
  auto: boolean;
  /** Fuente propia (JSON o HTML con el mismo formato que Google). Vacío = página oficial. */
  url: string | null;
  /** Moneda en la que se guarda el coste. Google tarifa en USD. */
  currency: string;
  /** Unidades de `currency` por 1 USD. 1 si la moneda es USD. */
  fxRate: number | null;
  /** Cuándo se obtuvo el cambio (para saber si está rancio). */
  fxAt: number | null;
  /** Margen que se aplica a un modelo que aparece por primera vez. */
  defaultMarginPct: number;
  /** Añadir a la allowlist los modelos nuevos de Google que tengan tarifa conocida. */
  autoAllow: boolean;
}

const S = {
  auto: 'ai.prices.auto',
  url: 'ai.prices.url',
  currency: 'ai.prices.currency',
  fx: 'ai.prices.fx',
  fxAt: 'ai.prices.fxAt',
  margin: 'ai.prices.defaultMarginPct',
  autoAllow: 'ai.prices.autoAllow',
  lastAt: 'ai.prices.lastAt',
  last: 'ai.prices.last',
} as const;

const numOr = (raw: string | null, fallback: number | null): number | null => {
  const n = Number(raw);
  return raw != null && raw !== '' && Number.isFinite(n) ? n : fallback;
};

export function getPricesConfig(): PricesConfig {
  const currency = (getSetting(S.currency) || 'EUR').toUpperCase().slice(0, 3);
  return {
    auto: getSetting(S.auto) !== '0', // por defecto activado
    url: getSetting(S.url),
    currency,
    fxRate: currency === 'USD' ? 1 : numOr(getSetting(S.fx), null),
    fxAt: numOr(getSetting(S.fxAt), null),
    defaultMarginPct: Math.max(0, Math.min(95, numOr(getSetting(S.margin), 0) ?? 0)),
    autoAllow: getSetting(S.autoAllow) === '1',
  };
}

export function setPricesConfig(p: Partial<Omit<PricesConfig, 'fxAt'>>): void {
  if (p.auto !== undefined) setSetting(S.auto, p.auto ? '1' : '0');
  if (p.url !== undefined) setSetting(S.url, p.url || null);
  if (p.currency !== undefined) {
    const next = p.currency.toUpperCase().slice(0, 3);
    // El cambio guardado es de USD a la moneda anterior: al cambiarla se tira,
    // porque aplicarlo a otra divisa falsearía todos los costes de golpe.
    if (next !== (getSetting(S.currency) || 'EUR')) {
      setSetting(S.fx, null);
      setSetting(S.fxAt, null);
    }
    setSetting(S.currency, next || null);
  }
  if (p.defaultMarginPct !== undefined) setSetting(S.margin, String(Math.max(0, Math.min(95, p.defaultMarginPct))));
  if (p.autoAllow !== undefined) setSetting(S.autoAllow, p.autoAllow ? '1' : '0');
  if (p.fxRate !== undefined) {
    // Un cambio puesto a mano se sella con la fecha de hoy: así el aviso de «cambio
    // rancio» cuenta desde que el operador lo fijó, no desde la última descarga.
    setSetting(S.fx, p.fxRate && p.fxRate > 0 ? String(p.fxRate) : null);
    setSetting(S.fxAt, p.fxRate && p.fxRate > 0 ? String(Date.now()) : null);
  }
}

// ---------- lectura de la tarifa ----------

/** Descarga texto con tiempo máximo; devuelve null ante cualquier fallo (es best-effort). */
async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json, text/html;q=0.9', 'User-Agent': 'Skyway/price-sync' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

const stripTags = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** Primer importe en dólares de un texto («$1.25 (prompts ≤ 200k)» → 1.25). */
function firstUsd(text: string): number | null {
  const m = /\$\s*([0-9]+(?:[.,][0-9]+)?)/.exec(text);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  // Cota de cordura: una tarifa por millón de tokens fuera de este rango es un
  // fallo de lectura (o una fila que no era un precio por token).
  return Number.isFinite(n) && n > 0 && n <= 1000 ? n : null;
}

/** Familias que se tarifan por token; lo demás (imagen, TTS, audio nativo, embeddings) no encaja aquí. */
const MODEL_ID_RE = /^gemini-[0-9]+(?:\.[0-9]+)?-(?:pro|flash|flash-lite)$/;

/**
 * Normaliza el identificador de una sección de la página («Gemini 2.5 Flash-Lite»
 * o el propio `id="gemini-2.5-flash-lite"`) al nombre de modelo de la API.
 */
function normalizeModelId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[‐-―]/g, '-') // guiones tipográficos
    .replace(/[^a-z0-9.\- ]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Importe de una fila: se prefiere la última columna (tarifa de pago; la gratuita no lleva importe). */
function rowPrice(cells: string[]): number | null {
  for (let i = cells.length - 1; i >= 1; i--) {
    const v = firstUsd(cells[i]);
    if (v != null) return v;
  }
  return null;
}

/**
 * Lee la tabla de precios de la página de Google: un `<h2 id="gemini-…">` por
 * modelo y, dentro, la PRIMERA tabla, que es la tarifa estándar (las siguientes
 * son variantes —batch, Live API— con otra tarifa o unidad). Es HTML ajeno: ante
 * la mínima duda se descarta la fila y, si no sale nada, se cae al catálogo.
 * De los precios por tramo se toma el primero (contexto corto, texto).
 */
export function parsePricingHtml(html: string): Record<string, ListPrice> {
  const out: Record<string, ListPrice> = {};
  // Modelos cuya tarifa se ha heredado de su sección «preview»: una sección
  // exacta posterior (la versión estable) sí puede sobrescribirlos.
  const inherited = new Set<string>();
  for (const [, attrs, body] of html.matchAll(/<h2\b([^>]*)>([\s\S]*?)(?=<h2\b|$)/gi)) {
    const heading = /\bid="([^"]+)"/i.exec(attrs)?.[1] || /\bdata-text="([^"]+)"/i.exec(attrs)?.[1] || '';
    const id = normalizeModelId(heading);
    // El nombre en la API de una preview lleva el sufijo; se guarda también sin él
    // para cubrir a quien tenga permitido el nombre estable antes de que exista.
    const base = id.replace(/-preview$/, '');
    if (!MODEL_ID_RE.test(base)) continue;
    const end = body.indexOf('</table>');
    if (end < 0) continue;
    const table = body.slice(0, end);

    let inUsd: number | null = null;
    let cacheUsd: number | null = null;
    let outUsd: number | null = null;
    for (const [, rawRow] of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...rawRow.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(([, c]) => stripTags(c));
      if (cells.length < 2) continue;
      const label = cells[0].toLowerCase();
      // El almacenamiento de la caché se cobra por hora, no por token consumido.
      if (/storage|hour|hora|almacenamiento/.test(label)) continue;
      if (/cach/.test(label)) cacheUsd ??= rowPrice(cells);
      else if (/input|entrada/.test(label)) inUsd ??= rowPrice(cells);
      else if (/output|salida/.test(label)) outUsd ??= rowPrice(cells);
    }
    // Entrada y salida son obligatorias: una lectura a medias no es una tarifa.
    if (inUsd == null || outUsd == null) continue;
    const price: ListPrice = { in: inUsd, cache: cacheUsd ?? 0, out: outUsd };
    if (!out[id] || inherited.has(id)) {
      out[id] = price;
      inherited.delete(id);
    }
    if (base !== id && !out[base]) {
      out[base] = price;
      inherited.add(base);
    }
  }
  return out;
}

/** Acepta también una fuente propia en JSON: `{ "gemini-2.5-pro": { "in": 1.25, "cache": 0.31, "out": 10 } }`. */
export function parsePricingJson(raw: string): Record<string, ListPrice> {
  const data = JSON.parse(raw);
  const src = (data && typeof data === 'object' && data.models && typeof data.models === 'object' ? data.models : data) as Record<string, any>;
  const out: Record<string, ListPrice> = {};
  for (const [model, v] of Object.entries(src ?? {})) {
    if (!model || !v || typeof v !== 'object') continue;
    const pick = (n: any) => (Number.isFinite(Number(n)) && Number(n) >= 0 && Number(n) <= 1000 ? Number(n) : null);
    const i = pick(v.in ?? v.input);
    const o = pick(v.out ?? v.output);
    if (i == null || o == null || i <= 0 || o <= 0) continue;
    out[model.trim()] = { in: i, cache: pick(v.cache ?? v.cached) ?? 0, out: o };
  }
  return out;
}

type Source = 'propia' | 'google' | 'catálogo';

/** Tarifa remota (fuente propia o Google). null si no hubo red o no se pudo leer nada. */
async function fetchListPrices(url: string | null): Promise<{ source: Source; prices: Record<string, ListPrice> } | null> {
  const target = url || GOOGLE_PRICING_URL;
  const body = await fetchText(target);
  if (!body) return null;
  const trimmed = body.trimStart();
  let prices: Record<string, ListPrice> = {};
  if (trimmed.startsWith('{')) {
    try {
      prices = parsePricingJson(body);
    } catch {
      return null;
    }
  } else {
    prices = parsePricingHtml(body);
  }
  // La página de Google no siempre se sirve igual (variantes de render). Si de una
  // tabla con decenas de modelos salen dos, la lectura es defectuosa, no una rebaja:
  // se descarta entera y manda el catálogo. La fuente propia sí puede ser mínima.
  const count = Object.keys(prices).length;
  if (!count || (!url && count < 3)) return null;
  return { source: url ? 'propia' : 'google', prices };
}

/**
 * Cambio USD → moneda del operador. Se refresca con la referencia del BCE y, si no
 * hay red, se reutiliza el último conocido (o el que fijó el operador a mano).
 * null = no hay cambio fiable; entonces la sincronización NO se ejecuta, porque
 * guardar dólares como si fueran euros falsearía el margen un 8 %.
 */
async function resolveFxRate(cfg: PricesConfig): Promise<number | null> {
  if (cfg.currency === 'USD') return 1;
  const raw = await fetchText(`${FX_URL}?from=USD&to=${encodeURIComponent(cfg.currency)}`);
  if (raw) {
    try {
      const rate = Number(JSON.parse(raw)?.rates?.[cfg.currency]);
      if (Number.isFinite(rate) && rate > 0.01 && rate < 100) {
        setSetting(S.fx, String(rate));
        setSetting(S.fxAt, String(Date.now()));
        return rate;
      }
    } catch {
      /* respuesta inesperada: se usa el cambio guardado */
    }
  }
  return cfg.fxRate && cfg.fxRate > 0 ? cfg.fxRate : null;
}

/**
 * Modelos que la clave del operador puede usar hoy en Google. Sirve para detectar
 * altas y bajas del catálogo de Gemini sin mirar la web. Best-effort: sin clave o
 * sin red devuelve null (no es un error de sincronización).
 */
async function fetchGoogleModels(): Promise<string[] | null> {
  const key = getGeminiApiKey();
  if (!key) return null;
  try {
    const res = await fetch(`${getGeminiBaseUrl()}/v1beta/models?pageSize=200`, {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    if (!Array.isArray(data?.models)) return null;
    return data.models
      .filter((m: any) => !Array.isArray(m?.supportedGenerationMethods) || m.supportedGenerationMethods.includes('generateContent'))
      .map((m: any) => String(m?.name || '').replace(/^models\//, '').trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

// ---------- sincronización ----------

export interface SyncResult {
  ok: boolean;
  at: number;
  /** De dónde salió la tarifa aplicada. */
  source: Source;
  currency: string;
  fxRate: number | null;
  /** Modelos con coste nuevo (alta) y con coste corregido. */
  added: string[];
  updated: string[];
  /** Ya estaban al día. */
  unchanged: string[];
  /** Coste fijado a mano: no se toca. */
  manual: string[];
  /** Sin tarifa en ninguna fuente: se dejan como estaban. */
  missing: string[];
  /** Modelos que Google ofrece a esta clave y no están en la allowlist. */
  discovered: string[];
  error: string | null;
}

/** Última sincronización (para pintarla en el panel sin volver a llamar a Google). */
export function getSyncState(): { lastAt: number | null; last: SyncResult | null } {
  const lastAt = numOr(getSetting(S.lastAt), null);
  const raw = getSetting(S.last);
  let last: SyncResult | null = null;
  if (raw) {
    try {
      last = JSON.parse(raw) as SyncResult;
    } catch {
      last = null;
    }
  }
  return { lastAt, last };
}

function remember(result: SyncResult): SyncResult {
  setSetting(S.lastAt, String(result.at));
  setSetting(S.last, JSON.stringify(result));
  return result;
}

/**
 * Refresca el coste de cada modelo con la tarifa vigente. Solo toca las filas
 * `auto`: lo que el operador escribió a mano es su decisión y manda sobre la
 * automática (para devolver un modelo al automático, basta con borrar su fila).
 * El margen de cada modelo se conserva, así que el PVP sugerido se recalcula solo.
 */
export async function syncAiModelPrices(trigger: 'manual' | 'auto' = 'manual'): Promise<SyncResult> {
  const cfg = getPricesConfig();
  const at = Date.now();
  const base: SyncResult = {
    ok: false, at, source: 'catálogo', currency: cfg.currency, fxRate: cfg.fxRate,
    added: [], updated: [], unchanged: [], manual: [], missing: [], discovered: [], error: null,
  };

  const remote = await fetchListPrices(cfg.url);
  // El catálogo interno rellena los huecos de una lectura parcial, nunca la pisa.
  const prices: Record<string, ListPrice> = { ...GEMINI_LIST_USD, ...(remote?.prices ?? {}) };
  base.source = remote?.source ?? 'catálogo';

  const fxRate = await resolveFxRate(cfg);
  if (fxRate == null) {
    return remember({
      ...base,
      error: `No se pudo obtener el cambio USD→${cfg.currency} y no hay ninguno guardado. Fíjalo a mano para poder convertir la tarifa de Google.`,
    });
  }
  base.fxRate = fxRate;

  const existing = new Map(listModelPrices().map((r) => [r.model, r]));
  const models = [...new Set([...getAllowedModels(), ...existing.keys()])].sort();
  // USD/Mtok → micro-céntimos/Mtok en la moneda del operador (×100 céntimos, ×1e6 micros).
  const toMicros = (usd: number) => Math.round(usd * fxRate * 100 * 1e6);

  for (const model of models) {
    const row = existing.get(model);
    if (row && row.source === 'manual') {
      base.manual.push(model);
      continue;
    }
    const list = prices[model];
    if (!list) {
      base.missing.push(model);
      continue;
    }
    const next = { in: toMicros(list.in), cache: toMicros(list.cache), out: toMicros(list.out) };
    if (row && row.cost_micros_in === next.in && row.cost_micros_cache === next.cache && row.cost_micros_out === next.out && row.currency === cfg.currency) {
      base.unchanged.push(model);
      continue;
    }
    setModelPrice({
      model,
      cost_micros_in: next.in,
      cost_micros_cache: next.cache,
      cost_micros_out: next.out,
      // El margen es del operador: se conserva tal cual y solo se estrena en las altas.
      margin_pct: row?.margin_pct ?? cfg.defaultMarginPct,
      currency: cfg.currency,
      source: 'auto',
      synced_at: at,
    });
    (row ? base.updated : base.added).push(model);
  }

  // Altas de Google: se avisan siempre; solo se permiten solas si el operador lo
  // pidió Y sabemos tarifarlas (permitir un modelo sin precio sería facturar a ciegas).
  const allowed = getAllowedModels();
  const googleModels = await fetchGoogleModels();
  if (googleModels) {
    base.discovered = googleModels.filter((m) => !allowed.includes(m) && !!prices[m]).sort();
    if (cfg.autoAllow && base.discovered.length) {
      setAllowedModels([...allowed, ...base.discovered]);
      for (const model of base.discovered) {
        const list = prices[model];
        setModelPrice({
          model,
          cost_micros_in: toMicros(list.in),
          cost_micros_cache: toMicros(list.cache),
          cost_micros_out: toMicros(list.out),
          margin_pct: cfg.defaultMarginPct,
          currency: cfg.currency,
          source: 'auto',
          synced_at: at,
        });
        base.added.push(model);
      }
      base.discovered = [];
    }
  }

  base.ok = true;
  const changed = base.added.length + base.updated.length;
  auditSystem(
    'ai_prices_synced',
    `Precios de IA (${trigger === 'auto' ? 'automático' : 'manual'}, fuente ${base.source}): ${changed} modelo(s) actualizado(s), ${base.unchanged.length} sin cambios, ${base.missing.length} sin tarifa`,
  );
  return remember(base);
}

/**
 * Tic del planificador: refresca la tarifa una vez al día si el automático está
 * activo. Silencioso por diseño (el panel muestra el resultado); un fallo de red
 * no debe generar ruido ni tumbar el resto del tic.
 */
export async function aiPricesTick(now: Date): Promise<void> {
  const cfg = getPricesConfig();
  if (!cfg.auto) return;
  const { lastAt } = getSyncState();
  if (lastAt && now.getTime() - lastAt < SYNC_INTERVAL_MS) return;
  await syncAiModelPrices('auto');
}
