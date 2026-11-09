import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, CircleAlert, FileText, History, Info, KeyRound, PlugZap, Send, Server, ShieldCheck, Stamp, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { api } from '../api';
import {
  EntornoVerifactu,
  EstadoRemision,
  ModoVerifactu,
  ResultadoEnvioVerifactu,
  VerifactuAjustes,
  VerifactuCertificado,
  VerifactuEnvio,
  VerifactuFactura,
  VerifactuRegistro,
  VerifactuVista,
} from '../types';
import { cx, fmtBytes, fmtDate, fmtDateTime, fmtMoney, timeAgo, Tone } from '../utils';
import { Button, Chip, ConfirmModal, CopyButton, EmptyState, ErrorState, Field, Segmented, Skeleton, StatusBadge, useToast } from './ui';

/*
 * VERI*FACTU (RD 1007/2023) en el panel: la sección de Contabilidad y las
 * piezas que enseñan el estado del registro de cada factura en las listas.
 * Todas las rutas que usa exigen administrador.
 */

/** El servidor no acepta certificados mayores: se avisa antes de leer el fichero. */
const MAX_BYTES_PFX = 64 * 1024;

const ENTORNO_LABEL: Record<EntornoVerifactu, string> = { pruebas: 'pruebas', produccion: 'producción' };

/**
 * «incorrecto» es el término de la AEAT; en el panel se dice «rechazado», que
 * es lo que significa y lo que dicen las alertas.
 */
const ESTADO_REMISION: Record<EstadoRemision, { label: string; corto: string; plural: string; tone: Tone }> = {
  pendiente: { label: 'Pendiente', corto: 'pendiente', plural: 'Pendientes', tone: 'info' },
  correcto: { label: 'Correcto', corto: 'correcto', plural: 'Correctos', tone: 'ok' },
  aceptado_con_errores: { label: 'Aceptado con errores', corto: 'con errores', plural: 'Con errores', tone: 'warn' },
  incorrecto: { label: 'Rechazado', corto: 'rechazado', plural: 'Rechazados', tone: 'err' },
};
const ESTADOS: EstadoRemision[] = ['pendiente', 'correcto', 'aceptado_con_errores', 'incorrecto'];

const RESULTADO_ENVIO: Record<ResultadoEnvioVerifactu, { label: string; tone: Tone }> = {
  correcto: { label: 'Correcto', tone: 'ok' },
  parcial: { label: 'Parcialmente correcto', tone: 'warn' },
  incorrecto: { label: 'Incorrecto', tone: 'err' },
  rechazado: { label: 'Envío rechazado', tone: 'err' },
  fallo: { label: 'Fallo de comunicación', tone: 'err' },
};

const EVENTO: Record<string, { label: string; tone: Tone }> = {
  activacion: { label: 'Activación de VERI*FACTU', tone: 'info' },
  desactivacion: { label: 'Desactivación de VERI*FACTU', tone: 'warn' },
  cambio_entorno: { label: 'Cambio de entorno', tone: 'info' },
  cambio_productor: { label: 'Cambio del productor del sistema', tone: 'neutral' },
  certificado_cargado: { label: 'Certificado cargado', tone: 'neutral' },
  certificado_retirado: { label: 'Certificado retirado', tone: 'warn' },
  envio_correcto: { label: 'Envío correcto', tone: 'ok' },
  envio_con_errores: { label: 'Envío con errores', tone: 'warn' },
  envio_rechazado: { label: 'Envío rechazado', tone: 'err' },
  error_conexion: { label: 'Error de conexión', tone: 'err' },
  subsanacion: { label: 'Subsanación', tone: 'info' },
};

/**
 * `incidencia` (registros sin remitir) lleva el tono más visible y va siempre
 * el primero: la Orden HAC/1177/2024 (art. 16.4) exige que el aviso se vea
 * mientras quede algún registro por remitir.
 */
const AVISO_TONO: Record<string, 'err' | 'warn' | 'info'> = { incidencia: 'err', certificado_caducado: 'err', entorno_pruebas: 'info' };
/* Clases completas por caso: añadir encima otras de la misma propiedad no sirve,
   porque gana la que va después en el CSS y no la que va después en el atributo. */
const AVISO_CLASE = {
  incidencia: 'border-err/50 bg-err/[.12] py-2.5 font-medium text-err',
  err: 'border-err/30 bg-err/[.08] py-2 text-err',
  warn: 'border-warn/30 bg-warn/[.08] py-2 text-warn',
  info: 'border-acc/30 bg-acc/[.08] py-2 text-acc-soft',
};

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/** Las esperas de la cola no pasan de una hora: con la hora basta. */
const hora = (ts: number) => new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });

/** «[1100] Descripción», con lo que haya de cada parte. */
function textoError(codigo: string | null, descripcion: string | null): string | null {
  const partes = [codigo ? `[${codigo}]` : '', descripcion ?? ''].filter(Boolean);
  return partes.length ? partes.join(' ') : null;
}

/** Nombre común (CN) de un asunto X.509 escrito en una línea; el asunto entero si no lo trae. */
function nombreComun(asunto: string): string {
  const m = /(?:^|,\s*)CN=([^,]+)/.exec(asunto);
  return m ? m[1].trim() : asunto;
}

const pendientesTotales = (v: VerifactuVista | undefined) =>
  (v?.cola.recuento ?? []).reduce((s, r) => s + (r.estado_remision === 'pendiente' ? r.n : 0), 0);

/** Generar un registro cambia la sección y las dos listas de facturas que enseñan su estado. */
function invalidarRegistros(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ['verifactu'] });
  queryClient.invalidateQueries({ queryKey: ['accounting-invoices'] });
  queryClient.invalidateQueries({ queryKey: ['ws-invoices'] });
}

// ---------- Piezas para las listas de facturas ----------

/**
 * Estado de VERI*FACTU de una factura en una lista. El texto dice el estado
 * (el color solo lo refuerza) y nombra el entorno de pruebas, porque un
 * «correcto» allí no tiene efectos fiscales.
 */
