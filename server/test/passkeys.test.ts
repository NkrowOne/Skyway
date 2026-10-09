import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { API_TOKEN_PREFIX, hashApiToken, signToken } from '../src/auth';
import { closeDb, createUser, getPasskeyByCredentialId, initDb, insertApiToken, insertPasskey, listPasskeys } from '../src/db';
import type { UserRow } from '../src/types';
import { hashPassword, randomToken } from '../src/util';
import { crearCredencial, credencialDesdePkcs8, firmarAsercion, type Algoritmo } from './passkeyfake';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

// Panel en un puerto propio (túnel SSH a :4000): el origen esperado lleva el
// puerto, que es justo lo que `req.hostname` dejó de dar en Fastify 5.
const HOST = 'localhost:4000';
const ORIGIN = 'http://localhost:4000';
const NAVEGADOR = { host: HOST, origin: ORIGIN, 'sec-fetch-site': 'same-origin' };

/**
 * Passkeys registradas con la versión anterior (SimpleWebAuthn 9): las filas
 * son las que guardó en su base de datos el servidor de `main` antes de la
 * migración, al registrar con el autenticador de `passkeyfake.ts` desde
 * http://localhost:4000 (la EdDSA y la RS256 ya habían iniciado sesión una vez:
 * contador 1). Las claves privadas son de prueba y solo sirven para firmar aquí.
 */
