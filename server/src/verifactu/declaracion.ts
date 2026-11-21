/**
 * Declaración responsable del sistema informático de facturación (art. 13 del
 * Reglamento del RD 1007/2023 y art. 15 de la Orden HAC/1177/2024): la suscribe
 * el productor del sistema y tiene que estar disponible, legible e
 * individualizada, dentro del propio sistema, y también fuera de él en un
 * formato de uso extendido y gratuito (texto o PDF), para cada versión.
 *
 * El art. 15.1 de la Orden fija el título, el contenido mínimo y su ORDEN
 * (letras a a l), y que cada dato vaya precedido del texto que lo describe. Los
 * rótulos son los del modelo de la AEAT («Ejemplos de declaraciones
 * responsables de sistemas informáticos de facturación», V0.5.1, ejemplo 1:
 * producto solo VERI*FACTU de una empresa con NIF español). Skyway la presenta
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
  /** Apartados 1.a) a 1.l) del art. 15.1 de la Orden, en su orden, y el anexo (2.c). */
  apartados: { letra: string; titulo: string; texto: string }[];
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** «17 de mayo de 2025», como el modelo de la AEAT (fecha completa: día, mes y año). */
function fechaLarga(iso: string): string {
  const [a, m, d] = iso.split('-').map(Number);
  return `${d} de ${MESES[m - 1]} de ${a}`;
}

