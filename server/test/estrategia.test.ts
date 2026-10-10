/**
 * Estrategia de despliegue («Una sola copia» / «Sin corte») y parada limpia.
 *
 *  - Un bot sin dominio ni puerto público se desplegaba siempre «sin corte»:
 *    durante el intercambio había dos copias a la vez y la segunda recibía un
 *    409 de Telegram (o procesaba dos veces el mismo trabajo). Ahora, sin
 *    dominio, healthcheck ni llamadas de otros servicios, Skyway elige «una sola
 *    copia».
 *  - La gracia de parada era un 10 fijo: ahora es la del servicio, la de
 *    RAILWAY_DEPLOYMENT_DRAINING_SECONDS o 30 s.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createProject, createService, initDb, setEnv, setProjectVars } from '../src/db';
import {
  COMANDO_PARADA_MAXIMO,
  comandoParada,
  describirEstrategia,
  estrategiaDespliegue,
  estrategiaEfectiva,
  GRACIA_PARADA_POR_DEFECTO,
  graciaParada,
  llamadoPorOtros,
  referenciaInterna,
} from '../src/deploy/estrategia';
import { searchFaq } from '../src/help/assistant';
import type { DatabaseConfig, GitConfig, ImageConfig, ServiceRow } from '../src/types';

beforeAll(() => {
  initDb();
});

afterAll(() => {
  closeDb();
});

/** Servicio en memoria (las reglas puras no leen la base). */
function app(config: Partial<GitConfig> = {}, extra: Partial<ServiceRow> = {}): ServiceRow {
  return {
    id: 'svc_x',
    project_id: 'prj_x',
    name: 'Bot',
    slug: 'bot',
    type: 'git',
    created_at: 0,
    config: {
      repoUrl: 'https://github.com/acme/bot',
      branch: 'main',
      port: 3000,
      domains: [],
      webhookSecret: 'x',
      ...config,
    } as GitConfig,
    ...extra,
  };
}

function imagen(config: Partial<ImageConfig> = {}): ServiceRow {
  return {
    id: 'svc_i',
    project_id: 'prj_x',
    name: 'Worker',
    slug: 'worker',
    type: 'image',
    created_at: 0,
    config: { image: 'busybox:stable', domains: [], ...config } as ImageConfig,
  };
}

function baseDeDatos(config: Partial<DatabaseConfig> = {}): ServiceRow {
  return {
    id: 'svc_d',
    project_id: 'prj_x',
    name: 'Postgres',
    slug: 'postgres',
    type: 'database',
    created_at: 0,
    config: { template: 'postgres', version: '16', ...config } as DatabaseConfig,
  };
}

