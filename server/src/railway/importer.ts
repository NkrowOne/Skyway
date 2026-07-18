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
    return {
      template,
      version: exactOfficial && tag ? tag : tpl.defaultVersion,
      exact: exactOfficial,
    };
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

  return {
    railwayProjectId: detail.id,
    projectName: detail.name,
    environment,
    environments: detail.environments,
    services,
    sharedVarCount: Object.keys(sharedVars).length,
    warnings,
    _sharedVars: sharedVars,
  };
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
    flagRailwayHosts(vars, raw.name, warnings);
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
    flagRailwayHosts(vars, raw.name, warnings);
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
