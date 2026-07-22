import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Megaphone, RefreshCw, Signal } from 'lucide-react';
import { api } from '../api';
import { StatusPageConfig } from '../types';
import { Button, ConfirmModal, CopyButton, Field, Modal, Skeleton, useToast } from './ui';

/**
 * Gestión de la página de estado pública del proyecto: el enlace que se
 * comparte con el cliente para que vea la disponibilidad sin entrar al panel.
 */
export default function StatusPageModal({
  open,
  onClose,
  projectId,
  isAdmin,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  isAdmin: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState('');
  const [confirmRotate, setConfirmRotate] = useState(false);

  const config = useQuery({
    queryKey: ['statusPage', projectId],
    queryFn: () => api.get<StatusPageConfig>(`/projects/${projectId}/status-page`),
    enabled: open,
  });

  // Sincroniza el borrador solo cuando cambia el VALOR del aviso en el
  // servidor: un refetch por rotar el enlace o cambiar el toggle no debe
  // machacar lo que el admin esté escribiendo.
  const serverNotice = config.data ? config.data.notice ?? '' : null;
  useEffect(() => {
    if (serverNotice !== null) setNotice(serverNotice);
  }, [serverNotice]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['statusPage', projectId] });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.post<StatusPageConfig>(`/projects/${projectId}/status-page`, { enabled }),
    onSuccess: (data) => {
      invalidate();
      toast(data.enabled ? 'Página de estado activada' : 'Página de estado desactivada', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const saveNotice = useMutation({
    mutationFn: (value: string) =>
      api.post<StatusPageConfig>(`/projects/${projectId}/status-page`, { notice: value.trim() || null }),
    onSuccess: (data) => {
      invalidate();
      toast(data.notice ? 'Aviso publicado en la página de estado' : 'Aviso retirado', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const rotate = useMutation({
    mutationFn: () => api.post<StatusPageConfig>(`/projects/${projectId}/status-page/rotate`),
    onSuccess: () => {
      setConfirmRotate(false);
      invalidate();
      toast('Enlace rotado: el anterior ya no funciona', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const enabled = config.data?.enabled ?? false;
  const url = config.data?.token ? `${window.location.origin}/status/${config.data.token}` : null;

  return (
    <Modal open={open} onClose={onClose} title="Página de estado para el cliente">
      {config.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-[13px] leading-relaxed text-sub">
            Un dashboard público con el estado en vivo de los servicios de este proyecto, su disponibilidad de los
            últimos 90 días y las incidencias. Sin login: comparte el enlace con tu cliente y listo.
          </p>

          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-line bg-bg px-4 py-3">
            <span className="flex items-center gap-2.5 text-sm font-medium">
              <Signal size={15} className={enabled ? 'text-ok' : 'text-subtle'} />
              Página de estado pública
            </span>
            <input
              type="checkbox"
              checked={enabled}
              disabled={!isAdmin || toggle.isPending}
              onChange={(e) => toggle.mutate(e.target.checked)}
              className="h-4 w-4 accent-acc"
            />
          </label>

          {enabled && url && (
            <>
              <div className="flex items-center justify-between gap-2 rounded-xl border border-line bg-bg px-3.5 py-2.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-txt">{url}</span>
                <span className="flex shrink-0 items-center gap-0.5">
                  <CopyButton value={url} title="Copiar enlace" />
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md p-1 text-subtle transition-colors hover:bg-surface2 hover:text-txt"
                    title="Abrir la página"
                  >
                    <ExternalLink size={13} />
                  </a>
                </span>
              </div>
              {isAdmin && (
                <Field
                  label={
                    <>
                      <Megaphone size={12} /> Aviso de mantenimiento
                    </>
                  }
                  hint="Se muestra como banner en la página pública. Vacío = sin aviso."
                >
                  <div className="flex flex-col gap-2">
                    <textarea
                      className="input min-h-[64px] resize-y py-2 text-[13px] leading-relaxed"
                      maxLength={500}
                      placeholder="Ej: Mantenimiento programado el sábado de 02:00 a 03:00 — puede haber cortes breves."
                      value={notice}
                      onChange={(e) => setNotice(e.target.value)}
                    />
                    {notice.trim() !== (config.data?.notice ?? '') && (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setNotice(config.data?.notice ?? '')}>
                          Descartar
                        </Button>
                        <Button size="sm" onClick={() => saveNotice.mutate(notice)} loading={saveNotice.isPending}>
                          {notice.trim() ? 'Publicar aviso' : 'Retirar aviso'}
                        </Button>
                      </div>
                    )}
                  </div>
                </Field>
              )}
              {isAdmin && (
                <div className="flex items-center justify-between gap-3 border-t border-line pt-3.5">
                  <p className="text-[11px] leading-relaxed text-subtle">
                    ¿Enlace filtrado o cliente que ya no debe verlo? Genera uno nuevo: el anterior deja de funcionar al
                    instante.
                  </p>
                  <Button size="sm" variant="secondary" onClick={() => setConfirmRotate(true)} loading={rotate.isPending}>
                    <RefreshCw size={12} /> Rotar enlace
                  </Button>
                </div>
              )}
            </>
          )}

          {!isAdmin && !enabled && (
            <p className="text-[11px] text-subtle">Solo un administrador puede activar la página de estado.</p>
          )}
        </div>
      )}

      <ConfirmModal
        open={confirmRotate}
        onClose={() => setConfirmRotate(false)}
        onConfirm={() => rotate.mutate()}
        loading={rotate.isPending}
        title="Rotar enlace"
        message="Se generará un enlace nuevo y el actual dejará de funcionar al instante. Tendrás que reenviar el nuevo a quien deba ver la página."
        confirmLabel="Rotar enlace"
        confirmVariant="primary"
      />
    </Modal>
  );
}
