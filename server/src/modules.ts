/**
 * Catálogo de módulos de Skyway. Un módulo es una capacidad que un plan incluye
 * y que el workspace de un cliente puede tener activa o no. Los administradores
 * conceden módulos (por plan o a medida); el propietario del workspace puede
 * «acotar» —desactivar— los que no quiera bajo su cuenta. Las gates de módulo se
 * aplican a propietarios y miembros; un administrador del servidor las traspasa
 * siempre (controla todo, también en nombre del cliente).
 */
export type ModuleKey =
  | 'databases'
  | 'dbconsole'
  | 'files'
  | 'backups'
  | 'domains'
  | 'github'
  | 'status_page'
  | 'metrics'
  | 'replicas'
  | 'exec';

export interface ModuleDef {
  key: ModuleKey;
  label: string;
  description: string;
  /** Grupo para agrupar la rejilla de módulos en la UI. */
  group: 'Cómputo' | 'Datos' | 'Red' | 'Operación';
}

/** Orden canónico de presentación (también el orden de la rejilla de módulos). */
export const MODULES: ModuleDef[] = [
  { key: 'databases', label: 'Bases de datos', description: 'Crear servicios de base de datos gestionados (Postgres, Redis, MySQL, Mongo, MinIO).', group: 'Datos' },
  { key: 'dbconsole', label: 'Consola de datos', description: 'Explorar y consultar las bases de datos desde el panel.', group: 'Datos' },
  { key: 'backups', label: 'Copias de seguridad', description: 'Volcados manuales y programados de las bases de datos, con retención.', group: 'Datos' },
  { key: 'files', label: 'Explorador de archivos', description: 'Navegar, subir y descargar archivos dentro de los contenedores.', group: 'Operación' },
  { key: 'exec', label: 'Terminal de comandos', description: 'Ejecutar comandos puntuales dentro de los contenedores.', group: 'Operación' },
  { key: 'metrics', label: 'Histórico de consumo', description: 'Gráficas de CPU, RAM, red y disco a 24 h / 7 d / 30 d.', group: 'Operación' },
  { key: 'replicas', label: 'Escalado horizontal', description: 'Varias réplicas por servicio con balanceo automático.', group: 'Cómputo' },
  { key: 'domains', label: 'Dominios y TLS', description: 'Dominios propios con certificado automático vía Traefik.', group: 'Red' },
  { key: 'status_page', label: 'Página de estado', description: 'Dashboard público de disponibilidad compartible por enlace.', group: 'Red' },
  { key: 'github', label: 'Conectores de GitHub', description: 'Conectar cuentas de GitHub para desplegar repos privados del cliente.', group: 'Red' },
];

export const ALL_MODULE_KEYS: ModuleKey[] = MODULES.map((m) => m.key);
export const MODULE_LABEL: Record<ModuleKey, string> = Object.fromEntries(
  MODULES.map((m) => [m.key, m.label]),
) as Record<ModuleKey, string>;
const MODULE_KEY_SET = new Set<string>(ALL_MODULE_KEYS);

export function isModuleKey(value: string): value is ModuleKey {
  return MODULE_KEY_SET.has(value);
}

/** Filtra y deduplica una lista arbitraria dejando solo claves de módulo válidas, en orden canónico. */
export function sanitizeModules(keys: readonly string[]): ModuleKey[] {
  const set = new Set(keys.filter(isModuleKey) as ModuleKey[]);
  return ALL_MODULE_KEYS.filter((k) => set.has(k));
}
