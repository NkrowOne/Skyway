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
  transaction,
} from '../db';
import { rateLimit } from '../ratelimit';
import {
  effectiveQuota,
  isWorkspaceActive,
  moduleAllowedForProject,
  workspaceOfProject,
  workspacePlan,
} from '../quota';
import { runStackDeploy, StackStep } from '../deploy/stackdeploy';
import { parseTemplateCode } from '../railway/client';
import { planRailwayTemplate, rewriteTemplateRefs } from '../railway/template';
import { getStack, renderStackEnv, stackList, StackRenderCtx } from '../stacks';
import { getTemplate } from '../templates';
import { DatabaseConfig, GitConfig, ImageConfig, ServiceRow } from '../types';
import { randomToken, slugify } from '../util';
import { domainSchema, publicServiceConfig } from './services';

/**
 * Tope de vistas previas de plantillas por usuario y minuto: cada una consulta
 * la API pública de Railway, y sin tope el panel servía de proxy para ella.
 */
const PREVIEWS_POR_MINUTO = 20;

/**
 * Servicios tal y como salen en la respuesta de creación: sin el secreto del
 * webhook de los servicios de repositorio (los listados ya lo omiten; aquí se
 * devolvía la fila entera).
 */
function publicServices(rows: ServiceRow[]): ServiceRow[] {
  return rows.map((s) => ({ ...s, config: publicServiceConfig(s.config) }));
}

/**
 * Ejecuta la creación de los servicios en una transacción. Devuelve el mensaje
 * para el usuario si chocó con un servicio que ya existía (dos peticiones a la
 * vez con el mismo prefijo: la comprobación previa del prefijo no es atómica),
 * y relanza cualquier otro fallo. La transacción deshace lo creado hasta ahí.
 */
function crearAtomico(fn: () => void): string | null {
  try {
    transaction(fn);
    return null;
  } catch (err) {
    const code = String((err as { code?: unknown } | null)?.code ?? '');
    if (code.startsWith('SQLITE_CONSTRAINT')) {
      return 'Ya existe un servicio con uno de esos nombres en el proyecto: utilice otro prefijo.';
    }
    throw err;
  }
}

