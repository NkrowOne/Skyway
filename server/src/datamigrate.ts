/**
 * Copia de datos de una base externa a una base gestionada de Skyway.
 *
 * Migrar de Railway se quedaba a medias: el informe de importación traía el
 * comando de `pg_dump | psql` y había que entrar por SSH al servidor a
 * ejecutarlo. Aquí ese último paso se hace desde el panel, con el log en vivo,
 * que es lo que convierte una migración en algo de una tarde y no de un fin de
 * semana.
 *
 * La URL de origen NUNCA se interpola en la línea de órdenes: viaja como
 * variable de entorno del `docker run` y el shell la lee con "$SRC" (mismo
 * patrón que dbconsole.ts y files.ts).
 */

import { spawn } from 'child_process';
import { getEnv } from './db';
import { bus } from './events';
import { spawnLogged } from './deploy/builder';
import { getRuntime, containerName, imageExists } from './docker/containers';
import { projectNetworkName } from './docker/networks';
import { effectiveDbVersion, getTemplate } from './templates';
import { DatabaseConfig, ProjectRow, ServiceRow } from './types';
import { id, lineSplitter, now } from './util';

const MAX_LOG_CHARS = 200_000;
/** Tope de duración: una copia que pasa de aquí es un problema, no una espera. */
const TIMEOUT_MS = 60 * 60_000;

export type MigrationStatus = 'running' | 'success' | 'failed' | 'canceled';

export interface DataMigration {
  id: string;
  serviceId: string;
  status: MigrationStatus;
  logs: string;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

interface RunningJob {
  migration: DataMigration;
  /** Proceso `docker run` en marcha, para poder cortarlo. */
  proc: { kill: (signal?: NodeJS.Signals) => boolean } | null;
  canceled: boolean;
}

/** Una copia por servicio: dos volcados a la vez sobre la misma base es un destrozo. */
const jobs = new Map<string, RunningJob>();

const channel = (serviceId: string) => `datamigrate:${serviceId}`;

export function onDataMigration(serviceId: string, fn: (ev: { type: 'log' | 'done'; line?: string; status?: MigrationStatus }) => void): () => void {
  const key = channel(serviceId);
  bus.on(key, fn);
  return () => bus.off(key, fn);
}

export function getDataMigration(serviceId: string): DataMigration | undefined {
  return jobs.get(serviceId)?.migration;
}

export function cancelDataMigration(serviceId: string): boolean {
  const job = jobs.get(serviceId);
  if (!job || job.migration.status !== 'running') return false;
  job.canceled = true;
  try {
    job.proc?.kill('SIGTERM');
  } catch {
    /* ya terminó */
  }
  return true;
}

/** Motores para los que Skyway sabe copiar datos. */
export const MIGRATABLE_TEMPLATES = ['postgres', 'mysql', 'mongo'] as const;

export function migrationSupported(template: string): boolean {
  return (MIGRATABLE_TEMPLATES as readonly string[]).includes(template);
}

interface Plan {
  /** Imagen con las herramientas de volcado (la del propio motor). */
  image: string;
  /** Variables que ve el contenedor: aquí van las credenciales, nunca en el comando. */
  env: Record<string, string>;
  /** Comando de shell; solo referencia variables, no las interpola. */
  script: string;
}

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('La URL de origen no es válida. Pega la cadena de conexión pública completa de la base de datos.');
  }
  if (!url.hostname) throw new Error('La URL de origen no indica ningún servidor.');
  return url;
}

/**
 * Prepara la copia según el motor. El destino se construye con las credenciales
 * que Skyway generó al crear el servicio, y el origen con lo que pegue el
 * usuario: ambos van por entorno.
 */
