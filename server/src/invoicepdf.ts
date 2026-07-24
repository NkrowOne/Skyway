/**
 * Generador del PDF de una factura escrito a mano: emite un PDF 1.4 completo
 * (objetos, tabla xref con los offsets reales y trailer) sin ninguna librería,
 * con el mismo espíritu que `stripe.ts`, que habla con Stripe a pelo con `fetch`.
 *
 * Solo se usan las fuentes base14 Helvetica y Helvetica-Bold, que ningún visor
 * necesita que se incrusten, con /WinAnsiEncoding: es la única forma barata de
 * que salgan los acentos, la «ñ» y el símbolo del euro sin adjuntar una fuente.
 *
 * `renderInvoicePdf` es pura y reentrante: todo el estado de maquetación vive
 * dentro de la llamada, no toca disco ni lee configuración global, y el
 * documento resultante depende únicamente de los datos recibidos (por eso las
 * fechas se imprimen en UTC y no hay marca de tiempo de generación).
 */
import { deflateSync } from 'node:zlib';

export interface InvoicePdfData {
  number: string;
  invoiceType: 'normal' | 'simplificada' | 'rectificativa';
  issuedAt: number | null;      // ms epoch
  operationDate: number | null; // ms epoch
  periodStart: number;
  periodEnd: number;
  dueAt: number | null;
  currency: string;             // 'EUR'
  issuer: { companyName: string; taxId: string; address: string; email: string; phone: string };
  /** `country` ya viene resuelto a nombre legible («España»), no como código ISO. */
  client: { name: string; taxId: string | null; address: string | null; country?: string | null };
  lines: { label: string; qty: number; unitCents: number; amountCents: number; taxRate?: number }[];
  subtotalCents: number;
  taxBreakdown: { rate: number; base_cents: number; quota_cents: number }[];
  taxCents: number;
  irpfRate: number;
  irpfCents: number;
  totalCents: number;
  legalMentions: string | null;
  notes: string | null;
  paymentMethod: string | null;
  bank: { iban: string; bic: string; bankName: string };
  footer: string;
}

// ---------------------------------------------------------------------------
// Codificación WinAnsi (cp1252)
// ---------------------------------------------------------------------------

/**
 * cp1252 NO es Latin-1 en el tramo 0x80–0x9F: ahí es donde Windows metió los
 * signos «de imprenta» (€, comillas tipográficas, rayas…). Este mapa traduce
 * esos puntos Unicode al byte que espera /WinAnsiEncoding; el resto del rango
 * alto coincide con Latin-1 y se copia tal cual.
 */
const WINANSI_ALTOS: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Anchos de Helvetica (unidades/1000) indexados por byte WinAnsi. */
const ANCHOS_HELVETICA: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 0,
  556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
  0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667,
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];

/** Anchos de Helvetica-Bold (unidades/1000) indexados por byte WinAnsi. */
const ANCHOS_HELVETICA_BOLD: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 0,
  556, 0, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
  0, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 0, 500, 667,
  278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278,
  611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556,
];

/**
 * Pasa el texto de UTF-16 (lo que maneja JS) a bytes cp1252. Se normaliza a NFC
 * antes porque una «ó» descompuesta (o + tilde combinante) no tiene byte propio
 * y acabaría como «o?». Lo que sigue sin equivalente se sustituye por '?': es
 * preferible una interrogación a un PDF con bytes que el visor no sabe pintar.
 */
function aWinAnsi(texto: string): number[] {
  const bytes: number[] = [];
  for (const ch of texto.normalize('NFC')) {
    const cp = ch.codePointAt(0) ?? 0x3f;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) bytes.push(0x20);
    else if (cp >= 0x20 && cp <= 0x7e) bytes.push(cp);
    else if (cp >= 0xa0 && cp <= 0xff) bytes.push(cp);
    else bytes.push(WINANSI_ALTOS[cp] ?? 0x3f);
  }
  return bytes;
}

/**
 * Serializa el texto como cadena literal PDF. Los bytes no ASCII se escriben en
 * octal en lugar de en crudo para que el flujo de contenido siga siendo texto
 * plano y ningún byte suelto (un 0x0D, por ejemplo) se cuele como salto de línea.
 */
