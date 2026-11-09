/**
 * Estado de la cola de remisión, persistido en `settings` (`verifactuRemision`)
 * para que sobreviva a un reinicio. Va por CADENA (emisor y entorno): cada una
 * es una cola independiente con sus esperas y sus fallos, de modo que una
 * cadena atascada (un NIF que la AEAT rechaza, el entorno de pruebas caído) no
 * deja sin remitir los registros de las demás. Módulo aparte para que lo lean
 * tanto la generación de registros (¿nace con incidencia?) como la cola.
 */
import { getSetting, setSetting } from '../db';
import type { EntornoVerifactu } from '../types';
import { safeParse } from '../util';

export interface EstadoCadena {
  /** Hasta cuándo pide esperar la AEAT antes del siguiente envío (ms). */
  esperaHasta: number;
  /** Hasta cuándo se espera tras un fallo (ms). */
  reintentoHasta: number;
  fallosSeguidos: number;
  /**
   * Registros que quedan por enviar de uno en uno tras un rechazo del envío
   * entero causado por un registro: así se encuentra el culpable sin frenar
   * a los demás.
   */
  aislarRestantes: number;
}

export interface EstadoCola {
  cadenas: Record<string, EstadoCadena>;
  // Resumen para el panel, por entorno: lo más restrictivo de sus cadenas.
  esperaHasta: Partial<Record<EntornoVerifactu, number>>;
  reintentoHasta: Partial<Record<EntornoVerifactu, number>>;
  fallosSeguidos: number;
  ultimoEnvioAt: number | null;
  ultimoResultado: 'correcto' | 'parcial' | 'incorrecto' | 'rechazado' | 'fallo' | null;
  ultimoCsv: string | null;
  ultimoError: string | null;
}

const CADENA_INICIAL: EstadoCadena = { esperaHasta: 0, reintentoHasta: 0, fallosSeguidos: 0, aislarRestantes: 0 };

export const claveCadena = (emisorNif: string, entorno: string): string => `${entorno}:${emisorNif}`;

export function getEstadoCola(): EstadoCola {
  const g = safeParse<Partial<EstadoCola>>(getSetting('verifactuRemision'), {});
  return {
    cadenas: g.cadenas && typeof g.cadenas === 'object' ? g.cadenas : {},
    esperaHasta: g.esperaHasta ?? {},
    reintentoHasta: g.reintentoHasta ?? {},
    fallosSeguidos: g.fallosSeguidos ?? 0,
    ultimoEnvioAt: g.ultimoEnvioAt ?? null,
    ultimoResultado: g.ultimoResultado ?? null,
    ultimoCsv: g.ultimoCsv ?? null,
    ultimoError: g.ultimoError ?? null,
  };
}

export function estadoCadena(estado: EstadoCola, emisorNif: string, entorno: string): EstadoCadena {
  return { ...CADENA_INICIAL, ...(estado.cadenas[claveCadena(emisorNif, entorno)] ?? {}) };
}

/** Guarda el estado recalculando el resumen por entorno que enseña el panel. */
export function guardarEstadoCola(e: EstadoCola): void {
  const esperaHasta: Partial<Record<EntornoVerifactu, number>> = {};
  const reintentoHasta: Partial<Record<EntornoVerifactu, number>> = {};
  let fallos = 0;
  for (const [clave, c] of Object.entries(e.cadenas)) {
    const entorno = clave.slice(0, clave.indexOf(':')) as EntornoVerifactu;
    esperaHasta[entorno] = Math.max(esperaHasta[entorno] ?? 0, c.esperaHasta);
    reintentoHasta[entorno] = Math.max(reintentoHasta[entorno] ?? 0, c.reintentoHasta);
    fallos = Math.max(fallos, c.fallosSeguidos);
  }
  setSetting('verifactuRemision', JSON.stringify({ ...e, esperaHasta, reintentoHasta, fallosSeguidos: fallos }));
}

/**
 * ¿Está la cadena en medio de una incidencia (último envío fallido o espera de
 * reintento)? Un registro generado ahora no se podrá remitir a su hora, así
 * que nace marcado y viajará con `Incidencia=S` (art. 16.4 de la Orden).
 */
export function cadenaEnIncidencia(emisorNif: string, entorno: string, ahora: number): boolean {
  const c = estadoCadena(getEstadoCola(), emisorNif, entorno);
  return c.fallosSeguidos > 0 || c.reintentoHasta > ahora;
}
