/**
 * Reglas para activar y desactivar VERI*FACTU, cambiar de entorno y cambiar los
 * datos de los que dependen los registros. Las usan la ruta de VERI*FACTU y la
 * del perfil de facturación, para que ninguna de las dos se salte a la otra.
 */
import { hayRegistrosProduccion } from '../db';
import type { BillingProfile, EntornoVerifactu } from '../types';
import { nifValido, normalizarNif, textoAeat } from './formato';

export const NO_SALIR_DE_PRODUCCION =
  'Skyway ya tiene registros de facturación del entorno de producción de la AEAT, así que VERI*FACTU tiene que seguir activo y en producción. ' +
  'La modalidad se mantiene al menos hasta el final del año natural y para dejarla hay que comunicar la renuncia a la AEAT en los envíos de ese año ' +
  '(art. 17 de la Orden HAC/1177/2024); Skyway no comunica la renuncia.';

/**
 * ¿Se puede pasar del modo y entorno actuales a los siguientes? Devuelve el
 * motivo si no.
 * - Para activar hacen falta la razón social y un NIF español válido del
 *   emisor: sin ellos no hay registro que la AEAT acepte.
 * - Con VERI*FACTU activo, el NIF del emisor no puede dejar de ser válido.
 * - Quien tiene registros de producción no puede desactivar ni volver a pruebas
 *   (art. 17 de la Orden): la modalidad se mantiene al menos hasta el 31 de
 *   diciembre y la renuncia se comunica a la AEAT con `FechaFinVeriFactu` en
 *   los envíos del año. Skyway no hace esa comunicación, así que, una vez en
 *   producción, se queda en producción. Volver a pruebas también es salir: las
 *   facturas dejarían de llegar a la AEAT con efectos fiscales.
 */
export function motivoCambioNoPermitido(
  actual: BillingProfile & { entorno?: EntornoVerifactu },
  siguiente: BillingProfile & { entorno?: EntornoVerifactu },
): string | null {
  if (siguiente.sifMode === 'verifactu') {
    if (!textoAeat(siguiente.companyName, 120)) return 'Para usar VERI*FACTU falta la razón social del emisor (Contabilidad → Datos de la empresa emisora).';
    if (!nifValido(normalizarNif(siguiente.taxId))) {
      return 'Para usar VERI*FACTU el NIF del emisor tiene que ser un NIF español válido (Contabilidad → Datos de la empresa emisora).';
    }
  }
  const sale = (actual.sifMode === 'verifactu' && siguiente.sifMode !== 'verifactu') || (actual.entorno === 'produccion' && siguiente.entorno === 'pruebas');
  if (sale && hayRegistrosProduccion()) return NO_SALIR_DE_PRODUCCION;
  return null;
}
