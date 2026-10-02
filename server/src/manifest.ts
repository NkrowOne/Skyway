/**
 * Manifiesto `skyway.json`: lo que una web declara que necesita para
 * funcionar en Skyway (base de datos, correo, secretos, su propia URL) y con
 * qué nombres de variable lo espera. Es OPCIONAL: sin él, la detección de
 * `needs.ts` hace lo que puede con las dependencias y el `.env.example`.
 *
 * Es un fichero del repositorio, así que lo escribe quien escribe el código:
 * por eso no admite comandos, rutas ni nada que se ejecute, el esquema es
 * estricto (una clave desconocida es un error, no algo que se ignora) y ningún
 * valor literal puede llevar una referencia `${{…}}`, que serviría para leer
 * las variables de otro servicio del proyecto sin pedir permiso. Lo que pide
 * se convierte en un plan (`integrations.ts`) que se aplica con los permisos de
 * quien lo aprueba. Formato en docs/MANIFIESTO.md.
 */
import { z } from 'zod';
import { LOCAL_PART_RE, MAIL_ROLES, MailMode, MailRole, ROLES_BY_MODE } from './mailenv';

export const MANIFEST_FILE = 'skyway.json';
/** Un manifiesto ocupa unos cientos de bytes; uno de más de 64 KB no es lo que parece. */
export const MANIFEST_MAX_BYTES = 64 * 1024;
const MAX_ENV = 100;

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `PORT` la fija Skyway en cada despliegue y `SKYWAY_*` son suyas: un manifiesto no las toca. */
export function reservedManifestVar(name: string): boolean {
  return name === 'PORT' || name.toUpperCase().startsWith('SKYWAY_');
}

const DB_SOURCES = ['postgres.url', 'redis.url'] as const;
export type DbSource = (typeof DB_SOURCES)[number];
const SOURCES = [...DB_SOURCES, 'self.public_url', ...MAIL_ROLES.map((r) => `mail.${r}` as const)] as const;

const fromSchema = z
  .object({
    from: z.enum(SOURCES as unknown as [string, ...string[]], {
      errorMap: () => ({
        message: `Origen desconocido: usa postgres.url, redis.url, self.public_url o mail.<papel> (${MAIL_ROLES.join(', ')}).`,
      }),
    }),
  })
  .strict();

const generateSchema = z
  .object({
    generate: z
      .object({
        bytes: z
          .number({ invalid_type_error: 'bytes debe ser un número' })
          .int('bytes debe ser un número entero')
          .min(16, 'Un secreto generado necesita al menos 16 bytes')
          .max(64, 'Un secreto generado admite como máximo 64 bytes')
          .default(32),
      })
      .strict(),
  })
  .strict();

const valueSchema = z
  .object({
    value: z
      .string()
      .max(1000, 'Un valor literal admite como máximo 1000 caracteres')
      // Una referencia leería las variables de otro servicio del proyecto sin aprobación.
      .refine((v) => !v.includes('${{'), 'Un valor literal no puede contener referencias ${{…}}: usa «from»')
      .refine((v) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v), 'Un valor literal no puede contener caracteres de control'),
  })
  .strict();

type EnvEntry = z.infer<typeof fromSchema> | z.infer<typeof generateSchema> | z.infer<typeof valueSchema>;

/**
 * Cada variable es una de las tres formas, elegida por su campo. Con un
 * `z.union` el error de «bytes: 8» se perdía en un «no coincide con ninguna»;
 * así se valida contra la forma que se ha querido escribir y el mensaje dice
 * qué falla.
 */
const envEntrySchema = z.unknown().transform((v, ctx): EnvEntry => {
  const obj = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const schema = !obj ? null : 'from' in obj ? fromSchema : 'generate' in obj ? generateSchema : 'value' in obj ? valueSchema : null;
  if (!schema) {
    ctx.addIssue({ code: 'custom', message: 'Cada variable lleva exactamente uno de estos campos: «from», «generate» o «value»' });
    return z.NEVER;
  }
  const r = schema.safeParse(obj);
  if (!r.success) {
    for (const issue of r.error.issues) ctx.addIssue(issue as z.IssueData);
    return z.NEVER;
  }
  return r.data;
});

