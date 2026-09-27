/**
 * Saneado de la configuración de Traefik que publica Mailway: todo lo que no
 * encaje en «Host(`…`) hacia un contenedor permitido» se descarta.
 */
import { describe, expect, it } from 'vitest';
import { parseHostRule, sanitizeTraefikConfig, stableStringify, SanitizeOptions } from '../src/mailwaytraefik';

const OPTS: SanitizeOptions = {
  reservedHosts: ['panel.skyway.example', 'app.cliente.com', 'WWW.Cliente.com'],
  allowBackendHost: (h) => h !== 'skyway' && (!h.startsWith('skyway-') || h.startsWith('skyway-correo-')),
};

const SERVICIO = { loadBalancer: { servers: [{ url: 'http://mailway-webmail:80' }] } };

/** Configuración con un único router bajo prueba y su servicio. */
function uno(router: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    http: {
      routers: { r: { entryPoints: ['websecure'], service: 's', ...router } },
      services: { s: SERVICIO, ...((extra.services as object) ?? {}) },
      middlewares: (extra.middlewares as object) ?? {},
    },
  };
}

function routers(raw: unknown, opts = OPTS): string[] {
  return Object.keys(sanitizeTraefikConfig(raw, opts).config.http?.routers ?? {});
}

describe('parseHostRule', () => {
  it('acepta uno o varios Host con comillas invertidas', () => {
    expect(parseHostRule('Host(`a.example.com`)')).toEqual(['a.example.com']);
    expect(parseHostRule('Host(`A.example.com`) || Host(`b.example.com`)')).toEqual(['a.example.com', 'b.example.com']);
  });

  it.each([
    'Host(`a.example.com`) || PathPrefix(`/`)',
    'Host(`a.example.com`) && PathPrefix(`/api`)',
    'HostRegexp(`.+`)',
    'HostRegexp(`{sub:[a-z]+}.example.com`)',
    'PathPrefix(`/`)',
    'Host(`*.example.com`)',
    'Host(`localhost`)',
    'Host("a.example.com")',
    'Host(`a.example.com`, `b.example.com`)',
    'Host(`a.example.com`) || ',
    'Host(`a.example.com`)) || (PathPrefix(`/`)',
    '!Host(`a.example.com`)',
    'Host(`a.example.com`) || Host(`b.example.com`) && Path(`/x`)',
    'Host(`a b.example.com`)',
    'Host(`a.example.com\n`)',
    '',
  ])('rechaza %j', (rule) => {
    expect(parseHostRule(rule)).toBeNull();
  });

  it('rechaza lo que no es texto', () => {
    expect(parseHostRule(undefined)).toBeNull();
    expect(parseHostRule(['Host(`a.example.com`)'])).toBeNull();
  });
});

