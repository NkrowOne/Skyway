import crypto from 'crypto';

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

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64, { N: SCRYPT_N }).toString('hex');
  return `s2:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 's2') return false;
  const [, salt, hash] = parts;
  const candidate = crypto.scryptSync(password, salt, 64, { N: SCRYPT_N });
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export function hmacSha256(secret: string, payload: string | Buffer): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Trocea un buffer/string en líneas completas, conservando el resto pendiente. */
export function lineSplitter(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let pending = '';
  return (chunk: Buffer | string) => {
    pending += chunk.toString();
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
  };
}
