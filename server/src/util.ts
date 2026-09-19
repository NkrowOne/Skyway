import crypto from 'crypto';
import { StringDecoder } from 'string_decoder';

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('hex');
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Cadena alfanumérica de longitud EXACTA. Hay secretos con longitud obligatoria
 * (claves de cifrado) y otros que viajan dentro de URLs, donde un carácter
 * reservado obligaría a escapar.
 */
export function randomAlnum(length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALNUM[bytes[i] % ALNUM.length];
  return out;
}

export function randomPassword(bytes = 16): string {
  // Alfanumérico para que funcione sin escapes en URLs de conexión.
  return crypto.randomBytes(bytes).toString('base64url').replace(/[-_]/g, '').slice(0, 24) || randomToken(12);
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return slug || 'svc';
}

export function now(): number {
  return Date.now();
}

/** Formatea bytes de forma legible para mensajes de alerta. */
export function fmtBytesEs(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10));
  const value = bytes / 2 ** (10 * i);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

const SCRYPT_N = 16384;
const SCRYPT_KEYLEN = 64;

/** Descompone `s2:salt:hash`; null si el formato no es el nuestro. */
function parseStoredHash(stored: string): { salt: string; expected: Buffer } | null {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 's2') return null;
  return { salt: parts[1], expected: Buffer.from(parts[2], 'hex') };
}

function scryptKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * Versión SÍNCRONA: bloquea el bucle de eventos ~50 ms. Vale para el arranque,
 * las herramientas de línea de comandos y las rutas de administración poco
 * frecuentes; en el login y en todo lo que pueda martillear un anónimo se usa
 * `hashPasswordAsync`/`verifyPasswordAsync`, que calculan en el pool de hilos.
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N }).toString('hex');
  return `s2:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const candidate = crypto.scryptSync(password, parsed.salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
  return candidate.length === parsed.expected.length && crypto.timingSafeEqual(candidate, parsed.expected);
}

export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scryptKey(password, salt)).toString('hex');
  return `s2:${salt}:${hash}`;
}

export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const candidate = await scryptKey(password, parsed.salt);
  return candidate.length === parsed.expected.length && crypto.timingSafeEqual(candidate, parsed.expected);
}

let decoyHash: string | null = null;

/**
 * Hash señuelo para el login: contra un email que no existe se verifica igual la
 * contraseña (contra este hash, que nunca casa), de modo que la respuesta tarda
 * lo mismo que con un usuario real. Sin él, medir el tiempo bastaba para saber
 * qué emails tienen cuenta. Se genera una vez por proceso, con una contraseña
 * aleatoria que nadie conoce.
 */
export function decoyPasswordHash(): string {
  decoyHash ??= hashPassword(randomToken(16));
  return decoyHash;
}

export function hmacSha256(secret: string, payload: string | Buffer): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * `JSON.parse` tolerante para datos ALMACENADOS (columnas JSON de SQLite,
 * ajustes): una fila corrupta o vacía devuelve `fallback` en vez de tumbar la
 * petición con un 500 opaco. Además exige que la forma coincida con la del valor
 * por defecto (lista frente a objeto): un dato del tipo equivocado es igual de
 * inservible que uno ilegible. No sustituye a zod para la entrada del usuario.
 */
export function safeParse<T>(json: string | null | undefined, fallback: T): T {
  if (json == null || json === '') return fallback;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return fallback;
  }
  if (Array.isArray(fallback)) return (Array.isArray(value) ? value : fallback) as T;
  if (fallback !== null && typeof fallback === 'object') {
    return (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : fallback) as T;
  }
  return (value ?? fallback) as T;
}

export type LineFeed = ((chunk: Buffer | string) => void) & {
  /** Entrega lo que quede sin salto de línea final. Llamar al cerrar el stream. */
  flush: () => void;
};

/**
 * Trocea un buffer/string en líneas completas, conservando el resto pendiente.
 * `flush()` suelta el resto al acabar el stream: sin él, la última línea de
 * una herramienta que no termina en salto de línea se perdía.
 *
 * Los buffers se decodifican con `StringDecoder`: un carácter UTF-8 multibyte
 * («ñ», «€», emoji) que cae partido entre dos trozos del stream salía como dos
 * «�» con `chunk.toString()`; el decodificador retiene los bytes incompletos
 * hasta que llega el resto.
 */
export function lineSplitter(onLine: (line: string) => void): LineFeed {
  let pending = '';
  const decoder = new StringDecoder('utf8');
  const feed = ((chunk: Buffer | string) => {
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let idx;
    while ((idx = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, idx).replace(/\r$/, '');
      pending = pending.slice(idx + 1);
      if (line.length > 0) onLine(line);
    }
    if (pending.length > 8192) {
      onLine(pending);
      pending = '';
    }
  }) as LineFeed;
  feed.flush = () => {
    // `end()` vacía lo que el decodificador retenía (bytes de un carácter a medias).
    const rest = (pending + decoder.end()).replace(/\r$/, '');
    pending = '';
    if (rest.length > 0) onLine(rest);
  };
  return feed;
}
