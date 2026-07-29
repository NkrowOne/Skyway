import crypto from 'crypto';
import jwt from 'jsonwebtoken';

/**
 * Pilas de aplicaciones: plantillas que despliegan VARIOS servicios coordinados
 * (como el catálogo de bases de datos, pero para aplicaciones completas).
 *
 * Cada pila declara sus servicios, los secretos que hay que generar una vez y el
 * orden de arranque. Los valores se escriben con marcadores que se resuelven al
 * crear la pila:
 *
 *   {{svc:clave}}       → slug real del servicio hermano (su nombre DNS en la red)
 *   {{secret:CLAVE}}    → referencia `${{slugAncla.CLAVE}}` a un secreto de la
 *                         pila (Skyway la expande al desplegar)
 *   {{ref:clave.VAR}}   → referencia `${{slug.VAR}}` a una variable de otro
 *                         servicio de la pila (p. ej. la contraseña que generó
 *                         la plantilla de base de datos)
 *   {{url}}             → URL pública de la pila (https://dominio, o la interna)
 *   {{domain}}          → dominio público; si no hay dominio, la variable que lo
 *                         use se omite en vez de quedarse vacía
 *
 * La doble indirección es deliberada: los secretos viven UNA sola vez, en las
 * variables de un servicio «ancla» de la propia pila, y el resto los referencia.
 * Rotar uno es editarlo ahí y redesplegar. NO van a las variables compartidas
 * del proyecto: esas se inyectan en el entorno de TODOS los servicios, también
 * en los que el usuario despliegue después, y una clave `service_role` (que se
 * salta el RLS) o la contraseña de superusuario de Postgres no tienen por qué
 * acabar dentro de una imagen de terceros.
 */

/** Marca con la que la UI pinta cada servicio (clave de ModuleIcon en el front). */
export type StackIcon =
  | 'supabase'
  | 'postgres'
  | 'kong'
  | 'mysql'
  | 'wordpress'
  | 'ghost'
  | 'n8n'
  | 'metabase'
  | 'docker';

export interface StackServiceDef {
  /** Sufijo del nombre y del slug dentro de la pila (`<prefijo>-<key>`). */
  key: string;
  /** Qué hace este servicio (se muestra en la tarjeta del catálogo). */
  description: string;
  icon: StackIcon;
  /** Servicios de imagen: imagen con tag exacto. */
  image?: string;
  /** Servicios de base de datos gestionada: clave de DB_TEMPLATES. */
  template?: string;
  version?: string;
  /** Puerto interno que escucha (null = proceso sin puerto). */
  port?: number;
  /** Volúmenes por clave lógica: la misma clave en dos servicios comparte volumen. */
  volumes?: { key: string; path: string }[];
  env?: Record<string, string>;
  /** Etapa de arranque: se despliegan en orden ascendente, en paralelo dentro de la etapa. */
  stage: number;
  /** Comando dentro del contenedor que debe salir 0 para darlo por listo. */
  readyCmd?: string;
  /** Servicio que recibe el dominio público de la pila. */
  public?: boolean;
}

export interface StackDef {
  key: string;
  label: string;
  /** Resumen de una línea para la tarjeta del catálogo. */
  description: string;
  icon: StackIcon;
  /** Logos de la tarjeta (además del principal). */
  logos: StackIcon[];
  docsUrl: string;
  /** RAM orientativa que conviene tener libre, en MB. */
  memoryHintMb: number;
  /** Avisos que la UI muestra ANTES de crear la pila. */
  notes: string[];
  /** Prefijo por defecto de los nombres de servicio. */
  defaultPrefix: string;
  services: StackServiceDef[];
  /** Secretos y ajustes comunes de la pila, generados una vez al crearla. */
  makeSecrets: () => Record<string, string>;
  /**
   * Clave del servicio que guarda esos secretos en SUS variables. Es el que
   * los referencia todo el mundo con `{{secret:...}}`, así que conviene el más
   * confiable de la pila (la base de datos) y el que nunca falta.
   */
  secretsService: string;
  /**
   * SQL que se aplica una vez la base esté aceptando conexiones. Se ejecuta con
   * psql DENTRO del contenedor, así que puede leer sus propias variables de
   * entorno (`\set x \`echo "$VAR"\``) y ningún secreto sale del contenedor.
   * `user` es el rol con el que conectar: no siempre vale el obvio.
   */
  postInit?: { service: string; user: string; sql: string; description: string };
}