describe('estrategiaDespliegue', () => {
  it('un bot sin dominio, healthcheck ni llamadas de otros: una sola copia, automática', () => {
    expect(estrategiaDespliegue(app(), false)).toEqual({ estrategia: 'recreate', motivo: 'sin_trafico', automatica: true });
    expect(estrategiaDespliegue(imagen(), false)).toEqual({ estrategia: 'recreate', motivo: 'sin_trafico', automatica: true });
  });

  it('con dominio, healthcheck o llamadas de otros: sin corte, automática', () => {
    const conTrafico = { estrategia: 'overlap', motivo: 'con_trafico', automatica: true };
    expect(estrategiaDespliegue(app({ domains: ['bot.acme.es'] }), false)).toEqual(conTrafico);
    expect(estrategiaDespliegue(app({ healthcheckPath: '/health' }), false)).toEqual(conTrafico);
    expect(estrategiaDespliegue(app(), true)).toEqual(conTrafico);
    expect(estrategiaDespliegue(imagen({ domains: ['w.acme.es'] }), false)).toEqual(conTrafico);
  });

  it('un healthcheck vacío o en blanco no cuenta como tráfico', () => {
    expect(estrategiaDespliegue(app({ healthcheckPath: '' }), false).estrategia).toBe('recreate');
    expect(estrategiaDespliegue(app({ healthcheckPath: '   ' }), false).estrategia).toBe('recreate');
    expect(estrategiaDespliegue(app({ healthcheckPath: null }), false).estrategia).toBe('recreate');
  });

  it('la estrategia elegida manda sobre la automática', () => {
    expect(estrategiaDespliegue(app({ deployStrategy: 'overlap' }), false)).toEqual({
      estrategia: 'overlap',
      motivo: 'elegida',
      automatica: false,
    });
    expect(estrategiaDespliegue(app({ domains: ['web.acme.es'], deployStrategy: 'recreate' }), true)).toEqual({
      estrategia: 'recreate',
      motivo: 'elegida',
      automatica: false,
    });
  });

  it('un valor desconocido en deployStrategy se trata como ausente', () => {
    const raro = app({ deployStrategy: 'blue-green' as never });
    expect(estrategiaDespliegue(raro, false)).toEqual({ estrategia: 'recreate', motivo: 'sin_trafico', automatica: true });
  });

  it('volúmenes o puerto público: siempre una sola copia, aunque se eligiera sin corte', () => {
    const estado = { estrategia: 'recreate', motivo: 'estado', automatica: false };
    expect(estrategiaDespliegue(app({ volumes: [{ name: 'datos', containerPath: '/data' }] }), true)).toEqual(estado);
    expect(estrategiaDespliegue(app({ hostPort: 2222, deployStrategy: 'overlap' }), true)).toEqual(estado);
    expect(
      estrategiaDespliegue(
        app({ volumes: [{ name: 'datos', containerPath: '/data' }], deployStrategy: 'overlap', domains: ['a.acme.es'] }),
        true,
      ),
    ).toEqual(estado);
    expect(estrategiaDespliegue(imagen({ hostPort: 8080 }), false)).toEqual(estado);
    // Una lista de volúmenes vacía o un puerto nulo no son estado.
    expect(estrategiaDespliegue(app({ volumes: [], hostPort: null }), false).motivo).toBe('sin_trafico');
  });

  it('una base de datos: siempre una sola copia, antes que cualquier otra regla', () => {
    expect(estrategiaDespliegue(baseDeDatos(), true)).toEqual({ estrategia: 'recreate', motivo: 'base_de_datos', automatica: false });
    expect(estrategiaDespliegue(baseDeDatos({ hostPort: 5432, domains: ['db.acme.es'] }), true).motivo).toBe('base_de_datos');
  });
});

describe('referenciaInterna', () => {
  const api = { name: 'API', slug: 'api' };

  it('cuenta las referencias internas por nombre o por slug', () => {
    expect(referenciaInterna(['${{api.INTERNAL_URL}}'], api)).toBe(true);
    expect(referenciaInterna(['http://${{ API.INTERNAL_HOST }}:8080'], api)).toBe(true);
    expect(referenciaInterna(['${{api.INTERNAL_PORT}}'], api)).toBe(true);
    expect(referenciaInterna(['${{api.RAILWAY_PRIVATE_DOMAIN}}'], api)).toBe(true);
    // Por nombre cuando el slug es otro.
    expect(referenciaInterna(['${{Mi API.INTERNAL_URL}}/v1'], { name: 'Mi API', slug: 'mi-api' })).toBe(true);
    expect(referenciaInterna(['${{mi-api.INTERNAL_URL}}/v1'], { name: 'Mi API', slug: 'mi-api' })).toBe(true);
  });

  it('cuenta la dirección interna escrita a mano', () => {
    expect(referenciaInterna(['http://api:3000'], api)).toBe(true);
    expect(referenciaInterna(['api:8080'], api)).toBe(true);
    expect(referenciaInterna(['postgres://u:p@api:5432/db'], api)).toBe(true);
    expect(referenciaInterna(['api.railway.internal'], api)).toBe(true);
    expect(referenciaInterna(['http://api.railway.internal:3000/v1'], api)).toBe(true);
  });

  it('no cuenta lo que solo se parece', () => {
    expect(referenciaInterna(['https://api.example.com'], api)).toBe(false);
    expect(referenciaInterna(['scope=api:read'], api)).toBe(false);
    expect(referenciaInterna(['${{api.PUBLIC_URL}}'], api)).toBe(false);
    expect(referenciaInterna(['${{api.PUBLIC_DOMAIN}}'], api)).toBe(false);
    expect(referenciaInterna(['${{otra.INTERNAL_URL}}'], api)).toBe(false);
    // Precedido de letra, cifra, punto o guion: es otro nombre.
    expect(referenciaInterna(['http://myapi:3000'], api)).toBe(false);
    expect(referenciaInterna(['http://old-api:3000'], api)).toBe(false);
    expect(referenciaInterna(['http://v2.api:3000'], api)).toBe(false);
    expect(referenciaInterna(['http://api-2:3000'], api)).toBe(false);
    // Puerto de una cifra o de seis: no es un puerto.
    expect(referenciaInterna(['api:3'], api)).toBe(false);
    expect(referenciaInterna(['api:300000'], api)).toBe(false);
    expect(referenciaInterna(['api.railway.internals'], api)).toBe(false);
    expect(referenciaInterna([], api)).toBe(false);
    expect(referenciaInterna([''], api)).toBe(false);
  });

  it('un slug con caracteres especiales de expresión regular no rompe la búsqueda', () => {
    expect(referenciaInterna(['http://a-b:3000'], { name: 'a-b', slug: 'a-b' })).toBe(true);
    expect(referenciaInterna(['http://axb:3000'], { name: 'a.b', slug: 'a.b' })).toBe(false);
  });
});

