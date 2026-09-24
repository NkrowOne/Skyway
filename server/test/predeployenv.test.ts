import { describe, expect, it } from 'vitest';
import { PRE_DEPLOY_RESERVED_NAME, partitionPreDeployEnv } from '../src/deploy/predeployenv';

describe('partitionPreDeployEnv', () => {
  it('aparta los nombres que gobiernan al propio CLI de Docker', () => {
    const { inherited, explicit } = partitionPreDeployEnv({
      PATH: '/tmp/falso',
      LD_PRELOAD: '/tmp/x.so',
      DOCKER_HOST: 'tcp://1.2.3.4:2375',
      GIT_SSH_COMMAND: 'sh -c id',
      https_proxy: 'http://proxy',
      NODE_ENV: 'production',
    });
    expect(Object.keys(explicit).sort()).toEqual(['DOCKER_HOST', 'GIT_SSH_COMMAND', 'LD_PRELOAD', 'NODE_ENV', 'PATH', 'https_proxy']);
    // El valor viaja intacto: el contenedor debe recibirlo igual que antes.
    expect(explicit.PATH).toBe('/tmp/falso');
    expect(inherited).toEqual({});
  });

  it('deja pasar las variables normales, incluso las que contienen un nombre reservado', () => {
    const { inherited, explicit } = partitionPreDeployEnv({
      DATABASE_URL: 'postgres://db/app',
      PORT: '3000',
      MY_PATH: '/data',
      PATHFINDER: '1',
    });
    expect(explicit).toEqual({});
    expect(inherited).toEqual({ DATABASE_URL: 'postgres://db/app', PORT: '3000', MY_PATH: '/data', PATHFINDER: '1' });
  });

  it('con un mapa vacío devuelve dos mapas vacíos', () => {
    expect(partitionPreDeployEnv({})).toEqual({ inherited: {}, explicit: {} });
  });

  it('la comparación distingue mayúsculas y exige el nombre completo', () => {
    expect(PRE_DEPLOY_RESERVED_NAME.test('path')).toBe(false);
    expect(PRE_DEPLOY_RESERVED_NAME.test('HTTP_PROXY')).toBe(true);
    expect(PRE_DEPLOY_RESERVED_NAME.test('Http_Proxy')).toBe(false);
    expect(PRE_DEPLOY_RESERVED_NAME.test('LD_')).toBe(true);
    expect(PRE_DEPLOY_RESERVED_NAME.test('XLD_PRELOAD')).toBe(false);
    expect(PRE_DEPLOY_RESERVED_NAME.test('SSL_CERT_FILE')).toBe(true);
  });
});
