import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizePath, parseLsOutput, scanTarEntry } from '../src/files';

/** Cabecera ustar mínima de 512 bytes. */
function header(name: string, size: number, typeflag: string): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 8, 'ascii');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  h.write(typeflag, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  return h;
}
const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);

describe('scanTarEntry', () => {
  it('devuelve la primera entrada normal con su tamaño y el inicio de los datos', () => {
    const content = Buffer.from('hola mundo');
    const tar = Buffer.concat([header('a.txt', content.length, '0'), content, pad(content.length), Buffer.alloc(1024)]);
    expect(scanTarEntry(tar)).toEqual({ status: 'entry', name: 'a.txt', typeflag: '0', size: 10, dataStart: 512 });
  });

  it('con una cabecera incompleta pide más datos', () => {
    expect(scanTarEntry(Buffer.alloc(100))).toEqual({ status: 'need_more' });
  });

  it('dos bloques a cero marcan el fin del archivo', () => {
    expect(scanTarEntry(Buffer.alloc(1024))).toEqual({ status: 'end' });
  });

  it('aplica el path de una cabecera PAX (x) a la entrada que sigue', () => {
    const longName = 'x'.repeat(150) + '.bin';
    const record = ` path=${longName}\n`;
    const paxBody = Buffer.from(`${record.length + String(record.length + 2).length} path=${longName}\n`);
    const content = Buffer.from('datos');
    const tar = Buffer.concat([
      header('PaxHeaders/x', paxBody.length, 'x'),
      paxBody,
      pad(paxBody.length),
      header(longName.slice(0, 100), content.length, '0'),
      content,
      pad(content.length),
    ]);
    // Con solo la cabecera PAX (o su cuerpo) no basta: la entrada real viene después.
    expect(scanTarEntry(tar.subarray(0, 512))).toEqual({ status: 'need_more' });
    expect(scanTarEntry(tar.subarray(0, 1024))).toEqual({ status: 'need_more' });
    const r = scanTarEntry(tar);
    expect(r.status).toBe('entry');
    if (r.status === 'entry') {
      expect(r.name).toBe(longName);
      expect(r.size).toBe(5);
      expect(r.dataStart).toBe(512 + 512 + 512);
      expect(tar.subarray(r.dataStart, r.dataStart + r.size).toString()).toBe('datos');
    }
  });

  describe('con un tar real de GNU tar', () => {
    const longName = 'nombre-muy-largo-'.repeat(8) + 'ñandú.txt';
    let dir = '';
    let tarPath = '';

    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-tar-'));
      fs.writeFileSync(path.join(dir, longName), 'contenido con ñ');
      tarPath = path.join(dir, 'out.tar');
    });

    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('resuelve un nombre largo con acentos en formato GNU (cabecera L)', () => {
      execFileSync('tar', ['-cf', tarPath, '-C', dir, longName]);
      const r = scanTarEntry(fs.readFileSync(tarPath));
      expect(r.status).toBe('entry');
      if (r.status === 'entry') {
        expect(r.name).toBe(longName);
        expect(r.size).toBe(Buffer.byteLength('contenido con ñ'));
      }
    });

    it('resuelve el mismo nombre en formato POSIX/PAX', () => {
      execFileSync('tar', ['--format=posix', '-cf', tarPath, '-C', dir, longName]);
      const r = scanTarEntry(fs.readFileSync(tarPath));
      expect(r.status).toBe('entry');
      if (r.status === 'entry') expect(r.name).toBe(longName);
    });
  });

  it('un directorio y un enlace se distinguen por su typeflag', () => {
    expect(scanTarEntry(Buffer.concat([header('d/', 0, '5'), Buffer.alloc(1024)]))).toMatchObject({ status: 'entry', typeflag: '5' });
    expect(scanTarEntry(Buffer.concat([header('l', 0, '2'), Buffer.alloc(1024)]))).toMatchObject({ status: 'entry', typeflag: '2' });
  });
});

describe('utilidades del explorador', () => {
  it('normalizePath resuelve . y ..', () => {
    expect(normalizePath('/a/../b/./c')).toBe('/b/c');
  });

  it('parseLsOutput ignora la línea «total» y cuenta las entradas', () => {
    const salida = 'total 4\ndrwxr-xr-x 2 root root 4096 Jan 1 00:00 dir\n-rw-r--r-- 1 root root 12 Jan 1 00:00 f.txt\n';
    expect(parseLsOutput(salida)).toHaveLength(2);
  });
});
