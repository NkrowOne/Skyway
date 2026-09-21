import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Database, XCircle } from 'lucide-react';
import { api, openStream } from '../api';
import { Button, Field, Modal, useToast } from './ui';
import LogViewer from './LogViewer';

/**
 * Copia de datos desde una base externa (la de Railway, normalmente) a la base
 * gestionada del proyecto.
 *
 * Antes esto era un comando `docker run` del informe de importación que había
 * que ejecutar por SSH: el paso que convertía «migrar en una tarde» en «migrar
 * el fin de semana». Aquí se lanza desde el panel y el volcado se ve en vivo.
 */

type Status = 'running' | 'success' | 'failed' | 'canceled';

interface MigrationState {
  supported: boolean;
  template: string | null;
  migration: { status: Status; logs: string; error: string | null } | null;
}

/**
 * Tope de líneas en pantalla. Un volcado grande escupe decenas de miles y
 * pintarlas todas convierte el móvil en un ladrillo; el log completo sigue en
 * el servidor y es lo que baja el botón de descarga.
 */
const MAX_LINES = 8000;

export default function DataMigrationModal({
  open,
  onClose,
  serviceId,
  serviceName,
  defaultSourceUrl,
}: {
  open: boolean;
  onClose: () => void;
  serviceId: string;
  serviceName: string;
  defaultSourceUrl?: string | null;
}) {
  const toast = useToast();
  const [sourceUrl, setSourceUrl] = useState(defaultSourceUrl ?? '');
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [probe, setProbe] = useState<{ ok: boolean; message: string } | null>(null);
  const [streamLost, setStreamLost] = useState(false);
  const streamRef = useRef<EventSource | null>(null);
  // Líneas recibidas y aún no pintadas: se vuelcan de una vez por frame en
  // vez de un setState por línea, que con un dump rápido encolaba cientos de
  // renders por segundo y congelaba el desplazamiento.
  const pendingRef = useRef<string[]>([]);
  const rafRef = useRef(0);

  const flush = () => {
    rafRef.current = 0;
    if (pendingRef.current.length === 0) return;
    const chunk = pendingRef.current;
    pendingRef.current = [];
    setLines((prev) => {
      const next = prev.length + chunk.length > MAX_LINES ? [...prev, ...chunk].slice(-MAX_LINES) : [...prev, ...chunk];
      return next;
    });
  };

  const push = (line: string) => {
    pendingRef.current.push(line);
    if (!rafRef.current) rafRef.current = requestAnimationFrame(flush);
  };

  const cancelFlush = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    pendingRef.current = [];
  };

  const state = useQuery({
    queryKey: ['dataMigration', serviceId],
    queryFn: () => api.get<MigrationState>(`/services/${serviceId}/data-migration`),
    enabled: open,
  });

  /** Sigue el log en vivo. Se abre al lanzar y al reencontrar una copia en curso. */
  const attach = () => {
    streamRef.current?.close();
    cancelFlush();
    setStreamLost(false);
    const es = openStream(`/services/${serviceId}/data-migration/stream`);
    streamRef.current = es;
    es.addEventListener('snapshot', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { logs: string; status: Status | null };
      cancelFlush();
      setLines(data.logs ? data.logs.split('\n').filter(Boolean).slice(-MAX_LINES) : []);
      setStatus(data.status);
    });
    es.addEventListener('log', (ev) => {
      const { line } = JSON.parse((ev as MessageEvent).data) as { line: string };
      push(line);
    });
    es.addEventListener('done', (ev) => {
      const { status: final } = JSON.parse((ev as MessageEvent).data) as { status: Status };
      flush();
      setStatus(final);
      // Se suelta la referencia antes de cerrar: un onerror rezagado de este
      // stream ya no debe contarse como conexión perdida.
      if (streamRef.current === es) streamRef.current = null;
      es.close();
      if (final === 'success') toast('Se han copiado los datos', 'ok');
      else if (final === 'failed') toast('La copia de datos ha fallado. Consulte el registro.', 'err');
    });
    es.onerror = () => {
      // El servidor cierra el stream al terminar y eso también dispara onerror;
      // solo es una pérdida real si el navegador ha dejado de reintentar
      // (CLOSED) y la copia seguía en marcha por lo que sabíamos.
      if (es.readyState === EventSource.CLOSED && streamRef.current === es) {
        flush();
        setStreamLost(true);
      }
    };
  };

  // Una copia lanzada antes de abrir el modal (o desde otra pestaña) se retoma.
  // Depende del estado en sí, no de «¿está en marcha?»: una copia que llegaba
  // ya terminada (success/failed) en la primera carga no disparaba el enganche
  // y su log archivado no aparecía nunca.
  const migrationStatus = state.data?.migration?.status ?? null;
  useEffect(() => {
    if (open && migrationStatus) attach();
    return () => {
      streamRef.current?.close();
      cancelFlush();
    };
    // `attach` cambia de identidad en cada render; abrirlo por cada render sería peor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, migrationStatus]);

  useEffect(() => {
    if (!open) {
      streamRef.current?.close();
      streamRef.current = null;
      cancelFlush();
    }
  }, [open]);

  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string }>(`/services/${serviceId}/data-migration/test`, { sourceUrl }),
    onSuccess: (res) =>
      setProbe(res.ok ? { ok: true, message: 'El origen responde correctamente.' } : { ok: false, message: res.error ?? 'Sin detalle disponible' }),
    onError: (err: Error) => setProbe({ ok: false, message: err.message }),
  });

  const start = useMutation({
    mutationFn: () => api.post(`/services/${serviceId}/data-migration`, { sourceUrl }),
    onSuccess: () => {
      setLines([]);
      setStatus('running');
      attach();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const cancel = useMutation({
    mutationFn: () => api.post(`/services/${serviceId}/data-migration/cancel`),
    onError: (err: Error) => toast(err.message, 'err'),
  });

  /**
   * Descarga el log entero desde el servidor, no lo que hay en pantalla: con
   * el tope de líneas, lo pintado puede ser solo la cola del volcado.
   */
  const downloadFull = async () => {
    try {
      const res = await api.get<MigrationState>(`/services/${serviceId}/data-migration`);
      const text = res.migration?.logs || lines.join('\n');
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `copia-${serviceName}.log`;
      a.click();
      // Revocar en diferido: hacerlo síncrono puede abortar la descarga.
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) {
      toast((err as Error).message, 'err');
    }
  };

  const running = status === 'running';
  const supported = state.data?.supported ?? false;

  return (
    <Modal open={open} onClose={() => { if (!running) onClose(); }} title={`Copiar datos a «${serviceName}»`} wide>
      {!supported ? (
        <p className="rounded-lg border border-line bg-bg px-3.5 py-3 text-xs text-sub">
          La copia de datos de este motor todavía no está disponible desde el panel. Utilice las herramientas del propio motor
          o el comando del informe de importación.
        </p>
      ) : (
        <>
          <p className="text-xs text-sub">
            Vuelca la base de datos de origen sobre la de este servicio. El destino <b>se sobrescribe</b>: se recomienda
            realizarlo antes de que la aplicación empiece a escribir en él, o crear una copia de seguridad previamente.
          </p>

          <div className="mt-4">
            <Field
              label="URL de conexión del origen"
              hint="La URL pública de Railway (DATABASE_PUBLIC_URL y equivalentes). Es necesario que el TCP Proxy esté activo para que este servidor pueda conectarse."
              error={probe && !probe.ok ? probe.message : null}
            >
              {/* type="text" y no "url": el navegador solo admite esquemas
                  «conocidos» y rechazaría mongodb+srv:// o rediss://. */}
              <input
                className="input font-mono sm:text-xs"
                placeholder="postgresql://usuario:clave@monorail.proxy.rlwy.net:12345/railway"
                value={sourceUrl}
                onChange={(e) => {
                  setSourceUrl(e.target.value);
                  setProbe(null);
                }}
                disabled={running}
                spellCheck={false}
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
              />
            </Field>
            {probe?.ok && (
              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-ok">
                <CheckCircle2 size={12} /> {probe.message}
              </p>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => test.mutate()}
              loading={test.isPending}
              disabled={running || sourceUrl.trim().length < 8}
            >
              Comprobar origen
            </Button>
            <Button
              size="sm"
              onClick={() => start.mutate()}
              loading={start.isPending}
              disabled={running || sourceUrl.trim().length < 8}
            >
              <Database size={13} /> Copiar datos
            </Button>
            {running && (
              <Button variant="ghost" size="sm" className="text-err hover:bg-err/[.1]" onClick={() => cancel.mutate()}>
                <XCircle size={13} /> Cancelar
              </Button>
            )}
            {status === 'success' && (
              <span className="flex items-center gap-1.5 text-xs text-ok">
                <CheckCircle2 size={13} /> Copia completada
              </span>
            )}
            {status === 'failed' && (
              <span className="flex items-center gap-1.5 text-xs text-err">
                <AlertTriangle size={13} /> La copia ha fallado
              </span>
            )}
          </div>

          {(lines.length > 0 || streamLost) && (
            <div className="mt-4">
              {/* dvh y no vh: en móvil el vh cuenta la barra del navegador y el
                  visor se salía de la hoja inferior. */}
              <LogViewer
                lines={lines}
                toolbar
                title="Copia de datos"
                downloadName={`copia-${serviceName}.log`}
                onDownload={() => void downloadFull()}
                className="h-[min(46dvh,380px)]"
                state={streamLost ? 'error' : 'ready'}
                onRetry={streamLost ? attach : undefined}
                statusNote={
                  streamLost
                    ? 'Se ha perdido la conexión con el servidor; el registro puede estar incompleto. Vuelva a conectar para continuar.'
                    : lines.length >= MAX_LINES
                      ? `Se muestran las últimas ${MAX_LINES} líneas; el registro completo está disponible en la descarga.`
                      : null
                }
              />
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
