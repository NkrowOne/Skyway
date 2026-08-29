import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Check, CheckCircle2, Copy, Info, Loader2, X } from 'lucide-react';
import { usePresence } from '../hooks';
import { cx, Tone } from '../utils';

// ---------- Button ----------
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  /** Éxito momentáneo tras guardar: muestra un check que aparece con un pop. */
  success?: boolean;
};

/** Temporizador para el estado de éxito momentáneo de un botón (check tras guardar). */
export function useFlash(ms = 1600): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<number>();
  const flash = useCallback(() => {
    setOn(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOn(false), ms);
  }, [ms]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [on, flash];
}

export function Button({ variant = 'primary', size = 'md', loading, success, className, children, disabled, ...rest }: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-[background-color,border-color,color,filter] duration-[--dur-1] ease-out disabled:opacity-45 disabled:cursor-not-allowed';
  const variants = {
    // El primario es la única superficie saturada de la pantalla: no necesita
    // degradado ni resplandor para leerse como la acción principal.
    primary: 'bg-acc text-white hover:brightness-[1.12] active:brightness-95',
    secondary: 'border border-line bg-surface2 text-txt hover:border-line2 hover:bg-surface3',
    outline: 'border border-line bg-transparent text-txt hover:border-line2 hover:bg-surface2',
    ghost: 'bg-transparent text-sub hover:bg-surface2 hover:text-txt',
    danger: 'border border-err/30 bg-err/10 text-err hover:border-err/50 hover:bg-err/20',
  };
  // Alturas que casan con .input (h-9): un botón y un campo en la misma fila
  // deben alinearse sin ajustes puntuales. `lg` llega a 44px, el objetivo
  // táctil mínimo recomendado.
  const sizes = {
    sm: 'h-8 px-2.5 text-xs',
    md: 'h-9 px-3.5 text-sm',
    lg: 'h-11 px-4 text-base font-semibold',
  };
  return (
    <button className={cx(base, variants[variant], sizes[size], className)} disabled={disabled || loading} {...rest}>
      {loading ? <Loader2 size={14} className="animate-spin" /> : success ? <Check size={14} className="pop-in text-current" /> : null}
      {children}
    </button>
  );
}

// ---------- Chip ----------
type ChipSize = 'sm' | 'md';

const CHIP_TONE: Record<Tone, string> = {
  ok: 'border-ok/25 bg-ok/10 text-ok',
  warn: 'border-warn/25 bg-warn/10 text-warn',
  err: 'border-err/25 bg-err/10 text-err',
  info: 'border-info/25 bg-info/10 text-info',
  neutral: 'border-line bg-surface2 text-sub',
};

/** Tono de un chip pulsable cuando no está activo: se apaga hasta que lo tocas. */
const CHIP_IDLE = 'border-transparent bg-transparent text-subtle hover:bg-surface2 hover:text-txt';

/**
 * Etiqueta compacta: estado, metadato o filtro.
 *
 * Sustituye a la docena de `<span>` con `rounded-* px-* text-[..px]` que había
 * repartidos por las páginas, cada uno con su radio, su tamaño y su punto de
 * color. Si es pulsable se comporta como filtro (`active` decide si está
 * encendido); si no, es una etiqueta y se renderiza como `<span>`.
 */
export function Chip({
  tone = 'neutral',
  size = 'md',
  dot,
  pulse,
  icon,
  children,
  onClick,
  active = true,
  title,
  className,
}: {
  tone?: Tone;
  size?: ChipSize;
  /** Punto de color a la izquierda: para estados, no para metadatos. */
  dot?: boolean;
  pulse?: boolean;
  icon?: React.ReactNode;
  children: React.ReactNode;
  onClick?: () => void;
  /** Solo para chips pulsables: apagado cuando es false. */
  active?: boolean;
  title?: string;
  className?: string;
}) {
  const shape = cx(
    'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border font-medium transition-colors duration-[--dur-1]',
    size === 'sm' ? 'px-1.5 py-px text-micro' : 'px-1.5 py-0.5 text-xs',
    onClick && !active ? CHIP_IDLE : CHIP_TONE[tone],
    // Un chip que se pulsa es un objetivo táctil: con el relleno de etiqueta se
    // queda en unos 20px de alto, que con el pulgar no se acierta.
    onClick && 'press cursor-pointer max-sm:px-2.5 max-sm:py-1.5',
    className,
  );
  const body = (
    <>
      {dot && <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full bg-current', pulse && 'pulse-soft')} />}
      {icon}
      {children}
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} aria-label={title} aria-pressed={active} className={shape}>
        {body}
      </button>
    );
  }
  return (
    <span title={title} className={shape}>
      {body}
    </span>
  );
}

