import { describe, expect, it } from 'vitest';
import { avisoDnsCorreo } from '../src/components/DnsAutoResult';

describe('avisoDnsCorreo', () => {
  it('cuenta como creados solo los registros creados: el alta automática nunca modifica uno existente', () => {
    const aviso = avisoDnsCorreo('ejemplo.es', {
      applied: [
        { action: 'create', type: 'MX', name: 'ejemplo.es' },
        { action: 'create', type: 'TXT', name: '_dmarc.ejemplo.es' },
      ],
      errors: [],
      skipped: [{ type: 'TXT', name: 'ejemplo.es', reason: 'SPF existente' }],
    });
    expect(aviso).toEqual({
      message: 'DNS de ejemplo.es en Cloudflare: 2 registros creados; 1 conflicto sin modificar (ejemplo.es).',
      kind: 'info',
    });
    expect(aviso?.message).not.toMatch(/ajustad/);
  });

  it('distingue lo que no sea una alta y explica por qué no se ha pedido', () => {
    expect(
      avisoDnsCorreo('ejemplo.es', { applied: [{ action: 'update', type: 'TXT', name: 'ejemplo.es' }], errors: [], skipped: [] })?.message,
    ).toBe('DNS de ejemplo.es en Cloudflare: 1 registro modificado.');
    expect(avisoDnsCorreo('ejemplo.es', { applied: [], errors: [], skipped: [] })?.message).toBe(
      'DNS de ejemplo.es en Cloudflare: no faltaba ningún registro.',
    );
    expect(avisoDnsCorreo('ejemplo.es', null, 'Mailway antiguo.')).toEqual({
      message: 'DNS de ejemplo.es sin configurar automáticamente: Mailway antiguo.',
      kind: 'info',
    });
    expect(avisoDnsCorreo('ejemplo.es', null, null)).toBeNull();
  });
});
