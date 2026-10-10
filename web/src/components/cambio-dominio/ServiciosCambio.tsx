import { useMutation } from '@tanstack/react-query';
import { cambioDominioApi, MigracionSkyway } from '../../cambioDominio';
import type { DeploymentStatus } from '../../types';
import { DEPLOY_STATUS_LABEL } from '../../utils';
import { Button, Chip, useToast } from '../ui';
import { Bloque } from './comunes';

/**
 * Despliegues de los servicios afectados por el cambio (al pasar, al volver o
 * en la baja), con «Reintentar este servicio» en los que fallaron. Mientras
 * alguno no esté desplegado, el cambio no se puede cerrar: el texto lo dice.
 */
export default function ServiciosCambio({
  projectId,
  m,
  onCambio,
  accion,
}: {
  projectId: string;
  m: MigracionSkyway;
  onCambio: (m: MigracionSkyway) => void;
  /** Lo que espera a los despliegues («dar de baja dominio.es», «terminar»…), o null si nada. */
  accion: string | null;
}) {
  const toast = useToast();
  const reintentar = useMutation({
    mutationFn: (serviceId: string) => cambioDominioApi.reintentarServicio(projectId, m.id, serviceId),
    onSuccess: (v) => onCambio(v),
    onError: (err: Error) => toast(err.message, 'err'),
  });
  if (m.servicios.length === 0) return null;
  const conError = m.servicios.some((s) => s.estado === 'error');
  const enCurso = m.servicios.some((s) => s.estado === 'desplegando');

  return (
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
      {accion && (conError || enCurso) && (
        <p className="mt-1.5 text-xs leading-5 text-subtle">
          {conError
            ? `Para ${accion}, todos los servicios tienen que estar desplegados: reintenta los que han fallado o despliégalos desde su página.`
            : `Para ${accion}, espera a que terminen los despliegues.`}
        </p>
      )}
    </Bloque>
  );
}
