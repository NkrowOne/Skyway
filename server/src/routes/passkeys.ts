import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from '@simplewebauthn/types';
import {
  clearLoginFailures,
  currentUser,
  loginBlocked,
  recordLoginFailure,
  requireAuth,
  requireSession,
  setAuthCookie,
  signToken,
} from '../auth';
import { audit } from '../audit';
import {
  deletePasskey,
  getPasskeyByCredentialId,
  getUser,
  insertPasskey,
  listPasskeys,
  touchPasskey,
} from '../db';
import { randomToken } from '../util';

const RP_NAME = 'Skyway';
const CHALLENGE_TTL_MS = 5 * 60_000;

// Retos pendientes en memoria: se consumen una vez y caducan solos.
const regChallenges = new Map<string, { challenge: string; rpId: string; origin: string; expires: number }>();
const authChallenges = new Map<string, { challenge: string; rpId: string; origin: string; expires: number }>();

function sweep(map: Map<string, { expires: number }>): void {
  const now = Date.now();
  for (const [k, v] of map) if (v.expires < now) map.delete(k);
}

const MAX_PENDING_CHALLENGES = 5000;

/** Tope de memoria expulsando los retos MÁS ANTIGUOS (nunca un clear() global). */
function capChallenges(map: Map<string, unknown>): void {
  while (map.size > MAX_PENDING_CHALLENGES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * WebAuthn liga cada credencial al dominio (rpID). Se derivan del Host real de
 * la petición para que funcione tanto en localhost (túnel SSH) como con dominio.
 */
function rpInfo(req: FastifyRequest): { rpId: string; origin: string } {
  const host = req.hostname || 'localhost';
  const rpId = host.split(':')[0];
  const originHeader = req.headers.origin;
  const origin = typeof originHeader === 'string' && originHeader ? originHeader : `${req.protocol}://${host}`;
  return { rpId, origin };
}

function b64uToBuffer(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

function bufferToB64u(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

export async function passkeyRoutes(app: FastifyInstance): Promise<void> {
  // ---- gestión de passkeys de la propia cuenta (requiere sesión) ----
  app.register(async (secured) => {
    secured.addHook('preHandler', requireAuth);

    secured.get('/api/auth/passkeys', async (req) => {
      const user = currentUser(req)!;
      return {
        passkeys: listPasskeys(user.id).map((p) => ({
          id: p.id,
          name: p.name,
          rp_id: p.rp_id,
          device_type: p.device_type,
          backed_up: !!p.backed_up,
          created_at: p.created_at,
          last_used_at: p.last_used_at,
        })),
      };
    });

    secured.post('/api/auth/passkeys/options', { preHandler: requireSession }, async (req) => {
      const user = currentUser(req)!;
      const { rpId, origin } = rpInfo(req);
      const existing = listPasskeys(user.id);
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: rpId,
        userID: user.id,
        userName: user.email,
        attestationType: 'none',
        excludeCredentials: existing.map((p) => ({
          id: b64uToBuffer(p.credential_id),
          type: 'public-key' as const,
        })),
        authenticatorSelection: {
          // residentKey requerido → login sin escribir email (descubrible).
          residentKey: 'required',
          userVerification: 'preferred',
        },
      });
      sweep(regChallenges);
      regChallenges.set(user.id, { challenge: options.challenge, rpId, origin, expires: Date.now() + CHALLENGE_TTL_MS });
      return { options };
    });

    secured.post('/api/auth/passkeys', { preHandler: requireSession }, async (req, reply) => {
      const user = currentUser(req)!;
      const body = z
        .object({ name: z.string().trim().min(1, 'Nombre requerido').max(60), response: z.any() })
        .parse(req.body);
      const pending = regChallenges.get(user.id);
      regChallenges.delete(user.id);
      if (!pending || pending.expires < Date.now()) {
        return reply.code(400).send({ error: 'El reto ha caducado, inténtalo de nuevo' });
      }
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: body.response as RegistrationResponseJSON,
          expectedChallenge: pending.challenge,
          expectedOrigin: pending.origin,
          expectedRPID: pending.rpId,
          requireUserVerification: false,
        });
      } catch (err: any) {
        return reply.code(400).send({ error: `No se pudo verificar la passkey: ${err?.message ?? 'error'}` });
      }
      if (!verification.verified || !verification.registrationInfo) {
        return reply.code(400).send({ error: 'La verificación de la passkey falló' });
      }
      const info = verification.registrationInfo;
      const transports = (body.response as RegistrationResponseJSON).response?.transports as
        | AuthenticatorTransportFuture[]
        | undefined;
      const row = insertPasskey({
        user_id: user.id,
        credential_id: bufferToB64u(info.credentialID),
        public_key: bufferToB64u(info.credentialPublicKey),
        counter: info.counter,
        transports: transports ? JSON.stringify(transports) : null,
        device_type: info.credentialDeviceType ?? null,
        backed_up: info.credentialBackedUp ? 1 : 0,
        rp_id: pending.rpId,
        name: body.name,
      });
      audit(req, 'passkey_registered', { type: 'passkey', id: row.id, detail: `${body.name} (${pending.rpId})` });
      reply.code(201);
      return { passkey: { id: row.id, name: row.name, rp_id: row.rp_id, created_at: row.created_at } };
    });

    secured.delete('/api/auth/passkeys/:id', async (req, reply) => {
      const user = currentUser(req)!;
      const { id } = req.params as { id: string };
      if (!deletePasskey(id, user.id)) return reply.code(404).send({ error: 'Passkey no encontrada' });
      audit(req, 'passkey_deleted', { type: 'passkey', id });
      return { ok: true };
    });
  });

  // ---- login con passkey (público, sin email: credenciales descubribles) ----
  app.post('/api/auth/passkey-login/options', async (req, reply) => {
    if (loginBlocked(req.ip)) {
      return reply.code(429).send({ error: 'Demasiados intentos fallidos. Espera 15 minutos.' });
    }
    const { rpId, origin } = rpInfo(req);
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      userVerification: 'preferred',
    });
    const challengeId = randomToken(16);
    sweep(authChallenges);
    authChallenges.set(challengeId, { challenge: options.challenge, rpId, origin, expires: Date.now() + CHALLENGE_TTL_MS });
    // Endpoint anónimo: tope de memoria expulsando los más antiguos, sin borrar
    // los retos legítimos en vuelo (un clear() los invalidaría a todos).
    capChallenges(authChallenges);
    return { challengeId, options };
  });

  app.post('/api/auth/passkey-login', async (req, reply) => {
    if (loginBlocked(req.ip)) {
      audit(req, 'login_blocked', { type: 'ip', id: req.ip });
      return reply.code(429).send({ error: 'Demasiados intentos fallidos. Espera 15 minutos.' });
    }
    const body = z.object({ challengeId: z.string(), response: z.any() }).parse(req.body);
    const pending = authChallenges.get(body.challengeId);
    authChallenges.delete(body.challengeId);
    if (!pending || pending.expires < Date.now()) {
      return reply.code(400).send({ error: 'El reto ha caducado, inténtalo de nuevo' });
    }
    const response = body.response as AuthenticationResponseJSON;
    const passkey = response?.id ? getPasskeyByCredentialId(response.id) : undefined;
    if (!passkey) {
      recordLoginFailure(req.ip);
      audit(req, 'login_failed', { type: 'passkey', id: response?.id ?? '?' });
      return reply.code(401).send({ error: 'Passkey no reconocida' });
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: pending.rpId,
        authenticator: {
          credentialID: b64uToBuffer(passkey.credential_id),
          credentialPublicKey: b64uToBuffer(passkey.public_key),
          counter: passkey.counter,
          transports: passkey.transports ? (JSON.parse(passkey.transports) as AuthenticatorTransportFuture[]) : undefined,
        },
        requireUserVerification: false,
      });
    } catch (err: any) {
      recordLoginFailure(req.ip);
      audit(req, 'login_failed', { type: 'passkey', id: passkey.id });
      return reply.code(401).send({ error: `Passkey inválida: ${err?.message ?? 'error'}` });
    }
    if (!verification.verified) {
      recordLoginFailure(req.ip);
      audit(req, 'login_failed', { type: 'passkey', id: passkey.id });
      return reply.code(401).send({ error: 'La verificación de la passkey falló' });
    }
    const user = getUser(passkey.user_id);
    if (!user) return reply.code(401).send({ error: 'Usuario no encontrado' });
    touchPasskey(passkey.id, verification.authenticationInfo.newCounter);
    clearLoginFailures(req.ip);
    setAuthCookie(reply, signToken(user.id), req.protocol === 'https');
    audit(req, 'login_passkey', { type: 'user', id: user.id, detail: `${user.email} · ${passkey.name}` }, user.email);
    return { user: { id: user.id, email: user.email, role: user.role } };
  });
}
