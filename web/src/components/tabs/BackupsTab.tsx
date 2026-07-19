import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Download, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { fmtBytes, fmtDateTime } from '../../utils';
import { Button, ConfirmModal, Spinner, useToast } from '../ui';

interface BackupEntry {
  file: string;
  size: number;
  createdAt: number;
}

export default function BackupsTab({ serviceId }: { serviceId: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [restoreFile, setRestoreFile] = useState<string | null>(null);
  const [deleteFile, setDeleteFile] = useState<string | null>(null);

  const backups = useQuery({
    queryKey: ['backups', serviceId],
    queryFn: () => api.get<{ supported: boolean; backups: BackupEntry[] }>(`/services/${serviceId}/backups`),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['backups', serviceId] });

  const create = useMutation({
    mutationFn: () => api.post<{ backup: BackupEntry }>(`/services/${serviceId}/backups`),
    onSuccess: (res) => {
      toast(`Backup creado: ${res.backup.file} (${fmtBytes(res.backup.size)})`, 'ok');
      invalidate();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const restore = useMutation({
    mutationFn: (file: string) => api.post(`/services/${serviceId}/backups/${file}/restore`, { confirm: true }),
    onSuccess: () => {
      toast('Backup restaurado', 'ok');
      setRestoreFile(null);
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const remove = useMutation({
    mutationFn: (file: string) => api.del(`/services/${serviceId}/backups/${file}`),
    onSuccess: () => {
      setDeleteFile(null);
      invalidate();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  if (backups.isLoading) return <Spinner label="Cargando backups..." />;

  if (backups.data && !backups.data.supported) {
    return (
      <p className="p-6 text-center text-sm text-sub">
        Este servicio no soporta backups desde el panel (solo PostgreSQL, MySQL y MongoDB).
      </p>
    );
  }

  const list = backups.data?.backups ?? [];

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-sub">
          Volcado completo comprimido, guardado en el servidor (<span className="font-mono">DATA_DIR/backups</span>).
          Descárgalos también fuera del servidor para estar cubierto ante un fallo de disco.
        </p>
        <Button size="sm" onClick={() => create.mutate()} loading={create.isPending}>
          <Plus size={13} /> Crear backup
        </Button>
      </div>

      {create.isPending && (
        <p className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
          Creando backup... con bases de datos grandes puede tardar varios minutos.
        </p>
      )}

      {list.length === 0 && !create.isPending && (
        <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-sub">
          <Archive size={24} className="text-sub/50" />
          Sin backups todavía. Crea el primero — mejor antes de cualquier cambio delicado.
        </div>
      )}

      <div className="space-y-2">
        {list.map((b) => (
          <div key={b.file} className="card flex items-center justify-between gap-2 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate font-mono text-xs">{b.file}</p>
              <p className="text-xs text-sub">
                {fmtBytes(b.size)} · {fmtDateTime(b.createdAt)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <a
                href={`/api/services/${serviceId}/backups/${b.file}/download`}
                className="rounded-md p-1.5 text-sub hover:bg-panel2 hover:text-txt"
                title="Descargar"
                download
              >
                <Download size={14} />
              </a>
              <button
                onClick={() => setRestoreFile(b.file)}
                className="rounded-md p-1.5 text-sub hover:bg-panel2 hover:text-warn"
                title="Restaurar"
              >
                <RotateCcw size={14} />
              </button>
              <button
                onClick={() => setDeleteFile(b.file)}
                className="rounded-md p-1.5 text-sub hover:bg-panel2 hover:text-err"
                title="Eliminar"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <ConfirmModal
        open={!!restoreFile}
        onClose={() => setRestoreFile(null)}
        onConfirm={() => restoreFile && restore.mutate(restoreFile)}
        loading={restore.isPending}
        title="Restaurar backup"
        confirmLabel="Sí, restaurar"
        message={`Se sobrescribirán los datos actuales de la base de datos con el contenido de "${restoreFile}". Las aplicaciones conectadas verán el cambio al instante. ¿Continuar?`}
      />
      <ConfirmModal
        open={!!deleteFile}
        onClose={() => setDeleteFile(null)}
        onConfirm={() => deleteFile && remove.mutate(deleteFile)}
        loading={remove.isPending}
        title="Eliminar backup"
        message={`Se eliminará "${deleteFile}" del servidor. Si no lo has descargado, no habrá copia.`}
      />
    </div>
  );
}
