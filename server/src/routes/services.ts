import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertProjectAccess, requireAuth } from '../auth';
import { audit } from '../audit';
import { markManualAction } from '../monitor';
import {
  createService,
  deleteService,
  getEnv,
  getGithubConnector,
  getProject,
  getService,
  latestDeployment,
  serviceSlugExists,
  setEnv,
  updateService,
} from '../db';
import { dockerAvailable } from '../docker/client';
import {
  configuredReplicas,
  containerName,
  getRuntime,
  listServiceContainers,
  removeContainer,
  removeVolume,
  replicaName,
  restartContainer,
  startContainer,
  stopContainer,
  updateResources,
  volumeName,
} from '../docker/containers';
import { triggerDeploy } from '../deploy/deployer';
import { getTemplate, templateList } from '../templates';
import { availableReferences, resolveServiceEnv } from '../variables';
import { DatabaseConfig, GitConfig, ImageConfig, ServiceRow } from '../types';
import { randomToken, slugify } from '../util';

const createGitSchema = z.object({
  type: z.literal('git'),
  name: z.string().trim().min(1).max(60),
  repoUrl: z.string().trim().min(3, 'Repositorio requerido'),
  connectorId: z.string().trim().optional(),
  branch: z.string().trim().min(1).default('main'),
  rootDir: z.string().trim().optional(),
  dockerfilePath: z.string().trim().optional(),
  startCmd: z.string().trim().optional(),
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  domains: z.array(z.string().trim().min(1)).default([]),
  autoDeploy: z.boolean().default(true),
});

const createDbSchema = z.object({
  type: z.literal('database'),
  name: z.string().trim().min(1).max(60).optional(),
  template: z.string(),
  version: z.string().trim().optional(),
});

