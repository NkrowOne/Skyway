import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  listServices,
  projectSlugExists,
  renameProject,
} from '../db';
import { dockerAvailable } from '../docker/client';
import { containerName, getRuntime, removeContainer, removeVolume, stopContainer, volumeName } from '../docker/containers';
import { projectNetworkName, removeNetwork } from '../docker/networks';
import { ServiceRuntime } from '../types';
import { slugify } from '../util';

const nameSchema = z.object({ name: z.string().trim().min(1, 'Nombre requerido').max(60) });

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
    const body = nameSchema.parse(req.body);
    let slug = slugify(body.name);
    let i = 2;
    while (projectSlugExists(slug)) slug = `${slugify(body.name)}-${i++}`;
    const project = createProject(body.name, slug);
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
    return { project, services, docker };
  });

  app.patch('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = getProject(id);
    if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    const body = nameSchema.parse(req.body);
    renameProject(id, body.name);
    return { project: { ...project, name: body.name } };
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
    return { ok: true };
  });
}
