import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  BookOpen,
  ChevronDown,
  ExternalLink,
  Info,
  LifeBuoy,
  Search,
  SendHorizontal,
  Stethoscope,
  X,
} from 'lucide-react';
import { api } from '../api';
import { Chip, ErrorState, PageHeader, Skeleton, Spinner } from '../components/ui';
import { matchesSearch, parseRichText, RichSpan } from '../helpText';
import { AskResponse, FaqCategory, FaqEntry, HelpIssue, HelpLink, IssueSeverity, Project } from '../types';
import { cx, EMPTY_LIST, SEVERITY_LABEL } from '../utils';

// ---------- piezas de texto ----------

function Spans({ spans }: { spans: RichSpan[] }) {
  return (
    <>
      {spans.map((s, i) =>
        s.bold ? (
          <strong key={i} className="font-semibold text-txt">
            {s.text}
          </strong>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

/** Respuesta del asistente en su Markdown mínimo: párrafos, listas y negritas. Nunca HTML. */
function RichText({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseRichText(text), [text]);
  return (
    <div className={cx('flex flex-col gap-2 text-sm leading-relaxed text-sub', className)}>
      {blocks.map((b, i) =>
        b.kind === 'ul' ? (
          <ul key={i} className="flex flex-col gap-1 pl-4">
            {b.items.map((item, j) => (
              <li key={j} className="list-disc marker:text-subtle">
                <Spans spans={item} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={i}>
            {b.lines.map((line, j) => (
              <span key={j}>
                {j > 0 && <br />}
                <Spans spans={line} />
              </span>
            ))}
          </p>
        ),
      )}
    </div>
  );
}

/** Enlace de la ayuda: interno con el router, externo en pestaña nueva. */
function HelpLinkButton({ link, small }: { link: HelpLink; small?: boolean }) {
  const cls = cx(
    'press inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface font-medium text-txt transition-colors hover:border-line2 hover:bg-surface2',
    small ? 'h-8 px-2.5 text-xs max-sm:h-10' : 'h-9 px-3 text-xs max-sm:h-11',
  );
  if (link.to.startsWith('/')) {
    return (
      <Link to={link.to} className={cls}>
        {link.label}
      </Link>
    );
  }
  return (
    <a href={link.to} target="_blank" rel="noreferrer" className={cls}>
      {link.label} <ExternalLink size={11} className="text-subtle" aria-hidden />
    </a>
  );
}

function LinkRow({ links, small }: { links: HelpLink[] | undefined; small?: boolean }) {
  if (!links || links.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {links.map((l) => (
        <HelpLinkButton key={`${l.to}|${l.label}`} link={l} small={small} />
      ))}
    </div>
  );
}

// ---------- problemas detectados ----------

const ISSUE_TONE: Record<IssueSeverity, { box: string; rail: string; title: string; Icon: typeof AlertTriangle }> = {
  critical: { box: 'border-err/40 bg-err/[.06]', rail: 'bg-err', title: 'text-err', Icon: AlertTriangle },
  warning: { box: 'border-warn/35 bg-warn/[.06]', rail: 'bg-warn', title: 'text-warn', Icon: AlertTriangle },
  info: { box: 'border-line bg-surface2/60', rail: 'bg-line2', title: 'text-txt', Icon: Info },
};

function IssueCard({ issue }: { issue: HelpIssue }) {
  const tone = ISSUE_TONE[issue.severity] ?? ISSUE_TONE.info;
  return (
    <article className={cx('relative overflow-hidden rounded-xl border p-3.5 text-xs', tone.box)}>
      <span aria-hidden className={cx('absolute inset-y-0 left-0 w-[3px]', tone.rail)} />
      <p className={cx('flex items-start gap-1.5 text-sm font-semibold leading-snug', tone.title)}>
        <tone.Icon size={14} className="mt-0.5 shrink-0" aria-hidden />
        <span className="min-w-0">{issue.title}</span>
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-subtle">
        <span className="font-semibold">{SEVERITY_LABEL[issue.severity]}</span>
        <span className="text-line">·</span>
        <span className="min-w-0 truncate">
          {issue.serviceName} <span className="text-line">en</span> {issue.projectName}
        </span>
      </p>
      <p className="mt-2 leading-relaxed text-sub">{issue.cause}</p>
      <p className="mt-1.5 leading-relaxed">
        <span className="font-semibold text-ok">Cómo arreglarlo: </span>
        <span className="text-sub">{issue.fix}</span>
      </p>
      {issue.evidence && (
        <pre className="mt-2 overflow-hidden whitespace-pre-wrap break-all rounded-md bg-term px-2.5 py-1.5 font-mono text-micro leading-4 text-sub">
          {issue.evidence}
        </pre>
      )}
      <div className="mt-2.5">
        <LinkRow links={issue.links} small />
      </div>
    </article>
  );
}

// ---------- entradas de la FAQ ----------

function FaqItem({ entry, categoryLabel, defaultOpen }: { entry: FaqEntry; categoryLabel?: string; defaultOpen?: boolean }) {
  return (
    <details className="group rounded-lg border border-line bg-surface" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-2.5 text-sm text-txt max-sm:min-h-11">
        <span className="min-w-0 flex-1 font-medium leading-snug">{entry.question}</span>
        {categoryLabel && <span className="hidden shrink-0 text-micro text-subtle sm:inline">{categoryLabel}</span>}
        <ChevronDown size={14} className="shrink-0 text-subtle transition-transform duration-200 group-open:rotate-180" aria-hidden />
      </summary>
      <div className="flex flex-col gap-2.5 border-t border-line px-3.5 py-3">
        <RichText text={entry.answer} className="text-xs" />
        <LinkRow links={entry.links} small />
      </div>
    </details>
  );
}

// ---------- hilo del asistente ----------

type Action = { kind: 'ask'; question: string; serviceId: string } | { kind: 'scan'; serviceId: string };

interface Msg {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  response?: AskResponse;
  /** Resultado de «Detectar errores»: solo problemas, sin FAQ. */
  issues?: HelpIssue[];
  pending?: boolean;
  error?: string;
  /** Lo que generó este mensaje, para poder reintentarlo. */
  action?: Action;
}

const STARTERS = ['Mi despliegue falla', '¿Cómo añado un dominio?', '¿Cómo importo mi .env?'];
const DETECT_LABEL = 'Detectar errores';

interface ServiceOption {
  id: string;
  name: string;
  projectName: string;
}

function AssistantMessage({ msg, onRetry }: { msg: Msg; onRetry: (msg: Msg) => void }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-acc/[.15] text-acc-soft">
        <LifeBuoy size={14} aria-hidden />
      </span>
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-line bg-surface px-3.5 py-3">
        {msg.pending ? (
          // El Spinner trae el relleno de una página entera: aquí es una línea.
          <div className="-my-7" aria-busy>
            <Spinner label={msg.action?.kind === 'scan' ? 'Revisando servicios…' : 'Pensando…'} />
          </div>
        ) : msg.error ? (
          <ErrorState
            compact
            title={msg.action?.kind === 'scan' ? 'No se han podido revisar los servicios' : 'No se ha podido responder'}
            error={msg.error}
            onRetry={() => onRetry(msg)}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {msg.text && <RichText text={msg.text} />}
            {msg.response?.issues && msg.response.issues.length > 0 && (
              <div className="flex flex-col gap-2">
                {msg.response.issues.map((i) => (
                  <IssueCard key={`${i.serviceId}:${i.id}`} issue={i} />
                ))}
              </div>
            )}
            {msg.issues && msg.issues.length > 0 && (
              <div className="flex flex-col gap-2">
                {msg.issues.map((i) => (
                  <IssueCard key={`${i.serviceId}:${i.id}`} issue={i} />
                ))}
              </div>
            )}
            {msg.response?.matches && msg.response.matches.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <p className="eyebrow text-subtle">Preguntas relacionadas</p>
                {msg.response.matches.map((m) => (
                  <FaqItem key={m.id} entry={m} />
                ))}
              </div>
            )}
            <LinkRow links={msg.response?.links} small />
          </div>
        )}
      </div>
    </div>
  );
}

export default function HelpPage() {
  const [searchParams] = useSearchParams();

  // Servicios a los que llega quien pregunta: los mismos proyectos del panel.
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: Project[] }>('/projects'),
    staleTime: 30_000,
  });
  const services = useMemo<ServiceOption[]>(() => {
    const list = projects.data?.projects ?? EMPTY_LIST;
    return list
      .flatMap((p) => (p.services ?? []).map((s) => ({ id: s.id, name: s.name, projectName: p.name })))
      .sort((a, b) => a.projectName.localeCompare(b.projectName, 'es') || a.name.localeCompare(b.name, 'es'));
  }, [projects.data]);

  const [serviceId, setServiceId] = useState(() => searchParams.get('service') ?? '');
  // Con un solo servicio no hay nada que elegir: se preselecciona una vez, y si
  // luego alguien lo quita a mano no se le vuelve a poner.
  const autoPicked = useRef(false);
  useEffect(() => {
    if (autoPicked.current || !projects.data) return;
    autoPicked.current = true;
    if (!serviceId && services.length === 1) setServiceId(services[0].id);
  }, [projects.data, services, serviceId]);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const idRef = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const patch = (id: number, changes: Partial<Msg>) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...changes } : m)));

  const run = useCallback(async (action: Action, msgId: number) => {
    patch(msgId, { pending: true, error: undefined });
    try {
      if (action.kind === 'ask') {
        const res = await api.post<AskResponse>('/help/ask', {
          question: action.question,
          ...(action.serviceId ? { serviceId: action.serviceId } : {}),
        });
        patch(msgId, { pending: false, text: res.answer, response: res });
      } else {
        const qs = action.serviceId ? `?serviceId=${encodeURIComponent(action.serviceId)}` : '';
        const res = await api.get<{ issues: HelpIssue[]; scanned: number }>(`/help/issues${qs}`);
        const n = res.scanned;
        const revisado = n === 1 ? 'He revisado 1 servicio' : `He revisado ${n} servicios`;
        const text =
          res.issues.length === 0
            ? `${revisado} y no he encontrado nada llamativo. Si algo falla igualmente, cuéntame qué ves (un error, un 502, que no arranca…) y lo miro con más detalle.`
            : `${revisado} y he encontrado ${res.issues.length === 1 ? '1 problema' : `${res.issues.length} problemas`}. Empieza por el más grave:`;
        patch(msgId, { pending: false, text, issues: res.issues });
      }
    } catch (err) {
      patch(msgId, { pending: false, error: err instanceof Error ? err.message : 'Error desconocido' });
    }
  }, []);

  const send = useCallback(
    (question: string) => {
      const q = question.trim();
      if (!q) return;
      const action: Action = q.toLowerCase() === DETECT_LABEL.toLowerCase() ? { kind: 'scan', serviceId } : { kind: 'ask', question: q, serviceId };
      const userId = ++idRef.current;
      const botId = ++idRef.current;
      setMessages((prev) => [
        ...prev,
        { id: userId, role: 'user', text: q },
        { id: botId, role: 'assistant', text: '', pending: true, action },
      ]);
      setDraft('');
      void run(action, botId);
    },
    [run, serviceId],
  );

  // Enlace profundo: /help?service=ID&q=pregunta lanza la pregunta al entrar.
  const launched = useRef(false);
  useEffect(() => {
    if (launched.current) return;
    launched.current = true;
    const q = searchParams.get('q');
    if (q) send(q);
    // Solo al montar: la pregunta de la URL se hace una vez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // El hilo crece hacia abajo: lo último que llega queda a la vista.
  const count = messages.length;
  useEffect(() => {
    if (count > 0) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [count]);

  // ---------- FAQ ----------
  const faq = useQuery({
    queryKey: ['help', 'faq'],
    queryFn: () => api.get<{ categories: { key: FaqCategory; label: string }[]; entries: FaqEntry[] }>('/help/faq'),
    staleTime: 300_000,
  });
  const [faqQuery, setFaqQuery] = useState('');
  const [category, setCategory] = useState<FaqCategory | 'all'>('all');
  const categories = faq.data?.categories ?? EMPTY_LIST;
  const entries = faq.data?.entries ?? EMPTY_LIST;
  const categoryLabel = useMemo(() => Object.fromEntries(categories.map((c) => [c.key, c.label])), [categories]);
  const filteredFaq = useMemo(
    () =>
      entries.filter(
        (e) => (category === 'all' || e.category === category) && matchesSearch(faqQuery, e.question, e.keywords, e.answer),
      ),
    [entries, category, faqQuery],
  );
  const searching = faqQuery.trim().length > 0;

  const selectedService = services.find((s) => s.id === serviceId);

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-5 px-4 py-7 sm:px-6 sm:py-10">
      <PageHeader
        title="Ayuda"
        description="Pregunta en tus palabras, deja que el asistente revise tus servicios cuando algo falla y consulta las preguntas frecuentes."
      />

      {/* Móvil: asistente arriba y FAQ debajo. Escritorio: dos columnas. */}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* ── Asistente ── */}
        <section className="card flex min-w-0 flex-col" aria-label="Asistente">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-base font-semibold text-txt">
                <LifeBuoy size={16} className="text-acc-soft" aria-hidden /> Asistente
              </h2>
              <p className="mt-0.5 text-xs leading-5 text-subtle">
                Responde con la documentación y, si eliges un servicio, con sus despliegues y logs.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-4 px-4 py-4">
            {messages.length === 0 ? (
              <div className="flex flex-col gap-3 rounded-xl border border-dashed border-line px-4 py-5 text-center">
                <p className="text-sm text-sub">¿Por dónde empezamos?</p>
                <p className="text-xs leading-5 text-subtle">
                  Prueba con una de estas preguntas o escribe la tuya. Con «Detectar errores» reviso el estado, el último
                  despliegue y los logs.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3.5" role="log" aria-live="polite">
                {messages.map((m) =>
                  m.role === 'user' ? (
                    <div key={m.id} className="flex justify-end">
                      <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-acc/[.16] px-3.5 py-2 text-sm leading-relaxed text-txt">
                        {m.text}
                      </p>
                    </div>
                  ) : (
                    <AssistantMessage key={m.id} msg={m} onRetry={(msg) => msg.action && void run(msg.action, msg.id)} />
                  ),
                )}
                <div ref={endRef} />
              </div>
            )}

            {/* Chips de arranque: siempre a mano, también con el hilo empezado. */}
            <div className="flex flex-wrap gap-1.5">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  className="press rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-medium text-sub transition-colors hover:border-acc/50 hover:text-txt max-sm:min-h-10"
                >
                  {s}
                </button>
              ))}
              <button
                type="button"
                onClick={() => send(DETECT_LABEL)}
                className="press inline-flex items-center gap-1.5 rounded-full border border-acc/40 bg-acc/[.10] px-3 py-1.5 text-xs font-semibold text-acc-soft transition-colors hover:bg-acc/[.16] max-sm:min-h-10"
                title={selectedService ? `Revisar ${selectedService.name}` : 'Revisar todos tus servicios'}
              >
                <Stethoscope size={13} aria-hidden /> {DETECT_LABEL}
              </button>
            </div>

            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                send(draft);
              }}
            >
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-sub">Servicio (opcional)</span>
                <select className="input" value={serviceId} onChange={(e) => setServiceId(e.target.value)} disabled={projects.isLoading}>
                  <option value="">{services.length === 0 && !projects.isLoading ? 'Sin servicios en tus proyectos' : 'Todos mis servicios'}</option>
                  {services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {s.projectName}
                    </option>
                  ))}
                  {/* Un id de la URL que no está en la lista se conserva: el servidor dirá si existe. */}
                  {serviceId && !selectedService && <option value={serviceId}>Servicio {serviceId.slice(0, 8)}…</option>}
                </select>
              </label>
              <div className="flex gap-2">
                <input
                  ref={inputRef}
                  className="input min-w-0 flex-1 max-sm:h-11"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Escribe tu pregunta y pulsa Enter…"
                  maxLength={500}
                  enterKeyHint="send"
                  autoComplete="off"
                  aria-label="Pregunta para el asistente"
                />
                <button
                  type="submit"
                  disabled={!draft.trim()}
                  className="press flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-acc text-white transition-[filter] hover:brightness-[1.12] disabled:cursor-not-allowed disabled:opacity-45 max-sm:h-11 max-sm:w-11"
                  title="Enviar"
                  aria-label="Enviar pregunta"
                >
                  <SendHorizontal size={15} aria-hidden />
                </button>
              </div>
              <p className="text-micro text-subtle">
                El asistente es determinista: se basa en la documentación y en lo que ve de tus servicios, sin enviar nada fuera.
              </p>
            </form>
          </div>
        </section>

        {/* ── Preguntas frecuentes ── */}
        <section className="card flex min-w-0 flex-col" aria-label="Preguntas frecuentes">
          <div className="border-b border-line px-4 py-3">
            <h2 className="flex items-center gap-2 text-base font-semibold text-txt">
              <BookOpen size={16} className="text-sub" aria-hidden /> Preguntas frecuentes
            </h2>
            <p className="mt-0.5 text-xs leading-5 text-subtle">Lo que más se pregunta, con el enlace a donde se arregla.</p>
          </div>

          <div className="flex flex-col gap-3 px-4 py-4">
            <div className="flex h-9 items-center gap-2 rounded-lg border border-line bg-bg px-2.5 focus-within:border-acc max-sm:h-11">
              <Search size={13} className="shrink-0 text-subtle" aria-hidden />
              <input
                value={faqQuery}
                onChange={(e) => setFaqQuery(e.target.value)}
                placeholder="Buscar en las preguntas…"
                className="min-w-0 flex-1 bg-transparent text-sm text-txt outline-none placeholder:text-subtle"
                aria-label="Buscar en las preguntas frecuentes"
                autoComplete="off"
              />
              {faqQuery && (
                <button type="button" onClick={() => setFaqQuery('')} className="press p-1 text-subtle hover:text-txt" aria-label="Borrar búsqueda">
                  <X size={13} />
                </button>
              )}
            </div>

            {categories.length > 0 && (
              <div className="flex flex-wrap gap-1" role="group" aria-label="Categorías">
                <Chip onClick={() => setCategory('all')} active={category === 'all'}>
                  Todas
                </Chip>
                {categories.map((c) => (
                  <Chip key={c.key} onClick={() => setCategory(c.key)} active={category === c.key}>
                    {c.label}
                  </Chip>
                ))}
              </div>
            )}

            {faq.isLoading && (
              <div aria-busy className="flex flex-col gap-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-11 w-full rounded-lg" />
                ))}
              </div>
            )}

            {faq.isError && (
              <ErrorState
                compact
                title="No se han podido cargar las preguntas"
                error={faq.error}
                onRetry={() => faq.refetch()}
                retrying={faq.isFetching}
              />
            )}

            {faq.data && filteredFaq.length === 0 && (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-4 py-8 text-center text-xs text-subtle">
                <p>Ninguna pregunta coincide{searching ? ` con «${faqQuery.trim()}»` : ''}.</p>
                <button
                  type="button"
                  onClick={() => {
                    setFaqQuery('');
                    setCategory('all');
                    inputRef.current?.focus();
                    if (searching) setDraft(faqQuery.trim());
                  }}
                  className="tap font-semibold text-acc-soft hover:underline"
                >
                  {searching ? 'Pregúntaselo al asistente →' : 'Quitar filtros'}
                </button>
              </div>
            )}

            {faq.data && filteredFaq.length > 0 && (
              <div className="flex flex-col gap-3">
                {category === 'all' && !searching ? (
                  // Sin filtro, agrupadas por tema: se ve de un vistazo qué cubre la ayuda.
                  categories.map((c) => {
                    const group = filteredFaq.filter((e) => e.category === c.key);
                    if (group.length === 0) return null;
                    return (
                      <div key={c.key} className="flex flex-col gap-1.5">
                        <p className="eyebrow text-subtle">{c.label}</p>
                        {group.map((e) => (
                          <FaqItem key={e.id} entry={e} />
                        ))}
                      </div>
                    );
                  })
                ) : (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs text-subtle">
                      {filteredFaq.length === 1 ? '1 pregunta' : `${filteredFaq.length} preguntas`}
                    </p>
                    {filteredFaq.map((e) => (
                      <FaqItem key={e.id} entry={e} categoryLabel={categoryLabel[e.category]} defaultOpen={searching && filteredFaq.length <= 2} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