const createImageSchema = z.object({
  type: z.literal('image'),
  name: z.string().trim().min(1).max(60),
  image: z.string().trim().min(1, 'Imagen requerida'),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  startCmd: z.string().trim().optional(),
  domains: z.array(z.string().trim().min(1)).default([]),
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  config: z
    .object({
      repoUrl: z.string().trim().min(3).optional(),
      connectorId: z.string().trim().nullable().optional(),
      branch: z.string().trim().min(1).optional(),
      rootDir: z.string().trim().nullable().optional(),
      dockerfilePath: z.string().trim().nullable().optional(),
      startCmd: z.string().trim().nullable().optional(),
      // nullable: los servicios de imagen sin puerto interno (workers) envían
      // null; sin esto, NINGÚN ajuste suyo se podía guardar (Number(null)=0).
      port: z.coerce.number().int().min(1).max(65535).nullable().optional(),
      domains: z.array(z.string().trim().min(1)).optional(),
      hostPort: z.coerce.number().int().min(1).max(65535).nullable().optional(),
      cpus: z.coerce.number().min(0.1).max(64).nullable().optional(),
      memoryMb: z.coerce.number().int().min(32).max(1024 * 512).nullable().optional(),
      diskMb: z.coerce.number().int().min(64).max(1024 * 1024).nullable().optional(),
      version: z.string().trim().optional(),
      image: z.string().trim().min(1).optional(),
      healthcheckPath: z.string().trim().max(200).nullable().optional(),
      buildArgs: z.record(z.string()).optional(),
      alertsMuted: z.boolean().optional(),
      autoDeploy: z.boolean().optional(),
      volumes: z.array(z.object({ containerPath: z.string().trim().min(1).regex(/^\//, 'Ruta absoluta requerida') })).optional(),
      replicas: z.coerce.number().int().min(1).max(10).optional(),
      backupSchedule: z.enum(['daily', 'weekly']).nullable().optional(),
      backupRetention: z.coerce.number().int().min(1).max(60).optional(),
    })
    .optional(),
});

/** Campos cuyo cambio requiere recrear el contenedor. */
const REDEPLOY_FIELDS = [
  'repoUrl', 'connectorId', 'branch', 'rootDir', 'dockerfilePath', 'startCmd', 'port',
  'domains', 'hostPort', 'version', 'image', 'buildArgs', 'healthcheckPath', 'volumes', 'replicas',
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
    if (!assertProjectAccess(req, reply, projectId)) return reply;

    const base = z.object({ type: z.enum(['git', 'database', 'image']) }).parse(req.body);

    let service: ServiceRow;
    if (base.type === 'image') {
      const body = createImageSchema.parse(req.body);
      const slug = uniqueSlug(projectId, body.name);
      const cfg: ImageConfig = {
        image: body.image,
        port: body.port ?? null,
        startCmd: body.startCmd || undefined,
        domains: body.domains,
      };
      service = createService(projectId, body.name, slug, 'image', cfg);
    } else if (base.type === 'git') {
      const body = createGitSchema.parse(req.body);
      if (body.connectorId && getGithubConnector(body.connectorId)?.project_id !== projectId) {
        return reply.code(400).send({ error: 'Conector de GitHub desconocido en este proyecto' });
      }
      const slug = uniqueSlug(projectId, body.name);
      const cfg: GitConfig = {
        repoUrl: body.repoUrl,
        connectorId: body.connectorId || undefined,
        branch: body.branch,
        rootDir: body.rootDir || undefined,
        dockerfilePath: body.dockerfilePath || undefined,
        startCmd: body.startCmd || undefined,
        port: body.port,
        domains: body.domains,
        autoDeploy: body.autoDeploy,
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

    audit(req, 'service_created', { type: 'service', id: service.id, detail: `${service.name} (${service.type})` });
    markManualAction(service.id);
    const deployment = triggerDeploy(service.id, 'initial');
    reply.code(201);
    return { service, deployment };
  });

  app.get('/api/services/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = loadService(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
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
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
    const body = patchSchema.parse(req.body);
    if (body.config?.connectorId && getGithubConnector(body.config.connectorId)?.project_id !== found.project.id) {
      return reply.code(400).send({ error: 'Conector de GitHub desconocido en este proyecto' });
    }

    const oldCfg = found.service.config as any;
    const newCfg = { ...oldCfg };
    let needsRedeploy = false;
    let resourcesChanged = false;

    if (body.config) {
      for (const [key, value] of Object.entries(body.config)) {
        if (value === undefined) continue;
        // El conector y el auto-deploy solo tienen sentido en servicios de repositorio.
        if (key === 'connectorId' && found.service.type !== 'git') continue;
        if (key === 'autoDeploy' && found.service.type !== 'git') continue;
        // Campos que no aplican a bases de datos: se ignoran sin efecto.
        if (found.service.type === 'database' && ['replicas', 'healthcheckPath'].includes(key)) continue;
        if (found.service.type !== 'database' && ['backupSchedule', 'backupRetention'].includes(key)) continue;
        // Un servicio git siempre escucha en un puerto: null no lo borra.
        if (key === 'port' && value === null && found.service.type === 'git') continue;
        let normalized: unknown = value === null ? undefined : value;

        // Los volúmenes llegan como rutas; se conserva el nombre del volumen
        // Docker existente para no perder los datos al reordenar/añadir.
        if (key === 'volumes' && Array.isArray(value)) {
          if (found.service.type === 'database') continue; // su volumen es fijo
          const oldVols: { name: string; containerPath: string }[] = oldCfg.volumes ?? [];
          const used = new Set(oldVols.map((v) => v.name));
          normalized = (value as { containerPath: string }[]).map((v) => {
            const existing = oldVols.find((o) => o.containerPath === v.containerPath);
            if (existing) return existing;
            let n = 0;
            let volName: string;
            do {
              volName = `skyway-${found.project.slug}-${found.service.slug}-data${n === 0 ? '' : n + 1}`;
              n += 1;
            } while (used.has(volName));
            used.add(volName);
            return { name: volName, containerPath: v.containerPath };
          });
          if ((normalized as any[]).length === 0) normalized = undefined;
        }

        if ((REDEPLOY_FIELDS as readonly string[]).includes(key)) {
          if (JSON.stringify(oldCfg[key] ?? null) !== JSON.stringify(normalized ?? null)) needsRedeploy = true;
        }
        if (key === 'cpus' || key === 'memoryMb') {
          if ((oldCfg[key] ?? null) !== (value ?? null)) resourcesChanged = true;
          newCfg[key] = value; // conserva null explícito para "sin límite"
          continue;
        }
        newCfg[key] = normalized;
      }
    }

    if ((newCfg.replicas ?? 1) > 1 && ((newCfg.volumes?.length ?? 0) > 0 || newCfg.hostPort)) {
      return reply.code(400).send({
        error:
          'Las réplicas requieren un servicio sin volúmenes y sin puerto público: varias copias no pueden compartir el mismo volumen de escritura ni el mismo puerto del host.',
      });
    }

    const name = body.name ?? found.service.name;
    updateService(id, name, newCfg);

    if (resourcesChanged && (await dockerAvailable())) {
      try {
        const updated = getService(id)!;
        for (let i = 1; i <= configuredReplicas(updated); i++) {
          await updateResources(replicaName(found.project, found.service, i), newCfg.cpus, newCfg.memoryMb);
        }
      } catch {
        needsRedeploy = true;
      }
    }

    const updated = getService(id)!;
    audit(req, 'service_updated', { type: 'service', id, detail: updated.name });
    return { service: updated, needsRedeploy };
  });

  app.delete('/api/services/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { volumes } = req.query as { volumes?: string };
    const found = loadService(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;

    markManualAction(id);
    if (await dockerAvailable()) {
      try {
        // Por label: incluye réplicas y restos de intercambios.
        for (const c of await listServiceContainers(id)) {
          await stopContainer(c.name);
          await removeContainer(c.name);
        }
      } catch {
        /* best-effort */
      }
      if (volumes === 'true') {
        await removeVolume(volumeName(found.project, found.service));
        for (const vol of ((found.service.config as any).volumes ?? []) as { name: string }[]) {
          await removeVolume(vol.name);
        }
      }
    }
    deleteService(id);
    audit(req, 'service_deleted', {
      type: 'service',
      id,
      detail: `${found.service.name}${volumes === 'true' ? ' (con volumen)' : ''}`,
    });
    return { ok: true };
  });

  app.post('/api/services/:id/deploy', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = loadService(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
    markManualAction(id);
    audit(req, 'service_deploy', { type: 'service', id, detail: found.service.name });
    const deployment = triggerDeploy(id, 'manual');
    reply.code(202);
    return { deployment };
  });

  for (const action of ['start', 'stop', 'restart'] as const) {
    app.post(`/api/services/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const found = loadService(id);
      if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
      if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });
      markManualAction(id);
      const total = configuredReplicas(found.service);
      try {
        for (let i = 1; i <= total; i++) {
          const name = replicaName(found.project, found.service, i);
          if (action === 'start') await startContainer(name);
          else if (action === 'stop') await stopContainer(name);
          else await restartContainer(name);
        }
      } catch (err: any) {
        return reply.code(500).send({ error: err?.message || 'Operación fallida' });
      }
      audit(req, `service_${action}`, { type: 'service', id, detail: found.service.name });
      return { ok: true, runtime: await getRuntime(containerName(found.project, found.service)) };
    });
  }

  app.get('/api/services/:id/env', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = loadService(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
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
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
    const body = z.object({ vars: z.record(z.string()) }).parse(req.body);
    for (const key of Object.keys(body.vars)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return reply.code(400).send({ error: `Nombre de variable inválido: ${key}` });
      }
    }
    setEnv(id, body.vars);
    audit(req, 'service_env_updated', {
      type: 'service',
      id,
      detail: `${found.service.name}: ${Object.keys(body.vars).length} variables`,
    });
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
