/**
 * Cliente mínimo de la API GraphQL pública de Railway.
 *
 * El token de cuenta (railway.com/account/tokens) viaja solo en memoria
 * durante la importación: Skyway no lo persiste nunca.
 *
 * La API de Railway puede cambiar con el tiempo: todo el parseo es
 * defensivo y los errores de GraphQL se devuelven tal cual a la UI.
 */

import { safeParse } from '../util';

const ENDPOINTS = [
  process.env.RAILWAY_GQL_URL,
  'https://backboard.railway.com/graphql/v2',
  'https://backboard.railway.app/graphql/v2',
].filter(Boolean) as string[];

/**
 * De qué clase es el fallo, para que quien llama decida si insistir: solo un
 * error de esquema (`graphql`) justifica repetir la consulta con menos campos.
 */
export type RailwayErrorKind = 'auth' | 'ratelimit' | 'http' | 'graphql' | 'network';

export class RailwayError extends Error {
  kind: RailwayErrorKind;
  constructor(message: string, kind: RailwayErrorKind = 'http') {
    super(message);
    this.name = 'RailwayError';
    this.kind = kind;
  }
}

/** Errores de GraphQL que significan «ese campo ya no existe en el esquema». */
const SCHEMA_ERROR_RE = /cannot query field|unknown (?:argument|field|type)|is not defined by type|did you mean/i;

/** El error viene de pedir un campo que la API ya no tiene, no de los datos. */
export function isRailwaySchemaError(err: unknown): boolean {
  return err instanceof RailwayError && err.kind === 'graphql' && SCHEMA_ERROR_RE.test(err.message);
}

async function gql<T>(token: string | null, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  let lastError: Error | null = null;
  for (const endpoint of ENDPOINTS) {
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // El catálogo de plantillas es público: se consulta sin token.
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err: any) {
      // Solo se prueba el siguiente endpoint en errores de red. Un timeout no:
      // encadenar dos esperas de 20 s deja al usuario mirando una rueda.
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new RailwayError('Railway no respondió en 20 s. Vuelva a intentarlo en unos instantes.', 'network');
      }
      lastError = err;
      continue;
    }
    // El cuerpo se lee siempre, también en los errores: sin consumirlo el
    // socket queda ocupado, y el importador hace una petición por servicio.
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new RailwayError('Railway rechazó el token (401/403). Compruebe que es un token de cuenta válido.', 'auth');
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after'));
      const cuando = Number.isFinite(wait) && wait > 0 ? ` Vuelva a intentarlo en ${Math.ceil(wait)} s.` : ' Espere unos instantes antes de volver a intentarlo.';
      throw new RailwayError(`Railway ha limitado las peticiones de este token (429).${cuando}`, 'ratelimit');
    }
    if (!res.ok) {
      throw new RailwayError(`Railway respondió HTTP ${res.status}`, 'http');
    }
    const body = safeParse<{ data?: unknown; errors?: unknown } | null>(text, null);
    if (!body) {
      // Un 200 que no es JSON es un proxy o una página de mantenimiento delante
      // de la API: no es nuestro token ni nuestra consulta.
      throw new RailwayError('Railway devolvió una respuesta que no es JSON (posible mantenimiento). Vuelva a intentarlo.', 'http');
    }
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const messages = body.errors.map((e: any) => (typeof e?.message === 'string' ? e.message : 'error desconocido'));
      throw new RailwayError(`Error de la API de Railway: ${messages.join('; ')}`, 'graphql');
    }
    return body.data as T;
  }
  throw new RailwayError(
    `No se pudo conectar con la API de Railway: ${(lastError as any)?.cause?.message || lastError?.message || 'error de red'}`,
    'network',
  );
}

const edges = (conn: any): any[] => conn?.edges?.map((e: any) => e?.node).filter(Boolean) ?? [];

export interface RailwayProject {
  id: string;
  name: string;
  team: string | null;
}

/** Lista los proyectos accesibles con el token (personales y de equipos). */
export async function listRailwayProjects(token: string): Promise<RailwayProject[]> {
  const data = await gql<any>(
    token,
    `query {
      me {
        projects { edges { node { id name } } }
        workspaces {
          name
          team { projects { edges { node { id name } } } }
        }
      }
    }`,
  );
  const out = new Map<string, RailwayProject>();
  for (const p of edges(data?.me?.projects)) out.set(p.id, { id: p.id, name: p.name, team: null });
  for (const ws of data?.me?.workspaces ?? []) {
    for (const p of edges(ws?.team?.projects)) {
      out.set(p.id, { id: p.id, name: p.name, team: ws?.name ?? null });
    }
  }
  return [...out.values()];
}

