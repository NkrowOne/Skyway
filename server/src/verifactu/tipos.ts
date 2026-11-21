/**
 * Registros de facturación de VERI*FACTU con los nombres de campo de la AEAT
 * (`SuministroInformacion.xsd`, versión 1.0). Se guardan tal cual en
 * `invoice_ledger.registro_json` al generarlos: el XML de remisión se
 * construye siempre a partir de esta foto, nunca de la factura viva, para que
 * lo enviado sea exactamente lo que se encadenó con la huella.
 *
 * Solo están los campos que Skyway rellena. El orden de los elementos del XML
 * lo fija `xml.ts`, no el orden de las claves.
 */

export type TipoFacturaAeat = 'F1' | 'F2' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
export type CalificacionOperacion = 'S1' | 'S2' | 'N1' | 'N2';
export type OperacionExenta = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6';

export interface IdFacturaAeat {
  IDEmisorFactura: string;
  NumSerieFactura: string;
  /** dd-mm-aaaa */
  FechaExpedicionFactura: string;
}

export interface IdOtro {
  /** Obligatorio salvo con IDType 02 (NIF-IVA), que lo lleva en el propio ID. */
  CodigoPais?: string;
  /** 02 NIF-IVA, 03 pasaporte, 04 documento del país de residencia, 05 certificado de residencia, 06 otro, 07 no censado. */
  IDType: '02' | '03' | '04' | '05' | '06' | '07';
  ID: string;
}

export interface PersonaAeat {
  NombreRazon: string;
  NIF?: string;
  IDOtro?: IdOtro;
}

export interface DetalleDesglose {
  /** 01 = IVA. */
  Impuesto: '01';
  /** 01 régimen general, 02 exportación, 18 recargo de equivalencia… */
  ClaveRegimen: string;
  CalificacionOperacion?: CalificacionOperacion;
  OperacionExenta?: OperacionExenta;
  TipoImpositivo?: string;
  BaseImponibleOimporteNoSujeto: string;
  CuotaRepercutida?: string;
  TipoRecargoEquivalencia?: string;
  CuotaRecargoEquivalencia?: string;
}

export interface RegistroAnteriorAeat {
  IDEmisorFactura: string;
  NumSerieFactura: string;
  FechaExpedicionFactura: string;
  Huella: string;
}

export interface Encadenamiento {
  PrimerRegistro?: 'S';
  RegistroAnterior?: RegistroAnteriorAeat;
}

export interface SistemaInformaticoAeat {
  NombreRazon: string;
  NIF: string;
  NombreSistemaInformatico: string;
  IdSistemaInformatico: string;
  Version: string;
  NumeroInstalacion: string;
  TipoUsoPosibleSoloVerifactu: 'S' | 'N';
  TipoUsoPosibleMultiOT: 'S' | 'N';
  IndicadorMultiplesOT: 'S' | 'N';
}

export interface RegistroAltaAeat {
  IDVersion: '1.0';
  IDFactura: IdFacturaAeat;
  NombreRazonEmisor: string;
  Subsanacion?: 'S' | 'N';
  RechazoPrevio?: 'N' | 'S' | 'X';
  TipoFactura: TipoFacturaAeat;
  TipoRectificativa?: 'S' | 'I';
  FacturasRectificadas?: IdFacturaAeat[];
  FechaOperacion?: string;
  DescripcionOperacion: string;
  FacturaSinIdentifDestinatarioArt61d?: 'S' | 'N';
  Macrodato?: 'S' | 'N';
  Destinatarios?: PersonaAeat[];
  Desglose: DetalleDesglose[];
  CuotaTotal: string;
  ImporteTotal: string;
  Encadenamiento: Encadenamiento;
  SistemaInformatico: SistemaInformaticoAeat;
  FechaHoraHusoGenRegistro: string;
  TipoHuella: '01';
  Huella: string;
}

export interface RegistroAnulacionAeat {
  IDVersion: '1.0';
  IDFactura: {
    IDEmisorFacturaAnulada: string;
    NumSerieFacturaAnulada: string;
    FechaExpedicionFacturaAnulada: string;
  };
  SinRegistroPrevio?: 'S' | 'N';
  RechazoPrevio?: 'S' | 'N';
  Encadenamiento: Encadenamiento;
  SistemaInformatico: SistemaInformaticoAeat;
  FechaHoraHusoGenRegistro: string;
  TipoHuella: '01';
  Huella: string;
}

export type RegistroAeat = { tipo: 'alta'; alta: RegistroAltaAeat } | { tipo: 'anulacion'; anulacion: RegistroAnulacionAeat };

/** Datos del obligado tributario que van en la cabecera de cada envío. */
export interface ObligadoEmision {
  NombreRazon: string;
  NIF: string;
}
