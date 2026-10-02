import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ExternalLink, Trash2, Unplug } from 'lucide-react';
import { api } from '../api';
import { MailPlan, MailwayConfigView, MailwayTestResult, Project } from '../types';
import { cx, fmtBytes, safeHref, timeAgo } from '../utils';
import { Button, ConfirmModal, ErrorState, Field, Skeleton, useFlash, useToast } from './ui';

/**
 * Conexión con Mailway (Ajustes → Correo). Es una sección de acción inmediata,
 * con su propio botón de guardar: el token es un secreto que solo se escribe
 * (nunca se lee de vuelta) y la barra de guardado global no debe mezclarlo con
 * el resto de ajustes.
 */
export default function MailwaySettings() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [baseUrl, setBaseUrl] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [token, setToken] = useState('');
  const [defaultPlanId, setDefaultPlanId] = useState('');
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [test, setTest] = useState<{ ok: true; result: MailwayTestResult } | { ok: false; message: string } | null>(null);
  const [saved, flashSaved] = useFlash();

  const config = useQuery({
    queryKey: ['mailwayConfig'],
    queryFn: () => api.get<MailwayConfigView>('/mailway/config'),
  });
  // Servicios candidatos a ser el panel de Mailway: los de repositorio o imagen.
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: Project[] }>('/projects'),
    staleTime: 30_000,
  });

  // Planes de la instancia, para elegir con cuál se crean los clientes de los
  // proyectos cuando no los activa un administrador.
  const plans = useQuery({
    queryKey: ['mailwayPlans'],
    queryFn: () => api.get<{ plans: MailPlan[]; defaultPlanId: string | null }>('/mailway/plans'),
    enabled: !!config.data?.configured,
    staleTime: 60_000,
    retry: false,
  });

  // Los campos se rellenan cuando cambia el valor guardado, no en cada recarga.
  const savedBaseUrl = config.data?.baseUrl ?? '';
  const savedServiceId = config.data?.serviceId ?? '';
  const savedDefaultPlanId = config.data?.defaultPlanId ?? '';
  useEffect(() => setBaseUrl(savedBaseUrl), [savedBaseUrl]);
  useEffect(() => setServiceId(savedServiceId), [savedServiceId]);
  useEffect(() => setDefaultPlanId(savedDefaultPlanId), [savedDefaultPlanId]);

  const candidates = useMemo(
    () =>
      (projects.data?.projects ?? [])
        .map((p) => ({ project: p, services: (p.services ?? []).filter((s) => s.type !== 'database') }))
        .filter((g) => g.services.length > 0),
    [projects.data],
  );

  const dirty =
    !!config.data &&
    (baseUrl.trim() !== savedBaseUrl || serviceId !== savedServiceId || defaultPlanId !== savedDefaultPlanId || !!token.trim());

  const save = useMutation({
    mutationFn: (body: { baseUrl?: string; serviceId?: string; token?: string; defaultPlanId?: string }) =>
      api.put<{ ok: boolean; config: MailwayConfigView }>('/mailway/config', body),
    onSuccess: (res) => {
      queryClient.setQueryData(['mailwayConfig'], res.config);
      queryClient.invalidateQueries({ queryKey: ['mailwayStatus'] });
      setToken('');
      flashSaved();
      toast('Configuración de Mailway guardada', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const disconnect = useMutation({
    mutationFn: () => api.post<{ ok: boolean; config: MailwayConfigView }>('/mailway/disconnect'),
    onSuccess: (res) => {
      setDisconnectOpen(false);
      queryClient.setQueryData(['mailwayConfig'], res.config);
      queryClient.invalidateQueries({ queryKey: ['mailwayStatus'] });
      queryClient.removeQueries({ queryKey: ['mailwayPlans'] });
      setToken('');
      setTest(null);
      toast('Mailway desconectado', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const runTest = useMutation({
    mutationFn: () =>
      api.post<MailwayTestResult>(
        '/mailway/test',
        dirty ? { baseUrl: baseUrl.trim() || undefined, serviceId: serviceId || undefined, token: token.trim() || undefined } : {},
      ),
    onMutate: () => setTest(null),
    onSuccess: (result) => {
      setTest({ ok: true, result });
      queryClient.invalidateQueries({ queryKey: ['mailwayConfig'] });
    },
    onError: (err: Error) => setTest({ ok: false, message: err.message }),
  });

  if (config.isLoading) return <Skeleton className="h-40 w-full rounded-lg" />;
  if (config.isError || !config.data) {
    return (
      <ErrorState
        compact
        className="rounded-lg border border-dashed border-line"
        title="No se ha podido cargar la configuración de Mailway"
        error={config.error}
        onRetry={() => config.refetch()}
        retrying={config.isFetching}
      />
    );
  }

  const cfg = config.data;
  const bridge = cfg.traefik;
  const panelHref = safeHref(cfg.panelUrl);
  const planList = plans.data?.plans ?? [];
  const canDisconnect = cfg.hasToken || !!cfg.baseUrl || !!cfg.serviceId || (bridge?.routers ?? 0) > 0;

  return (
    <div className="flex flex-col gap-3.5">
      <ConfirmModal
        open={disconnectOpen}
        onClose={() => setDisconnectOpen(false)}
        onConfirm={() => disconnect.mutate()}
        loading={disconnect.isPending}
        title="Desconectar Mailway"
        message="Se eliminarán la dirección, el token de gestión, el servicio del panel y el plan predeterminado, y se retirarán de Traefik las rutas de los dominios propios de los clientes de Mailway (webmail de marca blanca y autoconfiguración), que dejarán de responder a través de este servidor. Los proyectos conservan su vínculo con el cliente de correo, y los clientes, buzones y mensajes se conservan en Mailway."
        confirmLabel="Desconectar Mailway"
      />
      <ol className="list-decimal space-y-1 rounded-lg border border-line bg-bg py-3 pl-8 pr-3.5 text-xs leading-5 text-sub">
        <li>
          En Mailway → <span className="font-medium text-txt">Conexiones → Tokens de gestión</span>, crea un token de administrador
          y pégalo aquí.
        </li>
        <li>Indica la URL pública del panel de Mailway o, si lo despliega este servidor, selecciona su servicio.</li>
        <li>Pulsa «Probar conexión» y guarda. El botón «Correo» de cada proyecto quedará disponible.</li>
      </ol>

      <Field
        label="Servicio del panel de Mailway"
        hint="Opcional. Si Mailway se despliega con Skyway en este servidor, las peticiones se envían por la red interna, sin salir a internet."
      >
        <select className="input" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
          <option value="">Ninguno (usar la URL pública)</option>
          {candidates.map((g) => (
            <optgroup key={g.project.id} label={g.project.name}>
              {g.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </Field>
      {cfg.serviceId && cfg.serviceId === serviceId && (
        <p className="-mt-2 text-xs text-subtle">
          {cfg.internalUrl ? (
            <>
              Dirección interna: <span className="font-mono">{cfg.internalUrl}</span>
            </>
          ) : (
            <span className="text-warn">
              El servicio no tiene dominio ni puerto interno: no es accesible por la red interna y se utilizará la URL pública.
            </span>
          )}
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="URL pública del panel" hint="Se utiliza en los enlaces que se muestran a los usuarios.">
          <input
            className="input font-mono text-xs"
            type="url"
            inputMode="url"
            placeholder="https://panel.tuempresa.com"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </Field>
        <Field label="Token de gestión" hint="Solo se almacena en el servidor; no se vuelve a mostrar.">
          <input
            className="input font-mono text-xs"
            type="password"
            autoComplete="off"
            placeholder={cfg.hasToken ? '•••• (escribe para reemplazar)' : 'mwt_…'}
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setTest(null);
            }}
          />
        </Field>
      </div>

      {cfg.configured && (
        <Field
          label="Plan predeterminado de los proyectos"
          hint="Plan con el que se crea el cliente de correo cuando lo activa el propietario de un proyecto. Solo un administrador puede elegir otro."
        >
          <select
            className="input"
            value={defaultPlanId}
            onChange={(e) => setDefaultPlanId(e.target.value)}
            disabled={plans.isLoading || plans.isError}
          >
            <option value="">{plans.isError ? 'No se han podido cargar los planes' : 'El primero de Mailway'}</option>
            {planList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.maxDomains} dominio(s), {p.maxMailboxes} buzones de {fmtBytes(p.mailboxQuotaMb * 1024 * 1024)}
              </option>
            ))}
            {defaultPlanId && !plans.isLoading && !planList.some((p) => p.id === defaultPlanId) && (
              <option value={defaultPlanId}>{defaultPlanId} (no existe en Mailway)</option>
            )}
          </select>
        </Field>
      )}

      {test && (
        <div
          role={test.ok ? 'status' : 'alert'}
          className={cx(
            'rounded-lg border px-3 py-2 text-xs leading-5',
            test.ok ? 'border-ok/30 bg-ok/[.08] text-ok' : 'border-err/30 bg-err/[.08] text-err',
          )}
        >
          {test.ok ? (
            <>
              Conexión correcta con <span className="font-semibold">{test.result.info.brandName || 'Mailway'}</span> (Mailway{' '}
              {test.result.info.version}) · servidor de correo <span className="font-mono">{test.result.info.mailHostname}</span> ·
              rol del token: {test.result.info.role === 'admin' ? 'administrador' : 'cliente'}
              {test.result.warnings.map((w) => (
                <span key={w} className="mt-1 flex items-start gap-1 text-warn">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {w}
                </span>
              ))}
            </>
          ) : (
            test.message
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => runTest.mutate()}
          loading={runTest.isPending}
          title="Valida los valores indicados o, si no hay cambios, los guardados"
        >
          Probar conexión
        </Button>
        <Button
          size="sm"
          onClick={() =>
            save.mutate({
              baseUrl: baseUrl.trim(),
              serviceId,
              defaultPlanId,
              ...(token.trim() ? { token: token.trim() } : {}),
            })
          }
          loading={save.isPending}
          disabled={!dirty}
          success={saved && !dirty}
        >
          Guardar
        </Button>
        {cfg.hasToken && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => save.mutate({ token: '' })}
            loading={save.isPending}
            className="text-err hover:bg-err/[.1]"
            title="Deja de usar el token. Los dominios ya publicados en Traefik se mantienen hasta desconectar Mailway."
          >
            <Trash2 size={13} /> Eliminar token
          </Button>
        )}
        {canDisconnect && (
          <Button variant="ghost" size="sm" onClick={() => setDisconnectOpen(true)} className="text-err hover:bg-err/[.1]">
            <Unplug size={13} /> Desconectar Mailway
          </Button>
        )}
        {panelHref && (
          <a
            href={panelHref}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-acc-soft hover:underline"
          >
            Abrir Mailway <ExternalLink size={12} />
          </a>
        )}
      </div>

      {bridge && (
        <details className="group animate-details border-t border-line pt-3">
          <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-sub hover:text-txt">
            <ChevronDown size={12} className="shrink-0 transition-transform duration-200 ease-out group-open:rotate-180" />
            Dominios propios publicados en Traefik: {bridge.routers} ruta(s)
            {bridge.error && <span className="text-warn">· última lectura fallida</span>}
          </summary>
          <div className="details-body mt-2 space-y-1.5 text-xs leading-5 text-subtle">
            <p>
              Traefik lee cada 15 s las rutas de los dominios de marca blanca y de autoconfiguración de Mailway a través de Skyway,
              que solo admite reglas de dominio hacia los contenedores de Mailway.
              {bridge.syncedAt ? ` Última lectura correcta: ${timeAgo(bridge.syncedAt)}.` : ''}
            </p>
            {bridge.error && <p className="text-warn">{bridge.error} Se mantiene la última configuración correcta.</p>}
            <p>
              Eliminar el token o cambiar la dirección no retira estas rutas, para que el webmail de los clientes siga
              funcionando; solo las retira «Desconectar Mailway».
            </p>
            {bridge.dropped.length > 0 && (
              <>
                <p className="font-medium text-sub">Rutas descartadas por seguridad:</p>
                <ul className="list-disc space-y-0.5 pl-5 font-mono">
                  {bridge.dropped.slice(0, 20).map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
