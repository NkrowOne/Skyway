import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Play, RefreshCw, Rocket, Square, X } from 'lucide-react';
import { api } from '../api';
import { MetricPoint } from '../pages/Project';
import { Deployment, MetricsSnapshot, Project, Runtime, Service } from '../types';
import { STATE_COLOR, STATE_LABEL } from '../utils';
import DeploymentsTab from './tabs/DeploymentsTab';
import LogsTab from './tabs/LogsTab';
import MetricsTab from './tabs/MetricsTab';
import ServiceSettingsTab from './tabs/ServiceSettingsTab';
import VariablesTab from './tabs/VariablesTab';
import { Button, StatusDot, Tabs, useToast } from './ui';

const TABS = [
  { key: 'deployments', label: 'Despliegues' },
  { key: 'variables', label: 'Variables' },
  { key: 'metrics', label: 'Métricas' },
  { key: 'logs', label: 'Logs' },
  { key: 'settings', label: 'Ajustes' },
];

export default function ServiceDrawer({
  serviceId,
  projectId,
  latestMetrics,
  historyRef,
  onClose,
}: {
  serviceId: string;
  projectId: string;
  latestMetrics: MetricsSnapshot | null;
  historyRef: React.MutableRefObject<Map<string, MetricPoint[]>>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState('deployments');
  const toast = useToast();
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: ['service', serviceId],
    queryFn: () =>
      api.get<{ service: Service; project: Project; runtime: Runtime; latestDeployment: Deployment | null }>(
        `/services/${serviceId}`,
      ),
    refetchInterval: 4000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['service', serviceId] });
    queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    queryClient.invalidateQueries({ queryKey: ['deployments', serviceId] });
  };

  const deploy = useMutation({
    mutationFn: () => api.post<{ deployment: Deployment }>(`/services/${serviceId}/deploy`),
    onSuccess: () => {
      toast('Despliegue iniciado', 'ok');
      setTab('deployments');
      invalidate();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const action = useMutation({
    mutationFn: (verb: 'start' | 'stop' | 'restart') => api.post(`/services/${serviceId}/${verb}`),
    onSuccess: () => invalidate(),
    onError: (err: Error) => toast(err.message, 'err'),
  });

  if (!detail.data) {
    return (
      <aside className="flex w-[560px] shrink-0 items-center justify-center border-l border-line bg-panel">
        <span className="text-sm text-sub">Cargando servicio...</span>
      </aside>
    );
  }

  const { service, runtime } = detail.data;
  const state = latestMetrics?.services[serviceId]?.state ?? runtime.state;
  const isRunning = state === 'running' || state === 'restarting';
  const domain = service.type !== 'database' ? service.config.domains?.[0] : undefined;
  const subtitle =
    service.type === 'git'
      ? `${service.config.repoUrl} · ${service.config.branch}`
      : service.type === 'image'
        ? `${service.config.image} · host interno: ${service.slug}`
        : `${service.config.template}:${service.config.version} · host interno: ${service.slug}`;

  return (
    <aside className="flex w-[560px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="border-b border-line px-5 py-4">
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold">{service.name}</h2>
              <span className="flex items-center gap-1.5 rounded-full border border-line bg-panel2 px-2 py-0.5 text-[11px] text-sub">
                <StatusDot colorClass={STATE_COLOR[state]} size={6} />
                {STATE_LABEL[state]}
              </span>
            </div>
            <p className="mt-0.5 truncate text-xs text-sub">{subtitle}</p>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-sub hover:bg-panel2 hover:text-txt">
            <X size={16} />
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => deploy.mutate()} loading={deploy.isPending}>
            <Rocket size={13} /> Desplegar
          </Button>
          {isRunning ? (
            <>
              <Button size="sm" variant="outline" onClick={() => action.mutate('restart')} loading={action.isPending}>
                <RefreshCw size={13} /> Reiniciar
              </Button>
              <Button size="sm" variant="outline" onClick={() => action.mutate('stop')} loading={action.isPending}>
                <Square size={13} /> Detener
              </Button>
            </>
          ) : (
            state !== 'not_created' && (
              <Button size="sm" variant="outline" onClick={() => action.mutate('start')} loading={action.isPending}>
                <Play size={13} /> Iniciar
              </Button>
            )
          )}
          {domain && (
            <a
              href={`http://${domain}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-acc2 hover:bg-panel2"
            >
              <ExternalLink size={13} /> {domain}
            </a>
          )}
        </div>
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      <div className="flex-1 overflow-y-auto">
        {tab === 'deployments' && <DeploymentsTab serviceId={serviceId} serviceType={service.type} />}
        {tab === 'variables' && <VariablesTab serviceId={serviceId} onSaved={invalidate} />}
        {tab === 'metrics' && (
          <MetricsTab serviceId={serviceId} latest={latestMetrics} historyRef={historyRef} />
        )}
        {tab === 'logs' && <LogsTab serviceId={serviceId} />}
        {tab === 'settings' && (
          <ServiceSettingsTab
            service={service}
            projectId={projectId}
            onChanged={invalidate}
            onDeleted={() => {
              invalidate();
              onClose();
            }}
          />
        )}
      </div>
    </aside>
  );
}
