/**
 * XML del servicio web de remisión de VERI*FACTU (SOAP 1.1): la petición
 * `RegFactuSistemaFacturacion` con la cabecera y hasta 1000 registros, y la
 * lectura de la respuesta `RespuestaRegFactuSistemaFacturacion` o del SOAP
 * Fault con que la AEAT rechaza el envío entero.
 *
 * Los elementos se escriben en el orden exacto de las secuencias de
 * `SuministroLR.xsd` y `SuministroInformacion.xsd`: el servicio valida contra
 * el esquema y un elemento fuera de sitio rechaza el envío completo (4102).
 * Sin dependencias: el XML de salida es plantilla con escape, y el de entrada
 * se lee con un analizador mínimo que ignora los prefijos de espacio de nombres
 * (la AEAT puede cambiarlos sin que cambie el significado).
 */
import { escaparXml } from './formato';
import type {
  DetalleDesglose,
  Encadenamiento,
  IdFacturaAeat,
  ObligadoEmision,
  PersonaAeat,
  RegistroAeat,
  RegistroAltaAeat,
  RegistroAnulacionAeat,
  SistemaInformaticoAeat,
} from './tipos';

export const NS_SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
export const NS_SUMINISTRO_LR =
  'https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd';
export const NS_SUMINISTRO_INFORMACION =
  'https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd';

/** Máximo de registros por envío (`RegistroFactura maxOccurs="1000"`). */
export const MAX_REGISTROS_ENVIO = 1000;

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

/** Elemento del espacio de nombres de SuministroInformacion (prefijo sum1). */
const e = (nombre: string, contenido: string): string => `<sum1:${nombre}>${contenido}</sum1:${nombre}>`;
/** Elemento con texto, escapado. */
const t = (nombre: string, valor: string): string => e(nombre, escaparXml(valor));
/** Elemento opcional: no se escribe si no hay valor. */
const o = (nombre: string, valor: string | undefined): string => (valor === undefined || valor === '' ? '' : t(nombre, valor));

function idFactura(nombre: string, id: IdFacturaAeat): string {
  return e(nombre, t('IDEmisorFactura', id.IDEmisorFactura) + t('NumSerieFactura', id.NumSerieFactura) + t('FechaExpedicionFactura', id.FechaExpedicionFactura));
}

function persona(nombre: string, p: PersonaAeat): string {
  let ident = '';
  if (p.NIF) ident = t('NIF', p.NIF);
  else if (p.IDOtro) ident = e('IDOtro', o('CodigoPais', p.IDOtro.CodigoPais) + t('IDType', p.IDOtro.IDType) + t('ID', p.IDOtro.ID));
  return e(nombre, t('NombreRazon', p.NombreRazon) + ident);
}

function detalle(d: DetalleDesglose): string {
  return e(
    'DetalleDesglose',
    o('Impuesto', d.Impuesto) +
      o('ClaveRegimen', d.ClaveRegimen) +
      (d.CalificacionOperacion ? t('CalificacionOperacion', d.CalificacionOperacion) : o('OperacionExenta', d.OperacionExenta)) +
      o('TipoImpositivo', d.TipoImpositivo) +
      t('BaseImponibleOimporteNoSujeto', d.BaseImponibleOimporteNoSujeto) +
      o('CuotaRepercutida', d.CuotaRepercutida) +
      o('TipoRecargoEquivalencia', d.TipoRecargoEquivalencia) +
      o('CuotaRecargoEquivalencia', d.CuotaRecargoEquivalencia),
  );
}

function encadenamiento(c: Encadenamiento): string {
  if (c.RegistroAnterior) {
    const r = c.RegistroAnterior;
    return e(
      'Encadenamiento',
      e('RegistroAnterior', t('IDEmisorFactura', r.IDEmisorFactura) + t('NumSerieFactura', r.NumSerieFactura) + t('FechaExpedicionFactura', r.FechaExpedicionFactura) + t('Huella', r.Huella)),
    );
  }
  return e('Encadenamiento', t('PrimerRegistro', 'S'));
}

function sistema(s: SistemaInformaticoAeat): string {
  return e(
    'SistemaInformatico',
    t('NombreRazon', s.NombreRazon) +
      t('NIF', s.NIF) +
      t('NombreSistemaInformatico', s.NombreSistemaInformatico) +
      t('IdSistemaInformatico', s.IdSistemaInformatico) +
      t('Version', s.Version) +
      t('NumeroInstalacion', s.NumeroInstalacion) +
      t('TipoUsoPosibleSoloVerifactu', s.TipoUsoPosibleSoloVerifactu) +
      t('TipoUsoPosibleMultiOT', s.TipoUsoPosibleMultiOT) +
      t('IndicadorMultiplesOT', s.IndicadorMultiplesOT),
  );
}

