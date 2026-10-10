/**
 * Rutas del asistente «Cambiar de dominio» de un proyecto
 * (`domainmigration.ts`). Cambiar los dominios, las variables y el correo de
 * todo un proyecto es una decisión de estructura: solo la administración o el
 * propietario del workspace (`assertProjectManage`), como renombrar o borrar
 * el proyecto. Las respuestas de error son `{error, code}`.
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertProjectAccess, assertProjectManage, currentUser, requireAuth } from '../auth';
import {
  actualizarPersona,
  calcularPlan,
  cambiarModoHost,
  cambiarMx,
  cambioDelProyecto,
  cancelarCambio,
  comprobarCambio,
  darDeBajaCambio,
  ErrorCambio,
  ficheroDeZona,
  listarCambios,
  pasarCambio,
  prepararCambio,
  quitarRedirecciones,
  reintentarServicio,
  terminarCambio,
  vistaMigracion,
  volverCambio,
} from '../domainmigration';
import { getProject } from '../db';
import { MailwayError } from '../mailway';
import { rateLimit } from '../ratelimit';
import { ProjectRow } from '../types';
import { domainSchema } from './services';

const hostSchema = z.object({
  serviceId: z.string().trim().min(1).max(100),
  from: domainSchema,
  to: domainSchema,
  modo: z.enum(['redirigir', 'servir', 'no_cambiar']),
});

const claveSchema = z.object({
  ambito: z.enum(['service', 'project', 'build']),
  serviceId: z.string().trim().min(1).max(100).nullable(),
  key: z.string().trim().min(1).max(200),
});

const planSchema = z.object({
  fromDomain: domainSchema,
  toDomain: domainSchema,
  soloWeb: z.boolean().optional().default(false),
  hosts: z.array(hostSchema).max(200).optional(),
  excluidas: z.array(claveSchema).max(500).optional(),
});

const crearSchema = planSchema.extend({
  hosts: z.array(hostSchema).max(200),
  excluidas: z.array(claveSchema).max(500).default([]),
  expect: z.string().trim().min(1, 'Falta la huella del plan revisado.').max(200),
});

const pasarSchema = z.object({ expect: z.string().trim().min(1, 'Falta la huella del plan revisado.').max(200) });
const modoHostSchema = z.object({
  serviceId: z.string().trim().min(1).max(100),
  from: domainSchema,
  modo: z.enum(['servir', 'redirigir']),
});
const confirmSchema = z.object({ confirm: z.string().max(300) });

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/**
 * Código con el que se contesta un fallo de Mailway: sus 400, 404, 409, 429 y
 * 503 (`dns_unknown`) describen la petición y se trasladan con su código (la
 * interfaz enseña su mensaje tal cual, p. ej. `migration_new_mx_here`); el
 * resto es un fallo del servicio remoto (502). Nunca 401: la interfaz lo
 * tomaría por una sesión caducada.
 */
function statusMailway(err: MailwayError): number {
  if (err.kind === 'config') return 409;
  if (err.kind === 'http' && err.status !== null) {
    if ([400, 404, 409, 429, 503].includes(err.status)) return err.status;
    if (err.status === 422) return 400;
  }
  return 502;
}

function mensajeMailway(err: MailwayError): string {
  if (err.kind === 'http' && err.status === 403) {
    return `Mailway ha denegado la operación: ${err.message} Comprueba que el token de gestión configurado en Skyway es de administrador.`;
  }
  return err.message;
}

/** Traduce los errores con código (los del asistente y los de Mailway) a `{error, code}`. */
function guardado(fn: Handler): Handler {
  return async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (err) {
      if (err instanceof ErrorCambio) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      if (err instanceof MailwayError) {
        const status = statusMailway(err);
        if (status >= 500 && status !== 503) req.log.warn({ kind: err.kind, status: err.status }, `Mailway: ${err.message}`);
        return reply.code(status).send({ error: mensajeMailway(err), code: err.code ?? 'mailway_error' });
      }
      throw err;
    }
  };
}

/** Código estable de los errores que no lo traen (los de las guardas, zod, el límite de peticiones). */
function codigoPorEstado(status: number): string {
  if (status === 400) return 'invalid_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status === 502) return 'mailway_error';
  if (status === 503) return 'unavailable';
  return status >= 500 ? 'internal_error' : 'request_error';
}