export function VerifactuMarca({ v, className }: { v: VerifactuFactura; className?: string }) {
  const estado = ESTADO_REMISION[v.estado];
  const titulo = [
    `Registro de ${v.tipo === 'alta' ? 'alta' : 'anulación'} en el entorno de ${ENTORNO_LABEL[v.entorno]}: ${estado.label.toLowerCase()}`,
    v.csv ? `CSV ${v.csv}` : null,
    textoError(v.codigoError, v.descripcionError),
  ]
    .filter(Boolean)
    .join(' · ');
  // Tope del ancho de su columna y texto recortable: en una fila estrecha, junto
  // al importe, la marca no debe salirse ni empujar lo demás.
  return (
    <Chip size="sm" tone={estado.tone} dot pulse={v.estado === 'pendiente'} title={titulo} className={cx('max-w-full', className)}>
      <span className="min-w-0 truncate">
        VERI*FACTU · {estado.corto}
        {v.entorno === 'pruebas' ? ' (pruebas)' : ''}
      </span>
    </Chip>
  );
}

/**
 * Subsana el último registro de una factura (o repite su anulación rechazada).
 * Se confirma antes: genera un registro nuevo e inmutable en la cadena, y
 * conviene recordar que no corrige los datos de la factura emitida.
 */
export function SubsanarBoton({
  invoiceId,
  numero,
  accion,
}: {
  invoiceId: string;
  numero: string | null;
  accion: 'subsanar' | 'repetir_anulacion';
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [abierto, setAbierto] = useState(false);
  const repetir = accion === 'repetir_anulacion';
  const factura = numero ? `la factura ${numero}` : 'la factura';
  const subsanar = useMutation({
    mutationFn: () => api.post<{ ok: true }>(`/invoices/${invoiceId}/verifactu/subsanar`),
    onSuccess: () => {
      setAbierto(false);
      toast(repetir ? 'Registro de anulación generado de nuevo' : 'Registro de subsanación generado', 'ok');
      invalidarRegistros(queryClient);
    },
    // 409: el registro ya no admite subsanación (otra pestaña se adelantó, por ejemplo).
    onError: (err: Error) => {
      setAbierto(false);
      toast(err.message, 'err');
      invalidarRegistros(queryClient);
    },
  });
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setAbierto(true)}>
        {repetir ? 'Repetir anulación' : 'Subsanar'}
      </Button>
      <ConfirmModal
        open={abierto}
        onClose={() => setAbierto(false)}
        onConfirm={() => subsanar.mutate()}
        loading={subsanar.isPending}
        title={repetir ? 'Repetir la anulación' : 'Subsanar el registro'}
        message={
          repetir
            ? `Se generará de nuevo el registro de anulación de ${factura} y se remitirá a la AEAT.`
            : `Se generará un registro de subsanación de ${factura}, con sus datos actuales, y se remitirá a la AEAT. Si el error está en los datos de la factura emitida, la subsanación no lo corrige: en ese caso, emite una factura rectificativa.`
        }
        confirmLabel={repetir ? 'Repetir anulación' : 'Subsanar'}
        confirmVariant="primary"
      />
    </>
  );
}

/**
 * Error de la AEAT en el último registro de una factura y, si lo admite, el
 * botón para subsanarlo. No pinta nada mientras el registro esté bien.
 */
export function VerifactuIncidencia({
  invoiceId,
  numero,
  v,
  className,
}: {
  invoiceId: string;
  numero: string | null;
  v: VerifactuFactura;
  className?: string;
}) {
  const error = textoError(v.codigoError, v.descripcionError);
  if (!error && !v.accion) return null;
  const rechazado = v.estado === 'incorrecto';
  const registro = v.tipo === 'alta' ? 'el registro de alta' : 'el registro de anulación';
  return (
    <div
      className={cx(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2',
        rechazado ? 'border-err/30 bg-err/[.06]' : 'border-warn/30 bg-warn/[.06]',
        className,
      )}
    >
      {/* Base propia: en móvil el botón baja de línea en vez de estrechar el texto. */}
      <p className="min-w-0 grow basis-56 text-xs leading-5">
        <span className={cx('font-medium', rechazado ? 'text-err' : 'text-warn')}>
          {rechazado ? `La AEAT ha rechazado ${registro}.` : `La AEAT ha aceptado ${registro} con errores.`}
        </span>
        {error && <span className="break-words text-sub"> {error}</span>}
      </p>
      {v.accion && <SubsanarBoton invoiceId={invoiceId} numero={numero} accion={v.accion} />}
    </div>
  );
}

// ---------- Sección de Contabilidad ----------

/** Modo, entorno, certificado, cola, registros, sistema, declaración responsable y eventos. */
export default function VerifactuSettings() {
  const q = useQuery({
    queryKey: ['verifactu'],
    queryFn: () => api.get<VerifactuVista>('/verifactu'),
    // La cola se procesa en segundo plano cada 10 s: mientras haya registros por
    // remitir, la sección se refresca al mismo ritmo para enseñar el resultado.
    refetchInterval: (query) => (pendientesTotales(query.state.data) > 0 ? 10_000 : false),
  });

  if (q.isLoading) return <Skeleton className="h-96 w-full" />;
  if (!q.data) {
    return (
      <section className="card">
        <ErrorState title="No se ha podido cargar el estado de VERI*FACTU" error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} />
      </section>
    );
  }

  const vista = q.data;
  const activo = vista.modo === 'verifactu';
  const produccion = vista.ajustes.entorno === 'produccion';
  const a = vista.ajustes;
  // El servidor ya lo pone el primero; se asegura aquí porque es un requisito.
  const avisos = [...vista.avisos.filter((x) => x.tipo === 'incidencia'), ...vista.avisos.filter((x) => x.tipo !== 'incidencia')];
  // El formulario del productor se reinicia cuando cambian los datos guardados,
  // no en cada refresco de la cola: así no se pierde lo que se está escribiendo.
  const claveDatos = JSON.stringify([a.productorNombre, a.productorNif, a.productorDireccion, a.declaracionLugar, a.declaracionFecha]);

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <ShieldCheck size={15} className="text-acc-soft" /> VERI*FACTU
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-subtle">
            Sistema de emisión de facturas verificables (Real Decreto 1007/2023). Con VERI*FACTU activo, cada factura que se emite o se anula genera un
            registro de facturación encadenado que se remite a la AEAT, y el PDF de la factura incluye el código QR tributario.
          </p>
        </div>
        <StatusBadge
          pill
          tone={activo ? (produccion ? 'ok' : 'info') : 'neutral'}
          label={activo ? `Activo · ${produccion ? 'producción' : 'pruebas'}` : 'Desactivado'}
        />
      </div>

      {avisos.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2" aria-label="Avisos de VERI*FACTU">
          {avisos.map((aviso, i) => {
            const incidencia = aviso.tipo === 'incidencia';
            const tono = AVISO_TONO[aviso.tipo] ?? 'warn';
            const Icono = tono === 'info' ? Info : tono === 'err' ? CircleAlert : TriangleAlert;
            return (
              <li
                key={`${aviso.tipo}-${i}`}
                className={cx('flex items-start gap-2 rounded-lg border px-3 text-xs leading-5', AVISO_CLASE[incidencia ? 'incidencia' : tono])}
              >
                <Icono size={incidencia ? 14 : 13} className="mt-[3px] shrink-0" aria-hidden />
                <span className={cx('min-w-0 break-words', tono === 'info' && 'text-sub')}>{aviso.texto}</span>
              </li>
            );
          })}
        </ul>
      )}

      <ModoYEntorno vista={vista} />

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Certificado vista={vista} />
        <ColaRemision vista={vista} />
      </div>

      <Registros vista={vista} />

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <ProductorYDeclaracion key={claveDatos} vista={vista} />
        <div className="flex min-w-0 flex-col gap-4">
          <SistemaInformatico vista={vista} />
          <RegistroEventos vista={vista} />
        </div>
      </div>
    </section>
  );
}

