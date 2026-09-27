import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Ban,
  ChevronDown,
  Cloud,
  ExternalLink,
  Globe,
  Inbox,
  KeyRound,
  Link2,
  Mail,
  MoreHorizontal,
  Plug,
  RefreshCw,
  Trash2,
  Unlink,
} from 'lucide-react';
import { api } from '../api';
import {
  MailApiKey,
  MailAppPassword,
  MailCloudflarePlan,
  MailCloudflareResult,
  MailDomain,
  MailMailbox,
  MailOptions,
  ProjectMailView,
  Service,
} from '../types';
import { cx, fmtBytes, fmtDateTime, safeHref, Tone } from '../utils';
import {
  Button,
  Chip,
  ConfirmModal,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Menu,
  MenuItem,
  Modal,
  Segmented,
  Skeleton,
  Tabs,
  useToast,
} from './ui';

/**
 * Correo del proyecto (integración con Mailway): activar el cliente de correo,
 * dominios con sus registros DNS (y Cloudflare), buzones y la conexión de los
 * servicios por SMTP o por la API de envío.
 *
 * Las contraseñas y los enlaces de configuración se muestran UNA vez, en el
 * momento en que Mailway los genera: Skyway no los guarda ni puede volver a
 * mostrarlos.
 */

type MailTab = 'domains' | 'mailboxes' | 'connect';

/** Credencial de envío pendiente de confirmar su revocación. */
type CredentialToRevoke = { kind: 'app'; item: MailAppPassword } | { kind: 'key'; item: MailApiKey };

/** Contraseña recién generada, pendiente de copiar o de enviar por enlace. */
interface SecretShown {
  mailboxId: string;
  email: string;
  password: string;
  reason: 'created' | 'reset';
}

const mailKey = (projectId: string) => ['mail', projectId];

const DOMAIN_STATUS: Record<MailDomain['status'], { tone: Tone; label: string }> = {
  active: { tone: 'ok', label: 'Verificado' },
  pending_dns: { tone: 'warn', label: 'Pendiente' },
  error: { tone: 'err', label: 'Error' },
};

