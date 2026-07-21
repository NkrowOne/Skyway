import {
  createProject,
  createService,
  getEnv,
  listServices,
  projectSlugExists,
  setEnv,
  setProjectVars,
  setSetting,
} from '../db';
import { triggerDeploy } from '../deploy/deployer';
import { getTemplate } from '../templates';
import { DatabaseConfig, GitConfig, ImageConfig, ProjectRow, VolumeMount } from '../types';
import { slugify, randomToken } from '../util';
import { getRailwayProject, getRailwayVariables, RailwayServiceRaw } from './client';

// ---------- análisis ----------

export interface PlannedService {
  railwayName: string;
  kind: 'git' | 'database' | 'image' | 'skipped';
  template?: string;
  version?: string;
  image?: string;
  repoUrl?: string;
  branch?: string;
  rootDir?: string;
  startCmd?: string;
  port?: number | null;
  domains: string[];
  volumeMounts: string[];
  varCount: number;
  notes: string[];
  /** interno: variables originales de Railway (no se exponen en el plan). */
  _vars?: Record<string, string>;
}

export interface ImportPlan {
  railwayProjectId: string;
  projectName: string;
  environment: { id: string; name: string };
  environments: { id: string; name: string }[];
  services: PlannedService[];
  sharedVarCount: number;
  warnings: string[];
  _sharedVars?: Record<string, string>;
}

const RAILWAY_HOST_RE = /railway\.internal|railway\.app|rlwy\.net/i;

function splitImage(image: string): { name: string; tag: string | null } {
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  if (colon > slash) return { name: image.slice(0, colon), tag: image.slice(colon + 1) };
  return { name: image, tag: null };
}

/** Mapea una imagen de Railway a una plantilla de base de datos de Skyway. */
function matchTemplate(image: string): { template: string; version: string; exact: boolean } | null {
  const { name, tag } = splitImage(image.toLowerCase());
  const norm = name.replace(/^docker\.io\//, '').replace(/^library\//, '');
  const exactOfficial = ['postgres', 'redis', 'mysql', 'mongo'].includes(norm) || norm === 'minio/minio';

  const pick = (template: string) => {
    const tpl = getTemplate(template)!;
    let version = exactOfficial && tag ? tag : tpl.defaultVersion;
    // Las imágenes de Railway (p. ej. postgres-ssl:18) codifican la versión
    // mayor en el tag: respetarla evita que pg_dump rechace el volcado por
    // ser el servidor origen más nuevo que el cliente.
    if (!exactOfficial && template === 'postgres' && tag) {
      const major = parseInt(tag, 10);
      if (Number.isInteger(major) && major >= 13) version = `${major}-alpine`;
    }
    return { template, version, exact: exactOfficial };
  };

  if (/postgis/.test(norm)) return null; // postgis necesita su propia imagen
  if (/postgres/.test(norm)) return pick('postgres');
  if (/redis/.test(norm)) return pick('redis');
  if (/mysql/.test(norm)) return pick('mysql');
  if (/mariadb/.test(norm)) return null; // compatible pero con env distinto: mejor como imagen
  if (/mongo(?!-express)/.test(norm)) return pick('mongo');
  if (/minio/.test(norm)) return pick('minio');
  return null;
}

function filterVars(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (k.startsWith('RAILWAY_')) continue;
    out[k] = v;
  }
  return out;
}

