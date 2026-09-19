import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { Button, Modal, useToast } from './ui';

interface Row {
  /** Clave estable para React: por posición, borrar una fila del medio barajaba los campos. */
  id: string;
  key: string;
  value: string;
}

let rowSeq = 0;

/**
 * Variables compartidas del proyecto: se inyectan en todos los servicios
 * (las del servicio tienen prioridad) y se pueden referenciar con ${{shared.VAR}}.
 */
export default function SharedVarsModal({
  open,
  onClose,
  projectId,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);

  const vars = useQuery({
    queryKey: ['projectVars', projectId],
    queryFn: () => api.get<{ vars: Record<string, string> }>(`/projects/${projectId}/vars`),
    enabled: open,
  });

  // Al cerrar se olvida lo no guardado: si no, al volver a abrir seguía el
  // borrador descartado (y con `dirty` en pie nunca se recargaba del servidor).
  useEffect(() => {
    if (!open) setDirty(false);
  }, [open]);

  // Alfabético al cargar: el orden de inserción del servidor no ayuda a
  // encontrar nada. Mientras se edita no se reordena (las nuevas van al final).
  useEffect(() => {
    if (vars.data && !dirty) {
      setRows(
        Object.entries(vars.data.vars)
          .sort(([a], [b]) => a.localeCompare(b, 'es'))
          .map(([key, value]) => ({ id: `k:${key}`, key, value })),
      );
    }
  }, [vars.data, dirty]);

  const save = useMutation({
    mutationFn: () => {
      const out: Record<string, string> = {};
      for (const row of rows) {
        if (row.key.trim()) out[row.key.trim()] = row.value;
      }
      return api.put(`/projects/${projectId}/vars`, { vars: out });
    },
    onSuccess: () => {
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ['projectVars', projectId] });
      toast('Variables compartidas guardadas. Redespliega los servicios para aplicarlas.', 'ok');
      onClose();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  return (
    <Modal open={open} onClose={onClose} title="Variables compartidas del proyecto" wide dirty={dirty}>
      <p className="mb-4 text-xs text-sub">
        Se inyectan automáticamente en <strong className="text-txt">todos los servicios</strong> del proyecto (si un
        servicio define la misma clave, gana la suya). También puedes referenciarlas con{' '}
        <span className="font-mono text-info">{'${{shared.VAR}}'}</span>. Útiles para lo común de una empresa: SMTP,
        claves de API, zona horaria, entorno...
      </p>
      <div className="space-y-2">
        {rows.length === 0 && (
          <p className="py-4 text-center text-sm text-subtle">
            Sin variables compartidas. Ejemplos típicos: <span className="font-mono text-xs">TZ</span>,{' '}
            <span className="font-mono text-xs">SMTP_HOST</span>, <span className="font-mono text-xs">S3_BUCKET</span>
          </p>
        )}
        {rows.map((row, i) => (
          <div key={row.id} className="flex items-center gap-2">
            <input
              className="input w-2/5 min-w-0 font-mono sm:text-xs"
              placeholder="CLAVE"
              value={row.key}
              onChange={(e) => {
                const next = [...rows];
                next[i] = { ...next[i], key: e.target.value };
                setRows(next);
                setDirty(true);
              }}
              spellCheck={false}
              autoCapitalize="characters"
              autoCorrect="off"
            />
            <input
              className="input min-w-0 flex-1 font-mono sm:text-xs"
              placeholder="valor"
              value={row.value}
              onChange={(e) => {
                const next = [...rows];
                next[i] = { ...next[i], value: e.target.value };
                setRows(next);
                setDirty(true);
              }}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <button
              onClick={() => {
                setRows(rows.filter((_, j) => j !== i));
                setDirty(true);
              }}
              className="press shrink-0 rounded-md p-1.5 text-sub hover:bg-surface2 hover:text-err max-sm:p-2.5"
              title="Eliminar variable"
              aria-label={`Eliminar ${row.key || 'la variable'}`}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setRows([...rows, { id: `n:${Date.now()}_${++rowSeq}`, key: '', value: '' }]);
            setDirty(true);
          }}
        >
          <Plus size={13} /> Añadir variable
        </Button>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
          Guardar
        </Button>
      </div>
    </Modal>
  );
}
