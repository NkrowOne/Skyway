import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileText,
  HelpCircle,
  Layers,
  Plus,
  Search,
  Table,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { api } from '../../api';
import { cx } from '../../utils';
import { Button, CopyButton, EditorBar, Skeleton, useToast } from '../ui';

interface ReferenceGroup {
  service: string;
  template: string | null;
  vars: string[];
}

interface EnvResponse {
  vars: Record<string, string>;
  resolved: Record<string, string>;
  references: ReferenceGroup[];
}

interface Row {
  id: string;
  key: string;
  value: string;
}

/** Generador de ID único local para filas */
let rowCounter = 0;
function makeRow(key = '', value = ''): Row {
  return { id: `var_${Date.now()}_${++rowCounter}`, key, value };
}

/** Variables típicas que casi toda app necesita, para añadirlas en un clic. */
const SUGGESTED_VARS: { key: string; value: string; hint: string }[] = [
  { key: 'NODE_ENV', value: 'production', hint: 'Modo de ejecución para apps Node' },
  { key: 'TZ', value: 'Europe/Madrid', hint: 'Zona horaria del contenedor' },
  { key: 'LOG_LEVEL', value: 'info', hint: 'Nivel de logs de la aplicación' },
  { key: 'PORT', value: '3000', hint: 'Puerto de escucha de la aplicación' },
];

/** Variable de conexión principal que exporta cada plantilla de base de datos. */
const MAIN_VAR: Record<string, string> = {
  postgres: 'DATABASE_URL',
  redis: 'REDIS_URL',
  mysql: 'MYSQL_URL',
  mongo: 'MONGO_URL',
  minio: 'MINIO_ENDPOINT',
};

const RAILWAY_RE = /railway\.internal|railway\.app|rlwy\.net/i;

