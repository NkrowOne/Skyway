import fs from 'fs';
import path from 'path';
import { getEnv, getProjectVars } from './db';
import { getTemplate } from './templates';
import { DetectedNeeds, GitConfig, ServiceRow } from './types';
import { ReferenceGroup } from './variables';

/**
 * Dependencias que un repositorio declara sin decirlo: qué motores usa (por
 * sus librerías, su `schema.prisma` o su `docker-compose`) y qué variables
 * espera (por su `.env.example`). Con eso el panel propone las referencias que
 * faltan —o crear la base que no existe— en vez de dejar que la app arranque
 * sin `DATABASE_URL` y falle a los diez segundos con un mensaje que no habla de
 * variables. Solo se PROPONE: nada de esto escribe una variable por su cuenta.
 */

type Engine = 'postgres' | 'redis' | 'mysql' | 'mongo' | 'minio';
type Role = 'main' | 'host' | 'port' | 'user' | 'password' | 'database';

/** Un fichero de dependencias no debería pesar más; si pesa, no es lo que parece. */
const MAX_FILE_BYTES = 512 * 1024;

/** Ficheros de ejemplo de entorno, por orden de preferencia. */
const ENV_EXAMPLE_FILES = ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.local.example', 'example.env'];

/*
 * Paquete → motor, por ecosistema. Solo librerías que no dejan duda: un ORM
 * multi-motor (typeorm, knex, sqlalchemy, doctrine) no dice qué base hay
 * detrás, y sugerir Postgres a quien usa SQLite sería peor que callar.
 */
const NPM: Record<string, Engine> = {
  pg: 'postgres',
  postgres: 'postgres',
  'pg-promise': 'postgres',
  slonik: 'postgres',
  '@vercel/postgres': 'postgres',
  '@neondatabase/serverless': 'postgres',
  'pg-boss': 'postgres',
  redis: 'redis',
  ioredis: 'redis',
  bullmq: 'redis',
  bull: 'redis',
  'bee-queue': 'redis',
  'connect-redis': 'redis',
  'rate-limit-redis': 'redis',
  mongoose: 'mongo',
  mongodb: 'mongo',
  '@typegoose/typegoose': 'mongo',
  mysql: 'mysql',
  mysql2: 'mysql',
  mariadb: 'mysql',
  minio: 'minio',
  '@aws-sdk/client-s3': 'minio',
};
const PYPI: Record<string, Engine> = {
  psycopg2: 'postgres',
  'psycopg2-binary': 'postgres',
  psycopg: 'postgres',
  asyncpg: 'postgres',
  pg8000: 'postgres',
  redis: 'redis',
  aioredis: 'redis',
  rq: 'redis',
  'django-redis': 'redis',
  pymongo: 'mongo',
  motor: 'mongo',
  mongoengine: 'mongo',
  beanie: 'mongo',
  mysqlclient: 'mysql',
  pymysql: 'mysql',
  aiomysql: 'mysql',
  'mysql-connector-python': 'mysql',
  minio: 'minio',
  boto3: 'minio',
};
const GO: [RegExp, Engine][] = [
  [/github\.com\/lib\/pq\b/, 'postgres'],
  [/github\.com\/jackc\/pgx/, 'postgres'],
  [/github\.com\/(?:redis\/go-redis|go-redis\/redis)/, 'redis'],
  [/go\.mongodb\.org\/mongo-driver/, 'mongo'],
  [/github\.com\/go-sql-driver\/mysql/, 'mysql'],
  [/github\.com\/minio\/minio-go/, 'minio'],
  [/github\.com\/aws\/aws-sdk-go(?:-v2)?\/service\/s3/, 'minio'],
];
const GEM: Record<string, Engine> = {
  pg: 'postgres',
  redis: 'redis',
  sidekiq: 'redis',
  resque: 'redis',
  mongoid: 'mongo',
  mongo: 'mongo',
  mysql2: 'mysql',
  'aws-sdk-s3': 'minio',
};
const COMPOSER: Record<string, Engine> = {
  'predis/predis': 'redis',
  'mongodb/mongodb': 'mongo',
  'jenssegers/mongodb': 'mongo',
  'aws/aws-sdk-php': 'minio',
  'league/flysystem-aws-s3-v3': 'minio',
};
const PRISMA_PROVIDER: Record<string, Engine> = {
  postgresql: 'postgres',
  postgres: 'postgres',
  cockroachdb: 'postgres',
  mysql: 'mysql',
  mongodb: 'mongo',
};
const COMPOSE_IMAGE: Record<string, Engine> = {
  postgres: 'postgres',
  postgis: 'postgres',
  redis: 'redis',
  valkey: 'redis',
  mysql: 'mysql',
  mariadb: 'mysql',
  mongo: 'mongo',
  minio: 'minio',
};

