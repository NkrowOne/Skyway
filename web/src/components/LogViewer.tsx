import { useEffect, useRef, useState } from 'react';
import { cx } from '../utils';

/**
 * Visor de logs con autoscroll inteligente: sigue el final salvo que el
 * usuario haya subido manualmente.
 */
export default function LogViewer({ lines, className }: { lines: string[]; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (follow && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [lines, follow]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setFollow(atBottom);
  };

  return (
    <div className="relative">
      <div
        ref={ref}
        onScroll={onScroll}
        className={cx(
          'overflow-y-auto rounded-lg border border-line bg-ink p-3 font-mono text-[11.5px] leading-relaxed text-txt/90',
          className ?? 'h-72',
        )}
      >
        {lines.length === 0 ? (
          <span className="text-sub/60">Sin logs todavía...</span>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              {line}
            </div>
          ))
        )}
      </div>
      {!follow && (
        <button
          onClick={() => {
            setFollow(true);
            if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
          }}
          className="absolute bottom-3 right-3 rounded-full border border-line bg-panel2 px-3 py-1 text-xs text-sub shadow-lg hover:text-txt"
        >
          ↓ Seguir
        </button>
      )}
    </div>
  );
}
