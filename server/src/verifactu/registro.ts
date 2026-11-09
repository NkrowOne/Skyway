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
import { fireAlert } from '../alerts';
import {
  getInvoice,
  insertarRegistroFacturacion,
  registroDeCadena,
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
import { cadenaEnIncidencia } from './estadocola';
import { fechaAeat, fechaExpedicionIso, fechaHoraHuso, importeAeat, isoAAeat, nifValido, normalizarNif, textoAeat, tipoAeat } from './formato';
import { paisAeat } from './paises';
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

/**
 * Estructura del NIF-IVA de cada Estado miembro (validaciones de la AEAT,
 * nota 1), con su prefijo de país. Grecia usa «EL». Un identificador que no la
 * cumple no es un NIF-IVA: es el documento de un particular o de una empresa
 * no registrada a efectos de IVA intracomunitario.
 */
const ESTRUCTURA_NIF_IVA: Record<string, RegExp> = {
  AT: /^AT[0-9A-Z]{9}$/,
  BE: /^BE\d{10}$/,
  BG: /^BG\d{9,10}$/,
  CY: /^CY[0-9A-Z]{9}$/,
  CZ: /^CZ\d{8,10}$/,
  DE: /^DE\d{9}$/,
  DK: /^DK\d{8}$/,
  EE: /^EE\d{9}$/,
  FI: /^FI\d{8}$/,
  FR: /^FR[0-9A-Z]{11}$/,
  GR: /^EL\d{9}$/,
  HR: /^HR\d{11}$/,
  HU: /^HU\d{8}$/,
  IE: /^IE[0-9A-Z]{8,9}$/,
  IT: /^IT\d{11}$/,
  LT: /^LT(\d{9}|\d{12})$/,
  LU: /^LU\d{8}$/,
  LV: /^LV\d{11}$/,
  MT: /^MT\d{8}$/,
  NL: /^NL[0-9A-Z]{12}$/,
  PL: /^PL\d{10}$/,
  PT: /^PT\d{9}$/,
  RO: /^RO[1-9]\d{1,9}$/,
  SE: /^SE\d{12}$/,
  SI: /^SI\d{8}$/,
  SK: /^SK\d{10}$/,
};

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

/** Fecha de expedición del registro (dd-mm-aaaa): la que imprime la factura. */
function fechaExpedicionAeat(inv: InvoiceRow): string {
  return isoAAeat(fechaExpedicionIso(inv) ?? '');
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

/** NIF de una persona física: DNI, NIE o los K, L y M de quien no tiene DNI. */
const nifPersonaFisica = (nif: string): boolean => /^(\d{8}|[XYZKLM]\d{7})[A-Z]$/.test(nif);

interface OpcionesDestinatario {
  estricto: boolean;
  /** El régimen exige que el cliente de la UE sea empresa con NIF-IVA (E5, o N2 a una empresa de la UE). */
  exigeNifIva: boolean;
  /**
   * Subsanación de un 2001 (NIF no censado): un NIF de persona física se
   * declara como «no censado» (IDOtro, IDType 07, país ES), como indican las
   * validaciones de la AEAT (4.3.1).
   */
  noCensado?: boolean;
}

/**
 * Destinatario de la factura: NIF si es español; NIF-IVA si es de la UE y lo
 * tiene; si no, el documento de su país de residencia (IDType 04).
 */
function destinatario(inv: InvoiceRow, nifEmisor: string, opts: OpcionesDestinatario): PersonaAeat {
  const nombre = textoAeat(inv.client_name, 120);
  if (!nombre) throw new ErrorVerifactu('Falta el nombre del cliente, obligatorio en el registro de una factura completa.');
  const paisBruto = (inv.client_country || 'ES').trim().toUpperCase();
  const pais = paisAeat(paisBruto);
  if (!pais && opts.estricto) {
    throw new ErrorVerifactu(`El país del cliente («${paisBruto}») no es un código que admita la AEAT. Corrígelo en la ficha de la cuenta (por ejemplo, GB y no UK).`);
  }
  const codigo = pais ?? paisBruto;
  const bruto = (inv.client_tax_id ?? '').trim();
  if (codigo === 'ES') {
    const nif = normalizarNif(bruto);
    if (opts.estricto && !nifValido(nif)) {
      throw new ErrorVerifactu(`El NIF del cliente («${bruto || 'vacío'}») no es un NIF español válido. Corrígelo en la ficha de la cuenta o, si es de otro país, indica su país.`);
    }
    if (opts.estricto && nif === nifEmisor) throw new ErrorVerifactu('El NIF del cliente es el mismo que el del emisor.');
    if (opts.noCensado && nifPersonaFisica(nif)) return { NombreRazon: nombre, IDOtro: { CodigoPais: 'ES', IDType: '07', ID: nif } };
    return { NombreRazon: nombre, NIF: nif };
  }
  const id = bruto.toUpperCase().replace(/[\s.\-/]/g, '');
  if (!id) throw new ErrorVerifactu('Falta el número de identificación fiscal del cliente extranjero.');
  const estructura = ESTRUCTURA_NIF_IVA[codigo];
  if (estructura) {
    const prefijo = codigo === 'GR' ? 'EL' : codigo;
    const nifIva = id.startsWith(prefijo) ? id : `${prefijo}${id}`;
    // Sin código de país: con IDType 02 el país va en el propio NIF-IVA, y
    // ponerlo obliga a que coincida con su prefijo (1122), que en Grecia es EL.
    if (estructura.test(nifIva)) return { NombreRazon: nombre, IDOtro: { IDType: '02', ID: nifIva } };
    if (opts.estricto && opts.exigeNifIva) {
      throw new ErrorVerifactu(
        `El NIF-IVA del cliente («${bruto}») no tiene la estructura de los de su país. Una entrega intracomunitaria exenta o un servicio no sujeto a una empresa de la UE lo exigen: corrígelo en la ficha de la cuenta.`,
      );
    }
  }
  return { NombreRazon: nombre, IDOtro: { CodigoPais: codigo, IDType: '04', ID: id.slice(0, 20) } };
}

/**
 * Tipos de IVA que la AEAT admite en una operación sujeta y no exenta (S1),
 * según la fecha de la operación (validaciones, 15.1).
 */
function tipoAdmitido(rate: number, fechaIso: string): boolean {
  const r = Math.round(rate * 100) / 100;
  if (r === 0 || r === 4 || r === 10 || r === 21) return true;
  if (r === 5) return fechaIso >= '2022-07-01' && fechaIso <= '2024-09-30';
  if (r === 2 || r === 7.5) return fechaIso >= '2024-10-01' && fechaIso <= '2024-12-31';
  return false;
}

/**
 * Desglose por régimen y tipo. La clave de cada línea sale del régimen de IVA
 * de la factura (y, en la inversión del sujeto pasivo y la no sujeción, del
 * país del cliente: un servicio a una empresa de otro país no está sujeto al
 * IVA español por las reglas de localización, N2).
 */
function desglose(inv: InvoiceRow, fechaRefIso: string, estricto: boolean): DetalleDesglose[] {
  const extranjero = (paisAeat(inv.client_country || 'ES') ?? (inv.client_country || 'ES').toUpperCase()) !== 'ES';
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
        // Un 0 % es un tipo del IVA más (S1 al 0 %, validaciones 15.1): no es un
        // suplido, que no entra en el registro (FAQ de desarrolladores, n.º 21).
        if (estricto && !tipoAdmitido(b.rate, fechaRefIso)) {
          throw new ErrorVerifactu(`La AEAT no admite un IVA del ${tipoAeat(b.rate).replace('.', ',')} % en una operación de esa fecha: los tipos vigentes son 0, 4, 10 y 21 %.`);
        }
        const conRe = inv.vat_regime === 'recargo_equivalencia' && !!b.re_rate && b.re_cents !== undefined;
        anade({ ClaveRegimen: conRe ? '18' : '01', calif: 'S1', tipo: b.rate, ...(conRe ? { tipoRe: b.re_rate } : {}) }, b);
      }
    }
  }
  if (grupos.size === 0) anade({ ClaveRegimen: '01', calif: 'S1', tipo: 0 }, { rate: 0, base_cents: 0, quota_cents: 0 });
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
   * `noCensado`: el error era un NIF de cliente no censado (2001).
   */
  subsanacion?: { rechazoPrevio: 'S' | 'X' | null; noCensado?: boolean };
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
  // Los importes del registro, de los totales de la AEAT y del QR son en euros
  // (art. 12.1 del RD 1619/2012): Skyway no convierte otras monedas.
  if (opts.estricto && (inv.currency || 'EUR').toUpperCase() !== 'EUR') {
    throw new ErrorVerifactu(`VERI*FACTU exige los importes en euros y esta factura está en ${inv.currency}. Emítela en euros.`);
  }
  const original = inv.rectifies_invoice_id ? getInvoice(inv.rectifies_invoice_id) : undefined;
  const tipo = tipoFactura(inv, original);
  const fechaIso = fechaExpedicionIso(inv)!;
  const fecha = isoAAeat(fechaIso);
  let fechaOperacion: string | undefined;
  let fechaRefIso = fechaIso;
  if (inv.operation_date != null && Number.isFinite(inv.operation_date)) {
    // La fecha de operación es una fecha sin hora (medianoche UTC del día elegido).
    const opIso = new Date(inv.operation_date).toISOString().slice(0, 10);
    if (opIso !== fechaIso) {
      if (opts.estricto && opIso > fechaIso) {
        throw new ErrorVerifactu('La fecha de operación es posterior a la de expedición: la AEAT no lo admite en este tipo de factura. Quita la fecha de operación o emite la factura cuando se haya prestado el servicio.');
      }
      fechaOperacion = isoAAeat(opIso);
      fechaRefIso = opIso;
    }
  }
  const det = desglose(inv, fechaRefIso, opts.estricto);
  const cuotaTotal = suma(det, 'CuotaRepercutida') + suma(det, 'CuotaRecargoEquivalencia');
  // El importe total del registro es base + cuotas: la AEAT lo comprueba así
  // (1210, 2005), sin restar la retención de IRPF que sí resta el total a pagar.
  const importeTotal = suma(det, 'BaseImponibleOimporteNoSujeto') + cuotaTotal;
  const simplificada = tipo === 'F2' || tipo === 'R5';
  const paisCliente = paisAeat(inv.client_country || 'ES') ?? (inv.client_country || 'ES').toUpperCase();
  if (opts.estricto && inv.vat_regime === 'exento_intracom_art25' && paisCliente === 'ES') {
    throw new ErrorVerifactu('La exención por entrega intracomunitaria exige un cliente de otro país de la UE con NIF-IVA.');
  }
  let rectificadas: IdFacturaAeat[] | undefined;
  if (inv.invoice_type === 'rectificativa') {
    if (!original?.number || !original.issued_at) throw new ErrorVerifactu('La factura rectificada no está emitida: no se puede registrar la rectificativa.');
    const nifOriginal = emisor(original).nif;
    if (opts.estricto && !nifValido(nifOriginal)) {
      throw new ErrorVerifactu(`La factura rectificada se emitió con un NIF de emisor que no es válido («${nifOriginal}»): la AEAT rechazaría la rectificativa.`);
    }
    rectificadas = [{ IDEmisorFactura: nifOriginal, NumSerieFactura: original.number, FechaExpedicionFactura: fechaExpedicionAeat(original) }];
  }
  const exigeNifIva =
    inv.vat_regime === 'exento_intracom_art25' || ((inv.vat_regime === 'inversion_sujeto_pasivo' || inv.vat_regime === 'no_sujeto') && paisCliente !== 'ES');
  const dest = simplificada ? undefined : destinatario(inv, nif, { estricto: opts.estricto, exigeNifIva, noCensado: opts.subsanacion?.noCensado });
  // Restricciones de la AEAT al destinatario de algunas rectificativas (1191, 1192).
  if (opts.estricto && dest?.IDOtro) {
    if (tipo === 'R3' && dest.IDOtro.IDType !== '07') {
      throw new ErrorVerifactu('Una rectificativa por créditos incobrables (R3) solo admite clientes con NIF español.');
    }
    if (tipo === 'R2' && dest.IDOtro.IDType !== '02' && dest.IDOtro.IDType !== '07') {
      throw new ErrorVerifactu('Una rectificativa por concurso de acreedores (R2) solo admite clientes con NIF español o NIF-IVA de la UE.');
    }
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
    ...(dest ? { Destinatarios: [dest] } : {}),
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

/** Fecha (dd-mm-aaaa) con la que un registro identifica su factura: la que entró en su huella. */
function fechaDeRegistro(fila: RegistroFacturacionRow): string {
  const r = safeParse<{ alta?: RegistroAltaAeat; anulacion?: RegistroAnulacionAeat }>(fila.registro_json, {});
  return r.alta?.IDFactura.FechaExpedicionFactura ?? r.anulacion?.IDFactura.FechaExpedicionFacturaAnulada ?? fechaAeat(fila.fecha_expedicion);
}

/**
 * Comprobación 1.ª del art. 7.i de la Orden, como la explica la AEAT (FAQ de
 * desarrolladores, 15.1): el `RegistroAnterior` del último registro tiene que
 * apuntar al penúltimo (su NIF, número, fecha y huella), y solo el primero de
 * la cadena va marcado como primero. Además se recalcula la huella del último
 * con sus propios datos. Devuelve las anomalías encontradas.
 */
export function anomaliasCadena(ultimo: RegistroFacturacionRow): string[] {
  const out: string[] = [];
  const nombre = `${ultimo.num_serie_factura} (n.º ${ultimo.seq} de la cadena)`;
  if (huellaRecalculada(ultimo) !== ultimo.huella) out.push(`la huella del registro ${nombre} no cuadra con sus datos`);
  const r = registroAeat(ultimo);
  const enc = r.tipo === 'alta' ? r.alta.Encadenamiento : r.anulacion.Encadenamiento;
  if (ultimo.seq === 1) {
    if (!enc.PrimerRegistro) out.push(`el registro ${nombre} es el primero de la cadena y no está marcado como tal`);
    return out;
  }
  const previo = registroDeCadena(ultimo.emisor_nif, ultimo.entorno, ultimo.seq - 1);
  const ra = enc.RegistroAnterior;
  if (!previo) out.push(`falta el registro n.º ${ultimo.seq - 1} de la cadena`);
  else if (!ra) out.push(`el registro ${nombre} está marcado como primero sin serlo`);
  else if (ra.Huella !== previo.huella || ra.NumSerieFactura !== previo.num_serie_factura || ra.IDEmisorFactura !== previo.emisor_nif || ra.FechaExpedicionFactura !== fechaDeRegistro(previo)) {
    out.push(`el registro ${nombre} no apunta al registro anterior de la cadena`);
  }
  return out;
}

/**
 * Encadenamiento con el último registro de la cadena del emisor, o primer
 * registro, con las dos comprobaciones del art. 7.i de la Orden HAC/1177/2024:
 * - Una anomalía en el encadenamiento del último registro NO detiene la
 *   facturación («la facturación por este motivo NUNCA debe interrumpirse»,
 *   FAQ de desarrolladores, 15.2): se anota en el registro de eventos, se avisa
 *   y el registro nuevo se encadena con el último, como siempre.
 * - Lo que no se admite es generar un registro con fecha y hora más de un
 *   minuto anterior a la del último (FAQ, 15.3): eso sí se bloquea, porque es el
 *   reloj del servidor el que hay que corregir.
 */
function encadenar(nif: string, entorno: EntornoVerifactu, ahora: number): { enc: Encadenamiento; anterior: RegistroFacturacionRow | undefined } {
  const anterior = ultimoRegistroCadena(nif, entorno);
  if (!anterior) return { enc: { PrimerRegistro: 'S' }, anterior };
  if (anterior.created_at > ahora + 60_000) {
    throw new ErrorVerifactu('La hora del servidor va más de un minuto por detrás del último registro de facturación. Corrige el reloj del servidor antes de emitir o anular.');
  }
  const anomalias = anomaliasCadena(anterior);
  if (anomalias.length > 0) {
    const detalle = `Cadena ${entorno} ${nif}: ${anomalias.join('; ')}`;
    anotarEvento('anomalia_cadena', detalle, ahora);
    fireAlert({
      severity: 'critical',
      type: 'verifactu_cadena',
      title: 'Anomalía en la cadena de registros de facturación',
      message: detalle.slice(0, 300),
      explanation:
        'La facturación sigue: el registro nuevo se encadena con el último, como indica la AEAT. Los registros no se pueden modificar desde Skyway, así que esto apunta a un cambio hecho directamente en la base de datos o a una copia restaurada: revisa los accesos al servidor y las copias de seguridad.',
      dedupeKey: `verifactu:cadena:${anterior.id}`,
    });
  }
  return {
    enc: { RegistroAnterior: { IDEmisorFactura: anterior.emisor_nif, NumSerieFactura: anterior.num_serie_factura, FechaExpedicionFactura: fechaDeRegistro(anterior), Huella: anterior.huella } },
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
    // Sin certificado, o con la cadena en medio de un corte, no se podrá remitir
    // a su hora: nace con incidencia (art. 16.4 de la Orden).
    incidencia: !infoCertificado() || cadenaEnIncidencia(nif, entorno, ahora) ? 1 : 0,
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
    fecha = fechaExpedicionAeat(inv);
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
    incidencia: !infoCertificado() || cadenaEnIncidencia(nif, entorno, ahora) ? 1 : 0,
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
    // 2001: el NIF del cliente no está en el censo. Si es de persona física, se
    // declara «no censado» (validaciones de la AEAT, 4.3.1); repetir el mismo
    // NIF solo reproduciría el error.
    const noCensado = resumen.codigoError === '2001';
    const fila = registrarAlta(inv, { estricto: false, subsanacion: { rechazoPrevio, noCensado }, ahora, entorno: resumen.entorno });
    anotarEvento('subsanacion', `Subsanado el registro de alta de la factura ${inv.number ?? inv.id}`, ahora);
    return fila;
  });
}