/** Analiza un proyecto de Railway y produce el plan de importación. */
export async function analyzeRailwayProject(
  token: string,
  projectId: string,
  environmentId?: string,
): Promise<ImportPlan> {
  const detail = await getRailwayProject(token, projectId, environmentId);
  if (detail.environments.length === 0) {
    throw new Error('El proyecto de Railway no tiene entornos');
  }
  const environment =
    detail.environments.find((e) => e.id === environmentId) ||
    detail.environments.find((e) => e.name === 'production') ||
    detail.environments[0];

  const warnings: string[] = [];
  const sharedVars = filterVars(await getRailwayVariables(token, projectId, environment.id));

  const services: PlannedService[] = [];
  for (const raw of detail.services) {
    services.push(await planService(token, projectId, environment.id, raw, warnings));
  }

  const domainsSkipped = detail.services.flatMap((s) => s.serviceDomains);
  if (domainsSkipped.length > 0) {
    warnings.push(
      `Se omiten ${domainsSkipped.length} dominio(s) generados por Railway (*.up.railway.app): en Skyway genera los tuyos con tu dominio raíz o añade dominios propios.`,
    );
  }

  const plan: ImportPlan = {
    railwayProjectId: detail.id,
    projectName: detail.name,
    environment,
    environments: detail.environments,
    services,
    sharedVarCount: Object.keys(sharedVars).length,
    warnings,
    _sharedVars: sharedVars,
  };

  // Primero reconectamos a las bases de datos que también se importan; solo lo
  // que quede sin mapear merece el aviso de "revísala tras importar".
  reconnectRailwayVars(plan);
  for (const p of plan.services) {
    if (p.kind === 'git' || p.kind === 'image') flagRailwayHosts(p._vars ?? {}, p.railwayName, plan.warnings);
  }
  flagRailwayHosts(sharedVars, 'compartidas', plan.warnings);
  return plan;
}

async function planService(
  token: string,
  projectId: string,
  environmentId: string,
  raw: RailwayServiceRaw,
  warnings: string[],
): Promise<PlannedService> {
  const notes: string[] = [];
  const vars = filterVars(await getRailwayVariables(token, projectId, environmentId, raw.id));
  const base: PlannedService = {
    railwayName: raw.name,
    kind: 'skipped',
    domains: raw.customDomains,
    volumeMounts: raw.volumeMounts,
    varCount: Object.keys(vars).length,
    notes,
    _vars: vars,
  };

  // Puerto: Railway inyecta PORT dinámico; si el servicio lo fijaba, lo respetamos.
  const portVar = Number(vars.PORT);
  const explicitPort = Number.isInteger(portVar) && portVar > 0 && portVar < 65536 ? portVar : null;

  if (raw.image) {
    const template = matchTemplate(raw.image);
    if (template) {
      base.kind = 'database';
      base.template = template.template;
      base.version = template.version;
      if (!template.exact) {
        notes.push(`Imagen original "${raw.image}": se usará la plantilla oficial ${template.template}:${template.version}.`);
      }
      notes.push('Se generan credenciales nuevas; los datos se copian con el comando del informe.');
      return base;
    }
    base.kind = 'image';
    base.image = raw.image;
    base.port = explicitPort;
    base.startCmd = raw.startCommand ?? undefined;
    if (!explicitPort) notes.push('Sin puerto conocido: configúralo en Ajustes si el servicio sirve HTTP.');
    return base;
  }

  if (raw.repo) {
    base.kind = 'git';
    base.repoUrl = `https://github.com/${raw.repo}`;
    base.branch = raw.branch ?? 'main';
    if (!raw.branch) notes.push('Railway no expuso la rama: se asume "main", verifícala en Ajustes.');
    base.rootDir = raw.rootDirectory?.replace(/^\//, '') || undefined;
    base.startCmd = raw.startCommand ?? undefined;
    base.port = explicitPort ?? 3000;
    if (!explicitPort) notes.push('Puerto interno asumido 3000: ajústalo si tu app escucha en otro.');
    if (raw.buildCommand) {
      notes.push(`Build command de Railway ("${raw.buildCommand}") no se traslada: Skyway construye con Dockerfile o Nixpacks.`);
    }
    return base;
  }

  notes.push('Servicio sin repositorio ni imagen: no se importa.');
  return base;
}

function flagRailwayHosts(vars: Record<string, string>, serviceName: string, warnings: string[]): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v.includes('${{')) continue; // las referencias se re-resuelven en Skyway
    if (RAILWAY_HOST_RE.test(v)) {
      warnings.push(`Variable ${serviceName}.${k} apunta a infraestructura de Railway: revísala tras importar.`);
    }
  }
}

