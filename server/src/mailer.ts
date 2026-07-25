/**
 * Cliente SMTP mínimo escrito a mano para enviar la factura al cliente con su PDF
 * adjunto. Sin dependencias: el diálogo va sobre `node:net`/`node:tls` y las
 * fronteras MIME salen de `node:crypto`, en el mismo espíritu que el cliente de
 * Stripe (`stripe.ts`).
 *
 * Cubre lo justo que necesita Skyway: saludo, EHLO (con vuelta a HELO si el
 * servidor es antiguo), STARTTLS cuando se anuncia, AUTH PLAIN/LOGIN, sobre y
 * mensaje MIME con adjuntos. Nunca se registran la contraseña ni el cuerpo: en
 * los errores solo viaja el comando —con la línea de AUTH enmascarada— y la
 * respuesta del servidor. Toda espera tiene temporizador, de modo que ninguna
 * ruta de error puede dejar la promesa colgada.
 */
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

export class MailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailError';
  }
}

export interface SmtpConfig {
  host: string;
  port: number;
  /** true = TLS directo (465). false = texto plano con STARTTLS si el servidor lo ofrece (587/25). */
  secure: boolean;
  user: string;
  pass: string;
  /** Dirección del remitente (From). */
  from: string;
  fromName?: string;
  /** Tiempo máximo para todo el diálogo, en ms (por defecto 20 s). */
  timeoutMs?: number;
  /** Tiempo máximo de espera de la respuesta a un comando, en ms (por defecto, el global). */
  commandTimeoutMs?: number;
  /** Acepta certificados TLS no verificables (relés internos con certificado propio). */
  allowSelfSigned?: boolean;
}

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: MailAttachment[];
  replyTo?: string;
}

const CRLF = '\r\n';
const TIMEOUT_POR_DEFECTO = 20_000;
/** Topes defensivos para no acumular sin fin lo que mande un servidor averiado u hostil. */
const MAX_RESPUESTA = 64 * 1024;
const MAX_LINEAS = 256;

// ---------------------------------------------------------------------------
// Utilidades de texto y MIME
// ---------------------------------------------------------------------------

/**
 * Quita CR/LF y caracteres de control de un valor de cabecera: es la única
 * defensa real contra la inyección de cabeceras cuando el asunto o el nombre
 * del adjunto vienen de datos del cliente.
 */
