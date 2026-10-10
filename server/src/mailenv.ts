/**
 * Nombres de las variables de correo de una web. Cada librería (y cada
 * tutorial) llama distinto a lo mismo: la contraseña SMTP es `SMTP_PASS` en
 * nodemailer, `MAIL_PASSWORD` en Laravel y `EMAIL_HOST_PASSWORD` en Django.
 * Esta tabla dice qué PAPEL tiene cada nombre conocido, para que la detección
 * (`needs.ts`) sepa que una web envía correo y para que «Conectar a un
 * servicio» escriba las variables con el nombre que la web espera, en vez de
 * obligar a renombrarlas a mano.
 */

export type MailMode = 'smtp' | 'api';

/**
 * Papel de una variable de correo. `secure`, `starttls` y `encryption` dicen lo
 * mismo (el puerto 587 negocia TLS con STARTTLS) con la convención de cada
 * ecosistema: nodemailer quiere `secure=false`, Django `EMAIL_USE_TLS=true` y
 * Laravel `MAIL_ENCRYPTION=tls`.
 */
export type MailRole =
  | 'host'
  | 'port'
  | 'secure'
  | 'starttls'
  | 'encryption'
  | 'user'
  | 'password'
  | 'from'
  | 'url'
  | 'api_url'
  | 'api_key';

export const MAIL_ROLES: readonly MailRole[] = [
  'host',
  'port',
  'secure',
  'starttls',
  'encryption',
  'user',
  'password',
  'from',
  'url',
  'api_url',
  'api_key',
];

/** Papeles que tienen valor en cada modo: la API no da servidor ni contraseña SMTP. */
export const ROLES_BY_MODE: Record<MailMode, readonly MailRole[]> = {
  smtp: ['host', 'port', 'secure', 'starttls', 'encryption', 'user', 'password', 'from', 'url'],
  api: ['api_url', 'api_key', 'from'],
};

/** Papeles que llevan la credencial: si no se puede escribir ninguno, conectar no sirve de nada. */
export const SECRET_ROLES: Record<MailMode, readonly MailRole[]> = {
  smtp: ['password', 'url'],
  api: ['api_key'],
};

/**
 * Papeles que dicen a DÓNDE y con QUÉ usuario se presenta la credencial. Si uno
 * de ellos se queda con un valor puesto a mano distinto del de Mailway y se
 * escribe la credencial, el servicio queda conectado a medias: en el peor caso,
 * envía la contraseña de Mailway al servidor de otro proveedor.
 */
export const CONNECTION_ROLES: Record<MailMode, readonly MailRole[]> = {
  smtp: ['host', 'port', 'user'],
  api: ['api_url'],
};

/**
 * Nombres que Skyway escribe cuando la web no dice nada (los de siempre, que
 * se mantienen para no romper los servicios ya conectados). El orden es el de
 * la respuesta.
 */
export const DEFAULT_MAIL_VARS: Record<MailMode, { name: string; role: MailRole }[]> = {
  smtp: [
    { name: 'SMTP_HOST', role: 'host' },
    { name: 'SMTP_PORT', role: 'port' },
    { name: 'SMTP_SECURE', role: 'secure' },
    { name: 'SMTP_USER', role: 'user' },
    { name: 'SMTP_PASS', role: 'password' },
    { name: 'SMTP_FROM', role: 'from' },
  ],
  api: [
    { name: 'MAILWAY_API_URL', role: 'api_url' },
    { name: 'MAILWAY_API_KEY', role: 'api_key' },
    { name: 'MAIL_FROM', role: 'from' },
  ],
};

/**
 * Nombre → papel. Solo nombres sin ambigüedad: `MAIL_HOSTNAME` es en Mailway
 * el nombre público del servidor (no el SMTP de la web) y por eso no está.
 * `EMAIL_SERVER` es la URL completa en NextAuth y `MAILER_DSN` en Symfony.
 */
const ALIASES: Record<string, MailRole> = {
  SMTP_HOST: 'host',
  SMTP_SERVER: 'host',
  SMTP_HOSTNAME: 'host',
  SMTP_ADDRESS: 'host',
  MAIL_HOST: 'host',
  MAIL_SERVER: 'host',
  MAIL_SMTP_HOST: 'host',
  EMAIL_HOST: 'host',
  EMAIL_SMTP_HOST: 'host',
  MAILER_HOST: 'host',

  SMTP_PORT: 'port',
  MAIL_PORT: 'port',
  MAIL_SMTP_PORT: 'port',
  EMAIL_PORT: 'port',
  EMAIL_SMTP_PORT: 'port',
  MAILER_PORT: 'port',

  SMTP_SECURE: 'secure',
  MAIL_SECURE: 'secure',
  EMAIL_SECURE: 'secure',
  SMTP_SSL: 'secure',
  EMAIL_USE_SSL: 'secure',
  MAIL_USE_SSL: 'secure',

  SMTP_STARTTLS: 'starttls',
  SMTP_TLS: 'starttls',
  MAIL_STARTTLS: 'starttls',
  MAIL_USE_TLS: 'starttls',
  EMAIL_USE_TLS: 'starttls',
  EMAIL_STARTTLS: 'starttls',
  SMTP_ENABLE_STARTTLS_AUTO: 'starttls',

  SMTP_ENCRYPTION: 'encryption',
  MAIL_ENCRYPTION: 'encryption',
  EMAIL_ENCRYPTION: 'encryption',

  SMTP_USER: 'user',
  SMTP_USERNAME: 'user',
  SMTP_LOGIN: 'user',
  MAIL_USER: 'user',
  MAIL_USERNAME: 'user',
  EMAIL_USER: 'user',
  EMAIL_USERNAME: 'user',
  EMAIL_HOST_USER: 'user',
  MAILER_USER: 'user',
  MAILER_USERNAME: 'user',

  SMTP_PASS: 'password',
  SMTP_PASSWORD: 'password',
  MAIL_PASS: 'password',
  MAIL_PASSWORD: 'password',
  EMAIL_PASS: 'password',
  EMAIL_PASSWORD: 'password',
  EMAIL_HOST_PASSWORD: 'password',
  MAILER_PASS: 'password',
  MAILER_PASSWORD: 'password',

  SMTP_FROM: 'from',
  SMTP_FROM_EMAIL: 'from',
  SMTP_FROM_ADDRESS: 'from',
  SMTP_SENDER: 'from',
  MAIL_FROM: 'from',
  MAIL_FROM_ADDRESS: 'from',
  MAIL_FROM_EMAIL: 'from',
  MAIL_SENDER: 'from',
  EMAIL_FROM: 'from',
  EMAIL_FROM_ADDRESS: 'from',
  EMAIL_SENDER: 'from',
  DEFAULT_FROM_EMAIL: 'from',
  MAILER_FROM: 'from',
  MAILER_SENDER: 'from',

  SMTP_URL: 'url',
  SMTP_URI: 'url',
  SMTP_CONNECTION_URL: 'url',
  MAIL_URL: 'url',
  EMAIL_URL: 'url',
  EMAIL_SERVER: 'url',
  MAILER_DSN: 'url',
  MAILER_URL: 'url',

  MAILWAY_API_URL: 'api_url',
  MAILWAY_API_KEY: 'api_key',
};

