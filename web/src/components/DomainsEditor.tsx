import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Cloud, ExternalLink, Globe, Plus, RefreshCw, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { intervaloComprobacion, ordenarDominios, parejasWwwPendientes } from '../dominios';
import { CloudflareConfigView, DnsAutoResult, DomainCheck, DomainsConfig, Me } from '../types';
import { cx, Tone } from '../utils';
import { DnsAutoChip } from './DnsAutoResult';
import { Button, Chip, CopyButton, useToast } from './ui';

const STATUS_META: Record<DomainCheck['status'], { label: string; tone: Tone }> = {
  ok: { label: 'DNS correcto', tone: 'ok' },
  no_record: { label: 'Esperando DNS', tone: 'warn' },
  wrong_ip: { label: 'Apunta a otra IP', tone: 'err' },
  // Aviso y no error: el proxy puede estar entregando el tráfico aquí, pero
  // no se puede comprobar desde fuera.
  cloudflare_proxy: { label: 'Proxy de Cloudflare', tone: 'warn' },
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
        En el panel DNS de <span className="font-mono text-txt">{zone}</span> (Cloudflare, IONOS, OVH, GoDaddy, etc.) crea
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
        La propagación suele tardar entre 5 minutos y varias horas. La comprobación se repite automáticamente; pulsa{' '}
        <RefreshCw size={10} className="inline" /> para comprobarlo ahora.
      </p>
    </div>
  );
}

/** Explicación del chip «Principal» (al pasar el ratón). */
const AYUDA_PRINCIPAL = 'Dirección principal: se usa como dirección pública de la web';

