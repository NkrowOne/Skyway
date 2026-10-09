/**
 * Autenticador WebAuthn de software para las pruebas de passkeys: crea
 * credenciales con atestación «none» y firma aserciones como lo haría una llave
 * de seguridad o el gestor de contraseñas del navegador, y devuelve el mismo
 * JSON que envía `web/src/webauthn.ts`. Así se prueba el servidor de punta a
 * punta sin navegador.
 */
import crypto from 'crypto';

export type Algoritmo = 'ES256' | 'EdDSA' | 'RS256';

export interface Credencial {
  alg: Algoritmo;
  /** rawId de la credencial. */
  id: Buffer;
  privateKey: crypto.KeyObject;
  /** Clave pública en COSE, tal como la incluye el autenticador en authData. */
  publicKeyCose: Buffer;
  /** Contador de firmas; los gestores de passkeys suelen dejarlo siempre a 0. */
  counter: number;
  userHandle: Buffer;
}

const b64u = (b: Buffer): string => b.toString('base64url');
const sha256 = (data: Buffer | string): Buffer => crypto.createHash('sha256').update(data).digest();

// ---- CBOR mínimo (RFC 8949): enteros, cadenas de bytes y de texto y mapas, lo que usa WebAuthn ----

function cborCabecera(mayor: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(mayor << 5) | n]);
  if (n < 0x100) return Buffer.from([(mayor << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (mayor << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (mayor << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

type ValorCbor = number | string | Buffer | Map<number | string, ValorCbor>;

export function cbor(valor: ValorCbor): Buffer {
  if (typeof valor === 'number') return valor >= 0 ? cborCabecera(0, valor) : cborCabecera(1, -1 - valor);
  if (typeof valor === 'string') {
    const bytes = Buffer.from(valor, 'utf8');
    return Buffer.concat([cborCabecera(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(valor)) return Buffer.concat([cborCabecera(2, valor.length), valor]);
  const partes = [cborCabecera(5, valor.size)];
  for (const [k, v] of valor) partes.push(cbor(k), cbor(v));
  return Buffer.concat(partes);
}

// ---- claves ----

function clavePublicaCose(alg: Algoritmo, publicKey: crypto.KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' });
  const bytes = (v: string | undefined): Buffer => Buffer.from(v ?? '', 'base64url');
  if (alg === 'ES256') {
    return cbor(new Map<number, ValorCbor>([[1, 2], [3, -7], [-1, 1], [-2, bytes(jwk.x)], [-3, bytes(jwk.y)]]));
  }
  if (alg === 'EdDSA') {
    return cbor(new Map<number, ValorCbor>([[1, 1], [3, -8], [-1, 6], [-2, bytes(jwk.x)]]));
  }
  return cbor(new Map<number, ValorCbor>([[1, 3], [3, -257], [-1, bytes(jwk.n)], [-2, bytes(jwk.e)]]));
}

function generarClaves(alg: Algoritmo): crypto.KeyPairKeyObjectResult {
  if (alg === 'ES256') return crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  if (alg === 'EdDSA') return crypto.generateKeyPairSync('ed25519');
  return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
}

function firmar(alg: Algoritmo, privateKey: crypto.KeyObject, datos: Buffer): Buffer {
  // ES256 en WebAuthn es ECDSA con la firma en DER, que es lo que da Node por defecto.
  return crypto.sign(alg === 'EdDSA' ? null : 'sha256', datos, privateKey);
}

/** Reconstruye una credencial guardada (p. ej. la de un fixture) a partir de su clave privada PKCS#8. */
export function credencialDesdePkcs8(input: {
  alg: Algoritmo;
  id: string;
  privateKeyPkcs8: string;
  userHandle: string;
  counter?: number;
}): Credencial {
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(input.privateKeyPkcs8, 'base64'), format: 'der', type: 'pkcs8' });
  return {
    alg: input.alg,
    id: Buffer.from(input.id, 'base64url'),
    privateKey,
    publicKeyCose: clavePublicaCose(input.alg, crypto.createPublicKey(privateKey)),
    counter: input.counter ?? 0,
    userHandle: Buffer.from(input.userHandle, 'base64url'),
  };
}

export function exportarPkcs8(credencial: Credencial): string {
  return credencial.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
}

// Indicadores de authData: presencia (UP), verificación (UV), copia de seguridad
// posible y hecha (BE, BS, una passkey sincronizada) y datos de la credencial (AT).
const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;

interface OpcionesRegistro {
  challenge: string;
  rp: { id: string };
  user: { id: string };
}

/**
 * `navigator.credentials.create()`: crea la credencial y devuelve el cuerpo que
 * la web manda a `POST /api/auth/passkeys` en `response`. El user handle es lo
 * que la web pasa al navegador: `options.user.id` decodificado como base64url.
 * Con `existente` se vuelve a presentar esa misma credencial (mismo id y clave).
 */
export function crearCredencial(
  options: OpcionesRegistro,
  origin: string,
  alg: Algoritmo = 'ES256',
  existente?: Credencial,
): { credencial: Credencial; response: Record<string, unknown> } {
  const privateKey = existente?.privateKey ?? generarClaves(alg).privateKey;
  if (existente) alg = existente.alg;
  const id = existente?.id ?? crypto.randomBytes(16);
  const publicKeyCose = clavePublicaCose(alg, crypto.createPublicKey(privateKey));
  const contador = Buffer.alloc(4);
  const longitudId = Buffer.alloc(2);
  longitudId.writeUInt16BE(id.length);
  const authData = Buffer.concat([
    sha256(options.rp.id),
    Buffer.from([UP | UV | BE | BS | AT]),
    contador,
    Buffer.alloc(16), // AAGUID a cero, como con la atestación «none»
    longitudId,
    id,
    publicKeyCose,
  ]);
  const attestationObject = cbor(
    new Map<string, ValorCbor>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authData],
    ]),
  );
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
  const credencial: Credencial = { alg, id, privateKey, publicKeyCose, counter: 0, userHandle: Buffer.from(options.user.id, 'base64url') };
  return {
    credencial,
    response: {
      id: b64u(id),
      rawId: b64u(id),
      type: 'public-key',
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ['hybrid', 'internal'],
      },
    },
  };
}

/**
 * `navigator.credentials.get()`: firma el reto y devuelve el cuerpo que la web
 * manda a `POST /api/auth/passkey-login` en `response`. `incrementar` imita a
 * las llaves que llevan contador; sin él se queda en 0, como las passkeys
 * sincronizadas.
 */
export function firmarAsercion(
  credencial: Credencial,
  options: { challenge: string; rpId: string },
  origin: string,
  opciones: { incrementar?: boolean; firmaInvalida?: boolean } = {},
): Record<string, unknown> {
  if (opciones.incrementar) credencial.counter += 1;
  const contador = Buffer.alloc(4);
  contador.writeUInt32BE(credencial.counter);
  const authenticatorData = Buffer.concat([sha256(options.rpId), Buffer.from([UP | UV | BE | BS]), contador]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
  let signature = firmar(credencial.alg, credencial.privateKey, Buffer.concat([authenticatorData, sha256(clientDataJSON)]));
  if (opciones.firmaInvalida) signature = firmar(credencial.alg, generarClaves(credencial.alg).privateKey, Buffer.concat([authenticatorData, sha256(clientDataJSON)]));
  return {
    id: b64u(credencial.id),
    rawId: b64u(credencial.id),
    type: 'public-key',
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: b64u(clientDataJSON),
      authenticatorData: b64u(authenticatorData),
      signature: b64u(signature),
      userHandle: b64u(credencial.userHandle),
    },
  };
}