/** `<sum1:RegistroAlta>` en el orden de `RegistroFacturacionAltaType`. */
export function xmlRegistroAlta(r: RegistroAltaAeat): string {
  return e(
    'RegistroAlta',
    t('IDVersion', r.IDVersion) +
      idFactura('IDFactura', r.IDFactura) +
      t('NombreRazonEmisor', r.NombreRazonEmisor) +
      o('Subsanacion', r.Subsanacion) +
      o('RechazoPrevio', r.RechazoPrevio) +
      t('TipoFactura', r.TipoFactura) +
      o('TipoRectificativa', r.TipoRectificativa) +
      (r.FacturasRectificadas?.length ? e('FacturasRectificadas', r.FacturasRectificadas.map((f) => idFactura('IDFacturaRectificada', f)).join('')) : '') +
      o('FechaOperacion', r.FechaOperacion) +
      t('DescripcionOperacion', r.DescripcionOperacion) +
      o('FacturaSinIdentifDestinatarioArt61d', r.FacturaSinIdentifDestinatarioArt61d) +
      o('Macrodato', r.Macrodato) +
      (r.Destinatarios?.length ? e('Destinatarios', r.Destinatarios.map((d) => persona('IDDestinatario', d)).join('')) : '') +
      e('Desglose', r.Desglose.map(detalle).join('')) +
      t('CuotaTotal', r.CuotaTotal) +
      t('ImporteTotal', r.ImporteTotal) +
      encadenamiento(r.Encadenamiento) +
      sistema(r.SistemaInformatico) +
      t('FechaHoraHusoGenRegistro', r.FechaHoraHusoGenRegistro) +
      t('TipoHuella', r.TipoHuella) +
      t('Huella', r.Huella),
  );
}

/** `<sum1:RegistroAnulacion>` en el orden de `RegistroFacturacionAnulacionType`. */
export function xmlRegistroAnulacion(r: RegistroAnulacionAeat): string {
  return e(
    'RegistroAnulacion',
    t('IDVersion', r.IDVersion) +
      e(
        'IDFactura',
        t('IDEmisorFacturaAnulada', r.IDFactura.IDEmisorFacturaAnulada) +
          t('NumSerieFacturaAnulada', r.IDFactura.NumSerieFacturaAnulada) +
          t('FechaExpedicionFacturaAnulada', r.IDFactura.FechaExpedicionFacturaAnulada),
      ) +
      o('SinRegistroPrevio', r.SinRegistroPrevio) +
      o('RechazoPrevio', r.RechazoPrevio) +
      encadenamiento(r.Encadenamiento) +
      sistema(r.SistemaInformatico) +
      t('FechaHoraHusoGenRegistro', r.FechaHoraHusoGenRegistro) +
      t('TipoHuella', r.TipoHuella) +
      t('Huella', r.Huella),
  );
}

export interface OpcionesEnvio {
  /** Registros generados durante una incidencia que impidió remitirlos a tiempo. */
  incidencia?: boolean;
}

/** Petición SOAP completa con la cabecera y los registros, en UTF-8. */
export function soapRegFactu(obligado: ObligadoEmision, registros: RegistroAeat[], opts: OpcionesEnvio = {}): string {
  if (registros.length === 0) throw new Error('Un envío a la AEAT necesita al menos un registro.');
  if (registros.length > MAX_REGISTROS_ENVIO) throw new Error(`Un envío a la AEAT admite como máximo ${MAX_REGISTROS_ENVIO} registros.`);
  const cabecera =
    e('ObligadoEmision', t('NombreRazon', obligado.NombreRazon) + t('NIF', obligado.NIF)) +
    (opts.incidencia ? e('RemisionVoluntaria', t('Incidencia', 'S')) : '');
  const cuerpo = registros
    .map((r) => `<sum:RegistroFactura>${r.tipo === 'alta' ? xmlRegistroAlta(r.alta) : xmlRegistroAnulacion(r.anulacion)}</sum:RegistroFactura>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<soapenv:Envelope xmlns:soapenv="${NS_SOAP}" xmlns:sum="${NS_SUMINISTRO_LR}" xmlns:sum1="${NS_SUMINISTRO_INFORMACION}">` +
    '<soapenv:Header/>' +
    '<soapenv:Body>' +
    `<sum:RegFactuSistemaFacturacion><sum:Cabecera>${cabecera}</sum:Cabecera>${cuerpo}</sum:RegFactuSistemaFacturacion>` +
    '</soapenv:Body>' +
    '</soapenv:Envelope>'
  );
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

/** Nodo de un XML ya leído, con el nombre local (sin prefijo). */
export interface NodoXml {
  nombre: string;
  hijos: NodoXml[];
  texto: string;
}

const ENTIDADES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodificar(texto: string): string {
  return texto.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (todo, ent: string) => {
    if (ent[0] === '#') {
      const cp = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : todo;
    }
    return ENTIDADES[ent] ?? todo;
  });
}

