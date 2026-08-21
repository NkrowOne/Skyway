import { Component, ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from './ui';

/**
 * Red de seguridad para los errores de render.
 *
 * Sin esto, cualquier excepción al pintar —un campo que el servidor dejó de
 * mandar, un dato con una forma inesperada— desmonta el árbol entero y deja el
 * panel en blanco, sin decir nada y sin forma de salir salvo recargar a ciegas.
 * Aquí el fallo queda acotado a la parte que reventó: el resto del panel sigue
 * funcionando y se ve qué pasó.
 *
 * `resetKey` reinicia el límite al cambiar (la ruta, normalmente): si el error
 * era de una página concreta, navegar a otra vuelve a dejarla usable sin
 * recargar.
 */
interface Props {
  children: ReactNode;
  /** Al cambiar, se olvida el error y se reintenta pintar. */
  resetKey?: string;
  /** Texto de contexto: «esta página», «este panel»… */
  scope?: string;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error): void {
    // La consola del navegador es el único sitio donde el detalle sirve de algo:
    // no hay servicio de errores al que mandarlo y no se va a inventar uno.
    console.error('Error de render en Skyway:', error);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 px-6 py-12 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-err/[.12] text-err">
          <AlertTriangle size={20} />
        </span>
        <div>
          <p className="text-sm font-semibold">Algo se ha roto al pintar {this.props.scope ?? 'esta parte'}</p>
          <p className="mx-auto mt-1.5 max-w-md text-xs text-sub">
            El resto del panel sigue funcionando. Si vuelve a pasar en el mismo sitio, es un fallo de Skyway y no de tus
            datos: el detalle está en la consola del navegador.
          </p>
        </div>
        <p className="max-w-lg break-words rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[11px] text-subtle">
          {error.message || String(error)}
        </p>
        <div className="mt-1 flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => this.setState({ error: null })}>
            <RotateCcw size={13} /> Reintentar
          </Button>
          <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
            Recargar el panel
          </Button>
        </div>
      </div>
    );
  }
}