function DomainRow({
  domain,
  principal,
  enComprobacion,
  serverIp,
  tls,
  dns,
  onRemove,
  onRetryDns,
  retryingDns,
}: {
  domain: string;
  /** Es el dominio principal: el de PUBLIC_URL. */
  principal: boolean;
  /** Cuántos dominios se comprueban a la vez en el editor, para repartir el cupo de comprobaciones. */
  enComprobacion: number;
  serverIp: string | null;
  tls: boolean;
  /** Resultado del DNS automático en Cloudflare del último guardado (solo administrador). */
  dns?: DnsAutoResult;
  onRemove: () => void;
  /** Repite el DNS automático de este dominio (solo administrador, tras un resultado que no es correcto). */
  onRetryDns?: () => void;
  retryingDns?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // Desde cuándo se comprueba este dominio: la repetición automática se
  // espacia a los 2 minutos y se detiene a los 30.
  const [inicio] = useState(() => Date.now());
  const check = useQuery({
    queryKey: ['domainCheck', domain],
    queryFn: () => api.post<{ check: DomainCheck }>('/domains/check', { domain }),
    staleTime: 30_000,
    retry: false,
    // Tras crear el registro en el proveedor de DNS, el estado se actualiza
    // sin pulsar nada mientras no sea correcto. Con la pestaña oculta no se
    // repite (`refetchIntervalInBackground` es false por defecto).
    refetchInterval: (query) => intervaloComprobacion(query.state.data?.check.status, Date.now() - inicio, enComprobacion),
  });

  const status = check.data?.check.status ?? 'unknown';
  const meta = STATUS_META[status];

  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2">
      {/*
        En móvil (~360 px) dominio, chips y tres botones no caben en una línea:
        el dominio se truncaba a nada. Se deja envolver: el dominio en la
        primera línea y el estado con las acciones, a tamaño de dedo, debajo.
      */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* En móvil, el dominio (con «Principal») ocupa su línea y el estado
            del DNS baja a la de las acciones. Antes, con `flex-1 min-w-0`, el
            bloque se encogía hasta dejar el dominio en «c…» en vez de pasar
            las acciones abajo. */}
        <span className="flex min-w-0 items-center gap-2 max-sm:basis-full">
          <Globe size={13} className="shrink-0 text-info" />
          <span className="min-w-0 truncate font-mono text-xs">{domain}</span>
          {principal && (
            <Chip size="sm" tone="info" title={AYUDA_PRINCIPAL}>
              Principal
            </Chip>
          )}
        </span>
        <Chip
          size="sm"
          tone={meta.tone}
          onClick={() => setExpanded(!expanded)}
          title={expanded ? 'Ocultar detalle del DNS' : 'Ver detalle del DNS'}
          icon={status === 'ok' ? <CheckCircle2 size={10} aria-hidden /> : undefined}
        >
          {/* Solo la primera vez: con la repetición automática, el chip
              parpadearía cada 15 s; el botón de comprobar ya gira. */}
          {check.isPending ? 'Comprobando…' : meta.label}
        </Chip>
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
      {/* En su propia línea y con salto: junto al dominio no cabe en móvil. */}
      {dns && (
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-sub">
          <DnsAutoChip result={dns} />
          <span className="min-w-0 break-words">{dns.message}</span>
          {onRetryDns && dns.action !== 'created' && dns.action !== 'kept' && (
            <Button variant="ghost" size="sm" onClick={onRetryDns} loading={retryingDns} title="Volver a intentar el registro en Cloudflare">
              <Cloud size={12} /> Reintentar en Cloudflare
            </Button>
          )}
        </p>
      )}
      {(expanded || status === 'no_record' || status === 'wrong_ip' || status === 'cloudflare_proxy') && (
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
  dnsResults,
  onRetryDns,
  retryingDns,
}: {
  domains: string[];
  onChange: (domains: string[]) => void;
  slug: string;
  /** Resultado del DNS automático por dominio, tras guardar (solo lo recibe un administrador). */
  dnsResults?: Record<string, DnsAutoResult>;
  /** Repite el DNS automático de un dominio ya guardado (solo administrador). */
  onRetryDns?: (domain: string) => void;
  /** Dominio cuyo reintento está en curso. */
  retryingDns?: string | null;
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
  // Solo el administrador lo consulta (la ruta es suya): si tiene token, el
  // DNS de los dominios nuevos se configura solo al guardar.
  const cloudflare = useQuery({
    queryKey: ['cloudflareConfig'],
    queryFn: () => api.get<CloudflareConfigView>('/cloudflare/config'),
    enabled: isAdmin,
    staleTime: 60_000,
    retry: false,
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

  /*
   * Mismo orden que guarda el servidor y con el que calcula PUBLIC_URL: un
   * dominio con www primero, el subdominio generado al final. Un servicio
   * guardado con el orden antiguo se ve ya como quedará al guardar.
   */
  const ordenados = ordenarDominios(domains, rootDomain);
  const parejas = parejasWwwPendientes(ordenados, rootDomain);

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
    onChange(ordenarDominios([...domains, domain], rootDomain));
    setCustom('');
  };

  return (
    <div className="flex flex-col gap-2.5">
      {ordenados.length > 0 && (
        <div className="flex flex-col gap-2">
          {ordenados.map((d, i) => (
            <DomainRow
              key={d}
              domain={d}
              // Con un solo dominio no hay nada que distinguir.
              principal={i === 0 && ordenados.length > 1}
              enComprobacion={ordenados.length}
              serverIp={ip}
              tls={tls}
              dns={dnsResults?.[d]}
              onRemove={() => onChange(ordenarDominios(domains.filter((x) => x !== d), rootDomain))}
              onRetryDns={onRetryDns ? () => onRetryDns(d) : undefined}
              retryingDns={retryingDns === d}
            />
          ))}
        </div>
      )}

      {/* La web debe responder con y sin www: cada dominio propio al que le
          falta su pareja lo indica y la añade con un clic. */}
      {parejas.map((p) => (
        <div
          key={p.falta}
          role="status"
          className="flex flex-col items-start gap-2 rounded-lg border border-warn/30 bg-warn/[.06] px-3 py-2.5 text-xs text-warn"
        >
          <span className="flex min-w-0 items-start gap-1.5">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">
              {p.tipo === 'www' ? (
                <>
                  Añade también <span className="font-mono">{p.falta}</span> para que la web funcione con y sin www. La
                  dirección con www será la principal.
                </>
              ) : (
                <>
                  Añade también <span className="font-mono">{p.falta}</span> para que la web funcione también sin www.
                </>
              )}
            </span>
          </span>
          <Button
            size="sm"
            variant="secondary"
            className="ml-[18px] max-w-full max-sm:ml-0 max-sm:w-full"
            title={`Añadir ${p.falta}`}
            onClick={() => add(p.falta)}
          >
            <Plus size={12} className="shrink-0" /> <span className="min-w-0 truncate">Añadir {p.falta}</span>
          </Button>
        </div>
      ))}

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
                    Configura una sola vez el <strong className="text-txt">dominio raíz</strong> (por ejemplo,{' '}
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
      {isAdmin && cloudflare.data?.configured && (
        <p className="flex items-start gap-1.5 text-xs text-subtle">
          <Cloud size={12} className="mt-0.5 shrink-0 text-warn" />
          <span>
            DNS automático: al guardar, los dominios nuevos que estén en tu Cloudflare reciben su registro A hacia este servidor
            (sin proxy). Si ya existe un registro con ese nombre no se modifica: se indica como conflicto.
          </span>
        </p>
      )}
    </div>
  );
}
