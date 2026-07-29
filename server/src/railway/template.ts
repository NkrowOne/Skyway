import { getRailwayTemplate, RailwayTemplate, RailwayTemplateService } from './client';
import { rewriteRailwayRefs, RailwayRefCtx } from './importer';
import { slugify } from '../util';

/**
 * Instanciar una plantilla del catálogo de Railway DENTRO de un proyecto ya
 * existente, como hace Railway al añadir una plantilla a un proyecto.
 *
 * La plantilla se toma tal cual la declara su autor: cada servicio se crea con
 * la imagen o el repositorio que dice, sin intentar sustituirlo por una base de
 * datos gestionada de Skyway. Esa sustitución sí tiene sentido importando un
 * proyecto ajeno (un `postgres:16` suelto es Postgres y ya está), pero aquí
 * traicionaría a la plantilla: la «Postgres» de la plantilla de Supabase es una
 * imagen propia con sus roles y extensiones, y cambiarla por la nuestra rompería
 * todo lo que cuelga de ella.
 *
 * Lo que sí se adapta es el cableado: las variables mágicas de Railway se
 * traducen a lo que existe aquí (ver `rewriteRailwayRefs`) y el arranque va por
 * etapas (ver `assignStages`).
 */

export interface TemplateServicePlan {
  /** Nombre original en la plantilla (es el ámbito de sus referencias). */
  templateName: string;
  /** Nombre y slug con los que se creará en Skyway. */
  name: string;
  slug: string;
  kind: 'image' | 'git';
  image?: string;
  repoUrl?: string;
  rootDir?: string;
  startCmd?: string;
  healthcheckPath?: string;
  port: number | null;
  volumes: string[];
  env: Record<string, string>;
  /** Recibe el dominio público de la instalación. */
  public: boolean;
  /** Etapa de arranque (ver assignStages). */
  stage: number;
  /** Comando de sondeo dentro del contenedor, si se reconoce el motor. */
  readyCmd?: string;
  notes: string[];
}

export interface TemplatePlan {
  code: string;
  name: string;
  description: string | null;
  prefix: string;
  services: TemplateServicePlan[];
  warnings: string[];
}

/** Puerto público y de proxy TCP que declara la plantilla. */
function portsOf(svc: RailwayTemplateService): { httpPort: number | null; tcpPort: number | null } {
  let httpPort: number | null = null;
  for (const d of Object.values(svc.networking?.serviceDomains ?? {})) {
    if (typeof d?.port === 'number') httpPort = d.port;
  }
  let tcpPort: number | null = null;
  for (const key of Object.keys(svc.networking?.tcpProxies ?? {})) {
    const p = Number(key);
    if (Number.isInteger(p) && p > 0) tcpPort = p;
  }
  return { httpPort, tcpPort };
}

/**
 * Alrededor de una base de datos orbitan imágenes cuyo nombre la mencionan sin
 * serlo: postgREST, postgres-meta, pgbouncer, exporters... Sondearlas con
 * `pg_isready` (que ni siquiera traen) haría esperar cinco minutos y abortaría
 * la instalación entera.
 */
const NOT_A_DB_RE = /postgrest|-meta|pgadmin|pgbouncer|bouncer|exporter|backup|proxy|studio|admin/;

/**
 * Sondeo de arranque solo cuando el servicio es de verdad un motor: la imagen lo
 * dice Y además persiste datos o expone el puerto del motor. Lo demás no se
 * inventa: sin sondeo simplemente se usa el periodo de gracia de siempre.
 */
function readyCmdFor(
  image: string | undefined,
  opts: { hasVolume: boolean; tcpPort: number | null },
): string | undefined {
  if (!image) return undefined;
  const img = image.toLowerCase();
  if (NOT_A_DB_RE.test(img)) return undefined;
  if (!opts.hasVolume && opts.tcpPort === null) return undefined;
  if (/postgres|postgis|timescale/.test(img)) return 'pg_isready -h 127.0.0.1';
  if (/mysql|mariadb/.test(img)) return 'mysqladmin ping -h 127.0.0.1 --silent';
  return undefined;
}

/**
 * Orden de arranque. NO se deduce del grafo de referencias entre variables: en
 * una plantilla real ese grafo es cíclico (en la de Supabase, Postgres cita a
 * Postgrest y Studio a Kong y al revés, porque las variables sirven para
 * cablear, no para ordenar), y tratarlo como dependencias da resultados
 * absurdos como levantar Postgrest antes que Postgres.
 *
 * Se usa el orden que de verdad importa al arrancar: primero las bases de datos
 * —las únicas de las que algo se cae si no están—, después las aplicaciones, y
 * la puerta de entrada al final, que es la que enruta hacia todo lo demás.
 */
function assignStages(services: TemplateServicePlan[]): void {
  const hayVarias = services.length > 1;
  for (const svc of services) {
    if (svc.readyCmd) svc.stage = 0;
    else if (svc.public && hayVarias) svc.stage = 2;
    else svc.stage = 1;
  }
}

