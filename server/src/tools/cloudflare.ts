/**
 * Deja configurado el token de Cloudflare del administrador desde el propio
 * servidor: lo que hace Ajustes → Cloudflare con «Probar» y «Guardar», sin
 * navegador. Lo usa el instalador de Mailway, que pide el token UNA vez al
 * operador; quien puede ejecutarlo ya administra la máquina.
 *
 *   printf '%s' "$CF_TOKEN" | docker exec -i skyway node server/dist/tools/cloudflare.js conectar
 *     → stdout: {"ok":true,"zones":3}
 *
 * El token se lee SOLO de la entrada estándar: como argumento quedaría en el
 * historial del shell y en `ps` de cualquier usuario de la máquina mientras
 * corre. La verificación y el guardado son las funciones de Ajustes
 * (`cloudflareconfig.ts`): si Cloudflare no acepta el token no se guarda nada;
 * si se guarda, se audita con el actor «sistema» y sin el token. Repetirlo con
 * el mismo token refresca las zonas sin dejar otra entrada de auditoría. La
 * salida nunca incluye el token, solo el número de zonas que ve.
 */
import { auditSystem } from '../audit';
import { CloudflareError } from '../cloudflare';
import { guardarTokenCloudflare, validarFormatoToken } from '../cloudflareconfig';
import { initDb } from '../db';
import { ENTRADA_SALIDA_PROCESO, EntradaSalida, ErrorHerramienta, mensajeDeError } from './argumentos';

const USO = 'Uso: printf \'%s\' "$CF_TOKEN" | cloudflare conectar';

const SOLO_ENTRADA =
  'El token de Cloudflare se lee solo de la entrada estándar, nunca de los argumentos (quedaría en el historial y en «ps»). ' +
  'Ejemplo: printf \'%s\' "$CF_TOKEN" | docker exec -i skyway node server/dist/tools/cloudflare.js conectar';

/** Tamaño máximo de la entrada: un token ocupa ~40-60 caracteres. */
const MAX_ENTRADA = 4096;

export interface EntradaSalidaCloudflare extends EntradaSalida {
  /** Todo lo recibido por la entrada estándar. */
  leerEntrada: () => Promise<string>;
}

/**
 * ¿Parece un token? Los de Cloudflare no llevan un prefijo fijo (los de
 * usuario son 40 caracteres alfanuméricos; los de cuenta, `cfat_…`; la clave
 * global, `cfk_…` o 37 hexadecimales): cualquier palabra larga de ese
 * alfabeto se trata como un secreto pegado donde no toca.
 */
function pareceToken(arg: string): boolean {
  return /cf(at|k)_/i.test(arg) || /[A-Za-z0-9_-]{20,}/.test(arg);
}

/** El token de la entrada estándar, sin el salto de línea final. Nunca se repite en un mensaje. */
export function tokenDeEntrada(texto: string): string {
  if (texto.length > MAX_ENTRADA) throw new ErrorHerramienta('La entrada estándar es demasiado larga para ser un token de Cloudflare.');
  const token = texto.trim();
  if (!token) throw new ErrorHerramienta(`No ha llegado ningún token por la entrada estándar. ${SOLO_ENTRADA}`);
  try {
    return validarFormatoToken(token);
  } catch (err) {
    throw new ErrorHerramienta(mensajeDeError(err));
  }
}

async function conectar(io: EntradaSalidaCloudflare): Promise<void> {
  const token = tokenDeEntrada(await io.leerEntrada());
  const { zones } = await guardarTokenCloudflare(token, (action, target) => auditSystem(action, target.detail, target));
  io.out(JSON.stringify({ ok: true, zones: zones.total }));
}

/** Ejecuta la herramienta y devuelve el código de salida. La base de datos ya debe estar abierta. */
export async function ejecutarCloudflare(argv: readonly string[], io: EntradaSalidaCloudflare): Promise<number> {
  const [orden, ...resto] = argv;
  try {
    // Antes que nada: un token en los argumentos se rechaza sin usarlo ni repetirlo.
    if (argv.includes('--token') || argv.some(pareceToken)) throw new ErrorHerramienta(SOLO_ENTRADA);
    if (orden !== 'conectar' || resto.length > 0) throw new ErrorHerramienta(USO);
    await conectar(io);
    return 0;
  } catch (err) {
    io.err(err instanceof CloudflareError ? `Cloudflare: ${err.message}` : mensajeDeError(err));
    return 1;
  }
}

/** Entrada estándar del proceso. Desde un terminal no se espera: el token tiene que llegar por una tubería. */
async function leerEntradaEstandar(): Promise<string> {
  if (process.stdin.isTTY) throw new ErrorHerramienta(SOLO_ENTRADA);
  const trozos: Buffer[] = [];
  let total = 0;
  for await (const trozo of process.stdin) {
    const buf = Buffer.isBuffer(trozo) ? trozo : Buffer.from(String(trozo));
    total += buf.length;
    if (total > MAX_ENTRADA) throw new ErrorHerramienta('La entrada estándar es demasiado larga para ser un token de Cloudflare.');
    trozos.push(buf);
  }
  return Buffer.concat(trozos).toString('utf8');
}

if (require.main === module) {
  initDb();
  void ejecutarCloudflare(process.argv.slice(2), { ...ENTRADA_SALIDA_PROCESO, leerEntrada: leerEntradaEstandar }).then((code) =>
    process.exit(code),
  );
}
