import { containerName, execInContainer, getRuntime } from './docker/containers';
import { DatabaseConfig, ProjectRow, ServiceRow } from './types';

/**
 * Consola de consultas para los servicios de base de datos.
 *
 * Todo corre DENTRO del contenedor de la base de datos con su cliente oficial
 * (psql, mysql, mongosh, redis-cli) y las credenciales de su propio entorno:
 * Skyway no necesita drivers ni abre puertos. La consulta viaja como variable
 * de entorno del exec (SKYWAY_QUERY), nunca interpolada en el shell.
 *
 * El modo solo-lectura es un cinturón de seguridad contra accidentes, no un
 * límite de permisos: quien usa la consola ya puede ejecutar comandos en el
 * contenedor desde la terminal del panel.
 */

const QUERY_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 400_000;
const MAX_ROWS = 500;

export type DbEngine = 'postgres' | 'mysql' | 'mongo' | 'redis';

export interface QueryResult {
  kind: 'table' | 'text';
  columns?: string[];
  rows?: string[][];
  raw?: string;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  /** Aviso no fatal (p. ej. "resultado truncado a 500 filas"). */
  notice?: string;
}

export interface DbSnippet {
  label: string;
  query: string;
  /** Descripción corta que se muestra bajo el título. */
  hint?: string;
}

export interface DbObject {
  name: string;
  /** Filas (SQL), documentos (Mongo) o nº de claves (Redis, por base). */
  rows: number | null;
  sizeBytes: number | null;
}

export interface DbOverview {
  engine: DbEngine;
  version: string | null;
  sizeBytes: number | null;
  objectLabel: string;
  objects: DbObject[];
}

export function dbConsoleEngine(service: ServiceRow): DbEngine | null {
  if (service.type !== 'database') return null;
  const tpl = (service.config as DatabaseConfig).template;
  return tpl === 'postgres' || tpl === 'mysql' || tpl === 'mongo' || tpl === 'redis' ? tpl : null;
}

async function requireRunning(project: ProjectRow, service: ServiceRow): Promise<string> {
  const name = containerName(project, service);
  const runtime = await getRuntime(name);
  if (runtime.state !== 'running') {
    throw new Error('La base de datos no está en ejecución: arráncala antes de consultar.');
  }
  return name;
}

// ---------- parsers ----------

/** Parser CSV mínimo (salida de `psql --csv`): comillas dobles y saltos dentro de campos. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Salida `mysql --batch`: TSV con \t, \n y \\ escapados dentro de los campos. */
export function parseMysqlBatch(text: string): string[][] {
  const unescape = (s: string) =>
    s === 'NULL'
      ? ''
      : s.replace(/\\([\\nt0])/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === '0' ? '\0' : '\\'));
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.split('\t').map(unescape));
}

function tableResult(rows: string[][], durationMs: number, outputTruncated: boolean): QueryResult {
  if (rows.length === 0) {
    return { kind: 'text', raw: '', rowCount: 0, truncated: outputTruncated, durationMs, notice: 'Consulta ejecutada sin resultados.' };
  }
  const [columns, ...data] = rows;
  const truncated = outputTruncated || data.length > MAX_ROWS;
  return {
    kind: 'table',
    columns,
    rows: data.slice(0, MAX_ROWS),
    rowCount: data.length,
    truncated,
    durationMs,
    notice: truncated ? `Mostrando ${Math.min(data.length, MAX_ROWS)} de ${data.length}${outputTruncated ? '+' : ''} filas.` : undefined,
  };
}

function execError(output: string, fallback: string): Error {
  const clean = output.trim().split('\n').slice(0, 6).join('\n').slice(0, 900);
  return new Error(clean || fallback);
}

// ---------- guardas de solo lectura ----------

