/**
 * Certificado electrónico con el que Skyway se identifica ante la AEAT al
 * remitir los registros (TLS con certificado de cliente). Se sube como fichero
 * PKCS#12 (.pfx o .p12) con su contraseña.
 *
 * Es el secreto más delicado del panel: con él se puede actuar ante la AEAT en
 * nombre de su titular. Se guarda en `settings`, como las claves de Stripe, y
 * NUNCA sale por la API ni por los registros: la API solo devuelve los datos
 * públicos del certificado (titular, NIF y caducidad), que se leen una vez al
 * subirlo.
 */
import { X509Certificate } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { getSetting, setSetting } from '../db';
import { safeParse } from '../util';
import { nifValido, normalizarNif } from './formato';

export interface InfoCertificado {
  /** Asunto del certificado, en una línea. */
  titular: string;
  /** NIF que identifica el certificado: el de la entidad si es de representante o de sello, o el de la persona. */
  nif: string | null;
  emisor: string;
  validoDesde: number;
  validoHasta: number;
  /** Huella SHA-256 del certificado (pública), para reconocerlo. */
  huellaSha256: string;
  /**
   * Certificado de sello electrónico: la AEAT lo atiende en otro punto de
   * acceso. Se reconoce por el asunto («SELLO»), que es como lo rotulan los
   * prestadores; si no fuera así, «Probar conexión» lo pone de manifiesto.
   */
  sello?: boolean;
  cargadoAt: number;
}

export class ErrorCertificado extends Error {}

/** Tamaño máximo del fichero: un PKCS#12 con la cadena completa ocupa unos pocos KB. */
export const MAX_BYTES_PFX = 64 * 1024;

/**
 * NIF del certificado. En los de representante de persona jurídica y en los de
 * sello, la entidad va en `organizationIdentifier` (OID 2.5.4.97, «VATES-…»);
 * en los de persona física, en `serialNumber` («IDCES-…» o el NIF a secas).
 */
export function nifDelAsunto(asunto: string): string | null {
  const campos = asunto.split('\n').map((l) => l.trim());
  const valor = (claves: string[]): string[] =>
    campos.filter((l) => claves.some((k) => l.toLowerCase().startsWith(`${k.toLowerCase()}=`))).map((l) => l.slice(l.indexOf('=') + 1));
  const candidatos = [
    ...valor(['organizationIdentifier', '2.5.4.97']).map((v) => v.replace(/^VAT[A-Z]{2}-/i, '')),
    ...valor(['serialNumber']).map((v) => v.replace(/^(IDC|PAS)[A-Z]{2}-/i, '')),
  ];
  for (const c of candidatos) {
    const nif = normalizarNif(c);
    if (nifValido(nif)) return nif;
  }
  // Último recurso: un NIF dentro del nombre común («NOMBRE APELLIDOS - 12345678Z»).
  const cn = valor(['CN']).join(' ');
  for (const m of cn.toUpperCase().matchAll(/\b([0-9XYZKLM][0-9]{7}[A-Z]|[ABCDEFGHJNPQRSUVW][0-9]{7}[0-9A-J])\b/g)) {
    if (nifValido(m[1])) return m[1];
  }
  return null;
}

/**
 * Abre el PKCS#12 con su contraseña y devuelve los datos públicos del
 * certificado. Lanza `ErrorCertificado` con un mensaje para el operador si la
 * contraseña no es la correcta, el fichero no es un PKCS#12 o usa un cifrado
 * antiguo que OpenSSL 3 ya no abre por defecto.
 */
export function leerCertificado(pfx: Buffer, contrasena: string, ahora = Date.now()): InfoCertificado {
  if (pfx.length === 0) throw new ErrorCertificado('El fichero del certificado está vacío.');
  if (pfx.length > MAX_BYTES_PFX) throw new ErrorCertificado('El fichero es demasiado grande para ser un certificado .pfx o .p12.');
  let contexto: tls.SecureContext;
  try {
    contexto = tls.createSecureContext({ pfx, passphrase: contrasena });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/mac verify|bad decrypt|invalid password/i.test(msg)) throw new ErrorCertificado('La contraseña del certificado no es correcta.');
    if (/unsupported/i.test(msg)) {
      throw new ErrorCertificado(
        'El certificado usa un cifrado antiguo (RC2 o similar) que el servidor no abre. Expórtalo de nuevo con cifrado AES o TripleDES (en Windows: «TripleDES-SHA1» o «AES256-SHA256»).',
      );
    }
    throw new ErrorCertificado('El fichero no es un certificado PKCS#12 (.pfx o .p12) válido.');
  }
  // El certificado local de un socket TLS sin conectar: es la forma de leer el
  // certificado de un PKCS#12 con lo que trae Node, sin analizar ASN.1 a mano.
  const socket = new tls.TLSSocket(new net.Socket(), { secureContext: contexto, isServer: true });
  try {
    const local = socket.getCertificate();
    const raw = local && 'raw' in local ? (local.raw as Buffer | undefined) : undefined;
    if (!raw) throw new ErrorCertificado('El fichero no contiene un certificado con su clave privada.');
    const x = new X509Certificate(raw);
    const desde = Date.parse(x.validFrom);
    const hasta = Date.parse(x.validTo);
    if (Number.isFinite(hasta) && hasta < ahora) throw new ErrorCertificado(`El certificado caducó el ${new Date(hasta).toLocaleDateString('es-ES')}.`);
    return {
      titular: x.subject.split('\n').join(', '),
      nif: nifDelAsunto(x.subject),
      emisor: x.issuer.split('\n').join(', '),
      validoDesde: desde,
      validoHasta: hasta,
      huellaSha256: x.fingerprint256,
      sello: /\bSELLO\b/i.test(x.subject),
      cargadoAt: ahora,
    };
  } finally {
    socket.destroy();
  }
}

const CLAVE_PFX = 'verifactuCertPfx';
const CLAVE_CONTRASENA = 'verifactuCertPass';
const CLAVE_INFO = 'verifactuCertInfo';

/** Comprueba y guarda el certificado. Devuelve sus datos públicos. */
export function guardarCertificado(pfx: Buffer, contrasena: string): InfoCertificado {
  const info = leerCertificado(pfx, contrasena);
  setSetting(CLAVE_PFX, pfx.toString('base64'));
  setSetting(CLAVE_CONTRASENA, contrasena);
  setSetting(CLAVE_INFO, JSON.stringify(info));
  return info;
}

export function quitarCertificado(): void {
  setSetting(CLAVE_PFX, null);
  setSetting(CLAVE_CONTRASENA, null);
  setSetting(CLAVE_INFO, null);
}

/** Datos públicos del certificado guardado, o null si no hay. */
export function infoCertificado(): InfoCertificado | null {
  if (!getSetting(CLAVE_PFX)) return null;
  return safeParse<InfoCertificado | null>(getSetting(CLAVE_INFO), null);
}

/** Certificado y contraseña para la conexión TLS. Solo para el cliente de la remisión. */
export function credencialesCertificado(): { pfx: Buffer; passphrase: string } | null {
  const pfx = getSetting(CLAVE_PFX);
  if (!pfx) return null;
  // Una contraseña vacía es válida en PKCS#12 y `setSetting` no guarda vacíos.
  return { pfx: Buffer.from(pfx, 'base64'), passphrase: getSetting(CLAVE_CONTRASENA) ?? '' };
}