// ---------- generación de secretos ----------

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Cadena alfanumérica de longitud EXACTA (hay secretos con longitud obligatoria). */
function alnum(length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const TEN_YEARS_SECONDS = 60 * 60 * 24 * 365 * 10;

/**
 * Claves de API de Supabase: JWT HS256 firmados con el mismo JWT_SECRET que
 * usan GoTrue y PostgREST, con el payload que espera la pila (`role` + `iss`).
 */
function supabaseApiKey(jwtSecret: string, role: 'anon' | 'service_role'): string {
  const iat = Math.floor(Date.now() / 1000);
  return jwt.sign({ role, iss: 'supabase', iat, exp: iat + TEN_YEARS_SECONDS }, jwtSecret, {
    algorithm: 'HS256',
  });
}

// ---------- render de marcadores ----------

export interface StackRenderCtx {
  /** Slug real de cada servicio de la pila, por clave. */
  slugs: Record<string, string>;
  /** Slug del servicio que guarda los secretos. */
  secretsSlug: string;
  publicUrl: string;
  domain: string | null;
}

function renderStackValue(value: string, ctx: StackRenderCtx): string {
  return value
    .replace(/\{\{ref:([a-z0-9-]+)\.([A-Za-z0-9_]+)\}\}/g, (m, key, varName) =>
      ctx.slugs[key] ? `\${{${ctx.slugs[key]}.${varName}}}` : m,
    )
    .replace(/\{\{svc:([a-z0-9-]+)\}\}/g, (m, key) => ctx.slugs[key] ?? m)
    .replace(/\{\{secret:([A-Z0-9_]+)\}\}/g, (_m, key) => `\${{${ctx.secretsSlug}.${key}}}`)
    .replace(/\{\{url\}\}/g, ctx.publicUrl)
    .replace(/\{\{domain\}\}/g, ctx.domain ?? '');
}

/**
 * Entorno de un servicio de la pila ya resuelto. Las variables que dependen del
 * dominio se OMITEN cuando la pila se crea sin él: dejarlas vacías es peor que
 * no ponerlas (n8n con `N8N_HOST=` se anuncia en un host vacío).
 */
export function renderStackEnv(env: Record<string, string>, ctx: StackRenderCtx): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(env)) {
    if (!ctx.domain && raw.includes('{{domain}}')) continue;
    out[key] = renderStackValue(raw, ctx);
  }
  return out;
}

// ---------- Supabase ----------

/**
 * Configuración declarativa de Kong (modo DB-less), equivalente a la
 * `volumes/api/kong.yml` del compose oficial: consumidores anon/service_role
 * con sus claves, ACLs y el enrutado de /auth /rest /graphql /realtime /storage
 * /pg y el Studio en la raíz, protegido con basic-auth.
 *
 * Se omiten las rutas de Edge Functions y de analytics (esos servicios no
 * forman parte de la pila) y las transformaciones Lua de las claves opacas
 * `sb_`, que solo aplican al esquema de claves asimétricas.
 *
 * Los secretos van en escalares de bloque (`|-`) y no entrecomillados: su valor
 * se sustituye al desplegar, cuando ya no hay ocasión de escaparlo, y ahí una
 * comilla en una contraseña rotada a mano rompería el YAML —o peor, colaría
 * entradas nuevas en la configuración—. En un bloque literal no hay nada que
 * escapar.
 */