// ---------- EmptyState ----------
/**
 * Hueco vacío con salida. Un panel sin datos no es un error: es el momento de
 * decir qué hay que hacer para que deje de estarlo, así que `action` es lo
 * normal y omitirla, la excepción.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-1.5 px-4 py-8' : 'gap-2 px-6 py-14',
        className,
      )}
    >
      {icon && <span className="mb-1 text-subtle [&>svg]:h-6 [&>svg]:w-6">{icon}</span>}
      <p className={cx('font-semibold text-txt', compact ? 'text-sm' : 'text-base')}>{title}</p>
      {description && <p className="max-w-sm text-balance text-xs leading-5 text-subtle">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// ---------- ErrorState ----------
/**
 * Una consulta que falla no es un panel vacío.
 *
 * Varias pantallas presentaban el fallo como ausencia de datos —y el panel de
 * alertas llegaba a decir «Todo en orden» con su punto verde cuando lo que
 * pasaba es que la petición no había llegado—. Un error dice qué ha fallado y
 * ofrece volver a intentarlo.
 */
export function ErrorState({
  title = 'No se han podido cargar los datos',
  error,
  onRetry,
  retrying,
  compact,
  className,
}: {
  title?: string;
  error?: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const detalle = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  return (
    <div
      role="alert"
      className={cx(
        'flex flex-col items-center justify-center gap-2 text-center',
        compact ? 'px-4 py-8' : 'px-6 py-14',
        className,
      )}
    >
      <AlertCircle size={compact ? 18 : 22} className="text-err" aria-hidden />
      <p className={cx('font-semibold text-txt', compact ? 'text-sm' : 'text-base')}>{title}</p>
      {detalle && <p className="max-w-sm text-balance text-xs leading-5 text-subtle">{detalle}</p>}
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry} loading={retrying}>
          Reintentar
        </Button>
      )}
    </div>
  );
}

// ---------- PageHeader ----------
/**
 * Cabecera de página. Existía escrita a mano y distinta en cada una de las
 * quince páginas; unificarla es lo que hace que se noten como un mismo producto.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  /** Rótulo pequeño en versalitas sobre el título: dice dónde estás. */
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cx('flex flex-wrap items-end justify-between gap-x-4 gap-y-3', className)}>
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-1 eyebrow text-subtle">{eyebrow}</p>
        )}
        <h1 className="truncate text-2xl font-semibold text-txt">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-xs leading-5 text-sub">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

