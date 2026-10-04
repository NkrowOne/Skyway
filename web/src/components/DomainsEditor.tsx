import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Cloud, ExternalLink, Globe, Plus, RefreshCw, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { dominioUnicode, nombreEnZona, normalizarDominio } from '../dominios';
import { CloudflareConfigView, DnsAutoResult, DomainCheck, Me, PlanReemplazoDns } from '../types';
import { cx, Tone } from '../utils';
import { DnsAutoChip } from './DnsAutoResult';
import { Button, Chip, CopyButton, ErrorState, Modal, Skeleton, useToast } from './ui';

/** Lo que el servidor cuenta del dominio raíz y el TLS a cualquier usuario. */
interface DomainsConfig {
  rootDomain: string | null;
  tls: boolean;
  /** Let's Encrypt activado en el panel, pero Traefik sin un correo válido: no hay certificados. */
  tlsBlocked?: boolean;
}

const STATUS_META: Record<DomainCheck['status'], { label: string; tone: Tone }> = {
  ok: { label: 'DNS correcto', tone: 'ok' },
  no_record: { label: 'Esperando DNS', tone: 'warn' },
  wrong_ip: { label: 'Apunta a otra IP', tone: 'err' },
  caa: { label: 'Certificado bloqueado (CAA)', tone: 'err' },
  unknown: { label: 'Sin verificar', tone: 'neutral' },
};

const TONE_PILL: Record<Tone, string> = {
  ok: 'bg-ok/[.14] text-ok',
  warn: 'bg-warn/[.13] text-warn',
  err: 'bg-err/[.14] text-err',
  info: 'bg-info/[.13] text-info',
  neutral: 'bg-surface2 text-sub',
};

/**
 * Reserva mientras la comprobación no ha dicho la zona: las dos últimas
 * etiquetas. Falla con los sufijos de varios niveles (.com.es, .co.uk), por
 * eso el nombre y la zona buenos los calcula el servidor con la lista de
 * sufijos públicos y esto solo se usa mientras carga.
 */
function splitDnsName(domain: string): { name: string; zone: string } {
  const parts = domain.split('.');
  if (parts.length <= 2) return { name: '@', zone: domain };
  return { name: parts.slice(0, -2).join('.'), zone: parts.slice(-2).join('.') };
}

