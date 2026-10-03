/**
 * Borrado completo de proyectos y servicios, y limpieza de los datos que
 * dejaron los borrados anteriores.
 *
 * Borrar un proyecto o un servicio borra SIEMPRE sus datos: contenedores (con
 * sus volúmenes anónimos), volúmenes con nombre, imágenes que Skyway construyó
 * para ellos y copias de seguridad en disco. Antes los volúmenes solo se
 * borraban con una casilla que venía desmarcada, y un volumen que sobrevive a
 * su proyecto es peligroso además de inútil: Skyway nombra los volúmenes por
 * slug (`skyway-<proyecto>-<servicio>-data`), así que un proyecto nuevo con el
 * mismo nombre y un servicio con el mismo nombre montaba los datos viejos
 * —con Postgres o MySQL, además, con las credenciales viejas—.
 *
 * Los volúmenes se crean con `Binds "nombre:ruta"` y Docker los crea sin
 * etiquetas, así que la pertenencia se decide por el nombre. La regla es
 * conservadora a propósito (ver `orphanBlocker`): ante la duda, el volumen se
 * queda. Nunca se usa `docker volume prune`: se llevaría lo de otros programas.
 */
import { deleteServiceBackupDir, isServiceBackupDirName, listServiceBackupDirs } from './backups';
import {
  builtImageTagsOnlyFor,
  closeAlertsFor,
  deleteProject,
  deleteService,
  getService,
  getSetting,
  listProjects,
  listServices,
  listServicesForProjects,
  releaseProjectDnsReservations,
  setSetting,
} from './db';
import { cancelServiceDeployments, markServicesDeleting, unmarkServicesDeleting } from './deploy/deployer';
import { dockerVolumeSizes } from './disk';
import { listServiceContainers, removeContainer, serviceVolumeNames, stopContainer, volumeName } from './docker/containers';
import { EDGE_NETWORK, projectNetworkName } from './docker/networks';
import {
  deleteImage,
  deleteNetwork,
  deleteVolume,
  dockerErrorText,
  DockerVolumeInfo,
  listVolumes,
  volumesInUse,
} from './docker/resources';
import { invalidateDockerSnapshot } from './docker/sampler';
import { MAILWAY_SETTING, previousClientKey } from './mailway';
import { markManualAction } from './monitor';
import { ProjectRow, ServiceRow } from './types';

// ---------- nombres de volumen de Skyway ----------

/** Un slug: `[a-z0-9]` en tramos separados por un guion (lo que deja `slugify`). */
const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';

/**
 * `skyway-<proyecto>-<servicio>-data[N]`: bases de datos, rutas persistentes
 * de repos e imágenes, importaciones de Railway. Exige al menos dos tramos
 * antes de `-data` (proyecto y servicio): `skyway-data`, el nombre que suele
 * llevar el volumen del propio Skyway, no encaja.
 */
const VOLUMEN_SERVICIO = /^skyway-[a-z0-9]+(?:-[a-z0-9]+)+-data(?:[2-9]|[1-9][0-9]+)?$/;

/**
 * `skyway-<proyecto>__<prefijo>__<clave>`: volúmenes de las pilas y de las
 * plantillas de Railway. Un slug nunca lleva `_`, así que los de Compose
 * (`<proyecto>_<volumen>`, p. ej. `skyway_skyway-data`) no encajan en ninguno.
 */
const VOLUMEN_PILA = new RegExp(`^skyway-${SLUG}__${SLUG}__${SLUG}$`);

export function isSkywayVolumeName(name: string): boolean {
  return VOLUMEN_SERVICIO.test(name) || VOLUMEN_PILA.test(name);
}

// ---------- estado vivo ----------

interface LiveService {
  project: ProjectRow;
  service: ServiceRow;
}

function liveState(): { projects: ProjectRow[]; services: LiveService[] } {
  const projects = listProjects();
  const byProject = listServicesForProjects(projects.map((p) => p.id));
  const services: LiveService[] = [];
  for (const project of projects) {
    for (const service of byProject.get(project.id) ?? []) services.push({ project, service });
  }
  return { projects, services };
}

