import { FastifyRequest } from 'fastify';
import { userIdFromRequest } from './auth';
import { getUser, insertAudit } from './db';

/** Registra una acción en el log de auditoría, con actor e IP de la petición. */
export function audit(
  req: FastifyRequest,
  action: string,
  target?: { type: string; id: string; detail?: string },
  actorOverride?: string,
): void {
  let actor = actorOverride ?? 'sistema';
  if (!actorOverride) {
    const userId = userIdFromRequest(req);
    if (userId) {
      const user = getUser(userId);
      if (user) actor = user.email;
    }
  }
  try {
    insertAudit({
      actor,
      action,
      target_type: target?.type ?? null,
      target_id: target?.id ?? null,
      detail: target?.detail ?? null,
      ip: req.ip || null,
    });
  } catch {
    // la auditoría nunca debe romper la petición
  }
}

export function auditSystem(action: string, detail?: string): void {
  try {
    insertAudit({ actor: 'sistema', action, target_type: null, target_id: null, detail: detail ?? null, ip: null });
  } catch {
    /* noop */
  }
}
