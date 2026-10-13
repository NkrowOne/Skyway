import fs from 'fs';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireAdmin, requireAuth, requireSession } from '../auth';
import { audit } from '../audit';
import {
  RE_EJECUCION,
  RE_PROYECTO,
  abrirZipKit,
  eliminarKit,
  escribirPeticion,
  hayFicheroKit,
  kitEnPreparacion,
  leerKitCopias,
  PeticionCopias,
  situacionCopias,
} from '../copiasexternas';
import { getProject, listProjects } from '../db';

const MENSAJE_PROYECTO = 'El identificador del proyecto no es válido.';
const MENSAJE_EJECUCION = 'La ejecución debe tener el formato AAAAMMDD-HHMMSS.';

/**
 * Cuerpo de una petición al host. Estricto: un campo que no aplica a la acción
 * (un alcance en una copia, un proyecto en un kit completo) se rechaza en vez
 * de ignorarse, para que nadie crea haber pedido algo que el host no hará.
 */
const peticionSchema = z.discriminatedUnion(
  'accion',
  [
    z.object({ accion: z.literal('copia') }).strict('Una copia no admite más datos que la acción.'),
    z.object({ accion: z.literal('comprobar') }).strict('Una comprobación no admite más datos que la acción.'),
    z
      .object({
        accion: z.literal('kit'),
        alcance: z.enum(['todo', 'skyway', 'correo', 'proyecto'], {
          errorMap: () => ({ message: 'Indica el alcance del kit: «todo», «skyway», «correo» o «proyecto».' }),
        }),
        proyecto: z
          .string({ invalid_type_error: MENSAJE_PROYECTO })
          .regex(RE_PROYECTO, MENSAJE_PROYECTO)
          .optional(),
        ejecucion: z
          .string({ invalid_type_error: MENSAJE_EJECUCION })
          .regex(RE_EJECUCION, MENSAJE_EJECUCION)
          .optional(),
      })
      .strict('El kit solo admite el alcance, el proyecto y la ejecución.'),
  ],
  { errorMap: () => ({ message: 'Indica la acción: «copia», «comprobar» o «kit».' }) },
);

const ACCION_EN_CURSO: Record<string, string> = {
  copia: 'una copia',
  comprobar: 'una comprobación',
  kit: 'la preparación de un kit',
  restaurar: 'una restauración',
  mantenimiento: 'un mantenimiento',
};

/**
 * Ajustes → Copias externas. El panel lee lo que escribe el host en
 * `<DATA_DIR>/copias/` y le deja peticiones; nunca ejecuta nada en el
 * servidor (ver `copiasexternas.ts`). Todo es del administrador; descargar el
 * kit exige además sesión de navegador, como la copia del panel: lleva cifrados
 * los datos de todo el servidor.
 */
