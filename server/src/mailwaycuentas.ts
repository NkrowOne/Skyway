/**
 * Un cliente de Mailway por cuenta (workspace) de Skyway: los proyectos de una
 * cuenta que activan el correo comparten el cliente de la cuenta (referencia
 * externa `skyway:workspace:<id>`, con el nombre de la cuenta), con sus
 * dominios, buzones y plan. Un proyecto sin cuenta conserva el suyo
 * (`skyway:project:<id>`). Aquí vive lo que no es de una ruta concreta:
 *
 * - pasar al cliente de la cuenta los vínculos de antes de compartirlos, sin
 *   perder nada (`migrarVinculo`; perezoso al abrir el correo del proyecto y,
 *   sin bloquear nada, al arrancar: `migrarVinculosACuentas`);
 * - que el nombre del cliente siga al de la cuenta (`alinearNombreCliente`, al
 *   leer el resumen y al renombrar la cuenta: `sincronizarNombreCuenta`).
 *
 * El aislamiento no cambia: cada ruta comprueba el cliente vinculado al
 * proyecto (`ownedSummary`) y solo acepta las referencias del propio proyecto
 * o de su cuenta (`acceptedClientRefs`).
 */
import { auditSystem } from './audit';
import { getProject, getSetting, getWorkspace, listMailwayLinks, setMailwayLinkClientName, setSetting } from './db';
import {
  MailwayClient,
  MailwayError,
  getClientByRef,
  linkClient,
  listClients,
  mailwayClientName,
  mailwayConfigured,
  ownClientKey,
  projectExternalRef,
  renameClient,
  workspaceExternalRef,
} from './mailway';
import { ProjectRow, WorkspaceRow } from './types';

type Aviso = (message: string) => void;

/** Nombre que debe tener en Mailway el cliente de una cuenta: el de la cuenta. */
export function workspaceClientName(workspace: Pick<WorkspaceRow, 'name'>): string {
  return mailwayClientName(workspace.name, 'Cuenta');
}

/** Cuenta del proyecto, o undefined si no tiene. */
export function workspaceOfMailProject(project: Pick<ProjectRow, 'workspace_id'>): WorkspaceRow | undefined {
  return project.workspace_id ? getWorkspace(project.workspace_id) : undefined;
}

/**
 * Pone al cliente de una cuenta el nombre de la cuenta si Mailway tiene otro y
 * actualiza el que recuerdan sus vínculos. Devuelve el nombre con el que queda.
 * Lanza si Mailway rechaza el cambio: quien llama decide si eso importa.
 */
export async function alinearNombreCliente(
  clientId: string,
  actual: string,
  workspace: Pick<WorkspaceRow, 'id' | 'name'>,
): Promise<string> {
  const nombre = workspaceClientName(workspace);
  if (actual !== nombre) {
    await renameClient(clientId, nombre);
    auditSystem('mailway_client_renamed', `Cliente de correo «${actual}» → «${nombre}» (nombre de la cuenta)`, {
      type: 'workspace',
      id: workspace.id,
    });
  }
  setMailwayLinkClientName(clientId, nombre);
  return nombre;
}

/** Cliente de la cuenta con la que el proyecto conserva el suyo (ver `ownClientKey`), o null. */
export function readOwnClient(projectId: string): { workspaceClientId: string; workspaceClientName: string } | null {
  const raw = getSetting(ownClientKey(projectId));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { workspaceClientId?: unknown; workspaceClientName?: unknown };
    return typeof v.workspaceClientId === 'string'
      ? { workspaceClientId: v.workspaceClientId, workspaceClientName: String(v.workspaceClientName ?? '') }
      : null;
  } catch {
    return null;
  }
}

/** Se registra una sola vez por cliente de la cuenta: abrir el panel no repite la entrada. */
function recordarClientePropio(project: ProjectRow, workspace: WorkspaceRow, clientId: string, cuenta: MailwayClient): void {
  const antes = readOwnClient(project.id);
  if (antes?.workspaceClientId === cuenta.id) return;
  setSetting(
    ownClientKey(project.id),
    JSON.stringify({ workspaceClientId: cuenta.id, workspaceClientName: cuenta.name, at: Date.now() }),
  );
  auditSystem(
    'mailway_client_kept',
    `${project.name}: conserva su propio cliente de Mailway (${clientId}); la cuenta «${workspace.name}» ya tenía otro («${cuenta.name}»)`,
    { type: 'project', id: project.id },
  );
}

export type MigracionVinculo =
  /** El cliente es el de la cuenta (ya lo era o acaba de pasar a serlo), con este nombre. */
  | { estado: 'cuenta'; name: string }
  /** La cuenta ya tenía otro cliente: el proyecto conserva el suyo, sin fusionar ni mover nada. */
  | { estado: 'propio'; cuenta: { id: string; name: string } };

