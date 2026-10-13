import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { fireAlert } from './alerts';
import { config } from './config';
import { getSetting, resolveAlertsByDedupe, setSetting } from './db';

/**
 * Copias externas: la copia cifrada en S3 de Skyway, sus proyectos y Mailway
 * que hace el servidor con `skyway copias` (`scripts/copias/copias.sh`).
 *
 * El panel no ejecuta nada en el host. El host (root) escribe su estado en
 * `<DATA_DIR>/copias/` con escritura atómica y el panel solo lo LEE
 * (`estado.json`, `ejecuciones.json`, `kit.json` y `kits/*.zip`). Lo único que
 * ESCRIBE son peticiones en `copias/peticiones/`, que atiende una unidad de
 * systemd del host con su propia lista blanca; además retira el kit cuando el
 * administrador lo elimina. Así, quien controle el panel no gana con ello una
 * forma de ejecutar órdenes como root en el servidor.
 *
 * Los ficheros del host se leen con tolerancia: uno ausente, roto o de otra
 * versión devuelve null, y un campo con un tipo inesperado queda en null sin
 * invalidar el resto. Una página de Ajustes caída por un fichero a medio
 * escribir dejaría al administrador sin saber si tiene copias.
 */

/** Identificador de ejecución: la hora UTC de la copia (`AAAAMMDD-HHMMSS`). */
export const RE_EJECUCION = /^[0-9]{8}-[0-9]{6}$/;
/**
 * Nombre del zip del kit. Sin puntos ni barras fuera de `.zip`: el nombre
 * llega de un fichero y acaba en una ruta del disco y en Content-Disposition.
 */
export const RE_FICHERO_KIT = /^kit-[0-9]{8}-[0-9]{6}-[a-z0-9_-]{1,80}\.zip$/;
/** Nombre de una petición: `<Date.now()>-<4 hex>.json`, el que espera el host. */
export const RE_PETICION = /^[0-9]{13}-[0-9a-f]{4}\.json$/;
export const RE_PROYECTO = /^prj_[0-9a-f]{16}$/;
/** Slug de proyecto: va dentro de las órdenes de restaurar que el panel ofrece copiar. */
const RE_SLUG = /^[a-z0-9-]{1,32}$/;

/** Una operación del host que lleva más de esto en marcha se da por interrumpida. */
export const OPERACION_INTERRUMPIDA_MS = 12 * 3600_000;
/** Margen sobre el día: la copia diaria puede retrasarse un poco sin que haga falta avisar. */
export const COPIA_ATRASADA_MS = 26 * 3600_000;

/** Topes de tamaño: un fichero desmesurado no es del host y no se carga en memoria. */
const MAX_ESTADO = 1024 * 1024;
const MAX_EJECUCIONES = 16 * 1024 * 1024;
const MAX_KIT = 256 * 1024;
const MAX_PETICION = 64 * 1024;
/** Peticiones que se leen para mostrarlas: el panel solo deja una pendiente a la vez. */
const MAX_PETICIONES_LISTADAS = 20;

export function carpetaCopias(): string {
  return path.join(config.dataDir, 'copias');
}

function carpetaPeticiones(): string {
  return path.join(carpetaCopias(), 'peticiones');
}

function carpetaKits(): string {
  return path.join(carpetaCopias(), 'kits');
}

// ---------- esquemas tolerantes ----------

/**
 * Campo opcional y tolerante: si falta o no tiene el tipo esperado queda en
 * null, sin invalidar el resto del fichero.
 */
function campo<T extends z.ZodTypeAny>(esquema: T) {
  return esquema
    .nullish()
    .catch(null)
    .transform((v): z.output<T> | null => v ?? null);
}

/** Texto recortado: un detalle de error puede traer la salida entera de una orden. */
const texto = (max: number) => z.string().transform((s) => s.slice(0, max));

const numero = z.number().finite().nonnegative();