/**
 * Analizador mínimo de XML para las respuestas de la AEAT: elementos, texto,
 * entidades, CDATA, comentarios e instrucciones de proceso. Sin DTD (una
 * respuesta con DOCTYPE se rechaza: así no hay entidades externas que
 * resolver). Lanza un Error si el documento está mal formado.
 */
export function parsearXml(xml: string): NodoXml {
  let i = 0;
  const raiz: NodoXml = { nombre: '#documento', hijos: [], texto: '' };
  const pila: NodoXml[] = [raiz];
  const local = (nombre: string): string => nombre.slice(nombre.indexOf(':') + 1);
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      pila[pila.length - 1].texto += decodificar(xml.slice(i));
      break;
    }
    if (lt > i) pila[pila.length - 1].texto += decodificar(xml.slice(i, lt));
    if (xml.startsWith('<?', lt)) {
      const fin = xml.indexOf('?>', lt);
      if (fin === -1) throw new Error('XML mal formado: instrucción sin cerrar');
      i = fin + 2;
    } else if (xml.startsWith('<!--', lt)) {
      const fin = xml.indexOf('-->', lt);
      if (fin === -1) throw new Error('XML mal formado: comentario sin cerrar');
      i = fin + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const fin = xml.indexOf(']]>', lt);
      if (fin === -1) throw new Error('XML mal formado: CDATA sin cerrar');
      pila[pila.length - 1].texto += xml.slice(lt + 9, fin);
      i = fin + 3;
    } else if (xml.startsWith('<!', lt)) {
      throw new Error('XML no admitido: declaración DOCTYPE');
    } else if (xml.startsWith('</', lt)) {
      const fin = xml.indexOf('>', lt);
      if (fin === -1) throw new Error('XML mal formado: etiqueta de cierre sin terminar');
      const nombre = local(xml.slice(lt + 2, fin).trim());
      // La raíz del documento no se cierra nunca: un cierre con solo ella en la
      // pila es un cierre sin apertura.
      if (pila.length === 1 || pila[pila.length - 1].nombre !== nombre) throw new Error(`XML mal formado: cierre inesperado de ${nombre}`);
      pila.pop();
      i = fin + 1;
    } else {
      // Etiqueta de apertura: el nombre acaba en espacio, «/» o «>». Los
      // atributos se saltan respetando las comillas (un «>» dentro de un valor
      // no cierra la etiqueta).
      let j = lt + 1;
      while (j < xml.length && !/[\s/>]/.test(xml[j])) j++;
      const nombre = local(xml.slice(lt + 1, j));
      if (!nombre) throw new Error('XML mal formado: etiqueta sin nombre');
      let comilla = '';
      while (j < xml.length) {
        const c = xml[j];
        if (comilla) {
          if (c === comilla) comilla = '';
        } else if (c === '"' || c === "'") comilla = c;
        else if (c === '>') break;
        j++;
      }
      if (j >= xml.length) throw new Error('XML mal formado: etiqueta sin cerrar');
      const autocierre = xml[j - 1] === '/';
      const nodo: NodoXml = { nombre, hijos: [], texto: '' };
      pila[pila.length - 1].hijos.push(nodo);
      if (!autocierre) pila.push(nodo);
      i = j + 1;
    }
  }
  if (pila.length !== 1) throw new Error('XML mal formado: elementos sin cerrar');
  return raiz;
}

/** Primer descendiente (en profundidad) con ese nombre local. */
export function buscar(nodo: NodoXml, nombre: string): NodoXml | undefined {
  for (const h of nodo.hijos) {
    if (h.nombre === nombre) return h;
    const dentro = buscar(h, nombre);
    if (dentro) return dentro;
  }
  return undefined;
}

/** Texto (recortado) del primer hijo directo con ese nombre, o ''. */
function hijo(nodo: NodoXml | undefined, nombre: string): string {
  return nodo?.hijos.find((h) => h.nombre === nombre)?.texto.trim() ?? '';
}