// ---------- reconexión de variables Railway → servicios nuevos ----------

/** Variables de conexión que exporta cada plantilla, para reconstruir referencias. */
const TEMPLATE_CONN: Record<string, { main: string; host?: string; port?: string }> = {
  postgres: { main: 'DATABASE_URL', host: 'PGHOST', port: 'PGPORT' },
  redis: { main: 'REDIS_URL', host: 'REDIS_HOST', port: 'REDIS_PORT' },
  mysql: { main: 'MYSQL_URL', host: 'MYSQL_HOST', port: 'MYSQL_PORT' },
  mongo: { main: 'MONGO_URL', host: 'MONGO_HOST', port: 'MONGO_PORT' },
  minio: { main: 'MINIO_ENDPOINT' },
};

/** Esquema de URL → plantilla, para mapear por tipo cuando el host no identifica la base. */
const SCHEME_TEMPLATE: [RegExp, string][] = [
  [/^postgres(?:ql)?:\/\//i, 'postgres'],
  [/^rediss?:\/\//i, 'redis'],
  [/^mysql:\/\//i, 'mysql'],
  [/^mongodb(?:\+srv)?:\/\//i, 'mongo'],
];

// Solo se usa con matchAll (clona el regex): nunca con test/exec, que arrastrarían lastIndex.
const ENDPOINT_RE = /([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:railway\.internal|rlwy\.net|railway\.app))(?::(\d+))?/gi;

/** El scope de una referencia solo admite este alfabeto (ver REF_RE en variables.ts). */
const SAFE_REF_NAME_RE = /^[A-Za-z0-9 _.-]+$/;

interface DbTarget {
  planned: PlannedService;
  conn: { main: string; host?: string; port?: string };
  /** Hosts privados (railway.internal): identifican la base por sí solos. */
  privateHosts: Set<string>;
  /** Proxies públicos host:puerto (rlwy.net comparte host entre bases distintas). */
  publicHostPorts: Set<string>;
}

function collectDbTargets(services: PlannedService[]): DbTarget[] {
  const targets: DbTarget[] = [];
  for (const p of services) {
    if (p.kind !== 'database' || !p.template) continue;
    const conn = TEMPLATE_CONN[p.template];
    if (!conn) continue;
    const privateHosts = new Set<string>();
    const publicHostPorts = new Set<string>();
    for (const v of Object.values(p._vars ?? {})) {
      for (const m of v.matchAll(ENDPOINT_RE)) {
        const host = m[1].toLowerCase();
        if (host.endsWith('railway.internal')) privateHosts.add(host);
        else if (m[2]) publicHostPorts.add(`${host}:${m[2]}`);
      }
    }
    targets.push({ planned: p, conn, privateHosts, publicHostPorts });
  }
  return targets;
}

function matchTargets(value: string, targets: DbTarget[]): DbTarget[] {
  const found = new Set<DbTarget>();
  for (const m of value.matchAll(ENDPOINT_RE)) {
    const host = m[1].toLowerCase();
    for (const t of targets) {
      if (t.privateHosts.has(host)) found.add(t);
      else if (m[2] && t.publicHostPorts.has(`${host}:${m[2]}`)) found.add(t);
    }
  }
  return [...found];
}

/**
 * Reescribe un valor que apunta a una base de datos de Railway como referencia
 * `${{Base.VAR}}` al servicio nuevo. Devuelve null si no procede (sin match,
 * match ambiguo, o ya es una referencia).
 */
function rewriteValue(value: string, targets: DbTarget[]): string | null {
  if (value.includes('${{') || !RAILWAY_HOST_RE.test(value)) return null;
  let matched = matchTargets(value, targets);
  if (matched.length === 0) {
    // El host no identifica la base (p. ej. proxy sin puerto conocido): por
    // esquema, solo si hay exactamente una base de ese tipo en el proyecto.
    const scheme = SCHEME_TEMPLATE.find(([re]) => re.test(value.trim()));
    if (scheme) {
      const ofKind = targets.filter((t) => t.planned.template === scheme[1]);
      if (ofKind.length === 1) matched = ofKind;
    }
  }
  if (matched.length !== 1) return null;

  const t = matched[0];
  const name = SAFE_REF_NAME_RE.test(t.planned.railwayName) ? t.planned.railwayName : slugify(t.planned.railwayName);
  const ref = (v: string) => `\${{${name}.${v}}}`;
  const trimmed = value.trim();

  // Cadena de conexión completa (esquema o credenciales) → variable principal.
  // Las credenciales y el nombre de la base cambian al importar, así que se
  // sustituye el valor entero, no solo el host.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.includes('@')) return ref(t.conn.main);

  // Valor que es solo `host` o `host:puerto`.
  const hostLike = /^([a-z0-9.-]+)(?::(\d+))?$/i.exec(trimmed);
  if (hostLike) {
    if (hostLike[2] && t.conn.host && t.conn.port) return `${ref(t.conn.host)}:${ref(t.conn.port)}`;
    if (!hostLike[2] && t.conn.host) return ref(t.conn.host);
    return ref(t.conn.main);
  }

  // Host incrustado en un valor mayor (p. ej. jdbc:...): se sustituye solo el endpoint.
  if (t.conn.host) {
    let next = value;
    for (const m of [...value.matchAll(ENDPOINT_RE)]) {
      if (m[2] && !t.conn.port) continue; // no hay con qué sustituir el puerto
      const rep = m[2] ? `${ref(t.conn.host)}:${ref(t.conn.port!)}` : ref(t.conn.host);
      next = next.split(m[0]).join(rep);
    }
    if (next !== value) return next;
  }
  return null;
}

const summarizeChanges = (items: string[]): string =>
  items.length > 4 ? `${items.slice(0, 4).join(', ')} y ${items.length - 4} más` : items.join(', ');

/**
 * Sustituye en las variables de apps y compartidas los endpoints de Railway de
 * bases de datos que también se importan por referencias al servicio nuevo,
 * para que la app llegue por la red interna del proyecto sin tocar nada a mano.
 */
function reconnectRailwayVars(plan: ImportPlan): void {
  const targets = collectDbTargets(plan.services);
  if (targets.length === 0) return;

  const apply = (vars: Record<string, string>): string[] => {
    const changed: string[] = [];
    for (const [k, v] of Object.entries(vars)) {
      const next = rewriteValue(v, targets);
      if (next !== null) {
        vars[k] = next;
        changed.push(`${k} → ${next}`);
      }
    }
    return changed;
  };

  for (const p of plan.services) {
    if ((p.kind !== 'git' && p.kind !== 'image') || !p._vars) continue;
    const changed = apply(p._vars);
    if (changed.length > 0) {
      p.notes.push(`Variables reconectadas a las bases de datos nuevas: ${summarizeChanges(changed)}.`);
    }
  }
  if (plan._sharedVars) {
    const changed = apply(plan._sharedVars);
    if (changed.length > 0) {
      plan.warnings.push(`Variables compartidas reconectadas a las bases de datos nuevas: ${summarizeChanges(changed)}.`);
    }
  }
}

// ---------- ejecución ----------

export interface DataCopyEntry {
  service: string;
  template: string;
  command: string | null;
  note: string;
}

export interface ImportReport {
  ts: number;
  railwayProject: string;
  environment: string;
  projectId: string;
  projectName: string;
  created: { name: string; kind: string; notes: string[] }[];
  skipped: { name: string; notes: string[] }[];
  warnings: string[];
  dataCopy: DataCopyEntry[];
  nextSteps: string[];
}

export async function runRailwayImport(
  token: string,
  railwayProjectId: string,
  environmentId: string,
  opts: { projectName?: string; client?: string | null },
): Promise<{ project: ProjectRow; report: ImportReport }> {
  const plan = await analyzeRailwayProject(token, railwayProjectId, environmentId);

  const name = (opts.projectName || plan.projectName).trim() || plan.projectName;
  let slug = slugify(name);
  let i = 2;
  while (projectSlugExists(slug)) slug = `${slugify(name)}-${i++}`;
  const project = createProject(name, slug, opts.client?.trim() || null);

  if (plan._sharedVars && Object.keys(plan._sharedVars).length > 0) {
    setProjectVars(project.id, plan._sharedVars);
  }

  const report: ImportReport = {
    ts: Date.now(),
    railwayProject: plan.projectName,
    environment: plan.environment.name,
    projectId: project.id,
    projectName: name,
    created: [],
    skipped: [],
    warnings: [...plan.warnings],
    dataCopy: [],
    nextSteps: [],
  };

  const usedSlugs = new Set<string>();
  const uniqueSlug = (svcName: string) => {
    const base = slugify(svcName);
    let s = base;
    let n = 2;
    while (usedSlugs.has(s)) s = `${base}-${n++}`;
    usedSlugs.add(s);
    return s;
  };

  const toDeploy: string[] = [];

  for (const planned of plan.services) {
    if (planned.kind === 'skipped') {
      report.skipped.push({ name: planned.railwayName, notes: planned.notes });
      continue;
    }
    const svcSlug = uniqueSlug(planned.railwayName);
    const volumes: VolumeMount[] = planned.volumeMounts.map((mountPath, idx) => ({
      name: `skyway-${project.slug}-${svcSlug}-data${idx === 0 ? '' : idx + 1}`,
      containerPath: mountPath,
    }));

    if (planned.kind === 'database') {
      const template = getTemplate(planned.template!)!;
      const cfg: DatabaseConfig = { template: template.key, version: planned.version || template.defaultVersion };
      const service = createService(project.id, planned.railwayName, svcSlug, 'database', cfg);
      setEnv(service.id, template.makeEnv(svcSlug));
      toDeploy.push(service.id);
      report.dataCopy.push(buildDataCopyEntry(project, svcSlug, planned, template.key, cfg.version));
      report.created.push({ name: planned.railwayName, kind: `base de datos (${template.label})`, notes: planned.notes });
    } else if (planned.kind === 'image') {
      const cfg: ImageConfig = {
        image: planned.image!,
        port: planned.port ?? null,
        startCmd: planned.startCmd,
        domains: planned.domains,
        volumes: volumes.length ? volumes : undefined,
      };
      const service = createService(project.id, planned.railwayName, svcSlug, 'image', cfg);
      setEnv(service.id, planned._vars ?? {});
      toDeploy.push(service.id);
      report.created.push({ name: planned.railwayName, kind: `imagen (${planned.image})`, notes: planned.notes });
    } else {
      const cfg: GitConfig = {
        repoUrl: planned.repoUrl!,
        branch: planned.branch || 'main',
        rootDir: planned.rootDir,
        startCmd: planned.startCmd,
        port: planned.port || 3000,
        domains: planned.domains,
        webhookSecret: randomToken(16),
        volumes: volumes.length ? volumes : undefined,
      };
      const service = createService(project.id, planned.railwayName, svcSlug, 'git', cfg);
      setEnv(service.id, planned._vars ?? {});
      report.created.push({ name: planned.railwayName, kind: 'repositorio', notes: planned.notes });
    }
  }

  // Bases de datos e imágenes arrancan ya; los repos se despliegan cuando el usuario quiera.
  for (const serviceId of toDeploy) triggerDeploy(serviceId, 'import');

  const gitCount = report.created.filter((c) => c.kind === 'repositorio').length;
  const domainCount = plan.services.flatMap((s) => s.domains).length;
  if (gitCount > 0) {
    report.nextSteps.push(`Despliega los ${gitCount} servicio(s) de repositorio (botón Desplegar). Si alguno es privado, configura antes el token de GitHub en Ajustes.`);
  }
  if (report.dataCopy.some((d) => d.command)) {
    report.nextSteps.push('Copia los datos de las bases de datos con los comandos del informe (ejecútalos en el servidor).');
  }
  if (domainCount > 0) {
    report.nextSteps.push(`Apunta el DNS de tus ${domainCount} dominio(s) a la IP de este servidor cuando quieras hacer el cambio.`);
  }
  report.nextSteps.push('Configura los webhooks de GitHub de cada servicio para el auto-deploy (Ajustes del servicio).');
  report.nextSteps.push('Cuando todo funcione, pausa o borra el proyecto en Railway.');

  setSetting(`importReport:${project.id}`, JSON.stringify(report));
  return { project, report };
}

/** Genera el comando de copia de datos Railway → Skyway para una base de datos. */
function buildDataCopyEntry(
  project: ProjectRow,
  svcSlug: string,
  planned: PlannedService,
  templateKey: string,
  version: string,
): DataCopyEntry {
  const vars = planned._vars ?? {};
  // Credenciales locales recién generadas del servicio:
  const service = listServices(project.id).find((s) => s.slug === svcSlug);
  const localEnv = service ? getEnv(service.id) : {};
  const network = `skyway-${project.slug}`;
  const entry: DataCopyEntry = { service: planned.railwayName, template: templateKey, command: null, note: '' };

  const publicUrl =
    vars.DATABASE_PUBLIC_URL || vars.MYSQL_PUBLIC_URL || vars.MONGO_PUBLIC_URL || vars.REDIS_PUBLIC_URL ||
    Object.entries(vars).find(([k, v]) => /_URL$/.test(k) && /rlwy\.net|railway\.app/.test(v))?.[1];

  if (templateKey === 'redis') {
    entry.note = 'Redis suele usarse como caché: normalmente no hace falta migrar datos. Si los necesitas, usa redis-cli --rdb.';
    return entry;
  }
  if (!publicUrl) {
    entry.note = 'Railway no expone URL pública para esta base de datos: activa el TCP Proxy en Railway o exporta/importa manualmente.';
    return entry;
  }

  if (templateKey === 'postgres') {
    entry.command = `docker run --rm --network ${network} postgres:${version} sh -c 'pg_dump --no-owner --no-acl "${publicUrl}" | psql "postgresql://skyway:${localEnv.POSTGRES_PASSWORD}@${svcSlug}:5432/skyway"'`;
    entry.note = 'Ejecuta el comando en el servidor con el servicio ya desplegado. Copia esquema y datos.';
  } else if (templateKey === 'mysql') {
    const u = tryParseUrl(publicUrl);
    if (u) {
      const db = u.pathname.replace(/^\//, '') || 'railway';
      entry.command = `docker run --rm --network ${network} mysql:${version} sh -c 'mysqldump --single-transaction -h ${u.hostname} -P ${u.port || '3306'} -u ${decodeURIComponent(u.username)} -p"${decodeURIComponent(u.password)}" ${db} | mysql -h ${svcSlug} -u skyway -p"${localEnv.MYSQL_PASSWORD}" skyway'`;
      entry.note = 'Ejecuta el comando en el servidor con el servicio ya desplegado.';
    } else {
      entry.note = `No se pudo interpretar la URL pública (${publicUrl.slice(0, 40)}...): exporta con mysqldump manualmente.`;
    }
  } else if (templateKey === 'mongo') {
    entry.command = `docker run --rm --network ${network} mongo:${version} sh -c 'mongodump --uri="${publicUrl}" --archive | mongorestore --uri="mongodb://skyway:${localEnv.MONGO_INITDB_ROOT_PASSWORD}@${svcSlug}:27017" --archive --drop'`;
    entry.note = 'Ejecuta el comando en el servidor con el servicio ya desplegado. --drop sustituye colecciones existentes.';
  } else if (templateKey === 'minio') {
    entry.note = 'Copia los objetos con `mc mirror` (MinIO Client) entre el bucket antiguo y el nuevo.';
  }
  return entry;
}

function tryParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}