export async function copiasExternasRoutes(app: FastifyInstance): Promise<void> {
  app.register(async (secured) => {
    secured.addHook('preHandler', requireAuth);

    secured.get('/api/system/copias-externas', { preHandler: requireAdmin }, async () => {
      const situacion = situacionCopias();
      // Un kit por proyecto solo se puede pedir de un proyecto que siga en el panel.
      const enPanel = new Set(listProjects().map((p) => p.id));
      return {
        ...situacion,
        ejecuciones:
          situacion.ejecuciones?.map((e) => ({
            ...e,
            proyectos: e.proyectos.map((p) => ({ ...p, enPanel: enPanel.has(p.id) })),
          })) ?? null,
      };
    });

    /**
     * Deja una petición al host (copia, comprobación o kit). Una a la vez: con
     * otra pendiente o una operación en marcha se rechaza, en vez de acumular
     * trabajo que el host haría después en cadena.
     */
    secured.post('/api/system/copias-externas/peticiones', { preHandler: requireAdmin }, async (req, reply) => {
      const parsed = peticionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        const error = parsed.error.issues.map((i) => i.message).join(' ');
        return reply.code(400).send({ error, code: 'peticion_no_valida' });
      }
      const body = parsed.data;
      let peticion: PeticionCopias;
      if (body.accion === 'kit') {
        if (body.alcance === 'proyecto' && !body.proyecto) {
          return reply.code(400).send({ error: 'Indica el proyecto del kit.', code: 'peticion_no_valida' });
        }
        if (body.alcance !== 'proyecto' && body.proyecto) {
          return reply
            .code(400)
            .send({ error: 'El proyecto solo se indica con el alcance «proyecto».', code: 'peticion_no_valida' });
        }
        if (body.proyecto && !getProject(body.proyecto)) {
          return reply.code(404).send({ error: 'El proyecto no existe en el panel.', code: 'proyecto_no_encontrado' });
        }
        peticion = { accion: 'kit', alcance: body.alcance, proyecto: body.proyecto, ejecucion: body.ejecucion };
      } else {
        peticion = { accion: body.accion };
      }

      // De aquí a escribir la petición no hay ningún `await`: dos peticiones
      // simultáneas no pueden pasar las dos la comprobación de «ocupadas».
      const situacion = situacionCopias();
      if (!situacion.instalada) {
        return reply.code(409).send({
          error:
            'Las copias externas no están configuradas en el servidor. Ejecuta «sudo skyway copias configurar» y ' +
            'después «sudo skyway copias activar».',
          code: 'copias_no_instaladas',
        });
      }
      if (situacion.estado?.programacion?.activa === false) {
        // Sin activar, el host no atiende las peticiones: se quedarían pendientes sin más.
        return reply.code(409).send({
          error:
            'Las copias externas están desactivadas y el servidor no atiende las peticiones del panel. ' +
            'Ejecuta «sudo skyway copias activar» en el servidor.',
          code: 'copias_desactivadas',
        });
      }
      if (situacion.ocupada) {
        const accion = situacion.estado?.enCurso?.accion;
        const error =
          situacion.peticionesPendientes > 0
            ? 'Ya hay una petición pendiente. Espera a que el servidor la atienda.'
            : situacion.enCurso
              ? `Hay ${(accion && ACCION_EN_CURSO[accion]) || 'una operación'} en curso. Espera a que termine.`
              : 'Se está preparando un kit. Espera a que termine.';
        return reply.code(409).send({ error, code: 'copias_ocupadas' });
      }

      const user = currentUser(req);
      let escrita: ReturnType<typeof escribirPeticion>;
      try {
        escrita = escribirPeticion(peticion, user?.email ?? 'desconocido');
      } catch (err) {
        req.log.error({ err }, 'No se ha podido escribir la petición de copias externas');
        return reply.code(500).send({
          error: 'No se ha podido registrar la petición en la carpeta de copias del servidor.',
          code: 'peticion_no_registrada',
        });
      }
      const detalle = [
        `${escrita.id}: ${peticion.accion}`,
        peticion.accion === 'kit' ? peticion.alcance : null,
        peticion.accion === 'kit' && peticion.proyecto ? peticion.proyecto : null,
        peticion.accion === 'kit' && peticion.ejecucion ? `ejecución ${peticion.ejecucion}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      audit(req, 'copias_externas_peticion', { type: 'system', id: 'copias-externas', detail: detalle });
      reply.code(202);
      return { ok: true, peticion: { id: escrita.id, ...escrita.contenido } };
    });

    /**
     * Descarga el kit. Exige sesión de navegador, como la copia del panel: el
     * kit lleva cifrados los datos de todo el servidor (bases de datos,
     * volúmenes, configuración), y un token de API —el de una automatización o
     * uno robado— no debe poder llevárselo.
     */
    secured.get('/api/system/copias-externas/kit', { preHandler: [requireAdmin, requireSession] }, async (req, reply) => {
      const kit = leerKitCopias().valor;
      const zip = kit?.estado === 'listo' ? abrirZipKit(kit) : null;
      if (!zip) return reply.code(404).send({ error: 'No hay ningún kit preparado para descargar.', code: 'kit_no_disponible' });
      audit(req, 'copias_externas_kit_descargado', { type: 'system', id: 'copias-externas', detail: zip.fichero });
      reply.header('Content-Disposition', `attachment; filename="${zip.fichero}"`);
      reply.header('Content-Length', String(zip.tamano));
      reply.type('application/zip');
      return reply.send(fs.createReadStream('', { fd: zip.fd }));
    });

    /** Elimina el kit (zip y `kit.json`) sin esperar a que caduque. */
    secured.delete('/api/system/copias-externas/kit', { preHandler: requireAdmin }, async (req, reply) => {
      const lectura = leerKitCopias();
      if (!lectura.valor && !hayFicheroKit()) {
        return reply.code(404).send({ error: 'No hay ningún kit que eliminar.', code: 'kit_no_disponible' });
      }
      if (kitEnPreparacion(lectura)) {
        return reply
          .code(409)
          .send({ error: 'El kit se está preparando. Espera a que termine para eliminarlo.', code: 'kit_en_preparacion' });
      }
      let eliminado: ReturnType<typeof eliminarKit>;
      try {
        eliminado = eliminarKit(lectura.valor);
      } catch (err) {
        req.log.error({ err }, 'No se ha podido eliminar el kit de copias externas');
        return reply.code(500).send({ error: 'No se ha podido eliminar el kit.', code: 'kit_no_eliminado' });
      }
      audit(req, 'copias_externas_kit_eliminado', {
        type: 'system',
        id: 'copias-externas',
        detail: eliminado.fichero ?? 'kit.json',
      });
      return { ok: true };
    });
  });
}
