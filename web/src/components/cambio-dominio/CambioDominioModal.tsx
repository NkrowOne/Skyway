import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { cambioDominioApi, ESTADO_CAMBIO_LABEL, ESTADOS_EN_CURSO, ListaCambios, MigracionSkyway } from '../../cambioDominio';
import { Button, ErrorState, Modal, Skeleton, useToast } from '../ui';
import { Aviso, Avisos, Pasos } from './comunes';
import FasePreparar from './FasePreparar';
import FaseTerminada from './FaseTerminada';
import FaseTransicion from './FaseTransicion';
import PasoQueCambia from './PasoQueCambia';
import ServiciosCambio from './ServiciosCambio';

const abierto = (m: MigracionSkyway) => m.estado !== 'terminada' && m.estado !== 'cancelada';

/** Fase del asistente en la que está un cambio (para la barra de pasos). */
function faseDe(m: MigracionSkyway): 1 | 2 | 3 {
  if (m.estado === 'preparando' || m.estado === 'lista' || m.estado === 'pasando') return 1;
  if (m.estado === 'terminada') return 3;
  return 2;
}

/**
 * Asistente «Cambiar de dominio» de un proyecto: el cambio abierto en su
 * fase, o el formulario para empezar uno. Mientras se prepara, comprueba el
 * DNS y el correo cada 30 s; mientras una acción o un despliegue están en
 * curso, consulta el estado cada pocos segundos.
 */
export default function CambioDominioModal({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [nuevo, setNuevo] = useState(false);

  const lista = useQuery({
    queryKey: ['cambioDominio', projectId],
    queryFn: () => cambioDominioApi.listar(projectId),
    enabled: open,
    refetchInterval: (q) => {
      const a = q.state.data?.abierta;
      if (!a) {
        // Cancelar tras un «Volver» despliega las aplicaciones que envían con buzones del cambio.
        const ultima = q.state.data?.anteriores[0];
        return ultima?.estado === 'cancelada' && ultima.servicios.some((s) => s.estado === 'desplegando') ? 3000 : false;
      }
      if (ESTADOS_EN_CURSO.includes(a.estado) || a.servicios.some((s) => s.estado === 'desplegando')) return 3000;
      return a.estado === 'pasada' ? 15_000 : false;
    },
  });

  const actualizar = useCallback(
    (m: MigracionSkyway) => {
      queryClient.setQueryData<ListaCambios>(['cambioDominio', projectId], (prev) => {
        const anteriores = (prev?.anteriores ?? []).filter((x) => x.id !== m.id);
        return {
          dominios: prev?.dominios ?? [],
          abierta: abierto(m) ? m : null,
          anteriores: abierto(m) ? anteriores : [m, ...anteriores],
        };
      });
      // Los dominios y las variables de los servicios pueden haber cambiado.
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['cambioDominioResumen', projectId] });
    },
    [queryClient, projectId],
  );

  const comprobar = useMutation({
    mutationFn: (mid: string) => cambioDominioApi.comprobar(projectId, mid),
    onSuccess: actualizar,
  });
  const comprobarRef = useRef(comprobar.mutate);
  comprobarRef.current = comprobar.mutate;

  const a = lista.data?.abierta ?? null;
  const preparando = !!a && (a.estado === 'preparando' || a.estado === 'lista');
  const idPreparando = preparando ? a.id : null;
  useEffect(() => {
    if (!open || !idPreparando) return;
    const t = window.setInterval(() => comprobarRef.current(idPreparando), 30_000);
    return () => window.clearInterval(t);
  }, [open, idPreparando]);

  // Al cerrar, la próxima apertura vuelve a enseñar el último cambio terminado.
  useEffect(() => {
    if (!open) setNuevo(false);
  }, [open]);

  const ultima = lista.data?.anteriores[0] ?? null;
  const verTerminada = !a && !nuevo && ultima?.estado === 'terminada';

  let paso: 0 | 1 | 2 | 3 = 0;
  let cuerpo: React.ReactNode;
  if (lista.isLoading) {
    cuerpo = (
      <div className="flex flex-col gap-3" aria-busy>
        <Skeleton className="h-9 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    );
  } else if (lista.error) {
    cuerpo = <ErrorState compact error={lista.error} onRetry={() => lista.refetch()} retrying={lista.isFetching} />;
  } else if (a) {
    paso = faseDe(a);
    cuerpo = (
      <div className="flex flex-col gap-4">
        <Cabecera m={a} />
        {ESTADOS_EN_CURSO.includes(a.estado) && <EnCurso projectId={projectId} m={a} onCambio={actualizar} />}
        {(a.estado === 'preparando' || a.estado === 'lista') && (
          <FasePreparar
            projectId={projectId}
            m={a}
            onCambio={actualizar}
            onComprobar={() => comprobar.mutate(a.id, { onError: (err: Error) => toast(err.message, 'err') })}
            comprobando={comprobar.isPending}
          />
        )}
        {(a.estado === 'pasada' || a.estado === 'dando_de_baja') && <FaseTransicion projectId={projectId} m={a} onCambio={actualizar} />}
      </div>
    );
  } else if (verTerminada && ultima) {
    paso = 3;
    cuerpo = (
      <div className="flex flex-col gap-4">
        <Cabecera m={ultima} />
        <FaseTerminada projectId={projectId} m={ultima} onCambio={actualizar} onNuevo={() => setNuevo(true)} />
      </div>
    );
  } else {
    cuerpo = (
      <div className="flex flex-col gap-4">
        {ultima?.estado === 'cancelada' && !nuevo && (
          <Avisos tono="info" avisos={[`El último cambio (${ultima.fromDomain} → ${ultima.toDomain}) se canceló.`, ...ultima.avisos]} />
        )}
        {ultima?.estado === 'cancelada' && !nuevo && ultima.servicios.some((s) => s.estado !== 'ok') && (
          <ServiciosCambio projectId={projectId} m={ultima} onCambio={actualizar} accion={null} />
        )}
        <PasoQueCambia
          projectId={projectId}
          dominios={lista.data?.dominios ?? []}
          onPreparado={(m) => {
            setNuevo(false);
            actualizar(m);
          }}
        />
      </div>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title="Cambiar de dominio" wide>
      <Pasos actual={paso} />
      {cuerpo}
    </Modal>
  );
}

function Cabecera({ m }: { m: MigracionSkyway }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <p className="min-w-0 break-all font-mono text-sm text-txt">
        {m.fromDomain} <span className="font-sans text-subtle">→</span> {m.toDomain}
      </p>
      <span className="text-xs text-subtle">
        {ESTADO_CAMBIO_LABEL[m.estado]}
        {m.soloWeb ? ' · Solo la web' : ''}
      </span>
    </div>
  );
}

