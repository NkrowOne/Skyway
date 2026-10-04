import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, RotateCcw, Trash2 } from 'lucide-react';
import { api } from '../api';
import { CloudflareConfigView, CloudflareDnsRecord, CloudflareTestResult } from '../types';
import { cx, safeHref, timeAgo } from '../utils';
import { Button, Chip, ConfirmModal, ErrorState, Field, Skeleton, useFlash, useToast } from './ui';

/** Cuántas zonas se enseñan antes de resumir el resto. */
const ZONAS_VISIBLES = 12;

/**
 * Token de Cloudflare del administrador (Ajustes → Cloudflare). Con él, los
 * dominios nuevos que da de alta un administrador se configuran solos en su
 * Cloudflare. Sección de acción inmediata, con su propio botón, como Mailway:
 * el token es un secreto que solo se escribe (nunca se lee de vuelta) y no
 * debe mezclarse con la barra de guardado global.
 */
export default function CloudflareSettings() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [token, setToken] = useState('');
  const [removeOpen, setRemoveOpen] = useState(false);
  const [test, setTest] = useState<{ ok: true; result: CloudflareTestResult } | { ok: false; message: string } | null>(null);
  const [saved, flashSaved] = useFlash();

  const config = useQuery({
    queryKey: ['cloudflareConfig'],
    queryFn: () => api.get<CloudflareConfigView>('/cloudflare/config'),
  });

  const save = useMutation({
    mutationFn: () => api.put<{ ok: boolean; config: CloudflareConfigView }>('/cloudflare/config', { token: token.trim() }),
    onSuccess: (res) => {
      queryClient.setQueryData(['cloudflareConfig'], res.config);
      setToken('');
      setTest(null);
      flashSaved();
      toast('Token de Cloudflare guardado. Los dominios nuevos que des de alta se configurarán automáticamente.', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const remove = useMutation({
    mutationFn: () => api.del<{ ok: boolean; config: CloudflareConfigView }>('/cloudflare/config'),
    onSuccess: (res) => {
      setRemoveOpen(false);
      queryClient.setQueryData(['cloudflareConfig'], res.config);
      setToken('');
      setTest(null);
      toast('Token de Cloudflare eliminado', 'ok');
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const runTest = useMutation({
    mutationFn: () => api.post<CloudflareTestResult>('/cloudflare/test', token.trim() ? { token: token.trim() } : {}),
    onMutate: () => setTest(null),
    onSuccess: (result) => {
      setTest({ ok: true, result });
      // Probar el guardado refresca sus zonas y su último fallo.
      if (!token.trim()) queryClient.invalidateQueries({ queryKey: ['cloudflareConfig'] });
    },
    onError: (err: Error) => {
      setTest({ ok: false, message: err.message });
      if (!token.trim()) queryClient.invalidateQueries({ queryKey: ['cloudflareConfig'] });
    },
  });

  if (config.isLoading) return <Skeleton className="h-32 w-full rounded-lg" />;
  if (config.isError || !config.data) {
    return (
      <ErrorState
        compact
        className="rounded-lg border border-dashed border-line"
        title="No se ha podido cargar la configuración de Cloudflare"
        error={config.error}
        onRetry={() => config.refetch()}
        retrying={config.isFetching}
      />
    );
  }

  const cfg = config.data;
  const createHref = safeHref(cfg.createTokenUrl);
  const zonas = cfg.zones;

  return (
    <div className="flex flex-col gap-3.5">
      <ConfirmModal
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        onConfirm={() => remove.mutate()}
        loading={remove.isPending}
        title="Eliminar el token de Cloudflare"
        message="Los dominios que des de alta a partir de ahora ya no se configurarán automáticamente en Cloudflare. Los registros que ya se crearon se conservan."
        confirmLabel="Eliminar token"
      />
      <ol className="list-decimal space-y-1 rounded-lg border border-line bg-bg py-3 pl-8 pr-3.5 text-xs leading-5 text-sub">
        <li>
          Crea en Cloudflare un token de API con los permisos{' '}
          <span className="font-medium text-txt">Zone · Zone · Read</span> y{' '}
          <span className="font-medium text-txt">Zone · DNS · Edit</span> sobre tus zonas
          {createHref && (
            <>
              {' '}
              (
              <a href={createHref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-acc-soft hover:underline">
                crear el token <ExternalLink size={11} />
              </a>
              )
            </>
          )}
          .
        </li>
        <li>Pégalo aquí, pulsa «Probar» y guarda.</li>
        <li>
          Cuando un administrador dé de alta un dominio en un servicio, se creará su registro A hacia este servidor (sin proxy); en
          la importación de Railway, solo el de los dominios que marques. Nunca se modifica un registro que ya exista: los
          conflictos se informan. Las acciones de los clientes no usan nunca este token.
        </li>
      </ol>

      <Field
        label={
          <span className="flex flex-wrap items-center gap-1.5">
            Token de API de Cloudflare
            {cfg.configured && (
              <Chip size="sm" tone="ok" dot>
                Guardado{cfg.hint ? ` · termina en ${cfg.hint}` : ''}
              </Chip>
            )}
          </span>
        }
        hint="Solo se almacena en el servidor; no se vuelve a mostrar. También lo puede configurar el instalador de Mailway."
      >
        <input
          className="input font-mono text-xs"
          type="password"
          autoComplete="off"
          placeholder={cfg.configured ? '•••• (escribe para reemplazar)' : 'Token de API (no la clave global)'}
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setTest(null);
          }}
        />
      </Field>

      {cfg.lastError && (
        <p role="alert" className="flex items-start gap-1.5 rounded-lg border border-warn/30 bg-warn/[.06] px-3 py-2 text-xs leading-5 text-warn">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>
            Último fallo del token guardado ({timeAgo(cfg.lastError.at)}): {cfg.lastError.message}
          </span>
        </p>
      )}

      {test && (
        <div
          role={test.ok ? 'status' : 'alert'}
          className={cx(
            'rounded-lg border px-3 py-2 text-xs leading-5',
            test.ok ? 'border-ok/30 bg-ok/[.08] text-ok' : 'border-err/30 bg-err/[.08] text-err',
          )}
        >
          {test.ok
            ? `Token válido: ve ${test.result.zones.total} ${test.result.zones.total === 1 ? 'zona' : 'zonas'}${token.trim() ? '. Pulsa «Guardar» para utilizarlo.' : '.'}`
            : test.message}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => runTest.mutate()}
          loading={runTest.isPending}
          disabled={!token.trim() && !cfg.configured}
          title="Valida el token escrito o, si no hay ninguno, el guardado"
        >
          Probar
        </Button>
        <Button size="sm" onClick={() => save.mutate()} loading={save.isPending} disabled={!token.trim()} success={saved && !token.trim()}>
          Guardar
        </Button>
        {cfg.configured && (
          <Button variant="ghost" size="sm" onClick={() => setRemoveOpen(true)} className="text-err hover:bg-err/[.1]">
            <Trash2 size={13} /> Eliminar token
          </Button>
        )}
      </div>

      {cfg.configured && <RegistrosCreados />}

      {cfg.configured && (
        <div className="border-t border-line pt-3 text-xs text-subtle">
          {zonas && zonas.total > 0 ? (
            <>
              <p className="mb-1.5">
                Zonas que ve el token ({zonas.total}) · comprobado {timeAgo(zonas.checkedAt)}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {zonas.names.slice(0, ZONAS_VISIBLES).map((z) => (
                  <Chip key={z} size="sm">
                    <span className="max-w-[16rem] truncate font-mono">{z}</span>
                  </Chip>
                ))}
                {zonas.total > ZONAS_VISIBLES && <Chip size="sm">y {zonas.total - ZONAS_VISIBLES} más</Chip>}
              </div>
            </>
          ) : (
            <p>Pulsa «Probar» para consultar las zonas que ve el token.</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Registros A que ha creado el DNS automático. Siguen apuntando a este
 * servidor aunque el dominio deje de usarse, así que cada nombre queda
 * reservado al proyecto para el que se creó (ningún otro cliente puede
 * asignárselo) hasta que se borra aquí. El servidor solo borra un registro
 * que nadie usa y que nadie ha cambiado en Cloudflare.
 */
function RegistrosCreados() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [borrar, setBorrar] = useState<CloudflareDnsRecord | null>(null);
  const [restaurar, setRestaurar] = useState<CloudflareDnsRecord | null>(null);

  const records = useQuery({
    queryKey: ['cloudflareRecords'],
    queryFn: () => api.get<{ records: CloudflareDnsRecord[] }>('/cloudflare/records'),
  });

  const remove = useMutation({
    mutationFn: (domain: string) =>
      api.del<{ ok: boolean; result: 'deleted' | 'gone' | 'released'; records: CloudflareDnsRecord[] }>(
        `/cloudflare/records/${encodeURIComponent(domain)}`,
      ),
    onSuccess: (res, domain) => {
      setBorrar(null);
      queryClient.setQueryData(['cloudflareRecords'], { records: res.records });
      const texto = {
        deleted: `Registro de ${domain} borrado en Cloudflare.`,
        gone: `El registro de ${domain} ya no existía en Cloudflare: el nombre queda libre.`,
        released: `El registro de ${domain} ya apuntaba a otro sitio: no se ha tocado y el nombre queda libre.`,
      }[res.result];
      toast(texto, 'ok');
    },
    onError: (err: Error) => {
      setBorrar(null);
      toast(err.message, 'err');
    },
  });

  // Deshace un reemplazo: vuelven los registros del hosting anterior y se retira el A de Skyway.
  const restore = useMutation({
    mutationFn: (domain: string) =>
      api.post<{ ok: boolean; result: { restaurados: string[]; retirado: boolean }; records: CloudflareDnsRecord[] }>(
        `/cloudflare/records/${encodeURIComponent(domain)}/restore`,
      ),
    onSuccess: (res, domain) => {
      setRestaurar(null);
      queryClient.setQueryData(['cloudflareRecords'], { records: res.records });
      queryClient.invalidateQueries({ queryKey: ['domainCheck', domain] });
      toast(`Registros anteriores de ${domain} restaurados en Cloudflare: ${res.result.restaurados.join(', ')}.`, 'ok');
    },
    onError: (err: Error) => {
      setRestaurar(null);
      toast(err.message, 'err');
    },
  });

  if (records.isLoading) return <Skeleton className="h-16 w-full rounded-lg" />;
  if (records.isError || !records.data) {
    return (
      <ErrorState
        compact
        className="rounded-lg border border-dashed border-line"
        title="No se han podido cargar los registros creados"
        error={records.error}
        onRetry={() => records.refetch()}
        retrying={records.isFetching}
      />
    );
  }
  const lista = records.data.records;

  return (
    <div className="border-t border-line pt-3 text-xs">
      <ConfirmModal
        open={!!borrar}
        onClose={() => setBorrar(null)}
        onConfirm={() => borrar && remove.mutate(borrar.domain)}
        loading={remove.isPending}
        title="Borrar el registro en Cloudflare"
        message={
          borrar
            ? `Se borrará el registro A de ${borrar.domain} hacia ${borrar.content} en la zona ${borrar.zone}, y el nombre dejará de estar reservado. Si el registro ha cambiado en Cloudflare desde que lo creó Skyway, no se toca.`
            : ''
        }
        confirmLabel="Borrar registro"
      >
        {borrar?.replaced && borrar.replaced.length > 0 && (
          <p className="mt-2 text-sm text-warn">
            Este registro sustituyó a los del hosting anterior. Al borrarlo se pierde la copia y el nombre se queda sin dirección; para
            volver a como estaba, utiliza «Restaurar».
          </p>
        )}
      </ConfirmModal>
      <ConfirmModal
        open={!!restaurar}
        onClose={() => setRestaurar(null)}
        onConfirm={() => restaurar && restore.mutate(restaurar.domain)}
        loading={restore.isPending}
        title="Restaurar los registros anteriores"
        message={
          restaurar
            ? `Se volverán a crear en la zona ${restaurar.zone} los registros que había antes del reemplazo (${(restaurar.replaced ?? [])
                .map((p) => `${p.type} ${p.content}${p.proxied ? ' con proxy' : ''}`)
                .join(', ')}) y se retirará el A hacia ${restaurar.content}, en una sola operación. ${
                restaurar.usedBy
                  ? `El dominio sigue asignado a ${restaurar.usedBy.project} / ${restaurar.usedBy.name}, pero su tráfico volverá a ir al hosting anterior.`
                  : ''
              }`
            : ''
        }
        confirmLabel="Restaurar"
      />
      <p className="mb-1.5 text-subtle">
        Registros creados automáticamente ({lista.length}). Cada nombre queda reservado al proyecto para el que se creó, aunque deje de
        usarse, hasta que borres aquí su registro.
      </p>
      {lista.length === 0 ? (
        <p className="text-subtle">Todavía no se ha creado ningún registro.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {lista.map((r) => (
            <li key={r.domain} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-txt" title={r.domain}>
                {r.domain}
              </span>
              <span className="min-w-0 truncate text-subtle">
                {r.usedBy
                  ? `En uso: ${r.usedBy.project} / ${r.usedBy.name}`
                  : r.project
                    ? `Sin uso · reservado a ${r.project.name}`
                    : 'Sin uso · proyecto eliminado'}
              </span>
              <span className="text-subtle">{timeAgo(r.createdAt)}</span>
              {r.replaced && r.replaced.length > 0 && (
                <span className="basis-full text-subtle">
                  Sustituyó a {r.replaced.map((p) => `${p.type} ${p.content}${p.proxied ? ' (proxy)' : ''}`).join(', ')}
                </span>
              )}
              {r.replaced && r.replaced.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRestaurar(r)}
                  title="Volver a crear los registros del hosting anterior y retirar el de Skyway"
                >
                  <RotateCcw size={13} /> Restaurar
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setBorrar(r)}
                disabled={!!r.usedBy}
                title={r.usedBy ? 'Quita antes el dominio del servicio' : 'Borrar el registro en Cloudflare y liberar el nombre'}
                className="text-err hover:bg-err/[.1]"
              >
                <Trash2 size={13} /> Borrar
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