const SUPABASE_KONG_YML = `_format_version: '2.1'
_transform: true

consumers:
  - username: DASHBOARD
  - username: anon
    keyauth_credentials:
      - key: |-
          {{secret:ANON_KEY}}
  - username: service_role
    keyauth_credentials:
      - key: |-
          {{secret:SERVICE_ROLE_KEY}}

acls:
  - consumer: anon
    group: anon
  - consumer: service_role
    group: admin

basicauth_credentials:
  - consumer: DASHBOARD
    username: |-
      {{secret:DASHBOARD_USERNAME}}
    password: |-
      {{secret:DASHBOARD_PASSWORD}}

services:
  - name: auth-v1-open
    url: http://{{svc:auth}}:9999/verify
    routes:
      - name: auth-v1-open
        strip_path: true
        paths:
          - /auth/v1/verify
    plugins:
      - name: cors
  - name: auth-v1-open-callback
    url: http://{{svc:auth}}:9999/callback
    routes:
      - name: auth-v1-open-callback
        strip_path: true
        paths:
          - /auth/v1/callback
    plugins:
      - name: cors
  - name: auth-v1-open-authorize
    url: http://{{svc:auth}}:9999/authorize
    routes:
      - name: auth-v1-open-authorize
        strip_path: true
        paths:
          - /auth/v1/authorize
    plugins:
      - name: cors
  - name: auth-v1
    url: http://{{svc:auth}}:9999/
    routes:
      - name: auth-v1-all
        strip_path: true
        paths:
          - /auth/v1/
    plugins:
      - name: cors
      - name: key-auth
        config:
          hide_credentials: false
      - name: acl
        config:
          hide_groups_header: true
          allow:
            - admin
            - anon
  - name: rest-v1
    url: http://{{svc:rest}}:3000/
    routes:
      - name: rest-v1-all
        strip_path: true
        paths:
          - /rest/v1/
    plugins:
      - name: cors
      - name: key-auth
        config:
          hide_credentials: true
      - name: acl
        config:
          hide_groups_header: true
          allow:
            - admin
            - anon
  - name: graphql-v1
    url: http://{{svc:rest}}:3000/rpc/graphql
    routes:
      - name: graphql-v1-all
        strip_path: true
        paths:
          - /graphql/v1
    plugins:
      - name: cors
      - name: key-auth
        config:
          hide_credentials: true
      - name: request-transformer
        config:
          add:
            headers:
              - 'Content-Profile: graphql_public'
      - name: acl
        config:
          hide_groups_header: true
          allow:
            - admin
            - anon
  - name: realtime-v1-ws
    url: http://{{svc:realtime}}:4000/socket
    protocol: ws
    routes:
      - name: realtime-v1-ws
        strip_path: true
        paths:
          - /realtime/v1/
    plugins:
      - name: cors
      - name: key-auth
        config:
          hide_credentials: false
      - name: acl
        config:
          hide_groups_header: true
          allow:
            - admin
            - anon
  - name: realtime-v1-rest
    url: http://{{svc:realtime}}:4000/api
    protocol: http
    routes:
      - name: realtime-v1-rest
        strip_path: true
        paths:
          - /realtime/v1/api
    plugins:
      - name: cors
      - name: key-auth
        config:
          hide_credentials: false
      - name: acl
        config:
          hide_groups_header: true
          allow:
            - admin
            - anon
  - name: storage-v1
    url: http://{{svc:storage}}:5000/
    routes:
      - name: storage-v1-all
        strip_path: true
        paths:
          - /storage/v1/
    plugins:
      - name: cors
  - name: meta
    url: http://{{svc:meta}}:8080/
    routes:
      - name: meta-all
        strip_path: true
        paths:
          - /pg/
    plugins:
      - name: key-auth
        config:
          hide_credentials: false
      - name: acl
        config:
          hide_groups_header: true
          allow:
            - admin
  - name: dashboard
    url: http://{{svc:studio}}:3000/
    routes:
      - name: dashboard-all
        strip_path: true
        paths:
          - /
    plugins:
      - name: cors
      - name: basic-auth
        config:
          hide_credentials: true
`;

/**
 * Equivalente a los `volumes/db/*.sql` del compose oficial que SÍ hacen falta
 * para esta pila: contraseñas reales de los roles que trae la imagen (roles.sql),
 * esquema `_realtime` (realtime.sql) y los GUC de JWT (jwt.sql). Se omiten
 * `_supabase.sql`, `logs.sql` y `pooler.sql`, que solo sirven a analytics y al
 * pooler. Es idempotente a propósito: se aplica en cada despliegue de la pila.
 */
const SUPABASE_INIT_SQL = `\\set pgpass \`echo "$POSTGRES_PASSWORD"\`
\\set jwt_secret \`echo "$JWT_SECRET"\`
\\set jwt_exp \`echo "$JWT_EXP"\`

-- roles.sql: la imagen crea estos roles con contraseñas de plantilla. El valor
-- viaja por un GUC de sesión porque una variable de psql no se interpola dentro
-- del cuerpo del DO; el bucle salta los roles que una imagen futura no traiga.
SELECT set_config('skyway.pgpass', :'pgpass', false);
DO $skyway$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'authenticator', 'pgbouncer', 'supabase_auth_admin',
    'supabase_functions_admin', 'supabase_storage_admin'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('ALTER ROLE %I WITH PASSWORD %L', role_name, current_setting('skyway.pgpass'));
    END IF;
  END LOOP;
END
$skyway$;

-- realtime.sql: el esquema donde realtime guarda su estado (la imagen trae
-- «realtime», pero no «_realtime»), con el mismo propietario que el oficial.
CREATE SCHEMA IF NOT EXISTS _realtime;
ALTER SCHEMA _realtime OWNER TO supabase_admin;

-- pg_graphql da el esquema graphql_public que PostgREST espera en
-- PGRST_DB_SCHEMAS. Las imágenes recientes ya no lo activan solas, y si la
-- extensión no estuviera disponible preferimos un aviso a abortar el resto.
DO $skyway$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_graphql;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_graphql no disponible (%): la API GraphQL quedará desactivada', SQLERRM;
END
$skyway$;

-- jwt.sql: ajustes legacy que consultan las funciones SQL de Supabase.
ALTER DATABASE postgres SET "app.settings.jwt_secret" TO :'jwt_secret';
ALTER DATABASE postgres SET "app.settings.jwt_exp" TO :'jwt_exp';
`;

