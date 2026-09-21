import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, Globe, Plus, RefreshCw, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Me } from '../types';
import { cx, Tone } from '../utils';
import { Button, Chip, CopyButton, useToast } from './ui';

interface DomainCheck {
  domain: string;
  status: 'ok' | 'wrong_ip' | 'no_record' | 'unknown';
  resolvedIps: string[];
  expectedIp: string | null;
  message: string;
}

/** Lo que el servidor cuenta del dominio raíz y el TLS a cualquier usuario. */
interface DomainsConfig {
  rootDomain: string | null;
  tls: boolean;
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
  const ip = serverIp ?? 'IP-DEL-SERVIDOR';
  return (
    <div className="mt-2 rounded-lg border border-line bg-surface2 p-3 text-xs">
      <p className="mb-2 text-sub">
        En el panel DNS de <span className="font-mono text-txt">{zone}</span> (Cloudflare, IONOS, OVH, GoDaddy, etc.) cree
        el siguiente registro:
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
        La propagación suele tardar entre 5 minutos y varias horas. Pulse <RefreshCw size={10} className="inline" /> para
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
      {/*
        En móvil (~360 px) dominio, chip y tres botones no caben en una línea:
        el dominio se truncaba a nada. Se deja envolver: el dominio con su chip
        en la primera línea y las acciones pasan a la suya, a tamaño de dedo.
      */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Globe size={13} className="shrink-0 text-info" />
          <span className="min-w-0 truncate font-mono text-xs">{domain}</span>
          <Chip
            size="sm"
            tone={meta.tone}
            onClick={() => setExpanded(!expanded)}
            title={expanded ? 'Ocultar detalle del DNS' : 'Ver detalle del DNS'}
            icon={status === 'ok' ? <CheckCircle2 size={10} aria-hidden /> : undefined}
          >
            {check.isFetching ? 'Comprobando…' : meta.label}
          </Chip>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5 max-sm:gap-1">
          <button
            onClick={() => check.refetch()}
            className="press flex items-center justify-center rounded-md p-1 leading-none text-subtle transition-colors hover:bg-surface2 hover:text-txt max-sm:h-10 max-sm:w-10"
            title="Volver a comprobar el DNS"
            aria-label="Volver a comprobar el DNS"
          >
            <RefreshCw size={12} className={cx(check.isFetching && 'animate-spin')} />
          </button>
          <a
            href={`${tls ? 'https' : 'http'}://${domain}`}
            target="_blank"
            rel="noreferrer"
            className="press flex items-center justify-center rounded-md p-1 leading-none text-subtle transition-colors hover:bg-surface2 hover:text-txt max-sm:h-10 max-sm:w-10"
            title="Abrir"
            aria-label={`Abrir ${domain} en una pestaña nueva`}
          >
            <ExternalLink size={12} />
          </a>
          <button
            onClick={onRemove}
            className="press flex items-center justify-center rounded-md p-1 leading-none text-subtle transition-colors hover:bg-err/10 hover:text-err max-sm:h-10 max-sm:w-10"
            title="Eliminar"
            aria-label={`Eliminar ${domain}`}
          >
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
 * Editor de dominios: subdominio generado en un clic o dominio propio con
 * instrucciones DNS y verificación en vivo.
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

  /*
   * `GET /settings` es solo del admin. Un propietario que lo consultaba recibía
   * 403, el editor creía que no había dominio raíz y le pintaba el formulario
   * de «configúralo», que a su vez le contestaba 403 al guardar. La config que
   * necesita el editor (dominio raíz y si hay TLS) la sirve /domains/config a
   * cualquiera con sesión; el formulario solo lo ve quien puede rellenarlo.
   */
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), staleTime: 60_000 });
  const isAdmin = me.data?.user?.role === 'admin';
  const config = useQuery({
    queryKey: ['domainsConfig'],
    queryFn: () => api.get<DomainsConfig>('/domains/config'),
    staleTime: 60_000,
  });
  const serverIp = useQuery({
    queryKey: ['serverIp'],
    queryFn: () => api.get<{ ip: string | null; source: string | null }>('/domains/server-ip'),
    staleTime: 300_000,
  });

  const saveRootDomain = useMutation({
    mutationFn: () => api.put('/settings', { rootDomain: newRootDomain.trim().toLowerCase() }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domainsConfig'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast('Dominio raíz guardado', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const rootDomain = config.data?.rootDomain || null;
  const tls = !!config.data?.tls;
  const ip = serverIp.data?.ip ?? null;
  const generated = rootDomain ? `${slug}.${rootDomain}` : null;

  const add = (raw: string) => {
    const domain = raw.trim().toLowerCase();
    if (!domain) return;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      toast(`«${domain}» no es un dominio válido`, 'err');
      return;
    }
    if (domains.includes(domain)) {
      toast('Este dominio ya está añadido', 'err');
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

      {/* Subdominio automático. Hasta que llega la config no se pinta: si no,
          durante la carga asomaba el formulario de «configura tu dominio raíz»
          aunque ya estuviera configurado. */}
      {config.data && (
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
              <p className="mt-2 text-xs text-subtle">
                Requiere un registro A comodín <span className="font-mono">*.{rootDomain}</span> apuntando a la IP del
                servidor.
              </p>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 text-xs font-medium text-acc-soft">
                <Globe size={13} /> Subdominio automático
              </div>
              {isAdmin ? (
                <div className="mt-2 flex flex-col gap-2 text-xs text-sub">
                  <p>
                    Configure una sola vez el <strong className="text-txt">dominio raíz</strong> (por ejemplo,{' '}
                    <span className="font-mono">apps.midominio.com</span>) y cada servicio podrá tener su subdominio con
                    un clic.
                  </p>
                  <div className="flex gap-2">
                    <input
                      className="input min-w-0 flex-1 font-mono sm:text-xs"
                      placeholder="apps.midominio.com"
                      value={newRootDomain}
                      onChange={(e) => setNewRootDomain(e.target.value)}
                      inputMode="url"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
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
              ) : (
                /* Un propietario no puede tocar los ajustes del servidor: se le
                   dice quién sí y se le señala el dominio propio, que sí es suyo. */
                <p className="mt-2 text-xs text-sub">
                  El administrador del servidor aún no ha configurado un dominio raíz. Mientras tanto es posible añadir
                  un dominio propio en el campo inferior.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* Dominio propio */}
      <div className="flex gap-2">
        <input
          className="input min-w-0 flex-1 font-mono sm:text-xs"
          placeholder="app.clienteacme.com"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
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

      {/* El estado del TLS es un dato, no un párrafo: un chip se lee de un
          vistazo y el texto se queda con lo único que hay que saber. */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-subtle">
        {tls ? (
          <Chip size="sm" tone="ok" dot>
            TLS automático
          </Chip>
        ) : (
          <Chip size="sm" tone="warn" dot>
            Sin TLS —{' '}
            {isAdmin ? (
              <Link to="/settings" className="text-acc-soft hover:underline">
                Ajustes → Let's Encrypt
              </Link>
            ) : (
              'el administrador debe activar Let\'s Encrypt'
            )}
          </Chip>
        )}
        <span>Los dominios se aplican al guardar y volver a desplegar.</span>
      </div>
    </div>
  );
}
