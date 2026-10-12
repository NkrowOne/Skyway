import { describe, expect, it } from 'vitest';
import {
  actualizaUsuarioAlConectar,
  desplegarPorDefecto,
  entregaMientrasMxFuera,
  spfSugeridosPorNombre,
  tieneCredencialVigente,
} from '../src/correo';

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

describe('conectar un servicio: «Volver a desplegar ahora»', () => {
  // Nombres de la vista previa en un proyecto de una cuenta: llevan el proyecto.
  const smtpCuenta = ['skyway:tienda/bot'];
  const apiCuenta = ['Skyway · tienda/bot'];
  const apps = [{ name: 'skyway:tienda/bot' }, { name: 'n8n-a-mano' }];
  const claves = [{ name: 'Skyway · tienda/web' }];

  it('reconoce la credencial vigente del servicio por los nombres del servidor, en el modo elegido', () => {
    expect(tieneCredencialVigente('smtp', smtpCuenta, apps, claves)).toBe(true);
    // La clave de API es de otro servicio: en modo API no se revoca nada.
    expect(tieneCredencialVigente('api', apiCuenta, apps, claves)).toBe(false);
    // Con el nombre de un proyecto suelto no se reconoce en una cuenta.
    expect(tieneCredencialVigente('smtp', ['skyway:bot'], apps, claves)).toBe(false);
    // Sin vista previa todavía, nada.
    expect(tieneCredencialVigente('smtp', [], apps, claves)).toBe(false);
  });

  it('se marca sola si conectar revoca la credencial en uso, salvo con el servicio detenido desde el panel', () => {
    expect(desplegarPorDefecto(true, false)).toBe(true);
    expect(desplegarPorDefecto(false, false)).toBe(false);
    // Desplegar lo pondría en marcha: quizá se detuvo por algo.
    expect(desplegarPorDefecto(true, true)).toBe(false);
  });
});

describe('conectar un servicio: el buzón pasa a entrar con su dirección', () => {
  const buzon = { id: 'mbx_1', loginPending: true };

  it('en una cuenta, la credencial propia del servicio (skyway:<proyecto>/<servicio>) no cuenta como de otra aplicación', () => {
    const apps = [{ mailboxId: 'mbx_1', name: 'skyway:tienda/bot' }];
    expect(actualizaUsuarioAlConectar('smtp', buzon, apps, ['skyway:tienda/bot'])).toBe(true);
    // Con la regla de antes (`skyway:<slug>`) se tomaba por otra aplicación y no se avisaba.
    expect(actualizaUsuarioAlConectar('smtp', buzon, apps, ['skyway:bot'])).toBe(false);
  });

  it('otra aplicación de Skyway en el buzón lo deja para la baja; las creadas a mano y las de otros buzones no cuentan', () => {
    expect(actualizaUsuarioAlConectar('smtp', buzon, [{ mailboxId: 'mbx_1', name: 'skyway:tienda/web' }], ['skyway:tienda/bot'])).toBe(false);
    expect(actualizaUsuarioAlConectar('smtp', buzon, [{ mailboxId: 'mbx_1', name: 'n8n-a-mano' }], ['skyway:tienda/bot'])).toBe(true);
    expect(actualizaUsuarioAlConectar('smtp', buzon, [{ mailboxId: 'mbx_2', name: 'skyway:tienda/web' }], ['skyway:tienda/bot'])).toBe(true);
  });

  it('solo por SMTP y con el usuario anterior pendiente', () => {
    expect(actualizaUsuarioAlConectar('api', buzon, [], [])).toBe(false);
    expect(actualizaUsuarioAlConectar('smtp', { id: 'mbx_1', loginPending: false }, [], [])).toBe(false);
    expect(actualizaUsuarioAlConectar('smtp', undefined, [], [])).toBe(false);
  });
});