const SUPABASE: StackDef = {
  key: 'supabase',
  label: 'Supabase',
  description: 'Postgres con API REST y GraphQL, autenticación, realtime, almacenamiento y el panel Studio.',
  icon: 'supabase',
  logos: ['supabase', 'postgres', 'kong'],
  docsUrl: 'https://supabase.com/docs/guides/self-hosting/docker',
  memoryHintMb: 4096,
  defaultPrefix: 'supabase',
  notes: [
    'Son 9 contenedores: cuenta con unos 4 GB de RAM libres y varios GB de disco.',
    'El Studio y toda la API salen por el servicio «kong»: es el único que lleva dominio.',
    'El acceso al Studio va protegido con usuario y contraseña: las variables DASHBOARD_* del servicio «db».',
    'El alta pública de usuarios viene CERRADA: créalos desde el Studio, o pon GOTRUE_DISABLE_SIGNUP a false en el servicio «auth» cuando tu aplicación lo necesite.',
    'No incluye Edge Functions (necesita montar el código de las funciones), el pooler ni analytics: se conecta directo a la base.',
  ],
  makeSecrets: () => {
    // El secreto JWT firma las claves de API: debe generarse antes que ellas.
    const jwtSecret = alnum(48);
    return {
      POSTGRES_PASSWORD: alnum(32),
      JWT_SECRET: jwtSecret,
      JWT_EXPIRY: '3600',
      ANON_KEY: supabaseApiKey(jwtSecret, 'anon'),
      SERVICE_ROLE_KEY: supabaseApiKey(jwtSecret, 'service_role'),
      DASHBOARD_USERNAME: 'supabase',
      DASHBOARD_PASSWORD: alnum(20),
      SECRET_KEY_BASE: alnum(64),
      // Longitudes obligatorias: 16 (clave AES de realtime) y 32 (cifrado de pg-meta).
      REALTIME_DB_ENC_KEY: alnum(16),
      PG_META_CRYPTO_KEY: alnum(32),
      S3_PROTOCOL_ACCESS_KEY_ID: alnum(32),
      S3_PROTOCOL_ACCESS_KEY_SECRET: alnum(64),
    };
  },
  secretsService: 'db',
  postInit: {
    service: 'db',
    // supabase_admin, NO postgres: la imagen degrada a postgres a NOSUPERUSER
    // durante su propia inicialización, y supautils prohíbe a quien no sea
    // superusuario tocar los roles reservados (authenticator, supabase_*).
    // El pg_hba de la imagen confía en supabase_admin por el socket local.
    user: 'supabase_admin',
    sql: SUPABASE_INIT_SQL,
    description: 'roles de Supabase, esquema _realtime y ajustes de JWT',
  },
  services: [
    {
      key: 'db',
      description: 'PostgreSQL con las extensiones de Supabase',
      icon: 'postgres',
      image: 'supabase/postgres:17.6.1.136',
      port: 5432,
      stage: 0,
      volumes: [
        { key: 'db', path: '/var/lib/postgresql/data' },
        // Volumen aparte, como en el compose oficial: aquí viven supautils.conf
        // y la clave raíz de pgsodium. Si no persistiera, cada reinicio
        // regeneraría esa clave y el Vault dejaría de descifrar sus secretos.
        { key: 'db-config', path: '/etc/postgresql-custom' },
      ],
      readyCmd: 'pg_isready -h 127.0.0.1 -U postgres -d postgres',
      env: {
        POSTGRES_HOST: '/var/run/postgresql',
        PGPORT: '5432',
        POSTGRES_PORT: '5432',
        PGPASSWORD: '{{secret:POSTGRES_PASSWORD}}',
        POSTGRES_PASSWORD: '{{secret:POSTGRES_PASSWORD}}',
        PGDATABASE: 'postgres',
        POSTGRES_DB: 'postgres',
        JWT_SECRET: '{{secret:JWT_SECRET}}',
        JWT_EXP: '{{secret:JWT_EXPIRY}}',
      },
    },
    {
      key: 'rest',
      description: 'PostgREST: la API REST y GraphQL sobre tus tablas',
      icon: 'supabase',
      image: 'postgrest/postgrest:v14.12',
      port: 3000,
      stage: 1,
      env: {
        PGRST_DB_URI: 'postgres://authenticator:{{secret:POSTGRES_PASSWORD}}@{{svc:db}}:5432/postgres',
        PGRST_DB_SCHEMAS: 'public,graphql_public',
        PGRST_DB_ANON_ROLE: 'anon',
        PGRST_DB_MAX_ROWS: '1000',
        PGRST_DB_EXTRA_SEARCH_PATH: 'public',
        PGRST_JWT_SECRET: '{{secret:JWT_SECRET}}',
        PGRST_DB_USE_LEGACY_GUCS: 'false',
        PGRST_APP_SETTINGS_JWT_SECRET: '{{secret:JWT_SECRET}}',
        PGRST_APP_SETTINGS_JWT_EXP: '{{secret:JWT_EXPIRY}}',
        PGRST_ADMIN_SERVER_PORT: '3001',
        PGRST_ADMIN_SERVER_HOST: 'localhost',
      },
    },
    {
      key: 'auth',
      description: 'GoTrue: registro, login, OAuth y recuperación de contraseña',
      icon: 'supabase',
      image: 'supabase/gotrue:v2.189.0',
      port: 9999,
      stage: 1,
      env: {
        GOTRUE_API_HOST: '0.0.0.0',
        GOTRUE_API_PORT: '9999',
        API_EXTERNAL_URL: '{{url}}/auth/v1',
        GOTRUE_DB_DRIVER: 'postgres',
        GOTRUE_DB_DATABASE_URL:
          'postgres://supabase_auth_admin:{{secret:POSTGRES_PASSWORD}}@{{svc:db}}:5432/postgres',
        GOTRUE_SITE_URL: '{{url}}',
        GOTRUE_URI_ALLOW_LIST: '',
        // El endpoint /auth/v1/signup queda publicado en internet en cuanto la
        // pila tiene dominio: abierto de fábrica, cualquiera se daría de alta
        // con el correo que quisiera (y autoconfirmado, ya verificado de cara a
        // las políticas RLS). Se abre a conciencia, no por defecto.
        GOTRUE_DISABLE_SIGNUP: 'true',
        GOTRUE_JWT_ADMIN_ROLES: 'service_role',
        GOTRUE_JWT_AUD: 'authenticated',
        GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
        GOTRUE_JWT_EXP: '{{secret:JWT_EXPIRY}}',
        GOTRUE_JWT_SECRET: '{{secret:JWT_SECRET}}',
        GOTRUE_JWT_ISSUER: '{{url}}/auth/v1',
        GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true',
        GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: 'false',
        // Sin SMTP configurado nadie podría confirmar su correo: se autoconfirma
        // hasta que se rellenen las GOTRUE_SMTP_* y se ponga esto a false.
        GOTRUE_MAILER_AUTOCONFIRM: 'true',
        GOTRUE_SMTP_ADMIN_EMAIL: '',
        GOTRUE_SMTP_HOST: '',
        GOTRUE_SMTP_PORT: '587',
        GOTRUE_SMTP_USER: '',
        GOTRUE_SMTP_PASS: '',
        GOTRUE_SMTP_SENDER_NAME: '',
        GOTRUE_MAILER_URLPATHS_INVITE: '/auth/v1/verify',
        GOTRUE_MAILER_URLPATHS_CONFIRMATION: '/auth/v1/verify',
        GOTRUE_MAILER_URLPATHS_RECOVERY: '/auth/v1/verify',
        GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: '/auth/v1/verify',
        GOTRUE_EXTERNAL_PHONE_ENABLED: 'false',
        GOTRUE_SMS_AUTOCONFIRM: 'true',
      },
    },
    {
      key: 'realtime',
      description: 'Cambios en vivo por WebSocket (broadcast, presence, CDC)',
      icon: 'supabase',
      image: 'supabase/realtime:v2.102.3',
      port: 4000,
      stage: 1,
      env: {
        PORT: '4000',
        DB_HOST: '{{svc:db}}',
        DB_PORT: '5432',
        DB_USER: 'supabase_admin',
        DB_PASSWORD: '{{secret:POSTGRES_PASSWORD}}',
        DB_NAME: 'postgres',
        DB_AFTER_CONNECT_QUERY: 'SET search_path TO _realtime',
        DB_ENC_KEY: '{{secret:REALTIME_DB_ENC_KEY}}',
        API_JWT_SECRET: '{{secret:JWT_SECRET}}',
        METRICS_JWT_SECRET: '{{secret:JWT_SECRET}}',
        SECRET_KEY_BASE: '{{secret:SECRET_KEY_BASE}}',
        ERL_AFLAGS: '-proto_dist inet_tcp',
        DNS_NODES: "''",
        RLIMIT_NOFILE: '10000',
        APP_NAME: 'realtime',
        SEED_SELF_HOST: 'true',
        // Realtime deduce el «tenant» del primer tramo del Host con el que le
        // llaman, que aquí es el slug del servicio. El compose oficial lo
        // resuelve bautizando el contenedor «realtime-dev.supabase-realtime»;
        // sembrar el tenant con nuestro slug es equivalente y menos críptico.
        SELF_HOST_TENANT_NAME: '{{svc:realtime}}',
        RUN_JANITOR: 'true',
        DISABLE_HEALTHCHECK_LOGGING: 'true',
      },
    },
    {
      key: 'meta',
      description: 'postgres-meta: el API que el Studio usa para leer el esquema',
      icon: 'supabase',
      image: 'supabase/postgres-meta:v0.96.6',
      port: 8080,
      stage: 1,
      env: {
        PG_META_PORT: '8080',
        PG_META_DB_HOST: '{{svc:db}}',
        PG_META_DB_PORT: '5432',
        PG_META_DB_NAME: 'postgres',
        PG_META_DB_USER: 'postgres',
        PG_META_DB_PASSWORD: '{{secret:POSTGRES_PASSWORD}}',
        CRYPTO_KEY: '{{secret:PG_META_CRYPTO_KEY}}',
      },
    },
    {
      key: 'imgproxy',
      description: 'Transformación de imágenes para Storage',
      icon: 'docker',
      image: 'darthsim/imgproxy:v3.30.1',
      port: 5001,
      stage: 1,
      volumes: [{ key: 'storage', path: '/var/lib/storage' }],
      env: {
        IMGPROXY_BIND: ':5001',
        IMGPROXY_LOCAL_FILESYSTEM_ROOT: '/',
        IMGPROXY_USE_ETAG: 'true',
        IMGPROXY_AUTO_WEBP: 'true',
        IMGPROXY_MAX_SRC_RESOLUTION: '16.8',
      },
    },
    {
      key: 'storage',
      description: 'Almacenamiento de ficheros con permisos por fila',
      icon: 'supabase',
      image: 'supabase/storage-api:v1.60.4',
      port: 5000,
      stage: 2,
      // El mismo volumen que imgproxy: uno escribe los ficheros y el otro los lee.
      volumes: [{ key: 'storage', path: '/var/lib/storage' }],
      env: {
        ANON_KEY: '{{secret:ANON_KEY}}',
        SERVICE_KEY: '{{secret:SERVICE_ROLE_KEY}}',
        POSTGREST_URL: 'http://{{svc:rest}}:3000',
        AUTH_JWT_SECRET: '{{secret:JWT_SECRET}}',
        DATABASE_URL:
          'postgres://supabase_storage_admin:{{secret:POSTGRES_PASSWORD}}@{{svc:db}}:5432/postgres',
        STORAGE_PUBLIC_URL: '{{url}}',
        REQUEST_ALLOW_X_FORWARDED_PATH: 'true',
        FILE_SIZE_LIMIT: '52428800',
        STORAGE_BACKEND: 'file',
        FILE_STORAGE_BACKEND_PATH: '/var/lib/storage',
        GLOBAL_S3_BUCKET: 'stub',
        TENANT_ID: 'stub',
        REGION: 'stub',
        ENABLE_IMAGE_TRANSFORMATION: 'true',
        IMGPROXY_URL: 'http://{{svc:imgproxy}}:5001',
        S3_PROTOCOL_ACCESS_KEY_ID: '{{secret:S3_PROTOCOL_ACCESS_KEY_ID}}',
        S3_PROTOCOL_ACCESS_KEY_SECRET: '{{secret:S3_PROTOCOL_ACCESS_KEY_SECRET}}',
      },
    },
    {
      key: 'studio',
      description: 'Studio: el panel de tablas, SQL, auth y storage',
      icon: 'supabase',
      image: 'supabase/studio:2026.07.07-sha-a6a04f2',
      port: 3000,
      stage: 2,
      env: {
        HOSTNAME: '0.0.0.0',
        STUDIO_PG_META_URL: 'http://{{svc:meta}}:8080',
        POSTGRES_HOST: '{{svc:db}}',
        POSTGRES_PORT: '5432',
        POSTGRES_DB: 'postgres',
        POSTGRES_PASSWORD: '{{secret:POSTGRES_PASSWORD}}',
        POSTGRES_USER_READ_WRITE: 'postgres',
        PG_META_CRYPTO_KEY: '{{secret:PG_META_CRYPTO_KEY}}',
        PGRST_DB_SCHEMAS: 'public,graphql_public',
        PGRST_DB_MAX_ROWS: '1000',
        PGRST_DB_EXTRA_SEARCH_PATH: 'public',
        DEFAULT_ORGANIZATION_NAME: 'Default Organization',
        DEFAULT_PROJECT_NAME: 'Default Project',
        SUPABASE_URL: 'http://{{svc:kong}}:8000',
        SUPABASE_PUBLIC_URL: '{{url}}',
        SUPABASE_ANON_KEY: '{{secret:ANON_KEY}}',
        SUPABASE_SERVICE_KEY: '{{secret:SERVICE_ROLE_KEY}}',
        AUTH_JWT_SECRET: '{{secret:JWT_SECRET}}',
        ENABLED_FEATURES_LOGS_ALL: 'false',
      },
    },
    {
      key: 'kong',
      description: 'Puerta de entrada: enruta /rest, /auth, /storage y el Studio',
      icon: 'kong',
      image: 'kong/kong:3.9.1',
      port: 8000,
      // El último: el compose oficial también lo arranca al final, y Kong sin
      // base de datos no reintenta la resolución DNS con mucho empeño.
      stage: 3,
      public: true,
      env: {
        KONG_DATABASE: 'off',
        // Kong admite la configuración declarativa como cadena, sin fichero:
        // así no hacen falta bind mounts (que aquí no existen) ni el script de
        // sustitución del compose oficial, porque el YAML ya viene resuelto.
        KONG_DECLARATIVE_CONFIG_STRING: SUPABASE_KONG_YML,
        KONG_DNS_ORDER: 'LAST,A,CNAME',
        KONG_DNS_NOT_FOUND_TTL: '1',
        KONG_PLUGINS: 'request-transformer,cors,key-auth,acl,basic-auth',
        KONG_NGINX_PROXY_PROXY_BUFFER_SIZE: '160k',
        KONG_NGINX_PROXY_PROXY_BUFFERS: '64 160k',
        KONG_PROXY_ACCESS_LOG: '/dev/stdout combined',
      },
    },
  ],
};

