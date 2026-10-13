import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  FileDown,
  FileText,
  Layers,
  Mail,
  Plus,
  Search,
  Table,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../../api';
import { maskValue } from '../../helpText';
import { EnvImportReport, EnvImportResponse, EnvSkipReason } from '../../types';
import { EnvSuggestion } from '../../types';
import { copyToClipboard, cx, EMPTY_LIST, EMPTY_RECORD, tieneClave } from '../../utils';
import { IntegrationsPanel } from '../IntegrationPlan';
import { Button, CopyButton, EditorBar, ErrorState, Modal, Segmented, Skeleton, useToast } from '../ui';

/** Por qué se dejó fuera una clave del .env del repositorio, en palabras. */
const SKIP_REASON_LABEL: Record<EnvSkipReason, string> = {
  invalid_key: 'nombre no válido',
  reserved: 'reservada por Skyway',
  placeholder: 'valor de ejemplo',
  localhost: 'apunta a localhost',
  exists: 'ya definida',
  handled: 'procesada en una importación anterior',
};

/**
 * Vista previa de la importación del .env del repositorio. Tres listas y una
 * decisión: lo que entra, lo que hay que rellenar a mano y lo que se ignora
 * (con su motivo). Los valores van tapados por defecto: pueden ser secretos.
 */
