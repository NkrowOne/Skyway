/**
 * Lo común de las herramientas de terminal del servidor (`token.ts`,
 * `mailway.ts`): opciones `--nombre valor`, salida y código de salida. Las
 * herramientas exportan una función que recibe los argumentos y la E/S, y
 * solo cuando se ejecutan como programa tocan `process`: así las pruebas las
 * llaman sin lanzar procesos.
 */
import { ZodError } from 'zod';
import { MailwayError } from '../mailway';

export interface EntradaSalida {
  /** Una línea para stdout (el resultado, en JSON). */
  out: (linea: string) => void;
  /** Una línea para stderr (errores y avisos). */
  err: (linea: string) => void;
}

/** Error de uso o de validación: se explica en stderr y la herramienta sale con código 1. */
export class ErrorHerramienta extends Error {}

/**
 * Opciones `--clave valor`. Rechaza argumentos sueltos, opciones desconocidas
 * o repetidas y opciones sin valor. Los mensajes no repiten los valores: si
 * alguien pega un secreto donde no toca, no acaba en el terminal ni en un
 * registro.
 */
export function leerOpciones(argv: readonly string[], permitidas: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new ErrorHerramienta('Argumento no reconocido: las opciones se escriben como «--opción valor».');
    const clave = arg.slice(2);
    if (!permitidas.includes(clave)) {
      throw new ErrorHerramienta(`Opción desconocida: --${/^[a-z-]{1,30}$/.test(clave) ? clave : '…'}.`);
    }
    if (clave in out) throw new ErrorHerramienta(`La opción --${clave} está repetida.`);
    const valor = argv[i + 1];
    if (valor === undefined || valor.startsWith('--')) throw new ErrorHerramienta(`Falta el valor de --${clave}.`);
    out[clave] = valor;
    i++;
  }
  return out;
}

/** Mensaje para stderr de cualquier fallo. */
export function mensajeDeError(err: unknown): string {
  if (err instanceof ZodError) return err.issues.map((i) => i.message).join('; ');
  if (err instanceof Error && err.message) return err.message;
  return 'Error inesperado.';
}

/** Igual que la ruta: los 403 de Mailway explican qué token hace falta. */
export function mensajeMailway(err: MailwayError): string {
  if (err.kind === 'http' && err.status === 403) {
    return `Mailway ha denegado la operación: ${err.message} Comprueba que el token de gestión es de administrador.`;
  }
  return err.message;
}

/** E/S real del proceso. */
export const ENTRADA_SALIDA_PROCESO: EntradaSalida = {
  out: (linea) => process.stdout.write(`${linea}\n`),
  err: (linea) => process.stderr.write(`${linea}\n`),
};
