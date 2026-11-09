/**
 * Declaración responsable del sistema informático de facturación (art. 13 del
 * Reglamento del RD 1007/2023 y art. 15 de la Orden HAC/1177/2024): la suscribe
 * el productor del sistema y tiene que estar disponible, legible e
 * individualizada, dentro del propio sistema, para cada versión.
 *
 * El art. 15.1 de la Orden fija el título, el contenido mínimo y su ORDEN
 * (letras a a l), y que cada dato vaya precedido del texto que lo describe: los
 * rótulos de abajo siguen la redacción de cada letra. Skyway la presenta
 * rellena con los datos de esta instalación y no inventa ningún dato del
 * productor: lo que falte se enseña como pendiente, y el panel avisa hasta que
 * se complete. Texto de referencia y fuentes en `docs/DECLARACION-RESPONSABLE.md`.
 */
import { config } from '../config';
import { getAjustesVerifactu, ID_SISTEMA, NOMBRE_SISTEMA, productorEfectivo } from './ajustes';
import { nifValido } from './formato';

export const TITULO_DECLARACION = 'DECLARACIÓN RESPONSABLE DEL SISTEMA INFORMÁTICO DE FACTURACIÓN';

export interface DeclaracionResponsable {
  titulo: string;
  /** Datos completos: productor, dirección, lugar y fecha. */
  completa: boolean;
  pendientes: string[];
  /** Apartados a) a l) del art. 15.1 de la Orden, en su orden. */
  apartados: { letra: string; titulo: string; texto: string }[];
}

export function declaracionResponsable(): DeclaracionResponsable {
  const productor = productorEfectivo();
  const ajustes = getAjustesVerifactu();
  const pendientes: string[] = [];
  if (!productor.nombre) pendientes.push('Razón social del productor');
  if (!nifValido(productor.nif)) pendientes.push('NIF del productor');
  if (!productor.direccion) pendientes.push('Dirección postal de contacto del productor');
  if (!ajustes.declaracionLugar.trim()) pendientes.push('Lugar de suscripción (localidad y país)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ajustes.declaracionFecha)) pendientes.push('Fecha de suscripción');
  const falta = '(pendiente)';
  // Fecha completa en el orden día, mes y año (art. 15.1.l).
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(ajustes.declaracionFecha) ? ajustes.declaracionFecha.split('-').reverse().join('/') : falta;
  const productorNombre = productor.nombre || falta;
  const apartados = [
    { letra: 'a', titulo: 'Nombre del sistema informático', texto: NOMBRE_SISTEMA },
    { letra: 'b', titulo: 'Código identificador del sistema informático', texto: ID_SISTEMA },
    { letra: 'c', titulo: 'Identificador completo de la versión del sistema informático', texto: config.version },
    {
      letra: 'd',
      titulo: 'Componentes, hardware y software, del sistema informático, y descripción de lo que hace y de sus principales funcionalidades',
      texto:
        'Software: aplicación de servidor en Node.js y TypeScript, con base de datos SQLite y panel web, que se instala en un servidor del usuario (no incluye hardware). ' +
        'Gestiona cuentas de cliente, planes, suscripciones y consumo, y su facturación: series correlativas por ejercicio; facturas completas, simplificadas y rectificativas; desglose de IVA y retención de IRPF; documento PDF con el código QR tributario; ' +
        'registros de facturación de alta y de anulación encadenados con huella SHA-256; remisión de los registros a la Agencia Estatal de Administración Tributaria por el servicio web de VERI*FACTU con certificado electrónico; ' +
        'cola de remisión con control de flujo y reintentos; subsanación de registros y registro de eventos.',
    },
    {
      letra: 'e',
      titulo: 'Indicación de si el sistema informático se ha producido de tal manera que solo pueda funcionar exclusivamente como «VERI*FACTU»',
      texto: 'Sí. El sistema remite todos los registros de facturación a la Agencia Estatal de Administración Tributaria y no permite la modalidad «NO VERI*FACTU».',
    },
    {
      letra: 'f',
      titulo: 'Indicación de si el sistema informático permite ser usado por varios obligados tributarios o por un mismo usuario para dar soporte a la facturación de varios obligados tributarios',
      texto: 'No. Cada instalación da soporte a la facturación de un único obligado tributario.',
    },
    {
      letra: 'g',
      titulo: 'Tipos de firma utilizados para firmar los registros de facturación y de evento en el caso de que el sistema informático no sea utilizado como «VERI*FACTU»',
      texto: 'No aplica: el sistema solo funciona como «VERI*FACTU».',
    },
    { letra: 'h', titulo: 'Nombre y apellidos o razón social de la persona o entidad productora del sistema informático', texto: productorNombre },
    { letra: 'i', titulo: 'Número de identificación fiscal (NIF) español de la persona o entidad productora del sistema informático', texto: nifValido(productor.nif) ? productor.nif : falta },
    { letra: 'j', titulo: 'Dirección postal completa de contacto de la persona o entidad productora del sistema informático', texto: productor.direccion.replace(/\s*\n\s*/g, ', ') || falta },
    {
      letra: 'k',
      titulo: 'Declaración de cumplimiento',
      texto:
        `${productorNombre} hace constar que el sistema informático ${NOMBRE_SISTEMA}, en la versión ${config.version}, cumple con lo dispuesto en el artículo 29.2.j) de la Ley 58/2003, de 17 de diciembre, General Tributaria, ` +
        'en el Reglamento que establece los requisitos que deben adoptar los sistemas y programas informáticos o electrónicos que soporten los procesos de facturación de empresarios y profesionales, y la estandarización de formatos de los registros de facturación, aprobado por el Real Decreto 1007/2023, de 5 de diciembre, ' +
        'en la Orden HAC/1177/2024, de 17 de octubre, y en la sede electrónica de la Agencia Estatal de Administración Tributaria para todo aquello que complete las especificaciones de dicha orden.',
    },
    { letra: 'l', titulo: 'Fecha y lugar en los que la persona o entidad productora del sistema informático suscribe la declaración responsable', texto: `${fecha}, ${ajustes.declaracionLugar.trim() || falta}` },
  ];
  return { titulo: TITULO_DECLARACION, completa: pendientes.length === 0, pendientes, apartados };
}
