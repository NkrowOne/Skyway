/**
 * Sustitución de variables en un cambio de dominio (dominio.es → dominio2.es).
 * Módulo puro: recibe los valores y el mapa, y devuelve el plan; quien llama
 * (`domainmigration.ts`) lee la base, guarda la instantánea y escribe.
 *
 * Por qué un MAPA EXACTO y no «sustituir dominio.es por dominio2.es»: un
 * proyecto suele tener nombres de dominio.es que no sirve (la base de datos en
 * `db.dominio.es`, un buzón `contacto@dominio.es` que no está en Mailway). Un
 * reemplazo por sufijo los cambiaría por nombres que no existen y rompería la
 * conexión. Aquí solo cambian los hosts que sirve el proyecto y las
 * direcciones que se mudan; el resto se enseña («no se cambia») y se deja.
 *
 * Reglas:
 * - una sola pasada con una alternancia de la cadena más larga a la más corta:
 *   con a→b y b→c, «a» queda en «b» (nunca en «c»);
 * - sin distinguir mayúsculas y sin tocar nunca lo que va dentro de `${{…}}`
 *   (las referencias se resuelven solas al desplegar);
 * - el cálculo parte siempre del valor ORIGINAL (la instantánea): repetirlo da
 *   el mismo resultado aunque un dominio sea subdominio del otro.
 */
import crypto from 'crypto';
import { getDomain } from 'tldts';

export type AmbitoVariable = 'service' | 'project' | 'build';

export interface MapaCambio {
  /** Solo los hosts servidos por el proyecto con modo `redirigir` o `servir`. */
  hosts: { from: string; to: string }[];
  /** Buzones y alias que se mudan (plan de Mailway). */
  direcciones: { from: string; to: string }[];
}

export interface ValorVariable {
  ambito: AmbitoVariable;
  /** null para las variables compartidas del proyecto. */
  serviceId: string | null;
  key: string;
  valor: string;
  /**
   * `service_managed_env.origin` si la escribió Skyway y nadie la ha cambiado
   * (entonces se reescribe con `writeManagedEnv`, conservando el origen); null
   * si no. Las de origen `mail.*` no entran aquí: las refresca el correo
   * (`refrescarVariablesCorreo`), que sabe qué usuario y qué remitente tocan.
   */
  origen: string | null;
}

/** Variable identificada por su ámbito, su servicio y su nombre. */
export interface ClaveVariable {
  ambito: AmbitoVariable;
  serviceId: string | null;
  key: string;
}

export interface CambioPropuesto {
  ambito: AmbitoVariable;
  serviceId: string | null;
  key: string;
  ocurrencias: number;
  antes: string;
  despues: string;
  gestionada: string | null;
  /** Menciones de dominio.es (o de sus subdominios) que no se cambian, p. ej. `db.dominio.es`. */
  sinMapa: string[];
  /** El usuario la ha desmarcado: se enseña, pero no se aplica. */
  excluida: boolean;
}

export interface AvisoSinMapa {
  ambito: AmbitoVariable;
  key: string;
  serviceId: string | null;
  nombres: string[];
}

export interface PlanVariables {
  /** Variables con algo que cambiar (también las excluidas, marcadas). */
  cambios: CambioPropuesto[];
  /** Todas las variables que mencionan nombres de dominio.es que no se cambian. */
  avisosSinMapa: AvisoSinMapa[];
  /** sha256 de `(ámbito, servicio, clave, sha256(antes), excluida)` de cada cambio, en orden. */
  huella: string;
}

// ---------- búsqueda ----------

/** Tras un nombre: ni otra letra del nombre ni un punto seguido de más nombre (`dominio.es.mx`). */
const FIN = '(?![A-Za-z0-9-]|\\.[A-Za-z0-9])';
/**
 * Antes de un host: ni una letra del nombre ni «@» (sería una dirección:
 * `contacto@dominio.es` no cambia por servir `dominio.es`), ni un punto pegado
 * a otro nombre (`www.dominio.es` no es `dominio.es`). Un punto suelto sí:
 * `.dominio.es` es el dominio de una cookie que cubre al host servido.
 */