function DnsInstructions({ domain, serverIp, check }: { domain: string; serverIp: string | null; check: DomainCheck | undefined }) {
  const aprox = splitDnsName(domain);
  const zone = check?.zone ?? aprox.zone;
  const name = check?.zone ? (check.name ?? '@') : aprox.name;
  const ip = serverIp ?? 'IP-DEL-SERVIDOR';
  // Con un CAA que no autoriza a Let's Encrypt, lo que falta es otro registro,
  // con el nombre relativo a la zona como el A. Si el CAA está fuera de ella
  // (lo publica un nivel superior), el panel es el de ese nombre.
  const caa = check?.status === 'caa' ? check.caa : null;
  const caaEnZona = caa ? nombreEnZona(caa.name, zone) : null;
  const zonaPanel = caa && caaEnZona === null ? caa.name : zone;
  const filas = caa
    ? [{ type: 'CAA', name: caaEnZona ?? '@', value: '0 issue "letsencrypt.org"', copy: '0 issue "letsencrypt.org"' }]
    : [{ type: 'A', name, value: ip, copy: serverIp }];
  return (
    <div className="mt-2 rounded-lg border border-line bg-surface2 p-3 text-xs">
      <p className="mb-2 text-sub">
        En el panel DNS de <span className="font-mono text-txt">{dominioUnicode(zonaPanel)}</span> (Cloudflare, IONOS, OVH, GoDaddy, etc.){' '}
        {caa ? 'añade el siguiente registro y conserva los que ya hay:' : 'crea el siguiente registro:'}
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
            {filas.map((f) => (
              <tr key={f.type}>
                <td className="pr-4">{f.type}</td>
                <td className="pr-4">{f.name}</td>
                <td>
                  <span className="inline-flex items-center gap-1">
                    {f.value}
                    {f.copy && <CopyButton value={f.copy} />}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!caa && (
        <p className="mt-2 text-subtle">
          Si ese nombre ya tiene un registro A, AAAA o CNAME (por ejemplo, del hosting anterior), cámbialo o elimínalo: con dos
          registros, parte de los visitantes seguiría llegando al sitio anterior.
        </p>
      )}
      <p className="mt-2 text-subtle">
        La propagación suele tardar entre 5 minutos y varias horas. Pulsa <RefreshCw size={10} className="inline" /> para
        volver a comprobar.
      </p>
    </div>
  );
}

/**
 * Revisión y confirmación del reemplazo en Cloudflare del registro del hosting
 * anterior (solo administrador). Enseña los registros exactos que se
 * sustituyen; el servidor solo los cambia si siguen siendo esos.
 */
function ReemplazoDialog({
  serviceId,
  domain,
  onClose,
  onDone,
}: {
  serviceId: string;
  domain: string;
  onClose: () => void;
  onDone: (result: DnsAutoResult) => void;
}) {
  const toast = useToast();
  const [confirmado, setConfirmado] = useState(false);
  const plan = useQuery({
    queryKey: ['dnsReemplazo', serviceId, domain],
    queryFn: () =>
      api.get<{ plan: PlanReemplazoDns }>(`/services/${serviceId}/cloudflare-dns/replace?domain=${encodeURIComponent(domain)}`),
    // Compara con la zona en vivo: cada apertura lo recalcula.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const reemplazar = useMutation({
    mutationFn: (p: PlanReemplazoDns) =>
      api.post<{ dns: DnsAutoResult[] }>(`/services/${serviceId}/cloudflare-dns/replace`, {
        domain,
        records: p.actuales.map((r) => ({ id: r.id, type: r.type, content: r.content })),
      }),
    onSuccess: (res) => {
      const r = res.dns[0];
      if (r) {
        onDone(r);
        toast(`${domain}: ${r.message}`, 'ok');
      }
      onClose();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const p = plan.data?.plan;
  return (
    <Modal open onClose={onClose} title={`Reemplazar en Cloudflare · ${dominioUnicode(domain)}`}>
      {plan.isLoading ? (
        <div className="flex flex-col gap-2" aria-busy>
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
      ) : plan.isError || !p ? (
        <ErrorState compact title="No se ha podido consultar Cloudflare" error={plan.error} onRetry={() => plan.refetch()} retrying={plan.isFetching} />
      ) : p.motivo ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-sub">{p.motivo}</p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Cerrar</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-sub">
            Se sustituirán estos registros de <span className="font-mono text-txt">{domain}</span> en la zona{' '}
            <span className="font-mono text-txt">{p.zone}</span>:
          </p>
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line text-xs">
            {p.actuales.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2">
                <span className="w-12 shrink-0 font-mono font-semibold text-txt">{r.type}</span>
                <span className="min-w-0 flex-1 break-all font-mono text-sub">{r.content}</span>
                {r.proxied && (
                  <Chip size="sm" tone="warn">
                    Con proxy
                  </Chip>
                )}
                <span className="text-subtle">TTL {r.ttl === 1 ? 'automático' : `${r.ttl} s`}</span>
              </li>
            ))}
          </ul>
          <p className="text-sub">
            {p.conservaA ? (
              <>
                Se conserva el registro A hacia <span className="font-mono text-txt">{p.ip}</span>, que ya apunta a este servidor.
              </>
            ) : (
              <>
                En su lugar se creará un registro A hacia <span className="font-mono text-txt">{p.ip}</span>, sin proxy.
              </>
            )}{' '}
            El cambio se hace en una sola operación y Skyway guarda una copia de lo que sustituye: puedes restaurarlo en Ajustes →
            Cloudflare.
          </p>
          {p.avisos.length > 0 && (
            <ul className="flex flex-col gap-1 rounded-lg border border-warn/30 bg-warn/[.07] px-3 py-2 text-xs text-sub">
              {p.avisos.map((a) => (
                <li key={a} className="flex items-start gap-1.5">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn" />
                  <span>{a}</span>
                </li>
              ))}
            </ul>
          )}
          <label className="flex items-start gap-2 text-xs text-sub">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 accent-acc"
              checked={confirmado}
              onChange={(e) => setConfirmado(e.target.checked)}
            />
            <span>
              Confirmo que <span className="font-mono text-txt">{domain}</span> debe servirlo este servidor: el sitio anterior dejará de
              recibir sus visitas en cuanto se propague el cambio.
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={() => reemplazar.mutate(p)} loading={reemplazar.isPending} disabled={!confirmado}>
              Reemplazar
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function BotonReemplazo({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} title="Revisar los registros actuales y sustituirlos por el de este servidor">
      <Cloud size={12} /> Reemplazar en Cloudflare
    </Button>
  );
}

function DomainRow({
  domain,
  serverIp,
  tls,
  dns,
  onRemove,
  onRetryDns,
  retryingDns,
  onCreateDns,
  onReplaceDns,
}: {
  domain: string;
  serverIp: string | null;
  tls: boolean;
  /** Resultado del DNS automático en Cloudflare del último guardado (solo administrador). */
  dns?: DnsAutoResult;
  onRemove: () => void;
  /** Repite el DNS automático de este dominio (solo administrador, tras un resultado que no es correcto). */
  onRetryDns?: () => void;
  retryingDns?: boolean;
  /**
   * Crea el registro en Cloudflare de un dominio guardado que aún no tiene
   * ninguno (solo administrador con Cloudflare configurado): por ejemplo, uno
   * añadido antes de guardar el token.
   */
  onCreateDns?: () => void;
  /**
   * Abre la revisión del reemplazo en Cloudflare (solo administrador con
   * Cloudflare configurado y el dominio ya guardado): tras un conflicto o,
   * sin resultado del último guardado, si el dominio apunta a otra IP.
   */
  onReplaceDns?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const unicode = dominioUnicode(domain);
  const check = useQuery({
    queryKey: ['domainCheck', domain],
    queryFn: () => api.post<{ check: DomainCheck }>('/domains/check', { domain }),
    staleTime: 30_000,
    retry: false,
  });

  const status = check.data?.check.status ?? 'unknown';
  const meta = STATUS_META[status];
  // El resultado del DNS automático solo existe tras guardar en esta misma
  // sesión. Un dominio añadido otro día o con el asistente de alta, que
  // apunta todavía al hosting anterior, también tiene que poder trasladarse:
  // lo dice la comprobación del DNS. La revisión explica si no hay nada que
  // reemplazar (un proxy delante, una zona que el token no ve).
  const reemplazo = (dns ? dns.action === 'conflict' : status === 'wrong_ip' && !check.isFetching) ? onReplaceDns : undefined;

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
          <span className="min-w-0 truncate font-mono text-xs" title={unicode !== domain ? domain : undefined}>
            {unicode}
          </span>
          {unicode !== domain && <span className="hidden min-w-0 truncate font-mono text-[11px] text-subtle sm:inline">{domain}</span>}
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
          {reemplazo && <BotonReemplazo onClick={reemplazo} />}
        </p>
      )}
      {!dns && reemplazo && (
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-sub">
          <span className="min-w-0 break-words">Si el registro actual está en tu Cloudflare, puedes revisarlo y sustituirlo desde aquí.</span>
          <BotonReemplazo onClick={reemplazo} />
        </p>
      )}
      {!dns && onCreateDns && status === 'no_record' && !check.isFetching && (
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-sub">
          <span className="min-w-0 break-words">Si el dominio está en tu Cloudflare, Skyway puede crear el registro.</span>
          <Button variant="ghost" size="sm" onClick={onCreateDns} loading={retryingDns} title="Crear el registro A en Cloudflare">
            <Cloud size={12} /> Crear en Cloudflare
          </Button>
        </p>
      )}
      {(expanded || status === 'no_record' || status === 'wrong_ip' || status === 'caa') && (
        <div className="mt-1.5">
          {check.data && <p className="text-xs text-sub">{check.data.check.message}</p>}
          {status !== 'ok' && <DnsInstructions domain={domain} serverIp={serverIp} check={check.data?.check} />}
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
  serviceId,
  onDnsResult,
  savedDomains,
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
  /** Servicio ya creado: permite reemplazar en Cloudflare el registro de un dominio guardado. */
  serviceId?: string;
  /** Nuevo resultado del DNS automático de un dominio (tras un reemplazo). */
  onDnsResult?: (result: DnsAutoResult) => void;
  /** Dominios ya guardados en el servicio: solo esos se pueden reemplazar. */
  savedDomains?: string[];
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [custom, setCustom] = useState('');
  const [newRootDomain, setNewRootDomain] = useState('');
  const [reemplazar, setReemplazar] = useState<string | null>(null);

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

  // Reemplazar en Cloudflare: solo el administrador y con el token guardado
  // (sin él, la revisión respondería que falta configurarlo).
  const cloudflareListo = isAdmin && !!cloudflare.data?.configured;
  const rootDomain = config.data?.rootDomain || null;
  const tls = !!config.data?.tls;
  const ip = serverIp.data?.ip ?? null;
  const generated = rootDomain ? `${slug}.${rootDomain}` : null;

  // Como el servidor: sin esquema ni ruta (se pega la URL de la web) y en
  // ASCII («panadería.es» se guarda como xn--panadera-i2a.es).
  const add = (raw: string) => {
    if (!raw.trim()) return;
    const domain = normalizarDominio(raw);
    if (!domain) {
      toast(`«${raw.trim()}» no es un dominio válido: escribe solo el nombre, por ejemplo app.midominio.com.`, 'err');
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
            <DomainRow
              key={d}
              domain={d}
              serverIp={ip}
              tls={tls}
              dns={dnsResults?.[d]}
              onRemove={() => onChange(domains.filter((x) => x !== d))}
              onRetryDns={onRetryDns ? () => onRetryDns(d) : undefined}
              retryingDns={retryingDns === d}
              onCreateDns={cloudflareListo && onRetryDns && savedDomains?.includes(d) ? () => onRetryDns(d) : undefined}
              onReplaceDns={
                cloudflareListo && serviceId && onDnsResult && savedDomains?.includes(d) ? () => setReemplazar(d) : undefined
              }
            />
          ))}
        </div>
      )}
      {reemplazar && serviceId && onDnsResult && (
        <ReemplazoDialog
          serviceId={serviceId}
          domain={reemplazar}
          onClose={() => setReemplazar(null)}
          onDone={(r) => {
            onDnsResult(r);
            queryClient.invalidateQueries({ queryKey: ['domainCheck', r.domain] });
          }}
        />
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
        ) : config.data?.tlsBlocked ? (
          // Activado en el panel, pero Traefik tiene un correo que Let's Encrypt
          // rechaza: se sirve por HTTP en vez de redirigir a un HTTPS sin
          // certificado válido.
          <Chip size="sm" tone="err" dot>
            TLS bloqueado —{' '}
            {isAdmin ? (
              <Link to="/settings" className="text-acc-soft hover:underline">
                el correo de Let's Encrypt del servidor no es válido
              </Link>
            ) : (
              'el administrador debe corregir el correo de Let\'s Encrypt del servidor'
            )}
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
            (sin proxy). Si ya existe un registro con ese nombre no se modifica: se indica como conflicto y puedes revisarlo y
            reemplazarlo con «Reemplazar en Cloudflare».
          </span>
        </p>
      )}
    </div>
  );
}