const ANTERIORES: {
  alg: Algoritmo;
  userHandle: string;
  privateKeyPkcs8: string;
  fila: {
    credential_id: string;
    public_key: string;
    counter: number;
    transports: string;
    device_type: string;
    backed_up: number;
    rp_id: string;
    name: string;
  };
}[] = [
  {
    alg: 'ES256',
    userHandle: 'usr_67e76721788e21a1',
    privateKeyPkcs8:
      'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgVrZcetSx1zqDpDUN5uM4EJkdrUhOTorrtQbFh9SmGm6hRANC' +
      'AAQNm+ZFhVWFGCkiWvYoHtxqxqdTxBXvwkwc/Q/v6rCIy7DJEMxRsT8ktppyxTtH7mD962M/sHkXHp1sX0CLkkcd',
    fila: {
      credential_id: '__YratBeYm5lqivYX3c4ug',
      public_key:
        'pQECAyYgASFYIA2b5kWFVYUYKSJa9ige3GrGp1PEFe_CTBz9D-_qsIjLIlggsMkQzFGxPyS2mnLFO0fuYP3rYz-weRcenWxf' +
        'QIuSRx0',
      counter: 0,
      transports: '["hybrid","internal"]',
      device_type: 'multiDevice',
      backed_up: 1,
      rp_id: 'localhost',
      name: 'Llave ES256',
    },
  },
  {
    alg: 'EdDSA',
    userHandle: 'usr_67e76721788e21a1',
    privateKeyPkcs8: 'MC4CAQAwBQYDK2VwBCIEILG1Tuqxs+iCo64FcbRaV5P7nl2LWeRLS9Ixj494P8wT',
    fila: {
      credential_id: 'MrPRoM4u6hbjb0gwiWe-lg',
      public_key: 'pAEBAycgBiFYIDIjiA5nj8AQ_tb7aWpmsYQsmtDb622aR-KreeDyUgSE',
      counter: 1,
      transports: '["hybrid","internal"]',
      device_type: 'multiDevice',
      backed_up: 1,
      rp_id: 'localhost',
      name: 'Llave EdDSA',
    },
  },
  {
    alg: 'RS256',
    userHandle: 'usr_67e76721788e21a1',
    privateKeyPkcs8:
      'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCsrWURVzOnTXZEGYcAv55kHJNk2xeugwCmFLt8/f+20aGQ' +
      'Wfo3IkPDTCgaAEJ/l/MbXAhvziLrHsLNb8LmVzsQ9b7zxs5QO2Kv6Au8niCRGAmhmIEB3No0zTrikLPGbboQ5ZUPBYfzRWwT' +
      '9AoIRePk/noz2BY4zxvz/0DV0iS1zzFRzKTYQ1HtZPx40AXIQDdlEaPmnSsBmvhgMssg85furYNzxaS7q086GWuFLXDBdl7P' +
      'qw+U7tAiKwyKgT0wFygYgMcteUmU9xvapuA9aCqhLCzGCDkNKtzHuACwdmcKIhnvpWcvBsrEZaOaKKchylKnEt7EYD+k/URK' +
      '/D3XCPZZAgMBAAECggEAB52sL/wbHJ1ngnBnymopJ7w06gVZwYoonKqcbFJdlWggipfVV9osh/ATcrYhOLRwdfv0qU27r4gP' +
      'SnVL8NHXGpPkJKdXkSVVYHHJFrwYrp2TSyvJQNZHT33fw39jVnSfeMBPdzakvN+KeUTRrnS6rO5mYGP+8ul7j6Lp7qRSlywm' +
      'LU1T61gwa5WXc+f9J8N5iphCk1mh/lZWO+L+M3w1pmCgxZlLKLNCfOKJf9azfqbV+N4Asoy2fnLIY+2J39Xlsv2K/3eF6rL2' +
      'MdBDQPbzF2US8ZJiAffQEn6xmaZi50inGcEBoAniuZezNLHNfmGHXtels3HL4Sar38ozFirNIwKBgQDcJoqJ9SHttz7x2Zzx' +
      'iSMpnoFoDhrCuBBBGm5+1OGOFy7tXuoOZPzG5sZgcQWqiposc39O25SrO2GgcZygD7YKK7U8Ga05UN/wnEVZ/yR4qJX3iRYZ' +
      'yo23uApWHt4+wbsBi+ovZ0prB6woN4QB1b0QQIKYHfvZ9lZotbskPC/StwKBgQDIy9P0H9UzhTFUkx2NVpJryEOFQdcXHoOJ' +
      'J3UGEPXoInw53TuGkwvz9vKmQeHHEZbAANyRsNuUWPfYWbrIqvYJm+mzdmnaqfPAf025U16R7Ibx05FP/BZBVLEn/fS/lS84' +
      'ahk9zHkhCM8y0JjZiOUHNKeypefBkvhsvwGynUsvbwKBgCUCEZ35aFe2y00KwPhVjmSrsaNVY6hCGvFmyRZnIPeq7AeZQg1j' +
      'ap7hIo4J0eMGY75/N/KAtTBHzjSThLnfikGRcWkGA/mzn8Gp83qain4CERvInr99Lm+o74vkqoWwOYicBaUsXvU5F/a2xmks' +
      'jhjST2HVAIZ2g7YcfrYrq/pnAoGBAJolV55Wfa5idp9NnOcu6ZLSl3sKM1vtMd8tqjmw9YZyStmFC7hg1FFCZ77YXsIar5bQ' +
      'UoOJuNemgQXWxHxeOijgR0VdByA1Tgmd8QXviW8Om/2zhB9aD5+xq5pe6+/TT//H+36kpOyGPcHtvxlobSHd+0s677J76Dhb' +
      'XatH8zsDAoGBAK+5i7P7fnGFIlz9Z+NCXhNqJAXj9iTeUHG39A7JuX86VvkmUC21thfEmTDXaLgMZQCvbCClv4uKmKHrNo04' +
      'gFvSb/8mRzdoZJ0vH6Ka6U5YpIOqNC0oxjCNWx1F6Raez7Z+gF9BFeuAiMrxLbiJwBKzAtHkAlsLnT9jQNF7tW3p',
    fila: {
      credential_id: 'JJ-CrQhehoVGn9Tb-abOIw',
      public_key:
        'pAEDAzkBACBZAQCsrWURVzOnTXZEGYcAv55kHJNk2xeugwCmFLt8_f-20aGQWfo3IkPDTCgaAEJ_l_MbXAhvziLrHsLNb8Lm' +
        'VzsQ9b7zxs5QO2Kv6Au8niCRGAmhmIEB3No0zTrikLPGbboQ5ZUPBYfzRWwT9AoIRePk_noz2BY4zxvz_0DV0iS1zzFRzKTY' +
        'Q1HtZPx40AXIQDdlEaPmnSsBmvhgMssg85furYNzxaS7q086GWuFLXDBdl7Pqw-U7tAiKwyKgT0wFygYgMcteUmU9xvapuA9' +
        'aCqhLCzGCDkNKtzHuACwdmcKIhnvpWcvBsrEZaOaKKchylKnEt7EYD-k_URK_D3XCPZZIUMBAAE',
      counter: 1,
      transports: '["hybrid","internal"]',
      device_type: 'multiDevice',
      backed_up: 1,
      rp_id: 'localhost',
      name: 'Llave RS256',
    },
  },
];

let app: FastifyInstance;

beforeAll(async () => {
  initDb();
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeDb();
});

function nuevoUsuario(email: string): { user: UserRow; cookie: string } {
  const user = createUser(email, hashPassword('contraseña1'), 'admin');
  return { user, cookie: `skyway_token=${signToken(user.id)}` };
}

async function opcionesDeLogin(headers: Record<string, string> = NAVEGADOR): Promise<{ challengeId: string; options: Json }> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/passkey-login/options', payload: {}, headers });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