describe('llamadoPorOtros y estrategiaEfectiva (leen la base)', () => {
  it('cuenta las variables de los demás servicios y las compartidas, no las propias', () => {
    const p = createProject('Bots', 'bots');
    const cfgGit = (extra: Partial<GitConfig> = {}): GitConfig => ({
      repoUrl: 'https://github.com/acme/x',
      branch: 'main',
      port: 3000,
      domains: [],
      webhookSecret: 'x',
      ...extra,
    });
    const api = createService(p.id, 'api', 'api', 'git', cfgGit());
    const web = createService(p.id, 'web', 'web', 'git', cfgGit({ domains: ['web.acme.es'] }));
    const bot = createService(p.id, 'bot', 'bot', 'git', cfgGit());

    // Al principio nadie llama a nadie: los dos sin dominio van con una sola copia.
    expect(llamadoPorOtros(api)).toBe(false);
    expect(estrategiaEfectiva(api)).toEqual({ estrategia: 'recreate', motivo: 'sin_trafico', automatica: true });
    expect(estrategiaEfectiva(bot).estrategia).toBe('recreate');
    expect(estrategiaEfectiva(web)).toEqual({ estrategia: 'overlap', motivo: 'con_trafico', automatica: true });

    // Un servicio que se nombra a sí mismo no recibe tráfico por ello.
    setEnv(api.id, { SELF: '${{api.INTERNAL_URL}}' });
    expect(llamadoPorOtros(api)).toBe(false);

    // La web llama a la API: la API pasa a «sin corte»; el bot no cambia.
    setEnv(web.id, { API_URL: '${{api.INTERNAL_URL}}/v1' });
    expect(llamadoPorOtros(api)).toBe(true);
    expect(estrategiaEfectiva(api)).toEqual({ estrategia: 'overlap', motivo: 'con_trafico', automatica: true });
    expect(estrategiaEfectiva(bot).estrategia).toBe('recreate');

    // Una variable compartida del proyecto también cuenta.
    expect(llamadoPorOtros(bot)).toBe(false);
    setProjectVars(p.id, { BOT_URL: 'http://bot:8080' });
    expect(llamadoPorOtros(bot)).toBe(true);
    expect(estrategiaEfectiva(bot).motivo).toBe('con_trafico');
  });
});

describe('graciaParada', () => {
  it('la del servicio manda', () => {
    expect(graciaParada(app({ stopGraceSeconds: 20 }), { RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '45' })).toEqual({
      segundos: 20,
      origen: 'servicio',
    });
    expect(graciaParada(app({ stopGraceSeconds: 0 }), {})).toEqual({ segundos: 0, origen: 'servicio' });
    expect(graciaParada(app({ stopGraceSeconds: 600 }), {})).toEqual({ segundos: 600, origen: 'servicio' });
    expect(graciaParada(baseDeDatos({ stopGraceSeconds: 90 }), {})).toEqual({ segundos: 90, origen: 'servicio' });
  });

  it('un valor del servicio fuera de rango o no entero se descarta', () => {
    expect(graciaParada(app({ stopGraceSeconds: 601 }), {}).origen).toBe('defecto');
    expect(graciaParada(app({ stopGraceSeconds: -1 }), {}).origen).toBe('defecto');
    expect(graciaParada(app({ stopGraceSeconds: 2.5 }), {}).origen).toBe('defecto');
    expect(graciaParada(app({ stopGraceSeconds: '20' as never }), { RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '45' })).toEqual({
      segundos: 45,
      origen: 'railway',
    });
  });

  it('sin la del servicio, la de RAILWAY_DEPLOYMENT_DRAINING_SECONDS si se entiende', () => {
    expect(graciaParada(app(), { RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '45' })).toEqual({ segundos: 45, origen: 'railway' });
    expect(graciaParada(app(), { RAILWAY_DEPLOYMENT_DRAINING_SECONDS: ' 45 ' })).toEqual({ segundos: 45, origen: 'railway' });
    expect(graciaParada(app(), { RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '0' })).toEqual({ segundos: 0, origen: 'railway' });
    expect(graciaParada(app(), { RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '600' })).toEqual({ segundos: 600, origen: 'railway' });
    expect(graciaParada(app(), { RAILWAY_DEPLOYMENT_DRAINING_SECONDS: 'abc' })).toEqual({ segundos: 30, origen: 'defecto' });
    expect(graciaParada(app(), { RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '900' })).toEqual({ segundos: 30, origen: 'defecto' });
    expect(graciaParada(app(), { RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '-5' })).toEqual({ segundos: 30, origen: 'defecto' });
    expect(graciaParada(app(), { RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '4.5' })).toEqual({ segundos: 30, origen: 'defecto' });
    expect(graciaParada(app(), { RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '' })).toEqual({ segundos: 30, origen: 'defecto' });
  });

  it('por defecto, 30 s', () => {
    expect(GRACIA_PARADA_POR_DEFECTO).toBe(30);
    expect(graciaParada(app(), {})).toEqual({ segundos: 30, origen: 'defecto' });
    expect(graciaParada(baseDeDatos(), {})).toEqual({ segundos: 30, origen: 'defecto' });
  });
});