/**
 * Modo y entorno se aplican al momento. Activar y pasar a producción se
 * confirman: en producción, en cuanto se remite un registro, la modalidad ya
 * no se puede abandonar hasta que acabe el año natural.
 */
function ModoYEntorno({ vista }: { vista: VerifactuVista }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [confirmar, setConfirmar] = useState<'activar' | 'produccion' | null>(null);
  const entorno = vista.ajustes.entorno;
  const activo = vista.modo === 'verifactu';

  const cambiar = useMutation({
    mutationFn: (cambio: { modo?: ModoVerifactu; entorno?: EntornoVerifactu }) => api.put<VerifactuVista>('/verifactu', cambio),
    onSuccess: (nueva, cambio) => {
      queryClient.setQueryData(['verifactu'], nueva);
      toast(
        cambio.modo === 'verifactu'
          ? 'VERI*FACTU activado'
          : cambio.modo === 'desactivado'
            ? 'VERI*FACTU desactivado'
            : cambio.entorno === 'produccion'
              ? 'Entorno de producción seleccionado'
              : 'Entorno de pruebas seleccionado',
        'ok',
      );
    },
    // 409: el cambio no está permitido (falta el NIF del emisor, ya se ha
    // remitido a producción este año…). El motivo lo explica el servidor.
    onError: (err: Error) => toast(err.message, 'err'),
    onSettled: () => setConfirmar(null),
  });

  const elegirModo = (m: ModoVerifactu) => {
    if (m === vista.modo || cambiar.isPending) return;
    if (m === 'verifactu') setConfirmar('activar');
    else cambiar.mutate({ modo: 'desactivado' });
  };
  const elegirEntorno = (e: EntornoVerifactu) => {
    if (e === entorno || cambiar.isPending) return;
    if (e === 'produccion') setConfirmar('produccion');
    else cambiar.mutate({ entorno: 'pruebas' });
  };

  return (
    <div className="mt-4 grid gap-4 rounded-xl border border-line p-4 md:grid-cols-2">
      <div className="min-w-0">
        <p className="text-sm font-medium">Modo</p>
        <Segmented<ModoVerifactu>
          label="Modo de VERI*FACTU"
          className={cx('mt-2', cambiar.isPending && 'pointer-events-none opacity-60')}
          value={vista.modo}
          onChange={elegirModo}
          options={[
            { key: 'desactivado', label: 'Desactivado' },
            { key: 'verifactu', label: 'VERI*FACTU' },
          ]}
        />
        <p className="mt-2 text-xs leading-5 text-subtle">
          {activo
            ? 'Cada factura que se emite o se anula genera un registro de facturación encadenado con huella, que se remite a la AEAT. El PDF de la factura incluye el código QR tributario y la leyenda «VERI*FACTU».'
            : 'Las facturas se emiten sin registro de facturación y no se remite nada a la AEAT. Solo es válido mientras el reglamento no sea obligatorio para la empresa.'}
        </p>
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium">Entorno de la AEAT</p>
        <Segmented<EntornoVerifactu>
          label="Entorno de la AEAT"
          className={cx('mt-2', cambiar.isPending && 'pointer-events-none opacity-60')}
          value={entorno}
          onChange={elegirEntorno}
          options={[
            { key: 'pruebas', label: 'Pruebas' },
            { key: 'produccion', label: 'Producción' },
          ]}
        />
        <p className="mt-2 text-xs leading-5 text-subtle">
          {entorno === 'produccion'
            ? 'Entorno real de la AEAT, con efectos fiscales. Una vez remitidos registros, VERI*FACTU no se puede desactivar hasta el final del año natural.'
            : 'Entorno de pruebas de la AEAT: sirve para comprobar la configuración y no tiene efectos fiscales.'}
        </p>
        <p className="mt-1 break-all font-mono text-micro text-subtle" title="Servicio de remisión de la AEAT">
          {vista.servicio}
        </p>
      </div>

      <ConfirmModal
        open={confirmar === 'activar'}
        onClose={() => setConfirmar(null)}
        onConfirm={() => cambiar.mutate({ modo: 'verifactu' })}
        loading={cambiar.isPending}
        title="Activar VERI*FACTU"
        message={
          entorno === 'produccion'
            ? 'A partir de ahora, cada factura que se emita o se anule generará un registro de facturación que se remitirá al entorno de producción de la AEAT, con efectos fiscales. Una vez remitidos registros a producción, VERI*FACTU no se podrá desactivar hasta el final del año natural.'
            : 'A partir de ahora, cada factura que se emita o se anule generará un registro de facturación que se remitirá al entorno de pruebas de la AEAT, sin efectos fiscales.'
        }
        confirmLabel="Activar VERI*FACTU"
        confirmVariant="primary"
      >
        {!vista.certificado && (
          <p className="mt-3 text-xs leading-5 text-warn">
            Todavía no hay certificado electrónico: los registros se generarán, pero quedarán en cola hasta que se cargue.
          </p>
        )}
      </ConfirmModal>

      <ConfirmModal
        open={confirmar === 'produccion'}
        onClose={() => setConfirmar(null)}
        onConfirm={() => cambiar.mutate({ entorno: 'produccion' })}
        loading={cambiar.isPending}
        title="Pasar a producción"
        message="Los registros nuevos se remitirán al entorno de producción de la AEAT, con efectos fiscales. Una vez remitidos registros a producción, VERI*FACTU no se podrá desactivar hasta el final del año natural. Los registros ya generados conservan su entorno."
        confirmLabel="Pasar a producción"
        confirmVariant="primary"
      >
        {!activo && (
          <p className="mt-3 text-xs leading-5 text-sub">
            VERI*FACTU está desactivado: el entorno se aplicará a los registros que se generen cuando se active.
          </p>
        )}
      </ConfirmModal>
    </div>
  );
}