// ---------- pilas de aplicación clásicas ----------

const WORDPRESS: StackDef = {
  key: 'wordpress',
  label: 'WordPress + MySQL',
  description: 'WordPress con su base de datos MySQL gestionada por Skyway.',
  icon: 'wordpress',
  logos: ['wordpress', 'mysql'],
  docsUrl: 'https://hub.docker.com/_/wordpress',
  memoryHintMb: 1024,
  defaultPrefix: 'wordpress',
  notes: [
    'La base de datos es un servicio de Skyway: tiene copias de seguridad y consola de datos.',
    'Los ficheros de WordPress (temas, plugins, subidas) viven en un volumen propio.',
  ],
  makeSecrets: () => ({}),
  secretsService: 'app',
  services: [
    {
      key: 'db',
      description: 'MySQL gestionado',
      icon: 'mysql',
      template: 'mysql',
      version: '8',
      stage: 0,
      readyCmd: 'mysqladmin ping -h 127.0.0.1 -u root -p"$MYSQL_ROOT_PASSWORD" --silent',
    },
    {
      key: 'app',
      description: 'WordPress con Apache y PHP 8.3',
      icon: 'wordpress',
      image: 'wordpress:6-php8.3-apache',
      port: 80,
      stage: 1,
      public: true,
      volumes: [{ key: 'html', path: '/var/www/html' }],
      env: {
        WORDPRESS_DB_HOST: '{{svc:db}}:3306',
        WORDPRESS_DB_USER: '{{ref:db.MYSQL_USER}}',
        WORDPRESS_DB_PASSWORD: '{{ref:db.MYSQL_PASSWORD}}',
        WORDPRESS_DB_NAME: '{{ref:db.MYSQL_DATABASE}}',
      },
    },
  ],
};

