import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, HardDrive, Trash2 } from 'lucide-react';
import { api } from '../api';
import { Button, ConfirmModal, ErrorState, Skeleton, useToast } from './ui';
import { fmtBytes, fmtDate } from '../utils';

interface OrphanVolume {
  name: string;
  sizeBytes: number | null;
  createdAt: string | null;
}

interface OrphanBackup {
  serviceId: string;
  files: number;
  sizeBytes: number;
  updatedAt: number;
  /** Copia más reciente: su nombre lleva el proyecto y el servicio. */
  latestFile: string | null;
}

interface OrphansResponse {
  docker: boolean;
  volumes: OrphanVolume[];
  volumesError: string | null;
  backups: OrphanBackup[];
  confirmWord: string;
}

interface PurgeResponse {
  deleted: { volumes: string[]; backups: string[] };
  skipped: { kind: 'volume' | 'backup'; name: string; reason: string }[];
  failed: { kind: 'volume' | 'backup'; name: string; error: string }[];
}

/** Lo que se va a eliminar al confirmar: un elemento o todos. */
interface Target {
  title: string;
  message: string;
  volumes: string[];
  backups: string[];
}

function sizeOf(bytes: number | null): string {
  return bytes === null ? 'tamaño pendiente de medir' : fmtBytes(bytes);
}

