import { FastifyRequest } from 'fastify';
import { canAccessProjectRow, currentUser } from '../auth';
import { getDeployment, getProject, getService, latestDeployment, listProjects, listServicesForProjects } from '../db';
import { diagnose, explainExitCode } from '../deploy/diagnose';
import { containerName, fetchLogsBefore } from '../docker/containers';
import { dockerSnapshot, runtimeIn, sampleIn } from '../docker/sampler';
import { Diagnosis, ProjectRow, ServiceRow, UserRow } from '../types';
import { resolveServiceEnv } from '../variables';
import { FAQ } from './faq';
import { detectRuntimeIssues, toEvidence } from './runtime';
import { AskResponse, FaqEntry, HelpIssue, HelpLink, IssueSeverity } from './types';

/**
 * Asistente determinista del centro de ayuda: busca en las FAQ y revisa el
 * estado real de los servicios del usuario (último despliegue, contenedor,
 * variables y logs). Sin LLM a propósito: la respuesta sale de lo que Skyway ya
 * sabe y siempre es la misma para la misma situación, que es lo que hace falta
 * para poder confiar en ella y probarla.
 */

/** Antigüedad tolerada de la foto de Docker (la misma que las lecturas del panel). */
const PANEL_MAX_AGE_MS = 4000;
/** Líneas de la cola de logs que se revisan en un escaneo profundo. */
const LOG_TAIL = 300;
/** Tope de servicios en un escaneo ligero: más de esto ya no es una consulta del panel. */
export const MAX_SCAN = 60;
/** Puntuación mínima para que una FAQ cuente como coincidencia. */
const MIN_SCORE = 2;

// ---------- normalización y búsqueda en las FAQ ----------

/**
 * Palabras que no discriminan nada («como», «puedo», «que»…). Se filtran antes
 * de puntuar; sin esto, «¿Cómo puedo…?» casaba con todas las preguntas.
 */
const STOPWORDS = new Set(
  (
    'como que por para con sin una uno unos unas los las del mis tus sus hay esta este esto estos estas estan ' +
    'puedo puede pueden hacer hago hace tengo tiene tienen quiero quiere cuando donde cual cuales desde hasta ' +
    'sobre entre pero mas muy algo alguien nada todo todos todas ser soy son era fue sido estoy ver veo sea sean ' +
    'aqui ahi alli ahora aun cada otro otra otros otras tambien porque mientras tras dice decir sigue saber ' +
    'the and for with how what why does not can you your'
  ).split(' '),
);

/**
 * Raíz tosca: quita una `s` final (plural) y después una `e` final. Aplicada
 * igual a la pregunta y al corpus, junta «despliegue/despliegues» (→ despliegu),
 * «variable/variables» (→ variabl) y «error/errores» (→ error) sin tabla de
 * excepciones.
 */
function stem(token: string): string {
  let t = token;
  if (t.length > 3 && t.endsWith('s')) t = t.slice(0, -1);
  if (t.length > 4 && t.endsWith('e')) t = t.slice(0, -1);
  return t;
}

/** Minúsculas, sin acentos, sin palabras vacías; tokens de ≥ 3 caracteres ya reducidos a su raíz. */
export function normalizeText(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .map(stem);
}

