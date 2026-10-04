import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { cambioDominioApi, fechaLarga, MigracionSkyway } from '../../cambioDominio';
import { Button, ConfirmModal, useToast } from '../ui';
import { Avisos, Bloque } from './comunes';

/**
 * Paso 4, «Terminado»: el dominio anterior ya no se usa (o, solo web, el cambio
 * se ha dado por terminado). Las redirecciones se quedan hasta que alguien las
 * quita: los buscadores y los enlaces guardados tardan meses en olvidarlas.
 */
export default function FaseTerminada({
  projectId,
  m,
  onCambio,
  onNuevo,
}: {
  projectId: string;
  m: MigracionSkyway;
  onCambio: (m: MigracionSkyway) => void;
  onNuevo: () => void;
}) {
  const toast = useToast();
  const [quitarAbierto, setQuitarAbierto] = useState(false);
  const quitar = useMutation({
    mutationFn: () => cambioDominioApi.quitarRedirecciones(projectId, m.id, m.fromDomain),
    onSuccess: (v) => {
      setQuitarAbierto(false);
      onCambio(v);
      toast('Redirecciones quitadas', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5 text-sm leading-6 text-sub">
        {m.soloWeb ? (
          <p>
            El cambio de la web a <span className="font-medium text-txt">{m.toDomain}</span> ha terminado.
          </p>
        ) : (
          <>
            <p>
              {m.fromDomain} se ha dado de baja. El correo de tu equipo funciona en{' '}
              <span className="font-medium text-txt">{m.toDomain}</span>.
            </p>
            <p className="text-xs leading-5 text-subtle">
              Mantén {m.fromDomain} registrado al menos uno o dos años: quien lo registrara recibiría el correo que aún se envíe a las
              direcciones antiguas.
            </p>
          </>
        )}
      </div>

      <Bloque titulo="Redirecciones">
        {m.redirecciones.length === 0 ? (
          <p className="rounded-lg border border-line bg-bg px-3.5 py-2.5 text-sm text-sub">
            {m.fromDomain} ya no redirige a {m.toDomain}.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-bg">
            {m.redirecciones.map((r) => (
              <li key={r.host} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-3.5 py-2 text-sm">
                <span className="break-all font-mono text-sub">{r.host}</span>
                <ArrowRight size={13} className="shrink-0 text-subtle" aria-hidden />
                <span className="break-all font-mono text-txt">{r.toHost}</span>
                <span className="basis-full text-xs text-subtle">
                  {r.permanenteDesde <= Date.now() ? 'Permanente' : `Temporal hasta el ${fechaLarga(r.permanenteDesde)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Bloque>

      <Avisos tono="info" avisos={m.avisos} />

      <div className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">
        {m.redirecciones.length > 0 && (
          <Button variant="danger" onClick={() => setQuitarAbierto(true)} className="max-sm:h-11">
            Quitar las redirecciones
          </Button>
        )}
        <Button variant="secondary" onClick={onNuevo} className="max-sm:h-11">
          Empezar otro cambio
        </Button>
      </div>

      <ConfirmModal
        open={quitarAbierto}
        onClose={() => setQuitarAbierto(false)}
        onConfirm={() => quitar.mutate()}
        loading={quitar.isPending}
        title="Quitar las redirecciones"
        message={`Quien siga entrando por ${m.fromDomain} verá un error. Los buscadores tardan meses en olvidar las direcciones antiguas: mantenlas al menos 12 meses.`}
        confirmLabel="Quitar las redirecciones"
        typeToConfirm={m.fromDomain}
        typeToConfirmIgnoreCase
      />
    </div>
  );
}
