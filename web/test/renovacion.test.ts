import { describe, expect, it } from 'vitest';
import { avisoRenovacion, fmtRenovacion } from '../src/renovacion';
import { MailRenewal } from '../src/types';

const HECHA = Date.UTC(2026, 9, 9, 12, 32);

function renovada(deployment: MailRenewal['deployment']): MailRenewal {
  return { status: 'renewed', reason: null, renewedAt: HECHA, mailbox: 'hola@tienda.example', deployment };
}

describe('avisoRenovacion', () => {
  it('dice cuándo se renovó, tras la actualización del servidor de correo', () => {
    const aviso = avisoRenovacion(renovada({ id: 'dep_1', status: 'success' }))!;
    expect(aviso.tone).toBe('ok');
    expect(aviso.title).toBe(
      `Contraseña de aplicación renovada automáticamente el ${fmtRenovacion(HECHA)} tras la actualización del servidor de correo.`,
    );
    expect(aviso.detail).toBe('Se ha vuelto a desplegar el servicio para aplicarla.');
    expect(aviso.deploymentFailed).toBe(false);
  });

  it('sigue el despliegue que la aplica: en curso, fallido o sin desplegar', () => {
    expect(avisoRenovacion(renovada({ id: 'dep_1', status: 'building' }))!.detail).toBe(
      'Se está volviendo a desplegar el servicio para aplicarla.',
    );
    const fallido = avisoRenovacion(renovada({ id: 'dep_1', status: 'failed' }))!;
    expect(fallido).toMatchObject({ tone: 'warn', deploymentFailed: true });
    expect(fallido.detail).toMatch(/Vuelve a desplegar el servicio/);
    expect(avisoRenovacion(renovada(null))!.detail).toBe('Se aplicará en el próximo despliegue del servicio.');
  });

  it('explica por qué espera o por qué no se ha podido renovar', () => {
    const espera = avisoRenovacion({
      status: 'waiting',
      reason: 'El servicio está detenido. La contraseña se renovará automáticamente cuando vuelva a estar en marcha.',
      renewedAt: null,
      mailbox: null,
      deployment: null,
    })!;
    expect(espera.tone).toBe('warn');
    expect(espera.title).toBe('La contraseña de aplicación del servicio ha dejado de ser válida tras la actualización del servidor de correo.');
    expect(espera.detail).toMatch(/^El servicio está detenido/);

    const fallo = avisoRenovacion({ ...renovada(null), status: 'failed', reason: 'No se ha podido crear la contraseña de aplicación nueva.' })!;
    expect(fallo.tone).toBe('err');
    expect(fallo.title).toMatch(/no se ha podido renovar automáticamente\.$/);
    expect(fallo.detail).toBe('No se ha podido crear la contraseña de aplicación nueva.');
  });

  it('sin ninguna renovación hecha ni pendiente no dice nada', () => {
    expect(avisoRenovacion({ status: 'renewed', reason: null, renewedAt: null, mailbox: null, deployment: null })).toBeNull();
  });
});