/** Minúsculas y sin acentos, sin tokenizar: para comparar frases enteras. */
function plain(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

interface FaqIndexEntry {
  entry: FaqEntry;
  question: Set<string>;
  keywords: Set<string>;
  /**
   * Palabras clave de más de una palabra, tal cual («no arranca», «bad
   * gateway»): la tokenización pierde el «no» y con él la negación, así que se
   * buscan además como frase dentro de la pregunta.
   */
  phrases: string[];
  answer: Set<string>;
}

let faqIndex: FaqIndexEntry[] | null = null;

function indexFaq(): FaqIndexEntry[] {
  faqIndex ??= FAQ.map((entry) => ({
    entry,
    question: new Set(normalizeText(entry.question)),
    keywords: new Set(normalizeText(entry.keywords.join(' '))),
    phrases: entry.keywords.filter((k) => k.includes(' ')).map((k) => plain(k)),
    answer: new Set(normalizeText(entry.answer)),
  }));
  return faqIndex;
}

/** Puntos por una palabra clave de varias palabras que aparece literal en la pregunta. */
const PHRASE_BONUS = 4;

/**
 * Busca en las FAQ por tokens: 3 puntos por cada token de la pregunta que
 * aparece en el título, 2 si está en las palabras clave y 1 si está en la
 * respuesta (acumulables), más un bono por cada palabra clave de varias
 * palabras que aparezca entera. Devuelve hasta `limit`, de más a menos relevante.
 */
export function searchFaq(question: string, limit = 3): FaqEntry[] {
  const tokens = [...new Set(normalizeText(question))];
  if (tokens.length === 0) return [];
  const text = plain(question);
  const scored = indexFaq()
    .map((ix, order) => {
      let score = 0;
      for (const t of tokens) {
        if (ix.question.has(t)) score += 3;
        if (ix.keywords.has(t)) score += 2;
        if (ix.answer.has(t)) score += 1;
      }
      for (const phrase of ix.phrases) if (text.includes(phrase)) score += PHRASE_BONUS;
      return { entry: ix.entry, score, order };
    })
    .filter((s) => s.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, limit).map((s) => s.entry);
}

// ---------- detección de problemas de un servicio ----------

interface ServiceCtx {
  service: ServiceRow;
  project: ProjectRow;
}

type DrawerTab = 'logs' | 'deployments' | 'variables' | 'settings' | 'metrics' | 'backups' | 'files' | 'db';

function drawerLink(ctx: ServiceCtx, tab: DrawerTab | null, label: string): HelpLink {
  const to = `/projects/${ctx.project.id}?s=${ctx.service.id}${tab ? `&tab=${tab}` : ''}`;
  return { label, to };
}

const SEVERITY_RANK: Record<IssueSeverity, number> = { critical: 0, warning: 1, info: 2 };

function issue(
  ctx: ServiceCtx,
  fields: Pick<HelpIssue, 'id' | 'severity' | 'title' | 'cause' | 'fix' | 'links'> & { evidence?: string },
): HelpIssue {
  return {
    serviceId: ctx.service.id,
    serviceName: ctx.service.name,
    projectId: ctx.project.id,
    projectName: ctx.project.name,
    ...fields,
  };
}

function parseDiagnosis(raw: string | null): Diagnosis | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<Diagnosis>;
    if (d && typeof d.id === 'string' && typeof d.title === 'string') {
      return { id: d.id, title: d.title, cause: d.cause ?? '', fix: d.fix ?? '' };
    }
  } catch {
    /* diagnóstico corrupto: se recalcula abajo */
  }
  return null;
}

/** Referencias `${{…}}` que quedaron literales tras resolver el entorno. */
const REF_LITERAL = /\$\{\{[^}]*\}\}/g;

/**
 * `envImport.pending` de la config del servicio, leído a la defensiva: lo
 * escribe el importador de .env y puede no existir (servicios anteriores,
 * bases de datos, imágenes).
 */
function envImportPending(config: unknown): string[] {
  const pending = (config as { envImport?: { pending?: unknown } } | null)?.envImport?.pending;
  if (!Array.isArray(pending)) return [];
  return pending
    .map((p) => (p && typeof p === 'object' ? (p as { key?: unknown }).key : undefined))
    .filter((k): k is string => typeof k === 'string' && k.length > 0);
}

/**
 * Revisa un servicio y devuelve lo que encuentre, de más grave a menos:
 * último despliegue fallido (con su diagnóstico), estado del contenedor,
 * referencias sin resolver y variables pendientes de valor; con `deep`, además
 * la cola de logs de la aplicación pasada por las reglas de `runtime.ts`.
 * Sin Docker se limita a lo que está en la base de datos: no inventa estados.
 */
