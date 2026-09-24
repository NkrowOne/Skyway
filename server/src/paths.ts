import path from 'path';

/**
 * ¿`target` es `root` o está dentro de él?
 *
 * Comparar rutas con `startsWith` no vale: `/x/dep_a` es prefijo de
 * `/x/dep_ab`, que es otro directorio; y un `..` en la ruta relativa se sale
 * del directorio sin que la cadena lo delate. Se resuelven las dos y se mira la
 * ruta relativa entre ellas. Es una comprobación léxica: no sigue enlaces
 * simbólicos.
 */
export function insideDir(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
