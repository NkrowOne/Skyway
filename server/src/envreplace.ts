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
 *   el mismo resultado aunque un dominio sea subdominio del otro;
 * - un usuario para entrar no cambia (`SMTP_USER`, `MAIL_USERNAME`, uno con
 *   prefijo propio como `TG_SMTP_LOGIN`… o el usuario de una URL): tras pasar,
 *   el buzón sigue entrando con su dirección anterior hasta que se actualiza,
 *   y la aplicación dejaría de enviar.
 */
import crypto from 'crypto';
import { getDomain } from 'tldts';
import { mailRoleLoose } from './mailenv';
import type { ProveedorWebhook } from './types';

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
  /**
   * Direcciones que se mudan, pero que la variable usa como usuario para
   * entrar (`SMTP_USER`, el usuario de una URL): no se cambian al pasar
   * (`mensajeUsuario`). Las que escribió Skyway (`mail.smtp.user`) las
   * actualiza la baja con `refrescarVariablesCorreo`.
   */
  usuarios: AvisoSinMapa[];
  /** sha256 de `(ámbito, servicio, clave, sha256(antes), excluida)` de cada cambio, en orden. */
  huella: string;
}

// ---------- búsqueda ----------

/**
 * Cada `${{…}}` se tapa con este carácter (la misma longitud, para conservar
 * las posiciones) y la búsqueda se hace sobre el valor entero. Así una
 * referencia pegada a la IZQUIERDA de un nombre cuenta como parte de él:
 * `${{api.SUB}}.dominio.es` es un subdominio que se decide al desplegar, no
 * el dominio de una cookie, y no se cambia. A la DERECHA es un límite:
 * `https://www.dominio.es${{web.RUTA}}` sigue siendo el host servido.
 */
const TAPA = '\u0001';
/** Tras un nombre: ni otra letra del nombre ni un punto seguido de más nombre (`dominio.es.mx`, `dominio.es.${{X}}`). */
const FIN = '(?![A-Za-z0-9-]|\\.[A-Za-z0-9\\u0001])';
/**
 * Antes de un host: ni una letra del nombre ni un punto pegado a otro nombre
 * (`www.dominio.es` no es `dominio.es`). Un punto suelto sí: `.dominio.es` es
 * el dominio de una cookie que cubre al host servido. Tras «@» puede ser el
 * host de una URL con usuario o el dominio de una dirección: lo decide
 * `arrobaDeUrl` (`contacto@dominio.es` no cambia por servir `dominio.es`).
 */
