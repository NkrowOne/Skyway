/**
 * Tokens de API (`sky_…`) desde el propio servidor, sin red y sin sesión. Los
 * usa el instalador de Mailway para desplegar su panel en Skyway sin pedir al
 * administrador que cree un token a mano: crea uno de corta duración y lo
 * revoca al terminar. Quien puede ejecutarlo ya administra la máquina (y el
 * Docker en el que corre Skyway), así que no da más acceso del que ya tiene.
 *
 *   docker exec skyway node server/dist/tools/token.js crear --nombre <texto> --caduca-min <N> [--email <admin>]
 *     → stdout: {"id":"tok_…","token":"sky_…"}
 *   docker exec skyway node server/dist/tools/token.js revocar --id <id>
 *     → stdout: {"ok":true,"revoked":true|false}; código 0 aunque el token ya no exista
 *
 * El token es igual que los de Mi perfil → Tokens de API (`apitokens.ts`), con
 * caducidad obligatoria, y pertenece al primer administrador o al indicado con
 * --email. Crear y revocar quedan en la auditoría con el actor «sistema», sin
 * el valor del token. Código 1 y el motivo en stderr si algo falla.
 */
import { z } from 'zod';
import { CADUCIDAD_MAXIMA_MS, emitirTokenApi, nombreTokenSchema } from '../apitokens';
import { auditSystem } from '../audit';
import { deleteApiTokenById, getApiToken, getUser, getUserByEmail, initDb, listUsers } from '../db';
import { UserRow } from '../types';
import { ENTRADA_SALIDA_PROCESO, EntradaSalida, ErrorHerramienta, leerOpciones, mensajeDeError } from './argumentos';

const USO = [
  'Uso:',
  '  token crear --nombre <texto> --caduca-min <minutos> [--email <correo de un administrador>]',
  '  token revocar --id <id del token>',
].join('\n');

const CADUCIDAD_MAXIMA_MIN = CADUCIDAD_MAXIMA_MS / 60_000;

const crearSchema = z.object({
  nombre: nombreTokenSchema,
  'caduca-min': z
    .string({ required_error: 'Indica la caducidad en minutos con --caduca-min.' })
    .regex(/^\d{1,7}$/, 'La caducidad (--caduca-min) debe ser un número entero de minutos.')
    .transform(Number)
    .refine((n) => n >= 1 && n <= CADUCIDAD_MAXIMA_MIN, `La caducidad debe estar entre 1 y ${CADUCIDAD_MAXIMA_MIN} minutos (3650 días).`),
  email: z.string().trim().toLowerCase().email('El correo de --email no es válido.').optional(),
});

const revocarSchema = z.object({
  id: z
    .string({ required_error: 'Indica el token con --id.' })
    .regex(/^tok_[A-Za-z0-9]{1,64}$/, 'El identificador del token no es válido (empieza por «tok_»).'),
});

/** El administrador indicado o, sin --email, el más antiguo. */
function administrador(email: string | undefined): UserRow {
  if (email) {
    const user = getUserByEmail(email);
    if (!user) throw new ErrorHerramienta(`No existe ningún usuario con el correo ${email}.`);
    if (user.role !== 'admin') throw new ErrorHerramienta(`${user.email} no es administrador: el token tiene que ser de un administrador.`);
    return user;
  }
  const user = listUsers().find((u) => u.role === 'admin');
  if (!user) throw new ErrorHerramienta('Todavía no hay ningún administrador: crea la cuenta desde el panel de Skyway.');
  return user;
}

function crear(argv: readonly string[], io: EntradaSalida): void {
  const opts = crearSchema.parse(leerOpciones(argv, ['nombre', 'caduca-min', 'email']));
  const user = administrador(opts.email);
  const { token, row } = emitirTokenApi({
    userId: user.id,
    name: opts.nombre,
    expiresAt: Date.now() + opts['caduca-min'] * 60_000,
  });
  auditSystem('token_created', `${row.name} · de ${user.email}, desde la terminal del servidor (caduca en ${opts['caduca-min']} min)`, {
    type: 'token',
    id: row.id,
  });
  io.out(JSON.stringify({ id: row.id, token }));
}

function revocar(argv: readonly string[], io: EntradaSalida): void {
  const { id } = revocarSchema.parse(leerOpciones(argv, ['id']));
  const row = getApiToken(id);
  // Ya revocado (o nunca existió): lo que se pedía ya se cumple y no es un fallo.
  const revoked = !!row && deleteApiTokenById(id);
  if (row && revoked) {
    const owner = getUser(row.user_id);
    auditSystem('token_deleted', `${row.name}${owner ? ` · de ${owner.email}` : ''}, desde la terminal del servidor`, { type: 'token', id });
  }
  io.out(JSON.stringify({ ok: true, revoked }));
}

/** Ejecuta la herramienta y devuelve el código de salida. La base de datos ya debe estar abierta. */
export function ejecutarToken(argv: readonly string[], io: EntradaSalida): number {
  const [orden, ...resto] = argv;
  try {
    if (orden === 'crear') crear(resto, io);
    else if (orden === 'revocar') revocar(resto, io);
    else throw new ErrorHerramienta(USO);
    return 0;
  } catch (err) {
    io.err(mensajeDeError(err));
    return 1;
  }
}

if (require.main === module) {
  initDb();
  process.exit(ejecutarToken(process.argv.slice(2), ENTRADA_SALIDA_PROCESO));
}
