import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, CloudUpload, Download, FileArchive, Loader2, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '../api';
import { cx, fmtBytes, timeAgo, Tone } from '../utils';
import { Button, Chip, ConfirmModal, CopyButton, ErrorState, Skeleton, useToast } from './ui';

// ---------- lo que devuelve /system/copias-externas ----------

interface UltimaCopia {
  id: string | null;
  inicio: string | null;
  fin: string | null;
  resultado: string | null;
  motivo: string | null;
  alcance: string | null;
  detalle: string | null;
  avisos: string[] | null;
  elementos: number | null;
  bytesNuevos: number | null;
  duracionS: number | null;
}

interface EstadoCopias {
  formato: number;
  configuradas: boolean | null;
  destino: { endpoint: string | null; bucket: string | null; prefijo: string | null } | null;
  programacion: { activa: boolean | null; hora: string | null; proxima: string | null } | null;
  ultima: UltimaCopia | null;
  ultimaCorrecta: { id: string | null; fin: string | null } | null;
  enCurso: { accion: string | null; inicio: string | null; paso: string | null } | null;
  ultimaComprobacion: { fecha: string | null; resultado: string | null; detalle: string | null } | null;
  ultimaPruebaRestauracion: { fecha: string | null; ejecucion: string | null; resultado: string | null; detalle: string | null } | null;
  ultimaPeticion: { id: string | null; accion: string | null; resultado: string | null; detalle: string | null; fecha: string | null } | null;
  actualizado: string | null;
}

interface ProyectoEjecucion {
  id: string;
  nombre: string | null;
  slug: string | null;
  /** El proyecto sigue en el panel: solo de esos se puede pedir un kit. */
  enPanel: boolean;
}

interface Ejecucion {
  id: string;
  fecha: string | null;
  motivo: string | null;
  alcance: string | null;
  resultado: string | null;
  elementos: number | null;
  tamano: number | null;
  versiones: { skyway: string | null; mailway: string | null } | null;
  proyectos: ProyectoEjecucion[];
  correo: boolean | null;
}

interface KitCopias {
  estado: 'preparando' | 'listo' | 'fallido';
  fichero: string | null;
  tamano: number | null;
  ejecucion: string | null;
  alcance: string | null;
  creado: string | null;
  caduca: string | null;
  detalle: string | null;
}

interface PeticionPendiente {
  id: string;
  accion: string | null;
  alcance: string | null;
  proyecto: string | null;
  ejecucion: string | null;
  fecha: string | null;
}

interface SituacionCopias {
  instalada: boolean;
  estadoIlegible: boolean;
  estado: EstadoCopias | null;
  ejecuciones: Ejecucion[] | null;
  kit: KitCopias | null;
  kitDisponible: boolean;
  kitPreparando: boolean;
  kitInterrumpido: boolean;
  peticionesPendientes: number;
  peticiones: PeticionPendiente[];
  enCurso: boolean;
  enCursoInterrumpido: boolean;
  ocupada: boolean;
}

type AlcanceKit = 'todo' | 'skyway' | 'correo' | 'proyecto';

type NuevaPeticion =
  | { accion: 'copia' }
  | { accion: 'comprobar' }
  | { accion: 'kit'; alcance: AlcanceKit; proyecto?: string; ejecucion?: string };

// ---------- textos y formatos ----------

/** Copias que se enseñan antes de «Mostrar todas»: hay una por noche. */
const EJECUCIONES_VISIBLES = 7;
/** Una petición que el servidor no recoge en este tiempo indica que no las está atendiendo. */
const PETICION_SIN_ATENDER_MS = 5 * 60_000;

const RESULTADO: Record<string, { texto: string; tono: Tone }> = {
  correcta: { texto: 'Correcta', tono: 'ok' },
  'con-avisos': { texto: 'Con avisos', tono: 'warn' },
  incompleta: { texto: 'Incompleta', tono: 'warn' },
  fallida: { texto: 'Fallida', tono: 'err' },
};

const MOTIVO: Record<string, string> = {
  programada: 'Programada',
  manual: 'Manual',
  panel: 'Desde el panel',
  'antes-de-actualizar': 'Antes de actualizar',
};

const ACCION: Record<string, string> = {
  copia: 'Copia',
  comprobar: 'Comprobación',
  kit: 'Preparación del kit',
  restaurar: 'Restauración',
  mantenimiento: 'Mantenimiento',
};

const ALCANCE_KIT: Record<string, string> = {
  todo: 'completo',
  skyway: 'de Skyway',
  correo: 'del correo',
  proyecto: 'de un proyecto',
};