/**
 * Nombre de variable → (motor, papel). `sql` es «la base relacional que haya»:
 * `DATABASE_URL` o `DB_HOST` valen igual para Postgres y MySQL, y lo decide lo
 * que se haya detectado por otro lado (y Postgres si nada lo dice).
 */
const VAR_PATTERNS: { re: RegExp; engine: Engine | 'sql'; role: Role }[] = [
  { re: /^(?:DATABASE|DB)_?(?:URL|URI|CONNECTION(?:_STRING)?|DSN)$/, engine: 'sql', role: 'main' },
  { re: /^(?:POSTGRES(?:QL)?|PG)_?(?:URL|URI|CONNECTION(?:_STRING)?|DSN)$/, engine: 'postgres', role: 'main' },
  { re: /^(?:REDIS_?(?:URL|URI|DSN|CONNECTION(?:_STRING)?)|CELERY_BROKER_URL|BROKER_URL)$/, engine: 'redis', role: 'main' },
  { re: /^MONGO(?:DB)?_?(?:URL|URI|DSN|CONNECTION(?:_STRING)?)$/, engine: 'mongo', role: 'main' },
  { re: /^MYSQL_?(?:URL|URI|DSN|CONNECTION(?:_STRING)?)$/, engine: 'mysql', role: 'main' },
  { re: /^(?:S3|MINIO|AWS(?:_S3)?)_?ENDPOINT(?:_URL)?$/, engine: 'minio', role: 'main' },

  { re: /^(?:PGHOST|POSTGRES_HOST)$/, engine: 'postgres', role: 'host' },
  { re: /^(?:PGPORT|POSTGRES_PORT)$/, engine: 'postgres', role: 'port' },
  { re: /^(?:PGUSER|POSTGRES_USER)$/, engine: 'postgres', role: 'user' },
  { re: /^(?:PGPASSWORD|POSTGRES_PASSWORD)$/, engine: 'postgres', role: 'password' },
  { re: /^(?:PGDATABASE|POSTGRES_DB|POSTGRES_DATABASE)$/, engine: 'postgres', role: 'database' },

  { re: /^(?:DB|DATABASE)_HOST$/, engine: 'sql', role: 'host' },
  { re: /^(?:DB|DATABASE)_PORT$/, engine: 'sql', role: 'port' },
  { re: /^(?:DB|DATABASE)_USER(?:NAME)?$/, engine: 'sql', role: 'user' },
  { re: /^(?:DB|DATABASE)_PASS(?:WORD)?$/, engine: 'sql', role: 'password' },
  { re: /^(?:DB_NAME|DB_DATABASE|DATABASE_NAME)$/, engine: 'sql', role: 'database' },

  { re: /^REDIS_HOST$/, engine: 'redis', role: 'host' },
  { re: /^REDIS_PORT$/, engine: 'redis', role: 'port' },
  { re: /^REDIS_PASS(?:WORD)?$/, engine: 'redis', role: 'password' },

  { re: /^MONGO(?:DB)?_HOST$/, engine: 'mongo', role: 'host' },
  { re: /^MONGO(?:DB)?_PORT$/, engine: 'mongo', role: 'port' },
  { re: /^MONGO(?:DB)?_USER(?:NAME)?$/, engine: 'mongo', role: 'user' },
  { re: /^MONGO(?:DB)?_PASS(?:WORD)?$/, engine: 'mongo', role: 'password' },

  { re: /^MYSQL_HOST$/, engine: 'mysql', role: 'host' },
  { re: /^MYSQL_PORT$/, engine: 'mysql', role: 'port' },
  { re: /^MYSQL_USER(?:NAME)?$/, engine: 'mysql', role: 'user' },
  { re: /^MYSQL_PASS(?:WORD)?$/, engine: 'mysql', role: 'password' },
  { re: /^(?:MYSQL_DATABASE|MYSQL_DB)$/, engine: 'mysql', role: 'database' },

  { re: /^(?:(?:S3|MINIO|AWS)_?ACCESS_KEY(?:_ID)?|MINIO_ROOT_USER)$/, engine: 'minio', role: 'user' },
  { re: /^(?:(?:S3|MINIO|AWS)_?SECRET(?:_ACCESS)?_KEY|MINIO_ROOT_PASSWORD)$/, engine: 'minio', role: 'password' },
];

