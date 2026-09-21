import { describe, expect, it } from 'vitest';
import { cx, fmtBytes, fmtCores, fmtDuration, fmtMb, fmtMoney, parseRepoInput, stripAnsi, timeAgo } from '../src/utils';
import { parseEnvText } from '../src/components/tabs/VariablesTab';

describe('parseRepoInput', () => {
  it('acepta el atajo owner/repo y la URL de GitHub en sus variantes', () => {
    expect(parseRepoInput('GadGhast/LEWSPAIN')).toBe('GadGhast/LEWSPAIN');
    expect(parseRepoInput('https://github.com/GadGhast/LEWSPAIN/')).toBe('GadGhast/LEWSPAIN');
    expect(parseRepoInput('https://github.com/GadGhast/LEWSPAIN.git')).toBe('GadGhast/LEWSPAIN');
    expect(parseRepoInput('  github.com/a/b/tree/main  ')).toBe('a/b');
    expect(parseRepoInput('http://www.GitHub.com/a/b')).toBe('a/b');
  });

  it('rechaza lo que no es un repositorio', () => {
    expect(parseRepoInput('')).toBeNull();
    expect(parseRepoInput('solo-un-nombre')).toBeNull();
    expect(parseRepoInput('https://gitlab.com/a/b')).toBeNull();
    expect(parseRepoInput('a/b/c')).toBeNull();
  });
});

describe('parseEnvText', () => {
  it('lee un .env con comentarios, export y comillas', () => {
    const text = ['# comentario', 'export API_URL="https://x"', "SECRET='abc def'", 'EMPTY=', '', 'sin igual'].join('\n');
    expect(parseEnvText(text)).toEqual([
      { key: 'API_URL', value: 'https://x' },
      { key: 'SECRET', value: 'abc def' },
      { key: 'EMPTY', value: '' },
    ]);
  });

  it('parte varias variables en una línea sin partir un valor con espacios', () => {
    expect(parseEnvText('A=1 B=2 MSG=hola mundo')).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: '2' },
      { key: 'MSG', value: 'hola mundo' },
    ]);
  });

  it('descarta claves inválidas', () => {
    expect(parseEnvText('1abc=x\n-k=v\nOK_1=y')).toEqual([{ key: 'OK_1', value: 'y' }]);
  });
});

describe('formateadores', () => {
  it('fmtBytes acota a [0, TB] y no pinta «undefined» con valores menores que 1', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(0.4)).toBe('0.4 B');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(1023)).toBe('1023 B');
    expect(fmtBytes(2 ** 50 * 3)).toBe('3072 TB');
    expect(fmtMb(1024)).toBe('1.0 GB');
  });

  it('fmtDuration y fmtCores', () => {
    expect(fmtDuration(4500)).toBe('5s');
    expect(fmtDuration(125_000)).toBe('2m 5s');
    expect(fmtCores(100)).toBe('1.0 núcleo');
    expect(fmtCores(250)).toBe('2.5 núcleos');
    expect(fmtCores(25)).toBe('0.25 núcleos');
    expect(fmtCores(1250)).toBe('13 núcleos');
  });

  it('fmtMoney usa el formato español y no revienta con una divisa desconocida', () => {
    expect(fmtMoney(1234).replace(/ /g, ' ')).toMatch(/^12,34 €$/);
    expect(fmtMoney(1234, 'XXX')).toMatch(/12[,.]34/);
  });

  it('timeAgo en español', () => {
    const now = Date.now();
    expect(timeAgo(now - 5_000)).toBe('hace unos segundos');
    expect(timeAgo(now - 90_000)).toBe('hace 1 min');
    expect(timeAgo(now - 3 * 3_600_000)).toBe('hace 3 h');
    expect(timeAgo(now - 49 * 3_600_000)).toBe('hace 2 d');
  });

  it('stripAnsi y cx', () => {
    expect(stripAnsi('\u001b[32mok\u001b[0m listo')).toBe('ok listo');
    expect(cx('a', false, null, undefined, 'b')).toBe('a b');
  });
});
