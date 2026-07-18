import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth';
import { audit } from '../audit';
import {
  createProject,
  deleteProject,
  getProject,
  getProjectVars,
  listProjects,
  listServices,
  openAlertCountsByService,
  projectSlugExists,
  setProjectVars,
  updateProjectMeta,
} from '../db';
import { dockerAvailable } from '../docker/client';
import { containerName, getRuntime, removeContainer, removeVolume, stopContainer, volumeName } from '../docker/containers';
import { projectNetworkName, removeNetwork } from '../docker/networks';
import { ServiceRuntime } from '../types';
import { slugify } from '../util';

const projectSchema = z.object({
  name: z.string().trim().min(1, 'Nombre requerido').max(60),
  client: z.string().trim().max(60).optional(),
});

async function serviceWithRuntime(project: any, service: any, docker: boolean) {
  const runtime: ServiceRuntime = docker
    ? await getRuntime(containerName(project, service))
    : { state: 'unknown', startedAt: null, exitCode: null, restartCount: 0, image: null };
  return { ...service, runtime };
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/projects', async () => {
    const projects = listProjects();
    return {
      projects: projects.map((p) => ({ ...p, serviceCount: listServices(p.id).length })),
    };
  });

  app.post('/api/projects', async (req, reply) => {
    const body = projectSchema.parse(req.body);
    let slug = slugify(body.name);
    let i = 2;
    while (projectSlugExists(slug)) slug = `${slugify(body.name)}-${i++}`;
    const project = createProject(body.name, slug, body.client?.trim() || null);
    audit(req, 'project_created', { type: 'project', id: project.id, detail: project.name });
    reply.code(201);
    return { project };
  });

  app.get('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = getProject(id);
    if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });
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
    const body = projectSchema.partial().parse(req.body);
    const name = body.name ?? project.name;
    const client = body.client === undefined ? project.client : body.client.trim() || null;
    updateProjectMeta(id, name, client);
    audit(req, 'project_updated', { type: 'project', id, detail: name });
    return { project: { ...project, name, client } };
  });

  app.delete('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { volumes } = req.query as { volumes?: string };
    const project = getProject(id);
    if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });

    const services = listServices(id);
    if (await dockerAvailable()) {
      for (const service of services) {
        const name = containerName(project, service);
        try {
          await stopContainer(name);
          await removeContainer(name);
        } catch {
          /* best-effort */
        }
        if (volumes === 'true') {
          await removeVolume(volumeName(project, service));
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

  // ---- variables compartidas del proyecto ----
  app.get('/api/projects/:id/vars', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getProject(id)) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    return { vars: getProjectVars(id) };
  });

  app.put('/api/projects/:id/vars', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getProject(id)) return reply.code(404).send({ error: 'Proyecto no encontrado' });
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