const SQL_READ_START = /^\s*(select|with|show|explain|describe|desc|table|values|analyze)\b/i;
const MONGO_WRITE = /\.\s*(insert\w*|update\w*|delete\w*|remove|replaceOne|drop\w*|create\w*|rename\w*|bulkWrite|findOneAndUpdate|findOneAndReplace|findOneAndDelete|findAndModify)\s*\(|dropDatabase|adminCommand|runCommand|fsync|shutdownServer/i;
const REDIS_READ = new Set([
  'get', 'mget', 'getrange', 'strlen', 'exists', 'type', 'ttl', 'pttl', 'keys', 'scan', 'randomkey',
  'llen', 'lrange', 'lindex', 'lpos', 'scard', 'smembers', 'sismember', 'srandmember', 'sscan',
  'zcard', 'zcount', 'zrange', 'zrangebyscore', 'zrevrange', 'zscore', 'zrank', 'zscan',
  'hget', 'hgetall', 'hkeys', 'hvals', 'hlen', 'hmget', 'hstrlen', 'hscan',
  'bitcount', 'getbit', 'dbsize', 'info', 'memory', 'object', 'ping', 'echo', 'time', 'select',
  'xlen', 'xrange', 'xrevrange', 'xinfo', 'pfcount', 'geopos', 'geodist', 'sinter', 'sunion', 'sdiff',
]);

/** Lanza si la consulta parece de escritura y el modo escritura no está activo. */
function assertReadOnly(engine: DbEngine, query: string): void {
  if (engine === 'postgres' || engine === 'mysql') {
    if (!SQL_READ_START.test(query)) {
      throw new Error(
        'El modo solo lectura únicamente permite consultas SELECT/SHOW/EXPLAIN. Activa "Permitir escritura" para ejecutar cambios.',
      );
    }
    return;
  }
  if (engine === 'mongo') {
    if (MONGO_WRITE.test(query)) {
      throw new Error('Esa operación modifica datos. Activa "Permitir escritura" para ejecutarla.');
    }
    return;
  }
  const first = query.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!REDIS_READ.has(first)) {
    throw new Error(`El comando "${first.toUpperCase()}" no es de lectura. Activa "Permitir escritura" para ejecutarlo.`);
  }
}

// ---------- ejecución por motor ----------

export type BrowseMode = 'data' | 'describe';

interface EngineRunner {
  run: (name: string, query: string, allowWrite: boolean) => Promise<QueryResult>;
  overview: (name: string) => Promise<DbOverview>;
  snippets: DbSnippet[];
  /**
   * Consulta sugerida al pulsar un objeto del explorador. 'data' muestra
   * contenido; 'describe' muestra estructura (columnas, tipo de clave...).
   * Recibe el contenedor porque algunos motores (Redis) consultan el tipo.
   */
  browse: (name: string, object: string, mode: BrowseMode) => Promise<string>;
}

const PSQL = 'psql -X -U "${POSTGRES_USER:-skyway}" -d "${POSTGRES_DB:-skyway}" -v ON_ERROR_STOP=1 -q';

async function pgRun(name: string, query: string, allowWrite: boolean): Promise<QueryResult> {
  const env = [`SKYWAY_QUERY=${query}`];
  // default_transaction_read_only: el propio Postgres rechaza cualquier escritura.
  if (!allowWrite) env.push('PGOPTIONS=-c default_transaction_read_only=on');
  const res = await execInContainer(name, `${PSQL} --csv -c "$SKYWAY_QUERY"`, {
    timeoutMs: QUERY_TIMEOUT_MS,
    maxOutput: MAX_OUTPUT,
    env,
  });
  if (res.timedOut) throw new Error('La consulta superó el tiempo máximo (30 s).');
  if (res.exitCode !== 0) throw execError(res.output, 'La consulta falló.');
  return tableResult(parseCsv(res.output), res.durationMs, res.truncated);
}

async function pgOverview(name: string): Promise<DbOverview> {
  // El nombre lleva el esquema salvo para public: dos tablas "users" en
  // esquemas distintos deben distinguirse (y el browse debe calificarlas).
  const sql = `SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END,
      COALESCE(c.reltuples, 0)::bigint, pg_total_relation_size(c.oid)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p','m') AND n.nspname NOT IN ('pg_catalog','information_schema')
    ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 200`;
  const meta = await execInContainer(
    name,
    `${PSQL} --csv -t -c "SELECT current_setting('server_version'), pg_database_size(current_database())"`,
    { timeoutMs: QUERY_TIMEOUT_MS, env: [] },
  );
  const tables = await execInContainer(name, `${PSQL} --csv -t -c "$SKYWAY_QUERY"`, {
    timeoutMs: QUERY_TIMEOUT_MS,
    maxOutput: MAX_OUTPUT,
    env: [`SKYWAY_QUERY=${sql}`],
  });
  if (tables.exitCode !== 0) throw execError(tables.output, 'No se pudo leer el esquema.');
  const metaRow = meta.exitCode === 0 ? parseCsv(meta.output)[0] : undefined;
  return {
    engine: 'postgres',
    version: metaRow?.[0] ?? null,
    sizeBytes: metaRow?.[1] ? Number(metaRow[1]) : null,
    objectLabel: 'tablas',
    objects: parseCsv(tables.output).map((r) => ({
      name: r[0],
      rows: r[1] !== undefined && Number(r[1]) >= 0 ? Number(r[1]) : null,
      sizeBytes: r[2] !== undefined ? Number(r[2]) : null,
    })),
  };
}