function cuenta(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Ajustes → Datos sin proyecto. Volúmenes de Docker y copias de seguridad que
 * dejaron proyectos o servicios ya eliminados (antes, borrar sin marcar la
 * casilla de volúmenes los dejaba en el servidor). El servidor decide qué es
 * huérfano con una regla conservadora y la vuelve a aplicar al eliminar: esta
 * vista solo propone.
 */
export default function OrphanData() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<Target | null>(null);

  const orphans = useQuery({
    queryKey: ['orphans'],
    queryFn: () => api.get<OrphansResponse>('/system/orphans'),
    staleTime: 30_000,
    retry: false,
    // La primera medición de `docker system df` puede tardar más que la
    // consulta: mientras falte algún tamaño, se vuelve a preguntar.
    refetchInterval: (q) => (q.state.data?.volumes.some((v) => v.sizeBytes === null) ? 15_000 : false),
  });
  const word = orphans.data?.confirmWord ?? 'eliminar';

  const purge = useMutation({
    mutationFn: (t: Target) => api.post<PurgeResponse>('/system/orphans/purge', { confirm: word, volumes: t.volumes, backups: t.backups }),
    onSuccess: (res) => {
      setTarget(null);
      const borrados = res.deleted.volumes.length + res.deleted.backups.length;
      if (borrados > 0) toast(borrados === 1 ? 'Se ha eliminado 1 elemento.' : `Se han eliminado ${borrados} elementos.`, 'ok');
      const pendientes = [
        ...res.skipped.map((s) => `${s.name}: ${s.reason}`),
        ...res.failed.map((f) => `${f.name}: ${f.error}`),
      ];
      if (pendientes.length > 0) {
        toast(`No se ha eliminado: ${pendientes.join(' · ')}`, 'info', { persist: true });
      }
      queryClient.invalidateQueries({ queryKey: ['orphans'] });
      queryClient.invalidateQueries({ queryKey: ['dockerUsage'] });
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  if (orphans.isLoading) return <Skeleton className="h-24 w-full rounded-lg" />;

  if (orphans.isError || !orphans.data) {
    return (
      <ErrorState
        compact
        className="rounded-lg border border-dashed border-line"
        title="No se han podido comprobar los datos sin proyecto"
        error={orphans.error}
        onRetry={() => orphans.refetch()}
        retrying={orphans.isFetching}
      />
    );
  }

  const { docker, volumes, volumesError, backups } = orphans.data;
  const total =
    volumes.reduce((acc, v) => acc + (v.sizeBytes ?? 0), 0) + backups.reduce((acc, b) => acc + b.sizeBytes, 0);
  const count = volumes.length + backups.length;
  // `docker system df` puede no haber terminado a tiempo: el total es entonces
  // un mínimo, o nada si no se ha medido ningún volumen y no hay copias.
  const sinMedir = volumes.some((v) => v.sizeBytes === null);
  const nadaMedido = sinMedir && volumes.every((v) => v.sizeBytes === null) && backups.length === 0;
  const totalTexto = nadaMedido ? 'tamaño pendiente de medir' : `${fmtBytes(total)}${sinMedir ? ' como mínimo' : ''}`;
  const partes = [
    ...(volumes.length > 0 ? [cuenta(volumes.length, 'volumen', 'volúmenes')] : []),
    ...(backups.length > 0 ? [cuenta(backups.length, 'carpeta de copias de seguridad', 'carpetas de copias de seguridad')] : []),
  ];

  const askAll = () =>
    setTarget({
      title: 'Eliminar todos los datos sin proyecto',
      message: `Se eliminarán ${partes.join(' y ')} (${totalTexto}). Los datos no se podrán recuperar.`,
      volumes: volumes.map((v) => v.name),
      backups: backups.map((b) => b.serviceId),
    });

  return (
    <div className="flex flex-col gap-3">
      {!docker && (
        <p className="rounded-lg border border-warn/30 bg-warn/[.08] px-3 py-2 text-xs text-warn">
          Docker no está disponible: no se pueden comprobar los volúmenes. Se muestran solo las copias de seguridad.
        </p>
      )}
      {volumesError && (
        <p className="rounded-lg border border-warn/30 bg-warn/[.08] px-3 py-2 text-xs text-warn">{volumesError}</p>
      )}

      {count === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3.5 py-4 text-center text-xs text-subtle">
          No hay datos sin proyecto en el servidor.
        </p>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-line">
            {volumes.map((v) => (
              <div key={v.name} className="flex items-center gap-3 border-b border-line/60 bg-bg px-3.5 py-2 text-xs last:border-b-0">
                <HardDrive size={13} aria-hidden className="shrink-0 text-subtle" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs text-sub" title={v.name}>
                    {v.name}
                  </p>
                  <p className="mt-px truncate text-xs text-subtle">
                    Volumen de Docker{v.createdAt ? ` · creado el ${fmtDate(Date.parse(v.createdAt))}` : ''}
                  </p>
                </div>
                <span className="tnum shrink-0 text-xs text-subtle" title={v.sizeBytes === null ? 'Tamaño pendiente de medir' : undefined}>
                  {v.sizeBytes === null ? 'Midiendo…' : fmtBytes(v.sizeBytes)}
                </span>
                <button
                  onClick={() =>
                    setTarget({
                      title: 'Eliminar volumen',
                      message: `Se eliminará el volumen «${v.name}» (${sizeOf(v.sizeBytes)}). Los datos no se podrán recuperar.`,
                      volumes: [v.name],
                      backups: [],
                    })
                  }
                  className="rounded-md p-1 text-subtle transition-colors hover:bg-err/10 hover:text-err max-sm:p-2.5"
                  title="Eliminar volumen"
                  aria-label={`Eliminar el volumen ${v.name}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {backups.map((b) => (
              <div key={b.serviceId} className="flex items-center gap-3 border-b border-line/60 bg-bg px-3.5 py-2 text-xs last:border-b-0">
                <Archive size={13} aria-hidden className="shrink-0 text-subtle" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs text-sub" title={b.latestFile ?? undefined}>
                    {b.latestFile ?? `backups/${b.serviceId}`}
                  </p>
                  <p className="mt-px truncate text-xs text-subtle">
                    {b.files === 0
                      ? 'Carpeta vacía'
                      : cuenta(b.files, 'copia de seguridad', 'copias de seguridad')}{' '}
                    de un servicio eliminado · backups/{b.serviceId} · {fmtDate(b.updatedAt)}
                  </p>
                </div>
                <span className="tnum shrink-0 text-xs text-subtle">{fmtBytes(b.sizeBytes)}</span>
                <button
                  onClick={() =>
                    setTarget({
                      title: 'Eliminar copias de seguridad',
                      message:
                        b.files === 0
                          ? `Se eliminará la carpeta vacía «backups/${b.serviceId}».`
                          : `Se eliminará la carpeta «backups/${b.serviceId}» con ${cuenta(b.files, 'copia', 'copias')} (${fmtBytes(b.sizeBytes)}). Las copias no se podrán recuperar.`,
                      volumes: [],
                      backups: [b.serviceId],
                    })
                  }
                  className="rounded-md p-1 text-subtle transition-colors hover:bg-err/10 hover:text-err max-sm:p-2.5"
                  title="Eliminar copias de seguridad"
                  aria-label={`Eliminar las copias de seguridad de ${b.serviceId}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="tnum text-xs text-subtle">
              {count === 1 ? '1 elemento' : `${count} elementos`} · {totalTexto}
            </span>
            <Button variant="danger" size="sm" onClick={askAll}>
              <Trash2 size={13} /> Eliminar todo
            </Button>
          </div>
        </>
      )}

      <ConfirmModal
        open={!!target}
        onClose={() => setTarget(null)}
        onConfirm={() => target && purge.mutate(target)}
        loading={purge.isPending}
        title={target?.title ?? 'Eliminar'}
        message={target?.message ?? ''}
        typeToConfirm={word}
        typeToConfirmIgnoreCase
      >
        <p className="mt-2 text-xs text-subtle">
          Antes de eliminar, el servidor vuelve a comprobar cada elemento y conserva lo que ya pertenezca a un servicio o
          esté en uso.
        </p>
      </ConfirmModal>
    </div>
  );
}
