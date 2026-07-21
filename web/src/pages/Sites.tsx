import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, BellRing, ExternalLink, Globe, Lock, RefreshCw, Rocket, Search, Unlock } from 'lucide-react';
import { api } from '../api';
import { ModuleChip, moduleKind } from '../components/ModuleIcon';
import { Button, Skeleton, StatusBadge, useToast } from '../components/ui';
import { WebsiteEntry } from '../types';
import { cx, DEPLOY_STATUS_LABEL, STATE_LABEL, STATE_PULSE, STATE_TONE, timeAgo } from '../utils';

function SiteCard({
  site,
  tls,
  serverIp,
  onRestart,
  onDeploy,
  busy,
}: {
  site: WebsiteEntry;
  tls: boolean;
  serverIp: string | null;
  onRestart: () => void;
  onDeploy: () => void;
  busy: boolean;
}) {
  const navigate = useNavigate();
  const scheme = tls ? 'https' : 'http';
  const isRunning = site.state === 'running' || site.state === 'restarting';
  const deployTone =
    site.lastDeploy?.status === 'failed' ? 'text-err' : site.lastDeploy?.status === 'success' ? 'text-subtle' : 'text-warn';

  return (
    <div className="card card-hover flex flex-col p-4">
      <div className="flex items-start justify-between gap-2">
        <button
          onClick={() => navigate(`/projects/${site.projectId}?s=${site.id}`)}
          className="flex min-w-0 items-center gap-2.5 text-left"
          title="Abrir el servicio"
        >
          <ModuleChip kind={moduleKind({ type: site.type, config: { image: site.image } as any })} size={34} radius={9} />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate text-[13.5px] font-semibold tracking-[-.01em]">
              {site.name}
              {site.alerts > 0 && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-err/[.14] px-1.5 py-px text-[10px] font-semibold text-err">
                  <BellRing size={9} /> {site.alerts}
                </span>
              )}
            </p>
            <p className="truncate text-[11px] text-subtle">
              {site.projectName}
              {site.client ? ` · ${site.client}` : ''}
            </p>
          </div>
        </button>
        <StatusBadge tone={STATE_TONE[site.state]} label={STATE_LABEL[site.state]} pulse={STATE_PULSE[site.state]} replicas={site.replicas} />
      </div>

      <div className="mt-3 flex min-h-[26px] flex-wrap items-center gap-1.5">
        {site.domains.length === 0 && site.hostPort === null && (
          <span className="text-[11px] text-subtle">Sin dominio — añádelo en Ajustes del servicio</span>
        )}
        {site.domains.map((d) => (
          <a
            key={d}
            href={`${scheme}://${d}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-[3px] text-[11px] text-sub transition-colors hover:border-acc/50 hover:text-txt"
            title={`Abrir ${scheme}://${d}`}
          >
            {tls ? <Lock size={10} className="shrink-0 text-ok" /> : <Unlock size={10} className="shrink-0 text-warn" />}
            <span className="truncate">{d}</span>
            <ExternalLink size={10} className="shrink-0 opacity-60" />
          </a>
        ))}
        {site.hostPort !== null && (
          <a
            href={`http://${serverIp || window.location.hostname}:${site.hostPort}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-[3px] font-mono text-[11px] text-sub transition-colors hover:border-acc/50 hover:text-txt"
            title="Puerto público del host"
          >
            :{site.hostPort}
            <ExternalLink size={10} className="shrink-0 opacity-60" />
          </a>
        )}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 pt-3">
        <span className={cx('truncate text-[11px]', deployTone)}>
          {site.lastDeploy
            ? `${DEPLOY_STATUS_LABEL[site.lastDeploy.status]} ${timeAgo(site.lastDeploy.created_at)}`
            : 'Sin despliegues'}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={onDeploy}
            disabled={busy}
            className="rounded-lg p-1.5 leading-none text-subtle transition-colors hover:bg-surface2 hover:text-txt disabled:opacity-40"
            title="Desplegar"
          >
            <Rocket size={13} />
          </button>
          {isRunning && (
            <button
              onClick={onRestart}
              disabled={busy}
              className="rounded-lg p-1.5 leading-none text-subtle transition-colors hover:bg-surface2 hover:text-txt disabled:opacity-40"
              title="Reiniciar"
            >
              <RefreshCw size={13} className={cx(busy && 'animate-spin')} />
            </button>
          )}
          <Link
            to={`/projects/${site.projectId}?s=${site.id}`}
            className="rounded-lg p-1.5 leading-none text-subtle transition-colors hover:bg-surface2 hover:text-txt"
            title="Abrir servicio"
          >
            <ArrowUpRight size={13} />
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function SitesPage() {
  const [text, setText] = useState('');
  const [onlyDomains, setOnlyDomains] = useState(false);
  const toast = useToast();
  const queryClient = useQueryClient();

  const sites = useQuery({
    queryKey: ['websites'],
    queryFn: () => api.get<{ sites: WebsiteEntry[]; tls: boolean; serverIp: string | null }>('/websites'),
    refetchInterval: 8000,
  });

  // Ids con acción en curso: `mutation.variables` solo recuerda la última.
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const track = {
    onMutate: (serviceId: string) => setBusyIds((prev) => new Set(prev).add(serviceId)),
    onSettled: (_d: unknown, _e: unknown, serviceId: string) =>
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(serviceId);
        return next;
      }),
  };

  const restart = useMutation({
    mutationFn: (serviceId: string) => api.post(`/services/${serviceId}/restart`),
    ...track,
    onSuccess: () => {
      toast('Servicio reiniciado', 'ok');
      queryClient.invalidateQueries({ queryKey: ['websites'] });
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const deploy = useMutation({
    mutationFn: (serviceId: string) => api.post(`/services/${serviceId}/deploy`),
    ...track,
    onSuccess: () => toast('Despliegue iniciado', 'ok'),
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const all = sites.data?.sites ?? [];
  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    return all.filter((s) => {
      if (onlyDomains && s.domains.length === 0) return false;
      if (!q) return true;
      return `${s.name} ${s.projectName} ${s.client ?? ''} ${s.domains.join(' ')} ${s.image ?? ''} ${s.repoUrl ?? ''}`
        .toLowerCase()
        .includes(q);
    });
  }, [all, text, onlyDomains]);

  const withDomain = all.filter((s) => s.domains.length > 0).length;
  const online = all.filter((s) => s.state === 'running').length;

  return (
    <div className="mx-auto max-w-[1120px] px-4 py-7 sm:px-6 sm:py-9">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2.5 text-2xl font-semibold leading-[30px] tracking-[-.02em]">
            <Globe size={22} className="text-acc-soft" /> Sitios web
          </h1>
          <p className="mt-1.5 text-sm text-sub">
            Todas las webs y apps desplegadas en el servidor
            {sites.data && (
              <>
                : {online} en línea, {withDomain} con dominio
                {!sites.data.tls && withDomain > 0 && (
                  <span className="text-warn"> · TLS sin configurar (Ajustes → Let&apos;s Encrypt)</span>
                )}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
            <input
              className="input h-9 w-56 pl-8 text-xs"
              placeholder="Buscar sitio, dominio, cliente…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <Button
            variant={onlyDomains ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setOnlyDomains((v) => !v)}
            title="Mostrar solo servicios con dominio"
          >
            Con dominio
          </Button>
        </div>
      </div>

      {sites.isLoading && (
        <div aria-busy className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      )}

      {sites.isError && !sites.data && (
        <div className="card flex flex-col items-center gap-3 py-14 text-center">
          <Globe size={22} className="text-warn" />
          <p className="max-w-sm text-sm text-sub">No se pudieron cargar los sitios: {(sites.error as Error).message}</p>
          <Button variant="secondary" size="sm" onClick={() => sites.refetch()}>
            <RefreshCw size={13} /> Reintentar
          </Button>
        </div>
      )}

      {sites.data && all.length === 0 && (
        <div className="card flex flex-col items-center gap-3 py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-acc/[.14] text-acc-soft">
            <Globe size={22} />
          </span>
          <p className="max-w-sm text-sm text-sub">
            Aún no hay sitios desplegados. Crea un servicio de repositorio o imagen en cualquier proyecto y aparecerá aquí.
          </p>
        </div>
      )}

      {filtered.length === 0 && all.length > 0 && (
        <p className="card px-4 py-10 text-center text-xs text-subtle">Ningún sitio coincide con el filtro.</p>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
        {filtered.map((s) => (
          <SiteCard
            key={s.id}
            site={s}
            tls={sites.data!.tls}
            serverIp={sites.data!.serverIp}
            onRestart={() => restart.mutate(s.id)}
            onDeploy={() => deploy.mutate(s.id)}
            busy={busyIds.has(s.id)}
          />
        ))}
      </div>
    </div>
  );
}
