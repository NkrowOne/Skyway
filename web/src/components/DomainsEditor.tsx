import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, Globe, HelpCircle, Plus, RefreshCw, Sparkles, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { cx } from '../utils';
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

const STATUS_META: Record<DomainCheck['status'], { label: string; cls: string }> = {
  ok: { label: 'DNS correcto', cls: 'text-ok border-ok/40 bg-ok/10' },
  no_record: { label: 'Esperando DNS', cls: 'text-warn border-warn/40 bg-warn/10' },
  wrong_ip: { label: 'Apunta a otra IP', cls: 'text-err border-err/40 bg-err/10' },
  unknown: { label: 'Sin verificar', cls: 'text-sub border-line bg-panel2' },
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
    <div className="mt-2 rounded-lg border border-line bg-panel2 p-3 text-xs">
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
      <p className="mt-2 text-sub/80">
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
    <div className="rounded-lg border border-line bg-panel2 px-3 py-2">
      <div className="flex items-center gap-2">
        <Globe size={13} className="shrink-0 text-acc2" />
        <span className="min-w-0 truncate font-mono text-xs">{domain}</span>
        <button
          onClick={() => setExpanded(!expanded)}
          className={cx('shrink-0 rounded-full border px-2 py-0.5 text-[10px]', meta.cls)}
          title="Ver detalle"
        >
          {check.isFetching ? 'Comprobando...' : meta.label}
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            onClick={() => check.refetch()}
            className="rounded-md p-1 text-sub hover:bg-panel hover:text-txt"
            title="Volver a comprobar el DNS"
          >
            <RefreshCw size={12} className={cx(check.isFetching && 'animate-spin')} />
          </button>
          <a
            href={`${tls ? 'https' : 'http'}://${domain}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-md p-1 text-sub hover:bg-panel hover:text-txt"
            title="Abrir"
          >
            <ExternalLink size={12} />
          </a>
          <button onClick={onRemove} className="rounded-md p-1 text-sub hover:bg-panel hover:text-err" title="Quitar">
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
    <div className="space-y-3">
      {domains.length > 0 && (
        <div className="space-y-2">
          {domains.map((d) => (
            <DomainRow key={d} domain={d} serverIp={ip} tls={tls} onRemove={() => onChange(domains.filter((x) => x !== d))} />
          ))}
        </div>
      )}

      {/* Subdominio automático */}
      <div className="rounded-lg border border-acc/30 bg-acc/5 p-3">
        <div className="flex items-center gap-2 text-xs font-medium text-acc">
          <Sparkles size={13} /> Subdominio automático
        </div>
        {rootDomain ? (
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="font-mono text-xs text-txt">{generated}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={!generated || domains.includes(generated)}
              onClick={() => generated && add(generated)}
            >
              <Plus size={12} /> {domains.includes(generated!) ? 'Añadido' : 'Añadir'}
            </Button>
          </div>
        ) : (
          <div className="mt-2 space-y-2 text-xs text-sub">
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
              <Button size="sm" variant="outline" disabled={!newRootDomain.trim()} loading={saveRootDomain.isPending} onClick={() => saveRootDomain.mutate()}>
                Guardar
              </Button>
            </div>
          </div>
        )}
        {rootDomain && (
          <p className="mt-2 text-[11px] text-sub/80">
            Requisito único: un registro <span className="font-mono">A</span> comodín{' '}
            <span className="font-mono">*.{rootDomain}</span> → <span className="font-mono">{ip ?? 'IP del servidor'}</span>{' '}
            en tu DNS. Hecho eso, cada subdominio generado funciona al instante sin tocar nada más.
          </p>
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
        <Button size="sm" variant="outline" onClick={() => add(custom)}>
          <Plus size={13} /> Añadir dominio propio
        </Button>
      </div>

      <div className="flex items-start gap-2 text-[11px] text-sub/80">
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
              <Link to="/settings" className="text-acc hover:underline">
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
