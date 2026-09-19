import { describe, expect, it } from 'vitest';
import { configureUrl, installUrl, type GithubAppConfig } from '../src/github/app';
import { parseGithubSlug } from '../src/github/client';
import { isRailwaySchemaError, parseTemplateCode, RailwayError } from '../src/railway/client';
import { RAILWAY_REF_RE, rewriteRailwayRefs, splitRef, splitValidDomains, type RailwayRefCtx } from '../src/railway/importer';

describe('splitRef', () => {
  it('separa ámbito y clave, con nombres entrecomillados o con puntos', () => {
    expect(splitRef('Postgres.DATABASE_URL')).toEqual({ scope: 'Postgres', key: 'DATABASE_URL' });
    expect(splitRef('"Supabase Studio".JWT_SECRET')).toEqual({ scope: 'Supabase Studio', key: 'JWT_SECRET' });
    expect(splitRef('db.v2.DATABASE_URL')).toEqual({ scope: 'db.v2', key: 'DATABASE_URL' });
    expect(splitRef('PORT')).toEqual({ scope: null, key: 'PORT' });
  });
});

describe('RAILWAY_REF_RE', () => {
  it('no arrastra lastIndex entre usos con matchAll', () => {
    const v = '${{A.X}} y ${{ B.Y }}';
    expect([...v.matchAll(RAILWAY_REF_RE)]).toHaveLength(2);
    expect([...v.matchAll(RAILWAY_REF_RE)]).toHaveLength(2);
  });

  it('una referencia sin cierre no casa y se evalúa en tiempo lineal', () => {
    const abierto = '${{' + 'a'.repeat(50_000);
    const t0 = Date.now();
    expect([...abierto.matchAll(RAILWAY_REF_RE)]).toHaveLength(0);
    expect(Date.now() - t0, 'regex de referencias demasiado lenta').toBeLessThan(1000);
  });
});

describe('rewriteRailwayRefs', () => {
  type Entry = RailwayRefCtx['byName'] extends Map<string, infer V> ? V : never;
  const entry: Entry = { slug: 'postgres-prod', port: null, domains: [], vars: new Set(['DATABASE_URL', 'PGHOST']) };
  const ctx: RailwayRefCtx = {
    byName: new Map<string, Entry>([
      ['postgres (prod)', entry],
      ['postgres-prod', entry],
      ['web', { slug: 'web', port: 3000, domains: ['app.example.com'], vars: new Set(['PORT']) }],
    ]),
    sharedVars: new Set(['API_KEY']),
    projectName: 'demo',
    environmentName: 'production',
  };

  it('resuelve por nombre y por slug, dominios y puertos, secretos, y deja sin tocar lo irresoluble', () => {
    const vars: Record<string, string> = {
      A: '${{postgres-prod.DATABASE_URL}}',
      B: '${{"Postgres (prod)".PGHOST}}',
      C: '${{web.RAILWAY_PRIVATE_DOMAIN}}:${{web.PORT}}',
      D: 'https://${{web.RAILWAY_PUBLIC_DOMAIN}}',
      E: '${{shared.API_KEY}}',
      F: '${{shared.NOPE}}',
      G: '${{nadie.X}}',
      H: '${{secret(16)}}',
      I: '${{ secret(8, "abc") }}',
      J: '${{postgres-prod.NO_EXPORTA}}',
    };
    const { changed, unresolved } = rewriteRailwayRefs('web', vars, ctx);
    expect(vars.A).toBe('${{postgres-prod.DATABASE_URL}}');
    expect(vars.B).toBe('${{postgres-prod.PGHOST}}');
    expect(vars.C).toBe('web:3000');
    expect(vars.D).toBe('https://app.example.com');
    expect(vars.E).toBe('${{shared.API_KEY}}');
    expect(vars.F).toBe('${{shared.NOPE}}');
    expect(vars.G).toBe('${{nadie.X}}');
    expect(vars.H).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(vars.I).toMatch(/^[abc]{8}$/);
    expect(vars.J).toBe('${{postgres-prod.NO_EXPORTA}}');
    expect([...changed].sort()).toEqual(['B', 'C', 'D', 'H', 'I']);
    expect(unresolved, unresolved.join('\n')).toHaveLength(3);
  });
});