const MYSQL = 'mysql --batch -u "${MYSQL_USER:-skyway}" -p"$MYSQL_PASSWORD" "${MYSQL_DATABASE:-skyway}"';

async function mysqlRun(name: string, query: string, allowWrite: boolean): Promise<QueryResult> {
  // La sesión entera se pone en solo lectura antes de la consulta del usuario.
  const guarded = allowWrite ? query : `SET SESSION transaction_read_only = 1;\n${query}`;
  const res = await execInContainer(name, `${MYSQL} -e "$SKYWAY_QUERY" 2>&1`, {
    timeoutMs: QUERY_TIMEOUT_MS,
    maxOutput: MAX_OUTPUT,
    env: [`SKYWAY_QUERY=${guarded}`],
  });
  if (res.timedOut) throw new Error('La consulta superó el tiempo máximo (30 s).');
  const output = res.output.replace(/^mysql: \[Warning\].*\n?/gm, '');
  if (res.exitCode !== 0) throw execError(output, 'La consulta falló.');
  return tableResult(parseMysqlBatch(output), res.durationMs, res.truncated);
}

async function mysqlOverview(name: string): Promise<DbOverview> {
  const sql = `SELECT table_name, COALESCE(table_rows,0), COALESCE(data_length,0)+COALESCE(index_length,0)
    FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 3 DESC LIMIT 200`;
  const meta = await execInContainer(name, `${MYSQL} --skip-column-names -e "SELECT VERSION()" 2>&1`, {
    timeoutMs: QUERY_TIMEOUT_MS,
    env: [],
  });
  const tables = await execInContainer(name, `${MYSQL} --skip-column-names -e "$SKYWAY_QUERY" 2>&1`, {
    timeoutMs: QUERY_TIMEOUT_MS,
    maxOutput: MAX_OUTPUT,
    env: [`SKYWAY_QUERY=${sql}`],
  });
  if (tables.exitCode !== 0) throw execError(tables.output, 'No se pudo leer el esquema.');
  const clean = (s: string) => s.replace(/^mysql: \[Warning\].*\n?/gm, '');
  const objects = parseMysqlBatch(clean(tables.output)).map((r) => ({
    name: r[0],
    rows: r[1] !== undefined ? Number(r[1]) : null,
    sizeBytes: r[2] !== undefined ? Number(r[2]) : null,
  }));
  return {
    engine: 'mysql',
    version: meta.exitCode === 0 ? clean(meta.output).trim().split('\n')[0] || null : null,
    sizeBytes: objects.reduce((acc, o) => acc + (o.sizeBytes ?? 0), 0),
    objectLabel: 'tablas',
    objects,
  };
}

const MONGOSH =
  'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin';

/** Envuelve el script del usuario: evalúa, materializa cursores e imprime EJSON. */
const MONGO_WRAPPER = `
let __v = eval(process.env.SKYWAY_QUERY);
if (__v && typeof __v.toArray === 'function') __v = __v.toArray();
if (__v === undefined) print('__SKYWAY_OK__');
else print(EJSON.stringify(__v));
`.trim();

