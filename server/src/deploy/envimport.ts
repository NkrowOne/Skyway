/**
 * Importación de las variables del `.env` del repositorio.
 *
 * Casi todo repo trae un `.env.example` con las variables que la aplicación
 * espera, y el primer despliegue en Skyway solía fallar por no tenerlas: la
 * gente las copiaba a mano una a una. Aquí se leen esos ficheros del checkout
 * (durante el build) o de la API de GitHub (a petición, desde el panel), se
 * decide qué merece importarse y qué solo merece un aviso, y se deja constancia
 * en la config del servicio para no volver a proponer lo mismo dos veces.
 *
 * La clasificación (`planEnvImport`) es pura para poder probarla sin BD ni
 * disco; `importRepoEnv` y `finalizeEnvImport` son las que tocan el estado.
 */

import fs from 'fs';
import path from 'path';
import { fireAlert } from '../alerts';
import { getEnv, getProjectVars, getService, setEnv, updateService } from '../db';
import { getRepoFile, listRepoDir } from '../github/client';
import { GitConfig, ServiceRow } from '../types';

export type EnvSkipReason = 'invalid_key' | 'reserved' | 'placeholder' | 'localhost' | 'exists' | 'handled';
export interface EnvImportSkipped { key: string; file: string; reason: EnvSkipReason }
export interface EnvImportPlan {
  /** Ficheros encontrados, en orden de precedencia creciente (p. ej. ['.env.example', '.env']). */
  files: string[];
  /** Variables con valor útil que se van a crear (o se han creado). `value` solo en la vista previa, nunca se persiste. */
  imported: { key: string; file: string; value?: string }[];
  /** Clave válida pero sin valor útil (vacía o placeholder) y no definida todavía: hay que rellenarla a mano. */
  pending: { key: string; file: string }[];
  skipped: EnvImportSkipped[];
}
export interface EnvImportReport extends EnvImportPlan {
  at: number;            // Date.now()
  applied: boolean;      // true si se escribieron variables
  /** Acumulado de claves ya tratadas en cualquier pasada (imported ∪ pending ∪ skipped): nunca se vuelven a proponer. */
  handled: string[];
  /** Origen: 'deploy' (durante el build) | 'manual' (POST …/env/import-repo). */
  source: 'deploy' | 'manual';
}

/**
 * Ficheros que se miran, del menos al más autoritativo: el `.env` real va el
 * último porque, si está en el repo, sus valores son los que la aplicación usa
 * de verdad y mandan sobre cualquier ejemplo.
 */
export const ENV_FILE_CANDIDATES = [
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
  '.env.defaults',
  'example.env',
  '.env',
] as const;

/** Un `.env` de más de 64 KB no es un fichero de variables: se ignora. */
export const ENV_FILE_MAX_BYTES = 64 * 1024;

/** Misma regla que `PUT /api/services/:id/env`: lo que no pase por ahí tampoco entra por aquí. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Referencia de Skyway (`${{Servicio.VAR}}`): parece un placeholder pero es un valor de verdad. */
const SKYWAY_REF_RE = /\$\{\{[^}]*\}\}/;

/** Texto en español de cada motivo, para el log del despliegue. */
export const SKIP_REASON_LABEL: Record<EnvSkipReason, string> = {
  invalid_key: 'nombre inválido',
  reserved: 'reservada',
  placeholder: 'valor de ejemplo',
  localhost: 'apunta a localhost',
  exists: 'ya definida',
  handled: 'ya tratada',
};

export interface EnvFileEntry { key: string; value: string }
export interface EnvFileSource { file: string; entries: EnvFileEntry[] }

// ---------- parser ----------

/** Escapes que dotenv interpreta dentro de comillas dobles. */
function unescapeDoubleQuoted(raw: string): string {
  return raw.replace(/\\(.)/gs, (_m, c: string) => {
    switch (c) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      default: return c; // \" \\ \' y cualquier otro: el carácter tal cual
    }
  });
}

