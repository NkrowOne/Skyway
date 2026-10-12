import { describe, expect, it } from 'vitest';
import { textoWebhook, type WebhookEnRiesgo } from '../src/cambioDominio';

const aviso = (proveedores: WebhookEnRiesgo['proveedores']): WebhookEnRiesgo => ({
  serviceId: 's1',
  serviceName: 'Tienda',
  proveedores,
  evidencias: [],
  hosts: [{ serviceId: 's1', from: 'shop.bots.es', to: 'shop.bots2.es' }],
});

describe('textoWebhook', () => {
  it('dice «puede recibir»: usar la biblioteca o el token no dice que reciba webhooks (puede solo enviar)', () => {
    expect(textoWebhook(aviso(['telegram']))).toMatch(/^«Tienda» usa Telegram y puede recibir sus webhooks en shop\.bots\.es\./);
    expect(textoWebhook(aviso(['webhook']))).toMatch(/^«Tienda» puede recibir webhooks en shop\.bots\.es\./);
    expect(textoWebhook(aviso(['telegram']))).not.toMatch(/y recibe sus webhooks/);
  });

  it('con Stripe recuerda el secreto de firma del endpoint nuevo (el aviso general ya no sale)', () => {
    expect(textoWebhook(aviso(['stripe']))).toMatch(/Stripe no sigue redirecciones/);
    expect(textoWebhook(aviso(['stripe']))).toMatch(/actualiza STRIPE_WEBHOOK_SECRET\.$/);
    expect(textoWebhook(aviso(['slack']))).not.toMatch(/STRIPE_WEBHOOK_SECRET/);
  });
});
