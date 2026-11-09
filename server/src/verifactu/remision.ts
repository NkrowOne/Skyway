/**
 * Cola de remisión de los registros de facturación a la AEAT (modalidad
 * VERI*FACTU, art. 15 y 16 del RD 1007/2023).
 *
 * Los registros nacen en `invoice_ledger` como «pendiente» dentro de la
 * transacción de la factura; aquí se envían por lotes al servicio web SOAP de
 * la AEAT con el certificado electrónico del obligado:
 * - Una cola por cadena (emisor y entorno), con sus esperas y sus fallos: un
 *   corte en una cadena no frena a las demás (`estadocola.ts`).
 * - Hasta 1000 registros por envío, de una sola cadena, en su orden y con un
 *   solo registro por factura en cada envío.
 * - Control de flujo: tras cada respuesta se espera el `TiempoEsperaEnvio` que
 *   indica la AEAT (60 s por defecto) salvo que ya haya 1000 registros en cola.
 * - Sin conexión, con la AEAT caída o con el envío rechazado entero por algo
 *   que no es de un registro, los registros siguen en cola y se reintenta con
 *   esperas crecientes hasta una hora; se marcan como afectados por una
 *   incidencia. Si el rechazo lo causa un registro, se parte el lote hasta dar
 *   con él: queda rechazado y el resto sigue.
 * - Si la respuesta se pierde (corte a mitad), el reenvío es seguro: la AEAT
 *   contesta «duplicado» (3000) con el estado que ya tenía, y se toma ese. Sin
 *   un envío incierto antes, un 3000 es otra factura con ese número: rechazo.
 *
 * Nada de esto toca la factura: un fallo de remisión no deshace la emisión,
 * que ya es un hecho; se ve en Contabilidad y en Alertas.
 */
import https from 'node:https';
import { fireAlert } from '../alerts';
import { auditSystem } from '../audit';
import { getBillingProfile } from '../company';
import {
  actualizarRemisionRegistro,
  cadenasConPendientes,
  contarPendientesConIncidencia,
  getInvoice,
  marcarIncidenciaPendientes,
  pendientesDeCadena,
  registrosDeFactura,
  resolveAlertsByDedupe,
  transaction,
} from '../db';
import type { EntornoVerifactu, EstadoRemision, IssuerSnapshot, RegistroFacturacionRow } from '../types';
import { safeParse } from '../util';
import { URL_ENVIO, URL_ENVIO_SELLO, verifactuActivo } from './ajustes';
import { credencialesCertificado, infoCertificado } from './certificado';
import { claveCadena, estadoCadena, EstadoCola, getEstadoCola, guardarEstadoCola } from './estadocola';
import { anotarEvento } from './eventos';
import { normalizarNif, textoAeat } from './formato';
import { registroAeat } from './registro';
import type { ObligadoEmision, RegistroAeat } from './tipos';
import { interpretarRespuesta, LineaRespuesta, MAX_REGISTROS_ENVIO, soapRegFactu } from './xml';

/** Espera entre envíos si la AEAT no indica otra (segundos). */
export const ESPERA_POR_DEFECTO_S = 60;
/** Esperas tras un fallo, crecientes (segundos). */
const ESPERAS_TRAS_FALLO_S = [60, 120, 300, 900, 1800, 3600];
/** Rechazos del envío entero que no se arreglan reintentando: falta un ajuste. */
const FALLOS_DE_CONFIGURACION = new Set(['4104', '4107', '4108', '4109', '4112', '4115', '4116', '4123', '4141']);
const TIEMPO_MAX_PETICION_MS = 60_000;
const MAX_BYTES_RESPUESTA = 8 * 1024 * 1024;
const ALERTA_CONEXION = 'verifactu:remision';

export interface Certificado {
  pfx: Buffer;
  passphrase: string;
}

export interface RespuestaHttp {
  status: number;
  cuerpo: string;
}

/**
 * Cómo se habla con la AEAT. Las pruebas pasan uno simulado. Si falla después
 * de entregar la petición (la respuesta se pierde o no llega a tiempo), el
 * error lleva `enviado: true`: la AEAT pudo guardar el lote.
 */