describe('parseGithubSlug', () => {
  it('acepta owner/repo y URLs de GitHub, y rechaza el resto', () => {
    expect(parseGithubSlug('owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
    expect(parseGithubSlug('https://github.com/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
    expect(parseGithubSlug('https://github.com/owner/repo/tree/main')).toEqual({ owner: 'owner', repo: 'repo' });
    expect(parseGithubSlug('https://gitlab.com/owner/repo')).toBeNull();
    expect(parseGithubSlug('')).toBeNull();
  });
});

describe('parseTemplateCode', () => {
  it('extrae el código de una URL de plantilla o de un código suelto', () => {
    expect(parseTemplateCode('https://railway.com/new/template/abc-123')).toBe('abc-123');
    expect(parseTemplateCode('railway.app/template/XyZ')).toBe('XyZ');
    expect(parseTemplateCode('  XyZ_9 ')).toBe('XyZ_9');
  });

  it('rechaza códigos demasiado largos o con espacios', () => {
    expect(parseTemplateCode('x'.repeat(65))).toBeNull();
    expect(parseTemplateCode('a b')).toBeNull();
  });
});

describe('isRailwaySchemaError', () => {
  it('solo reconoce los errores GraphQL de campo inexistente', () => {
    expect(isRailwaySchemaError(new RailwayError('Error de la API de Railway: Cannot query field "branch" on type "ServiceInstance"', 'graphql'))).toBe(true);
    expect(isRailwaySchemaError(new RailwayError('Error de la API de Railway: Not Authorized', 'graphql'))).toBe(false);
    expect(isRailwaySchemaError(new RailwayError('Railway rechazó el token', 'auth'))).toBe(false);
    expect(isRailwaySchemaError(new Error('x'))).toBe(false);
  });
});

describe('splitValidDomains', () => {
  it('normaliza a minúsculas y quita duplicados', () => {
    expect(splitValidDomains(['App.Example.com', 'api.example.com', 'api.example.com'])).toEqual({
      valid: ['app.example.com', 'api.example.com'],
      invalid: [],
    });
  });

  it('aparta los dominios con caracteres que romperían la regla de Traefik, vacíos o malformados', () => {
    expect(splitValidDomains(['ok.example.com', 'ma`l.example.com', 'x.com`) || Host(`victima.com', '', ' -bad.com', 'a..b'])).toEqual({
      valid: ['ok.example.com'],
      invalid: ['ma`l.example.com', 'x.com`) || host(`victima.com', '-bad.com', 'a..b'],
    });
  });

  it('rechaza una etiqueta de más de 63 caracteres', () => {
    expect(splitValidDomains([`${'a'.repeat(64)}.com`]).valid).toEqual([]);
  });
});

describe('URLs de la GitHub App', () => {
  it('configureUrl distingue organización y usuario', () => {
    expect(configureUrl({ accountType: 'Organization', accountLogin: 'acme' }, 42)).toBe('https://github.com/organizations/acme/settings/installations/42');
    expect(configureUrl({ accountType: 'User', accountLogin: 'ana' }, 42)).toBe('https://github.com/settings/installations/42');
  });

  it('con la config de la App cae a la URL de usuario, nunca a /apps/<slug>/installations', () => {
    const cfg: GithubAppConfig = {
      appId: '1',
      slug: 'skyway-x',
      name: 'Skyway',
      privateKey: '',
      clientId: '',
      clientSecret: '',
      webhookSecret: '',
      htmlUrl: 'https://github.com/apps/skyway-x',
    };
    expect(configureUrl(cfg, 7)).toBe('https://github.com/settings/installations/7');
    expect(installUrl(cfg, 'a b')).toBe('https://github.com/apps/skyway-x/installations/new?state=a%20b');
  });
});
