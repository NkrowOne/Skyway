import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { CopyButton, useToast } from './ui';

interface Compartidos {
  /** Nombre del servicio en la red de los proyectos que lo reciben. */
  alias: string;
  port: number | null;
  /** Ámbito de sus referencias desde otro proyecto: `proyecto/servicio`. */
  reference: string;
  canManage: boolean;
  projects: { id: string; name: string; slug: string; shared: boolean }[];
}

/**
 * Compartir un servicio con otros proyectos de la misma empresa. Cada
 * proyecto tiene su red privada y en ella un servicio se llama por su nombre
 * corto, que solo vale dentro: aquí se elige qué otros proyectos lo ven, y con
 * qué nombre. Se aplica al marcar, sin volver a desplegar el servicio.
 */
export default function CompartirServicio({ serviceId }: { serviceId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const clave = ['service-shares', serviceId];
  const q = useQuery({ queryKey: clave, queryFn: () => api.get<Compartidos>(`/services/${serviceId}/shares`) });
  const guardar = useMutation({
    mutationFn: (projectIds: string[]) =>
      api.put<{ ok: true; shared: string[]; warnings: string[] }>(`/services/${serviceId}/shares`, { projectIds }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: clave });
      if (data.warnings.length > 0) toast(data.warnings[0], 'info');
      else toast('Cambios guardados y aplicados.', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  if (!q.data) return <p className="text-xs text-subtle">{q.isError ? 'No se ha podido cargar.' : 'Cargando…'}</p>;
  const { alias, port, reference, canManage, projects } = q.data;
  if (projects.length === 0) {
    return <p className="text-xs text-subtle">No hay otros proyectos de esta empresa con los que compartirlo.</p>;
  }
  const marcados = projects.filter((p) => p.shared).map((p) => p.id);
  const direccion = port ? `${alias}:${port}` : alias;
  const referencia = `\${{${reference}.NOMBRE}}`;
  const cambiar = (id: string, on: boolean) => guardar.mutate(on ? [...marcados, id] : marcados.filter((x) => x !== id));

  return (
    <>
      <div className="space-y-1.5">
        {projects.map((p) => (
          <label
            key={p.id}
            className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-sm max-sm:min-h-10"
          >
            <input
              type="checkbox"
              checked={p.shared}
              disabled={!canManage || guardar.isPending}
              onChange={(e) => cambiar(p.id, e.target.checked)}
              className="h-[15px] w-[15px] shrink-0 accent-acc max-sm:h-4 max-sm:w-4"
            />
            <span className="min-w-0 truncate">{p.name}</span>
          </label>
        ))}
      </div>
      {!canManage && (
        <p className="mt-2 text-xs text-subtle">Solo un administrador o el propietario de la empresa puede cambiarlo.</p>
      )}
      {marcados.length > 0 && (
        <>
          <div className="mt-3 flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2">
            <span className="truncate font-mono text-xs">{direccion}</span>
            <CopyButton value={direccion} />
          </div>
          <p className="mt-2 text-xs leading-relaxed text-subtle">
            Dirección del servicio desde los proyectos marcados. Su dirección interna de siempre solo vale dentro de este proyecto.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-subtle">
            <span>Sus variables, como referencia desde esos proyectos:</span>
            <span className="inline-flex items-center gap-1 rounded-md border border-dashed border-acc/40 px-1.5 py-0.5 font-mono text-acc-soft">
              {referencia}
            </span>
          </div>
        </>
      )}
    </>
  );
}