export type Transporte = (url: string, xml: string, cert: Certificado, opts: { timeoutMs: number; ca?: Buffer }) => Promise<RespuestaHttp>;

/** Petición HTTPS con certificado de cliente. `method` GET solo para probar la conexión. */
export function peticionHttps(
  url: string,
  cuerpo: string | null,
  cert: Certificado,
  opts: { timeoutMs: number; ca?: Buffer },
): Promise<RespuestaHttp> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const datos = cuerpo === null ? null : Buffer.from(cuerpo, 'utf8');
    // 'finish': la petición entera ha salido hacia la AEAT. Un fallo antes (DNS,
    // conexión rechazada, TLS) deja claro que no ha llegado; uno después, no.
    let entregada = false;
    const rechazar = (err: Error): void => reject(Object.assign(err, { enviado: entregada }));
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: datos ? 'POST' : 'GET',
        pfx: cert.pfx,
        passphrase: cert.passphrase,
        ...(opts.ca ? { ca: opts.ca } : {}),
        minVersion: 'TLSv1.2',
        // Sin agente compartido: cada conexión lleva el certificado actual, y
        // uno retirado no sigue vivo en una conexión reutilizada.
        agent: false,
        timeout: opts.timeoutMs,
        headers: datos
          ? { 'Content-Type': 'text/xml; charset=utf-8', 'Content-Length': datos.length, SOAPAction: '""', Accept: 'text/xml' }
          : { Accept: 'text/xml' },
      },
      (res) => {
        const trozos: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > MAX_BYTES_RESPUESTA) {
            req.destroy(new Error('La respuesta de la AEAT es demasiado grande'));
            return;
          }
          trozos.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, cuerpo: Buffer.concat(trozos).toString('utf8') }));
        res.on('error', rechazar);
      },
    );
    req.on('finish', () => {
      entregada = true;
    });
    req.on('timeout', () => req.destroy(new Error(`La AEAT no ha respondido en ${Math.round(opts.timeoutMs / 1000)} s`)));
    req.on('error', rechazar);
    req.end(datos ?? undefined);
  });
}

export const transporteHttps: Transporte = (url, xml, cert, opts) => peticionHttps(url, xml, cert, opts);

/** Punto de acceso del servicio según el entorno y el tipo de certificado cargado. */
export function urlServicio(entorno: EntornoVerifactu): string {
  return infoCertificado()?.sello ? URL_ENVIO_SELLO[entorno] : URL_ENVIO[entorno];
}

/**
 * Aviso de incidencia (art. 16.4 de la Orden HAC/1177/2024): desde que algo
 * impide remitir y mientras quede alguno de esos registros por remitir, el
 * sistema tiene que avisar e indicar cuántos faltan. Va ligado a los registros
 * con incidencia en cola: se abre al marcarlos y se cierra cuando no queda
 * ninguno, no con el primer envío que llega. El número vivo está en
 * Contabilidad → VERI*FACTU.
 */
function avisarIncidencia(motivo: string, explicacion: string): void {
  const pendientes = pendientesDelAviso();
  if (pendientes === 0) return;
  fireAlert({
    severity: 'critical',
    type: 'verifactu_remision',
    title: `${pendientes} ${pendientes === 1 ? 'registro de facturación pendiente' : 'registros de facturación pendientes'} de remitir a la AEAT`,
    message: motivo.slice(0, 300),
    explanation: explicacion,
    dedupeKey: ALERTA_CONEXION,
  });
}

/**
 * Registros que cuentan para el aviso de incidencia. Con VERI*FACTU desactivado
 * (solo se puede sin registros de producción), lo que quede en cola de pruebas
 * no tiene efectos fiscales ni se remite: no es una incidencia.
 */
export function pendientesDelAviso(): number {
  return contarPendientesConIncidencia(verifactuActivo() ? undefined : 'produccion');
}

/** Cierra el aviso de incidencia si ya no queda en cola ningún registro que cuente. */
export function cerrarAvisoSiProcede(): void {
  if (pendientesDelAviso() === 0) resolveAlertsByDedupe(ALERTA_CONEXION);
}

/** Espera de la AEAT entre envíos para la cadena: la última que indicó, o 60 s. */
const esperaCadena = (ec: { esperaS: number }): number => (ec.esperaS > 0 ? ec.esperaS : ESPERA_POR_DEFECTO_S) * 1000;

