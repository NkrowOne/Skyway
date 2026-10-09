/**
 * Copias de seguridad de las bases de datos: completas o nada.
 *
 * La copia se escribe en un temporal oculto y solo se renombra al nombre
 * definitivo cuando el volcado termina bien. Así un corte a mitad (el reinicio
 * del panel de la actualización automática nocturna, un apagado) nunca deja
 * una copia truncada que se liste, se descargue o se restaure como buena, y el
 * temporal que queda lo retira la copia siguiente.
 *
 * Docker se sustituye por un contenedor de mentira cuyo volcado se controla
 * desde cada prueba.
 */
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const volcado = vi.hoisted(() => ({
  /** Trozos que escribe el volcado; null = el flujo se corta con un error. */
  trozos: [] as (string | null)[],
  codigo: 0 as number | null,
  /** Se llama mientras el volcado sigue abierto, antes de que termine. */
  durante: null as null | (() => void),
}));

vi.mock('../src/docker/client', () => ({
  docker: {
    getContainer: () => ({
      exec: async () => ({
        start: async () => {
          const flujo = new PassThrough();
          setImmediate(() => {
            for (const trozo of volcado.trozos) {
              if (trozo === null) {
                flujo.destroy(new Error('conexión con Docker cortada'));
                return;
              }
              flujo.write(trozo);
            }
            volcado.durante?.();
            flujo.end();
          });
          return flujo;
        },
      }),
    }),
    // El flujo de mentira ya es la salida estándar del volcado.
    modem: {
      demuxStream: (origen: PassThrough, salida: PassThrough) => {
        origen.on('data', (c) => salida.write(c));
      },
    },
  },
}));

vi.mock('../src/docker/containers', () => ({
  containerName: () => 'skyway-prueba-db',
  getRuntime: async () => ({ state: 'running' }),
  waitExecExit: async () => volcado.codigo,
}));

import { config } from '../src/config';
import { createBackup, listBackups, listServiceBackupDirs, resolveBackupFile } from '../src/backups';
import type { ProjectRow, ServiceRow } from '../src/types';

const SERVICIO_ID = 'svc_0123456789abcdef';
const proyecto = { id: 'prj_1', slug: 'tienda', name: 'Tienda' } as unknown as ProjectRow;
const servicio = {
  id: SERVICIO_ID,
  slug: 'db',
  name: 'Base de datos',
  type: 'database',
  config: { template: 'postgres', version: '16' },
} as unknown as ServiceRow;

function carpeta(): string {
  return path.join(config.dataDir, 'backups', SERVICIO_ID);
}

function ficheros(): string[] {
  try {
    return fs.readdirSync(carpeta()).sort();
  } catch {
    return [];
  }
}

afterEach(() => {
  fs.rmSync(carpeta(), { recursive: true, force: true });
  volcado.trozos = [];
  volcado.codigo = 0;
  volcado.durante = null;
});

describe('copias de seguridad de las bases de datos', () => {
  it('una copia que termina bien queda con su nombre y sin temporales', async () => {
    volcado.trozos = ['-- volcado de prueba\n'.repeat(20)];
    const copia = await createBackup(proyecto, servicio);
    expect(ficheros()).toEqual([copia.file]);
    expect(copia.file).toMatch(/^postgres-tienda-db-.+\.sql\.gz$/);
    expect(listBackups(SERVICIO_ID).map((b) => b.file)).toEqual([copia.file]);
    expect(resolveBackupFile(SERVICIO_ID, copia.file)).not.toBeNull();
  });

  it('mientras se escribe, la copia no aparece en ningún listado ni se puede descargar', async () => {
    volcado.trozos = ['-- volcado de prueba\n'.repeat(20)];
    let visto: { ficheros: string[]; listado: number; carpeta: number | undefined } | null = null;
    volcado.durante = () => {
      visto = {
        ficheros: ficheros(),
        listado: listBackups(SERVICIO_ID).length,
        carpeta: listServiceBackupDirs().find((d) => d.serviceId === SERVICIO_ID)?.files,
      };
    };
    await createBackup(proyecto, servicio);
    expect(visto).not.toBeNull();
    const enCurso = visto!;
    // Solo existe el temporal oculto…
    expect(enCurso.ficheros).toHaveLength(1);
    expect(enCurso.ficheros[0]).toMatch(/^\.postgres-tienda-db-.+\.sql\.gz\.parcial$/);
    // …y nadie lo trata como una copia.
    expect(enCurso.listado).toBe(0);
    expect(enCurso.carpeta).toBe(0);
    expect(resolveBackupFile(SERVICIO_ID, enCurso.ficheros[0]!)).toBeNull();
  });

  it('un volcado cortado a mitad no deja ni la copia ni el temporal', async () => {
    volcado.trozos = ['-- primera parte del volcado\n'.repeat(20), null];
    await expect(createBackup(proyecto, servicio)).rejects.toThrow(/cortada/);
    expect(ficheros()).toEqual([]);
  });

  it('un volcado que termina con error no deja nada', async () => {
    volcado.trozos = ['-- volcado incompleto\n'.repeat(20)];
    volcado.codigo = 1;
    await expect(createBackup(proyecto, servicio)).rejects.toThrow(/código 1/);
    expect(ficheros()).toEqual([]);
  });

  it('la copia siguiente retira los temporales antiguos de una copia cortada, no los recientes', async () => {
    fs.mkdirSync(carpeta(), { recursive: true });
    const antiguo = path.join(carpeta(), '.postgres-tienda-db-2026-01-01T04-00-00.sql.gz.parcial');
    const reciente = path.join(carpeta(), '.postgres-tienda-db-2026-01-02T04-00-00.sql.gz.parcial');
    fs.writeFileSync(antiguo, 'truncado');
    fs.writeFileSync(reciente, 'otra copia en curso');
    const haceUnaHora = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(antiguo, haceUnaHora, haceUnaHora);

    volcado.trozos = ['-- volcado de prueba\n'.repeat(20)];
    const copia = await createBackup(proyecto, servicio);
    expect(ficheros()).toEqual([path.basename(reciente), copia.file].sort());
  });
});
