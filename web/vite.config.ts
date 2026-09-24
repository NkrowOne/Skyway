import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Prefijos de ruta del framework y de sus dependencias internas (scheduler, el
// router de Remix, el núcleo de react-query): con la función de reparto hay que
// nombrarlas también, o quedarían en chunks sueltos fuera de «vendor».
const VENDOR = [
  'node_modules/react/',
  'node_modules/react-dom/',
  'node_modules/scheduler/',
  'node_modules/react-router',
  'node_modules/@remix-run/',
  'node_modules/@tanstack/',
];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        /*
         * El framework (poco cambiante) va en un chunk aparte para cachearse entre
         * despliegues; cada página tiene su propio chunk por la carga diferida.
         * Los iconos de lucide van todos juntos en «icons»: dejados al reparto
         * automático, cada icono compartido por dos o más páginas diferidas
         * acababa en un micro-chunk de unos cientos de bytes (una petición por
         * icono), y el panel se usa a menudo por un túnel SSH en HTTP/1.1, donde
         * cada petición cuesta más que los bytes que trae.
         */
        manualChunks(id) {
          if (id.includes('node_modules/lucide-react/')) return 'icons';
          if (VENDOR.some((prefix) => id.includes(prefix))) return 'vendor';
          return undefined;
        },
      },
    },
  },
});