/** Deduce a qué tipo de base apunta un valor heredado de Railway (por esquema, luego por clave). */
const guessTemplate = (key: string, value: string): string | null => {
  if (/^postgres(?:ql)?:\/\//i.test(value)) return 'postgres';
  if (/^rediss?:\/\//i.test(value)) return 'redis';
  if (/^mysql:\/\//i.test(value)) return 'mysql';
  if (/^mongodb(?:\+srv)?:\/\//i.test(value)) return 'mongo';
  if (/^(?:DATABASE|PG|POSTGRES)/i.test(key)) return 'postgres';
  if (/^REDIS/i.test(key)) return 'redis';
  if (/^MYSQL/i.test(key)) return 'mysql';
  if (/^MONGO/i.test(key)) return 'mongo';
  if (/^(?:MINIO|S3)/i.test(key)) return 'minio';
  return null;
};

const isReference = (v: string) => v.includes('${{');

export default function VariablesTab({
  serviceId,
  onSaved,
  onDeploy,
  onNeedsRedeploy,
  onDirtyChange,
}: {
  serviceId: string;
  onSaved: () => void;
  onDeploy?: () => void;
  onNeedsRedeploy?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [viewMode, setViewMode] = useState<'table' | 'raw'>('table');
  const [rawText, setRawText] = useState('');
  const [globalReveal, setGlobalReveal] = useState(false);
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [dirty, setDirty] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  const keyInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const valueInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const env = useQuery({
    queryKey: ['env', serviceId],
    queryFn: () => api.get<EnvResponse>(`/services/${serviceId}/env`),
  });

  useEffect(() => {
    if (env.data && !dirty) {
      const entries = Object.entries(env.data.vars).map(([key, value]) => makeRow(key, value));
      setRows(entries);
      setRawText(entries.map((r) => `${r.key}=${r.value}`).join('\n'));
    }
  }, [env.data, dirty]);

  const save = useMutation({
    mutationFn: (vars: Record<string, string>) => api.put(`/services/${serviceId}/env`, { vars }),
    onSuccess: () => {
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ['env', serviceId] });
      toast('Variables guardadas con éxito.', 'ok', {
        action: onDeploy ? { label: 'Desplegar ahora', onClick: onDeploy } : undefined,
      });
      onNeedsRedeploy?.();
      onSaved();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  // Alternar vista tabla / texto plano
  const handleSwitchMode = (mode: 'table' | 'raw') => {
    if (mode === 'raw') {
      setRawText(rows.map((r) => `${r.key}=${r.value}`).join('\n'));
    } else {
      // Parsear texto plano a filas
      const newRows: Row[] = [];
      for (const line of rawText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq > 0) {
          newRows.push(makeRow(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1)));
        } else {
          newRows.push(makeRow(trimmed, ''));
        }
      }
      setRows(newRows);
    }
    setViewMode(mode);
  };

  // Validación y envío de cambios
  const submit = () => {
    const vars: Record<string, string> = {};
    if (viewMode === 'raw') {
      for (const line of rawText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) {
          toast(`Línea inválida: ${trimmed}`, 'err');
          return;
        }
        vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
      }
    } else {
      for (const row of rows) {
        if (!row.key.trim()) continue;
        vars[row.key.trim()] = row.value;
      }
    }
    save.mutate(vars);
  };

  // Descartar cambios
  const discard = () => {
    if (!env.data) return;
    const entries = Object.entries(env.data.vars).map(([key, value]) => makeRow(key, value));
    setRows(entries);
    setRawText(entries.map((r) => `${r.key}=${r.value}`).join('\n'));
    setDirty(false);
    toast('Cambios descartados', 'info');
  };

  // Alternar revelado individual
  const toggleRowReveal = (id: string) => {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Alternar revelado global
  const toggleGlobalReveal = () => {
    const next = !globalReveal;
    setGlobalReveal(next);
    if (next) {
      setRevealedIds(new Set(rows.map((r) => r.id)));
    } else {
      setRevealedIds(new Set());
    }
  };

  // Edición inteligente con divisor '=' al escribir o pegar
  const handleKeyChange = (id: string, rawInput: string, index: number) => {
    // Si contiene saltos de línea (pegado múltiple de .env)
    if (rawInput.includes('\n')) {
      const lines = rawInput.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      if (lines.length > 1) {
        const parsedRows: Row[] = [];
        for (const line of lines) {
          const eq = line.indexOf('=');
          if (eq > 0) {
            parsedRows.push(makeRow(line.slice(0, eq).trim(), line.slice(eq + 1)));
          } else {
            parsedRows.push(makeRow(line, ''));
          }
        }
        if (parsedRows.length > 0) {
          setRows((prev) => {
            const next = [...prev];
            next.splice(index, 1, ...parsedRows);
            return next;
          });
          setDirty(true);
          toast(`${parsedRows.length} variables importadas`, 'ok');
          return;
        }
      }
    }

    // Si contiene '=', actúa de divisor automático y salta el foco al campo valor
    if (rawInput.includes('=')) {
      const eq = rawInput.indexOf('=');
      const key = rawInput.slice(0, eq).trim();
      const value = rawInput.slice(eq + 1);
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, key, value: value || r.value } : r)));
      setDirty(true);
      setTimeout(() => {
        valueInputRefs.current.get(id)?.focus();
      }, 10);
      return;
    }

    // Edición normal
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, key: rawInput } : r)));
    setDirty(true);
  };

  const handleValueChange = (id: string, value: string) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, value } : r)));
    setDirty(true);
  };

  const handleAddRow = () => {
    const newR = makeRow('', '');
    setRows((prev) => [...prev, newR]);
    setDirty(true);
    setTimeout(() => {
      keyInputRefs.current.get(newR.id)?.focus();
    }, 50);
  };

  const handleDeleteRow = (id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
    setDirty(true);
  };

  // Copiar todo como formato .env
  const handleCopyAllAsEnv = () => {
    const text = rows.map((r) => `${r.key}=${r.value}`).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopiedAll(true);
      toast('Todas las variables copiadas al portapapeles en formato .env', 'ok');
      setTimeout(() => setCopiedAll(false), 2000);
    });
  };

  const references = env.data?.references ?? [];
  const resolved = env.data?.resolved ?? {};
  const hasRefs = useMemo(() => rows.some((r) => isReference(r.value)), [rows]);

  // Claves duplicadas
  const duplicates = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of rows) {
      const k = r.key.trim();
      if (k) counts[k] = (counts[k] || 0) + 1;
    }
    return new Set(Object.keys(counts).filter((k) => counts[k] > 1));
  }, [rows]);

  // Variables que siguen apuntando a Railway
  const railwayPending = useMemo(() => {
    const out: { id: string; key: string; candidates: ReferenceGroup[] }[] = [];
    rows.forEach((row) => {
      if (!RAILWAY_RE.test(row.value) || isReference(row.value)) return;
      const template = guessTemplate(row.key, row.value);
      const candidates = template
        ? references.filter((g) => g.template === template && g.vars.includes(MAIN_VAR[template]))
        : [];
      out.push({ id: row.id, key: row.key, candidates });
    });
    return out;
  }, [rows, references]);

  // Sugerencias rápidas
  const suggestions = useMemo(() => {
    const db = references
      .filter((g) => g.template && MAIN_VAR[g.template] && g.vars.includes(MAIN_VAR[g.template]))
      .map((g) => ({
        key: MAIN_VAR[g.template!],
        value: `\${{${g.service}.${MAIN_VAR[g.template!]}}}`,
        hint: `Conexión a ${g.service} por la red interna del proyecto`,
      }));
    const seen = new Set<string>();
    return [...db, ...SUGGESTED_VARS].filter((s) => !seen.has(s.key) && seen.add(s.key));
  }, [references]);

  // Filtrado por buscador
  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.key.toLowerCase().includes(q) || r.value.toLowerCase().includes(q));
  }, [rows, searchQuery]);

  if (env.isLoading) {
    return (
      <div aria-busy className="flex flex-col gap-3 p-4 sm:px-5">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-between">
      <div className="flex flex-col gap-3.5 p-3.5 sm:p-5 pb-24">
        {/* ── CABECERA Y HERRAMIENTAS PRINCIPALES ── */}
        <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-line bg-surface p-2.5 shadow-sm">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="text-xs font-semibold text-txt">Variables de entorno</span>
            <span className="rounded bg-surface2 px-1.5 py-0.5 text-micro font-mono text-subtle">
              {rows.length}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {/* Segmented Control: Tabla / RAW */}
            <div className="flex items-center rounded-lg bg-surface2/70 p-0.5 border border-line">
              <button
                type="button"
                onClick={() => handleSwitchMode('table')}
                className={cx(
                  'press flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
                  viewMode === 'table'
                    ? 'bg-surface text-txt shadow-sm border border-line font-semibold'
                    : 'text-subtle hover:text-txt',
                )}
                title="Vista en tabla"
              >
                <Table size={12} />
                <span className="hidden sm:inline">Tabla</span>
              </button>
              <button
                type="button"
                onClick={() => handleSwitchMode('raw')}
                className={cx(
                  'press flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
                  viewMode === 'raw'
                    ? 'bg-surface text-txt shadow-sm border border-line font-semibold'
                    : 'text-subtle hover:text-txt',
                )}
                title="Editar texto plano formato .env"
              >
                <FileText size={12} />
                <span>RAW</span>
              </button>
            </div>

            {viewMode === 'table' && (
              <>
                <button
                  type="button"
                  onClick={toggleGlobalReveal}
                  className="press flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface2/60 px-2.5 text-xs font-medium text-sub transition-colors hover:bg-surface2 hover:text-txt"
                  title={globalReveal ? 'Ocultar todos los valores' : 'Revelar todos los valores'} aria-label={globalReveal ? 'Ocultar todos los valores' : 'Revelar todos los valores'}
                >
                  {globalReveal ? <EyeOff size={13} /> : <Eye size={13} />}
                  <span className="hidden md:inline">{globalReveal ? 'Ocultar todo' : 'Revelar todo'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleCopyAllAsEnv}
                  className="press flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface2/60 px-2.5 text-xs font-medium text-sub transition-colors hover:bg-surface2 hover:text-txt"
                  title="Copiar todas las variables en formato .env" aria-label="Copiar todas las variables en formato .env"
                >
                  {copiedAll ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
                  <span className="hidden lg:inline">Copiar .env</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* ── ALERTA DE MIGRACIÓN DESDE RAILWAY (SI APLICA) ── */}
        {railwayPending.length > 0 && (
          <div className="rounded-xl border border-warn/35 bg-warn/[.07] p-3.5 text-xs shadow-sm">
            <p className="flex items-center gap-1.5 font-semibold text-warn">
              <AlertTriangle size={14} />
              {railwayPending.length === 1
                ? '1 variable sigue apuntando a la red externa de Railway'
                : `${railwayPending.length} variables siguen apuntando a la red externa de Railway`}
            </p>
            <p className="mt-1 text-sub">
              Reconéctalas en un clic para usar la red interna ultra-rápida y segura de Skyway:
            </p>
            <div className="mt-2.5 flex flex-col gap-1.5">
              {railwayPending.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold text-txt text-xs">{p.key}</span>
                  {p.candidates.map((g) => {
                    const token = `\${{${g.service}.${MAIN_VAR[g.template!]}}}`;
                    return (
                      <button
                        key={g.service}
                        type="button"
                        className="press rounded-md border border-line bg-surface px-2 py-0.5 font-mono text-xs text-info transition-colors hover:border-info"
                        onClick={() => {
                          setRows((prev) =>
                            prev.map((r) => (r.id === p.id ? { ...r, value: token } : r)),
                          );
                          setDirty(true);
                          toast(`Reconectado a ${g.service}`, 'ok');
                        }}
                      >
                        usar {token}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── MODO TEXTO PLANO RAW (.ENV) ── */}
        {viewMode === 'raw' ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs text-subtle">
              <span>Edición directa en formato <code className="font-mono text-txt">CLAVE=valor</code></span>
              <span>Pega tu archivo .env directamente aquí</span>
            </div>
            <textarea
              className="input min-h-[320px] w-full rounded-xl border border-line bg-term p-3.5 font-mono text-xs text-txt/95 leading-relaxed outline-none focus:border-acc"
              value={rawText}
              onChange={(e) => {
                setRawText(e.target.value);
                setDirty(true);
              }}
              placeholder={'CLAVE=valor\nAPI_KEY=123456\nDATABASE_URL=${{Postgres.DATABASE_URL}}'}
              spellCheck={false}
            />
          </div>
        ) : (
          /* ── MODO TABLA PROFESIONAL RESPONSIVA ── */
          <div className="flex flex-col gap-2.5">
            {/* Buscador de variables (si hay más de 4) */}
            {rows.length > 4 && (
              <div className="flex h-8 w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 focus-within:border-acc">
                <Search size={13} className="shrink-0 text-subtle" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filtrar variables por nombre o valor…"
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent text-xs text-txt outline-none placeholder:text-subtle"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="press text-subtle hover:text-txt"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            )}

            <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
              {filteredRows.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-8 text-center text-xs text-subtle">
                  {searchQuery ? (
                    <p>Ninguna variable coincide con "{searchQuery}"</p>
                  ) : (
                    <>
                      <Layers size={24} className="mb-2 opacity-40" />
                      <p className="font-medium text-txt">Sin variables de entorno</p>
                      <p className="mt-1 text-subtle">
                        Añade una variable o escribe <code className="font-mono text-acc">CLAVE=valor</code> directamente.
                      </p>
                    </>
                  )}
                </div>
              ) : (
                <div className="divide-y divide-line">
                  {filteredRows.map((row, index) => {
                    const isRevealed = globalReveal || revealedIds.has(row.id);
                    const isRef = isReference(row.value);
                    const isDup = duplicates.has(row.key.trim());

                    return (
                      <div
                        key={row.id}
                        className={cx(
                          'group flex flex-col sm:flex-row sm:items-center transition-colors duration-150 hover:bg-surface2/40',
                          isDup && 'bg-err/[.04]',
                        )}
                      >
                        {/* Campo CLAVE / KEY con salto automático al pulsar '=' o Enter */}
                        <div className="relative flex items-center sm:w-[40%] sm:border-r border-line">
                          <input
                            ref={(el) => {
                              if (el) keyInputRefs.current.set(row.id, el);
                              else keyInputRefs.current.delete(row.id);
                            }}
                            className={cx(
                              'w-full bg-transparent px-3.5 py-2.5 font-mono text-xs font-medium text-txt outline-none placeholder:text-subtle focus:bg-surface2/60',
                              isDup && 'text-err font-bold',
                            )}
                            placeholder="NOMBRE_VARIABLE"
                            value={row.key}
                            spellCheck={false}
                            onChange={(e) => handleKeyChange(row.id, e.target.value, index)}
                            onKeyDown={(e) => {
                              if (e.key === '=' || e.key === 'Equal') {
                                e.preventDefault();
                                valueInputRefs.current.get(row.id)?.focus();
                              } else if (e.key === 'Enter') {
                                e.preventDefault();
                                valueInputRefs.current.get(row.id)?.focus();
                              }
                            }}
                          />
                          {isDup && (
                            <span className="mr-2 rounded bg-err/15 px-1.5 py-0.5 text-micro font-bold text-err">
                              Duplicada
                            </span>
                          )}
                        </div>

                        {/* Campo VALOR / VALUE con salto a la siguiente fila al pulsar Enter */}
                        <div className="flex min-w-0 flex-1 items-center border-t sm:border-t-0 border-line/60">
                          <input
                            ref={(el) => {
                              if (el) valueInputRefs.current.set(row.id, el);
                              else valueInputRefs.current.delete(row.id);
                            }}
                            className={cx(
                              'min-w-0 flex-1 bg-transparent px-3.5 py-2.5 font-mono text-xs outline-none placeholder:text-subtle focus:bg-surface2/60',
                              isRef ? 'text-info font-medium' : isRevealed ? 'text-txt' : 'text-subtle',
                            )}
                            placeholder={isRef ? '${{Servicio.VAR}}' : 'valor o secreta'}
                            type={isRevealed || isRef ? 'text' : 'password'}
                            value={row.value}
                            spellCheck={false}
                            onChange={(e) => handleValueChange(row.id, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                if (index === filteredRows.length - 1) {
                                  handleAddRow();
                                } else {
                                  const nextRow = filteredRows[index + 1];
                                  if (nextRow) keyInputRefs.current.get(nextRow.id)?.focus();
                                }
                              }
                            }}
                          />

                          {/* Botones de acción individual por fila */}
                          <div className="flex shrink-0 items-center gap-0.5 pr-2">
                            {/* Botón individual de Ver / Ocultar valor */}
                            {!isRef && (
                              <button
                                type="button"
                                onClick={() => toggleRowReveal(row.id)}
                                className={cx(
                                  'press flex h-7 w-7 items-center justify-center rounded-md text-subtle transition-colors hover:bg-surface2 hover:text-txt',
                                  isRevealed && 'text-acc',
                                )}
                                title={isRevealed ? 'Ocultar valor' : 'Mostrar valor'}
                              >
                                {isRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
                              </button>
                            )}

                            {/* Copiar valor resuelto */}
                            <CopyButton
                              value={resolved[row.key] ?? row.value}
                              title="Copiar valor resuelto"
                            />

                            {/* Eliminar variable */}
                            <button
                              type="button"
                              onClick={() => handleDeleteRow(row.id)}
                              className="press flex h-7 w-7 items-center justify-center rounded-md text-subtle transition-colors hover:bg-surface2 hover:text-err"
                              title="Eliminar variable"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Botón Añadir Variable */}
              <button
                type="button"
                onClick={handleAddRow}
                className="press flex w-full items-center justify-center gap-2 border-t border-line bg-surface2/30 px-3.5 py-2.5 text-xs font-semibold text-sub transition-colors hover:bg-surface2 hover:text-txt"
              >
                <Plus size={14} className="text-acc" />
                <span>Añadir variable</span>
                <span className="hidden text-xs font-normal text-subtle sm:inline">
                  (escribe <code className="font-mono text-txt">CLAVE=valor</code> para autocompletar)
                </span>
              </button>
            </div>
          </div>
        )}

        {/* ── REFERENCIAS Y SUGERENCIAS ── */}
        <div className="flex flex-col gap-3">
          {/* Sugerencias rápidas */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-subtle">
            <span className="font-medium text-sub">Comunes:</span>
            {suggestions
              .filter((s) => !rows.some((r) => r.key === s.key))
              .map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className="press rounded-md border border-line bg-surface2/60 px-2 py-0.5 font-mono text-xs text-sub transition-colors hover:border-acc/40 hover:text-txt"
                  title={s.hint} aria-label={s.hint}
                  onClick={() => {
                    setRows((prev) => [...prev, makeRow(s.key, s.value)]);
                    setDirty(true);
                  }}
                >
                  + {s.key}
                </button>
              ))}
          </div>

          {/* Referencias disponibles del proyecto */}
          {references.length > 0 && (
            <div className="rounded-xl border border-line bg-surface p-3.5 text-xs shadow-sm">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-semibold text-sub">Referencias disponibles en el proyecto</span>
                <span className="text-xs text-subtle">Clic para copiar formato {'${{...}}'}</span>
              </div>
              <div className="flex flex-col gap-2.5">
                {references.map((ref) => (
                  <div key={ref.service} className="rounded-lg bg-surface2/50 p-2 border border-line/60">
                    <p className="mb-1.5 eyebrow text-subtle">
                      {ref.service === 'shared' ? 'Variables compartidas' : ref.service}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {ref.vars.map((v) => {
                        const token = `\${{${ref.service}.${v}}}`;
                        return (
                          <button
                            key={v}
                            type="button"
                            className="press rounded-md border border-line bg-surface px-2 py-0.5 font-mono text-xs text-info transition-colors hover:border-info hover:bg-info/10"
                            title={`Copiar ${token}`} aria-label={`Copiar ${token}`}
                            onClick={() => {
                              navigator.clipboard.writeText(token);
                              toast(`Copiado: ${token}`, 'ok');
                            }}
                          >
                            {v}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── BARRA DE GUARDADO FIJA / FLOTANTE ELEVADA (ACCESIBLE Y VISIBLE SIEMPRE) ── */}
      <EditorBar
        dirty={dirty}
        saving={save.isPending}
        onSave={submit}
        onDiscard={discard}
        saveLabel={dirty ? `Guardar (${rows.filter((r) => r.key.trim()).length})` : 'Guardar variables'}
        dirtyLabel="Cambios sin guardar · se aplican al redesplegar"
      />
    </div>
  );
}