/**
 * Parser propio de ficheros `.env`. Se queda deliberadamente en lo que dotenv
 * y docker-compose entienden igual: comentarios con `#`, prefijo `export `,
 * comillas simples y dobles (con escapes solo en las dobles), valores
 * multilínea entre comillas, `KEY=` vacío y espacios alrededor. Devuelve las
 * entradas en orden de aparición; dentro de un fichero, la última ocurrencia
 * de una clave manda (como en dotenv). Las claves inválidas se devuelven tal
 * cual para que la clasificación pueda avisar de ellas.
 */
export function parseEnvFile(text: string): EnvFileEntry[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = new Map<string, string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const sinExport = line.replace(/^export\s+/, '');
    const eq = sinExport.indexOf('=');
    if (eq < 0) continue; // `export FOO` a secas: declara sin valor, nada que importar
    const key = sinExport.slice(0, eq).trim();
    if (!key) continue;
    let rest = sinExport.slice(eq + 1).trimStart();

    let value: string;
    const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : null;
    if (quote) {
      // Se busca el cierre en esta línea o en las siguientes (valor multilínea).
      // En dobles, una comilla precedida de `\` no cierra.
      let body = rest.slice(1);
      let cierre = -1;
      for (;;) {
        cierre = findClosingQuote(body, quote);
        if (cierre >= 0 || i + 1 >= lines.length) break;
        body += '\n' + lines[++i];
      }
      if (cierre < 0) {
        // Sin cierre: se toma lo que hay, como hace dotenv, antes que perder la clave.
        value = quote === '"' ? unescapeDoubleQuoted(body) : body;
      } else {
        const raw = body.slice(0, cierre);
        value = quote === '"' ? unescapeDoubleQuoted(raw) : raw;
      }
    } else {
      // Sin comillas: un `#` precedido de espacio abre un comentario.
      const hash = rest.search(/\s#/);
      if (hash >= 0) rest = rest.slice(0, hash);
      value = rest.trim();
    }
    out.delete(key); // la última ocurrencia manda, pero conserva su posición final
    out.set(key, value);
  }
  return [...out.entries()].map(([key, value]) => ({ key, value }));
}

function findClosingQuote(body: string, quote: string): number {
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    if (quote === '"' && c === '\\') {
      j++; // salta el carácter escapado
      continue;
    }
    if (c === quote) return j;
  }
  return -1;
}

// ---------- clasificación ----------

/**
 * ¿Es un valor de relleno, de los que trae un `.env.example`? Se compara sin
 * distinguir mayúsculas. Una referencia de Skyway `${{Algo.VAR}}` no lo es
 * aunque lleve llaves: es justo lo que se quiere importar tal cual.
 */
export function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (v === '') return true;
  if (SKYWAY_REF_RE.test(v)) return false;
  const low = v.toLowerCase();
  if (/^<[\s\S]*>$/.test(low)) return true;
  if (/^\{\{[\s\S]*\}\}$/.test(low)) return true;
  if (/^x{3,}$/.test(low)) return true;
  if (/^(\.{3,}|…)$/.test(low)) return true;
  if (low === 'todo') return true;
  if (/change[-_]?me/.test(low)) return true;
  if (/(^|[^a-z])(your|tu)[-_]/.test(low)) return true;
  if (/replace/.test(low)) return true;
  if (/example|ejemplo/.test(low)) return true;
  if (/insert/.test(low)) return true;
  if (/secret_here/.test(low)) return true;
  if (/^sk-x+$/.test(low)) return true;
  if (/^\*{3,}$/.test(low)) return true;
  return false;
}

/** Valor que solo tiene sentido en la máquina de quien desarrolla: dentro del contenedor no hay nadie ahí. */
export function pointsToLocalhost(value: string): boolean {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(value);
}

/** `PORT` la fija Skyway y `RAILWAY_*` son del entorno de Railway, que aquí no existe. */
export function isReservedKey(key: string): boolean {
  return key === 'PORT' || key.startsWith('RAILWAY_');
}

