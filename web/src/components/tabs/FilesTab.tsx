import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  HardDrive,
  Link2,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { api } from '../../api';
import { DirListing, FileEntry } from '../../types';
import { cx, fmtBytes } from '../../utils';
import { Button, ConfirmModal, Skeleton, useToast } from '../ui';

/** Une un directorio y un nombre en una ruta absoluta POSIX. */
function joinPath(dir: string, name: string): string {
  if (dir === '/') return `/${name}`;
  return `${dir.replace(/\/$/, '')}/${name}`;
}

function parentPath(dir: string): string {
  if (dir === '/' || !dir.includes('/')) return '/';
  const trimmed = dir.replace(/\/$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
}

/** Segmentos de la ruta para las migas de pan. */
function crumbs(dir: string): { label: string; path: string }[] {
  const out: { label: string; path: string }[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const seg of dir.split('/').filter(Boolean)) {
    acc += `/${seg}`;
    out.push({ label: seg, path: acc });
  }
  return out;
}

export default function FilesTab({ serviceId }: { serviceId: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dir, setDir] = useState('/');
  const [deleting, setDeleting] = useState<FileEntry | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const listing = useQuery({
    queryKey: ['files', serviceId, dir],
    queryFn: () => api.get<{ listing: DirListing }>(`/services/${serviceId}/files?path=${encodeURIComponent(dir)}`),
    retry: false,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['files', serviceId, dir] });

  const mkdir = useMutation({
    mutationFn: (path: string) => api.post(`/services/${serviceId}/files/mkdir`, { path }),
    onSuccess: () => {
      toast('Carpeta creada', 'ok');
      invalidate();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const del = useMutation({
    mutationFn: (entry: FileEntry) =>
      api.post(`/services/${serviceId}/files/delete`, {
        path: joinPath(dir, entry.name),
        recursive: entry.type === 'dir',
      }),
    onSuccess: () => {
      toast('Eliminado', 'ok');
      setDeleting(null);
      invalidate();
    },
    onError: (err: Error) => {
      toast(err.message, 'err');
      setDeleting(null);
    },
  });

  const download = async (entry: FileEntry) => {
    try {
      const res = await fetch(
        `/api/services/${serviceId}/files/download?path=${encodeURIComponent(joinPath(dir, entry.name))}`,
        { credentials: 'same-origin' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Error ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = entry.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) {
      toast((err as Error).message, 'err');
    }
  };

  const onUpload = async (file: File) => {
    setUploading(true);
    try {
      const res = await fetch(
        `/api/services/${serviceId}/files/upload?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Error ${res.status}`);
      }
      toast(`Subido: ${file.name}`, 'ok');
      invalidate();
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const newFolder = () => {
    const name = window.prompt('Nombre de la nueva carpeta:');
    if (!name || !name.trim()) return;
    mkdir.mutate(joinPath(dir, name.trim()));
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 sm:px-5">
      {/* Migas de pan + acciones */}
      <div className="shrink-0 flex flex-wrap items-center gap-1.5 text-xs">
        <HardDrive size={13} className="shrink-0 text-subtle" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 font-mono text-xs">
          {crumbs(dir).map((c, i, arr) => (
            <span key={c.path} className="flex items-center gap-0.5">
              <button
                onClick={() => setDir(c.path)}
                className={cx(
                  'max-w-[160px] truncate rounded px-1 py-0.5 transition-colors hover:bg-surface2 hover:text-txt',
                  i === arr.length - 1 ? 'text-txt' : 'text-sub',
                )}
              >
                {c.label}
              </button>
              {i < arr.length - 1 && <ChevronRight size={11} className="text-subtle" />}
            </span>
          ))}
        </div>
        <button
          onClick={() => listing.refetch()}
          className="rounded-md p-1 text-subtle transition-colors hover:bg-surface2 hover:text-txt"
          title="Recargar"
        >
          <RefreshCw size={12} className={cx(listing.isFetching && 'animate-spin')} />
        </button>
      </div>

      <div className="shrink-0 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()} loading={uploading}>
          <Upload size={13} /> Subir
        </Button>
        <Button size="sm" variant="secondary" onClick={newFolder} loading={mkdir.isPending}>
          <FolderPlus size={13} /> Nueva carpeta
        </Button>
        <input
          ref={fileInput}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onUpload(file);
          }}
        />
      </div>

      {/* Listado */}
      {listing.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full rounded-lg" />
          ))}
        </div>
      ) : listing.isError ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-warn/30 bg-warn/[.08] px-4 py-3 text-sm text-warn">
          <TriangleAlert size={16} className="mt-px shrink-0" />
          <div>
            <p className="font-medium">No se pudo abrir el explorador</p>
            <p className="mt-0.5 text-xs text-sub">{(listing.error as Error).message}</p>
            <Button size="sm" variant="secondary" className="mt-2.5" onClick={() => listing.refetch()}>
              <RefreshCw size={12} /> Reintentar
            </Button>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-line">
          {dir !== '/' && (
            <button
              onClick={() => setDir(parentPath(dir))}
              className="flex w-full items-center gap-2 border-b border-line/60 px-3 py-2 text-left text-xs text-sub transition-colors hover:bg-surface2"
            >
              <Folder size={14} className="text-subtle" />
              <span className="font-mono">..</span>
            </button>
          )}
          {(listing.data?.listing.entries ?? []).length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-subtle">Carpeta vacía.</p>
          ) : (
            (listing.data?.listing.entries ?? []).map((entry) => (
              <div
                key={entry.name}
                className="group flex items-center gap-2 border-b border-line/60 px-3 py-2 text-xs last:border-b-0 hover:bg-surface2"
              >
                {entry.type === 'dir' ? (
                  <button
                    onClick={() => setDir(joinPath(dir, entry.name))}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <Folder size={14} className="shrink-0 text-acc-soft" />
                    <span className="truncate font-mono text-sub group-hover:text-txt">{entry.name}</span>
                  </button>
                ) : (
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    {entry.type === 'symlink' ? (
                      <Link2 size={14} className="shrink-0 text-subtle" />
                    ) : (
                      <FileIcon size={14} className="shrink-0 text-subtle" />
                    )}
                    <span className="truncate font-mono text-sub" title={entry.target ? `→ ${entry.target}` : undefined}>
                      {entry.name}
                      {entry.target && <span className="text-subtle"> → {entry.target}</span>}
                    </span>
                  </div>
                )}
                <span className="tnum shrink-0 text-micro text-subtle">{entry.perms}</span>
                {entry.type === 'file' && (
                  <span className="tnum w-16 shrink-0 text-right text-micro text-subtle">{fmtBytes(entry.size)}</span>
                )}
                <div className="flex shrink-0 items-center gap-0.5">
                  {entry.type === 'file' && (
                    <button
                      onClick={() => download(entry)}
                      className="rounded-md p-1 text-subtle transition-colors hover:bg-bg hover:text-txt"
                      title="Descargar"
                    >
                      <Download size={13} />
                    </button>
                  )}
                  {entry.type !== 'symlink' && (
                    <button
                      onClick={() => setDeleting(entry)}
                      className="rounded-md p-1 text-subtle transition-colors hover:bg-err/10 hover:text-err"
                      title="Eliminar"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      <p className="text-xs leading-relaxed text-subtle">
        Explora los archivos del contenedor sin FTP ni credenciales: va por el socket de Docker con tu sesión del panel.
        Subidas hasta 100 MB, descargas hasta 50 MB. Cada cambio queda en el registro de actividad.
      </p>

      <ConfirmModal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && del.mutate(deleting)}
        loading={del.isPending}
        title={`Eliminar ${deleting?.type === 'dir' ? 'carpeta' : 'archivo'}`}
        message={
          deleting?.type === 'dir'
            ? `Se eliminará la carpeta "${deleting?.name}" y todo su contenido dentro del contenedor. Esta acción no se puede deshacer.`
            : `Se eliminará "${deleting?.name}" dentro del contenedor. Esta acción no se puede deshacer.`
        }
      />
    </div>
  );
}