// ---------------------------------------------------------------------------
// Envío de un lote
// ---------------------------------------------------------------------------

export { getEstadoCola } from './estadocola';
export type { EstadoCola } from './estadocola';

/**
 * Rechazos del envío entero que los causa un registro (XML fuera de esquema,
 * fecha mal formada, caracteres no UTF-8…): reintentar el mismo lote fallaría
 * siempre. Se parte el lote por la mitad hasta dar con el culpable, que queda
 * rechazado, y el resto sigue.
 */
const FALLOS_DE_REGISTRO = new Set(['4102', '4103', '4106', '4119', '4136', '4137', '4138']);

/**
 * Lote siguiente de una cadena: los primeros registros en cola con la misma
 * incidencia, sin repetir factura y hasta `max`. Se corta en el primero que no
 * encaja (no se salta): el orden de envío es el de la cadena.
 */
export function siguienteLote(pendientes: RegistroFacturacionRow[], max: number = MAX_REGISTROS_ENVIO): RegistroFacturacionRow[] {
  const lote: RegistroFacturacionRow[] = [];
  const facturas = new Set<string>();
  for (const r of pendientes) {
    const p = lote[0];
    if (p && (r.entorno !== p.entorno || r.emisor_nif !== p.emisor_nif || r.incidencia !== p.incidencia)) break;
    if (facturas.has(r.invoice_id) || lote.length >= max) break;
    facturas.add(r.invoice_id);
    lote.push(r);
  }
  return lote;
}

/** Nombre del obligado para la cabecera: el del alta del lote, el de la factura o el del perfil. */
function obligado(lote: RegistroFacturacionRow[], registros: RegistroAeat[]): ObligadoEmision {
  const nif = lote[0].emisor_nif;
  const alta = registros.find((r): r is Extract<RegistroAeat, { tipo: 'alta' }> => r.tipo === 'alta');
  let nombre = alta?.alta.NombreRazonEmisor ?? '';
  if (!nombre) {
    const inv = getInvoice(lote[0].invoice_id);
    nombre = textoAeat(safeParse<IssuerSnapshot | null>(inv?.issuer_snapshot ?? null, null)?.companyName, 120);
  }
  if (!nombre) {
    const perfil = getBillingProfile();
    if (normalizarNif(perfil.taxId) === nif) nombre = textoAeat(perfil.companyName, 120);
  }
  return { NombreRazon: nombre || nif, NIF: nif };
}

/** Línea de la respuesta que corresponde a un registro (por número, fecha y operación). */
function lineaDe(r: RegistroFacturacionRow, registro: RegistroAeat, lineas: LineaRespuesta[], usadas: Set<number>): LineaRespuesta | undefined {
  const fecha = registro.tipo === 'alta' ? registro.alta.IDFactura.FechaExpedicionFactura : registro.anulacion.IDFactura.FechaExpedicionFacturaAnulada;
  const op = registro.tipo === 'alta' ? 'Alta' : 'Anulacion';
  const i = lineas.findIndex(
    (l, k) => !usadas.has(k) && l.numSerieFactura === r.num_serie_factura && l.fechaExpedicionFactura === fecha && (l.tipoOperacion === '' || l.tipoOperacion === op),
  );
  if (i === -1) return undefined;
  usadas.add(i);
  return lineas[i];
}

/**
 * Estado del registro según la línea de respuesta, con el caso del duplicado.
 * `reenvio`: un envío anterior del registro acabó sin saber si la AEAT lo
 * guardó (`envio_incierto`). Un envío rechazado entero (SOAP Fault) no cuenta:
 * ahí la AEAT no guardó nada.
 */