/** Fecha ISO que el navegador pueda interpretar; si no, el campo queda en null. */
const fecha = z
  .string()
  .max(64)
  .refine((s) => Number.isFinite(Date.parse(s)));

/** Lista de textos: los elementos que no son texto se descartan, no la lista entera. */
function textos(maxElementos: number, maxLongitud: number) {
  return z
    .array(z.unknown())
    .transform((lista) =>
      lista
        .filter((v): v is string => typeof v === 'string')
        .slice(0, maxElementos)
        .map((s) => s.slice(0, maxLongitud)),
    );
}

/** Lista de objetos: se quedan los válidos; falta o no es una lista → vacía. */
function listaValida<T extends z.ZodTypeAny>(esquema: T, max: number) {
  return z
    .array(z.unknown())
    .nullish()
    .catch(null)
    .transform((lista): z.output<T>[] => {
      const validos: z.output<T>[] = [];
      for (const elemento of lista ?? []) {
        const r = esquema.safeParse(elemento);
        if (r.success) validos.push(r.data);
        if (validos.length >= max) break;
      }
      return validos;
    });
}

const ultimaSchema = z.object({
  id: campo(z.string().regex(RE_EJECUCION)),
  inicio: campo(fecha),
  fin: campo(fecha),
  resultado: campo(texto(40)),
  motivo: campo(texto(40)),
  alcance: campo(texto(80)),
  detalle: campo(texto(2000)),
  avisos: campo(textos(50, 500)),
  elementos: campo(numero),
  bytesNuevos: campo(numero),
  duracionS: campo(numero),
});

/** `copias/estado.json`. `formato` es lo único obligatorio: distingue el fichero del host de un JSON cualquiera. */
const estadoSchema = z.object({
  formato: z.number().int().positive(),
  configuradas: campo(z.boolean()),
  destino: campo(
    z.object({
      endpoint: campo(texto(300)),
      bucket: campo(texto(200)),
      prefijo: campo(texto(200)),
    }),
  ),
  programacion: campo(
    z.object({
      activa: campo(z.boolean()),
      hora: campo(z.string().regex(/^[0-9]{2}:[0-9]{2}$/)),
      proxima: campo(fecha),
    }),
  ),
  ultima: campo(ultimaSchema),
  ultimaCorrecta: campo(
    z.object({
      id: campo(z.string().regex(RE_EJECUCION)),
      fin: campo(fecha),
    }),
  ),
  // Sin `pid`: es un detalle del host que el panel no necesita.
  enCurso: campo(
    z.object({
      accion: campo(texto(40)),
      inicio: campo(fecha),
      paso: campo(texto(300)),
    }),
  ),
  ultimaComprobacion: campo(
    z.object({
      fecha: campo(fecha),
      resultado: campo(texto(40)),
      detalle: campo(texto(2000)),
    }),
  ),
  // La restauración de prueba mensual de la copia programada (y la de «comprobar»).
  ultimaPruebaRestauracion: campo(
    z.object({
      fecha: campo(fecha),
      ejecucion: campo(z.string().regex(RE_EJECUCION)),
      resultado: campo(texto(40)),
      detalle: campo(texto(2000)),
    }),
  ),
  ultimaPeticion: campo(
    z.object({
      id: campo(texto(40)),
      accion: campo(texto(40)),
      resultado: campo(texto(40)),
      detalle: campo(texto(2000)),
      fecha: campo(fecha),
    }),
  ),
  actualizado: campo(fecha),
});

const proyectoEjecucionSchema = z.object({
  id: z.string().regex(RE_PROYECTO),
  nombre: campo(texto(200)),
  // Un slug con otro formato no llega a la orden de restaurar que se copia en una terminal de root.
  slug: campo(z.string().regex(RE_SLUG)),
});

