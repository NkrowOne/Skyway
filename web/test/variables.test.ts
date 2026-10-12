import { describe, expect, it } from 'vitest';
import { parseEnvText, upperKey } from '../src/components/tabs/VariablesTab';

describe('upperKey', () => {
  it('pasa a mayúsculas los nombres nuevos', () => {
    expect(upperKey('database_url', new Set())).toBe('DATABASE_URL');
    expect(upperKey('next.public-api', new Set())).toBe('NEXT.PUBLIC-API');
    expect(upperKey('PORT', new Set())).toBe('PORT');
  });

  it('respeta los nombres que ya existen con minúsculas', () => {
    const keepCase = new Set(['http_proxy']);
    expect(upperKey('http_proxy', keepCase)).toBe('http_proxy');
    expect(upperKey('no_proxy', keepCase)).toBe('NO_PROXY');
  });

  it('en un .env pegado solo cambia lo anterior al primer «=»: los valores no se tocan', () => {
    const keepCase = new Set(['legacy_key']);
    const vars = parseEnvText('api_key=abc_Def\nlegacy_key=x=y\nexport token="Hola Mundo"').map((v) => ({
      key: upperKey(v.key, keepCase),
      value: v.value,
    }));
    expect(vars).toEqual([
      { key: 'API_KEY', value: 'abc_Def' },
      { key: 'legacy_key', value: 'x=y' },
      { key: 'TOKEN', value: 'Hola Mundo' },
    ]);
  });
});
