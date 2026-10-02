/**
 * Token de Cloudflare del administrador (operador de la plataforma): probar,
 * guardar, borrar y la vista que ve Ajustes → Cloudflare. Lo comparten las
 * rutas (`routes/cloudflare.ts`) y la herramienta de terminal
 * `tools/cloudflare.ts`, con la que el instalador de Mailway lo deja puesto:
 * una sola validación y la misma auditoría, se configure desde el navegador o
 * desde el servidor.
 *
 * El token se guarda en `settings` como el resto de secretos del panel (el de
 * GitHub, el de Mailway) y JAMÁS se devuelve, se registra ni se audita: fuera
 * de aquí solo sale su pista (los últimos 4 caracteres). Lo usa únicamente el
 * DNS automático (`cloudflaredns.ts`), y solo en peticiones de un
 * administrador.
 */
import { z } from 'zod';
import { CloudflareClient, CloudflareError, URL_CREAR_TOKEN, pistaToken } from './cloudflare';
import { getSetting, setSetting } from './db';
import { httpError } from './mailconnect';
import { safeParse } from './util';

/** Claves de Ajustes. El token es secreto: solo se lee en este módulo. */
export const CLOUDFLARE_SETTING = {
  token: 'cloudflare.token',
  /** Zonas que ve el token en la última verificación (JSON, sin secretos). */
  zones: 'cloudflare.zones',
  /** Último fallo del token al usarlo (JSON `{message, at}`), para que el administrador lo vea. */
  lastError: 'cloudflare.lastError',
} as const;

/**
 * Forma de un token de API de Cloudflare: los de usuario son 40 caracteres y
 * los de cuenta empiezan por `cfat_`. Se admite un margen amplio, sin espacios
 * ni otros símbolos: el valor solo viaja en la cabecera Authorization.
 */
export const CLOUDFLARE_TOKEN_RE = /^[A-Za-z0-9_-]{20,400}$/;

const FORMATO_NO_VALIDO =
  'El token de Cloudflare no tiene un formato válido: copia el token de API completo (letras, números, guiones y guiones bajos).';

export const cloudflareTokenSchema = z.object({
  token: z.string({ required_error: 'Introduce el token de API de Cloudflare.' }).trim().max(400, FORMATO_NO_VALIDO),
});

/** Cuántos nombres de zona se guardan para mostrarlos (el total se guarda aparte). */
const MAX_ZONAS_GUARDADAS = 100;

export interface ZonasVisibles {
  names: string[];
  total: number;
  checkedAt: number;
}

export interface CloudflareConfigView {
  configured: boolean;
  /** Últimos 4 caracteres del token guardado, o null. */
  hint: string | null;
  zones: ZonasVisibles | null;
  lastError: { message: string; at: number } | null;
  createTokenUrl: string;
}

/** Valida la forma del token sin repetirlo en el mensaje. */
export function validarFormatoToken(token: string): string {
  const limpio = token.trim();
  if (!limpio) throw httpError(400, 'Introduce el token de API de Cloudflare.');
  if (!CLOUDFLARE_TOKEN_RE.test(limpio)) throw httpError(400, FORMATO_NO_VALIDO);
  return limpio;
}

/** Token guardado. Solo para el DNS automático: nunca sale del servidor. */
export function tokenCloudflareGuardado(): string | null {
  return getSetting(CLOUDFLARE_SETTING.token) || null;
}

export function cloudflareConfigurado(): boolean {
  return !!tokenCloudflareGuardado();
}

/**
 * Verifica el token contra Cloudflare y cuenta las zonas que ve. Un token sin
 * ninguna zona no sirve para crear registros: se rechaza como en Mailway.
 */
async function verificar(token: string): Promise<ZonasVisibles> {
  const cliente = new CloudflareClient(token);
  await cliente.verifyToken();
  const zonas = await cliente.listZones();
  if (zonas.length === 0) {
    throw new CloudflareError(
      400,
      'El token no da acceso a ninguna zona. Asigna el permiso «Zone · Zone · Read» e incluye las zonas de tus dominios.',
      'cloudflare_no_zones',
    );
  }
  const names = [...new Set(zonas.map((z) => z.name))].sort();
  return { names: names.slice(0, MAX_ZONAS_GUARDADAS), total: names.length, checkedAt: Date.now() };
}