function estadoDeLinea(
  l: LineaRespuesta,
  reenvio: boolean,
): { estado: EstadoRemision; codigo: string | null; descripcion: string | null; idPeticion: string | null } {
  if (l.estado === 'Correcto') return { estado: 'correcto', codigo: null, descripcion: null, idPeticion: null };
  if (l.estado === 'AceptadoConErrores') return { estado: 'aceptado_con_errores', codigo: l.codigoError || null, descripcion: l.descripcionError || null, idPeticion: null };
  // Duplicado: tras un reenvío, la AEAT ya tenía ESTE registro (se perdió la
  // respuesta) y manda el estado con que lo guardó entonces. En el primer
  // envío, en cambio, quiere decir que la AEAT ya tiene otra factura con ese
  // número y fecha (de otro sistema, o un número reutilizado): es un rechazo.
  if (l.codigoError === '3000' && l.duplicado && reenvio) {
    const d = l.duplicado;
    if (d.estado === 'Correcta' || d.estado === 'Anulada') return { estado: 'correcto', codigo: null, descripcion: null, idPeticion: d.idPeticion || null };
    if (d.estado === 'AceptadaConErrores') {
      return { estado: 'aceptado_con_errores', codigo: d.codigoError || l.codigoError, descripcion: d.descripcionError || l.descripcionError || null, idPeticion: d.idPeticion || null };
    }
  }
  return { estado: 'incorrecto', codigo: l.codigoError || null, descripcion: l.descripcionError || 'Registro rechazado por la AEAT', idPeticion: null };
}

/** Alerta por un registro que la AEAT ha rechazado o aceptado con errores. */
function alertaRegistro(r: RegistroFacturacionRow, estado: EstadoRemision, codigo: string | null, descripcion: string | null): void {
  const inv = getInvoice(r.invoice_id);
  const numero = inv?.number ?? r.num_serie_factura;
  fireAlert({
    severity: estado === 'incorrecto' ? 'critical' : 'warning',
    type: 'verifactu_registro',
    title: estado === 'incorrecto' ? `La AEAT ha rechazado el registro de la factura ${numero}` : `La AEAT ha aceptado con errores el registro de la factura ${numero}`,
    message: `${codigo ? `[${codigo}] ` : ''}${descripcion ?? ''}`.slice(0, 300),
    explanation:
      'La factura sigue emitida. Corrige el dato que indica la AEAT y pulsa «Subsanar» en Contabilidad → VERI*FACTU para generar el registro de subsanación. Si el error está en los datos impresos de la factura, corrígela con una factura rectificativa.',
    dedupeKey: `verifactu:${r.invoice_id}:${r.id}`,
  });
}

export interface ResultadoRemision {
  enviado: boolean;
  motivo?: 'en_curso' | 'sin_pendientes' | 'sin_certificado' | 'esperando';
  registros?: number;
  resultado?: EstadoCola['ultimoResultado'];
  error?: string;
}

let enCurso = false;

/**
 * Un paso de la cola: si toca, envía un lote. `forzar` (el botón «Enviar
 * ahora») se salta la espera tras un fallo, pero nunca la que pide la AEAT.
 */
export async function remisionTick(opts: { ahora?: number; transporte?: Transporte; forzar?: boolean; ca?: Buffer } = {}): Promise<ResultadoRemision> {
  if (enCurso) return { enviado: false, motivo: 'en_curso' };
  enCurso = true;
  try {
    return await paso(opts);
  } finally {
    enCurso = false;
  }
}