// ---------- Section ----------
/** Bloque con título dentro de una página. Un solo patrón para todos. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
  bare,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Sin caja: solo la cabecera y el contenido, para secciones que ya traen la suya. */
  bare?: boolean;
}) {
  return (
    <section className={cx(!bare && 'card', className)}>
      {(title || actions) && (
        <div
          className={cx(
            'flex flex-wrap items-center justify-between gap-x-3 gap-y-2',
            bare ? 'mb-3' : 'border-b border-line px-4 py-3',
          )}
        >
          <div className="min-w-0">
            {title && <h2 className="truncate text-base font-semibold text-txt">{title}</h2>}
            {description && <p className="mt-0.5 text-xs leading-5 text-subtle">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

// ---------- Menu ----------
/**
 * Menú anclado. Había tres implementaciones a mano (Layout, LogViewer,
 * LogsTab), cada una con su forma de cerrarse —y ninguna cerraba con Esc.
 * Esta cierra al pulsar fuera, con Esc, y devuelve el foco al disparador.
 */
export function Menu({
  open,
  onClose,
  children,
  align = 'right',
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  const { mounted, closing } = usePresence(open, 160);
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    /*
     * `mousedown` y no `click`: cierra antes de que el clic active lo que haya
     * debajo. El ancla (el contenedor `relative` que envuelve al disparador y
     * al menú) cuenta como «dentro»: si no, pulsar el disparador con el menú
     * abierto lo cerraría en mousedown y el click posterior volvería a
     * abrirlo, y el menú no se cerraría nunca desde su propio botón.
     */
    const onDown = (e: MouseEvent) => {
      const ancla = ref.current?.parentElement ?? ref.current;
      if (ancla && !ancla.contains(e.target as Node)) onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  if (!mounted) return null;
  return (
    <div
      ref={ref}
      role="menu"
      className={cx(
        'absolute top-full z-50 mt-1.5 min-w-[190px] rounded-xl border border-line bg-surface p-1 shadow-lvl3',
        align === 'right' ? 'right-0' : 'left-0',
        closing ? 'menu-out' : 'menu-in',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Entrada de menú: alto uniforme y estados coherentes en todos los menús. */
export function MenuItem({
  onClick,
  icon,
  children,
  danger,
  active,
  className,
}: {
  onClick?: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
  danger?: boolean;
  active?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cx(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors duration-[--dur-1]',
        danger ? 'text-err hover:bg-err/10' : active ? 'bg-surface2 text-txt' : 'text-sub hover:bg-surface2 hover:text-txt',
        className,
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

// ---------- Kbd ----------
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <kbd className={cx('kbd', className)}>{children}</kbd>;
}

// ---------- Field ----------
export function Field({
  label,
  hint,
  error,
  children,
  group,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  children: React.ReactNode;
  /**
   * Para cuando dentro hay varios controles (una lista de casillas, un grupo de
   * opciones) en vez de uno solo.
   *
   * Un `<label>` alrededor de varias casillas es HTML inválido y hace que
   * pulsar el rótulo del grupo marque la primera de la lista. En ese caso el
   * envoltorio pasa a ser `<fieldset>` y el rótulo, su `<legend>`.
   */
  group?: boolean;
}) {
  const Envoltorio = group ? 'fieldset' : 'label';
  const Rotulo = group ? 'legend' : 'span';
  return (
    <Envoltorio className="block min-w-0">
      <Rotulo className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-sub">{label}</Rotulo>
      {children}
      {error ? (
        <span className="mt-1 flex items-center gap-1 text-xs text-err">
          <AlertCircle size={11} /> {error}
        </span>
      ) : (
        hint && <span className="mt-1 block text-xs leading-4 text-subtle">{hint}</span>
      )}
    </Envoltorio>
  );
}

// ---------- NumberInput ----------
type NumberInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  value: number;
  onChange: (value: number) => void;
  /** Qué número se emite mientras el campo está vacío (por defecto 0). */
  emptyValue?: number;
};

/**
 * Campo numérico controlado que **se puede vaciar**. Un `<input type="number">`
 * atado directamente a un número se rellena solo al borrarlo (`Number('') || 0`
 * vuelve a 0), y obliga a escribir encima del valor anterior. Aquí el texto vive
 * en un estado propio: se puede dejar en blanco mientras se teclea y solo se
 * normaliza al salir del campo.
 */
export function NumberInput({ value, onChange, emptyValue = 0, onFocus, onBlur, ...rest }: NumberInputProps) {
  const [text, setText] = useState(() => String(value));
  const editing = useRef(false);

  // Los cambios que vienen de fuera (carga de datos, descartar cambios, un
  // clamp del padre) refrescan el texto, pero nunca mientras se está escribiendo.
  useEffect(() => {
    if (!editing.current) setText(String(value));
  }, [value]);

  return (
    <input
      {...rest}
      type="number"
      value={text}
      onFocus={(e) => {
        editing.current = true;
        onFocus?.(e);
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const n = Number(raw);
        onChange(raw.trim() === '' || Number.isNaN(n) ? emptyValue : n);
      }}
      onBlur={(e) => {
        editing.current = false;
        setText(String(value));
        onBlur?.(e);
      }}
    />
  );
}

// ---------- EditorBar ----------
/**
 * Dock de guardado flotante elevado: solo aparece cuando hay cambios pendientes (dirty),
 * flotando de manera limpia sobre el contenido y evitando solaparse con la barra de tareas.
 */
export function EditorBar({
  dirty,
  saving,
  saved,
  onSave,
  onDiscard,
  saveLabel = 'Guardar cambios',
  dirtyLabel = 'Tienes cambios sin guardar',
}: {
  dirty: boolean;
  saving?: boolean;
  saved?: boolean;
  onSave: () => void;
  onDiscard?: () => void;
  saveLabel?: string;
  dirtyLabel?: string;
}) {
  if (!dirty && !saved) return null;

  return (
    <div className="menu-in sticky bottom-[calc(1rem+env(safe-area-inset-bottom))] z-40 mx-auto mt-6 flex w-[calc(100%-1.5rem)] max-w-lg items-center justify-between gap-3 rounded-2xl border border-line/80 bg-surface/95 p-2.5 pl-4 shadow-lvl3 backdrop-blur-xl sm:bottom-6">
      <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-warn">
        <span className="pulse-soft h-2 w-2 shrink-0 rounded-full bg-warn" />
        <span className="truncate">{dirtyLabel}</span>
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        {dirty && onDiscard && (
          <Button variant="ghost" size="sm" onClick={onDiscard} className="h-8 text-xs text-sub hover:text-txt">
            Descartar
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          onClick={onSave}
          loading={saving}
          disabled={!dirty}
          success={saved && !dirty}
          className="h-8 font-semibold shadow-md text-xs px-3.5"
        >
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

// ---------- StatusBadge ----------
/**
 * Estado de un recurso: es un Chip con punto, más el recuento de réplicas
 * cuando hay más de una. No duplica la tabla de tonos: usa la de Chip.
 */
export function StatusBadge({
  tone,
  label,
  pulse,
  replicas,
  dot = true,
  size,
  className,
}: {
  tone: Tone;
  label: React.ReactNode;
  pulse?: boolean;
  replicas?: { running: number; total: number };
  dot?: boolean;
  size?: ChipSize;
  className?: string;
}) {
  return (
    <Chip tone={tone} size={size} dot={dot} pulse={pulse} className={className}>
      {label}
      {replicas && replicas.total > 1 && (
        <span className={cx('tnum font-mono', replicas.running < replicas.total && 'text-warn')}>
          {replicas.running}/{replicas.total}
        </span>
      )}
    </Chip>
  );
}

// ---------- Skeleton ----------
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('skeleton', className)} />;
}

// ---------- Modal ----------
/**
 * Qué cuenta como enfocable dentro de un diálogo. Los deshabilitados quedan
 * fuera: antes entraban en la lista y el tabulador podía atascarse en uno.
 */
const FOCUSABLES =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
  dirty,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  wide?: boolean;
  /**
   * Hay trabajo escrito sin guardar.
   *
   * Con esto puesto, Esc y el clic fuera dejan de descartarlo en silencio y
   * piden confirmación. Es el mismo trato que ya daba el drawer de servicio a
   * sus pestañas con cambios.
   */
  dirty?: boolean;
}) {
  // Presencia: el modal permanece montado durante la animación de salida.
  const { mounted, closing } = usePresence(open, 220);
  const [confirmandoCierre, setConfirmandoCierre] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  // onClose suele ser una arrow recreada en cada render del padre: si el efecto
  // dependiera de ella, cada tecla en un input controlado lo re-ejecutaría y su
  // cleanup devolvería el foco al elemento previo (te "sacaba" del campo).
  const pedirCierre = useCallback(() => {
    if (dirty) setConfirmandoCierre(true);
    else onClose();
  }, [dirty, onClose]);
  const onCloseRef = useRef(pedirCierre);
  onCloseRef.current = pedirCierre;

  // Al cerrarse de verdad, la pregunta pendiente se olvida.
  useEffect(() => {
    if (!open) setConfirmandoCierre(false);
  }, [open]);

  /*
   * Depende también de `mounted`: en el render en el que `open` pasa a true el
   * panel todavía no existe —usePresence monta un render después—, así que un
   * efecto atado solo a `open` buscaba el panel cuando aún era null y no movía
   * el foco a ninguna parte.
   */
  useEffect(() => {
    if (!open || !mounted) return;
    previousFocus.current = document.activeElement as HTMLElement | null;

    // Llevar el foco dentro. Sin esto el «focus trap» no atrapa nada: el foco
    // sigue en el disparador y el tabulador recorre la página de detrás.
    const llevarElFoco = () => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      const primero = panel.querySelector<HTMLElement>(FOCUSABLES);
      (primero ?? panel).focus();
    };
    const raf = requestAnimationFrame(llevarElFoco);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === 'Tab' && panelRef.current) {
        // Focus trap sencillo dentro del panel.
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLES);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      previousFocus.current?.focus?.();
    };
  }, [open, mounted]);

  if (!mounted) return null;
  return createPortal(
    <div
      className={cx(
        'fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/55 p-4 pt-[10vh] backdrop-blur-[3px] max-sm:items-end max-sm:p-0 max-sm:pt-8',
        closing ? 'overlay-out' : 'overlay-in',
      )}
      onMouseDown={pedirCierre}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={title}
        className={cx(
          'relative w-full rounded-2xl border border-line bg-surface shadow-lvl3',
          wide ? 'max-w-2xl' : 'max-w-md',
          // En móvil, hoja inferior: ancho completo, sube desde abajo y respeta el gesto del sistema.
          'max-sm:max-h-[92dvh] max-sm:max-w-full max-sm:overflow-y-auto max-sm:overscroll-contain max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0 max-sm:safe-b',
          closing ? 'modal-out' : 'modal-in',
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div aria-hidden className="mx-auto mt-2 h-1 w-9 rounded-full bg-line sm:hidden" />
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            onClick={pedirCierre}
            className="press rounded-md p-1 text-sub transition-colors hover:bg-surface2 hover:text-txt max-sm:p-2.5"
            title="Cerrar (esc)"
            aria-label="Cerrar"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-5">{children}</div>

        {/* La pregunta se pinta dentro del propio panel: apilar un diálogo
            sobre otro complica el foco sin ganar nada. */}
        {confirmandoCierre && (
          <div className="overlay-in absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-2xl bg-surface/95 p-6 text-center backdrop-blur-sm">
            <p className="text-base font-semibold">Tienes cambios sin guardar</p>
            <p className="max-w-xs text-xs leading-5 text-sub">Si sales ahora se pierden.</p>
            <div className="mt-1 flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmandoCierre(false)}>
                Seguir editando
              </Button>
              <Button variant="danger" size="sm" onClick={onClose}>
                Descartar cambios
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ---------- Confirm ----------
export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Eliminar',
  // Por defecto rojo (borrados). Acciones reversibles como reiniciar pasan un tono más sereno.
  confirmVariant = 'danger',
  loading,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  confirmVariant?: ButtonProps['variant'];
  loading?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="text-sm text-sub">{message}</p>
      {children}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button variant={confirmVariant} onClick={onConfirm} loading={loading}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

// ---------- Tabs ----------
/** Tabs 13px con subrayado de 2px animado (transición de left/width). */
export function Tabs({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: { key: string; label: string }[];
  active: string;
  onChange: (key: string) => void;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const c = listRef.current;
    const el = c?.querySelector<HTMLButtonElement>(`[data-tab-key="${CSS.escape(active)}"]`);
    if (!c || !el) return;
    setBar({ left: el.offsetLeft + 12, width: el.offsetWidth - 24 });
    // Mantiene visible la pestaña activa cuando la fila desborda (drawer estrecho
    // con muchas pestañas), sin arrastrar el scroll de la página.
    const left = el.offsetLeft;
    const right = left + el.offsetWidth;
    if (left < c.scrollLeft) c.scrollTo({ left: Math.max(0, left - 12), behavior: 'smooth' });
    else if (right > c.scrollLeft + c.clientWidth) c.scrollTo({ left: right - c.clientWidth + 12, behavior: 'smooth' });
  }, [active, tabs.map((t) => t.key).join('|')]);

  return (
    <div
      ref={listRef}
      role="tablist"
      className={cx('relative flex gap-0.5 overflow-x-auto border-b border-line px-2 [scrollbar-width:none]', className)}
    >
      {tabs.map((t) => (
        <button
          key={t.key}
          data-tab-key={t.key}
          role="tab"
          aria-selected={active === t.key}
          onClick={() => onChange(t.key)}
          className={cx(
            'shrink-0 whitespace-nowrap px-3.5 py-2.5 text-sm transition-colors duration-150',
            active === t.key ? 'font-semibold text-txt' : 'text-sub hover:text-txt',
          )}
        >
          {t.label}
        </button>
      ))}
      {bar && (
        <span
          aria-hidden
          className="absolute bottom-0 h-0.5 rounded-full bg-acc transition-[left,width] duration-200 ease-out"
          style={{ left: bar.left, width: bar.width }}
        />
      )}
    </div>
  );
}

// ---------- Spinner ----------
export function Spinner({ label }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center justify-center gap-2 py-10 text-sub">
      <Loader2 size={18} className="animate-spin" aria-hidden />
      {/* Sin etiqueta visible, el lector de pantalla anunciaba un hueco mudo. */}
      {label ? <span className="text-sm">{label}</span> : <span className="sr-only">Cargando…</span>}
    </div>
  );
}

// ---------- CopyButton ----------
export function CopyButton({ value, className, title = 'Copiar' }: { value: string; className?: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={cx('press rounded-md p-1 text-subtle hover:bg-surface2 hover:text-txt', className)}
      title={title} aria-label={title}
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check size={13} className="pop-in text-ok" /> : <Copy size={13} />}
    </button>
  );
}

// ---------- Toasts ----------
interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: number;
  message: string;
  kind: 'ok' | 'err' | 'info';
  action?: ToastAction;
  /** En despedida: el toast se desliza fuera y su hueco se pliega. */
  closing?: boolean;
}

type PushToast = (message: string, kind?: Toast['kind'], opts?: { action?: ToastAction }) => void;

const ToastContext = createContext<PushToast>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

const TOAST_ICON = {
  ok: <CheckCircle2 size={16} className="mt-px shrink-0 text-ok" />,
  err: <AlertCircle size={16} className="mt-px shrink-0 text-err" />,
  info: <Info size={16} className="mt-px shrink-0 text-info" />,
};

const TOAST_TITLE = { ok: 'Hecho', err: 'Algo ha fallado', info: 'Aviso' };

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const remove = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  // Despedida en dos tiempos: marca `closing` (animación de salida + pliegue del hueco) y retira después.
  const dismiss = useCallback(
    (id: number) => {
      setToasts((t) => t.map((x) => (x.id === id ? { ...x, closing: true } : x)));
      window.setTimeout(() => remove(id), 260);
    },
    [remove],
  );

  const push = useCallback<PushToast>((message, kind = 'info', opts) => {
    const id = ++idRef.current;
    // Pila de máximo 3: la más antigua sale.
    setToasts((t) => [...t.filter((x) => !x.closing).slice(-2), { id, message, kind, action: opts?.action }]);
    setTimeout(() => dismiss(id), 5000);
  }, [dismiss]);

  return (
    <ToastContext.Provider value={push}>
      {children}
      {createPortal(
        <div
          aria-live="polite"
          aria-atomic="false"
          className="fixed bottom-[calc(20px+env(safe-area-inset-bottom))] right-5 z-[60] flex w-[340px] max-w-[calc(100vw-24px)] flex-col"
        >
          {toasts.map((t) => (
            <div key={t.id} className={cx('toast-shell', t.closing && 'toast-shell-closing')}>
              <div className="toast-clip">
                <div
                  role="status"
                  className={cx(
                    'mt-2 flex items-start gap-2.5 rounded-xl border border-line bg-surface2 px-3.5 py-3 shadow-toast',
                    t.closing ? 'toast-out' : 'toast-in',
                  )}
                >
                  {TOAST_ICON[t.kind]}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold leading-snug">{TOAST_TITLE[t.kind]}</p>
                    <p className="mt-0.5 text-xs leading-snug text-sub">{t.message}</p>
                    {t.action && (
                      <button
                        className="mt-2 text-xs font-semibold text-acc-soft hover:underline"
                        onClick={() => {
                          t.action?.onClick();
                          dismiss(t.id);
                        }}
                      >
                        {t.action.label} →
                      </button>
                    )}
                  </div>
                  <button onClick={() => dismiss(t.id)} className="press rounded-md p-1 text-subtle hover:text-txt" title="Cerrar">
                    <X size={13} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}
