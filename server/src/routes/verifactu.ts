/**
 * VERI*FACTU en el panel: modo y entorno, certificado electrónico, estado de
 * la cola de remisión, registros, subsanación y declaración responsable.
 * Todo exige administrador: el certificado permite actuar ante la AEAT en
 * nombre del emisor, y los registros son datos fiscales de todos los clientes.
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit';
import { requireAdmin, requireAuth, requireSession } from '../auth';
import { getBillingProfile, setBillingProfile } from '../company';
import { getInvoice, listarEventosSif, listarRegistrosFacturacion, recuentoRegistrosFacturacion, registrosDeFactura, transaction } from '../db';
import { getAjustesVerifactu, ID_SISTEMA, NOMBRE_SISTEMA, numeroInstalacion, productorEfectivo, setAjustesVerifactu } from '../verifactu/ajustes';
import { ErrorCertificado, guardarCertificado, infoCertificado, MAX_BYTES_PFX, quitarCertificado } from '../verifactu/certificado';
import { declaracionEnTexto, declaracionResponsable } from '../verifactu/declaracion';
import { anotarEvento, cadenaEventosIntegra } from '../verifactu/eventos';
import { nifValido, normalizarNif } from '../verifactu/formato';
import { motivoCambioNoPermitido } from '../verifactu/modo';
import { ErrorVerifactu, subsanarRegistro } from '../verifactu/registro';
import { avisarRemision, cerrarAvisoSiProcede, getEstadoCola, pendientesDelAviso, probarConexion, remisionTick, urlServicio } from '../verifactu/remision';
import { levantarReintentos } from '../verifactu/estadocola';
import { config } from '../config';
import { safeParse } from '../util';

const ajustesSchema = z.object({
  modo: z.enum(['desactivado', 'verifactu']).optional(),
  entorno: z.enum(['pruebas', 'produccion']).optional(),
  productorNombre: z.string().trim().max(120).optional(),
  productorNif: z
    .string()
    .trim()
    .max(20)
    .refine((v) => v === '' || nifValido(normalizarNif(v)), { message: 'El NIF del productor no es un NIF español válido.' })
    .optional(),
  productorDireccion: z.string().trim().max(400).optional(),
  declaracionLugar: z.string().trim().max(120).optional(),
  declaracionFecha: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha de suscripción tiene que ser aaaa-mm-dd.')]).optional(),
});

/** Avisos del estado de VERI*FACTU para el panel: qué falta o qué conviene revisar. */
function avisos(): { tipo: string; texto: string }[] {
  const out: { tipo: string; texto: string }[] = [];
  const perfil = getBillingProfile();
  const cert = infoCertificado();
  const ajustes = getAjustesVerifactu();
  const activo = perfil.sifMode === 'verifactu';
  // Aviso de incidencia (art. 16.4 de la Orden): mientras haya registros que no
  // se han podido remitir a su hora (los que llevan la marca de incidencia),
  // cuántos faltan.
  const pendientes = pendientesDelAviso();
  const cola = getEstadoCola();
  if (pendientes > 0) {
    out.push({
      tipo: 'incidencia',
      texto: `Hay ${pendientes} ${pendientes === 1 ? 'registro de facturación pendiente' : 'registros de facturación pendientes'} de remitir a la AEAT por una incidencia${cola.ultimoError ? `: ${cola.ultimoError}` : !cert ? ': falta el certificado electrónico' : ''}. Skyway los reintenta solo, al menos una vez por hora.`,
    });
  }
  if (activo && !cert) out.push({ tipo: 'sin_certificado', texto: 'Falta el certificado electrónico: los registros se generan, pero no se pueden remitir a la AEAT hasta cargarlo.' });
  if (cert) {
    const dias = Math.floor((cert.validoHasta - Date.now()) / 86_400_000);
    if (dias < 0) out.push({ tipo: 'certificado_caducado', texto: 'El certificado electrónico ha caducado: carga uno vigente.' });
    else if (dias <= 30) out.push({ tipo: 'certificado_caduca', texto: `El certificado electrónico caduca en ${dias} días.` });
    const nifEmisor = normalizarNif(perfil.taxId);
    if (cert.nif && nifValido(nifEmisor) && cert.nif !== nifEmisor) {
      out.push({
        tipo: 'certificado_otro_nif',
        texto: `El certificado es del NIF ${cert.nif} y el emisor es ${nifEmisor}: la AEAT solo lo acepta si su titular es apoderado o colaborador social del emisor.`,
      });
    }
  }
  if (activo && ajustes.entorno === 'pruebas') {
    out.push({ tipo: 'entorno_pruebas', texto: 'Los registros van al entorno de pruebas de la AEAT, que no tiene efectos fiscales. Cambia a producción antes del plazo de adaptación.' });
  }
  if (activo && !declaracionResponsable().completa) out.push({ tipo: 'declaracion_incompleta', texto: 'Completa los datos de la declaración responsable del sistema.' });
  return out;
}

