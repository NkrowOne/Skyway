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
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-[background,border-color,color,box-shadow,transform,filter] duration-150 ease-out active:scale-[.98] active:duration-[60ms] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100';
  const variants = {
    // Primario con volumen: gradiente vertical + brillo interior arriba; el hover ilumina, no cambia de color.
    primary:
      'bg-gradient-to-b from-[#7d66d9] to-[#6a52c9] text-white shadow-[inset_0_1px_0_rgba(255,255,255,.16),0_2px_10px_-2px_color-mix(in_oklab,var(--color-acc)_55%,transparent)] hover:brightness-[1.07] hover:shadow-[inset_0_1px_0_rgba(255,255,255,.18),0_4px_16px_-6px_color-mix(in_oklab,var(--color-acc)_70%,transparent)]',
    secondary: 'bg-surface2 text-txt border border-line hover:border-acc/50',
    outline: 'bg-surface2 text-txt border border-line hover:border-acc/50',
    ghost: 'bg-transparent text-sub hover:text-txt hover:bg-surface2',
    danger: 'bg-err/[.12] text-err border border-err/35 hover:bg-err/20',
  };
  const sizes = {
    sm: 'h-8 text-xs px-2.5',
    md: 'h-9 text-[13px] px-3.5',
    lg: 'h-[42px] text-sm px-4 font-semibold',
  };
  return (
    <button className={cx(base, variants[variant], sizes[size], className)} disabled={disabled || loading} {...rest}>
      {loading ? <Loader2 size={14} className="animate-spin" /> : success ? <Check size={14} className="pop-in text-current" /> : null}
      {children}
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
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-sub">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 flex items-center gap-1 text-[11px] text-err">
          <AlertCircle size={11} /> {error}
        </span>
      ) : (
        hint && <span className="mt-1 block text-[11px] leading-4 text-subtle">{hint}</span>
      )}
    </label>
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
    <div className="sticky bottom-4 sm:bottom-6 z-40 mx-auto mt-6 flex w-[calc(100%-1.5rem)] max-w-lg items-center justify-between gap-3 rounded-2xl border border-line/80 bg-surface/92 p-2.5 pl-4 backdrop-blur-xl shadow-[0_12px_32px_rgba(0,0,0,0.5)] menu-in">
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
const TONE_BADGE: Record<Tone, string> = {
  ok: 'text-ok bg-ok/10 border border-ok/20',
  warn: 'text-warn bg-warn/10 border border-warn/20',
  err: 'text-err bg-err/10 border border-err/20',
  info: 'text-info bg-info/10 border border-info/20',
  neutral: 'text-sub bg-surface2 border border-line',
};

/**
 * Pill de estado unificado: dot 5px y tipografía limpia.
 */
export function StatusBadge({
  tone,
  label,
  pulse,
  replicas,
  dot = true,
  className,
}: {
  tone: Tone;
  label: React.ReactNode;
  pulse?: boolean;
  replicas?: { running: number; total: number };
  dot?: boolean;
  className?: string;
}) {
  const stateKey = typeof label === 'string' || typeof label === 'number' ? `${tone}-${label}` : undefined;
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors duration-200',
        TONE_BADGE[tone],
        className,
      )}
    >
      <span key={stateKey} className="inline-flex items-center gap-1.5">
        {dot && <span className={cx('h-1.5 w-1.5 rounded-full bg-current', pulse && 'pulse-soft')} />}
        {label}
        {replicas && replicas.total > 1 && (
          <span className={cx('tnum font-mono text-[10px]', replicas.running < replicas.total && 'text-warn')}>
            · {replicas.running}/{replicas.total}
          </span>
        )}
      </span>
    </span>
  );
}

// ---------- Skeleton ----------
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('skeleton', className)} />;
}

// ---------- Modal ----------
export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  // Presencia: el modal permanece montado durante la animación de salida.
  const { mounted, closing } = usePresence(open, 220);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  // onClose suele ser una arrow recreada en cada render del padre: si el efecto
  // dependiera de ella, cada tecla en un input controlado lo re-ejecutaría y su
  // cleanup devolvería el foco al elemento previo (te "sacaba" del campo).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === 'Tab' && panelRef.current) {
        // Focus trap sencillo dentro del panel.
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
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
      window.removeEventListener('keydown', onKey);
      previousFocus.current?.focus?.();
    };
  }, [open]);

  if (!mounted) return null;
  return createPortal(
    <div
      className={cx(
        'fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/55 p-4 pt-[10vh] backdrop-blur-[3px] max-sm:items-end max-sm:p-0 max-sm:pt-8',
        closing ? 'overlay-out' : 'overlay-in',
      )}
      onMouseDown={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          'w-full rounded-2xl border border-line bg-surface shadow-lvl3',
          wide ? 'max-w-2xl' : 'max-w-md',
          // En móvil, hoja inferior: ancho completo, sube desde abajo y respeta el gesto del sistema.
          'max-sm:max-h-[92dvh] max-sm:max-w-full max-sm:overflow-y-auto max-sm:overscroll-contain max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0 max-sm:safe-b',
          closing ? 'modal-out' : 'modal-in',
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div aria-hidden className="mx-auto mt-2 h-1 w-9 rounded-full bg-line sm:hidden" />
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="press rounded-md p-1 text-sub transition-colors hover:bg-surface2 hover:text-txt"
            title="Cerrar (esc)"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-5">{children}</div>
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
            'shrink-0 whitespace-nowrap px-3.5 py-2.5 text-[13px] transition-colors duration-150',
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
    <div className="flex items-center justify-center gap-2 py-10 text-sub">
      <Loader2 size={18} className="animate-spin" />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

// ---------- CopyButton ----------
export function CopyButton({ value, className, title = 'Copiar' }: { value: string; className?: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={cx('press rounded-md p-1 text-subtle hover:bg-surface2 hover:text-txt', className)}
      title={title}
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
        <div className="fixed bottom-[calc(20px+env(safe-area-inset-bottom))] right-5 z-[60] flex w-[340px] max-w-[calc(100vw-24px)] flex-col">
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
                    <p className="text-[13px] font-semibold leading-snug">{TOAST_TITLE[t.kind]}</p>
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