describe('comandoParada', () => {
  it('devuelve el comando sin espacios alrededor', () => {
    expect(comandoParada(app({ stopCommand: '  kill -USR1 1 \n' }))).toBe('kill -USR1 1');
    expect(comandoParada(imagen({ stopCommand: 'curl -fsS http://localhost/drain' }))).toBe('curl -fsS http://localhost/drain');
  });

  it('null si no hay, si está en blanco, si es una base de datos o si no se puede pasar entero', () => {
    expect(comandoParada(app())).toBeNull();
    expect(comandoParada(app({ stopCommand: '   ' }))).toBeNull();
    expect(comandoParada(baseDeDatos({ stopCommand: 'pg_ctl stop' } as Partial<DatabaseConfig>))).toBeNull();
    expect(comandoParada(app({ stopCommand: 'x'.repeat(COMANDO_PARADA_MAXIMO) }))).toHaveLength(COMANDO_PARADA_MAXIMO);
    expect(comandoParada(app({ stopCommand: 'x'.repeat(COMANDO_PARADA_MAXIMO + 1) }))).toBeNull();
    expect(comandoParada(app({ stopCommand: 'echo a\0b' }))).toBeNull();
  });
});

describe('describirEstrategia', () => {
  it('estrategia y motivo, para el registro', () => {
    expect(describirEstrategia({ estrategia: 'recreate', motivo: 'sin_trafico', automatica: true })).toBe(
      'una sola copia (sin dominio, healthcheck ni llamadas de otros servicios)',
    );
    expect(describirEstrategia({ estrategia: 'overlap', motivo: 'con_trafico', automatica: true })).toBe(
      'sin corte (recibe tráfico: dominio, healthcheck o llamadas de otros servicios)',
    );
    expect(describirEstrategia({ estrategia: 'overlap', motivo: 'elegida', automatica: false })).toBe('sin corte (elegida en Ajustes)');
    expect(describirEstrategia({ estrategia: 'recreate', motivo: 'estado', automatica: false })).toBe(
      'una sola copia (tiene volúmenes o puerto público)',
    );
    expect(describirEstrategia({ estrategia: 'recreate', motivo: 'base_de_datos', automatica: false })).toBe(
      'una sola copia (base de datos)',
    );
  });
});

describe('ayuda: las preguntas de bots llegan a sus respuestas', () => {
  it('el 409 de Telegram y las dos copias llevan a «una sola copia»', () => {
    expect(searchFaq('mi bot de telegram da error 409')[0].id).toBe('bot-o-worker-una-sola-copia');
    expect(searchFaq('hay dos copias del worker a la vez').map((f) => f.id)).toContain('bot-o-worker-una-sola-copia');
  });

  it('SIGTERM y la gracia llevan a la parada limpia; la identidad, a sus variables', () => {
    expect(searchFaq('el contenedor no se detiene con SIGTERM')[0].id).toBe('parada-limpia');
    expect(searchFaq('gracia de parada')[0].id).toBe('parada-limpia');
    expect(searchFaq('SKYWAY_INSTANCE_ID')[0].id).toBe('identidad-de-cada-copia');
  });
});
