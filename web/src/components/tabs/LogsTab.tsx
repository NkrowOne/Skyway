import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  Code2,
  Terminal,
} from 'lucide-react';
import { api, openStream } from '../../api';
import { Deployment, DeploymentStatus } from '../../types';
import {
  cx,
  DEPLOY_STATUS_LABEL,
  fmtDuration,
  isActiveDeploy,
  timeAgo,
} from '../../utils';
import LogViewer from '../LogViewer';
import { Menu, Segmented, Skeleton, useToast } from '../ui';

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
    // Igual que en Despliegues: solo hace falta ir rápido mientras sale uno.
    refetchInterval: (q) => (q.state.data?.deployments.some((d) => isActiveDeploy(d.status)) ? 3000 : 15_000),
  });

  const deployments = deploymentsQuery.data?.deployments ?? [];
  const latestDeploy = deployments[0] ?? null;
  const currentSuccessDeploy = deployments.find((d) => d.status === 'success') ?? latestDeploy;
  // Despliegue saliendo ahora mismo (si lo hay): en vivo, «Compilación» es su build.
  const activeDeploy = latestDeploy && isActiveDeploy(latestDeploy.status) ? latestDeploy : null;

  // 'live' = logs en vivo del servicio/contenedor activo, o un id concreto de despliegue
  const [selectedDepId, setSelectedDepId] = useState<string>(initialDeploymentId ?? 'live');
  const [selectorOpen, setSelectorOpen] = useState(false);
  // Dos pestañas claras y limpias: 'runtime' (Aplicación) y 'build' (Compilación)
  const [stageTab, setStageTab] = useState<'runtime' | 'build'>('runtime');

  useEffect(() => {
    if (initialDeploymentId) setSelectedDepId(initialDeploymentId);
  }, [initialDeploymentId]);

  const isLiveMode = selectedDepId === 'live';
  const effectiveDepId = isLiveMode ? currentSuccessDeploy?.id : selectedDepId;
  const selectedDeployment = deployments.find((d) => d.id === effectiveDepId);

  /**
   * Al elegir un despliegue que no llegó a servir (fallido, cancelado o aún
   * construyéndose) lo que se quiere leer es el build: se abre en Compilación.
   * Al volver a «En vivo», en Aplicación. Se decide una vez por selección; a
   * partir de ahí manda la pestaña que toque quien lo esté leyendo.
   */
  const autoTabRef = useRef<string | null>(null);
  useEffect(() => {
    if (isLiveMode) {
      if (autoTabRef.current !== 'live') {
        autoTabRef.current = 'live';
        setStageTab('runtime');
      }
      return;
    }
    if (!selectedDeployment || autoTabRef.current === selectedDeployment.id) return;
    autoTabRef.current = selectedDeployment.id;
    setStageTab(selectedDeployment.status === 'success' ? 'runtime' : 'build');
  }, [isLiveMode, selectedDeployment]);

  // 2. Logs en vivo (SSE para modo 'live' o para un despliegue en progreso)
  const [liveRows, setLiveRows] = useState<Row[]>([]);
  const [liveNotice, setLiveNotice] = useState<string | null>(null);
  // El servidor ya está enganchado al contenedor: a partir de aquí, una consola
  // vacía es que la aplicación no ha escrito nada, no que estemos cargando.
  const [attached, setAttached] = useState(false);
  // Se incrementa para reabrir el stream a mano cuando el navegador lo da por perdido.
  const [streamGen, setStreamGen] = useState(0);
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
  const streamKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isLiveMode) return;

    // El buffer solo se vacía al cambiar de servicio. Al reabrir el stream
    // (conexión perdida, vuelta desde un despliegue) se conserva lo leído: el
    // servidor reenvía la cola y las repetidas se descartan por cursor.
    if (streamKeyRef.current !== serviceId) {
      streamKeyRef.current = serviceId;
      setLiveRows([]);
      setAttached(false);
      setReachedStart(false);
      reachedStartRef.current = false;
      seenRef.current = new Set();
    }
    setLiveNotice(null);
    setLoadingOlder(false);
    loadingOlderRef.current = false;
    followingRef.current = true;
    let retryTimer = 0;

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
    es.addEventListener('attached', () => {
      setLiveNotice(null);
      setAttached(true);
    });
    /*
     * Sin esto, una conexión caída era invisible: la consola seguía diciendo
     * «En vivo» y no llegaba nada. Si el navegador reintenta solo (CONNECTING)
     * basta con avisar; si la da por perdida (CLOSED: sesión caducada, 404…)
     * se reabre a mano a los pocos segundos.
     */
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setLiveNotice('Conexión perdida con el servidor. Reintentando…');
        retryTimer = window.setTimeout(() => setStreamGen((g) => g + 1), 5000);
      } else {
        setLiveNotice('Reconectando…');
      }
    };

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (retryTimer) window.clearTimeout(retryTimer);
      es.close();
    };
  }, [serviceId, isLiveMode, streamGen]);

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
      /*
       * Docker filtra `until` por segundos, así que la página puede traer
       * líneas del mismo segundo que el ancla, posteriores a ella. Se quedan
       * solo las estrictamente anteriores (el cursor RFC3339 ordena como
       * texto): si no, iban a parar ENCIMA de líneas más antiguas.
       */
      const fresh = res.lines.filter((r) => (!r.cursor || r.cursor < before) && (!r.cursor || !seen.has(r.cursor)));
      for (const r of fresh) if (r.cursor) seen.add(r.cursor);
      if (fresh.length) {
        setLiveRows((prev) => {
          let next = fresh.concat(prev);
          // Al pasarse del tope se recorta por DELANTE (lo más antiguo): antes
          // se cortaba por el final y desaparecían justo las líneas más nuevas.
          if (next.length > CAP_READING) {
            const cut = next.length - CAP_READING;
            for (let i = 0; i < cut; i++) {
              const c = next[i].cursor;
              if (c) seen.delete(c);
            }
            next = next.slice(cut);
          }
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

  // 3. Consulta de logs por despliegue
  const targetDepId = isLiveMode ? currentSuccessDeploy?.id : selectedDepId;
  const isBuildingSelected = !isLiveMode && !!selectedDeployment && isActiveDeploy(selectedDeployment.status);
  /*
   * En vivo, el build de la versión vigente ya no cambia y la salida de la
   * aplicación llega por el stream: solo hace falta pedirla cuando se lee
   * Compilación o cuando el contenedor no da nada (parado). Antes se pedían
   * 3000 líneas a Docker cada 4 s por cada pestaña abierta, mirase lo que
   * mirase quien la tenía abierta.
   */
  const needsDeploymentLogs = !isLiveMode
    ? !isBuildingSelected
    : stageTab === 'build' || (liveRows.length === 0 && !attached && liveNotice !== null);
  const deploymentLogsQuery = useQuery({
    queryKey: ['deploymentLogs', targetDepId],
    queryFn: () => api.get<DeploymentLogsResponse>(`/deployments/${targetDepId}/logs`),
    enabled: !!targetDepId && needsDeploymentLogs,
    refetchInterval: isLiveMode && liveRows.length === 0 && !attached ? 10_000 : false,
  });

  // 4. Stream en vivo del build EN CURSO: el despliegue elegido si se está
  //    construyendo o, en vivo, el que esté saliendo ahora. Antes, con la
  //    consola en vivo, «Compilación» enseñaba el build de la versión
  //    ANTERIOR mientras la nueva se compilaba sin que se viera en ningún sitio.
  const [buildingLines, setBuildingLines] = useState<string[]>([]);
  const buildStreamId = isLiveMode ? activeDeploy?.id ?? null : isBuildingSelected ? selectedDepId : null;

  // Al arrancar un despliegue con la consola en vivo se pasa a Compilación una
  // vez: es el momento en que se quiere ver. Después manda quien lee.
  const autoBuildRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isLiveMode || !activeDeploy || autoBuildRef.current === activeDeploy.id) return;
    autoBuildRef.current = activeDeploy.id;
    setStageTab('build');
  }, [isLiveMode, activeDeploy]);

  useEffect(() => {
    if (!buildStreamId) return;
    setBuildingLines([]);
    const pending: string[] = [];
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (!pending.length) return;
      const add = pending.splice(0);
      setBuildingLines((prev) => (prev.length ? prev.concat(add) : add));
    };
    const es = openStream(`/deployments/${buildStreamId}/logs/stream`);
    es.addEventListener('snapshot', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data);
      pending.length = 0;
      setBuildingLines(data.logs ? data.logs.split('\n').filter(Boolean) : []);
    });
    es.addEventListener('log', (ev) => {
      // Un build escupe ráfagas de cientos de líneas: se agrupan por frame en
      // vez de forzar un render por línea, que en el móvil se notaba a tirones.
      pending.push(JSON.parse((ev as MessageEvent).data).line);
      if (!raf) raf = requestAnimationFrame(flush);
    });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      es.close();
    };
  }, [buildStreamId]);

  // 5. Consolidación de líneas para el visor
  const depData = deploymentLogsQuery.data;
  const { displayLines, emptyNote } = useMemo(() => {
    const split = (text: string | null | undefined) => (text ? text.split('\n').filter(Boolean) : []);
    const bLines = split(depData?.buildLogs);
    const rLines = split(depData?.runtimeLogs);

    /*
     * Cada pestaña enseña SOLO lo suyo. Antes, sin salida de aplicación se
     * colaba el build bajo el rótulo «Aplicación», y en vivo sin datos del
     * despliegue se colaba la aplicación bajo «Compilación»: quien leía no
     * podía saber qué estaba mirando. Si no hay nada, se dice por qué.
     */
    if (stageTab === 'build') {
      if (buildStreamId) return { displayLines: buildingLines, emptyNote: 'Esperando la primera línea del build…' };
      if (depData && bLines.length === 0) {
        return { displayLines: bLines, emptyNote: 'Este despliegue no dejó salida de compilación.' };
      }
      return { displayLines: bLines, emptyNote: null };
    }

    if (isLiveMode) {
      if (liveRows.length > 0) {
        return { displayLines: liveRows.map((r) => (r.cursor ? `${r.cursor} ${r.line}` : r.line)), emptyNote: null };
      }
      /*
       * Enganchados y sin líneas: el contenedor existe y no ha escrito nada.
       * Sin contenedor (aviso del servidor): lo último que se archivó del
       * despliegue vigente, si hay. Antes se enseñaban 3000 líneas del archivo
       * y un segundo después el stream las sustituía por sus 200: parecía que
       * el log se borraba solo.
       */
      if (attached) return { displayLines: [], emptyNote: 'La aplicación todavía no ha escrito nada.' };
      if (liveNotice) {
        return {
          displayLines: rLines,
          emptyNote: depData && rLines.length === 0 ? 'No hay contenedor ni salida archivada de esta versión.' : null,
        };
      }
      return { displayLines: [], emptyNote: null };
    }

    if (isBuildingSelected) {
      return { displayLines: [], emptyNote: 'Este despliegue aún se está construyendo: la aplicación no ha arrancado.' };
    }
    return {
      displayLines: rLines,
      emptyNote:
        depData && rLines.length === 0 ? 'Este despliegue no guardó salida de la aplicación. Mira Compilación.' : null,
    };
  }, [isLiveMode, liveRows, isBuildingSelected, buildStreamId, buildingLines, depData, stageTab, attached, liveNotice]);

  /*
   * Qué le pasa a la fuente, para que una consola vacía no diga «sin logs»
   * mientras todavía está cargando o cuando la petición ha fallado.
   */
  const liveRuntime = isLiveMode && stageTab === 'runtime';
  const viewerState: 'loading' | 'error' | 'ready' =
    displayLines.length > 0
      ? 'ready'
      : liveRuntime
        ? attached || liveNotice
          ? liveNotice && needsDeploymentLogs && deploymentLogsQuery.isLoading
            ? 'loading'
            : 'ready'
          : 'loading'
        : deploymentLogsQuery.isError && !isBuildingSelected
          ? 'error'
          : deploymentLogsQuery.isLoading && needsDeploymentLogs
            ? 'loading'
            : 'ready';

  // Descarga del log
  // Estables para que el visor (en `memo`) no reciba funciones nuevas en cada render.
  const handleFollowChange = useCallback((f: boolean) => {
    followingRef.current = f;
  }, []);
  const refetchDeploymentLogs = deploymentLogsQuery.refetch;
  const handleRetry = useCallback(() => {
    void refetchDeploymentLogs();
  }, [refetchDeploymentLogs]);

  const handleDownload = useCallback(async () => {
    try {
      if (isLiveMode && stageTab === 'runtime' && liveRows.length > 0) {
        const res = await fetch(`/api/services/${serviceId}/logs/download?timestamps=1`, {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error();
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `logs-app-${serviceId}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
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
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
    } catch {
      toast('No se pudo descargar el log', 'err');
    }
  }, [isLiveMode, stageTab, liveRows.length, serviceId, targetDepId, toast]);

  // Helper para el color del punto de estado:
  // Verde: Activo
  // Ámbar: En curso
  // Rojo: Fallido / Crasheado
  // Gris: Inactivo / Histórico pasado
  const getDotClass = (d: Deployment) => {
    if (d.id === currentSuccessDeploy?.id) return 'bg-ok pulse-soft';
    if (isActiveDeploy(d.status)) return 'bg-warn pulse-soft';
    if (d.status === 'failed' || d.error) return 'bg-err';
    return 'bg-subtle'; // Gris para despliegues inactivos/pasados
  };

  const getFriendlyTitle = (d: Deployment) => {
    if (d.commit_msg) return d.commit_msg;
    if (d.trigger === 'rollback') return 'Vuelta a una versión anterior';
    if (d.trigger === 'github') return `Push a rama ${d.commit_sha ? `(${d.commit_sha.slice(0, 7)})` : ''}`;
    return 'Despliegue manual';
  };

  return (
    <div className="flex min-h-0 h-full flex-1 flex-col overflow-hidden p-2.5 sm:p-4">
      {/* ── BARRA SUPERIOR ESTILO RAILWAY: SELECTOR DE DESPLIEGUE + SUBPESTAÑAS LIMPIAS ── */}
      <div className="mb-2 flex flex-col gap-2 rounded-xl border border-line bg-surface p-2 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        {/* Selector de despliegue desplegable con nombres amigables */}
        <div className="relative min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setSelectorOpen((o) => !o)}
            aria-expanded={selectorOpen}
            aria-haspopup="menu"
            className={cx(
              'press flex h-9 w-full items-center justify-between gap-2.5 rounded-lg border border-line bg-surface2/70 px-3 text-xs font-medium transition-colors hover:bg-surface2 max-sm:h-10',
              isLiveMode ? 'text-txt border-line' : 'text-acc-soft border-acc/40 bg-acc/5',
            )}
          >
            {isLiveMode ? (
              <div className="flex min-w-0 items-center gap-2 truncate">
                <span className="pulse-soft h-2 w-2 shrink-0 rounded-full bg-ok" />
                <span className="truncate font-semibold">Despliegue actual (En vivo)</span>
                {activeDeploy && (
                  <span className="shrink-0 rounded bg-warn/15 px-1 py-0.5 text-micro font-semibold text-warn">
                    {DEPLOY_STATUS_LABEL[activeDeploy.status]}
                  </span>
                )}
                {currentSuccessDeploy && (
                  <span className="hidden font-mono text-xs text-subtle md:inline">
                    · {currentSuccessDeploy.commit_msg ? currentSuccessDeploy.commit_msg.slice(0, 32) : currentSuccessDeploy.id.slice(0, 12)}
                  </span>
                )}
              </div>
            ) : (
              <div className="flex min-w-0 items-center gap-2 truncate">
                <span className={cx('h-2 w-2 shrink-0 rounded-full', selectedDeployment ? getDotClass(selectedDeployment) : 'bg-subtle')} />
                <span className="truncate font-medium">
                  {selectedDeployment ? getFriendlyTitle(selectedDeployment) : selectedDepId}
                </span>
                {selectedDeployment?.commit_sha && (
                  <span className="hidden font-mono text-subtle sm:inline">
                    · {selectedDeployment.commit_sha.slice(0, 7)}
                  </span>
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

          {/* Antes solo se cerraba con onMouseLeave: inalcanzable en táctil. */}
          <Menu
            open={selectorOpen}
            onClose={() => setSelectorOpen(false)}
            align="left"
            className="max-h-[min(380px,60dvh)] w-full min-w-0 overflow-y-auto overscroll-contain sm:min-w-[290px] sm:w-[360px]"
          >
            <div>
              <div className="px-2.5 py-1.5 eyebrow text-subtle">
                Seleccionar despliegue
              </div>

              {/* Opción En Vivo / Despliegue Actual */}
              <button
                type="button"
                onClick={() => {
                  setSelectedDepId('live');
                  setSelectorOpen(false);
                }}
                role="menuitemradio"
                aria-checked={isLiveMode}
                className={cx(
                  'flex min-h-10 w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors',
                  isLiveMode ? 'bg-acc/10 font-semibold text-txt' : 'hover:bg-surface2',
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="pulse-soft h-2 w-2 shrink-0 rounded-full bg-ok" />
                  <div className="min-w-0">
                    <p className="font-semibold text-txt">Despliegue actual (En vivo)</p>
                    <p className="truncate text-xs text-subtle">
                      {currentSuccessDeploy ? getFriendlyTitle(currentSuccessDeploy) : 'Salida en directo'}
                    </p>
                  </div>
                </div>
                {isLiveMode && <Check size={14} className="text-acc shrink-0" />}
              </button>

              <div className="my-1.5 border-t border-line" />
              <div className="px-2.5 py-1 eyebrow text-subtle">
                Historial ({deployments.length})
              </div>

              {deployments.map((d) => {
                const isSelected = !isLiveMode && selectedDepId === d.id;
                const isCur = d.id === currentSuccessDeploy?.id;
                const dotColor = getDotClass(d);
                const titleText = getFriendlyTitle(d);
                const shortId = d.id.replace(/^dep_|^dep-/, '').slice(0, 8);

                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => {
                      setSelectedDepId(d.id);
                      setSelectorOpen(false);
                    }}
                    role="menuitemradio"
                    aria-checked={isSelected}
                    className={cx(
                      'flex min-h-10 w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors',
                      isSelected ? 'bg-acc/10 font-semibold text-txt' : 'hover:bg-surface2',
                    )}
                  >
                    <div className="min-w-0 flex-1 pr-2">
                      <div className="flex items-center gap-1.5">
                        <span className={cx('h-2 w-2 shrink-0 rounded-full', dotColor)} />
                        <span className="truncate font-semibold text-txt text-xs">{titleText}</span>
                        {isCur && (
                          <span className="shrink-0 rounded bg-ok/15 px-1 py-0.5 text-micro font-semibold text-ok">
                            Activo
                          </span>
                        )}
                        {d.status === 'failed' && (
                          <span className="shrink-0 rounded bg-err/15 px-1 py-0.5 text-micro font-semibold text-err">
                            Falló
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate font-mono text-micro text-subtle">
                        {d.commit_sha ? `${d.commit_sha.slice(0, 7)} · ` : ''}
                        dep-{shortId} · {timeAgo(d.created_at)}
                        {d.finished_at ? ` · ${fmtDuration(d.finished_at - d.created_at)}` : ''}
                      </p>
                    </div>
                    {isSelected && <Check size={14} className="text-acc shrink-0" />}
                  </button>
                );
              })}
            </div>
          </Menu>
        </div>

        {/* Qué se está leyendo: lo que escribe la app, o lo que escribió el build.
            En el móvil ocupa su fila entera y se reparte: dos pastillas anchas
            que se aciertan con el pulgar. */}
        <Segmented
          full
          className="sm:w-fit"
          label="Origen de los logs"
          value={stageTab}
          onChange={setStageTab}
          options={[
            { key: 'runtime', label: 'Aplicación', icon: <Terminal size={13} aria-hidden /> },
            { key: 'build', label: 'Compilación', icon: <Code2 size={13} aria-hidden /> },
          ]}
        />
      </div>

      {/* ── VISOR DE LOGS PROFESIONAL RESPONSIVO CON SCROLL Y TIMESTAMPS GARANTIZADOS ── */}
      <LogViewer
        lines={displayLines}
        toolbar
        replicas={replicas}
        state={viewerState}
        onRetry={handleRetry}
        emptyMessage={emptyNote ?? undefined}
        statusNote={
          isLiveMode && stageTab === 'runtime'
            ? liveNotice
            : buildStreamId && stageTab === 'build'
              ? `${DEPLOY_STATUS_LABEL[(isLiveMode ? activeDeploy : selectedDeployment)?.status ?? 'building']} en directo…`
              : !isLiveMode && selectedDeployment?.error
                ? `Error: ${selectedDeployment.error}`
                : null
        }
        onLoadOlder={isLiveMode && stageTab === 'runtime' ? loadOlderLive : undefined}
        canLoadOlder={isLiveMode && stageTab === 'runtime' && liveRows.length > 0 && !reachedStart}
        loadingOlder={loadingOlder}
        onDownload={handleDownload}
        onFollowChange={handleFollowChange}
        downloadName={
          isLiveMode
            ? `logs-app-${serviceId}.txt`
            : `deploy-${targetDepId}.txt`
        }
        // Sin mínimo en móvil: con el teclado abierto el visor se salía del panel y el final quedaba fuera de alcance.
        className="min-h-0 flex-1 sm:min-h-[300px]"
      />
    </div>
  );
}
