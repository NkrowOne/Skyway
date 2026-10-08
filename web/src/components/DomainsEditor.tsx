import { Fragment, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Cloud, ExternalLink, Plus, RefreshCw, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { intervaloComprobacion, limpiarSinPareja, ordenarDominios, parejasWwwPendientes, parejaWww, ParejaWww } from '../dominios';
import { CloudflareConfigView, DnsAutoResult, DomainCheck, DomainsConfig, Me } from '../types';
import { cx, Tone } from '../utils';
import { DnsAutoChip } from './DnsAutoResult';
import { Button, Chip, ConfirmModal, CopyButton, useToast } from './ui';

/*
 * El estado es un punto de color y una etiqueta corta, como en los paneles de
 * Vercel o Render: la superficie de la fila es siempre neutra y el color solo
 * dice cómo está el DNS. Las cajas teñidas con párrafos largos se leían como
 * alarmas aunque solo faltara esperar a la propagación.
 */
const STATUS_META: Record<DomainCheck['status'], { label: string; tone: Tone }> = {
  ok: { label: 'Configurado', tone: 'ok' },
  no_record: { label: 'Esperando DNS', tone: 'warn' },
  wrong_ip: { label: 'Apunta a otra IP', tone: 'err' },
  // Aviso y no error: el proxy puede estar entregando el tráfico aquí, pero
  // no se puede comprobar desde fuera.
  cloudflare_proxy: { label: 'Proxy de Cloudflare', tone: 'warn' },
  unknown: { label: 'Sin verificar', tone: 'neutral' },
};

const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  err: 'bg-err',
  info: 'bg-acc-soft',
  neutral: 'bg-subtle',
};

/** Estados en los que hace falta tocar el DNS: su detalle se abre solo. */
const PENDIENTES: ReadonlySet<DomainCheck['status']> = new Set(['no_record', 'wrong_ip', 'cloudflare_proxy']);

/** Divide un dominio en (nombre a crear, zona) de forma aproximada. */
function splitDnsName(domain: string): { name: string; zone: string } {
  const parts = domain.split('.');
  if (parts.length <= 2) return { name: '@', zone: domain };
  return { name: parts.slice(0, -2).join('.'), zone: parts.slice(-2).join('.') };
}

