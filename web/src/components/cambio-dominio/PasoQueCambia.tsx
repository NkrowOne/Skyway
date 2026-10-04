import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { ApiError } from '../../api';
import {
  Clave,
  claveDe,
  cambioDominioApi,
  contar,
  HostPlan,
  MigracionSkyway,
  ModoHost,
  PlanSkyway,
} from '../../cambioDominio';
import { Button, Field, useToast } from '../ui';
import { Aviso, Avisos, Desplegable } from './comunes';

const ROTULO_AMBITO = { project: 'Compartida', service: 'Servicio', build: 'Compilación' } as const;

function modoTexto(modo: ModoHost, to: string): string {
  if (modo === 'redirigir') return `Redirigir a ${to}`;
  if (modo === 'servir') return `Servir también en ${to} (sin redirigir)`;
  return 'No cambiar';
}

/**
 * Paso 1, «Qué cambia»: los dos dominios y la vista previa (web, correo y
 * variables) con sus bloqueos. Revisar un nombre o una variable vuelve a pedir
 * el plan: la huella que se envía al preparar es la de lo que se ve.
 */
export default function PasoQueCambia({
  projectId,
  dominios,
  onPreparado,
}: {
  projectId: string;
  dominios: string[];
  onPreparado: (m: MigracionSkyway) => void;
}) {
  const toast = useToast();
  const [from, setFrom] = useState(dominios[0] ?? '');
  const [to, setTo] = useState('');
  const [soloWeb, setSoloWeb] = useState(false);
  const [plan, setPlan] = useState<PlanSkyway | null>(null);
  // La petición con la que se obtuvo el plan: los cambios de modo o de
  // exclusión se piden sobre ella, no sobre lo que se esté escribiendo.
  const [pedido, setPedido] = useState<{ fromDomain: string; toDomain: string; soloWeb: boolean } | null>(null);

  const calcular = useMutation({
    mutationFn: (body: { fromDomain: string; toDomain: string; soloWeb: boolean; hosts?: HostPlan[]; excluidas?: Clave[] }) =>
      cambioDominioApi.plan(projectId, body),
    onSuccess: (p, body) => {
      setPlan(p);
      setPedido({ fromDomain: body.fromDomain, toDomain: body.toDomain, soloWeb: body.soloWeb });
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  const hostsDe = (p: PlanSkyway): HostPlan[] => p.hosts.map(({ serviceId, from: f, to: t, modo }) => ({ serviceId, from: f, to: t, modo }));
  const excluidasDe = (p: PlanSkyway): Clave[] =>
    p.variables.cambios.filter((c) => c.excluida).map(({ ambito, serviceId, key }) => ({ ambito, serviceId, key }));

  const preparar = useMutation({
    mutationFn: () => {
      if (!plan || !pedido) throw new Error('Calcula antes qué cambia.');
      return cambioDominioApi.preparar(projectId, { ...pedido, hosts: hostsDe(plan), excluidas: excluidasDe(plan), expect: plan.expect });
    },
    onSuccess: (m) => onPreparado(m),
    onError: (err: Error) => {
      toast(err.message, 'err');
      // Algo cambió desde la vista previa: se vuelve a calcular para enseñar lo de ahora.
      if (err instanceof ApiError && err.code === 'plan_changed' && plan && pedido) {
        calcular.mutate({ ...pedido, hosts: hostsDe(plan), excluidas: excluidasDe(plan) });
      }
    },
  });

  const replanificar = (hosts: HostPlan[], excluidas: Clave[]) => {
    if (!pedido) return;
    calcular.mutate({ ...pedido, hosts, excluidas });
  };

  const cambiarModo = (i: number, modo: ModoHost) => {
    if (!plan) return;
    replanificar(
      hostsDe(plan).map((h, j) => (j === i ? { ...h, modo } : h)),
      excluidasDe(plan),
    );
  };

  const alternarVariable = (c: Clave, aplicar: boolean) => {
    if (!plan) return;
    const actuales = excluidasDe(plan).filter((x) => claveDe(x) !== claveDe(c));
    replanificar(hostsDe(plan), aplicar ? actuales : [...actuales, c]);
  };

  const pedir = (e: React.FormEvent) => {
    e.preventDefault();
    calcular.mutate({ fromDomain: from.trim(), toDomain: to.trim(), soloWeb });
  };

  // Lo escrito ya no es lo calculado: el plan de abajo es de otros dominios.
  const desfasado = !!pedido && (pedido.fromDomain !== from.trim() || pedido.toDomain !== to.trim() || pedido.soloWeb !== soloWeb);
  const destino = plan?.toDomain ?? to.trim();

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={pedir} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Dominio actual">
            <input
              className="input font-mono"
              list="cambio-dominio-actuales"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="dominio.es"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              required
            />
            <datalist id="cambio-dominio-actuales">
              {dominios.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </Field>
          <Field label="Dominio nuevo">
            <input
              className="input font-mono"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="dominio2.es"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          </Field>
        </div>
        {/* También si el plan falla: sin poder consultar el correo (Mailway no
            responde, el cliente está vinculado a otra integración), la web se
            puede cambiar igualmente. */}
        {(soloWeb || plan?.correoDisponible === 'si' || plan?.correoDisponible === 'mailway_antiguo' || calcular.isError) && (
          <label className="flex items-start gap-2 text-xs text-sub">
            <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-acc" checked={soloWeb} onChange={(e) => setSoloWeb(e.target.checked)} />
            <span>
              <span className="font-medium text-txt">Solo la web.</span> El correo de {from.trim() || 'este dominio'} no se cambia.
            </span>
          </label>
        )}
        <div className="flex justify-end">
          <Button type="submit" variant={plan && !desfasado ? 'secondary' : 'primary'} loading={calcular.isPending} disabled={!from.trim() || !to.trim()}>
            {plan && !desfasado ? 'Volver a calcular' : 'Ver qué cambia'}
          </Button>
        </div>
      </form>

      {plan && !desfasado && (
        <div className={`flex flex-col gap-2.5 ${calcular.isPending ? 'opacity-60' : ''}`} aria-busy={calcular.isPending}>
          {plan.bloqueos.length > 0 && <Avisos tono="err" avisos={plan.bloqueos} />}

          <Desplegable
            titulo={
              plan.hosts.filter((h) => h.modo !== 'no_cambiar').length > 0
                ? `Web: ${contar(plan.hosts.filter((h) => h.modo !== 'no_cambiar').length, 'nombre pasa', 'nombres pasan')} a ${destino}`
                : 'Web: ningún nombre cambia'
            }
            detalle={
              plan.hosts.length === 0
                ? `Ningún servicio de este proyecto usa ${plan.fromDomain}.`
                : 'El nombre anterior redirige al nuevo conservando la ruta: de forma temporal 7 días y después permanente.'
            }
            tono={plan.hosts.some((h) => h.error) ? 'err' : 'neutral'}
            abiertoInicial={plan.hosts.some((h) => h.error)}
          >
            {plan.hosts.length > 0 && (
              <ul className="flex flex-col divide-y divide-line">
                {plan.hosts.map((h, i) => (
                  <li key={`${h.serviceId}:${h.from}`} className="flex flex-col gap-1.5 py-2 first:pt-0 last:pb-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                      <span className="break-all font-mono text-txt">{h.from}</span>
                      <span className="text-xs text-subtle">· {h.serviceName}</span>
                    </div>
                    <select
                      className="input text-sm"
                      value={h.modo}
                      onChange={(e) => cambiarModo(i, e.target.value as ModoHost)}
                      disabled={calcular.isPending}
                      aria-label={`Qué hacer con ${h.from}`}
                    >
                      {(['redirigir', 'servir', 'no_cambiar'] as ModoHost[]).map((modo) => (
                        <option key={modo} value={modo}>
                          {modoTexto(modo, h.to)}
                        </option>
                      ))}
                    </select>
                    {h.error && <p className="text-xs text-err">{h.error}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Desplegable>

          <Desplegable
            titulo={
              plan.correo
                ? `Correo: ${contar(plan.correo.buzones.length, 'buzón', 'buzones')} y ${contar(plan.correo.alias.length, 'alias', 'alias')} de Mailway`
                : 'Correo: no cambia'
            }
            detalle={
              plan.correo
                ? 'Se conservan el correo, las contraseñas, las contraseñas de aplicación y las claves de API. Hasta dar de baja el dominio actual, lo que llegue a él sigue entrando en los mismos buzones.'
                : plan.correoDisponible === 'mailway_antiguo' && !plan.soloWeb
                  ? 'Actualiza Mailway a la 1.3 para cambiar el dominio del correo, o marca «Solo la web».'
                  : `El correo de ${plan.fromDomain} no cambia.`
            }
          >
            {plan.correo && (plan.correo.buzones.length > 0 || plan.correo.alias.length > 0) && (
              <ul className="flex flex-col gap-1.5 text-xs">
                {[...plan.correo.buzones.map((b) => ({ ...b, tipo: 'Buzón' })), ...plan.correo.alias.map((a) => ({ ...a, tipo: 'Alias', usadoPorApps: [] as string[] }))].map((b) => (
                  <li key={b.id} className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <span className="text-subtle">{b.tipo}</span>
                    <span className="break-all font-mono text-sub">{b.de}</span>
                    <ArrowRight size={12} className="shrink-0 text-subtle" aria-hidden />
                    <span className="break-all font-mono text-txt">{b.a}</span>
                    {b.usadoPorApps.length > 0 && (
                      <span className="text-subtle">
                        · Lo usa una aplicación para enviar ({b.usadoPorApps.map((n) => n.replace(/^skyway:/, '')).join(', ')})
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Desplegable>

          <Variables plan={plan} ocupado={calcular.isPending} onAlternar={alternarVariable} />

          {plan.avisos.length > 0 && <Avisos tono="info" avisos={plan.avisos} />}

          {plan.servicios.length > 0 && (
            <p className="text-xs leading-5 text-subtle">
              Al pasar se volverán a desplegar: {plan.servicios.map((s) => s.nombre).join(', ')}. Antes, en la preparación, no se despliega
              nada.
            </p>
          )}

          <div className="flex justify-end pt-1">
            <Button
              onClick={() => preparar.mutate()}
              loading={preparar.isPending}
              disabled={plan.bloqueos.length > 0 || calcular.isPending}
              className="max-sm:h-11 max-sm:w-full"
            >
              Preparar {destino}
            </Button>
          </div>
        </div>
      )}
      {desfasado && <Aviso tono="info">Los dominios han cambiado: pulsa «Ver qué cambia» para calcular el cambio de nuevo.</Aviso>}
    </div>
  );
}

/** «Variables: 7 cambios en 2 servicios», con una casilla por variable y sus notas. */
function Variables({
  plan,
  ocupado,
  onAlternar,
}: {
  plan: PlanSkyway;
  ocupado: boolean;
  onAlternar: (c: Clave, aplicar: boolean) => void;
}) {
  const { cambios, notas, wordpress } = plan.variables;
  const aplicados = cambios.filter((c) => !c.excluida);
  const servicios = new Set(aplicados.filter((c) => c.serviceId).map((c) => c.serviceId));
  for (const w of wordpress) servicios.add(w.serviceId);
  const compartidas = aplicados.some((c) => c.ambito === 'project');
  const donde = [servicios.size > 0 ? contar(servicios.size, 'servicio', 'servicios') : null, compartidas ? 'las compartidas' : null]
    .filter(Boolean)
    .join(' y ');
  const notasSueltas = useMemo(
    () => notas.filter((n) => !cambios.some((c) => c.ambito === n.ambito && c.serviceId === n.serviceId && c.key === n.key)),
    [notas, cambios],
  );
  const total = aplicados.length + wordpress.length;
  return (
    <Desplegable
      titulo={
        total > 0 ? `Variables: ${contar(total, 'cambio', 'cambios')} en ${donde}` : 'Variables: ninguna cambia'
      }
      detalle={
        notas.length > 0
          ? `${contar(notas.length, 'mención', 'menciones')} de ${plan.fromDomain} no se ${notas.length === 1 ? 'cambia' : 'cambian'}: revísalas.`
          : 'Solo cambian los nombres que sirve este proyecto y las direcciones que se mudan.'
      }
    >
      {cambios.length + wordpress.length + notasSueltas.length > 0 && (
        <ul className="flex flex-col divide-y divide-line">
          {cambios.map((c) => {
            const propias = notas.filter((n) => n.ambito === c.ambito && n.serviceId === c.serviceId && n.key === c.key);
            return (
              <li key={`${c.ambito}:${c.serviceId}:${c.key}`} className="py-2 first:pt-0 last:pb-0">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0 accent-acc"
                    checked={!c.excluida}
                    disabled={ocupado}
                    onChange={(e) => onAlternar({ ambito: c.ambito, serviceId: c.serviceId, key: c.key }, e.target.checked)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-1.5 text-sm">
                      <span className="break-all font-mono font-medium text-txt">{c.key}</span>
                      <span className="text-xs text-subtle">
                        · {c.ambito === 'project' ? ROTULO_AMBITO.project : `${c.serviceName ?? '?'}${c.ambito === 'build' ? ` (${ROTULO_AMBITO.build.toLowerCase()})` : ''}`}
                      </span>
                    </span>
                    {c.antes !== null && c.despues !== null ? (
                      <span className="mt-1 block break-all font-mono text-xs leading-5">
                        <span className="text-subtle line-through decoration-subtle/60">{c.antes}</span>
                        <br />
                        <span className="text-sub">{c.despues}</span>
                      </span>
                    ) : (
                      <span className="mt-1 block text-xs text-subtle">
                        Argumento de compilación: su valor no se muestra. {contar(c.ocurrencias, 'cambio', 'cambios')}.
                      </span>
                    )}
                    {propias.map((n) => (
                      <span key={n.texto} className="mt-1 block text-xs leading-5 text-subtle">
                        {n.texto}
                      </span>
                    ))}
                  </span>
                </label>
              </li>
            );
          })}
          {wordpress.map((w) => (
            <li key={`wp:${w.serviceId}`} className="py-2 text-xs leading-5 text-sub first:pt-0 last:pb-0">
              <span className="font-mono font-medium text-txt">WORDPRESS_CONFIG_EXTRA</span> · {w.serviceName}: se fija la URL{' '}
              <span className="break-all font-mono">{w.url}</span>. Sin ello, WordPress redirigiría a su URL anterior.
            </li>
          ))}
          {notasSueltas.map((n) => (
            <li key={`${n.ambito}:${n.serviceId}:${n.key}:${n.texto}`} className="py-2 text-xs leading-5 text-subtle first:pt-0 last:pb-0">
              {n.texto}
            </li>
          ))}
        </ul>
      )}
    </Desplegable>
  );
}