/** Lee el fichero como base64, sin el prefijo `data:…;base64,` que añade el navegador. */
function leerBase64(fichero: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => {
      const url = typeof lector.result === 'string' ? lector.result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    lector.onerror = () => reject(new Error('No se ha podido leer el fichero del certificado.'));
    lector.readAsDataURL(fichero);
  });
}

function Certificado({ vista }: { vista: VerifactuVista }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [sustituir, setSustituir] = useState(false);
  const [quitar, setQuitar] = useState(false);
  const [prueba, setPrueba] = useState<{ ok: boolean; detalle: string } | null>(null);
  const cert = vista.certificado;
  const entorno = vista.ajustes.entorno;

  const probar = useMutation({
    mutationFn: () => api.post<{ ok: boolean; detalle: string }>('/verifactu/probar', { entorno }),
    onMutate: () => setPrueba(null),
    onSuccess: (r) => setPrueba(r),
    onError: (err: Error) => setPrueba({ ok: false, detalle: err.message }),
  });
  const retirar = useMutation({
    mutationFn: () => api.del<{ ok: true }>('/verifactu/certificado'),
    onSuccess: () => {
      setQuitar(false);
      setSustituir(false);
      setPrueba(null);
      toast('Certificado retirado', 'ok');
      queryClient.invalidateQueries({ queryKey: ['verifactu'] });
    },
    onError: (err: Error) => {
      setQuitar(false);
      toast(err.message, 'err');
    },
  });

  return (
    <div className="min-w-0 rounded-xl border border-line p-4">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <KeyRound size={14} className="text-subtle" /> Certificado electrónico
      </h3>
      <p className="mt-1 text-xs leading-5 text-subtle">
        Identifica a Skyway ante la AEAT al remitir los registros. Debe ser del emisor o de un apoderado o colaborador social suyo. El fichero y la
        contraseña se guardan en el servidor y no se vuelven a mostrar.
      </p>

      {cert ? (
        <>
          <DatosCertificado cert={cert} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => probar.mutate()}
              loading={probar.isPending}
              title={`Comprueba la conexión con el entorno de ${ENTORNO_LABEL[entorno]} de la AEAT sin enviar registros`}
            >
              <PlugZap size={13} /> Probar conexión
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSustituir((v) => !v)} aria-expanded={sustituir}>
              <Upload size={13} /> Sustituir
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setQuitar(true)} className="text-err hover:bg-err/[.1]">
              <Trash2 size={13} /> Quitar
            </Button>
          </div>
          {prueba && (
            <p
              role={prueba.ok ? 'status' : 'alert'}
              className={cx(
                'mt-3 break-words rounded-lg border px-3 py-2 text-xs leading-5',
                prueba.ok ? 'border-ok/30 bg-ok/[.08] text-ok' : 'border-err/30 bg-err/[.08] text-err',
              )}
            >
              {prueba.detalle}
            </p>
          )}
          {sustituir && (
            <FormularioCertificado
              onCargado={() => {
                setSustituir(false);
                setPrueba(null);
              }}
            />
          )}
        </>
      ) : (
        <FormularioCertificado />
      )}

      <ConfirmModal
        open={quitar}
        onClose={() => setQuitar(false)}
        onConfirm={() => retirar.mutate()}
        loading={retirar.isPending}
        title="Quitar el certificado"
        message="Se eliminarán del servidor el certificado y su contraseña. Mientras no se cargue otro, los registros de facturación se seguirán generando, pero quedarán en cola sin remitirse a la AEAT."
        confirmLabel="Quitar certificado"
      />
    </div>
  );
}

function DatosCertificado({ cert }: { cert: VerifactuCertificado }) {
  const dias = Math.floor((cert.validoHasta - Date.now()) / 86_400_000);
  const caducado = dias < 0;
  const caducaPronto = !caducado && dias <= 30;
  return (
    <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
      <dt className="text-subtle">Titular</dt>
      <dd className="break-words" title={cert.titular}>
        {nombreComun(cert.titular)}
      </dd>
      <dt className="text-subtle">NIF</dt>
      <dd className={cert.nif ? 'font-mono' : 'text-subtle'}>{cert.nif ?? 'No figura en el certificado'}</dd>
      {cert.sello && (
        <>
          <dt className="text-subtle">Tipo</dt>
          <dd className="text-sub">Certificado de sello electrónico</dd>
        </>
      )}
      <dt className="text-subtle">Caducidad</dt>
      <dd className={cx('flex items-start gap-1', caducado ? 'font-medium text-err' : caducaPronto ? 'font-medium text-warn' : 'text-sub')}>
        {(caducado || caducaPronto) && <TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden />}
        <span>
          {caducado
            ? `Caducó el ${fmtDate(cert.validoHasta)}`
            : `${fmtDate(cert.validoHasta)} · ${dias === 0 ? 'caduca hoy' : `quedan ${plural(dias, 'día', 'días')}`}`}
        </span>
      </dd>
      <dt className="text-subtle">Emisor</dt>
      <dd className="break-words text-sub" title={cert.emisor}>
        {nombreComun(cert.emisor)}
      </dd>
      <dt className="text-subtle">Huella SHA-256</dt>
      <dd className="break-all font-mono text-micro text-sub">{cert.huellaSha256}</dd>
      <dt className="text-subtle">Cargado</dt>
      <dd className="text-sub">
        {fmtDate(cert.cargadoAt)} ({timeAgo(cert.cargadoAt)})
      </dd>
    </dl>
  );
}