/** Variables con las que una app monta sus enlaces absolutos: valen el dominio público del propio servicio. */
const PUBLIC_URL_RE =
  /^(?:(?:PUBLIC|APP|BASE|SITE|WEB|FRONTEND|SERVER|HOST|NEXTAUTH|NEXT_PUBLIC_(?:SITE|APP|BASE)|AUTH)_?URL|(?:APP_)?ORIGIN)$/;

/** Las pone Skyway en cada despliegue: que el .env.example las nombre no es una carencia. */
const AUTO_COVERED_RE = /^(?:PORT|HOST|HOSTNAME|NODE_ENV|TZ|PUBLIC_URL|PUBLIC_DOMAIN|INTERNAL_(?:HOST|PORT|URL)|RAILWAY_.*|SKYWAY_.*)$/;

const ENV_KEY_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function readSmall(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Nombre de paquete Python sin versión ni extras: `psycopg[binary]>=3` → `psycopg`. */
const pyName = (line: string): string | null => {
  const m = line.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
  return m ? m[1].toLowerCase().replace(/_/g, '-') : null;
};

/**
 * Inspecciona el repositorio clonado. Mira en `rootDir` y en la raíz (en un
 * monorepo las dependencias pueden estar arriba), sin recorrer el árbol: lo
 * que hay que leer está en sitios fijos, y un `find` sobre `node_modules`
 * sería lento y engañoso. Devuelve null si no encuentra nada que decir.
 */
export function detectNeeds(repoDir: string, rootDir?: string): DetectedNeeds | null {
  const roots = [...new Set([path.resolve(repoDir, rootDir || '.'), path.resolve(repoDir)])];
  const engines = new Map<Engine, string>();
  const sources = new Set<string>();
  const found = (engine: Engine, evidence: string) => {
    if (!engines.has(engine)) engines.set(engine, evidence);
  };
  const rel = (full: string) => path.relative(repoDir, full) || path.basename(full);

  let expectedVars: string[] = [];
  let envFile: string | null = null;

  for (const dir of roots) {
    const read = (name: string): { text: string; rel: string } | null => {
      const text = readSmall(path.join(dir, name));
      return text === null ? null : { text, rel: rel(path.join(dir, name)) };
    };

    // Variables esperadas: el primer fichero de ejemplo que aparezca manda.
    if (!envFile) {
      for (const name of ENV_EXAMPLE_FILES) {
        const f = read(name);
        if (!f) continue;
        const keys: string[] = [];
        for (const line of f.text.split(/\r?\n/)) {
          const m = line.match(ENV_KEY_RE);
          if (m && !keys.includes(m[1])) keys.push(m[1]);
        }
        if (keys.length > 0) {
          expectedVars = keys;
          envFile = f.rel;
          sources.add(f.rel);
        }
        break;
      }
    }

    const pkg = read('package.json');
    if (pkg) {
      try {
        const parsed = JSON.parse(pkg.text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        const deps = { ...(parsed.devDependencies ?? {}), ...(parsed.dependencies ?? {}) };
        for (const [name, engine] of Object.entries(NPM)) {
          if (deps[name] !== undefined) {
            found(engine, `${pkg.rel}: ${name}`);
            sources.add(pkg.rel);
          }
        }
      } catch {
        /* un package.json roto ya lo contará el build */
      }
    }

    for (const name of ['requirements.txt', 'requirements/base.txt', 'requirements/production.txt']) {
      const req = read(name);
      if (!req) continue;
      for (const line of req.text.split(/\r?\n/)) {
        const n = pyName(line);
        const engine = n ? PYPI[n] : undefined;
        if (engine) {
          found(engine, `${req.rel}: ${n}`);
          sources.add(req.rel);
        }
      }
    }
    const pyproject = read('pyproject.toml');
    if (pyproject) {
      // Sin parsear TOML entero: las dependencias van entre comillas y con eso basta.
      for (const m of pyproject.text.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*[<>=!~;\s"']/g)) {
        const n = m[1].toLowerCase().replace(/_/g, '-');
        const engine = PYPI[n];
        if (engine) {
          found(engine, `${pyproject.rel}: ${n}`);
          sources.add(pyproject.rel);
        }
      }
    }

    const gomod = read('go.mod');
    if (gomod) {
      for (const [re, engine] of GO) {
        if (re.test(gomod.text)) {
          found(engine, `${gomod.rel}: ${re.source.replace(/\\/g, '').replace(/\(\?:|\)|\|.*$/g, '')}`);
          sources.add(gomod.rel);
        }
      }
    }

    const gemfile = read('Gemfile');
    if (gemfile) {
      for (const m of gemfile.text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)) {
        const engine = GEM[m[1]];
        if (engine) {
          found(engine, `${gemfile.rel}: ${m[1]}`);
          sources.add(gemfile.rel);
        }
      }
    }

    const composer = read('composer.json');
    if (composer) {
      try {
        const parsed = JSON.parse(composer.text) as { require?: Record<string, string> };
        for (const [name, engine] of Object.entries(COMPOSER)) {
          if (parsed.require?.[name] !== undefined) {
            found(engine, `${composer.rel}: ${name}`);
            sources.add(composer.rel);
          }
        }
      } catch {
        /* idem */
      }
    }

    // Prisma dice motor y variable en el mismo sitio, y es la pista más fiable de todas.
    for (const name of ['prisma/schema.prisma', 'schema.prisma']) {
      const schema = read(name);
      if (!schema) continue;
      const provider = schema.text.match(/provider\s*=\s*["'](\w+)["']/)?.[1]?.toLowerCase();
      const engine = provider ? PRISMA_PROVIDER[provider] : undefined;
      if (engine) {
        // Sustituye la pista del package.json: `@prisma/client` no decía qué motor.
        engines.set(engine, `${schema.rel}: provider ${provider}`);
        sources.add(schema.rel);
      }
      const envVar = schema.text.match(/url\s*=\s*env\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\)/)?.[1];
      if (envVar && !expectedVars.includes(envVar)) {
        expectedVars.push(envVar);
        sources.add(schema.rel);
      }
    }

    // Un docker-compose de desarrollo retrata las dependencias mejor que nada.
    for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
      const compose = read(name);
      if (!compose) continue;
      for (const m of compose.text.matchAll(/^\s*image:\s*["']?(?:[a-z0-9.-]+\/)*([a-z0-9-]+)(?::[^\s"']+)?["']?\s*$/gim)) {
        const engine = COMPOSE_IMAGE[m[1].toLowerCase()];
        if (engine) {
          found(engine, `${compose.rel}: imagen ${m[1]}`);
          sources.add(compose.rel);
        }
      }
    }
  }

  // Un .env.example que pide REDIS_URL delata Redis aunque la librería no
  // esté en la lista. Para `DATABASE_URL` a secas se asume Postgres, que es
  // la base relacional por defecto de Skyway, y se dice que es una suposición.
  for (const v of expectedVars) {
    const hit = VAR_PATTERNS.find((p) => p.re.test(v));
    if (!hit) continue;
    if (hit.engine !== 'sql') found(hit.engine, `${envFile}: ${v}`);
    else if (!engines.has('postgres') && !engines.has('mysql')) found('postgres', `${envFile}: ${v} (se asume PostgreSQL)`);
  }

  if (engines.size === 0 && expectedVars.length === 0) return null;
  return {
    engines: [...engines.entries()].map(([template, evidence]) => ({ template, evidence })),
    expectedVars,
    envFile,
    sources: [...sources],
    detectedAt: Date.now(),
  };
}

export interface EnvSuggestion {
  /** Clave a crear en el servicio. */
  key: string;
  /** Referencia lista (`${{Postgres.DATABASE_URL}}`), o null si primero hay que crear la base. */
  value: string | null;
  /** Motor implicado, o null si es la URL pública del propio servicio. */
  template: string | null;
  label: string | null;
  /** Servicio del proyecto al que apunta `value`, si existe. */
  service: string | null;
  /** Variable del destino que se referencia; con `value` null, la que tendrá la base recién creada. */
  refVar: string | null;
  reason: string;
}

export interface EnvAdvice {
  needs: { engines: { template: string; label: string; evidence: string }[]; sources: string[] } | null;
  suggestions: EnvSuggestion[];
  /** Variables que el repositorio espera, sin sugerencia automática y sin definir. */
  missing: string[];
}

const NO_ADVICE: EnvAdvice = { needs: null, suggestions: [], missing: [] };

/**
 * Convierte lo detectado en propuestas concretas para ESTE servicio, contra lo
 * que ya tiene: cada variable esperada que falte y se sepa de qué es, con la
 * referencia al servicio del proyecto que la cubre, o sin valor si esa base no
 * existe todavía. Se calcula al pedirlo, no al desplegar: si entre medias se ha
 * creado la base o se ha añadido la variable, la propuesta cambia sola.
 */
export function adviseEnv(service: ServiceRow, references: ReferenceGroup[]): EnvAdvice {
  if (service.type !== 'git') return NO_ADVICE;
  const cfg = service.config as GitConfig;
  const needs = cfg.needs;
  if (!needs) return NO_ADVICE;

  const defined = new Set([...Object.keys(getProjectVars(service.project_id)), ...Object.keys(getEnv(service.id))]);
  const detected = new Set(needs.engines.map((e) => e.template));
  const sqlEngine: Engine = detected.has('mysql') && !detected.has('postgres') ? 'mysql' : 'postgres';
  const labelOf = (engine: string) => getTemplate(engine)?.label ?? engine;
  const evidenceOf = (engine: string) => needs.engines.find((e) => e.template === engine)?.evidence ?? '';
  const providerOf = (engine: string, refVar: string) =>
    references.find((g) => g.template === engine && g.vars.includes(refVar)) ?? null;

  const suggestions: EnvSuggestion[] = [];
  const missing: string[] = [];
  const covered = new Set<string>();
  const propose = (key: string, engine: Engine, role: Role, reason: string): boolean => {
    const refVar = getTemplate(engine)?.conn[role];
    if (!refVar) return false;
    const provider = providerOf(engine, refVar);
    suggestions.push({
      key,
      value: provider ? `\${{${provider.service}.${refVar}}}` : null,
      template: engine,
      label: labelOf(engine),
      service: provider?.service ?? null,
      refVar,
      reason,
    });
    covered.add(engine);
    return true;
  };

  for (const v of needs.expectedVars) {
    if (defined.has(v) || AUTO_COVERED_RE.test(v)) continue;
    const hit = VAR_PATTERNS.find((p) => p.re.test(v));
    if (hit) {
      const engine = hit.engine === 'sql' ? sqlEngine : hit.engine;
      if (propose(v, engine, hit.role, `${needs.envFile ?? 'el repositorio'}: ${v}`)) continue;
      missing.push(v);
      continue;
    }
    if (PUBLIC_URL_RE.test(v)) {
      const domains = cfg.domains ?? [];
      if (domains[0]) {
        suggestions.push({
          key: v,
          value: `\${{${service.name}.PUBLIC_URL}}`,
          template: null,
          label: null,
          service: service.name,
          refVar: 'PUBLIC_URL',
          reason: `${needs.envFile ?? 'el repositorio'}: ${v} · dominio público del servicio`,
        });
        continue;
      }
    }
    missing.push(v);
  }

  // Motores detectados por librería que ninguna variable esperada ha cubierto:
  // se propone el juego estándar de su plantilla, salvo lo que ya esté definido
  // (una DATABASE_URL literal a una base externa es una decisión, no un hueco).
  for (const engine of detected) {
    if (covered.has(engine)) continue;
    const template = getTemplate(engine);
    if (!template) continue;
    for (const key of template.conn.connect) {
      if (defined.has(key)) continue;
      const role = (Object.entries(template.conn) as [string, unknown][]).find(([r, name]) => r !== 'connect' && name === key)?.[0] as
        | Role
        | undefined;
      if (role) propose(key, engine as Engine, role, evidenceOf(engine));
    }
  }

  const seen = new Set<string>();
  return {
    needs: {
      engines: needs.engines.map((e) => ({ template: e.template, label: labelOf(e.template), evidence: e.evidence })),
      sources: needs.sources,
    },
    suggestions: suggestions.filter((s) => !seen.has(s.key) && seen.add(s.key)),
    missing,
  };
}
