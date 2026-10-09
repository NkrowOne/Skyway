import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Eye, Mail, Send } from 'lucide-react';
import { api } from '../api';
import { VALIDEZ_DIAS, fmtCaducidad, mailtoBienvenida } from '../bienvenida';
import { MailInvite, MailInviteLink, MailInviteStatus, MailInvitesView } from '../types';
import { fmtDateTime, safeHref, Tone } from '../utils';
import { Button, Chip, ConfirmModal, CopyButton, EmptyState, ErrorState, Field, Modal, Skeleton, useToast } from './ui';

/**
 * Configuración inicial del correo: el enlace de bienvenida de Mailway para la
 * persona de contacto del cliente. Con él crea su propio acceso al panel de
 * Mailway y entra en un asistente para añadir el dominio y crear los buzones.
 * El enlace es una credencial: se muestra al crearlo (y, mientras esté
 * pendiente, con «Ver enlace»), nunca en la lista.
 */

const INVITE_STATUS: Record<MailInviteStatus, { tone: Tone; label: string }> = {
  pending: { tone: 'info', label: 'Pendiente' },
  accepted: { tone: 'ok', label: 'Aceptado' },
  expired: { tone: 'neutral', label: 'Caducado' },
  revoked: { tone: 'neutral', label: 'Revocado' },
};

/** Un enlace mailto con aspecto de botón secundario pequeño (como `Button size="sm" variant="secondary"`). */
const ENLACE_BOTON =
  'inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface2 px-2.5 text-xs font-medium text-txt transition-colors hover:border-line2 hover:bg-surface3';

const inviteKey = (projectId: string) => ['mailInvites', projectId];

/** Lo que dice la fila de cada enlace sobre sus fechas, según su estado. */
function fechas(invite: MailInvite): string {
  const partes: string[] = [];
  if (invite.name) partes.push(invite.name);
  if (invite.createdAt) partes.push(`creado el ${fmtDateTime(invite.createdAt)}`);
  if (invite.status === 'pending' && invite.expiresAt) partes.push(`caduca el ${fmtDateTime(invite.expiresAt)}`);
  if (invite.status === 'expired' && invite.expiresAt) partes.push(`caducó el ${fmtDateTime(invite.expiresAt)}`);
  if (invite.status === 'accepted' && invite.acceptedAt) partes.push(`aceptado el ${fmtDateTime(invite.acceptedAt)}`);
  if (invite.status === 'revoked' && invite.revokedAt) partes.push(`revocado el ${fmtDateTime(invite.revokedAt)}`);
  const texto = partes.join(' · ');
  return texto ? texto.charAt(0).toUpperCase() + texto.slice(1) : '';
}