interface VolumeOwner {
  projectId: string;
  label: string;
}

/**
 * Volúmenes que declara algún servicio vivo, con su dueño. Además de los que
 * monta, se protege `volumeName` en servicios de cualquier tipo: no cuesta
 * nada y cubre configuraciones antiguas.
 */
function expectedVolumes(services: LiveService[]): Map<string, VolumeOwner> {
  const out = new Map<string, VolumeOwner>();
  for (const { project, service } of services) {
    const owner = { projectId: project.id, label: `«${project.name} / ${service.name}»` };
    for (const name of [volumeName(project, service), ...serviceVolumeNames(project, service)]) {
      if (!out.has(name)) out.set(name, owner);
    }
  }
  return out;
}

/**
 * Prefijos de lo que sigue vivo. Un volumen puede ser de un servicio vivo
 * aunque este ya no lo declare: una ruta quitada en Ajustes («Quitar una ruta
 * no elimina los datos»; si se vuelve a añadir, recupera el mismo volumen) o
 * la ambigüedad de los guiones (`acme` + `prod-web` y `acme-prod` + `web` dan
 * el mismo nombre). Todo volumen `-data` nace de un servicio concreto
 * (`skyway-<proyecto>-<servicio>-…`, y el slug no cambia al renombrar), así
 * que se protege por servicio; los de pila (`skyway-<proyecto>__…`), por
 * proyecto, porque los comparten varios servicios. Se pierde algún huérfano
 * real (lo que empiece como un servicio vivo), que es el lado seguro.
 */
function livePrefixes(projects: ProjectRow[], services: LiveService[]): string[] {
  return [
    ...services.map(({ project, service }) => `skyway-${project.slug}-${service.slug}-`),
    ...projects.map((p) => `skyway-${p.slug}__`),
  ];
}

interface VolumeContext {
  /** Volúmenes que monta algún contenedor, en cualquier estado, con sus nombres. */
  inUse: Map<string, string[]>;
  expected: Map<string, VolumeOwner>;
  protectedPrefixes: string[];
}

/**
 * Por qué el volumen NO se puede dar por huérfano, o null si lo es. Tienen que
 * cumplirse todas: nombre con el formato exacto de Skyway, controlador local y
 * sin etiquetas (los de Compose —Skyway, Traefik, Mailway— y los anónimos
 * llevan), que no lo declare ningún servicio vivo, que no lo monte ningún
 * contenedor (aunque esté parado: el de Skyway y el de Traefik lo están
 * siempre) y que no empiece por el prefijo de algo vivo.
 */
export function orphanBlocker(vol: DockerVolumeInfo, ctx: VolumeContext): string | null {
  if (!isSkywayVolumeName(vol.name)) return 'Su nombre no sigue el formato de los volúmenes de Skyway.';
  if (vol.driver !== 'local') return `Utiliza el controlador «${vol.driver || 'desconocido'}», no el local.`;
  if (Object.keys(vol.labels).length > 0) return 'Tiene etiquetas de otro programa (Docker Compose u otro).';
  const owner = ctx.expected.get(vol.name);
  if (owner) return `Pertenece al servicio ${owner.label}.`;
  const users = ctx.inUse.get(vol.name);
  if (users?.length) return `Lo utiliza el contenedor ${users[0]}.`;
  if (ctx.protectedPrefixes.some((p) => vol.name.startsWith(p))) {
    return 'Puede pertenecer a un servicio o un proyecto que sigue existiendo.';
  }
  return null;
}

/** Los volúmenes huérfanos de una lista (función pura: se prueba sin Docker). */
export function classifyOrphanVolumes(
  volumes: DockerVolumeInfo[],
  live: { projects: ProjectRow[]; services: ServiceRow[] },
  inUse: Map<string, string[]>,
): DockerVolumeInfo[] {
  const byId = new Map(live.projects.map((p) => [p.id, p]));
  const services: LiveService[] = [];
  for (const service of live.services) {
    const project = byId.get(service.project_id);
    if (project) services.push({ project, service });
  }
  const ctx: VolumeContext = { inUse, expected: expectedVolumes(services), protectedPrefixes: livePrefixes(live.projects, services) };
  return volumes.filter((v) => orphanBlocker(v, ctx) === null);
}

