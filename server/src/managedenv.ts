/**
 * Cuándo puede Skyway escribir una variable de un servicio por su cuenta (al
 * conectar el correo o al aplicar el plan de integraciones). La regla es una:
 * **nunca se pisa una variable que alguien haya puesto a mano con otro valor**.
 * Se puede escribir si no existe, si está vacía (un hueco del `.env.example`),
 * si ya tiene ese mismo valor o si la escribió Skyway y nadie la ha cambiado
 * desde entonces (su hash sigue casando, ver `service_managed_env`).
 */
import { getEnv, getManagedEnv, getProjectVars, hashEnvValue, ManagedEnvEntry } from './db';
import { ServiceRow } from './types';

export interface EnvState {
  env: Record<string, string>;
  /** Variables compartidas del proyecto: una del servicio con el mismo nombre las taparía. */
  shared: Record<string, string>;
  managed: Record<string, ManagedEnvEntry>;
}

export function envStateOf(service: ServiceRow): EnvState {
  return { env: getEnv(service.id), shared: getProjectVars(service.project_id), managed: getManagedEnv(service.id) };
}

/** La variable la escribió Skyway y conserva el valor que escribió. */
export function managedUnchanged(state: EnvState, key: string): boolean {
  const m = state.managed[key];
  const current = state.env[key];
  return !!m && current !== undefined && m.valueHash === hashEnvValue(current);
}

/**
 * `write` si Skyway puede escribir `value` en `key`; `manual` si la variable
 * tiene otro valor puesto a mano. Con `value` null (un secreto que aún no
 * existe) no se puede comparar el valor: solo cuenta que esté libre o que sea
 * de Skyway. `legacy` son nombres que Skyway escribió antes de llevar esta
 * cuenta (una conexión de correo anterior) y que se tratan como suyos.
 */
export function writeDecision(state: EnvState, key: string, value: string | null, legacy?: ReadonlySet<string>): 'write' | 'manual' {
  const current = state.env[key];
  if (current === undefined) {
    const shared = state.shared[key];
    // Una compartida con valor propio es una decisión del proyecto: taparla
    // con una del servicio sería pisarla para este servicio.
    if (shared !== undefined && shared !== '' && shared !== value) return 'manual';
    return 'write';
  }
  if (current === '' || (value !== null && current === value)) return 'write';
  if (managedUnchanged(state, key) || legacy?.has(key)) return 'write';
  return 'manual';
}
