import { randomPassword } from './util';

export interface DbTemplate {
  key: string;
  label: string;
  description: string;
  image: string;
  defaultVersion: string;
  port: number;
  volumePath: string;
  /** Comando opcional (forma shell) que puede usar variables de entorno. */
  cmd?: string[];
  /**
   * Genera las variables del servicio (se guardan como env vars normales).
   * Con `existing` conserva las credenciales ya guardadas y solo deriva lo
   * que falte (p. ej. reconstruir DATABASE_URL sin rotar la contraseña de
   * una base ya inicializada, cuyos datos guardan la contraseña vieja).
   */
  makeEnv: (slug: string, existing?: Record<string, string>) => Record<string, string>;
}

/** Codifica credenciales dentro de una URL de conexión (las generadas son
 * alfanuméricas y quedan igual; las personalizadas pueden llevar reservados). */
const enc = (s: string) => encodeURIComponent(s);

export const DB_TEMPLATES: Record<string, DbTemplate> = {
  postgres: {
    key: 'postgres',
    label: 'PostgreSQL',
    description: 'Base de datos relacional',
    image: 'postgres',
    defaultVersion: '16-alpine',
    port: 5432,
    volumePath: '/var/lib/postgresql/data',
    makeEnv: (slug, existing = {}) => {
      const user = existing.POSTGRES_USER || existing.PGUSER || 'skyway';
      const password = existing.POSTGRES_PASSWORD || existing.PGPASSWORD || randomPassword();
      const database = existing.POSTGRES_DB || existing.PGDATABASE || 'skyway';
      return {
        POSTGRES_USER: user,
        POSTGRES_PASSWORD: password,
        POSTGRES_DB: database,
        PGHOST: slug,
        PGPORT: '5432',
        PGUSER: user,
        PGPASSWORD: password,
        PGDATABASE: database,
        DATABASE_URL: `postgresql://${enc(user)}:${enc(password)}@${slug}:5432/${enc(database)}`,
      };
    },
  },
  redis: {
    key: 'redis',
    label: 'Redis',
    description: 'Cache y estructuras en memoria',
    image: 'redis',
    defaultVersion: '7-alpine',
    port: 6379,
    volumePath: '/data',
    cmd: ['sh', '-c', 'redis-server --requirepass "$REDIS_PASSWORD" --appendonly yes'],
    makeEnv: (slug, existing = {}) => {
      const password = existing.REDIS_PASSWORD || randomPassword();
      return {
        REDIS_HOST: slug,
        REDIS_PORT: '6379',
        REDIS_PASSWORD: password,
        REDIS_URL: `redis://default:${enc(password)}@${slug}:6379`,
      };
    },
  },
  mysql: {
    key: 'mysql',
    label: 'MySQL',
    description: 'Base de datos relacional',
    image: 'mysql',
    defaultVersion: '8',
    port: 3306,
    volumePath: '/var/lib/mysql',
    makeEnv: (slug, existing = {}) => {
      const user = existing.MYSQL_USER || 'skyway';
      const password = existing.MYSQL_PASSWORD || randomPassword();
      const database = existing.MYSQL_DATABASE || 'skyway';
      return {
        MYSQL_ROOT_PASSWORD: existing.MYSQL_ROOT_PASSWORD || randomPassword(),
        MYSQL_DATABASE: database,
        MYSQL_USER: user,
        MYSQL_PASSWORD: password,
        MYSQL_HOST: slug,
        MYSQL_PORT: '3306',
        MYSQL_URL: `mysql://${enc(user)}:${enc(password)}@${slug}:3306/${enc(database)}`,
      };
    },
  },
  mongo: {
    key: 'mongo',
    label: 'MongoDB',
    description: 'Base de datos de documentos',
    image: 'mongo',
    defaultVersion: '7',
    port: 27017,
    volumePath: '/data/db',
    makeEnv: (slug, existing = {}) => {
      const user = existing.MONGO_INITDB_ROOT_USERNAME || 'skyway';
      const password = existing.MONGO_INITDB_ROOT_PASSWORD || randomPassword();
      return {
        MONGO_INITDB_ROOT_USERNAME: user,
        MONGO_INITDB_ROOT_PASSWORD: password,
        MONGO_HOST: slug,
        MONGO_PORT: '27017',
        MONGO_URL: `mongodb://${enc(user)}:${enc(password)}@${slug}:27017`,
      };
    },
  },
  minio: {
    key: 'minio',
    label: 'MinIO',
    description: 'Almacenamiento de objetos compatible con S3',
    image: 'minio/minio',
    defaultVersion: 'latest',
    port: 9000,
    volumePath: '/data',
    cmd: ['sh', '-c', 'minio server /data --console-address ":9001"'],
    makeEnv: (slug, existing = {}) => {
      return {
        MINIO_ROOT_USER: existing.MINIO_ROOT_USER || 'skyway',
        MINIO_ROOT_PASSWORD: existing.MINIO_ROOT_PASSWORD || randomPassword(),
        MINIO_ENDPOINT: `http://${slug}:9000`,
        MINIO_CONSOLE: `http://${slug}:9001`,
      };
    },
  },
};

/**
 * Versión efectiva con la que se elige la imagen: los servicios creados por
 * versiones antiguas de Skyway (o un PATCH con versión vacía) pueden no tener
 * `version`, y todas las decisiones que dependen de ella (tag de imagen, ruta
 * de montaje, comprobaciones del volumen) deben usar EXACTAMENTE la misma.
 */
export function effectiveDbVersion(template: DbTemplate, version: string | undefined): string {
  return (version || '').trim() || template.defaultVersion;
}

/**
 * Ruta de datos a montar según la versión. La imagen oficial de Postgres 18+
 * cambió el volumen a `/var/lib/postgresql` (los datos van en un subdirectorio
 * versionado) y **se niega a arrancar** si se monta la ruta antigua
 * `/var/lib/postgresql/data`, aunque el volumen esté vacío. Los tags sin
 * número (latest, alpine…) apuntan hoy a 18+, así que también usan la nueva.
 */
export function volumePathFor(template: DbTemplate, version: string | undefined): string {
  if (template.key !== 'postgres') return template.volumePath;
  const major = parseInt(effectiveDbVersion(template, version), 10);
  return Number.isInteger(major) && major < 18 ? template.volumePath : '/var/lib/postgresql';
}

export function getTemplate(key: string): DbTemplate | undefined {
  return DB_TEMPLATES[key];
}

export function templateList(): Omit<DbTemplate, 'makeEnv'>[] {
  return Object.values(DB_TEMPLATES).map(({ makeEnv, ...rest }) => rest);
}
