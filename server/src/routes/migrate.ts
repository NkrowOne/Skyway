import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertProjectManage, requireAuth } from '../auth';
import { audit } from '../audit';
import {
  cancelDataMigration,
  getDataMigration,
  migrationSupported,
  onDataMigration,
  probeSource,
  startDataMigration,
} from '../datamigrate';
import { getProject, getService } from '../db';
import { sseInit } from '../sse';
import { DatabaseConfig } from '../types';

/**
 * Copia de datos desde una base externa (típicamente la de Railway) a una base
 * gestionada de Skyway. Es el último paso de una migración y el único que hasta
 * ahora obligaba a entrar por SSH.
 *
 * Requiere GESTIÓN del proyecto, no solo acceso: lanza un contenedor con
 * credenciales y se conecta a un servidor que indica quien llama.
 */
export async function migrateRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  const load = (id: string) => {
    const service = getService(id);
    if (!service) return null;
    const project = getProject(service.project_id);
    if (!project) return null;
    return { service, project };
  };

  /** Estado de la copia: si el motor lo admite y qué hay en marcha. */
  app.get('/api/services/:id/data-migration', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = load(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectManage(req, reply, found.project.id)) return reply;
    const template = found.service.type === 'database' ? (found.service.config as DatabaseConfig).template : null;
    return {
      supported: !!template && migrationSupported(template),
      template,
      migration: getDataMigration(id) ?? null,
    };
  });

  /** Comprobación previa: ¿responde el origen con esas credenciales? */
  app.post('/api/services/:id/data-migration/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = load(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectManage(req, reply, found.project.id)) return reply;
    const body = z.object({ sourceUrl: z.string().trim().min(8, 'URL de origen requerida') }).parse(req.body);
    try {
      const problem = await probeSource(found.service, found.project, body.sourceUrl);
      return problem ? { ok: false, error: problem } : { ok: true };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message || 'No se pudo comprobar el origen' });
    }
  });

  app.post('/api/services/:id/data-migration', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = load(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectManage(req, reply, found.project.id)) return reply;
    const body = z.object({ sourceUrl: z.string().trim().min(8, 'URL de origen requerida') }).parse(req.body);
    try {
      const migration = startDataMigration(found.service, found.project, body.sourceUrl);
      // La URL lleva credenciales del origen: en la auditoría solo el servidor.
      let host = 'origen externo';
      try {
        host = new URL(body.sourceUrl.trim()).host;
      } catch {
        /* ya validada en startDataMigration */
      }
      audit(req, 'data_migration_started', { type: 'service', id, detail: `${found.service.name} ← ${host}` });
      reply.code(202);
      return { migration };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message || 'No se pudo iniciar la copia' });
    }
  });

  app.post('/api/services/:id/data-migration/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = load(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectManage(req, reply, found.project.id)) return reply;
    if (!cancelDataMigration(id)) return reply.code(409).send({ error: 'No hay ninguna copia en marcha' });
    audit(req, 'data_migration_canceled', { type: 'service', id, detail: found.service.name });
    return { ok: true };
  });

  /** Log de la copia en vivo (SSE), con el histórico ya emitido al conectar. */
  app.get('/api/services/:id/data-migration/stream', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = load(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectManage(req, reply, found.project.id)) return reply;

    const channel = sseInit(reply);
    const unsubscribe = onDataMigration(id, (ev) => {
      if (ev.type === 'log') channel.send('log', { line: ev.line });
      else {
        channel.send('done', { status: ev.status });
        setTimeout(() => channel.close(), 100);
      }
    });
    channel.onClose(unsubscribe);

    const current = getDataMigration(id);
    channel.send('snapshot', { logs: current?.logs ?? '', status: current?.status ?? null });
    if (current && current.status !== 'running') {
      channel.send('done', { status: current.status });
      setTimeout(() => channel.close(), 100);
    }
  });
}
