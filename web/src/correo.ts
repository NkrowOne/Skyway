/**
 * Reglas de la pestaña Correo que no dependen de React: qué se dice en la
 * tarjeta de un dominio que aún recibe en otro proveedor y qué SPF combinado
 * corresponde a cada registro.
 */

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
