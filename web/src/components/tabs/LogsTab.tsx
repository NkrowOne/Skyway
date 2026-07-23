import { useEffect, useMemo, useRef, useState } from 'react';
import { api, openStream } from '../../api';
import LogViewer from '../LogViewer';

// Vista inicial ligera (primer pintado rápido en móvil). A partir de ahí el
// historial se pagina hacia atrás bajo demanda con «Cargar más», un bloque cada
// vez —no se arrastra todo el buffer—, para mejor rendimiento. El tope solo
// acota la memoria si además el vivo es muy hablador.
const INITIAL_TAIL = 200;
const STEP = 200;
const BUFFER_CAP = 20_000;

type Entry = { line: string; ts: string | null };

export default function LogsTab({ serviceId, replicas = 1 }: { serviceId: string; replicas?: number }) {
  // Cada línea guarda su timestamp de Docker: es el cursor para pedir el
  // siguiente bloque más antiguo. Al visor solo le pasamos el texto.
  const [entries, setEntries] = useState<Entry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedStart, setReachedStart] = useState(false);
  // Servicio activo: para descartar respuestas de «Cargar más» en vuelo si el
  // usuario cambia de servicio antes de que lleguen (no mezclar historiales).
  const serviceRef = useRef(serviceId);
  serviceRef.current = serviceId;

  useEffect(() => {
    setEntries([]);
    setNotice(null);
    setReachedStart(false);
    setLoadingMore(false);
    // Buffer de cola acotado + coalescencia por frame: una ráfaga de líneas
    // produce un único re-render. El vivo se añade por el final; «Cargar más»
    // prepende historial por el frente (más abajo).
    const pending: Entry[] = [];
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (!pending.length) return;
      const incoming = pending.splice(0);
      setEntries((prev) => {
        const next = prev.length ? prev.concat(incoming) : incoming;
        return next.length > BUFFER_CAP ? next.slice(next.length - BUFFER_CAP) : next;
      });
    };
    const es = openStream(`/services/${serviceId}/logs/stream?tail=${INITIAL_TAIL}`);
    es.addEventListener('log', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data);
      pending.push({ line: data.line, ts: data.ts ?? null });
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

  // Referencia estable del texto para que el visor conserve su caché incremental
  // (solo cambia cuando cambian las líneas, no en cada render).
  const displayLines = useMemo(() => entries.map((e) => e.line), [entries]);
  // Cursor de paginación: timestamp de la línea más antigua del buffer.
  const oldestTs = entries.length ? entries[0].ts : null;

  // «Cargar más»: pide UN bloque de líneas anteriores al cursor y lo prepende.
  // La petición se resuelve rápido (lectura local de Docker) y solo trae `STEP`
  // líneas, así el visor puede anclar la posición sin saltos.
  const loadMore = async () => {
    if (loadingMore || reachedStart || !oldestTs) return;
    const sid = serviceId;
    setLoadingMore(true);
    try {
      const res = await api.get<{ lines: Entry[]; reachedStart: boolean }>(
        `/services/${sid}/logs/history?before=${encodeURIComponent(oldestTs)}&limit=${STEP}`,
      );
      // El usuario cambió de servicio mientras llegaba: se descarta.
      if (serviceRef.current !== sid) return;
      if (res.lines.length) {
        setEntries((prev) => {
          // Descarta cualquier solape con el frente actual (por si el borde se
          // repite) y prepende solo lo estrictamente más antiguo.
          const head = prev.length ? prev[0].ts : null;
          const older = head ? res.lines.filter((l) => l.ts && l.ts < head) : res.lines;
          return older.length ? older.concat(prev) : prev;
        });
      }
      if (res.reachedStart || res.lines.length === 0) setReachedStart(true);
    } catch {
      // Silencioso: el usuario puede reintentar con el botón.
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4 sm:px-5">
      <LogViewer
        lines={displayLines}
        toolbar
        title="Logs en vivo"
        replicas={replicas}
        statusNote={notice}
        downloadName={`logs-${serviceId}-${new Date().toISOString().slice(0, 19)}.txt`}
        className="min-h-[280px] flex-1"
        onLoadMore={loadMore}
        canLoadMore={entries.length > 0 && !reachedStart && !!oldestTs}
        loadingMore={loadingMore}
        loadMoreCount={STEP}
        atStart={reachedStart && entries.length > 0}
      />
    </div>
  );
}
