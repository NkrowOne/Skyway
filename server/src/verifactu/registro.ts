/**
 * Generación de los registros de facturación de VERI*FACTU (art. 9 y 10 del
 * RD 1007/2023 y Orden HAC/1177/2024): uno de alta al expedir cada factura y
 * uno de anulación al anularla, con su huella encadenada a la del registro
 * anterior del mismo emisor.
 *
 * Se llama DENTRO de la transacción que numera o anula la factura: el número,
 * el registro y su puesto en la cadena se confirman juntos o no se confirma
 * nada (better-sqlite3 es síncrono y serializa las transacciones, así que dos
 * emisiones no pueden encadenarse al mismo registro anterior).
 *
 * Cómo se traduce una factura de Skyway a los campos de la AEAT, con su
 * justificación, en `docs/VERIFACTU.md`.
 */
import {
  getInvoice,
  insertarRegistroFacturacion,
  registrosDeFactura,
  transaction,
  ultimoRegistroCadena,
} from '../db';
import { config } from '../config';
import { getBillingProfile } from '../company';
import type { EntornoVerifactu, EstadoRemision, InvoiceLine, InvoiceRow, IssuerSnapshot, RegistroFacturacionRow, TaxBreakdownEntry } from '../types';
import { id, safeParse } from '../util';
import { getAjustesVerifactu, sistemaInformatico, URL_COTEJO, verifactuActivo } from './ajustes';
import { infoCertificado } from './certificado';
import { fechaAeat, fechaHoraHuso, importeAeat, nifValido, normalizarNif, textoAeat, tipoAeat } from './formato';
import { anotarEvento } from './eventos';
import { huellaAlta, huellaAnulacion } from './huella';
import type {
  CalificacionOperacion,
  DetalleDesglose,
  Encadenamiento,
  IdFacturaAeat,
  OperacionExenta,
  PersonaAeat,
  RegistroAeat,
  RegistroAltaAeat,
  RegistroAnulacionAeat,
  TipoFacturaAeat,
} from './tipos';

/** Dato de la factura que impide generar un registro válido. El mensaje es para el operador. */
export class ErrorVerifactu extends Error {}

/** Estados de la UE con NIF-IVA (sin España: un cliente español va con NIF). */
const UE = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'GR', 'FI', 'FR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']);
/** Prefijo del NIF-IVA cuando no coincide con el código ISO del país. */
const PREFIJO_IVA: Record<string, string> = { GR: 'EL' };

/** Límite de la factura simplificada sin identificar destinatario (código 1150 de la AEAT). */
const LIMITE_F2_CENTS = 300_000;
/** Umbral de «Macrodato» (códigos 1138 y 1139): 100 millones de euros. */
const UMBRAL_MACRODATO_CENTS = 10_000_000_000;

function lineas(inv: InvoiceRow): InvoiceLine[] {
  return safeParse<InvoiceLine[]>(inv.lines, []).filter((l) => l && typeof l === 'object');
}

function desgloseFactura(inv: InvoiceRow): TaxBreakdownEntry[] {
  return safeParse<TaxBreakdownEntry[]>(inv.tax_breakdown, []).filter((b) => b && typeof b === 'object');
}

/** Emisor congelado al emitir (o el perfil vivo en las facturas anteriores a la foto). */
function emisor(inv: InvoiceRow): { nif: string; nombre: string } {
  const snap = safeParse<IssuerSnapshot | null>(inv.issuer_snapshot, null);
  const perfil = getBillingProfile();
  return { nif: normalizarNif(snap?.taxId ?? perfil.taxId), nombre: textoAeat(snap?.companyName ?? perfil.companyName, 120) };
}

/**
 * Número de serie de la factura tal como lo admite la AEAT: hasta 60
 * caracteres ASCII imprimibles y sin los que rechaza el servicio (1130 y 1287).
 */
