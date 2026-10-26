/**
 * Tope de elementos del cuerpo de una petición.
 *
 * zod 3 está congelado (zod 4 es una versión mayor que no se adopta) y tiene
 * el aviso GHSA-mrhx-c7xc-m3w5: `z.array()` valida todos los elementos aunque
 * la lista pase de `.max()`, y crea un issue por cada uno que no vale
 * (`z.record()` hace lo mismo con cada clave). Un JSON de 1 MB con medio
 * millón de ceros en un campo de lista costaba unos 200 MB de memoria y más de
 * medio segundo de CPU por petición, y no todos los esquemas llevan `.max()`.
 * Contar los elementos antes de que corra ningún esquema corta el ataque en
 * un solo sitio, sin depender de que cada esquema esté bien acotado.
 *
 * Sin dependencias a propósito: `app.ts` lo usa en un hook global y las
 * pruebas lo llaman directamente.
 */

/**
 * Máximo de elementos de un cuerpo: elementos de lista más claves de objeto,
 * sumados en todo el cuerpo. Ninguna petición legítima se acerca. La mayor
 * que valida zod es la de preparar un cambio de dominio (200 nombres con sus
 * 4 campos y 500 variables excluidas con 3, unos 3000 elementos); la de las
 * variables de entorno cuenta uno por variable, y un `.env` real tiene
 * decenas o cientos.
 */
export const TOPE_ELEMENTOS_CUERPO = 20_000;

type Contenedor = unknown[] | Record<string, unknown>;

/**
 * Solo se recorren listas y objetos planos, que es lo que produce
 * `JSON.parse`. Un Buffer (la subida de archivos lo recibe así), un texto o
 * cualquier otra cosa no se recorre: iterar un Buffer contaría sus bytes.
 */
function esContenedor(valor: unknown): valor is Contenedor {
  if (Array.isArray(valor)) return true;
  if (typeof valor !== 'object' || valor === null) return false;
  const proto = Object.getPrototypeOf(valor);
  return proto === Object.prototype || proto === null;
}

/**
 * ¿Tiene el cuerpo más elementos que el tope? Recorre con una pila explícita y
 * no con recursión: un JSON con cien mil listas anidadas desbordaría la pila
 * de llamadas. Sale en cuanto la cuenta pasa del tope, así que el coste está
 * acotado por el tope y no por el tamaño del cuerpo.
 */
export function superaTopeElementos(cuerpo: unknown, tope: number = TOPE_ELEMENTOS_CUERPO): boolean {
  if (!esContenedor(cuerpo)) return false;
  const pendientes: Contenedor[] = [cuerpo];
  let cuenta = 0;
  while (pendientes.length > 0) {
    const actual = pendientes.pop() as Contenedor;
    const hijos: unknown[] = Array.isArray(actual) ? actual : Object.values(actual);
    // Se suma la lista entera antes de mirar dentro: una lista de medio millón
    // de elementos se rechaza sin recorrerla.
    cuenta += hijos.length;
    if (cuenta > tope) return true;
    for (const hijo of hijos) {
      if (esContenedor(hijo)) pendientes.push(hijo);
    }
  }
  return false;
}