async function mongoRun(name: string, query: string): Promise<QueryResult> {
  const res = await execInContainer(name, `${MONGOSH} --eval "$SKYWAY_WRAPPER"`, {
    timeoutMs: QUERY_TIMEOUT_MS,
    maxOutput: MAX_OUTPUT,
    env: [`SKYWAY_QUERY=${query}`, `SKYWAY_WRAPPER=${MONGO_WRAPPER}`],
  });
  if (res.timedOut) throw new Error('La consulta superó el tiempo máximo (30 s).');
  if (res.exitCode === 126 || res.exitCode === 127) {
    throw new Error(
      'Esta imagen de MongoDB no incluye mongosh (las 4.x y anteriores no lo traen). Sube la versión de la imagen en Ajustes del servicio para usar la consola.',
    );
  }
  if (res.exitCode !== 0) throw execError(res.output, 'La consulta falló.');
  const raw = res.output.trim();
  if (raw === '__SKYWAY_OK__') {
    return { kind: 'text', raw: '', rowCount: 0, truncated: false, durationMs: res.durationMs, notice: 'Operación ejecutada.' };
  }
  // Un array de documentos se tabula (unión de claves de primer nivel).
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((d) => d && typeof d === 'object' && !Array.isArray(d))) {
      const columns: string[] = [];
      for (const doc of parsed.slice(0, 50)) {
        for (const key of Object.keys(doc)) if (!columns.includes(key)) columns.push(key);
      }
      const cell = (v: unknown) =>
        v === undefined ? '' : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
      const truncated = res.truncated || parsed.length > MAX_ROWS;
      return {
        kind: 'table',
        columns,
        rows: parsed.slice(0, MAX_ROWS).map((doc: any) => columns.map((c) => cell(doc[c]))),
        rowCount: parsed.length,
        truncated,
        durationMs: res.durationMs,
        notice: truncated ? `Mostrando ${Math.min(parsed.length, MAX_ROWS)} de ${parsed.length} documentos.` : undefined,
      };
    }
    return {
      kind: 'text',
      raw: JSON.stringify(parsed, null, 2),
      rowCount: Array.isArray(parsed) ? parsed.length : 1,
      truncated: res.truncated,
      durationMs: res.durationMs,
    };
  } catch {
    return { kind: 'text', raw, rowCount: raw ? 1 : 0, truncated: res.truncated, durationMs: res.durationMs };
  }
}

const MONGO_OVERVIEW_SCRIPT = `
const dbs = db.adminCommand({ listDatabases: 1 }).databases
  .filter(d => !['admin','config','local'].includes(d.name));
const out = [];
for (const d of dbs) {
  const sib = db.getSiblingDB(d.name);
  for (const c of sib.getCollectionNames()) {
    let count = null;
    try { count = sib.getCollection(c).estimatedDocumentCount(); } catch (e) {}
    out.push({ name: d.name + '.' + c, rows: count, sizeBytes: null });
  }
  if (sib.getCollectionNames().length === 0) out.push({ name: d.name + ' (vacía)', rows: 0, sizeBytes: d.sizeOnDisk ?? null });
}
({ version: db.version(), sizeBytes: dbs.reduce((a, d) => a + (d.sizeOnDisk || 0), 0), objects: out });
`.trim();

async function mongoOverview(name: string): Promise<DbOverview> {
  const result = await mongoRun(name, MONGO_OVERVIEW_SCRIPT);
  try {
    const parsed = JSON.parse(result.raw || '{}');
    return {
      engine: 'mongo',
      version: parsed.version ?? null,
      sizeBytes: parsed.sizeBytes ?? null,
      objectLabel: 'colecciones',
      objects: (parsed.objects ?? []).slice(0, 200),
    };
  } catch {
    return { engine: 'mongo', version: null, sizeBytes: null, objectLabel: 'colecciones', objects: [] };
  }
}

const REDIS = 'redis-cli --no-auth-warning -a "$REDIS_PASSWORD"';

async function redisRun(name: string, query: string): Promise<QueryResult> {
  // Por stdin: redis-cli parsea comillas y espacios igual que en su REPL.
  const res = await execInContainer(name, `printf '%s\\n' "$SKYWAY_QUERY" | ${REDIS} 2>&1`, {
    timeoutMs: QUERY_TIMEOUT_MS,
    maxOutput: MAX_OUTPUT,
    env: [`SKYWAY_QUERY=${query}`],
  });
  if (res.timedOut) throw new Error('El comando superó el tiempo máximo (30 s).');
  const raw = res.output.trim();
  if (res.exitCode !== 0) throw execError(raw, 'El comando falló.');
  if (/^(ERR|WRONGTYPE|NOAUTH|NOPERM)\b/m.test(raw)) throw execError(raw, 'El comando falló.');
  const lines = raw ? raw.split('\n') : [];
  return {
    kind: 'text',
    raw,
    rowCount: lines.length,
    truncated: res.truncated,
    durationMs: res.durationMs,
  };
}