/**
 * Pasar, volver o dar de baja en curso. Si se cortó (un error o un reinicio
 * de Skyway), «Reintentar» repite la misma acción: todas son idempotentes.
 */
function EnCurso({ projectId, m, onCambio }: { projectId: string; m: MigracionSkyway; onCambio: (m: MigracionSkyway) => void }) {
  const toast = useToast();
  const reintentar = useMutation({
    mutationFn: () => {
      if (m.estado === 'pasando') return cambioDominioApi.pasar(projectId, m.id, m.variables?.huella ?? '');
      if (m.estado === 'volviendo') return cambioDominioApi.volver(projectId, m.id);
      return cambioDominioApi.darDeBaja(projectId, m.id, m.fromDomain);
    },
    onSuccess: onCambio,
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const volver = useMutation({
    mutationFn: () => cambioDominioApi.volver(projectId, m.id),
    onSuccess: onCambio,
    onError: (err: Error) => toast(err.message, 'err'),
  });
  const accion =
    m.estado === 'pasando' ? `Pasando a ${m.toDomain}` : m.estado === 'volviendo' ? `Volviendo a ${m.fromDomain}` : `Dando de baja ${m.fromDomain}`;

  if (!m.error) {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-line bg-bg px-3.5 py-3" role="status">
        <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-acc-soft" aria-hidden />
        <div className="min-w-0 text-sm">
          <p className="font-medium text-txt">{accion}…</p>
          {m.paso && <p className="mt-0.5 text-xs text-subtle">{m.paso}</p>}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <Aviso tono="err">
        <p className="font-medium">{accion}: no ha terminado.</p>
        <p className="mt-0.5">{m.error}</p>
      </Aviso>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {m.estado === 'pasando' && m.puedeVolver && (
          <Button variant="secondary" onClick={() => volver.mutate()} loading={volver.isPending} className="max-sm:h-11">
            Volver a {m.fromDomain}
          </Button>
        )}
        <Button onClick={() => reintentar.mutate()} loading={reintentar.isPending} className="max-sm:h-11">
          Reintentar
        </Button>
      </div>
    </div>
  );
}
