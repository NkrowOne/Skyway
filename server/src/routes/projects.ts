import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accessibleProjectRows, assertProjectAccess, assertProjectManage, currentUser, requireAuth } from '../auth';
import { audit } from '../audit';
import {
  activeDeploymentsByProject,
  bumpProjectConfigRev,
  clearProjectMemberships,
  createProject,
  countWorkspaceProjects,
  getMailwayLink,
  getOrCreateWorkspaceByName,
  getProject,
  getProjectVars,
  getWorkspace,
  listProjects,
  listServices,
  listServicesForProjects,
  openAlertCountsByService,
  patchProjectVars,
  projectDashboardMeta,
  projectSlugExists,
  servicesWithPendingChanges,
  setProjectVars,
  setProjectWorkspace,
  updateProjectMeta,
} from '../db';
import { envPatchSchema, invalidEnvKey, publicServiceConfig } from './services';
import { toDeployFeedItem } from '../events';
import { dockerAvailable } from '../docker/client';
import { dockerSnapshot, runtimeIn, Snapshot } from '../docker/sampler';
import { triggerDeploy } from '../deploy/deployer';
import { bloqueoPorCambioConCorreo } from '../domainmigration';
import { markManualAction } from '../monitor';
import { mailwayConfigured, releaseProjectClient } from '../mailway';
import { confirmsDeletion, purgeProject, PurgeBlockedError, purgeSummary, warningsForAudit } from '../purge';
import { effectiveQuota, isWorkspaceActive, workspacePlan } from '../quota';
import { ServiceRow, ServiceRuntime, WorkspaceRow } from '../types';
import { slugify, VISIBLE_NAME_ERROR, VISIBLE_NAME_RE } from '../util';

const projectSchema = z.object({
  name: z.string().trim().min(1, 'Nombre requerido').max(60).regex(VISIBLE_NAME_RE, VISIBLE_NAME_ERROR),
  // Texto de cliente: reutiliza o crea un workspace con ese nombre (compat con el flujo anterior).
  client: z.string().trim().max(80).optional(),
  // Asignación explícita a un workspace (admin). null desasigna.
  workspaceId: z.string().trim().nullable().optional(),
});

/**
 * Antigüedad tolerada de la foto de Docker en las lecturas del panel. El panel
 * repite estas consultas cada pocos segundos: sin foto compartida, cada una
 * lanzaba un `inspect` por servicio contra el socket.
 */
const PANEL_MAX_AGE_MS = 4000;

/** Proyectos que se están eliminando: un segundo DELETE a la vez no repite el trabajo. */
const deletingProjects = new Set<string>();