export function declaracionResponsable(): DeclaracionResponsable {
  const productor = productorEfectivo();
  const ajustes = getAjustesVerifactu();
  const pendientes: string[] = [];
  if (!productor.nombre) pendientes.push('Razón social del productor');
  if (!nifValido(productor.nif)) pendientes.push('NIF del productor');
  if (!productor.direccion) pendientes.push('Dirección postal de contacto del productor');
  if (!ajustes.declaracionLugar.trim()) pendientes.push('Lugar de suscripción (localidad y país)');
  // La fecha vale para la versión con que se suscribió: tras actualizar
  // Skyway, la declaración de la versión nueva está por suscribir.
  const fechaValida = /^\d{4}-\d{2}-\d{2}$/.test(ajustes.declaracionFecha) && ajustes.declaracionVersion === config.version;
  if (!fechaValida) {
    pendientes.push(
      /^\d{4}-\d{2}-\d{2}$/.test(ajustes.declaracionFecha)
        ? `Fecha de suscripción de la versión ${config.version} (la guardada es de ${ajustes.declaracionVersion ? `la versión ${ajustes.declaracionVersion}` : 'otra versión'})`
        : 'Fecha de suscripción',
    );
  }
  const falta = '(pendiente)';
  const fecha = fechaValida ? fechaLarga(ajustes.declaracionFecha) : falta;
  const apartados = [
    { letra: '1.a', titulo: 'Nombre del sistema informático a que se refiere esta declaración responsable', texto: NOMBRE_SISTEMA },
    { letra: '1.b', titulo: 'Código identificador del sistema informático a que se refiere el apartado a) de esta declaración responsable', texto: ID_SISTEMA },
    { letra: '1.c', titulo: 'Identificador completo de la versión concreta del sistema informático a que se refiere esta declaración responsable', texto: config.version },
    {
      letra: '1.d',
      titulo:
        'Componentes, hardware y software, de que consta el sistema informático a que se refiere esta declaración responsable, junto con una breve descripción de lo que hace dicho sistema informático y de sus principales funcionalidades',
      texto:
        'Se trata únicamente de un software (no incluye hardware): una aplicación de servidor en Node.js y TypeScript, con base de datos SQLite y panel web, que se instala en un servidor del usuario. ' +
        'Gestiona cuentas de cliente, planes, suscripciones y consumo, y su facturación: series correlativas por ejercicio; facturas completas, simplificadas y rectificativas; desglose de IVA y retención de IRPF; documento PDF con el código QR tributario; ' +
        'registros de facturación de alta y de anulación encadenados con huella SHA-256; remisión de los registros a la Agencia Estatal de Administración Tributaria por el servicio web de VERI*FACTU con certificado electrónico; ' +
        'cola de remisión con control de flujo y reintentos; subsanación de registros y registro de eventos. Cada instalación factura para un único obligado tributario.',
    },
    {
      letra: '1.e',
      titulo:
        'Indicación de si el sistema informático a que se refiere esta declaración responsable se ha producido de tal manera que, a los efectos de cumplir con el Reglamento, solo pueda funcionar exclusivamente como «VERI*FACTU»',
      texto: 'S - Sí',
    },
    {
      letra: '1.f',
      titulo:
        'Indicación de si el sistema informático a que se refiere la declaración responsable permite ser usado por varios obligados tributarios o por un mismo usuario para dar soporte a la facturación de varios obligados tributarios',
      texto: 'N - No',
    },
    {
      letra: '1.g',
      titulo:
        'Tipos de firma utilizados para firmar los registros de facturación y de evento en el caso de que el sistema informático a que se refiere esta declaración responsable no sea utilizado como «VERI*FACTU»',
      texto:
        'Dado que se trata de un producto de facturación que solo puede ser utilizado exclusivamente en la modalidad de «VERI*FACTU», no se realiza una firma electrónica expresa de los registros de facturación generados, ya que la normativa considera que quedan firmados al ser remitidos correctamente a los servicios electrónicos de la Agencia Tributaria con la debida autenticación mediante el adecuado certificado electrónico cualificado.',
    },
    {
      letra: '1.h',
      titulo: 'Nombre y apellidos o razón social de la persona o entidad productora del sistema informático a que se refiere esta declaración responsable',
      texto: productor.nombre || falta,
    },
    {
      letra: '1.i',
      titulo: 'Número de identificación fiscal (NIF) español de la persona o entidad productora del sistema informático a que se refiere esta declaración responsable',
      texto: nifValido(productor.nif) ? productor.nif : falta,
    },
    {
      letra: '1.j',
      titulo: 'Dirección postal completa de contacto de la persona o entidad productora del sistema informático a que se refiere esta declaración responsable',
      texto: productor.direccion.replace(/\s*\n\s*/g, ', ') || falta,
    },
    {
      letra: '1.k',
      titulo: 'Declaración de cumplimiento',
      texto:
        'La persona o entidad productora del sistema informático a que se refiere esta declaración responsable hace constar que dicho sistema informático, en la versión indicada en ella, cumple con lo dispuesto en el artículo 29.2.j) de la Ley 58/2003, de 17 de diciembre, General Tributaria, ' +
        'en el Reglamento que establece los requisitos que deben adoptar los sistemas y programas informáticos o electrónicos que soporten los procesos de facturación de empresarios y profesionales, y la estandarización de formatos de los registros de facturación, aprobado por el Real Decreto 1007/2023, de 5 de diciembre, ' +
        'en la Orden HAC/1177/2024, de 17 de octubre, y en la sede electrónica de la Agencia Estatal de Administración Tributaria para todo aquello que complete las especificaciones de dicha orden.',
    },
    {
      letra: '1.l',
      titulo: 'Fecha y lugar en que la persona o entidad productora de este sistema informático suscribe esta declaración responsable del mismo',
      texto: `${fecha}. ${ajustes.declaracionLugar.trim() || falta}.`,
    },
    {
      letra: '2.c',
      titulo:
        'Anexo. Cómo cumple el sistema informático las especificaciones técnicas y funcionales de la Orden HAC/1177/2024 y de la sede electrónica de la Agencia Estatal de Administración Tributaria',
      texto:
        'La expedición de la factura y la generación de su registro de facturación se consolidan en una sola transacción de la base de datos. Los registros y el registro de eventos no se pueden modificar ni borrar (lo impiden disparadores de la base de datos). ' +
        'Antes de encadenar cada registro se comprueba el encadenamiento del anterior y la fecha y hora de generación. La remisión respeta el control de flujo de la Agencia Tributaria y reintenta los envíos pendientes al menos una vez por hora, con aviso de incidencia mientras quede alguno por remitir. ' +
        'El diseño completo está en la documentación del sistema (docs/VERIFACTU.md).',
    },
  ];
  return { titulo: TITULO_DECLARACION, completa: pendientes.length === 0, pendientes, apartados };
}

/** La declaración en texto plano, con el título y cada dato tras su rótulo. */
export function declaracionEnTexto(d: DeclaracionResponsable): string {
  const cuerpo = d.apartados.map((a) => `${a.letra}) ${a.titulo}:\n${a.texto}`).join('\n\n');
  const aviso = d.completa ? '' : `\n\nDatos pendientes: ${d.pendientes.join(', ')}.`;
  return `${d.titulo}\n\n${cuerpo}${aviso}\n`;
}
