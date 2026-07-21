import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  Columns3,
  Database,
  Download,
  History,
  Play,
  RefreshCw,
  Table2,
  TriangleAlert,
} from 'lucide-react';
import { api } from '../../api';
import { useLocalStorage } from '../../hooks';
import { DbOverview, DbQueryResult, DbSnippet } from '../../types';
import { cx, fmtBytes } from '../../utils';
import { Button, Kbd, Skeleton, useToast } from '../ui';

/** Descarga un contenido como archivo desde el navegador. */
function downloadFile(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revocar en diferido: hacerlo síncrono puede abortar la descarga.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function resultToCsv(result: DbQueryResult): string {
  const rows = [result.columns ?? [], ...(result.rows ?? [])];
  return rows.map((r) => r.map(csvCell).join(',')).join('\n');
}

function resultToJson(result: DbQueryResult): string {
  // Columnas repetidas (SELECT a, b AS a) se renombran para no perder datos.
  const seen = new Map<string, number>();
  const cols = (result.columns ?? []).map((c) => {
    const n = seen.get(c) ?? 0;
    seen.set(c, n + 1);
    return n === 0 ? c : `${c}_${n + 1}`;
  });
  return JSON.stringify(
    (result.rows ?? []).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? '']))),
    null,
    2,
  );
}

const ENGINE_LABEL: Record<DbOverview['engine'], string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mongo: 'MongoDB',
  redis: 'Redis',
};

const PLACEHOLDER: Record<DbOverview['engine'], string> = {
  postgres: 'SELECT * FROM mi_tabla LIMIT 50;',
  mysql: 'SELECT * FROM mi_tabla LIMIT 50;',
  mongo: "db.getSiblingDB('mi_base').getCollection('usuarios').find().limit(10)",
  redis: 'SCAN 0 COUNT 100',
};

