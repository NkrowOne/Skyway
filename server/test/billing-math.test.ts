import { describe, expect, it } from 'vitest';

// `roundCents` y `cuota` no se exportan de routes/billing.ts: se replican aquí
// tal cual para fijar la aritmética de la que depende `computeTotals` (la
// rectificativa por anulación debe netear EXACTAMENTE la original).
function roundCents(x: number): number {
  const r = Math.round(Math.abs(x));
  return (x < 0 ? -r : r) || 0;
}
function pct(base: number, rate: number): number {
  return roundCents((base * rate) / 100);
}

interface Line {
  qty: number;
  unitCents: number;
  taxRate: number;
  irpfRate: number;
}

function totals(lines: Line[]) {
  const amounts = lines.map((l) => roundCents(l.qty * l.unitCents));
  const subtotal = amounts.reduce((s, a) => s + a, 0);
  const byRate = new Map<number, number>();
  const byIrpf = new Map<number, number>();
  lines.forEach((l, i) => {
    byRate.set(l.taxRate, (byRate.get(l.taxRate) ?? 0) + amounts[i]);
    byIrpf.set(l.irpfRate, (byIrpf.get(l.irpfRate) ?? 0) + amounts[i]);
  });
  const breakdown = [...byRate.entries()].map(([rate, base]) => ({ rate, base, quota: pct(base, rate) }));
  const tax = breakdown.reduce((s, b) => s + b.quota, 0);
  let irpf = 0;
  for (const [rate, base] of byIrpf) irpf += pct(base, rate);
  return { amounts, subtotal, breakdown, tax, irpf, total: subtotal + tax - irpf };
}

// Reversa igual que la ruta /rectify: se niega el IMPORTE ya calculado, qty 1.
function reversal(lines: Line[]): Line[] {
  const { amounts } = totals(lines);
  return lines.map((l, i) => ({ qty: 1, unitCents: -amounts[i], taxRate: l.taxRate, irpfRate: l.irpfRate }));
}

const RATES = [0, 4, 5, 7, 10, 12, 15, 19, 21, 2.1, 5.2, 7.5, 0.5, 33.3];

describe('redondeo de cuotas', () => {
  it('base × (tipo / 100) y (base × tipo) / 100 no redondean igual en todas las bases', () => {
    // Es el motivo de multiplicar ANTES de dividir: `rate / 100` arrastra error
    // de coma flotante y en algunas bases cambia el céntimo.
    let divergen = 0;
    for (let base = -100_000; base <= 100_000; base += 1) {
      for (const r of RATES) {
        if (Math.round(base * (r / 100)) !== Math.round((base * r) / 100)) divergen++;
      }
    }
    expect(divergen).toBeGreaterThan(0);
  });

  it('Math.round no es simétrico en las mitades exactas; roundCents sí', () => {
    expect(Math.round((1005 * 10) / 100)).toBe(101);
    expect(Math.round((-1005 * 10) / 100)).toBe(-100);
    let asimetrias = 0;
    let simetrias = 0;
    for (let base = 1; base <= 100_000; base += 1) {
      for (const r of RATES) {
        if (Math.round((base * r) / 100) + Math.round((-base * r) / 100) !== 0) asimetrias++;
        if (pct(base, r) + pct(-base, r) !== 0) simetrias++;
      }
    }
    expect(asimetrias).toBeGreaterThan(0);
    expect(simetrias).toBe(0);
  });

  it('roundCents nunca devuelve −0', () => {
    expect(Object.is(roundCents(-0.2), 0)).toBe(true);
    expect(Object.is(roundCents(-0), 0)).toBe(true);
  });
});

describe('totales de factura y reversa', () => {
  it('la reversa netea exactamente base, IVA, IRPF y total en 2000 facturas aleatorias', () => {
    // Generador con semilla fija: cada ejecución prueba las mismas facturas.
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const ivas = [21, 10, 4, 0, 5, 7.5];
    const irpfs = [0, 7, 15, 19];
    let casos = 0;
    for (let k = 0; k < 2000; k++) {
      const n = 1 + rnd(6);
      const lines: Line[] = [];
      for (let i = 0; i < n; i++) {
        lines.push({
          qty: rnd(3) === 0 ? rnd(1000) / 100 : 1 + rnd(20),
          unitCents: rnd(200000) - 20000,
          taxRate: ivas[rnd(ivas.length)],
          irpfRate: irpfs[rnd(irpfs.length)],
        });
      }
      const orig = totals(lines);
      const rev = totals(reversal(lines));
      expect(orig.subtotal + rev.subtotal, 'base').toBe(0);
      expect(orig.tax + rev.tax, `IVA ${JSON.stringify(lines)}`).toBe(0);
      expect(orig.irpf + rev.irpf, `IRPF ${JSON.stringify(lines)}`).toBe(0);
      expect(orig.total + rev.total, 'total').toBe(0);
      // El desglose por tipos cuadra con la base imponible.
      expect(orig.breakdown.reduce((s, b) => s + b.base, 0)).toBe(orig.subtotal);
      casos++;
    }
    expect(casos).toBe(2000);
  });

  it('10,05 € al 10 % da 1,01 € y su reversa −1,01 € (el caso que antes no neteaba)', () => {
    const l = [{ qty: 1, unitCents: 1005, taxRate: 10, irpfRate: 0 }];
    expect(totals(l).tax).toBe(101);
    expect(totals(reversal(l)).tax).toBe(-101);
  });

  it('factura tipo: tres líneas al 21 %, una exenta y retención del 15 % en una', () => {
    const f = totals([
      { qty: 1, unitCents: 10000, taxRate: 21, irpfRate: 0 },
      { qty: 2.5, unitCents: 1999, taxRate: 21, irpfRate: 0 },
      { qty: 1, unitCents: 30000, taxRate: 21, irpfRate: 15 },
      { qty: 1, unitCents: 5000, taxRate: 0, irpfRate: 0 },
    ]);
    // 2,5 × 19,99 = 49,975 → 49,98; base al 21 % = 449,98 → IVA 94,4958 → 94,50
    expect(f.amounts[1]).toBe(4998);
    expect(f.tax).toBe(9450);
    expect(f.irpf).toBe(4500);
    expect(f.total).toBe(10000 + 4998 + 30000 + 5000 + 9450 - 4500);
  });

  it('el descuento por grupo nunca supera la base y es simétrico', () => {
    expect(Math.min(4998, pct(4998, 100))).toBe(4998);
    expect(pct(4998, 33)).toBe(1649); // 1649,34
    expect(pct(-1005, 10)).toBe(-101);
  });
});
