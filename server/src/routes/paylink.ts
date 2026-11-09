/**
 * Enlace público y permanente de pago: `GET /pagar/<token>` (ver `enlacepago.ts`).
 *
 * Sin sesión y fuera de `/api`: lo abre el cliente desde el correo de la factura.
 * Con la factura pendiente, reutiliza la sesión de Stripe Checkout abierta o
 * crea otra (la misma lógica y el mismo cerrojo que «Cobrar» en el panel:
 * `cobrarConStripe`) y redirige a Stripe. Pagada o anulada, enseña una página
 * mínima que lo dice (`paginapago.ts`).
 *
 * Lo único que decide la respuesta es el token: uno que no existe, revocado o
 * mal formado dan la misma página 404, y la factura se busca solo por el hash
 * exacto, así que no hay forma de llegar desde aquí a otra factura ni a otro
 * cliente.
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fireWorkspaceAlert } from '../alerts';
import { audit } from '../audit';
import { getInvoice } from '../db';
import { facturaPorTokenPago } from '../enlacepago';
import { VistaPago, paginaPago } from '../paginapago';
import { panelBaseUrl } from '../paneldomain';
import { rateLimit } from '../ratelimit';
import { InvoiceRow } from '../types';
import { abonoQueLaRectifica, cobrarConStripe } from './billing';

/** Actor en la auditoría: quien abre el enlace no tiene cuenta (su IP sí consta). */
const ACTOR = 'enlace público de pago';

function cabeceras(reply: FastifyReply, codigo: number): FastifyReply {
  return (
    reply
      .code(codigo)
      .type('text/html; charset=utf-8')
      // Depende del estado de la factura y sus enlaces llevan el token: ni caché
      // del navegador o de intermediarios, ni buscadores.
      .header('Cache-Control', 'no-store')
      .header('X-Robots-Tag', 'noindex, nofollow')
  );
}

function enviarPagina(reply: FastifyReply, codigo: number, vista: VistaPago): FastifyReply {
  return cabeceras(reply, codigo).send(paginaPago(vista));
}

/** Página de una factura que no hay que mandar a Stripe, o null si está pendiente. */
function vistaDeEstado(inv: InvoiceRow): VistaPago | null {
  if (inv.status === 'paid') return { tipo: 'pagada', factura: inv };
  if (inv.status === 'void') return { tipo: 'anulada', factura: inv };
  // Abonada por una rectificativa: pagarla cobraría también lo que el abono devuelve.
  if (abonoQueLaRectifica(inv)) return { tipo: 'rectificada', factura: inv };
  if (inv.total_cents <= 0) return { tipo: 'sin_importe', factura: inv };
  return null;
}

/**
 * El cliente ha querido pagar y no ha podido. Nadie del equipo ve esta página,
 * así que se audita y se avisa al operador (una alerta por factura mientras
 * siga abierta).
 */
function avisarFallo(req: FastifyRequest, inv: InvoiceRow, motivo: string): void {
  const numero = inv.number ?? inv.id;
  audit(req, 'invoice_pay_link_failed', { type: 'invoice', id: inv.id, detail: `${numero}: ${motivo.slice(0, 200)}` }, ACTOR);
  fireWorkspaceAlert({
    severity: 'warning',
    workspaceId: inv.workspace_id,
    type: 'invoice_pay_link_failed',
    title: `No se ha podido iniciar el pago de la factura ${numero}`,
    message: motivo.slice(0, 300),
    explanation:
      'El cliente ha abierto el enlace de pago de la factura, pero no se ha podido crear la sesión de Stripe. Revisa la configuración de Stripe en Contabilidad y los datos fiscales de la cuenta.',
    dedupeKey: `invoice:${inv.id}:pay_link_failed`,
  });
}

