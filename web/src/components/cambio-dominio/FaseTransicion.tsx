import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  cambioDominioApi,
  contar,
  enumerar,
  fechaLarga,
  MigracionSkyway,
  UsuarioSinGestionar,
  WebhookEnRiesgo,
} from '../../cambioDominio';
import { Button, Chip, ConfirmModal, useToast } from '../ui';
import { Aviso, Avisos, AvisosWebhooks, Bloque } from './comunes';
import ServiciosCambio from './ServiciosCambio';

type Persona = NonNullable<MigracionSkyway['correo']>['buzones']['lista'][number];

/** Nombre de la aplicación a partir de su credencial («skyway:tienda» → «tienda»). */
const appsDe = (p: Persona) => p.usadoPorApps.filter((n) => n.startsWith('skyway:')).map((n) => n.slice('skyway:'.length));

/** «Bot» (TG_SMTP_LOGIN), los servicios que heredan las compartidas (SMTP_USER)…: lo que se vuelve a desplegar. */
function despliegues(usuarios: readonly UsuarioSinGestionar[]): string {
  const porServicio = new Map<string, Set<string>>();
  for (const u of usuarios) {
    for (const x of u.usos) {
      const nombre = x.ambito === 'project' ? 'los servicios que heredan las variables compartidas' : `«${x.serviceName ?? '?'}»`;
      porServicio.set(nombre, (porServicio.get(nombre) ?? new Set()).add(x.key));
    }
  }
  return enumerar([...porServicio].map(([nombre, keys]) => `${nombre} (${[...keys].join(', ')})`));
}

/**
 * Paso 3, «En transición»: la web y el correo ya están en el dominio nuevo y
 * el anterior redirige (y sigue recibiendo correo). Desde aquí se actualizan
 * las personas, se vuelve atrás o se da de baja el dominio anterior.
 */
