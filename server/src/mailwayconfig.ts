/**
 * Probar y guardar la conexión con Mailway. Lo comparten Ajustes → Correo
 * (Mailway) (`routes/mailway.ts`) y la herramienta de terminal
 * `tools/mailway.ts`, con la que el instalador de Mailway empareja los dos
 * paneles: una sola validación, un solo criterio de seguridad (la URL pública
 * nunca puede ser la de otro servicio, el token iría hasta él) y la misma
 * auditoría, se configure desde el navegador o desde el servidor.
 */
import { z } from 'zod';
import { getProject, getService, getSetting, setSetting } from './db';
import { httpError } from './mailconnect';
import {
  MAILWAY_SETTING,
  MailwayConfig,
  getInfo,
  hostOf,
  internalPanelUrl,
  normalizeBaseUrl,
  publicBaseConflict,
  readMailwayConfig,
  rememberPreviousHosts,
  resetMailwayCaches,
  safeHttpUrl,
} from './mailway';
import { resetMailwayTraefikState } from './mailwaytraefik';

export const MAILWAY_TOKEN_RE = /^mwt_[A-Za-z0-9_-]{8,500}$/;

export const mailwayConfigSchema = z.object({
  baseUrl: z.string().trim().max(500).optional(),
  token: z.string().trim().max(520).optional(),
  serviceId: z.string().trim().max(100).optional(),
  defaultPlanId: z
    .string()
    .trim()
    .max(64)
    .regex(/^[A-Za-z0-9_-]*$/, 'Identificador de plan no válido')
    .optional(),
});

export type MailwayConfigInput = z.infer<typeof mailwayConfigSchema>;

/** Valida una URL de panel: http(s), sin credenciales, consulta ni fragmento. */
export function parsePanelUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw httpError(400, 'La URL del panel de Mailway no es válida.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw httpError(400, 'La URL del panel de Mailway debe empezar por https:// o http://.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw httpError(400, 'La URL del panel de Mailway no puede incluir credenciales, parámetros ni fragmentos.');
  }
  return normalizeBaseUrl(url.toString())!;
}

/**
 * Motivo por el que no se puede usar la URL pública, si su dominio lo sirve un
 * servicio de Skyway que no es el panel de Mailway (el token viajaría hasta
 * él). Nombra el servicio: esta comprobación solo la ve el administrador.
 */
export function baseConflictMessage(cfg: MailwayConfig): string | null {
  const service = publicBaseConflict(cfg);
  if (!service) return null;
  const project = getProject(service.project_id);
  return (
    `El dominio de la URL pública lo sirve el servicio «${project?.name ?? '?'} / ${service.name}» de Skyway, que no es el panel de Mailway. ` +
    'Si ese servicio ejecuta el panel, selecciónalo en «Servicio del panel de Mailway»; si no, corrige la URL. El token de gestión no se envía por un dominio de otro servicio.'
  );
}

export function checkService(serviceId: string): void {
  const service = getService(serviceId);
  if (!service) throw httpError(400, 'El servicio indicado no existe.');
  if (service.type === 'database') throw httpError(400, 'El panel de Mailway no puede ser un servicio de base de datos.');
}

export interface ResultadoPruebaMailway {
  ok: true;
  info: {
    version: string;
    brandName: string;
    mailHostname: string;
    webmailUrl: string | null;
    panelUrl: string | null;
    role: 'admin' | 'client' | null;
    email: string | null;
    features: { cloudflare: boolean; autoconfig: boolean; portal: boolean };
  };
  warnings: string[];
}

/**
 * Prueba la conexión con los valores indicados (aún sin guardar) o, sin
 * ninguno, con los guardados; en este último caso deja además en caché la
 * información de la instancia y el token de Traefik. Lanza `httpError` (400 o
 * 403) si la petición no es válida y `MailwayError` si Mailway falla.
 *
 * `sesionNavegador`: probar OTRA dirección con el token GUARDADO lo enviaría
 * allí; con un token de API de Skyway sería una forma de sacar una credencial
 * persistente, así que exige sesión de navegador, como guardarla.
 */
