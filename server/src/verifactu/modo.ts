/**
 * Reglas para activar y desactivar VERI*FACTU y para cambiar los datos de los
 * que dependen los registros. Las usan la ruta de VERI*FACTU y la del perfil
 * de facturación, para que ninguna de las dos se salte a la otra.
 */
import { hayRegistrosProduccionDesde } from '../db';
import type { BillingProfile } from '../types';
import { nifValido, normalizarNif, textoAeat } from './formato';

/**
 * ¿Se puede pasar del perfil `actual` al `siguiente`? Devuelve el motivo si no.
 * - Para activar hacen falta la razón social y un NIF español válido del
 *   emisor: sin ellos no hay registro que la AEAT acepte.
 * - Con VERI*FACTU activo, el NIF del emisor no puede dejar de ser válido.
 * - Quien ha remitido registros a producción en un año sigue en VERI*FACTU
 *   hasta que acabe ese año natural: la opción se mantiene el año entero y
 *   la renuncia surte efecto al siguiente (RD 1007/2023, art. 16).
 */
export function motivoCambioNoPermitido(actual: BillingProfile, siguiente: BillingProfile, ahora: number = Date.now()): string | null {
  if (siguiente.sifMode === 'verifactu') {
    if (!textoAeat(siguiente.companyName, 120)) return 'Para usar VERI*FACTU falta la razón social del emisor (Contabilidad → Datos de la empresa emisora).';
    if (!nifValido(normalizarNif(siguiente.taxId))) {
      return 'Para usar VERI*FACTU el NIF del emisor tiene que ser un NIF español válido (Contabilidad → Datos de la empresa emisora).';
    }
  }
  if (actual.sifMode === 'verifactu' && siguiente.sifMode !== 'verifactu') {
    const inicioAnio = Date.UTC(new Date(ahora).getUTCFullYear(), 0, 1);
    if (hayRegistrosProduccionDesde(inicioAnio)) {
      return 'VERI*FACTU no se puede desactivar este año: ya se han remitido registros al entorno de producción de la AEAT, y la modalidad se mantiene hasta el final del año natural.';
    }
  }
  return null;
}