const ejecucionSchema = z.object({
  id: z.string().regex(RE_EJECUCION),
  fecha: campo(fecha),
  motivo: campo(texto(40)),
  alcance: campo(texto(80)),
  resultado: campo(texto(40)),
  elementos: campo(numero),
  tamano: campo(numero),
  versiones: campo(
    z.object({
      skyway: campo(texto(40)),
      mailway: campo(texto(40)),
    }),
  ),
  proyectos: listaValida(proyectoEjecucionSchema, 500),
  correo: campo(z.boolean()),
});

const ejecucionesSchema = z.object({
  formato: z.number().int().positive(),
  actualizado: campo(fecha),
  ejecuciones: listaValida(ejecucionSchema, 5000),
});

const kitSchema = z.object({
  formato: z.number().int().positive(),
  estado: z.enum(['preparando', 'listo', 'fallido']),
  // Un nombre con otro formato (una ruta, `..`) se descarta aquí: nunca llega a una ruta del disco.
  fichero: campo(z.string().regex(RE_FICHERO_KIT)),
  tamano: campo(numero),
  ejecucion: campo(z.string().regex(RE_EJECUCION)),
  alcance: campo(texto(80)),
  creado: campo(fecha),
  caduca: campo(fecha),
  detalle: campo(texto(2000)),
});

const peticionLeidaSchema = z.object({
  accion: campo(texto(40)),
  alcance: campo(texto(40)),
  proyecto: campo(z.string().regex(RE_PROYECTO)),
  ejecucion: campo(z.string().regex(RE_EJECUCION)),
  solicitadoPor: campo(texto(200)),
  fecha: campo(fecha),
});

export type EstadoCopias = z.output<typeof estadoSchema>;
export type EjecucionCopias = z.output<typeof ejecucionSchema>;
export type KitCopias = z.output<typeof kitSchema>;

export interface PeticionPendiente {
  id: string;
  accion: string | null;
  alcance: string | null;
  proyecto: string | null;
  ejecucion: string | null;
  solicitadoPor: string | null;
  fecha: string | null;
}

// ---------- lectura ----------

export interface Lectura<T> {
  valor: T | null;
  /** El fichero existe pero no se ha podido leer o no tiene el formato esperado. */
  ilegible: boolean;
  /** Última escritura del fichero: la fecha de respaldo si el contenido no trae la suya. */
  modificado: number | null;
}

/**
 * Lee un JSON del host. Solo ficheros normales (un enlace simbólico no lo
 * escribe el host) y con un tamaño razonable.
 */
function leerJson<T extends z.ZodTypeAny>(ruta: string, maxBytes: number, esquema: T): Lectura<z.output<T>> {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(ruta);
  } catch {
    return { valor: null, ilegible: false, modificado: null };
  }
  const modificado = st.mtimeMs;
  if (!st.isFile() || st.size > maxBytes) return { valor: null, ilegible: true, modificado };
  let datos: unknown;
  try {
    datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
  } catch {
    return { valor: null, ilegible: true, modificado };
  }
  const r = esquema.safeParse(datos);
  return r.success ? { valor: r.data, ilegible: false, modificado } : { valor: null, ilegible: true, modificado };
}

export function leerEstadoCopias(): Lectura<EstadoCopias> {
  return leerJson(path.join(carpetaCopias(), 'estado.json'), MAX_ESTADO, estadoSchema);
}

/** Ejecuciones de la más reciente a la más antigua; null si el fichero falta o no se puede leer. */
export function leerEjecucionesCopias(): EjecucionCopias[] | null {
  return leerJson(path.join(carpetaCopias(), 'ejecuciones.json'), MAX_EJECUCIONES, ejecucionesSchema).valor?.ejecuciones ?? null;
}

export function leerKitCopias(): Lectura<KitCopias> {
  return leerJson(path.join(carpetaCopias(), 'kit.json'), MAX_KIT, kitSchema);
}

/** Las copias están instaladas si el host ha escrito su estado y no dice que estén sin configurar. */
export function copiasInstaladas(estado: EstadoCopias | null): estado is EstadoCopias {
  return !!estado && estado.configuradas !== false;
}