const ANTES_HOST = '(?<![A-Za-z0-9\\u0001-])(?<![A-Za-z0-9@.\\u0001-]\\.)';
/** Antes de una dirección: nada que pueda ser parte de su parte local. */
const ANTES_DIRECCION = '(?<![A-Za-z0-9._%+\\u0001-])';
/** Para encontrar el principio de cualquier nombre (las menciones sin mapa). */
const ANTES_NOMBRE = '(?<![A-Za-z0-9\\u0001-])(?<![A-Za-z0-9\\u0001-]\\.)';
/** Una etiqueta de nombre; una referencia tapada cuenta como etiqueta (`${{api.SUB}}.dominio.es`). */
const ETIQUETA = '[A-Za-z0-9\\u0001-]+';
/** Referencias a otras variables: `${{servicio.VARIABLE}}`. */
const REFERENCIA = /\$\{\{[\s\S]*?\}\}/g;
/** Lo que termina la autoridad de una URL (`usuario:clave@host:puerto`). */
const FUERA_DE_AUTORIDAD = /[/?#\s"'<>,;\\`]/;

function escapar(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizar(s: string): string {
  return s.trim().toLowerCase().replace(/\.$/, '');
}

function tapar(valor: string): string {
  return valor.replace(REFERENCIA, (r) => TAPA.repeat(r.length));
}

/** El texto original entre `a` y `b`, en minúsculas salvo las referencias (sus nombres distinguen mayúsculas). */
function textoOriginal(valor: string, tapado: string, a: number, b: number): string {
  let out = '';
  for (let i = a; i < b; i++) out += tapado[i] === TAPA ? valor[i] : valor[i].toLowerCase();
  return out;
}

/** Autoridad de la URL que contiene la posición `i` (lo que va entre `esquema://` y la ruta), o null. */
function autoridad(texto: string, i: number): { inicio: number; fin: number } | null {
  let inicio = i;
  while (inicio > 0 && !FUERA_DE_AUTORIDAD.test(texto[inicio - 1])) inicio--;
  if (!/[A-Za-z][A-Za-z0-9+.-]*:\/\/$/.test(texto.slice(Math.max(0, inicio - 64), inicio))) return null;
  let fin = i;
  while (fin < texto.length && !FUERA_DE_AUTORIDAD.test(texto[fin])) fin++;
  return { inicio, fin };
}

/**
 * Papel del «@» de la posición `i`: el último de la autoridad de una URL
 * separa el usuario del host (`separador`: `https://u:clave@www.dominio.es`);
 * uno anterior es parte del usuario (`usuario`: `smtp://ana@dominio.es:clave@mail.x`);
 * fuera de una URL, null (una dirección, también en `mailto:`).
 */
function arrobaDeUrl(texto: string, i: number): 'separador' | 'usuario' | null {
  const a = autoridad(texto, i);
  if (!a) return null;
  return texto.lastIndexOf('@', a.fin - 1) === i ? 'separador' : 'usuario';
}

interface MapaCompilado {
  regex: RegExp | null;
  hosts: Map<string, string>;
  direcciones: Map<string, string>;
}

function compilar(mapa: MapaCambio): MapaCompilado {
  const hosts = new Map<string, string>();
  const direcciones = new Map<string, string>();
  const alternativas: { texto: string; patron: string }[] = [];
  const anadir = (destino: Map<string, string>, from: string, to: string, antes: string) => {
    const f = normalizar(from);
    const t = normalizar(to);
    // Un mismo origen con dos destinos: manda el primero (el plan no los genera).
    if (!f || !t || f === t || destino.has(f)) return;
    destino.set(f, t);
    alternativas.push({ texto: f, patron: `${antes}${escapar(f)}${FIN}` });
  };
  for (const h of mapa.hosts) if (!h.from.includes('@')) anadir(hosts, h.from, h.to, ANTES_HOST);
  for (const d of mapa.direcciones) if (d.from.includes('@')) anadir(direcciones, d.from, d.to, ANTES_DIRECCION);
  if (alternativas.length === 0) return { regex: null, hosts, direcciones };
  // De la más larga a la más corta: en la misma posición gana el nombre completo.
  alternativas.sort((a, b) => b.texto.length - a.texto.length || a.texto.localeCompare(b.texto));
  return { regex: new RegExp(alternativas.map((a) => `(?:${a.patron})`).join('|'), 'gi'), hosts, direcciones };
}

interface Analisis {
  valor: string;
  ocurrencias: number;
  sinMapa: string[];
  /** Direcciones del mapa que están como usuario para entrar: no se cambian. */
  usuarios: string[];
}

/**
 * Aplica el mapa en una sola pasada sobre el valor con las referencias
 * tapadas. `usuario`: el valor entero es un usuario SMTP (`SMTP_USER`,
 * `MAIL_USERNAME`…), así que sus direcciones no cambian.
 */
function analizar(valor: string, mapa: MapaCompilado, opciones: { fromDomain?: string | null; usuario?: boolean } = {}): Analisis {
  const texto = tapar(valor);
  let salida = '';
  let ultimo = 0;
  let ocurrencias = 0;
  // Tramos sustituidos o dejados a propósito: no son menciones «sin mapa».
  const tratados: [number, number][] = [];
  const usuarios: string[] = [];
  for (const m of mapa.regex ? texto.matchAll(mapa.regex) : []) {
    const inicio = m.index ?? 0;
    const fin = inicio + m[0].length;
    const nombre = m[0].toLowerCase();
    const arroba = nombre.indexOf('@');
    let desde = inicio;
    let nuevo: string | undefined;
    if (arroba < 0) {
      // Tras «@» solo es un host si es el de una URL con usuario; si no, es el dominio de una dirección.
      if (texto[inicio - 1] === '@' && arrobaDeUrl(texto, inicio - 1) !== 'separador') continue;
      nuevo = mapa.hosts.get(nombre);
    } else {
      const papel = arrobaDeUrl(texto, inicio + arroba);
      if (papel === 'separador') {
        // `https://ana@dominio.es/`: «ana» es el usuario de la URL y dominio.es, su host.
        desde = inicio + arroba + 1;
        nuevo = mapa.hosts.get(nombre.slice(arroba + 1));
      } else if (papel === 'usuario' || opciones.usuario) {
        // Usuario con el que se entra en el correo: hasta que se actualice (o
        // se dé de baja el dominio anterior) el buzón sigue entrando con su
        // dirección anterior, y cambiarlo dejaría a la aplicación sin enviar.
        usuarios.push(nombre);
        tratados.push([inicio, fin]);
        continue;
      } else {
        nuevo = mapa.direcciones.get(nombre);
      }
    }
    if (nuevo === undefined) continue;
    salida += valor.slice(ultimo, desde) + nuevo;
    ultimo = fin;
    ocurrencias++;
    tratados.push([desde, fin]);
  }
  salida += valor.slice(ultimo);
  return {
    valor: salida,
    ocurrencias,
    sinMapa: opciones.fromDomain ? menciones(valor, texto, opciones.fromDomain, tratados) : [],
    usuarios: [...new Set(usuarios)],
  };
}

/**
 * Nombres de `fromDomain` (o de sus subdominios) y direcciones suyas que
 * aparecen en el valor y NO se sustituyen. En una URL con usuario
 * (`postgres://u:clave@db.dominio.es`) se enseña el host, no `clave@…`; un
 * nombre que depende de una referencia se enseña con ella.
 */
function menciones(valor: string, texto: string, fromDomain: string, tratados: [number, number][]): string[] {
  const regex = new RegExp(`${ANTES_NOMBRE}(?:${ETIQUETA}\\.)*${escapar(fromDomain)}${FIN}`, 'gi');
  const cubierto = (a: number, b: number) => tratados.some(([s, e]) => s < b && a < e);
  const out: string[] = [];
  for (const m of texto.matchAll(regex)) {
    const inicio = m.index ?? 0;
    const fin = inicio + m[0].length;
    if (texto[inicio - 1] !== '@' || arrobaDeUrl(texto, inicio - 1) === 'separador') {
      if (!cubierto(inicio, fin)) out.push(textoOriginal(valor, texto, inicio, fin));
      continue;
    }
    // Tras «@»: el dominio de una dirección (con su parte local, si la tiene).
    let local = inicio - 1;
    while (local > 0 && /[A-Za-z0-9._%+\u0001-]/.test(texto[local - 1])) local--;
    if (!cubierto(local, fin)) out.push(textoOriginal(valor, texto, local, fin));
  }
  return [...new Set(out)];
}

/**
 * Aplica el mapa a un valor (siempre al original). Con `key`, si es la de un
 * usuario SMTP (`SMTP_USER`, `MAIL_USERNAME`…), sus direcciones no cambian:
 * el mismo criterio que `planificar`.
 */
export function aplicarMapa(valor: string, mapa: MapaCambio, opciones: { key?: string } = {}): { valor: string; ocurrencias: number } {
  const r = analizar(valor, compilar(mapa), { usuario: esUsuarioCorreo(opciones.key) });
  return { valor: r.valor, ocurrencias: r.ocurrencias };
}

/**
 * ¿Es el nombre de un usuario SMTP (`SMTP_USER`, `EMAIL_HOST_USER`…)? También
 * con un prefijo propio (`TG_SMTP_LOGIN`, `BOT_SMTP_USER`, `mailRoleLoose`):
 * cambiarlo al pasar dejaría al bot entrando con un usuario que todavía no
 * existe.
 */
function esUsuarioCorreo(key: string | undefined): boolean {
  return !!key && mailRoleLoose(key) === 'user';
}

/** Texto de una mención sin mapa para la interfaz. */
export function mensajeSinMapa(nombre: string, key?: string): string {
  const donde = key ? ` aparece en ${key}, pero` : '';
  if (nombre.includes('${{')) {
    return key ? `${nombre} aparece en ${key} y depende de otra variable: no se cambia.` : `${nombre} depende de otra variable: no se cambia.`;
  }
  if (nombre.startsWith('@')) return key ? `${nombre} aparece en ${key}: no se cambia.` : `${nombre} no se cambia.`;
  if (nombre.includes('@')) return `${nombre}${donde} no es un buzón ni un alias que se mude: no se cambia.`;
  return `${nombre}${donde} no lo sirve este proyecto: no se cambia.`;
}

/** Texto de un usuario para entrar que no se cambia (`PlanVariables.usuarios`). */
export function mensajeUsuario(nombre: string, key?: string): string {
  const dominio = nombre.slice(nombre.lastIndexOf('@') + 1);
  return (
    `${nombre}${key ? ` aparece en ${key}` : ''} como usuario para entrar en el correo: no se cambia al pasar. ` +
    `El buzón sigue entrando con ese usuario hasta que se actualice o se dé de baja ${dominio}.`
  );
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
  const usuarios: AvisoSinMapa[] = [];
  for (const v of valores) {
    if (v.origen?.startsWith('mail.')) continue;
    const r = analizar(v.valor, compilado, { fromDomain: from, usuario: esUsuarioCorreo(v.key) });
    if (r.sinMapa.length > 0) avisosSinMapa.push({ ambito: v.ambito, key: v.key, serviceId: v.serviceId, nombres: r.sinMapa });
    if (r.usuarios.length > 0) usuarios.push({ ambito: v.ambito, key: v.key, serviceId: v.serviceId, nombres: r.usuarios });
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
  usuarios.sort(orden);
  const huella = sha256(JSON.stringify(cambios.map((c) => [c.ambito, c.serviceId ?? '', c.key, sha256(c.antes), c.excluida])));
  return { cambios, avisosSinMapa, usuarios, huella };
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
 * Prefijos con los que los frameworks exponen una variable al navegador
 * (`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `VITE_TURNSTILE_SITE_KEY`): el
 * nombre que importa es lo que va detrás.
 */
const PREFIJO_PUBLICO = /^(?:NEXT_PUBLIC_|NUXT_PUBLIC_|EXPO_PUBLIC_|REACT_APP_|VITE_|PUBLIC_|GATSBY_|NUXT_)/;
const INICIO_SESION = new Set(['NEXTAUTH_URL', 'AUTH_URL']);
const GOOGLE = new Set(['GOOGLE_CLIENT_ID', 'GOOGLE_ID', 'AUTH_GOOGLE_ID', 'GOOGLE_OAUTH_CLIENT_ID']);
const GITHUB = new Set(['GITHUB_CLIENT_ID', 'GITHUB_ID', 'AUTH_GITHUB_ID', 'GITHUB_OAUTH_CLIENT_ID']);
/** El tema va en cualquier tramo del nombre: `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_…`, `APP_RECAPTCHA_SECRET`. */
const STRIPE = /(?:^|_)STRIPE_/;
const WIDGET = /(?:^|_)(?:TURNSTILE|RECAPTCHA|HCAPTCHA)_/;

/**
 * Avisos informativos según las variables y las pilas del proyecto: lo que el
 * cambio no puede hacer por sí solo (dar de alta la URL nueva en un proveedor
 * externo, corregir las URL guardadas en la base de datos). No bloquean nada.
 * `hostViejo`, si se conoce, completa la orden de WordPress.
 */
export function avisosDeVariables(claves: string[], pilas: string[], hostNuevo: string, hostViejo?: string): string[] {
  const k = claves.map((c) => c.toUpperCase());
  const base = k.map((c) => c.replace(PREFIJO_PUBLICO, ''));
  const nuevo = normalizar(hostNuevo);
  const registrable = getDomain(nuevo) ?? nuevo;
  const out: string[] = [];
  if (base.some((c) => INICIO_SESION.has(c))) {
    out.push(`Añade https://${nuevo}/api/auth/callback/<proveedor> en cada proveedor de inicio de sesión.`);
  }
  if (base.some((c) => GOOGLE.has(c))) {
    out.push(`Google Cloud → Credenciales: añade https://${nuevo} como origen autorizado y su URL de vuelta.`);
  }
  if (base.some((c) => GITHUB.has(c))) {
    out.push('GitHub → Developer settings → OAuth Apps: cambia la Authorization callback URL.');
  }
  if (k.some((c) => STRIPE.test(c))) {
    out.push(
      `Stripe → Webhooks: crea el endpoint en https://${nuevo}/… (Stripe no sigue redirecciones) y actualiza STRIPE_WEBHOOK_SECRET.`,
    );
  }
  if (k.some((c) => WIDGET.test(c))) {
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

// ---------- webhooks de bots ----------

/** Proveedor de webhooks del que avisa un cambio de dominio; `webhook` cuando el nombre no dice cuál. */
export type ProveedorAviso = ProveedorWebhook | 'webhook';

/**
 * Prefijos que delatan un proveedor de webhooks. Stripe con el tema en
 * cualquier tramo (`NEXT_PUBLIC_STRIPE_…`, `APP_STRIPE_…`), como su aviso; el
 * resto, al principio del nombre sin el prefijo público: `TG_` en medio de otro
 * nombre (`SETTING_TG_…`) no dice nada.
 */
const PROVEEDOR_POR_PREFIJO: [RegExp, ProveedorWebhook][] = [
  [/^(?:TELEGRAM|TG)_/, 'telegram'],
  [/^DISCORD_/, 'discord'],
  [/^SLACK_/, 'slack'],
  [/^WHATSAPP_/, 'whatsapp'],
  [/^TWILIO_/, 'twilio'],
];
/** Un token de bot sin proveedor en el nombre, o cualquier variable de webhooks. */
const WEBHOOK_GENERICO = /(?:^|_)BOT_TOKEN$|WEBHOOK/;

/**
 * Proveedores de webhooks que delatan los nombres de las variables de un
 * servicio, uno por variable (el más concreto): `TELEGRAM_BOT_TOKEN` es de
 * Telegram aunque también sea un token de bot. Un webhook registrado en el
 * proveedor con la URL anterior no sigue la redirección del cambio de dominio
 * (Telegram y Stripe tratan una redirección como un fallo): el asistente avisa
 * y ofrece seguir sirviendo el nombre anterior.
 */
export function proveedoresDeClaves(claves: readonly string[]): { proveedor: ProveedorAviso; clave: string }[] {
  const out: { proveedor: ProveedorAviso; clave: string }[] = [];
  for (const clave of new Set(claves)) {
    const k = clave.toUpperCase();
    const base = k.replace(PREFIJO_PUBLICO, '');
    const concreto = STRIPE.test(k) ? 'stripe' : PROVEEDOR_POR_PREFIJO.find(([re]) => re.test(base))?.[1];
    if (concreto) out.push({ proveedor: concreto, clave });
    else if (WEBHOOK_GENERICO.test(k)) out.push({ proveedor: 'webhook', clave });
  }
  return out;
}
