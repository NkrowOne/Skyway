/**
 * Cola de remisión de los registros de facturación a la AEAT (modalidad
 * VERI*FACTU, art. 15 y 16 del RD 1007/2023).
 *
 * Los registros nacen en `invoice_ledger` como «pendiente» dentro de la
 * transacción de la factura; aquí se envían por lotes al servicio web SOAP de
 * la AEAT con el certificado electrónico del obligado:
 * - Hasta 1000 registros por envío, del mismo emisor y entorno, en el orden de
 *   la cadena y con un solo registro por factura en cada envío.
 * - Control de flujo: tras cada respuesta se espera el `TiempoEsperaEnvio` que
 *   indica la AEAT (60 s por defecto) salvo que ya haya 1000 registros en cola.
 * - Sin conexión, con la AEAT caída o con el envío rechazado entero, los
 *   registros siguen en cola y se reintenta con esperas crecientes hasta una
 *   hora; se marcan como afectados por una incidencia.
 * - Si la respuesta se pierde (corte a mitad), el reenvío es seguro: la AEAT
 *   contesta «duplicado» (3000) con el estado que ya tenía, y se toma ese.
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
  contarRegistrosPendientes,
  getInvoice,
  getSetting,
  marcarIncidenciaPendientes,
  registrosPendientesRemision,
  resolveAlertsByDedupe,
  setSetting,
  transaction,
} from '../db';
import type { EntornoVerifactu, EstadoRemision, IssuerSnapshot, RegistroFacturacionRow } from '../types';
import { safeParse } from '../util';
import { URL_ENVIO, URL_ENVIO_SELLO } from './ajustes';
import { credencialesCertificado, infoCertificado } from './certificado';
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

/** Cómo se habla con la AEAT. Las pruebas pasan uno simulado. */
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
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`La AEAT no ha respondido en ${Math.round(opts.timeoutMs / 1000)} s`)));
    req.on('error', reject);
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
 * impide remitir y mientras quede algún registro por remitir, el sistema tiene
 * que avisar e indicar cuántos faltan. La alerta se abre con el primer fallo y
 * se resuelve con el primer envío que llega; el número vivo está en
 * Contabilidad → VERI*FACTU.
 */
function avisarIncidencia(motivo: string, explicacion: string): void {
  const pendientes = contarRegistrosPendientes();
  fireAlert({
    severity: 'critical',
    type: 'verifactu_remision',
    title: `${pendientes} ${pendientes === 1 ? 'registro de facturación pendiente' : 'registros de facturación pendientes'} de remitir a la AEAT`,
    message: motivo.slice(0, 300),
    explanation: explicacion,
    dedupeKey: ALERTA_CONEXION,
  });
}

// ---------------------------------------------------------------------------
// Estado de la cola (persistido: sobrevive a un reinicio)
// ---------------------------------------------------------------------------

export interface EstadoCola {
  /** Hasta cuándo pide esperar la AEAT antes del siguiente envío, por entorno (ms). */
  esperaHasta: Partial<Record<EntornoVerifactu, number>>;
  /** Hasta cuándo se espera tras un fallo, por entorno (ms). */
  reintentoHasta: Partial<Record<EntornoVerifactu, number>>;
  fallosSeguidos: number;
  ultimoEnvioAt: number | null;
  ultimoResultado: 'correcto' | 'parcial' | 'incorrecto' | 'rechazado' | 'fallo' | null;
  ultimoCsv: string | null;
  ultimoError: string | null;
}

const ESTADO_INICIAL: EstadoCola = {
  esperaHasta: {},
  reintentoHasta: {},
  fallosSeguidos: 0,
  ultimoEnvioAt: null,
  ultimoResultado: null,
  ultimoCsv: null,
  ultimoError: null,
};

export function getEstadoCola(): EstadoCola {
  return { ...ESTADO_INICIAL, ...safeParse<Partial<EstadoCola>>(getSetting('verifactuRemision'), {}) };
}

function setEstadoCola(e: EstadoCola): void {
  setSetting('verifactuRemision', JSON.stringify(e));
}

// ---------------------------------------------------------------------------
// Envío de un lote
// ---------------------------------------------------------------------------

/**
 * Lote siguiente: los primeros registros en cola que comparten emisor, entorno
 * e incidencia, sin repetir factura. Se corta en el primero que no encaja (no
 * se salta): el orden de envío es el de la cadena.
 */
