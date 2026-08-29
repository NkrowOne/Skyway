import { lazy, Suspense, useState } from 'react';
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

/** Programación de backups automáticos (diario/semanal con retención). */
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
      toast(schedule ? 'Backups automáticos activados' : 'Backups automáticos desactivados', 'ok');
      onChanged();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  return (
    <div className="rounded-xl border border-line bg-bg p-4">
      <div className="mb-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <CalendarClock size={14} className="text-acc-soft" />
          Backups automáticos
        </h3>
        <p className="mt-1 text-xs text-subtle">Se ejecutan de madrugada, con retención automática</p>
      </div>
      <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2.5">
        <Field label="Frecuencia">
          <select className="input" value={schedule} onChange={(e) => setSchedule(e.target.value)}>
            <option value="">Desactivados</option>
            <option value="daily">Diaria (~04:00)</option>
            <option value="weekly">Semanal (~04:00)</option>
          </select>
        </Field>
        <Field label="Conservar">
          <input className="input tnum" type="number" min={1} max={60} value={retention} onChange={(e) => setRetention(e.target.value)} />
        </Field>
        <Button variant="secondary" size="sm" className="mb-px h-9" onClick={() => save.mutate()} loading={save.isPending}>
          Guardar
        </Button>
      </div>
      <p className="mt-2.5 text-xs text-subtle">
        Si un backup programado falla recibirás una alerta con la causa. Descarga copias fuera del servidor de vez en cuando.
      </p>
    </div>
  );
}

export default function BackupsTab({ serviceId, service, onChanged }: { serviceId: string; service: Service; onChanged: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [restoreFile, setRestoreFile] = useState<string | null>(null);
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
        Este servicio no soporta backups desde el panel (solo PostgreSQL, MySQL y MongoDB).
      </p>
    );
  }

  const list = backups.data?.backups ?? [];

  return (
    <div className="flex flex-col gap-3.5 p-4 sm:px-5">
      <ScheduleSection service={service} onChanged={onChanged} />

      {/*
        Migrar desde fuera vive junto a los backups porque es la misma idea:
        meter datos en esta base. Es el último paso de una migración de Railway
        y antes obligaba a entrar por SSH al servidor.
      */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-line bg-bg px-4 py-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Database size={14} className="text-info" />
            Importar desde otra base de datos
          </h3>
          <p className="mt-1 text-xs text-subtle">
            Vuelca aquí una base externa (la de Railway, por ejemplo) con su URL de conexión pública.
          </p>
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

      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <p className="text-xs text-sub">
          {list.length > 0 ? (
            <>
              Último backup <span className="text-txt">{timeAgo(list[0].createdAt)}</span> · en{' '}
              <span className="font-mono text-xs">DATA_DIR/backups</span>
            </>
          ) : (
            <>
              Volcado completo comprimido, en <span className="font-mono text-xs">DATA_DIR/backups</span>
            </>
          )}
        </p>
        <Button size="sm" onClick={() => create.mutate()} loading={create.isPending}>
          <Plus size={13} /> Crear backup ahora
        </Button>
      </div>

      {create.isPending && (
        <p className="rounded-lg border border-warn/30 bg-warn/[.06] px-3 py-2 text-xs text-warn">
          Creando backup… con bases de datos grandes puede tardar varios minutos.
        </p>
      )}

      {list.length === 0 && !create.isPending && (
        <div className="rounded-xl border border-line bg-bg">
          <EmptyState
            icon={<Archive />}
            title="Sin copias de seguridad"
            description="Crea la primera antes de cualquier cambio delicado: restaurarla es cuestión de un clic."
          />
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
              <div className="flex shrink-0 items-center gap-0.5">
                <a
                  href={`/api/services/${serviceId}/backups/${b.file}/download`}
                  className="rounded-md p-1.5 leading-none text-subtle transition-colors hover:bg-surface2 hover:text-txt"
                  title="Descargar"
                  download
                >
                  <Download size={14} />
                </a>
                <button
                  onClick={() => setRestoreFile(b.file)}
                  className="rounded-md p-1.5 leading-none text-subtle transition-colors hover:bg-surface2 hover:text-warn"
                  title="Restaurar"
                >
                  <RotateCcw size={14} />
                </button>
                <button
                  onClick={() => setDeleteFile(b.file)}
                  className="rounded-md p-1.5 leading-none text-subtle transition-colors hover:bg-surface2 hover:text-err"
                  title="Eliminar"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

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
