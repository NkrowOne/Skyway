import { getEnv, listServices } from './db';
import { ServiceRow } from './types';

const REF_RE = /\$\{\{\s*([A-Za-z0-9 _.-]+?)\.([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Resuelve las variables de un servicio, expandiendo referencias del tipo
 * `${{OtroServicio.VARIABLE}}` contra los servicios hermanos del proyecto.
 */
export function resolveServiceEnv(service: ServiceRow): Record<string, string> {
  const siblings = listServices(service.project_id);
  const envByService = new Map<string, Record<string, string>>();
  for (const s of siblings) envByService.set(s.id, getEnv(s.id));

  const findSibling = (name: string): ServiceRow | undefined => {
    const n = name.trim().toLowerCase();
    return siblings.find((s) => s.name.toLowerCase() === n || s.slug === n);
  };

  const resolveValue = (value: string, depth: number): string => {
    if (depth > 5) return value;
    return value.replace(REF_RE, (match, svcName: string, varName: string) => {
      const target = findSibling(svcName);
      if (!target) return match;
      const vars = envByService.get(target.id) || {};
      const raw = vars[varName];
      if (raw === undefined) return match;
      return resolveValue(raw, depth + 1);
    });
  };

  const own = envByService.get(service.id) || {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(own)) out[k] = resolveValue(v, 0);
  return out;
}

/** Lista las referencias disponibles para autocompletar en la UI. */
export function availableReferences(service: ServiceRow): { service: string; vars: string[] }[] {
  const siblings = listServices(service.project_id).filter((s) => s.id !== service.id);
  return siblings.map((s) => ({ service: s.name, vars: Object.keys(getEnv(s.id)) }));
}
