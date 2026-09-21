import { describe, expect, it } from 'vitest';
import { maskValue, matchesSearch, normalizeSearch, parseInline, parseRichText } from '../src/helpText';

describe('parseRichText', () => {
  it('separa párrafos, listas y negritas', () => {
    const blocks = parseRichText('He revisado **api**: falta una variable.\n\nEsto puede ayudarte:\n- Una\n- **Dos**');
    expect(blocks).toEqual([
      { kind: 'p', lines: [[{ text: 'He revisado ', bold: false }, { text: 'api', bold: true }, { text: ': falta una variable.', bold: false }]] },
      { kind: 'p', lines: [[{ text: 'Esto puede ayudarte:', bold: false }]] },
      { kind: 'ul', items: [[{ text: 'Una', bold: false }], [{ text: 'Dos', bold: true }]] },
    ]);
  });

  it('no interpreta HTML ni se rompe con asteriscos sueltos', () => {
    expect(parseInline('<b>x</b> * y **z')).toEqual([{ text: '<b>x</b> * y **z', bold: false }]);
    expect(parseRichText('')).toEqual([]);
  });
});

describe('normalizeSearch / matchesSearch', () => {
  it('ignora acentos y mayúsculas', () => {
    expect(normalizeSearch('  Cómo añado un DOMINIO ')).toBe('como anado un dominio');
    expect(matchesSearch('dominio tls', '¿Cómo añado un dominio?', ['https', 'certificado TLS'])).toBe(true);
    expect(matchesSearch('backup', '¿Cómo añado un dominio?', ['https'])).toBe(false);
    expect(matchesSearch('', 'lo que sea')).toBe(true);
  });
});

describe('maskValue', () => {
  it('insinúa la longitud sin revelar nada', () => {
    expect(maskValue('')).toBe('');
    expect(maskValue('ab')).toBe('••••');
    expect(maskValue('x'.repeat(40))).toHaveLength(14);
  });
});
