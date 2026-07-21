import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Fingerprint, KeyRound, ShieldCheck, TerminalSquare, Users2 } from 'lucide-react';
import { api, ApiError } from '../api';
import { BrandMark } from '../components/Layout';
import { Button, CopyButton, Field, Modal } from '../components/ui';
import { cx } from '../utils';
import { loginWithPasskey, passkeysSupported } from '../webauthn';

/**
 * Recuperación de acceso honesta para una plataforma auto-alojada: sin email
 * de reset (no hay proveedor de correo garantizado), tres vías reales según
 * la situación, de la más rápida a la de último recurso.
 */
function RecoveryModal({ open, onClose, onPasskey }: { open: boolean; onClose: () => void; onPasskey: (() => void) | null }) {
  const cmd = 'docker compose exec skyway node dist/tools/reset-password.js tu@email.com';
  return (
    <Modal open={open} onClose={onClose} title="Recuperar el acceso">
      <div className="flex flex-col gap-5 text-[13px] leading-relaxed text-sub">
        {onPasskey && (
          <div>
            <p className="flex items-center gap-2 font-semibold text-txt">
              <Fingerprint size={14} className="text-acc-soft" />
              ¿Registraste una passkey?
            </p>
            <p className="mt-1">Entra con ella y pon una contraseña nueva en Seguridad.</p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2.5"
              onClick={() => {
                onClose();
                onPasskey();
              }}
            >
              <Fingerprint size={14} /> Entrar con passkey
            </Button>
          </div>
        )}
        <div>
          <p className="flex items-center gap-2 font-semibold text-txt">
            <Users2 size={14} className="text-info" />
            ¿Hay otro administrador?
          </p>
          <p className="mt-1">
            Puede ponerte una contraseña nueva en <span className="text-txt">Usuarios → tu cuenta → Nueva contraseña</span>. Tus
            sesiones antiguas se invalidan al momento.
          </p>
        </div>
        <div>
          <p className="flex items-center gap-2 font-semibold text-txt">
            <TerminalSquare size={14} className="text-warn" />
            ¿Eres el único admin? Desde el servidor:
          </p>
          <div className="mt-2 flex items-center gap-1 rounded-lg border border-line bg-term px-3 py-2">
            <code className="min-w-0 flex-1 select-all whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-txt/90">
              <span className="mr-1.5 select-none text-subtle">$</span>
              {cmd}
            </code>
            <CopyButton value={cmd} title="Copiar comando" />
          </div>
          <p className="mt-1.5 text-[11.5px] text-subtle">
            Imprime una contraseña temporal, cierra las demás sesiones y deja rastro en la auditoría. Sin Docker:{' '}
            <code className="font-mono text-[11px]">npm run reset-password -w server -- tu@email.com</code>
          </p>
        </div>
        <p className="flex items-center gap-1.5 border-t border-line pt-3 text-[11.5px] text-subtle">
          <KeyRound size={12} className="shrink-0" />
          Skyway no envía emails de restablecimiento: nadie puede pedir un reset en tu nombre desde fuera.
        </p>
      </div>
    </Modal>
  );
}

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  // Cada fallo incrementa la clave de la tarjeta: la sacudida se repite aunque el mensaje no cambie.
  const [errorShake, setErrorShake] = useState(0);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pkLoading, setPkLoading] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const fail = (message: string) => {
    setError(message);
    setErrorShake((n) => n + 1);
  };

  const passkey = async () => {
    setError('');
    setPkLoading(true);
    try {
      await loginWithPasskey();
      // Limpia la caché del usuario anterior antes de entrar como el nuevo.
      queryClient.clear();
      navigate('/');
    } catch (err) {
      // Cancelar el diálogo del navegador no es un error que mostrar.
      if ((err as DOMException)?.name !== 'NotAllowedError') {
        fail(err instanceof ApiError ? err.message : 'No se pudo usar la passkey');
      }
    } finally {
      setPkLoading(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/login', { email, password });
      // Limpia la caché del usuario anterior antes de entrar como el nuevo.
      queryClient.clear();
      navigate('/');
    } catch (err) {
      fail(err instanceof ApiError ? err.message : 'Error inesperado');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="relative flex min-h-full items-center justify-center overflow-hidden p-6"
      style={{
        background:
          'radial-gradient(1200px 600px at 50% -10%, color-mix(in oklab, #6e56cf 14%, transparent), transparent 70%), radial-gradient(700px 380px at 85% 0%, color-mix(in oklab, var(--color-info) 7%, transparent), transparent 62%), var(--color-bg)',
      }}
    >
      <span aria-hidden className="estrella-fugaz" />
      <div className="panel-in relative w-full max-w-[400px]">
        {/* Halo de marca que respira despacio tras la tarjeta: profundidad sin distracción. */}
        <div
          aria-hidden
          className="halo-breathe pointer-events-none absolute -inset-10 -z-10 rounded-[40px] blur-3xl"
          style={{ background: 'radial-gradient(closest-side, color-mix(in oklab, #6e56cf 16%, transparent), transparent 75%)' }}
        />
        <div
          key={errorShake}
          className={cx(
            'rounded-2xl border border-line bg-surface px-7 py-8 shadow-[0_24px_64px_-24px_rgba(0,0,0,.7),inset_0_1px_0_color-mix(in_oklab,#6e56cf_16%,transparent)]',
            errorShake > 0 && 'shake',
          )}
        >
          <div className="mb-6 flex flex-col items-center gap-3.5 text-center">
            <BrandMark size={52} iconSize={24} radius={14} />
            <div>
              <h1 className="text-[19px] font-[650] tracking-[-.015em]">Entrar en Skyway</h1>
              <p className="mt-1 text-[13px] text-sub">Tu plataforma de despliegue auto-alojada</p>
            </div>
          </div>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field label="Email">
              {/* autocomplete webauthn: el teclado del móvil ofrece la passkey guardada al tocar el campo. */}
              <input
                className="input"
                type="email"
                inputMode="email"
                autoComplete="username webauthn"
                autoCapitalize="none"
                spellCheck={false}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </Field>
            <Field
              label={
                <span className="flex w-full items-center justify-between">
                  Contraseña
                  <button
                    type="button"
                    onClick={() => setRecoveryOpen(true)}
                    className="font-normal text-subtle transition-colors hover:text-acc-soft"
                  >
                    ¿La has olvidado?
                  </button>
                </span>
              }
            >
              <div className="relative">
                <input
                  className="input pr-10"
                  type={showPw ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPw(!showPw)}
                  className="press absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 leading-none text-subtle hover:text-txt"
                  title={showPw ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                >
                  {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </Field>
            {error && <p className="tab-in text-sm text-err">{error}</p>}
            <Button type="submit" size="lg" loading={loading} className="w-full">
              Entrar
            </Button>
          </form>
          {passkeysSupported() && (
            <>
              <div className="my-4 flex items-center gap-3 text-[11px] text-subtle">
                <span className="h-px flex-1 bg-line" />
                o
                <span className="h-px flex-1 bg-line" />
              </div>
              <Button variant="secondary" size="lg" loading={pkLoading} onClick={passkey} className="w-full">
                <Fingerprint size={16} /> Entrar con passkey
              </Button>
            </>
          )}
        </div>
        <p className="mt-4 flex items-center justify-center gap-1.5 text-[11.5px] text-subtle">
          <ShieldCheck size={12} /> Intentos limitados por IP · toda la actividad queda en el registro de auditoría
        </p>
      </div>
      <RecoveryModal
        open={recoveryOpen}
        onClose={() => setRecoveryOpen(false)}
        onPasskey={passkeysSupported() ? passkey : null}
      />
    </div>
  );
}
