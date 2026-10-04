import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { cambioDominioApi, contar, fechaLarga, MigracionSkyway } from '../../cambioDominio';
import { DEPLOY_STATUS_LABEL } from '../../utils';
import type { DeploymentStatus } from '../../types';
import { Button, Chip, ConfirmModal, useToast } from '../ui';
import { Aviso, Avisos, Bloque } from './comunes';

type Persona = NonNullable<MigracionSkyway['correo']>['buzones']['lista'][number];

/** Nombre de la aplicación a partir de su credencial («skyway:tienda» → «tienda»). */
const appsDe = (p: Persona) => p.usadoPorApps.filter((n) => n.startsWith('skyway:')).map((n) => n.slice('skyway:'.length));

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
  const reintentar = useMutation({
    mutationFn: (serviceId: string) => cambioDominioApi.reintentarServicio(projectId, m.id, serviceId),
    onSuccess: (v) => onCambio(v),
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const actualizar = useMutation({
    mutationFn: (mailboxId: string) => cambioDominioApi.actualizarPersona(projectId, m.id, mailboxId),
    onSuccess: (v) => {
      setPersona(null);
      onCambio(v);
      toast('Usuario actualizado', 'ok');
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
  const viejoWebmail = correo?.webmail.viejo?.hostname ?? null;
  const mensajeMx = `${m.fromDomain} dejará de recibir correo en esta plataforma. Antes, su MX tiene que apuntar a otro sitio o ser un MX nulo («0 .»).`;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5 text-sm leading-6 text-sub">
        <p>
          La web nueva está activa.{' '}
          {permanente !== null &&
            (yaPermanente
              ? `${m.fromDomain} redirige de forma permanente.`
              : `${m.fromDomain} redirige de forma temporal hasta el ${fechaLarga(permanente)} y después de forma permanente.`)}
        </p>
        {correo && (
          <p>
            Desde ahora el correo sale como @{m.toDomain}. Lo que llegue a @{m.fromDomain} sigue entrando en los mismos buzones.
          </p>
        )}
      </div>
      {m.error && <Aviso tono="err">{m.error}</Aviso>}

      {m.servicios.length > 0 && (
        <Bloque titulo="Servicios">
          <ul className="divide-y divide-line rounded-lg border border-line bg-bg">
            {m.servicios.map((s) => (
              <li key={s.serviceId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2.5">
                <span className="min-w-0 flex-1 basis-40">
                  <span className="block text-sm font-medium text-txt">{s.nombre}</span>
                  {s.error && <span className="mt-0.5 block break-words text-xs leading-5 text-err">{s.error}</span>}
                </span>
                <Chip tone={s.estado === 'ok' ? 'ok' : s.estado === 'error' ? 'err' : 'info'} size="sm" dot pulse={s.estado === 'desplegando'}>
                  {s.estado === 'ok'
                    ? 'Desplegado'
                    : s.estado === 'error'
                      ? 'Error'
                      : s.despliegue
                        ? (DEPLOY_STATUS_LABEL[s.despliegue.estado as DeploymentStatus] ?? 'Desplegando')
                        : 'Desplegando'}
                </Chip>
                {s.estado === 'error' && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => reintentar.mutate(s.serviceId)}
                    loading={reintentar.isPending && reintentar.variables === s.serviceId}
                  >
                    Reintentar este servicio
                  </Button>
                )}
              </li>
            ))}
          </ul>
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
        message={`La web vuelve a servirse en ${m.fromDomain} sin redirecciones. Los nombres de ${m.toDomain} se siguen sirviendo, para que los enlaces que ya los usan no fallen.`}
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
      </ConfirmModal>

      {m.estado === 'pasada' && pendientes.length > 0 && (
        <p className="text-xs leading-5 text-subtle">
          {contar(pendientes.length, 'persona entra', 'personas entran')} todavía con su usuario de {m.fromDomain}. Cada una puede
          actualizarlo desde «Mi buzón» o su enlace de configuración con «Actualizar mis dispositivos».
        </p>
      )}
    </div>
  );
}