export async function detectServiceIssues(service: ServiceRow, opts: { deep: boolean }): Promise<HelpIssue[]> {
  const project = getProject(service.project_id);
  if (!project) return [];
  const ctx: ServiceCtx = { service, project };
  const issues: HelpIssue[] = [];

  // 1. Último despliegue fallido → diagnóstico guardado o recalculado.
  const last = latestDeployment(service.id);
  if (last?.status === 'failed') {
    let diag = parseDiagnosis(last.diagnosis);
    if (!diag) {
      // El listado no trae el log: se lee la fila entera solo en este caso.
      const full = getDeployment(last.id);
      diag = diagnose(full?.error ?? last.error, full?.logs ?? '');
    }
    if (diag) {
      issues.push(
        issue(ctx, {
          id: `deploy-failed:${diag.id}`,
          severity: 'critical',
          title: diag.title,
          cause: diag.cause,
          fix: diag.fix,
          evidence: last.error ? toEvidence(last.error) : undefined,
          links: [drawerLink(ctx, 'deployments', 'Ver despliegue'), drawerLink(ctx, 'logs', 'Ver registro')],
        }),
      );
    }
  }

  // 2. Estado en runtime, de la misma foto que usa el panel.
  const snap = await dockerSnapshot(PANEL_MAX_AGE_MS);
  let containerExists = false;
  let startedAt: string | null = null;
  if (snap.docker) {
    const sample = sampleIn(snap, service.id);
    const runtime = runtimeIn(snap, service.id);
    containerExists = sample.state !== 'not_created' && sample.state !== 'unknown';
    startedAt = runtime.startedAt;
    const stoppedByHand = !!service.stopped_at;
    switch (sample.state) {
      case 'restarting':
        issues.push(
          issue(ctx, {
            id: 'container:restarting',
            severity: 'critical',
            title: 'El servicio se reinicia en bucle',
            cause: `El proceso finaliza nada más arrancar y Docker lo vuelve a iniciar repetidamente. ${explainExitCode(runtime.exitCode)}`,
            fix: 'Consulte las últimas líneas de la pestaña «Logs»: la excepción que provoca el cierre aparece justo antes de cada reinicio. Suele deberse a una variable que falta, una conexión con la base de datos que no se establece o un puerto interno incorrecto.',
            links: [drawerLink(ctx, 'logs', 'Ver registro'), drawerLink(ctx, 'variables', 'Revisar variables')],
          }),
        );
        break;
      case 'exited':
      case 'dead':
        if (stoppedByHand) {
          issues.push(
            issue(ctx, {
              id: 'container:stopped',
              severity: 'info',
              title: 'El servicio está detenido manualmente',
              cause: 'Se pulsó «Detener»: el contenedor conserva su imagen, variables y volúmenes, pero no atiende peticiones ni genera alertas.',
              fix: 'Pulse «Iniciar» en la cabecera del servicio para que vuelva a estar en servicio.',
              links: [drawerLink(ctx, null, 'Abrir servicio')],
            }),
          );
        } else {
          issues.push(
            issue(ctx, {
              id: 'container:exited',
              severity: 'critical',
              title: 'El servicio está caído',
              cause: `El contenedor finalizó y no se ha vuelto a iniciar. ${explainExitCode(runtime.exitCode)}`,
              fix: 'Consulte la pestaña «Logs» para ver con qué error finalizó; corrija la causa (variables, conexiones, memoria) y pulse «Iniciar» o «Desplegar».',
              links: [drawerLink(ctx, 'logs', 'Ver registro'), drawerLink(ctx, null, 'Abrir servicio')],
            }),
          );
        }
        break;
      case 'paused':
        issues.push(
          issue(ctx, {
            id: 'container:paused',
            severity: 'warning',
            title: 'El contenedor está pausado',
            cause: 'Docker mantiene el contenedor en pausa: el proceso existe pero no ejecuta nada ni responde.',
            fix: 'Pulse «Reiniciar» en la cabecera del servicio para que vuelva a ejecutarse.',
            links: [drawerLink(ctx, null, 'Abrir servicio')],
          }),
        );
        break;
      case 'created':
        issues.push(
          issue(ctx, {
            id: 'container:created',
            severity: 'warning',
            title: 'El contenedor existe pero no llegó a arrancar',
            cause: 'Docker creó el contenedor y el arranque no se completó (un fallo en el propio arranque o un despliegue interrumpido).',
            fix: 'Pulse «Desplegar» para recrearlo; si se repite, el registro del despliegue indicará por qué no arranca.',
            links: [drawerLink(ctx, 'deployments', 'Ver despliegues')],
          }),
        );
        break;
      case 'running':
        if (sample.replicas.total > 1 && sample.replicas.running < sample.replicas.total) {
          issues.push(
            issue(ctx, {
              id: 'container:replicas-down',
              severity: 'warning',
              title: `Solo ${sample.replicas.running} de ${sample.replicas.total} réplicas están en marcha`,
              cause: 'Alguna réplica ha finalizado y no se ha recuperado. El servicio sigue en funcionamiento con menos capacidad.',
              fix: 'En la pestaña «Logs», filtre por la réplica caída ([r2], [r3]…) para ver con qué error finalizó, y pulse «Reiniciar» para iniciarlas todas.',
              links: [drawerLink(ctx, 'logs', 'Ver registro')],
            }),
          );
        }
        if (runtime.restartCount >= 3) {
          issues.push(
            issue(ctx, {
              id: 'container:restarts',
              severity: 'warning',
              title: `Docker ha reiniciado el servicio ${runtime.restartCount} veces`,
              cause: 'El contenedor está en ejecución en este momento, pero se ha caído varias veces desde que se creó: hay una causa intermitente (memoria, una excepción esporádica, una dependencia que deja de responder).',
              fix: 'Revise la pestaña «Logs» en torno a cada reinicio y la pestaña «Métricas» para comprobar si la memoria alcanza el límite antes de cada caída.',
              links: [drawerLink(ctx, 'logs', 'Ver registro'), drawerLink(ctx, 'metrics', 'Ver métricas')],
            }),
          );
        }
        break;
      case 'not_created':
        // Desplegó bien, nadie lo paró y el contenedor no está: alguien lo quitó por fuera.
        if (last?.status === 'success' && !stoppedByHand) {
          issues.push(
            issue(ctx, {
              id: 'container:missing',
              severity: 'warning',
              title: 'El contenedor ya no existe',
              cause: 'El último despliegue finalizó correctamente, pero el contenedor no existe en Docker: se eliminó fuera del panel o se limpió el servidor.',
              fix: 'Pulse «Desplegar»: se reutiliza la imagen del último despliegue correcto y el contenedor se recrea en unos segundos.',
              links: [drawerLink(ctx, 'deployments', 'Ver despliegues')],
            }),
          );
        }
        break;
      default:
        break;
    }
  }

  // 3. Referencias `${{…}}` que no resolvieron a nada: llegan literales al contenedor.
  const unresolved: string[] = [];
  for (const [key, value] of Object.entries(resolveServiceEnv(service))) {
    const refs = value.match(REF_LITERAL);
    // Solo la clave y la referencia: el resto del valor puede ser un secreto.
    if (refs) unresolved.push(`${key} → ${[...new Set(refs)].join(', ')}`);
  }
  if (unresolved.length > 0) {
    issues.push(
      issue(ctx, {
        id: 'env:unresolved-ref',
        severity: 'warning',
        title: `${unresolved.length === 1 ? 'Una referencia' : `${unresolved.length} referencias`} de variables sin resolver`,
        cause: 'Alguna variable utiliza una referencia `${{Servicio.VAR}}` cuyo servicio o variable no existe en este proyecto (es posible que el servicio se haya renombrado). El contenedor recibe el texto literal y la aplicación falla al conectar.',
        fix: 'En la pestaña «Variables», corrija el nombre del servicio o de la variable referenciada (el panel «Referencias del proyecto» muestra las válidas) y vuelva a desplegar.',
        evidence: toEvidence(unresolved.join('; ')),
        links: [drawerLink(ctx, 'variables', 'Revisar variables')],
      }),
    );
  }

  // 4. Claves del .env del repositorio que siguen sin valor.
  const pending = envImportPending(service.config);
  if (pending.length > 0) {
    issues.push(
      issue(ctx, {
        id: 'env:pending',
        severity: 'warning',
        title: `${pending.length === 1 ? 'Una variable' : `${pending.length} variables`} del .env del repositorio sin valor`,
        cause: `El .env de ejemplo del repositorio declara ${pending.join(', ')} sin un valor útil, y el servicio no las tiene definidas. Si el código las necesita, fallará al arrancar.`,
        fix: 'Complete su valor en la pestaña «Variables» (el aviso de la cabecera las añade como filas vacías) y pulse «Desplegar».',
        evidence: toEvidence(pending.join(', ')),
        links: [drawerLink(ctx, 'variables', 'Completar variables')],
      }),
    );
  }

  // 5. Escaneo profundo: la cola de logs de la aplicación.
  if (opts.deep && snap.docker && containerExists) {
    try {
      const lines = await fetchLogsBefore(containerName(project, service), LOG_TAIL, null);
      // Solo lo escrito desde el último arranque: un error de hace tres
      // despliegues no es un problema de hoy. Sin sello de arranque (parado o
      // reiniciándose) vale todo, que es donde está la causa de la caída.
      const recent = startedAt ? lines.filter((l) => !l.cursor || l.cursor >= startedAt!) : lines;
      for (const f of detectRuntimeIssues(recent.map((l) => l.line).join('\n'))) {
        issues.push(
          issue(ctx, {
            id: `runtime:${f.id}`,
            severity: f.severity,
            title: f.title,
            cause: f.cause,
            fix: f.fix,
            evidence: f.evidence,
            links: [drawerLink(ctx, 'logs', 'Ver registro'), drawerLink(ctx, 'variables', 'Revisar variables')],
          }),
        );
      }
    } catch {
      // Docker respondió al inspect pero no a los logs: lo demás sigue valiendo.
    }
  }

  return issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

// ---------- ámbito del usuario ----------

/**
 * Servicios que el usuario puede ver (misma regla que el listado de proyectos:
 * el admin todo, el propietario su workspace, el miembro sus proyectos), hasta
 * `max`. El orden es el del listado de proyectos (más recientes primero).
 */
export function accessibleServices(user: UserRow, max = MAX_SCAN): ServiceCtx[] {
  const projects = listProjects().filter((p) => canAccessProjectRow(user, p));
  const byProject = listServicesForProjects(projects.map((p) => p.id));
  const out: ServiceCtx[] = [];
  for (const project of projects) {
    for (const service of byProject.get(project.id) ?? []) {
      out.push({ service, project });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Un servicio concreto, solo si el usuario puede verlo. */
export function accessibleService(user: UserRow, serviceId: string): ServiceCtx | null {
  const service = getService(serviceId);
  const project = service ? getProject(service.project_id) : undefined;
  if (!service || !project || !canAccessProjectRow(user, project)) return null;
  return { service, project };
}

// ---------- intención y redacción ----------

const ERROR_INTENT =
  /\b(error|errores|falla|fallo|fallos|fallan|fallado|fallida|fallido|no arranca|no funciona|no va|caido|caida|502|503|504|bad gateway|crash|crashea|reinicia|reiniciando|reinicios|bucle|no carga|no responde|log|logs|roto|rota|peta|excepcion|exception|timeout|se cae|se cierra|se para|parado|no conecta|no despliega|detectar|revisar|revisa|problema|problemas|diagnostic[ao])\b/;

/** ¿La pregunta habla de algo que va mal? Entonces conviene mirar el servicio, no solo las FAQ. */
export function hasErrorIntent(question: string): boolean {
  return ERROR_INTENT.test(plain(question));
}

/**
 * Servicio nombrado en la pregunta («mi api-web no arranca»): el nombre o el
 * slug más largo que aparezca en el texto. Nombres de menos de tres letras se
 * ignoran: «db» o «ui» aparecen en demasiadas frases.
 */
export function findServiceByName(question: string, candidates: ServiceCtx[]): ServiceCtx | null {
  const text = ` ${plain(question).replace(/[^a-z0-9]+/g, ' ')} `;
  let best: { ctx: ServiceCtx; len: number } | null = null;
  for (const ctx of candidates) {
    for (const name of [ctx.service.name, ctx.service.slug]) {
      const needle = plain(name).replace(/[^a-z0-9]+/g, ' ').trim();
      if (needle.length < 3) continue;
      if (text.includes(` ${needle} `) && (!best || needle.length > best.len)) best = { ctx, len: needle.length };
    }
  }
  return best?.ctx ?? null;
}

const SEVERITY_LABEL: Record<IssueSeverity, string> = { critical: 'crítico', warning: 'advertencia', info: 'información' };

/** Longitud a partir de la cual el extracto de una respuesta ya dice algo. */
const EXCERPT_MIN = 80;

/**
 * Extracto de una respuesta para el hilo: el primer párrafo y, si es una
 * entradilla corta («Sí, de dos formas:»), también el segundo.
 */
function excerpt(text: string): string {
  const [first, second] = text.split('\n\n');
  return first.length < EXCERPT_MIN && second ? `${first}\n\n${second}` : first;
}

function faqSection(matches: FaqEntry[]): string[] {
  if (matches.length === 0) return [];
  const [top, ...rest] = matches;
  const parts = ['Documentación relacionada:', `**${top.question}**\n\n${excerpt(top.answer)}`];
  if (rest.length > 0) parts.push(rest.map((m) => `- **${m.question}**`).join('\n'));
  return parts;
}

function describeIssues(ctx: ServiceCtx, issues: HelpIssue[]): string[] {
  const name = ctx.service.name;
  if (issues.length === 0) {
    return [
      `Se ha revisado el servicio **${name}** (último despliegue, estado del contenedor, variables y registro reciente) y no se ha detectado ningún problema conocido.`,
      'Si el problema persiste, abra la pestaña «Logs» e indique en la consulta el error que aparece: con el texto exacto la revisión es más precisa.',
    ];
  }
  const [top, ...rest] = issues;
  const parts = [
    `Se ha revisado el servicio **${name}** y se ${issues.length === 1 ? 'ha detectado 1 problema' : `han detectado ${issues.length} problemas`}. El más grave: **${top.title}**.`,
    `**Causa:** ${top.cause}`,
    `**Solución recomendada:** ${top.fix}`,
  ];
  if (top.evidence) parts.push(`Detalle del registro: ${top.evidence}`);
  if (rest.length > 0) {
    parts.push(`Otros problemas detectados:\n${rest.map((i) => `- **${i.title}** (${SEVERITY_LABEL[i.severity]})`).join('\n')}`);
  }
  return parts;
}

const NOTHING_FOUND = [
  'No se ha encontrado una respuesta para esta consulta. El asistente puede ayudarle con la mayoría de las operaciones del panel. Ejemplos de consulta:',
  '- «¿Cómo añado un dominio a mi servicio?»\n- «Mi despliegue falla» (con el servicio seleccionado, se revisa en detalle)\n- «¿Cómo importo el .env de mi repositorio?»',
  'También puede consultar todas las preguntas frecuentes por categoría en la página de Ayuda.',
];

const HELP_LINK: HelpLink = { label: 'Preguntas frecuentes', to: '/help' };

function uniqueLinks(links: HelpLink[]): HelpLink[] {
  const seen = new Set<string>();
  return links.filter((l) => (seen.has(l.to) ? false : (seen.add(l.to), true)));
}

/**
 * Responde a una pregunta. Con intención de error y un servicio (elegido o
 * nombrado), lo revisa a fondo; con intención de error y sin servicio, pasa
 * rápido por todos los accesibles y, si solo uno tiene problemas, lo mira a
 * fondo; si hay varios, pide elegir. Las FAQ se consultan siempre.
 */
export async function ask(input: { question: string; serviceId?: string; req: FastifyRequest }): Promise<AskResponse> {
  const user = currentUser(input.req)!;
  const question = input.question.trim();
  const matches = searchFaq(question);
  const errorIntent = hasErrorIntent(question);

  let target: ServiceCtx | null = null;
  let candidates: ServiceCtx[] | null = null;
  if (input.serviceId) {
    target = accessibleService(user, input.serviceId);
  }
  if (!target && errorIntent) {
    candidates = accessibleServices(user);
    target = findServiceByName(question, candidates);
  }

  const paragraphs: string[] = [];
  const issues: HelpIssue[] = [];
  const links: HelpLink[] = [];

  if (target && errorIntent) {
    issues.push(...(await detectServiceIssues(target.service, { deep: true })));
    paragraphs.push(...describeIssues(target, issues));
    links.push(drawerLink(target, issues.length > 0 ? 'logs' : null, `Abrir ${target.service.name}`));
  } else if (errorIntent) {
    const scan = candidates ?? accessibleServices(user);
    if (scan.length === 0) {
      paragraphs.push('No hay ningún servicio que revisar. Cree uno desde el proyecto con **Nuevo servicio** y, si se produce un error al desplegar, realice de nuevo la consulta.');
    } else {
      const withIssues: { ctx: ServiceCtx; issues: HelpIssue[] }[] = [];
      for (const ctx of scan) {
        const found = await detectServiceIssues(ctx.service, { deep: false });
        if (found.length > 0) withIssues.push({ ctx, issues: found });
      }
      if (withIssues.length === 0) {
        paragraphs.push(
          `Se ${scan.length === 1 ? 'ha revisado su único servicio' : `han revisado sus ${scan.length} servicios`} y no se han detectado despliegues fallidos, contenedores caídos ni variables sin resolver.`,
          'Si el problema está en el registro de una aplicación concreta, seleccione el servicio en el selector (o indíquelo en la consulta) para revisarlo en detalle.',
        );
      } else if (withIssues.length === 1) {
        const only = withIssues[0].ctx;
        issues.push(...(await detectServiceIssues(only.service, { deep: true })));
        paragraphs.push(`De sus ${scan.length} servicios, solo **${only.service.name}** presenta problemas.`, ...describeIssues(only, issues));
        links.push(drawerLink(only, 'logs', `Abrir ${only.service.name}`));
      } else {
        for (const w of withIssues) issues.push(...w.issues);
        paragraphs.push(
          `Se han revisado ${scan.length} servicios y se han detectado problemas en ${withIssues.length}:`,
          withIssues.map((w) => `- **${w.ctx.service.name}** (${w.ctx.project.name}): ${w.issues[0].title}`).join('\n'),
          'Seleccione uno en el selector de servicio, o indíquelo en la consulta, para revisarlo en detalle junto con su registro.',
        );
        for (const w of withIssues) links.push(drawerLink(w.ctx, null, `Abrir ${w.ctx.service.name}`));
      }
    }
  }

  paragraphs.push(...faqSection(matches));
  if (paragraphs.length === 0) {
    paragraphs.push(...NOTHING_FOUND);
    links.push(HELP_LINK);
  }
  for (const m of matches) if (m.links) links.push(...m.links);

  return {
    answer: paragraphs.join('\n\n'),
    matches,
    issues,
    links: uniqueLinks(links),
  };
}

/**
 * Escaneo para `GET /api/help/issues`: profundo si se pide un servicio, ligero
 * sobre todos los accesibles si no. `scanned` dice cuántos se miraron.
 */
export async function scanIssues(user: UserRow, serviceId?: string): Promise<{ issues: HelpIssue[]; scanned: number } | null> {
  if (serviceId) {
    const ctx = accessibleService(user, serviceId);
    if (!ctx) return null;
    return { issues: await detectServiceIssues(ctx.service, { deep: true }), scanned: 1 };
  }
  const scan = accessibleServices(user);
  const issues: HelpIssue[] = [];
  for (const ctx of scan) issues.push(...(await detectServiceIssues(ctx.service, { deep: false })));
  issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return { issues, scanned: scan.length };
}
