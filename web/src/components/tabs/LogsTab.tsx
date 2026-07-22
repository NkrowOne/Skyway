import { useEffect, useRef, useState } from 'react';
import { openStream } from '../../api';
import LogViewer from '../LogViewer';

// Historial inicial ligero (primer pintado rápido en móvil) que «Cargar más»
// va ampliando; tope alineado con el servidor y holgura bajo el buffer del
// cliente para que cargar todo el historial no recorte por el frente.
const INITIAL_TAIL = 200;
const MAX_TAIL = 5_000;
const BUFFER_CAP = 8_000;

export default function LogsTab({ serviceId, replicas = 1 }: { serviceId: string; replicas?: number }) {
  const [lines, setLines] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // `tail` = cuántas líneas de historial se piden al contenedor. Crece con
  // «Cargar más», que reabre el stream con más cola. El primer lote de cada
  // suscripción REEMPLAZA el buffer (el snapshot ya incluye lo reciente), así
  // pedir más historia no duplica líneas ni deja la consola en blanco.
  const [tail, setTail] = useState(INITIAL_TAIL);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedStart, setReachedStart] = useState(false);
  // Línea más antigua ya cargada: si al pedir más cola no cambia, el contenedor
  // no guarda nada más arriba y se oculta «Cargar más».
  const oldestRef = useRef<string | undefined>(undefined);
  const prevServiceRef = useRef<string | null>(null);

  useEffect(() => {
    const serviceChanged = prevServiceRef.current !== serviceId;
    prevServiceRef.current = serviceId;
    // Al cambiar de servicio se limpia todo; al solo ampliar la cola se conserva
    // lo visible hasta que el primer lote lo reemplaza (sin parpadeo en blanco).
    if (serviceChanged) {
      setLines([]);
      setNotice(null);
      setReachedStart(false);
      oldestRef.current = undefined;
    }

    // Buffer de cola acotado + coalescencia por frame: una ráfaga de líneas
    // produce un único re-render. El primer flush de esta suscripción reemplaza
    // el buffer con el snapshot; los siguientes añaden el vivo por el final.
    let replaceNext = true;
    const pending: string[] = [];
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (!pending.length) return;
      const incoming = pending.splice(0);
      if (replaceNext) {
        replaceNext = false;
        // Docker entrega la cola en orden cronológico: incoming[0] es SIEMPRE la
        // línea más antigua del snapshot, aunque el lote llegue troceado. Si tras
        // ampliar la cola coincide con la que ya teníamos, no hay nada más arriba.
        const newOldest = incoming[0];
        if (!serviceChanged && newOldest !== undefined && newOldest === oldestRef.current) {
          setReachedStart(true);
        }
        oldestRef.current = newOldest;
        setLines(incoming.length > BUFFER_CAP ? incoming.slice(incoming.length - BUFFER_CAP) : incoming);
        setLoadingMore(false);
      } else {
        setLines((prev) => {
          const next = prev.length ? prev.concat(incoming) : incoming;
          return next.length > BUFFER_CAP ? next.slice(next.length - BUFFER_CAP) : next;
        });
      }
    };
    const es = openStream(`/services/${serviceId}/logs/stream?tail=${tail}`);
    es.addEventListener('log', (ev) => {
      pending.push(JSON.parse((ev as MessageEvent).data).line);
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
  }, [serviceId, tail]);

  // «Cargar más»: sube la profundidad de cola (reabre el stream) hasta el tope.
  const loadMore = () => {
    if (loadingMore || reachedStart || tail >= MAX_TAIL) return;
    setLoadingMore(true);
    setTail((t) => Math.min(MAX_TAIL, t < 500 ? 1_000 : t * 2));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4 sm:px-5">
      <LogViewer
        lines={lines}
        toolbar
        title="Logs en vivo"
        replicas={replicas}
        statusNote={notice}
        downloadName={`logs-${serviceId}-${new Date().toISOString().slice(0, 19)}.txt`}
        className="min-h-[280px] flex-1"
        onLoadMore={loadMore}
        canLoadMore={lines.length > 0 && !reachedStart && tail < MAX_TAIL}
        loadingMore={loadingMore}
      />
    </div>
  );
}