/** Traduce una plantilla pública de Railway al plan de servicios de Skyway. */
export async function planRailwayTemplate(
  code: string,
  opts: { prefix?: string; projectName: string },
): Promise<TemplatePlan> {
  const tpl: RailwayTemplate = await getRailwayTemplate(code);
  const prefix = slugify(opts.prefix || tpl.name) || 'plantilla';
  const warnings: string[] = [];

  const services: TemplateServicePlan[] = [];
  for (const svc of tpl.services) {
    const templateName = (svc.name || '').trim();
    if (!templateName) continue;
    const notes: string[] = [];
    const { httpPort, tcpPort } = portsOf(svc);
    const image = svc.source?.image?.trim();
    const repo = svc.source?.repo?.trim();
    if (!image && !repo) {
      warnings.push(`El servicio «${templateName}» no declara imagen ni repositorio: se omite.`);
      continue;
    }

    const env: Record<string, string> = {};
    const pendientes: string[] = [];
    for (const [key, def] of Object.entries(svc.variables ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      const value = def?.defaultValue;
      if (value === null || value === undefined || value === '') {
        // Variable que la plantilla espera que rellene quien la instala.
        if (def?.isOptional !== true) pendientes.push(key);
        env[key] = '';
      } else {
        env[key] = String(value);
      }
    }
    if (pendientes.length > 0) {
      notes.push(`Variables que la plantilla deja en tu mano: ${pendientes.join(', ')}. Rellénalas antes de desplegar.`);
    }
    if (repo) {
      notes.push('Servicio de repositorio: Skyway lo construirá con su Dockerfile o con Nixpacks, no con el builder de Railway.');
    }

    const volumes = Object.values(svc.volumeMounts ?? {})
      .map((v) => v?.mountPath)
      .filter((p): p is string => !!p && p.startsWith('/'));

    services.push({
      templateName,
      name: `${prefix}-${slugify(templateName)}`,
      slug: `${prefix}-${slugify(templateName)}`,
      kind: image ? 'image' : 'git',
      image,
      repoUrl: repo ? (repo.startsWith('http') ? repo : `https://github.com/${repo}`) : undefined,
      rootDir: svc.source?.rootDirectory?.replace(/^\//, '') || undefined,
      startCmd: svc.deploy?.startCommand ?? undefined,
      healthcheckPath: svc.deploy?.healthcheckPath ?? undefined,
      port: httpPort ?? tcpPort,
      volumes,
      env,
      public: httpPort !== null,
      stage: 0,
      readyCmd: readyCmdFor(image, { hasVolume: volumes.length > 0, tcpPort }),
      notes,
    });
  }

  if (services.length === 0) throw new Error('La plantilla no tiene ningún servicio que Skyway pueda crear.');

  if (tpl.buckets.length > 0) {
    warnings.push(
      `La plantilla cuenta con ${tpl.buckets.length} bucket(s) de almacenamiento de Railway (${tpl.buckets.join(', ')}), que Skyway no provee: las variables que apuntan a ellos quedan sin resolver. Si los necesitas, añade un servicio MinIO al proyecto y rellénalas con sus credenciales.`,
    );
  }

  // Un solo servicio público: si la plantilla declara varios dominios, el
  // dominio que dé el usuario va al primero y el resto queda accesible por la
  // red interna (Skyway no reparte subdominios automáticos).
  const publicos = services.filter((s) => s.public);
  if (publicos.length > 1) {
    for (const s of publicos.slice(1)) s.public = false;
    warnings.push(
      `La plantilla expone ${publicos.length} servicios a internet; aquí el dominio va a «${publicos[0].templateName}». A los demás añádeles el suyo en Ajustes.`,
    );
  }

  assignStages(services);
  return { code: tpl.code, name: tpl.name, description: tpl.description, prefix, services, warnings };
}

/**
 * Traduce las referencias de todos los servicios del plan. Se hace aparte del
 * planificado porque necesita los slugs de todos, incluidos los que aún no se
 * habían recorrido.
 */
export function rewriteTemplateRefs(
  plan: TemplatePlan,
  ctx: { projectName: string; domain: string | null },
): void {
  const refCtx: RailwayRefCtx = {
    byName: new Map(
      plan.services.map((s) => [
        s.templateName.toLowerCase(),
        {
          slug: s.slug,
          port: s.port,
          domains: s.public && ctx.domain ? [ctx.domain] : [],
          vars: new Set(Object.keys(s.env)),
        },
      ]),
    ),
    sharedVars: new Set(),
    projectName: ctx.projectName,
    environmentName: 'production',
  };

  for (const svc of plan.services) {
    const { changed, unresolved } = rewriteRailwayRefs(svc.templateName, svc.env, refCtx);
    if (changed.length > 0) {
      svc.notes.push(`Referencias de Railway traducidas: ${changed.join(', ')}.`);
    }
    for (const u of unresolved) svc.notes.push(`⚠ Referencia sin resolver: ${u}`);
  }
}
