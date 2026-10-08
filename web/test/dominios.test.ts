import { describe, expect, it } from 'vitest';
import * as servidor from '../../server/src/dominioprincipal';
import {
  completarParejasWww,
  dominioPrincipal,
  intervaloComprobacion,
  limpiarSinPareja,
  ordenarDominios,
  parejasWwwPendientes,
  parejaWww,
} from '../src/dominios';

const ROOT = 'apps.plataforma.com';

describe('ordenarDominios (misma regla que el servidor)', () => {
  it('www primero, el resto en su orden y el subdominio generado al final', () => {
    expect(ordenarDominios([`web.${ROOT}`, 'codanuancelegal.com', 'www.codanuancelegal.com'], ROOT)).toEqual([
      'www.codanuancelegal.com',
      'codanuancelegal.com',
      `web.${ROOT}`,
    ]);
    expect(ordenarDominios(['b.com', 'a.com'], ROOT)).toEqual(['b.com', 'a.com']);
    expect(dominioPrincipal([`web.${ROOT}`], ROOT)).toBe(`web.${ROOT}`);
    expect(dominioPrincipal([], ROOT)).toBeNull();
  });
});

describe('parejaWww', () => {
  it('dominio registrable sin www: falta la versión con www', () => {
    expect(parejaWww('codanuancelegal.com')).toEqual({ falta: 'www.codanuancelegal.com', tipo: 'www' });
    expect(parejaWww('Tienda.ES')).toEqual({ falta: 'www.tienda.es', tipo: 'www' });
  });

  it('www de un dominio registrable: falta la versión sin www', () => {
    expect(parejaWww('www.codanuancelegal.com')).toEqual({ falta: 'codanuancelegal.com', tipo: 'raiz' });
  });

  it('sufijos de dos niveles: el registrable tiene tres etiquetas', () => {
    expect(parejaWww('tienda.com.es')).toEqual({ falta: 'www.tienda.com.es', tipo: 'www' });
    expect(parejaWww('www.shop.co.uk')).toEqual({ falta: 'shop.co.uk', tipo: 'raiz' });
    expect(parejaWww('www.empresa.com.mx')).toEqual({ falta: 'empresa.com.mx', tipo: 'raiz' });
    // El propio sufijo no es un dominio registrable.
    expect(parejaWww('com.es')).toBeNull();
  });

  it('sin pareja: subdominios más profundos y lo que cuelga del dominio raíz de la plataforma', () => {
    expect(parejaWww('app.ejemplo.com')).toBeNull();
    expect(parejaWww('www.app.ejemplo.com')).toBeNull();
    expect(parejaWww('app.tienda.com.es')).toBeNull();
    expect(parejaWww(`web.${ROOT}`, ROOT)).toBeNull();
    expect(parejaWww(`www.${ROOT}`, ROOT)).toBeNull();
    expect(parejaWww('localhost')).toBeNull();
  });
});

describe('parejasWwwPendientes', () => {
  it('solo los dominios cuya pareja no está en la lista', () => {
    expect(parejasWwwPendientes(['codanuancelegal.com'], ROOT)).toEqual([
      { domain: 'codanuancelegal.com', falta: 'www.codanuancelegal.com', tipo: 'www' },
    ]);
    expect(parejasWwwPendientes(['www.codanuancelegal.com', 'codanuancelegal.com'], ROOT)).toEqual([]);
    expect(parejasWwwPendientes(['www.a.com', 'b.es', 'app.c.com', `web.${ROOT}`], ROOT)).toEqual([
      { domain: 'www.a.com', falta: 'a.com', tipo: 'raiz' },
      { domain: 'b.es', falta: 'www.b.es', tipo: 'www' },
    ]);
  });
});

describe('intervaloComprobacion', () => {
  it('cada 15 s los dos primeros minutos, después cada minuto y se detiene a los 30', () => {
    expect(intervaloComprobacion('no_record', 0, 1)).toBe(15_000);
    expect(intervaloComprobacion(undefined, 60_000, 1)).toBe(15_000);
    expect(intervaloComprobacion('cloudflare_proxy', 3 * 60_000, 1)).toBe(60_000);
    expect(intervaloComprobacion('no_record', 30 * 60_000, 1)).toBe(false);
  });

  it('se detiene en cuanto el DNS es correcto', () => {
    expect(intervaloComprobacion('ok', 0, 1)).toBe(false);
  });

  it('con varios dominios, entre todos no pasan de 20 comprobaciones por minuto (el servidor admite 30)', () => {
    for (const n of [1, 2, 5, 8, 12, 40]) {
      const ms = intervaloComprobacion('no_record', 0, n);
      expect(ms).not.toBe(false);
      expect((n * 60_000) / (ms as number), `${n} dominios`).toBeLessThanOrEqual(20);
    }
  });
});

describe('completarParejasWww y limpiarSinPareja', () => {
  it('añade la pareja detrás de su dominio, respeta las renuncias y solo completa los nuevos', () => {
    expect(completarParejasWww(['bufete.es'], { rootDomain: ROOT })).toEqual({ domains: ['www.bufete.es', 'bufete.es'], anadidos: ['www.bufete.es'] });
    expect(completarParejasWww(['bufete.es'], { sinPareja: ['bufete.es'] }).domains).toEqual(['bufete.es']);
    expect(completarParejasWww(['antiguo.es', 'nuevo.es'], { nuevos: ['nuevo.es'] }).domains).toEqual(['www.nuevo.es', 'antiguo.es', 'nuevo.es']);
    expect(limpiarSinPareja(['a.es', 'b.es', 'c.es'], ['a.es', 'b.es', 'www.b.es'])).toEqual(['a.es']);
  });
});

/*
 * La copia del editor y la del servidor deben decir lo mismo: si el panel
 * añadiera una pareja que el servidor no, o al revés, el guardado cambiaría
 * la lista que se acaba de ver.
 */
describe('la copia de la web y la del servidor coinciden', () => {
  const casos: { domains: string[]; nuevos?: string[]; sinPareja?: string[] }[] = [
    { domains: ['codanuancelegal.com'] },
    { domains: ['www.codanuancelegal.com'] },
    { domains: ['tienda.com.es', 'www.shop.co.uk', 'app.ejemplo.com', `web.${ROOT}`, `www.${ROOT}`] },
    { domains: ['b.com', 'a.com', 'www.a.com', 'B.COM.'] },
    { domains: ['antiguo.es', 'nuevo.es'], nuevos: ['nuevo.es'] },
    { domains: ['renuncia.es', 'otro.es'], sinPareja: ['renuncia.es', 'quitado.es'] },
    { domains: ['com.es', 'localhost', 'empresa.com.mx'] },
  ];
  it.each(casos)('%j', (caso) => {
    const opts = { rootDomain: ROOT, nuevos: caso.nuevos, sinPareja: caso.sinPareja };
    expect(completarParejasWww(caso.domains, opts)).toEqual(servidor.completarParejasWww(caso.domains, opts));
    expect(ordenarDominios(caso.domains, ROOT)).toEqual(servidor.ordenarDominios(caso.domains, ROOT));
    for (const d of caso.domains) expect(parejaWww(d, ROOT)).toEqual(servidor.parejaWww(d, ROOT));
    const sin = caso.sinPareja ?? caso.domains;
    expect(limpiarSinPareja(sin, caso.domains, ROOT)).toEqual(servidor.limpiarSinPareja(sin, caso.domains, ROOT));
  });
});
