import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, Globe, HelpCircle, Plus, RefreshCw, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { cx, Tone } from '../utils';
import { Button, CopyButton, useToast } from './ui';

interface DomainCheck {
  domain: string;
  status: 'ok' | 'wrong_ip' | 'no_record' | 'unknown';
  resolvedIps: string[];
  expectedIp: string | null;
  message: string;
}

interface SettingsData {
  settings: { rootDomain: string | null; letsencryptEmail: string | null };
}

const STATUS_META: Record<DomainCheck['status'], { label: string; tone: Tone }> = {
  ok: { label: 'DNS correcto', tone: 'ok' },
  no_record: { label: 'Esperando DNS', tone: 'warn' },
  wrong_ip: { label: 'Apunta a otra IP', tone: 'err' },
  unknown: { label: 'Sin verificar', tone: 'neutral' },
};

const TONE_PILL: Record<Tone, string> = {
  ok: 'bg-ok/[.14] text-ok',
  warn: 'bg-warn/[.13] text-warn',
  err: 'bg-err/[.14] text-err',
  info: 'bg-info/[.13] text-info',
  neutral: 'bg-surface2 text-sub',
};

/** Divide un dominio en (nombre a crear, zona) de forma aproximada. */
function splitDnsName(domain: string): { name: string; zone: string } {
  const parts = domain.split('.');
  if (parts.length <= 2) return { name: '@', zone: domain };
  return { name: parts.slice(0, -2).join('.'), zone: parts.slice(-2).join('.') };
}

function DnsInstructions({ domain, serverIp }: { domain: string; serverIp: string | null }) {
  const { name, zone } = splitDnsName(domain);
  const ip = serverIp ?? 'IP-DE-TU-SERVIDOR';
  return (
    <div className="mt-2 rounded-lg border border-line bg-surface2 p-3 text-xs">
      <p className="mb-2 text-sub">
        En el panel DNS de <span className="font-mono text-txt">{zone}</span> (Cloudflare, IONOS, OVH, GoDaddy...) crea
        este registro:
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className="text-sub">
            <tr>
              <th className="pb-1 pr-4 font-medium">Tipo</th>
              <th className="pb-1 pr-4 font-medium">Nombre / Host</th>
              <th className="pb-1 font-medium">Valor</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            <tr>
              <td className="pr-4">A</td>
              <td className="pr-4">{name}</td>
              <td>
                <span className="inline-flex items-center gap-1">
                  {ip}
                  {serverIp && <CopyButton value={serverIp} />}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-subtle">
        La propagación suele tardar de 5 minutos a unas horas. Pulsa <RefreshCw size={10} className="inline" /> para
        volver a comprobar.
      </p>
    </div>
  );
}

