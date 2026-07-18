import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, HardDrive, Package } from 'lucide-react';
import { api } from '../api';
import { Button, Field, useToast } from '../components/ui';
import { SystemInfo } from '../types';
import { cx, fmtBytes } from '../utils';

interface Settings {
  rootDomain: string | null;
  letsencryptEmail: string | null;
  hasGithubToken: boolean;
}

function Chip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
        ok ? 'border-ok/40 bg-ok/10 text-ok' : 'border-err/40 bg-err/10 text-err',
      )}
    >
      <span className={cx('h-1.5 w-1.5 rounded-full', ok ? 'bg-ok' : 'bg-err')} />
      {label}
    </span>
  );
}

export default function SettingsPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [rootDomain, setRootDomain] = useState('');
  const [letsencryptEmail, setLetsencryptEmail] = useState('');
  const [githubToken, setGithubToken] = useState('');

  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings: Settings }>('/settings'),
  });
  const system = useQuery({
    queryKey: ['system'],
    queryFn: () => api.get<SystemInfo>('/system'),
  });

  useEffect(() => {
    if (settings.data) {
      setRootDomain(settings.data.settings.rootDomain || '');
      setLetsencryptEmail(settings.data.settings.letsencryptEmail || '');
    }
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      api.put('/settings', {
        rootDomain,
        letsencryptEmail,
        ...(githubToken ? { githubToken } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setGithubToken('');
      toast('Ajustes guardados', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const sys = system.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <h1 className="text-xl font-semibold">Ajustes</h1>

      <section className="card p-6">
        <h2 className="mb-4 text-sm font-semibold">Dominios y TLS</h2>
        <div className="space-y-4">
          <Field
            label="Dominio raíz"
            hint="Con un dominio raíz (ej: apps.midominio.com) podrás generar subdominios automáticos para tus servicios"
          >
            <input className="input" placeholder="apps.midominio.com" value={rootDomain} onChange={(e) => setRootDomain(e.target.value)} />
          </Field>
          <Field
            label="Email para Let's Encrypt"
            hint="Si lo defines, Traefik emitirá certificados TLS automáticos para los dominios de tus servicios"
          >
            <input className="input" type="email" placeholder="tu@email.com" value={letsencryptEmail} onChange={(e) => setLetsencryptEmail(e.target.value)} />
          </Field>
        </div>
      </section>

      <section className="card p-6">
        <h2 className="mb-1 text-sm font-semibold">GitHub</h2>
        <p className="mb-4 text-xs text-sub">
          Token de acceso personal (con permiso <span className="font-mono">repo</span>) para clonar repositorios privados.
          {settings.data?.settings.hasGithubToken && <span className="ml-1 text-ok">Token configurado ✓</span>}
        </p>
        <Field label="Token de GitHub">
          <input
            className="input font-mono"
            type="password"
            placeholder={settings.data?.settings.hasGithubToken ? '••••••••••••  (escribir para reemplazar)' : 'ghp_...'}
            value={githubToken}
            onChange={(e) => setGithubToken(e.target.value)}
          />
        </Field>
      </section>

      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          Guardar ajustes
        </Button>
      </div>

      {sys && (
        <section className="card p-6">
          <h2 className="mb-4 text-sm font-semibold">Sistema</h2>
          <div className="mb-4 flex flex-wrap gap-2">
            <Chip ok={sys.docker} label={sys.docker ? 'Docker conectado' : 'Docker no disponible'} />
            <Chip ok={sys.nixpacks} label={sys.nixpacks ? 'Nixpacks instalado' : 'Nixpacks no instalado'} />
          </div>
          <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <div className="flex items-center gap-3 rounded-lg border border-line bg-panel2 p-3">
              <Cpu size={18} className="text-acc" />
              <div>
                <p className="text-xs text-sub">CPU</p>
                <p>{sys.host.cpus} núcleos · carga {sys.host.load[0]}</p>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-lg border border-line bg-panel2 p-3">
              <HardDrive size={18} className="text-acc" />
              <div>
                <p className="text-xs text-sub">Memoria</p>
                <p>{fmtBytes(sys.host.freeMem)} libres de {fmtBytes(sys.host.totalMem)}</p>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-lg border border-line bg-panel2 p-3">
              <Package size={18} className="text-acc" />
              <div>
                <p className="text-xs text-sub">Skyway</p>
                <p>v{sys.version} · {sys.host.platform}/{sys.host.arch}</p>
              </div>
            </div>
          </div>
          <p className="mt-3 text-xs text-sub">
            Si Nixpacks no está instalado, los repositorios sin Dockerfile no podrán construirse. Instálalo con:{' '}
            <span className="font-mono">curl -sSL https://nixpacks.com/install.sh | bash</span>
          </p>
        </section>
      )}
    </div>
  );
}
