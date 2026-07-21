/**
 * Canon de logos oficiales de módulos.
 *
 * Fuente única: el paquete `simple-icons` (CC0, marcas oficiales normalizadas
 * a un path de 24×24). Este script vuelca los SVG a src/assets/icons/ para
 * servirlos como assets locales (sin CDN en runtime) e imprime el color
 * oficial de cada marca, que es la referencia para afinar los tintes de
 * ModuleIcon.tsx (CHIP) sobre fondo oscuro.
 *
 *   npm run logos -w web        # tras añadir o actualizar una marca
 *
 * Para añadir un módulo: entrada aquí + import y colores en ModuleIcon.tsx
 * + detección en moduleKind().
 */
import { writeFileSync } from 'node:fs';
import * as si from 'simple-icons';

const LOGOS = {
  github: 'siGithub',
  postgresql: 'siPostgresql',
  redis: 'siRedis',
  mysql: 'siMysql',
  mongodb: 'siMongodb',
  wordpress: 'siWordpress',
  n8n: 'siN8n',
  docker: 'siDocker',
  minio: 'siMinio',
  mariadb: 'siMariadb',
  plausible: 'siPlausibleanalytics',
  uptimekuma: 'siUptimekuma',
  ghost: 'siGhost',
  grafana: 'siGrafana',
  nginx: 'siNginx',
  traefik: 'siTraefikproxy',
};

const dir = new URL('../src/assets/icons/', import.meta.url);
let failed = false;
for (const [slug, key] of Object.entries(LOGOS)) {
  const icon = si[key];
  if (!icon) {
    console.error(`✗ ${slug}: ${key} no existe en simple-icons`);
    failed = true;
    continue;
  }
  writeFileSync(new URL(`${slug}.svg`, dir), `${icon.svg}\n`);
  console.log(`✓ ${slug}.svg — ${icon.title} · color oficial #${icon.hex}`);
}
process.exit(failed ? 1 : 0);