export async function probarConexionMailway(
  body: MailwayConfigInput,
  opts: { sesionNavegador: boolean },
): Promise<ResultadoPruebaMailway> {
  const saved = readMailwayConfig();
  const override = !!(body.baseUrl || body.token || body.serviceId);
  if (body.token && !MAILWAY_TOKEN_RE.test(body.token)) {
    throw httpError(400, 'El token de gestión no es válido: debe empezar por «mwt_».');
  }
  if (body.serviceId) checkService(body.serviceId);
  if ((body.baseUrl || body.serviceId) && !body.token && !opts.sesionNavegador) {
    throw httpError(403, 'Probar otra dirección con el token guardado requiere una sesión de navegador.');
  }
  const cfg: MailwayConfig = {
    baseUrl: body.baseUrl ? parsePanelUrl(body.baseUrl) : saved.baseUrl,
    token: body.token || saved.token,
    serviceId: body.serviceId || saved.serviceId,
  };
  if (!cfg.token) {
    throw httpError(400, 'Introduce el token de gestión de Mailway o guárdalo antes de probar la conexión.');
  }
  if (!cfg.baseUrl && !internalPanelUrl(cfg.serviceId)) {
    throw httpError(400, 'Indica la URL pública del panel de Mailway o el servicio de Skyway que lo ejecuta.');
  }
  const conflicto = baseConflictMessage(cfg);
  if (conflicto && !internalPanelUrl(cfg.serviceId)) throw httpError(400, conflicto);
  const info = override ? await getInfo({ config: cfg }) : await getInfo({ fresh: true });
  const warnings: string[] = [];
  if (conflicto) warnings.push(conflicto);
  if (info.user?.role !== 'admin') {
    warnings.push(
      'El token pertenece a un usuario que no es administrador de Mailway: no será posible activar el correo en los proyectos ni publicar en Traefik los dominios propios de los clientes.',
    );
  } else if (!info.traefik?.token) {
    warnings.push('Mailway no ha facilitado el token de Traefik: los dominios propios de los clientes no se publicarán automáticamente.');
  }
  return {
    ok: true,
    info: {
      version: info.version,
      brandName: info.brandName,
      mailHostname: info.mailHostname,
      webmailUrl: safeHttpUrl(info.webmailUrl),
      panelUrl: safeHttpUrl(info.panelUrl),
      role: info.user?.role ?? null,
      email: info.user?.email ?? null,
      features: {
        cloudflare: !!info.features?.cloudflare,
        autoconfig: !!info.features?.autoconfig,
        portal: !!info.features?.portal,
      },
    },
    warnings,
  };
}

/** Cómo deja rastro quien guarda: `audit(req, …)` en la ruta, `auditSystem` en la terminal. */
export type AuditarConfigMailway = (action: string, target: { type: string; id: string; detail: string }) => void;

/**
 * Guarda la configuración (`''` borra un campo; lo que no llega se conserva) y
 * devuelve la lista de cambios, sin valores. Valida todo antes de escribir
 * nada. Si cambia la conexión, olvida lo aprendido de la instancia anterior y
 * el token de Traefik; la última configuración de Traefik se conserva
 * (también sin token): solo «Desconectar Mailway» retira las rutas.
 *
 * Desde la terminal del servidor el proceso es otro: lo que se olvida aquí en
 * memoria no alcanza al panel en marcha, pero el panel lee la configuración de
 * la base en cada petición, vuelve a pedir el token de Traefik en su siguiente
 * lectura del puente (lo encuentra borrado) y su caché de la instancia caduca
 * en 5 minutos.
 */
export function guardarConfigMailway(body: MailwayConfigInput, auditar: AuditarConfigMailway): { cambios: string[] } {
  const before = readMailwayConfig();
  const next: MailwayConfig = { ...before };
  const cambios: string[] = [];

  if (body.baseUrl !== undefined) next.baseUrl = body.baseUrl === '' ? null : parsePanelUrl(body.baseUrl);
  if (body.token !== undefined) {
    if (body.token !== '' && !MAILWAY_TOKEN_RE.test(body.token)) {
      throw httpError(400, 'El token de gestión no es válido: debe empezar por «mwt_» (Mailway → Conexiones → Tokens de gestión).');
    }
    next.token = body.token === '' ? null : body.token;
  }
  if (body.serviceId !== undefined) {
    if (body.serviceId !== '') checkService(body.serviceId);
    next.serviceId = body.serviceId === '' ? null : body.serviceId;
  }
  // Al cambiar la dirección o el servicio se valida la combinación final
  // antes de guardar nada: una URL cuyo dominio sirve otro servicio de
  // Skyway recibiría el token. Sin tocarlas (p. ej., para quitar el token)
  // no se bloquea al administrador.
  if (next.baseUrl !== before.baseUrl || next.serviceId !== before.serviceId) {
    const conflicto = baseConflictMessage(next);
    if (conflicto) throw httpError(400, conflicto);
  }

  if (next.baseUrl !== before.baseUrl) {
    setSetting(MAILWAY_SETTING.baseUrl, next.baseUrl);
    cambios.push(next.baseUrl ? 'URL del panel' : 'URL del panel (eliminada)');
    // El nombre anterior sigue apuntando aquí hasta que cambie su DNS: queda reservado.
    const anterior = hostOf(before.baseUrl);
    if (anterior) rememberPreviousHosts([anterior]);
  }
  if (next.token !== before.token) {
    setSetting(MAILWAY_SETTING.token, next.token);
    cambios.push(next.token ? 'token de gestión' : 'token de gestión (eliminado)');
  }
  if (next.serviceId !== before.serviceId) {
    setSetting(MAILWAY_SETTING.serviceId, next.serviceId);
    cambios.push(next.serviceId ? 'servicio del panel' : 'servicio del panel (eliminado)');
  }
  let cambioPlan = false;
  if (body.defaultPlanId !== undefined) {
    const value = body.defaultPlanId || null;
    if (value !== (getSetting(MAILWAY_SETTING.defaultPlanId) || null)) {
      setSetting(MAILWAY_SETTING.defaultPlanId, value);
      cambioPlan = true;
    }
  }

  if (cambios.length > 0) {
    // Otra instancia u otro token: lo aprendido de la anterior no vale.
    resetMailwayCaches();
    setSetting(MAILWAY_SETTING.traefikToken, null);
    resetMailwayTraefikState();
  }
  if (cambioPlan) cambios.push('plan predeterminado');
  if (cambios.length > 0) {
    auditar('mailway_config_updated', { type: 'system', id: 'mailway', detail: cambios.join(', ') });
  }
  return { cambios };
}
