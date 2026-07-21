import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertProjectAccess, requireAuth } from '../auth';
import { audit } from '../audit';
import { dbConsoleEngine, dbSnippets, getDbBrowseQuery, getDbOverview, runDbQuery } from '../dbconsole';
import { getProject, getService } from '../db';
import { dockerAvailable } from '../docker/client';
import { ProjectRow, ServiceRow } from '../types';

function load(id: string): { service: ServiceRow; project: ProjectRow } | null {
  const service = getService(id);
  if (!service) return null;
  const project = getProject(service.project_id);
  if (!project) return null;
  return { service, project };
}

/** Consola de consultas de bases de datos: explorador, snippets y ejecución. */
export async function dbConsoleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/services/:id/db/overview', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = load(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
    const engine = dbConsoleEngine(found.service);
    if (!engine) return reply.code(400).send({ error: 'Este servicio no tiene consola de consultas' });
    if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });
    try {
      const overview = await getDbOverview(found.project, found.service);
      return { overview, snippets: dbSnippets(engine) };
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message || 'No se pudo leer el esquema' });
    }
  });

  app.post('/api/services/:id/db/query', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = load(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
    if (!dbConsoleEngine(found.service)) {
      return reply.code(400).send({ error: 'Este servicio no tiene consola de consultas' });
    }
    if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });

    const body = z
      .object({
        query: z.string().trim().min(1, 'Consulta requerida').max(10_000, 'Consulta demasiado larga'),
        allowWrite: z.boolean().default(false),
      })
      .parse(req.body);

    audit(req, 'db_query', {
      type: 'service',
      id,
      detail: `${found.service.name}${body.allowWrite ? ' [escritura]' : ''}: ${body.query.slice(0, 120)}`,
    });
    try {
      const result = await runDbQuery(found.project, found.service, body.query, body.allowWrite);
      return { result };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message || 'La consulta falló' });
    }
  });

  /** Consulta sugerida para un objeto del explorador (tabla, colección, clave). */
  app.get('/api/services/:id/db/browse-query', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = load(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
    if (!dbConsoleEngine(found.service)) {
      return reply.code(400).send({ error: 'Este servicio no tiene consola de consultas' });
    }
    if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });
    const params = z
      .object({
        object: z.string().min(1, 'Falta el parámetro object').max(500),
        mode: z.enum(['data', 'describe']).default('data'),
      })
      .parse(req.query);
    try {
      const query = await getDbBrowseQuery(found.project, found.service, params.object, params.mode);
      return { query };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message || 'No se pudo generar la consulta' });
    }
  });
}
