import { describe, expect, it } from 'vitest';
import { fmtCaducidad, mailtoBienvenida, textoBienvenida } from '../src/bienvenida';

const base = {
  email: 'ana@empresa.com',
  name: 'Ana García',
  clientName: 'Irene Cobo',
  url: 'https://correo.example.com/bienvenida/tok_123',
  expiresAt: Date.UTC(2026, 9, 16, 8, 30),
};

/** Asunto y cuerpo de un enlace mailto, ya decodificados. */
function partes(mailto: string): { to: string; subject: string; body: string } {
  const [to, query] = mailto.slice('mailto:'.length).split('?');
  const params = new URLSearchParams(query.replace(/\+/g, '%2B'));
  return { to, subject: params.get('subject') ?? '', body: params.get('body') ?? '' };
}

describe('mailtoBienvenida', () => {
  it('lleva la dirección, un asunto breve y el cuerpo con el enlace, el cliente y la caducidad', () => {
    const mailto = mailtoBienvenida(base);
    expect(mailto.startsWith('mailto:ana@empresa.com?subject=')).toBe(true);
    const { to, subject, body } = partes(mailto);
    expect(to).toBe('ana@empresa.com');
    expect(subject).toBe('Configuración inicial del correo de Irene Cobo');
    expect(body.split('\r\n')[0]).toBe('Hola, Ana García:');
    expect(body).toContain('Se ha preparado el acceso de Irene Cobo al panel de correo.');
    expect(body).toContain('\r\nhttps://correo.example.com/bienvenida/tok_123\r\n');
    expect(body).toContain(`caduca el ${fmtCaducidad(base.expiresAt)}.`);
    expect(body).toMatch(/solo se puede utilizar una vez/);
    expect(body.endsWith('Un saludo.')).toBe(true);
  });

  it('un «&» o un «?» en el nombre o en el cliente no rompen el enlace', () => {
    const mailto = mailtoBienvenida({ ...base, name: 'Ana & Luis?', clientName: 'Cobo & Asociados' });
    // Solo hay un «?» y un «&» sin codificar: los separadores de la consulta.
    expect(mailto.split('?')).toHaveLength(2);
    expect(mailto.split('&')).toHaveLength(2);
    const { subject, body } = partes(mailto);
    expect(subject).toBe('Configuración inicial del correo de Cobo & Asociados');
    expect(body.split('\r\n')[0]).toBe('Hola, Ana & Luis?:');
  });

  it('sin nombre saluda sin él y sin caducidad no la menciona', () => {
    const { body } = textoBienvenida({ ...base, name: '  ', expiresAt: null });
    expect(body.split('\r\n')[0]).toBe('Hola:');
    expect(body).not.toMatch(/caduca/);
    expect(body).toContain('El enlace es personal y solo se puede utilizar una vez.');
  });
});

describe('fmtCaducidad', () => {
  it('fecha y hora completas en español', () => {
    expect(fmtCaducidad(base.expiresAt)).toMatch(/^\d{1,2} de octubre de 2026 a las \d{2}:\d{2}$/);
  });
});
