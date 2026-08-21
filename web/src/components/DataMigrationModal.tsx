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
  const streamRef = useRef<EventSource | null>(null);

  const state = useQuery({
    queryKey: ['dataMigration', serviceId],
    queryFn: () => api.get<MigrationState>(`/services/${serviceId}/data-migration`),
    enabled: open,
  });

  /** Sigue el log en vivo. Se abre al lanzar y al reencontrar una copia en curso. */
  const attach = () => {
    streamRef.current?.close();
    const es = openStream(`/services/${serviceId}/data-migration/stream`);
    streamRef.current = es;
    es.addEventListener('snapshot', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { logs: string; status: Status | null };
      setLines(data.logs ? data.logs.split('\n').filter(Boolean) : []);
      setStatus(data.status);
    });
    es.addEventListener('log', (ev) => {
      const { line } = JSON.parse((ev as MessageEvent).data) as { line: string };
      setLines((prev) => [...prev, line]);
    });
    es.addEventListener('done', (ev) => {
      const { status: final } = JSON.parse((ev as MessageEvent).data) as { status: Status };
      setStatus(final);
      es.close();
      if (final === 'success') toast('Datos copiados', 'ok');
      else if (final === 'failed') toast('La copia de datos falló: revisa el log', 'err');
    });
    es.onerror = () => {
      /* el servidor cierra el stream al terminar */
    };
  };

  // Una copia lanzada antes de abrir el modal (o desde otra pestaña) se retoma.
  useEffect(() => {
    if (open && state.data?.migration) attach();
    return () => streamRef.current?.close();
  }, [open, state.data?.migration?.status === 'running']);

  useEffect(() => {
    if (!open) {
      streamRef.current?.close();
      streamRef.current = null;
    }
  }, [open]);

  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string }>(`/services/${serviceId}/data-migration/test`, { sourceUrl }),
    onSuccess: (res) =>
      setProbe(res.ok ? { ok: true, message: 'El origen responde.' } : { ok: false, message: res.error ?? 'Sin detalle' }),
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

  const running = status === 'running';
  const supported = state.data?.supported ?? false;

  return (
    <Modal open={open} onClose={() => { if (!running) onClose(); }} title={`Copiar datos a «${serviceName}»`} wide>
      {!supported ? (
        <p className="rounded-lg border border-line bg-bg px-3.5 py-3 text-xs text-sub">
          Skyway aún no sabe copiar datos de este motor desde el panel. Usa las herramientas del propio motor o el
          comando del informe de importación.
        </p>
      ) : (
        <>
          <p className="text-xs text-sub">
            Vuelca la base de origen sobre la de este servicio. El destino <b>se sobrescribe</b>: hazlo antes de que la
            aplicación empiece a escribir aquí, o haz un backup primero.
          </p>

          <div className="mt-4">
            <Field
              label="URL de conexión del origen"
              hint="La pública de Railway (DATABASE_PUBLIC_URL y equivalentes). Necesita el TCP Proxy activo para que este servidor llegue."
              error={probe && !probe.ok ? probe.message : null}
            >
              <input
                className="input font-mono text-xs"
                placeholder="postgresql://usuario:clave@monorail.proxy.rlwy.net:12345/railway"
                value={sourceUrl}
                onChange={(e) => {
                  setSourceUrl(e.target.value);
                  setProbe(null);
                }}
                disabled={running}
                spellCheck={false}
              />
            </Field>
            {probe?.ok && (
              <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ok">
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
                <AlertTriangle size={13} /> La copia falló
              </span>
            )}
          </div>

          {lines.length > 0 && (
            <div className="mt-4">
              <LogViewer
                lines={lines}
                toolbar
                title="Copia de datos"
                downloadName={`copia-${serviceName}.log`}
                className="h-[min(46vh,380px)]"
              />
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
