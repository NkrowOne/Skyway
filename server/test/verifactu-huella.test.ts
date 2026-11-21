import { describe, expect, it } from 'vitest';
import {
  cadenaHuellaAlta,
  cadenaHuellaAnulacion,
  huellaAlta,
  huellaAnulacion,
} from '../src/verifactu/huella';
import {
  fechaAeat,
  fechaHoraHuso,
  importeAeat,
  nifValido,
  normalizarNif,
  textoAeat,
  tipoAeat,
} from '../src/verifactu/formato';

/**
 * Ejemplos del documento de la AEAT «Detalle de las especificaciones técnicas
 * para generación de la huella o hash de los registros de facturación»: el
 * primer registro de una cadena, el siguiente encadenado a él y la anulación de
 * este último. Las huellas son las publicadas por la AEAT.
 */
describe('huella de los registros (ejemplos oficiales de la AEAT)', () => {
  const primero = {
    idEmisorFactura: '89890001K',
    numSerieFactura: '12345678/G33',
    fechaExpedicionFactura: '01-01-2024',
    tipoFactura: 'F1',
    cuotaTotal: '12.35',
    importeTotal: '123.45',
    huellaAnterior: '',
    fechaHoraHusoGenRegistro: '2024-01-01T19:20:30+01:00',
  };

  it('primer registro de alta: concatenación y huella', () => {
    expect(cadenaHuellaAlta(primero)).toBe(
      'IDEmisorFactura=89890001K&NumSerieFactura=12345678/G33&FechaExpedicionFactura=01-01-2024&TipoFactura=F1&CuotaTotal=12.35&ImporteTotal=123.45&Huella=&FechaHoraHusoGenRegistro=2024-01-01T19:20:30+01:00',
    );
    expect(huellaAlta(primero)).toBe('3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60');
  });

  it('registro de alta encadenado al anterior', () => {
    const segundo = {
      ...primero,
      numSerieFactura: '12345679/G34',
      huellaAnterior: '3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60',
      fechaHoraHusoGenRegistro: '2024-01-01T19:20:35+01:00',
    };
    expect(huellaAlta(segundo)).toBe('F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97');
  });

  it('registro de anulación encadenado', () => {
    const anulacion = {
      idEmisorFacturaAnulada: '89890001K',
      numSerieFacturaAnulada: '12345679/G34',
      fechaExpedicionFacturaAnulada: '01-01-2024',
      huellaAnterior: 'F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97',
      fechaHoraHusoGenRegistro: '2024-01-01T19:20:40+01:00',
    };
    expect(cadenaHuellaAnulacion(anulacion)).toBe(
      'IDEmisorFacturaAnulada=89890001K&NumSerieFacturaAnulada=12345679/G34&FechaExpedicionFacturaAnulada=01-01-2024&Huella=F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97&FechaHoraHusoGenRegistro=2024-01-01T19:20:40+01:00',
    );
    expect(huellaAnulacion(anulacion)).toBe('177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68');
  });

  it('los valores van sin espacios al principio ni al final', () => {
    expect(huellaAlta({ ...primero, numSerieFactura: '  12345678/G33 ' })).toBe(huellaAlta(primero));
  });
});

describe('formatos de los campos', () => {
  it('fecha dd-mm-aaaa en UTC, como la que imprime el PDF', () => {
    expect(fechaAeat(Date.UTC(2026, 0, 5, 23, 30))).toBe('05-01-2026');
  });

  it('fecha y hora con el desfase de la hora peninsular (invierno y verano)', () => {
    expect(fechaHoraHuso(Date.UTC(2024, 0, 1, 18, 20, 30))).toBe('2024-01-01T19:20:30+01:00');
    expect(fechaHoraHuso(Date.UTC(2026, 6, 15, 10, 0, 5, 999))).toBe('2026-07-15T12:00:05+02:00');
  });

  it('importes con dos decimales y punto, y tipos', () => {
    expect(importeAeat(1235)).toBe('12.35');
    expect(importeAeat(1230)).toBe('12.30');
    expect(importeAeat(-500)).toBe('-5.00');
    expect(importeAeat(0)).toBe('0.00');
    expect(importeAeat(-0)).toBe('0.00');
    expect(tipoAeat(21)).toBe('21.00');
    expect(tipoAeat(5.2)).toBe('5.20');
  });

  it('NIF normalizado y validado', () => {
    expect(normalizarNif(' b-1234567.8 ')).toBe('B12345678');
    expect(normalizarNif('ESB12345674')).toBe('B12345674');
    expect(nifValido('89890001K')).toBe(true); // NIF de los ejemplos de la AEAT
    expect(nifValido('12345678Z')).toBe(true);
    expect(nifValido('12345678A')).toBe(false);
    expect(nifValido('X1234567L')).toBe(true);
    expect(nifValido('B12345674')).toBe(true);
    expect(nifValido('B12345678')).toBe(false);
    expect(nifValido('Q2826000H')).toBe(true);
    expect(nifValido('ABC')).toBe(false);
  });

  it('texto libre sin los caracteres que rechaza la AEAT (código 1287)', () => {
    expect(textoAeat('Talleres "El Rayo" <S.L.>', 120)).toBe('Talleres ”El Rayo” S.L.');
    expect(textoAeat("O'Donnell = 1\nlínea", 120)).toBe('O’Donnell 1 línea');
    expect(textoAeat('áéíóú '.repeat(200), 500)).toHaveLength(500);
  });
});
