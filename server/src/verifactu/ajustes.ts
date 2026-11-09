/**
 * Ajustes de VERI*FACTU: entorno de la AEAT, datos del productor del sistema
 * informático y número de instalación. El modo (activado o no) vive en el
 * perfil de facturación (`BillingProfile.sifMode`), junto al resto de datos
 * fiscales del emisor.
 */
import { randomUUID } from 'node:crypto';
import { getBillingProfile } from '../company';
import { config } from '../config';
import { getSetting, setSetting } from '../db';
import type { EntornoVerifactu } from '../types';
import { safeParse } from '../util';
import { normalizarNif, textoAeat } from './formato';
import type { SistemaInformaticoAeat } from './tipos';

/** Nombre del sistema informático de facturación (máx. 30) y su código de 2 caracteres. */
export const NOMBRE_SISTEMA = 'Skyway';
export const ID_SISTEMA = 'SK';

/**
 * Servicio de remisión de registros (SOAP), con certificado de persona física
 * o de representante. Fuente: «Descripción del servicio web» de VERI*FACTU y
 * el WSDL `SistemaFacturacion.wsdl` de la AEAT.
 */
export const URL_ENVIO: Record<EntornoVerifactu, string> = {
  pruebas: 'https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP',
  produccion: 'https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP',
};

/**
 * El mismo servicio para los certificados de sello electrónico, que la AEAT
 * atiende en otro punto de acceso (puertos «SistemaVerifactuSello» del WSDL).
 */
export const URL_ENVIO_SELLO: Record<EntornoVerifactu, string> = {
  pruebas: 'https://prewww10.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP',
  produccion: 'https://www10.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP',
};

/** Servicio de cotejo al que lleva el QR de la factura (especificación del QR de la AEAT). */
export const URL_COTEJO: Record<EntornoVerifactu, string> = {
  pruebas: 'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR',
  produccion: 'https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR',
};

export interface AjustesVerifactu {
  /** Entorno al que se remiten los registros nuevos. */
  entorno: EntornoVerifactu;
  /**
   * Productor del sistema informático (bloque `SistemaInformatico`): quien lo
   * desarrolla. Vacío = el propio emisor, el caso de una empresa que instala
   * Skyway para facturar sus servicios.
   */
  productorNombre: string;
  productorNif: string;
  /** Dirección postal de contacto del productor (declaración responsable). Vacía = la del emisor. */
  productorDireccion: string;
  /** Lugar y fecha (aaaa-mm-dd) en que el productor suscribe la declaración responsable. */
  declaracionLugar: string;
  declaracionFecha: string;
}

const POR_DEFECTO: AjustesVerifactu = {
  entorno: 'pruebas',
  productorNombre: '',
  productorNif: '',
  productorDireccion: '',
  declaracionLugar: '',
  declaracionFecha: '',
};

const texto = (v: unknown, defecto: string): string => (typeof v === 'string' ? v : defecto);

export function getAjustesVerifactu(): AjustesVerifactu {
  const guardado = safeParse<Partial<AjustesVerifactu>>(getSetting('verifactu'), {});
  return {
    entorno: guardado.entorno === 'produccion' ? 'produccion' : 'pruebas',
    productorNombre: texto(guardado.productorNombre, POR_DEFECTO.productorNombre),
    productorNif: texto(guardado.productorNif, POR_DEFECTO.productorNif),
    productorDireccion: texto(guardado.productorDireccion, POR_DEFECTO.productorDireccion),
    declaracionLugar: texto(guardado.declaracionLugar, POR_DEFECTO.declaracionLugar),
    declaracionFecha: texto(guardado.declaracionFecha, POR_DEFECTO.declaracionFecha),
  };
}

export function setAjustesVerifactu(a: AjustesVerifactu): void {
  setSetting('verifactu', JSON.stringify(a));
}

/** ¿Genera Skyway registros de facturación al emitir y anular? */
export function verifactuActivo(): boolean {
  return getBillingProfile().sifMode === 'verifactu';
}

/**
 * Identificador de esta instalación (`NumeroInstalacion`, máx. 100). Se crea
 * una vez y no cambia: la AEAT distingue con él cada instalación del mismo
 * sistema informático.
 */
export function numeroInstalacion(): string {
  let n = getSetting('verifactuNumeroInstalacion');
  if (!n) {
    n = randomUUID();
    setSetting('verifactuNumeroInstalacion', n);
  }
  return n;
}

/**
 * Productor efectivo: el configurado (nombre y NIF juntos) o, si no hay, el
 * emisor. Nunca mezcla el nombre de uno con el NIF del otro. La dirección de
 * un productor configurado es la suya; la del emisor solo se toma cuando el
 * productor es el propio emisor.
 */
export function productorEfectivo(): { nombre: string; nif: string; direccion: string; esEmisor: boolean } {
  const a = getAjustesVerifactu();
  const perfil = getBillingProfile();
  const propio = !!a.productorNombre.trim() && !!a.productorNif.trim();
  return {
    nombre: textoAeat(propio ? a.productorNombre : perfil.companyName, 120),
    nif: normalizarNif(propio ? a.productorNif : perfil.taxId),
    direccion: (a.productorDireccion || (propio ? '' : perfil.address)).trim(),
    esEmisor: !propio,
  };
}

/** Bloque `SistemaInformatico` de cada registro. */
export function sistemaInformatico(): SistemaInformaticoAeat {
  const p = productorEfectivo();
  return {
    NombreRazon: p.nombre,
    NIF: p.nif,
    NombreSistemaInformatico: NOMBRE_SISTEMA,
    IdSistemaInformatico: ID_SISTEMA,
    Version: config.version.slice(0, 50),
    NumeroInstalacion: numeroInstalacion(),
    // Skyway solo funciona como VERI*FACTU (no implementa la modalidad con
    // firma) y factura a un único obligado tributario por instalación: el
    // perfil de facturación es uno.
    TipoUsoPosibleSoloVerifactu: 'S',
    TipoUsoPosibleMultiOT: 'N',
    IndicadorMultiplesOT: 'N',
  };
}
