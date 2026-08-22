/**
 * Cliente mínimo de la API GraphQL pública de Railway.
 *
 * El token de cuenta (railway.com/account/tokens) viaja solo en memoria
 * durante la importación: Skyway no lo persiste nunca.
 *
 * La API de Railway puede cambiar con el tiempo: todo el parseo es
 * defensivo y los errores de GraphQL se devuelven tal cual a la UI.
 */

const ENDPOINTS = [
  process.env.RAILWAY_GQL_URL,
  'https://backboard.railway.com/graphql/v2',
  'https://backboard.railway.app/graphql/v2',
].filter(Boolean) as string[];

export class RailwayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RailwayError';
  }
}

async function gql<T>(token: string | null, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  let lastError: Error | null = null;
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // El catálogo de plantillas es público: se consulta sin token.
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 401 || res.status === 403) {
        throw new RailwayError('Railway rechazó el token (401/403). Comprueba que es un token de cuenta válido.');
      }
      if (!res.ok) {
        throw new RailwayError(`Railway respondió HTTP ${res.status}`);
      }
      const body: any = await res.json();
      if (body.errors?.length) {
        throw new RailwayError(`Error de la API de Railway: ${body.errors.map((e: any) => e.message).join('; ')}`);
      }
      return body.data as T;
    } catch (err: any) {
      lastError = err;
      // Solo probamos el siguiente endpoint en errores de red, no de la API.
      if (err instanceof RailwayError) throw err;
    }
  }
  throw new RailwayError(`No se pudo conectar con la API de Railway: ${lastError?.message || 'error de red'}`);
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
      if (!(err instanceof RailwayError)) throw err;
      ultimoError = err;
    }
  }
  if (ultimoError) throw ultimoError;

  const project = data?.project;
  if (!project) throw new RailwayError('Proyecto no encontrado en Railway (¿ID correcto y token con acceso?)');

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
    // Las variables compartidas pueden no existir; no es fatal.
    return {};
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
  if (!tpl) throw new RailwayError(`Railway no conoce ninguna plantilla con el código «${code}».`);
  const raw = tpl.serializedConfig?.services;
  const services: RailwayTemplateService[] = raw && typeof raw === 'object' ? Object.values(raw) : [];
  if (services.length === 0) {
    throw new RailwayError(`La plantilla «${tpl.name ?? code}» no declara ningún servicio.`);
  }
  const rawBuckets = tpl.serializedConfig?.buckets;
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
