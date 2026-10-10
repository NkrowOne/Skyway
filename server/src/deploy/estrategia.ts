/**
 * Cómo se sustituye la versión en marcha de un servicio al desplegar y cómo se
 * detiene cada copia.
 *
 * Hasta ahora cualquier servicio sin volúmenes ni puerto público se desplegaba
 * «sin corte»: la versión nueva arrancaba (primero como copia de validación
 * «--next») mientras la anterior seguía en marcha. Para una web es lo correcto,
 * pero un bot de polling (Telegram, Discord…) o un worker no admiten dos copias
 * a la vez: la segunda recibe un 409 de `getUpdates`, o las dos procesan el
 * mismo trabajo. «Una sola copia» detiene la anterior (con parada limpia) antes
 * de arrancar la nueva.
 *
 * La elección automática no puede ser «sin puerto», que es lo que distingue a
 * un bot a simple vista: un servicio de repositorio siempre tiene puerto
 * interno (3000 por defecto). Un bot no tiene dominio, ni ruta de healthcheck,
 * ni otros servicios que lo llamen por la red interna; una API interna sí tiene
 * quien la llame y no debe quedarse sin servicio en cada despliegue.
 *
 * Todo lo de aquí es puro salvo `llamadoPorOtros` (y `estrategiaEfectiva`, que
 * lo usa), que lee las variables del proyecto: el desplegador lo calcula una
 * vez por despliegue.
 */

import { getEnv, getProjectVars, listServices } from '../db';
import type { DeployStrategy, GitConfig, ImageConfig, ServiceRow } from '../types';

/** Gracia de parada (SIGTERM → SIGKILL) si ni el servicio ni Railway dicen otra. */
export const GRACIA_PARADA_POR_DEFECTO = 30;
/** Más allá de 10 min, una parada bloquea despliegues y «Detener» sin motivo razonable. */
export const GRACIA_PARADA_MAXIMA = 600;
export const COMANDO_PARADA_MAXIMO = 1000;

export type MotivoEstrategia = 'elegida' | 'base_de_datos' | 'estado' | 'sin_trafico' | 'con_trafico';

export interface EstrategiaServicio {
  estrategia: DeployStrategy;
  motivo: MotivoEstrategia;
  /** true si no hay `deployStrategy` y la decide Skyway (motivos sin_trafico / con_trafico). */
  automatica: boolean;
}

export type OrigenGracia = 'servicio' | 'railway' | 'defecto';

const TEXTO_ESTRATEGIA: Record<DeployStrategy, string> = {
  recreate: 'una sola copia',
  overlap: 'sin corte',
};

const TEXTO_MOTIVO: Record<MotivoEstrategia, string> = {
  elegida: 'elegida en Ajustes',
  base_de_datos: 'base de datos',
  estado: 'tiene volúmenes o puerto público',
  sin_trafico: 'sin dominio, healthcheck ni llamadas de otros servicios',
  con_trafico: 'recibe tráfico: dominio, healthcheck o llamadas de otros servicios',
};

/**
 * Variables de sistema que delatan que otro servicio llama a este por la red
 * interna. `RAILWAY_PRIVATE_DOMAIN` es la forma con que llegan las referencias
 * de un proyecto importado de Railway.
 */
const VARIABLES_INTERNAS = new Set(['INTERNAL_URL', 'INTERNAL_HOST', 'INTERNAL_PORT', 'RAILWAY_PRIVATE_DOMAIN']);

/** El mismo patrón que `REF_RE` de variables.ts: lo que el resolvedor expande, y nada más. */
const REFERENCIA_RE = /\$\{\{\s*([A-Za-z0-9 _.-]+?)\.([A-Za-z0-9_]+)\s*\}\}/g;

function configDeApp(service: ServiceRow): GitConfig | ImageConfig {
  return service.config as GitConfig | ImageConfig;
}

function esEstrategia(v: unknown): v is DeployStrategy {
  return v === 'overlap' || v === 'recreate';
}

/**
 * Pura. Estrategia de despliegue del servicio, con estas reglas en este orden:
 *  1. Base de datos → una sola copia (dos motores sobre el mismo volumen lo corrompen).
 *  2. Volúmenes o puerto público → una sola copia, aunque se haya elegido «sin
 *     corte»: dos procesos no pueden escribir el mismo volumen ni publicar el
 *     mismo puerto del host.
 *  3. La elegida en Ajustes (`deployStrategy`).
 *  4. Automática: sin dominio, sin healthcheck y sin que otro servicio lo llame
 *     → una sola copia; si no, sin corte.
 */
export function estrategiaDespliegue(service: ServiceRow, llamadoPorOtros: boolean): EstrategiaServicio {
  if (service.type === 'database') return { estrategia: 'recreate', motivo: 'base_de_datos', automatica: false };
  const cfg = configDeApp(service);
  if ((cfg.volumes?.length ?? 0) > 0 || !!cfg.hostPort) {
    return { estrategia: 'recreate', motivo: 'estado', automatica: false };
  }
  if (esEstrategia(cfg.deployStrategy)) return { estrategia: cfg.deployStrategy, motivo: 'elegida', automatica: false };
  const conDominio = (cfg.domains?.length ?? 0) > 0;
  const conHealthcheck = typeof cfg.healthcheckPath === 'string' && cfg.healthcheckPath.trim() !== '';
  if (!conDominio && !conHealthcheck && !llamadoPorOtros) {
    return { estrategia: 'recreate', motivo: 'sin_trafico', automatica: true };
  }
  return { estrategia: 'overlap', motivo: 'con_trafico', automatica: true };
}

function escaparRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pura. ¿Algún valor referencia este servicio por la red interna?
 * `${{<nombre|slug>.INTERNAL_URL|INTERNAL_HOST|INTERNAL_PORT|RAILWAY_PRIVATE_DOMAIN}}`
 * (mismo criterio de nombre que `findSibling` en variables.ts: nombre sin
 * mayúsculas o slug) o la dirección literal `<slug>:<puerto>` / `<slug>.railway.internal`
 * no precedida de letra, cifra, punto o guion.
 *
 * La dirección literal exige el puerto (o el sufijo de Railway) para no
 * confundir `api` con cualquier palabra: `scope=api:read` o
 * `https://api.example.com` no son llamadas a este servicio. `${{api.PUBLIC_URL}}`
 * tampoco cuenta: entra por el dominio, y eso ya lo dice la regla del dominio.
 */
export function referenciaInterna(valores: Iterable<string>, service: Pick<ServiceRow, 'name' | 'slug'>): boolean {
  const nombre = service.name.trim().toLowerCase();
  const slug = service.slug;
  const esEste = (scope: string): boolean => {
    const n = scope.trim().toLowerCase();
    return n === nombre || n === slug;
  };
  const s = escaparRegExp(slug);
  // Sin `g`: `test` con estado entre valores daría falsos negativos.
  const literal = new RegExp(`(?<![A-Za-z0-9.-])${s}(?::[0-9]{2,5}(?![0-9])|\\.railway\\.internal(?![A-Za-z0-9-]))`, 'i');
  for (const valor of valores) {
    if (typeof valor !== 'string' || valor === '') continue;
    for (const m of valor.matchAll(REFERENCIA_RE)) {
      if (VARIABLES_INTERNAS.has(m[2]) && esEste(m[1])) return true;
    }
    if (literal.test(valor)) return true;
  }
  return false;
}

/**
 * ¿Lo llama otro servicio del proyecto por la red interna? Lee las variables
 * compartidas del proyecto y las de los DEMÁS servicios: las propias no cuentan
 * (un servicio que se nombra a sí mismo no recibe tráfico por ello).
 */
export function llamadoPorOtros(service: ServiceRow): boolean {
  const valores: string[] = Object.values(getProjectVars(service.project_id));
  for (const otro of listServices(service.project_id)) {
    if (otro.id === service.id) continue;
    valores.push(...Object.values(getEnv(otro.id)));
  }
  return referenciaInterna(valores, service);
}

/**
 * estrategiaDespliegue(service, llamadoPorOtros(service)). Solo lee la base
 * cuando hace falta: si el servicio tiene dominio, volúmenes o una estrategia
 * elegida, las llamadas de otros no cambian el resultado.
 */
export function estrategiaEfectiva(service: ServiceRow): EstrategiaServicio {
  const sinLlamadas = estrategiaDespliegue(service, false);
  if (sinLlamadas.motivo !== 'sin_trafico') return sinLlamadas;
  return estrategiaDespliegue(service, llamadoPorOtros(service));
}

/**
 * Pura. `stopGraceSeconds` entero 0–600 → 'servicio'; si no,
 * `env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (solo dígitos, ≤600) → 'railway';
 * si no, 30 → 'defecto'. `env` es el entorno resuelto del servicio.
 *
 * La variable de Railway es justo el plazo SIGTERM → SIGKILL de Railway: una
 * app migrada que la fijó espera ese plazo. Un valor que no se entiende (texto,
 * negativo o más de 600) se descarta en vez de recortarse: no se adivina lo que
 * quiso decir quien lo escribió.
 */
export function graciaParada(service: ServiceRow, env: Record<string, string>): { segundos: number; origen: OrigenGracia } {
  const propia = (service.config as { stopGraceSeconds?: unknown }).stopGraceSeconds;
  if (typeof propia === 'number' && Number.isInteger(propia) && propia >= 0 && propia <= GRACIA_PARADA_MAXIMA) {
    return { segundos: propia, origen: 'servicio' };
  }
  const railway = env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS;
  if (typeof railway === 'string') {
    const t = railway.trim();
    if (/^[0-9]+$/.test(t) && Number(t) <= GRACIA_PARADA_MAXIMA) return { segundos: Number(t), origen: 'railway' };
  }
  return { segundos: GRACIA_PARADA_POR_DEFECTO, origen: 'defecto' };
}

/**
 * Pura. `stopCommand` sin espacios alrededor, o null si no hay (siempre null en
 * bases de datos: su parada la gobierna el motor). Un comando de más de 1000
 * caracteres (solo puede llegar sin pasar por la API, que lo rechaza) o con un
 * carácter nulo, que no cabe en una variable de entorno, devuelve null en vez
 * de recortarse: un comando partido podría hacer otra cosa.
 */
export function comandoParada(service: ServiceRow): string | null {
  if (service.type === 'database') return null;
  const raw = configDeApp(service).stopCommand;
  if (typeof raw !== 'string') return null;
  const comando = raw.trim();
  if (comando === '' || comando.length > COMANDO_PARADA_MAXIMO || comando.includes('\0')) return null;
  return comando;
}

/** Texto para el registro: «una sola copia (sin dominio, healthcheck ni llamadas de otros servicios)». */
export function describirEstrategia(e: EstrategiaServicio): string {
  return `${TEXTO_ESTRATEGIA[e.estrategia]} (${TEXTO_MOTIVO[e.motivo]})`;
}
