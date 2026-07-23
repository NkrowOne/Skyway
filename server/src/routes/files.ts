import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertProjectAccess, moduleGate, requireAuth } from '../auth';
import { audit } from '../audit';
import { getProject, getService } from '../db';
import { dockerAvailable } from '../docker/client';
import {
  MAX_UPLOAD_BYTES,
  deletePath,
  downloadFile,
  listDir,
  makeDir,
  uploadFile,
} from '../files';
import { ProjectRow, ServiceRow } from '../types';

function load(id: string): { service: ServiceRow; project: ProjectRow } | null {
  const service = getService(id);
  if (!service) return null;
  const project = getProject(service.project_id);
  if (!project) return null;
  return { service, project };
}

/** Deja un nombre de fichero seguro para la cabecera Content-Disposition. */
function safeHeaderName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'archivo';
}

/**
 * Explorador de archivos por servicio (estilo gestor FTP), sobre el socket de
 * Docker: sin puertos ni credenciales de FTP. Requiere sesión y acceso al
 * workspace, y cada acción de escritura queda en la auditoría.
 */
export async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.register(async (scope) => {
    scope.addHook('preHandler', requireAuth);
    // El explorador de archivos requiere el módulo 'files' activo en el workspace.
    scope.addHook('preHandler', moduleGate('files'));

    /** Lista un directorio del contenedor. */
    scope.get('/api/services/:id/files', async (req, reply) => {
      const { id } = req.params as { id: string };
      const found = load(id);
      if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
      if (!assertProjectAccess(req, reply, found.project.id)) return reply;
      if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });
      const query = z.object({ path: z.string().max(4096).optional() }).parse(req.query);
      try {
        return { listing: await listDir(found.project, found.service, query.path ?? '/') };
      } catch (err: any) {
        return reply.code(400).send({ error: err?.message || 'No se pudo listar el directorio' });
      }
    });

    /** Descarga un archivo del contenedor. */
    scope.get('/api/services/:id/files/download', async (req, reply) => {
      const { id } = req.params as { id: string };
      const found = load(id);
      if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
      if (!assertProjectAccess(req, reply, found.project.id)) return reply;
      if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });
      const query = z.object({ path: z.string().min(1).max(4096) }).parse(req.query);
      try {
        const file = await downloadFile(found.project, found.service, query.path);
        audit(req, 'file_downloaded', { type: 'service', id, detail: `${found.service.name}: ${query.path}` });
        reply.header('Content-Disposition', `attachment; filename="${safeHeaderName(file.name)}"`);
        reply.type('application/octet-stream');
        return reply.send(file.content);
      } catch (err: any) {
        return reply.code(400).send({ error: err?.message || 'No se pudo descargar el archivo' });
      }
    });

    /** Crea un directorio. */
    scope.post('/api/services/:id/files/mkdir', async (req, reply) => {
      const { id } = req.params as { id: string };
      const found = load(id);
      if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
      if (!assertProjectAccess(req, reply, found.project.id)) return reply;
      if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });
      const body = z.object({ path: z.string().min(1).max(4096) }).parse(req.body);
      try {
        await makeDir(found.project, found.service, body.path);
        audit(req, 'file_mkdir', { type: 'service', id, detail: `${found.service.name}: ${body.path}` });
        return { ok: true };
      } catch (err: any) {
        return reply.code(400).send({ error: err?.message || 'No se pudo crear el directorio' });
      }
    });

    /** Borra un archivo o directorio. */
    scope.post('/api/services/:id/files/delete', async (req, reply) => {
      const { id } = req.params as { id: string };
      const found = load(id);
      if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
      if (!assertProjectAccess(req, reply, found.project.id)) return reply;
      if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });
      const body = z.object({ path: z.string().min(1).max(4096), recursive: z.boolean().default(false) }).parse(req.body);
      try {
        await deletePath(found.project, found.service, body.path, body.recursive);
        audit(req, 'file_deleted', { type: 'service', id, detail: `${found.service.name}: ${body.path}${body.recursive ? ' (recursivo)' : ''}` });
        return { ok: true };
      } catch (err: any) {
        return reply.code(400).send({ error: err?.message || 'No se pudo borrar' });
      }
    });
  });

  // La subida acepta binario crudo (octet-stream) en un scope propio con su
  // límite de cuerpo ampliado, sin tocar el límite global de 1 MB del resto.
  app.register(async (upload) => {
    upload.addHook('preHandler', requireAuth);
    upload.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
      (_req, body, done) => done(null, body),
    );

    upload.post('/api/services/:id/files/upload', { bodyLimit: MAX_UPLOAD_BYTES }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const found = load(id);
      if (!found) return reply.code(404).send({ error: 'Servicio no encontrado' });
      if (!assertProjectAccess(req, reply, found.project.id)) return reply;
      if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });
      const query = z
        .object({ path: z.string().min(1).max(4096), name: z.string().min(1).max(255) })
        .parse(req.query);
      const content = req.body;
      if (!Buffer.isBuffer(content) || content.length === 0) {
        return reply.code(400).send({ error: 'Cuerpo vacío: adjunta el contenido del archivo' });
      }
      try {
        await uploadFile(found.project, found.service, query.path, query.name, content);
        audit(req, 'file_uploaded', {
          type: 'service',
          id,
          detail: `${found.service.name}: ${query.path}/${query.name} (${content.length} bytes)`,
        });
        reply.code(201);
        return { ok: true };
      } catch (err: any) {
        return reply.code(400).send({ error: err?.message || 'No se pudo subir el archivo' });
      }
    });
  });
}
