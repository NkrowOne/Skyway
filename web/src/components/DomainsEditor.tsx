import { Fragment, ReactNode, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronRight, Cloud, ExternalLink, Plus, RefreshCw, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import {
  dominioUnicode,
  intervaloComprobacion,
  limpiarSinPareja,
  nombreEnZona,
  normalizarEntradaDominio,
  ordenarDominios,
  parejasWwwPendientes,
  parejaWww,
  ParejaWww,
} from '../dominios';
import { CloudflareConfigView, DnsAutoResult, DomainCheck, DomainsConfig, Me, PlanReemplazoDns } from '../types';
import { cx, Tone } from '../utils';
import { DnsAutoChip } from './DnsAutoResult';
import { Button, Chip, ConfirmModal, CopyButton, ErrorState, Modal, Skeleton, useToast } from './ui';

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
  // Información y no aviso: el proxy de Cloudflare es la forma recomendada de
  // servir la web. Solo falta saber a dónde lleva el tráfico, que desde fuera
  // no se ve (a un administrador se le comprueba con la API de Cloudflare
  // cuando su token ve la zona, y entonces sale «Configurado»).
  cloudflare_proxy: { label: 'Proxy de Cloudflare', tone: 'info' },
  // Error: la web no carga (el navegador corta el bucle de redirecciones).
  cloudflare_flexible: { label: 'Bucle en Cloudflare', tone: 'err' },
  // Error: apunta aquí, pero un registro CAA impide el certificado.
  caa: { label: 'Certificado bloqueado (CAA)', tone: 'err' },
  unknown: { label: 'Sin verificar', tone: 'neutral' },
};

const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  err: 'bg-err',
  info: 'bg-acc-soft',
  neutral: 'bg-subtle',
};

/**
 * Estados en los que hay algo que corregir, en el DNS o en Cloudflare: su
 * detalle se abre solo. El proxy sin verificar no está: no hay nada que hacer.
 */
const PENDIENTES: ReadonlySet<DomainCheck['status']> = new Set(['no_record', 'wrong_ip', 'cloudflare_flexible', 'caa']);

/**
 * Reserva mientras la comprobación no ha dicho la zona: las dos últimas
 * etiquetas. Falla con los sufijos de varios niveles (.com.es, .co.uk), por
 * eso el nombre y la zona buenos los calcula el servidor con la lista de
 * sufijos públicos (`check.zone` y `check.name`) y esto solo se usa mientras
 * carga.
 */
function splitDnsName(domain: string): { name: string; zone: string } {
  const parts = domain.split('.');
  if (parts.length <= 2) return { name: '@', zone: domain };
  return { name: parts.slice(0, -2).join('.'), zone: parts.slice(-2).join('.') };
}

/** Zona y nombre del registro: los del servidor si ya los ha dicho. */
function zonaYNombre(domain: string, check: DomainCheck | undefined): { name: string; zone: string } {
  const aprox = splitDnsName(domain);
  return check?.zone ? { zone: check.zone, name: check.name ?? '@' } : aprox;
}