function vista() {
  const perfil = getBillingProfile();
  const ajustes = getAjustesVerifactu();
  const recuento = recuentoRegistrosFacturacion();
  return {
    modo: perfil.sifMode,
    ajustes,
    productor: productorEfectivo(),
    sistema: { nombre: NOMBRE_SISTEMA, id: ID_SISTEMA, version: config.version, numeroInstalacion: numeroInstalacion() },
    servicio: urlServicio(ajustes.entorno),
    certificado: infoCertificado(),
    cola: { ...getEstadoCola(), recuento },
    registros: listarRegistrosFacturacion(50).map((r) => ({
      id: r.id,
      invoice_id: r.invoice_id,
      invoice_number: r.invoice_number,
      workspace_id: r.workspace_id,
      tipo: r.record_type,
      tipo_factura: r.tipo_factura,
      entorno: r.entorno,
      seq: r.seq,
      estado: r.estado_remision,
      csv: r.csv_aeat,
      codigo_error: r.codigo_error,
      descripcion_error: r.descripcion_error,
      importe_total_cents: r.importe_total_cents,
      huella: r.huella,
      fecha_hora_gen: r.fecha_hora_gen,
      subsanacion: r.subsanacion === 1,
      incidencia: r.incidencia === 1,
      intentos: r.intentos,
      created_at: r.created_at,
    })),
    eventos: listarEventosSif(20),
    eventosIntegros: cadenaEventosIntegra(),
    declaracion: declaracionResponsable(),
    avisos: avisos(),
  };
}