/** El enlace con su URL: copiarlo o enviarlo por correo desde el programa de correo de quien lo crea. */
function EnlaceBienvenida({
  invite,
  clientName,
  onDismiss,
  dismissLabel,
}: {
  invite: MailInviteLink;
  clientName: string;
  onDismiss: () => void;
  dismissLabel: string;
}) {
  // La URL llega de Mailway: solo se enlaza si es http(s).
  const url = safeHref(invite.url);
  const mailto = url
    ? mailtoBienvenida({
        email: invite.email,
        name: invite.name,
        clientName,
        url,
        expiresAt: invite.expiresAt,
        existingUser: invite.existingUser,
      })
    : null;
  return (
    <div role="status" className="rounded-lg border border-ok/30 bg-ok/[.06] p-3">
      <p className="text-sm font-medium text-txt">
        Enlace de configuración inicial para <span className="break-all font-mono">{invite.email}</span>
      </p>
      <p className="mt-0.5 text-xs text-sub">Copia el enlace o envíalo por correo a la persona de contacto.</p>
      <div className="mt-2 flex items-center gap-1 rounded-md border border-line bg-surface px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-txt">{invite.url}</span>
        <CopyButton value={invite.url} title="Copiar enlace" />
      </div>
      <p className="mt-2 text-xs leading-5 text-sub">
        {invite.expiresAt ? `Caduca el ${fmtCaducidad(invite.expiresAt)}. ` : ''}
        Solo se puede utilizar una vez. Si se crea otro enlace para el mismo correo electrónico, sustituye a este.
      </p>
      {invite.existingUser && (
        <p className="mt-1 text-xs leading-5 text-sub">
          Esta persona ya tiene acceso al panel de este cliente: con el enlace elegirá una contraseña nueva.
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap justify-end gap-2">
        {mailto && (
          <a href={mailto} className={ENLACE_BOTON}>
            <Mail size={12} /> Enviar por correo
          </a>
        )}
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          {dismissLabel}
        </Button>
      </div>
    </div>
  );
}

export default function BienvenidaDialog({
  projectId,
  clientName: clienteDelResumen,
  workspaceName,
  shared,
  blocked,
  onClose,
}: {
  projectId: string;
  /** Nombre del cliente de correo del proyecto (del resumen), por si la lista de enlaces no ha llegado. */
  clientName: string | null;
  /** Cuenta del proyecto; si su cliente de correo lo comparten sus proyectos, el acceso es a todo él. */
  workspaceName: string | null;
  shared: boolean;
  /** Cuenta o cliente de correo suspendidos: no se pueden crear enlaces. */
  blocked: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  // null: sin tocar; se usa el correo que propone el servidor.
  const [editedEmail, setEmail] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [days, setDays] = useState<number>(7);
  const [created, setCreated] = useState<MailInviteLink | null>(null);
  const [shown, setShown] = useState<MailInviteLink | null>(null);
  const [revoking, setRevoking] = useState<MailInvite | null>(null);

  const list = useQuery({
    queryKey: inviteKey(projectId),
    queryFn: () => api.get<MailInvitesView>(`/projects/${projectId}/mail/invites`),
    // El estado de los enlaces cambia fuera de Skyway (la persona los abre o los usa).
    staleTime: 0,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: inviteKey(projectId) });
  const email = editedEmail ?? list.data?.suggestedEmail ?? '';
  // El de la cuenta no sirve de respaldo: un proyecto con cliente propio no usa el de la cuenta.
  const clientName = list.data?.clientName ?? clienteDelResumen ?? '';

  const create = useMutation({
    mutationFn: () =>
      api.post<{ invite: MailInviteLink }>(`/projects/${projectId}/mail/invites`, {
        email: email.trim(),
        name: name.trim() || undefined,
        ttlHours: days * 24,
      }),
    onSuccess: (res) => {
      setCreated(res.invite);
      setShown(null);
      refresh();
      toast(`Enlace de configuración inicial creado para ${res.invite.email}`, 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const view = useMutation({
    mutationFn: (invite: MailInvite) => api.get<{ invite: MailInviteLink }>(`/projects/${projectId}/mail/invites/${invite.id}/url`),
    onSuccess: (res) => setShown(res.invite),
    onError: (err: Error) => {
      toast(err.message, 'err');
      // Puede haberse usado o caducado entretanto: la lista lo dirá.
      refresh();
    },
  });

  const revoke = useMutation({
    mutationFn: (invite: MailInvite) => api.del(`/projects/${projectId}/mail/invites/${invite.id}`),
    onSuccess: (_res, invite) => {
      setRevoking(null);
      if (shown?.id === invite.id) setShown(null);
      if (created?.id === invite.id) setCreated(null);
      refresh();
      toast(`Enlace de ${invite.email} revocado`, 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const invites = list.data?.invites ?? [];

  return (
    <>
      <Modal
        open
        onClose={() => {
          // Con la confirmación abierta, Esc o el clic fuera solo cierran la confirmación.
          if (!revoking) onClose();
        }}
        title="Configuración inicial"
        wide
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed text-sub">
            Envía a la persona de contacto del cliente un enlace para que cree su propio acceso al panel de Mailway. Al entrar, un
            asistente le guía para añadir el dominio de la empresa y crear los buzones que necesite.
            {shared && workspaceName
              ? ` El acceso es al cliente de correo de la cuenta «${workspaceName}», que comparten todos sus proyectos.`
              : ''}
          </p>

          {created ? (
            <EnlaceBienvenida invite={created} clientName={clientName} onDismiss={() => setCreated(null)} dismissLabel="Crear otro enlace" />
          ) : (
            <form
              className="grid grid-cols-1 gap-3 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (email.trim() && !blocked) create.mutate();
              }}
            >
              <div className="sm:col-span-2">
                <Field label="Correo electrónico de la persona de contacto">
                  <input
                    className="input"
                    type="email"
                    required
                    maxLength={254}
                    placeholder="contacto@tuempresa.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </Field>
              </div>
              <Field label="Nombre" hint="Opcional. Se utiliza en el saludo.">
                <input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Validez del enlace">
                <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                  {VALIDEZ_DIAS.map((d) => (
                    <option key={d} value={d}>
                      {d === 1 ? '1 día' : `${d} días`}
                    </option>
                  ))}
                </select>
              </Field>
              {blocked && (
                <p className="text-xs text-warn sm:col-span-2">
                  La cuenta o el cliente de correo están suspendidos: no es posible crear enlaces de configuración inicial.
                </p>
              )}
              <div className="flex justify-end sm:col-span-2">
                <Button type="submit" loading={create.isPending} disabled={!email.trim() || blocked}>
                  <Send size={13} /> Crear enlace
                </Button>
              </div>
            </form>
          )}

          <section className="border-t border-line pt-3.5">
            <h3 className="text-sm font-semibold text-txt">Enlaces enviados</h3>
            <p className="mt-0.5 text-xs text-subtle">
              Los más recientes del cliente de correo. Revoca los pendientes que ya no deban utilizarse: dejan de funcionar al instante.
            </p>
            <div className="mt-2">
              {list.isLoading ? (
                <Skeleton className="h-16 w-full rounded-lg" />
              ) : list.isError ? (
                <ErrorState
                  compact
                  title="No se han podido cargar los enlaces"
                  error={list.error}
                  onRetry={() => list.refetch()}
                  retrying={list.isFetching}
                />
              ) : invites.length === 0 ? (
                <EmptyState
                  compact
                  className="rounded-lg border border-dashed border-line"
                  icon={<Send />}
                  title="Todavía no se ha enviado ningún enlace"
                  description="Los enlaces de configuración inicial que se creen aparecerán aquí con su estado."
                />
              ) : (
                <div className="rounded-lg border border-line">
                  {invites.map((invite) => {
                    const st = INVITE_STATUS[invite.status] ?? INVITE_STATUS.expired;
                    const pendiente = invite.status === 'pending';
                    return (
                      <div key={invite.id} className="border-b border-line/60 bg-bg px-3.5 py-2.5 last:border-b-0">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                          <div className="min-w-0 flex-1 basis-48">
                            <p className="flex flex-wrap items-center gap-2">
                              <span className="break-all font-mono text-sm text-txt">{invite.email}</span>
                              <Chip size="sm" tone={st.tone} dot>
                                {st.label}
                              </Chip>
                            </p>
                            <p className="tnum mt-0.5 text-xs text-subtle">{fechas(invite)}</p>
                          </div>
                          {pendiente && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              {/* El recién creado ya se muestra arriba. */}
                              {invite.recoverable && created?.id !== invite.id && (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => view.mutate(invite)}
                                  loading={view.isPending && view.variables?.id === invite.id}
                                >
                                  <Eye size={12} /> Ver enlace
                                </Button>
                              )}
                              <Button size="sm" variant="ghost" onClick={() => setRevoking(invite)} className="text-err hover:bg-err/[.1]">
                                <Ban size={12} /> Revocar
                              </Button>
                            </div>
                          )}
                        </div>
                        {shown?.id === invite.id && (
                          <div className="mt-2">
                            <EnlaceBienvenida invite={shown} clientName={clientName} onDismiss={() => setShown(null)} dismissLabel="Ocultar" />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      </Modal>

      <ConfirmModal
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => revoking && revoke.mutate(revoking)}
        loading={revoke.isPending}
        title="Revocar enlace"
        message={`El enlace de configuración inicial enviado a ${revoking?.email ?? ''} dejará de funcionar de inmediato. Si la persona aún no ha creado su acceso, necesitará un enlace nuevo.`}
        confirmLabel="Revocar enlace"
      />
    </>
  );
}
