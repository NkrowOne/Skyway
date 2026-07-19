import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { openStream } from '../../api';
import LogViewer from '../LogViewer';
import { Button } from '../ui';

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

  const download = () => {
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logs-${serviceId}-${new Date().toISOString().slice(0, 19)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs text-sub">{notice ?? `${lines.length} líneas en memoria`}</p>
        <Button size="sm" variant="ghost" onClick={download} disabled={lines.length === 0} title="Descargar logs visibles">
          <Download size={13} /> Descargar
        </Button>
      </div>
      <LogViewer lines={lines} className="h-[calc(100vh-320px)]" />
    </div>
  );
}
