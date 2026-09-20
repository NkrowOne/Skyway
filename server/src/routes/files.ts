import { FastifyInstance, FastifyReply } from 'fastify';
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

/** Códigos de error de sistema con los que falla el socket de Docker. */
const SOCKET_ERROR = /\b(ECONNREFUSED|ECONNRESET|ENOENT|ENOTFOUND|ETIMEDOUT|EPIPE|EACCES|EAI_AGAIN)\b/;

/**
 * Traduce un fallo del explorador a un código HTTP honesto. El módulo `files`
 * lanza `Error` llanos con mensajes para el usuario (ruta inválida, contenedor
 * parado, límite de tamaño…): eso es un 400. Pero antes TODO salía como 400,
 * también un socket de Docker caído o un error del daemon, y la UI (y los
 * agentes que usan la API) los tomaban por un error de uso que reintentar no
 * arregla. Los del socket van como 503 y los del daemon como 500.
 */
function sendFileError(reply: FastifyReply, err: unknown, fallback: string): FastifyReply {
  const e = err as { code?: unknown; statusCode?: unknown; message?: unknown } | null;
  const message = typeof e?.message === 'string' && e.message ? e.message : fallback;
  // dockerode marca el fallo de red en `code`; `files.ts` a veces lo reenvuelve
  // en un Error nuevo y solo queda el código dentro del mensaje.
  if ((typeof e?.code === 'string' && SOCKET_ERROR.test(e.code)) || SOCKET_ERROR.test(message)) {
    return reply.code(503).send({ error: 'Docker no responde en este momento. Vuelva a intentarlo en unos segundos.' });
  }
  // Respuesta de error del propio daemon (statusCode de la API de Docker).
  if (typeof e?.statusCode === 'number') return reply.code(500).send({ error: message });
  return reply.code(err instanceof Error ? 400 : 500).send({ error: message });
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
      } catch (err) {
        return sendFileError(reply, err, 'No se pudo listar el directorio');
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
      } catch (err) {
        return sendFileError(reply, err, 'No se pudo descargar el archivo');
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
      } catch (err) {
        return sendFileError(reply, err, 'No se pudo crear el directorio');
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
      } catch (err) {
        return sendFileError(reply, err, 'No se pudo borrar');
      }
    });
  });

  // La subida acepta binario crudo (octet-stream) en un scope propio con su
  // límite de cuerpo ampliado, sin tocar el límite global de 1 MB del resto.
  app.register(async (upload) => {
    upload.addHook('preHandler', requireAuth);
    // Mismo módulo que el resto del explorador: al vivir en otro scope no
    // heredaba la gate y se podía subir con el módulo 'files' desactivado.
    upload.addHook('preHandler', moduleGate('files'));
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
      } catch (err) {
        return sendFileError(reply, err, 'No se pudo subir el archivo');
      }
    });
  });
}
