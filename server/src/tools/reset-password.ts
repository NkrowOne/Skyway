/**
 * Restablecimiento de contraseña desde el propio servidor (último recurso,
 * p. ej. el único admin bloqueado). No hay endpoint HTTP para esto a propósito:
 * quien puede ejecutarlo ya administra la máquina.
 *
 *   docker compose exec skyway node dist/tools/reset-password.js <email> [nueva-contraseña]
 *   npm run reset-password -w server -- <email> [nueva-contraseña]
 *   SKYWAY_NEW_PASSWORD='...' npm run reset-password -w server -- <email>
 *
 * La contraseña como argumento queda en el historial del shell y en `ps` de
 * cualquier usuario de la máquina mientras corre: la variable de entorno
 * evita ambas cosas. Sin ninguna de las dos se genera una contraseña temporal
 * fuerte y se imprime. Invalida las demás sesiones (bump de epoch) y deja
 * rastro en la auditoría.
 */
import crypto from 'node:crypto';
import { getUserByEmail, initDb, insertAudit, updateUserPassword } from '../db';
import { hashPassword } from '../util';

const [email, argPassword] = process.argv.slice(2);
const provided = argPassword ?? (process.env.SKYWAY_NEW_PASSWORD || undefined);

if (!email || email.startsWith('-')) {
  console.error('Uso: reset-password <email> [nueva-contraseña]   (o SKYWAY_NEW_PASSWORD en el entorno)');
  process.exit(1);
}
if (provided !== undefined && provided.length < 8) {
  console.error('La contraseña debe tener al menos 8 caracteres.');
  process.exit(1);
}

initDb();
const user = getUserByEmail(email.trim().toLowerCase());
if (!user) {
  console.error(`No existe ningún usuario con el email ${email}.`);
  process.exit(1);
}

const password = provided ?? crypto.randomBytes(12).toString('base64url');
updateUserPassword(user.id, hashPassword(password));
insertAudit({
  actor: 'cli',
  action: 'password_changed',
  target_type: 'user',
  target_id: user.id,
  detail: 'Contraseña restablecida desde la CLI del servidor',
  ip: null,
});

console.log(`Contraseña de ${user.email} restablecida.`);
if (!provided) console.log(`Contraseña temporal: ${password}`);
console.log('Las sesiones abiertas han quedado invalidadas. Cámbiala tras entrar (Seguridad → Cuenta y sesiones).');
