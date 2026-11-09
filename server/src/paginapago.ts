/**
 * Página pública mínima del enlace de pago (`/pagar/<token>`). La ve el cliente
 * sin sesión, así que no carga nada del panel: HTML propio con el estilo en
 * línea (la CSP admite estilos en línea y ningún script), sin enlaces al panel
 * ni datos de la cuenta. Solo dice el estado de ESA factura y quién la emite.
 *
 * Qué no aparece nunca en esta página: el destinatario (nombre, NIF, domicilio,
 * correo), las líneas, identificadores internos ni nada de otras facturas. Si el
 * enlace se reenvía o se filtra, quien lo abra solo ve lo que el propio emisor
 * imprime en cada factura y el estado del pago. (Con la factura pendiente, la
 * página de Stripe Checkout a la que se redirige sí muestra el correo de
 * facturación del cliente: se le pasa para el recibo, como en «Cobrar».)
 */
import { getBillingProfile } from './company';
import { fmtFecha, fmtImporte } from './invoicepdf';
import { InvoiceRow, IssuerSnapshot } from './types';
import { safeParse } from './util';

export type VistaPago =
  | { tipo: 'no_valido' }
  | { tipo: 'demasiadas' }
  | { tipo: 'pagada' | 'anulada' | 'rectificada' | 'sin_importe'; factura: InvoiceRow }
  /** `recibido`: Stripe ya da el pago por completado; falta solo la confirmación. */
  | { tipo: 'confirmando'; factura: InvoiceRow; token: string; recibido?: boolean }
  | { tipo: 'cancelado'; factura: InvoiceRow; token: string }
  | { tipo: 'no_disponible'; factura: InvoiceRow; token: string; motivo: 'pasarela' | 'configuracion' };