export default function FaseTransicion({
  projectId,
  m,
  onCambio,
}: {
  projectId: string;
  m: MigracionSkyway;
  onCambio: (m: MigracionSkyway) => void;
}) {
  const toast = useToast();
  const [volverAbierto, setVolverAbierto] = useState(false);
  const [bajaAbierta, setBajaAbierta] = useState(false);
  const [terminarAbierto, setTerminarAbierto] = useState(false);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [sinGestionar, setSinGestionar] = useState<UsuarioSinGestionar | null>(null);
  const [webhook, setWebhook] = useState<WebhookEnRiesgo | null>(null);

  const volver = useMutation({
    mutationFn: () => cambioDominioApi.volver(projectId, m.id),
    onSuccess: (v) => {
      setVolverAbierto(false);
      onCambio(v);
      toast(`Se ha vuelto a ${m.fromDomain}.`, 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const baja = useMutation({
    mutationFn: (confirm: string) => cambioDominioApi.darDeBaja(projectId, m.id, confirm),
    onSuccess: (v) => {
      setBajaAbierta(false);
      onCambio(v);
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const terminar = useMutation({
    mutationFn: (confirm: string) => cambioDominioApi.terminar(projectId, m.id, confirm),
    onSuccess: (v) => {
      setTerminarAbierto(false);
      onCambio(v);
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const actualizar = useMutation({
    mutationFn: (mailboxId: string) => cambioDominioApi.actualizarPersona(projectId, m.id, mailboxId),
    onSuccess: (v) => {
      setPersona(null);
      setSinGestionar(null);
      onCambio(v);
      toast('Usuario actualizado', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });
  // Tras pasar, «Servir también» vuelve a desplegar el servicio con el nombre anterior.
  const servir = useMutation({
    mutationFn: async (w: WebhookEnRiesgo) => {
      let vista: MigracionSkyway | null = null;
      for (const h of w.hosts) vista = await cambioDominioApi.modoHost(projectId, m.id, { serviceId: h.serviceId, from: h.from, modo: 'servir' });
      return vista;
    },
    onSuccess: (v) => {
      setWebhook(null);
      if (v) onCambio(v);
      toast('Se sirve también el nombre anterior: el servicio se está desplegando.', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const correo = m.correo;
  const pendientes = (correo?.buzones.lista ?? []).filter((p) => p.pendiente);
  const conApps = pendientes.filter((p) => appsDe(p).length > 0);
  const apps = [...new Set(conApps.flatMap(appsDe))];
  const permanente = m.redirecciones.length > 0 ? Math.min(...m.redirecciones.map((r) => r.permanenteDesde)) : null;
  const yaPermanente = permanente !== null && permanente <= Date.now();
  const ocupado = m.servicios.some((s) => s.estado === 'desplegando');
  const conWeb = m.hosts.some((h) => h.modo !== 'no_cambiar');
  const viejoWebmail = correo?.webmail.viejo?.hostname ?? null;
  const mensajeMx = `${m.fromDomain} dejará de recibir correo en esta plataforma. Antes, su MX tiene que apuntar a otro sitio o ser un MX nulo («0 .»).`;
  const nombreServicio = (id: string) => m.hosts.find((h) => h.serviceId === id)?.serviceName ?? 'el servicio';
  const sinGestionarDe = (mailboxId: string) => m.usuariosSinGestionar.filter((u) => u.mailboxId === mailboxId);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5 text-sm leading-6 text-sub">
        {conWeb && (
          <p>
            La web nueva está activa.{' '}
            {permanente !== null &&
              (yaPermanente
                ? `${m.fromDomain} redirige de forma permanente.`
                : `${m.fromDomain} redirige de forma temporal hasta el ${fechaLarga(permanente)} y después de forma permanente.`)}
          </p>
        )}
        {correo && (
          <p>
            Desde ahora el correo sale como @{m.toDomain}. Lo que llegue a @{m.fromDomain} sigue entrando en los mismos buzones.
          </p>
        )}
      </div>
      {/* En «dando_de_baja» el error ya lo enseña el aviso de la acción en curso, con «Reintentar». */}
      {m.error && m.estado === 'pasada' && <Aviso tono="err">{m.error}</Aviso>}

      <ServiciosCambio
        projectId={projectId}
        m={m}
        onCambio={onCambio}
        accion={m.estado !== 'pasada' ? null : m.soloWeb ? 'terminar' : `dar de baja ${m.fromDomain}`}
      />

      {m.estado === 'pasada' && (
        <AvisosWebhooks
          webhooks={m.webhooks}
          pasada
          onServir={(w) => setWebhook(w)}
          ocupado={servir.isPending ? (servir.variables?.serviceId ?? null) : null}
          deshabilitado={ocupado}
        />
      )}

      {m.usuariosSinGestionar.length > 0 && (
        <Bloque titulo="Servicios que envían con un usuario que cambia">
          <ul className="divide-y divide-line rounded-lg border border-line bg-bg">
            {m.usuariosSinGestionar.map((u) => (
              <li key={u.mailboxId} className="flex flex-col gap-2 px-3.5 py-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="min-w-0 flex-1 basis-60">
                    <span className="block break-all font-mono text-sm text-txt">{u.email}</span>
                    <span className="mt-0.5 block break-words text-xs leading-5 text-subtle">
                      Entra con {u.login}
                      {u.pendiente ? ' · Pendiente de actualizar' : ''}
                    </span>
                  </span>
                  <Button variant="secondary" size="sm" onClick={() => setSinGestionar(u)} disabled={m.estado !== 'pasada'}>
                    Actualizar y desplegar
                  </Button>
                </div>
                <ul className="flex flex-col gap-1">
                  {u.usos.map((x) => (
                    <li key={`${x.ambito}:${x.serviceId ?? ''}:${x.key}`} className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                      <span className="text-sub">{x.ambito === 'project' ? 'Compartida' : x.serviceName}</span>
                      <span className="break-all font-mono text-txt">{x.key}</span>
                      <span className="break-all font-mono text-subtle">{x.usuario}</span>
                      <Chip tone={x.estado === 'no_entra' ? 'err' : 'warn'} size="sm">
                        {x.estado === 'no_entra' ? 'No entra' : 'Entra hasta actualizar'}
                      </Chip>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs leading-5 text-subtle">
            Son variables que Skyway no gestiona (puestas a mano o con otro nombre). «Actualizar y desplegar» actualiza el usuario del buzón, las
            cambia al usuario nuevo y vuelve a desplegar esos servicios con la versión en marcha. La baja de {m.fromDomain} lo hace también.
          </p>
        </Bloque>
      )}

      {correo && (
        <Bloque titulo="Personas pendientes de actualizar dispositivos">
          {pendientes.length === 0 ? (
            <p className="rounded-lg border border-line bg-bg px-3.5 py-2.5 text-sm text-sub">
              {correo.buzones.total > 0 ? 'Todas las personas entran ya con su dirección nueva.' : 'No hay buzones en este cambio.'}
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line bg-bg">
              {pendientes.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2.5">
                  <span className="min-w-0 flex-1 basis-60">
                    <span className="block break-all font-mono text-sm text-txt">{p.email}</span>
                    <span className="mt-0.5 block break-words text-xs leading-5 text-subtle">
                      Entra con {p.login} · Pendiente de actualizar dispositivos
                      {appsDe(p).length > 0 ? ` · La usa una aplicación para enviar (${appsDe(p).join(', ')})` : ''}
                    </span>
                  </span>
                  <Button variant="secondary" size="sm" onClick={() => setPersona(p)} disabled={m.estado !== 'pasada'}>
                    Actualizar ahora
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Bloque>
      )}

      <Avisos
        tono="info"
        avisos={m.appsManuales.map(
          (a) =>
            `${a.email} tiene contraseñas de aplicación creadas a mano (${a.apps.join(', ')}) y no lo usa ningún servicio de este proyecto: las aplicaciones que las usan tendrán que entrar con ${a.email} tras actualizarlo o dar de baja ${m.fromDomain}.`,
        )}
      />

      <Avisos tono="info" avisos={m.avisos} />

      {m.estado === 'pasada' && (
        <div className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">
          {m.puedeVolver && (
            <Button variant="secondary" onClick={() => setVolverAbierto(true)} disabled={ocupado} className="max-sm:h-11">
              Volver a {m.fromDomain}
            </Button>
          )}
          {m.soloWeb ? (
            <Button onClick={() => setTerminarAbierto(true)} disabled={!m.puedeTerminar || ocupado} className="max-sm:h-11">
              Terminar
            </Button>
          ) : (
            <Button
              variant="danger"
              onClick={() => setBajaAbierta(true)}
              disabled={!m.puedeDarDeBaja || ocupado}
              className="max-sm:h-11"
            >
              Dar de baja {m.fromDomain}…
            </Button>
          )}
        </div>
      )}
      {m.estado === 'pasada' && !m.soloWeb && !m.puedeDarDeBaja && (correo?.bloqueosBaja ?? []).some((b) => b.code !== 'mailbox_used_by_app') && (
        <Avisos tono="warn" avisos={correo!.bloqueosBaja.filter((b) => b.code !== 'mailbox_used_by_app').map((b) => b.mensaje)} />
      )}

      <ConfirmModal
        open={volverAbierto}
        onClose={() => setVolverAbierto(false)}
        onConfirm={() => volver.mutate()}
        loading={volver.isPending}
        title={`Volver a ${m.fromDomain}`}
        message={
          conWeb
            ? `La web vuelve a servirse en ${m.fromDomain} sin redirecciones. Los nombres de ${m.toDomain} se siguen sirviendo, para que los enlaces que ya los usan no fallen.`
            : `Se deshace el paso a ${m.toDomain}.`
        }
        confirmLabel={`Volver a ${m.fromDomain}`}
        confirmVariant="secondary"
      >
        {correo && (
          <p className="mt-2 text-sm text-sub">
            El correo volverá a salir como @{m.fromDomain}. Quien ya haya actualizado sus dispositivos seguirá entrando con su usuario de{' '}
            {m.toDomain}.
          </p>
        )}
      </ConfirmModal>

      <ConfirmModal
        open={terminarAbierto}
        onClose={() => setTerminarAbierto(false)}
        onConfirm={() => terminar.mutate(m.fromDomain)}
        loading={terminar.isPending}
        title="Terminar el cambio de dominio"
        message={`${m.fromDomain} seguirá redirigiendo a ${m.toDomain}, pero ya no se podrá volver desde el asistente: se descartan los valores anteriores de las variables.`}
        confirmLabel="Terminar"
        confirmVariant="primary"
        typeToConfirm={m.fromDomain}
        typeToConfirmIgnoreCase
      />

      <ConfirmModal
        open={bajaAbierta}
        onClose={() => setBajaAbierta(false)}
        // El diálogo solo deja confirmar con el dominio escrito; el servidor lo vuelve a comprobar.
        onConfirm={() => baja.mutate(m.fromDomain)}
        loading={baja.isPending}
        title={`Dar de baja ${m.fromDomain}`}
        message={
          apps.length > 0
            ? `Antes de dar de baja ${m.fromDomain}, las aplicaciones que envían con su usuario de ${m.fromDomain} (${apps.join(', ')}) pasarán a usar el de ${m.toDomain}: se desplegará la versión que ya está en marcha y no podrán enviar durante unos segundos.`
            : mensajeMx
        }
        confirmLabel="Dar de baja"
        typeToConfirm={m.fromDomain}
        typeToConfirmIgnoreCase
      >
        <div className="mt-2 flex flex-col gap-2 text-sm leading-6 text-sub">
          {apps.length > 0 && <p>{mensajeMx}</p>}
          {m.usuariosSinGestionar.length > 0 && (
            <p>
              También pasarán a entrar con su usuario de {m.toDomain} y se volverán a desplegar con la versión en marcha:{' '}
              {despliegues(m.usuariosSinGestionar)}.
            </p>
          )}
          {pendientes.length > 0 && (
            <div>
              <p>
                {pendientes.length === 1
                  ? `La persona que aún entra con su usuario de ${m.fromDomain} pasará a entrar con su dirección de ${m.toDomain}. Sus dispositivos sin actualizar dejarán de conectar hasta que cambien el usuario. La contraseña no cambia.`
                  : `Las ${pendientes.length} personas que aún entran con su usuario de ${m.fromDomain} pasarán a entrar con su dirección de ${m.toDomain}. Sus dispositivos sin actualizar dejarán de conectar hasta que cambien el usuario. La contraseña no cambia.`}
              </p>
              <ul className="mt-1 list-disc pl-5 text-xs leading-5">
                {pendientes.map((p) => (
                  <li key={p.id} className="break-all">
                    {p.email}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {viejoWebmail && <p>{viejoWebmail} dejará de funcionar.</p>}
          <p className="text-xs leading-5 text-subtle">Si acabas de cambiar el MX, espera al menos un día: algunos servidores tardan en ver el cambio.</p>
        </div>
      </ConfirmModal>

      <ConfirmModal
        open={!!persona}
        onClose={() => setPersona(null)}
        onConfirm={() => persona && actualizar.mutate(persona.id)}
        loading={actualizar.isPending}
        title="Actualizar ahora"
        message={
          persona
            ? `Los dispositivos de ${persona.email} que sigan configurados con ${persona.login} dejarán de conectar hasta que se actualicen. La contraseña no cambia.`
            : ''
        }
        confirmLabel="Actualizar"
        confirmVariant="primary"
      >
        {persona && appsDe(persona).length > 0 && (
          <p className="mt-2 text-sm text-sub">
            La usa una aplicación para enviar ({appsDe(persona).join(', ')}): pasará a usar {persona.email} y se desplegará la versión que ya
            está en marcha, sin poder enviar durante unos segundos.
          </p>
        )}
        {persona && sinGestionarDe(persona.id).length > 0 && (
          <p className="mt-2 text-sm text-sub">
            También se volverán a desplegar, con {persona.email}: {despliegues(sinGestionarDe(persona.id))}.
          </p>
        )}
      </ConfirmModal>

      <ConfirmModal
        open={!!sinGestionar}
        onClose={() => setSinGestionar(null)}
        onConfirm={() => sinGestionar && actualizar.mutate(sinGestionar.mailboxId)}
        loading={actualizar.isPending}
        title="Actualizar y desplegar"
        message={
          sinGestionar
            ? sinGestionar.pendiente
              ? `${sinGestionar.email} pasará a entrar con ${sinGestionar.email} en lugar de ${sinGestionar.login} (también para las personas que lo usan) y se volverán a desplegar: ${despliegues([sinGestionar])}. La contraseña no cambia.`
              : `Se volverán a desplegar ${despliegues([sinGestionar])} para que entren con ${sinGestionar.login}. La contraseña no cambia.`
            : ''
        }
        confirmLabel="Actualizar y desplegar"
        confirmVariant="primary"
      />

      <ConfirmModal
        open={!!webhook}
        onClose={() => setWebhook(null)}
        onConfirm={() => webhook && servir.mutate(webhook)}
        loading={servir.isPending}
        title="Servir también el nombre anterior"
        message={
          webhook
            ? `${webhook.hosts.map((h) => `${h.from} dejará de redirigir y se servirá también desde «${nombreServicio(h.serviceId)}».`).join(' ')} ${
                new Set(webhook.hosts.map((h) => h.serviceId)).size === 1 ? 'Se vuelve a desplegar el servicio.' : 'Se vuelven a desplegar los servicios.'
              }`
            : ''
        }
        confirmLabel="Servir también"
        confirmVariant="primary"
      />

      {m.estado === 'pasada' && pendientes.length > 0 && (
        <p className="text-xs leading-5 text-subtle">
          {contar(pendientes.length, 'persona entra', 'personas entran')} todavía con su usuario de {m.fromDomain}. Cada una puede
          actualizarlo desde «Mi buzón» o su enlace de configuración con «Actualizar mis dispositivos».
        </p>
      )}
    </div>
  );
}