describe('sanitizeTraefikConfig', () => {
  it('conserva una configuración legítima y reescribe la regla en forma canónica', () => {
    const raw = {
      http: {
        routers: {
          'mailway-1': { rule: 'Host(`Webmail.Acme.com`)', entryPoints: ['websecure'], service: 'mailway-webmail', tls: { certResolver: 'le', options: 'x' } },
          'mailway-1-http': { rule: 'Host(`webmail.acme.com`)', entryPoints: ['web'], service: 'mailway-webmail', middlewares: ['mailway-https'], priority: 9999 },
        },
        services: { 'mailway-webmail': SERVICIO, 'sin-uso': SERVICIO },
        middlewares: { 'mailway-https': { redirectScheme: { scheme: 'https', permanent: true } } },
      },
      tcp: { routers: { x: { rule: 'HostSNI(`*`)', service: 'y' } } },
    };
    const { config, dropped } = sanitizeTraefikConfig(raw, OPTS);
    expect(dropped).toEqual([]);
    expect(config).toEqual({
      http: {
        routers: {
          'mailway-1': { rule: 'Host(`webmail.acme.com`)', entryPoints: ['websecure'], service: 'mailway-webmail', tls: { certResolver: 'le' } },
          'mailway-1-http': { rule: 'Host(`webmail.acme.com`)', entryPoints: ['web'], service: 'mailway-webmail', middlewares: ['mailway-https'] },
        },
        // Solo lo que usan las rutas; TCP y la prioridad desaparecen.
        services: { 'mailway-webmail': SERVICIO },
        middlewares: { 'mailway-https': { redirectScheme: { scheme: 'https', permanent: true } } },
      },
    });
  });

  it('sin rutas válidas devuelve un objeto vacío (Traefik lo acepta)', () => {
    expect(sanitizeTraefikConfig({}, OPTS).config).toEqual({});
    expect(sanitizeTraefikConfig(null, OPTS).config).toEqual({});
    expect(sanitizeTraefikConfig('texto', OPTS).config).toEqual({});
    expect(sanitizeTraefikConfig({ http: { routers: [] } }, OPTS).config).toEqual({});
  });

  it('descarta los dominios que ya son de Skyway (panel y servicios), sin distinguir mayúsculas', () => {
    expect(routers(uno({ rule: 'Host(`app.cliente.com`)' }))).toEqual([]);
    expect(routers(uno({ rule: 'Host(`panel.skyway.example`)' }))).toEqual([]);
    expect(routers(uno({ rule: 'Host(`www.cliente.com`)' }))).toEqual([]);
    // Uno propio mezclado con uno ajeno: fuera la ruta entera.
    expect(routers(uno({ rule: 'Host(`mio.acme.com`) || Host(`APP.cliente.com`)' }))).toEqual([]);
    expect(routers(uno({ rule: 'Host(`mio.acme.com`)' }))).toEqual(['r']);
  });

  it('descarta inyecciones en la regla', () => {
    expect(routers(uno({ rule: 'Host(`a.acme.com`) || PathPrefix(`/`)' }))).toEqual([]);
    expect(routers(uno({ rule: 'HostRegexp(`^.+$`)' }))).toEqual([]);
    expect(routers(uno({ rule: 'Host(`a.acme.com`) || HostRegexp(`.*`)' }))).toEqual([]);
    const { dropped } = sanitizeTraefikConfig(uno({ rule: 'PathPrefix(`/`)' }), OPTS);
    expect(dropped[0]).toMatch(/solo puede contener Host/);
  });

  it('no permite señalar a servicios de otros proveedores ni con nombres raros', () => {
    expect(routers(uno({ rule: 'Host(`a.acme.com`)', service: 'api@internal' }))).toEqual([]);
    expect(routers(uno({ rule: 'Host(`a.acme.com`)', service: 'skyway@docker' }))).toEqual([]);
    expect(routers(uno({ rule: 'Host(`a.acme.com`)', service: 'no-existe' }))).toEqual([]);
    const raw = { http: { routers: { 'r@docker': { rule: 'Host(`a.acme.com`)', entryPoints: ['web'], service: 's' } }, services: { s: SERVICIO } } };
    expect(routers(raw)).toEqual([]);
  });

  it.each([
    'http://169.254.169.254',
    'http://127.0.0.1:4000',
    'http://2130706433',
    'http://0x7f000001',
    'https://mailway-webmail:443',
    'http://evil.example.com',
    'http://mailway-webmail:80/ruta',
    'http://user:pass@mailway-webmail:80',
    'http://skyway:4000',
    'http://skyway-otro-cliente-app:3000',
    'http://mailway-webmail:99999',
    'http://mailway-webmail:0',
    'file:///etc/passwd',
    '',
  ])('rechaza el destino %j', (url) => {
    const raw = uno({ rule: 'Host(`a.acme.com`)' }, { services: { s: { loadBalancer: { servers: [{ url }] } } } });
    expect(routers(raw)).toEqual([]);
  });

  it('admite contenedores del proyecto de Mailway y normaliza la URL', () => {
    const raw = uno({ rule: 'Host(`a.acme.com`)' }, { services: { s: { loadBalancer: { servers: [{ url: 'HTTP://skyway-correo-panel:03000/' }] } } } });
    const cfg = sanitizeTraefikConfig(raw, OPTS).config;
    expect(cfg.http?.services?.s.loadBalancer.servers).toEqual([{ url: 'http://skyway-correo-panel:3000' }]);
  });

  it('un servicio con un solo destino malo se descarta entero y con él sus rutas', () => {
    const servers = [{ url: 'http://mailway-webmail:80' }, { url: 'http://skyway:4000' }];
    const raw = uno({ rule: 'Host(`a.acme.com`)' }, { services: { s: { loadBalancer: { servers, healthCheck: {} } } } });
    const { config, dropped } = sanitizeTraefikConfig(raw, OPTS);
    expect(config).toEqual({});
    expect(dropped.some((d) => d.includes('contenedor no permitido'))).toBe(true);
  });

  it('solo admite middlewares de redirección a HTTPS', () => {
    const conMw = (middlewares: Record<string, unknown>, uses: string[]) =>
      routers(uno({ rule: 'Host(`a.acme.com`)', middlewares: uses }, { middlewares }));
    expect(conMw({ m: { redirectScheme: { scheme: 'https' } } }, ['m'])).toEqual(['r']);
    expect(conMw({ m: { redirectScheme: { scheme: 'http' } } }, ['m'])).toEqual([]);
    expect(conMw({ m: { basicAuth: { users: ['a:b'] } } }, ['m'])).toEqual([]);
    expect(conMw({ m: { headers: { customRequestHeaders: { 'X-Forwarded-User': 'admin' } } } }, ['m'])).toEqual([]);
    expect(conMw({ m: { redirectScheme: { scheme: 'https' }, stripPrefix: { prefixes: ['/'] } } }, ['m'])).toEqual([]);
    expect(conMw({}, ['auth@file'])).toEqual([]);
  });

  it('solo las entradas web/websecure y el emisor «le»', () => {
    expect(routers(uno({ rule: 'Host(`a.acme.com`)', entryPoints: ['traefik'] }))).toEqual([]);
    expect(routers(uno({ rule: 'Host(`a.acme.com`)', entryPoints: 'websecure' }))).toEqual([]);
    const mixto = sanitizeTraefikConfig(uno({ rule: 'Host(`a.acme.com`)', entryPoints: ['traefik', 'web'] }), OPTS).config;
    expect(mixto.http?.routers?.r.entryPoints).toEqual(['web']);
    expect(routers(uno({ rule: 'Host(`a.acme.com`)', tls: { certResolver: 'otro' } }))).toEqual([]);
    expect(routers(uno({ rule: 'Host(`a.acme.com`)', tls: true }))).toEqual([]);
    const sinEmisor = sanitizeTraefikConfig(uno({ rule: 'Host(`a.acme.com`)', tls: {} }), OPTS).config;
    expect(sinEmisor.http?.routers?.r.tls).toEqual({});
  });

  it('es idempotente y su serialización es estable', () => {
    const raw = {
      http: {
        routers: {
          b: { rule: 'Host(`b.acme.com`)', entryPoints: ['web'], service: 's' },
          a: { rule: 'Host(`a.acme.com`)', entryPoints: ['websecure'], service: 's', tls: { certResolver: 'le' } },
        },
        services: { s: SERVICIO },
      },
    };
    const once = sanitizeTraefikConfig(raw, OPTS).config;
    const twice = sanitizeTraefikConfig(once, OPTS).config;
    expect(twice).toEqual(once);
    expect(stableStringify(once)).toBe(stableStringify(JSON.parse(JSON.stringify(twice))));
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
});
