/**
 * Huella (hash) de los registros de facturación de VERI*FACTU, según el
 * documento de la AEAT «Detalle de las especificaciones técnicas para
 * generación de la huella o hash de los registros de facturación».
 *
 * Se concatenan, en este orden y como `nombre=valor` unidos por `&`, unos
 * campos concretos del registro (cada valor sin espacios al principio ni al
 * final, y el campo vacío como `nombre=`), y se calcula el SHA-256 del texto en
 * UTF-8, en hexadecimal y en mayúsculas (64 caracteres). La huella del registro
 * anterior entra en la concatenación: así cada registro queda encadenado al
 * anterior y no se puede alterar ni quitar uno sin romper los siguientes.
 *
 * Los tres ejemplos oficiales del documento están en
 * `server/test/verifactu-huella.test.ts` y dan exactamente las huellas que
 * publica la AEAT.
 */
import { createHash } from 'node:crypto';

/** Campos de un registro de alta que entran en la huella. */
export interface CamposHuellaAlta {
  idEmisorFactura: string;
  numSerieFactura: string;
  /** dd-mm-aaaa */
  fechaExpedicionFactura: string;
  tipoFactura: string;
  /** Importe con punto decimal, igual que en el XML. */
  cuotaTotal: string;
  importeTotal: string;
  /** Huella del registro anterior; vacía en el primero de la cadena. */
  huellaAnterior: string;
  /** 2024-01-01T19:20:30+01:00 */
  fechaHoraHusoGenRegistro: string;
}

/** Campos de un registro de anulación que entran en la huella. */
export interface CamposHuellaAnulacion {
  idEmisorFacturaAnulada: string;
  numSerieFacturaAnulada: string;
  fechaExpedicionFacturaAnulada: string;
  huellaAnterior: string;
  fechaHoraHusoGenRegistro: string;
}

const par = (nombre: string, valor: string): string => `${nombre}=${(valor ?? '').trim()}`;

/** Texto exacto sobre el que se calcula la huella de un registro de alta. */
export function cadenaHuellaAlta(c: CamposHuellaAlta): string {
  return [
    par('IDEmisorFactura', c.idEmisorFactura),
    par('NumSerieFactura', c.numSerieFactura),
    par('FechaExpedicionFactura', c.fechaExpedicionFactura),
    par('TipoFactura', c.tipoFactura),
    par('CuotaTotal', c.cuotaTotal),
    par('ImporteTotal', c.importeTotal),
    par('Huella', c.huellaAnterior),
    par('FechaHoraHusoGenRegistro', c.fechaHoraHusoGenRegistro),
  ].join('&');
}

/** Texto exacto sobre el que se calcula la huella de un registro de anulación. */
export function cadenaHuellaAnulacion(c: CamposHuellaAnulacion): string {
  return [
    par('IDEmisorFacturaAnulada', c.idEmisorFacturaAnulada),
    par('NumSerieFacturaAnulada', c.numSerieFacturaAnulada),
    par('FechaExpedicionFacturaAnulada', c.fechaExpedicionFacturaAnulada),
    par('Huella', c.huellaAnterior),
    par('FechaHoraHusoGenRegistro', c.fechaHoraHusoGenRegistro),
  ].join('&');
}

/** SHA-256 en hexadecimal y mayúsculas (`TipoHuella` 01). */
export function sha256Mayusculas(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex').toUpperCase();
}

export function huellaAlta(c: CamposHuellaAlta): string {
  return sha256Mayusculas(cadenaHuellaAlta(c));
}

export function huellaAnulacion(c: CamposHuellaAnulacion): string {
  return sha256Mayusculas(cadenaHuellaAnulacion(c));
}