async function iniciarSesion(challengeId: string, response: unknown, headers: Record<string, string> = NAVEGADOR) {
  return app.inject({ method: 'POST', url: '/api/auth/passkey-login', payload: { challengeId, response }, headers });
}

describe('passkeys registradas con la versión anterior', () => {
  it.each(ANTERIORES)('$alg: la fila guardada tal cual sigue iniciando sesión', async ({ alg, userHandle, privateKeyPkcs8, fila }) => {
    const { user } = nuevoUsuario(`antigua-${alg.toLowerCase()}@example.com`);
    insertPasskey({ user_id: user.id, ...fila });
    const credencial = credencialDesdePkcs8({ alg, id: fila.credential_id, privateKeyPkcs8, userHandle, counter: fila.counter });

    const { challengeId, options } = await opcionesDeLogin();
    // Las llaves con contador avanzan; las passkeys sincronizadas lo dejan en 0.
    const incrementar = fila.counter > 0;
    const r = await iniciarSesion(challengeId, firmarAsercion(credencial, options, ORIGIN, { incrementar }));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().user.email).toBe(user.email);
    const setCookie = String(r.headers['set-cookie']);
    expect(setCookie).toMatch(/^skyway_token=[^;]+; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax$/);

    const guardada = getPasskeyByCredentialId(fila.credential_id)!;
    expect(guardada.counter).toBe(incrementar ? fila.counter + 1 : 0);
    expect(guardada.last_used_at).not.toBeNull();

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: setCookie.split(';')[0] } });
    expect(me.json().user.id).toBe(user.id);
  });

  it('una firma que no es de la passkey guardada no inicia sesión', async () => {
    const { alg, userHandle, privateKeyPkcs8, fila } = ANTERIORES[0];
    const credencial = credencialDesdePkcs8({ alg, id: fila.credential_id, privateKeyPkcs8, userHandle });
    const { challengeId, options } = await opcionesDeLogin();
    const r = await iniciarSesion(challengeId, firmarAsercion(credencial, options, ORIGIN, { firmaInvalida: true }));
    expect(r.statusCode).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('un contador que no avanza se rechaza (repetición de una firma)', async () => {
    const { alg, userHandle, privateKeyPkcs8, fila } = ANTERIORES.find((a) => a.alg === 'RS256')!;
    const guardada = getPasskeyByCredentialId(fila.credential_id)!;
    const credencial = credencialDesdePkcs8({ alg, id: fila.credential_id, privateKeyPkcs8, userHandle, counter: guardada.counter });
    const { challengeId, options } = await opcionesDeLogin();
    const r = await iniciarSesion(challengeId, firmarAsercion(credencial, options, ORIGIN));
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toMatch(/counter/i);
  });

  it('el reto solo vale una vez', async () => {
    const { alg, userHandle, privateKeyPkcs8, fila } = ANTERIORES[0];
    const credencial = credencialDesdePkcs8({ alg, id: fila.credential_id, privateKeyPkcs8, userHandle });
    const { challengeId, options } = await opcionesDeLogin();
    const respuesta = firmarAsercion(credencial, options, ORIGIN);
    expect((await iniciarSesion(challengeId, respuesta)).statusCode).toBe(200);
    expect((await iniciarSesion(challengeId, respuesta)).statusCode).toBe(400);
  });
});

