import { getEnv, getProjectVars, listServices } from './db';
import { ServiceRow } from './types';

const REF_RE = /\$\{\{\s*([A-Za-z0-9 _.-]+?)\.([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Resuelve las variables de un servicio:
 * - Hereda las variables compartidas del proyecto (las del servicio tienen prioridad).
 * - Expande referencias `${{OtroServicio.VAR}}` y `${{shared.VAR}}` recursivamente.
 */
export function resolveServiceEnv(service: ServiceRow): Record<string, string> {
  const siblings = listServices(service.project_id);
  const shared = getProjectVars(service.project_id);
  const envByService = new Map<string, Record<string, string>>();
  for (const s of siblings) envByService.set(s.id, getEnv(s.id));

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
      const raw = (envByService.get(target.id) || {})[varName];
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
  vars: string[];
}

/** Referencias disponibles para la UI: variables compartidas + servicios hermanos. */
export function availableReferences(service: ServiceRow): ReferenceGroup[] {
  const groups: ReferenceGroup[] = [];
  const shared = getProjectVars(service.project_id);
  if (Object.keys(shared).length > 0) {
    groups.push({ service: 'shared', vars: Object.keys(shared) });
  }
  const siblings = listServices(service.project_id).filter((s) => s.id !== service.id);
  for (const s of siblings) {
    groups.push({ service: s.name, vars: Object.keys(getEnv(s.id)) });
  }
  return groups;
}
