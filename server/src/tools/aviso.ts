/**
 * Envía un aviso por los canales de alertas del panel (Discord, Telegram o
 * webhook de Ajustes → Alertas) desde la terminal del servidor: lo mismo que
 * «Enviar notificación de prueba», con el texto que se indique. Lo usa
 * `skyway update --auto` (`scripts/skyway`) para contar al operador cómo ha
 * ido la actualización nocturna; quien puede ejecutarlo ya administra la
 * máquina.
 *
 *   docker exec skyway node server/dist/tools/aviso.js --nivel <info|error> --mensaje <texto> [--titulo <texto>]
 *     → stdout: {"ok":true,"channels":["discord"],"failures":[]}
 *
 * El texto llega como argumento: el script lo pasa a `docker exec` sin un
 * shell de por medio, así que no hay nada que escapar. La salida nombra los
 * canales, nunca sus URL ni el token de Telegram (que va dentro de la URL), y
 * un fallo solo dice el estado HTTP o el código de red, como en Ajustes. Sin
 * ningún canal configurado no se envía nada y el código es 0: no es un fallo
 * de quien avisa, y el motivo va a stderr. Código 1 si los argumentos no son
 * válidos o algún canal falla (cuáles, en stderr).
 */
import { z } from 'zod';
import { initDb } from '../db';
import { channelsConfigured, dispatchToChannelsDetailed } from '../notify';
import { AlertSeverity } from '../types';
import { ENTRADA_SALIDA_PROCESO, EntradaSalida, ErrorHerramienta, leerOpciones, mensajeDeError } from './argumentos';

const USO = 'Uso: aviso --nivel <info|error> --mensaje <texto> [--titulo <texto>]';

/** Un error se envía como alerta crítica: es lo que el operador tiene que mirar. */
const GRAVEDAD: Record<'info' | 'error', AlertSeverity> = { info: 'info', error: 'critical' };

const TITULO_POR_DEFECTO = 'Aviso del servidor';

/** Discord admite 1900 caracteres por mensaje (`notify.ts`): con el título y el prefijo, 1500 caben siempre. */
export const MAX_MENSAJE = 1500;
const MAX_TITULO = 100;

/**
 * Caracteres de control salvo el tabulador y el salto de línea: en un aviso no
 * aportan nada y un retorno de carro o una secuencia de escape pueden
 * desordenar lo que se ve en el canal.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

const texto = (que: string, max: number) =>
  z
    .string()
    .transform((s) => s.replace(CONTROL, ' ').trim())
    .pipe(z.string().min(1, `${que} no puede estar vacío.`).max(max, `${que} admite como máximo ${max} caracteres.`));

const avisoSchema = z.object({
  nivel: z.enum(['info', 'error'], { errorMap: () => ({ message: 'Indica el nivel con --nivel: «info» o «error».' }) }),
  mensaje: z.string({ required_error: 'Indica el texto del aviso con --mensaje.' }).pipe(texto('El mensaje (--mensaje)', MAX_MENSAJE)),
  titulo: texto('El título (--titulo)', MAX_TITULO).optional(),
});

/** Ejecuta la herramienta y devuelve el código de salida. La base de datos ya debe estar abierta. */
export async function ejecutarAviso(argv: readonly string[], io: EntradaSalida): Promise<number> {
  try {
    if (argv.length === 0) throw new ErrorHerramienta(USO);
    const opts = avisoSchema.parse(leerOpciones(argv, ['nivel', 'mensaje', 'titulo']));
    const channels = channelsConfigured();
    if (channels.length === 0) {
      io.err('No hay ningún canal de notificación configurado (Ajustes → Alertas): no se ha enviado el aviso.');
      io.out(JSON.stringify({ ok: true, channels, failures: [] }));
      return 0;
    }
    const failures = await dispatchToChannelsDetailed({
      severity: GRAVEDAD[opts.nivel],
      title: opts.titulo ?? TITULO_POR_DEFECTO,
      message: opts.mensaje,
    });
    io.out(JSON.stringify({ ok: failures.length === 0, channels, failures }));
    for (const f of failures) io.err(`No se ha podido enviar el aviso por ${f.channel}: ${f.error}`);
    return failures.length === 0 ? 0 : 1;
  } catch (err) {
    io.err(mensajeDeError(err));
    return 1;
  }
}

if (require.main === module) {
  initDb();
  void ejecutarAviso(process.argv.slice(2), ENTRADA_SALIDA_PROCESO).then((code) => process.exit(code));
}