function FormularioCertificado({ onCargado }: { onCargado?: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const entrada = useRef<HTMLInputElement>(null);
  const [fichero, setFichero] = useState<File | null>(null);
  const [contrasena, setContrasena] = useState('');
  const [error, setError] = useState<string | null>(null);

  const cargar = useMutation({
    mutationFn: async (f: File) => api.post<{ certificado: VerifactuCertificado }>('/verifactu/certificado', { pfx: await leerBase64(f), password: contrasena }),
    onSuccess: () => {
      setFichero(null);
      setContrasena('');
      setError(null);
      if (entrada.current) entrada.current.value = '';
      toast('Certificado cargado', 'ok');
      queryClient.invalidateQueries({ queryKey: ['verifactu'] });
      onCargado?.();
    },
    // Contraseña incorrecta, fichero no válido, caducado o con cifrado antiguo:
    // el mensaje dice cómo resolverlo y es largo para un aviso que se cierra solo.
    onError: (err: Error) => setError(err.message),
  });

  const elegir = (f: File | undefined) => {
    setError(null);
    const motivo = !f ? null : f.size === 0 ? 'El fichero está vacío.' : f.size > MAX_BYTES_PFX ? 'El fichero supera los 64 KB: no parece un certificado .pfx o .p12.' : null;
    if (motivo) {
      setError(motivo);
      // Sin vaciar el campo, volver a elegir el mismo fichero no avisaría del cambio.
      if (entrada.current) entrada.current.value = '';
    }
    setFichero(f && !motivo ? f : null);
  };
  const enviar = () => {
    if (fichero && !cargar.isPending) cargar.mutate(fichero);
  };

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-lg border border-line bg-bg/40 p-3">
      <Field label="Fichero del certificado" hint="PKCS#12 (.pfx o .p12) con la clave privada, de 64 KB como máximo." group>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => entrada.current?.click()}>
            <Upload size={13} /> Seleccionar fichero
          </Button>
          <span className="min-w-0 flex-1 truncate text-xs text-sub" title={fichero?.name}>
            {fichero ? `${fichero.name} · ${fmtBytes(fichero.size)}` : 'Ningún fichero seleccionado'}
          </span>
        </div>
        <input
          ref={entrada}
          type="file"
          accept=".pfx,.p12,application/x-pkcs12"
          className="hidden"
          onChange={(e) => elegir(e.target.files?.[0])}
        />
      </Field>
      <Field label="Contraseña del certificado" hint="Si el certificado no tiene contraseña, deja el campo vacío.">
        <input
          className="input"
          type="password"
          autoComplete="off"
          value={contrasena}
          onChange={(e) => {
            setContrasena(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') enviar();
          }}
        />
      </Field>
      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-xs leading-5 text-err">
          <CircleAlert size={13} className="mt-[3px] shrink-0" aria-hidden /> <span className="min-w-0 break-words">{error}</span>
        </p>
      )}
      <div className="flex justify-end">
        <Button size="sm" onClick={enviar} loading={cargar.isPending} disabled={!fichero}>
          Cargar certificado
        </Button>
      </div>
    </div>
  );
}

/** Texto del aviso tras «Enviar ahora», según lo que haya hecho la cola. */
function mensajeEnvio(r: VerifactuEnvio['resultado']): [string, 'ok' | 'err' | 'info'] {
  if (!r.enviado) {
    switch (r.motivo) {
      case 'en_curso':
        return ['Ya hay un envío en curso. El resultado se mostrará en unos segundos.', 'info'];
      case 'sin_certificado':
        return ['No se pueden remitir los registros sin el certificado electrónico.', 'err'];
      case 'esperando':
        return ['La AEAT ha indicado un tiempo de espera entre envíos. Los registros se remitirán automáticamente cuando termine.', 'info'];
      default:
        return ['No hay registros pendientes de remitir.', 'info'];
    }
  }
  const n = r.registros ?? 0;
  const detalle = (r.error ?? '').trim().replace(/\.$/, '');
  switch (r.resultado) {
    case 'correcto':
      return [n === 1 ? 'Se ha remitido 1 registro y la AEAT lo ha aceptado.' : `Se han remitido ${n} registros y la AEAT los ha aceptado.`, 'ok'];
    case 'parcial':
      return [`Se han remitido ${plural(n, 'registro', 'registros')} y la AEAT ha rechazado o aceptado con errores alguno de ellos. Revisa la lista de registros.`, 'err'];
    case 'incorrecto':
      return [`La AEAT ha rechazado ${n === 1 ? 'el registro remitido' : `los ${n} registros remitidos`}. Revisa los errores en la lista de registros.`, 'err'];
    case 'rechazado':
      return [`La AEAT ha rechazado el envío${detalle ? `: ${detalle}` : ''}. Los registros siguen en cola.`, 'err'];
    default:
      return [`No se ha podido completar el envío${detalle ? `: ${detalle}` : ''}. Los registros siguen en cola y se reintentará automáticamente.`, 'err'];
  }
}