function cadena(texto: string): string {
  let salida = '(';
  for (const b of aWinAnsi(texto)) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) salida += `\\${String.fromCharCode(b)}`;
    else if (b < 0x20 || b > 0x7e) salida += `\\${b.toString(8).padStart(3, '0')}`;
    else salida += String.fromCharCode(b);
  }
  return `${salida})`;
}

/** Ancho del texto en puntos para un cuerpo dado, según las métricas de la base14. */
function anchoTexto(texto: string, tam: number, negrita: boolean): number {
  const tabla = negrita ? ANCHOS_HELVETICA_BOLD : ANCHOS_HELVETICA;
  let suma = 0;
  for (const b of aWinAnsi(texto)) suma += tabla[b] ?? 0;
  return (suma * tam) / 1000;
}

/** Recorta el texto al ancho disponible añadiendo «…» (nunca desborda la columna). */
function truncar(texto: string, max: number, tam: number, negrita: boolean): string {
  if (anchoTexto(texto, tam, negrita) <= max) return texto;
  // Sin hueco no cabe ni la elipsis: devolver «…» aquí la pintaría igualmente y
  // se solaparía con el texto de al lado, que es justo lo que se quería evitar.
  if (max <= 0) return '';
  const chars = Array.from(texto);
  while (chars.length > 0 && anchoTexto(`${chars.join('')}…`, tam, negrita) > max) chars.pop();
  return `${chars.join('').trimEnd()}…`;
}

/** Parte el texto en líneas que caben en `max` puntos, respetando los saltos existentes. */
function envolver(texto: string, max: number, tam: number, negrita: boolean): string[] {
  const lineas: string[] = [];
  for (const parrafo of texto.split(/\r?\n/)) {
    const palabras = parrafo.split(/\s+/).filter(Boolean);
    if (palabras.length === 0) {
      lineas.push('');
      continue;
    }
    let actual = '';
    for (const palabra of palabras) {
      const tentativa = actual ? `${actual} ${palabra}` : palabra;
      if (anchoTexto(tentativa, tam, negrita) <= max) {
        actual = tentativa;
        continue;
      }
      if (actual) lineas.push(actual);
      actual = palabra;
      // Una «palabra» más ancha que la caja (un IBAN o una URL sin espacios) hay
      // que partirla a lo bruto o se saldría del papel.
      while (anchoTexto(actual, tam, negrita) > max) {
        let corte = 1;
        while (corte < actual.length && anchoTexto(actual.slice(0, corte + 1), tam, negrita) <= max) corte++;
        lineas.push(actual.slice(0, corte));
        actual = actual.slice(corte);
      }
    }
    if (actual) lineas.push(actual);
  }
  return lineas;
}

// ---------------------------------------------------------------------------
// Formato español
// ---------------------------------------------------------------------------

/** Separador de millares con punto: 1234567 → «1.234.567». */
function conMillares(entero: string): string {
  return entero.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Céntimos → «1.234,56» (con signo si es negativo). */
function fmtCentimos(cents: number): string {
  const n = Math.round(Number.isFinite(cents) ? cents : 0);
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}${conMillares(String(Math.floor(abs / 100)))},${String(abs % 100).padStart(2, '0')}`;
}

/** Céntimos → «1.234,56 €» (o el código ISO si la moneda no es el euro). */
function fmtImporte(cents: number, moneda: string): string {
  return `${fmtCentimos(cents)} ${moneda === 'EUR' ? '€' : moneda}`;
}

/** Cantidades de línea: entera si lo es, con dos decimales y coma si no. */
function fmtCantidad(qty: number): string {
  if (!Number.isFinite(qty)) return '0';
  const redondeada = Math.round(qty * 100) / 100;
  return Number.isInteger(redondeada) ? String(redondeada) : redondeada.toFixed(2).replace('.', ',');
}

/** Tipos impositivos: «21», «10», «4», «21,5». */
function fmtTipo(rate: number): string {
  if (!Number.isFinite(rate)) return '0';
  const redondeado = Math.round(rate * 100) / 100;
  return Number.isInteger(redondeado) ? String(redondeado) : String(redondeado).replace('.', ',');
}

/**
 * Fecha dd/mm/aaaa en UTC. Se usa UTC a propósito: una factura es un documento
 * fiscal inmutable y debe imprimir siempre el mismo día independientemente de la
 * zona horaria del proceso que la genere, igual que hacen las exportaciones
 * contables (`routes/accounting.ts`).
 */
function fmtFecha(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const dia = String(d.getUTCDate()).padStart(2, '0');
  const mes = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dia}/${mes}/${d.getUTCFullYear()}`;
}

