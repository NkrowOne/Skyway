import { describe, expect, it } from 'vitest';
import { entregaMientrasMxFuera, spfSugeridosPorNombre } from '../src/correo';

describe('entregaMientrasMxFuera', () => {
  it('solo dice que se entrega en el proveedor actual cuando Mailway lo encamina allí', () => {
    expect(entregaMientrasMxFuera('cliente.es', true, false)).toMatch(/se entrega allí/);
    // false: MX de los dos proveedores o aún sin medir; Mailway lo entrega aquí.
    const local = entregaMientrasMxFuera('cliente.es', false, true);
    expect(local).toMatch(/se queda en los buzones de aquí/);
    expect(local).not.toMatch(/se entrega allí/);
    expect(local).not.toMatch(/actualiza/);
  });

  it('con un Mailway que no lo informa, actualizarlo solo se le pide al administrador', () => {
    expect(entregaMientrasMxFuera('cliente.es', null, true)).toMatch(/actualiza Mailway/);
    const miembro = entregaMientrasMxFuera('cliente.es', undefined, false);
    expect(miembro).toMatch(/se queda en los buzones de aquí/);
    expect(miembro).not.toMatch(/actualiza Mailway/);
    expect(miembro).toMatch(/el administrador de la plataforma/);
  });
});

describe('spfSugeridosPorNombre', () => {
  it('empareja cada SPF combinado con su registro, no con el primero que haya', () => {
    const m = spfSugeridosPorNombre([
      { id: 'mx:operador.com' },
      { id: 'spf:mail.operador.com.', suggested: 'v=spf1 a ip4:203.0.113.10 -all' },
      { id: 'spf:Operador.com', suggested: 'v=spf1 include:_spf.google.com a:mail.operador.com ~all' },
      { id: 'spf:otro.operador.com', suggested: null },
    ]);
    expect(m.get('operador.com')).toBe('v=spf1 include:_spf.google.com a:mail.operador.com ~all');
    expect(m.get('mail.operador.com')).toBe('v=spf1 a ip4:203.0.113.10 -all');
    expect(m.has('otro.operador.com')).toBe(false);
  });
});
