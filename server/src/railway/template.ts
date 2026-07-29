import { getRailwayTemplate, RailwayTemplate, RailwayTemplateService } from './client';
import { rewriteRailwayRefs, splitRef, RailwayRefCtx } from './importer';
import { randomAlnum, slugify } from '../util';

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
  /** Infraestructura de la que otros dependen (base de datos, almacenamiento). */
  infra: boolean;
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
 * Un bucket de Railway es almacenamiento gestionado que aquí no existe. En vez
 * de dejar las variables colgando, se levanta un **MinIO** en el propio proyecto
 * y se rellenan con sus credenciales: la plantilla queda funcional sin depender
 * de nada externo, con el almacenamiento en un volumen del servidor.
 *
 * Los nombres de variable los dicta lo que la plantilla referencia de verdad
 * (`${{S3.ACCESS_KEY_ID}}` y compañía), así que se recogen del propio config en
 * vez de adivinarlos.
 */
function bucketVarValue(
  key: string,
  w: { accessKey: string; secretKey: string; bucket: string; endpoint: string },
): string | null {
  switch (key) {
    case 'ACCESS_KEY_ID':
    case 'AWS_ACCESS_KEY_ID':
      return w.accessKey;
    case 'SECRET_ACCESS_KEY':
    case 'AWS_SECRET_ACCESS_KEY':
    case 'SECRET_KEY':
      return w.secretKey;
    case 'BUCKET':
    case 'BUCKET_NAME':
    case 'NAME':
      return w.bucket;
    case 'REGION':
    case 'AWS_REGION':
      return 'us-east-1'; // la que asume MinIO por defecto
    case 'ENDPOINT':
    case 'URL':
    case 'PUBLIC_ENDPOINT':
    case 'PUBLIC_URL':
    case 'HOST':
      return w.endpoint;
    case 'PORT':
      return '9000';
    default:
      return null;
  }
}

/** Claves que la plantilla referencia de un bucket concreto. */
function bucketRefs(services: TemplateServicePlan[], bucketName: string): Set<string> {
  const keys = new Set<string>();
  const wanted = bucketName.toLowerCase();
  for (const svc of services) {
    for (const value of Object.values(svc.env)) {
      for (const m of value.matchAll(/\$\{\{\s*([^{}]+?)\s*\}\}/g)) {
        const { scope, key } = splitRef(m[1]);
        if (scope && scope.toLowerCase() === wanted) keys.add(key);
      }
    }
  }
  return keys;
}

/** Crea el servicio MinIO que da cuerpo a un bucket de la plantilla. */
function minioForBucket(
  bucketName: string,
  prefix: string,
  services: TemplateServicePlan[],
  warnings: string[],
): TemplateServicePlan {
  const slug = `${prefix}-${slugify(bucketName)}`;
  // Nombre de bucket válido para S3: minúsculas y al menos 3 caracteres (un
  // bucket llamado «S3» daría «s3», que MinIO rechazaría).
  const bucket = slugify(`${prefix}-${bucketName}`);
  const wiring = {
    accessKey: randomAlnum(20),
    secretKey: randomAlnum(40),
    bucket,
    endpoint: `http://${slug}:9000`,
  };

  const env: Record<string, string> = {
    // Las credenciales de administrador de MinIO SON las claves de acceso: así
    // lo que la plantilla usa como cliente S3 entra sin más configuración.
    MINIO_ROOT_USER: wiring.accessKey,
    MINIO_ROOT_PASSWORD: wiring.secretKey,
  };
  const desconocidas: string[] = [];
  for (const key of bucketRefs(services, bucketName)) {
    const value = bucketVarValue(key, wiring);
    if (value === null) {
      env[key] = '';
      desconocidas.push(key);
    } else {
      env[key] = value;
    }
  }
  if (desconocidas.length > 0) {
    warnings.push(
      `Del bucket «${bucketName}» no sé qué valor darle a ${desconocidas.join(', ')}: quedan vacías en el servicio de almacenamiento.`,
    );
  }

  return {
    templateName: bucketName,
    name: slug,
    slug,
    kind: 'image',
    image: 'minio/minio:latest',
    // MinIO crea como bucket cualquier directorio de primer nivel del volumen:
    // así el bucket existe desde el primer arranque, sin un contenedor auxiliar.
    startCmd: `mkdir -p /data/${bucket} && exec minio server /data --console-address ":9001"`,
    healthcheckPath: '/minio/health/live',
    port: 9000,
    volumes: ['/data'],
    env,
    public: false,
    stage: 0,
    infra: true,
    notes: [
      `Sustituye al bucket «${bucketName}» de Railway: almacenamiento local en un volumen, con el bucket «${bucket}» ya creado.`,
      'La consola web de MinIO escucha en el puerto 9001; para abrirla, publica ese puerto o añádele un dominio en Ajustes.',
    ],
  };
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
    if (svc.infra) svc.stage = 0;
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
    const readyCmd = readyCmdFor(image, { hasVolume: volumes.length > 0, tcpPort });

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
      readyCmd,
      // Si sabemos sondearlo, es un motor: algo depende de que esté antes.
      infra: !!readyCmd,
      notes,
    });
  }

  if (services.length === 0) throw new Error('La plantilla no tiene ningún servicio que Skyway pueda crear.');

  // Cada bucket de Railway se materializa como un MinIO del propio proyecto.
  for (const bucketName of tpl.buckets) {
    if (services.some((s) => s.templateName.toLowerCase() === bucketName.toLowerCase())) continue;
    services.push(minioForBucket(bucketName, prefix, services, warnings));
  }
  if (tpl.buckets.length > 0) {
    warnings.push(
      `La plantilla usa ${tpl.buckets.length} bucket(s) de almacenamiento de Railway (${tpl.buckets.join(', ')}). Skyway no los provee, así que se añade un MinIO por cada uno con el bucket creado y las credenciales ya cableadas: queda funcional, guardando los ficheros en un volumen de este servidor.`,
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
