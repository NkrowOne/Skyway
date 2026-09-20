import { lazy, Suspense, useState } from 'react';
import { useLatched } from '../../hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, CalendarClock, Database, Download, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { Service } from '../../types';
import { fmtBytes, fmtDateTime, timeAgo } from '../../utils';
import { Button, ConfirmModal, EmptyState, Field, Skeleton, useToast } from '../ui';

// Solo se descarga al abrirlo: trae su propio visor de log.
const DataMigrationModal = lazy(() => import('../DataMigrationModal'));

interface BackupEntry {
  file: string;
  size: number;
  createdAt: number;
}

/** Programación de copias automáticas (diaria/semanal con retención). */
function ScheduleSection({ service, onChanged }: { service: Service; onChanged: () => void }) {
  const toast = useToast();
  const [schedule, setSchedule] = useState<string>(service.config.backupSchedule ?? '');
  const [retention, setRetention] = useState(String(service.config.backupRetention ?? 7));

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/services/${service.id}`, {
        config: {
          backupSchedule: schedule === '' ? null : schedule,
          backupRetention: Math.max(1, Number(retention) || 7),
        },
      }),
    onSuccess: () => {
      toast(schedule ? 'Copias automáticas activadas.' : 'Copias automáticas desactivadas.', 'ok');
      onChanged();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  return (
    <div className="rounded-xl border border-line bg-bg p-4">
      <div className="mb-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <CalendarClock size={14} className="text-acc-soft" />
          Copias automáticas
        </h3>
        <p className="mt-1 text-xs text-subtle">Se ejecutan de madrugada, con retención automática</p>
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Frecuencia">
          <select className="input" value={schedule} onChange={(e) => setSchedule(e.target.value)}>
            <option value="">Desactivadas</option>
            <option value="daily">Diaria (~04:00)</option>
            <option value="weekly">Semanal (~04:00)</option>
          </select>
        </Field>
        <Field label="Conservar">
          <input
            className="input tnum"
            type="number"
            inputMode="numeric"
            min={1}
            max={60}
            value={retention}
            onChange={(e) => setRetention(e.target.value)}
          />
        </Field>
        <Button variant="secondary" size="sm" className="h-9 sm:mb-px" onClick={() => save.mutate()} loading={save.isPending}>
          Guardar
        </Button>
      </div>
      <p className="mt-2.5 text-xs text-subtle">Si una copia programada falla, se generará una alerta.</p>
    </div>
  );
}

export default function BackupsTab({ serviceId, service, onChanged }: { serviceId: string; service: Service; onChanged: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [restoreFile, setRestoreFile] = useState<string | null>(null);
  const restoreShown = useLatched(restoreFile);
  const [deleteFile, setDeleteFile] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);

  const backups = useQuery({
    queryKey: ['backups', serviceId],
    queryFn: () => api.get<{ supported: boolean; backups: BackupEntry[] }>(`/services/${serviceId}/backups`),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['backups', serviceId] });

  const create = useMutation({
    mutationFn: () => api.post<{ backup: BackupEntry }>(`/services/${serviceId}/backups`),
    onSuccess: (res) => {
      toast(`Copia creada: ${res.backup.file} (${fmtBytes(res.backup.size)})`, 'ok');
      invalidate();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  // El nombre va codificado en las tres rutas: lo genera el servidor, pero un
  // carácter fuera de lo esperado (un `#`, un `?`) rompería la URL en silencio.
  const restore = useMutation({
    mutationFn: (file: string) => api.post(`/services/${serviceId}/backups/${encodeURIComponent(file)}/restore`, { confirm: true }),
    onSuccess: () => {
      toast('Copia restaurada.', 'ok');
      setRestoreFile(null);
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const remove = useMutation({
    mutationFn: (file: string) => api.del(`/services/${serviceId}/backups/${encodeURIComponent(file)}`),
    onSuccess: () => {
      setDeleteFile(null);
      invalidate();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  if (backups.isLoading) {
    return (
      <div aria-busy className="flex flex-col gap-3.5 p-4 sm:px-5">
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    );
  }

  if (backups.data && !backups.data.supported) {
    return (
      <p className="p-6 text-center text-sm text-sub">
        Este servicio no admite copias de seguridad desde el panel (solo PostgreSQL, MySQL y MongoDB).
      </p>
    );
  }

  const list = backups.data?.backups ?? [];
  const createNow = (
    <Button size="sm" onClick={() => create.mutate()} loading={create.isPending}>
      <Plus size={13} /> Crear copia ahora
    </Button>
  );

  return (
    <div className="flex flex-col gap-3.5 p-4 sm:px-5">
      {/* Lo primero es lo que ya hay: las copias existentes y el botón para
          hacer una. La programación y la importación son configuración y van después. */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <p className="text-xs text-sub">
          {list.length > 0 ? (
            <>
              Última copia <span className="text-txt">{timeAgo(list[0].createdAt)}</span> · en{' '}
              <span className="font-mono text-xs">DATA_DIR/backups</span>
            </>
          ) : (
            <>
              Volcado completo comprimido, en <span className="font-mono text-xs">DATA_DIR/backups</span>
            </>
          )}
        </p>
        {list.length > 0 && createNow}
      </div>

      {create.isPending && (
        <p className="rounded-lg border border-warn/30 bg-warn/[.06] px-3 py-2 text-xs text-warn">
          Creando la copia… Con bases de datos grandes puede tardar varios minutos.
        </p>
      )}

      {list.length === 0 && !create.isPending && (
        <div className="rounded-xl border border-line bg-bg">
          <EmptyState icon={<Archive />} title="No hay copias de esta base de datos" action={createNow} />
        </div>
      )}

      {list.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-line bg-bg">
          {list.map((b) => (
            <div key={b.file} className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-3 last:border-b-0">
              <div className="flex min-w-0 items-center gap-2.5">
                <Archive size={14} className="shrink-0 text-subtle" />
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs">{b.file}</p>
                  <p className="tnum mt-px text-xs text-subtle">
                    {fmtBytes(b.size)} · {fmtDateTime(b.createdAt)}
                  </p>
                </div>
              </div>
              {/* Eliminar va aparte, tras un divisor: al lado de Restaurar se
                  pulsaba por error, y aquí un error borra la única copia. */}
              <div className="flex shrink-0 items-center gap-0.5">
                <a
                  href={`/api/services/${serviceId}/backups/${encodeURIComponent(b.file)}/download`}
                  className="press rounded-md p-1.5 leading-none text-subtle transition-colors hover:bg-surface2 hover:text-txt max-sm:p-2.5"
                  title="Descargar"
                  aria-label={`Descargar ${b.file}`}
                  download
                >
                  <Download size={14} />
                </a>
                <button
                  onClick={() => setRestoreFile(b.file)}
                  className="press rounded-md p-1.5 leading-none text-warn/80 transition-colors hover:bg-warn/10 hover:text-warn max-sm:p-2.5"
                  title="Restaurar"
                  aria-label={`Restaurar ${b.file}`}
                >
                  <RotateCcw size={14} />
                </button>
                <span aria-hidden className="mx-1 h-4 w-px bg-line" />
                <button
                  onClick={() => setDeleteFile(b.file)}
                  className="press rounded-md p-1.5 leading-none text-subtle transition-colors hover:bg-err/10 hover:text-err max-sm:p-2.5"
                  title="Eliminar"
                  aria-label={`Eliminar ${b.file}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ScheduleSection service={service} onChanged={onChanged} />

      {/*
        Importar desde fuera vive junto a las copias porque es la misma idea:
        meter datos en esta base. Antes obligaba a entrar por SSH al servidor.
      */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-line bg-bg px-4 py-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Database size={14} className="text-info" />
            Importar desde otra base de datos
          </h3>
          <p className="mt-1 text-xs text-subtle">Importa el contenido de una base de datos externa a partir de su URL de conexión.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setMigrating(true)}>
          Copiar datos
        </Button>
      </div>

      {migrating && (
        <Suspense fallback={null}>
          <DataMigrationModal
            open
            onClose={() => setMigrating(false)}
            serviceId={service.id}
            serviceName={service.name}
          />
        </Suspense>
      )}

      <ConfirmModal
        open={!!restoreFile}
        onClose={() => setRestoreFile(null)}
        onConfirm={() => restoreFile && restore.mutate(restoreFile)}
        loading={restore.isPending}
        title="Restaurar copia"
        confirmLabel="Restaurar"
        message={`Se sobrescribirán los datos actuales de la base de datos con el contenido de «${restoreShown ?? ''}». Las aplicaciones conectadas verán el cambio de inmediato.`}
      />
      <ConfirmModal
        open={!!deleteFile}
        onClose={() => setDeleteFile(null)}
        onConfirm={() => deleteFile && remove.mutate(deleteFile)}
        loading={remove.isPending}
        title="Eliminar copia"
        message={`Se eliminará «${deleteFile}» del servidor. Si no se ha descargado previamente, no quedará ninguna copia.`}
      />
    </div>
  );
}
