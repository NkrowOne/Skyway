/**
 * Registro de eventos del sistema de facturación (`invoice_events_log`).
 *
 * En la modalidad VERI*FACTU el reglamento no lo exige (la AEAT recibe los
 * registros al momento), pero deja constancia, encadenada por huella como los
 * registros, de lo que cambia el comportamiento del sistema: activarlo o
 * desactivarlo, cambiar de entorno o de certificado, y los envíos rechazados o
 * fallidos. Así, ante una inspección o una incidencia, se puede reconstruir qué
 * pasó y cuándo.
 */
import { insertarEventoSif, listarEventosSif, ultimoEventoSif } from '../db';
import type { EventoSifRow } from '../types';
import { id, now } from '../util';
import { fechaHoraHuso, textoAeat } from './formato';
import { sha256Mayusculas } from './huella';

export type TipoEventoSif =
  | 'activacion'
  | 'desactivacion'
  | 'cambio_entorno'
  | 'cambio_productor'
  | 'certificado_cargado'
  | 'certificado_retirado'
  | 'envio_correcto'
  | 'envio_con_errores'
  | 'envio_rechazado'
  | 'error_conexion'
  | 'subsanacion'
  | 'anomalia_cadena';

/** Huella de un evento: su contenido más la del anterior, como en los registros. */
export function huellaEvento(e: Pick<EventoSifRow, 'seq' | 'tipo_evento' | 'ts' | 'detalle' | 'huella_evento_anterior'>): string {
  return sha256Mayusculas(
    [`Seq=${e.seq}`, `TipoEvento=${e.tipo_evento}`, `FechaHoraHuso=${e.ts}`, `Detalle=${e.detalle ?? ''}`, `HuellaAnterior=${e.huella_evento_anterior ?? ''}`].join('&'),
  );
}

/**
 * Anota un evento. Va dentro de la transacción de quien lo llama cuando la hay
 * (better-sqlite3 es síncrono): el evento y el cambio que lo provoca quedan
 * juntos o no queda ninguno.
 */
export function anotarEvento(tipo: TipoEventoSif, detalle: string, ahora: number = now()): EventoSifRow {
  const anterior = ultimoEventoSif();
  const base = {
    seq: (anterior?.seq ?? 0) + 1,
    tipo_evento: tipo,
    ts: fechaHoraHuso(ahora),
    detalle: textoAeat(detalle, 1000) || null,
    huella_evento_anterior: anterior?.huella_evento ?? null,
  };
  const evento: EventoSifRow = { id: id('sev'), ...base, huella_evento: huellaEvento(base), created_at: ahora };
  insertarEventoSif(evento);
  return evento;
}

/** Comprueba la cadena de los últimos eventos (de más antiguo a más reciente). */
export function cadenaEventosIntegra(limite = 500): boolean {
  const eventos = listarEventosSif(limite).reverse();
  return eventos.every((e, i) => {
    if (i > 0 && e.huella_evento_anterior !== eventos[i - 1].huella_evento) return false;
    return huellaEvento(e) === e.huella_evento;
  });
}
