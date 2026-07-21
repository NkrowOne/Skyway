import { useEffect, useState } from 'react';
import { openStream } from '../../api';
import LogViewer from '../LogViewer';

export default function LogsTab({ serviceId, replicas = 1 }: { serviceId: string; replicas?: number }) {
  const [lines, setLines] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setLines([]);
    setNotice(null);
    const es = openStream(`/services/${serviceId}/logs/stream`);
    es.addEventListener('log', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data);
      setLines((prev) => [...prev.slice(-3000), data.line]);
    });
    es.addEventListener('notice', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data);
      setNotice(data.message);
    });
    es.addEventListener('attached', () => setNotice(null));
    return () => es.close();
  }, [serviceId]);

  return (
    <div className="flex flex-1 flex-col p-4 sm:px-5">
      <LogViewer
        lines={lines}
        toolbar
        replicas={replicas}
        statusNote={notice}
        downloadName={`logs-${serviceId}-${new Date().toISOString().slice(0, 19)}.txt`}
        className="min-h-[240px] flex-1"
      />
    </div>
  );
}