describe('registro de passkeys', () => {
  let user: UserRow;
  let cookie = '';

  beforeAll(() => {
    ({ user, cookie } = nuevoUsuario('registro@example.com'));
  });

  async function opcionesDeRegistro(): Promise<Json> {
    const r = await app.inject({ method: 'POST', url: '/api/auth/passkeys/options', payload: {}, headers: { ...NAVEGADOR, cookie } });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().options;
  }

  async function registrar(nombre: string, response: unknown) {
    return app.inject({ method: 'POST', url: '/api/auth/passkeys', payload: { name: nombre, response }, headers: { ...NAVEGADOR, cookie } });
  }

  it('las opciones son las mismas que con la versión anterior', async () => {
    const options = await opcionesDeRegistro();
    // `user.id` sigue siendo el id de Skyway: la web lo decodifica como
    // base64url y el autenticador guarda los mismos bytes que antes.
    expect(options.user).toEqual({ id: user.id, name: user.email, displayName: user.email });
    expect(options.rp).toEqual({ name: 'Skyway', id: 'localhost' });
    expect(options.pubKeyCredParams).toEqual([
      { alg: -8, type: 'public-key' },
      { alg: -7, type: 'public-key' },
      { alg: -257, type: 'public-key' },
    ]);
    expect(options.attestation).toBe('none');
    expect(options.timeout).toBe(60000);
    expect(options.authenticatorSelection).toEqual({ residentKey: 'required', userVerification: 'preferred', requireResidentKey: true });
    expect(options.extensions).toEqual({ credProps: true });
    expect(options.excludeCredentials).toEqual([]);
    expect(options.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it.each(['ES256', 'EdDSA', 'RS256'] as Algoritmo[])('registra una passkey %s con el formato de siempre e inicia sesión con ella', async (alg) => {
    const options = await opcionesDeRegistro();
    const { credencial, response } = crearCredencial(options, ORIGIN, alg);
    const r = await registrar(`Llave ${alg}`, response);
    expect(r.statusCode, r.body).toBe(201);

    // Mismo formato que guardaba la versión anterior: id y clave COSE en base64url sin relleno.
    const fila = getPasskeyByCredentialId(credencial.id.toString('base64url'))!;
    expect(fila).toBeTruthy();
    expect(fila.public_key).toBe(credencial.publicKeyCose.toString('base64url'));
    expect(fila.public_key).not.toMatch(/=/);
    expect(fila.counter).toBe(0);
    expect(fila.transports).toBe('["hybrid","internal"]');
    expect(fila.device_type).toBe('multiDevice');
    expect(fila.backed_up).toBe(1);
    expect(fila.rp_id).toBe('localhost');
    // El autenticador recibió los mismos bytes de usuario que con la versión anterior.
    expect(credencial.userHandle.toString('base64url')).toBe(user.id);

    const { challengeId, options: loginOptions } = await opcionesDeLogin();
    const login = await iniciarSesion(challengeId, firmarAsercion(credencial, loginOptions, ORIGIN, { incrementar: true }));
    expect(login.statusCode, login.body).toBe(200);
    expect(getPasskeyByCredentialId(fila.credential_id)!.counter).toBe(1);
  });

  it('las ya registradas van en excludeCredentials con su id guardado', async () => {
    const options = await opcionesDeRegistro();
    const guardadas = listPasskeys(user.id).map((p) => ({ id: p.credential_id, type: 'public-key' }));
    expect(guardadas.length).toBe(3);
    expect(options.excludeCredentials).toEqual(guardadas);
  });

  it('la misma passkey otra vez responde 409', async () => {
    const { credencial, response } = crearCredencial(await opcionesDeRegistro(), ORIGIN);
    expect((await registrar('Una', response)).statusCode).toBe(201);
    // El autenticador vuelve a presentar la misma credencial con el reto nuevo.
    const repetida = crearCredencial(await opcionesDeRegistro(), ORIGIN, 'ES256', credencial);
    const r = await registrar('Otra vez', repetida.response);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe('Esta passkey ya está registrada en Skyway');
  });

  it('un registro hecho desde otro origen no se acepta', async () => {
    const options = await opcionesDeRegistro();
    const { response } = crearCredencial(options, 'http://otro.example:4000');
    const r = await registrar('Ajena', response);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/origin/i);
  });

  it('con un token de API no se pueden registrar passkeys (exige sesión de navegador)', async () => {
    const token = `${API_TOKEN_PREFIX}${randomToken(24)}`;
    insertApiToken({ user_id: user.id, name: 'agente', token_hash: hashApiToken(token), prefix: token.slice(0, 12), expires_at: null });
    const r = await app.inject({ method: 'POST', url: '/api/auth/passkeys/options', payload: {}, headers: { ...NAVEGADOR, authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(403);
  });
});

describe('opciones de inicio de sesión', () => {
  it('el rpId es el host sin puerto y no se listan credenciales (passkeys descubribles)', async () => {
    const { challengeId, options } = await opcionesDeLogin();
    expect(challengeId).toMatch(/^[0-9a-f]{32}$/);
    expect(options).toEqual({ rpId: 'localhost', challenge: options.challenge, timeout: 60000, userVerification: 'preferred' });
  });

  it('detrás de un proxy de confianza con HTTPS, el origen esperado es https', async () => {
    const { alg, userHandle, privateKeyPkcs8, fila } = ANTERIORES[0];
    const credencial = credencialDesdePkcs8({ alg, id: fila.credential_id, privateKeyPkcs8, userHandle });
    // Traefik (red privada) reenvía el Host del navegador y X-Forwarded-Proto.
    const proxy = { host: 'localhost', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.60' };
    const { challengeId, options } = await opcionesDeLogin(proxy);
    const r = await iniciarSesion(challengeId, firmarAsercion(credencial, options, 'https://localhost'), proxy);
    expect(r.statusCode, r.body).toBe(200);
    expect(String(r.headers['set-cookie'])).toMatch(/; Secure;/);
  });
});