export interface RailwayServiceRaw {
  id: string;
  name: string;
  repo: string | null;
  image: string | null;
  branch: string | null;
  startCommand: string | null;
  rootDirectory: string | null;
  buildCommand: string | null;
  customDomains: string[];
  serviceDomains: string[];
  volumeMounts: string[];
  /** Campos «extendidos»: solo llegan si la API de Railway los expone hoy. */
  healthcheckPath: string | null;
  numReplicas: number | null;
  restartPolicyType: string | null;
  cronSchedule: string | null;
  builder: string | null;
  /** Puerto del dominio del servicio: es el que Railway enruta al contenedor. */
  domainPort: number | null;
}

export interface RailwayProjectDetail {
  id: string;
  name: string;
  environments: { id: string; name: string }[];
  services: RailwayServiceRaw[];
}

/**
 * Campos del `serviceInstance` que Railway ha ido añadiendo. Se piden en una
 * consulta aparte porque GraphQL rechaza la petición ENTERA si uno de ellos ya
 * no existe: mejor perder los extras que quedarse sin poder importar nada.
 */
const INSTANCE_EXTRA_FIELDS = `
  healthcheckPath
  numReplicas
  restartPolicyType
  cronSchedule
  builder
`;

const projectQuery = (extras: string, domainExtras = ''): string => `query ($id: String!) {
      project(id: $id) {
        id
        name
        environments { edges { node { id name } } }
        volumes {
          edges { node {
            name
            volumeInstances { edges { node { mountPath serviceId environmentId } } }
          } }
        }
        services {
          edges { node {
            id
            name
            serviceInstances { edges { node {
              environmentId
              startCommand
              rootDirectory
              buildCommand
              ${extras}
              source { repo image }
              domains {
                customDomains { domain }
                serviceDomains { domain ${domainExtras} }
              }
            } } }
          } }
        }
      }
    }`;

/** Lee la estructura de un proyecto de Railway para un entorno concreto. */
export async function getRailwayProject(
  token: string,
  projectId: string,
  environmentId?: string,
): Promise<RailwayProjectDetail> {
  // Escalones de la consulta, del que más datos trae al que menos: GraphQL
  // rechaza la petición ENTERA si un campo ya no existe, así que cada escalón
  // renuncia a lo que puede faltar antes que quedarse sin poder importar nada.
  // El de en medio es EXACTAMENTE la consulta que venía funcionando: si «branch»
  // no existiera, el importador se comporta igual que siempre.
  const escalones: [string, string][] = [
    [`branch\n${INSTANCE_EXTRA_FIELDS}`, 'targetPort'],
    [INSTANCE_EXTRA_FIELDS, 'targetPort'],
    ['', ''],
  ];
  let data: any;
  let ultimoError: RailwayError | null = null;
  for (const [extras, domainExtras] of escalones) {
    try {
      data = await gql<any>(token, projectQuery(extras, domainExtras), { id: projectId });
      ultimoError = null;
      break;
    } catch (err) {
      // Solo se baja un escalón cuando el fallo es de esquema (un campo que ya
      // no existe). Un token rechazado, un proyecto ajeno o la red caída dan
      // lo mismo con menos campos: repetir tres veces solo triplicaba la
      // espera y, con cuota, quemaba peticiones.
      if (!isRailwaySchemaError(err)) throw err;
      ultimoError = err as RailwayError;
    }
  }
  if (ultimoError) throw ultimoError;

  const project = data?.project;
  if (!project) throw new RailwayError('Proyecto no encontrado en Railway. Compruebe el ID del proyecto y que el token tiene acceso.');

  const environments = edges(project.environments).map((e: any) => ({ id: e.id, name: e.name }));
  const envId =
    environmentId ||
    environments.find((e) => e.name === 'production')?.id ||
    environments[0]?.id;

  const volumeMountsByService = new Map<string, string[]>();
  for (const vol of edges(project.volumes)) {
    for (const inst of edges(vol.volumeInstances)) {
      if (inst.environmentId && envId && inst.environmentId !== envId) continue;
      if (!inst.serviceId || !inst.mountPath) continue;
      volumeMountsByService.set(inst.serviceId, [
        ...(volumeMountsByService.get(inst.serviceId) ?? []),
        inst.mountPath,
      ]);
    }
  }

  const intOrNull = (value: unknown): number | null => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  const services: RailwayServiceRaw[] = edges(project.services).map((s: any) => {
    const instances = edges(s.serviceInstances);
    const instance = instances.find((i: any) => i.environmentId === envId) ?? instances[0] ?? {};
    const serviceDomains = instance?.domains?.serviceDomains ?? [];
    return {
      id: s.id,
      name: s.name,
      repo: instance?.source?.repo ?? null,
      image: instance?.source?.image ?? null,
      branch: instance?.branch ?? null,
      startCommand: instance?.startCommand ?? null,
      rootDirectory: instance?.rootDirectory ?? null,
      buildCommand: instance?.buildCommand ?? null,
      customDomains: (instance?.domains?.customDomains ?? []).map((d: any) => d?.domain).filter(Boolean),
      serviceDomains: serviceDomains.map((d: any) => d?.domain).filter(Boolean),
      volumeMounts: volumeMountsByService.get(s.id) ?? [],
      healthcheckPath: instance?.healthcheckPath ?? null,
      numReplicas: intOrNull(instance?.numReplicas),
      restartPolicyType: instance?.restartPolicyType ?? null,
      cronSchedule: instance?.cronSchedule ?? null,
      builder: instance?.builder ?? null,
      // Railway enruta su dominio a este puerto: es el dato más fiable sobre
      // dónde escucha la aplicación, mejor que asumir 3000.
      domainPort: intOrNull(serviceDomains.find((d: any) => intOrNull(d?.targetPort))?.targetPort),
    };
  });

  return { id: project.id, name: project.name, environments, services };
}

