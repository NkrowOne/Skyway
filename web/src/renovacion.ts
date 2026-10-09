/**
 * Lo que dice «Conectar a un servicio» de la renovación automática de la
 * contraseña de aplicación de un servicio conectado por SMTP: al cambiar de
 * motor de correo, Mailway invalida las contraseñas de aplicación del motor
 * anterior y Skyway crea una nueva, la guarda en las variables del servicio y
 * lo vuelve a desplegar (ver `server/src/mailwayrenovacion.ts`).
 */
import { MailRenewal } from './types';

const FECHA = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'long', year: 'numeric' });
const HORA = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' });

/** Fecha y hora completas («9 de octubre de 2026 a las 14:32»). */
export function fmtRenovacion(ts: number): string {
  const d = new Date(ts);
  return `${FECHA.format(d)} a las ${HORA.format(d)}`;
}

export interface AvisoRenovacion {
  tone: 'ok' | 'warn' | 'err';
  /** Lo que ha pasado, en una frase. */
  title: string;
  /** Lo que queda por hacer o por qué no se ha podido. */
  detail: string | null;
  /** El despliegue que la aplica no ha terminado bien: se enlaza el historial. */
  deploymentFailed: boolean;
}

const INVALIDADA = 'La contraseña de aplicación del servicio ha dejado de ser válida tras la actualización del servidor de correo';

export function avisoRenovacion(r: MailRenewal): AvisoRenovacion | null {
  if (r.status === 'waiting') {
    return { tone: 'warn', title: `${INVALIDADA}.`, detail: r.reason, deploymentFailed: false };
  }
  if (r.status === 'failed') {
    return { tone: 'err', title: `${INVALIDADA} y no se ha podido renovar automáticamente.`, detail: r.reason, deploymentFailed: false };
  }
  if (!r.renewedAt) return null;
  const title = `Contraseña de aplicación renovada automáticamente el ${fmtRenovacion(r.renewedAt)} tras la actualización del servidor de correo.`;
  const dep = r.deployment;
  if (!dep) return { tone: 'ok', title, detail: 'Se aplicará en el próximo despliegue del servicio.', deploymentFailed: false };
  if (dep.status === 'success') return { tone: 'ok', title, detail: 'Se ha vuelto a desplegar el servicio para aplicarla.', deploymentFailed: false };
  if (dep.status === 'queued' || dep.status === 'building' || dep.status === 'deploying') {
    return { tone: 'ok', title, detail: 'Se está volviendo a desplegar el servicio para aplicarla.', deploymentFailed: false };
  }
  return {
    tone: 'warn',
    title,
    detail: 'El despliegue que la aplica no se ha completado. Vuelve a desplegar el servicio para que la utilice.',
    deploymentFailed: true,
  };
}
