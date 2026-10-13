/**
 * Copias externas (`scripts/copias/copias.sh`): que nada nuevo con estado se
 * quede fuera sin que nadie se entere.
 *
 * Los volúmenes de los servicios los da el inventario (`serviceVolumeNames`,
 * probado en copias-herramienta.test.ts). Los del propio `docker-compose.yml`
 * de Skyway (los datos del panel y los certificados de Traefik) los localiza
 * copias.sh por el contenedor que los monta: si alguien añade un volumen al
 * compose, esta prueba falla hasta que copias.sh sepa copiarlo. Además, las
 * órdenes que no necesitan Docker funcionan sin él y los scripts tienen la
 * sintaxis correcta (la prueba completa, con Docker, es scripts/copias/prueba-real.sh).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const RAIZ = path.resolve(__dirname, '../..');
const COPIAS = path.join(RAIZ, 'scripts/copias/copias.sh');
const RESTAURAR = path.join(RAIZ, 'scripts/copias/restaurar.sh');

/**
 * Cómo copia copias.sh cada volumen del compose: el texto que debe aparecer en
 * el script (el contenedor y la ruta por los que lo localiza, y el nombre que
 * le da Compose si el contenedor no existe).
 */
const CUBIERTOS: Record<string, string[]> = {
  'skyway-data': ['montaje_de skyway /data', '_skyway-data'],
  'traefik-letsencrypt': ['montaje_de skyway-traefik /letsencrypt', '_traefik-letsencrypt'],
};

/** Claves de primer nivel de «volumes:» en el compose (sin dependencias de YAML). */
function volumenesDelCompose(texto: string): string[] {
  const lineas = texto.split('\n');
  const inicio = lineas.findIndex((l) => /^volumes:\s*$/.test(l));
  if (inicio < 0) return [];
  const claves: string[] = [];
  for (const linea of lineas.slice(inicio + 1)) {
    if (/^\S/.test(linea)) break; // otra clave de primer nivel
    const m = /^ {2}([A-Za-z0-9_.-]+):/.exec(linea);
    if (m) claves.push(m[1]);
  }
  return claves;
}

describe('copias externas: cobertura del docker-compose.yml', () => {
  it('cada volumen del compose tiene su regla en copias.sh', () => {
    const compose = fs.readFileSync(path.join(RAIZ, 'docker-compose.yml'), 'utf8');
    const script = fs.readFileSync(COPIAS, 'utf8');
    const volumenes = volumenesDelCompose(compose);
    expect(volumenes.length).toBeGreaterThan(0);
    for (const v of volumenes) {
      const reglas = CUBIERTOS[v];
      expect(
        reglas,
        `El volumen «${v}» del docker-compose.yml no tiene regla en las copias externas. Declara en scripts/copias/copias.sh ` +
          '(localizar_skyway y plan_copia) cómo se localiza y con qué consistencia se copia, y añádelo a CUBIERTOS en esta prueba.',
      ).toBeDefined();
      for (const texto of reglas ?? []) expect(script, `copias.sh debe localizar «${v}» con «${texto}»`).toContain(texto);
    }
  });

  it('los scripts de las copias tienen la sintaxis correcta', () => {
    for (const f of [COPIAS, RESTAURAR, path.join(RAIZ, 'scripts/copias/kit/descodificar.sh'), path.join(RAIZ, 'scripts/copias/prueba-real.sh')]) {
      const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
      expect(r.status, `${path.basename(f)}: ${r.stderr}`).toBe(0);
    }
  });

  it('sin configurar, «configuradas» sale con 1 y la ayuda funciona sin Docker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copias-cobertura-'));
    try {
      const env = { ...process.env, COPIAS_CONFIG_DIR: dir, COPIAS_ESTADO_DIR: dir, NO_COLOR: '1' };
      expect(spawnSync('bash', [COPIAS, 'configuradas'], { env }).status).toBe(1);
      const ayuda = spawnSync('bash', [COPIAS, 'ayuda'], { env, encoding: 'utf8' });
      expect(ayuda.status).toBe(0);
      expect(ayuda.stderr).toContain('restaurar');
      const mal = spawnSync('bash', [COPIAS, 'borrarlo-todo'], { env, encoding: 'utf8' });
      expect(mal.status).toBe(1);
      expect(mal.stderr).toContain('Orden desconocida');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('el kit lleva las plantillas que copia «kit»', () => {
    for (const f of ['LEEME.txt', 'descodificar.sh', 'descodificar.ps1', 'descodificar.bat']) {
      expect(fs.existsSync(path.join(RAIZ, 'scripts/copias/kit', f)), f).toBe(true);
    }
    const leeme = fs.readFileSync(path.join(RAIZ, 'scripts/copias/kit/LEEME.txt'), 'utf8');
    for (const marcador of ['{{FECHA}}', '{{EJECUCION}}', '{{CONTENIDO}}']) expect(leeme).toContain(marcador);
  });
});
