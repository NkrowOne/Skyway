import { describe, expect, it } from 'vitest';
import { dominioUnicode, nombreEnZona, normalizarDominio } from '../src/dominios';

describe('normalizarDominio', () => {
  it('admite acentos y «ñ» y los guarda en punycode, como el servidor y Mailway', () => {
    expect(normalizarDominio('panadería.es')).toBe('xn--panadera-i2a.es');
    expect(normalizarDominio('Peña.COM.es')).toBe('xn--pea-8ma.com.es');
  });

  it('quita el esquema, la ruta, el puerto y el punto final de una URL pegada', () => {
    expect(normalizarDominio('https://www.panaderiasol.es')).toBe('www.panaderiasol.es');
    expect(normalizarDominio('https://www.panaderiasol.es/tienda?x=1')).toBe('www.panaderiasol.es');
    expect(normalizarDominio('www.panaderiasol.es/tienda')).toBe('www.panaderiasol.es');
    expect(normalizarDominio('app.ejemplo.es:8080')).toBe('app.ejemplo.es');
    expect(normalizarDominio('ejemplo.es.')).toBe('ejemplo.es');
  });

  it('rechaza lo que no es un dominio', () => {
    expect(normalizarDominio('')).toBe('');
    expect(normalizarDominio('localhost')).toBe('');
    expect(normalizarDominio('a b.es')).toBe('');
    expect(normalizarDominio('dominio_con_guion_bajo.es')).toBe('');
    // Como el servidor: un correo pegado no se queda en silencio con su dominio.
    expect(normalizarDominio('info@cliente.es')).toBe('');
    expect(normalizarDominio('cliente.es\\tienda')).toBe('');
  });
});

describe('dominioUnicode', () => {
  it('enseña el dominio como se escribe', () => {
    expect(dominioUnicode('xn--panadera-i2a.es')).toBe('panadería.es');
    expect(dominioUnicode('www.xn--pea-8ma.com.es')).toBe('www.peña.com.es');
    expect(dominioUnicode('ejemplo.es')).toBe('ejemplo.es');
  });

  it('un punycode roto se deja como está', () => {
    expect(dominioUnicode('xn--ab!c.es')).toBe('xn--ab!c.es');
  });

  it('ida y vuelta', () => {
    for (const d of ['panadería.es', 'añadir.ejemplo.es', 'müller.de', 'example.中国']) {
      expect(dominioUnicode(normalizarDominio(d))).toBe(d);
    }
  });
});

describe('nombreEnZona', () => {
  it('da el nombre que se escribe en el panel DNS de la zona', () => {
    expect(nombreEnZona('caa.es', 'caa.es')).toBe('@');
    expect(nombreEnZona('www.caa.es.', 'caa.es')).toBe('www');
    expect(nombreEnZona('a.b.panaderia.com.es', 'panaderia.com.es')).toBe('a.b');
    // Fuera de la zona (un CAA en el sufijo, por ejemplo) no hay nombre relativo.
    expect(nombreEnZona('com.es', 'panaderia.com.es')).toBeNull();
    expect(nombreEnZona('otrocaa.es', 'caa.es')).toBeNull();
  });
});