function limpiarCabecera(valor: string): string {
  // eslint-disable-next-line no-control-regex
  return valor.replace(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').trim();
}

function esAscii(valor: string): boolean {
  return !/[^\x20-\x7e]/.test(valor);
}

/**
 * Codifica un texto de cabecera en «encoded words» =?UTF-8?B?…?= troceados por
 * debajo del límite de 75 octetos del RFC 2047. El troceo va por puntos de
 * código, no por bytes, para no partir un carácter multibyte por la mitad.
 */
function palabrasCodificadas(valor: string): string {
  const trozos: string[] = [];
  let actual: string[] = [];
  let bytes = 0;
  for (const caracter of valor) {
    const n = Buffer.byteLength(caracter, 'utf8');
    // 45 octetos crudos ≈ 60 en base64, que con el envoltorio =?UTF-8?B?…?= cabe en 75.
    if (bytes + n > 45 && actual.length > 0) {
      trozos.push(actual.join(''));
      actual = [];
      bytes = 0;
    }
    actual.push(caracter);
    bytes += n;
  }
  if (actual.length > 0) trozos.push(actual.join(''));
  if (trozos.length === 0) trozos.push('');
  return trozos
    .map((t) => `=?UTF-8?B?${Buffer.from(t, 'utf8').toString('base64')}?=`)
    .join(`${CRLF} `); // plegado: continuación de cabecera con espacio inicial
}

/** Valor de cabecera listo para escribir: tal cual si es ASCII, codificado si no. */
function textoCabecera(valor: string): string {
  const limpio = limpiarCabecera(valor);
  return esAscii(limpio) ? limpio : palabrasCodificadas(limpio);
}

function entrecomillar(valor: string): string {
  return `"${valor.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

function quitarComillas(valor: string): string {
  const v = valor.trim();
  return v.startsWith('"') && v.endsWith('"') && v.length >= 2 ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v;
}

/**
 * Trocea una lista de direcciones por las comas de primer nivel. Las que van
 * dentro de un nombre entrecomillado o de los ángulos del buzón no separan nada:
 * «"Núñez, S.L." <a@b.com>» es UNA dirección, no dos.
 */
function trocearDirecciones(lista: string): string[] {
  const partes: string[] = [];
  let actual = '';
  let enComillas = false;
  let enAngulos = false;
  for (const c of lista) {
    if (c === '"' && !enAngulos) enComillas = !enComillas;
    else if (c === '<' && !enComillas) enAngulos = true;
    else if (c === '>' && !enComillas) enAngulos = false;
    if (c === ',' && !enComillas && !enAngulos) {
      partes.push(actual);
      actual = '';
      continue;
    }
    actual += c;
  }
  partes.push(actual);
  return partes.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Parte `Nombre <buzon@dominio>` en sus dos mitades; sin ángulos, todo es buzón. */
function partirDireccion(direccion: string): { nombre: string; buzon: string } {
  const m = direccion.match(/^([\s\S]*)<([^<>]*)>\s*$/);
  if (!m) return { nombre: '', buzon: direccion.trim() };
  return { nombre: quitarComillas(m[1]), buzon: m[2].trim() };
}

/**
 * Construye `Nombre <buzon@dominio>`. Ojo: `direccion` puede venir ya con nombre
 * («Skyway <facturacion@…>», que es como se teclea en Ajustes); hay que quedarse
 * solo con el buzón para los ángulos, o sale un `<Skyway <facturacion@…>>` que
 * ningún cliente sabe leer y que además cuela el nombre sin codificar.
 */
function direccionConNombre(direccion: string, nombre?: string): string {
  const partida = partirDireccion(limpiarCabecera(direccion));
  // `||`, no `??`: el nombre configurado aparte llega como cadena VACÍA cuando no
  // se ha rellenado (así lo guarda `getSmtpSettings`), y con `??` esa cadena vacía
  // ganaba y descartaba el nombre que el operador hubiera escrito dentro de la
  // propia dirección («Facturación Skyway <facturas@…>»).
  const rotulo = limpiarCabecera(nombre || partida.nombre);
  if (!rotulo) return `<${partida.buzon}>`;
  if (!esAscii(rotulo)) return `${palabrasCodificadas(rotulo)} <${partida.buzon}>`;
  // Los «specials» del RFC 5322 obligan a entrecomillar el nombre visible.
  return `${/[()<>@,;:\\".[\]]/.test(rotulo) ? entrecomillar(rotulo) : rotulo} <${partida.buzon}>`;
}

/**
 * Cabecera de lista de direcciones (To, Reply-To). Codificar la lista entera con
 * `textoCabecera` sepultaría los buzones dentro de un =?UTF-8?B?…?= y el receptor
 * se quedaría sin poder responder: solo se codifica el nombre visible de cada una.
 */
function listaDirecciones(valor: string): string {
  const partes = trocearDirecciones(limpiarCabecera(valor));
  return partes.length > 0 ? partes.map((d) => direccionConNombre(d)).join(', ') : textoCabecera(valor);
}

const DIAS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MESES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Fecha en el formato del RFC 5322. Se emite siempre en UTC (+0000) para no depender del TZ del host. */
function fechaRfc5322(fecha: Date): string {
  const dos = (n: number) => String(n).padStart(2, '0');
  return (
    `${DIAS[fecha.getUTCDay()]}, ${dos(fecha.getUTCDate())} ${MESES[fecha.getUTCMonth()]} ${fecha.getUTCFullYear()} ` +
    `${dos(fecha.getUTCHours())}:${dos(fecha.getUTCMinutes())}:${dos(fecha.getUTCSeconds())} +0000`
  );
}

/** Base64 en líneas de 76 caracteres, como exige el RFC 2045 para los cuerpos. */
function base64Lineas(datos: Buffer): string {
  const b64 = datos.toString('base64');
  const lineas: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lineas.push(b64.slice(i, i + 76));
  return lineas.join(CRLF);
}

function dominioDe(email: string): string {
  const i = email.lastIndexOf('@');
  const dominio = i >= 0 ? email.slice(i + 1) : '';
  return /^[A-Za-z0-9.\-_]+$/.test(dominio) ? dominio : 'localhost';
}

/** Extrae el buzón de una dirección que puede venir como `Nombre <buzon@dominio>`. */
function buzonDe(direccion: string): string {
  return partirDireccion(direccion).buzon;
}

/**
 * Buzón admisible en el sobre SMTP: `dot-atom@dominio`, sin espacios, comas,
 * ángulos ni caracteres de control. Es lo que impide que un valor de Ajustes o un
 * destinatario cuelen un CRLF y con él un comando extra en MAIL FROM / RCPT TO
 * (misma regla del repositorio: la entrada nunca se interpola sin validar).
 */
const BUZON = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/**
 * Normaliza los finales de línea a CRLF y duplica el punto inicial de cada línea
 * (RFC 5321 §4.5.2): sin esto, una línea que empiece por «.» corta el mensaje ahí.
 * Se exporta para poder verificarla de forma aislada.
 */
export function dotStuff(cuerpo: string): string {
  return cuerpo.replace(/\r\n|\r|\n/g, CRLF).replace(/^\./gm, '..');
}

// ---------------------------------------------------------------------------
// Construcción del mensaje
// ---------------------------------------------------------------------------

function frontera(): string {
  return `=_skyway_${randomBytes(12).toString('hex')}`;
}

function parteTexto(texto: string, tipo: 'plain' | 'html'): string {
  // Antes de codificar hay que pasar el texto a su forma canónica (CRLF): es lo que
  // el RFC 2045 exige dentro de un cuerpo base64 y lo que esperan los clientes.
  const canonico = texto.replace(/\r\n|\r|\n/g, CRLF);
  return [
    `Content-Type: text/${tipo}; charset=utf-8`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lineas(Buffer.from(canonico, 'utf8')),
  ].join(CRLF);
}

/** Caracteres que el RFC 2231 deja pasar sin escapar en un valor extendido (token sin `*`, `'` ni `%`). */
const CARACTER_ATRIBUTO = /^[A-Za-z0-9!#$&+\-.^_`{|}~]$/;

/**
 * Codifica un valor para `filename*` (RFC 2231). `encodeURIComponent` no sirve:
 * deja intactos `'`, `*`, `(`, `)`, `!` y `~`, y el apóstrofo es justamente el
 * separador de `charset'idioma'valor`, así que un nombre como «d'Álava.pdf»
 * descuadraría el análisis del receptor.
 */
function valorExtendido(valor: string): string {
  let salida = '';
  for (const octeto of Buffer.from(valor, 'utf8')) {
    const c = String.fromCharCode(octeto);
    salida += CARACTER_ATRIBUTO.test(c) ? c : `%${octeto.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return salida;
}

function parteAdjunto(adj: MailAttachment): string {
  // El nombre puede venir de datos del cliente: fuera rutas y caracteres de control.
  const nombre = limpiarCabecera(adj.filename).replace(/[\\/]/g, '_') || 'adjunto.bin';
  const tipo = limpiarCabecera(adj.contentType) || 'application/octet-stream';
  // Aquí el encoded-word va dentro de comillas y no puede plegarse, pero dos de ellos
  // pegados («?==?») no los decodifica nadie: hay que dejar el espacio que los separa.
  const nombreCabecera = esAscii(nombre)
    ? entrecomillar(nombre)
    : `"${palabrasCodificadas(nombre).replace(/\r\n /g, ' ')}"`;
  // Con nombre no ASCII se emiten los dos formatos: `filename` con encoded-word para
  // los clientes viejos y `filename*` (RFC 2231) para los modernos, que lo prefieren.
  const disposicion = esAscii(nombre)
    ? `Content-Disposition: attachment; filename=${nombreCabecera}`
    : `Content-Disposition: attachment; filename=${nombreCabecera};${CRLF} filename*=UTF-8''${valorExtendido(nombre)}`;
  return [
    `Content-Type: ${tipo}; name=${nombreCabecera}`,
    'Content-Transfer-Encoding: base64',
    disposicion,
    '',
    base64Lineas(adj.content),
  ].join(CRLF);
}

/** Envuelve varias partes en un multipart con su frontera y el cierre `--frontera--`. */
function envolver(partes: string[], tipo: string, limite: string): string {
  const cuerpo = partes.map((p) => `--${limite}${CRLF}${p}`).join(CRLF) + `${CRLF}--${limite}--`;
  return `Content-Type: ${tipo}; boundary="${limite}"${CRLF}${CRLF}${cuerpo}`;
}

/**
 * Arma el mensaje completo (cabeceras + cuerpo) ya en CRLF, sin el punto final
 * del diálogo SMTP. La estructura depende de lo que haya: texto suelto,
 * multipart/alternative con HTML y multipart/mixed cuando hay adjuntos.
 */
function construirMime(cfg: SmtpConfig, msg: MailMessage, ahora = new Date()): string {
  const adjuntos = msg.attachments ?? [];
  // `text` llega de una frontera HTTP: si falta, mejor un cuerpo vacío que un TypeError.
  const texto = typeof msg.text === 'string' ? msg.text : '';
  let contenido: string;
  if (msg.html) {
    const limite = frontera();
    contenido = envolver([parteTexto(texto, 'plain'), parteTexto(msg.html, 'html')], 'multipart/alternative', limite);
  } else {
    contenido = parteTexto(texto, 'plain');
  }
  if (adjuntos.length > 0) {
    const limite = frontera();
    contenido = envolver([contenido, ...adjuntos.map(parteAdjunto)], 'multipart/mixed', limite);
  }

  const cabeceras = [
    `From: ${direccionConNombre(cfg.from, cfg.fromName)}`,
    `To: ${listaDirecciones(msg.to)}`,
    `Subject: ${textoCabecera(msg.subject)}`,
    `Date: ${fechaRfc5322(ahora)}`,
    `Message-ID: <${randomBytes(12).toString('hex')}.${ahora.getTime().toString(36)}@${dominioDe(buzonDe(cfg.from))}>`,
    'MIME-Version: 1.0',
  ];
  if (msg.replyTo) cabeceras.push(`Reply-To: ${listaDirecciones(msg.replyTo)}`);

  return `${cabeceras.join(CRLF)}${CRLF}${contenido}${CRLF}`;
}

// ---------------------------------------------------------------------------
// Diálogo SMTP
// ---------------------------------------------------------------------------

interface RespuestaSmtp {
  code: number;
  /** Texto de todas las líneas de la respuesta, unido con « / ». */
  text: string;
  lines: string[];
}

/** Conexión SMTP con lector de respuestas multilínea y temporizadores propios. */
class SesionSmtp {
  private sock: net.Socket;
  private buf: Buffer = Buffer.alloc(0);
  private lineas: string[] = [];
  private cola: RespuestaSmtp[] = [];
  private espera: { resolver: (r: RespuestaSmtp) => void; rechazar: (e: MailError) => void; temporizador: NodeJS.Timeout } | null = null;
  private fallo: MailError | null = null;

  constructor(sock: net.Socket, private readonly finaliza: number, private readonly msComando: number) {
    this.sock = sock;
    this.enganchar(sock);
  }

  private alDatos = (trozo: Buffer): void => {
    this.buf = this.buf.length === 0 ? trozo : Buffer.concat([this.buf, trozo]);
    // Un relé averiado que escupa datos sin salto de línea llenaría la memoria hasta
    // que venciera el temporizador; con el tope se corta en cuanto pasa de lo razonable.
    if (this.buf.length > MAX_RESPUESTA) {
      this.romper(new MailError('El servidor SMTP envió una respuesta desmesurada; se corta la conexión.'));
      return;
    }
    for (;;) {
      const fin = this.buf.indexOf(0x0a);
      if (fin < 0) break;
      const linea = this.buf.subarray(0, fin).toString('utf8').replace(/\r$/, '');
      this.buf = this.buf.subarray(fin + 1);
      this.procesarLinea(linea);
      if (this.fallo) return;
    }
  };

  private alError = (err: Error): void => {
    this.romper(new MailError(`Se perdió la conexión con el servidor SMTP: ${err.message}`));
  };

  private alFin = (): void => {
    this.romper(new MailError('El servidor SMTP cerró la conexión antes de terminar el diálogo.'));
  };

  private procesarLinea(linea: string): void {
    const m = linea.match(/^(\d{3})([ -]?)(.*)$/);
    if (!m) {
      this.romper(new MailError(`El servidor SMTP devolvió una respuesta que no se entiende: «${linea.slice(0, 120)}».`));
      return;
    }
    this.lineas.push(m[3]);
    if (this.lineas.length > MAX_LINEAS) {
      this.romper(new MailError('El servidor SMTP encadenó demasiadas líneas de respuesta; se corta la conexión.'));
      return;
    }
    // Una respuesta multilínea usa «-» como cuarto carácter; solo el espacio (o el
    // fin de línea) la cierra. Quedarse con la primera línea es el fallo clásico.
    if (m[2] === '-') return;
    const respuesta: RespuestaSmtp = { code: parseInt(m[1], 10), text: this.lineas.join(' / '), lines: this.lineas };
    this.lineas = [];
    const espera = this.espera;
    if (espera) {
      this.espera = null;
      clearTimeout(espera.temporizador);
      espera.resolver(respuesta);
    } else {
      // El saludo llega antes de que nadie lo pida: se guarda para el primer leer().
      this.cola.push(respuesta);
    }
  }

  private enganchar(sock: net.Socket): void {
    sock.on('data', this.alDatos);
    sock.on('error', this.alError);
    sock.on('close', this.alFin);
  }

  private desenganchar(sock: net.Socket): void {
    sock.removeListener('data', this.alDatos);
    sock.removeListener('error', this.alError);
    sock.removeListener('close', this.alFin);
  }

  /** Marca la sesión como rota, rechaza al que esté esperando y tira el socket. */
  private romper(err: MailError): void {
    if (!this.fallo) this.fallo = err;
    const espera = this.espera;
    this.espera = null;
    if (espera) {
      clearTimeout(espera.temporizador);
      espera.rechazar(this.fallo);
    }
    this.sock.destroy();
  }

  private msRestantes(): number {
    return Math.max(1, Math.min(this.msComando, this.finaliza - Date.now()));
  }

  leer(): Promise<RespuestaSmtp> {
    const encolada = this.cola.shift();
    if (encolada) return Promise.resolve(encolada);
    if (this.fallo) return Promise.reject(this.fallo);
    const plazo = this.msRestantes();
    return new Promise<RespuestaSmtp>((resolver, rechazar) => {
      const temporizador = setTimeout(() => {
        const err = new MailError(`El servidor SMTP no respondió en ${plazo} ms; se corta la conexión.`);
        this.espera = null;
        this.romper(err);
        rechazar(err);
      }, plazo);
      this.espera = { resolver, rechazar, temporizador };
    });
  }

  escribir(datos: string): void {
    if (this.fallo) throw this.fallo;
    this.sock.write(datos);
  }

  /** Envía un comando y espera su respuesta completa. */
  async comando(orden: string): Promise<RespuestaSmtp> {
    if (Date.now() >= this.finaliza) {
      const err = new MailError('Se agotó el tiempo máximo del envío por SMTP.');
      this.romper(err);
      throw err;
    }
    this.escribir(orden + CRLF);
    return this.leer();
  }

  /** Sustituye el socket por su versión cifrada tras un STARTTLS aceptado. */
  async iniciarTls(host: string, permitirAutofirmado: boolean): Promise<void> {
    const plano = this.sock;
    this.desenganchar(plano);
    this.buf = Buffer.alloc(0);
    this.lineas = [];
    this.cola = [];
    const seguro = await new Promise<tls.TLSSocket>((resolver, rechazar) => {
      const temporizador = setTimeout(() => {
        plano.destroy();
        rechazar(new MailError(`El apretón de manos TLS con ${host} no terminó a tiempo.`));
      }, this.msRestantes());
      const cifrado = tls.connect({ socket: plano, servername: host, rejectUnauthorized: !permitirAutofirmado });
      cifrado.once('secureConnect', () => {
        clearTimeout(temporizador);
        cifrado.removeListener('error', alFallar);
        resolver(cifrado);
      });
      const alFallar = (err: Error) => {
        clearTimeout(temporizador);
        cifrado.destroy();
        rechazar(new MailError(`No se pudo cifrar la conexión con ${host} (STARTTLS): ${err.message}`));
      };
      cifrado.once('error', alFallar);
    });
    this.sock = seguro;
    this.enganchar(seguro);
  }

  /** Cierre limpio: QUIT sin esperar demasiado y adiós. Los fallos aquí no importan. */
  async despedir(): Promise<void> {
    try {
      if (!this.fallo) await this.comando('QUIT');
    } catch {
      // El servidor puede cortar sin responder al QUIT; el mensaje ya se aceptó.
    }
    this.sock.destroy();
  }

  destruir(): void {
    this.sock.destroy();
  }
}

function conectar(cfg: SmtpConfig, ms: number): Promise<net.Socket> {
  return new Promise((resolver, rechazar) => {
    const sock = cfg.secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: !cfg.allowSelfSigned })
      : net.connect({ host: cfg.host, port: cfg.port });
    const temporizador = setTimeout(() => {
      sock.destroy();
      rechazar(new MailError(`No se pudo conectar con ${cfg.host}:${cfg.port}: se agotó el tiempo de espera (${ms} ms).`));
    }, ms);
    const alFallar = (err: Error) => {
      clearTimeout(temporizador);
      sock.destroy();
      rechazar(new MailError(`No se pudo conectar con ${cfg.host}:${cfg.port}: ${err.message}`));
    };
    sock.once('error', alFallar);
    sock.once(cfg.secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(temporizador);
      sock.removeListener('error', alFallar);
      sock.setNoDelay(true);
      resolver(sock);
    });
  });
}

/** Extensiones anunciadas en el EHLO, indexadas por palabra clave en mayúsculas. */
function extensiones(respuesta: RespuestaSmtp): Map<string, string[]> {
  const mapa = new Map<string, string[]>();
  // La primera línea del EHLO es el saludo del servidor, no una extensión.
  for (const linea of respuesta.lines.slice(1)) {
    const partes = linea.trim().split(/\s+/);
    if (partes.length === 0 || !partes[0]) continue;
    mapa.set(partes[0].toUpperCase(), partes.slice(1).map((p) => p.toUpperCase()));
  }
  return mapa;
}

/**
 * Texto del servidor apto para un mensaje de error, un registro de auditoría o una
 * alerta. Muchos relés repiten el comando que no entendieron
 * («500 5.5.1 Command unrecognized: "AUTH PLAIN AGZ...="»), así que su respuesta
 * puede traer de vuelta la credencial en base64: se enmascara cualquier bloque
 * largo de base64 antes de dejarlo salir de aquí.
 */
function textoSeguro(texto: string): string {
  return texto.replace(/[A-Za-z0-9+/]{16,}={0,2}/g, '***').slice(0, 300);
}

function exigir(respuesta: RespuestaSmtp, aceptados: number[], contexto: string): void {
  if (aceptados.includes(Math.floor(respuesta.code / 100))) return;
  throw new MailError(`${contexto}: el servidor respondió ${respuesta.code} ${textoSeguro(respuesta.text)}`);
}

function validarConfig(cfg: SmtpConfig): void {
  if (!cfg || typeof cfg !== 'object') throw new MailError('Falta la configuración SMTP.');
  if (!cfg.host || !cfg.host.trim()) throw new MailError('Falta el servidor SMTP (host) en la configuración de correo.');
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    throw new MailError('El puerto SMTP no es válido: debe ser un número entero entre 1 y 65535.');
  }
  if (!cfg.from || !cfg.from.trim()) throw new MailError('Falta la dirección del remitente (from) en la configuración de correo.');
  if (!BUZON.test(buzonDe(cfg.from))) throw new MailError(`La dirección del remitente no es válida: «${limpiarCabecera(cfg.from)}».`);
  if (cfg.user && !cfg.pass) throw new MailError('Falta la contraseña SMTP: hay usuario configurado pero no contraseña.');
  if (!cfg.user && cfg.pass) throw new MailError('Falta el usuario SMTP: hay contraseña configurada pero no usuario.');
}

function destinatarios(to: string): string[] {
  const lista = trocearDirecciones(typeof to === 'string' ? to : '')
    .map((d) => buzonDe(d))
    .filter((d) => d.length > 0);
  if (lista.length === 0) throw new MailError('El mensaje no tiene destinatario (to).');
  for (const d of lista) {
    if (!BUZON.test(d)) throw new MailError(`La dirección del destinatario no es válida: «${limpiarCabecera(d)}».`);
  }
  return lista;
}

/**
 * Abre la conexión y deja la sesión autenticada y lista para el sobre.
 * Es lo común entre `sendMail` y `verifySmtp`.
 */
async function abrirSesion(cfg: SmtpConfig): Promise<SesionSmtp> {
  const total = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : TIMEOUT_POR_DEFECTO;
  const porComando = cfg.commandTimeoutMs && cfg.commandTimeoutMs > 0 ? cfg.commandTimeoutMs : total;
  const finaliza = Date.now() + total;
  const sock = await conectar(cfg, Math.min(total, porComando));
  const sesion = new SesionSmtp(sock, finaliza, porComando);
  try {
    exigir(await sesion.leer(), [2], 'El servidor SMTP no dio la bienvenida esperada');

    // EHLO con el dominio del remitente: muchos relés rechazan un nombre sin punto.
    const nombreCliente = dominioDe(buzonDe(cfg.from));
    let saludo = await sesion.comando(`EHLO ${nombreCliente}`);
    let ext = extensiones(saludo);
    if (saludo.code >= 500) {
      // Servidor antiguo que no entiende ESMTP: se reintenta con HELO y sin extensiones.
      saludo = await sesion.comando(`HELO ${nombreCliente}`);
      exigir(saludo, [2], 'El servidor SMTP rechazó el saludo (HELO)');
      ext = new Map();
    } else {
      exigir(saludo, [2], 'El servidor SMTP rechazó el saludo (EHLO)');
    }

    if (!cfg.secure && ext.has('STARTTLS')) {
      // Si el servidor ofrece cifrado se usa siempre: la contraseña no viaja en claro.
      exigir(await sesion.comando('STARTTLS'), [2], 'El servidor SMTP rechazó STARTTLS');
      await sesion.iniciarTls(cfg.host, cfg.allowSelfSigned === true);
      saludo = await sesion.comando(`EHLO ${nombreCliente}`);
      exigir(saludo, [2], 'El servidor SMTP rechazó el saludo (EHLO tras STARTTLS)');
      ext = extensiones(saludo);
    }

    if (cfg.user && cfg.pass) await autenticar(sesion, cfg, ext);
    return sesion;
  } catch (err) {
    sesion.destruir();
    throw comoMailError(err);
  }
}

async function autenticar(sesion: SesionSmtp, cfg: SmtpConfig, ext: Map<string, string[]>): Promise<void> {
  // Con HELO no hay lista de mecanismos; se intenta PLAIN, que es lo habitual.
  let mecanismos = ext.get('AUTH') ?? [];
  for (const [clave, valores] of ext) {
    // Sintaxis heredada «AUTH=PLAIN LOGIN» de algunos servidores antiguos.
    if (clave.startsWith('AUTH=')) mecanismos = [clave.slice(5), ...valores];
  }
  if (mecanismos.length === 0 && ext.size > 0 && !ext.has('AUTH')) {
    throw new MailError('El servidor SMTP no admite autenticación, pero hay usuario y contraseña configurados.');
  }
  const usarPlain = mecanismos.length === 0 || mecanismos.includes('PLAIN');

  let respuesta: RespuestaSmtp;
  if (usarPlain) {
    const credencial = Buffer.from(`\u0000${cfg.user}\u0000${cfg.pass}`, 'utf8').toString('base64');
    // El comando lleva la credencial: se envía a mano para que jamás aparezca en un error.
    sesion.escribir(`AUTH PLAIN ${credencial}${CRLF}`);
    respuesta = await sesion.leer();
  } else if (mecanismos.includes('LOGIN')) {
    const inicio = await sesion.comando('AUTH LOGIN');
    exigir(inicio, [3], 'El servidor SMTP rechazó AUTH LOGIN');
    sesion.escribir(`${Buffer.from(cfg.user, 'utf8').toString('base64')}${CRLF}`);
    const paso = await sesion.leer();
    exigir(paso, [3], 'El servidor SMTP rechazó el usuario SMTP'); // textoSeguro enmascara el eco del base64
    sesion.escribir(`${Buffer.from(cfg.pass, 'utf8').toString('base64')}${CRLF}`);
    respuesta = await sesion.leer();
  } else {
    throw new MailError(`El servidor SMTP solo admite mecanismos de autenticación no soportados: ${mecanismos.join(', ')}.`);
  }
  if (Math.floor(respuesta.code / 100) !== 2) {
    // «AUTH …» va enmascarado: la credencial nunca debe acabar en un log ni en la UI.
    throw new MailError(
      `El servidor SMTP rechazó las credenciales (AUTH ***): ${respuesta.code} ${textoSeguro(respuesta.text)}. ` +
        'Revisa el usuario y la contraseña de correo en Ajustes.',
    );
  }
}

function comoMailError(err: unknown): MailError {
  if (err instanceof MailError) return err;
  const mensaje = err instanceof Error ? err.message : String(err);
  return new MailError(`Fallo inesperado enviando el correo: ${mensaje}`);
}

/** Envía un correo. Lanza MailError con un mensaje accionable si falla. */
export async function sendMail(cfg: SmtpConfig, msg: MailMessage): Promise<void> {
  validarConfig(cfg);
  if (!msg || typeof msg !== 'object') throw new MailError('No hay mensaje que enviar.');
  const rcpt = destinatarios(msg.to);
  for (const respuesta of trocearDirecciones(limpiarCabecera(msg.replyTo ?? ''))) {
    // Reply-To no entra en el sobre, pero un buzón raro dejaría octetos crudos en la cabecera.
    if (!BUZON.test(buzonDe(respuesta))) throw new MailError(`La dirección de respuesta (replyTo) no es válida: «${respuesta}».`);
  }
  for (const adj of msg.attachments ?? []) {
    if (!Buffer.isBuffer(adj.content)) throw new MailError(`El adjunto «${limpiarCabecera(adj.filename)}» no tiene contenido válido.`);
  }
  const mime = construirMime(cfg, msg);
  const remitente = buzonDe(cfg.from);

  const sesion = await abrirSesion(cfg);
  try {
    exigir(await sesion.comando(`MAIL FROM:<${remitente}>`), [2], 'El servidor SMTP rechazó el remitente (MAIL FROM)');
    for (const destino of rcpt) {
      exigir(await sesion.comando(`RCPT TO:<${destino}>`), [2], `El servidor SMTP rechazó el destinatario «${destino}» (RCPT TO)`);
    }
    exigir(await sesion.comando('DATA'), [3], 'El servidor SMTP rechazó el envío del cuerpo (DATA)');
    // El cuerpo no se registra nunca; solo se escribe con su punto de cierre.
    sesion.escribir(dotStuff(mime));
    sesion.escribir(`.${CRLF}`);
    exigir(await sesion.leer(), [2], 'El servidor SMTP no aceptó el mensaje');
  } catch (err) {
    sesion.destruir();
    throw comoMailError(err);
  }
  await sesion.despedir();
}

/** Conecta y autentica sin enviar nada: sirve al botón «probar conexión» de Ajustes. */
export async function verifySmtp(cfg: SmtpConfig): Promise<void> {
  validarConfig(cfg);
  const sesion = await abrirSesion(cfg);
  await sesion.despedir();
}
