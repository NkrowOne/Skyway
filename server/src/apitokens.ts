/**
 * Emisión de tokens de API (`sky_…`). La comparten «Mi perfil → Tokens de API»
 * (`routes/tokens.ts`) y la herramienta de terminal `tools/token.ts`, para que
 * un token creado desde el servidor sea exactamente igual que uno del panel:
 * mismo formato, mismo hash, mismo prefijo visible y misma caducidad.
 */
import { z } from 'zod';
import { API_TOKEN_PREFIX, hashApiToken } from './auth';
import { insertApiToken } from './db';
import { ApiTokenRow } from './types';
import { randomToken } from './util';

export const nombreTokenSchema = z
  .string()
  .trim()
  .min(1, 'Nombre requerido')
  .max(60, 'El nombre del token admite hasta 60 caracteres');

/** Caducidad máxima: la misma que admite el panel (3650 días). */
export const CADUCIDAD_MAXIMA_MS = 3650 * 24 * 3600 * 1000;

/**
 * Crea el token y devuelve su valor en claro, que solo existe aquí: se guarda
 * hasheado y nadie puede recuperarlo después.
 */
export function emitirTokenApi(input: { userId: string; name: string; expiresAt: number | null }): {
  token: string;
  row: ApiTokenRow;
} {
  const token = `${API_TOKEN_PREFIX}${randomToken(24)}`; // sky_ + 48 hex
  const row = insertApiToken({
    user_id: input.userId,
    name: input.name,
    token_hash: hashApiToken(token),
    prefix: token.slice(0, API_TOKEN_PREFIX.length + 8),
    expires_at: input.expiresAt,
  });
  return { token, row };
}