function numSerie(inv: InvoiceRow): string {
  const n = (inv.number ?? '').trim();
  if (!n) throw new ErrorVerifactu('La factura no tiene número: no se puede registrar sin emitirla.');
  if (n.length > 60) throw new ErrorVerifactu(`El número de factura «${n}» supera los 60 caracteres que admite la AEAT.`);
  if (!/^[\x20-\x7e]+$/.test(n) || /[<>"'=]/.test(n)) {
    throw new ErrorVerifactu(`El número de factura «${n}» tiene caracteres que la AEAT no admite. Cambia el prefijo de serie en Contabilidad.`);
  }
  return n;
}

/** Tipo de factura de la AEAT según el tipo de Skyway y, en las rectificativas, la original. */
function tipoFactura(inv: InvoiceRow, original: InvoiceRow | undefined): TipoFacturaAeat {
  if (inv.invoice_type === 'simplificada') return 'F2';
  if (inv.invoice_type !== 'rectificativa') return 'F1';
  if (original?.invoice_type === 'simplificada') return 'R5';
  return inv.rectify_code ?? 'R1';
}

/** Destinatario de la factura: NIF si es español; NIF-IVA si es de la UE; documento de su país si no. */
function destinatario(inv: InvoiceRow, nifEmisor: string, estricto: boolean): PersonaAeat {
  const nombre = textoAeat(inv.client_name, 120);
  if (!nombre) throw new ErrorVerifactu('Falta el nombre del cliente, obligatorio en el registro de una factura completa.');
  const pais = (inv.client_country || 'ES').toUpperCase();
  const bruto = (inv.client_tax_id ?? '').trim();
  if (pais === 'ES') {
    const nif = normalizarNif(bruto);
    if (estricto && !nifValido(nif)) {
      throw new ErrorVerifactu(`El NIF del cliente («${bruto || 'vacío'}») no es un NIF español válido. Corrígelo en la ficha de la cuenta o, si es de otro país, indica su país.`);
    }
    if (estricto && nif === nifEmisor) throw new ErrorVerifactu('El NIF del cliente es el mismo que el del emisor.');
    return { NombreRazon: nombre, NIF: nif };
  }
  const id = bruto.toUpperCase().replace(/[\s.\-/]/g, '');
  if (!id) throw new ErrorVerifactu('Falta el número de identificación fiscal del cliente extranjero.');
  if (UE.has(pais)) {
    const prefijo = PREFIJO_IVA[pais] ?? pais;
    // Sin código de país: con IDType 02 el país va en el propio NIF-IVA, y
    // ponerlo obliga a que coincida con su prefijo (1122), que en Grecia es EL.
    return { NombreRazon: nombre, IDOtro: { IDType: '02', ID: (/^[A-Z]{2}/.test(id) ? id : `${prefijo}${id}`).slice(0, 20) } };
  }
  return { NombreRazon: nombre, IDOtro: { CodigoPais: pais, IDType: '04', ID: id.slice(0, 20) } };
}

/**
 * Desglose por régimen y tipo. La clave de cada línea sale del régimen de IVA
 * de la factura (y, en la inversión del sujeto pasivo y la no sujeción, del
 * país del cliente: un servicio a una empresa de otro país no está sujeto al
 * IVA español por las reglas de localización, N2).
 */
function desglose(inv: InvoiceRow): DetalleDesglose[] {
  const extranjero = (inv.client_country || 'ES').toUpperCase() !== 'ES';
  const grupos = new Map<string, { d: DetalleDesglose; base: number; cuota: number; cuotaRe: number }>();
  const anade = (clave: { ClaveRegimen: string; calif?: CalificacionOperacion; exenta?: OperacionExenta; tipo?: number; tipoRe?: number }, b: TaxBreakdownEntry): void => {
    const k = [clave.ClaveRegimen, clave.calif ?? '', clave.exenta ?? '', clave.tipo ?? '', clave.tipoRe ?? ''].join('|');
    let g = grupos.get(k);
    if (!g) {
      g = {
        d: {
          Impuesto: '01',
          ClaveRegimen: clave.ClaveRegimen,
          ...(clave.calif ? { CalificacionOperacion: clave.calif } : {}),
          ...(clave.exenta ? { OperacionExenta: clave.exenta } : {}),
          BaseImponibleOimporteNoSujeto: '',
        },
        base: 0,
        cuota: 0,
        cuotaRe: 0,
      };
      if (clave.tipo !== undefined) g.d.TipoImpositivo = tipoAeat(clave.tipo);
      if (clave.tipoRe !== undefined) g.d.TipoRecargoEquivalencia = tipoAeat(clave.tipoRe);
      grupos.set(k, g);
    }
    g.base += b.base_cents;
    if (clave.calif === 'S1') {
      g.cuota += b.quota_cents;
      if (clave.tipoRe !== undefined) g.cuotaRe += b.re_cents ?? 0;
    }
  };
  for (const b of desgloseFactura(inv)) {
    switch (inv.vat_regime) {
      case 'exento_export_art21':
        anade({ ClaveRegimen: '02', exenta: 'E2' }, b);
        break;
      case 'exento_intracom_art25':
        anade({ ClaveRegimen: '01', exenta: 'E5' }, b);
        break;
      case 'exento_otros':
        anade({ ClaveRegimen: '01', exenta: 'E6' }, b);
        break;
      case 'inversion_sujeto_pasivo':
        if (extranjero) anade({ ClaveRegimen: '01', calif: 'N2' }, b);
        else anade({ ClaveRegimen: '01', calif: 'S2', tipo: 0 }, b);
        break;
      case 'no_sujeto':
        anade({ ClaveRegimen: '01', calif: extranjero ? 'N2' : 'N1' }, b);
        break;
      default: {
        // General y recargo de equivalencia. Con recargo calculado, clave 18;
        // sin él (Skyway aún no lo calcula), la factura es de régimen general.
        const conRe = inv.vat_regime === 'recargo_equivalencia' && !!b.re_rate && b.re_cents !== undefined;
        if (b.rate > 0) anade({ ClaveRegimen: conRe ? '18' : '01', calif: 'S1', tipo: b.rate, ...(conRe ? { tipoRe: b.re_rate } : {}) }, b);
        // Un 0 % en régimen general no es un tipo del IVA: es un importe no
        // sujeto (un suplido, por ejemplo), que la AEAT pide como N1.
        else anade({ ClaveRegimen: '01', calif: 'N1' }, b);
      }
    }
  }
  if (grupos.size === 0) anade({ ClaveRegimen: '01', calif: 'N1' }, { rate: 0, base_cents: 0, quota_cents: 0 });
  if (grupos.size > 12) throw new ErrorVerifactu('La factura tiene más de 12 combinaciones de régimen y tipo de IVA, el máximo de un registro.');
  return [...grupos.values()].map(({ d, base, cuota, cuotaRe }) => ({
    ...d,
    BaseImponibleOimporteNoSujeto: importeAeat(base),
    // La cuota solo existe en las operaciones sujetas y no exentas (1237, 1238);
    // con inversión del sujeto pasivo va a cero (1198).
    ...(d.CalificacionOperacion === 'S1' ? { CuotaRepercutida: importeAeat(cuota) } : {}),
    ...(d.CalificacionOperacion === 'S2' ? { CuotaRepercutida: importeAeat(0) } : {}),
    ...(d.TipoRecargoEquivalencia !== undefined ? { CuotaRecargoEquivalencia: importeAeat(cuotaRe) } : {}),
  }));
}

/** Suma en céntimos de un campo de importe del desglose. */
const suma = (det: DetalleDesglose[], campo: 'BaseImponibleOimporteNoSujeto' | 'CuotaRepercutida' | 'CuotaRecargoEquivalencia'): number =>
  det.reduce((s, d) => s + Math.round(Number(d[campo] ?? '0') * 100), 0);

/** Descripción de la operación (obligatoria, hasta 500 caracteres). */
function descripcion(inv: InvoiceRow, original: InvoiceRow | undefined): string {
  if (inv.invoice_type === 'rectificativa') {
    return textoAeat(`Rectificación de la factura ${original?.number ?? ''}: ${inv.rectify_reason ?? ''}`, 500) || 'Rectificación de factura';
  }
  const conceptos = [...new Set(lineas(inv).map((l) => (l.label ?? '').trim()).filter(Boolean))];
  return textoAeat(conceptos.join('; '), 500) || textoAeat(inv.plan_name, 500) || 'Prestación de servicios';
}

/** Mismo día natural (UTC, como la fecha impresa) o posterior. */
const diaUtc = (ms: number): number => Math.floor(ms / 86_400_000);

export interface OpcionesAlta {
  /**
   * Comprueba los datos del cliente y de la operación y falla con un mensaje
   * para el operador si la AEAT fuera a rechazar el registro. Lo usan los
   * caminos de emisión deliberados; el cobro por webhook no se bloquea nunca.
   */
  estricto: boolean;
  /**
   * Subsanación de un registro anterior de la misma factura. `rechazoPrevio`:
   * «X» si la AEAT no tiene ningún alta de la factura (todas rechazadas), «S»
   * si lo rechazado fue la subsanación de un alta que sí tiene, null si el alta
   * se aceptó con errores (validaciones de la AEAT, anexo 6.1, y error 1153).
   */
  subsanacion?: { rechazoPrevio: 'S' | 'X' | null };
  ahora?: number;
  entorno?: EntornoVerifactu;
}

/** Campos del registro de alta que salen de la factura (sin cadena, huella ni fecha de generación). */
export function camposAlta(inv: InvoiceRow, opts: Pick<OpcionesAlta, 'estricto' | 'subsanacion'>): Omit<
  RegistroAltaAeat,
  'Encadenamiento' | 'SistemaInformatico' | 'FechaHoraHusoGenRegistro' | 'Huella'
> {
  if (!inv.issued_at) throw new ErrorVerifactu('La factura no tiene fecha de expedición.');
  const { nif, nombre } = emisor(inv);
  if (!nifValido(nif)) throw new ErrorVerifactu('El NIF del emisor no es válido: corrígelo en Contabilidad → Datos de la empresa emisora.');
  if (!nombre) throw new ErrorVerifactu('Falta la razón social del emisor.');
  const original = inv.rectifies_invoice_id ? getInvoice(inv.rectifies_invoice_id) : undefined;
  const tipo = tipoFactura(inv, original);
  const fecha = fechaAeat(inv.issued_at);
  const det = desglose(inv);
  const cuotaTotal = suma(det, 'CuotaRepercutida') + suma(det, 'CuotaRecargoEquivalencia');
  // El importe total del registro es base + cuotas: la AEAT lo comprueba así
  // (1210, 2005), sin restar la retención de IRPF que sí resta el total a pagar.
  const importeTotal = suma(det, 'BaseImponibleOimporteNoSujeto') + cuotaTotal;
  const simplificada = tipo === 'F2' || tipo === 'R5';
  if (opts.estricto && inv.vat_regime === 'exento_intracom_art25' && (inv.client_country || 'ES').toUpperCase() === 'ES') {
    throw new ErrorVerifactu('La exención por entrega intracomunitaria exige un cliente de otro país de la UE con NIF-IVA.');
  }
  let fechaOperacion: string | undefined;
  if (inv.operation_date != null && Number.isFinite(inv.operation_date) && fechaAeat(inv.operation_date) !== fecha) {
    if (opts.estricto && diaUtc(inv.operation_date) > diaUtc(inv.issued_at)) {
      throw new ErrorVerifactu('La fecha de operación es posterior a la de expedición: la AEAT no lo admite en este tipo de factura. Quita la fecha de operación o emite la factura cuando se haya prestado el servicio.');
    }
    fechaOperacion = fechaAeat(inv.operation_date);
  }
  let rectificadas: IdFacturaAeat[] | undefined;
  if (inv.invoice_type === 'rectificativa') {
    if (!original?.number || !original.issued_at) throw new ErrorVerifactu('La factura rectificada no está emitida: no se puede registrar la rectificativa.');
    rectificadas = [{ IDEmisorFactura: emisor(original).nif, NumSerieFactura: original.number, FechaExpedicionFactura: fechaAeat(original.issued_at) }];
  }
  return {
    IDVersion: '1.0',
    IDFactura: { IDEmisorFactura: nif, NumSerieFactura: numSerie(inv), FechaExpedicionFactura: fecha },
    NombreRazonEmisor: nombre,
    ...(opts.subsanacion ? { Subsanacion: 'S' as const, ...(opts.subsanacion.rechazoPrevio ? { RechazoPrevio: opts.subsanacion.rechazoPrevio } : {}) } : {}),
    TipoFactura: tipo,
    // Las rectificativas de Skyway revierten la original y añaden lo correcto:
    // el importe es la diferencia, rectificación «por diferencias» (I).
    ...(rectificadas ? { TipoRectificativa: 'I' as const, FacturasRectificadas: rectificadas } : {}),
    ...(fechaOperacion ? { FechaOperacion: fechaOperacion } : {}),
    DescripcionOperacion: descripcion(inv, original),
    // Una simplificada de más de 3.000 € solo puede ser una factura completa sin
    // identificar al destinatario (art. 6.1.d del RD 1619/2012); sin la marca, la
    // AEAT la rechaza (1150).
    ...(tipo === 'F2' && importeTotal > LIMITE_F2_CENTS ? { FacturaSinIdentifDestinatarioArt61d: 'S' as const } : {}),
    ...(Math.abs(importeTotal) >= UMBRAL_MACRODATO_CENTS ? { Macrodato: 'S' as const } : {}),
    ...(simplificada ? {} : { Destinatarios: [destinatario(inv, nif, opts.estricto)] }),
    Desglose: det,
    CuotaTotal: importeAeat(cuotaTotal),
    ImporteTotal: importeAeat(importeTotal),
    TipoHuella: '01',
  };
}

/** Huella recalculada de un registro guardado, a partir de sus propios campos. */
export function huellaRecalculada(fila: RegistroFacturacionRow): string {
  const r = registroAeat(fila);
  if (r.tipo === 'alta') {
    const a = r.alta;
    return huellaAlta({
      idEmisorFactura: a.IDFactura.IDEmisorFactura,
      numSerieFactura: a.IDFactura.NumSerieFactura,
      fechaExpedicionFactura: a.IDFactura.FechaExpedicionFactura,
      tipoFactura: a.TipoFactura,
      cuotaTotal: a.CuotaTotal,
      importeTotal: a.ImporteTotal,
      huellaAnterior: a.Encadenamiento.RegistroAnterior?.Huella ?? '',
      fechaHoraHusoGenRegistro: a.FechaHoraHusoGenRegistro,
    });
  }
  const b = r.anulacion;
  return huellaAnulacion({
    idEmisorFacturaAnulada: b.IDFactura.IDEmisorFacturaAnulada,
    numSerieFacturaAnulada: b.IDFactura.NumSerieFacturaAnulada,
    fechaExpedicionFacturaAnulada: b.IDFactura.FechaExpedicionFacturaAnulada,
    huellaAnterior: b.Encadenamiento.RegistroAnterior?.Huella ?? '',
    fechaHoraHusoGenRegistro: b.FechaHoraHusoGenRegistro,
  });
}

/**
 * Encadenamiento con el último registro de la cadena del emisor, o primer
 * registro. Antes de encadenar se hacen las dos comprobaciones del art. 7.i de
 * la Orden HAC/1177/2024: que el último registro está bien encadenado (su
 * huella cuadra con sus datos) y que su fecha de generación no va más de un
 * minuto por delante del reloj actual. Si alguna falla no se genera nada: un
 * registro encadenado a otro dañado, o con la hora hacia atrás, rompería la
 * trazabilidad de todos los siguientes.
 */
function encadenar(nif: string, entorno: EntornoVerifactu, ahora: number): { enc: Encadenamiento; anterior: RegistroFacturacionRow | undefined } {
  const anterior = ultimoRegistroCadena(nif, entorno);
  if (!anterior) return { enc: { PrimerRegistro: 'S' }, anterior };
  if (huellaRecalculada(anterior) !== anterior.huella) {
    throw new ErrorVerifactu(
      `La cadena de registros de facturación está dañada: el último registro (${anterior.num_serie_factura}) no cuadra con su huella. No se puede emitir ni anular hasta revisarlo.`,
    );
  }
  if (anterior.created_at > ahora + 60_000) {
    throw new ErrorVerifactu('La hora del servidor va más de un minuto por detrás del último registro de facturación. Corrige el reloj del servidor antes de emitir o anular.');
  }
  const r = safeParse<{ tipo?: string; alta?: RegistroAltaAeat; anulacion?: RegistroAnulacionAeat }>(anterior.registro_json, {});
  // La fecha va tal como se escribió en el registro anterior: es la que entró
  // en su huella.
  const fecha = r.alta?.IDFactura.FechaExpedicionFactura ?? r.anulacion?.IDFactura.FechaExpedicionFacturaAnulada ?? fechaAeat(anterior.fecha_expedicion);
  return {
    enc: { RegistroAnterior: { IDEmisorFactura: anterior.emisor_nif, NumSerieFactura: anterior.num_serie_factura, FechaExpedicionFactura: fecha, Huella: anterior.huella } },
    anterior,
  };
}

/**
 * URL del QR de la factura: el servicio de cotejo de la AEAT con los cuatro
 * parámetros del registro, en el orden oficial (nif, numserie, fecha, importe).
 * Se codifican como el código de referencia de la AEAT (`URLEncoder` de Java,
 * application/x-www-form-urlencoded), que es exactamente lo que produce
 * `URLSearchParams`: «&» → %26, «/» → %2F, espacio → «+». El importe es el
 * `ImporteTotal` del registro tal cual: el cotejo lo compara con él.
 */
export function urlQr(entorno: EntornoVerifactu, alta: Pick<RegistroAltaAeat, 'IDFactura' | 'ImporteTotal'>): string {
  const q = new URLSearchParams();
  q.append('nif', alta.IDFactura.IDEmisorFactura);
  q.append('numserie', alta.IDFactura.NumSerieFactura);
  q.append('fecha', alta.IDFactura.FechaExpedicionFactura);
  q.append('importe', alta.ImporteTotal);
  return `${URL_COTEJO[entorno]}?${q.toString()}`;
}

/**
 * Genera e inserta el registro de alta de una factura recién emitida. Debe ir
 * en la misma transacción que la numera. Devuelve la fila insertada.
 */
export function registrarAlta(inv: InvoiceRow, opts: OpcionesAlta): RegistroFacturacionRow {
  const ahora = opts.ahora ?? Date.now();
  const entorno = opts.entorno ?? getAjustesVerifactu().entorno;
  const campos = camposAlta(inv, opts);
  const nif = campos.IDFactura.IDEmisorFactura;
  const { enc, anterior } = encadenar(nif, entorno, ahora);
  const fechaGen = fechaHoraHuso(ahora);
  const huella = huellaAlta({
    idEmisorFactura: nif,
    numSerieFactura: campos.IDFactura.NumSerieFactura,
    fechaExpedicionFactura: campos.IDFactura.FechaExpedicionFactura,
    tipoFactura: campos.TipoFactura,
    cuotaTotal: campos.CuotaTotal,
    importeTotal: campos.ImporteTotal,
    huellaAnterior: anterior?.huella ?? '',
    fechaHoraHusoGenRegistro: fechaGen,
  });
  const alta: RegistroAltaAeat = {
    ...campos,
    Encadenamiento: enc,
    SistemaInformatico: sistemaInformatico(),
    FechaHoraHusoGenRegistro: fechaGen,
    Huella: huella,
  };
  const fila: RegistroFacturacionRow = {
    id: id('vfr'),
    seq: (anterior?.seq ?? 0) + 1,
    invoice_id: inv.id,
    record_type: 'alta',
    emisor_nif: nif,
    num_serie_factura: alta.IDFactura.NumSerieFactura,
    fecha_expedicion: inv.issued_at!,
    tipo_factura: alta.TipoFactura,
    cuota_total_cents: Math.round(Number(alta.CuotaTotal) * 100),
    importe_total_cents: Math.round(Number(alta.ImporteTotal) * 100),
    fecha_hora_gen: fechaGen,
    huella,
    huella_anterior: anterior?.huella ?? null,
    sif_mode: 'verifactu',
    firma: null,
    qr_url: urlQr(entorno, alta),
    estado_remision: 'pendiente',
    csv_aeat: null,
    version_sif: config.version,
    created_at: ahora,
    entorno,
    registro_json: JSON.stringify({ tipo: 'alta', alta } satisfies RegistroAeat),
    subsanacion: opts.subsanacion ? 1 : 0,
    // Sin certificado no se puede remitir al generarlo: nace con incidencia.
    incidencia: infoCertificado() ? 0 : 1,
    intentos: 0,
    ultimo_intento_at: null,
    respuesta_at: null,
    codigo_error: null,
    descripcion_error: null,
    id_peticion: null,
  };
  insertarRegistroFacturacion(fila);
  return fila;
}

/** Último registro de alta de la factura (el que vale para el QR), si lo hay. */
export function ultimaAlta(invoiceId: string): RegistroFacturacionRow | undefined {
  return registrosDeFactura(invoiceId)
    .filter((r) => r.record_type === 'alta')
    .at(-1);
}

/**
 * Genera el registro de anulación de una factura emitida (validaciones de la
 * AEAT, 6.2, «Operativas de anulación admisibles»):
 * - Con registro de alta: en la cadena y el entorno de ese alta, que es la AEAT
 *   que lo recibió; aunque el modo esté ya desactivado.
 * - Sin registro de alta (emitida antes de activar VERI*FACTU): solo con el modo
 *   activo, con `SinRegistroPrevio=S`, porque la AEAT no la tiene. Es opcional
 *   para la AEAT («si así lo necesita» el SIF): si los datos de esa factura
 *   antigua no valen para un registro, no se genera nada en vez de bloquear la
 *   anulación.
 * - `SinRegistroPrevio=S` también si ningún alta de la factura llegó a
 *   aceptarse, y `RechazoPrevio=S` si repite una anulación rechazada.
 */
export function registrarAnulacion(inv: InvoiceRow, opts: { ahora?: number } = {}): RegistroFacturacionRow | null {
  const registros = registrosDeFactura(inv.id);
  if (registros.some((r) => r.record_type === 'anulacion' && r.estado_remision !== 'incorrecto')) return null;
  const altas = registros.filter((r) => r.record_type === 'alta');
  const alta = altas.at(-1);
  let nif: string;
  let numero: string;
  let fecha: string;
  let fechaMs: number;
  let entorno: EntornoVerifactu;
  if (alta) {
    const datosAlta = safeParse<{ alta?: RegistroAltaAeat }>(alta.registro_json, {}).alta;
    nif = alta.emisor_nif;
    numero = alta.num_serie_factura;
    fecha = datosAlta?.IDFactura.FechaExpedicionFactura ?? fechaAeat(alta.fecha_expedicion);
    fechaMs = alta.fecha_expedicion;
    entorno = alta.entorno;
  } else {
    if (!verifactuActivo() || !inv.number || !inv.issued_at) return null;
    try {
      nif = emisor(inv).nif;
      if (!nifValido(nif)) return null;
      numero = numSerie(inv);
    } catch (err) {
      if (err instanceof ErrorVerifactu) return null;
      throw err;
    }
    fecha = fechaAeat(inv.issued_at);
    fechaMs = inv.issued_at;
    entorno = getAjustesVerifactu().entorno;
  }
  const ahora = opts.ahora ?? Date.now();
  const { enc, anterior } = encadenar(nif, entorno, ahora);
  const fechaGen = fechaHoraHuso(ahora);
  const huella = huellaAnulacion({
    idEmisorFacturaAnulada: nif,
    numSerieFacturaAnulada: numero,
    fechaExpedicionFacturaAnulada: fecha,
    huellaAnterior: anterior?.huella ?? '',
    fechaHoraHusoGenRegistro: fechaGen,
  });
  const sinRegistroPrevio = altas.every((r) => r.estado_remision === 'incorrecto');
  const rechazoPrevio = registros.some((r) => r.record_type === 'anulacion' && r.estado_remision === 'incorrecto');
  const anulacion: RegistroAnulacionAeat = {
    IDVersion: '1.0',
    IDFactura: { IDEmisorFacturaAnulada: nif, NumSerieFacturaAnulada: numero, FechaExpedicionFacturaAnulada: fecha },
    ...(sinRegistroPrevio ? { SinRegistroPrevio: 'S' as const } : {}),
    ...(rechazoPrevio ? { RechazoPrevio: 'S' as const } : {}),
    Encadenamiento: enc,
    SistemaInformatico: sistemaInformatico(),
    FechaHoraHusoGenRegistro: fechaGen,
    TipoHuella: '01',
    Huella: huella,
  };
  const fila: RegistroFacturacionRow = {
    id: id('vfr'),
    seq: (anterior?.seq ?? 0) + 1,
    invoice_id: inv.id,
    record_type: 'anulacion',
    emisor_nif: nif,
    num_serie_factura: numero,
    fecha_expedicion: fechaMs,
    tipo_factura: null,
    cuota_total_cents: null,
    importe_total_cents: null,
    fecha_hora_gen: fechaGen,
    huella,
    huella_anterior: anterior?.huella ?? null,
    sif_mode: 'verifactu',
    firma: null,
    qr_url: null,
    estado_remision: 'pendiente',
    csv_aeat: null,
    version_sif: config.version,
    created_at: ahora,
    entorno,
    registro_json: JSON.stringify({ tipo: 'anulacion', anulacion } satisfies RegistroAeat),
    subsanacion: 0,
    incidencia: infoCertificado() ? 0 : 1,
    intentos: 0,
    ultimo_intento_at: null,
    respuesta_at: null,
    codigo_error: null,
    descripcion_error: null,
    id_peticion: null,
  };
  insertarRegistroFacturacion(fila);
  return fila;
}

/** El registro guardado, con los campos de la AEAT. */
export function registroAeat(fila: RegistroFacturacionRow): RegistroAeat {
  const r = safeParse<RegistroAeat | null>(fila.registro_json, null);
  if (!r || (r.tipo !== 'alta' && r.tipo !== 'anulacion')) throw new Error(`Registro de facturación ${fila.id} sin datos de la AEAT`);
  return r;
}

/** Lo que el panel enseña de los registros de una factura. */
export interface ResumenVerifactu {
  /** Estado del último registro de la factura. */
  estado: EstadoRemision;
  tipo: 'alta' | 'anulacion';
  entorno: EntornoVerifactu;
  csv: string | null;
  codigoError: string | null;
  descripcionError: string | null;
  /** URL del QR (último alta). */
  qrUrl: string | null;
  huella: string;
  /** Qué se puede hacer con un registro rechazado o aceptado con errores. */
  accion: 'subsanar' | 'repetir_anulacion' | null;
  registros: number;
}

export function resumenRegistros(registros: RegistroFacturacionRow[]): ResumenVerifactu | null {
  const ultimo = registros.at(-1);
  if (!ultimo) return null;
  const alta = registros.filter((r) => r.record_type === 'alta').at(-1);
  const conError = ultimo.estado_remision === 'incorrecto' || ultimo.estado_remision === 'aceptado_con_errores';
  return {
    estado: ultimo.estado_remision,
    tipo: ultimo.record_type,
    entorno: ultimo.entorno,
    csv: ultimo.csv_aeat,
    codigoError: ultimo.codigo_error,
    descripcionError: ultimo.descripcion_error,
    qrUrl: alta?.qr_url ?? null,
    huella: ultimo.huella,
    accion: ultimo.record_type === 'alta' && conError ? 'subsanar' : ultimo.record_type === 'anulacion' && ultimo.estado_remision === 'incorrecto' ? 'repetir_anulacion' : null,
    registros: registros.length,
  };
}

/**
 * Subsana el registro de una factura que la AEAT rechazó o aceptó con errores:
 * un registro nuevo (con su huella, al final de la cadena) con los datos de la
 * factura y la marca de subsanación. Si lo rechazado era un alta, lleva
 * además «RechazoPrevio». Una anulación rechazada se repite. Los datos de la
 * factura emitida no cambian: si el error está en ellos, el camino es una
 * rectificativa.
 */
export function subsanarRegistro(invoiceId: string, ahora: number = Date.now()): RegistroFacturacionRow {
  return transaction(() => {
    const inv = getInvoice(invoiceId);
    if (!inv) throw new ErrorVerifactu('Factura no encontrada.');
    const resumen = resumenRegistros(registrosDeFactura(invoiceId));
    if (!resumen?.accion) throw new ErrorVerifactu('El último registro de esta factura no tiene nada que subsanar.');
    if (resumen.accion === 'repetir_anulacion') {
      const fila = registrarAnulacion(inv, { ahora });
      if (!fila) throw new ErrorVerifactu('No se ha podido generar el registro de anulación.');
      anotarEvento('subsanacion', `Repetida la anulación de la factura ${inv.number ?? inv.id}`, ahora);
      return fila;
    }
    const altas = registrosDeFactura(invoiceId).filter((r) => r.record_type === 'alta');
    const aceptada = altas.some((r) => r.estado_remision === 'correcto' || r.estado_remision === 'aceptado_con_errores');
    // «X»: la AEAT no tiene el alta (todas rechazadas). «S»: tiene un alta y se
    // rechazó su subsanación. Sin marca: el alta está aceptada con errores.
    const rechazoPrevio = !aceptada ? 'X' : resumen.estado === 'incorrecto' ? 'S' : null;
    const fila = registrarAlta(inv, { estricto: false, subsanacion: { rechazoPrevio }, ahora, entorno: resumen.entorno });
    anotarEvento('subsanacion', `Subsanado el registro de alta de la factura ${inv.number ?? inv.id}`, ahora);
    return fila;
  });
}
