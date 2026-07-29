import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertProjectAccess, currentUser, requireAuth } from '../auth';
import { audit } from '../audit';
import { markManualAction } from '../monitor';
import {
  countWorkspaceServices,
  createService,
  getProject,
  getSetting,
  serviceSlugExists,
  setEnv,
} from '../db';
import {
  effectiveQuota,
  isWorkspaceActive,
  moduleAllowedForProject,
  workspaceOfProject,
  workspacePlan,
} from '../quota';
import { runStackDeploy, StackStep } from '../deploy/stackdeploy';
import { getStack, renderStackEnv, stackList, StackRenderCtx } from '../stacks';
import { getTemplate } from '../templates';
import { DatabaseConfig, ImageConfig, ServiceRow } from '../types';
import { slugify } from '../util';

const createSchema = z.object({
  stack: z.string().trim().min(1),
  /** Prefijo de los nombres de servicio (`<prefijo>-db`, `<prefijo>-kong`...). */
  prefix: z.string().trim().min(1).max(40).optional(),
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, 'Dominio no válido')
    .optional(),
});

/**
 * Prefijo libre en el proyecto: si ya existe un servicio con alguno de los
 * nombres que generaría la pila, se numera el prefijo entero. Así los slugs y
 * los nombres de volumen de una instancia siguen siendo coherentes entre sí.
 */
function uniquePrefix(projectId: string, base: string, keys: string[]): string {
  let prefix = base;
  let n = 2;
  while (keys.some((k) => serviceSlugExists(projectId, `${prefix}-${k}`))) {
    prefix = `${base}-${n++}`;
  }
  return prefix;
}

export async function stackRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/stacks', async () => ({ stacks: stackList() }));

  app.post('/api/projects/:projectId/stacks', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = getProject(projectId);
    if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    if (!assertProjectAccess(req, reply, projectId)) return reply;

    const body = createSchema.parse(req.body);
    const stack = getStack(body.stack);
    if (!stack) return reply.code(400).send({ error: `Pila desconocida: ${body.stack}` });

    // Mismas puertas que crear servicios sueltos, pero contando la pila entera.
    const isAdmin = currentUser(req)!.role === 'admin';
    const workspace = workspaceOfProject(projectId);
    if (workspace) {
      if (!isWorkspaceActive(workspace)) {
        return reply.code(403).send({ error: 'El workspace está suspendido: no se pueden crear servicios.' });
      }
      const quota = effectiveQuota(workspace, workspacePlan(workspace));
      const used = countWorkspaceServices(workspace.id);
      if (used + stack.services.length > quota.maxServices) {
        return reply.code(409).send({
          error: `La pila «${stack.label}» son ${stack.services.length} servicios y el workspace tiene ${used} de ${quota.maxServices}. Un administrador puede ampliar la cuota.`,
        });
      }
    }
    if (stack.services.some((s) => s.template) && !moduleAllowedForProject(projectId, 'databases', isAdmin)) {
      return reply.code(403).send({ error: 'El módulo «Bases de datos» no está activo en este workspace.' });
    }
    if (body.domain && !moduleAllowedForProject(projectId, 'domains', isAdmin)) {
      return reply.code(403).send({ error: 'El módulo «Dominios y TLS» no está activo en este workspace.' });
    }

    const prefix = uniquePrefix(
      projectId,
      slugify(body.prefix || stack.defaultPrefix) || stack.key,
      stack.services.map((s) => s.key),
    );
    const slugs = Object.fromEntries(stack.services.map((s) => [s.key, `${prefix}-${s.key}`]));

    const entry = stack.services.find((s) => s.public) ?? stack.services[stack.services.length - 1];
    // Sin dominio la pila sigue siendo utilizable desde el propio proyecto: las
    // URLs públicas apuntan al alias interno del servicio de entrada.
    const scheme = getSetting('letsencryptEmail') ? 'https' : 'http';
    const publicUrl = body.domain
      ? `${scheme}://${body.domain}`
      : `http://${slugs[entry.key]}:${entry.port ?? 80}`;

    const ctx: StackRenderCtx = {
      slugs,
      secretsSlug: slugs[stack.secretsService],
      publicUrl,
      domain: body.domain ?? null,
    };

    // Los secretos se guardan en las variables del servicio ancla de la pila (no
    // en las compartidas del proyecto, que se inyectan en TODOS los contenedores
    // del proyecto, incluidos los que el usuario despliegue después).
    const secrets = stack.makeSecrets();

    const created: ServiceRow[] = [];
    const steps: StackStep[] = [];
    for (const def of stack.services) {
      const slug = slugs[def.key];
      const domains = def.public && body.domain ? [body.domain] : [];
      // Los secretos ganan sobre el entorno renderizado: en el propio servicio
      // ancla, un `{{secret:X}}` se habría convertido en una referencia a su
      // propia variable X, que sin el valor literal detrás no resolvería nada.
      const own = (env: Record<string, string>) =>
        def.key === stack.secretsService ? { ...env, ...secrets } : env;
      let service: ServiceRow;

      if (def.template) {
        const template = getTemplate(def.template);
        if (!template) return reply.code(500).send({ error: `Plantilla desconocida: ${def.template}` });
        const cfg: DatabaseConfig = {
          template: template.key,
          version: def.version || template.defaultVersion,
          stack: stack.key,
        };
        service = createService(projectId, slug, slug, 'database', cfg);
        // Credenciales generadas por la plantilla, como en una base suelta: el
        // resto de la pila las referencia con ${{servicio.VARIABLE}}.
        setEnv(service.id, own(template.makeEnv(slug)));
      } else {
        const cfg: ImageConfig & { icon?: string; stack?: string } = {
          image: def.image!,
          port: def.port ?? null,
          domains,
          icon: def.icon,
          stack: stack.key,
        };
        if (def.volumes?.length) {
          // Separador `__` a propósito. Con guiones, el nombre sería AMBIGUO:
          // proyecto «acme-prod» + prefijo «supabase» y proyecto «acme» +
          // prefijo «prod-supabase» darían el mismo, y Docker adjunta el volumen
          // existente sin mirar de quién es — los datos de otro workspace. Ni
          // los slugs de proyecto ni los prefijos pueden contener `_`, así que
          // con este separador la descomposición es única. Dos servicios con la
          // misma clave lógica comparten volumen: storage e imgproxy lo
          // necesitan.
          cfg.volumes = def.volumes.map((v) => ({
            name: `skyway-${project.slug}__${prefix}__${v.key}`,
            containerPath: v.path,
          }));
        }
        service = createService(projectId, slug, slug, 'image', cfg);
        setEnv(service.id, own(def.env ? renderStackEnv(def.env, ctx) : {}));
      }

      // El monitor no debe interpretar los arranques de la pila como caídas.
      markManualAction(service.id);
      created.push(service);
      steps.push({ serviceId: service.id, key: def.key, stage: def.stage, readyCmd: def.readyCmd });
    }

    audit(req, 'stack_created', {
      type: 'project',
      id: projectId,
      detail: `${stack.label} → ${created.length} servicios (${prefix})`,
    });

    // El despliegue va por etapas y tarda minutos: se responde ya y el panel
    // sigue el progreso servicio a servicio, como en cualquier otro despliegue.
    void runStackDeploy(stack, steps).catch((err) => {
      req.log.error({ err, stack: stack.key }, 'fallo desplegando la pila');
    });

    reply.code(201);
    return { stack: stack.key, prefix, publicUrl, services: created };
  });
}