/** Instante de una fecha del host, o null si no se puede interpretar. */
function instante(valor: string | null | undefined): number | null {
  if (!valor) return null;
  const ms = Date.parse(valor);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Hay una operación del host en marcha (copia, comprobación, kit…). Si lleva
 * más de 12 h se da por interrumpida: un proceso que murió sin limpiar
 * `enCurso` no puede bloquear el panel para siempre. Sin fecha de inicio vale
 * la de la última escritura de `estado.json`.
 */
export function operacionEnCurso(lectura: Lectura<EstadoCopias>, ahora = Date.now()): boolean {
  const enCurso = lectura.valor?.enCurso;
  if (!enCurso) return false;
  const inicio = instante(enCurso.inicio) ?? lectura.modificado;
  return inicio !== null && ahora - inicio < OPERACION_INTERRUMPIDA_MS;
}

/** El kit se está preparando, con el mismo plazo que cualquier otra operación del host. */
export function kitEnPreparacion(lectura: Lectura<KitCopias>, ahora = Date.now()): boolean {
  const kit = lectura.valor;
  if (kit?.estado !== 'preparando') return false;
  const creado = instante(kit.creado) ?? lectura.modificado;
  return creado !== null && ahora - creado < OPERACION_INTERRUMPIDA_MS;
}

/**
 * Ruta del zip del kit, validada: solo el nombre que trae `kit.json` con su
 * formato, dentro de `copias/kits/`, y solo si es un fichero normal (no un
 * enlace simbólico hacia otra parte del disco).
 */
export function rutaZipKit(kit: KitCopias | null): { ruta: string; fichero: string } | null {
  const fichero = kit?.fichero;
  if (!fichero || !RE_FICHERO_KIT.test(fichero) || fichero.includes('..') || path.basename(fichero) !== fichero) return null;
  const dir = carpetaKits();
  const ruta = path.join(dir, fichero);
  if (path.dirname(ruta) !== dir) return null;
  try {
    return fs.lstatSync(ruta).isFile() ? { ruta, fichero } : null;
  } catch {
    return null;
  }
}

/**
 * Abre el zip del kit para enviarlo. Se abre antes de responder (y sin seguir
 * enlaces): si el host lo borra al caducar mientras se descarga, la descarga
 * en curso termina igual con el fichero ya abierto.
 */
export function abrirZipKit(kit: KitCopias | null): { fd: number; fichero: string; tamano: number } | null {
  const zip = rutaZipKit(kit);
  if (!zip) return null;
  let fd: number;
  try {
    fd = fs.openSync(zip.ruta, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (st.isFile()) return { fd, fichero: zip.fichero, tamano: st.size };
  } catch {
    /* se cierra abajo */
  }
  fs.closeSync(fd);
  return null;
}

/** Nombres de las peticiones pendientes, de la más antigua a la más reciente. */
function nombresPeticiones(): string[] {
  try {
    return fs
      .readdirSync(carpetaPeticiones())
      .filter((n) => RE_PETICION.test(n))
      .sort();
  } catch {
    return [];
  }
}

export function contarPeticionesPendientes(): number {
  return nombresPeticiones().length;
}

/** Peticiones pendientes de atender. Una ilegible cuenta igual: sigue en la carpeta hasta que el host la retire. */
export function peticionesPendientes(): PeticionPendiente[] {
  return nombresPeticiones()
    .slice(0, MAX_PETICIONES_LISTADAS)
    .map((nombre) => {
      const id = nombre.slice(0, -'.json'.length);
      const leida = leerJson(path.join(carpetaPeticiones(), nombre), MAX_PETICION, peticionLeidaSchema).valor;
      return {
        id,
        accion: leida?.accion ?? null,
        alcance: leida?.alcance ?? null,
        proyecto: leida?.proyecto ?? null,
        ejecucion: leida?.ejecucion ?? null,
        solicitadoPor: leida?.solicitadoPor ?? null,
        // El nombre lleva el instante en que se dejó: vale de fecha si el contenido no la trae.
        fecha: leida?.fecha ?? new Date(Number(id.slice(0, 13))).toISOString(),
      };
    });
}

export interface SituacionCopias {
  /** Hay un `estado.json` válido del host y no dice que las copias estén sin configurar. */
  instalada: boolean;
  /** `estado.json` existe pero no se puede leer: no es lo mismo que no tener copias. */
  estadoIlegible: boolean;
  estado: EstadoCopias | null;
  ejecuciones: EjecucionCopias[] | null;
  kit: KitCopias | null;
  /** El zip del kit está listo y se puede descargar. */
  kitDisponible: boolean;
  kitPreparando: boolean;
  /** El kit dice «preparando» desde hace más de 12 h: se da por interrumpido. */
  kitInterrumpido: boolean;
  peticionesPendientes: number;
  peticiones: PeticionPendiente[];
  enCurso: boolean;
  /** `enCurso` sigue escrito pero lleva más de 12 h. */
  enCursoInterrumpido: boolean;
  /** No se admite otra petición: hay una pendiente, una operación en marcha o un kit en preparación. */
  ocupada: boolean;
}

export function situacionCopias(ahora = Date.now()): SituacionCopias {
  const lectura = leerEstadoCopias();
  const estado = lectura.valor;
  const lecturaKit = leerKitCopias();
  const kit = lecturaKit.valor;
  const enCurso = operacionEnCurso(lectura, ahora);
  const kitPreparando = kitEnPreparacion(lecturaKit, ahora);
  const pendientes = contarPeticionesPendientes();
  return {
    instalada: copiasInstaladas(estado),
    estadoIlegible: lectura.ilegible,
    estado,
    ejecuciones: leerEjecucionesCopias(),
    kit,
    kitDisponible: kit?.estado === 'listo' && rutaZipKit(kit) !== null,
    kitPreparando,
    kitInterrumpido: kit?.estado === 'preparando' && !kitPreparando,
    peticionesPendientes: pendientes,
    peticiones: peticionesPendientes(),
    enCurso,
    enCursoInterrumpido: !!estado?.enCurso && !enCurso,
    ocupada: pendientes > 0 || enCurso || kitPreparando,
  };
}

// ---------- peticiones ----------

export type AlcanceKit = 'todo' | 'skyway' | 'correo' | 'proyecto';

export type PeticionCopias =
  | { accion: 'copia' }
  | { accion: 'comprobar' }
  | { accion: 'kit'; alcance: AlcanceKit; proyecto?: string; ejecucion?: string };

/** Lo que se escribe en `peticiones/<id>.json` (formato del host). */
export type PeticionEscrita = PeticionCopias & { formato: 1; solicitadoPor: string; fecha: string };

/**
 * Deja una petición para el host con escritura atómica: se escribe en un
 * temporal y se renombra al definitivo, así el host nunca lee una petición a
 * medias. El temporal va en `copias/` y no en `peticiones/` (el mismo disco,
 * así que el renombrado sigue siendo atómico): el host vigila `peticiones/`
 * con `DirectoryNotEmpty=` de systemd y un temporal allí lo despertaría antes
 * de tiempo; si además se quedara (un corte a mitad), la carpeta no volvería a
 * estar vacía y la unidad se relanzaría sin parar. Es el mismo patrón
 * (`.<nombre>.tmp` en `copias/`) con el que el host escribe su estado.
 */
export function escribirPeticion(
  peticion: PeticionCopias,
  solicitadoPor: string,
  ahora = new Date(),
): { id: string; contenido: PeticionEscrita } {
  const dir = carpetaPeticiones();
  fs.mkdirSync(dir, { recursive: true });
  const contenido: PeticionEscrita = {
    formato: 1,
    ...peticion,
    solicitadoPor,
    // Sin milisegundos, como el resto de fechas que escribe el host.
    fecha: ahora.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  for (let intento = 0; intento < 5; intento++) {
    const id = `${ahora.getTime()}-${crypto.randomBytes(2).toString('hex')}`;
    const final = path.join(dir, `${id}.json`);
    // Con el mismo milisegundo y los mismos 4 hex, el renombrado sustituiría otra petición.
    if (fs.existsSync(final)) continue;
    const temporal = path.join(carpetaCopias(), `.peticion-${id}.tmp`);
    try {
      fs.writeFileSync(temporal, `${JSON.stringify(contenido)}\n`, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporal, final);
    } catch (err) {
      fs.rmSync(temporal, { force: true });
      throw err;
    }
    return { id, contenido };
  }
  throw new Error('No se ha podido generar un nombre libre para la petición');
}

/**
 * Elimina el kit (zip y `kit.json`). El zip solo si su nombre es válido: con
 * uno manipulado se retira `kit.json` y nada más.
 */
export function eliminarKit(kit: KitCopias | null): { fichero: string | null } {
  const zip = rutaZipKit(kit);
  if (zip) fs.rmSync(zip.ruta, { force: true });
  fs.rmSync(path.join(carpetaCopias(), 'kit.json'), { force: true });
  return { fichero: zip?.fichero ?? null };
}

/** `kit.json` existe (válido o no): algo que el administrador puede retirar. */
export function hayFicheroKit(): boolean {
  try {
    fs.lstatSync(path.join(carpetaCopias(), 'kit.json'));
    return true;
  } catch {
    return false;
  }
}

// ---------- avisos ----------

export const ALERTA_COPIAS_ATRASADAS = 'copias_externas_atrasadas';
export const ALERTA_COPIAS_FALLIDAS = 'copias_externas_fallidas';

const DEDUPE_ATRASO = 'system:copias-externas:atrasadas';
const dedupeFallo = (id: string) => `system:copias-externas:fallida:${id}`;

/**
 * Marcas en los ajustes. La deduplicación de las alertas solo mira las
 * abiertas: sin estas marcas, una alerta que el administrador resuelve a mano
 * volvería a crearse diez minutos después mientras no cambie nada.
 */
const MARCA_FALLO = 'copiasExternas.avisoFallo';
const MARCA_ATRASO = 'copiasExternas.avisoAtraso';
/** Primera vez que el panel vio activa la copia diaria: sin ninguna copia correcta, es la única referencia. */
const MARCA_ACTIVA_DESDE = 'copiasExternas.activaDesde';

const MOTIVO_TEXTO: Record<string, string> = {
  programada: 'programada',
  manual: 'manual',
  panel: 'desde el panel',
  'antes-de-actualizar': 'antes de actualizar',
};

function fechaUtc(ms: number): string {
  const d = new Date(ms);
  const dos = (n: number) => String(n).padStart(2, '0');
  return `${dos(d.getUTCDate())}/${dos(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} a las ${dos(d.getUTCHours())}:${dos(d.getUTCMinutes())} UTC`;
}

/** Aviso de la última copia fallida: uno por ejecución, y el de una nueva sustituye al anterior. */
function avisarFallo(estado: EstadoCopias): void {
  const ultima = estado.ultima;
  const avisada = getSetting(MARCA_FALLO);
  if (!ultima?.id) return;
  if (ultima.resultado !== 'fallida') {
    // La última ya no es la fallida: su alerta deja de tener sentido.
    if (avisada) {
      resolveAlertsByDedupe(dedupeFallo(avisada));
      setSetting(MARCA_FALLO, null);
    }
    return;
  }
  if (avisada === ultima.id) return;
  if (avisada) resolveAlertsByDedupe(dedupeFallo(avisada));
  const motivo = ultima.motivo ? (MOTIVO_TEXTO[ultima.motivo] ?? ultima.motivo) : null;
  fireAlert({
    severity: 'warning',
    type: ALERTA_COPIAS_FALLIDAS,
    title: 'Copia externa fallida',
    message:
      `La copia externa ${ultima.id}${motivo ? ` (${motivo})` : ''} ha fallado` +
      (ultima.detalle ? `: ${ultima.detalle.slice(0, 300)}` : '.'),
    explanation:
      `Las copias anteriores siguen disponibles. Consulta el detalle en el servidor con «sudo skyway copias ver ${ultima.id}» ` +
      'y vuelve a intentarlo desde Ajustes → Copias externas con «Hacer copia ahora».',
    dedupeKey: dedupeFallo(ultima.id),
  });
  setSetting(MARCA_FALLO, ultima.id);
}

/** Aviso de copias atrasadas: uno por cada última copia correcta que se queda vieja. */
function avisarAtraso(lectura: Lectura<EstadoCopias>, ahora: number): void {
  const estado = lectura.valor;
  if (!copiasInstaladas(estado) || estado.programacion?.activa !== true) {
    // Sin copia diaria no hay atraso posible; al volver a activarla se empieza a contar de nuevo.
    setSetting(MARCA_ACTIVA_DESDE, null);
    setSetting(MARCA_ATRASO, null);
    resolveAlertsByDedupe(DEDUPE_ATRASO);
    return;
  }
  let activaDesde = Number(getSetting(MARCA_ACTIVA_DESDE));
  if (!Number.isFinite(activaDesde) || activaDesde <= 0) {
    activaDesde = ahora;
    setSetting(MARCA_ACTIVA_DESDE, String(ahora));
  }
  const finCorrecta = instante(estado.ultimaCorrecta?.fin);
  const referencia = finCorrecta ?? activaDesde;
  if (ahora - referencia <= COPIA_ATRASADA_MS) {
    setSetting(MARCA_ATRASO, null);
    resolveAlertsByDedupe(DEDUPE_ATRASO);
    return;
  }
  // Una primera copia grande puede tardar horas: se avisa cuando termine (o falle) si sigue haciendo falta.
  if (operacionEnCurso(lectura, ahora)) return;
  const episodio = estado.ultimaCorrecta?.id ?? (finCorrecta === null ? 'ninguna' : String(finCorrecta));
  if (getSetting(MARCA_ATRASO) === episodio) return;
  fireAlert({
    severity: 'warning',
    type: ALERTA_COPIAS_ATRASADAS,
    title: 'Copias externas atrasadas',
    message:
      finCorrecta !== null
        ? `La última copia externa correcta terminó el ${fechaUtc(finCorrecta)}, hace más de 26 horas.`
        : 'No consta ninguna copia externa correcta desde que se activó la copia diaria, hace más de 26 horas.',
    explanation:
      'Comprueba el estado en el servidor con «sudo skyway copias estado». Causas habituales: el servidor estaba apagado ' +
      'a la hora programada, el almacenamiento S3 no responde o sus credenciales ya no son válidas. Puedes lanzar una copia ' +
      'desde Ajustes → Copias externas.',
    dedupeKey: DEDUPE_ATRASO,
  });
  setSetting(MARCA_ATRASO, episodio);
}

/**
 * Comprobación periódica (planificador): avisa en el panel, y por los canales
 * configurados, si la última copia externa ha fallado o si las copias se
 * atrasan. Sin copias instaladas no hace nada más que retirar el aviso de
 * atraso. Solo lee ficheros del host: no depende de Docker.
 */
export function comprobarCopiasExternas(ahora: Date = new Date()): void {
  const lectura = leerEstadoCopias();
  // Un estado que no se puede leer no dice nada: retirar los avisos o volver a
  // contar desde cero por él duplicaría la alerta en cuanto se pudiera leer.
  // Ajustes ya muestra que el estado no se puede leer.
  if (lectura.ilegible) return;
  if (copiasInstaladas(lectura.valor)) avisarFallo(lectura.valor);
  avisarAtraso(lectura, ahora.getTime());
}
