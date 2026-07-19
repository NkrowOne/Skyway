import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Fingerprint, KeyRound, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { Button, ConfirmModal, CopyButton, Field, Modal, useToast } from '../components/ui';
import { ApiToken, Me, Passkey } from '../types';
import { timeAgo } from '../utils';
import { passkeysSupported, registerPasskey } from '../webauthn';

function Section({
  icon,
  iconClass,
  title,
  description,
  aside,
  children,
}: {
  icon: React.ReactNode;
  iconClass: string;
  title: string;
  description: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5">
          <span className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg ${iconClass}`}>{icon}</span>
          <div>
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="mt-px text-xs text-subtle">{description}</p>
          </div>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export default function AccountPage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me') });

  // ---- contraseña ----
  const [currentPw, setCurrentPw] = useState('');
  const [nextPw, setNextPw] = useState('');
  const changePw = useMutation({
    mutationFn: () => api.post('/auth/password', { current: currentPw, next: nextPw }),
    onSuccess: () => {
      setCurrentPw('');
      setNextPw('');
      toast('Contraseña actualizada', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  // ---- passkeys ----
  const passkeys = useQuery({ queryKey: ['passkeys'], queryFn: () => api.get<{ passkeys: Passkey[] }>('/auth/passkeys') });
  const [pkModal, setPkModal] = useState(false);
  const [pkName, setPkName] = useState('');
  const [pkBusy, setPkBusy] = useState(false);
  const [pkDelete, setPkDelete] = useState<Passkey | null>(null);

  const addPasskey = async () => {
    setPkBusy(true);
    try {
      await registerPasskey(pkName.trim() || 'Mi passkey');
      setPkModal(false);
      setPkName('');
      toast('Passkey registrada', 'ok');
      queryClient.invalidateQueries({ queryKey: ['passkeys'] });
    } catch (err) {
      if ((err as DOMException)?.name !== 'NotAllowedError') toast((err as Error).message, 'err');
    } finally {
      setPkBusy(false);
    }
  };

  const removePasskey = useMutation({
    mutationFn: (id: string) => api.del(`/auth/passkeys/${id}`),
    onSuccess: () => {
      setPkDelete(null);
      toast('Passkey eliminada', 'ok');
      queryClient.invalidateQueries({ queryKey: ['passkeys'] });
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  // ---- tokens de API ----
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api.get<{ tokens: ApiToken[] }>('/tokens') });
  const [tokModal, setTokModal] = useState(false);
  const [tokName, setTokName] = useState('');
  const [tokDays, setTokDays] = useState('');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokDelete, setTokDelete] = useState<ApiToken | null>(null);

  const createToken = useMutation({
    mutationFn: () =>
      api.post<{ token: string }>('/tokens', {
        name: tokName.trim(),
        expiresDays: tokDays ? Number(tokDays) : null,
      }),
    onSuccess: (res) => {
      setNewToken(res.token);
      setTokModal(true); // fuerza el modal abierto: el secreto solo se muestra una vez
      setTokName('');
      setTokDays('');
      queryClient.invalidateQueries({ queryKey: ['tokens'] });
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const removeToken = useMutation({
    mutationFn: (id: string) => api.del(`/tokens/${id}`),
    onSuccess: () => {
      setTokDelete(null);
      toast('Token revocado', 'ok');
      queryClient.invalidateQueries({ queryKey: ['tokens'] });
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  return (
    <div className="mx-auto flex max-w-[780px] flex-col gap-5 px-4 py-7 sm:px-6 sm:py-10">
      <div className="mb-2">
        <h1 className="text-2xl font-semibold tracking-[-.02em]">Mi cuenta</h1>
        <p className="mt-1.5 text-sm text-sub">
          {me.data?.user?.email} · {me.data?.user?.role === 'admin' ? 'administrador' : 'miembro'}
        </p>
      </div>

      <Section
        icon={<Fingerprint size={15} />}
        iconClass="bg-acc/[.15] text-acc-soft"
        title="Passkeys"
        description="Entra con huella, cara o PIN del dispositivo: sin contraseña y resistente a phishing"
        aside={
          passkeysSupported() ? (
            <Button size="sm" onClick={() => setPkModal(true)}>
              <Plus size={13} /> Añadir passkey
            </Button>
          ) : (
            <span className="text-xs text-subtle">Tu navegador no soporta passkeys</span>
          )
        }
      >
        {(passkeys.data?.passkeys ?? []).length === 0 ? (
          <p className="rounded-lg border border-dashed border-line bg-bg px-4 py-5 text-center text-xs text-subtle">
            Sin passkeys todavía. Añade una para entrar sin contraseña.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {passkeys.data!.passkeys.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg px-3.5 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{p.name}</p>
                  <p className="mt-px text-[11px] text-subtle">
                    dominio <span className="font-mono">{p.rp_id}</span> · creada {timeAgo(p.created_at)}
                    {p.last_used_at ? ` · último uso ${timeAgo(p.last_used_at)}` : ' · sin usar'}
                  </p>
                </div>
                <button
                  onClick={() => setPkDelete(p)}
                  className="rounded-md p-1.5 text-subtle transition-colors hover:bg-err/[.12] hover:text-err"
                  title="Eliminar passkey"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-[11px] text-subtle">
          Cada passkey queda ligada al dominio donde se creó (p. ej. <span className="font-mono">localhost</span> por túnel SSH, o tu
          dominio público). Si cambias de dominio, registra una nueva desde él.
        </p>
      </Section>

      <Section
        icon={<Bot size={15} />}
        iconClass="bg-info/[.13] text-info"
        title="Tokens de API"
        description="Para automatizaciones y agentes (Claude, CI/CD): heredan tus permisos"
        aside={
          <Button size="sm" onClick={() => { setNewToken(null); setTokModal(true); }}>
            <Plus size={13} /> Crear token
          </Button>
        }
      >
        {(tokens.data?.tokens ?? []).length === 0 ? (
          <p className="rounded-lg border border-dashed border-line bg-bg px-4 py-5 text-center text-xs text-subtle">
            Sin tokens. Crea uno para controlar Skyway desde fuera del panel.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {tokens.data!.tokens.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg px-3.5 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{t.name}</p>
                  <p className="mt-px text-[11px] text-subtle">
                    <span className="font-mono">{t.prefix}…</span> · creado {timeAgo(t.created_at)}
                    {t.last_used_at ? ` · último uso ${timeAgo(t.last_used_at)}` : ' · sin usar'}
                    {t.expires_at ? ` · caduca ${new Date(t.expires_at).toLocaleDateString()}` : ''}
                  </p>
                </div>
                <button
                  onClick={() => setTokDelete(t)}
                  className="rounded-md p-1.5 text-subtle transition-colors hover:bg-err/[.12] hover:text-err"
                  title="Revocar token"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-[11px] text-subtle">
          Uso: <span className="font-mono">Authorization: Bearer sky_…</span> contra la API REST. El token completo solo se muestra al
          crearlo.
        </p>
      </Section>

      <Section
        icon={<KeyRound size={15} />}
        iconClass="bg-warn/[.13] text-warn"
        title="Contraseña"
        description="Cámbiala periódicamente; con passkey la usarás poco"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Contraseña actual">
            <input className="input" type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} />
          </Field>
          <Field label="Nueva contraseña" hint="mínimo 8 caracteres">
            <input className="input" type="password" value={nextPw} onChange={(e) => setNextPw(e.target.value)} />
          </Field>
        </div>
        <div className="mt-3.5 flex justify-end">
          <Button size="sm" onClick={() => changePw.mutate()} loading={changePw.isPending} disabled={!currentPw || nextPw.length < 8}>
            Cambiar contraseña
          </Button>
        </div>
      </Section>

      {/* ---- modales ---- */}
      <Modal open={pkModal} onClose={() => setPkModal(false)} title="Añadir passkey">
        <Field label="Nombre" hint="para reconocerla: «Portátil», «iPhone», «YubiKey»…">
          <input className="input" value={pkName} onChange={(e) => setPkName(e.target.value)} autoFocus />
        </Field>
        <p className="mt-3 text-xs text-subtle">Tu navegador te pedirá la huella, cara o PIN del dispositivo.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setPkModal(false)}>
            Cancelar
          </Button>
          <Button onClick={addPasskey} loading={pkBusy}>
            <Fingerprint size={14} /> Continuar
          </Button>
        </div>
      </Modal>

      <Modal
        open={tokModal}
        onClose={() => {
          if (createToken.isPending) return; // no cerrar mientras se genera: perdería el secreto
          setTokModal(false);
        }}
        title={newToken ? 'Token creado' : 'Crear token de API'}
      >
        {newToken ? (
          <>
            <p className="text-sm text-sub">
              Copia el token ahora: <strong>no volverá a mostrarse.</strong>
            </p>
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-bg px-3 py-2.5">
              <code className="min-w-0 flex-1 break-all font-mono text-xs">{newToken}</code>
              <CopyButton value={newToken} />
            </div>
            <div className="mt-5 flex justify-end">
              <Button onClick={() => { setTokModal(false); setNewToken(null); }}>Hecho</Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              <Field label="Nombre" hint="quién lo usa: «Claude», «CI de GitHub»…">
                <input className="input" value={tokName} onChange={(e) => setTokName(e.target.value)} autoFocus />
              </Field>
              <Field label="Caducidad en días" hint="vacío = no caduca">
                <input
                  className="input tnum"
                  type="number"
                  min={1}
                  max={3650}
                  placeholder="90"
                  value={tokDays}
                  onChange={(e) => setTokDays(e.target.value)}
                />
              </Field>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setTokModal(false)}>
                Cancelar
              </Button>
              <Button onClick={() => createToken.mutate()} loading={createToken.isPending} disabled={!tokName.trim()}>
                Crear token
              </Button>
            </div>
          </>
        )}
      </Modal>

      <ConfirmModal
        open={!!pkDelete}
        onClose={() => setPkDelete(null)}
        onConfirm={() => pkDelete && removePasskey.mutate(pkDelete.id)}
        title="Eliminar passkey"
        message={`«${pkDelete?.name}» dejará de servir para entrar. Asegúrate de conservar otra forma de acceso.`}
        loading={removePasskey.isPending}
      />

      <ConfirmModal
        open={!!tokDelete}
        onClose={() => setTokDelete(null)}
        onConfirm={() => tokDelete && removeToken.mutate(tokDelete.id)}
        title="Revocar token"
        message={`Las integraciones que usen «${tokDelete?.name}» dejarán de funcionar al momento.`}
        confirmLabel="Revocar"
        loading={removeToken.isPending}
      />
    </div>
  );
}