/** El registro A que hay que crear, como lo muestran los proveedores: tipo, nombre y valor. */
function TablaRegistro({ domain, serverIp, check }: { domain: string; serverIp: string | null; check?: DomainCheck }) {
  const { name } = zonaYNombre(domain, check);
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
 * El registro CAA que falta para que Let's Encrypt pueda emitir el
 * certificado, con el nombre relativo a la zona como el A. Se añade y se
 * conservan los que ya hay.
 */
function TablaCaa({ nombre }: { nombre: string }) {
  const valor = '0 issue "letsencrypt.org"';
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
            <td className={celda}>CAA</td>
            <td className={cx(celda, 'py-0.5')}>
              <span className="inline-flex items-center gap-0.5">
                {nombre}
                <CopyButton value={nombre} title="Copiar nombre" />
              </span>
            </td>
            <td className={cx(celda, 'py-0.5')}>
              <span className="inline-flex items-center gap-0.5">
                {valor}
                <CopyButton value={valor} title="Copiar valor" />
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Lo que solo hace falta leer una vez, plegado bajo el mensaje del estado. */
function MasInformacion({ children }: { children: ReactNode }) {
  return (
    <details className="group">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-subtle transition-colors hover:text-sub">
        <ChevronRight size={12} className="shrink-0 transition-transform group-open:rotate-90" aria-hidden />
        Más información
      </summary>
      <p className="details-body mt-1.5 text-xs text-subtle">{children}</p>
    </details>
  );
}

/**
 * «Activar proxy en Cloudflare» o «Desactivar proxy en Cloudflare», con una
 * nota opcional de cuándo conviene. Son las únicas modificaciones de un
 * registro existente, y solo con este clic: el guardado automático nunca toca
 * lo que ya existe.
 */
function BotonProxy({ activar, onClick, loading, nota }: { activar: boolean; onClick: () => void; loading?: boolean; nota?: string }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <Button size="sm" variant="secondary" onClick={onClick} loading={loading} className="max-sm:h-10">
        <Cloud size={12} /> {activar ? 'Activar proxy en Cloudflare' : 'Desactivar proxy en Cloudflare'}
      </Button>
      {nota && <p className="text-xs text-subtle">{nota}</p>}
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
  onActivarProxy,
  onDesactivarProxy,
  cambiandoProxy,
  notaSinProxy,
  enCloudflare,
}: {
  domain: string;
  check: DomainCheck | undefined;
  error: Error | null;
  serverIp: string | null;
  /** Pone el proxy en el Cloudflare del administrador (dominio guardado, zona en esa cuenta y HTTPS configurado). */
  onActivarProxy?: () => void;
  /** Quita el proxy en el Cloudflare del administrador (dominio guardado y zona en esa cuenta). */
  onDesactivarProxy?: () => void;
  cambiandoProxy?: boolean;
  /** Por qué no se ofrece activar el proxy en un dominio que no lo tiene (p. ej., el certificado gratuito no lo cubre). */
  notaSinProxy?: string;
  /** El DNS automático acaba de crear (o ya tenía) el registro A en Cloudflare. */
  enCloudflare?: boolean;
}) {
  const { zone } = zonaYNombre(domain, check);
  const zona = <span className="font-mono text-txt">{dominioUnicode(zone)}</span>;
  if (!check) return error ? <p className="text-xs text-err">{error.message}</p> : null;
  switch (check.status) {
    case 'ok': {
      // `viaCloudflare` solo llega a un administrador: es quien puede cambiar
      // el proxy, y sin él no se sabe si el registro lo tiene.
      let proxy: ReactNode = null;
      if (check.viaCloudflare) {
        if (onDesactivarProxy) {
          proxy = (
            <BotonProxy
              activar={false}
              onClick={onDesactivarProxy}
              loading={cambiandoProxy}
              nota="Desactiva el proxy si el servicio necesita subidas de más de 100 MB o peticiones de más de 100 segundos: el plan gratuito de Cloudflare no las admite."
            />
          );
        }
      } else if (onActivarProxy) {
        proxy = (
          <BotonProxy
            activar
            onClick={onActivarProxy}
            loading={cambiandoProxy}
            nota="El modo SSL/TLS de la zona en Cloudflare debe ser «Completo (estricto)» o «Completo»."
          />
        );
      } else if (notaSinProxy) {
        proxy = <p className="text-xs text-subtle">{notaSinProxy}</p>;
      }
      return (
        <>
          <p className="text-xs text-sub">{check.message}</p>
          {proxy}
        </>
      );
    }
    case 'no_record':
      // Con el registro ya en Cloudflare, la tabla pediría crear lo que existe.
      if (enCloudflare) return <p className="text-xs text-sub">El registro ya está en Cloudflare; puede tardar unos minutos en propagarse.</p>;
      return (
        <>
          <p className="text-xs text-sub">Añade este registro en el DNS de {zona}:</p>
          <TablaRegistro domain={domain} serverIp={serverIp} check={check} />
        </>
      );
    case 'wrong_ip':
      return (
        <>
          <p className="text-xs text-sub">
            {check.message} Corrige el registro en el DNS de {zona}:
          </p>
          <TablaRegistro domain={domain} serverIp={serverIp} check={check} />
          <MasInformacion>
            Si ese nombre tiene otro registro A, AAAA o CNAME (por ejemplo, del hosting anterior), cámbialo o elimínalo: con dos
            registros, parte de los visitantes seguiría llegando al sitio anterior.
          </MasInformacion>
        </>
      );
    case 'caa': {
      // Si el CAA lo publica un nivel por encima de la zona, el panel es el de ese nombre.
      const caa = check.caa;
      const enZona = caa ? nombreEnZona(caa.name, zone) : null;
      const panel = caa && enZona === null ? caa.name : zone;
      return (
        <>
          <p className="text-xs text-sub">
            {check.message} Añádelo en el DNS de <span className="font-mono text-txt">{dominioUnicode(panel)}</span> y conserva los
            que ya hay:
          </p>
          <TablaCaa nombre={enZona ?? '@'} />
        </>
      );
    }
    case 'cloudflare_proxy':
      return (
        <>
          <p className="text-xs text-sub">{check.message}</p>
          {onDesactivarProxy && <BotonProxy activar={false} onClick={onDesactivarProxy} loading={cambiandoProxy} />}
          <MasInformacion>
            {serverIp && (
              <>
                El registro A debe apuntar a <span className="font-mono text-sub">{serverIp}</span>.{' '}
              </>
            )}
            Con el proxy, el modo SSL/TLS de la zona en Cloudflare debe ser «Completo (estricto)» o «Completo», nunca
            «Flexible». Let&apos;s Encrypt emite el certificado igualmente: Cloudflare deja pasar la ruta{' '}
            <span className="font-mono">/.well-known/acme-challenge/</span> hasta este servidor.
          </MasInformacion>
        </>
      );
    case 'cloudflare_flexible':
      return (
        <>
          <p className="text-xs text-sub">{check.message}</p>
          {onDesactivarProxy && (
            <BotonProxy
              activar={false}
              onClick={onDesactivarProxy}
              loading={cambiandoProxy}
              nota="Si no puedes cambiar ahora el modo SSL/TLS, desactiva el proxy de este dominio: la web volverá a abrir sin pasar por Cloudflare."
            />
          )}
          <MasInformacion>
            En Cloudflare, abre SSL/TLS → Información general y selecciona «Completo (estricto)» (o «Completo»). Con
            «Flexible», Cloudflare se conecta a este servidor sin cifrado y el servidor redirige a HTTPS, lo que provoca el
            bucle.
          </MasInformacion>
        </>
      );
    default:
      return (
        <>
          <p className="text-xs text-sub">{check.message}</p>
          {serverIp && <TablaRegistro domain={domain} serverIp={serverIp} check={check} />}
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
                En su lugar se creará un registro A hacia <span className="font-mono text-txt">{p.ip}</span>
                {p.proxied ? ', con el proxy de Cloudflare.' : ', sin proxy.'}
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
  onCambiarProxy,
  cambiandoProxy,
  motivoSinProxy = null,
  onCreateDns,
  onReplaceDns,
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
  /** Activa (`true`) o desactiva el proxy de Cloudflare (solo administrador, dominio guardado y zona en su Cloudflare). */
  onCambiarProxy?: (proxied: boolean) => void;
  cambiandoProxy?: boolean;
  /**
   * Por qué no se ofrece activar el proxy (null: se ofrece). Vacío para el
   * subdominio de la plataforma, que no necesita explicación.
   */
  motivoSinProxy?: string | null;
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
  // null: lo decide el estado (abierto si hay algo que corregir, `PENDIENTES`);
  // un clic en el estado lo fija en uno u otro sentido.
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
  // Comprobado con la API de Cloudflare (solo para el administrador).
  const conProxy = status === 'ok' && !!check.data?.check.viaCloudflare;
  // Activarlo exige HTTPS: sin él, el servidor lo rechaza porque Cloudflare
  // solo podría entregar la web en el modo «Flexible».
  const activarProxy = onCambiarProxy && tls && motivoSinProxy === null ? () => onCambiarProxy(true) : undefined;
  const notaSinProxy = onCambiarProxy && tls && motivoSinProxy ? motivoSinProxy : undefined;
  const desactivarProxy = onCambiarProxy ? () => onCambiarProxy(false) : undefined;
  // Así se escribe (panadería.es) aunque se guarde en ASCII (xn--panadera-i2a.es).
  const unicode = dominioUnicode(domain);
  // El resultado del DNS automático solo existe tras guardar en esta misma
  // sesión. Un dominio añadido otro día o con el asistente de alta, que
  // apunta todavía al hosting anterior, también tiene que poder trasladarse:
  // lo dice la comprobación del DNS. La revisión explica si no hay nada que
  // reemplazar (una zona que el token no ve, un nombre de la plataforma).
  const reemplazo = (dns ? dns.action === 'conflict' : status === 'wrong_ip' && !check.isFetching) ? onReplaceDns : undefined;

  return (
    <li className="px-3 py-2.5">
      {/*
        En móvil (~360 px) dominio, estado y tres botones no caben en una
        línea: el dominio ocupa la suya entera (y parte por cualquier carácter
        antes que truncarse a «c…») y el estado con las acciones, a tamaño de
        dedo, pasa debajo.
      */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex min-w-0 items-center gap-2 max-sm:basis-full" title={unicode !== domain ? domain : undefined}>
          <NombreDominio domain={unicode} className="text-sm text-txt" />
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
            {/* Un icono y no texto: «con proxy de Cloudflare» no cabe junto al
                dominio y las acciones sin partir la fila (en móvil, la etiqueta
                en tres líneas). El detalle lo dice entero. */}
            {conProxy && (
              <span className="inline-flex text-subtle" title="Con el proxy de Cloudflare">
                <Cloud size={12} aria-hidden />
                <span className="sr-only">, con el proxy de Cloudflare</span>
              </span>
            )}
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
          {reemplazo && <BotonReemplazo onClick={reemplazo} />}
        </p>
      )}
      {!dns && reemplazo && (
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-sub">
          <span className="min-w-0 break-words">Si el registro actual está en tu Cloudflare, puedes revisarlo y sustituirlo desde aquí.</span>
          <BotonReemplazo onClick={reemplazo} />
        </p>
      )}
      {!dns && onCreateDns && status === 'no_record' && !check.isFetching && (
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-sub">
          <span className="min-w-0 break-words">Si el dominio está en tu Cloudflare, Skyway puede crear el registro.</span>
          <Button variant="ghost" size="sm" onClick={onCreateDns} loading={retryingDns} title="Crear el registro A en Cloudflare">
            <Cloud size={12} /> Crear en Cloudflare
          </Button>
        </p>
      )}
      {visible && (check.data || check.error) && (
        <div id={detalleId} className="mt-2 flex flex-col gap-2">
          <DetalleDns
            domain={domain}
            check={check.data?.check}
            error={check.error}
            serverIp={serverIp}
            onActivarProxy={activarProxy}
            notaSinProxy={notaSinProxy}
            onDesactivarProxy={desactivarProxy}
            cambiandoProxy={cambiandoProxy}
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
  onCambiarProxy,
  cambiandoProxy,
  serviceId,
  onDnsResult,
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
  /** Activa (`proxied: true`) o desactiva el proxy de Cloudflare de un dominio guardado (solo administrador). */
  onCambiarProxy?: (domain: string, proxied: boolean) => void;
  /** Dominio cuyo proxy se está cambiando. */
  cambiandoProxy?: string | null;
  /** Servicio ya creado: permite reemplazar en Cloudflare el registro de un dominio guardado. */
  serviceId?: string;
  /** Nuevo resultado del DNS automático de un dominio (tras un reemplazo). */
  onDnsResult?: (result: DnsAutoResult) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [custom, setCustom] = useState('');
  // La pareja se añade por defecto; desmarcarla es la renuncia expresa.
  const [conPareja, setConPareja] = useState(true);
  // Quitar una mitad de la pareja se confirma: la web deja de responder en esa forma.
  const [quitando, setQuitando] = useState<{ domain: string; queda: string } | null>(null);
  const [newRootDomain, setNewRootDomain] = useState('');
  // Dominio cuya revisión del reemplazo en Cloudflare está abierta.
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

  // Reemplazar o crear en Cloudflare: solo el administrador y con el token
  // guardado (sin él, la revisión respondería que falta configurarlo).
  const cloudflareListo = isAdmin && !!cloudflare.data?.configured;
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
   * El proxy solo se puede activar o quitar desde aquí si la zona está en el
   * Cloudflare del administrador. Con más zonas de las que se guardan (o sin
   * la lista), no se sabe: se ofrece y el servidor responde si no la encuentra.
   */
  const zonas = isAdmin && cloudflare.data?.configured ? cloudflare.data.zones : undefined;
  const enCloudflare = (d: string) =>
    zonas !== undefined && (!zonas || zonas.total > zonas.names.length || zonas.names.some((z) => d === z || d.endsWith(`.${z}`)));
  /*
   * El certificado gratuito de Cloudflare solo cubre la zona y un nivel de
   * subdominio: con el proxy, un nombre más profundo daría un error de
   * certificado. El subdominio generado tampoco: lo resuelve un comodín, sin
   * registro propio que cambiar. Sin la lista de zonas no se sabe: se ofrece
   * y el servidor responde.
   */
  const motivoSinProxy = (d: string): string | null => {
    if (d === generated || (rootDomain && d.endsWith(`.${rootDomain}`))) return '';
    const zona = zonas?.names.filter((z) => d === z || d.endsWith(`.${z}`)).sort((a, b) => b.length - a.length)[0];
    if (!zona || d === zona || !d.slice(0, -(zona.length + 1)).includes('.')) return null;
    return `El certificado gratuito de Cloudflare solo cubre ${zona} y un nivel de subdominio: este nombre va sin proxy.`;
  };

  /** Toda edición pasa por aquí: la lista en el orden del principal y las renuncias limpias. */
  const cambiar = (siguientes: string[], renuncias: string[]) => {
    const lista = ordenarDominios(siguientes, rootDomain);
    onChange(lista, limpiarSinPareja(renuncias, lista, rootDomain));
  };

  // La pareja del dominio que se está escribiendo, si se va a ofrecer añadirla.
  const escrito = normalizarEntradaDominio(custom);
  const parejaEscrita = escrito && !domains.includes(escrito) ? parejaWww(escrito, rootDomain) : null;
  const ofrecerPareja = parejaEscrita && !domains.includes(parejaEscrita.falta) ? parejaEscrita : null;

  /*
   * La lista solo lee el resultado que ya guardan las filas (`enabled: false`
   * no lanza peticiones) para decir una sola vez, debajo, que el DNS se
   * comprueba solo y tarda en propagarse, en vez de repetirlo en cada fila.
   */
  const comprobaciones = useQueries({
    queries: ordenados.map((d) => ({ queryKey: ['domainCheck', d], queryFn: () => comprobarDominio(d), enabled: false })),
  });
  // El bucle del modo «Flexible» no espera al DNS: se corrige en Cloudflare y vale al momento.
  const hayPendientes = comprobaciones.some(
    (c) => c.data && PENDIENTES.has(c.data.check.status) && c.data.check.status !== 'cloudflare_flexible',
  );

  // Como el servidor: sin esquema ni ruta (se pega la URL de la web) y en
  // ASCII («panadería.es» se guarda como xn--panadera-i2a.es).
  const add = (raw: string) => {
    if (!raw.trim()) return;
    const domain = normalizarEntradaDominio(raw);
    if (!domain) {
      toast(`«${raw.trim()}» no es un dominio válido: escribe solo el nombre, por ejemplo app.midominio.com.`, 'err');
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
                onCambiarProxy={
                  onCambiarProxy && guardados?.includes(d) && enCloudflare(d)
                    ? (proxied) => onCambiarProxy(d, proxied)
                    : undefined
                }
                cambiandoProxy={cambiandoProxy === d}
                motivoSinProxy={motivoSinProxy(d)}
                onCreateDns={cloudflareListo && onRetryDns && guardados?.includes(d) ? () => onRetryDns(d) : undefined}
                onReplaceDns={cloudflareListo && serviceId && onDnsResult && guardados?.includes(d) ? () => setReemplazar(d) : undefined}
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
          <Cloud size={12} className="mt-0.5 shrink-0" aria-hidden />
          {/* Misma regla que el servidor: el registro lleva el proxy solo con
              HTTPS. El de un dominio guardado se cambia en su detalle, y con
              el DNS correcto ese detalle no se abre por sí mismo: la nota dice
              dónde está. */}
          <span>
            {tls
              ? 'Al guardar, los dominios nuevos de tu Cloudflare reciben su registro A con el proxy activado. Un registro existente no se modifica: su proxy se activa o desactiva en el detalle de cada dominio y, si apunta a otro sitio, se puede revisar y sustituir con «Reemplazar en Cloudflare».'
              : 'Al guardar, los dominios nuevos de tu Cloudflare reciben su registro A sin proxy: el proxy de Cloudflare requiere HTTPS. Un registro existente no se modifica; si apunta a otro sitio, se puede revisar y sustituir con «Reemplazar en Cloudflare».'}
          </span>
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