async function volumeSnapshot(): Promise<{ volumes: DockerVolumeInfo[]; inUse: Map<string, string[]> }> {
  const [volumes, inUse] = await Promise.all([listVolumes(), volumesInUse()]);
  return { volumes, inUse };
}

function orphanContext(inUse: Map<string, string[]>): VolumeContext {
  const { projects, services } = liveState();
  return { inUse, expected: expectedVolumes(services), protectedPrefixes: livePrefixes(projects, services) };
}

// ---------- datos sin proyecto (Ajustes) ----------

export interface OrphanVolume {
  name: string;
  /** Del `docker system df` cacheado; null si no se ha podido medir a tiempo. */
  sizeBytes: number | null;
  createdAt: string | null;
}

export interface OrphanBackup {
  serviceId: string;
  files: number;
  sizeBytes: number;
  updatedAt: number;
  /** Copia más reciente: su nombre dice de qué proyecto y servicio era. */
  latestFile: string | null;
}

/**
 * Espera máxima a los tamaños. `docker system df` mide cada volumen y en un
 * host grande tarda minutos la primera vez: el listado no espera por ellos (la
 * medición sigue y queda en caché para la próxima consulta).
 */
const SIZES_WAIT_MS = 8000;

async function sizesWithin(ms: number): Promise<Map<string, number> | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([dockerVolumeSizes().catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function findOrphanVolumes(): Promise<OrphanVolume[]> {
  const { volumes, inUse } = await volumeSnapshot();
  const ctx = orphanContext(inUse);
  const orphans = volumes.filter((v) => orphanBlocker(v, ctx) === null);
  const sizes = orphans.length > 0 ? await sizesWithin(SIZES_WAIT_MS) : null;
  return orphans
    .map((v) => ({ name: v.name, sizeBytes: sizes?.get(v.name) ?? null, createdAt: v.createdAt }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Carpetas de copias de seguridad de servicios que ya no existen. */
export function findOrphanBackups(): OrphanBackup[] {
  return listServiceBackupDirs()
    .filter((d) => !getService(d.serviceId))
    .map((d) => ({ serviceId: d.serviceId, files: d.files, sizeBytes: d.size, updatedAt: d.updatedAt, latestFile: d.latestFile }));
}

export interface OrphanPurgeResult {
  deleted: { volumes: string[]; backups: string[] };
  /** Lo pedido que ya no es huérfano (o no existe): no se ha tocado. */
  skipped: { kind: 'volume' | 'backup'; name: string; reason: string }[];
  failed: { kind: 'volume' | 'backup'; name: string; error: string }[];
}

/**
 * Elimina los datos sin proyecto pedidos. NO se fía de la lista que manda el
 * cliente: la vuelve a calcular con Docker y la base de datos en este momento,
 * y cada nombre tiene que seguir siendo huérfano. Docker, además, se niega a
 * borrar un volumen que monte un contenedor creado entre medias.
 */
export async function purgeOrphans(
  wanted: { volumes: string[]; backups: string[] },
  onDeleted: (kind: 'volume' | 'backup', name: string, detail: string) => void,
): Promise<OrphanPurgeResult> {
  const result: OrphanPurgeResult = { deleted: { volumes: [], backups: [] }, skipped: [], failed: [] };

  const volumes = [...new Set(wanted.volumes)];
  if (volumes.length > 0) {
    const { volumes: all, inUse } = await volumeSnapshot();
    const ctx = orphanContext(inUse);
    const byName = new Map(all.map((v) => [v.name, v]));
    const sizes = await sizesWithin(1000);
    for (const name of volumes) {
      const vol = byName.get(name);
      const blocker = vol ? orphanBlocker(vol, ctx) : 'Ya no existe.';
      if (blocker) {
        result.skipped.push({ kind: 'volume', name, reason: blocker });
        continue;
      }
      try {
        if ((await deleteVolume(name)) === 'removed') {
          result.deleted.volumes.push(name);
          const size = sizes?.get(name);
          onDeleted('volume', name, size !== undefined ? `${name} (${size} bytes)` : name);
        } else {
          result.skipped.push({ kind: 'volume', name, reason: 'Ya no existe.' });
        }
      } catch (err) {
        result.failed.push({ kind: 'volume', name, error: dockerErrorText(err) });
      }
    }
    invalidateDockerSnapshot();
  }

  const backups = [...new Set(wanted.backups)];
  if (backups.length > 0) {
    const orphanDirs = new Map(findOrphanBackups().map((b) => [b.serviceId, b]));
    for (const serviceId of backups) {
      const dir = orphanDirs.get(serviceId);
      if (!dir) {
        result.skipped.push({
          kind: 'backup',
          name: serviceId,
          reason: !isServiceBackupDirName(serviceId)
            ? 'No es una carpeta de copias de seguridad de un servicio.'
            : getService(serviceId)
              ? 'Pertenece a un servicio que existe.'
              : 'Ya no existe.',
        });
        continue;
      }
      try {
        if (deleteServiceBackupDir(serviceId)) {
          result.deleted.backups.push(serviceId);
          onDeleted('backup', serviceId, `${serviceId} (${dir.files} copias, ${dir.sizeBytes} bytes)`);
        } else {
          result.skipped.push({ kind: 'backup', name: serviceId, reason: 'Ya no existe.' });
        }
      } catch (err) {
        result.failed.push({ kind: 'backup', name: serviceId, error: (err as Error)?.message ?? String(err) });
      }
    }
  }
  return result;
}

// ---------- borrado de proyectos y servicios ----------

/**
 * El borrado no ha podido retirar lo que está en marcha (un contenedor que
 * Docker no deja quitar, un despliegue que no termina): se interrumpe ANTES de
 * tocar volúmenes y filas. Seguir dejaba un contenedor sin proyecto, con su
 * dominio sirviendo y su volumen montado, que además no aparece en «Datos sin
 * proyecto» porque el volumen está en uso. Reintentar es seguro.
 */
export class PurgeBlockedError extends Error {
  constructor(readonly warnings: string[]) {
    super(warnings.join(' · '));
  }
}

/**
 * Prefijos de lo que sigue vivo en OTROS proyectos, con quién es. Por la
 * ambigüedad de los guiones, el proyecto «a» con el servicio «b-c» y el
 * proyecto «a-b» con el servicio «c» generan los mismos nombres
 * (`skyway-a-b-c-dataN`): sin esto, borrar el primero se llevaba un volumen
 * del segundo que este ya no declara (una ruta quitada, cuyos datos se
 * prometen conservar), aunque sea de otra cuenta.
 */
function foreignPrefixes(projects: ProjectRow[], survivors: LiveService[], projectId: string): { prefix: string; label: string }[] {
  return [
    ...survivors
      .filter(({ project }) => project.id !== projectId)
      .map(({ project, service }) => ({ prefix: `skyway-${project.slug}-${service.slug}-`, label: `al servicio «${project.name} / ${service.name}»` })),
    ...projects.filter((p) => p.id !== projectId).map((p) => ({ prefix: `skyway-${p.slug}__`, label: `al proyecto «${p.name}»` })),
  ];
}

export interface PurgeReport {
  /** Lo que no se ha podido retirar, para hacerlo a mano. */
  warnings: string[];
  /** Volúmenes borrados. */
  volumes: string[];
  /** Imágenes construidas que se han borrado. */
  images: number;
  /** Carpetas de copias de seguridad borradas. */
  backups: number;
}

/**
 * Retira de Docker y del disco todo lo de estos servicios. No toca la base de
 * datos del panel: eso lo hace quien llama, después.
 */
async function purgeServicesData(
  project: ProjectRow,
  services: ServiceRow[],
  prefixed: boolean,
): Promise<{ report: PurgeReport; tried: Set<string> }> {
  const report: PurgeReport = { warnings: [], volumes: [], images: 0, backups: 0 };
  const warn = (service: ServiceRow | null, text: string) =>
    report.warnings.push(prefixed && service ? `${service.name}: ${text}` : text.charAt(0).toUpperCase() + text.slice(1));
  const ids = services.map((s) => s.id);
  const deleting = new Set(ids);

  // 1. Primero los despliegues: uno a medias volvería a crear el contenedor
  //    —y, con el montaje, el volumen— cuando ya no queda nada que lo borre.
  //    Los que lleguen mientras dura el borrado nacen cancelados (quien llama
  //    ya ha marcado los servicios con `markServicesDeleting`).
  for (const s of services) markManualAction(s.id);
  const bloqueos: string[] = [];
  const pendientes = await cancelServiceDeployments(ids);
  if (pendientes > 0) {
    bloqueos.push(
      pendientes === 1
        ? 'Un despliegue en curso no ha terminado de cancelarse.'
        : `${pendientes} despliegues en curso no han terminado de cancelarse.`,
    );
  }

  // 2. Contenedores, por etiqueta (réplicas y restos de intercambios
  //    incluidos), con sus volúmenes anónimos. Si alguno no se puede retirar,
  //    no se sigue: ver `PurgeBlockedError`.
  if (bloqueos.length === 0) {
    for (const s of services) {
      let contenedores: { name: string }[];
      try {
        contenedores = await listServiceContainers(s.id);
      } catch (err) {
        bloqueos.push(`${s.name}: no se han podido enumerar sus contenedores: ${dockerErrorText(err)}`);
        continue;
      }
      for (const c of contenedores) {
        // La parada es cortesía (deja cerrar al proceso); si falla, la
        // retirada forzada se intenta igualmente.
        await stopContainer(c.name).catch(() => undefined);
        try {
          await removeContainer(c.name, { anonymousVolumes: true });
        } catch (err) {
          bloqueos.push(`${s.name}: no se ha podido retirar el contenedor ${c.name}: ${dockerErrorText(err)}`);
        }
      }
    }
  }
  if (bloqueos.length > 0) {
    invalidateDockerSnapshot(); // algunos contenedores sí se han retirado
    throw new PurgeBlockedError(bloqueos);
  }

  // 3. Volúmenes que declaran. Nunca uno que declare un servicio que se queda:
  //    las pilas comparten volumen entre servicios (storage e imgproxy), y el
  //    nombre por slug puede coincidir con el de otro proyecto.
  const live = liveState();
  const survivors = live.services.filter((ls) => !deleting.has(ls.service.id));
  const expected = expectedVolumes(survivors);
  const ajenos = foreignPrefixes(live.projects, survivors, project.id);
  let snap: { volumes: DockerVolumeInfo[]; inUse: Map<string, string[]> } | null = null;
  try {
    snap = await volumeSnapshot();
  } catch (err) {
    warn(null, `no se ha podido consultar la lista de volúmenes de Docker: ${dockerErrorText(err)}`);
  }
  const existing = snap ? new Map(snap.volumes.map((v) => [v.name, v])) : null;
  const tratados = new Set<string>();
  for (const s of services) {
    for (const name of serviceVolumeNames(project, s)) {
      if (tratados.has(name)) continue;
      tratados.add(name);
      const owner = expected.get(name);
      if (owner) {
        // Compartido con un servicio hermano que se queda: es suyo y no hay
        // nada que avisar. Con otro proyecto es una coincidencia de nombres.
        if (owner.projectId !== project.id) {
          warn(s, `el volumen ${name} también lo declara el servicio ${owner.label}: se conserva.`);
        }
        continue;
      }
      if (existing && !existing.has(name)) continue; // nunca llegó a crearse
      const ajeno = ajenos.find((a) => name.startsWith(a.prefix));
      if (ajeno) {
        warn(s, `el volumen ${name} puede pertenecer ${ajeno.label}, de otro proyecto: se conserva.`);
        continue;
      }
      if (!isSkywayVolumeName(name)) {
        warn(s, `el volumen ${name} no sigue el formato de nombres de Skyway: no se ha borrado.`);
        continue;
      }
      const vol = existing?.get(name);
      if (vol && Object.keys(vol.labels).length > 0) {
        warn(s, `el volumen ${name} tiene etiquetas de otro programa: no se ha borrado.`);
        continue;
      }
      const users = snap?.inUse.get(name);
      if (users?.length) {
        warn(s, `el volumen ${name} lo utiliza el contenedor ${users.join(', ')}: no se ha borrado.`);
        continue;
      }
      try {
        if ((await deleteVolume(name)) === 'removed') report.volumes.push(name);
      } catch (err) {
        warn(s, `no se ha podido borrar el volumen ${name}: ${dockerErrorText(err)}`);
      }
    }
  }

  // 4. Imágenes que Skyway construyó para ellos y que nadie más referencia.
  for (const tag of builtImageTagsOnlyFor(ids)) {
    try {
      if ((await deleteImage(tag)) === 'removed') report.images += 1;
    } catch (err) {
      warn(null, `no se ha podido borrar la imagen ${tag}: ${dockerErrorText(err)}`);
    }
  }

  // 5. Copias de seguridad en disco.
  for (const s of services) {
    try {
      if (deleteServiceBackupDir(s.id)) report.backups += 1;
    } catch (err) {
      warn(s, `no se han podido borrar sus copias de seguridad: ${(err as Error)?.message ?? err}`);
    }
  }
  return { report, tried: tratados };
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Volúmenes que pueden haber dejado estos servicios fuera de su configuración actual. */
function leftoverPatterns(project: ProjectRow, services: ServiceRow[], wholeProject: boolean): RegExp[] {
  const p = escapeRe(project.slug);
  const out = services.map((s) => new RegExp(`^skyway-${p}-${escapeRe(s.slug)}-data(?:[2-9]|[1-9][0-9]+)?$`));
  // Con `__` la descomposición es única: todo lo que empieza así es del proyecto.
  if (wholeProject) out.push(new RegExp(`^skyway-${p}__`));
  return out;
}

/**
 * Restos del proyecto o del servicio que no figuran en su configuración: rutas
 * que se quitaron en Ajustes y volúmenes de un proyecto anterior con el mismo
 * nombre que se borró sin sus datos (el caso que motivó este borrado). Se
 * aplica la regla de los huérfanos completa, ya sin las filas borradas, y solo
 * sobre los nombres de lo que se acaba de borrar. Lo que ya se intentó borrar
 * en el paso anterior (y quizá dio aviso) no se repite.
 */
async function sweepLeftovers(patterns: RegExp[], tried: Set<string>, report: PurgeReport): Promise<void> {
  let snap: { volumes: DockerVolumeInfo[]; inUse: Map<string, string[]> };
  try {
    snap = await volumeSnapshot();
  } catch {
    return; // ya avisado si Docker no respondía; lo que quede saldrá en «Datos sin proyecto»
  }
  const ctx = orphanContext(snap.inUse);
  for (const vol of snap.volumes) {
    if (tried.has(vol.name) || !patterns.some((re) => re.test(vol.name))) continue;
    if (orphanBlocker(vol, ctx) !== null) continue;
    try {
      if ((await deleteVolume(vol.name)) === 'removed') report.volumes.push(vol.name);
    } catch (err) {
      report.warnings.push(`No se ha podido borrar el volumen ${vol.name}: ${dockerErrorText(err)}`);
    }
  }
}

/** Referencias en Ajustes a servicios que se van a borrar. */
function forgetServices(services: ServiceRow[]): void {
  const panel = getSetting(MAILWAY_SETTING.serviceId);
  // Mismo estado que una instalación que nunca lo indicó: el puente de
  // Traefik y la protección de dominios de Mailway buscan el panel por su URL.
  if (panel && services.some((s) => s.id === panel)) setSetting(MAILWAY_SETTING.serviceId, null);
}

/**
 * Borra un proyecto con todos sus datos. Exige Docker disponible (lo comprueba
 * la ruta): sin él, borrar las filas dejaría todo lo demás sin dueño.
 */
export async function purgeProject(project: ProjectRow): Promise<PurgeReport & { services: number }> {
  const services = listServices(project.id);
  const ids = services.map((s) => s.id);
  markServicesDeleting(ids);
  try {
    return await purgeProjectMarked(project, services);
  } finally {
    unmarkServicesDeleting(ids);
  }
}

async function purgeProjectMarked(project: ProjectRow, services: ServiceRow[]): Promise<PurgeReport & { services: number }> {
  const { report, tried } = await purgeServicesData(project, services, true);

  // La red del proyecto. Nunca la compartida con Traefik: el proyecto «edge»
  // tendría ese mismo nombre.
  const net = projectNetworkName(project);
  if (net !== EDGE_NETWORK) {
    try {
      await deleteNetwork(net);
    } catch (err) {
      report.warnings.push(`No se ha podido borrar la red ${net}: ${dockerErrorText(err)}`);
    }
  }

  forgetServices(services);
  closeAlertsFor({ projectId: project.id });
  // El informe de importación lleva comandos con contraseñas.
  setSetting(`importReport:${project.id}`, null);
  setSetting(previousClientKey(project.id), null);
  releaseProjectDnsReservations(project.id);
  // El resto de filas (servicios, variables, despliegues, vínculo de correo,
  // conectores) caen en cascada.
  deleteProject(project.id);

  await sweepLeftovers(leftoverPatterns(project, services, true), tried, report);
  invalidateDockerSnapshot();
  return { ...report, services: services.length };
}

/** Borra un servicio con todos sus datos (ver `purgeProject`). */
export async function purgeService(project: ProjectRow, service: ServiceRow): Promise<PurgeReport> {
  markServicesDeleting([service.id]);
  try {
    const { report, tried } = await purgeServicesData(project, [service], false);
    forgetServices([service]);
    closeAlertsFor({ serviceId: service.id });
    deleteService(service.id);
    await sweepLeftovers(leftoverPatterns(project, [service], false), tried, report);
    invalidateDockerSnapshot(service.id);
    return report;
  } finally {
    unmarkServicesDeleting([service.id]);
  }
}

function cuenta(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** Resumen de lo borrado para el registro de auditoría («4 servicios, 5 volúmenes, 1 imagen…»). */
export function purgeSummary(report: PurgeReport & { services?: number }): string {
  return [
    ...(report.services !== undefined ? [cuenta(report.services, 'servicio', 'servicios')] : []),
    cuenta(report.volumes.length, 'volumen', 'volúmenes'),
    cuenta(report.images, 'imagen', 'imágenes'),
    cuenta(report.backups, 'carpeta de copias', 'carpetas de copias'),
  ].join(', ');
}

/**
 * Los avisos en el registro de auditoría, recortados: el toast de la web se
 * cierra y lo que haya que retirar a mano tiene que poder consultarse después.
 */
export function warningsForAudit(warnings: string[]): string {
  if (warnings.length === 0) return '';
  const text = warnings.join(' | ');
  return ` · avisos: ${text.length > 600 ? `${text.slice(0, 599)}…` : text}`;
}

/**
 * La confirmación de un borrado: el nombre visible exacto o el slug (lo que
 * usa un script, que no tiene por qué conocer mayúsculas y tildes). Se
 * ignoran los espacios de los extremos, que el nombre nunca lleva.
 */
export function confirmsDeletion(confirm: unknown, target: { name: string; slug: string }): boolean {
  if (typeof confirm !== 'string') return false;
  // NFC: un nombre pegado desde macOS (NFD) y el que teclea un móvil (NFC)
  // se ven iguales y deben valer igual.
  const value = confirm.normalize('NFC').trim();
  return value.length > 0 && (value === target.name.normalize('NFC') || value === target.slug);
}