function ColaRemision({ vista }: { vista: VerifactuVista }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { cola, certificado } = vista;
  const entorno = vista.ajustes.entorno;
  const otro: EntornoVerifactu = entorno === 'produccion' ? 'pruebas' : 'produccion';
  const cuenta = (e: EntornoVerifactu, estado: EstadoRemision) =>
    cola.recuento.find((r) => r.entorno === e && r.estado_remision === estado)?.n ?? 0;
  const pendientesActual = cuenta(entorno, 'pendiente');
  const pendientesOtro = cuenta(otro, 'pendiente');
  const pendientes = pendientesActual + pendientesOtro;

  const enviar = useMutation({
    mutationFn: () => api.post<VerifactuEnvio>('/verifactu/enviar'),
    onSuccess: ({ resultado, vista: nueva }) => {
      queryClient.setQueryData(['verifactu'], nueva);
      queryClient.invalidateQueries({ queryKey: ['accounting-invoices'] });
      queryClient.invalidateQueries({ queryKey: ['ws-invoices'] });
      const [texto, tipo] = mensajeEnvio(resultado);
      toast(texto, tipo);
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  // Las esperas son por entorno: cuenta la del entorno que tiene registros en cola.
  const entornoCola = pendientesActual > 0 || pendientesOtro === 0 ? entorno : otro;
  const espera = cola.esperaHasta[entornoCola] ?? 0;
  const reintento = cola.reintentoHasta[entornoCola] ?? 0;
  // Un refresco con los mismos datos no vuelve a pintar el componente: sin este
  // aviso, «Próximo envío» y el botón seguirían en espera cuando ya ha acabado.
  const [, repintar] = useState(0);
  useEffect(() => {
    const falta = Math.max(espera, reintento) - Date.now();
    if (falta <= 0) return;
    const t = window.setTimeout(() => repintar((n) => n + 1), falta + 500);
    return () => window.clearTimeout(t);
  }, [espera, reintento]);
  const ahora = Date.now();
  const proximo =
    pendientes === 0
      ? 'Cuando haya registros pendientes.'
      : !certificado
        ? 'Cuando se cargue el certificado electrónico.'
        : espera > ahora
          ? `A partir de las ${hora(espera)}, cuando termine el tiempo de espera que indica la AEAT.`
          : reintento > ahora
            ? `A las ${hora(reintento)}, como reintento tras un envío fallido. «Enviar ahora» lo adelanta.`
            : 'En los próximos segundos.';
  const resultado = cola.ultimoResultado ? RESULTADO_ENVIO[cola.ultimoResultado] : null;
  // «Enviar ahora» se salta el reintento tras un fallo, pero nunca la espera que
  // pide la AEAT: durante esa espera el botón no podría hacer nada.
  const esperandoAeat = pendientes > 0 && !!certificado && espera > ahora;
  const ayudaEnvio = !certificado
    ? 'Carga el certificado electrónico para remitir los registros.'
    : pendientes === 0
      ? 'No hay registros pendientes de remitir.'
      : esperandoAeat
        ? 'El tiempo de espera que indica la AEAT no se puede adelantar.'
        : reintento > ahora
          ? 'Remite el siguiente lote sin esperar al reintento automático.'
          : 'Remite ahora el siguiente lote de registros pendientes.';

  return (
    <div className="min-w-0 rounded-xl border border-line p-4">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <Send size={14} className="text-subtle" /> Cola de remisión
      </h3>
      <p className="mt-1 text-xs leading-5 text-subtle">
        Los registros se remiten automáticamente por lotes, respetando el tiempo de espera entre envíos que indica la AEAT. Registros del entorno de{' '}
        {ENTORNO_LABEL[entorno]}:
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {ESTADOS.map((e) => {
          const n = cuenta(entorno, e);
          const info = ESTADO_REMISION[e];
          return (
            <div key={e} className="min-w-0 rounded-lg border border-line bg-bg px-3 py-2">
              <StatusBadge tone={info.tone} label={info.plural} />
              <p className={cx('mt-1 tnum text-lg font-semibold leading-none', n > 0 && info.tone === 'err' && 'text-err', n > 0 && info.tone === 'warn' && 'text-warn')}>
                {n}
              </p>
            </div>
          );
        })}
      </div>
      {pendientesOtro > 0 && (
        <p className="mt-2 text-xs leading-5 text-warn">
          Además, hay {plural(pendientesOtro, 'registro pendiente', 'registros pendientes')} del entorno de {ENTORNO_LABEL[otro]}, que se remiten a ese entorno.
        </p>
      )}

      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-subtle">Último envío</dt>
        <dd className="text-sub">
          {cola.ultimoEnvioAt ? `${fmtDateTime(cola.ultimoEnvioAt)} (${timeAgo(cola.ultimoEnvioAt)})` : 'Todavía no se ha realizado ningún envío'}
        </dd>
        {resultado && (
          <>
            <dt className="text-subtle">Resultado</dt>
            <dd>
              <StatusBadge tone={resultado.tone} label={resultado.label} />
            </dd>
          </>
        )}
        {cola.ultimoCsv && (
          <>
            <dt className="text-subtle">Último CSV</dt>
            <dd className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 break-all font-mono text-sub">{cola.ultimoCsv}</span>
              <CopyButton value={cola.ultimoCsv} title="Copiar el CSV" />
            </dd>
          </>
        )}
        {cola.fallosSeguidos > 0 && (
          <>
            <dt className="text-subtle">Fallos seguidos</dt>
            <dd className="tnum text-warn">{cola.fallosSeguidos}</dd>
          </>
        )}
        <dt className="text-subtle">Próximo envío</dt>
        <dd className="text-sub">{proximo}</dd>
      </dl>

      {cola.ultimoError && (
        <p role="alert" className="mt-3 break-words rounded-lg border border-err/30 bg-err/[.08] px-3 py-2 text-xs leading-5 text-err">
          {cola.ultimoError}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 text-xs text-subtle">{ayudaEnvio}</p>
        <Button size="sm" onClick={() => enviar.mutate()} loading={enviar.isPending} disabled={!certificado || pendientes === 0 || esperandoAeat}>
          <Send size={13} /> Enviar ahora
        </Button>
      </div>
    </div>
  );
}

function Registros({ vista }: { vista: VerifactuVista }) {
  const registros = vista.registros;
  // La lista va de más reciente a más antiguo: el primer registro que aparece de
  // cada factura es su último, el único que admite subsanación.
  const ultimos = new Set<string>();
  const vistas = new Set<string>();
  for (const r of registros) {
    if (vistas.has(r.invoice_id)) continue;
    vistas.add(r.invoice_id);
    ultimos.add(r.id);
  }
  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-line">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <FileText size={14} className="text-subtle" /> Registros de facturación
        </h3>
        {registros.length > 0 && <span className="text-xs text-subtle">Los más recientes</span>}
      </div>
      {registros.length === 0 ? (
        <EmptyState compact title="Todavía no hay registros de facturación" description="Se generan al emitir o anular una factura con VERI*FACTU activo." />
      ) : (
        <ul className="max-h-[440px] divide-y divide-line overflow-y-auto">
          {registros.map((r) => (
            <FilaRegistro key={r.id} r={r} ultimo={ultimos.has(r.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FilaRegistro({ r, ultimo }: { r: VerifactuRegistro; ultimo: boolean }) {
  const estado = ESTADO_REMISION[r.estado];
  const error = textoError(r.codigo_error, r.descripcion_error);
  // Las mismas reglas que el servidor: se subsana un alta rechazada o aceptada
  // con errores, y se repite una anulación rechazada.
  const accion = !ultimo
    ? null
    : r.tipo === 'alta' && (r.estado === 'incorrecto' || r.estado === 'aceptado_con_errores')
      ? 'subsanar'
      : r.tipo === 'anulacion' && r.estado === 'incorrecto'
        ? 'repetir_anulacion'
        : null;
  const numero = r.invoice_number ?? 'Sin número';
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
      {/* Con base propia (y no `flex-1`, de base 0): en pantallas estrechas pasan
          a la línea siguiente el estado y el botón, en vez de estrechar el texto
          hasta una palabra por línea. */}
      <div className="min-w-0 grow basis-56">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {r.workspace_id ? (
            <Link
              to={`/workspaces/${r.workspace_id}?tab=facturacion`}
              className="tap font-mono text-xs font-medium text-acc-soft hover:underline"
              title="Abrir la facturación de la cuenta"
            >
              {numero}
            </Link>
          ) : (
            <span className="font-mono text-xs font-medium">{numero}</span>
          )}
          <Chip size="sm">
            {r.tipo === 'alta' ? 'Alta' : 'Anulación'}
            {r.tipo_factura ? ` · ${r.tipo_factura}` : ''}
          </Chip>
          {r.subsanacion && <Chip size="sm">Subsanación</Chip>}
          {r.incidencia && (
            <Chip size="sm" tone="warn" dot title="No se pudo remitir a su hora (sin certificado o sin conexión) y consta como remitido durante una incidencia">
              Incidencia
            </Chip>
          )}
          {r.entorno === 'pruebas' && (
            <Chip size="sm" title="Entorno de pruebas de la AEAT, sin efectos fiscales">
              Pruebas
            </Chip>
          )}
        </p>
        <p className="mt-1 text-xs text-subtle">
          <span title={r.fecha_hora_gen}>{fmtDateTime(r.created_at)}</span>
          {r.importe_total_cents != null && <span className="tnum"> · {fmtMoney(r.importe_total_cents, 'EUR')}</span>}
          <span className="tnum"> · n.º {r.seq} de la cadena</span>
          {r.intentos > 1 && <span className="tnum"> · {r.intentos} intentos</span>}
        </p>
        {r.csv && (
          <p className="mt-0.5 break-all text-xs text-subtle">
            CSV <span className="font-mono text-sub">{r.csv}</span>
          </p>
        )}
        {error && <p className={cx('mt-1 break-words text-xs leading-5', r.estado === 'incorrecto' ? 'text-err' : 'text-warn')}>{error}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <StatusBadge tone={estado.tone} label={estado.label} pulse={r.estado === 'pendiente'} />
        {accion && <SubsanarBoton invoiceId={r.invoice_id} numero={r.invoice_number} accion={accion} />}
      </div>
    </li>
  );
}

function SistemaInformatico({ vista }: { vista: VerifactuVista }) {
  const s = vista.sistema;
  const p = vista.productor;
  return (
    <div className="min-w-0 rounded-xl border border-line p-4">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <Server size={14} className="text-subtle" /> Sistema informático
      </h3>
      <p className="mt-1 text-xs leading-5 text-subtle">Datos que acompañan a cada registro de facturación.</p>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-subtle">Nombre</dt>
        <dd>{s.nombre}</dd>
        <dt className="text-subtle">Código</dt>
        <dd className="font-mono">{s.id}</dd>
        <dt className="text-subtle">Versión</dt>
        <dd className="font-mono">{s.version}</dd>
        <dt className="text-subtle">Número de instalación</dt>
        <dd className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 break-all font-mono text-sub">{s.numeroInstalacion}</span>
          <CopyButton value={s.numeroInstalacion} title="Copiar el número de instalación" />
        </dd>
        <dt className="text-subtle">Productor</dt>
        <dd className="min-w-0 break-words">
          {p.nombre || <span className="text-warn">Sin razón social</span>}
          {p.nif && <span className="font-mono text-subtle"> · {p.nif}</span>}
        </dd>
      </dl>
    </div>
  );
}

type DatosDeclaracion = Pick<VerifactuAjustes, 'productorNombre' | 'productorNif' | 'productorDireccion' | 'declaracionLugar' | 'declaracionFecha'>;
const CAMPOS_DECLARACION: (keyof DatosDeclaracion)[] = ['productorNombre', 'productorNif', 'productorDireccion', 'declaracionLugar', 'declaracionFecha'];

/**
 * Productor del sistema y declaración responsable. Se monta con una clave que
 * cambia al cambiar lo guardado (ver VerifactuSettings): el borrador nace de
 * ahí y no se pisa con cada refresco de la cola.
 */
function ProductorYDeclaracion({ vista }: { vista: VerifactuVista }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const guardado = vista.ajustes;
  const [d, setD] = useState<DatosDeclaracion>(() => ({
    productorNombre: guardado.productorNombre,
    productorNif: guardado.productorNif,
    productorDireccion: guardado.productorDireccion,
    declaracionLugar: guardado.declaracionLugar,
    declaracionFecha: guardado.declaracionFecha,
  }));
  const set = (patch: Partial<DatosDeclaracion>) => setD((x) => ({ ...x, ...patch }));
  const dirty = CAMPOS_DECLARACION.some((k) => d[k].trim() !== guardado[k]);

  const guardar = useMutation({
    mutationFn: () =>
      api.put<VerifactuVista>('/verifactu', {
        productorNombre: d.productorNombre.trim(),
        productorNif: d.productorNif.trim(),
        productorDireccion: d.productorDireccion.trim(),
        declaracionLugar: d.declaracionLugar.trim(),
        declaracionFecha: d.declaracionFecha,
      }),
    onSuccess: (nueva) => {
      queryClient.setQueryData(['verifactu'], nueva);
      toast('Datos del productor y de la declaración guardados', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  // Con el campo guardado vacío, el dato efectivo es el de la empresa emisora y
  // sirve de ejemplo de lo que se usará si se deja así. Con un productor propio
  // guardado, el efectivo es ese, así que se describe en vez de mostrarlo.
  const ejemplo = (campo: 'productorNombre' | 'productorNif' | 'productorDireccion', efectivo: string, descripcion: string) =>
    !guardado[campo] && efectivo ? efectivo : descripcion;
  const { declaracion } = vista;

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-line p-4">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Stamp size={14} className="text-subtle" /> Productor y declaración responsable
        </h3>
        <p className="mt-1 text-xs leading-5 text-subtle">
          La declaración responsable la suscribe el productor del sistema informático, es decir, quien lo desarrolla o lo distribuye. Si la empresa
          utiliza Skyway para facturar sus propios servicios, el productor es la propia empresa.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Razón social del productor">
          <input
            className="input"
            maxLength={120}
            value={d.productorNombre}
            onChange={(e) => set({ productorNombre: e.target.value })}
            placeholder={ejemplo('productorNombre', vista.productor.nombre, 'La de la empresa emisora')}
          />
        </Field>
        <Field label="NIF del productor">
          <input
            className="input font-mono"
            maxLength={20}
            autoCapitalize="characters"
            spellCheck={false}
            value={d.productorNif}
            onChange={(e) => set({ productorNif: e.target.value })}
            placeholder={ejemplo('productorNif', vista.productor.nif, 'El de la empresa emisora')}
          />
        </Field>
      </div>
      <Field label="Dirección postal de contacto" hint="Los datos del productor que se dejen vacíos se toman de la empresa emisora.">
        <textarea
          className="input min-h-14"
          maxLength={400}
          value={d.productorDireccion}
          onChange={(e) => set({ productorDireccion: e.target.value })}
          placeholder={ejemplo('productorDireccion', vista.productor.direccion, 'La de la empresa emisora')}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Lugar de suscripción" hint="Localidad y país, por ejemplo «Madrid, España»">
          <input
            className="input"
            maxLength={120}
            value={d.declaracionLugar}
            onChange={(e) => set({ declaracionLugar: e.target.value })}
            placeholder="Madrid, España"
          />
        </Field>
        <Field label="Fecha de suscripción">
          <input className="input" type="date" value={d.declaracionFecha} onChange={(e) => set({ declaracionFecha: e.target.value })} />
        </Field>
      </div>

      {declaracion.completa ? (
        <p className="text-xs text-ok">La declaración responsable está completa.</p>
      ) : (
        <div className="rounded-lg border border-warn/30 bg-warn/[.08] px-3 py-2 text-xs leading-5 text-warn">
          <p className="font-medium">Datos pendientes de la declaración:</p>
          <ul className="mt-0.5 list-disc pl-4">
            {declaracion.pendientes.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex justify-end">
        <Button size="sm" onClick={() => guardar.mutate()} loading={guardar.isPending} disabled={!dirty}>
          Guardar
        </Button>
      </div>

      <details className="group animate-details border-t border-line pt-3">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-sub hover:text-txt">
          <ChevronRight size={12} className="shrink-0 text-subtle transition-transform group-open:rotate-90" aria-hidden />
          Ver la declaración responsable
        </summary>
        {/* La Orden (art. 15.1) fija el título, el orden a) a l) y que cada dato
            vaya precedido de su rótulo: se pinta tal como llega. */}
        <div className="details-body mt-3 rounded-lg border border-line bg-bg/40 p-3">
          <p className="text-xs font-semibold leading-5 text-txt">{declaracion.titulo}</p>
          <dl className="mt-2 flex flex-col gap-2.5">
            {declaracion.apartados.map((ap) => (
              <div key={ap.letra}>
                <dt className="text-xs font-medium leading-5 text-sub">
                  {ap.letra}) {ap.titulo}
                </dt>
                <dd className={cx('mt-0.5 break-words text-xs leading-5', ap.texto.includes('(pendiente)') ? 'text-warn' : 'text-subtle')}>{ap.texto}</dd>
              </div>
            ))}
          </dl>
        </div>
      </details>
    </div>
  );
}

function RegistroEventos({ vista }: { vista: VerifactuVista }) {
  const { eventos, eventosIntegros } = vista;
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-line">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <History size={14} className="text-subtle" /> Registro de eventos
        </h3>
        {eventos.length > 0 && <span className="text-xs text-subtle">Los más recientes</span>}
      </div>
      {!eventosIntegros && (
        <p role="alert" className="flex items-start gap-2 border-b border-line bg-err/[.08] px-4 py-2.5 text-xs leading-5 text-err">
          <CircleAlert size={13} className="mt-[3px] shrink-0" aria-hidden />
          <span>La cadena de huellas del registro de eventos no es íntegra: algún evento se ha modificado o eliminado fuera de Skyway.</span>
        </p>
      )}
      {eventos.length === 0 ? (
        <EmptyState
          compact
          title="Todavía no hay eventos"
          description="Se anotan la activación, los cambios de entorno, de productor y de certificado, los envíos y las subsanaciones."
        />
      ) : (
        <ul className="max-h-[320px] divide-y divide-line overflow-y-auto">
          {eventos.map((e) => {
            const info = EVENTO[e.tipo_evento] ?? { label: e.tipo_evento, tone: 'neutral' as Tone };
            return (
              <li key={e.id} className="px-4 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                  <StatusBadge tone={info.tone} label={info.label} />
                  <span className="tnum text-micro text-subtle" title={e.ts}>
                    {fmtDateTime(e.created_at)}
                  </span>
                </div>
                {e.detalle && <p className="mt-0.5 break-words text-xs leading-5 text-subtle">{e.detalle}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