const manifestSchema = z
  .object({
    version: z.literal(1, { errorMap: () => ({ message: 'Versión no admitida: este Skyway entiende la versión 1.' }) }),
    integrations: z
      .object({
        mail: z
          .object({
            mode: z.enum(['smtp', 'api']).optional(),
            mailbox: z
              .string()
              .trim()
              .toLowerCase()
              .regex(LOCAL_PART_RE, 'Buzón no válido: indica solo la parte anterior a la arroba, por ejemplo «no-reply»')
              .optional(),
          })
          .strict()
          .optional(),
        postgres: z.object({}).strict().optional(),
        redis: z.object({}).strict().optional(),
      })
      .strict()
      .optional(),
    env: z
      .record(z.string(), envEntrySchema)
      .optional()
      .superRefine((env, ctx) => {
        const names = Object.keys(env ?? {});
        if (names.length > MAX_ENV) ctx.addIssue({ code: 'custom', message: `Como máximo ${MAX_ENV} variables` });
        for (const name of names) {
          if (!ENV_NAME_RE.test(name)) {
            ctx.addIssue({ code: 'custom', path: [name], message: 'Nombre de variable no válido' });
          } else if (reservedManifestVar(name)) {
            ctx.addIssue({ code: 'custom', path: [name], message: 'PORT y las variables SKYWAY_* las gestiona Skyway' });
          }
        }
      }),
  })
  .strict()
  .superRefine((m, ctx) => {
    // Lo que se pide del correo tiene que existir en el modo elegido.
    const mode = manifestMailMode(m);
    for (const [name, entry] of Object.entries(m.env ?? {})) {
      const role = 'from' in entry && entry.from.startsWith('mail.') ? (entry.from.slice(5) as MailRole) : null;
      if (role && !ROLES_BY_MODE[mode].includes(role)) {
        ctx.addIssue({
          code: 'custom',
          path: ['env', name, 'from'],
          message: `mail.${role} no existe en el modo ${mode === 'api' ? 'API' : 'SMTP'}`,
        });
      }
    }
  });

export type SkywayManifest = z.infer<typeof manifestSchema>;
export type ManifestEnvEntry = EnvEntry;

/**
 * Modo del correo: el declarado y, si no, el que se deduce de lo que se pide
 * (una variable `mail.api_*` solo existe con la API).
 */
export function manifestMailMode(m: Pick<SkywayManifest, 'integrations' | 'env'>): MailMode {
  if (m.integrations?.mail?.mode) return m.integrations.mail.mode;
  const usesApi = Object.values(m.env ?? {}).some((e) => 'from' in e && (e.from === 'mail.api_url' || e.from === 'mail.api_key'));
  return usesApi ? 'api' : 'smtp';
}

/** ¿Pide el manifiesto correo, sea en `integrations` o en alguna variable? */
export function manifestWantsMail(m: SkywayManifest): boolean {
  return !!m.integrations?.mail || Object.values(m.env ?? {}).some((e) => 'from' in e && e.from.startsWith('mail.'));
}

/** Motores de base de datos que pide el manifiesto, en `integrations` o por una variable. */
export function manifestEngines(m: SkywayManifest): ('postgres' | 'redis')[] {
  const out: ('postgres' | 'redis')[] = [];
  for (const engine of ['postgres', 'redis'] as const) {
    const byVar = Object.values(m.env ?? {}).some((e) => 'from' in e && e.from === `${engine}.url`);
    if (m.integrations?.[engine] || byVar) out.push(engine);
  }
  return out;
}

/** Ruta de un error de zod en texto: `env.SESSION_SECRET.generate.bytes`. */
function issuePath(path: (string | number)[]): string {
  return path.map(String).join('.');
}

/**
 * Lee y valida el manifiesto. Nunca lanza: un manifiesto roto se enseña en el
 * plan con su motivo y no aplica nada (mejor que aplicar la mitad).
 */
export function parseManifest(text: string): { manifest: SkywayManifest; error: null } | { manifest: null; error: string } {
  if (Buffer.byteLength(text, 'utf8') > MANIFEST_MAX_BYTES) {
    return { manifest: null, error: `${MANIFEST_FILE} ocupa más de 64 KB.` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { manifest: null, error: `${MANIFEST_FILE} no es JSON válido.` };
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const detalle = parsed.error.issues
      .slice(0, 5)
      .map((i) => {
        const path = issuePath(i.path);
        const message = i.code === 'unrecognized_keys' ? `campo no admitido (${i.keys.join(', ')})` : i.message;
        return path ? `${path}: ${message}` : message;
      })
      .join('; ');
    return { manifest: null, error: `${MANIFEST_FILE} no es válido: ${detalle}.` };
  }
  return { manifest: parsed.data, error: null };
}