async function paso(opts: { ahora?: number; transporte?: Transporte; forzar?: boolean; ca?: Buffer }): Promise<ResultadoRemision> {
  const ahora = opts.ahora ?? Date.now();
  // Con VERI*FACTU desactivado, la cola de pruebas se queda quieta: se remitirá
  // si se vuelve a activar. (Con registros de producción no se puede desactivar.)
  const activo = verifactuActivo();
  const cadenas = cadenasConPendientes().filter((c) => activo || c.entorno === 'produccion');
  if (cadenas.length === 0) return { enviado: false, motivo: 'sin_pendientes' };
  const cert = credencialesCertificado();
  if (!cert) {
    // Sin certificado no se puede remitir: los registros esperan y constan
    // como generados durante una incidencia.
    marcarIncidenciaPendientes();
    avisarIncidencia(
      'Falta el certificado electrónico para remitir los registros.',
      'Carga el certificado en Contabilidad → VERI*FACTU. Los registros siguen en cola y se remitirán en cuanto esté cargado.',
    );
    return { enviado: false, motivo: 'sin_certificado' };
  }

  // La primera cadena (la de registro pendiente más antiguo) que pueda enviar
  // ya. La espera tras un fallo no se salta nunca solo por tener el lote lleno:
  // con la AEAT caída, eso sería reintentar cada 10 s. La que pide la AEAT sí
  // (art. 16 de la Orden: se espera el tiempo indicado o a tener 1000).
  const estado = getEstadoCola();
  let lote: RegistroFacturacionRow[] = [];
  for (const c of cadenas) {
    const ec = estadoCadena(estado, c.emisor_nif, c.entorno);
    if (!opts.forzar && ahora < ec.reintentoHasta) continue;
    const max = ec.aislarRestantes > 0 ? Math.max(1, Math.min(ec.aislarLote || 1, ec.aislarRestantes)) : MAX_REGISTROS_ENVIO;
    const candidato = siguienteLote(pendientesDeCadena(c.emisor_nif, c.entorno, MAX_REGISTROS_ENVIO + 1), max);
    if (candidato.length < MAX_REGISTROS_ENVIO && ahora < ec.esperaHasta) continue;
    lote = candidato;
    break;
  }
  if (lote.length === 0) return { enviado: false, motivo: 'esperando' };
  const nif = lote[0].emisor_nif;
  const entorno = lote[0].entorno;

  // Un registro cuyo contenido guardado no se puede leer (solo pasa si se ha
  // tocado la base de datos a mano) no se podrá remitir nunca: queda rechazado
  // con su alerta, para subsanarlo desde la factura, y la cola sigue.
  const ilegibles = lote.filter((r) => {
    try {
      registroAeat(r);
      return false;
    } catch {
      return true;
    }
  });
  if (ilegibles.length > 0) {
    const descripcion = 'Los datos guardados del registro no se pueden leer: no se puede remitir. Subsánalo para generar uno nuevo desde la factura.';
    transaction(() => {
      for (const r of ilegibles) actualizarRemisionRegistro(r.id, { estado_remision: 'incorrecto', respuesta_at: ahora, codigo_error: null, descripcion_error: descripcion });
      anotarEvento('anomalia_cadena', `${entorno} ${nif}: ${ilegibles.map((r) => r.num_serie_factura).join(', ')}: datos del registro ilegibles`, ahora);
    });
    for (const r of ilegibles) alertaRegistro(r, 'incorrecto', null, descripcion);
    return paso(opts);
  }
  const registros = lote.map(registroAeat);
  const xml = soapRegFactu(obligado(lote, registros), registros, { incidencia: lote[0].incidencia === 1 });
  transaction(() => {
    for (const r of lote) actualizarRemisionRegistro(r.id, { intentos: r.intentos + 1, ultimo_intento_at: ahora });
  });

  const transporte = opts.transporte ?? transporteHttps;
  // Un envío que salió y no tuvo respuesta del servicio deja la duda de si la
  // AEAT guardó el lote: un «duplicado» en el reenvío será el propio registro.
  const incierto = (): void =>
    transaction(() => {
      for (const r of lote) actualizarRemisionRegistro(r.id, { envio_incierto: 1 });
    });
  let http: RespuestaHttp;
  try {
    http = await transporte(urlServicio(entorno), xml, cert, { timeoutMs: TIEMPO_MAX_PETICION_MS, ca: opts.ca });
  } catch (err) {
    const enviado = (err as { enviado?: unknown } | null)?.enviado === true;
    if (enviado) incierto();
    return fallo(lote, ahora, String((err as Error)?.message ?? err), null, enviado);
  }
  let respuesta: ReturnType<typeof interpretarRespuesta>;
  try {
    respuesta = interpretarRespuesta(http.cuerpo);
  } catch {
    // Respuesta HTTP que no es del servicio (un proxy, una página de error): la
    // petición llegó a algún sitio y no se sabe si la AEAT la procesó.
    incierto();
    return fallo(lote, ahora, `La AEAT ha respondido con un error HTTP ${http.status} sin una respuesta del servicio`, null, true);
  }

  if (respuesta.tipo === 'fault') {
    const mensaje = `${respuesta.codigo ? `[${respuesta.codigo}] ` : ''}${respuesta.mensaje}`;
    if (FALLOS_DE_REGISTRO.has(respuesta.codigo)) return rechazoPorRegistro(lote, ahora, mensaje, respuesta.codigo);
    return fallo(lote, ahora, mensaje, respuesta.codigo, true);
  }

  const usadas = new Set<number>();
  const conErrores: { r: RegistroFacturacionRow; codigo: string | null; descripcion: string | null; estado: EstadoRemision }[] = [];
  const aceptados: RegistroFacturacionRow[] = [];
  let sinLinea = 0;
  transaction(() => {
    lote.forEach((r, i) => {
      const linea = lineaDe(r, registros[i], respuesta.lineas, usadas);
      if (!linea) {
        // La respuesta no dice nada de él: no se sabe si la AEAT lo guardó.
        sinLinea++;
        actualizarRemisionRegistro(r.id, { envio_incierto: 1 });
        return;
      }
      // `r` es la fila de antes de este envío: lo incierto es de envíos anteriores.
      const e = estadoDeLinea(linea, r.envio_incierto === 1);
      actualizarRemisionRegistro(r.id, {
        estado_remision: e.estado,
        csv_aeat: e.estado === 'incorrecto' ? null : respuesta.csv || null,
        respuesta_at: ahora,
        codigo_error: e.codigo,
        descripcion_error: e.descripcion ? e.descripcion.slice(0, 500) : null,
        id_peticion: e.idPeticion,
      });
      if (e.estado !== 'correcto') conErrores.push({ r, codigo: e.codigo, descripcion: e.descripcion, estado: e.estado });
      if (e.estado !== 'incorrecto') aceptados.push(r);
    });
    const rechazados = conErrores.filter((c) => c.estado === 'incorrecto').length;
    anotarEvento(
      conErrores.length ? 'envio_con_errores' : 'envio_correcto',
      `${entorno} ${nif}: ${lote.length} registros, ${lote.length - conErrores.length - sinLinea} correctos, ${conErrores.length - rechazados} aceptados con errores, ${rechazados} rechazados${respuesta.csv ? `, CSV ${respuesta.csv}` : ''}`,
      ahora,
    );
  });

  const esperaS = respuesta.tiempoEsperaEnvio ?? ESPERA_POR_DEFECTO_S;
  const espera = esperaS * 1000;
  const resultado: EstadoCola['ultimoResultado'] =
    respuesta.estadoEnvio === 'Correcto' && conErrores.length === 0 ? 'correcto' : respuesta.estadoEnvio === 'Incorrecto' ? 'incorrecto' : 'parcial';
  const actual = getEstadoCola();
  const ec = estadoCadena(actual, nif, entorno);
  const restantes = Math.max(0, ec.aislarRestantes - lote.length);
  actual.cadenas[claveCadena(nif, entorno)] = {
    esperaHasta: ahora + espera,
    reintentoHasta: 0,
    fallosSeguidos: 0,
    aislarRestantes: restantes,
    aislarLote: restantes > 0 ? ec.aislarLote : 0,
    esperaS,
  };
  guardarEstadoCola({
    ...actual,
    ultimoEnvioAt: ahora,
    ultimoResultado: resultado,
    ultimoCsv: respuesta.csv || actual.ultimoCsv,
    ultimoError: sinLinea ? `La respuesta no traía ${sinLinea} de los ${lote.length} registros enviados: se reenviarán.` : null,
  });
  cerrarAvisoSiProcede();
  // Un registro que la AEAT acepta deja resueltas las alertas de los registros
  // anteriores de su factura (el alta rechazada que se ha subsanado, la
  // anulación que se ha repetido).
  for (const r of aceptados) {
    for (const otro of registrosDeFactura(r.invoice_id)) if (otro.id !== r.id) resolveAlertsByDedupe(`verifactu:${r.invoice_id}:${otro.id}`);
  }
  for (const c of conErrores) alertaRegistro(c.r, c.estado, c.codigo, c.descripcion);
  return { enviado: true, registros: lote.length, resultado };
}

