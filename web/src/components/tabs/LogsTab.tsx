import { useEffect, useState } from 'react';
import { openStream } from '../../api';
import LogViewer from '../LogViewer';

export default function LogsTab({ serviceId }: { serviceId: string }) {
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
    <div className="p-4">
      {notice && <p className="mb-2 text-xs text-sub">{notice}</p>}
      <LogViewer lines={lines} className="h-[calc(100vh-280px)]" />
    </div>
  );
}