export type EstadoEnvio = 'Correcto' | 'ParcialmenteCorrecto' | 'Incorrecto';
export type EstadoRegistroAeat = 'Correcto' | 'AceptadoConErrores' | 'Incorrecto';

export interface LineaRespuesta {
  idEmisorFactura: string;
  numSerieFactura: string;
  fechaExpedicionFactura: string;
  tipoOperacion: 'Alta' | 'Anulacion' | '';
  estado: EstadoRegistroAeat | '';
  codigoError: string;
  descripcionError: string;
  /** Si la AEAT ya tenía este registro (código 3000): cómo quedó entonces. */
  duplicado?: { idPeticion: string; estado: string; codigoError: string; descripcionError: string };
}

export type RespuestaAeat =
  | {
      tipo: 'respuesta';
      csv: string;
      estadoEnvio: EstadoEnvio | '';
      /** Segundos que hay que esperar antes del siguiente envío. */
      tiempoEsperaEnvio: number | null;
      lineas: LineaRespuesta[];
    }
  | { tipo: 'fault'; codigo: string; mensaje: string };

/**
 * Interpreta lo que devuelve el servicio. Lanza un Error si no es ni una
 * respuesta ni un SOAP Fault reconocibles (una página de error HTML de un
 * proxy, por ejemplo): para quien llama es un fallo de comunicación, no una
 * respuesta de la AEAT.
 */
export function interpretarRespuesta(xml: string): RespuestaAeat {
  const doc = parsearXml(xml);
  const fault = buscar(doc, 'Fault');
  if (fault) {
    const mensaje = hijo(fault, 'faultstring') || buscar(fault, 'Text')?.texto.trim() || 'Envío rechazado por la AEAT';
    // La AEAT suele poner el código dentro del texto («Codigo[4102].El XML…»).
    const codigo = /\b(\d{4})\b/.exec(mensaje)?.[1] ?? hijo(fault, 'faultcode');
    return { tipo: 'fault', codigo, mensaje };
  }
  const resp = buscar(doc, 'RespuestaRegFactuSistemaFacturacion');
  if (!resp) throw new Error('La respuesta de la AEAT no tiene el formato esperado');
  const espera = Number.parseInt(hijo(resp, 'TiempoEsperaEnvio'), 10);
  const lineas: LineaRespuesta[] = resp.hijos
    .filter((h) => h.nombre === 'RespuestaLinea')
    .map((l) => {
      const id = l.hijos.find((h) => h.nombre === 'IDFactura');
      const op = l.hijos.find((h) => h.nombre === 'Operacion');
      const dup = l.hijos.find((h) => h.nombre === 'RegistroDuplicado');
      const tipoOp = hijo(op, 'TipoOperacion');
      const estado = hijo(l, 'EstadoRegistro');
      return {
        idEmisorFactura: hijo(id, 'IDEmisorFactura') || hijo(id, 'IDEmisorFacturaAnulada'),
        numSerieFactura: hijo(id, 'NumSerieFactura') || hijo(id, 'NumSerieFacturaAnulada'),
        fechaExpedicionFactura: hijo(id, 'FechaExpedicionFactura') || hijo(id, 'FechaExpedicionFacturaAnulada'),
        tipoOperacion: tipoOp === 'Alta' || tipoOp === 'Anulacion' ? tipoOp : '',
        estado: estado === 'Correcto' || estado === 'AceptadoConErrores' || estado === 'Incorrecto' ? estado : '',
        codigoError: hijo(l, 'CodigoErrorRegistro'),
        descripcionError: hijo(l, 'DescripcionErrorRegistro'),
        ...(dup
          ? {
              duplicado: {
                idPeticion: hijo(dup, 'IdPeticionRegistroDuplicado'),
                estado: hijo(dup, 'EstadoRegistroDuplicado'),
                codigoError: hijo(dup, 'CodigoErrorRegistro'),
                descripcionError: hijo(dup, 'DescripcionErrorRegistro'),
              },
            }
          : {}),
      };
    });
  const estadoEnvio = hijo(resp, 'EstadoEnvio');
  return {
    tipo: 'respuesta',
    csv: hijo(resp, 'CSV'),
    estadoEnvio: estadoEnvio === 'Correcto' || estadoEnvio === 'ParcialmenteCorrecto' || estadoEnvio === 'Incorrecto' ? estadoEnvio : '',
    tiempoEsperaEnvio: Number.isFinite(espera) && espera >= 0 ? espera : null,
    lineas,
  };
}
