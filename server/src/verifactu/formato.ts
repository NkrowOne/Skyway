/**
 * Formatos de los campos de los registros de facturación de VERI*FACTU, tal como
 * los definen los esquemas de la AEAT (`SuministroInformacion.xsd`) y la
 * especificación de la huella. Funciones puras: las usan la generación del
 * registro, la huella, el XML de remisión y el QR, y TIENEN que dar el mismo
 * texto en los cuatro sitios, porque la huella se calcula sobre ese texto.
 */

/** Dos cifras con cero a la izquierda. */
const dos = (v: number): string => String(v).padStart(2, '0');

/**
 * Fecha `dd-mm-aaaa` (tipo `fecha` del esquema). En UTC, como la fecha que
 * imprime el PDF (`invoicepdf.ts`): la fecha de expedición del registro tiene
 * que ser la misma que lleva la factura, y el PDF la imprime en UTC para que
 * no dependa de la zona horaria del proceso.
 */
export function fechaAeat(ms: number): string {
  const d = new Date(ms);
  return `${dos(d.getUTCDate())}-${dos(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

/** Zona horaria con la que se escribe `FechaHoraHusoGenRegistro`. */
export const ZONA_HORARIA = 'Europe/Madrid';

const formateadores = new Map<string, Intl.DateTimeFormat>();
function formateador(zona: string): Intl.DateTimeFormat {
  let f = formateadores.get(zona);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: zona,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formateadores.set(zona, f);
  }
  return f;
}

/**
 * Fecha, hora y huso horario de generación del registro: `2024-01-01T19:20:30+01:00`
 * (ISO 8601 con desfase, como en los ejemplos de la AEAT; sin milisegundos ni
 * «Z»). Se escribe en hora peninsular española: el instante es el mismo en
 * cualquier huso, pero el desfase explícito es lo que pide el campo.
 */
export function fechaHoraHuso(ms: number, zona: string = ZONA_HORARIA): string {
  const segundo = Math.floor(ms / 1000) * 1000;
  const p = Object.fromEntries(formateador(zona).formatToParts(new Date(segundo)).map((x) => [x.type, x.value]));
  const anio = Number(p.year);
  const mes = Number(p.month);
  const dia = Number(p.day);
  const hora = Number(p.hour);
  const minuto = Number(p.minute);
  const seg = Number(p.second);
  const desfaseMin = Math.round((Date.UTC(anio, mes - 1, dia, hora, minuto, seg) - segundo) / 60_000);
  const signo = desfaseMin < 0 ? '-' : '+';
  const abs = Math.abs(desfaseMin);
  return `${anio}-${dos(mes)}-${dos(dia)}T${dos(hora)}:${dos(minuto)}:${dos(seg)}${signo}${dos(Math.floor(abs / 60))}:${dos(abs % 60)}`;
}

/**
 * Importe en euros con punto decimal y siempre dos decimales (`12.30`, `-5.00`),
 * dentro del patrón `ImporteSgn12.2Type`. Siempre el mismo texto para el mismo
 * importe: la huella se calcula sobre él y la AEAT la recalcula con lo que
 * recibe en el XML.
 */
export function importeAeat(cents: number): string {
  const n = Math.round(Number.isFinite(cents) ? cents : 0);
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}${Math.floor(abs / 100)}.${dos(abs % 100)}`;
}

/** Tipo impositivo (`Tipo2.2Type`): `21.00`, `10.00`, `5.20`. */
export function tipoAeat(rate: number): string {
  const v = Math.round((Number.isFinite(rate) ? rate : 0) * 100);
  return `${Math.floor(Math.abs(v) / 100)}.${dos(Math.abs(v) % 100)}`;
}

/**
 * NIF tal como lo espera la AEAT: mayúsculas y sin espacios, guiones ni puntos.
 * El prefijo «ES» de un NIF-IVA español (ESB12345678) se quita: el campo NIF
 * tiene exactamente 9 caracteres.
 */
export function normalizarNif(valor: string | null | undefined): string {
  const limpio = (valor ?? '').toUpperCase().replace(/[\s.\-/]/g, '');
  return /^ES[0-9A-Z]{9}$/.test(limpio) ? limpio.slice(2) : limpio;
}

const LETRAS_DNI = 'TRWAGMYFPDXBNJZSQVHLCKE';

/**
 * ¿Es un NIF español válido? DNI, NIE, NIF de entidades (CIF) y los NIF de
 * personas físicas sin DNI (K, L, M). Con dígito de control salvo en K/L/M,
 * cuyo algoritmo no está publicado de forma uniforme: ahí basta el formato.
 * La AEAT rechaza el registro entero con un NIF mal formado (códigos 1123 y
 * 4109); comprobarlo antes de emitir evita una factura emitida con su registro
 * rechazado.
 */
export function nifValido(nif: string): boolean {
  if (!/^[0-9A-Z]{9}$/.test(nif)) return false;
  if (/^\d{8}[A-Z]$/.test(nif)) return LETRAS_DNI[Number(nif.slice(0, 8)) % 23] === nif[8];
  if (/^[XYZ]\d{7}[A-Z]$/.test(nif)) {
    const numero = Number(`${'XYZ'.indexOf(nif[0])}${nif.slice(1, 8)}`);
    return LETRAS_DNI[numero % 23] === nif[8];
  }
  if (/^[KLM]\d{7}[A-Z]$/.test(nif)) return true;
  if (/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(nif)) {
    const digitos = nif.slice(1, 8).split('').map(Number);
    let suma = 0;
    digitos.forEach((d, i) => {
      if (i % 2 === 1) suma += d;
      else {
        const doble = d * 2;
        suma += Math.floor(doble / 10) + (doble % 10);
      }
    });
    const control = (10 - (suma % 10)) % 10;
    const fin = nif[8];
    return fin === String(control) || fin === 'JABCDEFGHI'[control];
  }
  return false;
}

/**
 * Texto libre para un campo de la AEAT: sin los caracteres que el servicio
 * rechaza (código 1287: «<», «>», «"», «'», «=»), sin saltos de línea ni
 * espacios repetidos, y recortado a la longitud máxima del campo. Las comillas
 * se cambian por las tipográficas y no se quitan: un nombre como O'Donnell
 * debe seguir leyéndose igual.
 */
export function textoAeat(valor: string | null | undefined, max: number): string {
  const limpio = (valor ?? '')
    .normalize('NFC')
    .replace(/'/g, '’')
    .replace(/"/g, '”')
    .replace(/[<>=]/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(limpio).slice(0, max).join('').trim();
}

/**
 * Escapa un valor para el contenido de un elemento XML. Los caracteres que la
 * AEAT rechaza ya no llegan aquí (`textoAeat`), pero el número de factura o un
 * NIF extranjero sí pueden traer un «&».
 */
export function escaparXml(valor: string): string {
  return valor.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