export function siguienteLote(pendientes: RegistroFacturacionRow[]): RegistroFacturacionRow[] {
  const lote: RegistroFacturacionRow[] = [];
  const facturas = new Set<string>();
  for (const r of pendientes) {
    const p = lote[0];
    if (p && (r.entorno !== p.entorno || r.emisor_nif !== p.emisor_nif || r.incidencia !== p.incidencia)) break;
    if (facturas.has(r.invoice_id) || lote.length >= MAX_REGISTROS_ENVIO) break;
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

/** Estado del registro según la línea de respuesta, con el caso del duplicado. */
function estadoDeLinea(l: LineaRespuesta): { estado: EstadoRemision; codigo: string | null; descripcion: string | null; idPeticion: string | null } {
  if (l.estado === 'Correcto') return { estado: 'correcto', codigo: null, descripcion: null, idPeticion: null };
  if (l.estado === 'AceptadoConErrores') return { estado: 'aceptado_con_errores', codigo: l.codigoError || null, descripcion: l.descripcionError || null, idPeticion: null };
  // Duplicado: la AEAT ya tenía el registro (un reenvío tras perder la
  // respuesta). Manda el estado con que lo guardó entonces.
  if (l.codigoError === '3000' && l.duplicado) {
    const d = l.duplicado;
    if (d.estado === 'Correcta' || d.estado === 'Anulada') return { estado: 'correcto', codigo: null, descripcion: null, idPeticion: d.idPeticion || null };
    if (d.estado === 'AceptadaConErrores') {
      return { estado: 'aceptado_con_errores', codigo: d.codigoError || l.codigoError, descripcion: d.descripcionError || l.descripcionError || null, idPeticion: d.idPeticion || null };
    }
  }
  return { estado: 'incorrecto', codigo: l.codigoError || null, descripcion: l.descripcionError || 'Registro rechazado por la AEAT', idPeticion: null };
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
  const pendientes = registrosPendientesRemision(MAX_REGISTROS_ENVIO + 1);
  if (pendientes.length === 0) return { enviado: false, motivo: 'sin_pendientes' };
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
  const lote = siguienteLote(pendientes);
  const entorno = lote[0].entorno;
  const estado = getEstadoCola();
  const lleno = lote.length >= MAX_REGISTROS_ENVIO;
  const esperaAeat = estado.esperaHasta[entorno] ?? 0;
  const esperaFallo = opts.forzar ? 0 : (estado.reintentoHasta[entorno] ?? 0);
  if (!lleno && (ahora < esperaAeat || ahora < esperaFallo)) return { enviado: false, motivo: 'esperando' };

  const registros = lote.map(registroAeat);
  const xml = soapRegFactu(obligado(lote, registros), registros, { incidencia: lote[0].incidencia === 1 });
  transaction(() => {
    for (const r of lote) actualizarRemisionRegistro(r.id, { intentos: r.intentos + 1, ultimo_intento_at: ahora });
  });

  const transporte = opts.transporte ?? transporteHttps;
  let respuesta: ReturnType<typeof interpretarRespuesta>;
  try {
    const http = await transporte(urlServicio(entorno), xml, cert, { timeoutMs: TIEMPO_MAX_PETICION_MS, ca: opts.ca });
    try {
      respuesta = interpretarRespuesta(http.cuerpo);
    } catch {
      throw new Error(`La AEAT ha respondido con un error HTTP ${http.status} sin una respuesta del servicio`);
    }
  } catch (err) {
    return fallo(lote, entorno, ahora, String((err as Error)?.message ?? err), null);
  }

  if (respuesta.tipo === 'fault') {
    return fallo(lote, entorno, ahora, `${respuesta.codigo ? `[${respuesta.codigo}] ` : ''}${respuesta.mensaje}`, respuesta.codigo);
  }

  const usadas = new Set<number>();
  const conErrores: { r: RegistroFacturacionRow; codigo: string | null; descripcion: string | null; estado: EstadoRemision }[] = [];
  let sinLinea = 0;
  transaction(() => {
    lote.forEach((r, i) => {
      const linea = lineaDe(r, registros[i], respuesta.lineas, usadas);
      if (!linea) {
        sinLinea++;
        return;
      }
      const e = estadoDeLinea(linea);
      actualizarRemisionRegistro(r.id, {
        estado_remision: e.estado,
        csv_aeat: e.estado === 'incorrecto' ? null : respuesta.csv || null,
        respuesta_at: ahora,
        codigo_error: e.codigo,
        descripcion_error: e.descripcion ? e.descripcion.slice(0, 500) : null,
        id_peticion: e.idPeticion,
      });
      if (e.estado !== 'correcto') conErrores.push({ r, codigo: e.codigo, descripcion: e.descripcion, estado: e.estado });
    });
    const rechazados = conErrores.filter((c) => c.estado === 'incorrecto').length;
    anotarEvento(
      conErrores.length ? 'envio_con_errores' : 'envio_correcto',
      `${entorno}: ${lote.length} registros, ${lote.length - conErrores.length - sinLinea} correctos, ${conErrores.length - rechazados} aceptados con errores, ${rechazados} rechazados${respuesta.csv ? `, CSV ${respuesta.csv}` : ''}`,
      ahora,
    );
  });

  const espera = (respuesta.tiempoEsperaEnvio ?? ESPERA_POR_DEFECTO_S) * 1000;
  const resultado: EstadoCola['ultimoResultado'] =
    respuesta.estadoEnvio === 'Correcto' && conErrores.length === 0 ? 'correcto' : respuesta.estadoEnvio === 'Incorrecto' ? 'incorrecto' : 'parcial';
  setEstadoCola({
    ...estado,
    esperaHasta: { ...estado.esperaHasta, [entorno]: ahora + espera },
    reintentoHasta: { ...estado.reintentoHasta, [entorno]: 0 },
    fallosSeguidos: 0,
    ultimoEnvioAt: ahora,
    ultimoResultado: resultado,
    ultimoCsv: respuesta.csv || estado.ultimoCsv,
    ultimoError: sinLinea ? `La respuesta no traía ${sinLinea} de los ${lote.length} registros enviados: se reenviarán.` : null,
  });
  resolveAlertsByDedupe(ALERTA_CONEXION);
  for (const c of conErrores) {
    const inv = getInvoice(c.r.invoice_id);
    const numero = inv?.number ?? c.r.num_serie_factura;
    fireAlert({
      severity: c.estado === 'incorrecto' ? 'critical' : 'warning',
      type: 'verifactu_registro',
      title: c.estado === 'incorrecto' ? `La AEAT ha rechazado el registro de la factura ${numero}` : `La AEAT ha aceptado con errores el registro de la factura ${numero}`,
      message: `${c.codigo ? `[${c.codigo}] ` : ''}${c.descripcion ?? ''}`.slice(0, 300),
      explanation:
        'La factura sigue emitida. Corrige el dato que indica la AEAT y pulsa «Subsanar» en Contabilidad → VERI*FACTU para generar el registro de subsanación. Si el error está en los datos impresos de la factura, corrígela con una factura rectificativa.',
      dedupeKey: `verifactu:${c.r.invoice_id}:${c.r.id}`,
    });
  }
  return { enviado: true, registros: lote.length, resultado };
}

/** El envío no ha llegado o la AEAT lo ha rechazado entero: los registros siguen en cola. */
function fallo(lote: RegistroFacturacionRow[], entorno: EntornoVerifactu, ahora: number, mensaje: string, codigo: string | null): ResultadoRemision {
  const estado = getEstadoCola();
  const fallos = estado.fallosSeguidos + 1;
  const configuracion = !!codigo && FALLOS_DE_CONFIGURACION.has(codigo);
  const espera = configuracion ? 3600 : ESPERAS_TRAS_FALLO_S[Math.min(fallos - 1, ESPERAS_TRAS_FALLO_S.length - 1)];
  transaction(() => {
    // No llegaron a su hora: constan como afectados por una incidencia.
    for (const r of lote) actualizarRemisionRegistro(r.id, { incidencia: 1 });
    anotarEvento(codigo ? 'envio_rechazado' : 'error_conexion', `${entorno}: ${lote.length} registros. ${mensaje}`, ahora);
  });
  setEstadoCola({
    ...estado,
    reintentoHasta: { ...estado.reintentoHasta, [entorno]: ahora + espera * 1000 },
    fallosSeguidos: fallos,
    ultimoEnvioAt: ahora,
    ultimoResultado: codigo ? 'rechazado' : 'fallo',
    ultimoError: mensaje.slice(0, 500),
  });
  auditSystem('verifactu_remision_fallida', `${entorno}: ${lote.length} registros: ${mensaje}`.slice(0, 300));
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
