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
  /** Genera las variables del servicio (se guardan como env vars normales). */
  makeEnv: (slug: string) => Record<string, string>;
}

export const DB_TEMPLATES: Record<string, DbTemplate> = {
  postgres: {
    key: 'postgres',
    label: 'PostgreSQL',
    description: 'Base de datos relacional',
    image: 'postgres',
    defaultVersion: '16-alpine',
    port: 5432,
    volumePath: '/var/lib/postgresql/data',
    makeEnv: (slug) => {
      const password = randomPassword();
      return {
        POSTGRES_USER: 'skyway',
        POSTGRES_PASSWORD: password,
        POSTGRES_DB: 'skyway',
        PGHOST: slug,
        PGPORT: '5432',
        PGUSER: 'skyway',
        PGPASSWORD: password,
        PGDATABASE: 'skyway',
        DATABASE_URL: `postgresql://skyway:${password}@${slug}:5432/skyway`,
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
    makeEnv: (slug) => {
      const password = randomPassword();
      return {
        REDIS_HOST: slug,
        REDIS_PORT: '6379',
        REDIS_PASSWORD: password,
        REDIS_URL: `redis://default:${password}@${slug}:6379`,
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
    makeEnv: (slug) => {
      const password = randomPassword();
      const rootPassword = randomPassword();
      return {
        MYSQL_ROOT_PASSWORD: rootPassword,
        MYSQL_DATABASE: 'skyway',
        MYSQL_USER: 'skyway',
        MYSQL_PASSWORD: password,
        MYSQL_HOST: slug,
        MYSQL_PORT: '3306',
        MYSQL_URL: `mysql://skyway:${password}@${slug}:3306/skyway`,
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
    makeEnv: (slug) => {
      const password = randomPassword();
      return {
        MONGO_INITDB_ROOT_USERNAME: 'skyway',
        MONGO_INITDB_ROOT_PASSWORD: password,
        MONGO_HOST: slug,
        MONGO_PORT: '27017',
        MONGO_URL: `mongodb://skyway:${password}@${slug}:27017`,
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
    makeEnv: (slug) => {
      const password = randomPassword();
      return {
        MINIO_ROOT_USER: 'skyway',
        MINIO_ROOT_PASSWORD: password,
        MINIO_ENDPOINT: `http://${slug}:9000`,
        MINIO_CONSOLE: `http://${slug}:9001`,
      };
    },
  },
};

/**
 * Ruta de datos a montar según la versión. La imagen oficial de Postgres 18+
 * cambió el volumen a `/var/lib/postgresql` (los datos van en un subdirectorio
 * versionado) y **se niega a arrancar** si se monta la ruta antigua
 * `/var/lib/postgresql/data`. Los tags sin número (latest, alpine…) apuntan
 * hoy a 18+, así que también usan la ruta nueva.
 */
export function volumePathFor(template: DbTemplate, version: string): string {
  if (template.key !== 'postgres') return template.volumePath;
  const major = parseInt(version, 10);
  return Number.isInteger(major) && major < 18 ? template.volumePath : '/var/lib/postgresql';
}

export function getTemplate(key: string): DbTemplate | undefined {
  return DB_TEMPLATES[key];
}

export function templateList(): Omit<DbTemplate, 'makeEnv'>[] {
  return Object.values(DB_TEMPLATES).map(({ makeEnv, ...rest }) => rest);
}
