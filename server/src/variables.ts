import { getEnv, getProjectVars, getSetting, listServices } from './db';
import { getTemplate } from './templates';
import { DatabaseConfig, GitConfig, ImageConfig, ServiceRow } from './types';

const REF_RE = /\$\{\{\s*([A-Za-z0-9 _.-]+?)\.([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Puerto interno por el que se llega a un servicio dentro del proyecto, según
 * lo guardado: el de la plantilla si es una base de datos, el elegido si es
 * una imagen (o ninguno: un worker) y, en un repositorio, el elegido o el 3000
 * con el que se despliega cuando nadie lo ha cambiado (mismo criterio que
 * `resolveGitPort`). Es lo que la UI enseña como «Dirección interna».
 */
export function internalPortOf(service: ServiceRow): number | null {
  if (service.type === 'database') return getTemplate((service.config as DatabaseConfig).template)?.port ?? null;
  if (service.type === 'git') return (service.config as GitConfig).port || 3000;
  return (service.config as ImageConfig).port ?? null;
}

/** Nombres de las variables que Skyway calcula por cada servicio. */
export const SYSTEM_VAR_KEYS = ['INTERNAL_HOST', 'INTERNAL_PORT', 'INTERNAL_URL', 'PUBLIC_DOMAIN', 'PUBLIC_URL'] as const;

/**
 * Variables que Skyway sabe de un servicio sin que nadie las escriba: por dónde
 * se le llama dentro del proyecto y por qué dominio se le llega desde fuera.
 * Otro servicio las referencia como `${{api.INTERNAL_URL}}` y el propio
 * servicio las recibe al desplegar; al cambiar el puerto o el dominio se
 * actualizan solas, que es lo que una URL escrita a mano no hace.
 *
 * Una base de datos no tiene `INTERNAL_URL`: su URL es la del motor
 * (`DATABASE_URL`, `REDIS_URL`…), que ya exporta como variable normal, y una
 * `http://` delante de un Postgres solo confundiría.
 *
 * `port` y `domains` se pueden pasar cuando se sabe más que lo guardado: el
 * despliegue conoce el puerto que acaba de detectar del EXPOSE de la imagen.
 */
export function systemVars(
  service: ServiceRow,
  overrides: { port?: number | null; domains?: string[] } = {},
): Record<string, string> {
  const out: Record<string, string> = { INTERNAL_HOST: service.slug };
  const port = overrides.port !== undefined ? overrides.port : internalPortOf(service);
  if (port) {
    out.INTERNAL_PORT = String(port);
    if (service.type !== 'database') out.INTERNAL_URL = `http://${service.slug}:${port}`;
  }
  const domains = overrides.domains ?? (((service.config as GitConfig | ImageConfig).domains ?? []) as string[]);
  if (domains[0]) {
    out.PUBLIC_DOMAIN = domains[0];
    // El esquema lo decide quien enruta: sin correo de Let's Encrypt, Traefik
    // no monta el router seguro y prometer https lleva a un certificado ajeno.
    out.PUBLIC_URL = `${getSetting('letsencryptEmail') ? 'https' : 'http'}://${domains[0]}`;
  }
  return out;
}

/**
 * Resuelve las variables de un servicio:
 * - Hereda las variables compartidas del proyecto (las del servicio tienen prioridad).
 * - Expande referencias `${{OtroServicio.VAR}}` y `${{shared.VAR}}` recursivamente.
 * - Si el servicio apuntado no tiene esa variable guardada, prueba con las de
 *   sistema (`INTERNAL_URL`, `PUBLIC_URL`…): lo guardado siempre gana, así que
 *   quien defina a mano una `PUBLIC_URL` distinta sigue mandando.
 */
export function resolveServiceEnv(service: ServiceRow): Record<string, string> {
  const siblings = listServices(service.project_id);
  const shared = getProjectVars(service.project_id);
  const envByService = new Map<string, Record<string, string>>();
  for (const s of siblings) envByService.set(s.id, getEnv(s.id));
  // Perezoso: casi ninguna referencia cae en una variable de sistema, y
  // calcularlas para todos los hermanos en cada despliegue sería tirar trabajo.
  const systemByService = new Map<string, Record<string, string>>();
  const systemOf = (s: ServiceRow): Record<string, string> => {
    let vars = systemByService.get(s.id);
    if (!vars) {
      vars = systemVars(s);
      systemByService.set(s.id, vars);
    }
    return vars;
  };

  const findSibling = (name: string): ServiceRow | undefined => {
    const n = name.trim().toLowerCase();
    return siblings.find((s) => s.name.toLowerCase() === n || s.slug === n);
  };

  const resolveValue = (value: string, depth: number): string => {
    if (depth > 5) return value;
    return value.replace(REF_RE, (match, scope: string, varName: string) => {
      const scopeName = scope.trim().toLowerCase();
      if (scopeName === 'shared' || scopeName === 'proyecto' || scopeName === 'project') {
        const raw = shared[varName];
        return raw === undefined ? match : resolveValue(raw, depth + 1);
      }
      const target = findSibling(scope);
      if (!target) return match;
      const raw = (envByService.get(target.id) || {})[varName] ?? systemOf(target)[varName];
      return raw === undefined ? match : resolveValue(raw, depth + 1);
    });
  };

  const merged: Record<string, string> = { ...shared, ...(envByService.get(service.id) || {}) };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) out[k] = resolveValue(v, 0);
  return out;
}

export interface ReferenceGroup {
  service: string;
  /** Plantilla si el hermano es una base de datos (postgres, redis…); null en el resto. */
  template: string | null;
  vars: string[];
  /** Variables de sistema que ese servicio tiene ahora mismo (las calcula Skyway, no están guardadas). */
  auto: string[];
}

/** Referencias disponibles para la UI: variables compartidas + servicios hermanos. */
export function availableReferences(service: ServiceRow): ReferenceGroup[] {
  const groups: ReferenceGroup[] = [];
  const shared = getProjectVars(service.project_id);
  if (Object.keys(shared).length > 0) {
    groups.push({ service: 'shared', template: null, vars: Object.keys(shared), auto: [] });
  }
  const siblings = listServices(service.project_id).filter((s) => s.id !== service.id);
  for (const s of siblings) {
    const template = s.type === 'database' ? (s.config as DatabaseConfig).template : null;
    const vars = getEnv(s.id);
    // Una variable guardada con el mismo nombre tapa a la de sistema: se
    // enseña una vez, como lo que es.
    const auto = Object.keys(systemVars(s)).filter((k) => vars[k] === undefined);
    groups.push({ service: s.name, template, vars: Object.keys(vars), auto });
  }
  return groups;
}