const GHOST: StackDef = {
  key: 'ghost',
  label: 'Ghost + MySQL',
  description: 'Ghost, la plataforma de publicación y newsletters, con MySQL.',
  icon: 'ghost',
  logos: ['ghost', 'mysql'],
  docsUrl: 'https://ghost.org/docs/install/docker/',
  memoryHintMb: 1024,
  defaultPrefix: 'ghost',
  notes: [
    'Ghost necesita saber su URL pública: si cambias el dominio, actualiza la variable «url» y redespliega.',
    'Para enviar correos hay que configurar las variables mail__* del servicio.',
  ],
  makeSecrets: () => ({}),
  secretsService: 'app',
  services: [
    {
      key: 'db',
      description: 'MySQL gestionado',
      icon: 'mysql',
      template: 'mysql',
      version: '8',
      stage: 0,
      readyCmd: 'mysqladmin ping -h 127.0.0.1 -u root -p"$MYSQL_ROOT_PASSWORD" --silent',
    },
    {
      key: 'app',
      description: 'Ghost 5',
      icon: 'ghost',
      image: 'ghost:5-alpine',
      port: 2368,
      stage: 1,
      public: true,
      volumes: [{ key: 'content', path: '/var/lib/ghost/content' }],
      env: {
        url: '{{url}}',
        NODE_ENV: 'production',
        database__client: 'mysql',
        database__connection__host: '{{svc:db}}',
        database__connection__port: '3306',
        database__connection__user: '{{ref:db.MYSQL_USER}}',
        database__connection__password: '{{ref:db.MYSQL_PASSWORD}}',
        database__connection__database: '{{ref:db.MYSQL_DATABASE}}',
      },
    },
  ],
};