const createSchema = z.object({
  stack: z.string().trim().min(1),
  /** Prefijo de los nombres de servicio (`<prefijo>-db`, `<prefijo>-kong`...). */
  prefix: z.string().trim().min(1).max(40).optional(),
  // El mismo validador que crear/editar servicio: el dominio acaba en la regla
  // Host() de Traefik y ahí no puede entrar texto libre.
  domain: domainSchema.optional(),
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

const templateSchema = z.object({
  template: z.string().trim().min(1, 'Indica la plantilla de Railway'),
  prefix: z.string().trim().min(1).max(40).optional(),
  domain: domainSchema.optional(),
});

export async function stackRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/stacks', async () => ({ stacks: stackList() }));

  /**
   * Vista previa de una plantilla del catálogo de Railway: qué servicios saldrían
   * y qué avisos hay. No crea nada, así que basta con estar autenticado.
   */
  app.post('/api/railway-templates/preview', { preHandler: rateLimit({ max: PREVIEWS_POR_MINUTO, windowMs: 60_000 }) }, async (req, reply) => {
    const body = z.object({ template: z.string().trim().min(1), prefix: z.string().trim().max(40).optional() }).parse(req.body);
    const code = parseTemplateCode(body.template);
    if (!code) return reply.code(400).send({ error: 'No se reconoce la plantilla: introduzca su URL de Railway o su código.' });
    const plan = await planRailwayTemplate(code, { prefix: body.prefix, projectName: '' });
    return {
      plan: {
        code: plan.code,
        name: plan.name,
        description: plan.description,
        prefix: plan.prefix,
        warnings: plan.warnings,
        services: plan.services.map((s) => ({
          templateName: s.templateName,
          slug: s.slug,
          kind: s.kind,
          image: s.image ?? s.repoUrl ?? '',
          port: s.port,
          public: s.public,
          stage: s.stage,
          varCount: Object.keys(s.env).length,
          volumes: s.volumes,
          notes: s.notes,
        })),
      },
    };
  });

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

    // Se comprueba ANTES de crear nada: descubrirlo a mitad dejaba media pila
    // en la base de datos y un 500.
    const plantillaRota = stack.services.find((s) => s.template && !getTemplate(s.template));
    if (plantillaRota) return reply.code(500).send({ error: `Plantilla desconocida: ${plantillaRota.template}` });

    const created: ServiceRow[] = [];
    const steps: StackStep[] = [];
    // Todo o nada: un choque de slug con una petición simultánea (la comprobación
    // de arriba no es atómica) o cualquier otro fallo a mitad no deja servicios
    // sueltos a los que nadie va a desplegar.
    const creacion = crearAtomico(() => {
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
          const template = getTemplate(def.template)!;
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

        created.push(service);
        steps.push({ serviceId: service.id, key: def.key, stage: def.stage, readyCmd: def.readyCmd });
      }
    });
    if (creacion) return reply.code(409).send({ error: creacion });
    // El monitor no debe interpretar los arranques de la pila como caídas.
    for (const service of created) markManualAction(service.id);

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
    return { stack: stack.key, prefix, publicUrl, services: publicServices(created) };
  });

  /**
   * Instala una plantilla de Railway DENTRO de este proyecto, traduciendo su
   * cableado. Mismas puertas que crear una pila del catálogo.
   */
  app.post('/api/projects/:projectId/railway-templates', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = getProject(projectId);
    if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    if (!assertProjectAccess(req, reply, projectId)) return reply;

    const body = templateSchema.parse(req.body);
    const code = parseTemplateCode(body.template);
    if (!code) return reply.code(400).send({ error: 'No se reconoce la plantilla: introduzca su URL de Railway o su código.' });

    const isAdmin = currentUser(req)!.role === 'admin';
    if (body.domain && !moduleAllowedForProject(projectId, 'domains', isAdmin)) {
      return reply.code(403).send({ error: 'El módulo «Dominios y TLS» no está activo en este workspace.' });
    }

    const plan = await planRailwayTemplate(code, { prefix: body.prefix, projectName: project.name });

    const workspace = workspaceOfProject(projectId);
    if (workspace) {
      if (!isWorkspaceActive(workspace)) {
        return reply.code(403).send({ error: 'El workspace está suspendido: no se pueden crear servicios.' });
      }
      const quota = effectiveQuota(workspace, workspacePlan(workspace));
      const used = countWorkspaceServices(workspace.id);
      if (used + plan.services.length > quota.maxServices) {
        return reply.code(409).send({
          error: `La plantilla «${plan.name}» son ${plan.services.length} servicios y el workspace tiene ${used} de ${quota.maxServices}. Un administrador puede ampliar la cuota.`,
        });
      }
    }

    // El prefijo se numera si algún nombre ya existe, igual que en las pilas.
    const finalPrefix = uniquePrefix(
      projectId,
      plan.prefix,
      plan.services.map((s) => s.slug.slice(plan.prefix.length + 1)),
    );
    if (finalPrefix !== plan.prefix) {
      for (const s of plan.services) {
        s.slug = `${finalPrefix}${s.slug.slice(plan.prefix.length)}`;
        s.name = s.slug;
      }
    }
    rewriteTemplateRefs(plan, { projectName: project.name, domain: body.domain ?? null });

    const created: ServiceRow[] = [];
    const steps: StackStep[] = [];
    // Atómico por lo mismo que en las pilas del catálogo: sin servicios a medias.
    const creacion = crearAtomico(() => {
      for (const svc of plan.services) {
        const domains = svc.public && body.domain ? [body.domain] : [];
        const volumes = svc.volumes.map((path, idx) => ({
          name: `skyway-${project.slug}__${finalPrefix}__${slugify(svc.templateName)}${idx === 0 ? '' : idx + 1}`,
          containerPath: path,
        }));
        const common = {
          domains,
          startCmd: svc.startCmd,
          healthcheckPath: svc.healthcheckPath,
          volumes: volumes.length ? volumes : undefined,
          stack: `railway:${plan.code}`,
        };
        const cfg =
          svc.kind === 'image'
            ? ({ ...common, image: svc.image!, port: svc.port ?? null } as ImageConfig & { stack?: string })
            : ({
                ...common,
                repoUrl: svc.repoUrl!,
                branch: 'main',
                rootDir: svc.rootDir,
                port: svc.port ?? 3000,
                webhookSecret: randomToken(16),
              } as GitConfig & { stack?: string });

        const service = createService(projectId, svc.name, svc.slug, svc.kind, cfg);
        setEnv(service.id, svc.env);
        created.push(service);
        steps.push({ serviceId: service.id, key: svc.templateName, stage: svc.stage, readyCmd: svc.readyCmd });
      }
    });
    if (creacion) return reply.code(409).send({ error: creacion });
    for (const service of created) markManualAction(service.id);

    audit(req, 'railway_template_imported', {
      type: 'project',
      id: projectId,
      detail: `${plan.name} (${plan.code}) → ${created.length} servicios`,
    });

    void runStackDeploy({ key: `railway:${plan.code}`, label: plan.name }, steps).catch((err) => {
      req.log.error({ err, template: plan.code }, 'fallo desplegando la plantilla de Railway');
    });

    reply.code(201);
    return {
      template: plan.code,
      name: plan.name,
      prefix: finalPrefix,
      warnings: plan.warnings,
      services: publicServices(created),
      notes: plan.services.flatMap((s) => s.notes.map((n) => `${s.templateName}: ${n}`)),
    };
  });
}