function serviceWithRuntime(service: ServiceRow, snap: Snapshot, pending: ReadonlySet<string>) {
  const runtime: ServiceRuntime = runtimeIn(snap, service.id);
  // Vista de proyecto: la ven todos sus miembros, así que sin secretos.
  // `pendingChanges`: cambios guardados que su último despliegue no lleva.
  return { ...service, config: publicServiceConfig(service.config), runtime, pendingChanges: pending.has(service.id) };
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/projects', async (req) => {
    const user = currentUser(req)!;
    const projects = accessibleProjectRows(user, listProjects());
    const meta = projectDashboardMeta();
    // Una consulta para los servicios de todos los proyectos: el panel sondea
    // esto cada 8 s y antes lanzaba una por proyecto.
    const servicesByProject = listServicesForProjects(projects.map((p) => p.id));
    return {
      projects: projects.map((p) => {
        const sList = servicesByProject.get(p.id) ?? [];
        return {
          ...p,
          serviceCount: sList.length,
          services: sList.map((s) => ({
            id: s.id,
            name: s.name,
            type: s.type,
            config: publicServiceConfig(s.config),
          })),
          lastDeployAt: meta[p.id]?.lastDeployAt ?? null,
          openAlerts: meta[p.id]?.openAlerts ?? 0,
          activeDeploys: meta[p.id]?.activeDeploys ?? 0,
        };
      }),
    };
  });

  app.post('/api/projects', async (req, reply) => {
    const user = currentUser(req)!;
    if (user.role === 'member') {
      return reply.code(403).send({ error: 'Requiere ser administrador o propietario del workspace' });
    }
    const body = projectSchema.parse(req.body);

    // Resolver el workspace destino según el rol.
    let workspace: WorkspaceRow | undefined;
    if (user.role === 'owner') {
      if (!user.workspace_id) return reply.code(403).send({ error: 'Tu cuenta no tiene un workspace asignado' });
      workspace = getWorkspace(user.workspace_id);
      // No es un error de la petición: la cuenta apunta a un workspace que ya no
      // existe (borrado sin reasignar a sus usuarios). Solo el admin lo arregla.
      if (!workspace) {
        return reply.code(409).send({
          error: 'El workspace de tu cuenta ya no existe. Solicita a un administrador que reasigne tu usuario a un workspace.',
        });
      }
    } else if (body.workspaceId) {
      workspace = getWorkspace(body.workspaceId);
      if (!workspace) return reply.code(400).send({ error: 'Workspace desconocido' });
    } else if (body.client && body.client.trim()) {
      workspace = getOrCreateWorkspaceByName(body.client.trim());
    }

    if (workspace) {
      if (!isWorkspaceActive(workspace)) {
        return reply.code(403).send({ error: 'El workspace está suspendido: no se pueden crear proyectos.' });
      }
      const quota = effectiveQuota(workspace, workspacePlan(workspace));
      if (countWorkspaceProjects(workspace.id) >= quota.maxProjects) {
        return reply.code(409).send({
          error: `El workspace ha alcanzado su límite de ${quota.maxProjects} proyectos. Un administrador puede ampliar la cuota.`,
        });
      }
    }

    let slug = slugify(body.name);
    let i = 2;
    while (projectSlugExists(slug)) slug = `${slugify(body.name)}-${i++}`;
    const project = createProject(body.name, slug, workspace?.name ?? null, workspace?.id ?? null);
    audit(req, 'project_created', {
      type: 'project',
      id: project.id,
      detail: workspace ? `${project.name} · ${workspace.name}` : project.name,
    });
    reply.code(201);
    return { project };
  });

  app.get('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = getProject(id);
    if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    if (!assertProjectAccess(req, reply, id)) return reply;
    // Una sola foto para todo el proyecto, y es ella quien dice si Docker
    // respondía: así el `docker` que se devuelve no puede contradecir a los
    // estados que lo acompañan.
    const snap = await dockerSnapshot(PANEL_MAX_AGE_MS);
    const docker = snap.docker;
    const rows = listServices(id);
    const pending = servicesWithPendingChanges(rows);
    const services = rows.map((s) => serviceWithRuntime(s, snap, pending));
    // activeDeploys va en la carga inicial para que la rejilla ya pinte «hay
    // una versión saliendo» en el primer render, sin esperar al stream.
    const active = activeDeploymentsByProject(id);
    return {
      project,
      services,
      docker,
      alertCounts: openAlertCountsByService(id),
      activeDeploys: Object.fromEntries(
        Object.entries(active).map(([serviceId, row]) => [serviceId, toDeployFeedItem(row, id)]),
      ),
    };
  });

  app.patch('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = getProject(id);
    if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    if (!assertProjectManage(req, reply, id)) return reply;
    const user = currentUser(req)!;
    const body = projectSchema.partial().parse(req.body);
    const name = body.name ?? project.name;

    // Solo el admin puede reasignar el proyecto a otro workspace (o desasignarlo);
    // el propietario únicamente renombra dentro del suyo.
    const reassigning = user.role === 'admin' && (body.workspaceId !== undefined || body.client !== undefined);
    if (reassigning) {
      let workspace: WorkspaceRow | undefined;
      if (body.workspaceId) {
        workspace = getWorkspace(body.workspaceId);
        if (!workspace) return reply.code(400).send({ error: 'Workspace desconocido' });
      } else if (body.client && body.client.trim()) {
        workspace = getOrCreateWorkspaceByName(body.client.trim());
      }
      const changingWorkspace = (workspace?.id ?? null) !== project.workspace_id;
      if (workspace && changingWorkspace) {
        const quota = effectiveQuota(workspace, workspacePlan(workspace));
        if (countWorkspaceProjects(workspace.id) >= quota.maxProjects) {
          return reply.code(409).send({ error: `El workspace destino ha alcanzado su límite de ${quota.maxProjects} proyectos.` });
        }
      }
      updateProjectMeta(id, name, workspace?.name ?? null);
      setProjectWorkspace(id, workspace?.id ?? null, workspace?.name ?? null);
      // Al cambiar de workspace, se retiran los accesos de miembros del anterior
      // (sus asignaciones puntuales ya no corresponden al nuevo cliente).
      if (changingWorkspace) clearProjectMemberships(id);
    } else {
      updateProjectMeta(id, name, project.client);
    }
    audit(req, 'project_updated', { type: 'project', id, detail: name });
    return { project: getProject(id) };
  });

  /**
   * Elimina el proyecto con TODOS sus datos: contenedores, volúmenes de todos
   * sus servicios, imágenes construidas, copias de seguridad en disco y red
   * (ver `purge.ts`). No hay opción para conservar los datos: un volumen que
   * sobrevive a su proyecto lo heredaba el siguiente proyecto con el mismo
   * nombre. Por eso se exige `?confirm=` con el nombre del proyecto (o su
   * slug), y sin Docker no se borra nada: borrar solo las filas dejaría los
   * datos sin dueño.
   */
  app.delete('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { confirm } = (req.query ?? {}) as { confirm?: unknown };
    const project = getProject(id);
    if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    if (!assertProjectManage(req, reply, id)) return reply;
    if (!confirmsDeletion(confirm, project)) {
      return reply.code(400).send({
        error:
          typeof confirm === 'string' && confirm.trim()
            ? `El texto de confirmación no coincide con el nombre del proyecto («${project.name}»). No se ha eliminado nada.`
            : `Para eliminar el proyecto, confirma con su nombre («${project.name}») en el parámetro confirm. Se eliminarán sus servicios y todos sus datos (volúmenes, bases de datos y copias de seguridad) sin posibilidad de recuperarlos.`,
      });
    }
    if (deletingProjects.has(id)) return reply.code(409).send({ error: 'El proyecto ya se está eliminando.' });
    const cambioAbierto = bloqueoPorCambioConCorreo(id, 'eliminar el proyecto');
    if (cambioAbierto) return reply.code(409).send({ error: cambioAbierto, code: 'migration_open' });
    if (!(await dockerAvailable(true))) {
      return reply.code(503).send({
        error: 'Docker no está disponible: no es posible eliminar el proyecto sin eliminar sus datos. Vuelve a intentarlo cuando Docker responda. No se ha eliminado nada.',
      });
    }

    deletingProjects.add(id);
    try {
      // El vínculo de correo se borra con el proyecto (ON DELETE CASCADE); en
      // Mailway se suelta la referencia en segundo plano para que el cliente no
      // quede apuntando a un proyecto que ya no existe (solo si todavía la
      // lleva: si es de otra integración no se toca). Sus buzones siguen allí.
      const mailLink = getMailwayLink(id);
      const report = await purgeProject(project);
      if (mailLink && mailwayConfigured()) {
        void releaseProjectClient(id, mailLink.client_id).catch((err: unknown) => {
          req.log.warn({ clientId: mailLink.client_id }, `No se pudo soltar el cliente de Mailway: ${(err as Error)?.message ?? err}`);
        });
      }
      // El slug va en el registro: es lo que permite saber, después, qué nombres
      // de volumen tenía el proyecto.
      audit(req, 'project_deleted', {
        type: 'project',
        id,
        detail:
          `${project.name} (${project.slug}) · ${purgeSummary(report)}` +
          warningsForAudit(report.warnings),
      });
      return {
        ok: true,
        warnings: report.warnings,
        removed: { services: report.services, volumes: report.volumes, images: report.images, backups: report.backups },
      };
    } catch (err) {
      if (!(err instanceof PurgeBlockedError)) throw err;
      return reply.code(409).send({
        error: `No se ha podido retirar todo lo que está en marcha, así que no se han eliminado los datos ni el proyecto. Vuelve a intentarlo. ${err.message}`,
        warnings: err.warnings,
      });
    } finally {
      deletingProjects.delete(id);
    }
  });

  /** Despliega de una vez todos los servicios de repo e imagen del proyecto. */
  app.post('/api/projects/:id/deploy-all', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = getProject(id);
    if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    if (!assertProjectAccess(req, reply, id)) return reply;
    const targets = listServices(id).filter((s) => s.type !== 'database');
    for (const service of targets) {
      markManualAction(service.id);
      triggerDeploy(service.id, 'manual');
    }
    audit(req, 'project_deploy_all', { type: 'project', id, detail: `${project.name}: ${targets.length} servicios` });
    reply.code(202);
    return { count: targets.length };
  });

  // ---- variables compartidas del proyecto ----
  app.get('/api/projects/:id/vars', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getProject(id)) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    if (!assertProjectAccess(req, reply, id)) return reply;
    return { vars: getProjectVars(id) };
  });

  app.put('/api/projects/:id/vars', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getProject(id)) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    if (!assertProjectAccess(req, reply, id)) return reply;
    const body = z.object({ vars: z.record(z.string()) }).parse(req.body);
    const mala = invalidEnvKey(Object.keys(body.vars));
    if (mala !== null) return reply.code(400).send({ error: `Nombre de variable inválido: ${mala}`, code: 'invalid_key' });
    setProjectVars(id, body.vars);
    bumpProjectConfigRev(id);
    audit(req, 'project_vars_updated', { type: 'project', id, detail: `${Object.keys(body.vars).length} variables` });
    return { ok: true, needsRedeploy: true, affected: affectedServices(id) };
  });

  /**
   * Guardado del modal de variables compartidas: solo los cambios de quien
   * edita (como `PATCH /services/:id/env`). Devuelve los servicios a los que
   * llegan, que son todos los del proyecto, para ofrecer desplegarlos.
   */
  app.patch('/api/projects/:id/vars', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getProject(id)) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    if (!assertProjectAccess(req, reply, id)) return reply;
    const body = envPatchSchema.parse(req.body ?? {});
    const mala = invalidEnvKey([...Object.keys(body.set), ...body.unset]);
    if (mala !== null) return reply.code(400).send({ error: `Nombre de variable inválido: ${mala}`, code: 'invalid_key' });
    const cambiadas = Object.keys(body.set).length;
    const quitadas = body.unset.filter((k) => !Object.hasOwn(body.set, k)).length;
    if (cambiadas + quitadas > 0) {
      patchProjectVars(id, body.set, body.unset);
      bumpProjectConfigRev(id);
      audit(req, 'project_vars_updated', { type: 'project', id, detail: `${cambiadas} definidas, ${quitadas} eliminadas` });
    }
    return { ok: true, needsRedeploy: cambiadas + quitadas > 0, vars: getProjectVars(id), affected: affectedServices(id) };
  });
}

/**
 * Servicios a los que llegan las variables compartidas (todos los del proyecto)
 * y que tienen algo desplegado: los que hay que volver a desplegar para aplicarlas.
 */
function affectedServices(projectId: string): { id: string; name: string; type: string }[] {
  const rows = listServices(projectId);
  const pending = servicesWithPendingChanges(rows);
  return rows.filter((s) => pending.has(s.id)).map((s) => ({ id: s.id, name: s.name, type: s.type }));
}