/** El registro A que hay que crear, como lo muestran los proveedores: tipo, nombre y valor. */
function TablaRegistro({ domain, serverIp }: { domain: string; serverIp: string | null }) {
  const { name } = splitDnsName(domain);
  const celda = 'px-3 py-1.5 align-middle';
  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="w-full text-left text-xs">
        <thead className="text-subtle">
          <tr className="border-b border-line">
            <th className={cx(celda, 'w-16 font-medium')}>Tipo</th>
            <th className={cx(celda, 'font-medium')}>Nombre</th>
            <th className={cx(celda, 'font-medium')}>Valor</th>
          </tr>
        </thead>
        <tbody className="font-mono text-txt">
          <tr>
            <td className={celda}>A</td>
            <td className={cx(celda, 'py-0.5')}>
              <span className="inline-flex items-center gap-0.5">
                {name}
                <CopyButton value={name} title="Copiar nombre" />
              </span>
            </td>
            <td className={cx(celda, 'py-0.5')}>
              {serverIp ? (
                <span className="inline-flex items-center gap-0.5">
                  {serverIp}
                  <CopyButton value={serverIp} title="Copiar valor" />
                </span>
              ) : (
                <span className="font-sans text-subtle">IP del servidor</span>
              )}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * Qué hacer con el DNS, en una frase y el registro. Lo que repetía la etiqueta
 * («aún no existe registro…») o la propagación en cada fila ya no aparece: la
 * propagación se explica una vez, debajo de la lista.
 */
function DetalleDns({
  domain,
  check,
  error,
  serverIp,
  onDisableProxy,
  disablingProxy,
  enCloudflare,
}: {
  domain: string;
  check: DomainCheck | undefined;
  error: Error | null;
  serverIp: string | null;
  /** Quita el proxy en el Cloudflare del administrador (solo si el dominio está guardado y su zona en esa cuenta). */
  onDisableProxy?: () => void;
  disablingProxy?: boolean;
  /** El DNS automático acaba de crear (o ya tenía) el registro A en Cloudflare. */
  enCloudflare?: boolean;
}) {
  const { zone } = splitDnsName(domain);
  const zona = <span className="font-mono text-txt">{zone}</span>;
  if (!check) return error ? <p className="text-xs text-err">{error.message}</p> : null;
  switch (check.status) {
    case 'ok':
      return <p className="text-xs text-sub">{check.message}</p>;
    case 'no_record':
      // Con el registro ya en Cloudflare, la tabla pediría crear lo que existe.
      if (enCloudflare) return <p className="text-xs text-sub">El registro ya está en Cloudflare; puede tardar unos minutos en propagarse.</p>;
      return (
        <>
          <p className="text-xs text-sub">Añade este registro en el DNS de {zona}:</p>
          <TablaRegistro domain={domain} serverIp={serverIp} />
        </>
      );
    case 'wrong_ip':
      return (
        <>
          <p className="text-xs text-sub">
            {check.message} Corrige el registro en el DNS de {zona}:
          </p>
          <TablaRegistro domain={domain} serverIp={serverIp} />
        </>
      );
    case 'cloudflare_proxy':
      return (
        <>
          <p className="text-xs text-sub">{check.message}</p>
          {/* La única modificación de un registro existente, y solo con este clic:
              el guardado automático nunca toca lo que ya existe. */}
          {onDisableProxy && (
            <div>
              <Button size="sm" variant="secondary" onClick={onDisableProxy} loading={disablingProxy} className="max-sm:h-10">
                <Cloud size={12} /> Desactivar proxy en Cloudflare
              </Button>
            </div>
          )}
          <details className="group">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-subtle transition-colors hover:text-sub">
              <ChevronRight size={12} className="shrink-0 transition-transform group-open:rotate-90" aria-hidden />
              Más información
            </summary>
            <p className="details-body mt-1.5 text-xs text-subtle">
              {serverIp && (
                <>
                  El registro A debe apuntar a <span className="font-mono text-sub">{serverIp}</span>.{' '}
                </>
              )}
              Para mantener el proxy, el modo SSL/TLS de Cloudflare debe ser «Full» o «Full (strict)» y «Always Use HTTPS» no
              debe bloquear la ruta <span className="font-mono">/.well-known/acme-challenge</span>, que Let&apos;s Encrypt usa
              para emitir el certificado.
            </p>
          </details>
        </>
      );
    default:
      return (
        <>
          <p className="text-xs text-sub">{check.message}</p>
          {serverIp && <TablaRegistro domain={domain} serverIp={serverIp} />}
        </>
      );
  }
}

/**
 * El dominio con un punto de corte opcional tras cada punto: en móvil, un
 * nombre largo pasa de línea por una etiqueta («tienda.apps.skyway.» y
 * «example») y no por una letra suelta.
 */
function NombreDominio({ domain, className }: { domain: string; className?: string }) {
  const partes = domain.split('.');
  return (
    <span className={cx('min-w-0 break-words font-mono', className)}>
      {partes.map((p, i) => (
        <Fragment key={i}>
          {p}
          {i < partes.length - 1 && (
            <>
              .<wbr />
            </>
          )}
        </Fragment>
      ))}
    </span>
  );
}

/** Explicación de la insignia «Principal» (al pasar el ratón). */
const AYUDA_PRINCIPAL = 'Dirección principal: se usa como dirección pública de la web';

const ICON_BTN =
  'press flex items-center justify-center rounded-md p-1.5 leading-none text-subtle transition-colors hover:bg-surface2 hover:text-txt max-sm:h-10 max-sm:w-10';

function DomainRow({
  domain,
  principal,
  enComprobacion,
  serverIp,
  tls,
  dns,
  faltaPareja,
  onAddPareja,
  onRemove,
  onRetryDns,
  retryingDns,
  onDisableProxy,
  disablingProxy,
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
  /** La pareja con o sin www que le falta (descartada o de un servicio antiguo). */
  faltaPareja?: ParejaWww;
  onAddPareja: () => void;
  onRemove: () => void;
  /** Repite el DNS automático de este dominio (solo administrador, tras un resultado que no es correcto). */
  onRetryDns?: () => void;
  retryingDns?: boolean;
  /** «Desactivar proxy en Cloudflare» (solo administrador, dominio guardado y zona en su Cloudflare). */
  onDisableProxy?: () => void;
  disablingProxy?: boolean;
}) {
  // null: lo decide el estado (abierto si hay que tocar el DNS); un clic en el
  // estado lo fija en uno u otro sentido.
  const [abierto, setAbierto] = useState<boolean | null>(null);
  // Desde cuándo se comprueba este dominio: la repetición automática se
  // espacia a los 2 minutos y se detiene a los 30.
  const [inicio] = useState(() => Date.now());
  const check = useQuery({
    queryKey: ['domainCheck', domain],
    queryFn: () => comprobarDominio(domain),
    staleTime: 30_000,
    retry: false,
    // Tras crear el registro en el proveedor de DNS, el estado se actualiza
    // sin pulsar nada mientras no sea correcto. Con la pestaña oculta no se
    // repite (`refetchIntervalInBackground` es false por defecto).
    refetchInterval: (query) => intervaloComprobacion(query.state.data?.check.status, Date.now() - inicio, enComprobacion),
  });

  const status = check.data?.check.status ?? 'unknown';
  const meta = STATUS_META[status];
  const visible = abierto ?? PENDIENTES.has(status);
  const detalleId = `dns-${domain}`;

  return (
    <li className="px-3 py-2.5">
      {/*
        En móvil (~360 px) dominio, estado y tres botones no caben en una
        línea: el dominio ocupa la suya entera (y parte por cualquier carácter
        antes que truncarse a «c…») y el estado con las acciones, a tamaño de
        dedo, pasa debajo.
      */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex min-w-0 items-center gap-2 max-sm:basis-full">
          <NombreDominio domain={domain} className="text-sm text-txt" />
          {principal && (
            <Chip size="sm" title={AYUDA_PRINCIPAL}>
              Principal
            </Chip>
          )}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 max-sm:ml-0 max-sm:w-full">
          <button
            type="button"
            onClick={() => setAbierto(!visible)}
            aria-expanded={visible}
            aria-controls={detalleId}
            title={visible ? 'Ocultar detalle del DNS' : 'Ver detalle del DNS'}
            className="press mr-1 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-sub transition-colors hover:bg-surface2 hover:text-txt max-sm:-ml-1.5 max-sm:mr-auto max-sm:py-2"
          >
            <span
              aria-hidden
              className={cx('h-2 w-2 shrink-0 rounded-full', TONE_DOT[meta.tone], check.isPending && 'pulse-soft')}
            />
            {/* Solo la primera vez: con la repetición automática, la etiqueta
                parpadearía cada 15 s; el botón de comprobar ya gira. */}
            {check.isPending ? 'Comprobando…' : meta.label}
          </button>
          <button
            type="button"
            onClick={() => check.refetch()}
            className={ICON_BTN}
            title="Volver a comprobar el DNS"
            aria-label={`Volver a comprobar el DNS de ${domain}`}
          >
            <RefreshCw size={14} className={cx(check.isFetching && 'animate-spin')} />
          </button>
          <a
            href={`${tls ? 'https' : 'http'}://${domain}`}
            target="_blank"
            rel="noreferrer"
            className={ICON_BTN}
            title="Abrir"
            aria-label={`Abrir ${domain} en una pestaña nueva`}
          >
            <ExternalLink size={14} />
          </a>
          <button
            type="button"
            onClick={onRemove}
            className={cx(ICON_BTN, 'hover:bg-err/10 hover:text-err')}
            title="Eliminar"
            aria-label={`Eliminar ${domain}`}
          >
            <X size={14} />
          </button>
        </span>
      </div>
      {faltaPareja && (
        /* Una línea, no una fila sugerida: sin la pareja, quien escribe la otra
           forma en el navegador no llega a la web. El punto y el texto van
           juntos y el botón sigue al texto, también cuando en móvil parte. */
        <div className="mt-1 flex items-start gap-2 text-xs">
          <span aria-hidden className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
          <p className="min-w-0 flex-1 break-words leading-5 text-warn">
            Sin <span className="font-mono">{faltaPareja.falta}</span>:{' '}
            {faltaPareja.tipo === 'www' ? 'la web no responde con www.' : 'la web no responde sin www.'}{' '}
            <button
              type="button"
              onClick={onAddPareja}
              aria-label={`Añadir ${faltaPareja.falta}`}
              // El área de toque se amplía con el pseudoelemento: con más
              // relleno, la línea partida en móvil se separaba.
              className="press relative ml-1 inline-flex items-center gap-1 rounded-md px-1.5 align-baseline leading-5 font-medium text-sub transition-colors before:absolute before:-inset-x-1 before:-inset-y-2 before:content-[''] hover:bg-surface2 hover:text-txt"
            >
              <Plus size={12} aria-hidden /> Añadir
            </button>
          </p>
        </div>
      )}
      {dns && (
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-sub">
          <DnsAutoChip result={dns} />
          <span className="min-w-0 break-words">{dns.message}</span>
          {onRetryDns && dns.action !== 'created' && dns.action !== 'kept' && (
            <Button variant="ghost" size="sm" onClick={onRetryDns} loading={retryingDns} title="Volver a intentar el registro en Cloudflare">
              <Cloud size={12} /> Reintentar en Cloudflare
            </Button>
          )}
        </p>
      )}
      {visible && (check.data || check.error) && (
        <div id={detalleId} className="mt-2 flex flex-col gap-2">
          <DetalleDns
            domain={domain}
            check={check.data?.check}
            error={check.error}
            serverIp={serverIp}
            onDisableProxy={onDisableProxy}
            disablingProxy={disablingProxy}
            enCloudflare={dns?.action === 'created' || dns?.action === 'kept'}
          />
        </div>
      )}
    </li>
  );
}

/** Misma petición en la fila (que la repite) y en la lista (que solo lee el resultado). */
function comprobarDominio(domain: string) {
  return api.post<{ check: DomainCheck }>('/domains/check', { domain });
}

/**
 * El subdominio generado, que se ofrece añadir con un clic: una fila más de la
 * lista, en gris y con una nota de una línea, no un aviso. La pareja con o sin
 * www no es una sugerencia: se añade con el dominio.
 */
function FilaSugerida({ domain, nota, title, onAdd }: { domain: string; nota: string; title?: string; onAdd: () => void }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2" title={title}>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <NombreDominio domain={domain} className="text-sm text-sub max-sm:text-xs" />
        <span className="text-xs text-subtle">{nota}</span>
      </span>
      <Button size="sm" variant="secondary" onClick={onAdd} aria-label={`Añadir ${domain}`} className="shrink-0 max-sm:h-10">
        <Plus size={13} /> Añadir
      </Button>
    </li>
  );
}

/**
 * Editor de dominios: subdominio generado en un clic o dominio propio con
 * instrucciones DNS y verificación en vivo.
 */
export default function DomainsEditor({
  domains,
  sinPareja,
  onChange,
  slug,
  dnsResults,
  onRetryDns,
  retryingDns,
  guardados,
  onDisableProxy,
  disablingProxy,
}: {
  domains: string[];
  /** Dominios cuya pareja con o sin www se ha descartado (`dominiosSinPareja`). */
  sinPareja: string[];
  onChange: (domains: string[], sinPareja: string[]) => void;
  slug: string;
  /** Resultado del DNS automático por dominio, tras guardar (solo lo recibe un administrador). */
  dnsResults?: Record<string, DnsAutoResult>;
  /** Repite el DNS automático de un dominio ya guardado (solo administrador). */
  onRetryDns?: (domain: string) => void;
  /** Dominio cuyo reintento está en curso. */
  retryingDns?: string | null;
  /** Dominios ya guardados en el servicio: las acciones en Cloudflare solo valen para ellos. */
  guardados?: string[];
  /** Quita el proxy de Cloudflare de un dominio guardado (solo administrador). */
  onDisableProxy?: (domain: string) => void;
  /** Dominio cuyo proxy se está desactivando. */
  disablingProxy?: string | null;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [custom, setCustom] = useState('');
  // La pareja se añade por defecto; desmarcarla es la renuncia expresa.
  const [conPareja, setConPareja] = useState(true);
  // Quitar una mitad de la pareja se confirma: la web deja de responder en esa forma.
  const [quitando, setQuitando] = useState<{ domain: string; queda: string } | null>(null);
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
  const sinParejaFalta = new Map(parejasWwwPendientes(ordenados, rootDomain).map((p) => [p.domain, p]));
  const ofrecerGenerado = !!generated && !ordenados.includes(generated);

  /*
   * El proxy solo se puede quitar desde aquí si la zona está en el Cloudflare
   * del administrador. Con más zonas de las que se guardan (o sin la lista),
   * no se sabe: se ofrece y el servidor responde si no la encuentra.
   */
  const zonas = isAdmin && cloudflare.data?.configured ? cloudflare.data.zones : undefined;
  const enCloudflare = (d: string) =>
    zonas !== undefined && (!zonas || zonas.total > zonas.names.length || zonas.names.some((z) => d === z || d.endsWith(`.${z}`)));

  /** Toda edición pasa por aquí: la lista en el orden del principal y las renuncias limpias. */
  const cambiar = (siguientes: string[], renuncias: string[]) => {
    const lista = ordenarDominios(siguientes, rootDomain);
    onChange(lista, limpiarSinPareja(renuncias, lista, rootDomain));
  };

  // La pareja del dominio que se está escribiendo, si se va a ofrecer añadirla.
  const escrito = custom.trim().toLowerCase();
  const parejaEscrita =
    /^[a-z0-9.-]+\.[a-z]{2,}$/.test(escrito) && !domains.includes(escrito) ? parejaWww(escrito, rootDomain) : null;
  const ofrecerPareja = parejaEscrita && !domains.includes(parejaEscrita.falta) ? parejaEscrita : null;

  /*
   * La lista solo lee el resultado que ya guardan las filas (`enabled: false`
   * no lanza peticiones) para decir una sola vez, debajo, que el DNS se
   * comprueba solo y tarda en propagarse, en vez de repetirlo en cada fila.
   */
  const comprobaciones = useQueries({
    queries: ordenados.map((d) => ({ queryKey: ['domainCheck', d], queryFn: () => comprobarDominio(d), enabled: false })),
  });
  const hayPendientes = comprobaciones.some((c) => c.data && PENDIENTES.has(c.data.check.status));

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
    const pareja = parejaWww(domain, rootDomain);
    const faltaPareja = !!pareja && !domains.includes(pareja.falta);
    if (faltaPareja && conPareja) {
      cambiar([...domains, domain, pareja.falta], sinPareja);
    } else {
      // Sin la casilla marcada, la renuncia se guarda para que el servidor no la añada.
      cambiar([...domains, domain], faltaPareja ? [...sinPareja, domain] : sinPareja);
    }
    setCustom('');
    setConPareja(true);
  };

  const quitar = (d: string) => {
    const pareja = parejaWww(d, rootDomain);
    if (pareja && domains.includes(pareja.falta)) {
      setQuitando({ domain: d, queda: pareja.falta });
      return;
    }
    cambiar(domains.filter((x) => x !== d), sinPareja);
  };

  const filas = ordenados.length + (ofrecerGenerado ? 1 : 0);

  return (
    <div className="flex flex-col gap-3">
      {/*
        Una sola lista: los dominios y, al final, el subdominio generado como
        fila sugerida con su botón. La pareja con o sin www no se sugiere: se
        añade con el dominio, y si falta, la fila del dominio lo indica.
      */}
      {filas > 0 && (
        <div>
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
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
                faltaPareja={sinParejaFalta.get(d)}
                onAddPareja={() => {
                  const p = sinParejaFalta.get(d);
                  // Con la pareja presente, `cambiar` retira la renuncia.
                  if (p) cambiar([...domains, p.falta], sinPareja);
                }}
                onRemove={() => quitar(d)}
                onRetryDns={onRetryDns ? () => onRetryDns(d) : undefined}
                retryingDns={retryingDns === d}
                onDisableProxy={
                  onDisableProxy && guardados?.includes(d) && enCloudflare(d) ? () => onDisableProxy(d) : undefined
                }
                disablingProxy={disablingProxy === d}
              />
            ))}
            {ofrecerGenerado && (
              <FilaSugerida
                domain={generated}
                nota="Subdominio de la plataforma"
                title={`Requiere un registro A comodín *.${rootDomain} hacia la IP del servidor.`}
                onAdd={() => add(generated)}
              />
            )}
          </ul>
          {hayPendientes && (
            <p className="mt-1.5 text-xs text-subtle">
              El DNS se comprueba automáticamente; los cambios pueden tardar unas horas en propagarse.
            </p>
          )}
        </div>
      )}

      {/* Sin dominio raíz no hay subdominio que ofrecer. Hasta que llega la
          config no se pinta: si no, durante la carga asomaba el formulario
          aunque el dominio raíz ya estuviera configurado. */}
      {config.data && !rootDomain && (
        <div className="rounded-lg border border-dashed border-line px-3 py-2.5 text-xs text-sub">
          {isAdmin ? (
            <div className="flex flex-col gap-2">
              <p>
                Configura un dominio raíz (por ejemplo, <span className="font-mono">apps.midominio.com</span>) para ofrecer un
                subdominio a cada servicio.
              </p>
              <div className="flex gap-2">
                <input
                  className="input min-w-0 flex-1 font-mono sm:text-xs"
                  placeholder="apps.midominio.com"
                  aria-label="Dominio raíz"
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
               dice quién sí; el dominio propio del campo inferior sí es suyo. */
            <p>El administrador del servidor aún no ha configurado un dominio raíz para los subdominios automáticos.</p>
          )}
        </div>
      )}

      {/* Dominio propio */}
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            className="input min-w-0 flex-1 font-mono sm:text-xs"
            placeholder="app.clienteacme.com"
            aria-label="Dominio propio"
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
        {ofrecerPareja && (
          <label className="flex cursor-pointer items-center gap-2 self-start text-xs text-sub max-sm:min-h-10">
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0 accent-acc"
              checked={conPareja}
              onChange={(e) => setConPareja(e.target.checked)}
            />
            <span className="min-w-0 break-words">
              Añadir también <span className="font-mono text-txt">{ofrecerPareja.falta}</span>
            </span>
          </label>
        )}
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
          <Cloud size={12} className="mt-0.5 shrink-0" aria-hidden />
          <span>Al guardar, los dominios nuevos de tu Cloudflare reciben su registro A sin proxy. Un registro existente no se modifica.</span>
        </p>
      )}

      <ConfirmModal
        open={!!quitando}
        onClose={() => setQuitando(null)}
        onConfirm={() => {
          if (!quitando) return;
          // La renuncia queda en el dominio que se conserva: el servidor no vuelve a añadir el otro.
          cambiar(domains.filter((x) => x !== quitando.domain), [...sinPareja, quitando.queda]);
          setQuitando(null);
        }}
        title="Quitar dominio"
        message={
          quitando ? `Si quitas ${quitando.domain}, la web no responderá en esa dirección. ¿Quitar ${quitando.domain}?` : ''
        }
        confirmLabel="Quitar"
      />
    </div>
  );
}
