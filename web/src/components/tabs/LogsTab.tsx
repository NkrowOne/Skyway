import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, openStream } from '../../api';
import { useToast } from '../ui';
import LogViewer from '../LogViewer';

type Row = { line: string; cursor: string | null };

// Tope del buffer en vivo: al seguir el final se recorta el frente (historial
// viejo que no se está mirando); mientras se lee hacia arriba se deja crecer más
// para no arrancar lo que se acaba de cargar, con un tope duro de seguridad.
const CAP_FOLLOWING = 12_000;
const CAP_READING = 40_000;
const OLDER_PAGE = 400;

export default function LogsTab({ serviceId, replicas = 1 }: { serviceId: string; replicas?: number }) {
  const toast = useToast();
  const [rows, setRows] = useState<Row[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reachedStart, setReachedStart] = useState(false);

  // Cursores presentes en el buffer: deduplica por coincidencia EXACTA (el sello
  // RFC3339 de Docker recorta ceros finales, así que no es ordenable como texto,
  // pero cada línea llega siempre con el mismo cursor). Evita duplicar la cola
  // que reenvía el stream al reconectar y el solape del segundo frontera al
  // paginar hacia atrás.
  const seenRef = useRef<Set<string>>(new Set());
  const rowsRef = useRef<Row[]>([]);
  const followingRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const reachedStartRef = useRef(false);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    setRows([]);
    setNotice(null);
    setLoadingOlder(false);
    setReachedStart(false);
    reachedStartRef.current = false;
    loadingOlderRef.current = false;
    followingRef.current = true;
    seenRef.current = new Set();

    // Buffer de cola + coalescencia por frame: una ráfaga de líneas produce un
    // único re-render. El visor sigue el final en vivo.
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
      setRows((prev) => {
        let next = prev.length ? prev.concat(add) : add;
        const cap = followingRef.current ? CAP_FOLLOWING : CAP_READING;
        if (next.length > cap) {
          // Recorte por el frente: al soltarse líneas, se sueltan también sus
          // cursores para no rechazar más tarde ese mismo tramo si se recarga
          // como historial. Se hace en el updater (necesita el `prev` real);
          // en StrictMode se invoca dos veces con el mismo `prev`, y como el
          // borrado es idéntico e idempotente el Set queda igualmente coherente.
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
      setNotice(data.message);
    });
    es.addEventListener('attached', () => setNotice(null));
    return () => {
      if (raf) cancelAnimationFrame(raf);
      es.close();
    };
  }, [serviceId]);

  // Carga un tramo de líneas ANTERIORES a la más antigua del buffer y lo
  // antepone. El visor conserva el sitio de lectura al crecer el frente.
  const loadOlder = useCallback(async () => {
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
        setRows((prev) => {
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

  // Descarga el log ÍNTEGRO desde el servidor (todo el buffer del contenedor),
  // no solo lo que el visor tiene en memoria.
  const downloadComplete = useCallback(async () => {
    try {
      const res = await fetch(`/api/services/${serviceId}/logs/download`, { credentials: 'same-origin' });
      if (!res.ok) {
        toast('No se pudo descargar el log', 'err');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `logs-${serviceId}-${new Date().toISOString().slice(0, 19)}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast('No se pudo descargar el log', 'err');
    }
  }, [serviceId, toast]);

  const lines = useMemo(() => rows.map((r) => r.line), [rows]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4 sm:px-5">
      <LogViewer
        lines={lines}
        toolbar
        tailAnchor
        title="Logs en vivo"
        replicas={replicas}
        statusNote={notice}
        onLoadOlder={loadOlder}
        canLoadOlder={!reachedStart && lines.length > 0}
        loadingOlder={loadingOlder}
        reachedStart={reachedStart && lines.length > 0}
        onDownload={downloadComplete}
        onFollowChange={(f) => {
          followingRef.current = f;
        }}
        className="min-h-[280px] flex-1"
      />
    </div>
  );
}
