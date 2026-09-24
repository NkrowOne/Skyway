import { describe, expect, it } from 'vitest';
import { baselineFrom, cpuPercentFromBaseline, cpuPercentFromDocker, DockerStatsSample } from '../src/docker/cpu';

/** Muestra de Docker con `n` ns de CPU del contenedor y `sys` ns del host (4 núcleos). */
function sample(id: string, n: number, sys: number, extra: Partial<DockerStatsSample> = {}): DockerStatsSample {
  return { id, cpu_stats: { cpu_usage: { total_usage: n }, system_cpu_usage: sys, online_cpus: 4 }, ...extra };
}

describe('CPU a partir de stats de Docker', () => {
  it('sin línea base no hay porcentaje (hace falta una lectura anterior)', () => {
    expect(cpuPercentFromBaseline(sample('c1', 1000, 4000), undefined)).toBeNull();
  });

  it('resta contra la lectura anterior con la fórmula de docker stats', () => {
    const base = baselineFrom(sample('c1', 1_000_000, 8_000_000), 1);
    // El contenedor consumió 2 s de CPU en 4 s de host × 4 núcleos: dos núcleos enteros.
    const cur = sample('c1', 3_000_000, 12_000_000);
    expect(cpuPercentFromBaseline(cur, base)).toBeCloseTo(200, 5);
  });

  it('un contenedor recreado con el mismo nombre no comparte contadores', () => {
    const base = baselineFrom(sample('c1', 5_000_000, 8_000_000), 1);
    expect(cpuPercentFromBaseline(sample('c2', 100, 12_000_000), base)).toBeNull();
  });

  it('contadores que retroceden (reinicio) o sin avance del host invalidan la línea base', () => {
    const base = baselineFrom(sample('c1', 5_000_000, 8_000_000), 1);
    expect(cpuPercentFromBaseline(sample('c1', 100, 12_000_000), base)).toBeNull();
    expect(cpuPercentFromBaseline(sample('c1', 6_000_000, 8_000_000), base)).toBeNull();
  });

  it('una muestra sin id se compara por nombre (línea base con id vacío)', () => {
    const base = baselineFrom({ cpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0, online_cpus: 2 } }, 1);
    const cur: DockerStatsSample = { cpu_stats: { cpu_usage: { total_usage: 1_000 }, system_cpu_usage: 4_000, online_cpus: 2 } };
    expect(cpuPercentFromBaseline(cur, base)).toBeCloseTo(50, 5);
  });

  it('la lectura de dos muestras de Docker usa precpu_stats', () => {
    const s = sample('c1', 3_000_000, 12_000_000, {
      precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 8_000_000 },
    });
    expect(cpuPercentFromDocker(s)).toBeCloseTo(200, 5);
    // Sobre una muestra one-shot (sin precpu_stats) la fórmula de Docker divide
    // acumulado entre acumulado y sale un número que no es el consumo actual:
    // por eso el porcentaje de esas muestras se calcula con la línea base propia.
    expect(cpuPercentFromDocker(sample('c1', 3_000_000, 12_000_000))).toBe(100);
    // Sin avance de ninguno de los dos contadores: 0, nunca un valor inventado.
    expect(cpuPercentFromDocker({ cpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 10 }, precpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 10 } })).toBe(0);
  });
});
