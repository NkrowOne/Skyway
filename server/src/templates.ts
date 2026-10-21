import type { DatabaseConfig, PgExtension } from './types';
import { randomPassword } from './util';

/**
 * Qué variables de conexión exporta un motor, por su papel. Es lo que permite
 * enganchar otro servicio sin saber si la URL se llama DATABASE_URL o
 * MONGO_URL: el panel («Conectar a…»), el importador de Railway y la detección
 * de dependencias leen esto, en vez de tener cada uno su propia tabla.
 */
export interface DbConn {
  /** La URL completa (el endpoint, en MinIO): lo que casi toda app necesita. */
  main: string;
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  database?: string;
  /**
   * Juego mínimo que «Conectar a…» copia como referencias en otro servicio.
   * Una URL basta en casi todo; S3 no tiene URL con credenciales y necesita tres.
   */
  connect: string[];
}

export interface DbTemplate {
  key: string;
  label: string;
  description: string;
  image: string;
  defaultVersion: string;
  port: number;
  volumePath: string;
  conn: DbConn;
  /** Extensiones que se pueden pedir al crear la base (`DatabaseConfig.extensions`). */
  extensions?: DbExtension[];
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

/** Extensión que cambia la imagen del motor (hoy, pgvector en Postgres). */
export interface DbExtension {
  key: PgExtension;
  label: string;
  description: string;
  image: string;
  /** Etiqueta de la imagen para la versión por defecto del motor. */
  defaultTag: string;
  /** Forma de la etiqueta: `{major}` es la versión mayor guardada en `version`. */
  tagTemplate: string;
}

/**
 * pgvector: la imagen oficial del proyecto (`pgvector/pgvector`), que parte de
 * la oficial de Postgres en Debian. No hay variante alpine. La etiqueta fija
 * la distribución (`pg16-trixie` y no `pg16`): la que no la lleva cambia de
 * Debian cuando lo decide el proyecto, y una glibc nueva ordena el texto de
 * otra forma e invalida los índices de un volumen ya inicializado (es lo que
 * hace también la imagen de Postgres de Railway, que trae pgvector).
 */
export const PGVECTOR = {
  image: 'pgvector/pgvector',
  distro: 'trixie',
  minMajor: 13,
  maxMajor: 18,
} as const;

/** Extensiones admitidas, en el orden en que se enseñan. */
export const PG_EXTENSIONS: readonly PgExtension[] = ['vector'];

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
    extensions: [
      {
        key: 'vector',
        label: 'PostgreSQL con pgvector',
        description: 'Búsqueda vectorial (embeddings) con la extensión vector',
        image: PGVECTOR.image,
        defaultTag: `pg16-${PGVECTOR.distro}`,
        tagTemplate: `pg{major}-${PGVECTOR.distro}`,
      },
    ],
    conn: {
      main: 'DATABASE_URL',
      host: 'PGHOST',
      port: 'PGPORT',
      user: 'PGUSER',
      password: 'PGPASSWORD',
      database: 'PGDATABASE',
      connect: ['DATABASE_URL'],
    },
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
    conn: { main: 'REDIS_URL', host: 'REDIS_HOST', port: 'REDIS_PORT', password: 'REDIS_PASSWORD', connect: ['REDIS_URL'] },
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
    conn: {
      main: 'MYSQL_URL',
      host: 'MYSQL_HOST',
      port: 'MYSQL_PORT',
      user: 'MYSQL_USER',
      password: 'MYSQL_PASSWORD',
      database: 'MYSQL_DATABASE',
      connect: ['MYSQL_URL'],
    },
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
    conn: {
      main: 'MONGO_URL',
      host: 'MONGO_HOST',
      port: 'MONGO_PORT',
      user: 'MONGO_INITDB_ROOT_USERNAME',
      password: 'MONGO_INITDB_ROOT_PASSWORD',
      connect: ['MONGO_URL'],
    },
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
    conn: {
      main: 'MINIO_ENDPOINT',
      user: 'MINIO_ROOT_USER',
      password: 'MINIO_ROOT_PASSWORD',
      connect: ['MINIO_ENDPOINT', 'MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD'],
    },
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

/** Versión mayor de una etiqueta de Postgres («16-alpine» → 16), o null si no la indica (latest, alpine). */
export function pgMajor(version: string | undefined): number | null {
  const major = parseInt((version || '').trim(), 10);
  return Number.isInteger(major) && major > 0 ? major : null;
}

/** Extensiones que pide la config de una base (solo las conocidas y solo en Postgres). */
export function dbExtensions(cfg: Pick<DatabaseConfig, 'template' | 'extensions'>): PgExtension[] {
  if (cfg.template !== 'postgres' || !Array.isArray(cfg.extensions)) return [];
  return PG_EXTENSIONS.filter((e) => cfg.extensions!.includes(e));
}

/** ¿Lleva esta base la imagen de pgvector? */
export function hasPgvector(cfg: Pick<DatabaseConfig, 'template' | 'extensions'>): boolean {
  return dbExtensions(cfg).includes('vector');
}

/**
 * Normaliza versión y extensiones de una base antes de guardarla. Con
 * pgvector la versión se guarda como su número mayor («16»): la imagen solo
 * se publica por versión mayor, y «16-alpine» diría una imagen que no es la
 * que corre. Devuelve el error para el usuario si la combinación no existe.
 */
export function normalizeDbConfig(
  template: DbTemplate,
  version: string | undefined,
  extensions: readonly string[] | undefined,
): { version: string; extensions?: PgExtension[] } | { error: string } {
  const wanted = [...new Set(extensions ?? [])];
  const allowed = (template.extensions ?? []).map((e) => e.key as string);
  const unknown = wanted.filter((e) => !allowed.includes(e));
  if (unknown.length > 0) {
    return {
      error:
        allowed.length > 0
          ? `Extensión no admitida en ${template.label}: ${unknown.join(', ')}. Valores admitidos: ${allowed.join(', ')}.`
          : `${template.label} no admite extensiones.`,
    };
  }
  const effective = effectiveDbVersion(template, version);
  if (!wanted.includes('vector')) return { version: effective };
  const major = pgMajor(effective);
  if (major === null || major < PGVECTOR.minMajor || major > PGVECTOR.maxMajor) {
    return {
      error: `pgvector está disponible para PostgreSQL ${PGVECTOR.minMajor} a ${PGVECTOR.maxMajor}: indica la versión mayor, por ejemplo «16».`,
    };
  }
  return { version: String(major), extensions: PG_EXTENSIONS.filter((e) => wanted.includes(e)) };
}

/**
 * Imagen con la que corre una base. TODO lo que arranca el motor o sus
 * herramientas (despliegue, copia de datos) la saca de aquí: si divergieran,
 * pg_dump podría ser de otra versión o faltar la extensión en el destino.
 */
export function dbImageFor(template: DbTemplate, cfg: Pick<DatabaseConfig, 'template' | 'version' | 'extensions'>): string {
  const version = effectiveDbVersion(template, cfg.version);
  if (template.key === 'postgres' && hasPgvector(cfg)) {
    // Sin número (no lo guarda `normalizeDbConfig`, pero una config antigua
    // podría): 18, la misma que supone `volumePathFor` para elegir la ruta.
    return `${PGVECTOR.image}:pg${pgMajor(version) ?? 18}-${PGVECTOR.distro}`;
  }
  return `${template.image}:${version}`;
}

/**
 * Biblioteca C de una imagen de Postgres: la que decide cómo se ordena el
 * texto (collation). Las alpine usan musl y el resto (Debian, pgvector)
 * glibc. Unos datos inicializados con una y abiertos con la otra arrancan,
 * pero los índices de las columnas de texto quedan ordenados con otra regla y
 * las búsquedas por índice dejan de encontrar filas, sin ningún error.
 */
export function postgresLibc(image: string): 'musl' | 'glibc' {
  const tag = image.slice(image.lastIndexOf('/') + 1).split(':')[1] ?? '';
  return /alpine/i.test(tag) ? 'musl' : 'glibc';
}

/**
 * Por qué no se puede pasar una base con datos de `previous` (la imagen de su
 * último despliegue correcto) a `next`, o null si se puede. Lo comparten
 * Ajustes (que lo rechaza al guardar) y el despliegue (que lo comprueba con el
 * volumen): un cambio de musl a glibc, o al revés, deja los índices de texto
 * ordenados con otra regla. Copiar los datos con un volcado sí es seguro,
 * porque la restauración reconstruye los índices.
 */
export function libcChangeError(previous: string | null, next: string): string | null {
  if (!previous || postgresLibc(previous) === postgresLibc(next)) return null;
  return (
    `Los datos de esta base se escribieron con ${previous} y la nueva configuración usa ${next}: ` +
    'una imagen usa musl (alpine) y la otra glibc (Debian), que ordenan el texto de forma distinta, y los índices de las columnas de texto dejarían de ser válidos. ' +
    'Para cambiar de imagen, crea una base nueva con la configuración que necesitas y copia los datos con «Copiar datos» ' +
    '(la restauración reconstruye los índices), o elimina esta base con su volumen y vuelve a crearla para empezar de cero.'
  );
}

export function getTemplate(key: string): DbTemplate | undefined {
  return DB_TEMPLATES[key];
}

export function templateList(): Omit<DbTemplate, 'makeEnv'>[] {
  return Object.values(DB_TEMPLATES).map(({ makeEnv, ...rest }) => rest);
}