/** Anota (o borra, con null) el último fallo del token guardado. */
export function anotarErrorCloudflare(message: string | null): void {
  setSetting(CLOUDFLARE_SETTING.lastError, message ? JSON.stringify({ message, at: Date.now() }) : null);
}

/**
 * Prueba el token indicado (sin guardarlo) o, sin ninguno, el guardado; en
 * este último caso refresca además las zonas y el último fallo que ve Ajustes.
 */
export async function probarTokenCloudflare(body: { token?: string }): Promise<{ ok: true; zones: ZonasVisibles }> {
  if (body.token) return { ok: true, zones: await verificar(validarFormatoToken(body.token)) };
  const guardado = tokenCloudflareGuardado();
  if (!guardado) throw httpError(400, 'Introduce el token de Cloudflare o guárdalo antes de probarlo.');
  try {
    const zones = await verificar(guardado);
    setSetting(CLOUDFLARE_SETTING.zones, JSON.stringify(zones));
    anotarErrorCloudflare(null);
    return { ok: true, zones };
  } catch (err) {
    if (err instanceof CloudflareError) anotarErrorCloudflare(err.message);
    throw err;
  }
}

/** Cómo deja rastro quien guarda: `audit(req, …)` en la ruta, `auditSystem` en la terminal. */
export type AuditarCloudflare = (action: string, target: { type: string; id: string; detail: string }) => void;

/**
 * Verifica el token y, solo si Cloudflare lo acepta, lo guarda con sus zonas.
 * Guardar el mismo token otra vez refresca las zonas sin dejar otra entrada de
 * auditoría (la herramienta de terminal se puede repetir sin ruido). La
 * auditoría nunca lleva el token, ni siquiera su pista.
 */
export async function guardarTokenCloudflare(
  tokenCrudo: string,
  auditar: AuditarCloudflare,
): Promise<{ zones: ZonasVisibles; cambiado: boolean }> {
  const token = validarFormatoToken(tokenCrudo);
  const zones = await verificar(token);
  const antes = tokenCloudflareGuardado();
  setSetting(CLOUDFLARE_SETTING.token, token);
  setSetting(CLOUDFLARE_SETTING.zones, JSON.stringify(zones));
  anotarErrorCloudflare(null);
  const cambiado = antes !== token;
  if (cambiado) {
    auditar(antes ? 'cloudflare_token_replaced' : 'cloudflare_token_saved', {
      type: 'system',
      id: 'cloudflare',
      detail: `${zones.total} zona(s) visibles`,
    });
  }
  return { zones, cambiado };
}

/** Borra el token y lo que se sabía de él. Devuelve si había alguno. */
export function borrarTokenCloudflare(auditar: AuditarCloudflare): boolean {
  const habia = !!tokenCloudflareGuardado();
  for (const key of Object.values(CLOUDFLARE_SETTING)) setSetting(key, null);
  if (habia) auditar('cloudflare_token_removed', { type: 'system', id: 'cloudflare', detail: 'token eliminado' });
  return habia;
}

/** Lo que ve Ajustes → Cloudflare: nunca el token. */
export function cloudflareConfigView(): CloudflareConfigView {
  const token = tokenCloudflareGuardado();
  const zones = safeParse<ZonasVisibles | null>(getSetting(CLOUDFLARE_SETTING.zones), null);
  const lastError = safeParse<{ message: string; at: number } | null>(getSetting(CLOUDFLARE_SETTING.lastError), null);
  return {
    configured: !!token,
    hint: token ? pistaToken(token) || null : null,
    zones: token && zones && Array.isArray(zones.names) ? zones : null,
    lastError: token && lastError && typeof lastError.message === 'string' ? lastError : null,
    createTokenUrl: URL_CREAR_TOKEN,
  };
}