/**
 * Las respuestas de error de estas rutas son siempre `{error, code}`. Las de
 * las guardas comunes (`requireAuth`, `assertProjectAccess`,
 * `assertProjectManage`), las de zod (manejador global) y las del límite de
 * peticiones solo traen `error`: se completan aquí con un código por estado,
 * sin cambiarlas en el resto de la API.
 */
function conCodigo(statusCode: number, payload: unknown): unknown {
  if (statusCode < 400 || typeof payload !== 'string') return payload;
  try {
    const body = JSON.parse(payload) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return payload;
    const obj = body as Record<string, unknown>;
    if (typeof obj.error !== 'string' || typeof obj.code === 'string') return payload;
    return JSON.stringify({ ...obj, code: codigoPorEstado(statusCode) });
  } catch {
    return payload;
  }
}

/** El proyecto de la ruta, si quien pide puede gestionarlo; si no, ya ha respondido y devuelve null. */
function proyecto(req: FastifyRequest, reply: FastifyReply): ProjectRow | null {
  const { id } = req.params as { id: string };
  const project = getProject(id);
  if (!project) {
    reply.code(404).send({ error: 'Proyecto no encontrado', code: 'not_found' });
    return null;
  }
  if (!assertProjectAccess(req, reply, id)) return null;
  if (!assertProjectManage(req, reply, id)) return null;
  return project;
}

const esAdmin = (req: FastifyRequest) => currentUser(req)?.role === 'admin';