/**
 * La AEAT ha rechazado el envío entero por un defecto de un registro. Con
 * varios registros en el lote, la cadena sigue con lotes de la mitad; con uno
 * solo, ese es el culpable: queda rechazado (con su alerta, para subsanarlo o
 * rectificar) y lo que quedaba del lote rechazado se prueba de una vez.
 */
function rechazoPorRegistro(lote: RegistroFacturacionRow[], ahora: number, mensaje: string, codigo: string): ResultadoRemision {
  const nif = lote[0].emisor_nif;
  const entorno = lote[0].entorno;
  const estado = getEstadoCola();
  const ec = estadoCadena(estado, nif, entorno);
  const culpable = lote.length === 1 ? lote[0] : null;
  transaction(() => {
    if (culpable) {
      actualizarRemisionRegistro(culpable.id, { estado_remision: 'incorrecto', respuesta_at: ahora, codigo_error: codigo, descripcion_error: mensaje.slice(0, 500) });
    } else {
      for (const r of lote) actualizarRemisionRegistro(r.id, { incidencia: 1 });
    }
    anotarEvento(
      'envio_rechazado',
      culpable
        ? `${entorno} ${nif}: el registro de ${culpable.num_serie_factura} hace rechazar el envío. ${mensaje}`
        : `${entorno} ${nif}: ${lote.length} registros; se reenvían en lotes más pequeños para encontrar el que lo provoca. ${mensaje}`,
      ahora,
    );
  });
  // Lo que queda del lote rechazado por resolver, y el tamaño del próximo lote.
  const restantes = culpable ? Math.max(0, ec.aislarRestantes - 1) : ec.aislarRestantes > 0 ? ec.aislarRestantes : lote.length;
  estado.cadenas[claveCadena(nif, entorno)] = {
    ...ec,
    // La AEAT ha recibido el envío: también aquí se respeta su espera. Y ha
    // contestado: si venía de un corte, el corte ha terminado.
    esperaHasta: ahora + esperaCadena(ec),
    reintentoHasta: 0,
    fallosSeguidos: 0,
    aislarRestantes: restantes,
    aislarLote: culpable ? restantes : Math.ceil(lote.length / 2),
  };
  guardarEstadoCola({ ...estado, ultimoEnvioAt: ahora, ultimoResultado: 'rechazado', ultimoError: mensaje.slice(0, 500) });
  auditSystem('verifactu_remision_fallida', `${entorno} ${nif}: ${lote.length} registros: ${mensaje}`.slice(0, 300));
  if (culpable) {
    alertaRegistro(culpable, 'incorrecto', codigo, mensaje);
    cerrarAvisoSiProcede();
  } else {
    // Los del lote ya no llegan a su hora: constan con incidencia y se avisa.
    avisarIncidencia(
      mensaje,
      'Un registro del envío hace que la AEAT lo rechace entero. Skyway lo reenvía en lotes más pequeños para encontrarlo: ese quedará rechazado, para subsanarlo, y el resto se remitirá en unos minutos.',
    );
  }
  return { enviado: true, registros: lote.length, resultado: 'rechazado', error: mensaje };
}