export async function verifactuRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireAdmin);

  app.get('/api/verifactu', async () => vista());

  // Modo, entorno y datos del productor y de la declaración.
  app.put('/api/verifactu', async (req, reply) => {
    const body = ajustesSchema.parse(req.body ?? {});
    const perfil = getBillingProfile();
    const actual = getAjustesVerifactu();
    const siguientePerfil = { ...perfil, sifMode: body.modo ?? perfil.sifMode };
    const motivo = motivoCambioNoPermitido(
      { ...perfil, entorno: actual.entorno },
      { ...siguientePerfil, entorno: body.entorno ?? actual.entorno },
    );
    if (motivo) return reply.code(409).send({ error: motivo });
    // El productor se identifica con su nombre Y su NIF (art. 15.1.h e i de la
    // Orden): uno sin el otro mezclaría el nombre de uno con el NIF del emisor.
    // Se comprueba solo cuando se cambia alguno de los dos: unos datos guardados
    // a medias no deben impedir activar ni cambiar de entorno, y mientras tanto
    // el productor efectivo es la empresa emisora (`productorEfectivo`).
    const nombreProductor = body.productorNombre ?? actual.productorNombre;
    const nifProductor = body.productorNif !== undefined ? normalizarNif(body.productorNif) : actual.productorNif;
    const tocaProductor = body.productorNombre !== undefined || body.productorNif !== undefined;
    if (tocaProductor && !!nombreProductor.trim() !== !!nifProductor.trim()) {
      return reply.code(400).send({ error: 'Indica la razón social y el NIF del productor juntos, o deja los dos vacíos para que sea la empresa emisora.' });
    }
    const siguiente = {
      entorno: body.entorno ?? actual.entorno,
      productorNombre: body.productorNombre ?? actual.productorNombre,
      productorNif: body.productorNif !== undefined ? normalizarNif(body.productorNif) : actual.productorNif,
      productorDireccion: body.productorDireccion ?? actual.productorDireccion,
      declaracionLugar: body.declaracionLugar ?? actual.declaracionLugar,
      declaracionFecha: body.declaracionFecha ?? actual.declaracionFecha,
      // Poner (o cambiar) la fecha es suscribir la declaración de esta versión.
      declaracionVersion:
        body.declaracionFecha !== undefined && body.declaracionFecha !== actual.declaracionFecha
          ? body.declaracionFecha
            ? config.version
            : ''
          : actual.declaracionVersion,
    };
    transaction(() => {
      if (siguientePerfil.sifMode !== perfil.sifMode) {
        setBillingProfile(siguientePerfil);
        anotarEvento(siguientePerfil.sifMode === 'verifactu' ? 'activacion' : 'desactivacion', `Entorno: ${siguiente.entorno}`);
      }
      if (siguiente.entorno !== actual.entorno) anotarEvento('cambio_entorno', `${actual.entorno} → ${siguiente.entorno}`);
      if (siguiente.productorNombre !== actual.productorNombre || siguiente.productorNif !== actual.productorNif) {
        anotarEvento('cambio_productor', `${siguiente.productorNombre || '(el emisor)'} ${siguiente.productorNif}`);
      }
      setAjustesVerifactu(siguiente);
    });
    // Al desactivar, lo que quede en cola de pruebas deja de ser una incidencia.
    cerrarAvisoSiProcede();
    audit(req, 'verifactu_updated', { type: 'system', id: 'verifactu', detail: `${siguientePerfil.sifMode} · ${siguiente.entorno}` });
    return vista();
  });

  // Certificado electrónico (.pfx o .p12, en base64) y su contraseña. Nunca se
  // devuelven. Cargarlo o retirarlo exige sesión de navegador, como el resto de
  // credenciales persistentes (Cloudflare, Mailway): un token de API filtrado no
  // debe poder cambiar con qué identidad se presenta Skyway ante la AEAT ni
  // dejar de remitir.
  app.post('/api/verifactu/certificado', { preHandler: requireSession }, async (req, reply) => {
    const body = z
      .object({
        pfx: z.string().trim().min(1, 'Falta el fichero del certificado.').max(Math.ceil((MAX_BYTES_PFX * 4) / 3) + 8, 'El fichero es demasiado grande.'),
        password: z.string().max(200),
      })
      .parse(req.body ?? {});
    if (!/^[A-Za-z0-9+/=\s]+$/.test(body.pfx)) return reply.code(400).send({ error: 'El certificado tiene que llegar codificado en base64.' });
    try {
      const info = guardarCertificado(Buffer.from(body.pfx, 'base64'), body.password);
      anotarEvento('certificado_cargado', `${info.titular} · caduca ${new Date(info.validoHasta).toISOString().slice(0, 10)} · ${info.huellaSha256}`);
      audit(req, 'verifactu_certificate_uploaded', { type: 'system', id: 'verifactu', detail: `${info.nif ?? 'sin NIF'} · caduca ${new Date(info.validoHasta).toISOString().slice(0, 10)}` });
      // Con certificado, lo que esperaba en cola puede salir ya: también lo que
      // esperaba hasta una hora por un rechazo de configuración (otro titular,
      // un certificado caducado). La espera que pide la AEAT se mantiene.
      levantarReintentos();
      avisarRemision();
      return { certificado: info };
    } catch (err) {
      if (err instanceof ErrorCertificado) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.delete('/api/verifactu/certificado', { preHandler: requireSession }, async (req) => {
    const antes = infoCertificado();
    quitarCertificado();
    if (antes) anotarEvento('certificado_retirado', `${antes.titular} · ${antes.huellaSha256}`);
    audit(req, 'verifactu_certificate_removed', { type: 'system', id: 'verifactu', detail: antes?.nif ?? '' });
    return { ok: true };
  });

  // La declaración responsable en texto plano, para publicarla fuera del
  // panel (la AEAT pide que esté también accesible de forma independiente del
  // sistema, en un formato de uso extendido y gratuito).
  app.get('/api/verifactu/declaracion.txt', async (_req, reply) => {
    // La declaración es de una versión concreta (art. 15 de la Orden): el nombre
    // del fichero la lleva, para no confundir la de una versión con otra.
    reply.header('Content-Disposition', `attachment; filename="declaracion-responsable-skyway-${config.version}.txt"`);
    reply.type('text/plain; charset=utf-8');
    return declaracionEnTexto(declaracionResponsable());
  });

  // Prueba la conexión TLS con el certificado contra el entorno elegido. No envía registros.
  app.post('/api/verifactu/probar', async (req) => {
    const body = z.object({ entorno: z.enum(['pruebas', 'produccion']).optional() }).parse(req.body ?? {});
    return probarConexion(body.entorno ?? getAjustesVerifactu().entorno);
  });

  // Envía ya lo que haya en cola (respetando la espera que pide la AEAT).
  app.post('/api/verifactu/enviar', async (req) => {
    const r = await remisionTick({ forzar: true });
    audit(req, 'verifactu_send_now', { type: 'system', id: 'verifactu', detail: r.enviado ? `${r.registros} registros: ${r.resultado}` : (r.motivo ?? '') });
    return { resultado: r, vista: vista() };
  });

  // Registros de una factura, con todos sus campos de la AEAT.
  app.get('/api/invoices/:id/verifactu', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getInvoice(id)) return reply.code(404).send({ error: 'Factura no encontrada' });
    return {
      registros: registrosDeFactura(id).map((r) => ({
        id: r.id,
        tipo: r.record_type,
        entorno: r.entorno,
        seq: r.seq,
        estado: r.estado_remision,
        csv: r.csv_aeat,
        codigo_error: r.codigo_error,
        descripcion_error: r.descripcion_error,
        huella: r.huella,
        huella_anterior: r.huella_anterior,
        qr_url: r.qr_url,
        intentos: r.intentos,
        incidencia: r.incidencia === 1,
        created_at: r.created_at,
        registro: safeParse<unknown>(r.registro_json, null),
      })),
    };
  });

  // Subsana el registro rechazado o aceptado con errores de una factura.
  app.post('/api/invoices/:id/verifactu/subsanar', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getInvoice(id)) return reply.code(404).send({ error: 'Factura no encontrada' });
    try {
      const fila = subsanarRegistro(id);
      audit(req, 'verifactu_record_corrected', { type: 'invoice', id, detail: `${fila.record_type} ${fila.num_serie_factura}` });
      avisarRemision();
      return { ok: true, registro: { id: fila.id, tipo: fila.record_type, estado: fila.estado_remision } };
    } catch (err) {
      if (err instanceof ErrorVerifactu) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });
}