export interface EnvImportContext {
  /** Claves ya definidas: variables del servicio y compartidas del proyecto. */
  existing: Iterable<string>;
  /** Claves tratadas en pasadas anteriores (`EnvImportReport.handled`). */
  handled?: Iterable<string>;
  /**
   * Claves que quedaron pendientes en la pasada anterior. Aunque estén en
   * `handled`, mientras sigan sin definirse se vuelven a listar como
   * pendientes: si no, el aviso del panel desaparecería en el segundo
   * despliegue con los valores todavía sin rellenar.
   */
  pending?: Iterable<string>;
}

/**
 * Decide qué hacer con cada clave de los ficheros encontrados. Pura: no lee la
 * BD ni el disco. Los ficheros llegan en orden de precedencia creciente y el
 * último que trae la clave manda; la excepción es un valor vacío o de relleno,
 * que no pisa un valor útil de un fichero anterior (un `.env` con `FOO=`
 * al lado de un `.env.example` con `FOO=production` no debería dejar FOO sin valor).
 */
export function planEnvImport(files: EnvFileSource[], ctx: EnvImportContext): EnvImportPlan {
  const existing = new Set(ctx.existing);
  const previousPending = new Set(ctx.pending ?? []);
  const handled = new Set(ctx.handled ?? []);

  const merged = new Map<string, { value: string; file: string }>();
  for (const src of files) {
    for (const { key, value } of src.entries) {
      const previo = merged.get(key);
      if (previo && isPlaceholder(value) && !isPlaceholder(previo.value)) continue;
      merged.set(key, { value, file: src.file });
    }
  }

  const plan: EnvImportPlan = { files: files.map((f) => f.file), imported: [], pending: [], skipped: [] };
  for (const [key, { value, file }] of merged) {
    if (!ENV_KEY_RE.test(key)) {
      plan.skipped.push({ key, file, reason: 'invalid_key' });
    } else if (isReservedKey(key)) {
      plan.skipped.push({ key, file, reason: 'reserved' });
    } else if (handled.has(key) && !(previousPending.has(key) && !existing.has(key))) {
      plan.skipped.push({ key, file, reason: 'handled' });
    } else if (existing.has(key)) {
      plan.skipped.push({ key, file, reason: 'exists' });
    } else if (isPlaceholder(value)) {
      plan.pending.push({ key, file });
    } else if (pointsToLocalhost(value)) {
      plan.skipped.push({ key, file, reason: 'localhost' });
    } else {
      plan.imported.push({ key, file, value });
    }
  }
  return plan;
}

// ---------- lectura de ficheros ----------

/**
 * Ficheros `.env` del checkout: en la raíz del repositorio y, si el contexto
 * del build es otro directorio, también ahí. Para cada nombre candidato se
 * mira primero la raíz y después el contexto, de modo que el fichero más
 * cercano a la aplicación manda sobre el de la raíz y el `.env` sigue mandando
 * sobre los ejemplos. Se saltan enlaces simbólicos: un repo podría apuntar a
 * un fichero del host y acabar con su contenido en el panel.
 */
export function scanRepoEnvFiles(workDir: string, contextDir: string): EnvFileSource[] {
  const root = path.resolve(workDir);
  const context = path.resolve(contextDir);
  if (!context.startsWith(root)) throw new Error('rootDir fuera del repositorio');
  const dirs = [...new Set([root, context])];
  const found: EnvFileSource[] = [];
  for (const name of ENV_FILE_CANDIDATES) {
    for (const dir of dirs) {
      const full = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > ENV_FILE_MAX_BYTES) continue;
      const text = fs.readFileSync(full, 'utf8');
      found.push({ file: path.relative(root, full) || name, entries: parseEnvFile(text) });
    }
  }
  return found;
}

/** Directorio de contexto normalizado como ruta relativa al repo ('' = raíz), o null si se sale de él. */
function normalizeRootDir(rootDir: string | undefined): string | null {
  const norm = path.posix.normalize((rootDir || '.').replace(/\\/g, '/')).replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (norm === '.' || norm === '') return '';
  if (norm === '..' || norm.startsWith('../') || norm.startsWith('/')) return null;
  return norm;
}

/**
 * Los mismos ficheros, pero leídos por la API de GitHub sin clonar (para la
 * importación manual desde el panel). Se lista cada directorio una vez y solo
 * se descargan los candidatos que existen, para no gastar cuota en 404.
 */