/**
 * El envío no ha llegado o la AEAT lo ha rechazado entero: los registros siguen
 * en cola. `pudoLlegar`: la petición salió (rechazo entero, respuesta perdida):
 * la AEAT pudo contarlo como envío, así que su espera entre envíos también
 * cuenta y «Enviar ahora» no se la salta.
 */
function fallo(lote: RegistroFacturacionRow[], ahora: number, mensaje: string, codigo: string | null, pudoLlegar: boolean): ResultadoRemision {
  const nif = lote[0].emisor_nif;
  const entorno = lote[0].entorno;
  const estado = getEstadoCola();
  const ec = estadoCadena(estado, nif, entorno);
  const fallos = ec.fallosSeguidos + 1;
  const configuracion = !!codigo && FALLOS_DE_CONFIGURACION.has(codigo);
  const espera = configuracion ? 3600 : ESPERAS_TRAS_FALLO_S[Math.min(fallos - 1, ESPERAS_TRAS_FALLO_S.length - 1)];
  transaction(() => {
    // Ni este lote ni lo que espera detrás en la cadena llegan a su hora:
    // todos constan como afectados por la incidencia (art. 16.4 de la Orden).
    marcarIncidenciaPendientes({ emisorNif: nif, entorno });
    anotarEvento(codigo ? 'envio_rechazado' : 'error_conexion', `${entorno} ${nif}: ${lote.length} registros. ${mensaje}`, ahora);
  });
  estado.cadenas[claveCadena(nif, entorno)] = {
    ...ec,
    reintentoHasta: ahora + espera * 1000,
    fallosSeguidos: fallos,
    esperaHasta: pudoLlegar ? Math.max(ec.esperaHasta, ahora + esperaCadena(ec)) : ec.esperaHasta,
  };
  guardarEstadoCola({ ...estado, ultimoEnvioAt: ahora, ultimoResultado: codigo ? 'rechazado' : 'fallo', ultimoError: mensaje.slice(0, 500) });
  auditSystem('verifactu_remision_fallida', `${entorno} ${nif}: ${lote.length} registros: ${mensaje}`.slice(0, 300));
  avisarIncidencia(
    mensaje,
    configuracion
      ? 'La AEAT rechaza el envío por un dato de configuración: revisa el certificado y el NIF del emisor en Contabilidad → VERI*FACTU. Los registros siguen en cola y se remitirán cuando se corrija.'
      : 'Los registros siguen en cola y Skyway reintenta solo, con esperas de hasta una hora. Si el corte persiste, revisa la conexión del servidor y el certificado en Contabilidad → VERI*FACTU.',
  );
  return { enviado: true, registros: lote.length, resultado: codigo ? 'rechazado' : 'fallo', error: mensaje };
}

