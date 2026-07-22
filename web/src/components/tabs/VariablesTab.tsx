import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { cx } from '../../utils';
import { CopyButton, EditorBar, Skeleton, useToast } from '../ui';

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
  key: string;
  value: string;
}

/** Variables típicas que casi toda app necesita, para añadirlas en un clic. */
const SUGGESTED_VARS: { key: string; value: string; hint: string }[] = [
  { key: 'NODE_ENV', value: 'production', hint: 'Modo de ejecución para apps Node' },
  { key: 'TZ', value: 'Europe/Madrid', hint: 'Zona horaria del contenedor' },
  { key: 'LOG_LEVEL', value: 'info', hint: 'Nivel de logs de la aplicación' },
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
}: {
  serviceId: string;
  onSaved: () => void;
  onDeploy?: () => void;
  /** Aviso al panel: las variables guardadas solo surten efecto al redesplegar. */
  onNeedsRedeploy?: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [raw, setRaw] = useState(false);
  const [rawText, setRawText] = useState('');
  const [reveal, setReveal] = useState(false);
  const [dirty, setDirty] = useState(false);

  const env = useQuery({
    queryKey: ['env', serviceId],
    queryFn: () => api.get<EnvResponse>(`/services/${serviceId}/env`),
  });

  useEffect(() => {
    if (env.data && !dirty) {
      const entries = Object.entries(env.data.vars).map(([key, value]) => ({ key, value }));
      setRows(entries);
      setRawText(entries.map((r) => `${r.key}=${r.value}`).join('\n'));
    }
  }, [env.data, dirty]);

  const save = useMutation({
    mutationFn: (vars: Record<string, string>) => api.put(`/services/${serviceId}/env`, { vars }),
    onSuccess: () => {
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ['env', serviceId] });
      toast('Variables guardadas. Redespliega el servicio para aplicarlas.', 'ok', {
        action: onDeploy ? { label: 'Desplegar ahora', onClick: onDeploy } : undefined,
      });
      onNeedsRedeploy?.();
      onSaved();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const submit = () => {
    const vars: Record<string, string> = {};
    if (raw) {
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

  // Descartar: vuelve a las variables guardadas y limpia el estado sucio.
  const discard = () => {
    if (!env.data) return;
    const entries = Object.entries(env.data.vars).map(([key, value]) => ({ key, value }));
    setRows(entries);
    setRawText(entries.map((r) => `${r.key}=${r.value}`).join('\n'));
    setDirty(false);
  };

  const references = env.data?.references ?? [];
  const resolved = env.data?.resolved ?? {};
  const hasRefs = useMemo(() => rows.some((r) => isReference(r.value)), [rows]);

  // Variables que siguen apuntando a Railway (tras una importación) y con qué
  // base de datos interna del proyecto se pueden reconectar en un clic.
  const railwayPending = useMemo(() => {
    const out: { index: number; key: string; candidates: ReferenceGroup[] }[] = [];
    rows.forEach((row, index) => {
      if (!RAILWAY_RE.test(row.value) || isReference(row.value)) return;
      const template = guessTemplate(row.key, row.value);
      const candidates = template
        ? references.filter((g) => g.template === template && g.vars.includes(MAIN_VAR[template]))
        : [];
      out.push({ index, key: row.key, candidates });
    });
    return out;
  }, [rows, references]);

  // Sugerencias: conexiones a las bases de datos reales del proyecto + genéricas.
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

  const edit = (i: number, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };

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
    <>
      <div className="flex flex-col gap-3.5 p-4 pb-0 sm:px-5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-sub">
          Referencias <span className="font-mono text-[11px] text-info">{'${{Servicio.VAR}}'}</span> ·{' '}
          <span className="font-mono text-[11px] text-info">{'${{shared.VAR}}'}</span> — las compartidas del proyecto se
          heredan solas.
        </p>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            onClick={() => setReveal(!reveal)}
            className="rounded-lg p-[7px] leading-none text-subtle transition-colors hover:bg-surface2 hover:text-txt"
            title={reveal ? 'Ocultar valores' : 'Mostrar valores'}
          >
            {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <button
            onClick={() => setRaw(!raw)}
            className={cx(
              'rounded-lg px-2 py-[5px] font-mono text-[11px] transition-colors',
              raw ? 'bg-acc/[.14] text-acc-soft' : 'text-subtle hover:bg-surface2 hover:text-txt',
            )}
            title="Editar como texto plano"
          >
            RAW
          </button>
        </div>
      </div>

      {!raw && railwayPending.length > 0 && (
        <div className="rounded-xl border border-warn/30 bg-warn/[.06] p-3.5 text-xs">
          <p className="mb-2 font-semibold text-warn">
            {railwayPending.length === 1
              ? '1 variable sigue apuntando a Railway'
              : `${railwayPending.length} variables siguen apuntando a Railway`}
          </p>
          <div className="flex flex-col gap-1.5">
            {railwayPending.map((p) => (
              <div key={p.index} className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[11px] text-txt">{p.key || '(sin clave)'}</span>
                {p.candidates.length === 0 ? (
                  <span className="text-subtle">sin equivalente en el proyecto: revísala a mano</span>
                ) : (
                  p.candidates.map((g) => {
                    const token = `\${{${g.service}.${MAIN_VAR[g.template!]}}}`;
                    return (
                      <button
                        key={g.service}
                        className="rounded-md border border-line bg-bg px-2 py-0.5 font-mono text-[11px] text-info transition-colors duration-150 hover:border-[color-mix(in_oklab,var(--color-info)_50%,var(--color-line))]"
                        title={`Reconectar con ${g.service} por la red interna del proyecto`}
                        onClick={() => edit(p.index, { value: token })}
                      >
                        usar {token}
                      </button>
                    );
                  })
                )}
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-subtle">
            Tras reconectarlas, guarda y redespliega: la conexión pasará por la red interna del proyecto.
          </p>
        </div>
      )}

      {raw ? (
        <textarea
          className="input h-64 w-full font-mono text-xs"
          value={rawText}
          onChange={(e) => {
            setRawText(e.target.value);
            setDirty(true);
          }}
          placeholder={'CLAVE=valor\nOTRA_CLAVE=${{Postgres.DATABASE_URL}}'}
          spellCheck={false}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-bg">
          {rows.length === 0 && <p className="px-4 py-6 text-center text-sm text-subtle">Sin variables definidas</p>}
          {rows.map((row, i) => (
            <div key={i} className="flex items-center border-b border-line">
              <input
                className="w-[38%] shrink-0 border-r border-line bg-transparent px-3.5 py-[9px] font-mono text-xs text-txt outline-none placeholder:text-subtle focus:bg-surface2/50"
                placeholder="CLAVE"
                value={row.key}
                spellCheck={false}
                onChange={(e) => edit(i, { key: e.target.value })}
              />
              <input
                className={cx(
                  'min-w-0 flex-1 bg-transparent px-3.5 py-[9px] font-mono text-xs outline-none placeholder:text-subtle focus:bg-surface2/50',
                  isReference(row.value) ? 'text-info' : reveal ? 'text-txt' : 'text-subtle',
                )}
                placeholder="valor"
                type={reveal || isReference(row.value) ? 'text' : 'password'}
                value={row.value}
                spellCheck={false}
                onChange={(e) => edit(i, { value: e.target.value })}
              />
              <div className="flex shrink-0 items-center gap-0.5 pr-2">
                <CopyButton value={resolved[row.key] ?? row.value} title="Copiar valor resuelto" />
                <button
                  onClick={() => {
                    setRows(rows.filter((_, j) => j !== i));
                    setDirty(true);
                  }}
                  className="rounded-md p-1 text-subtle transition-colors hover:bg-surface2 hover:text-err"
                  title="Eliminar"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
          <button
            onClick={() => {
              setRows([...rows, { key: '', value: '' }]);
              setDirty(true);
            }}
            className="flex w-full items-center gap-2 px-3.5 py-2.5 text-xs text-sub transition-colors duration-150 hover:bg-surface2 hover:text-txt"
          >
            <Plus size={13} /> Añadir variable
          </button>
        </div>
      )}

      {hasRefs && !raw && (
        <p className="text-[11px] text-subtle">
          Las referencias se resuelven al desplegar; el botón de copiar copia el valor ya resuelto.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5 text-xs text-subtle">
        <span>Sugerencias:</span>
        {suggestions.filter((s) => !rows.some((r) => r.key === s.key)).map((s) => (
          <button
            key={s.key}
            className="rounded-md border border-line bg-surface px-2 py-0.5 font-mono text-[11px] text-sub transition-colors duration-150 hover:border-[color-mix(in_oklab,#6e56cf_50%,var(--color-line))] hover:text-txt"
            title={s.hint}
            onClick={() => {
              setRows([...rows, { key: s.key, value: s.value }]);
              setDirty(true);
            }}
          >
            + {s.key}
          </button>
        ))}
      </div>

      {references.length > 0 && (
        <div className="rounded-xl border border-line bg-surface p-3.5 text-xs">
          <p className="mb-2.5 font-semibold text-sub">Referencias disponibles</p>
          <div className="flex flex-col gap-2.5">
            {references.map((ref) => (
              <div key={ref.service}>
                <p className="mb-1.5 text-[11px] uppercase tracking-[.07em] text-subtle">
                  {ref.service === 'shared' ? 'Compartidas del proyecto' : ref.service}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {ref.vars.map((v) => {
                    const token = `\${{${ref.service}.${v}}}`;
                    return (
                      <button
                        key={v}
                        className="rounded-md border border-line bg-bg px-2 py-0.5 font-mono text-[11px] text-info transition-colors duration-150 hover:border-[color-mix(in_oklab,var(--color-info)_50%,var(--color-line))]"
                        title="Copiar referencia"
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

      <EditorBar
        dirty={dirty}
        saving={save.isPending}
        onSave={submit}
        onDiscard={discard}
        saveLabel="Guardar variables"
        dirtyLabel="Cambios sin guardar · se aplican al redesplegar"
      />
    </>
  );
}
