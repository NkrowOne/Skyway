import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { Button, CopyButton, Spinner, useToast } from '../ui';

interface EnvResponse {
  vars: Record<string, string>;
  resolved: Record<string, string>;
  references: { service: string; vars: string[] }[];
}

interface Row {
  key: string;
  value: string;
}

export default function VariablesTab({ serviceId, onSaved }: { serviceId: string; onSaved: () => void }) {
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
      toast('Variables guardadas. Redespliega el servicio para aplicarlas.', 'ok');
      onSaved();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const submit = () => {
    let vars: Record<string, string> = {};
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

  const references = env.data?.references ?? [];
  const resolved = env.data?.resolved ?? {};
  const hasRefs = useMemo(() => rows.some((r) => r.value.includes('${{')), [rows]);

  if (env.isLoading) return <Spinner label="Cargando variables..." />;

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-sub">
          Usa referencias <span className="font-mono text-acc2">{'${{Servicio.VAR}}'}</span> para conectar servicios
        </p>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setReveal(!reveal)} title={reveal ? 'Ocultar valores' : 'Mostrar valores'}>
            {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRaw(!raw)}>
            {raw ? 'Editor' : 'RAW'}
          </Button>
        </div>
      </div>

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
        <div className="space-y-2">
          {rows.length === 0 && <p className="py-6 text-center text-sm text-sub/70">Sin variables definidas</p>}
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                className="input w-2/5 font-mono text-xs"
                placeholder="CLAVE"
                value={row.key}
                onChange={(e) => {
                  const next = [...rows];
                  next[i] = { ...next[i], key: e.target.value };
                  setRows(next);
                  setDirty(true);
                }}
              />
              <div className="relative flex-1">
                <input
                  className="input w-full pr-8 font-mono text-xs"
                  placeholder="valor"
                  type={reveal ? 'text' : 'password'}
                  value={row.value}
                  onChange={(e) => {
                    const next = [...rows];
                    next[i] = { ...next[i], value: e.target.value };
                    setRows(next);
                    setDirty(true);
                  }}
                />
                <CopyButton value={resolved[row.key] ?? row.value} className="absolute right-1.5 top-1/2 -translate-y-1/2" />
              </div>
              <button
                onClick={() => {
                  setRows(rows.filter((_, j) => j !== i));
                  setDirty(true);
                }}
                className="rounded-md p-1.5 text-sub hover:bg-panel2 hover:text-err"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setRows([...rows, { key: '', value: '' }]);
              setDirty(true);
            }}
          >
            <Plus size={13} /> Añadir variable
          </Button>
        </div>
      )}

      {hasRefs && !raw && (
        <p className="text-xs text-sub/80">
          Las referencias se resuelven al desplegar; el botón de copiar copia el valor ya resuelto.
        </p>
      )}

      {references.length > 0 && (
        <details className="card p-3 text-xs">
          <summary className="cursor-pointer text-sub hover:text-txt">Referencias disponibles de otros servicios</summary>
          <div className="mt-2 space-y-2">
            {references.map((ref) => (
              <div key={ref.service}>
                <p className="mb-1 font-medium text-txt">{ref.service}</p>
                <div className="flex flex-wrap gap-1.5">
                  {ref.vars.map((v) => {
                    const token = `\${{${ref.service}.${v}}}`;
                    return (
                      <button
                        key={v}
                        className="rounded-md border border-line bg-panel2 px-2 py-0.5 font-mono text-[11px] text-acc2 hover:border-acc2/50"
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
        </details>
      )}

      <div className="flex justify-end">
        <Button onClick={submit} loading={save.isPending} disabled={!dirty}>
          Guardar variables
        </Button>
      </div>
    </div>
  );
}