const N8N: StackDef = {
  key: 'n8n',
  label: 'n8n + PostgreSQL',
  description: 'Automatizaciones y flujos de trabajo con su base de datos Postgres.',
  icon: 'n8n',
  logos: ['n8n', 'postgres'],
  docsUrl: 'https://docs.n8n.io/hosting/installation/docker/',
  memoryHintMb: 1024,
  defaultPrefix: 'n8n',
  notes: [
    'La clave de cifrado de credenciales se genera al crear la pila: si la pierdes, las credenciales guardadas dejan de poder descifrarse.',
    'Los webhooks usan la URL pública: sin dominio, solo funcionan dentro del proyecto.',
  ],
  makeSecrets: () => ({ ENCRYPTION_KEY: alnum(48) }),
  secretsService: 'app',
  services: [
    {
      key: 'db',
      description: 'PostgreSQL gestionado',
      icon: 'postgres',
      template: 'postgres',
      version: '16-alpine',
      stage: 0,
      readyCmd: 'pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
    },
    {
      key: 'app',
      description: 'n8n',
      icon: 'n8n',
      image: 'n8nio/n8n:latest',
      port: 5678,
      stage: 1,
      public: true,
      // Sin healthcheck a propósito: la primera arrancada migra la base y puede
      // pasarse del minuto que espera la sonda, que daría el despliegue por malo.
      volumes: [{ key: 'data', path: '/home/node/.n8n' }],
      env: {
        DB_TYPE: 'postgresdb',
        DB_POSTGRESDB_HOST: '{{svc:db}}',
        DB_POSTGRESDB_PORT: '5432',
        DB_POSTGRESDB_DATABASE: '{{ref:db.POSTGRES_DB}}',
        DB_POSTGRESDB_USER: '{{ref:db.POSTGRES_USER}}',
        DB_POSTGRESDB_PASSWORD: '{{ref:db.POSTGRES_PASSWORD}}',
        N8N_ENCRYPTION_KEY: '{{secret:ENCRYPTION_KEY}}',
        N8N_PORT: '5678',
        N8N_PROTOCOL: 'http',
        N8N_HOST: '{{domain}}',
        WEBHOOK_URL: '{{url}}/',
        GENERIC_TIMEZONE: 'Europe/Madrid',
        N8N_RUNNERS_ENABLED: 'true',
      },
    },
  ],
};