function ImportRepoModal({
  open,
  onClose,
  report,
  done,
  applying,
  onApply,
  onAddPending,
}: {
  open: boolean;
  onClose: () => void;
  report: EnvImportReport | null;
  /** Respuesta tras aplicar: el modal pasa a contar qué se hizo y qué queda. */
  done: EnvImportResponse | null;
  applying: boolean;
  onApply: () => void;
  onAddPending: (keys: string[]) => void;
}) {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  // Cada vista previa empieza con todo tapado.
  useEffect(() => {
    if (open) setRevealed(new Set());
  }, [open, report]);

  if (!report) return null;
  const pendingKeys = report.pending.map((p) => p.key);
  const n = report.imported.length;

  const listBox = 'divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface';

  return (
    <Modal open={open} onClose={onClose} title="Importar variables del repositorio" wide>
      {done ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-sub">{done.message}</p>
          {done.report.pending.length > 0 && (
            <div className="rounded-lg border border-warn/35 bg-warn/[.07] p-3 text-xs">
              <p className="flex items-center gap-1.5 font-semibold text-warn">
                <AlertTriangle size={13} /> {done.report.pending.length === 1 ? '1 variable sin valor' : `${done.report.pending.length} variables sin valor`}
              </p>
              <p className="mt-1 text-sub">
                En el repositorio figuran vacías o con un valor de ejemplo. Es necesario introducir su valor manualmente.
              </p>
              <p className="mt-1.5 break-words font-mono text-txt">{done.report.pending.map((p) => p.key).join(', ')}</p>
            </div>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onClose} className="max-sm:h-11">
              Cerrar
            </Button>
            {done.report.pending.length > 0 && (
              <Button
                onClick={() => {
                  onAddPending(done.report.pending.map((p) => p.key));
                  onClose();
                }}
                className="max-sm:h-11"
              >
                <Plus size={13} /> Añadir pendientes como filas vacías
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {report.files.length === 0 ? (
            <p className="rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-sub">
              No se ha encontrado ningún <span className="font-mono text-txt">.env</span> ni{' '}
              <span className="font-mono text-txt">.env.example</span> en el repositorio.
            </p>
          ) : (
            <p className="text-xs text-subtle">
              Leído de{' '}
              {report.files.map((f, i) => (
                <span key={f}>
                  {i > 0 && ', '}
                  <span className="font-mono text-txt">{f}</span>
                </span>
              ))}
              {report.files.length > 1 && ' (si una clave se repite, prevalece el último archivo)'}. No se guarda nada hasta que se pulse «Importar».
            </p>
          )}

          {/* Se importarán */}
          <section>
            <h4 className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-txt">
              Se importarán <span className="tnum font-mono text-xs text-subtle">{n}</span>
            </h4>
            {n === 0 ? (
              <p className="text-xs text-subtle">No hay variables nuevas con un valor válido.</p>
            ) : (
              <ul className={listBox}>
                {report.imported.map((v) => {
                  const shown = revealed.has(v.key);
                  return (
                    <li key={v.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs sm:flex-nowrap">
                      <span className="min-w-0 flex-1 truncate font-mono font-medium text-txt" title={v.key}>
                        {v.key}
                      </span>
                      <span className="hidden shrink-0 text-subtle sm:inline">{v.file}</span>
                      <span className="flex w-full min-w-0 items-center gap-1 sm:w-auto sm:max-w-[45%]">
                        <span className={cx('min-w-0 flex-1 truncate font-mono', shown ? 'text-sub' : 'text-subtle')}>
                          {shown ? v.value ?? '' : maskValue(v.value ?? '')}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setRevealed((prev) => {
                              const next = new Set(prev);
                              if (next.has(v.key)) next.delete(v.key);
                              else next.add(v.key);
                              return next;
                            })
                          }
                          className={cx(
                            'press flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-subtle hover:bg-surface2 hover:text-txt sm:h-7 sm:w-7',
                            shown && 'text-acc-soft',
                          )}
                          title={shown ? 'Ocultar valor' : 'Mostrar valor'}
                          aria-label={shown ? `Ocultar el valor de ${v.key}` : `Mostrar el valor de ${v.key}`}
                        >
                          {shown ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Pendientes */}
          {report.pending.length > 0 && (
            <section>
              <h4 className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-txt">
                Pendientes de valor <span className="tnum font-mono text-xs text-subtle">{report.pending.length}</span>
              </h4>
              <p className="mb-1.5 text-xs text-subtle">Figuran vacías o con un valor de ejemplo. Es necesario introducir su valor manualmente.</p>
              <ul className={listBox}>
                {report.pending.map((v) => (
                  <li key={v.key} className="flex items-center gap-3 px-3 py-2 text-xs">
                    <span className="min-w-0 flex-1 truncate font-mono font-medium text-warn" title={v.key}>
                      {v.key}
                    </span>
                    <span className="shrink-0 text-subtle">{v.file}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Ignoradas */}
          {report.skipped.length > 0 && (
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-sub hover:text-txt">
                Ignoradas <span className="tnum font-mono text-xs text-subtle">{report.skipped.length}</span>
                <span className="ml-auto text-xs font-normal text-subtle group-open:hidden">Ver motivos</span>
              </summary>
              <ul className={cx(listBox, 'mt-1.5')}>
                {report.skipped.map((v) => (
                  <li key={`${v.key}:${v.file}`} className="flex items-center gap-3 px-3 py-2 text-xs">
                    <span className="min-w-0 flex-1 truncate font-mono text-subtle" title={v.key}>
                      {v.key}
                    </span>
                    <span className="shrink-0 text-subtle">{SKIP_REASON_LABEL[v.reason] ?? v.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
            <Button variant="ghost" onClick={onClose} className="max-sm:h-11">
              Cancelar
            </Button>
            {pendingKeys.length > 0 && (
              <Button
                variant="secondary"
                onClick={() => {
                  onAddPending(pendingKeys);
                  onClose();
                }}
                className="max-sm:h-11"
                title="Inserta las claves sin valor en la tabla para completarlas"
              >
                <Plus size={13} /> Añadir pendientes como filas vacías
              </Button>
            )}
            <Button onClick={onApply} loading={applying} disabled={n === 0} className="max-sm:h-11">
              <FileDown size={13} /> {n === 1 ? 'Importar 1 variable' : `Importar ${n} variables`}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

interface ReferenceGroup {
  service: string;
  template: string | null;
  vars: string[];
  /** Las que calcula Skyway (INTERNAL_URL, PUBLIC_URL…): no están guardadas, pero se referencian igual. */
  auto: string[];
  /** Lo que «Conectar a…» copia: la URL del motor en una base (tres en S3), la URL interna en una app. */
  connect: string[];
}

interface EnvResponse {
  vars: Record<string, string>;
  resolved: Record<string, string>;
  references: ReferenceGroup[];
  /** Lo que la detección del último despliegue encontró en el repositorio; null si nada o si no es un servicio de repositorio. */
  needs: { engines: { template: string; label: string; evidence: string }[]; sources: string[] } | null;
  suggestions: EnvSuggestion[];
  /** Variables que el repositorio espera (de .env.example) sin sugerencia automática y que no están definidas. */
  missing: string[];
  /** La web envía correo: modo y nombres de las variables de correo que espera. */
  mail?: { mode: 'smtp' | 'api'; vars: { name: string; role: string }[]; evidence: string[] } | null;
  /** skyway.json del repositorio (si lo hay): manda sobre la detección. */
  manifest?: { file: string; error: string | null } | null;
  /**
   * Lo que el .env del repositorio dejó sin valor en el último despliegue y
   * sigue sin cubrir: sin lo ya definido (también compartido), lo que pone
   * Skyway sola y lo que proponen el correo o el manifiesto.
   */
  repoPending?: { key: string; file: string }[];
}

interface Row {
  id: string;
  key: string;
  value: string;
  /**
   * El nombre llegó con minúsculas (guardado así antes, o así lo espera el
   * repositorio) y lo que se escriba en él se respeta tal cual. En el resto
   * de filas el nombre pasa a mayúsculas mientras se escribe.
   */
  keepCase: boolean;
}

/** Qué le pasa a una fila respecto a lo guardado: es lo que la tiñe. */
type RowStatus = 'saved' | 'new' | 'changed';

const hasLowercase = (s: string) => s !== s.toUpperCase();

/** Generador de ID único local para filas */
let rowCounter = 0;
function makeRow(key = '', value = ''): Row {
  return { id: `var_${Date.now()}_${++rowCounter}`, key, value, keepCase: hasLowercase(key) };
}

/**
 * Filas a partir de lo guardado, ordenadas por clave. El servidor devuelve el
 * orden de inserción, que en una lista de treinta variables no ayuda a
 * encontrar nada; alfabético sí. Solo se aplica al cargar y al descartar: las
 * filas nuevas se añaden al final y nada se reordena mientras se edita, para
 * que un campo no cambie de sitio debajo del dedo.
 */
const rowsFromVars = (vars: Record<string, string>): Row[] =>
  Object.entries(vars)
    .sort(([a], [b]) => a.localeCompare(b, 'es'))
    // El id sale de la clave (única en lo guardado), no de un contador: con
    // ids nuevos en cada recarga React remontaba todos los campos, se perdía
    // el foco mientras escribías y se cerraban los valores revelados.
    .map(([key, value]) => ({ id: `k:${key}`, key, value, keepCase: hasLowercase(key) }));

/** Variables típicas que casi toda app necesita, para añadirlas en un clic. */
// PORT no está: Skyway la pone sola con el puerto interno del servicio, y
// proponer 3000 a mano la desviaba en cuanto el puerto era otro.
const SUGGESTED_VARS: { key: string; value: string; hint: string }[] = [
  { key: 'NODE_ENV', value: 'production', hint: 'Modo de ejecución para apps Node' },
  { key: 'TZ', value: 'Europe/Madrid', hint: 'Zona horaria del contenedor' },
  { key: 'LOG_LEVEL', value: 'info', hint: 'Nivel de registro de la aplicación' },
];

/**
 * Nombre con el que un servicio recibe la URL interna de otro: «api» → API_URL,
 * «bot-lewspain» → BOT_LEWSPAIN_URL. En una base de datos la clave es la
 * misma que exporta (DATABASE_URL), que es lo que las librerías buscan.
 */
const connectKey = (group: ReferenceGroup, v: string): string =>
  group.template ? v : `${group.service.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'SERVICE'}_URL`;

const RAILWAY_RE = /railway\.internal|railway\.app|rlwy\.net/i;

/** Deduce a qué tipo de base apunta un valor heredado de Railway (por esquema, luego por clave). */
const guessTemplate = (key: string, value: string): string | null => {
  if (/^postgres(?:ql)?:\/\//i.test(value)) return 'postgres';
  if (/^rediss?:\/\//i.test(value)) return 'redis';
  if (/^mysql:\/\//i.test(value)) return 'mysql';
  if (/^mongodb(?:\+srv)?:\/\//i.test(value)) return 'mongo';
  if (/^(?:DATABASE|PG|POSTGRES)/i.test(key)) return 'postgres';
  if (/^REDIS/i.test(key)) return 'redis';
  if (/^MYSQL/i.test(key)) return 'mysql';
  if (/^MONGO/i.test(key)) return 'mongo';
  if (/^(?:MINIO|S3)/i.test(key)) return 'minio';
  return null;
};

const isReference = (v: string) => v.includes('${{');

/** Nombre de variable válido: es lo que permite partir «A=1 B=2» en dos sin partir un valor con espacios. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Quita las comillas que envuelven un valor de .env («"abc"» → «abc»), solo si casan. */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1);
  return value;
}

/**
 * Lee variables de un texto pegado, en cualquiera de las formas en que suele
 * llegar: un .env (una por línea), «export CLAVE=valor», o varias en la misma
 * línea separadas por espacios («A=1 B=2»). Un `<input>` de una línea se come
 * los saltos al pegar, así que lo primero que llega aquí es el texto del
 * portapapeles tal cual, no lo que el campo dejó pasar.
 */
export function parseEnvText(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    // Parte por espacios solo cuando lo que sigue es otro «CLAVE=»: así un
    // valor con espacios («MSG=hola mundo») sigue siendo un solo valor.
    const chunks = line.split(/\s+(?=[A-Za-z_][A-Za-z0-9_.-]*=)/);
    for (const chunk of chunks) {
      const eq = chunk.indexOf('=');
      if (eq <= 0) continue;
      const key = chunk.slice(0, eq).trim();
      if (!KEY_RE.test(key)) continue;
      out.push({ key, value: unquote(chunk.slice(eq + 1)) });
    }
  }
  return out;
}

/**
 * Nombre con el que se guarda una variable leída de un texto (pegado, vista
 * .env): en mayúsculas, la convención de las variables de entorno. Los nombres
 * de `keepCase` (los que ya existen, o los que el repositorio espera con
 * minúsculas) se dejan como están: cambiarlos sería borrar la variable y crear
 * otra, y la aplicación, que la busca por su nombre exacto, no la encontraría.
 */
export function upperKey(key: string, keepCase: ReadonlySet<string>): string {
  return keepCase.has(key) ? key : key.toUpperCase();
}

/**
 * Cambia el texto de un campo sin mover el cursor. Si se deja a React, al
 * llegarle un valor distinto del que hay en pantalla lo reescribe entero y el
 * cursor salta al final: corregir una letra en medio de un nombre lo mandaría
 * al final en cada pulsación.
 */
function setFieldKeepingCaret(el: HTMLInputElement | undefined, value: string) {
  if (!el || el.value === value) return;
  const { selectionStart, selectionEnd } = el;
  el.value = value;
  if (selectionStart !== null && selectionEnd !== null) el.setSelectionRange(selectionStart, selectionEnd);
}

const SUGGEST_LIST = 'divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface';
/** Con el pulgar, 40px de alto; con ratón, compacto. */
const SUGGEST_BTN =
  'press flex h-8 shrink-0 items-center justify-center gap-1 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-sub transition-colors hover:border-acc/40 hover:text-txt disabled:cursor-not-allowed disabled:opacity-60 max-sm:h-10 max-sm:px-3';

/** Una variable sugerida: su nombre, para qué sirve y su acción. */
function SuggestionItem({ name, detail, children }: { name: string; detail: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="break-words font-mono font-semibold text-txt">{name}</p>
        <p className="mt-0.5 break-words text-subtle">{detail}</p>
      </div>
      {children}
    </li>
  );
}

/** Acciones de una fila: un objeto estable, para que las filas memoizadas no se repinten con cada tecla. */
interface RowActions {
  /** `composing`: el teclado aún está componiendo (IME, teclados de Android); ver `handleKeyChange`. */
  keyChange: (id: string, raw: string, composing: boolean) => void;
  valueChange: (id: string, value: string) => void;
  paste: (id: string, field: 'key' | 'value', e: React.ClipboardEvent<HTMLInputElement>) => void;
  toggleReveal: (id: string) => void;
  remove: (id: string) => void;
  addRow: () => void;
  focusKey: (id: string) => void;
  focusValue: (id: string) => void;
}

/*
 * Los valores tapados se ocultan con CSS sobre un campo de texto, no con
 * `type="password"`: en iOS un campo de contraseña activa el gestor de
 * contraseñas y el llavero en cada pulsación y, con decenas de campos en la
 * misma pantalla, la página deja de responder mientras escribe. Donde el
 * navegador no admite ese CSS se conserva el campo de contraseña.
 */
const MASK_WITH_CSS = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('-webkit-text-security', 'disc');

/**
 * Una variable de la tabla. Va en `memo`: cada tecla actualiza una sola fila
 * y las demás reciben exactamente las mismas props, así que no se repintan.
 */
const VariableRow = memo(function VariableRow({
  row,
  isLast,
  isRevealed,
  isRef,
  isDup,
  status,
  resolvedValue,
  nextRowId,
  actions,
  keyInputRefs,
  valueInputRefs,
}: {
  row: Row;
  isLast: boolean;
  isRevealed: boolean;
  isRef: boolean;
  isDup: boolean;
  status: RowStatus;
  resolvedValue: string;
  nextRowId: string | null;
  actions: RowActions;
  keyInputRefs: React.MutableRefObject<Map<string, HTMLInputElement>>;
  valueInputRefs: React.MutableRefObject<Map<string, HTMLInputElement>>;
}) {
  const rail = status === 'new' ? 'bg-acc-soft' : status === 'changed' ? 'bg-warn' : 'bg-transparent';
  const masked = !isRevealed && !isRef;
  return (
    <div
      className={cx(
        'group relative flex flex-col rounded-xl border border-line bg-surface transition-colors duration-150 sm:flex-row sm:items-stretch sm:rounded-none sm:border-0 sm:border-b sm:last:border-b-0 sm:hover:bg-surface2/40',
        /*
         * Lo nuevo y lo cambiado se ven sin leer: tinte suave
         * de fondo, un riel de color a la izquierda y una
         * etiqueta. Al guardar vuelven al gris de lo que ya está.
         */
        status === 'new' && 'border-acc/35 bg-acc/[.06] sm:bg-acc/[.05] sm:hover:bg-acc/[.08]',
        status === 'changed' && 'border-warn/35 bg-warn/[.05] sm:bg-warn/[.04] sm:hover:bg-warn/[.07]',
        isDup && 'bg-err/[.05] sm:bg-err/[.04]',
      )}
    >
      <span aria-hidden className={cx('absolute inset-y-0 left-0 w-[3px] rounded-l-xl sm:rounded-none', rail)} />

      {/* Nombre */}
      <div className="relative flex min-w-0 items-center gap-2 pl-3.5 pr-2 pt-2 sm:w-[40%] sm:border-r sm:border-line sm:py-0 sm:pr-0">
        <span className="eyebrow w-12 shrink-0 text-subtle sm:hidden">Nombre</span>
        <input
          ref={(el) => {
            if (el) keyInputRefs.current.set(row.id, el);
            else keyInputRefs.current.delete(row.id);
          }}
          className={cx(
            'h-9 min-w-0 flex-1 rounded-md bg-transparent px-2 font-mono text-xs font-medium text-txt outline-none placeholder:text-subtle focus:bg-surface2/60 sm:h-auto sm:rounded-none sm:px-3.5 sm:py-2.5',
            isDup && 'font-bold text-err',
          )}
          placeholder="NOMBRE_VARIABLE"
          value={row.key}
          spellCheck={false}
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          onChange={(e) => actions.keyChange(row.id, e.target.value, (e.nativeEvent as Partial<InputEvent>).isComposing === true)}
          onCompositionEnd={(e) => actions.keyChange(row.id, e.currentTarget.value, false)}
          onPaste={(e) => actions.paste(row.id, 'key', e)}
          onKeyDown={(e) => {
            if (e.key === '=' || e.key === 'Enter') {
              e.preventDefault();
              actions.focusValue(row.id);
            }
          }}
        />
        {isDup ? (
          <span className="shrink-0 rounded bg-err/15 px-1.5 py-0.5 text-micro font-bold text-err sm:mr-2">Duplicada</span>
        ) : status === 'new' ? (
          <span className="shrink-0 rounded bg-acc/20 px-1.5 py-0.5 text-micro font-semibold text-acc-soft sm:mr-2">Nueva</span>
        ) : status === 'changed' ? (
          <span className="shrink-0 rounded bg-warn/15 px-1.5 py-0.5 text-micro font-semibold text-warn sm:mr-2">Cambiada</span>
        ) : null}
      </div>

      {/* Valor + acciones */}
      <div className="flex min-w-0 flex-1 items-center gap-2 pb-2 pl-3.5 pr-2 pt-1 sm:py-0 sm:pl-0">
        <span className="eyebrow w-12 shrink-0 text-subtle sm:hidden">Valor</span>
        <input
          ref={(el) => {
            if (el) valueInputRefs.current.set(row.id, el);
            else valueInputRefs.current.delete(row.id);
          }}
          className={cx(
            'h-9 min-w-0 flex-1 rounded-md bg-transparent px-2 font-mono text-xs outline-none placeholder:text-subtle focus:bg-surface2/60 sm:h-auto sm:rounded-none sm:px-3.5 sm:py-2.5',
            isRef ? 'font-medium text-info' : isRevealed ? 'text-txt' : 'text-subtle',
            masked && MASK_WITH_CSS && 'masked-value',
          )}
          placeholder={isRef ? '${{Servicio.VAR}}' : 'valor'}
          type={masked && !MASK_WITH_CSS ? 'password' : 'text'}
          value={row.value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          data-1p-ignore=""
          data-lpignore="true"
          data-form-type="other"
          onChange={(e) => actions.valueChange(row.id, e.target.value)}
          onPaste={(e) => actions.paste(row.id, 'value', e)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (isLast || !nextRowId) actions.addRow();
              else actions.focusKey(nextRowId);
            }
          }}
        />

        <div className="flex shrink-0 items-center gap-0.5 sm:pr-2">
          {!isRef && (
            <button
              type="button"
              onClick={() => actions.toggleReveal(row.id)}
              className={cx(
                'press flex h-8 w-8 items-center justify-center rounded-md text-subtle transition-colors hover:bg-surface2 hover:text-txt sm:h-7 sm:w-7',
                isRevealed && 'text-acc-soft',
              )}
              title={isRevealed ? 'Ocultar valor' : 'Mostrar valor'}
              aria-label={isRevealed ? 'Ocultar valor' : 'Mostrar valor'}
            >
              {isRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          )}
          <CopyButton value={resolvedValue} title="Copiar valor resuelto" />
          <button
            type="button"
            onClick={() => actions.remove(row.id)}
            className="press flex h-8 w-8 items-center justify-center rounded-md text-subtle transition-colors hover:bg-surface2 hover:text-err sm:h-7 sm:w-7"
            title="Eliminar variable"
            aria-label="Eliminar variable"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </div>
  );
});

export default function VariablesTab({
  serviceId,
  serviceType,
  envImport,
  projectId,
  onSaved,
  onDeploy,
  onNeedsRedeploy,
  onDirtyChange,
}: {
  serviceId: string;
  /** Solo los servicios git tienen un repositorio del que importar el .env. */
  serviceType?: 'git' | 'database' | 'image';
  /** Última importación del .env del repositorio (config del servicio). */
  envImport?: EnvImportReport | null;
  projectId: string;
  onSaved: () => void;
  onDeploy?: () => void;
  onNeedsRedeploy?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importReport, setImportReport] = useState<EnvImportReport | null>(null);
  const [importDone, setImportDone] = useState<EnvImportResponse | null>(null);
  const [viewMode, setViewMode] = useState<'table' | 'raw'>('table');
  const [rawText, setRawText] = useState('');
  const [globalReveal, setGlobalReveal] = useState(false);
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [dirty, setDirty] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  // null mientras no se toque: la lista se abre sola si el repositorio espera algo.
  const [suggestOpenPref, setSuggestOpenPref] = useState<boolean | null>(null);
  const suggestPanelId = useId();
  const keyInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const valueInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  /*
   * Claves presentes en la vista abierta; en la de texto, las de sus líneas.
   * Las sugerencias se comparan contra esto para desaparecer en cuanto se
   * añaden, antes incluso de guardar, también desde la vista .env.
   */
  const presentKeys = useMemo(() => {
    if (viewMode !== 'raw') return new Set(rows.map((r) => r.key.trim()));
    /*
     * En el texto, cada nombre cuenta también en mayúsculas, que es como se
     * guardará si es nuevo: con `database_url=…` escrito a mano, la sugerencia
     * DATABASE_URL seguía ofreciéndose y, al añadirla, su línea vacía pisaba
     * el valor al guardar.
     */
    const keys = new Set<string>();
    for (const line of rawText.split('\n')) {
      const eq = line.indexOf('=');
      const key = (eq >= 0 ? line.slice(0, eq) : line).trim();
      if (!key) continue;
      keys.add(key);
      keys.add(key.toUpperCase());
    }
    return keys;
  }, [viewMode, rows, rawText]);

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const env = useQuery({
    queryKey: ['env', serviceId],
    queryFn: () => api.get<EnvResponse>(`/services/${serviceId}/env`),
  });

  // Solo se vuelve a leer del servidor cuando llegan datos NUEVOS. Antes
  // dependía también de `dirty`: al guardar, `dirty` caía a false antes de
  // que llegara la recarga y las filas volvían un instante a los valores viejos.
  const syncedRef = useRef<EnvResponse | null>(null);
  useEffect(() => {
    if (!env.data || env.data === syncedRef.current || dirty) return;
    syncedRef.current = env.data;
    const entries = rowsFromVars(env.data.vars);
    setRows(entries);
    setRawText(entries.map((r) => `${r.key}=${r.value}`).join('\n'));
  }, [env.data, dirty]);

  /*
   * Solo se envían los cambios respecto a lo que se cargó (`syncedRef`), no la
   * tabla entera: mientras se edita, el primer despliegue importa el .env del
   * repositorio, el manifiesto genera secretos y Correo → Conectar escribe las
   * credenciales SMTP. Reemplazar la lista entera los borraba en silencio (y un
   * secreto generado que desaparece se regenera con otro valor al desplegar).
   */
  const save = useMutation({
    mutationFn: (vars: Record<string, string>) => {
      const base = syncedRef.current?.vars ?? {};
      const set: Record<string, string> = {};
      for (const [k, v] of Object.entries(vars)) if (base[k] !== v) set[k] = v;
      const unset = Object.keys(base).filter((k) => !tieneClave(vars, k));
      return api.patch(`/services/${serviceId}/env`, { set, unset });
    },
    onSuccess: () => {
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ['env', serviceId] });
      toast('Variables guardadas.', 'ok', {
        action: onDeploy ? { label: 'Desplegar ahora', onClick: onDeploy } : undefined,
      });
      onNeedsRedeploy?.();
      onSaved();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  /*
   * Importación del .env del repositorio en dos pasos: vista previa (no
   * escribe nada) y aplicación. Los 400 del servidor («solo servicios de
   * GitHub», rate-limit…) llegan como toast, igual que el resto de errores.
   */
  const importPreview = useMutation({
    mutationFn: () => api.post<EnvImportResponse>(`/services/${serviceId}/env/import-repo`, { apply: false }),
    onSuccess: (res) => {
      setImportReport(res.report);
      setImportDone(null);
      setImportOpen(true);
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const importApply = useMutation({
    mutationFn: () => api.post<EnvImportResponse>(`/services/${serviceId}/env/import-repo`, { apply: true }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['env', serviceId] });
      toast(res.message, 'ok', {
        action: onDeploy && res.needsRedeploy ? { label: 'Desplegar ahora', onClick: onDeploy } : undefined,
      });
      if (res.needsRedeploy) onNeedsRedeploy?.();
      onSaved();
      // Con pendientes el modal se queda para ofrecer añadirlas; si no, ya está.
      if (res.report.pending.length > 0) setImportDone(res);
      else setImportOpen(false);
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  /**
   * Nombres que se respetan tal cual al leer texto (pegado o vista .env): los
   * guardados, los de la tabla y los que el repositorio espera con ese nombre
   * exacto. Cualquier otro es nuevo y pasa a mayúsculas (`upperKey`).
   */
  const keepCaseKeys = () =>
    new Set<string>([
      ...Object.keys(env.data?.vars ?? {}),
      ...rows.map((r) => r.key.trim()),
      ...(env.data?.suggestions ?? []).map((s) => s.key),
      ...(env.data?.missing ?? []),
      ...(env.data?.mail?.vars ?? []).map((v) => v.name),
      ...(envImport?.pending ?? []).map((p) => p.key),
    ]);

  /**
   * Añade variables al final de la vista abierta. En la de texto van como
   * líneas `CLAVE=valor`: añadidas solo a la tabla, que en ese modo no se ve,
   * se perderían al volver a ella. Devuelve las filas creadas, para poder
   * llevar el cursor a su valor.
   */
  const appendVars = (entries: { key: string; value: string }[]): Row[] => {
    setDirty(true);
    if (viewMode === 'raw') {
      setRawText((prev) => [prev.trimEnd(), ...entries.map((e) => `${e.key}=${e.value}`)].filter(Boolean).join('\n'));
      return [];
    }
    const fresh = entries.map((e) => makeRow(e.key, e.value));
    setRows((prev) => [...prev, ...fresh]);
    return fresh;
  };

  /**
   * Inserta las claves sin valor como filas vacías (o líneas `CLAVE=` en modo
   * texto) para rellenarlas. Las que ya están en la tabla no se duplican.
   */
  const addPendingRows = (keys: string[]) => {
    const fresh = keys.filter((k) => !presentKeys.has(k));
    if (fresh.length === 0) {
      toast('Las variables indicadas ya están en la tabla.', 'info');
      return;
    }
    const [first] = appendVars(fresh.map((key) => ({ key, value: '' })));
    if (first) setTimeout(() => valueInputRefs.current.get(first.id)?.focus(), 50);
    toast(fresh.length === 1 ? 'Se ha añadido 1 fila. Introduce su valor y guarda los cambios.' : `Se han añadido ${fresh.length} filas. Introduce sus valores y guarda los cambios.`, 'ok');
  };

  /**
   * Añade una sugerencia (o todas las referencias a la vez, que llevan valor). Sin
   * valor, el cursor queda en su campo para introducirlo. La lista se fija
   * abierta: si no, al añadir la última del repositorio se plegaría sola
   * debajo del dedo.
   */
  const addSuggested = (entries: { key: string; value: string }[]) => {
    if (entries.length === 0) return;
    setSuggestOpenPref((open) => open ?? true);
    const [first] = appendVars(entries);
    const [entry] = entries;
    if (entries.length === 1 && !entry.value && first) setTimeout(() => valueInputRefs.current.get(first.id)?.focus(), 50);
    toast(
      entries.length > 1
        ? `Se han añadido ${entries.length} variables.`
        : entry.value
          ? `Se ha añadido ${entry.key}.`
          : `Se ha añadido ${entry.key}. Introduce su valor y guarda los cambios.`,
      'ok',
    );
  };

  // Alternar vista tabla / texto plano
  const handleSwitchMode = (mode: 'table' | 'raw') => {
    if (mode === 'raw') {
      setRawText(rows.map((r) => `${r.key}=${r.value}`).join('\n'));
    } else {
      // Línea a línea, sin descartar una clave suelta a medio escribir.
      const keepCase = keepCaseKeys();
      const newRows: Row[] = [];
      for (const line of rawText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        newRows.push(
          eq > 0
            ? makeRow(upperKey(trimmed.slice(0, eq).trim(), keepCase), trimmed.slice(eq + 1))
            : makeRow(upperKey(trimmed, keepCase), ''),
        );
      }
      setRows(newRows);
    }
    setViewMode(mode);
  };

  // Validación y envío de cambios
  const submit = () => {
    // Sin la carga inicial no hay nada que guardar: un PUT con las filas vacías
    // borraría las variables reales del servicio.
    if (!env.data) return;
    const vars: Record<string, string> = {};
    if (viewMode === 'raw') {
      const keepCase = keepCaseKeys();
      for (const line of rawText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) {
          toast(`Línea no válida: ${trimmed}`, 'err');
          return;
        }
        const key = upperKey(trimmed.slice(0, eq).trim(), keepCase);
        // Dos líneas con el mismo nombre (también `api_key` y `API_KEY`, que se
        // guardan igual) se quedaban con el último valor sin avisar.
        if (Object.prototype.hasOwnProperty.call(vars, key)) {
          toast(`La variable ${key} aparece más de una vez. Deja una sola línea con ese nombre.`, 'err');
          return;
        }
        vars[key] = trimmed.slice(eq + 1);
      }
    } else {
      for (const row of rows) {
        if (!row.key.trim()) continue;
        vars[row.key.trim()] = row.value;
      }
    }
    save.mutate(vars);
  };

  // Descartar cambios
  const discard = () => {
    if (!env.data) return;
    const entries = rowsFromVars(env.data.vars);
    setRows(entries);
    setRawText(entries.map((r) => `${r.key}=${r.value}`).join('\n'));
    setDirty(false);
    toast('Cambios descartados.', 'info');
  };

  // Alternar revelado individual
  const toggleRowReveal = (id: string) => {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Alternar revelado global
  const toggleGlobalReveal = () => {
    const next = !globalReveal;
    setGlobalReveal(next);
    if (next) {
      setRevealedIds(new Set(rows.map((r) => r.id)));
    } else {
      setRevealedIds(new Set());
    }
  };



  /**
   * Mete varias variables de golpe partiendo de la fila `atId`: las claves que
   * ya existen se actualizan en su sitio (pegar un .env encima no duplica), las
   * nuevas se insertan justo después. Si la fila de partida está vacía, la
   * primera nueva la ocupa.
   */
  const importVars = (atId: string, vars: { key: string; value: string }[]) => {
    let updated = 0;
    let added = 0;
    // Se calcula fuera del updater: React puede invocarlo dos veces y los
    // contadores del aviso saldrían dobles.
    const next = rows.map((r) => ({ ...r }));
    const at = next.findIndex((r) => r.id === atId);
    const fresh: Row[] = [];
    const keepCase = keepCaseKeys();
    for (const v of vars) {
      const key = upperKey(v.key, keepCase);
      const existing = next.find((r) => r.key.trim() === key && r.id !== atId);
      if (existing) {
        existing.value = v.value;
        updated += 1;
      } else {
        fresh.push(makeRow(key, v.value));
        added += 1;
      }
    }
    const emptyAt = at >= 0 && !next[at].key.trim() && !next[at].value;
    next.splice(emptyAt ? at : at + 1, emptyAt ? 1 : 0, ...fresh);
    setRows(next);
    setDirty(true);
    const parts = [added && `${added} nueva${added === 1 ? '' : 's'}`, updated && `${updated} actualizada${updated === 1 ? '' : 's'}`].filter(
      Boolean,
    );
    toast(`Variables importadas: ${parts.join(' · ')}.`, 'ok');
  };

  /**
   * Pegado en un campo. El navegador aplana los saltos de línea al pegar en un
   * `<input>`, así que hay que leer el portapapeles antes de que lo haga: es
   * lo que permite que «A=1⏎B=2» acabe en dos filas y no en un solo valor.
   */
  const handlePaste = (rowId: string, field: 'key' | 'value', e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!text) return;
    const vars = parseEnvText(text);
    // En el campo de valor solo se interviene si claramente viene un lote:
    // un valor suelto con un «=» dentro (una URL con query) es un valor.
    const bulk = vars.length >= 2 || (field === 'key' && vars.length === 1 && text.includes('='));
    if (!bulk) return;
    e.preventDefault();
    importVars(rowId, vars);
  };

  /*
   * Edición del nombre: lo escrito pasa a mayúsculas y un «=» escrito a mano
   * salta al valor. Mientras el teclado compone (IME, la mayoría de teclados
   * de Android) el texto no se toca: reescribirlo a mitad de una composición
   * duplica letras en algunos teclados. Se convierte al terminarla
   * (`onCompositionEnd` vuelve a llamar aquí sin `composing`).
   */
  const handleKeyChange = (id: string, rawInput: string, composing: boolean) => {
    // Texto que llegó aplanado (arrastrar y soltar, autocompletado): si trae
    // varias variables, se reparte igual que un pegado.
    if (/\s/.test(rawInput.trim()) || rawInput.includes('\n')) {
      const vars = parseEnvText(rawInput);
      if (vars.length >= 2) {
        importVars(id, vars);
        return;
      }
    }
    // Una variable que ya tenía minúsculas conserva lo que se escriba: pasar
    // a mayúsculas letras que no se han tocado la renombraría sin pedirlo.
    // Al vaciar el nombre deja de ser esa variable y vuelve la norma.
    const keepCase = rows.find((r) => r.id === id)?.keepCase ?? false;
    const cased = (key: string) => (keepCase ? key : key.toUpperCase());
    if (rawInput.includes('=')) {
      const eq = rawInput.indexOf('=');
      const key = cased(rawInput.slice(0, eq).trim());
      const value = rawInput.slice(eq + 1);
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, key, value: value || r.value, keepCase: keepCase && key !== '' } : r)));
      setDirty(true);
      setTimeout(() => {
        valueInputRefs.current.get(id)?.focus();
      }, 10);
      return;
    }
    const key = composing ? rawInput : cased(rawInput);
    setFieldKeepingCaret(keyInputRefs.current.get(id), key);
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, key, keepCase: keepCase && key !== '' } : r)));
    setDirty(true);
  };

  const handleValueChange = (id: string, value: string) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, value } : r)));
    setDirty(true);
  };

  const handleAddRow = () => {
    const newR = makeRow('', '');
    setRows((prev) => [...prev, newR]);
    setDirty(true);
    setTimeout(() => {
      keyInputRefs.current.get(newR.id)?.focus();
    }, 50);
  };

  const handleDeleteRow = (id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
    setDirty(true);
  };

  // Las filas son `memo`: reciben un objeto de acciones que no cambia entre
  // renders y que llama siempre a la versión más reciente de cada manejador.
  const latestHandlers = useRef({ handleKeyChange, handleValueChange, handlePaste, toggleRowReveal, handleDeleteRow, handleAddRow });
  latestHandlers.current = { handleKeyChange, handleValueChange, handlePaste, toggleRowReveal, handleDeleteRow, handleAddRow };
  const rowActions = useMemo<RowActions>(
    () => ({
      keyChange: (id, raw, composing) => latestHandlers.current.handleKeyChange(id, raw, composing),
      valueChange: (id, value) => latestHandlers.current.handleValueChange(id, value),
      paste: (id, field, e) => latestHandlers.current.handlePaste(id, field, e),
      toggleReveal: (id) => latestHandlers.current.toggleRowReveal(id),
      remove: (id) => latestHandlers.current.handleDeleteRow(id),
      addRow: () => latestHandlers.current.handleAddRow(),
      focusKey: (id) => keyInputRefs.current.get(id)?.focus(),
      focusValue: (id) => valueInputRefs.current.get(id)?.focus(),
    }),
    [],
  );

  // Copiar todo como formato .env
  const handleCopyAllAsEnv = () => {
    const text = rows.map((r) => `${r.key}=${r.value}`).join('\n');
    void copyToClipboard(text).then((ok) => {
      if (ok) {
        setCopiedAll(true);
        toast('Se han copiado todas las variables al portapapeles en formato .env.', 'ok');
        setTimeout(() => setCopiedAll(false), 2000);
      } else {
        // Sin HTTPS o con el permiso denegado: antes no se decía nada.
        toast('No se ha podido copiar al portapapeles.', 'err');
      }
    });
  };

  const references = env.data?.references ?? EMPTY_LIST;
  const resolved = env.data?.resolved ?? EMPTY_RECORD;
  const saved = env.data?.vars ?? EMPTY_RECORD;

  // Qué es nuevo, qué ha cambiado y qué se ha quitado respecto a lo guardado.
  const statusOf = (row: Row): RowStatus => {
    const k = row.key.trim();
    if (!k || !(k in saved)) return 'new';
    return saved[k] === row.value ? 'saved' : 'changed';
  };
  const changes = useMemo(() => {
    const keys = new Set(rows.map((r) => r.key.trim()).filter(Boolean));
    const removed = Object.keys(saved).filter((k) => !keys.has(k)).length;
    let added = 0;
    let changed = 0;
    for (const r of rows) {
      const k = r.key.trim();
      if (!k) continue;
      if (!(k in saved)) added += 1;
      else if (saved[k] !== r.value) changed += 1;
    }
    return { added, changed, removed };
  }, [rows, saved]);
  const dirtyLabel = useMemo(() => {
    const parts = [
      changes.added && `${changes.added} nueva${changes.added === 1 ? '' : 's'}`,
      changes.changed && `${changes.changed} cambiada${changes.changed === 1 ? '' : 's'}`,
      changes.removed && `${changes.removed} eliminada${changes.removed === 1 ? '' : 's'}`,
    ].filter(Boolean);
    return parts.length ? `${parts.join(' · ')} · se aplicarán al volver a desplegar` : 'Cambios sin guardar · se aplicarán al volver a desplegar';
  }, [changes]);

  // Claves duplicadas
  const duplicates = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of rows) {
      const k = r.key.trim();
      if (k) counts[k] = (counts[k] || 0) + 1;
    }
    return new Set(Object.keys(counts).filter((k) => counts[k] > 1));
  }, [rows]);

  // Variables que siguen apuntando a Railway
  const railwayPending = useMemo(() => {
    const out: { id: string; key: string; candidates: ReferenceGroup[] }[] = [];
    rows.forEach((row) => {
      if (!RAILWAY_RE.test(row.value) || isReference(row.value)) return;
      const template = guessTemplate(row.key, row.value);
      const candidates = template ? references.filter((g) => g.template === template && g.connect.length > 0) : [];
      out.push({ id: row.id, key: row.key, candidates });
    });
    return out;
  }, [rows, references]);

  /*
   * «Conectar a…»: un botón por servicio del proyecto al que se pueda enganchar
   * este, que inserta de golpe las referencias que hacen falta (qué son lo dice
   * el servidor, según el motor). Desaparece cuando ya están todas.
   */
  const connectChips = useMemo(
    () =>
      references
        .filter((g) => g.service !== 'shared' && g.connect.length > 0)
        .map((g) => ({
          service: g.service,
          entries: g.connect.map((v) => ({ key: connectKey(g, v), value: `\${{${g.service}.${v}}}` })),
        })),
    [references],
  );

  // Filtrado por buscador
  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.key.toLowerCase().includes(q) || r.value.toLowerCase().includes(q));
  }, [rows, searchQuery]);

  /*
   * Lo que ya está cubierto y no se vuelve a proponer: lo que hay en pantalla
   * (también lo añadido sin guardar, para que desaparezca en vivo) y las
   * variables compartidas del proyecto, que el servicio recibe igual.
   */
  const coveredKeys = useMemo(() => {
    const keys = new Set(presentKeys);
    for (const k of references.find((g) => g.service === 'shared')?.vars ?? EMPTY_LIST) keys.add(k);
    return keys;
  }, [presentKeys, references]);

  /*
   * Claves que el .env del repositorio trae sin valor y que siguen sin
   * existir. El servidor las cruza con lo guardado y lo que Skyway cubre sola
   * (`repoPending`); aquí, además, con lo que hay en pantalla.
   */
  const isGit = serviceType === 'git';
  const pendingFromRepo = useMemo(() => {
    const pending = env.data?.repoPending ?? envImport?.pending ?? EMPTY_LIST;
    if (!isGit || pending.length === 0) return EMPTY_LIST as { key: string; file: string }[];
    return pending.filter((p) => !coveredKeys.has(p.key));
  }, [isGit, env.data, envImport, coveredKeys]);

  // Dependencias detectadas en el repo: sugerencias y variables que faltan.
  const pendingSuggestions = useMemo(
    () => (env.data?.suggestions ?? EMPTY_LIST).filter((s) => !coveredKeys.has(s.key)),
    [env.data, coveredKeys],
  );
  const pendingMissing = useMemo(
    () => (env.data?.missing ?? EMPTY_LIST).filter((k) => !coveredKeys.has(k)),
    [env.data, coveredKeys],
  );
  const pendingWithValue = useMemo(() => pendingSuggestions.filter((s) => s.value !== null), [pendingSuggestions]);

  // Las que piden crear una base nueva se agrupan por motor: MinIO pide tres
  // variables y solo hace falta un botón de «crear y conectar», no tres.
  const pendingGroups = useMemo(() => {
    const groups = new Map<string, EnvSuggestion[]>();
    for (const s of pendingSuggestions) {
      if (s.value !== null || !s.template) continue;
      groups.set(s.template, [...(groups.get(s.template) ?? []), s]);
    }
    return Array.from(groups.values());
  }, [pendingSuggestions]);

  /*
   * Lo que el repositorio espera sin un valor que proponer: lo que el .env
   * importado trae vacío y lo que la detección echa en falta (suelen ser las
   * mismas claves, así que va una entrada por clave). Se añaden de una en una:
   * un lote de filas vacías obligaba a buscar después cuáles quedaban por
   * rellenar. Las que tienen referencia o base que crear salen aparte, con su
   * acción.
   */
  const pendingEmpty = useMemo(() => {
    const withAction = new Set(pendingSuggestions.filter((s) => s.value !== null || s.template).map((s) => s.key));
    const out = new Map<string, string>();
    for (const p of pendingFromRepo) if (!withAction.has(p.key)) out.set(p.key, `Vacía o con un valor de ejemplo en ${p.file}`);
    const expected = 'Esperada por el repositorio, sin valor propuesto';
    for (const k of pendingMissing) if (!withAction.has(k) && !out.has(k)) out.set(k, expected);
    for (const s of pendingSuggestions) if (!withAction.has(s.key) && !out.has(s.key)) out.set(s.key, s.reason || expected);
    return Array.from(out, ([key, detail]) => ({ key, detail }));
  }, [pendingFromRepo, pendingMissing, pendingSuggestions]);

  // Las habituales (NODE_ENV, TZ…) que falten y que el repositorio no proponga ya.
  const commonPending = useMemo(() => {
    const fromRepo = new Set([...pendingSuggestions.map((s) => s.key), ...pendingEmpty.map((p) => p.key)]);
    return SUGGESTED_VARS.filter((s) => !coveredKeys.has(s.key) && !fromRepo.has(s.key));
  }, [coveredKeys, pendingSuggestions, pendingEmpty]);

  const repoSuggestCount = pendingWithValue.length + pendingGroups.reduce((n, g) => n + g.length, 0) + pendingEmpty.length;
  const suggestCount = repoSuggestCount + commonPending.length;
  // Plegada por defecto; abierta si el repositorio espera algo, hasta que se pliegue a mano.
  const suggestOpen = suggestOpenPref ?? repoSuggestCount > 0;

  // Variables de correo que la web espera y todavía no existen (las escribe «Correo → Conectar»).
  // Con un skyway.json válido, el correo lo lleva su plan (panel de integraciones).
  const pendingMailVars = useMemo(
    () =>
      env.data?.manifest && !env.data.manifest.error
        ? (EMPTY_LIST as string[])
        : (env.data?.mail?.vars ?? EMPTY_LIST).map((v) => v.name).filter((k) => !coveredKeys.has(k)),
    [env.data, coveredKeys],
  );

  // Crea la base de datos del grupo y, con la respuesta, conecta de golpe
  // todas las variables que la referencian (una sola llamada aunque el
  // grupo tenga varias claves, como MinIO).
  const createDbAndConnect = useMutation({
    mutationFn: (group: EnvSuggestion[]) =>
      api.post<{ service: { id: string; name: string } }>(`/projects/${projectId}/services`, {
        type: 'database',
        template: group[0].template,
      }),
    onSuccess: (data, group) => {
      queryClient.invalidateQueries({ queryKey: ['env', serviceId] });
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      appendVars(group.map((s) => ({ key: s.key, value: `\${{${data.service.name}.${s.refVar}}}` })));
      toast(
        `Se ha creado «${data.service.name}» y se ha conectado en ${group.map((s) => s.key).join(', ')}. Guarda los cambios y vuelve a desplegar.`,
        'ok',
      );
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  if (env.isLoading) {
    return (
      <div aria-busy className="flex flex-col gap-3 p-4 sm:px-5">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }

  /*
   * El editor solo existe con las variables cargadas. Si la consulta falla y
   * se pintara igual, saldría vacío y «Guardar» machacaría las variables
   * reales del servicio con un conjunto en blanco.
   */
  if (!env.data) {
    return (
      <div className="p-4 sm:px-5">
        <ErrorState
          compact
          title="No se han podido cargar las variables"
          error={env.error}
          onRetry={() => env.refetch()}
          retrying={env.isFetching}
        />
      </div>
    );
  }

  const toolBtn =
    'press flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-xs font-medium text-sub transition-colors hover:bg-surface2 hover:text-txt';

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-between">
      <div className="flex flex-col gap-4 p-3.5 pb-24 sm:p-5">
        {/* ── Cabecera: qué hay y cómo verlo ── */}
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <h3 className="text-sm font-semibold text-txt">Variables de entorno</h3>
            <span className="tnum font-mono text-xs text-subtle">{rows.length}</span>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <Segmented
              label="Modo de edición"
              size="sm"
              value={viewMode}
              onChange={handleSwitchMode}
              options={[
                { key: 'table', label: <span className="max-sm:hidden">Tabla</span>, icon: <Table size={12} aria-hidden />, title: 'Vista en tabla' },
                { key: 'raw', label: '.env', icon: <FileText size={12} aria-hidden />, title: 'Editar como texto plano' },
              ]}
            />

            {viewMode === 'table' && (
              <>
                <button
                  type="button"
                  onClick={toggleGlobalReveal}
                  className={toolBtn}
                  title={globalReveal ? 'Ocultar todos los valores' : 'Revelar todos los valores'}
                  aria-label={globalReveal ? 'Ocultar todos los valores' : 'Revelar todos los valores'}
                >
                  {globalReveal ? <EyeOff size={13} /> : <Eye size={13} />}
                  <span className="hidden md:inline">{globalReveal ? 'Ocultar' : 'Revelar'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleCopyAllAsEnv}
                  className={toolBtn}
                  title="Copiar todas las variables en formato .env"
                  aria-label="Copiar todas las variables en formato .env"
                >
                  {copiedAll ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
                  <span className="hidden lg:inline">Copiar .env</span>
                </button>
              </>
            )}

            {isGit && (
              <button
                type="button"
                onClick={() => importPreview.mutate()}
                disabled={importPreview.isPending || dirty}
                className={cx(toolBtn, 'disabled:cursor-not-allowed disabled:opacity-45')}
                title={
                  dirty
                    ? 'Guarda o descarta los cambios antes de importar'
                    : 'Leer el .env o .env.example del repositorio y proponer las variables que faltan'
                }
                aria-label="Importar variables del repositorio"
              >
                <FileDown size={13} className={cx(importPreview.isPending && 'animate-pulse')} />
                <span className="hidden sm:inline">Importar del repositorio</span>
                <span className="sm:hidden">Importar</span>
              </button>
            )}
          </div>
        </div>

        {/* ── Plan del skyway.json: lo pendiente de aprobar y el botón para aplicarlo ── */}
        {isGit && env.data.manifest && <IntegrationsPanel serviceId={serviceId} dirty={dirty} />}

        {/* ── La web envía correo y aún le faltan sus variables ── */}
        {isGit && pendingMailVars.length > 0 && (
          <div className="rounded-xl border border-info/35 bg-info/[.07] p-3.5 text-xs">
            <p className="flex items-center gap-1.5 font-semibold text-info">
              <Mail size={14} aria-hidden /> Esta web envía correo
            </p>
            <p className="mt-1 text-sub">
              {env.data?.mail?.evidence.join(' · ')}. Faltan{' '}
              <span className="break-words font-mono text-txt">{pendingMailVars.join(', ')}</span>: en el botón «Correo» del
              proyecto, «Conectar a un servicio» las escribe con esos nombres
              {env.data?.mail?.mode === 'api' ? ' (la web usa la API de envío)' : ''}.
            </p>
          </div>
        )}

        {/* ── Aviso de migración desde Railway (si aplica) ── */}
        {railwayPending.length > 0 && (
          <div className="rounded-xl border border-warn/35 bg-warn/[.07] p-3.5 text-xs">
            <p className="flex items-center gap-1.5 font-semibold text-warn">
              <AlertTriangle size={14} />
              {railwayPending.length === 1
                ? '1 variable sigue apuntando a la red externa de Railway'
                : `${railwayPending.length} variables siguen apuntando a la red externa de Railway`}
            </p>
            <p className="mt-1 text-sub">Selecciona una referencia para conectarlas a través de la red interna del proyecto:</p>
            <div className="mt-2.5 flex flex-col gap-1.5">
              {railwayPending.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-txt">{p.key}</span>
                  {p.candidates.map((g) => {
                    const token = `\${{${g.service}.${g.connect[0]}}}`;
                    return (
                      <button
                        key={g.service}
                        type="button"
                        className="press rounded-md border border-line bg-surface px-2 py-0.5 font-mono text-xs text-info transition-colors hover:border-info"
                        onClick={() => {
                          setRows((prev) => prev.map((r) => (r.id === p.id ? { ...r, value: token } : r)));
                          setDirty(true);
                          toast(`Variable conectada a «${g.service}».`, 'ok');
                        }}
                      >
                        Usar {token}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}

        {/*
          ── Variables sugeridas: lo que el repositorio espera y las habituales ──
          Cada una se añade por separado: con su valor si lo tiene, o con el
          cursor en su valor si no. Plegada ocupa una línea.
        */}
        {suggestCount > 0 && (
          <section
            className={cx('rounded-xl border text-xs', repoSuggestCount > 0 ? 'border-info/35 bg-info/[.07]' : 'border-line bg-surface')}
          >
            <button
              type="button"
              onClick={() => setSuggestOpenPref(!suggestOpen)}
              aria-expanded={suggestOpen}
              aria-controls={suggestPanelId}
              className={cx(
                'flex min-h-10 w-full min-w-0 items-center gap-2 px-3.5 py-2 text-left transition-colors hover:bg-txt/[.03]',
                suggestOpen ? 'rounded-t-xl' : 'rounded-xl',
              )}
            >
              <Layers size={14} aria-hidden className={cx('shrink-0', repoSuggestCount > 0 ? 'text-info' : 'text-subtle')} />
              <span className="shrink-0 font-semibold text-txt">Variables sugeridas</span>
              <span className="tnum shrink-0 font-mono text-subtle">{suggestCount}</span>
              {repoSuggestCount > 0 && <span className="min-w-0 truncate text-info">· {repoSuggestCount} del repositorio</span>}
              <ChevronDown size={14} aria-hidden className={cx('ml-auto shrink-0 text-subtle transition-transform', suggestOpen && 'rotate-180')} />
            </button>

            {suggestOpen && (
              <div id={suggestPanelId} className="flex flex-col gap-3 border-t border-line px-3.5 pb-3.5 pt-3">
                {repoSuggestCount > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
                      <h4 className="eyebrow text-subtle">Detectadas en el repositorio</h4>
                      {/* En bloque, solo las que llevan una referencia real: nunca un lote de filas vacías. */}
                      {pendingWithValue.length >= 2 && (
                        <button
                          type="button"
                          className={SUGGEST_BTN}
                          onClick={() => addSuggested(pendingWithValue.map((s) => ({ key: s.key, value: s.value ?? '' })))}
                        >
                          <Plus size={12} aria-hidden className="text-acc-soft" /> Añadir las {pendingWithValue.length} referencias
                        </button>
                      )}
                    </div>
                    {/* Sin motores detectados (solo un .env.example) no hay nada que «necesitar». */}
                    {env.data.needs && env.data.needs.engines.length > 0 && (
                      <p className="text-sub">
                        Este repositorio parece necesitar: {env.data.needs.engines.map((e) => `${e.label} (${e.evidence})`).join(' · ')}.
                      </p>
                    )}
                    <ul className={SUGGEST_LIST}>
                      {pendingWithValue.map((s) => (
                        <SuggestionItem
                          key={s.key}
                          name={s.key}
                          detail={
                            <>
                              <span className="font-mono text-info">{s.value}</span>
                              {s.reason && ` · ${s.reason}`}
                            </>
                          }
                        >
                          <button
                            type="button"
                            className={SUGGEST_BTN}
                            aria-label={`Añadir ${s.key}`}
                            onClick={() => addSuggested([{ key: s.key, value: s.value ?? '' }])}
                          >
                            <Plus size={12} aria-hidden className="text-acc-soft" /> Añadir
                          </button>
                        </SuggestionItem>
                      ))}
                      {/* Las que piden una base nueva van por motor: MinIO son tres claves y un solo botón. */}
                      {pendingGroups.map((group) => {
                        const label = group[0].label ?? group[0].template ?? 'la base de datos';
                        const keys = group.map((s) => s.key).join(', ');
                        const creating = createDbAndConnect.isPending && createDbAndConnect.variables?.[0]?.template === group[0].template;
                        return (
                          <SuggestionItem key={`crear:${group[0].template}`} name={keys} detail={`No hay ${label} en el proyecto${group[0].reason ? ` · ${group[0].reason}` : ''}`}>
                            <button
                              type="button"
                              className={SUGGEST_BTN}
                              disabled={creating}
                              title={`Crear ${label} y conectar ${keys}`}
                              onClick={() => createDbAndConnect.mutate(group)}
                            >
                              {creating ? (
                                'Creando…'
                              ) : (
                                <>
                                  <span className="sm:hidden">Crear y conectar</span>
                                  <span className="max-sm:hidden">Crear {label} y conectar</span>
                                </>
                              )}
                            </button>
                          </SuggestionItem>
                        );
                      })}
                      {pendingEmpty.map((p) => (
                        <SuggestionItem key={p.key} name={p.key} detail={p.detail}>
                          <button
                            type="button"
                            className={SUGGEST_BTN}
                            aria-label={`Añadir ${p.key}`}
                            onClick={() => addSuggested([{ key: p.key, value: '' }])}
                          >
                            <Plus size={12} aria-hidden className="text-acc-soft" /> Añadir
                          </button>
                        </SuggestionItem>
                      ))}
                    </ul>
                  </div>
                )}

                {commonPending.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <h4 className="eyebrow text-subtle">Habituales</h4>
                    <ul className={SUGGEST_LIST}>
                      {commonPending.map((s) => (
                        <SuggestionItem
                          key={s.key}
                          name={s.key}
                          detail={
                            <>
                              {s.hint} · <span className="font-mono text-sub">{s.value}</span>
                            </>
                          }
                        >
                          <button
                            type="button"
                            className={SUGGEST_BTN}
                            aria-label={`Añadir ${s.key}`}
                            onClick={() => addSuggested([{ key: s.key, value: s.value }])}
                          >
                            <Plus size={12} aria-hidden className="text-acc-soft" /> Añadir
                          </button>
                        </SuggestionItem>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {viewMode === 'raw' ? (
          /* ── Texto plano (.env) ── */
          <div className="flex flex-col gap-2">
            <p className="text-xs text-subtle">
              Una variable por línea, en formato <code className="font-mono text-txt">CLAVE=valor</code>. Se puede pegar el
              contenido completo de un archivo .env. Los nombres nuevos se guardan en mayúsculas.
            </p>
            <textarea
              className="input min-h-[320px] w-full rounded-xl border border-line bg-term p-3.5 font-mono leading-relaxed text-txt/95 outline-none focus:border-acc sm:text-xs"
              value={rawText}
              onChange={(e) => {
                setRawText(e.target.value);
                setDirty(true);
              }}
              placeholder={'CLAVE=valor\nAPI_KEY=123456\nDATABASE_URL=${{Postgres.DATABASE_URL}}'}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </div>
        ) : (
          /* ── Tabla ── */
          <div className="flex flex-col gap-2.5">
            {rows.length > 4 && (
              <div className="flex h-8 w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 focus-within:border-acc">
                <Search size={13} className="shrink-0 text-subtle" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filtrar por nombre o valor"
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent text-xs text-txt outline-none placeholder:text-subtle"
                />
                {searchQuery && (
                  <button type="button" onClick={() => setSearchQuery('')} className="press text-subtle hover:text-txt" aria-label="Borrar filtro">
                    <X size={12} />
                  </button>
                )}
              </div>
            )}

            {/* Cabecera de columnas: en móvil cada fila lleva sus rótulos. */}
            {filteredRows.length > 0 && (
              <div className="hidden px-3.5 sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-3">
                <span className="eyebrow text-subtle">Nombre</span>
                <span className="eyebrow text-subtle">Valor</span>
              </div>
            )}

            {filteredRows.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line p-8 text-center text-xs text-subtle">
                {searchQuery ? (
                  <p>No se ha encontrado ninguna variable que coincida con «{searchQuery}».</p>
                ) : (
                  <>
                    <Layers size={24} className="mb-2 opacity-40" />
                    <p className="font-medium text-txt">No hay variables de entorno</p>
                    <p className="mt-1 text-subtle">
                      Añade una variable o pega el contenido de un archivo .env en cualquier campo; las variables se separarán automáticamente.
                    </p>
                  </>
                )}
              </div>
            ) : (
              /*
               * En móvil cada variable es una tarjeta con aire alrededor y sus
               * dos campos apilados con rótulo: antes eran dos cajas pegadas sin
               * un solo píxel entre variables y no se sabía dónde acababa una.
               * En escritorio, una lista de filas con las dos columnas alineadas.
               */
              <div className="flex flex-col gap-2 sm:gap-0 sm:overflow-hidden sm:rounded-xl sm:border sm:border-line sm:bg-surface">
                {filteredRows.map((row, index) => (
                  <VariableRow
                    key={row.id}
                    row={row}
                    isLast={index === filteredRows.length - 1}
                    isRevealed={globalReveal || revealedIds.has(row.id)}
                    isRef={isReference(row.value)}
                    isDup={duplicates.has(row.key.trim())}
                    status={statusOf(row)}
                    resolvedValue={resolved[row.key] ?? row.value}
                    nextRowId={filteredRows[index + 1]?.id ?? null}
                    actions={rowActions}
                    keyInputRefs={keyInputRefs}
                    valueInputRefs={valueInputRefs}
                  />
                ))}
              </div>
            )}

            {/* La pista del pegado ya la da el estado vacío; aquí, permanente,
                era ruido para quien ya tiene variables. Queda en el title. */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={handleAddRow}
                title="Si se pega el contenido de un archivo .env en cualquier campo, las variables se separarán en filas automáticamente"
                className="press flex h-9 items-center gap-1.5 rounded-lg border border-dashed border-line2 px-3 text-xs font-semibold text-sub transition-colors hover:border-acc/50 hover:bg-surface2 hover:text-txt max-sm:flex-1 max-sm:justify-center"
              >
                <Plus size={14} className="text-acc-soft" />
                Añadir variable
              </button>
            </div>
          </div>
        )}

        {/* ── Referencias y sugerencias ── */}
        <div className="flex flex-col gap-3">
          {connectChips.some((c) => c.entries.some((e) => !rows.some((r) => r.key === e.key))) && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-subtle">
              <span className="font-medium text-sub">Conectar a:</span>
              {connectChips
                .filter((c) => c.entries.some((e) => !rows.some((r) => r.key === e.key)))
                .map((c) => {
                  const pending = c.entries.filter((e) => !rows.some((r) => r.key === e.key));
                  const hint = `Añade ${pending.map((e) => e.key).join(', ')} como referencia a ${c.service} por la red interna del proyecto`;
                  return (
                    <button
                      key={c.service}
                      type="button"
                      className="press flex items-center gap-1 rounded-md border border-acc/40 bg-acc/[.06] px-2 py-0.5 text-xs font-medium text-acc-soft transition-colors hover:border-acc hover:bg-acc/10 max-sm:py-1.5"
                      title={hint}
                      aria-label={hint}
                      onClick={() => {
                        setRows((prev) => [...prev, ...pending.map((e) => makeRow(e.key, e.value))]);
                        setDirty(true);
                        toast(`Conectado a ${c.service}: ${pending.map((e) => e.key).join(', ')}`, 'ok');
                      }}
                    >
                      <Plus size={12} /> {c.service}
                    </button>
                  );
                })}
            </div>
          )}

          {references.length > 0 && (
            <div className="rounded-xl border border-line bg-surface p-3.5 text-xs">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-1">
                <span className="font-semibold text-sub">Referencias del proyecto</span>
                <span className="text-xs text-subtle">Selecciona una para copiarla en formato {'${{...}}'}</span>
              </div>
              <div className="flex flex-col gap-2.5">
                {references.map((ref) => (
                  <div key={ref.service} className="rounded-lg border border-line/60 bg-surface2/50 p-2">
                    <p className="eyebrow mb-1.5 text-subtle">
                      {ref.service === 'shared' ? 'Variables compartidas' : ref.service}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {/* Las de sistema van detrás y en otro tono: no son
                          variables del servicio, las calcula Skyway de su puerto
                          y su dominio, y cambian con ellos. */}
                      {[...ref.vars.map((v) => ({ v, auto: false })), ...(ref.auto ?? []).map((v) => ({ v, auto: true }))].map(
                        ({ v, auto }) => {
                          const token = `\${{${ref.service}.${v}}}`;
                          const title = auto
                            ? `Copiar ${token} · la calcula Skyway del puerto y el dominio de ${ref.service}`
                            : `Copiar ${token}`;
                          return (
                            <button
                              key={v}
                              type="button"
                              className={cx(
                                'press rounded-md border px-2 py-0.5 font-mono text-xs transition-colors max-sm:py-1.5',
                                auto
                                  ? 'border-dashed border-acc/40 bg-surface text-acc-soft hover:border-acc hover:bg-acc/10'
                                  : 'border-line bg-surface text-info hover:border-info hover:bg-info/10',
                              )}
                              title={title}
                              aria-label={title}
                              onClick={() => {
                                // El «Copiado» solo cuando de verdad se ha copiado.
                                void copyToClipboard(token).then((ok) =>
                                  toast(ok ? `Copiado: ${token}` : 'No se ha podido copiar al portapapeles', ok ? 'ok' : 'err'),
                                );
                              }}
                            >
                              {v}
                            </button>
                          );
                        },
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <EditorBar
        dirty={dirty}
        saving={save.isPending}
        onSave={submit}
        onDiscard={discard}
        saveLabel={dirty ? `Guardar (${rows.filter((r) => r.key.trim()).length})` : 'Guardar variables'}
        dirtyLabel={dirtyLabel}
      />

      <ImportRepoModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        report={importReport}
        done={importDone}
        applying={importApply.isPending}
        onApply={() => importApply.mutate()}
        onAddPending={addPendingRows}
      />
    </div>
  );
}
