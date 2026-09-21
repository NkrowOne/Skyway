import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  hashPasswordAsync,
  lineSplitter,
  randomAlnum,
  safeParse,
  slugify,
  verifyPassword,
  verifyPasswordAsync,
} from '../src/util';

describe('safeParse', () => {
  it('devuelve el valor por defecto con JSON ilegible, vacío o nulo', () => {
    expect(safeParse('{no es json', { a: 1 })).toEqual({ a: 1 });
    expect(safeParse('', [1])).toEqual([1]);
    expect(safeParse(null, 'x')).toBe('x');
    expect(safeParse(undefined, 7)).toBe(7);
  });

  it('exige que la forma coincida con la del valor por defecto', () => {
    // Una lista donde se esperaba un objeto es tan inservible como basura.
    expect(safeParse('[1,2]', { a: 1 })).toEqual({ a: 1 });
    expect(safeParse('{"a":2}', [] as number[])).toEqual([]);
    expect(safeParse('"cadena"', { a: 1 })).toEqual({ a: 1 });
    expect(safeParse('{"b":3}', { a: 1 })).toEqual({ b: 3 });
    expect(safeParse('[3]', [1])).toEqual([3]);
  });
});

describe('lineSplitter', () => {
  it('entrega líneas completas y guarda el resto hasta el flush', () => {
    const lines: string[] = [];
    const feed = lineSplitter((l) => lines.push(l));
    feed('hola\nmun');
    expect(lines).toEqual(['hola']);
    feed('do\r\n');
    expect(lines).toEqual(['hola', 'mundo']);
    feed('final sin salto');
    expect(lines).toEqual(['hola', 'mundo']);
    feed.flush();
    expect(lines).toEqual(['hola', 'mundo', 'final sin salto']);
  });

  it('no rompe un carácter UTF-8 partido entre dos trozos', () => {
    const lines: string[] = [];
    const feed = lineSplitter((l) => lines.push(l));
    const bytes = Buffer.from('año € 😀\n', 'utf8');
    // Se corta dentro de la «ñ» (2 bytes), del «€» (3) y del emoji (4).
    feed(bytes.subarray(0, 2));
    feed(bytes.subarray(2, 6));
    feed(bytes.subarray(6, 10));
    feed(bytes.subarray(10));
    expect(lines).toEqual(['año € 😀']);
  });

  it('suelta un trozo enorme sin salto de línea para no acumular sin tope', () => {
    const lines: string[] = [];
    const feed = lineSplitter((l) => lines.push(l));
    feed('x'.repeat(9000));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(9000);
  });
});

describe('contraseñas', () => {
  it('el hash síncrono y el asíncrono comparten formato y se verifican entre sí', async () => {
    const sync = hashPassword('contraseña-1');
    const async = await hashPasswordAsync('contraseña-1');
    expect(sync.startsWith('s2:')).toBe(true);
    expect(async.startsWith('s2:')).toBe(true);
    expect(verifyPassword('contraseña-1', async)).toBe(true);
    expect(await verifyPasswordAsync('contraseña-1', sync)).toBe(true);
    expect(await verifyPasswordAsync('otra', sync)).toBe(false);
    expect(verifyPassword('contraseña-1', 'basura')).toBe(false);
  });
});

describe('slugify y randomAlnum', () => {
  it('slugify quita acentos, símbolos y recorta a 32', () => {
    expect(slugify('Mi App Ñoña!')).toBe('mi-app-nona');
    expect(slugify('---')).toBe('svc');
    expect(slugify('a'.repeat(50))).toHaveLength(32);
  });

  it('randomAlnum devuelve la longitud exacta y solo alfanuméricos', () => {
    const s = randomAlnum(40);
    expect(s).toHaveLength(40);
    expect(s).toMatch(/^[A-Za-z0-9]+$/);
  });
});
