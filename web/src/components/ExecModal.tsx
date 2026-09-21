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
              className="input pl-9 font-mono sm:text-xs"
              placeholder="npm run migrate"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              autoFocus
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
            />
          </div>
          <Button type="submit" loading={running}>
            Ejecutar
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-1.5 text-xs text-sub">
          <span>Comandos rápidos:</span>
          {QUICK_COMMANDS.map((c) => (
            <button
              key={c}
              type="button"
              className="press rounded-md border border-line bg-surface2 px-2 py-0.5 font-mono text-xs transition-colors duration-150 hover:border-acc/50 max-sm:py-1.5"
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
          {/* En móvil la salida se acota al 40 % de la pantalla real (dvh): con
              el teclado abierto, 288 px fijos dejaban el campo de comando fuera. */}
          <pre className="h-[min(288px,40dvh)] overflow-auto overscroll-contain whitespace-pre-wrap break-all rounded-lg border border-line bg-term p-3 font-mono text-xs leading-relaxed text-txt/[.88] sm:h-72">
            {running ? 'Ejecutando…' : result ? result.output || '(sin salida)' : 'La salida se mostrará aquí. El comando se ejecuta con `sh -c` dentro del contenedor.'}
          </pre>
          {result && (
            <span
              className={cx(
                'absolute right-2 top-2 rounded-full border px-2 py-0.5 text-xs',
                result.exitCode === 0 ? 'border-ok/40 bg-ok/10 text-ok' : 'border-err/40 bg-err/10 text-err',
              )}
            >
              {result.timedOut ? 'tiempo de espera agotado (60 s)' : `código de salida ${result.exitCode ?? '?'}`} · {(result.durationMs / 1000).toFixed(1)}s
              {result.truncated ? ' · salida truncada' : ''}
            </span>
          )}
        </div>
        <p className="text-xs text-subtle">Límite de 60 s. La ejecución se anota en el registro de actividad.</p>
      </div>
    </Modal>
  );
}
