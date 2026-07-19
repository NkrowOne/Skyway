import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, CheckCircle2, Cpu, Globe, Trash2 } from 'lucide-react';
import { api } from '../api';
import { ModuleLogo } from '../components/ModuleIcon';
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

function OkPill({ label, dot }: { label: string; dot?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-ok/[.14] px-2 py-px text-[10px] font-semibold text-ok">
      {dot ? <span className="h-[5px] w-[5px] rounded-full bg-current" /> : <CheckCircle2 size={10} />}
      {label}
    </span>
  );
}

function ErrPill({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-err/[.14] px-2 py-px text-[10px] font-semibold text-err">
      <span className="h-[5px] w-[5px] rounded-full bg-current" />
      {label}
    </span>
  );
}

function SettingsSection({
  icon,
  iconClass,
  title,
  description,
  aside,
  children,
}: {
  icon: React.ReactNode;
  iconClass: string;
  title: string;
  description: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5">
          <span className={cx('flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg', iconClass)}>{icon}</span>
          <div>
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="mt-px text-xs text-subtle">{description}</p>
          </div>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-line bg-bg px-3.5 py-3">
      <p className="text-[11px] text-subtle">{label}</p>
      <p className="tnum mt-[3px] text-sm font-semibold">{value}</p>
      <p className="mt-px text-[11px] text-sub">{sub}</p>
    </div>
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
      else toast(`Notificación enviada a: ${res.channels.join(', ')}`, 'ok');
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      setTesting(false);
    }
  };

  const sys = system.data;

  return (
    <div className="mx-auto flex max-w-[780px] flex-col gap-5 px-4 py-7 sm:px-6 sm:py-10">
      <div className="mb-2">
        <h1 className="text-2xl font-semibold tracking-[-.02em]">Ajustes</h1>
        <p className="mt-1.5 text-sm text-sub">Configuración global del servidor: dominios, integraciones, alertas y mantenimiento</p>
      </div>

      <SettingsSection
        icon={<Globe size={15} />}
        iconClass="bg-info/[.13] text-info"
        title="Dominios y TLS"
        description="Subdominios en un clic y certificados automáticos"
      >
        <div className="flex flex-col gap-3.5">
          <Field
            label="Dominio raíz"
            hint="Genera subdominios por servicio en un clic. Requisito único: un registro A comodín (*.tudominio) apuntando a la IP del servidor."
          >
            <input className="input" placeholder="apps.midominio.com" value={rootDomain} onChange={(e) => setRootDomain(e.target.value)} />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Email para Let's Encrypt" hint="Con email definido, TLS automático en cada dominio">
              <input
                className="input"
                type="email"
                placeholder="tu@email.com"
                value={letsencryptEmail}
                onChange={(e) => setLetsencryptEmail(e.target.value)}
              />
            </Field>
            <Field
              label={
                <>
                  IP pública del servidor {serverIpInfo.data?.ip && !serverIp && <OkPill label="autodetectada" />}
                </>
              }
              hint={
                serverIpInfo.data?.ip
                  ? `Detectada: ${serverIpInfo.data.ip}. Rellénala solo si es incorrecta; verifica los DNS.`
                  : 'No se pudo detectar automáticamente: indícala para verificar los DNS de tus dominios.'
              }
            >
              <input
                className="input font-mono text-xs"
                placeholder={serverIpInfo.data?.ip ?? '203.0.113.10'}
                value={serverIp}
                onChange={(e) => setServerIp(e.target.value)}
              />
            </Field>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        icon={<ModuleLogo kind="github" size={15} />}
        iconClass="bg-txt/[.09] text-txt"
        title="GitHub"
        description={
          <>
            Token de acceso personal (permiso <span className="font-mono">repo</span>) para clonar repos privados
          </>
        }
        aside={settings.data?.settings.hasGithubToken ? <OkPill label="Conectado" /> : undefined}
      >
        <Field label="Token de GitHub" hint="Se usa para clonar y para los webhooks de auto-deploy de cada servicio">
          <input
            className="input font-mono text-xs"
            type="password"
            placeholder={settings.data?.settings.hasGithubToken ? '••••••••••••  (escribir para reemplazar)' : 'ghp_...'}
            value={githubToken}
            onChange={(e) => setGithubToken(e.target.value)}
          />
        </Field>
      </SettingsSection>

      <SettingsSection
        icon={<BellRing size={15} />}
        iconClass="bg-warn/[.13] text-warn"
        title="Alertas y notificaciones"
        description="Caídas, bucles de reinicio y CPU/RAM sostenidas — sin tener el panel abierto"
      >
        <div className="mb-3.5 grid grid-cols-3 gap-3">
          <Field label="Umbral CPU (%)" hint="por defecto 90">
            <input className="input tnum" type="number" min={10} max={100} placeholder="90" value={cpuPct} onChange={(e) => setCpuPct(e.target.value)} />
          </Field>
          <Field label="Umbral RAM (%)" hint="por defecto 90">
            <input className="input tnum" type="number" min={10} max={100} placeholder="90" value={memPct} onChange={(e) => setMemPct(e.target.value)} />
          </Field>
          <Field label="Sostenido (min)" hint="por defecto 5">
            <input className="input tnum" type="number" min={1} max={120} placeholder="5" value={sustainMin} onChange={(e) => setSustainMin(e.target.value)} />
          </Field>
        </div>
        <div className="flex flex-col gap-3">
          <Field label="Webhook genérico (POST JSON)" hint="Para n8n, Zapier, tu propio endpoint…">
            <input className="input font-mono text-xs" placeholder="https://…" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} />
          </Field>
          <Field label="Webhook de Discord" hint="Canal → Ajustes → Integraciones → Webhooks">
            <input
              className="input font-mono text-xs"
              placeholder="https://discord.com/api/webhooks/…"
              value={discordUrl}
              onChange={(e) => setDiscordUrl(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label={<>Token del bot de Telegram {settings.data?.settings.hasTelegramToken && <OkPill label="configurado" />}</>}
              hint={settings.data?.settings.hasTelegramToken ? undefined : 'Crea un bot con @BotFather'}
            >
              <input
                className="input font-mono text-xs"
                type="password"
                placeholder={settings.data?.settings.hasTelegramToken ? '••••••••  (escribir para reemplazar)' : '123456:ABC...'}
                value={telegramToken}
                onChange={(e) => setTelegramToken(e.target.value)}
              />
            </Field>
            <Field label="Chat ID de Telegram" hint="Tu ID o el de un grupo (@userinfobot)">
              <input
                className="input font-mono text-xs"
                placeholder="-100123456789"
                value={telegramChat}
                onChange={(e) => setTelegramChat(e.target.value)}
              />
            </Field>
          </div>
        </div>
        <div className="mt-3.5 flex justify-end">
          <Button variant="secondary" size="sm" onClick={testChannels} loading={testing}>
            Enviar notificación de prueba
          </Button>
        </div>
      </SettingsSection>

      {sys && (
        <SettingsSection
          icon={<Cpu size={15} />}
          iconClass="bg-acc/[.15] text-acc-soft"
          title="Sistema"
          description="Estado del host y uso de disco de Docker"
          aside={
            <div className="flex flex-wrap gap-2">
              {sys.docker ? <OkPill dot label="Docker conectado" /> : <ErrPill label="Docker no disponible" />}
              {sys.nixpacks ? <OkPill dot label="Nixpacks instalado" /> : <ErrPill label="Nixpacks no instalado" />}
            </div>
          }
        >
          <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2.5">
            <StatTile label="CPU" value={`${sys.host.cpus} núcleos`} sub={`carga ${sys.host.load[0]}`} />
            <StatTile label="Memoria" value={`${fmtBytes(sys.host.freeMem)} libres`} sub={`de ${fmtBytes(sys.host.totalMem)}`} />
            <StatTile
              label="Disco"
              value={sys.disk ? `${fmtBytes(sys.disk.free)} libres` : 'n/d'}
              sub={sys.disk ? `de ${fmtBytes(sys.disk.total)}` : ''}
            />
            <StatTile label="Skyway" value={`v${sys.version}`} sub={`${sys.host.platform}/${sys.host.arch}`} />
          </div>

          {dockerUsage.data && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-bg px-3.5 py-3">
              <div className="tnum flex flex-wrap gap-4 text-xs text-sub">
                <span>
                  Imágenes <span className="font-semibold text-txt">{fmtBytes(dockerUsage.data.images.size)}</span> ({dockerUsage.data.images.count})
                </span>
                <span>
                  Volúmenes <span className="font-semibold text-txt">{fmtBytes(dockerUsage.data.volumes.size)}</span> ({dockerUsage.data.volumes.count})
                </span>
                <span>
                  Caché de build <span className="font-semibold text-txt">{fmtBytes(dockerUsage.data.buildCache.size)}</span>
                </span>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => prune.mutate()}
                loading={prune.isPending}
                title="Purga imágenes colgantes y caché de build. Nunca toca volúmenes."
              >
                <Trash2 size={13} /> Liberar espacio
              </Button>
            </div>
          )}
          <p className="mt-3 text-[11px] text-subtle">
            La limpieza purga imágenes colgantes y caché de build; nunca toca volúmenes. Si Nixpacks faltara, los repos sin
            Dockerfile no podrían construirse: <span className="font-mono">curl -sSL https://nixpacks.com/install.sh | bash</span>
          </p>
        </SettingsSection>
      )}

      <div className="sticky bottom-0 mt-1 flex items-center justify-end gap-2.5 border-t border-line bg-bg/90 py-3 backdrop-blur-lg">
        <span className="text-xs text-subtle">Los cambios se aplican al guardar</span>
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          Guardar ajustes
        </Button>
      </div>
    </div>
  );
}