// Un solo formateador: se usa por fila y en cada refresco.
const FECHA = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function instante(valor: string | null | undefined): number | null {
  if (!valor) return null;
  const ms = Date.parse(valor);
  return Number.isFinite(ms) ? ms : null;
}

/** Fecha y hora en la zona del navegador. */
function fmtFecha(valor: string | null | undefined): string | null {
  const ms = instante(valor);
  return ms === null ? null : FECHA.format(new Date(ms));
}

/** Fecha de una copia a partir de su identificador (`AAAAMMDD-HHMMSS`, en UTC), en la zona del navegador. */
function fechaDeEjecucion(id: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(id);
  if (!m) return null;
  const [, a, mes, d, h, min, seg] = m.map(Number);
  const ms = Date.UTC(a, mes - 1, d, h, min, seg);
  return Number.isFinite(ms) ? FECHA.format(new Date(ms)) : null;
}

function fmtDuracion(segundos: number): string {
  const s = Math.round(segundos);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Tiempo relativo hacia el futuro («dentro de 3 h») o el pasado («hace 3 h»). */
function relativo(ms: number): string {
  const falta = ms - Date.now();
  if (falta <= 0) return timeAgo(ms);
  const min = Math.round(falta / 60_000);
  if (min < 60) return `dentro de ${Math.max(1, min)} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `dentro de ${h} h` : `dentro de ${Math.round(h / 24)} d`;
}

/** Alcance de un kit: el host escribe `proyecto-<slug>` en los de un proyecto. */
function alcanceKitDe(alcance: string): string {
  if (alcance.startsWith('proyecto-')) return `del proyecto «${alcance.slice('proyecto-'.length)}»`;
  return ALCANCE_KIT[alcance] ?? alcance;
}

function resultadoDe(resultado: string | null): { texto: string; tono: Tone } {
  if (!resultado) return { texto: 'Sin resultado', tono: 'neutral' };
  return RESULTADO[resultado] ?? { texto: resultado, tono: 'neutral' };
}

const motivoDe = (motivo: string | null) => (motivo ? (MOTIVO[motivo] ?? motivo) : null);
const accionDe = (accion: string | null) => (accion ? (ACCION[accion] ?? accion) : 'Operación');

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/** Identifica un botón de petición para mostrar su estado de carga. */
function claveDe(p: NuevaPeticion | undefined): string {
  if (!p) return '';
  return p.accion === 'kit' ? `kit:${p.alcance}:${p.proyecto ?? ''}:${p.ejecucion ?? ''}` : p.accion;
}

function mensajeEnviada(p: NuevaPeticion, hayKit: boolean): string {
  if (p.accion === 'copia') return 'Petición enviada. El servidor empezará la copia en unos instantes.';
  if (p.accion === 'comprobar') return 'Petición enviada. El servidor comprobará las copias en unos instantes.';
  return `Petición enviada. El servidor preparará el kit; puede tardar varios minutos.${hayKit ? ' El kit actual se sustituirá por el nuevo.' : ''}`;
}

// ---------- piezas ----------

/** Orden para la terminal del servidor, con su botón de copiar. */
function Orden({ orden }: { orden: string }) {
  return (
    <div className="mt-1.5 flex items-start gap-1 rounded-md border border-line bg-term py-1 pl-2.5 pr-1">
      {/* Corta por los espacios: partida a mitad de palabra, una orden se lee mal antes de copiarla. */}
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-words py-0.5 font-mono text-xs leading-5 text-txt/[.88]">{orden}</code>
      <CopyButton value={orden} title="Copiar orden" className="shrink-0" />
    </div>
  );
}

function Aviso({ tono, icono, children, accion }: { tono: 'warn' | 'err' | 'info'; icono?: React.ReactNode; children: React.ReactNode; accion?: React.ReactNode }) {
  const caja = {
    warn: 'border-warn/30 bg-warn/[.06]',
    err: 'border-err/30 bg-err/[.06]',
    info: 'border-acc/30 bg-acc/[.06]',
  }[tono];
  const color = { warn: 'text-warn', err: 'text-err', info: 'text-acc-soft' }[tono];
  return (
    <div role={tono === 'info' ? 'status' : 'alert'} className={cx('flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5 text-sub', caja)}>
      <span className={cx('mt-0.5 shrink-0', color)}>{icono ?? <AlertTriangle size={13} aria-hidden />}</span>
      <div className="min-w-0 flex-1">{children}</div>
      {accion && <div className="shrink-0">{accion}</div>}
    </div>
  );
}

function Dato({ etiqueta, valor, detalle }: { etiqueta: string; valor: React.ReactNode; detalle?: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-bg px-3.5 py-3">
      <p className="text-xs text-subtle">{etiqueta}</p>
      <p className="tnum mt-0.5 truncate text-sm font-semibold">{valor}</p>
      {detalle && <div className="mt-1 text-xs text-sub">{detalle}</div>}
    </div>
  );
}

function ChipResultado({ resultado }: { resultado: string | null }) {
  const r = resultadoDe(resultado);
  return (
    <Chip size="sm" tone={r.tono} dot>
      {r.texto}
    </Chip>
  );
}

/** Sin copias instaladas: qué son y cómo se activan en el servidor. */
function SinInstalar({ ilegible }: { ilegible: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      {ilegible && (
        <Aviso tono="warn">
          No se puede leer el estado de las copias externas (<span className="font-mono">copias/estado.json</span>). Comprueba su
          estado en el servidor con <span className="font-mono">sudo skyway copias estado</span>.
        </Aviso>
      )}
      <p className="text-xs leading-5 text-sub">
        Las copias incluyen la configuración de Skyway y de Mailway, el correo y los volúmenes, bases de datos e imágenes de los
        servicios, y se guardan en un almacenamiento compatible con S3, como Cubbit. Se activan en la terminal del servidor:
      </p>
      <ol className="list-decimal space-y-3 rounded-lg border border-line bg-bg py-3 pl-8 pr-3.5 text-xs leading-5 text-sub">
        <li>
          Configura el almacenamiento S3 y la contraseña de las copias. La orden comprueba el bucket y prepara el repositorio
          cifrado.
          <Orden orden="sudo skyway copias configurar" />
        </li>
        <li>
          Activa la copia diaria y las peticiones desde este panel.
          <Orden orden="sudo skyway copias activar" />
        </li>
        <li>
          Guarda fuera del servidor los datos de recuperación: sin la contraseña de las copias no se pueden descodificar.
          <Orden orden="sudo skyway copias datos-recuperacion" />
        </li>
      </ol>
      <p className="text-xs leading-5 text-subtle">
        Las órdenes se ejecutan en la terminal del servidor. La guía completa está en{' '}
        <span className="font-mono">docs/COPIAS.md</span>, en la carpeta de Skyway.
      </p>
    </div>
  );
}

/** Operación en marcha, peticiones sin recoger y el resultado de la última petición. */
function Actividad({ datos }: { datos: SituacionCopias }) {
  const estado = datos.estado;
  const enCurso = estado?.enCurso;
  const fallo = estado?.ultimaPeticion?.resultado === 'fallida' ? estado.ultimaPeticion : null;
  if (!datos.enCurso && !datos.enCursoInterrumpido && datos.peticiones.length === 0 && !fallo) return null;
  return (
    <div className="flex flex-col gap-2">
      {datos.enCurso && enCurso && (
        <Aviso tono="info" icono={<Loader2 size={13} className="animate-spin" aria-hidden />}>
          <span className="font-medium text-txt">{accionDe(enCurso.accion)} en curso</span>
          {fmtFecha(enCurso.inicio) ? ` desde el ${fmtFecha(enCurso.inicio)}` : ''}.
          {enCurso.paso && <span className="block break-words text-subtle">Paso actual: {enCurso.paso}</span>}
        </Aviso>
      )}
      {datos.enCursoInterrumpido && enCurso && (
        <Aviso tono="warn">
          La operación «{accionDe(enCurso.accion).toLowerCase()}»
          {fmtFecha(enCurso.inicio) ? `, iniciada el ${fmtFecha(enCurso.inicio)},` : ''} no ha terminado en 12 horas y se
          considera interrumpida. Comprueba el estado en el servidor con <span className="font-mono">sudo skyway copias estado</span>.
        </Aviso>
      )}
      {datos.peticiones.map((p) => {
        const enviada = instante(p.fecha);
        const atascada = enviada !== null && Date.now() - enviada > PETICION_SIN_ATENDER_MS;
        const que = `${accionDe(p.accion).toLowerCase()}${p.accion === 'kit' && p.alcance ? ` ${alcanceKitDe(p.alcance)}` : ''}`;
        return atascada ? (
          <Aviso key={p.id} tono="warn">
            La petición «{que}» lleva {enviada !== null ? timeAgo(enviada).replace(/^hace /, '') : 'un tiempo'} sin atenderse.
            Comprueba en el servidor que las copias estén activadas con <span className="font-mono">sudo skyway copias estado</span>.
          </Aviso>
        ) : (
          <Aviso key={p.id} tono="info" icono={<Loader2 size={13} className="animate-spin" aria-hidden />}>
            <span className="font-medium text-txt">Petición enviada: {que}</span>
            {enviada !== null ? ` (${timeAgo(enviada)})` : ''}. El servidor la atenderá en unos instantes.
          </Aviso>
        );
      })}
      {fallo && datos.peticiones.length === 0 && (
        <Aviso tono="err">
          La última petición del panel ({accionDe(fallo.accion).toLowerCase()}
          {fmtFecha(fallo.fecha) ? `, ${fmtFecha(fallo.fecha)}` : ''}) no se ha podido completar
          {fallo.detalle ? `: ${fallo.detalle}` : '.'}
        </Aviso>
      )}
    </div>
  );
}

/** El kit actual: en preparación, listo para descargar o fallido. */
function KitActual({
  datos,
  onEliminar,
  onDescartar,
  descartando,
}: {
  datos: SituacionCopias;
  /** Kit listo: se pide confirmación antes de eliminarlo. */
  onEliminar: () => void;
  /** Kit fallido, interrumpido o caducado: no queda nada que perder y se retira directamente. */
  onDescartar: () => void;
  descartando: boolean;
}) {
  const kit = datos.kit;
  if (!kit) return null;
  const fechaCopia = kit.ejecucion ? fechaDeEjecucion(kit.ejecucion) : null;
  const deLaCopia = [
    kit.alcance ? `kit ${alcanceKitDe(kit.alcance)}` : 'kit',
    fechaCopia ? `de la copia del ${fechaCopia}` : kit.ejecucion ? `de la copia ${kit.ejecucion}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  const eliminar = (
    <Button variant="ghost" size="sm" onClick={onDescartar} loading={descartando} title="Retirar el kit del servidor">
      <Trash2 size={13} /> Descartar
    </Button>
  );

  if (kit.estado === 'preparando') {
    return datos.kitPreparando ? (
      <Aviso tono="info" icono={<Loader2 size={13} className="animate-spin" aria-hidden />}>
        <span className="font-medium text-txt">Preparando el {deLaCopia}…</span> Puede tardar varios minutos, según el tamaño de la
        copia.
      </Aviso>
    ) : (
      <Aviso tono="warn" accion={eliminar}>
        La preparación del {deLaCopia} no ha terminado en 12 horas y se considera interrumpida.
      </Aviso>
    );
  }
  if (kit.estado === 'fallido') {
    return (
      <Aviso tono="err" accion={eliminar}>
        No se ha podido preparar el {deLaCopia}
        {kit.detalle ? `: ${kit.detalle}` : '.'}
      </Aviso>
    );
  }
  if (!datos.kitDisponible) {
    return (
      <Aviso tono="warn" accion={eliminar}>
        El {deLaCopia} ya no está disponible en el servidor; puede haber caducado. Prepáralo de nuevo desde la lista de copias.
      </Aviso>
    );
  }
  const caduca = instante(kit.caduca);
  return (
    <div className="rounded-lg border border-ok/30 bg-ok/[.05] px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <FileArchive size={16} aria-hidden className="shrink-0 text-ok" />
        {/* Con un ancho mínimo, en el móvil los botones pasan debajo en vez de estrujar el texto. */}
        <div className="min-w-[13rem] flex-1">
          <p className="text-sm font-semibold">Kit listo para descargar</p>
          <p className="mt-0.5 break-words font-mono text-xs text-sub">{kit.fichero}</p>
          <p className="tnum mt-0.5 text-xs text-subtle">
            {[
              kit.tamano !== null ? fmtBytes(kit.tamano) : null,
              caduca !== null ? `caduca ${relativo(caduca)} (${fmtFecha(kit.caduca)})` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <a
            href="/api/system/copias-externas/kit"
            download
            className="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface2 px-2.5 text-xs font-medium text-txt transition-colors hover:border-line2 hover:bg-surface3"
          >
            <Download size={13} /> Descargar
          </a>
          <Button variant="ghost" size="sm" onClick={onEliminar} className="text-err hover:bg-err/[.1]" title="Eliminar el kit del servidor">
            <Trash2 size={13} /> Eliminar
          </Button>
        </div>
      </div>
      <p className="mt-2.5 border-t border-line/60 pt-2.5 text-xs leading-5 text-subtle">
        El kit contiene las copias cifradas. Para leerlas en tu equipo, descomprímelo y ejecuta{' '}
        <span className="font-mono">descodificar.sh</span> (Linux y macOS) o <span className="font-mono">descodificar.bat</span>{' '}
        (Windows): piden la contraseña de las copias y dejan los datos legibles en la carpeta{' '}
        <span className="font-mono">descodificado</span>. Para restaurar en un servidor nuevo, utiliza{' '}
        <span className="font-mono">sudo bash restaurar.sh --kit {kit.fichero ?? 'kit.zip'}</span>.
      </p>
    </div>
  );
}

/** Una copia de la lista: resumen, kits que se pueden pedir y órdenes para restaurarla. */
function FilaEjecucion({
  ejecucion,
  abierta,
  onAlternar,
  pedir,
  cargando,
  bloqueo,
}: {
  ejecucion: Ejecucion;
  abierta: boolean;
  onAlternar: () => void;
  pedir: (p: NuevaPeticion) => void;
  cargando: (p: NuevaPeticion) => boolean;
  bloqueo: string | null;
}) {
  const e = ejecucion;
  const completa = !e.alcance || e.alcance === 'todo';
  const conSkyway = completa || e.alcance === 'skyway';
  const kit = (alcance: AlcanceKit, proyecto?: string): NuevaPeticion => ({ accion: 'kit', alcance, proyecto, ejecucion: e.id });
  const resumen = [
    motivoDe(e.motivo),
    e.tamano !== null ? fmtBytes(e.tamano) : null,
    e.proyectos.length > 0 ? plural(e.proyectos.length, 'proyecto', 'proyectos') : null,
    e.correo === true ? 'con correo' : e.correo === false ? 'sin correo' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const detalle = [
    e.versiones?.skyway ? `Skyway ${e.versiones.skyway}` : null,
    e.versiones?.mailway ? `Mailway ${e.versiones.mailway}` : null,
    e.elementos !== null ? plural(e.elementos, 'elemento', 'elementos') : null,
    `ejecución ${e.id}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="border-b border-line/60 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-bg px-3.5 py-2.5">
        <button
          type="button"
          onClick={onAlternar}
          aria-expanded={abierta}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          title={abierta ? 'Ocultar detalles' : 'Ver detalles, kits y órdenes para restaurar'}
        >
          <ChevronDown
            size={13}
            aria-hidden
            className={cx('mt-0.5 shrink-0 text-subtle transition-transform duration-200', abierta && 'rotate-180')}
          />
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="tnum text-xs font-medium text-txt">{fmtFecha(e.fecha) ?? e.id}</span>
              <ChipResultado resultado={e.resultado} />
            </span>
            {resumen && <span className="mt-0.5 block text-xs text-subtle">{resumen}</span>}
          </span>
        </button>
        {completa && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => pedir(kit('todo'))}
            loading={cargando(kit('todo'))}
            disabled={bloqueo !== null}
            title={bloqueo ?? 'Prepara un ZIP con toda la copia para guardarlo en tu equipo'}
          >
            <FileArchive size={13} /> Preparar kit
          </Button>
        )}
      </div>

      {abierta && (
        <div className="flex flex-col gap-3 border-t border-line/60 bg-surface px-3.5 py-3 text-xs">
          <p className="tnum text-subtle">{detalle}</p>

          {(conSkyway || e.correo === true) && (
            <div>
              <p className="font-medium text-sub">Kit de una parte</p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {conSkyway && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => pedir(kit('skyway'))}
                    loading={cargando(kit('skyway'))}
                    disabled={bloqueo !== null}
                    title={bloqueo ?? 'Prepara un ZIP solo con la parte de Skyway de esta copia'}
                  >
                    Preparar kit de Skyway
                  </Button>
                )}
                {e.correo === true && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => pedir(kit('correo'))}
                    loading={cargando(kit('correo'))}
                    disabled={bloqueo !== null}
                    title={bloqueo ?? 'Prepara un ZIP solo con el correo (Mailway) de esta copia'}
                  >
                    Preparar kit del correo
                  </Button>
                )}
              </div>
            </div>
          )}

          <div>
            <p className="font-medium text-sub">Restaurar en el servidor</p>
            <p className="mt-0.5 leading-5 text-subtle">
              Ejecuta la orden en la terminal del servidor; pide confirmación antes de sustituir los datos actuales.
            </p>
            {completa && <Orden orden={`sudo skyway copias restaurar todo --ejecucion ${e.id}`} />}
            {e.correo === true && <Orden orden={`sudo skyway copias restaurar correo --ejecucion ${e.id}`} />}
            {e.proyectos.length > 0 && (
              <p className="mt-1.5 text-subtle">Para restaurar un solo proyecto, utiliza la orden de su apartado en «Proyectos».</p>
            )}
          </div>

          {e.proyectos.length > 0 && (
            <div>
              <p className="font-medium text-sub">Proyectos</p>
              <div className="mt-1.5 flex flex-col gap-2.5">
                {e.proyectos.map((p) => (
                  <div key={p.id} className="rounded-lg border border-line bg-bg px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0">
                        <span className="font-medium text-txt">{p.nombre ?? p.slug ?? p.id}</span>
                        {p.slug && <span className="ml-1.5 font-mono text-subtle">{p.slug}</span>}
                        {!p.enPanel && <span className="ml-1.5 text-subtle">· ya no está en el panel</span>}
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => pedir(kit('proyecto', p.id))}
                        loading={cargando(kit('proyecto', p.id))}
                        disabled={bloqueo !== null || !p.enPanel}
                        title={
                          !p.enPanel
                            ? 'El proyecto ya no existe en el panel: restáuralo desde el servidor con la orden indicada.'
                            : (bloqueo ?? 'Prepara un ZIP solo con este proyecto')
                        }
                      >
                        <FileArchive size={13} /> Preparar kit
                      </Button>
                    </div>
                    <Orden orden={`sudo skyway copias restaurar proyecto ${p.slug ?? p.id} --ejecucion ${e.id}`} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ListaEjecuciones({
  ejecuciones,
  pedir,
  cargando,
  bloqueo,
  programada,
}: {
  ejecuciones: Ejecucion[] | null;
  pedir: (p: NuevaPeticion) => void;
  cargando: (p: NuevaPeticion) => boolean;
  bloqueo: string | null;
  programada: string | null;
}) {
  const [abierta, setAbierta] = useState<string | null>(null);
  const [todas, setTodas] = useState(false);

  if (ejecuciones === null) {
    return (
      <Aviso tono="warn">
        No se puede leer la lista de copias (<span className="font-mono">copias/ejecuciones.json</span>). Consúltala en el servidor
        con <span className="font-mono">sudo skyway copias lista</span>.
      </Aviso>
    );
  }
  if (ejecuciones.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line px-3.5 py-4 text-center text-xs text-subtle">
        Todavía no hay ninguna copia.{programada ? ` La primera se hará ${programada}` : ''}
        {programada ? '; también puedes pulsar «Hacer copia ahora».' : ' Pulsa «Hacer copia ahora» para hacer la primera.'}
      </p>
    );
  }
  const visibles = todas ? ejecuciones : ejecuciones.slice(0, EJECUCIONES_VISIBLES);
  return (
    <div>
      <div className="overflow-hidden rounded-lg border border-line">
        {visibles.map((e) => (
          <FilaEjecucion
            key={e.id}
            ejecucion={e}
            abierta={abierta === e.id}
            onAlternar={() => setAbierta((actual) => (actual === e.id ? null : e.id))}
            pedir={pedir}
            cargando={cargando}
            bloqueo={bloqueo}
          />
        ))}
      </div>
      {ejecuciones.length > EJECUCIONES_VISIBLES && (
        <Button variant="ghost" size="sm" className="mt-1.5" onClick={() => setTodas((t) => !t)}>
          {todas ? 'Mostrar solo las recientes' : `Mostrar todas (${ejecuciones.length})`}
        </Button>
      )}
    </div>
  );
}

/**
 * Ajustes → Copias externas. Las hace el servidor (`skyway copias`) y el panel
 * solo lee su estado y le deja peticiones: copia, comprobación o kit. Las
 * restauraciones se ofrecen como órdenes para la terminal del servidor, porque
 * deben funcionar aunque el panel no lo haga.
 */
export default function CopiasExternas() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [confirmarEliminar, setConfirmarEliminar] = useState(false);

  const copias = useQuery({
    queryKey: ['copiasExternas'],
    queryFn: () => api.get<SituacionCopias>('/system/copias-externas'),
    // Mientras el servidor trabaja, o aún no ha recogido la petición, se sigue su avance.
    refetchInterval: (q) => (q.state.data?.ocupada ? 10_000 : false),
  });

  const pedir = useMutation({
    mutationFn: (p: NuevaPeticion) => api.post<{ ok: boolean }>('/system/copias-externas/peticiones', p),
    onSuccess: (_res, p) => {
      toast(mensajeEnviada(p, !!copias.data?.kitDisponible), 'ok');
      queryClient.invalidateQueries({ queryKey: ['copiasExternas'] });
    },
    onError: (err: Error) => {
      toast(err.message, 'err');
      // Un 409 suele significar que el estado ha cambiado: se muestra el actual.
      queryClient.invalidateQueries({ queryKey: ['copiasExternas'] });
    },
  });

  const eliminarKit = useMutation({
    mutationFn: () => api.del<{ ok: boolean }>('/system/copias-externas/kit'),
    onSuccess: () => {
      setConfirmarEliminar(false);
      toast('Kit eliminado del servidor', 'ok');
      queryClient.invalidateQueries({ queryKey: ['copiasExternas'] });
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  if (copias.isLoading) return <Skeleton className="h-32 w-full rounded-lg" />;
  if (copias.isError || !copias.data) {
    return (
      <ErrorState
        compact
        className="rounded-lg border border-dashed border-line"
        title="No se ha podido consultar el estado de las copias externas"
        error={copias.error}
        onRetry={() => copias.refetch()}
        retrying={copias.isFetching}
      />
    );
  }

  const datos = copias.data;
  const estado = datos.estado;
  if (!datos.instalada || !estado) return <SinInstalar ilegible={datos.estadoIlegible} />;

  const programacion = estado.programacion;
  const desactivada = programacion?.activa === false;
  const bloqueo = desactivada
    ? 'La copia diaria está desactivada: el servidor no atiende las peticiones del panel.'
    : datos.ocupada
      ? 'Hay una operación o una petición en curso. Espera a que termine.'
      : pedir.isPending
        ? 'Enviando la petición…'
        : null;
  const cargando = (p: NuevaPeticion) => pedir.isPending && claveDe(pedir.variables) === claveDe(p);
  const lanzar = (p: NuevaPeticion) => pedir.mutate(p);

  const ultima = estado.ultima;
  const proxima = programacion?.activa ? fmtFecha(programacion.proxima) : null;
  const programada = proxima ? `el ${proxima}` : programacion?.activa && programacion.hora ? `a las ${programacion.hora}` : null;
  const finCorrecta = instante(estado.ultimaCorrecta?.fin);
  const destino = estado.destino;
  const destinoTexto = destino
    ? [destino.endpoint?.replace(/^https?:\/\//, ''), [destino.bucket, destino.prefijo].filter(Boolean).join('/')].filter(Boolean).join(' · ')
    : '';
  const actualizado = instante(estado.actualizado);
  const datosUltima = ultima
    ? [
        motivoDe(ultima.motivo),
        ultima.duracionS !== null ? `duración ${fmtDuracion(ultima.duracionS)}` : null,
        ultima.bytesNuevos !== null ? `${fmtBytes(ultima.bytesNuevos)} nuevos` : null,
        ultima.elementos !== null ? plural(ultima.elementos, 'elemento', 'elementos') : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  // En una copia correcta el detalle del host resume lo mismo que la línea de datos; en una fallida trae el motivo.
  const detalleUltima = ultima && ultima.resultado !== 'correcta' && ultima.resultado !== 'con-avisos' ? ultima.detalle : null;
  const comprobacion = estado.ultimaComprobacion;
  const prueba = estado.ultimaPruebaRestauracion;

  return (
    <div className="flex flex-col gap-3.5">
      <ConfirmModal
        open={confirmarEliminar}
        onClose={() => setConfirmarEliminar(false)}
        onConfirm={() => eliminarKit.mutate()}
        loading={eliminarKit.isPending}
        title="Eliminar el kit"
        message="Se eliminará el kit del servidor. Las copias del almacenamiento S3 no cambian: puedes preparar otro kit cuando lo necesites."
        confirmLabel="Eliminar kit"
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {programacion?.activa ? (
          <Chip size="sm" tone="ok" dot>
            Copia diaria{programacion.hora ? ` a las ${programacion.hora}` : ' activada'}
          </Chip>
        ) : desactivada ? (
          <Chip size="sm" tone="warn" dot>
            Copia diaria desactivada
          </Chip>
        ) : null}
        {destinoTexto && (
          <span className="min-w-0 break-all font-mono text-xs text-subtle" title="Destino de las copias">
            {destinoTexto}
          </span>
        )}
        {actualizado !== null && <span className="text-xs text-subtle">Estado actualizado {timeAgo(actualizado)}</span>}
      </div>

      {desactivada && (
        <Aviso tono="warn">
          La copia diaria está desactivada y el servidor no atiende las peticiones de este panel. Para activarla, ejecuta en el
          servidor:
          <Orden orden="sudo skyway copias activar" />
        </Aviso>
      )}

      <Actividad datos={datos} />

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Dato
          etiqueta="Última copia"
          valor={ultima ? (fmtFecha(ultima.fin ?? ultima.inicio) ?? ultima.id ?? 'Sin fecha') : 'Ninguna'}
          detalle={ultima ? <ChipResultado resultado={ultima.resultado} /> : 'Todavía no se ha hecho ninguna.'}
        />
        <Dato
          etiqueta="Última correcta"
          valor={fmtFecha(estado.ultimaCorrecta?.fin) ?? 'Ninguna'}
          detalle={finCorrecta !== null ? timeAgo(finCorrecta) : 'Todavía no hay ninguna copia correcta.'}
        />
        <Dato
          etiqueta="Próxima copia"
          valor={programacion?.activa ? (proxima ?? 'Programada') : desactivada ? 'Sin programar' : 'Sin datos'}
          detalle={
            programacion?.activa
              ? programacion.hora
                ? `Cada día a las ${programacion.hora}`
                : 'Copia diaria activada'
              : desactivada
                ? 'Copia diaria desactivada'
                : 'El servidor no indica la programación.'
          }
        />
        <Dato
          etiqueta="Última comprobación"
          valor={fmtFecha(comprobacion?.fecha) ?? 'Ninguna'}
          detalle={comprobacion?.resultado ? <ChipResultado resultado={comprobacion.resultado} /> : 'Todavía no se han comprobado.'}
        />
      </div>

      {prueba?.fecha && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
          <span>
            Última restauración de prueba: {fmtFecha(prueba.fecha)}
            {prueba.ejecucion ? `, de la copia ${prueba.ejecucion}` : ''}
          </span>
          {prueba.resultado && <ChipResultado resultado={prueba.resultado} />}
          {prueba.resultado && prueba.resultado !== 'correcta' && prueba.detalle && (
            <span className="basis-full break-words text-sub">{prueba.detalle}</span>
          )}
        </div>
      )}

      {ultima && (datosUltima || detalleUltima || (ultima.avisos?.length ?? 0) > 0) && (
        <div className="rounded-lg border border-line bg-bg px-3.5 py-3 text-xs leading-5">
          <p className="font-medium text-sub">Última copia{ultima.id ? ` (${ultima.id})` : ''}</p>
          {datosUltima && <p className="tnum text-subtle">{datosUltima}</p>}
          {detalleUltima && <p className="mt-1 break-words text-sub">{detalleUltima}</p>}
          {(ultima.avisos?.length ?? 0) > 0 && (
            <ul className="mt-1.5 space-y-1 text-warn">
              {ultima.avisos!.map((aviso, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <AlertTriangle size={12} className="mt-1 shrink-0" aria-hidden />
                  <span className="break-words">{aviso}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {comprobacion?.resultado && comprobacion.resultado !== 'correcta' && comprobacion.detalle && (
        <Aviso tono={comprobacion.resultado === 'fallida' ? 'err' : 'warn'}>
          Última comprobación: {comprobacion.detalle}
        </Aviso>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => lanzar({ accion: 'copia' })}
          loading={cargando({ accion: 'copia' })}
          disabled={bloqueo !== null}
          title={bloqueo ?? 'Pide al servidor una copia completa ahora'}
        >
          <CloudUpload size={13} /> Hacer copia ahora
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => lanzar({ accion: 'comprobar' })}
          loading={cargando({ accion: 'comprobar' })}
          disabled={bloqueo !== null}
          title={bloqueo ?? 'Comprueba que el repositorio de copias del almacenamiento S3 está completo y sin errores'}
        >
          <ShieldCheck size={13} /> Comprobar copias
        </Button>
        {datos.ocupada && !desactivada && <span className="text-xs text-subtle">{bloqueo}</span>}
      </div>

      <KitActual
        datos={datos}
        onEliminar={() => setConfirmarEliminar(true)}
        onDescartar={() => eliminarKit.mutate()}
        descartando={eliminarKit.isPending && !confirmarEliminar}
      />

      <div>
        <h3 className="mb-1 text-sm font-semibold">Copias disponibles</h3>
        <p className="mb-2.5 text-xs leading-5 text-subtle">
          Despliega una copia para preparar un kit (un ZIP con las copias cifradas para guardarlo en tu equipo) o para ver las
          órdenes que la restauran en el servidor.
        </p>
        <ListaEjecuciones
          ejecuciones={datos.ejecuciones}
          pedir={lanzar}
          cargando={cargando}
          bloqueo={bloqueo}
          programada={programada}
        />
      </div>

      <details className="group animate-details">
        <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-sub hover:text-txt">
          <ChevronDown size={12} className="shrink-0 transition-transform duration-200 ease-out group-open:rotate-180" />
          Restaurar en un servidor nuevo
        </summary>
        <div className="details-body mt-1.5 text-xs leading-5 text-subtle">
          <p>
            Si el servidor no se puede recuperar, prepara uno nuevo con el sistema operativo instalado y ejecuta como root el script{' '}
            <span className="font-mono">restaurar.sh</span> (está en el kit y en <span className="font-mono">scripts/copias/</span>{' '}
            de Skyway). Pide los datos de recuperación, permite elegir la copia y restaura todo:
          </p>
          <Orden orden="sudo bash restaurar.sh" />
          <p className="mt-2">Con un kit descargado, sin acceder al almacenamiento S3:</p>
          <Orden orden="sudo bash restaurar.sh --kit kit.zip" />
        </div>
      </details>
    </div>
  );
}
