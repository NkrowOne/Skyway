import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, Database, HardDrive, Package, Trash2 } from 'lucide-react';
import { api } from '../api';
import { Button, Field, useToast } from '../components/ui';
import { DockerUsage, SystemInfo } from '../types';
import { cx, fmtBytes } from '../utils';

interface Settings {
  rootDomain: string | null;
  letsencryptEmail: string | null;
  serverIp: string | null;
  hasGithubToken: boolean;
  hasTelegramToken: boolean;
  alertCpuPercent: string | null;
  alertMemPercent: string | null;
  alertSustainMinutes: string | null;
  alertWebhookUrl: string | null;
  alertDiscordUrl: string | null;
  alertTelegramChat: string | null;
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
  const [serverIp, setServerIp] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [cpuPct, setCpuPct] = useState('');
  const [memPct, setMemPct] = useState('');
  const [sustainMin, setSustainMin] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [discordUrl, setDiscordUrl] = useState('');
  const [telegramToken, setTelegramToken] = useState('');
  const [telegramChat, setTelegramChat] = useState('');
  const [testing, setTesting] = useState(false);

  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings: Settings }>('/settings'),
  });
  const system = useQuery({
    queryKey: ['system'],
    queryFn: () => api.get<SystemInfo>('/system'),
  });

  const serverIpInfo = useQuery({
    queryKey: ['serverIp'],
    queryFn: () => api.get<{ ip: string | null; source: string | null }>('/domains/server-ip'),
    staleTime: 300_000,
  });

  const dockerUsage = useQuery({
    queryKey: ['dockerUsage'],
    queryFn: () => api.get<DockerUsage>('/system/docker-usage'),
    enabled: !!system.data?.docker,
    staleTime: 60_000,
    retry: false,
  });

  const prune = useMutation({
    mutationFn: () => api.post<{ reclaimed: string }>('/system/prune'),
    onSuccess: (res) => {
      toast(`Espacio liberado: ${res.reclaimed}`, 'ok');
      queryClient.invalidateQueries({ queryKey: ['dockerUsage'] });
      queryClient.invalidateQueries({ queryKey: ['system'] });
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  useEffect(() => {
    if (settings.data) {
      const s = settings.data.settings;
      setRootDomain(s.rootDomain || '');
      setLetsencryptEmail(s.letsencryptEmail || '');
      setServerIp(s.serverIp || '');
      setCpuPct(s.alertCpuPercent || '');
      setMemPct(s.alertMemPercent || '');
      setSustainMin(s.alertSustainMinutes || '');
      setWebhookUrl(s.alertWebhookUrl || '');
      setDiscordUrl(s.alertDiscordUrl || '');
      setTelegramChat(s.alertTelegramChat || '');
    }
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      api.put('/settings', {
        rootDomain,
        letsencryptEmail,
        serverIp,
        alertCpuPercent: cpuPct,
        alertMemPercent: memPct,
        alertSustainMinutes: sustainMin,
        alertWebhookUrl: webhookUrl,
        alertDiscordUrl: discordUrl,
        alertTelegramChat: telegramChat,
        ...(githubToken ? { githubToken } : {}),
        ...(telegramToken ? { alertTelegramToken: telegramToken } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setGithubToken('');
      setTelegramToken('');
      toast('Ajustes guardados', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const testChannels = async () => {
    setTesting(true);
    try {
      const res = await api.post<{ ok: boolean; channels: string[]; failures: string[] }>('/settings/alerts/test');
      if (res.failures.length > 0) toast(`Fallo en: ${res.failures.join(', ')}. Revisa la configuración.`, 'err');
      else toast(`Notificación enviada a: ${res.channels.join(', ')} ✓`, 'ok');
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      setTesting(false);
    }
  };

  const sys = system.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <h1 className="text-xl font-semibold">Ajustes</h1>

      <section className="card p-6">
        <h2 className="mb-4 text-sm font-semibold">Dominios y TLS</h2>
        <div className="space-y-4">
          <Field
            label="Dominio raíz"
            hint="Con un dominio raíz (ej: apps.midominio.com) generas subdominios por servicio en un clic. Requisito único: un registro A comodín (*.apps.midominio.com) apuntando a la IP del servidor."
          >
            <input className="input" placeholder="apps.midominio.com" value={rootDomain} onChange={(e) => setRootDomain(e.target.value)} />
          </Field>
          <Field
            label="Email para Let's Encrypt"
            hint="Si lo defines, Traefik emitirá certificados TLS automáticos para los dominios de tus servicios"
          >
            <input className="input" type="email" placeholder="tu@email.com" value={letsencryptEmail} onChange={(e) => setLetsencryptEmail(e.target.value)} />
          </Field>
          <Field
            label="IP pública del servidor"
            hint={
              serverIpInfo.data?.ip
                ? `Detectada automáticamente: ${serverIpInfo.data.ip}. Rellénala solo si es incorrecta (se usa para verificar los DNS de tus dominios).`
                : 'No se pudo detectar automáticamente: indícala para que Skyway verifique los DNS de tus dominios.'
            }
          >
            <input className="input font-mono" placeholder={serverIpInfo.data?.ip ?? '203.0.113.10'} value={serverIp} onChange={(e) => setServerIp(e.target.value)} />
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

      <section className="card p-6">
        <h2 className="mb-1 text-sm font-semibold">Alertas y notificaciones</h2>
        <p className="mb-4 text-xs text-sub">
          Skyway vigila caídas, bucles de reinicio y consumo de CPU/RAM. Configura al menos un canal para enterarte sin
          tener el panel abierto.
        </p>
        <div className="mb-4 grid grid-cols-3 gap-3">
          <Field label="Umbral CPU (%)" hint="por defecto 90">
            <input className="input" type="number" min={10} max={100} placeholder="90" value={cpuPct} onChange={(e) => setCpuPct(e.target.value)} />
          </Field>
          <Field label="Umbral RAM (%)" hint="por defecto 90">
            <input className="input" type="number" min={10} max={100} placeholder="90" value={memPct} onChange={(e) => setMemPct(e.target.value)} />
          </Field>
          <Field label="Sostenido (min)" hint="por defecto 5">
            <input className="input" type="number" min={1} max={120} placeholder="5" value={sustainMin} onChange={(e) => setSustainMin(e.target.value)} />
          </Field>
        </div>
        <div className="space-y-4">
          <Field label="Webhook genérico (POST JSON)" hint="Para n8n, Zapier, tu propio endpoint...">
            <input className="input font-mono text-xs" placeholder="https://..." value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} />
          </Field>
          <Field label="Webhook de Discord" hint="Canal → Ajustes → Integraciones → Webhooks">
            <input className="input font-mono text-xs" placeholder="https://discord.com/api/webhooks/..." value={discordUrl} onChange={(e) => setDiscordUrl(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Token del bot de Telegram" hint={settings.data?.settings.hasTelegramToken ? 'Token configurado ✓' : 'Crea un bot con @BotFather'}>
              <input
                className="input font-mono text-xs"
                type="password"
                placeholder={settings.data?.settings.hasTelegramToken ? '••••••••  (escribir para reemplazar)' : '123456:ABC...'}
                value={telegramToken}
                onChange={(e) => setTelegramToken(e.target.value)}
              />
            </Field>
            <Field label="Chat ID de Telegram" hint="Tu ID o el de un grupo (@userinfobot)">
              <input className="input font-mono text-xs" placeholder="-100123456789" value={telegramChat} onChange={(e) => setTelegramChat(e.target.value)} />
            </Field>
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="outline" size="sm" onClick={testChannels} loading={testing}>
            Enviar notificación de prueba
          </Button>
        </div>
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
          <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
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
              <Database size={18} className={cx(sys.disk && sys.disk.free / sys.disk.total < 0.1 ? 'text-err' : 'text-acc')} />
              <div>
                <p className="text-xs text-sub">Disco</p>
                <p>{sys.disk ? `${fmtBytes(sys.disk.free)} libres de ${fmtBytes(sys.disk.total)}` : 'n/d'}</p>
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

          {dockerUsage.data && (
            <div className="mt-4 rounded-lg border border-line bg-panel2 p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-4 text-xs text-sub">
                  <span>
                    Imágenes: <span className="text-txt">{fmtBytes(dockerUsage.data.images.size)}</span> ({dockerUsage.data.images.count})
                  </span>
                  <span>
                    Volúmenes: <span className="text-txt">{fmtBytes(dockerUsage.data.volumes.size)}</span> ({dockerUsage.data.volumes.count})
                  </span>
                  <span>
                    Caché de build: <span className="text-txt">{fmtBytes(dockerUsage.data.buildCache.size)}</span>
                  </span>
                </div>
                <Button size="sm" variant="outline" onClick={() => prune.mutate()} loading={prune.isPending} title="Purga imágenes colgantes y caché de build. Nunca toca volúmenes.">
                  <Trash2 size={13} /> Liberar espacio
                </Button>
              </div>
            </div>
          )}
          <p className="mt-3 text-xs text-sub">
            Si Nixpacks no está instalado, los repositorios sin Dockerfile no podrán construirse. Instálalo con:{' '}
            <span className="font-mono">curl -sSL https://nixpacks.com/install.sh | bash</span>
          </p>
        </section>
      )}
    </div>
  );
}