export async function domainMigrationRoutes(app: FastifyInstance): Promise<void> {
  app.register(async (r) => {
    r.addHook('onSend', async (_req, reply, payload) => conCodigo(reply.statusCode, payload));
    r.addHook('preHandler', requireAuth);

    /** Vista previa: mapa de nombres, correo de Mailway y variables, con su huella. Sin efectos. */
    r.post(
      '/api/projects/:id/domain-migrations/plan',
      { preHandler: rateLimit({ max: 30, windowMs: 60_000 }) },
      guardado(async (req, reply) => {
        const project = proyecto(req, reply);
        if (!project) return reply;
        const body = planSchema.parse(req.body ?? {});
        return (await calcularPlan(req, project, body)).plan;
      }),
    );

    /** Preparar: 201 con el cambio (o 200 si ya estaba abierto con el mismo origen y destino). */
    r.post(
      '/api/projects/:id/domain-migrations',
      { preHandler: rateLimit({ max: 10, windowMs: 60_000 }) },
      guardado(async (req, reply) => {
        const project = proyecto(req, reply);
        if (!project) return reply;
        const body = crearSchema.parse(req.body ?? {});
        const { status, vista, dns } = await prepararCambio(req, project, body);
        reply.code(status);
        return { ...vista, ...(dns ? { dns } : {}) };
      }),
    );

    /** El cambio abierto y los últimos cerrados. `?ligera=1`: sin consultar a Mailway (el aviso de la página del proyecto). */
    r.get(
      '/api/projects/:id/domain-migrations',
      guardado(async (req, reply) => {
        const project = proyecto(req, reply);
        if (!project) return reply;
        const { ligera } = z.object({ ligera: z.enum(['0', '1']).optional() }).parse(req.query ?? {});
        return listarCambios(project, esAdmin(req), { ligera: ligera === '1' });
      }),
    );

    r.get(
      '/api/projects/:id/domain-migrations/:mid',
      guardado(async (req, reply) => {
        const project = proyecto(req, reply);
        if (!project) return reply;
        const { mid } = req.params as { mid: string };
        return vistaMigracion(cambioDelProyecto(project, mid), esAdmin(req));
      }),
    );

    /** Volver a medir el DNS, los certificados y el correo (el asistente lo llama cada 30 s). */
    r.post(
      '/api/projects/:id/domain-migrations/:mid/check',
      { preHandler: rateLimit({ max: 60, windowMs: 60_000 }) },
      guardado(async (req, reply) => {
        const project = proyecto(req, reply);
        if (!project) return reply;
        const { mid } = req.params as { mid: string };
        return comprobarCambio(project, mid, esAdmin(req));
      }),
    );

    /** Cambiar el MX del dominio nuevo a este servidor en su zona de Cloudflare (recibía en otro proveedor). */
    r.post(
      '/api/projects/:id/domain-migrations/:mid/mx',
      { preHandler: rateLimit({ max: 10, windowMs: 60_000 }) },
      guardado(async (req, reply) => {
        const project = proyecto(req, reply);
        if (!project) return reply;
        const { mid } = req.params as { mid: string };
        return cambiarMx(req, project, mid);
      }),
    );

    /**
     * «Servir también» un nombre que redirige (o volver a redirigirlo antes de
     * pasar): 202 si se ha vuelto a desplegar el servicio (tras pasar), 200 si no.
     */
    r.post(
      '/api/projects/:id/domain-migrations/:mid/hosts/mode',
      { preHandler: rateLimit({ max: 20, windowMs: 60_000 }) },
      guardado(async (req, reply) => {
        const project = proyecto(req, reply);
        if (!project) return reply;
        const { mid } = req.params as { mid: string };
        const body = modoHostSchema.parse(req.body ?? {});
        const { vista, desplegado } = await cambiarModoHost(req, project, mid, body);
        reply.code(desplegado ? 202 : 200);
        return vista;
      }),
    );

    r.post(
      '/api/projects/:id/domain-migrations/:mid/switch',
      guardado(async (req, reply) => {
        const project = proyecto(req, reply);
        if (!project) return reply;
        const { mid } = req.params as { mid: string };
        const { expect } = pasarSchema.parse(req.body ?? {});
        const vista = await pasarCambio(req, project, mid, expect);
        reply.code(202);
        return vista;
      }),
    );

    r.post(
      '/api/projects/:id/domain-migrations/:mid/rollback',
      guardado(async (req, reply) => {
        const project = proyecto(req, reply);
        if (!project) return reply;
        const { mid } = req.params as { mid: string };
        const vista = await volverCambio(req, project, mid);
        reply.code(202);
        return vista;
      }),
    );

    r.post(
      '/api/projects/:id/domain-migrations/:mid/cancel',
      guardado(async (req, reply) => {
        const project = proyecto(req, reply);
        if (!project) return reply;
        const { mid } = req.params as { mid: string };
        return cancelarCambio(req, project, mid);
      }),
    );

    r.post(
      '/api/projects/:id/domain-migrations/:mid/retire',
      guardado(async (req, reply) => {
        const project = proyecto(req, reply);
        if (!project) return reply;
        const { mid } = req.params as { mid: string };
        const { confirm } = confirmSchema.parse(req.body ?? {});
        const vista = await darDeBajaCambio(req, project, mid, confirm);
        reply.code(202);
        return vista;
      }),
    );

    r.post(
      '/api/projects/:id/domain-migrations/:mid/finish',
      guardado(async (req, reply) => {
        const project = proyecto(req, reply);
        if (!project) return reply;
        const { mid } = req.params as { mid: string };
        const { confirm } = confirmSchema.parse(req.body ?? {});
        return terminarCambio(req, project, mid, confirm);
      }),
    );

    r.post(
      '/api/projects/:id/domain-migrations/:mid/redirects/remove',
      guardado(async (req, reply) => {
        const project = proyecto(req, reply);
        if (!project) return reply;
        const { mid } = req.params as { mid: string };
        const { confirm } = confirmSchema.parse(req.body ?? {});
        return quitarRedirecciones(req, project, mid, confirm);
      }),
    );

    r.post(
      '/api/projects/:id/domain-migrations/:mid/services/:sid/retry',
      guardado(async (req, reply) => {
        const project = proyecto(req, reply);
        if (!project) return reply;
        const { mid, sid } = req.params as { mid: string; sid: string };
        const vista = await reintentarServicio(req, project, mid, sid);
        reply.code(202);
        return vista;
      }),
    );

    r.post(
      '/api/projects/:id/domain-migrations/:mid/mailboxes/:mbid/login-update',
      guardado(async (req, reply) => {
        const project = proyecto(req, reply);
        if (!project) return reply;
        const { mid, mbid } = req.params as { mid: string; mbid: string };
        return actualizarPersona(req, project, mid, mbid);
      }),
    );

    /** Registros DNS del dominio nuevo (correo de Mailway y A de la web) en un fichero de zona. */
    r.get(
      '/api/projects/:id/domain-migrations/:mid/zonefile',
      { preHandler: rateLimit({ max: 20, windowMs: 60_000 }) },
      guardado(async (req, reply) => {
        const project = proyecto(req, reply);
        if (!project) return reply;
        const { mid } = req.params as { mid: string };
        const { nombre, texto } = await ficheroDeZona(project, mid, esAdmin(req));
        return reply
          .type('text/plain; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="${nombre}"`)
          .send(texto);
      }),
    );
  });
}
