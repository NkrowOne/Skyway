import { getProject, getService, insertAlert, resolveOpenServiceAlerts } from './db';
import { dispatchToChannels } from './notify';
import { AlertSeverity } from './types';

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
    void dispatchToChannels({
      severity: input.severity,
      title: input.title,
      message: input.message,
      explanation: input.explanation,
      project: project?.name ?? null,
      service: service?.name ?? null,
    }).catch(() => {});
  }
}

/** Resuelve las alertas abiertas de un tipo para un servicio (p. ej. al recuperarse). */
export function resolveServiceAlerts(serviceId: string, type: string, notifyRecovery = false): void {
  const resolved = resolveOpenServiceAlerts(serviceId, type);
  if (resolved.length > 0 && notifyRecovery) {
    const service = getService(serviceId);
    const project = service ? getProject(service.project_id) : undefined;
    void dispatchToChannels({
      severity: 'info',
      title: 'Servicio recuperado',
      message: `"${service?.name ?? serviceId}" vuelve a estar en ejecución.`,
      project: project?.name ?? null,
      service: service?.name ?? null,
    }).catch(() => {});
  }
}