export default function MailModal({
  open,
  onClose,
  projectId,
  projectName,
  services,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string;
  services: Service[];
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<MailTab>('domains');
  // Diálogos secundarios: se pintan fuera del modal principal y, mientras
  // están abiertos, Esc o el clic fuera no deben cerrar también el de debajo.
  const [cfDomain, setCfDomain] = useState<MailDomain | null>(null);
  const [resetBox, setResetBox] = useState<MailMailbox | null>(null);
  const [deleteBox, setDeleteBox] = useState<MailMailbox | null>(null);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [revokeCred, setRevokeCred] = useState<CredentialToRevoke | null>(null);
  const [secret, setSecret] = useState<SecretShown | null>(null);
  const childOpen = !!cfDomain || !!resetBox || !!deleteBox || unlinkOpen || !!revokeCred;

  const view = useQuery({
    queryKey: mailKey(projectId),
    queryFn: () => api.get<ProjectMailView>(`/projects/${projectId}/mail`),
    enabled: open,
    staleTime: 15_000,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: mailKey(projectId) });

  // Al cerrar se olvida la contraseña mostrada: no debe seguir en pantalla al volver.
  useEffect(() => {
    if (!open) setSecret(null);
  }, [open]);

  const resetPassword = useMutation({
    mutationFn: (box: MailMailbox) =>
      api.post<{ password: string | null }>(`/projects/${projectId}/mail/mailboxes/${box.id}/password`),
    onSuccess: (res, box) => {
      setResetBox(null);
      if (res.password) setSecret({ mailboxId: box.id, email: box.email, password: res.password, reason: 'reset' });
      setTab('mailboxes');
      toast('Contraseña restablecida', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const deleteMailbox = useMutation({
    mutationFn: (box: MailMailbox) => api.del(`/projects/${projectId}/mail/mailboxes/${box.id}`),
    onSuccess: (_res, box) => {
      setDeleteBox(null);
      if (secret?.mailboxId === box.id) setSecret(null);
      invalidate();
      toast('Buzón eliminado', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const unlink = useMutation({
    mutationFn: () => api.del(`/projects/${projectId}/mail/link`),
    onSuccess: () => {
      setUnlinkOpen(false);
      setSecret(null);
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['mailOptions', projectId] });
      toast('Correo desactivado en el proyecto', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const revoke = useMutation({
    mutationFn: (c: CredentialToRevoke) =>
      api.del(
        c.kind === 'app'
          ? `/projects/${projectId}/mail/app-passwords/${c.item.id}`
          : `/projects/${projectId}/mail/api-keys/${c.item.id}`,
      ),
    onSuccess: (_res, c) => {
      setRevokeCred(null);
      invalidate();
      toast(c.kind === 'app' ? 'Contraseña de aplicación revocada' : 'Clave de API revocada', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const data = view.data;
  const canManage = !!data?.canManage;
  // Mailway envía la URL del panel: solo se pinta como enlace si es http(s).
  const panelHref = safeHref(data?.panelUrl);

  let body: React.ReactNode;
  if (view.isLoading) {
    body = (
      <div className="flex flex-col gap-3" aria-busy>
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    );
  } else if (view.isError || !data) {
    body = (
      <ErrorState
        compact
        title="No se ha podido cargar el correo del proyecto"
        error={view.error}
        onRetry={() => view.refetch()}
        retrying={view.isFetching}
      />
    );
  } else if (!data.moduleEnabled) {
    body = (
      <EmptyState
        compact
        icon={<Mail />}
        title="El correo no está incluido en el plan"
        description="El plan de la cuenta de este proyecto no incluye el módulo «Correo». Póngase en contacto con el administrador de la plataforma para activarlo."
      />
    );
  } else if (!data.configured) {
    body = (
      <EmptyState
        compact
        icon={<Mail />}
        title="El correo no está configurado"
        description={
          data.isAdmin
            ? 'Conecte Skyway con su instancia de Mailway para crear dominios de correo y buzones desde los proyectos.'
            : 'Un administrador de la plataforma debe conectar el servicio de correo antes de utilizarlo.'
        }
        action={
          data.isAdmin ? (
            <Link to="/settings#mailway" onClick={onClose} className="text-sm font-medium text-acc-soft hover:underline">
              Configurar Mailway
            </Link>
          ) : undefined
        }
      />
    );
  } else if (!data.linked) {
    body = (
      <>
        {data.notice && (
          <p className="mb-4 rounded-lg border border-warn/30 bg-warn/[.07] px-3 py-2 text-xs text-sub">{data.notice}</p>
        )}
        {canManage ? (
          <ActivateForm projectId={projectId} projectName={projectName} isAdmin={data.isAdmin} onDone={invalidate} />
        ) : (
          <EmptyState
            compact
            icon={<Mail />}
            title="El correo no está activado en este proyecto"
            description="Solicite su activación al propietario de la cuenta o a un administrador."
          />
        )}
      </>
    );
  } else if (!data.summary) {
    // Vinculado, pero Mailway no encuentra el cliente: se explica y se ofrece desactivarlo.
    body = (
      <div role="alert" className="flex flex-col items-center gap-3 px-2 py-6 text-center">
        <AlertTriangle size={22} className="text-warn" aria-hidden />
        <p className="max-w-md text-sm text-sub">{data.notice ?? 'No se ha podido leer el cliente de correo del proyecto.'}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => view.refetch()} loading={view.isFetching}>
            <RefreshCw size={12} /> Reintentar
          </Button>
          {canManage && (
            <Button size="sm" variant="ghost" onClick={() => setUnlinkOpen(true)}>
              <Unlink size={13} /> Desactivar correo
            </Button>
          )}
        </div>
      </div>
    );
  } else {
    const summary = data.summary;
    const blocked = data.accountSuspended || summary.client.suspended;
    body = (
      <div className="flex flex-col gap-4">
        {blocked && (
          <p role="alert" className="rounded-lg border border-warn/30 bg-warn/[.07] px-3 py-2 text-xs text-sub">
            {data.accountSuspended
              ? 'La cuenta de este proyecto está suspendida: no es posible crear dominios ni buzones, ni conectar servicios. Lo ya creado sigue funcionando.'
              : 'El cliente de correo de este proyecto está suspendido en Mailway: no es posible crear dominios ni buzones, ni conectar servicios.'}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-sub">
          <span className="min-w-0">
            Cliente de correo <span className="font-semibold text-txt">{summary.client.name}</span>
            {summary.plan && <> · plan {summary.plan.name}</>}
          </span>
          <span className="tnum flex flex-wrap items-center gap-1.5">
            <Chip size="sm">
              Dominios {summary.usage.domains}
              {summary.plan ? `/${summary.plan.maxDomains}` : ''}
            </Chip>
            <Chip size="sm">
              Buzones {summary.usage.mailboxes}
              {summary.plan ? `/${summary.plan.maxMailboxes}` : ''}
            </Chip>
            {summary.client.suspended && (
              <Chip size="sm" tone="err" dot>
                Suspendido
              </Chip>
            )}
          </span>
        </div>

        <Tabs
          className="-mx-5 px-3"
          tabs={[
            { key: 'domains', label: 'Dominios' },
            { key: 'mailboxes', label: 'Buzones' },
            { key: 'connect', label: 'Conectar a un servicio' },
          ]}
          active={tab}
          onChange={(k) => setTab(k as MailTab)}
        />

        {tab === 'domains' && (
          <DomainsTab
            projectId={projectId}
            blocked={blocked}
            domains={summary.domains}
            cloudflare={data.features?.cloudflare !== false}
            onInvalidate={invalidate}
            onCloudflare={setCfDomain}
          />
        )}
        {tab === 'mailboxes' && (
          <MailboxesTab
            projectId={projectId}
            blocked={blocked}
            view={data}
            secret={secret}
            onSecret={setSecret}
            onInvalidate={invalidate}
            onReset={setResetBox}
            onDelete={setDeleteBox}
            onGoDomains={() => setTab('domains')}
          />
        )}
        {tab === 'connect' && (
          <ConnectTab
            projectId={projectId}
            blocked={blocked}
            view={data}
            services={services}
            onClose={onClose}
            onGoMailboxes={() => setTab('mailboxes')}
            onRevoke={setRevokeCred}
          />
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3.5">
          {panelHref ? (
            <a
              href={panelHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-acc-soft hover:underline"
            >
              Abrir en Mailway <ExternalLink size={12} />
            </a>
          ) : (
            <span />
          )}
          {canManage && (
            <Button variant="ghost" size="sm" onClick={() => setUnlinkOpen(true)} className="text-sub">
              <Unlink size={13} /> Desactivar correo
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <Modal
        open={open}
        onClose={() => {
          if (!childOpen) onClose();
        }}
        title="Correo del proyecto"
        wide
      >
        {body}
      </Modal>

      {cfDomain && (
        <CloudflareDialog
          projectId={projectId}
          domain={cfDomain}
          canManage={canManage}
          onClose={() => setCfDomain(null)}
          onApplied={invalidate}
        />
      )}

      <ConfirmModal
        open={!!resetBox}
        onClose={() => setResetBox(null)}
        onConfirm={() => resetBox && resetPassword.mutate(resetBox)}
        loading={resetPassword.isPending}
        title="Restablecer contraseña"
        message={`Se generará una contraseña nueva para ${resetBox?.email ?? ''}. Los dispositivos y programas configurados con la contraseña actual dejarán de conectar hasta que se configuren con la nueva.`}
        confirmLabel="Restablecer contraseña"
        confirmVariant="secondary"
      />

      <ConfirmModal
        open={!!deleteBox}
        onClose={() => setDeleteBox(null)}
        onConfirm={() => deleteBox && deleteMailbox.mutate(deleteBox)}
        loading={deleteMailbox.isPending}
        title="Eliminar buzón"
        message={`Se eliminará ${deleteBox?.email ?? ''} con todos sus mensajes. Las claves de API que Skyway creó con este buzón como remitente se revocarán, y los servicios que envíen con él dejarán de poder hacerlo. Esta acción no se puede deshacer.`}
        confirmLabel="Eliminar buzón"
      />

      <ConfirmModal
        open={unlinkOpen}
        onClose={() => setUnlinkOpen(false)}
        onConfirm={() => unlink.mutate()}
        loading={unlink.isPending}
        title="Desactivar el correo del proyecto"
        message="El proyecto dejará de estar vinculado a su cliente de correo. Los dominios, buzones y mensajes se conservan en Mailway y el correo sigue funcionando; solo deja de gestionarse desde Skyway. Si vuelve a activar el correo más adelante, podrá recuperar este mismo cliente con sus dominios y buzones."
        confirmLabel="Desactivar correo"
        confirmVariant="secondary"
      />

      <ConfirmModal
        open={!!revokeCred}
        onClose={() => setRevokeCred(null)}
        onConfirm={() => revokeCred && revoke.mutate(revokeCred)}
        loading={revoke.isPending}
        title={revokeCred?.kind === 'key' ? 'Revocar clave de API' : 'Revocar contraseña de aplicación'}
        message={
          revokeCred
            ? `«${revokeCred.item.name}» (${revokeCred.kind === 'key' ? revokeCred.item.senderEmail : revokeCred.item.email}) dejará de funcionar de inmediato. Los servicios que la utilicen no podrán enviar correo hasta que se vuelvan a conectar.`
            : ''
        }
        confirmLabel="Revocar"
      />
    </>
  );
}

// ---------- activación ----------

type ActivateMode = 'create' | 'existing' | 'previous';

function ActivateForm({
  projectId,
  projectName,
  isAdmin,
  onDone,
}: {
  projectId: string;
  projectName: string;
  isAdmin: boolean;
  onDone: () => void;
}) {
  const toast = useToast();
  // null: aún sin elegir (se propone recuperar el cliente anterior si se puede).
  const [chosenMode, setMode] = useState<ActivateMode | null>(null);
  // null: sin tocar; se usa el nombre que propone el servidor.
  const [editedName, setName] = useState<string | null>(null);
  const [planId, setPlanId] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [clientId, setClientId] = useState('');

  const options = useQuery({
    queryKey: ['mailOptions', projectId],
    queryFn: () => api.get<MailOptions>(`/projects/${projectId}/mail/options`),
  });
  // Plan por defecto: el predeterminado de la instancia, en cuanto se conoce.
  const defaultPlanId = options.data?.defaultPlanId ?? options.data?.plans[0]?.id ?? '';
  useEffect(() => {
    if (defaultPlanId) setPlanId((p) => p || defaultPlanId);
  }, [defaultPlanId]);

  const previousAvailable = !!options.data?.previous?.available;
  const mode: ActivateMode = chosenMode ?? (previousAvailable ? 'previous' : 'create');
  const name = editedName ?? options.data?.defaultName ?? projectName;

  const activate = useMutation({
    mutationFn: () =>
      api.post(
        `/projects/${projectId}/mail/link`,
        mode === 'create'
          ? {
              mode,
              name: name.trim() || undefined,
              // Solo el administrador elige el plan; al propietario se le asigna el predeterminado.
              planId: options.data?.canChoosePlan ? planId || undefined : undefined,
              contactEmail: contactEmail.trim() || undefined,
            }
          : mode === 'existing'
            ? { mode, clientId }
            : { mode },
      ),
    onSuccess: () => {
      toast(mode === 'previous' ? 'Correo activado con el cliente anterior' : 'Correo activado en el proyecto', 'ok');
      onDone();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  if (options.isLoading) return <Skeleton className="h-40 w-full rounded-lg" />;
  if (options.isError || !options.data) {
    return (
      <ErrorState
        compact
        title="No se han podido cargar los planes de correo"
        error={options.error}
        onRetry={() => options.refetch()}
        retrying={options.isFetching}
      />
    );
  }

  const { plans, clients, canChoosePlan, previous } = options.data;
  const assignedPlan = plans.find((p) => p.id === planId) ?? plans[0];
  const canSubmit = mode === 'create' ? name.trim().length >= 2 : mode === 'existing' ? !!clientId : previousAvailable;
  const modes: { key: ActivateMode; label: string }[] = [
    ...(previousAvailable ? [{ key: 'previous' as const, label: 'Recuperar cliente anterior' }] : []),
    { key: 'create', label: 'Crear cliente nuevo' },
    ...(isAdmin ? [{ key: 'existing' as const, label: 'Vincular cliente existente' }] : []),
  ];
  const planLabel = (p: MailOptions['plans'][number]) =>
    `${p.name} · ${p.maxDomains} dominio(s), ${p.maxMailboxes} buzones de ${fmtBytes(p.mailboxQuotaMb * 1024 * 1024)}`;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) activate.mutate();
      }}
    >
      <p className="text-sm leading-relaxed text-sub">
        Al activar el correo se crea en Mailway un cliente para este proyecto. Después podrá añadir sus dominios, crear buzones y
        conectarlos a los servicios.
      </p>

      {modes.length > 1 && (
        <Segmented full label="Origen del cliente de correo" value={mode} onChange={setMode} options={modes} />
      )}

      {previous && !previous.available && (
        <p className="rounded-lg border border-warn/30 bg-warn/[.07] px-3 py-2 text-xs text-sub">
          {previous.reason ?? `No es posible recuperar el cliente anterior «${previous.clientName}».`} Si crea un cliente nuevo,
          los dominios del cliente anterior no se podrán añadir de nuevo mientras sigan dados de alta en Mailway.
        </p>
      )}

      {mode === 'previous' && previous ? (
        <p className="rounded-lg border border-line bg-bg px-3 py-2.5 text-sm text-sub">
          Se volverá a vincular el cliente <span className="font-semibold text-txt">{previous.clientName}</span>, que este proyecto
          utilizaba antes, con sus dominios, buzones y credenciales.
        </p>
      ) : mode === 'create' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Nombre del cliente" hint="Entre 2 y 80 caracteres.">
            <input
              className="input"
              value={name}
              minLength={2}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </Field>
          {canChoosePlan ? (
            <Field label="Plan de correo" hint={plans.length === 0 ? 'Mailway no tiene planes: se aplicará el predeterminado.' : undefined}>
              <select className="input" value={planId} onChange={(e) => setPlanId(e.target.value)} disabled={plans.length === 0}>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {planLabel(p)}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="Plan de correo" hint="Lo asigna el administrador de la plataforma.">
              <input className="input text-sub" readOnly value={assignedPlan ? planLabel(assignedPlan) : 'Plan predeterminado de Mailway'} />
            </Field>
          )}
          <Field label="Correo electrónico de contacto" hint="Opcional. Mailway lo utiliza para los avisos del cliente.">
            <input
              className="input"
              type="email"
              placeholder="contacto@suempresa.com"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
            />
          </Field>
        </div>
      ) : (
        <Field label="Cliente de Mailway" hint="Los clientes ya vinculados a otro proyecto o integración no se pueden seleccionar.">
          <select className="input" value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">Seleccione un cliente…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id} disabled={!c.available}>
                {c.name}
                {c.linkedTo ? ` (vinculado a ${c.linkedTo})` : ''}
              </option>
            ))}
          </select>
        </Field>
      )}

      <div className="flex justify-end">
        <Button type="submit" loading={activate.isPending} disabled={!canSubmit}>
          <Mail size={14} /> Activar correo
        </Button>
      </div>
    </form>
  );
}

// ---------- dominios ----------

function DomainsTab({
  projectId,
  blocked,
  domains,
  cloudflare,
  onInvalidate,
  onCloudflare,
}: {
  projectId: string;
  blocked: boolean;
  domains: MailDomain[];
  cloudflare: boolean;
  onInvalidate: () => void;
  onCloudflare: (d: MailDomain) => void;
}) {
  const toast = useToast();
  const [domain, setDomain] = useState('');

  const add = useMutation({
    mutationFn: (value: string) => api.post<{ domain: MailDomain }>(`/projects/${projectId}/mail/domains`, { domain: value }),
    onSuccess: (res) => {
      setDomain('');
      onInvalidate();
      toast(`Dominio ${res.domain.domain} añadido. Cree sus registros DNS para verificarlo.`, 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (domain.trim() && !blocked) add.mutate(domain.trim());
        }}
      >
        <input
          className="input min-w-0 font-mono text-xs max-sm:h-11 sm:flex-1"
          placeholder="suempresa.com"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          aria-label="Dominio de correo"
          autoCapitalize="none"
          spellCheck={false}
        />
        <Button type="submit" variant="secondary" loading={add.isPending} disabled={!domain.trim() || blocked} className="max-sm:h-11">
          <Globe size={13} /> Añadir dominio
        </Button>
      </form>

      {domains.length === 0 ? (
        <EmptyState
          compact
          className="rounded-lg border border-dashed border-line"
          icon={<Globe />}
          title="Todavía no hay dominios"
          description="Añada el dominio con el que se enviará y recibirá el correo, por ejemplo suempresa.com."
        />
      ) : (
        domains.map((d) => (
          <DomainCard
            key={d.id}
            projectId={projectId}
            domain={d}
            cloudflare={cloudflare}
            onInvalidate={onInvalidate}
            onCloudflare={() => onCloudflare(d)}
          />
        ))
      )}
    </div>
  );
}

function DomainCard({
  projectId,
  domain,
  cloudflare,
  onInvalidate,
  onCloudflare,
}: {
  projectId: string;
  domain: MailDomain;
  cloudflare: boolean;
  onInvalidate: () => void;
  onCloudflare: () => void;
}) {
  const toast = useToast();
  const [showDns, setShowDns] = useState(false);
  const status = DOMAIN_STATUS[domain.status] ?? DOMAIN_STATUS.pending_dns;

  const dns = useQuery({
    queryKey: ['mailDns', projectId, domain.id],
    queryFn: () => api.get<{ records: { type: string; name: string; content: string }[] }>(
      `/projects/${projectId}/mail/domains/${domain.id}/dns`,
    ),
    enabled: showDns,
    staleTime: 60_000,
  });

  const verify = useMutation({
    mutationFn: () => api.post<{ domain: MailDomain }>(`/projects/${projectId}/mail/domains/${domain.id}/verify`),
    onSuccess: (res) => {
      onInvalidate();
      toast(
        res.domain.status === 'active'
          ? `${domain.domain}: todos los registros obligatorios son correctos`
          : `${domain.domain}: ${res.domain.dns.requiredOk} de ${res.domain.dns.requiredTotal} registros obligatorios correctos`,
        res.domain.status === 'active' ? 'ok' : 'info',
      );
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const pendientes = domain.dns.checks.filter((c) => c.required && c.status !== 'ok');

  return (
    <div className="rounded-lg border border-line bg-bg">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3">
        <div className="min-w-0 flex-1 basis-48">
          <p className="flex flex-wrap items-center gap-2">
            <span className="break-all font-mono text-sm font-medium text-txt">{domain.domain}</span>
            <Chip size="sm" tone={status.tone} dot>
              {status.label}
            </Chip>
            {domain.ownershipPending && (
              <Chip size="sm" tone="warn" dot>
                Propiedad pendiente
              </Chip>
            )}
          </p>
          <p className="tnum mt-0.5 text-xs text-subtle">
            {domain.dns.requiredTotal > 0
              ? `${domain.dns.requiredOk}/${domain.dns.requiredTotal} registros obligatorios correctos`
              : 'Pendiente de comprobar los registros DNS'}
            {domain.lastCheckedAt ? ` · comprobado ${fmtDateTime(domain.lastCheckedAt)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => verify.mutate()} loading={verify.isPending}>
            <RefreshCw size={12} /> Verificar ahora
          </Button>
          {cloudflare && (
            <Button size="sm" variant="secondary" onClick={onCloudflare}>
              <Cloud size={12} /> Configurar en Cloudflare
            </Button>
          )}
        </div>
      </div>

      {domain.ownershipPending && (
        <div className="border-t border-line/60 px-3.5 py-2.5 text-xs text-sub">
          <p>
            Antes de crear buzones es necesario comprobar que el dominio es suyo: apunte el registro MX a este servidor de correo o
            añada el siguiente registro en el proveedor de DNS del dominio y pulse «Verificar ahora».
          </p>
          {domain.ownershipRecord && (
            <div className="mt-2 flex flex-col gap-1 rounded-md border border-line bg-surface px-3 py-2 sm:flex-row sm:items-start sm:gap-3">
              <span className="w-14 shrink-0 font-mono font-semibold text-txt">{domain.ownershipRecord.type}</span>
              <span className="flex min-w-0 items-start gap-1 sm:w-48 sm:shrink-0">
                <span className="min-w-0 break-all font-mono text-sub">{domain.ownershipRecord.name}</span>
                <CopyButton value={domain.ownershipRecord.name} title="Copiar nombre" className="-my-0.5 shrink-0" />
              </span>
              <span className="flex min-w-0 flex-1 items-start gap-1">
                <span className="min-w-0 flex-1 break-all font-mono text-txt">{domain.ownershipRecord.content}</span>
                <CopyButton value={domain.ownershipRecord.content} title="Copiar valor" className="-my-0.5 shrink-0" />
              </span>
            </div>
          )}
        </div>
      )}

      {pendientes.length > 0 && (
        <ul className="space-y-1 border-t border-line/60 px-3.5 py-2.5 text-xs">
          {pendientes.map((c) => (
            <li key={c.id} className="flex items-start gap-1.5 text-sub">
              <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn" />
              <span className="min-w-0">
                <span className="font-medium text-txt">{c.label}</span>
                {c.status === 'mismatch' ? ': el valor publicado no coincide con el esperado.' : c.status === 'missing' ? ': no se ha encontrado el registro.' : ': no se ha podido comprobar.'}
                {c.help ? ` ${c.help}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-line/60">
        <button
          type="button"
          onClick={() => setShowDns((v) => !v)}
          aria-expanded={showDns}
          className="flex w-full items-center gap-1.5 px-3.5 py-2 text-left text-xs font-medium text-sub hover:text-txt max-sm:py-3"
        >
          <ChevronDown size={12} className={cx('shrink-0 transition-transform duration-200', showDns && 'rotate-180')} />
          Registros DNS
        </button>
        {showDns && (
          <div className="px-3.5 pb-3">
            {dns.isLoading ? (
              <Skeleton className="h-20 w-full rounded-md" />
            ) : dns.isError || !dns.data ? (
              <ErrorState
                compact
                title="No se han podido cargar los registros"
                error={dns.error}
                onRetry={() => dns.refetch()}
                retrying={dns.isFetching}
              />
            ) : dns.data.records.length === 0 ? (
              <p className="text-xs text-subtle">Mailway no ha indicado ningún registro para este dominio.</p>
            ) : (
              <>
                <p className="mb-2 text-xs text-subtle">Cree estos registros en el proveedor de DNS del dominio.</p>
                <div className="overflow-hidden rounded-md border border-line">
                  {dns.data.records.map((r, i) => (
                    <div
                      key={`${r.type}-${r.name}-${i}`}
                      className="flex flex-col gap-1 border-b border-line/60 bg-surface px-3 py-2 text-xs last:border-b-0 sm:flex-row sm:items-start sm:gap-3"
                    >
                      <span className="w-14 shrink-0 font-mono font-semibold text-txt">{r.type}</span>
                      <span className="flex min-w-0 items-start gap-1 sm:w-48 sm:shrink-0">
                        <span className="min-w-0 break-all font-mono text-sub">{r.name}</span>
                        <CopyButton value={r.name} title="Copiar nombre" className="-my-0.5 shrink-0" />
                      </span>
                      <span className="flex min-w-0 flex-1 items-start gap-1">
                        <span className="min-w-0 flex-1 break-all font-mono text-txt">{r.content}</span>
                        <CopyButton value={r.content} title="Copiar valor" className="-my-0.5 shrink-0" />
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const CHANGE_LABEL: Record<MailCloudflarePlan['changes'][number]['action'], { tone: Tone; label: string }> = {
  create: { tone: 'info', label: 'Crear' },
  update: { tone: 'warn', label: 'Actualizar' },
  keep: { tone: 'ok', label: 'Sin cambios' },
  conflict: { tone: 'err', label: 'Conflicto' },
};

function CloudflareDialog({
  projectId,
  domain,
  canManage,
  onClose,
  onApplied,
}: {
  projectId: string;
  domain: MailDomain;
  canManage: boolean;
  onClose: () => void;
  onApplied: () => void;
}) {
  const toast = useToast();
  const [replaceConflicts, setReplaceConflicts] = useState(false);
  const [result, setResult] = useState<MailCloudflareResult | null>(null);

  const plan = useQuery({
    queryKey: ['mailCf', projectId, domain.id],
    queryFn: () => api.get<MailCloudflarePlan>(`/projects/${projectId}/mail/domains/${domain.id}/cloudflare`),
    // El plan compara con la zona en vivo: cada apertura lo recalcula.
    staleTime: 0,
    gcTime: 0,
  });

  const apply = useMutation({
    mutationFn: () =>
      api.post<MailCloudflareResult>(`/projects/${projectId}/mail/domains/${domain.id}/cloudflare/apply`, { replaceConflicts }),
    onSuccess: (res) => {
      setResult(res);
      onApplied();
      toast(res.errors.length ? 'Cambios aplicados con errores' : 'Registros DNS aplicados en Cloudflare', res.errors.length ? 'err' : 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const p = plan.data;
  const pendientes = p ? p.summary.create + p.summary.update + (replaceConflicts ? p.summary.conflict : 0) : 0;

  return (
    <Modal open onClose={onClose} title={`Cloudflare · ${domain.domain}`} wide>
      {plan.isLoading ? (
        <div className="flex flex-col gap-2" aria-busy>
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-32 w-full rounded-lg" />
        </div>
      ) : plan.isError || !p ? (
        <ErrorState compact title="No se ha podido consultar Cloudflare" error={plan.error} onRetry={() => plan.refetch()} retrying={plan.isFetching} />
      ) : result ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-sub">
            {result.applied.length === 0 ? 'No se ha aplicado ningún cambio.' : `Se han aplicado ${result.applied.length} cambio(s) en la zona.`}
          </p>
          {result.applied.length > 0 && (
            <ul className="space-y-1 rounded-lg border border-line bg-bg px-3 py-2 text-xs">
              {result.applied.map((a, i) => (
                <li key={`${a.type}-${a.name}-${i}`} className="break-all font-mono text-sub">
                  {a.action === 'create' ? 'Creado' : 'Actualizado'} · {a.type} {a.name}
                </li>
              ))}
            </ul>
          )}
          {result.errors.length > 0 && (
            <ul role="alert" className="space-y-1 rounded-lg border border-err/30 bg-err/[.07] px-3 py-2 text-xs text-err">
              {result.errors.map((e, i) => (
                <li key={`${e.type}-${e.name}-${i}`} className="break-all">
                  {e.type} {e.name}: {e.error}
                </li>
              ))}
            </ul>
          )}
          {result.domain && (
            <p className="text-xs text-subtle">
              Estado del dominio: {DOMAIN_STATUS[result.domain.status]?.label ?? result.domain.status} ({result.domain.dns.requiredOk}/
              {result.domain.dns.requiredTotal} registros obligatorios correctos). La propagación del DNS puede tardar unos minutos.
            </p>
          )}
          <div className="flex justify-end">
            <Button onClick={onClose}>Cerrar</Button>
          </div>
        </div>
      ) : !p.available ? (
        <EmptyState
          compact
          icon={<Cloud />}
          title="Cloudflare no está disponible para este dominio"
          description={p.reason || 'Conecte en Mailway → Conexiones una cuenta de Cloudflare con acceso a la zona del dominio.'}
          action={
            <Button variant="secondary" size="sm" onClick={onClose}>
              Cerrar
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-sub">
            Zona <span className="font-mono text-txt">{p.zone?.name ?? domain.domain}</span>
            {p.account ? ` · cuenta «${p.account.label}»` : ''}. Revise los cambios antes de aplicarlos.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {(['create', 'update', 'keep', 'conflict'] as const).map((k) => (
              <Chip key={k} size="sm" tone={CHANGE_LABEL[k].tone} dot>
                {CHANGE_LABEL[k].label}: {p.summary[k]}
              </Chip>
            ))}
          </div>
          <div className="max-h-[45dvh] overflow-y-auto rounded-lg border border-line">
            {p.changes.map((c, i) => (
              <div key={`${c.type}-${c.name}-${i}`} className="border-b border-line/60 bg-bg px-3 py-2 text-xs last:border-b-0">
                <p className="flex flex-wrap items-center gap-2">
                  <Chip size="sm" tone={CHANGE_LABEL[c.action].tone} dot>
                    {CHANGE_LABEL[c.action].label}
                  </Chip>
                  <span className="font-mono font-semibold">{c.type}</span>
                  <span className="min-w-0 break-all font-mono text-sub">{c.name}</span>
                  {!c.required && <span className="text-subtle">(recomendado)</span>}
                </p>
                <p className="mt-1 break-all font-mono text-txt">
                  {c.priority != null ? `${c.priority} ` : ''}
                  {c.content}
                </p>
                {c.current && (c.action === 'update' || c.action === 'conflict') && (
                  <p className="mt-0.5 break-all font-mono text-subtle">Actual: {c.current}</p>
                )}
                <p className="mt-0.5 text-subtle">{c.reason}</p>
              </div>
            ))}
          </div>
          {p.summary.conflict > 0 && (
            <label className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/[.07] px-3 py-2 text-xs text-sub">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-acc"
                checked={replaceConflicts}
                onChange={(e) => setReplaceConflicts(e.target.checked)}
                disabled={!canManage}
              />
              <span>
                <span className="font-medium text-txt">Reemplazar registros en conflicto.</span> Los registros existentes que
                entran en conflicto (por ejemplo, otro proveedor de correo) se sustituirán. El correo que dependa de ellos dejará de
                funcionar.
              </span>
            </label>
          )}
          {!canManage && (
            <p className="text-xs text-subtle">Solo el propietario de la cuenta o un administrador puede aplicar los cambios.</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button onClick={() => apply.mutate()} loading={apply.isPending} disabled={!canManage || pendientes === 0}>
              Aplicar cambios
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------- buzones ----------

function MailboxesTab({
  projectId,
  blocked,
  view,
  secret,
  onSecret,
  onInvalidate,
  onReset,
  onDelete,
  onGoDomains,
}: {
  projectId: string;
  blocked: boolean;
  view: ProjectMailView;
  secret: SecretShown | null;
  onSecret: (s: SecretShown | null) => void;
  onInvalidate: () => void;
  onReset: (m: MailMailbox) => void;
  onDelete: (m: MailMailbox) => void;
  onGoDomains: () => void;
}) {
  const toast = useToast();
  const summary = view.summary!;
  const [domainId, setDomainId] = useState(summary.domains[0]?.id ?? '');
  const [localPart, setLocalPart] = useState('');
  const [displayName, setDisplayName] = useState('');
  const selectedDomain = summary.domains.find((d) => d.id === domainId) ?? summary.domains[0];

  const create = useMutation({
    mutationFn: () =>
      api.post<{ mailbox: MailMailbox; password: string | null }>(`/projects/${projectId}/mail/mailboxes`, {
        domainId: selectedDomain?.id,
        localPart: localPart.trim(),
        displayName: displayName.trim() || undefined,
      }),
    onSuccess: (res) => {
      setLocalPart('');
      setDisplayName('');
      onInvalidate();
      if (res.password) onSecret({ mailboxId: res.mailbox.id, email: res.mailbox.email, password: res.password, reason: 'created' });
      toast(`Buzón ${res.mailbox.email} creado`, 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  if (summary.domains.length === 0) {
    return (
      <EmptyState
        compact
        className="rounded-lg border border-dashed border-line"
        icon={<Inbox />}
        title="Añada primero un dominio"
        description="Los buzones se crean sobre un dominio del proyecto."
        action={
          <Button size="sm" variant="secondary" onClick={onGoDomains}>
            Ir a Dominios
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {secret && <SecretPanel projectId={projectId} secret={secret} onDismiss={() => onSecret(null)} />}

      {view.canManage ? (
        <form
          className="flex flex-col gap-2 rounded-lg border border-line bg-bg p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (localPart.trim() && selectedDomain && !blocked && !selectedDomain.ownershipPending) create.mutate();
          }}
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <input
                className="input min-w-0 flex-1 font-mono text-xs"
                placeholder="info"
                value={localPart}
                onChange={(e) => setLocalPart(e.target.value)}
                aria-label="Nombre del buzón"
                autoCapitalize="none"
                spellCheck={false}
              />
              <span className="shrink-0 text-xs text-subtle">@</span>
              {summary.domains.length === 1 ? (
                <span className="min-w-0 truncate font-mono text-xs text-sub">{selectedDomain?.domain}</span>
              ) : (
                <select
                  className="input min-w-0 flex-1 font-mono text-xs"
                  value={selectedDomain?.id ?? ''}
                  onChange={(e) => setDomainId(e.target.value)}
                  aria-label="Dominio del buzón"
                >
                  {summary.domains.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.domain}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <input
              className="input sm:w-44"
              placeholder="Nombre visible (opcional)"
              value={displayName}
              maxLength={80}
              onChange={(e) => setDisplayName(e.target.value)}
              aria-label="Nombre visible"
            />
            <Button
              type="submit"
              loading={create.isPending}
              disabled={!localPart.trim() || blocked || !!selectedDomain?.ownershipPending}
              className="max-sm:h-11"
            >
              <Inbox size={13} /> Crear buzón
            </Button>
          </div>
          {!view.isAdmin && (
            <p className="text-xs text-subtle">
              Los nombres reservados a la administración del dominio (postmaster, abuse, admin, hostmaster, webmaster, root…) solo
              los puede crear un administrador de la plataforma.
            </p>
          )}
          {selectedDomain?.ownershipPending ? (
            <p className="text-xs text-warn">
              La propiedad del dominio {selectedDomain.domain} está pendiente de comprobar: no es posible crear buzones en él hasta
              verificarla. Los pasos se indican en la pestaña «Dominios».
            </p>
          ) : selectedDomain && selectedDomain.status !== 'active' && (
            <p className="text-xs text-warn">
              El dominio {selectedDomain.domain} aún no está verificado: el buzón no recibirá correo hasta que sus registros DNS sean
              correctos.
            </p>
          )}
        </form>
      ) : (
        <p className="rounded-lg border border-line bg-bg px-3 py-2.5 text-xs text-sub">
          Solo el propietario de la cuenta o un administrador puede crear buzones. Desde aquí puede enviar a cada titular el enlace de
          configuración de su buzón.
        </p>
      )}

      {summary.mailboxes.length === 0 ? (
        <EmptyState
          compact
          className="rounded-lg border border-dashed border-line"
          icon={<Inbox />}
          title="Todavía no hay buzones"
          description="Cree el primer buzón del proyecto, por ejemplo info o contacto."
        />
      ) : (
        <div className="rounded-lg border border-line">
          {summary.mailboxes.map((m) => (
            <MailboxRow
              key={m.id}
              projectId={projectId}
              mailbox={m}
              canManage={view.canManage}
              onReset={() => onReset(m)}
              onDelete={() => onDelete(m)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MailboxRow({
  projectId,
  mailbox,
  canManage,
  onReset,
  onDelete,
}: {
  projectId: string;
  mailbox: MailMailbox;
  canManage: boolean;
  onReset: () => void;
  onDelete: () => void;
}) {
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const quotaBytes = mailbox.quotaMb * 1024 * 1024;
  const pct = mailbox.usedBytes != null && quotaBytes > 0 ? Math.min(100, (mailbox.usedBytes / quotaBytes) * 100) : null;

  const setupLink = useMutation({
    mutationFn: () => api.post<{ url: string }>(`/projects/${projectId}/mail/mailboxes/${mailbox.id}/setup-link`, {}),
    onSuccess: (res) => setLinkUrl(res.url),
    onError: (err: Error) => toast(err.message, 'err'),
  });

  return (
    <div className="border-b border-line/60 bg-bg px-3.5 py-2.5 last:border-b-0">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="break-all font-mono text-sm text-txt">{mailbox.email}</span>
            {mailbox.status === 'suspended' && (
              <Chip size="sm" tone="err" dot>
                Suspendido
              </Chip>
            )}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
            {mailbox.displayName && <span className="truncate">{mailbox.displayName}</span>}
            <span className="tnum flex items-center gap-1.5">
              {pct != null && (
                <span aria-hidden className="h-1 w-16 overflow-hidden rounded-full bg-surface3">
                  <span
                    className={cx('block h-full rounded-full', pct >= 90 ? 'bg-err' : pct >= 75 ? 'bg-warn' : 'bg-acc')}
                    style={{ width: `${Math.max(2, pct)}%` }}
                  />
                </span>
              )}
              {mailbox.usedBytes != null ? `${fmtBytes(mailbox.usedBytes)} de ` : 'Cuota: '}
              {fmtBytes(quotaBytes)}
            </span>
          </div>
        </div>
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-expanded={menuOpen}
            className="press flex h-9 min-w-9 items-center justify-center rounded-lg text-sub hover:bg-surface2 hover:text-txt max-sm:h-11 max-sm:min-w-11"
            title={`Acciones de ${mailbox.email}`}
            aria-label={`Acciones de ${mailbox.email}`}
          >
            <MoreHorizontal size={16} />
          </button>
          <Menu open={menuOpen} onClose={() => setMenuOpen(false)} align="right" className="w-[240px]">
            <MenuItem
              icon={<Link2 size={14} />}
              onClick={() => {
                setMenuOpen(false);
                setupLink.mutate();
              }}
            >
              Crear enlace de configuración
            </MenuItem>
            {canManage && (
              <>
                <MenuItem
                  icon={<KeyRound size={14} />}
                  onClick={() => {
                    setMenuOpen(false);
                    onReset();
                  }}
                >
                  Restablecer contraseña
                </MenuItem>
                <div className="my-1 border-t border-line" />
                <MenuItem
                  danger
                  icon={<Trash2 size={14} />}
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete();
                  }}
                >
                  Eliminar buzón
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
      </div>
      {setupLink.isPending && <Skeleton className="mt-2 h-9 w-full rounded-md" />}
      {linkUrl && (
        <div className="mt-2 rounded-md border border-line bg-surface px-3 py-2">
          <p className="text-xs text-subtle">
            Envíe este enlace al titular del buzón para que configure el correo en sus dispositivos. No incluye la contraseña.
          </p>
          <div className="mt-1 flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-txt">{linkUrl}</span>
            <CopyButton value={linkUrl} title="Copiar enlace" />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Contraseña recién generada. Se muestra una sola vez: al descartarla o cerrar
 * el diálogo ya no se puede recuperar. Desde aquí se puede crear un enlace de
 * configuración que la incluya, para entregarla sin copiarla a mano.
 */
function SecretPanel({ projectId, secret, onDismiss }: { projectId: string; secret: SecretShown; onDismiss: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  // Un secreto distinto (otro buzón) no hereda el enlace del anterior.
  useEffect(() => setUrl(null), [secret.mailboxId, secret.password]);

  const setupLink = useMutation({
    mutationFn: () =>
      api.post<{ url: string; hasPassword: boolean }>(`/projects/${projectId}/mail/mailboxes/${secret.mailboxId}/setup-link`, {
        includePassword: true,
        password: secret.password,
      }),
    onSuccess: (res) => setUrl(res.url),
    onError: (err: Error) => toast(err.message, 'err'),
  });

  return (
    <div role="status" className="rounded-lg border border-ok/30 bg-ok/[.06] p-3">
      <p className="text-sm font-medium text-txt">
        {secret.reason === 'created' ? 'Buzón creado' : 'Contraseña restablecida'}: <span className="font-mono">{secret.email}</span>
      </p>
      <p className="mt-0.5 text-xs text-sub">Copie la contraseña ahora: no se volverá a mostrar.</p>
      <div className="mt-2 flex items-center gap-1 rounded-md border border-line bg-surface px-3 py-2">
        <span className="min-w-0 flex-1 break-all font-mono text-sm text-txt">{secret.password}</span>
        <CopyButton value={secret.password} title="Copiar contraseña" />
      </div>
      {url ? (
        <div className="mt-2">
          <p className="text-xs text-subtle">
            Enlace de configuración (incluye la contraseña; envíelo solo al titular del buzón):
          </p>
          <div className="mt-1 flex items-center gap-1 rounded-md border border-line bg-surface px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-txt">{url}</span>
            <CopyButton value={url} title="Copiar enlace" />
          </div>
        </div>
      ) : null}
      <div className="mt-2.5 flex flex-wrap justify-end gap-2">
        {!url && (
          <Button size="sm" variant="secondary" onClick={() => setupLink.mutate()} loading={setupLink.isPending}>
            <Link2 size={12} /> Crear enlace de configuración
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Cerrar
        </Button>
      </div>
    </div>
  );
}

// ---------- conectar a un servicio ----------

const MODE_HELP: Record<'smtp' | 'api', { title: string; text: string; vars: string[] }> = {
  smtp: {
    title: 'SMTP',
    text: 'Se crea una contraseña de aplicación propia para el servicio (la contraseña del buzón no cambia). Compatible con cualquier biblioteca de correo: Nodemailer, PHPMailer, Django, Laravel, Rails…',
    vars: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'],
  },
  api: {
    title: 'API de envío',
    text: 'Se crea una clave de la API de envío de Mailway con el buzón como remitente. Indicado para correo transaccional mediante HTTP, con límites de envío y registro por clave.',
    vars: ['MAILWAY_API_URL', 'MAILWAY_API_KEY', 'MAIL_FROM'],
  },
};

function ConnectTab({
  projectId,
  blocked,
  view,
  services,
  onClose,
  onGoMailboxes,
  onRevoke,
}: {
  projectId: string;
  blocked: boolean;
  view: ProjectMailView;
  services: Service[];
  onClose: () => void;
  onGoMailboxes: () => void;
  onRevoke: (c: CredentialToRevoke) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const deployables = useMemo(() => services.filter((s) => s.type !== 'database'), [services]);
  const mailboxes = view.summary?.mailboxes ?? [];
  const [serviceId, setServiceId] = useState(deployables[0]?.id ?? '');
  const [mailboxId, setMailboxId] = useState(mailboxes[0]?.id ?? '');
  const [mode, setMode] = useState<'smtp' | 'api'>('smtp');
  const [redeploy, setRedeploy] = useState(false);
  const [result, setResult] = useState<{
    serviceId: string;
    serviceName: string;
    keys: string[];
    needsRedeploy: boolean;
    revoked: number;
  } | null>(null);

  const service = deployables.find((s) => s.id === serviceId) ?? deployables[0];
  const mailbox = mailboxes.find((m) => m.id === mailboxId) ?? mailboxes[0];
  // Credenciales vigentes del cliente: las revocadas ya no hacen nada y solo
  // alargarían la lista.
  const appPasswords = (view.summary?.appPasswords ?? []).filter((a) => !a.revokedAt);
  const apiKeys = (view.summary?.apiKeys ?? []).filter((k) => !k.revokedAt);

  const connect = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; keys: string[]; needsRedeploy: boolean; revoked?: number }>(`/projects/${projectId}/mail/connect`, {
        serviceId: service?.id,
        mailboxId: mailbox?.id,
        mode,
        redeploy,
      }),
    onSuccess: (res) => {
      if (!service) return;
      setResult({ serviceId: service.id, serviceName: service.name, keys: res.keys, needsRedeploy: res.needsRedeploy, revoked: res.revoked ?? 0 });
      queryClient.invalidateQueries({ queryKey: ['env', service.id] });
      queryClient.invalidateQueries({ queryKey: mailKey(projectId) });
      if (!res.needsRedeploy) queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      toast(`Correo conectado a ${service.name}`, 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  if (deployables.length === 0) {
    return (
      <EmptyState
        compact
        className="rounded-lg border border-dashed border-line"
        icon={<Plug />}
        title="No hay servicios a los que conectar el correo"
        description="Cree en este proyecto un servicio de repositorio o de imagen Docker."
      />
    );
  }
  if (mailboxes.length === 0) {
    return (
      <EmptyState
        compact
        className="rounded-lg border border-dashed border-line"
        icon={<Inbox />}
        title="Cree primero un buzón remitente"
        description="El servicio enviará el correo desde uno de los buzones del proyecto."
        action={
          <Button size="sm" variant="secondary" onClick={onGoMailboxes}>
            Ir a Buzones
          </Button>
        }
      />
    );
  }

  const help = MODE_HELP[mode];

  return (
    <div className="flex flex-col gap-3.5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Servicio">
          <select className="input" value={service?.id ?? ''} onChange={(e) => setServiceId(e.target.value)}>
            {deployables.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Buzón remitente">
          <select className="input font-mono text-xs" value={mailbox?.id ?? ''} onChange={(e) => setMailboxId(e.target.value)}>
            {mailboxes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.email}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Segmented
        full
        label="Modo de conexión"
        value={mode}
        onChange={setMode}
        options={[
          { key: 'smtp', label: 'SMTP' },
          { key: 'api', label: 'API de envío' },
        ]}
      />
      <div className="rounded-lg border border-line bg-bg px-3.5 py-3 text-xs leading-5 text-sub">
        <p>{help.text}</p>
        <p className="mt-1.5">
          Variables que se añaden al servicio:{' '}
          {help.vars.map((v, i) => (
            <span key={v}>
              <span className="font-mono text-txt">{v}</span>
              {i < help.vars.length - 1 ? ', ' : '.'}
            </span>
          ))}{' '}
          Si ya existen, se sustituyen; el resto de variables se conservan.
        </p>
        <p className="mt-1.5">
          Si el servicio ya estaba conectado en este modo, la credencial anterior se revoca: hasta que se vuelva a desplegar, el
          servicio no podrá enviar correo.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm text-sub">
        <input type="checkbox" className="h-4 w-4 shrink-0 accent-acc" checked={redeploy} onChange={(e) => setRedeploy(e.target.checked)} />
        Volver a desplegar ahora
      </label>

      {!view.canManage && (
        <p className="text-xs text-subtle">Solo el propietario de la cuenta o un administrador puede conectar el correo a un servicio.</p>
      )}

      <div className="flex justify-end">
        <Button onClick={() => connect.mutate()} loading={connect.isPending} disabled={!view.canManage || !service || !mailbox || blocked}>
          <Plug size={13} /> Conectar
        </Button>
      </div>

      {result && (
        <div role="status" className="rounded-lg border border-ok/30 bg-ok/[.06] px-3.5 py-3 text-xs leading-5 text-sub">
          <p className="font-medium text-txt">Correo conectado a {result.serviceName}.</p>
          <p className="mt-1">
            Se han añadido las variables{' '}
            {result.keys.map((k, i) => (
              <span key={k}>
                <span className="font-mono text-txt">{k}</span>
                {i < result.keys.length - 1 ? ', ' : '.'}
              </span>
            ))}{' '}
            Los valores no se muestran aquí; puede consultarlos en la pestaña «Variables» del servicio.
          </p>
          {result.revoked > 0 && <p className="mt-1">Se ha revocado la credencial que el servicio tenía antes.</p>}
          <p className="mt-1">
            {result.needsRedeploy
              ? 'Es necesario volver a desplegar el servicio para aplicar los cambios.'
              : 'Se ha iniciado un nuevo despliegue del servicio.'}
          </p>
          <Link
            to={`/projects/${projectId}?s=${result.serviceId}&tab=variables`}
            onClick={onClose}
            className="mt-1.5 inline-block font-medium text-acc-soft hover:underline"
          >
            Ver las variables del servicio
          </Link>
        </div>
      )}

      {(appPasswords.length > 0 || apiKeys.length > 0) && (
        <div className="border-t border-line pt-3.5">
          <p className="flex items-center gap-1.5 text-xs font-medium text-sub">
            <KeyRound size={13} /> Credenciales de envío vigentes
          </p>
          <p className="mt-0.5 text-xs text-subtle">
            Contraseñas de aplicación y claves de API del cliente de correo. Revoque las que ya no se utilicen: dejan de funcionar al
            instante.
          </p>
          <div className="mt-2 rounded-lg border border-line">
            {appPasswords.map((a) => (
              <CredentialRow
                key={a.id}
                kind="SMTP"
                name={a.name}
                detail={a.email}
                createdAt={a.createdAt}
                canManage={view.canManage}
                onRevoke={() => onRevoke({ kind: 'app', item: a })}
              />
            ))}
            {apiKeys.map((k) => (
              <CredentialRow
                key={k.id}
                kind="API"
                name={k.name}
                detail={`${k.prefix}… · ${k.senderEmail}${k.lastUsedAt ? ` · último uso ${fmtDateTime(k.lastUsedAt)}` : ''}`}
                createdAt={k.createdAt}
                canManage={view.canManage}
                onRevoke={() => onRevoke({ kind: 'key', item: k })}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CredentialRow({
  kind,
  name,
  detail,
  createdAt,
  canManage,
  onRevoke,
}: {
  kind: 'SMTP' | 'API';
  name: string;
  detail: string;
  createdAt: number | null;
  canManage: boolean;
  onRevoke: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-line/60 bg-bg px-3.5 py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <Chip size="sm">{kind}</Chip>
          <span className="break-all font-mono text-xs text-txt">{name}</span>
        </p>
        <p className="mt-0.5 break-all text-xs text-subtle">
          {detail}
          {createdAt ? ` · creada ${fmtDateTime(createdAt)}` : ''}
        </p>
      </div>
      {canManage && (
        <Button size="sm" variant="ghost" onClick={onRevoke} className="shrink-0 text-err hover:bg-err/[.1]">
          <Ban size={12} /> Revocar
        </Button>
      )}
    </div>
  );
}