export async function fetchRepoEnvFiles(
  token: string | null,
  slug: { owner: string; repo: string },
  ref: string,
  rootDir: string | undefined,
): Promise<EnvFileSource[]> {
  const context = normalizeRootDir(rootDir);
  const dirs = [...new Set(['', ...(context ? [context] : [])])];
  const listings = new Map<string, Set<string>>();
  for (const dir of dirs) {
    const names = await listRepoDir(token, slug.owner, slug.repo, dir, ref);
    if (names) listings.set(dir, new Set(names));
  }
  const found: EnvFileSource[] = [];
  for (const name of ENV_FILE_CANDIDATES) {
    for (const dir of dirs) {
      if (!listings.get(dir)?.has(name)) continue;
      const file = dir ? `${dir}/${name}` : name;
      const text = await getRepoFile(token, slug.owner, slug.repo, file, ref);
      if (text === null) continue; // demasiado grande, o desapareció entre el listado y la lectura
      found.push({ file, entries: parseEnvFile(text) });
    }
  }
  return found;
}

// ---------- aplicación y persistencia ----------

/** Contexto de clasificación de un servicio: lo que ya tiene y lo que ya se trató. */
export function envImportContextFor(service: ServiceRow): EnvImportContext {
  const previous = (service.config as GitConfig).envImport;
  return {
    existing: [...Object.keys(getEnv(service.id)), ...Object.keys(getProjectVars(service.project_id))],
    handled: previous?.handled ?? [],
    pending: previous?.pending.map((p) => p.key) ?? [],
  };
}

function listaClaves(keys: string[], max = 6): string {
  return keys.length > max ? `${keys.slice(0, max).join(', ')}, …` : keys.join(', ');
}

/**
 * Convierte el plan en informe y, si se pide, lo aplica: escribe las variables,
 * guarda el informe (sin valores) en la config del servicio y avisa con la
 * campana. Con `apply: false` el informe conserva los valores para la vista
 * previa y no se persiste nada.
 */
export function finalizeEnvImport(
  service: ServiceRow,
  plan: EnvImportPlan,
  opts: { source: EnvImportReport['source']; apply: boolean },
): EnvImportReport {
  const previous = (service.config as GitConfig).envImport;
  const handled = new Set(previous?.handled ?? []);
  for (const i of plan.imported) handled.add(i.key);
  for (const p of plan.pending) handled.add(p.key);
  for (const s of plan.skipped) handled.add(s.key);

  const report: EnvImportReport = {
    files: plan.files,
    imported: plan.imported.map(({ key, file, value }) => (opts.apply ? { key, file } : { key, file, value })),
    pending: plan.pending,
    skipped: plan.skipped,
    at: Date.now(),
    applied: opts.apply && plan.imported.length > 0,
    handled: [...handled].sort(),
    source: opts.source,
  };
  if (!opts.apply) return report;

  if (plan.imported.length > 0) {
    const nuevas: Record<string, string> = {};
    for (const { key, value } of plan.imported) nuevas[key] = value ?? '';
    setEnv(service.id, { ...getEnv(service.id), ...nuevas });
  }

  // Se relee el servicio: la config en memoria de quien llama puede ser
  // anterior a un cambio de ajustes hecho mientras tanto desde el panel.
  const fresh = getService(service.id) ?? service;
  const cfg = { ...(fresh.config as GitConfig), envImport: report };
  updateService(service.id, fresh.name, cfg);
  // Y se actualiza también la copia de quien llama: el desplegador vuelve a
  // guardar `service.config` más adelante (puerto detectado) y borraría esto.
  (service.config as GitConfig).envImport = report;

  if (plan.imported.length > 0 || plan.pending.length > 0) {
    const importadas = plan.imported.map((i) => i.key);
    const pendientes = plan.pending.map((p) => p.key);
    const fichero = plan.files[plan.files.length - 1] ?? '.env';
    const partes: string[] = [];
    if (importadas.length > 0) {
      partes.push(`Se ${importadas.length === 1 ? 'ha importado 1 variable' : `han importado ${importadas.length} variables`} de ${fichero} (${listaClaves(importadas)}).`);
    }
    if (pendientes.length > 0) {
      partes.push(`${pendientes.length === 1 ? '1 pendiente de valor' : `${pendientes.length} pendientes de valor`}: ${listaClaves(pendientes)}.`);
    }
    const aplicacion =
      opts.source === 'deploy'
        ? 'Las importadas ya van en este despliegue.'
        : 'Redespliega el servicio para que el contenedor reciba las importadas.';
    fireAlert({
      quiet: true,
      severity: pendientes.length > 0 ? 'warning' : 'info',
      type: 'env_imported',
      serviceId: service.id,
      projectId: service.project_id,
      title:
        pendientes.length > 0
          ? `Variables pendientes de valor: ${service.name}`
          : `Variables importadas del repositorio: ${service.name}`,
      message: partes.join(' '),
      explanation:
        `${aplicacion} ` +
        (pendientes.length > 0
          ? 'Las pendientes traen un valor vacío o de ejemplo en el repositorio: rellénalas en la pestaña Variables del servicio y redespliega.'
          : 'Revísalas en la pestaña Variables del servicio.'),
      dedupeKey: `env_imported:${service.id}`,
    });
  }
  return report;
}

