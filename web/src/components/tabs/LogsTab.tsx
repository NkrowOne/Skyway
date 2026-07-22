import { useEffect, useState } from 'react';
import { openStream } from '../../api';
import LogViewer from '../LogViewer';

export default function LogsTab({ serviceId, replicas = 1 }: { serviceId: string; replicas?: number }) {
  const [lines, setLines] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setLines([]);
    setNotice(null);
    // Buffer holgado (la consola virtualiza) + coalescencia por frame: una ráfaga
    // de líneas produce un único re-render, no uno por línea.
    const pending: string[] = [];
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (!pending.length) return;
      const incoming = pending.splice(0);
      setLines((prev) => {
        const next = prev.length ? prev.concat(incoming) : incoming;
        return next.length > 50_000 ? next.slice(next.length - 50_000) : next;
      });
    };
    const es = openStream(`/services/${serviceId}/logs/stream`);
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
  }, [serviceId]);

  return (
    <div className="flex flex-1 flex-col p-4 sm:px-5">
      <LogViewer
        lines={lines}
        toolbar
        title="Logs en vivo"
        replicas={replicas}
        statusNote={notice}
        downloadName={`logs-${serviceId}-${new Date().toISOString().slice(0, 19)}.txt`}
        className="min-h-[280px] flex-1"
      />
    </div>
  );
}