function esc(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Emisor CONGELADO al emitir (el que figura en la factura); sin él, el perfil vivo. */
function emisorDe(inv: InvoiceRow): IssuerSnapshot {
  const perfil = getBillingProfile();
  const snap = safeParse<IssuerSnapshot | null>(inv.issuer_snapshot, null);
  return {
    companyName: snap?.companyName ?? perfil.companyName,
    taxId: snap?.taxId ?? perfil.taxId,
    address: snap?.address ?? perfil.address,
    email: snap?.email ?? perfil.email,
    phone: snap?.phone ?? perfil.phone,
  };
}

function bloqueEmisor(e: IssuerSnapshot): string {
  const lineas = [
    e.companyName.trim() ? `<strong>${esc(e.companyName.trim())}</strong>` : '',
    e.taxId.trim() ? `NIF ${esc(e.taxId.trim())}` : '',
    // El domicilio puede venir en varias líneas: se respetan sin abrir HTML.
    ...e.address.split(/\r?\n/).map((l) => esc(l.trim())),
    [e.email.trim(), e.phone.trim()].filter(Boolean).map(esc).join(' · '),
  ].filter(Boolean);
  if (lineas.length === 0) return '';
  return `<footer class="emisor"><p class="rotulo">Emisor</p>${lineas.join('<br>')}</footer>`;
}

function datosFactura(inv: InvoiceRow, conPago: boolean): string {
  const filas: [string, string][] = [
    ['Factura', inv.number ?? 'Sin número'],
    ['Importe', fmtImporte(inv.total_cents, inv.currency)],
  ];
  if (inv.issued_at) filas.push(['Fecha de expedición', fmtFecha(inv.issued_at)]);
  if (conPago && inv.paid_at) filas.push(['Fecha de pago', fmtFecha(inv.paid_at)]);
  else if (!conPago && inv.status === 'issued' && inv.due_at) filas.push(['Vencimiento', fmtFecha(inv.due_at)]);
  return `<dl>${filas.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}

/** Datos para pagar por transferencia, los mismos que imprime la factura. */
function bloqueTransferencia(inv: InvoiceRow): string {
  const { iban, bankName } = getBillingProfile();
  if (!iban.trim()) return '';
  const banco = bankName.trim() ? ` (${esc(bankName.trim())})` : '';
  const concepto = inv.number ? ` Indica como concepto el número de factura ${esc(inv.number)}.` : '';
  return (
    '<div class="transferencia"><p class="rotulo">Transferencia bancaria</p>' +
    `<p>IBAN <span class="mono">${esc(iban.trim())}</span>${banco}.${concepto}</p></div>`
  );
}

function botonPagar(token: string, texto: string): string {
  // Relativo y al mismo enlace: vuelve a pasar por la comprobación del estado.
  return `<p><a class="boton" href="/pagar/${esc(token)}">${esc(texto)}</a></p>`;
}

interface Contenido {
  titulo: string;
  estado?: { texto: string; clase: 'ok' | 'aviso' | 'neutro' };
  parrafos: string[];
  factura?: InvoiceRow;
  conPago?: boolean;
  extra?: string;
}

function contenido(vista: VistaPago): Contenido {
  switch (vista.tipo) {
    case 'no_valido':
      return {
        titulo: 'Enlace no válido',
        parrafos: ['Este enlace de pago no existe o ya no está activo. Si tienes una factura pendiente, ponte en contacto con la empresa que te la ha enviado.'],
      };
    case 'demasiadas':
      return {
        titulo: 'Demasiadas solicitudes',
        parrafos: ['Se han recibido demasiadas solicitudes desde tu conexión. Espera unos minutos y vuelve a intentarlo.'],
      };
    case 'pagada':
      return {
        titulo: 'Factura pagada',
        estado: { texto: 'Pagada', clase: 'ok' },
        parrafos: ['Esta factura ya está pagada. No es necesario realizar ningún otro pago.'],
        factura: vista.factura,
        conPago: true,
      };
    case 'anulada':
      return {
        titulo: 'Factura anulada',
        estado: { texto: 'Anulada', clase: 'aviso' },
        parrafos: ['Esta factura está anulada y no admite pagos. Si tienes alguna duda, ponte en contacto con el emisor.'],
        factura: vista.factura,
      };
    case 'rectificada':
      return {
        titulo: 'Factura rectificada',
        estado: { texto: 'Rectificada', clase: 'aviso' },
        parrafos: [
          'Esta factura se ha corregido con una factura rectificativa y no admite pagos por su importe original. Ponte en contacto con el emisor para conocer el importe pendiente.',
        ],
        factura: vista.factura,
      };
    case 'sin_importe':
      return {
        titulo: 'Sin importe pendiente',
        estado: { texto: 'Sin importe pendiente', clase: 'neutro' },
        parrafos: ['Esta factura no tiene importe pendiente de pago.'],
        factura: vista.factura,
      };
    case 'confirmando':
      if (vista.recibido) {
        // Stripe ya tiene el pago: sin botón para pagar, que sería pagar dos veces.
        return {
          titulo: 'Pago recibido',
          estado: { texto: 'Pendiente de confirmación', clase: 'neutro' },
          parrafos: [
            'El pago de esta factura se ha completado y está pendiente de confirmación. No es necesario volver a pagar: la factura constará como pagada en cuanto se confirme.',
          ],
          factura: vista.factura,
        };
      }
      return {
        titulo: 'Pago en proceso de confirmación',
        estado: { texto: 'Pendiente de confirmación', clase: 'neutro' },
        parrafos: [
          'Si has completado el pago, no es necesario hacer nada más: la factura constará como pagada en unos minutos.',
          'Si no llegaste a completar el pago, puedes volver a intentarlo.',
        ],
        factura: vista.factura,
        extra: botonPagar(vista.token, 'Pagar con tarjeta'),
      };
    case 'cancelado':
      return {
        titulo: 'Pago no completado',
        estado: { texto: 'Pendiente de pago', clase: 'aviso' },
        parrafos: ['No se ha realizado ningún cargo. Puedes volver a intentarlo cuando quieras.'],
        factura: vista.factura,
        extra: botonPagar(vista.token, 'Pagar con tarjeta') + bloqueTransferencia(vista.factura),
      };
    case 'no_disponible':
      return {
        titulo: 'Pago con tarjeta no disponible',
        estado: { texto: 'Pendiente de pago', clase: 'aviso' },
        parrafos: [
          vista.motivo === 'pasarela'
            ? 'No se ha podido conectar con la pasarela de pago. Vuelve a intentarlo en unos minutos.'
            : 'En este momento no es posible pagar esta factura con tarjeta. Vuelve a intentarlo más tarde o ponte en contacto con el emisor.',
        ],
        factura: vista.factura,
        extra: (vista.motivo === 'pasarela' ? botonPagar(vista.token, 'Volver a intentarlo') : '') + bloqueTransferencia(vista.factura),
      };
  }
}

const ESTILO = `
:root{color-scheme:light dark;--fondo:#f4f5f7;--tarjeta:#fff;--texto:#1b1e23;--suave:#5b626e;--linea:#e1e4e9;--acento:#2456d3;--acento-texto:#fff;--ok:#1a7a4b;--aviso:#9a5800}
@media (prefers-color-scheme:dark){:root{--fondo:#111317;--tarjeta:#1a1d22;--texto:#eceef1;--suave:#a2a9b4;--linea:#2c3038;--acento:#6b97ff;--acento-texto:#0b0d10;--ok:#4cc38a;--aviso:#f0a447}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:var(--fondo);color:var(--texto);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:460px;background:var(--tarjeta);border:1px solid var(--linea);border-radius:12px;padding:28px}
h1{font-size:22px;line-height:1.3;margin:4px 0 12px}
p{margin:0 0 12px;color:var(--suave)}
.estado{font-size:13px;font-weight:600;letter-spacing:.02em;margin:0}
.estado.ok{color:var(--ok)}.estado.aviso{color:var(--aviso)}.estado.neutro{color:var(--suave)}
dl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 16px;margin:18px 0;padding:14px 0;border-top:1px solid var(--linea);border-bottom:1px solid var(--linea)}
dt{color:var(--suave)}dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.boton{display:inline-block;margin-top:4px;padding:10px 18px;border-radius:8px;background:var(--acento);color:var(--acento-texto);text-decoration:none;font-weight:600}
.boton:focus-visible{outline:2px solid var(--acento);outline-offset:3px}
.transferencia{margin-top:16px}
.rotulo{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin:0 0 4px;color:var(--suave)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere;color:var(--texto)}
.emisor{margin-top:22px;padding-top:14px;border-top:1px solid var(--linea);font-size:14px;color:var(--suave)}
.emisor strong{color:var(--texto)}
@media (max-width:420px){main{padding:22px}}
`;

/** HTML completo de la página. Todo lo variable pasa por `esc`. */
export function paginaPago(vista: VistaPago): string {
  const c = contenido(vista);
  const emisor = c.factura ? emisorDe(c.factura) : null;
  const nombre = emisor?.companyName.trim();
  const titulo = nombre ? `${c.titulo} · ${nombre}` : c.titulo;
  const cuerpo = [
    c.estado ? `<p class="estado ${c.estado.clase}">${esc(c.estado.texto)}</p>` : '',
    `<h1>${esc(c.titulo)}</h1>`,
    ...c.parrafos.map((p) => `<p>${esc(p)}</p>`),
    c.factura ? datosFactura(c.factura, !!c.conPago) : '',
    c.extra ?? '',
    emisor ? bloqueEmisor(emisor) : '',
  ].join('');
  return (
    '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow">' +
    `<title>${esc(titulo)}</title><style>${ESTILO}</style></head>` +
    `<body><main>${cuerpo}</main></body></html>`
  );
}