export async function payLinkRoutes(app: FastifyInstance): Promise<void> {
  // Límite por IP: la ruta es pública y cada visita puede consultar a Stripe y
  // crear una sesión. Holgado para quien recarga o vuelve de Stripe varias veces;
  // con tokens de 256 bits no hay nada que adivinar a base de peticiones.
  const limitar = rateLimit({
    max: 30,
    windowMs: 10 * 60_000,
    key: (req) => `pagar:${req.ip}`,
    responder: (reply) => {
      enviarPagina(reply, 429, { tipo: 'demasiadas' });
    },
  });

  app.get('/pagar/:token', { preHandler: limitar }, async (req, reply) => {
    // Hexadecimal: se normaliza una vez y es el mismo en la página y en la vuelta de Stripe.
    const token = (req.params as { token: string }).token.toLowerCase();
    const inv = facturaPorTokenPago(token);
    if (!inv) return enviarPagina(reply, 404, { tipo: 'no_valido' });
    const estado = vistaDeEstado(inv);
    if (estado) return enviarPagina(reply, 200, estado);
    // Un HEAD (comprobadores de enlaces, vistas previas de chats y de correo)
    // nunca crea sesiones ni emite nada: solo confirma que el enlace existe.
    if (req.method === 'HEAD') return cabeceras(reply, 200).send();

    // Vuelta desde Stripe: no se redirige otra vez a pagar. Tras pagar, el
    // webhook puede tardar unos segundos; volver a Checkout invitaría a pagar dos
    // veces. Y desde «cancelar», redirigir haría imposible salir de Stripe.
    const { estado: vuelta } = req.query as { estado?: unknown };
    if (vuelta === 'pagado') return enviarPagina(reply, 200, { tipo: 'confirmando', factura: inv, token });
    if (vuelta === 'cancelado') return enviarPagina(reply, 200, { tipo: 'cancelado', factura: inv, token });

    try {
      const res = await cobrarConStripe(
        inv.id,
        {
          base: panelBaseUrl(req),
          auditar: (accion, detalle) => audit(req, accion, { type: 'invoice', id: inv.id, detail: detalle }, ACTOR),
          token,
        },
        'esperar',
      );
      if (res.ok) return reply.code(303).header('Location', res.url).header('Cache-Control', 'no-store').send();
      if (res.motivo === 'no_existe') return enviarPagina(reply, 404, { tipo: 'no_valido' });
      // Ya pagada en Stripe a falta de la confirmación: nada de otra sesión.
      if (res.motivo === 'en_confirmacion') return enviarPagina(reply, 200, { tipo: 'confirmando', factura: inv, token, recibido: true });
      // Pudo cobrarse o anularse mientras tanto: la página dice cómo está ahora.
      const actual = getInvoice(inv.id) ?? inv;
      const ahora = vistaDeEstado(actual);
      if (ahora) return enviarPagina(reply, 200, ahora);
      avisarFallo(req, actual, res.mensaje);
      // Solo un fallo pasajero de Stripe invita a reintentar; un rechazo (importe
      // mínimo, moneda, cuenta sin activar) o la falta de configuración, no.
      const pasarela = res.motivo === 'stripe';
      return enviarPagina(reply, pasarela ? 502 : 503, { tipo: 'no_disponible', factura: actual, token, motivo: pasarela ? 'pasarela' : 'configuracion' });
    } catch (err) {
      // Un fallo interno no debe llegar al cliente como el JSON de la API.
      req.log.error({ err, invoice: inv.id }, 'fallo al preparar el cobro desde el enlace público');
      avisarFallo(req, inv, 'Error interno al preparar el cobro.');
      return enviarPagina(reply, 500, { tipo: 'no_disponible', factura: inv, token, motivo: 'configuracion' });
    }
  });

  // Cualquier otra forma bajo /pagar (sin token, con barra final, con más
  // tramos) es un enlace roto: la misma página, no el panel.
  const noValido = async (_req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => enviarPagina(reply, 404, { tipo: 'no_valido' });
  app.get('/pagar', { preHandler: limitar }, noValido);
  app.get('/pagar/*', { preHandler: limitar }, noValido);
}
