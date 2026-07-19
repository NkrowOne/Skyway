import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Fingerprint, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../api';
import { BrandMark } from '../components/Layout';
import { Button, Field } from '../components/ui';
import { loginWithPasskey, passkeysSupported } from '../webauthn';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pkLoading, setPkLoading] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const passkey = async () => {
    setError('');
    setPkLoading(true);
    try {
      await loginWithPasskey();
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      navigate('/');
    } catch (err) {
      // Cancelar el diálogo del navegador no es un error que mostrar.
      if ((err as DOMException)?.name !== 'NotAllowedError') {
        setError(err instanceof ApiError ? err.message : 'No se pudo usar la passkey');
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
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error inesperado');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="flex min-h-full items-center justify-center p-6"
      style={{
        background:
          'radial-gradient(1200px 600px at 50% -10%, color-mix(in oklab, #6e56cf 10%, transparent), transparent 70%), var(--color-bg)',
      }}
    >
      <div className="w-full max-w-[400px]">
        <div className="rounded-2xl border border-line bg-surface px-7 py-8 shadow-[0_24px_64px_-24px_rgba(0,0,0,.7)]">
          <div className="mb-6 flex flex-col items-center gap-3.5 text-center">
            <BrandMark size={52} iconSize={24} radius={14} />
            <div>
              <h1 className="text-[19px] font-[650] tracking-[-.015em]">Entrar en Skyway</h1>
              <p className="mt-1 text-[13px] text-sub">Tu plataforma de despliegue auto-alojada</p>
            </div>
          </div>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field label="Email">
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </Field>
            <Field label="Contraseña">
              <div className="relative">
                <input
                  className="input pr-10"
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPw(!showPw)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 leading-none text-subtle transition-colors hover:text-txt"
                  title={showPw ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                >
                  {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </Field>
            {error && <p className="text-sm text-err">{error}</p>}
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
    </div>
  );
}