// ---------------------------------------------------------------------------
// Bucle en segundo plano
// ---------------------------------------------------------------------------

const INTERVALO_MS = 10_000;
let intervalo: NodeJS.Timeout | null = null;
let aviso: NodeJS.Timeout | null = null;
let registro: { warn: (msg: string) => void } | null = null;

function tickSeguro(): void {
  remisionTick().catch((err) => registro?.warn(`VERI*FACTU: ${(err as Error)?.message ?? err}`));
}

/** Arranca el envío periódico (cada 10 s mira si hay registros y si toca enviar). */
export function startRemisionVerifactu(log: { warn: (msg: string) => void }): void {
  if (intervalo) return;
  registro = log;
  intervalo = setInterval(tickSeguro, INTERVALO_MS);
  intervalo.unref();
  tickSeguro();
}

export function stopRemisionVerifactu(): void {
  if (intervalo) clearInterval(intervalo);
  if (aviso) clearTimeout(aviso);
  intervalo = null;
  aviso = null;
}

/**
 * Hay un registro nuevo: se intenta enviar en un segundo en vez de esperar al
 * siguiente paso del bucle. Sin bucle arrancado (las pruebas) no hace nada.
 */
export function avisarRemision(): void {
  if (!intervalo || aviso) return;
  aviso = setTimeout(() => {
    aviso = null;
    tickSeguro();
  }, 1000);
  aviso.unref();
}

/**
 * Prueba la conexión con el certificado: una petición GET al servicio. La AEAT
 * solo responde si acepta el certificado en el TLS (a un GET contesta con un
 * error 4135, «esta URL no puede usarse mediante GET», que aquí es la señal de
 * que todo está en orden). No envía ningún registro.
 */
export async function probarConexion(
  entorno: EntornoVerifactu,
  opts: { peticion?: typeof peticionHttps; url?: string; ca?: Buffer } = {},
): Promise<{ ok: boolean; detalle: string }> {
  const cert = credencialesCertificado();
  if (!cert) return { ok: false, detalle: 'No hay ningún certificado cargado.' };
  try {
    const r = await (opts.peticion ?? peticionHttps)(opts.url ?? urlServicio(entorno), null, cert, { timeoutMs: 20_000, ca: opts.ca });
    if (r.status === 401 || r.status === 403) return { ok: false, detalle: `La AEAT no acepta el certificado (HTTP ${r.status}).` };
    return { ok: true, detalle: `Conexión correcta con el entorno de ${entorno === 'produccion' ? 'producción' : 'pruebas'} de la AEAT (HTTP ${r.status}).` };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/certificate|handshake|alert/i.test(msg)) return { ok: false, detalle: `La AEAT ha rechazado la conexión con este certificado: ${msg}` };
    return { ok: false, detalle: `No se ha podido conectar con la AEAT: ${msg}` };
  }
}