function planMigration(service: ServiceRow, project: ProjectRow, sourceUrl: string): Plan {
  const cfg = service.config as DatabaseConfig;
  const template = getTemplate(cfg.template);
  if (!template) throw new Error(`Plantilla desconocida: ${cfg.template}`);
  const version = effectiveDbVersion(template, cfg.version);
  const local = getEnv(service.id);
  const src = parseUrl(sourceUrl);

  if (template.key === 'postgres') {
    const user = local.POSTGRES_USER || 'skyway';
    const password = local.POSTGRES_PASSWORD || '';
    const database = local.POSTGRES_DB || 'skyway';
    return {
      image: `postgres:${version}`,
      env: {
        SRC: sourceUrl.trim(),
        DST: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${service.slug}:5432/${encodeURIComponent(database)}`,
      },
      // Volcado a fichero y después restauración, en vez de una tubería: `sh`
      // no siempre admite `pipefail` (dash no lo tiene) y con tubería un
      // pg_dump que muere a medias devolvería el éxito de psql, dejando la base
      // a medio copiar y con cara de haber ido bien.
      // --no-owner/--no-acl: los roles del origen no existen aquí y sin esto el
      // restore se llena de errores de permisos que no significan nada.
      script:
        'pg_dump --no-owner --no-acl --verbose -f /tmp/skyway-dump.sql "$SRC" && ' +
        'psql --set ON_ERROR_STOP=on -f /tmp/skyway-dump.sql "$DST"',
    };
  }

  if (template.key === 'mysql') {
    const user = local.MYSQL_USER || 'skyway';
    const password = local.MYSQL_PASSWORD || '';
    const database = local.MYSQL_DATABASE || 'skyway';
    return {
      image: `mysql:${version}`,
      env: {
        SRC_HOST: src.hostname,
        SRC_PORT: src.port || '3306',
        SRC_USER: decodeURIComponent(src.username || 'root'),
        SRC_PASS: decodeURIComponent(src.password || ''),
        SRC_DB: decodeURIComponent(src.pathname.replace(/^\//, '')) || 'railway',
        DST_HOST: service.slug,
        DST_USER: user,
        DST_PASS: password,
        DST_DB: database,
      },
      // --no-tablespaces evita el PROCESS privilege que los servicios
      // gestionados no conceden, y que hace fallar el volcado entero.
      script:
        'mysqldump --single-transaction --no-tablespaces -h "$SRC_HOST" -P "$SRC_PORT" -u "$SRC_USER" -p"$SRC_PASS" "$SRC_DB" > /tmp/skyway-dump.sql && ' +
        'mysql -h "$DST_HOST" -u "$DST_USER" -p"$DST_PASS" "$DST_DB" < /tmp/skyway-dump.sql',
    };
  }

  if (template.key === 'mongo') {
    const user = local.MONGO_INITDB_ROOT_USERNAME || 'skyway';
    const password = local.MONGO_INITDB_ROOT_PASSWORD || '';
    return {
      image: `mongo:${version}`,
      env: {
        SRC: sourceUrl.trim(),
        DST: `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${service.slug}:27017/?authSource=admin`,
      },
      script:
        'mongodump --uri="$SRC" --archive=/tmp/skyway.archive && ' +
        'mongorestore --uri="$DST" --archive=/tmp/skyway.archive --drop',
    };
  }

  throw new Error(
    `Skyway aún no sabe copiar datos de ${template.label}. ` +
      (template.key === 'redis'
        ? 'Redis suele usarse como caché y no necesita migración; si la necesitas, usa redis-cli --rdb.'
        : 'Cópialos con las herramientas del propio motor.'),
  );
}

/**
 * Lanza la copia. Devuelve el trabajo inmediatamente: el progreso se sigue por
 * el stream. Lanza si no se puede empezar (motor no soportado, base parada,
 * copia ya en marcha).
 */
export function startDataMigration(service: ServiceRow, project: ProjectRow, sourceUrl: string): DataMigration {
  if (service.type !== 'database') throw new Error('Solo las bases de datos gestionadas admiten copia de datos.');
  const existing = jobs.get(service.id);
  if (existing && existing.migration.status === 'running') {
    throw new Error('Ya hay una copia de datos en marcha para esta base.');
  }
  const plan = planMigration(service, project, sourceUrl);

  const migration: DataMigration = {
    id: id('mig'),
    serviceId: service.id,
    status: 'running',
    logs: '',
    startedAt: now(),
    finishedAt: null,
    error: null,
  };
  const job: RunningJob = { migration, proc: null, canceled: false };
  jobs.set(service.id, job);

  const log = (line: string) => {
    const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
    if (migration.logs.length < MAX_LOG_CHARS) migration.logs += stamped + '\n';
    bus.emit(channel(service.id), { type: 'log', line: stamped });
  };

  void run(job, service, project, plan, log);
  return migration;
}

async function run(job: RunningJob, service: ServiceRow, project: ProjectRow, plan: Plan, log: (l: string) => void): Promise<void> {
  const finish = (status: MigrationStatus, error: string | null) => {
    job.migration.status = status;
    job.migration.error = error;
    job.migration.finishedAt = now();
    bus.emit(channel(service.id), { type: 'done', status });
  };

  try {
    const runtime = await getRuntime(containerName(project, service));
    if (runtime.state !== 'running') {
      throw new Error('La base de datos de destino no está en marcha: despliégala antes de copiar los datos.');
    }
    if (!(await imageExists(plan.image))) {
      log(`Descargando ${plan.image} (trae las herramientas de volcado)...`);
      await spawnLogged('docker', ['pull', plan.image], {}, log);
    }

    log(`Copiando datos hacia «${service.name}» con ${plan.image}. Puede tardar según el tamaño de la base.`);
    const args = ['run', '--rm', '--network', projectNetworkName(project)];
    for (const key of Object.keys(plan.env)) args.push('--env', key);
    args.push('--env', 'SKYWAY_MIGRATE_SCRIPT', plan.image, 'sh', '-c', 'eval "$SKYWAY_MIGRATE_SCRIPT"');

    // Los valores (credenciales incluidas) llegan por el entorno del proceso
    // hijo; enmascarados en el log por si alguna herramienta los repite.
    const env = { ...plan.env, SKYWAY_MIGRATE_SCRIPT: plan.script };
    const mask = Object.values(plan.env).filter((v) => v.length >= 6);

    const timeout = setTimeout(() => {
      job.canceled = true;
      try {
        job.proc?.kill('SIGKILL');
      } catch {
        /* ya terminó */
      }
    }, TIMEOUT_MS);

    try {
      await spawnLogged(
        'docker',
        args,
        {
          env,
          mask,
          onSpawn: (p) => {
            job.proc = p;
          },
        },
        log,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (job.canceled) {
      log('✖ Copia cancelada.');
      finish('canceled', null);
      return;
    }
    log('✔ Copia de datos completada.');
    finish('success', null);
  } catch (err: any) {
    if (job.canceled) {
      log('✖ Copia cancelada.');
      finish('canceled', null);
      return;
    }
    const message = err?.message || String(err);
    log(`✖ Error: ${message}`);
    finish('failed', message);
  }
}

/**
 * Comprobación rápida de que la URL de origen responde, antes de empezar una
 * copia que podría tardar. Devuelve null si va bien, o el motivo del fallo.
 */
export async function probeSource(service: ServiceRow, project: ProjectRow, sourceUrl: string): Promise<string | null> {
  const plan = planMigration(service, project, sourceUrl);
  const probe =
    plan.image.startsWith('postgres')
      ? 'pg_isready -d "$SRC" -t 8'
      : plan.image.startsWith('mysql')
        ? 'mysql -h "$SRC_HOST" -P "$SRC_PORT" -u "$SRC_USER" -p"$SRC_PASS" -e "SELECT 1" "$SRC_DB"'
        : // mongosh solo viene en las imágenes de Mongo 6+; en las anteriores
          // la consola se llama «mongo».
          'mongosh --quiet --eval "db.runCommand({ping:1})" "$SRC" || mongo --quiet --eval "db.runCommand({ping:1})" "$SRC"';

  const args = ['run', '--rm', '--network', projectNetworkName(project)];
  for (const key of Object.keys(plan.env)) args.push('--env', key);
  args.push('--env', 'SKYWAY_PROBE', plan.image, 'sh', '-c', 'eval "$SKYWAY_PROBE"');

  return new Promise((resolve) => {
    const p = spawn('docker', args, {
      env: { ...process.env, ...plan.env, SKYWAY_PROBE: probe },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    const feed = lineSplitter((line) => {
      if (err.length < 500) err += line + '\n';
    });
    p.stderr.on('data', feed);
    const timer = setTimeout(() => {
      try {
        p.kill('SIGKILL');
      } catch {
        /* ya terminó */
      }
      resolve('El origen no respondió en 20 s. Comprueba que la URL es la pública y que el proxy TCP está activo.');
    }, 20_000);
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve(`No se pudo ejecutar la comprobación: ${e.message}`);
    });
    p.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? null : err.trim().slice(0, 400) || `La comprobación terminó con código ${code}`);
    });
  });
}
