import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config';
import { getApiTokenByHash, getSetting, getUser, setSetting, touchApiToken, userHasProject } from './db';
import { UserRow } from './types';
import { randomToken } from './util';

declare module 'fastify' {
  interface FastifyRequest {
    /** Usuario autenticado, resuelto una vez por petición (cookie o token Bearer). */
    authUser?: UserRow | null;
    /** Cómo nombrar al actor en auditoría (email, o email · token:nombre). */
    authActor?: string;
    /** Con qué se autenticó: sesión de navegador ('cookie') o token de API ('token'). */
    authMethod?: 'cookie' | 'token';
  }
}

export const COOKIE_NAME = 'skyway_token';
export const API_TOKEN_PREFIX = 'sky_';
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

/** Invalida todas las sesiones rotando el secreto de firma. */
export function rotateJwtSecret(): void {
  const next = randomToken(32);
  setSetting('jwtSecret', next);
  cachedSecret = config.jwtSecretEnv ? cachedSecret : next;
}

// --- límite de intentos de login por IP (anti fuerza bruta) ---
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 8;
const MAX_TRACKED_IPS = 5000;
const attempts = new Map<string, { count: number; first: number }>();

export function loginBlocked(ip: string): boolean {
  const entry = attempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

export function recordLoginFailure(ip: string): void {
  const entry = attempts.get(ip);
  if (!entry || Date.now() - entry.first > WINDOW_MS) {
    attempts.set(ip, { count: 1, first: Date.now() });
  } else {
    entry.count += 1;
  }
  // Tope de memoria: se expulsan las entradas MÁS ANTIGUAS, nunca un clear()
  // global. Un clear() dejaría que un atacante, inundando desde miles de IPs,
  // reseteara de golpe el contador de todas las víctimas (amplificación).
  while (attempts.size > MAX_TRACKED_IPS) {
    const oldest = attempts.keys().next().value;
    if (oldest === undefined) break;
    attempts.delete(oldest);
  }
}

export function clearLoginFailures(ip: string): void {
  attempts.delete(ip);
}

export function signToken(userId: string): string {
  const epoch = getUser(userId)?.session_epoch ?? 0;
  return jwt.sign({ sub: userId, epoch }, jwtSecret(), { expiresIn: TOKEN_TTL, algorithm: 'HS256' });
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
  return verifySession(req)?.userId ?? null;
}

/** Verifica la cookie de sesión y devuelve el usuario y el epoch firmado. */
function verifySession(req: FastifyRequest): { userId: string; epoch: number } | null {
  const token = (req.cookies as Record<string, string | undefined>)?.[COOKIE_NAME];
  if (!token) return null;
  try {
    // algorithms fijado a HS256: sin esto, jsonwebtoken aceptaría cualquier
    // algoritmo del propio token (incluida confusión de algoritmo).
    const payload = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (typeof payload.sub !== 'string') return null;
    return { userId: payload.sub, epoch: typeof payload.epoch === 'number' ? payload.epoch : 0 };
  } catch {
    return null;
  }
}

export function hashApiToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Resuelve el usuario de la petición: primero token Bearer de API
 * (automatizaciones, Claude), después cookie de sesión. Cachea en la request.
 */
export function currentUser(req: FastifyRequest): UserRow | null {
  if (req.authUser !== undefined) return req.authUser;
  let user: UserRow | null = null;

  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const raw = header.slice(7).trim();
    if (raw.startsWith(API_TOKEN_PREFIX)) {
      const row = getApiTokenByHash(hashApiToken(raw));
      if (row && (!row.expires_at || row.expires_at > Date.now())) {
        const owner = getUser(row.user_id);
        if (owner) {
          user = owner;
          req.authActor = `${owner.email} · token:${row.name}`;
          req.authMethod = 'token';
          touchApiToken(row.id);
        }
      }
    }
  }

  if (!user) {
    const session = verifySession(req);
    if (session) {
      const fromCookie = getUser(session.userId);
      // El epoch corta las cookies emitidas antes de un cambio/reset de contraseña.
      if (fromCookie && fromCookie.session_epoch === session.epoch) {
        user = fromCookie;
        req.authActor = fromCookie.email;
        req.authMethod = 'cookie';
      }
    }
  }

  req.authUser = user;
  return user;
}

/**
 * preHandler que exige sesión de navegador (cookie), rechazando tokens de API.
 * Se usa en operaciones que crean credenciales persistentes (passkeys, tokens):
 * así un token robado no puede fabricarse acceso que sobreviva a su revocación.
 */
export async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!currentUser(req)) {
    reply.code(401).send({ error: 'No autenticado' });
    return;
  }
  if (req.authMethod !== 'cookie') {
    reply.code(403).send({ error: 'Esta acción requiere una sesión de navegador, no un token de API' });
  }
}

/** preHandler que exige sesión válida (cookie o token de API). */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!currentUser(req)) {
    reply.code(401).send({ error: 'No autenticado' });
  }
}

/** preHandler que exige rol administrador. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = currentUser(req);
  if (!user) {
    reply.code(401).send({ error: 'No autenticado' });
    return;
  }
  if (user.role !== 'admin') {
    reply.code(403).send({ error: 'Requiere permisos de administrador' });
  }
}

export function canAccessProject(user: UserRow, projectId: string): boolean {
  return user.role === 'admin' || userHasProject(user.id, projectId);
}

/**
 * Comprueba acceso al proyecto; si no lo hay responde 403 y devuelve false.
 * Úsalo tras requireAuth (siempre hay usuario).
 */
export function assertProjectAccess(req: FastifyRequest, reply: FastifyReply, projectId: string): boolean {
  const user = currentUser(req)!;
  if (canAccessProject(user, projectId)) return true;
  reply.code(403).send({ error: 'No tienes acceso a este workspace' });
  return false;
}
