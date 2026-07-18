import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth';
import {
  createService,
  deleteService,
  getEnv,
  getProject,
  getService,
  latestDeployment,
  serviceSlugExists,
  setEnv,
  updateService,
} from '../db';
import { dockerAvailable } from '../docker/client';
import {
  containerName,
  getRuntime,
  removeContainer,
  removeVolume,
  restartContainer,
  startContainer,
  stopContainer,
  updateResources,
  volumeName,
} from '../docker/containers';
import { triggerDeploy } from '../deploy/deployer';
import { getTemplate, templateList } from '../templates';
import { availableReferences, resolveServiceEnv } from '../variables';
import { DatabaseConfig, GitConfig, ServiceRow } from '../types';
import { randomToken, slugify } from '../util';

const createGitSchema = z.object({
  type: z.literal('git'),
  name: z.string().trim().min(1).max(60),
  repoUrl: z.string().trim().min(3, 'Repositorio requerido'),
  branch: z.string().trim().min(1).default('main'),
  rootDir: z.string().trim().optional(),
  dockerfilePath: z.string().trim().optional(),
  startCmd: z.string().trim().optional(),
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  domains: z.array(z.string().trim().min(1)).default([]),
});

const createDbSchema = z.object({
  type: z.literal('database'),
  name: z.string().trim().min(1).max(60).optional(),
  template: z.string(),
  version: z.string().trim().optional(),
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  config: z
    .object({
      repoUrl: z.string().trim().min(3).optional(),
      branch: z.string().trim().min(1).optional(),
      rootDir: z.string().trim().nullable().optional(),
      dockerfilePath: z.string().trim().nullable().optional(),
      startCmd: z.string().trim().nullable().optional(),
      port: z.coerce.number().int().min(1).max(65535).optional(),
      domains: z.array(z.string().trim().min(1)).optional(),
      hostPort: z.coerce.number().int().min(1).max(65535).nullable().optional(),
      cpus: z.coerce.number().min(0.1).max(64).nullable().optional(),
      memoryMb: z.coerce.number().int().min(32).max(1024 * 512).nullable().optional(),
      version: z.string().trim().optional(),
      buildArgs: z.record(z.string()).optional(),
    })
    .optional(),
});

/** Campos cuyo cambio requiere recrear el contenedor. */
const REDEPLOY_FIELDS = [
  'repoUrl', 'branch', 'rootDir', 'dockerfilePath', 'startCmd', 'port',
  'domains', 'hostPort', 'version', 'buildArgs',
] as const;

function loadService(id: string): { service: ServiceRow; project: NonNullable<ReturnType<typeof getProject>> } | null {
  const service = getService(id);
  if (!service) return null;
  const project = getProject(service.project_id);
  if (!project) return null;
  return { service, project };
}