/** Variables de un servicio (o compartidas del entorno si no se pasa serviceId). */
export async function getRailwayVariables(
  token: string,
  projectId: string,
  environmentId: string,
  serviceId?: string,
): Promise<Record<string, string>> {
  try {
    const data = await gql<any>(
      token,
      `query ($projectId: String!, $environmentId: String!, $serviceId: String) {
        variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
      }`,
      { projectId, environmentId, serviceId: serviceId ?? null },
    );
    const vars = data?.variables;
    if (vars && typeof vars === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(vars)) out[k] = String(v);
      return out;
    }
    return {};
  } catch (err) {
    if (serviceId) throw err;
    // Las variables compartidas pueden no existir; que la API se queje de la
    // consulta no es fatal. Pero un token rechazado, la cuota agotada o la red
    // caída sí lo son: tragarlos daba un plan «sin variables compartidas» que
    // parecía correcto y dejaba la app importada sin la mitad de su entorno.
    if (err instanceof RailwayError && err.kind === 'graphql') return {};
    throw err;
  }
}

// ---------- plantillas públicas ----------

export interface RailwayTemplateService {
  icon?: string;
  name?: string;
  source?: { image?: string; repo?: string; rootDirectory?: string };
  deploy?: { startCommand?: string | null; healthcheckPath?: string | null };
  variables?: Record<string, { defaultValue?: string | null; isOptional?: boolean; description?: string }>;
  networking?: {
    serviceDomains?: Record<string, { port?: number }>;
    tcpProxies?: Record<string, unknown>;
  };
  volumeMounts?: Record<string, { mountPath?: string }>;
}

export interface RailwayTemplate {
  id: string;
  code: string;
  name: string;
  description: string | null;
  services: RailwayTemplateService[];
  /** Buckets de almacenamiento que la plantilla da por provistos (Skyway no los tiene). */
  buckets: string[];
}

/**
 * Extrae el código de una plantilla de una URL de Railway. Admite las formas
 * que la gente copia y pega: railway.com/new/template/CODE, /template/CODE, o
 * el código a secas.
 */
export function parseTemplateCode(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const url = /(?:railway\.(?:com|app))\/(?:new\/)?template\/([A-Za-z0-9_-]+)/i.exec(trimmed);
  const code = url ? url[1] : trimmed;
  return /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : null;
}

/** Plantilla pública del catálogo de Railway (no requiere token). */
export async function getRailwayTemplate(code: string): Promise<RailwayTemplate> {
  const data = await gql<any>(
    null,
    `query ($code: String!) {
      template(code: $code) { id code name description serializedConfig }
    }`,
    { code },
  );
  const tpl = data?.template;
  if (!tpl) throw new RailwayError(`Railway no conoce ninguna plantilla con el código «${code}».`, 'graphql');
  // `serializedConfig` es un escalar JSON: normalmente llega ya como objeto,
  // pero un cambio de la API podría entregarlo como texto. Se aceptan ambos.
  const config: any =
    typeof tpl.serializedConfig === 'string'
      ? safeParse<Record<string, unknown>>(tpl.serializedConfig, {})
      : tpl.serializedConfig ?? {};
  const raw = config?.services;
  const services: RailwayTemplateService[] =
    raw && typeof raw === 'object' ? Object.values(raw).filter((s): s is RailwayTemplateService => !!s && typeof s === 'object') : [];
  if (services.length === 0) {
    throw new RailwayError(`La plantilla «${tpl.name ?? code}» no declara ningún servicio.`, 'graphql');
  }
  const rawBuckets = config?.buckets;
  return {
    id: String(tpl.id ?? ''),
    code: String(tpl.code ?? code),
    name: String(tpl.name ?? code),
    description: tpl.description ?? null,
    services,
    buckets:
      rawBuckets && typeof rawBuckets === 'object'
        ? Object.values(rawBuckets as Record<string, any>).map((b) => String(b?.name ?? 'bucket'))
        : [],
  };
}
