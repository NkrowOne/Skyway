import { defineConfig } from 'vitest/config';

// Solo utilidades puras (sin DOM): lo que se puede comprobar sin navegador.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