/** Papel de un nombre de variable, o null si no es uno de correo conocido. */
export function mailRoleOf(name: string): MailRole | null {
  return ALIASES[name] ?? null;
}

/**
 * Papel con un prefijo propio delante del nombre conocido más largo en que
 * termina (`TG_SMTP_LOGIN` → user, `MYAPP_EMAIL_HOST_USER` → user). Un bot o
 * un worker suele llevar sus variables con el nombre del proyecto delante, y
 * un cambio de dominio tiene que reconocer ahí el usuario con el que entra en
 * el correo: tratarlo como una dirección lo dejaría sin poder enviar al pasar.
 *
 * Solo para RECONOCER (cambio de dominio): para escribir y para proponer
 * nombres se usa `mailRoleOf`, que no adivina.
 */
export function mailRoleLoose(name: string): MailRole | null {
  const n = name.trim().toUpperCase();
  const exacto = ALIASES[n];
  if (exacto) return exacto;
  // De izquierda a derecha: el primer sufijo que casa es el más largo.
  for (let i = n.indexOf('_'); i >= 0; i = n.indexOf('_', i + 1)) {
    const role = ALIASES[n.slice(i + 1)];
    if (role) return role;
  }
  return null;
}

/** Las variables esperadas (en su orden) que son de correo, con su papel. */
export function mailVarsOf(expectedVars: readonly string[]): { name: string; role: MailRole }[] {
  const out: { name: string; role: MailRole }[] = [];
  for (const name of expectedVars) {
    const role = mailRoleOf(name);
    if (role && !out.some((v) => v.name === name)) out.push({ name, role });
  }
  return out;
}

/** Modo que se propone: la API si la web pide sus variables; SMTP en el resto. */
export function suggestedMailMode(vars: readonly { role: MailRole }[]): MailMode {
  return vars.some((v) => v.role === 'api_url' || v.role === 'api_key') ? 'api' : 'smtp';
}

/**
 * Qué nombres escribir en cada modo: los que la web espera para los papeles de
 * ese modo y, para los papeles por defecto que la web no nombra, el nombre de
 * siempre. Un papel opcional (`starttls`, `encryption`, `url`) solo se escribe
 * si la web lo pide.
 */
export function mailTargets(mode: MailMode, expected: readonly { name: string; role: MailRole }[]): { name: string; role: MailRole }[] {
  const roles = new Set(ROLES_BY_MODE[mode]);
  const out = expected.filter((v) => roles.has(v.role));
  for (const def of DEFAULT_MAIL_VARS[mode]) {
    if (!out.some((v) => v.role === def.role)) out.push(def);
  }
  return out;
}

/** Datos con los que se rellenan las variables. Los secretos solo existen al conectar. */
export interface MailValues {
  host: string | null;
  port: number | null;
  user: string | null;
  password: string | null;
  from: string | null;
  apiUrl: string | null;
  apiKey: string | null;
}

/** Valor de una variable por su papel, o null si no se conoce todavía (un secreto aún sin crear). */
export function mailValue(role: MailRole, v: MailValues): string | null {
  switch (role) {
    case 'host':
      return v.host;
    case 'port':
      return v.port ? String(v.port) : null;
    // El puerto de envío es el 587: TLS implícito no, STARTTLS sí.
    case 'secure':
      return 'false';
    case 'starttls':
      return 'true';
    case 'encryption':
      return 'tls';
    case 'user':
      return v.user;
    case 'password':
      return v.password;
    case 'from':
      return v.from;
    case 'url':
      // Usuario y contraseña codificados: una dirección lleva «@».
      return v.host && v.user && v.password
        ? `smtp://${encodeURIComponent(v.user)}:${encodeURIComponent(v.password)}@${v.host}:${v.port ?? 587}`
        : null;
    case 'api_url':
      return v.apiUrl;
    case 'api_key':
      return v.apiKey;
  }
}

/** Parte local de un buzón, con el mismo criterio que Mailway: sin «+» y sin empezar ni acabar en signo. */
export const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