function DomainRow({
  domain,
  serverIp,
  tls,
  onRemove,
}: {
  domain: string;
  serverIp: string | null;
  tls: boolean;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const check = useQuery({
    queryKey: ['domainCheck', domain],
    queryFn: () => api.post<{ check: DomainCheck }>('/domains/check', { domain }),
    staleTime: 30_000,
    retry: false,
  });

  const status = check.data?.check.status ?? 'unknown';
  const meta = STATUS_META[status];

  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        <Globe size={13} className="shrink-0 text-info" />
        <span className="min-w-0 truncate font-mono text-xs">{domain}</span>
        <button
          onClick={() => setExpanded(!expanded)}
          className={cx(
            'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
            TONE_PILL[meta.tone],
          )}
          title="Ver detalle"
        >
          {status === 'ok' && <CheckCircle2 size={10} />}
          {check.isFetching ? 'Comprobando…' : meta.label}
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            onClick={() => check.refetch()}
            className="rounded-md p-1 leading-none text-subtle transition-colors hover:text-txt"
            title="Volver a comprobar el DNS"
          >
            <RefreshCw size={12} className={cx(check.isFetching && 'animate-spin')} />
          </button>
          <a
            href={`${tls ? 'https' : 'http'}://${domain}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-md p-1 leading-none text-subtle transition-colors hover:text-txt"
            title="Abrir"
          >
            <ExternalLink size={12} />
          </a>
          <button onClick={onRemove} className="rounded-md p-1 leading-none text-subtle transition-colors hover:text-err" title="Quitar">
            <X size={12} />
          </button>
        </span>
      </div>
      {(expanded || status === 'no_record' || status === 'wrong_ip') && (
        <div className="mt-1.5">
          {check.data && <p className="text-xs text-sub">{check.data.check.message}</p>}
          {status !== 'ok' && <DnsInstructions domain={domain} serverIp={serverIp} />}
        </div>
      )}
    </div>
  );
}

/**
 * Editor de dominios estilo Railway: subdominio generado en un clic o dominio
 * propio con instrucciones DNS y verificación en vivo.
 */
export default function DomainsEditor({
  domains,
  onChange,
  slug,
}: {
  domains: string[];
  onChange: (domains: string[]) => void;
  slug: string;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [custom, setCustom] = useState('');
  const [newRootDomain, setNewRootDomain] = useState('');

  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsData>('/settings') });
  const serverIp = useQuery({
    queryKey: ['serverIp'],
    queryFn: () => api.get<{ ip: string | null; source: string | null }>('/domains/server-ip'),
    staleTime: 300_000,
  });

  const saveRootDomain = useMutation({
    mutationFn: () => api.put('/settings', { rootDomain: newRootDomain.trim().toLowerCase() }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast('Dominio raíz guardado', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const rootDomain = settings.data?.settings.rootDomain || null;
  const tls = !!settings.data?.settings.letsencryptEmail;
  const ip = serverIp.data?.ip ?? null;
  const generated = rootDomain ? `${slug}.${rootDomain}` : null;

  const add = (raw: string) => {
    const domain = raw.trim().toLowerCase();
    if (!domain) return;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      toast(`"${domain}" no parece un dominio válido`, 'err');
      return;
    }
    if (domains.includes(domain)) {
      toast('Ese dominio ya está añadido', 'err');
      return;
    }
    onChange([...domains, domain]);
    setCustom('');
  };

  return (
    <div className="flex flex-col gap-2.5">
      {domains.length > 0 && (
        <div className="flex flex-col gap-2">
          {domains.map((d) => (
            <DomainRow key={d} domain={d} serverIp={ip} tls={tls} onRemove={() => onChange(domains.filter((x) => x !== d))} />
          ))}
        </div>
      )}

      {/* Subdominio automático */}
      <div className="rounded-lg border border-dashed border-acc/40 bg-acc/[.06] p-3">
        {rootDomain ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2 text-xs text-acc-soft">
                <Globe size={13} className="shrink-0" />
                <span className="truncate font-mono text-xs text-txt">{generated}</span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                className="h-[30px]"
                disabled={!generated || domains.includes(generated)}
                onClick={() => generated && add(generated)}
              >
                <Plus size={12} /> {domains.includes(generated!) ? 'Añadido' : 'Añadir subdominio'}
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-subtle">
              Generado desde tu dominio raíz. Requisito único: registro <span className="font-mono">A</span> comodín{' '}
              <span className="font-mono">
                *.{rootDomain} → {ip ?? 'IP del servidor'}
              </span>
              .
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs font-medium text-acc-soft">
              <Globe size={13} /> Subdominio automático
            </div>
            <div className="mt-2 flex flex-col gap-2 text-xs text-sub">
              <p>
                Configura una vez tu <strong className="text-txt">dominio raíz</strong> (ej:{' '}
                <span className="font-mono">apps.midominio.com</span>) y podrás generar subdominios para cada servicio en
                un clic, como en Railway.
              </p>
              <div className="flex gap-2">
                <input
                  className="input flex-1 font-mono text-xs"
                  placeholder="apps.midominio.com"
                  value={newRootDomain}
                  onChange={(e) => setNewRootDomain(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-9"
                  disabled={!newRootDomain.trim()}
                  loading={saveRootDomain.isPending}
                  onClick={() => saveRootDomain.mutate()}
                >
                  Guardar
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Dominio propio */}
      <div className="flex gap-2">
        <input
          className="input flex-1 font-mono text-xs"
          placeholder="app.clienteacme.com"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(custom);
            }
          }}
        />
        <Button size="sm" variant="secondary" className="h-9" onClick={() => add(custom)}>
          <Plus size={13} /> Añadir
        </Button>
      </div>

      <div className="flex items-start gap-2 text-[11px] text-subtle">
        <HelpCircle size={12} className="mt-0.5 shrink-0" />
        <p>
          El tráfico entra por Traefik (puertos 80/443).{' '}
          {tls ? (
            <>
              <CheckCircle2 size={11} className="inline text-ok" /> TLS automático activo: el certificado se emite solo
              en la primera visita cuando el DNS ya apunta aquí.
            </>
          ) : (
            <>
              Sin TLS todavía: configura el email de Let's Encrypt en{' '}
              <Link to="/settings" className="text-acc-soft hover:underline">
                Ajustes
              </Link>{' '}
              para que cada dominio tenga HTTPS automático.
            </>
          )}{' '}
          Los cambios de dominios se aplican al guardar y redesplegar (sin corte).
        </p>
      </div>
    </div>
  );
}