/**
 * Pasa al cliente de la cuenta el vínculo de un proyecto que conserva su
 * cliente propio (`skyway:project:<id>`, de antes de compartirlos), sin perder
 * nada. Si la cuenta aún no tiene cliente, ese mismo cliente pasa a serlo
 * (referencia de la cuenta y su nombre), con sus dominios y buzones. Si ya
 * tiene otro, no se fusiona ni se mueve nada: el proyecto sigue con el suyo,
 * que funciona igual, y queda registrado para el administrador. `cuentaYa` es
 * el cliente de la cuenta si quien llama ya lo ha consultado. Lanza si
 * Mailway no responde: se volverá a intentar la próxima vez.
 */
export async function migrarVinculo(
  project: ProjectRow,
  workspace: WorkspaceRow,
  client: Pick<MailwayClient, 'id' | 'name'>,
  cuentaYa?: MailwayClient | null,
): Promise<MigracionVinculo> {
  const ref = workspaceExternalRef(workspace.id);
  let cuenta = cuentaYa === undefined ? await getClientByRef(ref) : cuentaYa;
  if (!cuenta) {
    try {
      await linkClient(client.id, ref);
    } catch (err) {
      // Otro cliente se ha quedado la referencia entretanto: es el de la cuenta.
      if (!(err instanceof MailwayError && err.status === 409)) throw err;
      cuenta = await getClientByRef(ref);
      if (!cuenta) throw err;
    }
  }
  if (cuenta && cuenta.id !== client.id) {
    recordarClientePropio(project, workspace, client.id, cuenta);
    return { estado: 'propio', cuenta: { id: cuenta.id, name: cuenta.name } };
  }
  setSetting(ownClientKey(project.id), null);
  if (!cuenta) {
    auditSystem(
      'mailway_client_shared',
      `${project.name}: el cliente «${client.name}» pasa a ser el de la cuenta «${workspace.name}» y lo comparten sus proyectos`,
      { type: 'project', id: project.id },
    );
  }
  let name = client.name;
  try {
    name = await alinearNombreCliente(client.id, client.name, workspace);
  } catch {
    // El vínculo ya es el de la cuenta; el nombre se alineará al abrir el correo.
  }
  return { estado: 'cuenta', name };
}

/**
 * Migración de arranque: recorre los vínculos de los proyectos de una cuenta
 * cuyo cliente aún lleva la referencia del proyecto y los pasa al cliente de
 * la cuenta (`migrarVinculo`), del vínculo más antiguo al más nuevo: si dos
 * proyectos de una cuenta tenían clientes distintos, el del primero pasa a ser
 * el de la cuenta y el segundo conserva el suyo. Una sola consulta a Mailway
 * para leer las referencias. Nunca lanza: los fallos se registran y la
 * migración perezosa lo reintenta al abrir el correo del proyecto.
 */
export async function migrarVinculosACuentas(aviso: Aviso): Promise<void> {
  if (!mailwayConfigured()) return;
  const links = listMailwayLinks().filter((l) => l.workspace_id);
  if (links.length === 0) return;
  let clients: MailwayClient[];
  try {
    clients = await listClients();
  } catch (err) {
    aviso(`No se ha podido revisar en Mailway el cliente de correo de las cuentas: ${(err as Error).message}`);
    return;
  }
  for (const link of links) {
    const project = getProject(link.project_id);
    const workspace = project ? workspaceOfMailProject(project) : undefined;
    const client = clients.find((c) => c.id === link.client_id);
    if (!project || !workspace || !client) continue;
    const ref = workspaceExternalRef(workspace.id);
    try {
      if (client.externalRef === projectExternalRef(project.id)) {
        const cuenta = clients.find((c) => c.externalRef === ref) ?? null;
        const r = await migrarVinculo(project, workspace, client, cuenta);
        // A partir de aquí es el de la cuenta: los siguientes proyectos de la cuenta lo encuentran.
        if (r.estado === 'cuenta') Object.assign(client, { externalRef: ref, name: r.name });
      } else if (client.externalRef === ref) {
        client.name = await alinearNombreCliente(client.id, client.name, workspace);
      }
    } catch (err) {
      aviso(`No se ha podido revisar el cliente de correo del proyecto «${project.name}»: ${(err as Error).message}`);
    }
  }
}

/**
 * Lleva a Mailway el nombre nuevo de una cuenta, si tiene cliente de correo.
 * Lanza si Mailway falla: quien llama lo registra sin deshacer el cambio.
 */
export async function sincronizarNombreCuenta(workspaceId: string): Promise<void> {
  if (!mailwayConfigured()) return;
  const workspace = getWorkspace(workspaceId);
  if (!workspace) return;
  const client = await getClientByRef(workspaceExternalRef(workspace.id));
  if (client) await alinearNombreCliente(client.id, client.name, workspace);
}
