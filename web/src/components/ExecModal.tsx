import { useState } from 'react';
import { Terminal } from 'lucide-react';
import { api } from '../api';
import { cx } from '../utils';
import { Button, Modal, useToast } from './ui';

interface ExecResult {
  output: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

const QUICK_COMMANDS = ['ls -la', 'env | sort', 'ps aux', 'df -h'];

/** Terminal de un solo comando dentro del contenedor (migraciones, inspección...). */
export default function ExecModal({
  open,
  onClose,
  serviceId,
  serviceName,
}: {
  open: boolean;
  onClose: () => void;
  serviceId: string;
  serviceName: string;
}) {
  const toast = useToast();
  const [command, setCommand] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ExecResult | null>(null);

  const run = async (cmd: string) => {
    if (!cmd.trim() || running) return;
    setRunning(true);
    setResult(null);
    try {
      const res = await api.post<{ result: ExecResult }>(`/services/${serviceId}/exec`, { command: cmd });
      setResult(res.result);
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Ejecutar comando — ${serviceName}`} wide>
      <div className="space-y-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(command);
          }}
        >
          <div className="relative flex-1">
            <Terminal size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-sub" />
            <input
              className="input pl-9 font-mono text-xs"
              placeholder="npm run migrate"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              autoFocus
              spellCheck={false}
            />
          </div>
          <Button type="submit" loading={running}>
            Ejecutar
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-1.5 text-xs text-sub">
          <span>Rápidos:</span>
          {QUICK_COMMANDS.map((c) => (
            <button
              key={c}
              className="rounded-md border border-line bg-surface2 px-2 py-0.5 font-mono text-[11px] hover:border-acc/50"
              onClick={() => {
                setCommand(c);
                run(c);
              }}
            >
              {c}
            </button>
          ))}
        </div>

        <div className="relative">
          <pre className="h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-term p-3 font-mono text-[11.5px] leading-relaxed text-txt/[.88]">
            {running ? 'Ejecutando...' : result ? result.output || '(sin salida)' : 'La salida aparecerá aquí. El comando corre con `sh -c` dentro del contenedor.'}
          </pre>
          {result && (
            <span
              className={cx(
                'absolute right-2 top-2 rounded-full border px-2 py-0.5 text-[11px]',
                result.exitCode === 0 ? 'border-ok/40 bg-ok/10 text-ok' : 'border-err/40 bg-err/10 text-err',
              )}
            >
              {result.timedOut ? 'timeout 60s' : `exit ${result.exitCode ?? '?'}`} · {(result.durationMs / 1000).toFixed(1)}s
              {result.truncated ? ' · salida truncada' : ''}
            </span>
          )}
        </div>
        <p className="text-xs text-subtle">
          Útil para migraciones (<span className="font-mono">npm run migrate</span>,{' '}
          <span className="font-mono">npx prisma migrate deploy</span>...). Cada ejecución queda en el registro de
          actividad. Límite: 60 s.
        </p>
      </div>
    </Modal>
  );
}
