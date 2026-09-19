/**
 * Preparación común de cada fichero de pruebas (ver `setupFiles` en
 * vitest.config.ts): una carpeta de datos temporal propia, sin logs y con un
 * secreto de sesión fijo. Va ANTES de importar nada de `src`: `config.ts` lee
 * las variables de entorno en el momento de importarse.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-test-'));
process.env.DATA_DIR = dir;
process.env.LOG_LEVEL = 'silent';
process.env.JWT_SECRET = 'secreto-de-pruebas-0123456789abcdef';
// Las pruebas no tienen Docker: que nadie espere a un socket que no existe.
process.env.DOCKER_SOCK = path.join(dir, 'docker.sock');

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
