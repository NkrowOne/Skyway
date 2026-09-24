import path from 'path';
import { describe, expect, it } from 'vitest';
import { insideDir } from '../src/paths';

describe('insideDir', () => {
  const root = path.resolve('/x/dep_a');

  it('acepta el propio directorio y sus descendientes', () => {
    expect(insideDir(root, root)).toBe(true);
    expect(insideDir(root, path.join(root, 'apps', 'api'))).toBe(true);
    // Un `..` que no llega a salirse sigue dentro.
    expect(insideDir(root, path.join(root, 'apps', '..', 'Dockerfile'))).toBe(true);
  });

  it('rechaza un hermano que comparte prefijo (donde startsWith fallaba)', () => {
    expect(insideDir(root, path.resolve('/x/dep_ab'))).toBe(false);
    expect(insideDir(root, path.resolve('/x/dep_ab/apps'))).toBe(false);
  });

  it('rechaza las salidas con .. y las rutas absolutas ajenas', () => {
    expect(insideDir(root, path.join(root, '..'))).toBe(false);
    expect(insideDir(root, path.join(root, '..', '..', 'etc', 'passwd'))).toBe(false);
    expect(insideDir(root, path.join(root, 'apps', '..', '..', 'otro'))).toBe(false);
    expect(insideDir(root, path.resolve('/etc/passwd'))).toBe(false);
  });
});