function fmtRows(n: number | null): string {
  if (n === null) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Tabla de resultados con cabecera fija y celdas monoespaciadas. */
function ResultTable({ result }: { result: DbQueryResult }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-left">
        <thead className="sticky top-0 z-10">
          <tr>
            {(result.columns ?? []).map((c, i) => (
              <th
                key={`${c}-${i}`}
                className="whitespace-nowrap border-b border-line bg-surface2 px-3 py-2 text-[11px] font-semibold uppercase tracking-[.05em] text-sub"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(result.rows ?? []).map((row, i) => (
            <tr key={i} className="odd:bg-bg even:bg-surface hover:bg-acc/[.06]">
              {row.map((cell, j) => (
                <td key={j} className="max-w-[360px] truncate border-b border-line/60 px-3 py-1.5 font-mono text-[11.5px] text-txt" title={cell}>
                  {cell === '' ? <span className="text-subtle">∅</span> : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DbConsoleTab({ serviceId }: { serviceId: string }) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [allowWrite, setAllowWrite] = useState(false);
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useLocalStorage<string[]>(`skyway.dbHistory.${serviceId}`, []);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  const overview = useQuery({
    queryKey: ['dbOverview', serviceId],
    queryFn: () => api.get<{ overview: DbOverview; snippets: DbSnippet[] }>(`/services/${serviceId}/db/overview`),
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) setHistoryOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, []);

  const run = useMutation({
    mutationFn: (q: string) =>
      api.post<{ result: DbQueryResult }>(`/services/${serviceId}/db/query`, { query: q, allowWrite }),
    onSuccess: (data, q) => {
      setResult(data.result);
      setError(null);
      setHistory([q, ...history.filter((x) => x !== q)].slice(0, 20));
    },
    onError: (err: Error) => {
      setResult(null);
      setError(err.message);
    },
  });

  const execute = (q?: string) => {
    const text = (q ?? query).trim();
    // Una consulta en vuelo cada vez: evita que dos ejecuciones concurrentes
    // dejen en pantalla el resultado de la más lenta (no de la última pedida).
    if (!text || run.isPending) return;
    if (q !== undefined) setQuery(q);
    run.mutate(text);
  };

  const browse = useMutation({
    mutationFn: ({ object, mode }: { object: string; mode: 'data' | 'describe' }) =>
      api.get<{ query: string }>(
        `/services/${serviceId}/db/browse-query?object=${encodeURIComponent(object)}&mode=${mode}`,
      ),
    onSuccess: (data) => execute(data.query),
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const engine = overview.data?.overview.engine;
  const objects = overview.data?.overview.objects ?? [];
  const snippets = overview.data?.snippets ?? [];
  const totalSize = overview.data?.overview.sizeBytes ?? null;

  const emptyState = useMemo(
    () => !run.isPending && !result && !error,
    [run.isPending, result, error],
  );

  if (overview.isLoading) {
    return (
      <div className="space-y-3 p-4 sm:px-5">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (overview.isError) {
    return (
      <div className="p-4 sm:px-5">
        <div className="flex items-start gap-2.5 rounded-xl border border-warn/30 bg-warn/[.08] px-4 py-3 text-sm text-warn">
          <TriangleAlert size={16} className="mt-px shrink-0" />
          <div>
            <p className="font-medium">No se pudo abrir la consola</p>
            <p className="mt-0.5 text-xs text-sub">{(overview.error as Error).message}</p>
            <Button size="sm" variant="secondary" className="mt-2.5" onClick={() => overview.refetch()}>
              <RefreshCw size={12} /> Reintentar
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 sm:px-5">
      {/* Cabecera: motor, tamaño y explorador de objetos */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-sub">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface2 px-2.5 py-1">
          <Database size={12} className="text-acc-soft" />
          {engine ? ENGINE_LABEL[engine] : 'Base de datos'}
          {overview.data?.overview.version && (
            <span className="font-mono text-[10.5px] text-subtle">{overview.data.overview.version.split(' ')[0]}</span>
          )}
        </span>
        {totalSize !== null && totalSize > 0 && (
          <span className="text-subtle">
            {engine === 'redis' ? 'memoria' : 'tamaño'}: <span className="tnum text-sub">{fmtBytes(totalSize)}</span>
          </span>
        )}
        <button
          onClick={() => overview.refetch()}
          className="ml-auto rounded-md p-1 text-subtle transition-colors hover:bg-surface2 hover:text-txt"
          title="Recargar esquema"
        >
          <RefreshCw size={12} className={cx(overview.isFetching && 'animate-spin')} />
        </button>
      </div>

      {objects.length > 0 && (
        <div className="max-h-28 overflow-y-auto rounded-xl border border-line bg-bg p-2">
          <p className="mb-1.5 px-1 text-[10.5px] font-semibold uppercase tracking-[.08em] text-subtle">
            {overview.data?.overview.objectLabel} · {objects.length}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {objects.map((o, i) => (
              <span
                key={`${o.name}-${i}`}
                className="inline-flex max-w-full items-stretch overflow-hidden rounded-lg border border-line bg-surface text-[11.5px] text-sub transition-colors focus-within:border-acc/50 hover:border-acc/50"
              >
                <button
                  onClick={() => browse.mutate({ object: o.name, mode: 'data' })}
                  disabled={browse.isPending || run.isPending}
                  className="inline-flex min-w-0 items-center gap-1.5 px-2 py-1 transition-colors hover:text-txt disabled:opacity-60"
                  title={`Ver contenido de ${o.name}`}
                >
                  <Table2 size={11} className="shrink-0 text-subtle" />
                  <span className="truncate font-mono">{o.name}</span>
                  {o.rows !== null && <span className="tnum shrink-0 text-[10px] text-subtle">{fmtRows(o.rows)}</span>}
                  {o.sizeBytes !== null && o.sizeBytes > 0 && (
                    <span className="tnum shrink-0 text-[10px] text-subtle">{fmtBytes(o.sizeBytes)}</span>
                  )}
                </button>
                <button
                  onClick={() => browse.mutate({ object: o.name, mode: 'describe' })}
                  disabled={browse.isPending || run.isPending}
                  className="inline-flex items-center border-l border-line px-1.5 text-subtle transition-colors hover:bg-surface2 hover:text-txt disabled:opacity-60"
                  title={engine === 'redis' ? `Tipo, TTL y memoria de ${o.name}` : `Estructura de ${o.name}`}
                >
                  <Columns3 size={11} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Snippets de consultas frecuentes */}
      {snippets.length > 0 && (
        <div className="-mb-0.5 flex flex-wrap items-center gap-1.5">
          {snippets.map((s) => (
            <button
              key={s.label}
              onClick={() => setQuery(s.query)}
              className="rounded-full border border-line bg-surface px-2.5 py-[3px] text-[11px] text-sub transition-colors hover:border-acc/50 hover:text-txt"
              title={s.hint ?? s.query}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {/* Editor */}
      <div className="rounded-xl border border-line bg-bg focus-within:border-acc/50">
        <textarea
          ref={textareaRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              execute();
            }
          }}
          spellCheck={false}
          rows={4}
          placeholder={engine ? PLACEHOLDER[engine] : ''}
          className="w-full resize-y bg-transparent px-3.5 py-3 font-mono text-xs leading-relaxed text-txt outline-none placeholder:text-subtle focus-visible:[outline:none]"
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-2.5 py-2">
          <Button size="sm" onClick={() => execute()} loading={run.isPending} disabled={!query.trim()}>
            <Play size={12} /> Ejecutar
          </Button>
          <span className="hidden items-center gap-1 text-[11px] text-subtle sm:flex">
            <Kbd>⌘↵</Kbd>
          </span>
          <label
            className={cx(
              'flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors',
              allowWrite ? 'border-warn/50 bg-warn/[.1] text-warn' : 'border-line text-sub hover:text-txt',
            )}
            title="Sin marcar, solo se permiten consultas de lectura"
          >
            <input
              type="checkbox"
              checked={allowWrite}
              onChange={(e) => setAllowWrite(e.target.checked)}
              className="h-3 w-3 accent-warn"
            />
            Permitir escritura
          </label>
          {history.length > 0 && (
            <div className="relative ml-auto" ref={historyRef}>
              <button
                onClick={() => setHistoryOpen((v) => !v)}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-sub transition-colors hover:bg-surface2 hover:text-txt"
              >
                <History size={12} /> Historial <ChevronDown size={11} />
              </button>
              {historyOpen && (
                <div className="absolute right-0 top-8 z-20 max-h-64 w-[440px] max-w-[80vw] overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-lvl3">
                  {history.map((h, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        setQuery(h);
                        setHistoryOpen(false);
                        textareaRef.current?.focus();
                      }}
                      className="block w-full truncate rounded-lg px-2.5 py-1.5 text-left font-mono text-[11px] text-sub hover:bg-surface2 hover:text-txt"
                      title={h}
                    >
                      {h}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Resultado */}
      {error && (
        <div className="flex items-start gap-2.5 rounded-xl border border-err/35 bg-err/[.07] px-4 py-3 text-sm text-err">
          <TriangleAlert size={15} className="mt-px shrink-0" />
          <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed">{error}</pre>
        </div>
      )}

      {result && (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-subtle">
            <span className="tnum">
              {result.kind === 'table'
                ? `${result.rowCount} fila${result.rowCount === 1 ? '' : 's'}`
                : `${result.rowCount} línea${result.rowCount === 1 ? '' : 's'}`}
            </span>
            <span>·</span>
            <span className="tnum">{result.durationMs} ms</span>
            {result.notice && <span className="text-warn">· {result.notice}</span>}
            {result.kind === 'table' && (result.rows?.length ?? 0) > 0 && (
              <span className="ml-auto flex items-center gap-1">
                <button
                  onClick={() => downloadFile(`consulta-${Date.now()}.csv`, resultToCsv(result), 'text/csv')}
                  className="flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-surface2 hover:text-txt"
                  title="Descargar el resultado como CSV"
                >
                  <Download size={11} /> CSV
                </button>
                <button
                  onClick={() => downloadFile(`consulta-${Date.now()}.json`, resultToJson(result), 'application/json')}
                  className="flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-surface2 hover:text-txt"
                  title="Descargar el resultado como JSON"
                >
                  <Download size={11} /> JSON
                </button>
              </span>
            )}
            {result.kind === 'text' && !!result.raw && (
              <button
                onClick={() => downloadFile(`consulta-${Date.now()}.txt`, result.raw!, 'text/plain')}
                className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-surface2 hover:text-txt"
                title="Descargar el resultado"
              >
                <Download size={11} /> Descargar
              </button>
            )}
          </div>
          {result.kind === 'table' ? (
            <ResultTable result={result} />
          ) : result.raw ? (
            <pre className="min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-bg px-3.5 py-3 font-mono text-[11.5px] leading-relaxed text-txt">
              {result.raw}
            </pre>
          ) : (
            <p className="rounded-lg border border-line bg-bg px-3.5 py-3 text-xs text-sub">{result.notice ?? 'Sin resultados.'}</p>
          )}
        </div>
      )}

      {emptyState && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line py-10 text-center">
          <Database size={22} className="text-subtle" />
          <p className="max-w-xs text-xs leading-relaxed text-subtle">
            Escribe una consulta, usa un snippet o pulsa {overview.data?.overview.objectLabel === 'tablas' ? 'una tabla' : 'un objeto'} de
            arriba para explorar los datos. Por defecto solo se permite lectura.
          </p>
        </div>
      )}
    </div>
  );
}
