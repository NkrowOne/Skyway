import { useEffect, useState } from 'react';

/**
 * Presencia con salida animada: mantiene el nodo montado `exitMs` tras cerrarse
 * para que la animación de despedida pueda verse. `closing` activa las clases
 * *-out. Con `prefers-reduced-motion` desmonta al instante.
 */
export function usePresence(open: boolean, exitMs = 200): { mounted: boolean; closing: boolean } {
  const [state, setState] = useState<'open' | 'closing' | 'closed'>(open ? 'open' : 'closed');
  useEffect(() => {
    if (open) {
      setState('open');
      return;
    }
    setState((prev) => {
      if (prev === 'closed') return prev;
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'closed' : 'closing';
    });
  }, [open]);
  useEffect(() => {
    if (state !== 'closing') return;
    const t = window.setTimeout(() => setState('closed'), exitMs);
    return () => window.clearTimeout(t);
  }, [state, exitMs]);
  return { mounted: state !== 'closed', closing: state === 'closing' };
}

/** true cuando la media query se cumple; se actualiza en vivo. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Estado persistido en localStorage (JSON). */
export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* almacenamiento lleno o bloqueado: seguimos en memoria */
    }
  };
  return [value, set];
}

/** true si el evento de teclado ocurre con el foco en un campo editable. */
export function isEditableTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
