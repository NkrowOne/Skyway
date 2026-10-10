import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import { cambioDominioApi, contar, enumerar, MigracionSkyway, WebhookEnRiesgo } from '../../cambioDominio';
import { copyToClipboard } from '../../utils';
import { Button, Chip, ConfirmModal, Modal, useToast } from '../ui';
import { Aviso, Avisos, AvisosWebhooks, Bloque, Condicion } from './comunes';
import ServiciosCambio from './ServiciosCambio';

const DNS_CHIP = {
  ok: { tone: 'ok', label: 'Apunta a este servidor' },
  pendiente: { tone: 'warn', label: 'Pendiente' },
  desconocido: { tone: 'neutral', label: 'Sin comprobar' },
} as const;

/**
 * Paso 2, «Preparar»: el DNS, los certificados y el correo del dominio nuevo,
 * medidos cada 30 s, hasta que todo está listo para pasar. Nada de lo que se
 * hace aquí se nota en la web ni en el correo actuales.
 */
export default function FasePreparar({
  projectId,
  m,
  onCambio,
  onComprobar,
  comprobando,
}: {
  projectId: string;
  m: MigracionSkyway;
  onCambio: (m: MigracionSkyway) => void;
  onComprobar: () => void;
  comprobando: boolean;
}) {
  const toast = useToast();
  const [pasarAbierto, setPasarAbierto] = useState(false);
  const [cancelarAbierto, setCancelarAbierto] = useState(false);
  const [mxAbierto, setMxAbierto] = useState(false);
  const [copiando, setCopiando] = useState(false);

  const nuevos = [...new Map(m.hosts.filter((h) => h.modo !== 'no_cambiar').map((h) => [h.to, h])).values()];
  const correo = m.correo;
  const conCorreo = !m.soloWeb;
  // Lo que pasa, para no hablar de la web en un cambio solo del correo (ni al revés).
  const queCambia = nuevos.length > 0 && conCorreo ? 'La web y el correo han' : nuevos.length > 0 ? 'La web ha' : 'El correo ha';

  const pasar = useMutation({
    mutationFn: () => cambioDominioApi.pasar(projectId, m.id, m.variables?.huella ?? ''),
    onSuccess: (v) => {
      setPasarAbierto(false);
      onCambio(v);
      toast(`${queCambia} pasado a ${m.toDomain}.`, 'ok');
    },
    onError: (err: Error) => {
      setPasarAbierto(false);
      toast(err.message, 'err');
      onComprobar();
    },
  });

  const cancelar = useMutation({
    mutationFn: () => cambioDominioApi.cancelar(projectId, m.id),
    onSuccess: (v) => {
      setCancelarAbierto(false);
      onCambio(v);
      toast('Cambio de dominio cancelado', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  // «Servir también» los nombres en los que el servicio recibe webhooks: solo cambia el modo (nada se despliega hasta pasar).
  const servir = useMutation({
    mutationFn: async (w: WebhookEnRiesgo) => {
      let vista: MigracionSkyway | null = null;
      for (const h of w.hosts) vista = await cambioDominioApi.modoHost(projectId, m.id, { serviceId: h.serviceId, from: h.from, modo: 'servir' });
      return vista;
    },
    onSuccess: (v, w) => {
      if (v) onCambio(v);
      toast(`${enumerar(w.hosts.map((h) => h.from))} se ${w.hosts.length === 1 ? 'servirá' : 'servirán'} también al pasar, sin redirigir.`, 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const mx = useMutation({
    mutationFn: () => cambioDominioApi.cambiarMx(projectId, m.id),
    onSuccess: (v) => {
      setMxAbierto(false);
      onCambio(v);
      toast(`MX de ${m.toDomain} cambiado a este servidor`, 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const copiarTodo = async () => {
    setCopiando(true);
    try {
      const texto = await cambioDominioApi.ficheroDeZona(projectId, m.id);
      if (!(await copyToClipboard(texto))) throw new Error('No se han podido copiar los registros: descarga el fichero de zona.');
      toast('Registros copiados', 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'No se han podido copiar los registros.', 'err');
    } finally {
      setCopiando(false);
    }
  };

  const sinTls = nuevos.length > 0 && nuevos.every((h) => h.certificado === 'sin_tls');
  const otroProveedor = !!correo?.hacia.recibeEnOtroProveedor;
  const sinDesplegar = m.servicios.some((s) => s.estado !== 'ok');
  const redirige = m.hosts.some((h) => h.modo === 'redirigir');
  const reinicios = (m.alPasar ?? []).filter((s) => s.reinicio);
  // Solo por usar la dirección de otro servicio que cambia de nombre (`${{api.PUBLIC_URL}}`).
  const porReferencias = (m.alPasar ?? []).filter((s) => s.motivos.length > 0 && s.motivos.every((x) => x === 'referencias'));
  const variables = (m.variables?.cambios ?? []).filter((c) => !c.excluida);
  // Tras un «Volver», quien ya había actualizado sus dispositivos entra con su
  // usuario del dominio nuevo; al cancelar, Mailway le devuelve el anterior.
  const conUsuarioNuevo = (correo?.buzones.lista ?? []).filter((b) => b.pendiente && b.login.toLowerCase().endsWith(`@${m.toDomain}`));
  const appsAlCancelar = conUsuarioNuevo.filter((b) => b.usadoPorApps.some((n) => n.startsWith('skyway:')));

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm leading-6 text-sub">
        Mientras preparas <span className="font-medium text-txt">{m.toDomain}</span>, la web y el correo siguen funcionando en{' '}
        {m.fromDomain}. No se despliega nada hasta pasar.
      </p>
      {m.error && <Aviso tono="err">{m.error}</Aviso>}

      <Bloque
        titulo="Registros DNS"
        acciones={
          <>
            <Button variant="secondary" size="sm" onClick={copiarTodo} loading={copiando}>
              Copiar todo
            </Button>
            <a
              href={cambioDominioApi.ficheroDeZonaUrl(projectId, m.id)}
              download
              className="press inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 text-xs font-medium text-txt hover:border-line2 hover:bg-surface3"
            >
              <Download size={13} aria-hidden /> Descargar fichero de zona
            </a>
          </>
        }
      >
        <ul className="rounded-lg border border-line bg-bg px-3.5 py-1.5">
          {nuevos.map((h) => (
            <li key={h.to} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5">
              <span className="min-w-0">
                <span className="block break-all font-mono text-sm text-txt">{h.to}</span>
                <span className="block text-xs text-subtle">
                  {m.ipServidor ? `Registro A → ${m.ipServidor}, sin proxy` : 'Registro A hacia la IP de este servidor, sin proxy'}
                </span>
                {/* Sin comprobar: por qué (el proxy de Cloudflare, un DNS que no responde) y qué hacer. */}
                {h.dns === 'desconocido' && h.detalle && <span className="mt-0.5 block text-xs text-sub">{h.detalle}</span>}
              </span>
              <Chip tone={DNS_CHIP[h.dns].tone} size="sm" dot>
                {DNS_CHIP[h.dns].label}
              </Chip>
            </li>
          ))}
          {correo && (
            <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5">
              <span className="min-w-0 text-sm text-sub">
                Correo de <span className="font-mono text-txt">{m.toDomain}</span> (MX, SPF, DKIM y verificación)
              </span>
              <Chip tone={correo.compuertas.find((c) => c.id === 'dns')?.ok ? 'ok' : 'warn'} size="sm" dot>
                {correo.compuertas.find((c) => c.id === 'dns')?.ok ? 'Completo' : 'Pendiente'}
              </Chip>
            </li>
          )}
          {nuevos.length === 0 && !correo && <li className="py-1.5 text-sm text-subtle">No hay registros que crear.</li>}
        </ul>
        <p className="mt-1.5 text-xs leading-5 text-subtle">
          {correo?.hacia.cloudflare
            ? 'Registros del correo creados en Cloudflare. '
            : 'Añade estos registros en tu proveedor de DNS: el fichero de zona los incluye todos. '}
          {nuevos.length > 0 && 'Los registros de la web van comentados: quita antes el registro anterior de cada nombre, si lo hay.'}
        </p>
        {otroProveedor && correo && (
          <Aviso tono="warn" className="mt-2">
            <p>
              {m.toDomain} recibe ahora el correo en otro proveedor. Cuando veas «{m.toDomain} ya recibe en los buzones», cambia el MX a este
              servidor
              {correo.hacia.cloudflare
                ? '.'
                : ': en el fichero de zona va comentado, porque importarlo lo añadiría al actual en vez de sustituirlo.'}
            </p>
            {correo.hacia.cloudflare && (
              <div className="mt-2">
                <Button variant="secondary" size="sm" onClick={() => setMxAbierto(true)} disabled={!correo.recepcionPreparada}>
                  Cambiar el MX a este servidor
                </Button>
              </div>
            )}
          </Aviso>
        )}
      </Bloque>

      {nuevos.length > 0 && (
        <Bloque titulo="Certificados">
          <ul>
            {sinTls ? (
              <Condicion estado="ok" titulo="TLS no está activo en este servidor: no hay certificados que esperar." />
            ) : (
              nuevos.map((h) => (
                <Condicion
                  key={h.to}
                  estado={h.certificado === 'ok' ? 'ok' : h.certificado === 'desconocido' ? 'aviso' : 'pendiente'}
                  titulo={
                    h.certificado === 'ok'
                      ? `Certificado listo para ${h.to}`
                      : h.dns !== 'ok'
                        ? `Esperando al DNS de ${h.to}`
                        : h.certificado === 'desconocido'
                          ? `No se ha podido comprobar el certificado de ${h.to}`
                          : `Esperando el certificado de ${h.to}`
                  }
                  detalle={
                    h.certificado === 'desconocido'
                      ? 'No impide pasar.'
                      : h.dns === 'ok' && h.certificado === 'pendiente' && h.detalle
                        ? h.detalle
                        : undefined
                  }
                />
              ))
            )}
          </ul>
        </Bloque>
      )}

      {conCorreo && !correo && (
        <Bloque titulo="Correo">
          <ul>
            {m.compuertas
              .filter((c) => c.id === 'correo')
              .map((c) => (
                <Condicion key={c.id} estado={c.ok ? 'ok' : 'pendiente'} titulo={c.titulo} detalle={c.detalle || undefined} />
              ))}
          </ul>
        </Bloque>
      )}

      {correo && (
        <Bloque titulo="Correo">
          <ul>
            {correo.compuertas.map((c) => (
              <Condicion key={c.id} estado={c.ok ? 'ok' : c.bloquea ? 'pendiente' : 'aviso'} titulo={c.titulo} detalle={c.ok ? undefined : c.detalle || undefined} />
            ))}
          </ul>
          {correo.error && <Aviso tono="err" className="mt-2">{correo.error}</Aviso>}
        </Bloque>
      )}

      <AvisosWebhooks
        webhooks={m.webhooks}
        onServir={(w) => servir.mutate(w)}
        ocupado={servir.isPending ? (servir.variables?.serviceId ?? null) : null}
      />

      {sinDesplegar && <ServiciosCambio projectId={projectId} m={m} onCambio={onCambio} accion="cancelar el cambio" />}

      <Avisos tono="info" avisos={m.avisos} />

      <div className="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
          <span className="whitespace-nowrap">Se comprueba cada 30 segundos.</span>
          <Button variant="ghost" size="sm" onClick={onComprobar} loading={comprobando}>
            {!comprobando && <RefreshCw size={12} aria-hidden />} Comprobar ahora
          </Button>
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button variant="ghost" onClick={() => setCancelarAbierto(true)} disabled={!m.puedeCancelar} className="max-sm:h-11">
            Cancelar el cambio
          </Button>
          <Button onClick={() => setPasarAbierto(true)} disabled={!m.puedePasar || !m.variables} className="max-sm:h-11">
            Pasar a {m.toDomain}
          </Button>
        </div>
      </div>

      <Modal open={pasarAbierto} onClose={() => setPasarAbierto(false)} title={`Pasar a ${m.toDomain}`}>
        <div className="flex flex-col gap-2.5 text-sm leading-6 text-sub">
          <p>
            {nuevos.length > 0
              ? `Al pasar, la web se sirve en ${m.toDomain}${redirige ? ` y ${m.fromDomain} redirige a ella conservando la ruta` : ''}${conCorreo ? `; el correo sale como @${m.toDomain}` : ''}.`
              : `Al pasar, el correo sale como @${m.toDomain}. Lo que llegue a @${m.fromDomain} sigue entrando en los mismos buzones.`}
          </p>
          {(m.alPasar?.length ?? 0) > 0 && (
            <p>
              Se {m.alPasar!.length === 1 ? 'volverá' : 'volverán'} a desplegar {contar(m.alPasar!.length, 'servicio', 'servicios')}:{' '}
              {m.alPasar!.map((s) => s.nombre).join(', ')}.
            </p>
          )}
          {porReferencias.map((s) => (
            <p key={s.serviceId} className="text-xs leading-5 text-subtle">
              «{s.nombre}» se vuelve a desplegar porque usa la dirección de un servicio que cambia de nombre.
            </p>
          ))}
          {reinicios.length > 0 && (
            <p>
              Los servicios que se despliegan con una sola copia ({reinicios.map((s) => s.nombre).join(', ')}) se detienen antes de arrancar la
              versión nueva: unos segundos sin servicio.
            </p>
          )}
          {m.webhooks.length > 0 && (
            <p className="text-xs leading-5 text-subtle">
              {enumerar(m.webhooks.map((w) => `«${w.serviceName}»`))} {m.webhooks.length === 1 ? 'recibe' : 'reciben'} webhooks en nombres que
              van a redirigir: vuelve a registrarlos con la URL nueva después de pasar.
            </p>
          )}
          {redirige && <p>Durante 7 días la redirección es temporal; después pasa a ser permanente.</p>}
          {variables.length > 0 && (
            <p className="text-xs leading-5 text-subtle">
              Cambian {contar(variables.length, 'variable', 'variables')}: {[...new Set(variables.map((c) => c.key))].join(', ')}.
            </p>
          )}
          {(m.variables?.wordpress ?? []).map((w) => (
            <p key={w.serviceId} className="text-xs leading-5 text-subtle">
              WordPress ({w.serviceName}) pasa a usar la URL {w.url}.
            </p>
          ))}
          {correo && correo.buzones.lista.length > 0 && (
            <p className="text-xs leading-5 text-subtle">
              Las personas siguen entrando con su usuario de {m.fromDomain} hasta que actualicen sus dispositivos. La contraseña no cambia.
            </p>
          )}
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={() => setPasarAbierto(false)}>
            Cancelar
          </Button>
          <Button onClick={() => pasar.mutate()} loading={pasar.isPending}>
            Pasar ahora
          </Button>
        </div>
      </Modal>

      <ConfirmModal
        open={mxAbierto}
        onClose={() => setMxAbierto(false)}
        onConfirm={() => mx.mutate()}
        loading={mx.isPending}
        title="Cambiar el MX a este servidor"
        message={`El correo de ${m.toDomain} dejará de llegar a su proveedor actual y entrará en estos buzones.`}
        confirmLabel="Cambiar el MX"
        confirmVariant="primary"
      />

      <ConfirmModal
        open={cancelarAbierto}
        onClose={() => setCancelarAbierto(false)}
        onConfirm={() => cancelar.mutate()}
        loading={cancelar.isPending}
        title="Cancelar el cambio de dominio"
        message={
          nuevos.length > 0
            ? `Se dejarán de preparar los nombres de ${m.toDomain}. La web sigue en ${m.fromDomain} sin cambios.`
            : `Se deja de preparar ${m.toDomain}.`
        }
        confirmLabel="Cancelar el cambio"
      >
        {correo && (
          <p className="mt-2 text-sm text-sub">
            Se quitarán las direcciones de {m.toDomain} de los buzones y alias. {m.fromDomain} sigue igual.
          </p>
        )}
        {conUsuarioNuevo.length > 0 && (
          <p className="mt-2 text-sm text-sub">
            {conUsuarioNuevo.length === 1
              ? `${conUsuarioNuevo[0].email} entra ahora con ${conUsuarioNuevo[0].login}: volverá a entrar con su dirección, y sus dispositivos configurados con ${conUsuarioNuevo[0].login} dejarán de conectar hasta que se actualicen.`
              : `${conUsuarioNuevo.length} personas entran ahora con su usuario de ${m.toDomain}: volverán a entrar con su dirección de ${m.fromDomain}, y sus dispositivos configurados con el de ${m.toDomain} dejarán de conectar hasta que se actualicen.`}{' '}
            La contraseña no cambia.
            {appsAlCancelar.length > 0 &&
              ` Las aplicaciones que envían con ${appsAlCancelar.length === 1 ? appsAlCancelar[0].email : 'esos buzones'} pasarán a usar su usuario de ${m.fromDomain}: se desplegará la versión que ya está en marcha y no podrán enviar durante unos segundos.`}
          </p>
        )}
      </ConfirmModal>
    </div>
  );
}
