import { beforeEach, describe, expect, it } from 'vitest';
import { clearLiveSnapshot, liveSnapshot, publishLiveSnapshot } from '../src/livemetrics';
import { MetricsSnapshot } from '../src/types';

function foto(ts: number, services: MetricsSnapshot['services']): MetricsSnapshot {
  return { ts, docker: true, services };
}

const parado = () => ({ state: 'exited' as const, stats: null, replicas: { running: 0, total: 1 } });
const activo = (cpu: number) => ({
  state: 'running' as const,
  stats: { cpuPercent: cpu, memUsage: 1024, memLimit: 4096, netRx: 10, netTx: 20 },
  replicas: { running: 1, total: 1 },
});

describe('almacén de métricas en vivo', () => {
  beforeEach(() => clearLiveSnapshot());

  it('conserva la identidad de las entradas que no cambian entre fotos', () => {
    publishLiveSnapshot(foto(1, { a: parado(), b: activo(50) }));
    const antes = liveSnapshot()!.services;
    publishLiveSnapshot(foto(2, { a: parado(), b: activo(50) }));
    const despues = liveSnapshot()!.services;
    // Misma identidad → `memo`/`useSyncExternalStore` no repintan.
    expect(despues.a).toBe(antes.a);
    expect(despues.b).toBe(antes.b);
    expect(liveSnapshot()!.ts).toBe(2);
  });

  it('una cifra distinta da una entrada nueva, pero las partes iguales siguen siendo las mismas', () => {
    publishLiveSnapshot(foto(1, { b: activo(50) }));
    const antes = liveSnapshot()!.services.b;
    publishLiveSnapshot(foto(2, { b: activo(75) }));
    const despues = liveSnapshot()!.services.b;
    expect(despues).not.toBe(antes);
    expect(despues.stats?.cpuPercent).toBe(75);
    // Las réplicas no cambiaron: la cabecera del drawer, que solo las mira, no se repinta.
    expect(despues.replicas).toBe(antes.replicas);
  });

  it('un cambio de estado o de réplicas sí renueva la entrada', () => {
    publishLiveSnapshot(foto(1, { a: parado() }));
    const antes = liveSnapshot()!.services.a;
    publishLiveSnapshot(foto(2, { a: { ...parado(), state: 'running' } }));
    expect(liveSnapshot()!.services.a).not.toBe(antes);
  });

  it('se vacía al cambiar de proyecto', () => {
    publishLiveSnapshot(foto(1, { a: parado() }));
    clearLiveSnapshot();
    expect(liveSnapshot()).toBeNull();
  });
});
