/**
 * Configuración inicial del correo (enlace de bienvenida de Mailway): la
 * validez que se ofrece y el correo con el que se envía el enlace a la persona
 * de contacto del cliente desde el programa de correo de quien lo crea.
 */

/** Validez que se ofrece al crear el enlace, en días (Mailway admite de 1 hora a 30 días). */
export const VALIDEZ_DIAS = [1, 3, 7, 30] as const;

const FECHA = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'long', year: 'numeric' });
const HORA = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' });

/** Fecha y hora completas («16 de octubre de 2026 a las 10:30»): la caducidad del enlace se lee en un correo. */
export function fmtCaducidad(ts: number): string {
  const d = new Date(ts);
  return `${FECHA.format(d)} a las ${HORA.format(d)}`;
}

export interface CorreoBienvenida {
  email: string;
  name: string;
  /** Nombre del cliente de correo (el de la cuenta, si lo comparten sus proyectos). */
  clientName: string;
  url: string;
  expiresAt: number | null;
}

/** Asunto y cuerpo del correo con el enlace: breve, profesional y tratando de tú a quien lo recibe. */
export function textoBienvenida(c: CorreoBienvenida): { subject: string; body: string } {
  const nombre = c.name.trim();
  const lineas = [
    nombre ? `Hola, ${nombre}:` : 'Hola:',
    '',
    `Se ha preparado el acceso de ${c.clientName} al panel de correo. Con el siguiente enlace podrás crear tu acceso y, a continuación, añadir el dominio de la empresa y crear los buzones que necesites:`,
    '',
    c.url,
    '',
    c.expiresAt
      ? `El enlace es personal, solo se puede utilizar una vez y caduca el ${fmtCaducidad(c.expiresAt)}.`
      : 'El enlace es personal y solo se puede utilizar una vez.',
    '',
    'Un saludo.',
  ];
  // Saltos de línea CRLF: es lo que pide RFC 6068 para el cuerpo de un enlace mailto.
  return { subject: `Configuración inicial del correo de ${c.clientName}`, body: lineas.join('\r\n') };
}

/** Enlace mailto: con el asunto y el cuerpo codificados (un «&» o un «?» del nombre no rompen la dirección). */
export function mailtoBienvenida(c: CorreoBienvenida): string {
  const { subject, body } = textoBienvenida(c);
  // La arroba se deja tal cual: algunos programas de correo no decodifican %40 en la dirección.
  const to = encodeURIComponent(c.email.trim()).replace(/%40/g, '@');
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