/** Fecha en el formato de metadatos PDF: D:AAAAMMDDHHmmSSZ. */
function fmtFechaPdf(ms: number): string {
  const d = new Date(ms);
  const p = (v: number): string => String(v).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** Números para el flujo de contenido: dos decimales, sin notación exponencial ni «-0». */
function n(valor: number): string {
  const v = Math.round((Number.isFinite(valor) ? valor : 0) * 100) / 100;
  return Object.is(v, -0) ? '0' : String(v);
}

// ---------------------------------------------------------------------------
// Geometría de la página
// ---------------------------------------------------------------------------

const PAGINA_ANCHO = 595.28;
const PAGINA_ALTO = 841.89;
const MARGEN = 48;
const ANCHO_UTIL = PAGINA_ANCHO - MARGEN * 2;
const X_DERECHA = MARGEN + ANCHO_UTIL;
const Y_INICIO = PAGINA_ALTO - MARGEN;
const Y_MINIMO = 80; // por debajo empieza la zona reservada al pie

// Bordes derechos de cada columna de la tabla (el concepto ocupa lo que sobra).
const COL_CONCEPTO_FIN = 286;
const COL_CANT_FIN = 330;
const COL_PRECIO_FIN = 404;
const COL_IVA_FIN = 452;
const COL_IMPORTE_FIN = X_DERECHA;

// El bloque de totales se alinea con la tabla, dejando el mismo aire a la derecha.
const X_TOTALES = 300;
const X_IMPORTE_TOTALES = COL_IMPORTE_FIN - 5;

const ALTO_FILA = 15;
// La cabecera (emisor y destinatario) es el único bloque que no pagina, así que
// una dirección con decenas de saltos de línea imprimiría texto fuera del papel:
// se recorta a las líneas que caben de sobra en cualquier dirección postal real.
const MAX_LINEAS_DIRECCION = 6;
const GRIS_TEXTO = 0.35;
const GRIS_LINEA = 0.78;
const GRIS_SOMBRA = 0.93;

const TITULOS: Record<InvoicePdfData['invoiceType'], string> = {
  normal: 'FACTURA',
  simplificada: 'FACTURA SIMPLIFICADA',
  rectificativa: 'FACTURA RECTIFICATIVA',
};

interface Pagina {
  ops: string[];
}

/** Documento PDF de la factura, listo para descargar o adjuntar a un correo. */
export function renderInvoicePdf(data: InvoicePdfData): Buffer {
  const moneda = (data.currency || 'EUR').toUpperCase();
  const titulo = TITULOS[data.invoiceType] ?? TITULOS.normal;

  // --- estado de maquetación (local: la función es reentrante) ---
  const paginas: Pagina[] = [];
  let pagina: Pagina = { ops: [] };
  let y = Y_INICIO; // línea base del siguiente texto

  const dibujaTexto = (x: number, base: number, texto: string, tam: number, negrita = false, gris = 0): void => {
    if (!texto) return;
    pagina.ops.push(`BT /${negrita ? 'F2' : 'F1'} ${n(tam)} Tf ${n(gris)} g ${n(x)} ${n(base)} Td ${cadena(texto)} Tj ET`);
  };
  const dibujaTextoDer = (derecha: number, base: number, texto: string, tam: number, negrita = false, gris = 0): void => {
    dibujaTexto(derecha - anchoTexto(texto, tam, negrita), base, texto, tam, negrita, gris);
  };
  const dibujaLinea = (x1: number, y1: number, x2: number, y2: number, grosor = 0.5, gris = GRIS_LINEA): void => {
    pagina.ops.push(`q ${n(gris)} G ${n(grosor)} w ${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S Q`);
  };
  const dibujaCaja = (x: number, base: number, ancho: number, alto: number, gris: number): void => {
    pagina.ops.push(`q ${n(gris)} g ${n(x)} ${n(base)} ${n(ancho)} ${n(alto)} re f Q`);
  };

  const nuevaPagina = (): void => {
    pagina = { ops: [] };
    paginas.push(pagina);
    y = Y_INICIO;
  };

  /** Cabecera reducida de las páginas de continuación. */
  const cabeceraContinuacion = (): void => {
    dibujaTexto(MARGEN, y - 10, truncar(`${titulo} ${data.number}`, 260, 10, true), 10, true);
    dibujaTextoDer(X_DERECHA, y - 10, truncar(`${data.issuer.companyName} · ${fmtFecha(data.issuedAt)}`, 220, 8, false), 8, false, GRIS_TEXTO);
    dibujaLinea(MARGEN, y - 18, X_DERECHA, y - 18);
    y -= 34;
  };

  const cabeceraTabla = (): void => {
    dibujaCaja(MARGEN, y - 5.5, ANCHO_UTIL, 17, GRIS_SOMBRA);
    dibujaTexto(MARGEN + 5, y, 'Concepto', 8.5, true);
    dibujaTextoDer(COL_CANT_FIN - 5, y, 'Cant.', 8.5, true);
    dibujaTextoDer(COL_PRECIO_FIN - 5, y, 'Precio', 8.5, true);
    dibujaTextoDer(COL_IVA_FIN - 5, y, 'IVA %', 8.5, true);
    dibujaTextoDer(COL_IMPORTE_FIN - 5, y, 'Importe', 8.5, true);
    y -= 22;
  };

  /**
   * Reserva `alto` puntos: si no caben, salta de página. `repiteTabla` vuelve a
   * pintar la cabecera de columnas, obligatorio cuando el salto ocurre en mitad
   * del detalle de líneas.
   */
  const asegura = (alto: number, repiteTabla = false): void => {
    if (y - alto >= Y_MINIMO) return;
    nuevaPagina();
    cabeceraContinuacion();
    if (repiteTabla) cabeceraTabla();
  };

  // --- primera página: emisor, título y datos de la factura ---
  nuevaPagina();

  dibujaTexto(MARGEN, y, truncar(data.issuer.companyName || '', 245, 14, true), 14, true);
  let yIzq = y - 18;
  const datosEmisor: string[] = [];
  if (data.issuer.taxId) datosEmisor.push(`NIF: ${data.issuer.taxId}`);
  const dirEmisor = data.issuer.address ? envolver(data.issuer.address, 250, 8.5, false) : [];
  for (const l of dirEmisor.slice(0, MAX_LINEAS_DIRECCION)) datosEmisor.push(l);
  if (data.issuer.email) datosEmisor.push(data.issuer.email);
  if (data.issuer.phone) datosEmisor.push(`Tel.: ${data.issuer.phone}`);
  for (const l of datosEmisor) {
    dibujaTexto(MARGEN, yIzq, truncar(l, 250, 8.5, false), 8.5, false, GRIS_TEXTO);
    yIzq -= 11;
  }

  dibujaTextoDer(X_DERECHA, y, titulo, anchoTexto(titulo, 19, true) > 300 ? 15 : 19, true);
  let yDer = y - 24;
  dibujaTextoDer(X_DERECHA, yDer, truncar(`Nº ${data.number}`, 240, 11, true), 11, true);
  yDer -= 15;
  const fechas: string[] = [];
  const expedicion = fmtFecha(data.issuedAt);
  if (expedicion) fechas.push(`Fecha de expedición: ${expedicion}`);
  const operacion = fmtFecha(data.operationDate);
  if (operacion) fechas.push(`Fecha de operación: ${operacion}`);
  const vencimiento = fmtFecha(data.dueAt);
  if (vencimiento) fechas.push(`Vencimiento: ${vencimiento}`);
  for (const l of fechas) {
    dibujaTextoDer(X_DERECHA, yDer, truncar(l, 240, 8.5, false), 8.5, false, GRIS_TEXTO);
    yDer -= 11;
  }

  y = Math.min(yIzq, yDer) - 8;
  dibujaLinea(MARGEN, y, X_DERECHA, y, 0.8, 0.6);
  y -= 20;

  // --- destinatario y periodo facturado ---
  dibujaTexto(MARGEN, y, 'FACTURAR A', 8, true, GRIS_TEXTO);
  dibujaTextoDer(X_DERECHA, y, 'PERIODO FACTURADO', 8, true, GRIS_TEXTO);
  yIzq = y - 15;
  yDer = y - 15;

  dibujaTexto(MARGEN, yIzq, truncar(data.client.name || '—', 250, 11, true), 11, true);
  yIzq -= 13;
  if (data.client.taxId) {
    dibujaTexto(MARGEN, yIzq, truncar(`NIF: ${data.client.taxId}`, 250, 9, false), 9, false, GRIS_TEXTO);
    yIzq -= 11;
  }
  if (data.client.address) {
    for (const l of envolver(data.client.address, 270, 9, false).slice(0, MAX_LINEAS_DIRECCION)) {
      dibujaTexto(MARGEN, yIzq, l, 9, false, GRIS_TEXTO);
      yIzq -= 11;
    }
  }
  // El país cierra el domicilio del destinatario, como en cualquier factura.
  if (data.client.country) {
    dibujaTexto(MARGEN, yIzq, truncar(data.client.country, 270, 9, false), 9, false, GRIS_TEXTO);
    yIzq -= 11;
  }

  dibujaTextoDer(X_DERECHA, yDer, `${fmtFecha(data.periodStart)} – ${fmtFecha(data.periodEnd)}`, 9.5, false);
  yDer -= 13;

  y = Math.min(yIzq, yDer) - 12;

  // --- tabla de líneas ---
  asegura(60);
  cabeceraTabla();
  const anchoConcepto = COL_CONCEPTO_FIN - MARGEN - 10;
  // Un importe absurdo (o una cantidad con muchos dígitos) no puede invadir la
  // columna vecina: se recorta al ancho de su celda menos el aire lateral.
  const celda = (texto: string, anchoColumna: number): string => truncar(texto, anchoColumna - 10, 9, false);
  for (const linea of data.lines) {
    asegura(ALTO_FILA, true);
    dibujaTexto(MARGEN + 5, y, truncar(linea.label || '', anchoConcepto, 9, false), 9);
    dibujaTextoDer(COL_CANT_FIN - 5, y, celda(fmtCantidad(linea.qty), COL_CANT_FIN - COL_CONCEPTO_FIN), 9);
    dibujaTextoDer(COL_PRECIO_FIN - 5, y, celda(fmtImporte(linea.unitCents, moneda), COL_PRECIO_FIN - COL_CANT_FIN), 9);
    dibujaTextoDer(COL_IVA_FIN - 5, y, celda(linea.taxRate == null ? '—' : `${fmtTipo(linea.taxRate)} %`, COL_IVA_FIN - COL_PRECIO_FIN), 9);
    dibujaTextoDer(COL_IMPORTE_FIN - 5, y, celda(fmtImporte(linea.amountCents, moneda), COL_IMPORTE_FIN - COL_IVA_FIN), 9);
    dibujaLinea(MARGEN, y - 5, X_DERECHA, y - 5, 0.4, 0.9);
    y -= ALTO_FILA;
  }

  // --- totales (siempre juntos y en la última página) ---
  const filasTotales: { etiqueta: string; importe: number }[] = [
    { etiqueta: 'Base imponible', importe: data.subtotalCents },
  ];
  if (data.taxBreakdown.length > 0) {
    for (const t of data.taxBreakdown) {
      filasTotales.push({
        etiqueta: `IVA ${fmtTipo(t.rate)}% s/ ${fmtImporte(t.base_cents, moneda)}`,
        importe: t.quota_cents,
      });
    }
  } else if (data.taxCents !== 0) {
    filasTotales.push({ etiqueta: 'IVA', importe: data.taxCents });
  }
  // El IRPF retenido resta del total, así que se imprime con el signo cambiado.
  if (data.irpfCents !== 0) {
    filasTotales.push({ etiqueta: `Retención IRPF ${fmtTipo(data.irpfRate)}%`, importe: -data.irpfCents });
  }

  // --- bloques finales de texto libre ---
  const banco: string[] = [];
  // Los datos bancarios se envuelven igual que el resto de bloques: un nombre de
  // banco largo, o un IBAN tecleado sin espacios, se salía del papel por la derecha.
  const anadeBanco = (texto: string): void => {
    for (const l of envolver(texto, ANCHO_UTIL, 8.5, false)) banco.push(l);
  };
  if (data.bank.bankName) anadeBanco(`Banco: ${data.bank.bankName}`);
  if (data.bank.iban) anadeBanco(`IBAN: ${data.bank.iban}`);
  if (data.bank.bic) anadeBanco(`BIC/SWIFT: ${data.bank.bic}`);
  const bloques: { rotulo: string; lineas: string[] }[] = [
    { rotulo: 'MENCIONES LEGALES', lineas: data.legalMentions ? envolver(data.legalMentions, ANCHO_UTIL, 8.5, false) : [] },
    { rotulo: 'OBSERVACIONES', lineas: data.notes ? envolver(data.notes, ANCHO_UTIL, 8.5, false) : [] },
    { rotulo: 'FORMA DE PAGO', lineas: data.paymentMethod ? envolver(data.paymentMethod, ANCHO_UTIL, 8.5, false) : [] },
    { rotulo: 'DATOS BANCARIOS', lineas: banco },
  ].filter((b) => b.lineas.length > 0);

  // Tiene que coincidir EXACTAMENTE con lo que el bloque baja el cursor
  // (10 + 14 por fila + 38 del recuadro TOTAL): si se queda corto, la reserva no
  // alcanza y las menciones legales se van solas a una página siguiente dejando
  // los totales huérfanos en la anterior.
  const altoTotales = 10 + filasTotales.length * 14 + 38;
  const altoBloques = bloques.reduce((suma, b) => suma + 21 + b.lineas.length * 11, 0);
  // Los totales tienen que quedar en la última página, así que el cierre entero
  // (totales + menciones) salta de página junto si no cabe donde acabó el detalle.
  // Sólo si ni en una hoja completa cabe se deja fluir bloque a bloque.
  const cabeEnUnaHoja = altoTotales + altoBloques <= Y_INICIO - 34 - Y_MINIMO;
  asegura(cabeEnUnaHoja ? altoTotales + altoBloques : altoTotales);

  y -= 10;
  dibujaLinea(X_TOTALES, y + 8, X_DERECHA, y + 8, 0.6, 0.6);
  for (const fila of filasTotales) {
    // El importe manda: se recorta la etiqueta (el desglose lleva la base dentro)
    // con lo que sobre, nunca la cifra.
    const importe = truncar(fmtImporte(fila.importe, moneda), X_IMPORTE_TOTALES - X_TOTALES, 9, false);
    const hueco = X_IMPORTE_TOTALES - X_TOTALES - anchoTexto(importe, 9, false) - 10;
    dibujaTexto(X_TOTALES, y, truncar(fila.etiqueta, hueco, 9, false), 9, false, GRIS_TEXTO);
    dibujaTextoDer(X_IMPORTE_TOTALES, y, importe, 9);
    y -= 14;
  }
  dibujaCaja(X_TOTALES - 8, y - 8, X_DERECHA - X_TOTALES + 8, 24, GRIS_SOMBRA);
  dibujaTexto(X_TOTALES, y, 'TOTAL', 12, true);
  dibujaTextoDer(X_IMPORTE_TOTALES, y, truncar(fmtImporte(data.totalCents, moneda), 190, 12, true), 12, true);
  y -= 38;

  for (const b of bloques) {
    asegura(21 + Math.min(b.lineas.length, 3) * 11);
    dibujaTexto(MARGEN, y, b.rotulo, 8, true, GRIS_TEXTO);
    y -= 13;
    for (const l of b.lineas) {
      asegura(11);
      dibujaTexto(MARGEN, y, l, 8.5, false, 0.15);
      y -= 11;
    }
    y -= 8;
  }

  // --- pie de página (al final: hasta ahora no se sabía el total de páginas) ---
  const totalPaginas = paginas.length;
  paginas.forEach((p, i) => {
    pagina = p;
    const paginado = `Página ${i + 1} de ${totalPaginas}`;
    const anchoPaginado = anchoTexto(paginado, 7.5, false);
    dibujaLinea(MARGEN, 58, X_DERECHA, 58, 0.4, 0.85);
    dibujaTexto(MARGEN, 46, truncar(data.footer || '', ANCHO_UTIL - anchoPaginado - 20, 7.5, false), 7.5, false, 0.45);
    dibujaTextoDer(X_DERECHA, 46, paginado, 7.5, false, 0.45);
  });

  return serializaPdf(paginas, data.issuedAt);
}

// ---------------------------------------------------------------------------
// Serialización del fichero PDF
// ---------------------------------------------------------------------------

/**
 * Monta el fichero: objetos, tabla xref y trailer. Los offsets de la xref se
 * calculan sobre los buffers ya serializados y acumulando su longitud real —es
 * el punto donde más fallan estos generadores— y no sobre longitudes estimadas.
 */
function serializaPdf(paginas: Pagina[], creado: number | null): Buffer {
  const objetos: Buffer[] = [];
  const anade = (cuerpo: Buffer | string): void => {
    objetos.push(typeof cuerpo === 'string' ? Buffer.from(cuerpo, 'latin1') : cuerpo);
  };

  // Numeración fija: 1 catálogo, 2 páginas, 3-4 fuentes, 5 info y, a partir de
  // ahí, pares (contenido, página) para cada hoja.
  const numPagina = (i: number): number => 7 + i * 2;
  const kids = paginas.map((_, i) => `${numPagina(i)} 0 R`).join(' ');

  anade('<< /Type /Catalog /Pages 2 0 R >>');
  anade(`<< /Type /Pages /Kids [${kids}] /Count ${paginas.length} >>`);
  anade('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  anade('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const creacion = creado != null && Number.isFinite(creado) ? ` /CreationDate ${cadena(fmtFechaPdf(creado))}` : '';
  anade(`<< /Producer (Skyway) /Creator (Skyway)${creacion} >>`);

  paginas.forEach((p, i) => {
    const comprimido = deflateSync(Buffer.from(p.ops.join('\n'), 'latin1'), { level: 9 });
    anade(Buffer.concat([
      Buffer.from(`<< /Length ${comprimido.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      comprimido,
      Buffer.from('\nendstream', 'latin1'),
    ]));
    anade(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(PAGINA_ANCHO)} ${n(PAGINA_ALTO)}]` +
      ` /Resources << /ProcSet [/PDF /Text] /Font << /F1 3 0 R /F2 4 0 R >> >>` +
      ` /Contents ${numPagina(i) - 1} 0 R >>`,
    );
  });

  const partes: Buffer[] = [];
  let pos = 0;
  const escribe = (b: Buffer): void => {
    partes.push(b);
    pos += b.length;
  };

  escribe(Buffer.from('%PDF-1.4\n', 'latin1'));
  // Comentario con bytes altos: marca el fichero como binario para las
  // herramientas que transfieren PDFs (evita que alguien lo trate como texto).
  escribe(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets: number[] = [];
  objetos.forEach((cuerpo, i) => {
    offsets.push(pos);
    escribe(Buffer.from(`${i + 1} 0 obj\n`, 'latin1'));
    escribe(cuerpo);
    escribe(Buffer.from('\nendobj\n', 'latin1'));
  });

  const inicioXref = pos;
  // Cada entrada ocupa exactamente 20 bytes: 10 de offset, 5 de generación,
  // el tipo y un fin de línea de dos caracteres.
  let xref = `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  escribe(Buffer.from(xref, 'latin1'));
  escribe(Buffer.from(
    `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${inicioXref}\n%%EOF\n`,
    'latin1',
  ));

  return Buffer.concat(partes);
}
