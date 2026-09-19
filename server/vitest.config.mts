import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // Cada fichero de pruebas en su propio proceso: `config.ts` lee DATA_DIR una
    // sola vez al importarse y `db.ts` abre la base con esa ruta, así que la
    // única forma de que cada fichero tenga su base temporal es no compartir el
    // módulo entre ficheros.
    pool: 'forks',
    isolate: true,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
