import jwt from 'jsonwebtoken';
import { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config';
import { getSetting, getUser, setSetting } from './db';
import { randomToken } from './util';

export const COOKIE_NAME = 'skyway_token';
const TOKEN_TTL = '30d';

let cachedSecret: string | null = null;

export function jwtSecret(): string {
  if (cachedSecret) return cachedSecret;
  if (config.jwtSecretEnv) {
    cachedSecret = config.jwtSecretEnv;
    return cachedSecret;
  }
  let stored = getSetting('jwtSecret');
  if (!stored) {
    stored = randomToken(32);
    setSetting('jwtSecret', stored);
  }
  cachedSecret = stored;
  return cachedSecret;
}

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, jwtSecret(), { expiresIn: TOKEN_TTL });
}

export function setAuthCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: 30 * 24 * 3600,
  });
}

export function clearAuthCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}

export function userIdFromRequest(req: FastifyRequest): string | null {
  const token = (req.cookies as Record<string, string | undefined>)?.[COOKIE_NAME];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, jwtSecret()) as jwt.JwtPayload;
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/** preHandler que exige sesión válida. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = userIdFromRequest(req);
  if (!userId || !getUser(userId)) {
    reply.code(401).send({ error: 'No autenticado' });
  }
}
