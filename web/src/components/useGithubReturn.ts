import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useToast } from './ui';

/**
 * Vuelta de github.com. Los saltos a GitHub (crear la App, instalarla en una
 * cuenta) regresan al panel con `?github=<resultado>`; aquí se traduce a un
 * aviso y se limpia el parámetro para que recargar no lo repita.
 *
 * Vive suelto y no dentro del panel de Ajustes porque también lo usa la página
 * de proyecto, que no debe arrastrar el panel de administración a su bundle.
 */
const RETURN_MESSAGE: Record<string, { text: string; tone: 'ok' | 'err' }> = {
  creada: { text: 'GitHub App creada y conectada.', tone: 'ok' },
  conectado: { text: 'Cuenta de GitHub conectada.', tone: 'ok' },
  estado_invalido: { text: 'El enlace de GitHub caducó o no era de esta sesión. Vuelve a intentarlo.', tone: 'err' },
  proyecto_no_existe: { text: 'El proyecto ya no existe.', tone: 'err' },
  error: { text: 'GitHub devolvió un error al completar la conexión.', tone: 'err' },
};

export function useGithubReturnNotice(): void {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const code = params.get('github');

  useEffect(() => {
    if (!code) return;
    const message = RETURN_MESSAGE[code];
    toast(message?.text ?? `GitHub: ${code}`, message?.tone ?? 'info');
    const next = new URLSearchParams(params);
    next.delete('github');
    setParams(next, { replace: true });
  }, [code]);
}