const METABASE: StackDef = {
  key: 'metabase',
  label: 'Metabase + PostgreSQL',
  description: 'Cuadros de mando y consultas sobre tus datos, con Postgres de respaldo.',
  icon: 'metabase',
  logos: ['metabase', 'postgres'],
  docsUrl: 'https://www.metabase.com/docs/latest/installation-and-operation/running-metabase-on-docker',
  memoryHintMb: 2048,
  defaultPrefix: 'metabase',
  notes: [
    'El Postgres de la pila es el almacén interno de Metabase, no la fuente de datos que vas a analizar.',
    'El primer arranque tarda un par de minutos: Metabase crea su esquema antes de responder.',
  ],
  makeSecrets: () => ({}),
  secretsService: 'app',
  services: [
    {
      key: 'db',
      description: 'PostgreSQL gestionado (metadatos de Metabase)',
      icon: 'postgres',
      template: 'postgres',
      version: '16-alpine',
      stage: 0,
      readyCmd: 'pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
    },
    {
      key: 'app',
      description: 'Metabase',
      icon: 'metabase',
      image: 'metabase/metabase:latest',
      port: 3000,
      stage: 1,
      public: true,
      env: {
        MB_DB_TYPE: 'postgres',
        MB_DB_HOST: '{{svc:db}}',
        MB_DB_PORT: '5432',
        MB_DB_DBNAME: '{{ref:db.POSTGRES_DB}}',
        MB_DB_USER: '{{ref:db.POSTGRES_USER}}',
        MB_DB_PASS: '{{ref:db.POSTGRES_PASSWORD}}',
        MB_JETTY_PORT: '3000',
      },
    },
  ],
};

export const STACKS: StackDef[] = [SUPABASE, WORDPRESS, GHOST, N8N, METABASE];

export function getStack(key: string): StackDef | undefined {
  return STACKS.find((s) => s.key === key);
}

/** Catálogo para la UI: sin funciones ni secretos, solo lo que se pinta. */
export function stackList() {
  return STACKS.map((s) => ({
    key: s.key,
    label: s.label,
    description: s.description,
    icon: s.icon,
    logos: s.logos,
    docsUrl: s.docsUrl,
    memoryHintMb: s.memoryHintMb,
    notes: s.notes,
    defaultPrefix: s.defaultPrefix,
    services: s.services.map((svc) => ({
      key: svc.key,
      description: svc.description,
      icon: svc.icon,
      image: svc.image ?? (svc.template ? `${svc.template}:${svc.version ?? ''}` : ''),
      public: !!svc.public,
    })),
  }));
}