export async function serviceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/templates', async () => ({ templates: templateList() }));

  app.post('/api/projects/:projectId/services', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = getProject(projectId);
    if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });

    const base = z.object({ type: z.enum(['git', 'database']) }).parse(req.body);

    let service: ServiceRow;
    if (base.type === 'git') {
      const body = createGitSchema.parse(req.body);
      const slug = uniqueSlug(projectId, body.name);
      const cfg: GitConfig = {
        repoUrl: body.repoUrl,
        branch: body.branch,
        rootDir: body.rootDir || undefined,
        dockerfilePath: body.dockerfilePath || undefined,
        startCmd: body.startCmd || undefined,
        port: body.port,
        domains: body.domains,
        webhookSecret: randomToken(16),
      };
      service = createService(projectId, body.name, slug, 'git', cfg);
    } else {
      const body = createDbSchema.parse(req.body);
      const template = getTemplate(body.template);
      if (!template) return reply.code(400).send({ error: `Plantilla desconocida: ${body.template}` });
      const name = body.name || template.label;
      const slug = uniqueSlug(projectId, name);
      const cfg: DatabaseConfig = {
        template: template.key,
        version: body.version || template.defaultVersion,
      };
      service = createService(projectId, name, slug, 'database', cfg);
      setEnv(service.id, template.makeEnv(slug));
    }

    const deployment = triggerDeploy(service.id, 'initial');
    reply.code(201);
    return { service, deployment };
  });

  app.get('/api/services/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = loadService(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    const docker = await dockerAvailable();
    const runtime = docker
      ? await getRuntime(containerName(found.project, found.service))
      : { state: 'unknown', startedAt: null, exitCode: null, restartCount: 0, image: null };
    return {
      service: found.service,
      project: found.project,
      runtime,
      latestDeployment: latestDeployment(id) ?? null,
    };
  });

  app.patch('/api/services/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = loadService(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    const body = patchSchema.parse(req.body);

    const oldCfg = found.service.config as any;
    const newCfg = { ...oldCfg };
    let needsRedeploy = false;
    let resourcesChanged = false;

    if (body.config) {
      for (const [key, value] of Object.entries(body.config)) {
        if (value === undefined) continue;
        const normalized = value === null ? undefined : value;
        if ((REDEPLOY_FIELDS as readonly string[]).includes(key)) {
          if (JSON.stringify(oldCfg[key] ?? null) !== JSON.stringify(value ?? null)) needsRedeploy = true;
        }
        if (key === 'cpus' || key === 'memoryMb') {
          if ((oldCfg[key] ?? null) !== (value ?? null)) resourcesChanged = true;
          newCfg[key] = value; // conserva null explícito para "sin límite"
          continue;
        }
        newCfg[key] = normalized;
      }
    }

    const name = body.name ?? found.service.name;
    updateService(id, name, newCfg);

    if (resourcesChanged && (await dockerAvailable())) {
      try {
        await updateResources(containerName(found.project, found.service), newCfg.cpus, newCfg.memoryMb);
      } catch {
        needsRedeploy = true;
      }
    }

    const updated = getService(id)!;
    return { service: updated, needsRedeploy };
  });

  app.delete('/api/services/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { volumes } = req.query as { volumes?: string };
    const found = loadService(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });

    if (await dockerAvailable()) {
      const name = containerName(found.project, found.service);
      try {
        await stopContainer(name);
        await removeContainer(name);
      } catch {
        /* best-effort */
      }
      if (volumes === 'true') {
        await removeVolume(volumeName(found.project, found.service));
      }
    }
    deleteService(id);
    return { ok: true };
  });

  app.post('/api/services/:id/deploy', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = loadService(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    const deployment = triggerDeploy(id, 'manual');
    reply.code(202);
    return { deployment };
  });

  for (const action of ['start', 'stop', 'restart'] as const) {
    app.post(`/api/services/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const found = loadService(id);
      if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
      if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });
      const name = containerName(found.project, found.service);
      try {
        if (action === 'start') await startContainer(name);
        else if (action === 'stop') await stopContainer(name);
        else await restartContainer(name);
      } catch (err: any) {
        return reply.code(500).send({ error: err?.message || 'Operación fallida' });
      }
      return { ok: true, runtime: await getRuntime(name) };
    });
  }

  app.get('/api/services/:id/env', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = loadService(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    return {
      vars: getEnv(id),
      resolved: resolveServiceEnv(found.service),
      references: availableReferences(found.service),
    };
  });

  app.put('/api/services/:id/env', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = loadService(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    const body = z.object({ vars: z.record(z.string()) }).parse(req.body);
    for (const key of Object.keys(body.vars)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return reply.code(400).send({ error: `Nombre de variable inválido: ${key}` });
      }
    }
    setEnv(id, body.vars);
    return { ok: true, needsRedeploy: true };
  });
}

function uniqueSlug(projectId: string, name: string): string {
  const base = slugify(name);
  let slug = base;
  let i = 2;
  while (serviceSlugExists(projectId, slug)) slug = `${base}-${i++}`;
  return slug;
}