async function redisOverview(name: string): Promise<DbOverview> {
  const info = await execInContainer(name, `${REDIS} INFO 2>&1`, { timeoutMs: QUERY_TIMEOUT_MS, env: [] });
  const scan = await execInContainer(name, `${REDIS} --scan --count 200 2>&1 | head -100`, {
    timeoutMs: QUERY_TIMEOUT_MS,
    env: [],
  });
  const text = info.output;
  const version = text.match(/redis_version:([^\r\n]+)/)?.[1] ?? null;
  const memory = text.match(/used_memory:(\d+)/)?.[1];
  // SCAN puede devolver la misma clave más de una vez: se deduplica.
  const keys = scan.exitCode === 0
    ? [...new Set(scan.output.split('\n').map((l) => l.trim()).filter((l) => l.length > 0))]
    : [];
  return {
    engine: 'redis',
    version,
    sizeBytes: memory ? Number(memory) : null,
    objectLabel: 'claves (muestra)',
    objects: keys.slice(0, 100).map((k) => ({ name: k, rows: null, sizeBytes: null })),
  };
}

// ---------- consultas de exploración por motor ----------

const pgIdent = (t: string) => `"${t.replace(/"/g, '""')}"`;
const pgLiteral = (t: string) => `'${t.replace(/'/g, "''")}'`;
/** "esquema.tabla" → identificador calificado; sin punto → tabla a secas. */
function pgQualified(object: string): { from: string; schema: string | null; table: string } {
  const idx = object.indexOf('.');
  if (idx < 0) return { from: pgIdent(object), schema: null, table: object };
  const schema = object.slice(0, idx);
  const table = object.slice(idx + 1);
  return { from: `${pgIdent(schema)}.${pgIdent(table)}`, schema, table };
}
const myIdent = (t: string) => `\`${t.replace(/`/g, '``')}\``;
/** Clave Redis citada como la entiende el parser de redis-cli. */
const redisKey = (k: string) => `"${k.replace(/([\\"])/g, '\\$1')}"`;

/** Comando de lectura adecuado al tipo real de la clave Redis. */
function redisDataQuery(type: string, key: string): string {
  const k = redisKey(key);
  switch (type) {
    case 'string': return `GET ${k}`;
    case 'hash': return `HGETALL ${k}`;
    case 'list': return `LRANGE ${k} 0 49`;
    case 'set': return `SMEMBERS ${k}`;
    case 'zset': return `ZRANGE ${k} 0 49 WITHSCORES`;
    case 'stream': return `XRANGE ${k} - + COUNT 20`;
    default: return `TYPE ${k}`;
  }
}

function mongoTarget(object: string): { db: string; coll: string | null } {
  const [dbName, ...rest] = object.split('.');
  return { db: dbName, coll: rest.length > 0 ? rest.join('.') : null };
}

