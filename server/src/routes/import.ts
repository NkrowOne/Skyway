import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertProjectAccess, requireAdmin, requireAuth } from '../auth';
import { audit } from '../audit';
import { getProject, getSetting, setSetting } from '../db';
import { listRailwayProjects } from '../railway/client';
import { analyzeRailwayProject, runRailwayImport } from '../railway/importer';

const tokenSchema = z.string().trim().min(10, 'Token de Railway requerido');

/**
 * Importación desde Railway. El token viaja en el cuerpo de cada petición,
 * se usa en memoria y NO se guarda en ningún sitio (ni en la auditoría).
 */
export async function importRoutes(app: FastifyInstance): Promise<void> {
  // El informe de importación de un proyecto lo ve quien tiene acceso al workspace.
  app.register(async (scoped) => {
    scoped.addHook('preHandler', requireAuth);

    scoped.get('/api/projects/:id/import-report', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!getProject(id)) return reply.code(404).send({ error: 'Proyecto no encontrado' });
      if (!assertProjectAccess(req, reply, id)) return reply;
      const raw = getSetting(`importReport:${id}`);
      return { report: raw ? JSON.parse(raw) : null };
    });

    scoped.delete('/api/projects/:id/import-report', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!getProject(id)) return reply.code(404).send({ error: 'Proyecto no encontrado' });
      if (!assertProjectAccess(req, reply, id)) return reply;
      setSetting(`importReport:${id}`, null);
      return { ok: true };
    });
  });

  // Importar de Railway crea proyectos y toca credenciales: solo administradores.
  // Scope propio para que requireAdmin no se filtre al scope del informe de arriba.
  app.register(async (admin) => {
    admin.addHook('preHandler', requireAdmin);

    admin.post('/api/import/railway/projects', async (req) => {
      const body = z.object({ token: tokenSchema }).parse(req.body);
      const projects = await listRailwayProjects(body.token);
      return { projects };
    });

    admin.post('/api/import/railway/analyze', async (req) => {
      const body = z
        .object({
          token: tokenSchema,
          projectId: z.string().trim().min(1, 'ID de proyecto requerido'),
          environmentId: z.string().trim().optional(),
        })
        .parse(req.body);
      const plan = await analyzeRailwayProject(body.token, body.projectId, body.environmentId);
      // No exponemos los valores de las variables en la vista previa.
      const { _sharedVars, ...safePlan } = plan;
      return {
        plan: { ...safePlan, services: plan.services.map(({ _vars, ...s }) => s) },
      };
    });

    admin.post('/api/import/railway/run', async (req, reply) => {
      const body = z
        .object({
          token: tokenSchema,
          projectId: z.string().trim().min(1),
          environmentId: z.string().trim().min(1, 'Elige un entorno'),
          projectName: z.string().trim().max(60).optional(),
          client: z.string().trim().max(60).optional(),
        })
        .parse(req.body);
      const { project, report } = await runRailwayImport(body.token, body.projectId, body.environmentId, {
        projectName: body.projectName,
        client: body.client ?? null,
      });
      audit(req, 'railway_import', {
        type: 'project',
        id: project.id,
        detail: `${report.railwayProject} (${report.environment}) → ${report.created.length} servicios`,
      });
      reply.code(201);
      return { project, report };
    });
  });
}
