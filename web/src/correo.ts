/**
 * Reglas de la pestaña Correo que no dependen de React: qué se dice en la
 * tarjeta de un dominio que aún recibe en otro proveedor, qué SPF combinado
 * corresponde a cada registro y, al conectar un servicio, si se revoca una
 * credencial en uso y si el buzón pasa a entrar con su dirección.
 */

import type { MailApiKey, MailAppPassword, MailMailbox } from './types';

/** Nombre DNS comparable: minúsculas y sin el punto final que traen algunos registros. */
export function nombreDns(n: string): string {
  return n.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Qué pasa con lo que se envía desde este servidor a un dominio cuyo MX está
 * en otro proveedor, según lo que informa Mailway en `recepcionExterna`:
 *
 * - true: Mailway lo entrega en el proveedor actual.
 * - false: lo entrega aquí (hay MX de los dos, o todavía no lo ha medido).
 * - null o ausente: un Mailway hasta la 1.2, que siempre lo entrega aquí.
 *
 * Actualizar Mailway solo lo puede hacer el administrador de la plataforma:
 * al resto se le dice quién.
 */
export function entregaMientrasMxFuera(dominio: string, recepcionExterna: boolean | null | undefined, isAdmin: boolean): string {
  const desdeAqui = `lo que se envíe a @${dominio} desde este servidor (la web, otros buzones, la API de envío)`;
  if (recepcionExterna === true) {
    return `Hasta que cambies el MX, ${desdeAqui} se entrega allí y los buzones de aquí no reciben nada todavía.`;
  }
  const local =
    `El servidor de correo lo trata ya como propio: ${desdeAqui} se queda en los buzones de aquí ` +
    'o se rechaza si la dirección solo existe en el proveedor actual.';
  if (recepcionExterna === false) return `${local} Cambia el MX cuando los buzones estén listos.`;
  return isAdmin
    ? `${local} Cambia el MX cuando los buzones estén listos, o actualiza Mailway para que lo entregue en el proveedor actual mientras tanto.`
    : `${local} Cambia el MX cuando los buzones estén listos. Para que se entregue en el proveedor actual mientras tanto, el administrador de la plataforma debe actualizar el servidor de correo.`;
}

/**
 * SPF con el que sustituir el actual, por nombre del registro: el del dominio
 * y, si el servidor de correo está dentro de él (mail.empresa.com), el suyo
 * propio son registros distintos y cada uno tiene su valor.
 */
export function spfSugeridosPorNombre(checks: readonly { id: string; suggested?: string | null }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of checks) {
    if (!c.id.toLowerCase().startsWith('spf:') || !c.suggested) continue;
    out.set(nombreDns(c.id.slice('spf:'.length)), c.suggested);
  }
  return out;
}

/**
 * ¿Tiene el servicio una credencial de Skyway vigente en este modo? Es la que
 * el servidor revoca al conectar, y el contenedor en marcha la sigue usando
 * hasta el próximo despliegue. `credNames` son los nombres que da la vista
 * previa (en un proyecto de una cuenta llevan también el proyecto): repetir
 * aquí la regla del servidor ya falló una vez. Las listas son las vigentes.
 */
export function tieneCredencialVigente(
  mode: 'smtp' | 'api',
  credNames: readonly string[],
  appPasswords: readonly Pick<MailAppPassword, 'name'>[],
  apiKeys: readonly Pick<MailApiKey, 'name'>[],
): boolean {
  return (mode === 'smtp' ? appPasswords : apiKeys).some((c) => credNames.includes(c.name));
}

/**
 * «Volver a desplegar ahora» mientras nadie lo toca: marcado si conectar
 * revoca la credencial que usa el contenedor en marcha. No en un servicio
 * detenido desde el panel: no hay nada en marcha que se quede sin enviar, y
 * cualquier despliegue lo pondría en marcha (quizá se detuvo por algo).
 */
export function desplegarPorDefecto(reconecta: boolean, detenido: boolean): boolean {
  return reconecta && !detenido;
}

/**
 * Como `actualizaUsuarioAlConectar` del servidor: tras un cambio de dominio,
 * conectar por SMTP un buzón que aún entra con su usuario anterior lo
 * actualiza, salvo que lo usen otras aplicaciones de Skyway (que lo actualizan
 * en la baja). La credencial propia del servicio no cuenta como «otra»: es la
 * de `credNames`, que en un proyecto de una cuenta es
 * `skyway:<proyecto>/<servicio>`, no `skyway:<servicio>`.
 */
export function actualizaUsuarioAlConectar(
  mode: 'smtp' | 'api',
  mailbox: Pick<MailMailbox, 'id' | 'loginPending'> | undefined,
  appPasswords: readonly Pick<MailAppPassword, 'mailboxId' | 'name'>[],
  credNames: readonly string[],
): boolean {
  return (
    mode === 'smtp' &&
    !!mailbox?.loginPending &&
    !appPasswords.some((a) => a.mailboxId === mailbox.id && a.name.startsWith('skyway:') && !credNames.includes(a.name))
  );
}