const RUNNERS: Record<DbEngine, EngineRunner> = {
  postgres: {
    run: pgRun,
    overview: pgOverview,
    browse: async (_name, t, mode) => {
      const q = pgQualified(t);
      if (mode !== 'describe') return `SELECT * FROM ${q.from} LIMIT 50;`;
      const schemaCond = q.schema ? ` AND table_schema = ${pgLiteral(q.schema)}` : '';
      return `SELECT column_name AS columna, data_type AS tipo, is_nullable AS nulable, column_default AS por_defecto\nFROM information_schema.columns WHERE table_name = ${pgLiteral(q.table)}${schemaCond} ORDER BY ordinal_position;`;
    },
    snippets: [
      { label: 'Tablas y tamaño', hint: 'Qué ocupa cada tabla', query: "SELECT c.relname AS tabla, pg_size_pretty(pg_total_relation_size(c.oid)) AS tamano, COALESCE(c.reltuples,0)::bigint AS filas_aprox\nFROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace\nWHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')\nORDER BY pg_total_relation_size(c.oid) DESC;" },
      { label: 'Conexiones activas', hint: 'Quién está conectado ahora', query: "SELECT pid, usename, state, query_start, LEFT(query, 80) AS query\nFROM pg_stat_activity WHERE state <> 'idle' ORDER BY query_start;" },
      { label: 'Columnas de una tabla', hint: 'Estructura (cambia el nombre)', query: "SELECT column_name, data_type, is_nullable, column_default\nFROM information_schema.columns WHERE table_name = 'mi_tabla' ORDER BY ordinal_position;" },
      { label: 'Índices sin usar', hint: 'Candidatos a eliminar', query: 'SELECT relname AS tabla, indexrelname AS indice, idx_scan AS usos\nFROM pg_stat_user_indexes ORDER BY idx_scan ASC LIMIT 20;' },
    ],
  },
  mysql: {
    run: mysqlRun,
    overview: mysqlOverview,
    browse: async (_name, t, mode) =>
      mode === 'describe' ? `SHOW FULL COLUMNS FROM ${myIdent(t)};` : `SELECT * FROM ${myIdent(t)} LIMIT 50;`,
    snippets: [
      { label: 'Tablas y tamaño', hint: 'Qué ocupa cada tabla', query: "SELECT table_name AS tabla, ROUND((data_length+index_length)/1024/1024, 2) AS mb, table_rows AS filas_aprox\nFROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY (data_length+index_length) DESC;" },
      { label: 'Procesos activos', hint: 'Consultas en ejecución', query: 'SHOW FULL PROCESSLIST;' },
      { label: 'Columnas de una tabla', hint: 'Estructura (cambia el nombre)', query: "SHOW COLUMNS FROM mi_tabla;" },
      { label: 'Variables del servidor', hint: 'Configuración efectiva', query: "SHOW VARIABLES LIKE 'max_connections';" },
    ],
  },
  mongo: {
    run: (name, query) => mongoRun(name, query),
    overview: mongoOverview,
    browse: async (_name, obj, mode) => {
      const { db, coll } = mongoTarget(obj);
      if (!coll) return `db.getSiblingDB(${JSON.stringify(db)}).getCollectionNames()`;
      const target = `db.getSiblingDB(${JSON.stringify(db)}).getCollection(${JSON.stringify(coll)})`;
      return mode === 'describe'
        ? `(() => { const d = ${target}.findOne(); return d ? Object.entries(d).map(([campo, v]) => ({ campo, tipo: Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v })) : []; })()`
        : `${target}.find().limit(20)`;
    },
    snippets: [
      { label: 'Bases y colecciones', hint: 'Qué hay en el servidor', query: 'db.adminCommand({ listDatabases: 1 })' },
      { label: 'Primeros documentos', hint: 'Cambia base y colección', query: "db.getSiblingDB('mi_base').getCollection('mi_coleccion').find().limit(10)" },
      { label: 'Contar documentos', hint: 'Total de una colección', query: "db.getSiblingDB('mi_base').getCollection('mi_coleccion').countDocuments()" },
      { label: 'Operaciones en curso', hint: 'Qué está ejecutando el servidor', query: 'db.adminCommand({ currentOp: 1, active: true })' },
    ],
  },
  redis: {
    run: (name, query) => redisRun(name, query),
    overview: redisOverview,
    browse: async (name, key, mode) => {
      const k = redisKey(key);
      if (mode === 'describe') return `TYPE ${k}\nTTL ${k}\nMEMORY USAGE ${k}`;
      // El comando de lectura depende del tipo real: GET sobre un hash falla.
      const typeRes = await redisRun(name, `TYPE ${k}`);
      return redisDataQuery((typeRes.raw ?? '').trim().split('\n')[0] ?? '', key);
    },
    snippets: [
      { label: 'Claves (muestra)', hint: 'SCAN no bloquea el servidor', query: 'SCAN 0 COUNT 100' },
      { label: 'Memoria usada', hint: 'Resumen del uso de memoria', query: 'INFO memory' },
      { label: 'Nº total de claves', query: 'DBSIZE' },
      { label: 'Ver una clave', hint: 'TYPE primero si no es string', query: 'GET mi:clave' },
      { label: 'Clientes conectados', query: 'CLIENT LIST' },
    ],
  },
};

export function dbSnippets(engine: DbEngine): DbSnippet[] {
  return RUNNERS[engine].snippets;
}

/** Consulta sugerida para un objeto del explorador (contenido o estructura). */
export async function getDbBrowseQuery(
  project: ProjectRow,
  service: ServiceRow,
  object: string,
  mode: BrowseMode,
): Promise<string> {
  const engine = dbConsoleEngine(service);
  if (!engine) throw new Error('Este servicio no tiene consola de consultas.');
  const name = await requireRunning(project, service);
  return RUNNERS[engine].browse(name, object, mode);
}

export async function runDbQuery(
  project: ProjectRow,
  service: ServiceRow,
  query: string,
  allowWrite: boolean,
): Promise<QueryResult> {
  const engine = dbConsoleEngine(service);
  if (!engine) throw new Error('Este servicio no tiene consola de consultas.');
  if (!allowWrite) assertReadOnly(engine, query);
  const name = await requireRunning(project, service);
  return RUNNERS[engine].run(name, query, allowWrite);
}

export async function getDbOverview(project: ProjectRow, service: ServiceRow): Promise<DbOverview> {
  const engine = dbConsoleEngine(service);
  if (!engine) throw new Error('Este servicio no tiene consola de consultas.');
  const name = await requireRunning(project, service);
  return RUNNERS[engine].overview(name);
}
