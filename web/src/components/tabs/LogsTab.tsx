import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  Clock,
  Code2,
  Cpu,
  Download,
  GitBranch,
  GitCommit,
  History,
  Layers,
  Play,
  Radio,
  RotateCcw,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { api, openStream } from '../../api';
import { Deployment, DeploymentStatus } from '../../types';
import {
  cx,
  DEPLOY_STATUS_LABEL,
  DEPLOY_TRIGGER_LABEL,
  fmtDuration,
  isActiveDeploy,
  timeAgo,
} from '../../utils';
import LogViewer, { LogStage } from '../LogViewer';
import { Skeleton, useToast } from '../ui';

type Row = { line: string; cursor: string | null };

const CAP_FOLLOWING = 14_000;
const CAP_READING = 45_000;
const OLDER_PAGE = 400;

interface DeploymentLogsResponse {
  deploymentId: string;
  status: DeploymentStatus;
  buildLogs: string;
  runtimeLogs: string | null;
  isLiveRuntime: boolean;
  createdAt: number;
  finishedAt: number | null;
}

export default function LogsTab({
  serviceId,
  replicas = 1,
  initialDeploymentId,
}: {
  serviceId: string;
  replicas?: number;
  initialDeploymentId?: string | null;
}) {
  const toast = useToast();

  // 1. Despliegues del servicio
  const deploymentsQuery = useQuery({
    queryKey: ['deployments', serviceId],
    queryFn: () => api.get<{ deployments: Deployment[] }>(`/services/${serviceId}/deployments`),
    refetchInterval: 5000,
  });

  const deployments = deploymentsQuery.data?.deployments ?? [];
  const latestDeploy = deployments[0] ?? null;
  const currentSuccessDeploy = deployments.find((d) => d.status === 'success') ?? latestDeploy;

  // 'live' = logs en vivo del servicio/contenedor activo, o un id concreto de despliegue
  const [selectedDepId, setSelectedDepId] = useState<string>(initialDeploymentId ?? 'live');
  const [selectorOpen, setSelectorOpen] = useState(false);
  // Por defecto 'runtime' (Logs de aplicación) como en Railway
  const [stageTab, setStageTab] = useState<LogStage>('runtime');

  useEffect(() => {
    if (initialDeploymentId) setSelectedDepId(initialDeploymentId);
  }, [initialDeploymentId]);

  const isLiveMode = selectedDepId === 'live';
  const effectiveDepId = isLiveMode ? currentSuccessDeploy?.id : selectedDepId;
  const selectedDeployment = deployments.find((d) => d.id === effectiveDepId);

  // 2. Logs en vivo (SSE para modo 'live' o para un despliegue en progreso)
  const [liveRows, setLiveRows] = useState<Row[]>([]);
  const [liveNotice, setLiveNotice] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reachedStart, setReachedStart] = useState(false);

  const seenRef = useRef<Set<string>>(new Set());
  const rowsRef = useRef<Row[]>([]);
  const followingRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const reachedStartRef = useRef(false);

  useEffect(() => {
    rowsRef.current = liveRows;
  }, [liveRows]);

  // Manejo de stream en vivo cuando estamos en modo 'live'
  useEffect(() => {
    if (!isLiveMode) return;

    setLiveRows([]);
    setLiveNotice(null);
    setLoadingOlder(false);
    setReachedStart(false);
    reachedStartRef.current = false;
    loadingOlderRef.current = false;
    followingRef.current = true;
    seenRef.current = new Set();

    const pending: Row[] = [];
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (!pending.length) return;
      const incoming = pending.splice(0);
      const seen = seenRef.current;
      const add: Row[] = [];
      for (const r of incoming) {
        if (r.cursor) {
          if (seen.has(r.cursor)) continue;
          seen.add(r.cursor);
        }
        add.push(r);
      }
      if (!add.length) return;
      setLiveRows((prev) => {
        let next = prev.length ? prev.concat(add) : add;
        const cap = followingRef.current ? CAP_FOLLOWING : CAP_READING;
        if (next.length > cap) {
          const cut = next.length - cap;
          for (let i = 0; i < cut; i++) {
            const c = next[i].cursor;
            if (c) seen.delete(c);
          }
          next = next.slice(cut);
        }
        return next;
      });
    };

    const es = openStream(`/services/${serviceId}/logs/stream`);
    es.addEventListener('log', (ev) => {
      pending.push(JSON.parse((ev as MessageEvent).data) as Row);
      if (!raf) raf = requestAnimationFrame(flush);
    });
    es.addEventListener('notice', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data);
      setLiveNotice(data.message);
    });
    es.addEventListener('attached', () => setLiveNotice(null));

    return () => {
      if (raf) cancelAnimationFrame(raf);
      es.close();
    };
  }, [serviceId, isLiveMode]);

  // Carga de historial hacia atrás en modo 'live'
  const loadOlderLive = useCallback(async () => {
    if (loadingOlderRef.current || reachedStartRef.current) return;
    const before = rowsRef.current.find((r) => r.cursor)?.cursor;
    if (!before) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const res = await api.get<{ lines: Row[]; hasMore: boolean }>(
        `/services/${serviceId}/logs/tail?limit=${OLDER_PAGE}&before=${encodeURIComponent(before)}`,
      );
      const seen = seenRef.current;
      const fresh = res.lines.filter((r) => !r.cursor || !seen.has(r.cursor));
      for (const r of fresh) if (r.cursor) seen.add(r.cursor);
      if (fresh.length) {
        setLiveRows((prev) => {
          let next = fresh.concat(prev);
          if (next.length > CAP_READING) next = next.slice(0, CAP_READING);
          return next;
        });
      }
      if (!res.hasMore || fresh.length === 0) {
        reachedStartRef.current = true;
        setReachedStart(true);
      }
    } catch {
      toast('No se pudieron cargar más líneas', 'err');
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [serviceId, toast]);

  // 3. Consulta de logs por despliegue (siempre que tengamos un deploymentId)
  const targetDepId = isLiveMode ? currentSuccessDeploy?.id : selectedDepId;
  const deploymentLogsQuery = useQuery({
    queryKey: ['deploymentLogs', targetDepId],
    queryFn: () => api.get<DeploymentLogsResponse>(`/deployments/${targetDepId}/logs`),
    enabled: !!targetDepId,
    refetchInterval: isLiveMode ? 4000 : false,
  });

  // 4. Stream en vivo si es un despliegue EN CURSO
  const [buildingLines, setBuildingLines] = useState<string[]>([]);
  const isBuildingSelected = !isLiveMode && selectedDeployment && isActiveDeploy(selectedDeployment.status);

  useEffect(() => {
    if (!isBuildingSelected || !selectedDepId) return;
    setBuildingLines([]);
    const es = openStream(`/deployments/${selectedDepId}/logs/stream`);
    es.addEventListener('snapshot', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data);
      setBuildingLines(data.logs ? data.logs.split('\n').filter(Boolean) : []);
    });
    es.addEventListener('log', (ev) => {
      const line = JSON.parse((ev as MessageEvent).data).line;
      setBuildingLines((prev) => [...prev, line]);
    });
    return () => es.close();
  }, [selectedDepId, isBuildingSelected]);

  // 5. Consolidación de líneas para el visor con sellos de fecha y hora íntegros
  const displayLines = useMemo(() => {
    // Si estamos en streaming en vivo y hay líneas en vivo
    if (isLiveMode && liveRows.length > 0) {
      const liveFormatted = liveRows.map((r) =>
        r.cursor ? `${r.cursor} [runtime] ${r.line}` : `[runtime] ${r.line}`,
      );
      if (stageTab === 'runtime') return liveFormatted;
      if (stageTab === 'build' && deploymentLogsQuery.data) {
        return deploymentLogsQuery.data.buildLogs
          ? deploymentLogsQuery.data.buildLogs.split('\n').filter(Boolean)
          : [];
      }
      if (stageTab === 'deploy' && deploymentLogsQuery.data) {
        return deploymentLogsQuery.data.buildLogs
          ? deploymentLogsQuery.data.buildLogs
              .split('\n')
              .filter((l) => l.toLowerCase().includes('[deploy]'))
          : [];
      }
      if (stageTab === 'all' && deploymentLogsQuery.data) {
        const b = deploymentLogsQuery.data.buildLogs
          ? deploymentLogsQuery.data.buildLogs.split('\n').filter(Boolean)
          : [];
        return [...b, ...liveFormatted];
      }
      return liveFormatted;
    }

    if (isBuildingSelected) {
      return buildingLines;
    }

    // Datos del despliegue (histórico o servicio detenido)
    if (deploymentLogsQuery.data) {
      const data = deploymentLogsQuery.data;
      const bLines = data.buildLogs ? data.buildLogs.split('\n').filter(Boolean) : [];
      const rLines = data.runtimeLogs
        ? data.runtimeLogs
            .split('\n')
            .filter(Boolean)
            .map((l) => (l.includes('[runtime]') ? l : `[runtime] ${l}`))
        : [];

      if (stageTab === 'runtime') {
        return rLines.length > 0 ? rLines : bLines;
      }
      if (stageTab === 'build') return bLines.filter((l) => !l.toLowerCase().includes('[deploy]'));
      if (stageTab === 'deploy') return bLines.filter((l) => l.toLowerCase().includes('[deploy]'));

      // 'all': Build + Deploy + Runtime intercalados/secuenciales con sus marcas de fecha
      if (rLines.length === 0) return bLines;
      return [...bLines, ...rLines];
    }

    return [];
  }, [
    isLiveMode,
    liveRows,
    isBuildingSelected,
    buildingLines,
    deploymentLogsQuery.data,
    stageTab,
  ]);

  // Descarga del log
  const handleDownload = useCallback(async () => {
    try {
      if (isLiveMode && liveRows.length > 0) {
        const res = await fetch(`/api/services/${serviceId}/logs/download?timestamps=1`, {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error();
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `logs-${serviceId}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
        a.click();
        URL.revokeObjectURL(url);
      } else if (targetDepId) {
        const res = await fetch(`/api/deployments/${targetDepId}/logs/download`, {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error();
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `deploy-${targetDepId}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch {
      toast('No se pudo descargar el log', 'err');
    }
  }, [isLiveMode, liveRows.length, serviceId, targetDepId, toast]);

  return (
    <div className="flex min-h-0 h-full flex-1 flex-col overflow-hidden p-3.5 sm:p-4">
      {/* ── BARRA SUPERIOR ESTILO RAILWAY: SELECTOR DE DESPLIEGUE + SUBPESTAÑAS DE FLUJO ── */}
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface p-2 shadow-sm">
        {/* Selector de despliegue desplegable */}
        <div className="relative min-w-[220px]">
          <button
            type="button"
            onClick={() => setSelectorOpen((o) => !o)}
            className={cx(
              'press flex h-9 w-full items-center justify-between gap-2.5 rounded-lg border border-line bg-surface2/70 px-3 text-xs font-medium transition-colors hover:bg-surface2',
              isLiveMode ? 'text-txt border-line' : 'text-acc-soft border-acc/40 bg-acc/5',
            )}
          >
            {isLiveMode ? (
              <div className="flex items-center gap-2 truncate">
                <span className="pulse-soft h-2 w-2 shrink-0 rounded-full bg-ok" />
                <span className="font-semibold">Despliegue actual (En vivo)</span>
                {currentSuccessDeploy && (
                  <span className="hidden font-mono text-[11px] text-subtle sm:inline">
                    · {currentSuccessDeploy.id}
                  </span>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 truncate">
                <span
                  className={cx(
                    'h-2 w-2 shrink-0 rounded-full',
                    selectedDeployment?.status === 'success'
                      ? 'bg-ok'
                      : selectedDeployment?.status === 'failed'
                        ? 'bg-err'
                        : selectedDeployment?.status && isActiveDeploy(selectedDeployment.status)
                          ? 'bg-warn pulse-soft'
                          : 'bg-subtle',
                  )}
                />
                <span className="font-mono font-semibold">{selectedDeployment?.id}</span>
                {selectedDeployment?.commit_sha && (
                  <span className="text-subtle">· {selectedDeployment.commit_sha.slice(0, 7)}</span>
                )}
                {selectedDeployment?.created_at && (
                  <span className="hidden text-subtle md:inline">
                    · {timeAgo(selectedDeployment.created_at)}
                  </span>
                )}
              </div>
            )}
            <ChevronDown size={14} className="shrink-0 text-subtle" />
          </button>

          {selectorOpen && (
            <div
              className="absolute left-0 top-full z-40 mt-1.5 max-h-[380px] w-[340px] overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-modal"
              onMouseLeave={() => setSelectorOpen(false)}
            >
              <div className="px-2.5 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-subtle">
                Flujo de logs por despliegue
              </div>

              {/* Opción En Vivo / Despliegue Actual */}
              <button
                type="button"
                onClick={() => {
                  setSelectedDepId('live');
                  setSelectorOpen(false);
                }}
                className={cx(
                  'flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors',
                  isLiveMode ? 'bg-acc/10 font-semibold text-txt' : 'hover:bg-surface2',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="pulse-soft h-2 w-2 rounded-full bg-ok" />
                  <div>
                    <p className="font-medium">Despliegue actual (En vivo)</p>
                    <p className="text-[11px] text-subtle">
                      Logs de aplicación en tiempo real del contenedor
                    </p>
                  </div>
                </div>
                {isLiveMode && <span className="text-xs font-bold text-acc">✓</span>}
              </button>

              <div className="my-1.5 border-t border-line" />
              <div className="px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-subtle">
                Historial de despliegues ({deployments.length})
              </div>

              {deployments.map((d) => {
                const isSelected = !isLiveMode && selectedDepId === d.id;
                const isCur = d.id === currentSuccessDeploy?.id;
                const active = isActiveDeploy(d.status);
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => {
                      setSelectedDepId(d.id);
                      setSelectorOpen(false);
                    }}
                    className={cx(
                      'flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors',
                      isSelected ? 'bg-acc/10 font-semibold text-txt' : 'hover:bg-surface2',
                    )}
                  >
                    <div className="min-w-0 flex-1 pr-2">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cx(
                            'h-2 w-2 shrink-0 rounded-full',
                            d.status === 'success'
                              ? 'bg-ok'
                              : d.status === 'failed'
                                ? 'bg-err'
                                : active
                                  ? 'bg-warn pulse-soft'
                                  : 'bg-subtle',
                          )}
                        />
                        <span className="font-mono text-[11px] font-semibold">{d.id}</span>
                        {isCur && (
                          <span className="rounded bg-ok/15 px-1 py-0.2 text-[9.5px] font-semibold text-ok">
                            Activo
                          </span>
                        )}
                        {active && (
                          <span className="rounded bg-warn/15 px-1 py-0.2 text-[9.5px] font-semibold text-warn">
                            En curso
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-[11.5px] text-sub">
                        {d.commit_msg || DEPLOY_TRIGGER_LABEL[d.trigger] || d.trigger}
                      </p>
                      <p className="font-mono text-[10.5px] text-subtle">
                        {d.commit_sha ? `${d.commit_sha.slice(0, 7)} · ` : ''}
                        {timeAgo(d.created_at)}
                        {d.finished_at ? ` · ${fmtDuration(d.finished_at - d.created_at)}` : ''}
                      </p>
                    </div>
                    {isSelected && <span className="text-xs font-bold text-acc">✓</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Sub-pestañas de flujo estilo Railway (Aplicación, Compilación, Despliegue, Todos) */}
        <div className="flex items-center gap-1 rounded-lg bg-surface2/60 p-1 border border-line">
          {(
            [
              { key: 'runtime', label: 'Aplicación (Runtime)', icon: Terminal },
              { key: 'build', label: 'Compilación (Build)', icon: Code2 },
              { key: 'deploy', label: 'Despliegue', icon: Layers },
              { key: 'all', label: 'Todos', icon: History },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            const active = stageTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setStageTab(tab.key)}
                className={cx(
                  'press flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
                  active
                    ? 'bg-surface text-txt shadow-sm border border-line font-semibold'
                    : 'text-subtle hover:text-txt hover:bg-surface/50',
                )}
              >
                <Icon size={12} className={active ? 'text-acc' : 'text-subtle'} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── VISOR DE LOGS PROFESIONAL CON SCROLL Y TIMESTAMPS GARANTIZADOS ── */}
      <LogViewer
        lines={displayLines}
        toolbar
        tailAnchor={isLiveMode}
        replicas={replicas}
        statusNote={
          isLiveMode
            ? liveNotice
            : isBuildingSelected
              ? 'Construyendo despliegue en tiempo real…'
              : selectedDeployment?.error
                ? `Error: ${selectedDeployment.error}`
                : null
        }
        onLoadOlder={isLiveMode ? loadOlderLive : undefined}
        canLoadOlder={isLiveMode && !reachedStart && displayLines.length > 0}
        loadingOlder={loadingOlder}
        reachedStart={isLiveMode && reachedStart && displayLines.length > 0}
        onDownload={handleDownload}
        onFollowChange={(f) => {
          followingRef.current = f;
        }}
        downloadName={
          isLiveMode
            ? `logs-runtime-${serviceId}.txt`
            : `deploy-${targetDepId}.txt`
        }
        className="flex-1 min-h-[300px]"
      />
    </div>
  );
}
