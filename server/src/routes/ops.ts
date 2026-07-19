import fs from 'fs';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertProjectAccess, requireAuth } from '../auth';
import { audit } from '../audit';
import {
  backupSupported,
  createBackup,
  deleteBackup,
  listBackups,
  resolveBackupFile,
  restoreBackup,
} from '../backups';
import { getProject, getService } from '../db';
import { dockerAvailable } from '../docker/client';
import { containerName, execInContainer, getRuntime } from '../docker/containers';
import { ProjectRow, ServiceRow } from '../types';

function load(id: string): { service: ServiceRow; project: ProjectRow } | null {
  const service = getService(id);
  if (!service) return null;
  const project = getProject(service.project_id);
  if (!project) return null;
  return { service, project };
}

export async function opsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Ejecuta un comando dentro del contenedor del servicio (migraciones, etc.). */
  app.post('/api/services/:id/exec', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = load(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
    if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });

    const body = z.object({ command: z.string().trim().min(1, 'Comando requerido').max(2000) }).parse(req.body);
    const name = containerName(found.project, found.service);
    const runtime = await getRuntime(name);
    if (runtime.state !== 'running') {
      return reply.code(409).send({ error: 'El servicio no está en ejecución' });
    }

    audit(req, 'service_exec', { type: 'service', id, detail: `${found.service.name}: ${body.command.slice(0, 120)}` });
    try {
      const result = await execInContainer(name, body.command, { timeoutMs: 60_000 });
      return { result };
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message || 'No se pudo ejecutar el comando' });
    }
  });

  // ---------- backups de bases de datos ----------
  app.get('/api/services/:id/backups', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = load(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
    return { supported: backupSupported(found.service), backups: listBackups(id) };
  });

  app.post('/api/services/:id/backups', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = load(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
    if (!backupSupported(found.service)) {
      return reply.code(400).send({ error: 'Este servicio no soporta backups' });
    }
    if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });
    try {
      const entry = await createBackup(found.project, found.service);
      audit(req, 'backup_created', { type: 'service', id, detail: `${found.service.name}: ${entry.file}` });
      reply.code(201);
      return { backup: entry };
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message || 'No se pudo crear el backup' });
    }
  });

  app.get('/api/services/:id/backups/:file/download', async (req, reply) => {
    const { id, file } = req.params as { id: string; file: string };
    if (!load(id)) return reply.code(404).send({ error: 'Servicio no encontrado' });
    const full = resolveBackupFile(id, file);
    if (!full) return reply.code(404).send({ error: 'Backup no encontrado' });
    audit(req, 'backup_downloaded', { type: 'service', id, detail: file });
    reply.header('Content-Disposition', `attachment; filename="${file}"`);
    reply.type('application/gzip');
    return reply.send(fs.createReadStream(full));
  });

  app.post('/api/services/:id/backups/:file/restore', async (req, reply) => {
    const { id, file } = req.params as { id: string; file: string };
    const found = load(id);
    if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!assertProjectAccess(req, reply, found.project.id)) return reply;
    const body = z.object({ confirm: z.literal(true) }).parse(req.body);
    void body;
    if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });
    try {
      await restoreBackup(found.project, found.service, file);
      audit(req, 'backup_restored', { type: 'service', id, detail: `${found.service.name}: ${file}` });
      return { ok: true };
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message || 'No se pudo restaurar el backup' });
    }
  });

  app.delete('/api/services/:id/backups/:file', async (req, reply) => {
    const { id, file } = req.params as { id: string; file: string };
    if (!load(id)) return reply.code(404).send({ error: 'Servicio no encontrado' });
    if (!deleteBackup(id, file)) return reply.code(404).send({ error: 'Backup no encontrado' });
    audit(req, 'backup_deleted', { type: 'service', id, detail: file });
    return { ok: true };
  });
}
