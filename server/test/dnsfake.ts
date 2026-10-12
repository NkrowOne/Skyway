/**
 * DNS falso para todas las pruebas (lo instala `setup.ts`): ninguna depende
 * del DNS real, que en otra máquina daría otras respuestas (o ninguna). Se
 * sustituyen los métodos del resolutor de Node que usa Skyway (`domains.ts`):
 * A, AAAA, MX y CAA. Un nombre sin entrada responde «no existe» (ENOTFOUND);
 * uno de `fallan`, «no se pudo consultar» (ETIMEOUT).
 */
import dns from 'dns';
import { vi } from 'vitest';

export interface CaaFalso {
  critical: number;
  issue?: string;
  issuewild?: string;
  iodef?: string;
}

export const dnsFalso = {
  a: new Map<string, string[]>(),
  aaaa: new Map<string, string[]>(),
  mx: new Map<string, { exchange: string; priority: number }[]>(),
  caa: new Map<string, CaaFalso[]>(),
  /**
   * Consultas que fallan (sin respuesta del servidor DNS): «nombre» para
   * todas las de ese nombre, o «TIPO:nombre» (A, AAAA, MX, CAA) para una.
   */
  fallan: new Set<string>(),
};

export function reiniciarDns(): void {
  dnsFalso.a.clear();
  dnsFalso.aaaa.clear();
  dnsFalso.mx.clear();
  dnsFalso.caa.clear();
  dnsFalso.fallan.clear();
}

function responder<T>(tabla: Map<string, T[]>, tipo: string, nombre: string): T[] {
  const n = nombre.toLowerCase().replace(/\.$/, '');
  const consulta = `query${tipo}`;
  if (dnsFalso.fallan.has(n) || dnsFalso.fallan.has(`${tipo}:${n}`)) {
    throw Object.assign(new Error(`${consulta} ETIMEOUT ${n}`), { code: 'ETIMEOUT' });
  }
  const v = tabla.get(n);
  if (!v) throw Object.assign(new Error(`${consulta} ENOTFOUND ${n}`), { code: 'ENOTFOUND' });
  if (v.length === 0) throw Object.assign(new Error(`${consulta} ENODATA ${n}`), { code: 'ENODATA' });
  return v;
}

// El cuerpo de los métodos del resolutor es frontera con Node: se sustituye sin tipar.
const resolutor = dns.promises.Resolver.prototype as any;
vi.spyOn(resolutor, 'resolve4').mockImplementation(async (n: unknown) => responder(dnsFalso.a, 'A', String(n)));
vi.spyOn(resolutor, 'resolve6').mockImplementation(async (n: unknown) => responder(dnsFalso.aaaa, 'AAAA', String(n)));
vi.spyOn(resolutor, 'resolveMx').mockImplementation(async (n: unknown) => responder(dnsFalso.mx, 'MX', String(n)));
vi.spyOn(resolutor, 'resolveCaa').mockImplementation(async (n: unknown) => responder(dnsFalso.caa, 'CAA', String(n)));
