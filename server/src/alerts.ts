import { auditSystem } from './audit';
import { getProject, getService, insertAlert, resolveAllOpenServiceAlerts, resolveOpenServiceAlerts } from './db';
import { OutgoingAlert, dispatchToChannelsDetailed } from './notify';
import { AlertSeverity } from './types';

/** Última auditoría de fallo por canal: como mucho una entrada por hora y canal. */
const ultimoFalloAuditado = new Map<string, number>();
const AUDITAR_FALLO_CADA_MS = 3_600_000;

function registrarFalloEnvio(canal: string, contexto: string, motivo: string): void {
  // Sin logger a mano fuera de una petición: el prefijo permite filtrarlo.
  console.warn(`[alertas] no se pudo enviar ${contexto} por ${canal}: ${motivo}`);
  const ahora = Date.now();
  if (ahora - (ultimoFalloAuditado.get(canal) ?? 0) < AUDITAR_FALLO_CADA_MS) return;
  ultimoFalloAuditado.set(canal, ahora);
  auditSystem('alert_dispatch_failed', `${canal}: ${motivo} — ${contexto}`.slice(0, 300));
}

/**
 * Envío a los canales externos en segundo plano, sin bloquear al llamante. El
 * antiguo `.catch(() => {})` tragaba tanto un rechazo como la lista de canales
 * fallidos que devuelve el envío: Discord o Telegram podían llevar semanas rotos
 * sin que nadie lo supiera. Se deja traza en el log y, acotada, en la auditoría
 * (las alertas ya llegan deduplicadas, así que no hay avalancha de entradas).
 */
function enviarACanales(alerta: OutgoingAlert): void {
  const contexto = `«${alerta.title}»${alerta.project ? ` · ${alerta.project}` : ''}`;
  dispatchToChannelsDetailed(alerta)
    .then((fallos) => {
      for (const f of fallos) registrarFalloEnvio(f.channel, contexto, f.error);
    })
    .catch((err: unknown) => registrarFalloEnvio('canales', contexto, err instanceof Error ? err.message : String(err)));
}

export interface FireAlertInput {
  severity: AlertSeverity;
  type: string;
  serviceId?: string | null;
  projectId?: string | null;
  title: string;
  message: string;
  explanation?: string | null;
  /** Con dedupe, no se crea otra alerta si ya hay una abierta del mismo tipo. */
  dedupe?: boolean;
  /** Clave de dedupe explícita para alertas sin servicio (p. ej. de sistema). */
  dedupeKey?: string;
  /** No enviar a canales externos (solo campana in-app). */
  quiet?: boolean;
}

/** Crea una alerta (con dedupe) y la envía a los canales configurados. */
export function fireAlert(input: FireAlertInput): void {
  const service = input.serviceId ? getService(input.serviceId) : undefined;
  const projectId = input.projectId ?? service?.project_id ?? null;
  const project = projectId ? getProject(projectId) : undefined;

  if (service && (service.config as any).alertsMuted) return;

  const dedupeKey =
    input.dedupeKey ?? (input.dedupe && input.serviceId ? `${input.serviceId}:${input.type}` : null);
  const row = insertAlert({
    severity: input.severity,
    type: input.type,
    project_id: projectId,
    service_id: input.serviceId ?? null,
    title: input.title,
    message: input.message,
    explanation: input.explanation ?? null,
    dedupe_key: dedupeKey,
  });
  if (!row) return; // ya había una alerta abierta idéntica

  if (!input.quiet) {
    enviarACanales({
      severity: input.severity,
      title: input.title,
      message: input.message,
      explanation: input.explanation,
      project: project?.name ?? null,
      service: service?.name ?? null,
    });
  }
}

/** Crea una alerta ligada a una CUENTA de cliente (facturación, uso, morosidad). */
export function fireWorkspaceAlert(input: {
  severity: AlertSeverity;
  workspaceId: string;
  type: string;
  title: string;
  message: string;
  explanation?: string | null;
  /** Clave de dedupe (incluye el ciclo para que se reevalúe cada periodo). */
  dedupeKey: string;
  quiet?: boolean;
}): void {
  const row = insertAlert({
    severity: input.severity,
    type: input.type,
    workspace_id: input.workspaceId,
    title: input.title,
    message: input.message,
    explanation: input.explanation ?? null,
    dedupe_key: input.dedupeKey,
  });
  if (!row) return; // ya había una abierta idéntica
  if (!input.quiet) {
    enviarACanales({
      severity: input.severity,
      title: input.title,
      message: input.message,
      explanation: input.explanation,
      project: null,
      service: null,
    });
  }
}

/** Resuelve las alertas abiertas de un tipo para un servicio (p. ej. al recuperarse). */
export function resolveServiceAlerts(serviceId: string, type: string, notifyRecovery = false): void {
  const resolved = resolveOpenServiceAlerts(serviceId, type);
  if (resolved.length > 0 && notifyRecovery) {
    const service = getService(serviceId);
    const project = service ? getProject(service.project_id) : undefined;
    enviarACanales({
      severity: 'info',
      title: 'Servicio recuperado',
      message: `"${service?.name ?? serviceId}" vuelve a estar en ejecución.`,
      project: project?.name ?? null,
      service: service?.name ?? null,
    });
  }
}

/** Resuelve TODAS las alertas abiertas de un servicio (p. ej. al redesplegar con éxito). */
export function resolveAllServiceAlerts(serviceId: string, notifyRecovery = false): void {
  const resolved = resolveAllOpenServiceAlerts(serviceId);
  if (resolved.length > 0 && notifyRecovery) {
    const service = getService(serviceId);
    const project = service ? getProject(service.project_id) : undefined;
    enviarACanales({
      severity: 'info',
      title: 'Servicio recuperado',
      message: `"${service?.name ?? serviceId}" se ha desplegado con éxito y ha resuelto sus incidencias.`,
      project: project?.name ?? null,
      service: service?.name ?? null,
    });
  }
}