const ANTES_HOST = '(?<![A-Za-z0-9@-])(?<![A-Za-z0-9@.-]\\.)';
/** Antes de una dirección: nada que pueda ser parte de su parte local. */
const ANTES_DIRECCION = '(?<![A-Za-z0-9._%+-])';
/** Para encontrar el principio de cualquier nombre (las menciones sin mapa). */
const ANTES_NOMBRE = '(?<![A-Za-z0-9-])(?<![A-Za-z0-9-]\\.)';
/** Referencias a otras variables: `${{servicio.VARIABLE}}`. */
const REFERENCIA = /\$\{\{[\s\S]*?\}\}/g;

function escapar(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizar(s: string): string {
  return s.trim().toLowerCase().replace(/\.$/, '');
}

interface MapaCompilado {
  regex: RegExp | null;
  destino: Map<string, string>;
}

function compilar(mapa: MapaCambio): MapaCompilado {
  const destino = new Map<string, string>();
  const alternativas: { texto: string; patron: string }[] = [];
  const anadir = (from: string, to: string, antes: string) => {
    const f = normalizar(from);
    const t = normalizar(to);
    // Un mismo origen con dos destinos: manda el primero (el plan no los genera).
    if (!f || !t || f === t || destino.has(f)) return;
    destino.set(f, t);
    alternativas.push({ texto: f, patron: `${antes}${escapar(f)}${FIN}` });
  };
  for (const h of mapa.hosts) anadir(h.from, h.to, ANTES_HOST);
  for (const d of mapa.direcciones) anadir(d.from, d.to, ANTES_DIRECCION);
  if (alternativas.length === 0) return { regex: null, destino };
  // De la más larga a la más corta: en la misma posición gana el nombre completo.
  alternativas.sort((a, b) => b.texto.length - a.texto.length || a.texto.localeCompare(b.texto));
  return { regex: new RegExp(alternativas.map((a) => `(?:${a.patron})`).join('|'), 'gi'), destino };
}

/** Trozos del valor fuera de `${{…}}` (con su posición) y dentro (intocables). */
function trozos(valor: string): { texto: string; inicio: number; referencia: boolean }[] {
  const out: { texto: string; inicio: number; referencia: boolean }[] = [];
  let ultimo = 0;
  for (const m of valor.matchAll(REFERENCIA)) {
    const i = m.index ?? 0;
    if (i > ultimo) out.push({ texto: valor.slice(ultimo, i), inicio: ultimo, referencia: false });
    out.push({ texto: m[0], inicio: i, referencia: true });
    ultimo = i + m[0].length;
  }
  if (ultimo < valor.length) out.push({ texto: valor.slice(ultimo), inicio: ultimo, referencia: false });
  return out;
}

interface Analisis {
  valor: string;
  ocurrencias: number;
  sinMapa: string[];
}

function analizar(valor: string, mapa: MapaCompilado, fromDomain: string | null): Analisis {
  let salida = '';
  let ocurrencias = 0;
  const sustituidos: [number, number][] = [];
  const partes = trozos(valor);
  for (const p of partes) {
    if (p.referencia || !mapa.regex) {
      salida += p.texto;
      continue;
    }
    salida += p.texto.replace(mapa.regex, (encontrado: string, offset: number) => {
      const to = mapa.destino.get(encontrado.toLowerCase());
      if (to === undefined) return encontrado;
      ocurrencias++;
      sustituidos.push([p.inicio + offset, p.inicio + offset + encontrado.length]);
      return to;
    });
  }
  return { valor: salida, ocurrencias, sinMapa: fromDomain ? menciones(valor, partes, fromDomain, sustituidos) : [] };
}

/**
 * Nombres de `fromDomain` (o de sus subdominios) y direcciones suyas que
 * aparecen en el valor original y NO se sustituyen. En una URL con usuario
 * (`postgres://u:clave@db.dominio.es`) se enseña el host, no `clave@…`.
 */
function menciones(
  valor: string,
  partes: { texto: string; inicio: number; referencia: boolean }[],
  fromDomain: string,
  sustituidos: [number, number][],
): string[] {
  const regex = new RegExp(`${ANTES_NOMBRE}(?:[A-Za-z0-9-]+\\.)*${escapar(fromDomain)}${FIN}`, 'gi');
  const cubierto = (a: number, b: number) => sustituidos.some(([s, e]) => s < b && a < e);
  const out: string[] = [];
  for (const p of partes) {
    if (p.referencia) continue;
    for (const m of p.texto.matchAll(regex)) {
      const inicio = p.inicio + (m.index ?? 0);
      const fin = inicio + m[0].length;
      const nombre = m[0].toLowerCase();
      if (valor[inicio - 1] !== '@') {
        if (!cubierto(inicio, fin)) out.push(nombre);
        continue;
      }
      // Precedido de «@»: o una dirección o el usuario de una URL.
      let local = inicio - 1;
      while (local > 0 && /[A-Za-z0-9._%+-]/.test(valor[local - 1])) local--;
      const parteLocal = valor.slice(local, inicio - 1);
      const previo = valor[local - 1];
      const esDireccion =
        parteLocal !== '' && (previo === undefined || (previo !== ':' && previo !== '/') || /mailto:$/i.test(valor.slice(0, local)));
      if (esDireccion) {
        if (!cubierto(local, fin)) out.push(`${parteLocal.toLowerCase()}@${nombre}`);
      } else if (!cubierto(inicio, fin)) {
        out.push(nombre);
      }
    }
  }
  return [...new Set(out)];
}

/** Aplica el mapa a un valor (siempre al original). */
export function aplicarMapa(valor: string, mapa: MapaCambio): { valor: string; ocurrencias: number } {
  const r = analizar(valor, compilar(mapa), null);
  return { valor: r.valor, ocurrencias: r.ocurrencias };
}

/** Texto de una mención sin mapa para la interfaz. */
export function mensajeSinMapa(nombre: string, key?: string): string {
  if (nombre.includes('@')) {
    return key
      ? `${nombre} aparece en ${key}, pero no es un buzón ni un alias que se mude: no se cambia.`
      : `${nombre} no es un buzón ni un alias que se mude: no se cambia.`;
  }
  return key
    ? `${nombre} aparece en ${key}, pero no lo sirve este proyecto: no se cambia.`
    : `${nombre} no lo sirve este proyecto: no se cambia.`;
}

const ORDEN_AMBITO: Record<AmbitoVariable, number> = { project: 0, service: 1, build: 2 };

function claveDe(c: ClaveVariable): string {
  return `${c.ambito}\u0000${c.serviceId ?? ''}\u0000${c.key}`;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Plan de variables del cambio: qué cambia, qué menciones se dejan y la huella
 * con la que «Pasar» comprueba que nada ha cambiado desde la vista previa (otra
 * persona editando una variable, un valor nuevo que menciona el dominio…).
 * `excluidas` son las que el usuario ha desmarcado: siguen en `cambios`, con
 * `excluida`, y cuentan en la huella.
 */
export function planificar(
  valores: ValorVariable[],
  mapa: MapaCambio,
  fromDomain: string,
  opciones: { excluidas?: readonly ClaveVariable[] } = {},
): PlanVariables {
  const compilado = compilar(mapa);
  const from = normalizar(fromDomain) || null;
  const excluidas = new Set((opciones.excluidas ?? []).map(claveDe));
  const cambios: CambioPropuesto[] = [];
  const avisosSinMapa: AvisoSinMapa[] = [];
  for (const v of valores) {
    if (v.origen?.startsWith('mail.')) continue;
    const r = analizar(v.valor, compilado, from);
    if (r.sinMapa.length > 0) avisosSinMapa.push({ ambito: v.ambito, key: v.key, serviceId: v.serviceId, nombres: r.sinMapa });
    if (r.ocurrencias === 0) continue;
    cambios.push({
      ambito: v.ambito,
      serviceId: v.serviceId,
      key: v.key,
      ocurrencias: r.ocurrencias,
      antes: v.valor,
      despues: r.valor,
      gestionada: v.origen ?? null,
      sinMapa: r.sinMapa,
      excluida: excluidas.has(claveDe(v)),
    });
  }
  const orden = (a: ClaveVariable, b: ClaveVariable) =>
    ORDEN_AMBITO[a.ambito] - ORDEN_AMBITO[b.ambito] ||
    (a.serviceId ?? '').localeCompare(b.serviceId ?? '') ||
    a.key.localeCompare(b.key);
  cambios.sort(orden);
  avisosSinMapa.sort(orden);
  const huella = sha256(JSON.stringify(cambios.map((c) => [c.ambito, c.serviceId ?? '', c.key, sha256(c.antes), c.excluida])));
  return { cambios, avisosSinMapa, huella };
}

// ---------- WordPress ----------

const INICIO_WORDPRESS = '/* skyway:cambio-de-dominio */';
const FIN_WORDPRESS = '/* fin */';
const BLOQUE_WORDPRESS = /\n?\/\* skyway:cambio-de-dominio \*\/[\s\S]*?\/\* fin \*\//g;

/** Cadena PHP entre comillas simples. */
function php(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Añade (o sustituye) el bloque que fija la URL de WordPress en
 * `WORDPRESS_CONFIG_EXTRA`. Sin él, WordPress redirige a la URL que guarda en
 * su base de datos (la vieja) y la redirección de Skyway devuelve a la nueva:
 * un bucle. Idempotente: aplicarlo dos veces deja un solo bloque.
 */
export function anadirBloqueWordpress(extra: string, urlPrincipal: string): string {
  const url = php(urlPrincipal.trim());
  const bloque = `${INICIO_WORDPRESS}define('WP_HOME','${url}');define('WP_SITEURL','${url}');${FIN_WORDPRESS}`;
  const base = quitarBloqueWordpress(extra);
  return base ? `${base}\n${bloque}` : bloque;
}

/** Quita el bloque (y el salto de línea con el que se añadió): deja el valor como estaba. */
export function quitarBloqueWordpress(extra: string): string {
  return extra.replace(BLOQUE_WORDPRESS, '');
}

// ---------- avisos ----------

/**
 * Avisos informativos según las variables y las pilas del proyecto: lo que el
 * cambio no puede hacer por sí solo (dar de alta la URL nueva en un proveedor
 * externo, corregir las URL guardadas en la base de datos). No bloquean nada.
 * `hostViejo`, si se conoce, completa la orden de WordPress.
 */
export function avisosDeVariables(claves: string[], pilas: string[], hostNuevo: string, hostViejo?: string): string[] {
  const k = claves.map((c) => c.toUpperCase());
  const nuevo = normalizar(hostNuevo);
  const registrable = getDomain(nuevo) ?? nuevo;
  const out: string[] = [];
  if (k.some((c) => c === 'NEXTAUTH_URL' || c === 'AUTH_URL')) {
    out.push(`Añade https://${nuevo}/api/auth/callback/<proveedor> en cada proveedor de inicio de sesión.`);
  }
  if (k.includes('GOOGLE_CLIENT_ID')) {
    out.push(`Google Cloud → Credenciales: añade https://${nuevo} como origen autorizado y su URL de vuelta.`);
  }
  if (k.includes('GITHUB_CLIENT_ID')) {
    out.push('GitHub → Developer settings → OAuth Apps: cambia la Authorization callback URL.');
  }
  if (k.some((c) => c.startsWith('STRIPE_'))) {
    out.push(
      `Stripe → Webhooks: crea el endpoint en https://${nuevo}/… (Stripe no sigue redirecciones) y actualiza STRIPE_WEBHOOK_SECRET.`,
    );
  }
  if (k.some((c) => c.startsWith('TURNSTILE_') || c.startsWith('RECAPTCHA_'))) {
    out.push(`Añade ${registrable} a los nombres permitidos del widget.`);
  }
  if (k.some((c) => c.includes('COOKIE_DOMAIN'))) {
    out.push('Las sesiones abiertas se cerrarán al pasar.');
  }
  if (pilas.some((p) => p.toLowerCase() === 'wordpress')) {
    const viejo = hostViejo ? normalizar(hostViejo) : null;
    out.push(
      viejo
        ? `Haz una copia de la base de datos y ejecuta wp search-replace 'https://${viejo}' 'https://${nuevo}' --all-tables. ` +
            'Mientras tanto, la redirección mantiene funcionando los enlaces.'
        : `Haz una copia de la base de datos y ejecuta wp search-replace con la dirección antigua y 'https://${nuevo}' --all-tables. ` +
            'Mientras tanto, la redirección mantiene funcionando los enlaces.',
    );
  }
  return out;
}
