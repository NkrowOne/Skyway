import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertProjectAccess, assertProjectManage, canAccessProject, currentUser, requireAuth } from '../auth';
import { audit } from '../audit';
import {
  clearProjectMemberships,
  createProject,
  countWorkspaceProjects,
  deleteProject,
  getOrCreateWorkspaceByName,
  getProject,
  getProjectVars,
  getWorkspace,
  listProjects,
  listServices,
  openAlertCountsByService,
  projectDashboardMeta,
  projectSlugExists,
  setProjectVars,
  setProjectWorkspace,
  updateProjectMeta,
} from '../db';
import { dockerAvailable } from '../docker/client';
import { containerName, getRuntime, listServiceContainers, removeContainer, removeVolume, stopContainer, volumeName } from '../docker/containers';
import { projectNetworkName, removeNetwork } from '../docker/networks';
import { triggerDeploy } from '../deploy/deployer';
import { markManualAction } from '../monitor';
import { effectiveQuota, isWorkspaceActive, workspacePlan } from '../quota';
import { ServiceRuntime, WorkspaceRow } from '../types';
import { slugify } from '../util';

const projectSchema = z.object({
  name: z.string().trim().min(1, 'Nombre requerido').max(60),
  // Texto de cliente: reutiliza o crea un workspace con ese nombre (compat con el flujo anterior).
  client: z.string().trim().max(80).optional(),
  // Asignación explícita a un workspace (admin). null desasigna.
  workspaceId: z.string().trim().nullable().optional(),
});

async function serviceWithRuntime(project: any, service: any, docker: boolean) {
  const runtime: ServiceRuntime = docker
    ? await getRuntime(containerName(project, service))
    : { state: 'unknown', startedAt: null, exitCode: null, restartCount: 0, image: null };
  return { ...service, runtime };
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/projects', async (req) => {
    const user = currentUser(req)!;
    const projects = listProjects().filter((p) => canAccessProject(user, p.id));
    const meta = projectDashboardMeta();
    return {
      projects: projects.map((p) => ({
        ...p,
        serviceCount: listServices(p.id).length,
        lastDeployAt: meta[p.id]?.lastDeployAt ?? null,
        openAlerts: meta[p.id]?.openAlerts ?? 0,
      })),
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
      if (!workspace) return reply.code(400).send({ error: 'Workspace no encontrado' });
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
    const docker = await dockerAvailable();
    const services = await Promise.all(
      listServices(id).map((s) => serviceWithRuntime(project, s, docker)),
    );
    return { project, services, docker, alertCounts: openAlertCountsByService(id) };
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

  app.delete('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { volumes } = req.query as { volumes?: string };
    const project = getProject(id);
    if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    if (!assertProjectManage(req, reply, id)) return reply;

    const services = listServices(id);
    if (await dockerAvailable()) {
      for (const service of services) {
        try {
          for (const c of await listServiceContainers(service.id)) {
            await stopContainer(c.name);
            await removeContainer(c.name);
          }
        } catch {
          /* best-effort */
        }
        if (volumes === 'true') {
          await removeVolume(volumeName(project, service));
          for (const vol of ((service.config as any).volumes ?? []) as { name: string }[]) {
            await removeVolume(vol.name);
          }
        }
      }
      await removeNetwork(projectNetworkName(project));
    }
    deleteProject(id);
    audit(req, 'project_deleted', {
      type: 'project',
      id,
      detail: `${project.name}${volumes === 'true' ? ' (con volúmenes)' : ''}`,
    });
    return { ok: true };
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
    for (const key of Object.keys(body.vars)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return reply.code(400).send({ error: `Nombre de variable inválido: ${key}` });
      }
    }
    setProjectVars(id, body.vars);
    audit(req, 'project_vars_updated', { type: 'project', id, detail: `${Object.keys(body.vars).length} variables` });
    return { ok: true, needsRedeploy: true };
  });
}