/** Líneas del log del despliegue. Solo claves: los valores no se escriben jamás. */
function logEnvImport(report: EnvImportReport, log: (line: string) => void): void {
  const ficheros = report.files;
  log(
    ficheros.length === 1
      ? `Variables: encontrado ${ficheros[0]} en el repositorio.`
      : `Variables: encontrados ${ficheros.slice(0, -1).join(', ')} y ${ficheros[ficheros.length - 1]} en el repositorio.`,
  );
  const importadas = report.imported.map((i) => i.key);
  const pendientes = report.pending.map((p) => p.key);
  // `exists` y `handled` se callan: en el segundo despliegue serían todas las
  // claves del fichero, una a una, y taparían lo que sí interesa.
  const ignoradas = report.skipped.filter((s) => s.reason !== 'exists' && s.reason !== 'handled');
  if (importadas.length > 0) {
    log(`Variables: ${importadas.length === 1 ? 'importada 1' : `importadas ${importadas.length}`} (${listaClaves(importadas)}).`);
  }
  if (pendientes.length > 0) {
    log(
      `Variables: ${pendientes.length} ${pendientes.length === 1 ? 'pendiente' : 'pendientes'} de valor (${listaClaves(pendientes)}): ` +
        `${pendientes.length === 1 ? 'rellénala' : 'rellénalas'} en la pestaña Variables.`,
    );
  }
  if (ignoradas.length > 0) {
    const detalle = ignoradas.slice(0, 6).map((s) => `${s.key}: ${SKIP_REASON_LABEL[s.reason]}`);
    if (ignoradas.length > 6) detalle.push('…');
    log(`Variables: ${ignoradas.length} ${ignoradas.length === 1 ? 'ignorada' : 'ignoradas'} (${detalle.join(', ')}).`);
  }
  if (importadas.length === 0 && pendientes.length === 0 && ignoradas.length === 0) {
    log('Variables: nada nuevo que importar.');
  }
}

/**
 * Importación durante el build: lee los `.env` del checkout, aplica las
 * variables útiles al servicio y lo cuenta en el log. Devuelve el informe, o
 * null si el repositorio no trae ningún fichero candidato. Lanza si el
 * directorio de contexto se sale del repo o no se puede leer: quien llama
 * decide si eso rompe el despliegue (no debería).
 */
export function importRepoEnv(opts: {
  service: ServiceRow;
  workDir: string;
  contextDir: string;
  log: (line: string) => void;
}): EnvImportReport | null {
  const files = scanRepoEnvFiles(opts.workDir, opts.contextDir);
  if (files.length === 0) return null;
  const plan = planEnvImport(files, envImportContextFor(opts.service));
  const report = finalizeEnvImport(opts.service, plan, { source: 'deploy', apply: true });
  logEnvImport(report, opts.log);
  return report;
}
