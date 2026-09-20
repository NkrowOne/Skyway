import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Layers,
  Plus,
  Search,
  Table,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../../api';
import { cx, EMPTY_LIST, EMPTY_RECORD } from '../../utils';
import { CopyButton, EditorBar, Segmented, Skeleton, useToast } from '../ui';

interface ReferenceGroup {
  service: string;
  template: string | null;
  vars: string[];
  /** Las que calcula Skyway (INTERNAL_URL, PUBLIC_URL…): no están guardadas, pero se referencian igual. */
  auto: string[];
  /** Lo que «Conectar a…» copia: la URL del motor en una base (tres en S3), la URL interna en una app. */
  connect: string[];
}

interface EnvResponse {
  vars: Record<string, string>;
  resolved: Record<string, string>;
  references: ReferenceGroup[];
}

interface Row {
  id: string;
  key: string;
  value: string;
}

/** Qué le pasa a una fila respecto a lo guardado: es lo que la tiñe. */
type RowStatus = 'saved' | 'new' | 'changed';

/** Generador de ID único local para filas */
let rowCounter = 0;
function makeRow(key = '', value = ''): Row {
  return { id: `var_${Date.now()}_${++rowCounter}`, key, value };
}

/**
 * Filas a partir de lo guardado, ordenadas por clave. El servidor devuelve el
 * orden de inserción, que en una lista de treinta variables no ayuda a
 * encontrar nada; alfabético sí. Solo se aplica al cargar y al descartar: las
 * filas nuevas se añaden al final y nada se reordena mientras se edita, para
 * que un campo no cambie de sitio debajo del dedo.
 */
const rowsFromVars = (vars: Record<string, string>): Row[] =>
  Object.entries(vars)
    .sort(([a], [b]) => a.localeCompare(b, 'es'))
    // El id sale de la clave (única en lo guardado), no de un contador: con
    // ids nuevos en cada recarga React remontaba todos los campos, se perdía
    // el foco mientras escribías y se cerraban los valores revelados.
    .map(([key, value]) => ({ id: `k:${key}`, key, value }));

/** Variables típicas que casi toda app necesita, para añadirlas en un clic. */
const SUGGESTED_VARS: { key: string; value: string; hint: string }[] = [
  { key: 'NODE_ENV', value: 'production', hint: 'Modo de ejecución para apps Node' },
  { key: 'TZ', value: 'Europe/Madrid', hint: 'Zona horaria del contenedor' },
  { key: 'LOG_LEVEL', value: 'info', hint: 'Nivel de logs de la aplicación' },
  { key: 'PORT', value: '3000', hint: 'Puerto de escucha de la aplicación' },
];

/**
 * Nombre con el que un servicio recibe la URL interna de otro: «api» → API_URL,
 * «bot-lewspain» → BOT_LEWSPAIN_URL. En una base de datos la clave es la
 * misma que exporta (DATABASE_URL), que es lo que las librerías buscan.
 */
const connectKey = (group: ReferenceGroup, v: string): string =>
  group.template ? v : `${group.service.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'SERVICE'}_URL`;

const RAILWAY_RE = /railway\.internal|railway\.app|rlwy\.net/i;

/** Deduce a qué tipo de base apunta un valor heredado de Railway (por esquema, luego por clave). */
const guessTemplate = (key: string, value: string): string | null => {
  if (/^postgres(?:ql)?:\/\//i.test(value)) return 'postgres';
  if (/^rediss?:\/\//i.test(value)) return 'redis';
  if (/^mysql:\/\//i.test(value)) return 'mysql';
  if (/^mongodb(?:\+srv)?:\/\//i.test(value)) return 'mongo';
  if (/^(?:DATABASE|PG|POSTGRES)/i.test(key)) return 'postgres';
  if (/^REDIS/i.test(key)) return 'redis';
  if (/^MYSQL/i.test(key)) return 'mysql';
  if (/^MONGO/i.test(key)) return 'mongo';
  if (/^(?:MINIO|S3)/i.test(key)) return 'minio';
  return null;
};

const isReference = (v: string) => v.includes('${{');

/** Nombre de variable válido: es lo que permite partir «A=1 B=2» en dos sin partir un valor con espacios. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Quita las comillas que envuelven un valor de .env («"abc"» → «abc»), solo si casan. */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1);
  return value;
}

/**
 * Lee variables de un texto pegado, en cualquiera de las formas en que suele
 * llegar: un .env (una por línea), «export CLAVE=valor», o varias en la misma
 * línea separadas por espacios («A=1 B=2»). Un `<input>` de una línea se come
 * los saltos al pegar, así que lo primero que llega aquí es el texto del
 * portapapeles tal cual, no lo que el campo dejó pasar.
 */
export function parseEnvText(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    // Parte por espacios solo cuando lo que sigue es otro «CLAVE=»: así un
    // valor con espacios («MSG=hola mundo») sigue siendo un solo valor.
    const chunks = line.split(/\s+(?=[A-Za-z_][A-Za-z0-9_.-]*=)/);
    for (const chunk of chunks) {
      const eq = chunk.indexOf('=');
      if (eq <= 0) continue;
      const key = chunk.slice(0, eq).trim();
      if (!KEY_RE.test(key)) continue;
      out.push({ key, value: unquote(chunk.slice(eq + 1)) });
    }
  }
  return out;
}

export default function VariablesTab({
  serviceId,
  onSaved,
  onDeploy,
  onNeedsRedeploy,
  onDirtyChange,
}: {
  serviceId: string;
  onSaved: () => void;
  onDeploy?: () => void;
  onNeedsRedeploy?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [viewMode, setViewMode] = useState<'table' | 'raw'>('table');
  const [rawText, setRawText] = useState('');
  const [globalReveal, setGlobalReveal] = useState(false);
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [dirty, setDirty] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  const keyInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const valueInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const env = useQuery({
    queryKey: ['env', serviceId],
    queryFn: () => api.get<EnvResponse>(`/services/${serviceId}/env`),
  });

  // Solo se vuelve a leer del servidor cuando llegan datos NUEVOS. Antes
  // dependía también de `dirty`: al guardar, `dirty` caía a false antes de
  // que llegara la recarga y las filas volvían un instante a los valores viejos.
  const syncedRef = useRef<EnvResponse | null>(null);
  useEffect(() => {
    if (!env.data || env.data === syncedRef.current || dirty) return;
    syncedRef.current = env.data;
    const entries = rowsFromVars(env.data.vars);
    setRows(entries);
    setRawText(entries.map((r) => `${r.key}=${r.value}`).join('\n'));
  }, [env.data, dirty]);

  const save = useMutation({
    mutationFn: (vars: Record<string, string>) => api.put(`/services/${serviceId}/env`, { vars }),
    onSuccess: () => {
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ['env', serviceId] });
      toast('Variables guardadas con éxito.', 'ok', {
        action: onDeploy ? { label: 'Desplegar ahora', onClick: onDeploy } : undefined,
      });
      onNeedsRedeploy?.();
      onSaved();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  // Alternar vista tabla / texto plano
  const handleSwitchMode = (mode: 'table' | 'raw') => {
    if (mode === 'raw') {
      setRawText(rows.map((r) => `${r.key}=${r.value}`).join('\n'));
    } else {
      // Línea a línea, sin descartar una clave suelta a medio escribir.
      const newRows: Row[] = [];
      for (const line of rawText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        newRows.push(eq > 0 ? makeRow(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1)) : makeRow(trimmed, ''));
      }
      setRows(newRows);
    }
    setViewMode(mode);
  };

  // Validación y envío de cambios
  const submit = () => {
    const vars: Record<string, string> = {};
    if (viewMode === 'raw') {
      for (const line of rawText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) {
          toast(`Línea inválida: ${trimmed}`, 'err');
          return;
        }
        vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
      }
    } else {
      for (const row of rows) {
        if (!row.key.trim()) continue;
        vars[row.key.trim()] = row.value;
      }
    }
    save.mutate(vars);
  };

  // Descartar cambios
  const discard = () => {
    if (!env.data) return;
    const entries = rowsFromVars(env.data.vars);
    setRows(entries);
    setRawText(entries.map((r) => `${r.key}=${r.value}`).join('\n'));
    setDirty(false);
    toast('Cambios descartados', 'info');
  };

  // Alternar revelado individual
  const toggleRowReveal = (id: string) => {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Alternar revelado global
  const toggleGlobalReveal = () => {
    const next = !globalReveal;
    setGlobalReveal(next);
    if (next) {
      setRevealedIds(new Set(rows.map((r) => r.id)));
    } else {
      setRevealedIds(new Set());
    }
  };

  /**
   * Mete varias variables de golpe partiendo de la fila `atId`: las claves que
   * ya existen se actualizan en su sitio (pegar un .env encima no duplica), las
   * nuevas se insertan justo después. Si la fila de partida está vacía, la
   * primera nueva la ocupa.
   */
  const importVars = (atId: string, vars: { key: string; value: string }[]) => {
    let updated = 0;
    let added = 0;
    // Se calcula fuera del updater: React puede invocarlo dos veces y los
    // contadores del aviso saldrían dobles.
    const next = rows.map((r) => ({ ...r }));
    const at = next.findIndex((r) => r.id === atId);
    const fresh: Row[] = [];
    for (const v of vars) {
      const existing = next.find((r) => r.key.trim() === v.key && r.id !== atId);
      if (existing) {
        existing.value = v.value;
        updated += 1;
      } else {
        fresh.push(makeRow(v.key, v.value));
        added += 1;
      }
    }
    const emptyAt = at >= 0 && !next[at].key.trim() && !next[at].value;
    next.splice(emptyAt ? at : at + 1, emptyAt ? 1 : 0, ...fresh);
    setRows(next);
    setDirty(true);
    const parts = [added && `${added} nueva${added === 1 ? '' : 's'}`, updated && `${updated} actualizada${updated === 1 ? '' : 's'}`].filter(
      Boolean,
    );
    toast(`Variables pegadas: ${parts.join(' · ')}`, 'ok');
  };

  /**
   * Pegado en un campo. El navegador aplana los saltos de línea al pegar en un
   * `<input>`, así que hay que leer el portapapeles antes de que lo haga: es
   * lo que permite que «A=1⏎B=2» acabe en dos filas y no en un solo valor.
   */
  const handlePaste = (rowId: string, field: 'key' | 'value', e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!text) return;
    const vars = parseEnvText(text);
    // En el campo de valor solo se interviene si claramente viene un lote:
    // un valor suelto con un «=» dentro (una URL con query) es un valor.
    const bulk = vars.length >= 2 || (field === 'key' && vars.length === 1 && text.includes('='));
    if (!bulk) return;
    e.preventDefault();
    importVars(rowId, vars);
  };

  // Edición del nombre: un «=» escrito a mano salta al valor.
  const handleKeyChange = (id: string, rawInput: string) => {
    // Texto que llegó aplanado (arrastrar y soltar, autocompletado): si trae
    // varias variables, se reparte igual que un pegado.
    if (/\s/.test(rawInput.trim()) || rawInput.includes('\n')) {
      const vars = parseEnvText(rawInput);
      if (vars.length >= 2) {
        importVars(id, vars);
        return;
      }
    }
    if (rawInput.includes('=')) {
      const eq = rawInput.indexOf('=');
      const key = rawInput.slice(0, eq).trim();
      const value = rawInput.slice(eq + 1);
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, key, value: value || r.value } : r)));
      setDirty(true);
      setTimeout(() => {
        valueInputRefs.current.get(id)?.focus();
      }, 10);
      return;
    }
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, key: rawInput } : r)));
    setDirty(true);
  };

  const handleValueChange = (id: string, value: string) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, value } : r)));
    setDirty(true);
  };

  const handleAddRow = () => {
    const newR = makeRow('', '');
    setRows((prev) => [...prev, newR]);
    setDirty(true);
    setTimeout(() => {
      keyInputRefs.current.get(newR.id)?.focus();
    }, 50);
  };

  const handleDeleteRow = (id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
    setDirty(true);
  };

  // Copiar todo como formato .env
  const handleCopyAllAsEnv = () => {
    const text = rows.map((r) => `${r.key}=${r.value}`).join('\n');
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedAll(true);
        toast('Todas las variables copiadas al portapapeles en formato .env', 'ok');
        setTimeout(() => setCopiedAll(false), 2000);
      })
      // Sin HTTPS o con el permiso denegado el portapapeles rechaza: antes no se decía nada.
      .catch(() => toast('No se ha podido copiar al portapapeles', 'err'));
  };

  const references = env.data?.references ?? EMPTY_LIST;
  const resolved = env.data?.resolved ?? EMPTY_RECORD;
  const saved = env.data?.vars ?? EMPTY_RECORD;

  // Qué es nuevo, qué ha cambiado y qué se ha quitado respecto a lo guardado.
  const statusOf = (row: Row): RowStatus => {
    const k = row.key.trim();
    if (!k || !(k in saved)) return 'new';
    return saved[k] === row.value ? 'saved' : 'changed';
  };
  const changes = useMemo(() => {
    const keys = new Set(rows.map((r) => r.key.trim()).filter(Boolean));
    const removed = Object.keys(saved).filter((k) => !keys.has(k)).length;
    let added = 0;
    let changed = 0;
    for (const r of rows) {
      const k = r.key.trim();
      if (!k) continue;
      if (!(k in saved)) added += 1;
      else if (saved[k] !== r.value) changed += 1;
    }
    return { added, changed, removed };
  }, [rows, saved]);
  const dirtyLabel = useMemo(() => {
    const parts = [
      changes.added && `${changes.added} nueva${changes.added === 1 ? '' : 's'}`,
      changes.changed && `${changes.changed} cambiada${changes.changed === 1 ? '' : 's'}`,
      changes.removed && `${changes.removed} eliminada${changes.removed === 1 ? '' : 's'}`,
    ].filter(Boolean);
    return parts.length ? `${parts.join(' · ')} · se aplican al redesplegar` : 'Cambios sin guardar · se aplican al redesplegar';
  }, [changes]);

  // Claves duplicadas
  const duplicates = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of rows) {
      const k = r.key.trim();
      if (k) counts[k] = (counts[k] || 0) + 1;
    }
    return new Set(Object.keys(counts).filter((k) => counts[k] > 1));
  }, [rows]);

  // Variables que siguen apuntando a Railway
  const railwayPending = useMemo(() => {
    const out: { id: string; key: string; candidates: ReferenceGroup[] }[] = [];
    rows.forEach((row) => {
      if (!RAILWAY_RE.test(row.value) || isReference(row.value)) return;
      const template = guessTemplate(row.key, row.value);
      const candidates = template ? references.filter((g) => g.template === template && g.connect.length > 0) : [];
      out.push({ id: row.id, key: row.key, candidates });
    });
    return out;
  }, [rows, references]);

  /*
   * «Conectar a…»: un botón por servicio del proyecto al que se pueda enganchar
   * este, que inserta de golpe las referencias que hacen falta (qué son lo dice
   * el servidor, según el motor). Desaparece cuando ya están todas.
   */
  const connectChips = useMemo(
    () =>
      references
        .filter((g) => g.service !== 'shared' && g.connect.length > 0)
        .map((g) => ({
          service: g.service,
          entries: g.connect.map((v) => ({ key: connectKey(g, v), value: `\${{${g.service}.${v}}}` })),
        })),
    [references],
  );

  // Sugerencias rápidas
  const suggestions = SUGGESTED_VARS;

  // Filtrado por buscador
  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.key.toLowerCase().includes(q) || r.value.toLowerCase().includes(q));
  }, [rows, searchQuery]);

  if (env.isLoading) {
    return (
      <div aria-busy className="flex flex-col gap-3 p-4 sm:px-5">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }

  const toolBtn =
    'press flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-xs font-medium text-sub transition-colors hover:bg-surface2 hover:text-txt';

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-between">
      <div className="flex flex-col gap-4 p-3.5 pb-24 sm:p-5">
        {/* ── Cabecera: qué hay y cómo verlo ── */}
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <h3 className="text-sm font-semibold text-txt">Variables de entorno</h3>
            <span className="tnum font-mono text-xs text-subtle">{rows.length}</span>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <Segmented
              label="Modo de edición"
              size="sm"
              value={viewMode}
              onChange={handleSwitchMode}
              options={[
                { key: 'table', label: <span className="max-sm:hidden">Tabla</span>, icon: <Table size={12} aria-hidden />, title: 'Vista en tabla' },
                { key: 'raw', label: '.env', icon: <FileText size={12} aria-hidden />, title: 'Editar como texto plano' },
              ]}
            />

            {viewMode === 'table' && (
              <>
                <button
                  type="button"
                  onClick={toggleGlobalReveal}
                  className={toolBtn}
                  title={globalReveal ? 'Ocultar todos los valores' : 'Revelar todos los valores'}
                  aria-label={globalReveal ? 'Ocultar todos los valores' : 'Revelar todos los valores'}
                >
                  {globalReveal ? <EyeOff size={13} /> : <Eye size={13} />}
                  <span className="hidden md:inline">{globalReveal ? 'Ocultar' : 'Revelar'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleCopyAllAsEnv}
                  className={toolBtn}
                  title="Copiar todas las variables en formato .env"
                  aria-label="Copiar todas las variables en formato .env"
                >
                  {copiedAll ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
                  <span className="hidden lg:inline">Copiar .env</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* ── Aviso de migración desde Railway (si aplica) ── */}
        {railwayPending.length > 0 && (
          <div className="rounded-xl border border-warn/35 bg-warn/[.07] p-3.5 text-xs">
            <p className="flex items-center gap-1.5 font-semibold text-warn">
              <AlertTriangle size={14} />
              {railwayPending.length === 1
                ? '1 variable sigue apuntando a la red externa de Railway'
                : `${railwayPending.length} variables siguen apuntando a la red externa de Railway`}
            </p>
            <p className="mt-1 text-sub">Reconéctalas en un clic para usar la red interna del proyecto:</p>
            <div className="mt-2.5 flex flex-col gap-1.5">
              {railwayPending.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-txt">{p.key}</span>
                  {p.candidates.map((g) => {
                    const token = `\${{${g.service}.${g.connect[0]}}}`;
                    return (
                      <button
                        key={g.service}
                        type="button"
                        className="press rounded-md border border-line bg-surface px-2 py-0.5 font-mono text-xs text-info transition-colors hover:border-info"
                        onClick={() => {
                          setRows((prev) => prev.map((r) => (r.id === p.id ? { ...r, value: token } : r)));
                          setDirty(true);
                          toast(`Reconectado a ${g.service}`, 'ok');
                        }}
                      >
                        usar {token}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}

        {viewMode === 'raw' ? (
          /* ── Texto plano (.env) ── */
          <div className="flex flex-col gap-2">
            <p className="text-xs text-subtle">
              Una variable por línea, en formato <code className="font-mono text-txt">CLAVE=valor</code>. Puedes pegar un
              archivo .env entero.
            </p>
            <textarea
              className="input min-h-[320px] w-full rounded-xl border border-line bg-term p-3.5 font-mono leading-relaxed text-txt/95 outline-none focus:border-acc sm:text-xs"
              value={rawText}
              onChange={(e) => {
                setRawText(e.target.value);
                setDirty(true);
              }}
              placeholder={'CLAVE=valor\nAPI_KEY=123456\nDATABASE_URL=${{Postgres.DATABASE_URL}}'}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </div>
        ) : (
          /* ── Tabla ── */
          <div className="flex flex-col gap-2.5">
            {rows.length > 4 && (
              <div className="flex h-8 w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 focus-within:border-acc">
                <Search size={13} className="shrink-0 text-subtle" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filtrar por nombre o valor…"
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent text-xs text-txt outline-none placeholder:text-subtle"
                />
                {searchQuery && (
                  <button type="button" onClick={() => setSearchQuery('')} className="press text-subtle hover:text-txt" aria-label="Borrar filtro">
                    <X size={12} />
                  </button>
                )}
              </div>
            )}

            {/* Cabecera de columnas: en móvil cada fila lleva sus rótulos. */}
            {filteredRows.length > 0 && (
              <div className="hidden px-3.5 sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-3">
                <span className="eyebrow text-subtle">Nombre</span>
                <span className="eyebrow text-subtle">Valor</span>
              </div>
            )}

            {filteredRows.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line p-8 text-center text-xs text-subtle">
                {searchQuery ? (
                  <p>Ninguna variable coincide con «{searchQuery}»</p>
                ) : (
                  <>
                    <Layers size={24} className="mb-2 opacity-40" />
                    <p className="font-medium text-txt">Sin variables de entorno</p>
                    <p className="mt-1 text-subtle">
                      Añade una, o pega un .env entero en cualquier campo: se reparte solo.
                    </p>
                  </>
                )}
              </div>
            ) : (
              /*
               * En móvil cada variable es una tarjeta con aire alrededor y sus
               * dos campos apilados con rótulo: antes eran dos cajas pegadas sin
               * un solo píxel entre variables y no se sabía dónde acababa una.
               * En escritorio, una lista de filas con las dos columnas alineadas.
               */
              <div className="flex flex-col gap-2 sm:gap-0 sm:overflow-hidden sm:rounded-xl sm:border sm:border-line sm:bg-surface">
                {filteredRows.map((row, index) => {
                  const isRevealed = globalReveal || revealedIds.has(row.id);
                  const isRef = isReference(row.value);
                  const isDup = duplicates.has(row.key.trim());
                  const status = statusOf(row);
                  const rail =
                    status === 'new' ? 'bg-acc-soft' : status === 'changed' ? 'bg-warn' : 'bg-transparent';

                  return (
                    <div
                      key={row.id}
                      className={cx(
                        'group relative flex flex-col rounded-xl border border-line bg-surface transition-colors duration-150 sm:flex-row sm:items-stretch sm:rounded-none sm:border-0 sm:border-b sm:last:border-b-0 sm:hover:bg-surface2/40',
                        /*
                         * Lo nuevo y lo cambiado se ven sin leer: tinte suave
                         * de fondo, un riel de color a la izquierda y una
                         * etiqueta. Al guardar vuelven al gris de lo que ya está.
                         */
                        status === 'new' && 'border-acc/35 bg-acc/[.06] sm:bg-acc/[.05] sm:hover:bg-acc/[.08]',
                        status === 'changed' && 'border-warn/35 bg-warn/[.05] sm:bg-warn/[.04] sm:hover:bg-warn/[.07]',
                        isDup && 'bg-err/[.05] sm:bg-err/[.04]',
                      )}
                    >
                      <span aria-hidden className={cx('absolute inset-y-0 left-0 w-[3px] rounded-l-xl sm:rounded-none', rail)} />

                      {/* Nombre */}
                      <div className="relative flex min-w-0 items-center gap-2 pl-3.5 pr-2 pt-2 sm:w-[40%] sm:border-r sm:border-line sm:py-0 sm:pr-0">
                        <span className="eyebrow w-12 shrink-0 text-subtle sm:hidden">Nombre</span>
                        <input
                          ref={(el) => {
                            if (el) keyInputRefs.current.set(row.id, el);
                            else keyInputRefs.current.delete(row.id);
                          }}
                          className={cx(
                            'h-9 min-w-0 flex-1 rounded-md bg-transparent px-2 font-mono text-xs font-medium text-txt outline-none placeholder:text-subtle focus:bg-surface2/60 sm:h-auto sm:rounded-none sm:px-3.5 sm:py-2.5',
                            isDup && 'font-bold text-err',
                          )}
                          placeholder="NOMBRE_VARIABLE"
                          value={row.key}
                          spellCheck={false}
                          autoCapitalize="characters"
                          autoCorrect="off"
                          onChange={(e) => handleKeyChange(row.id, e.target.value)}
                          onPaste={(e) => handlePaste(row.id, 'key', e)}
                          onKeyDown={(e) => {
                            if (e.key === '=' || e.key === 'Enter') {
                              e.preventDefault();
                              valueInputRefs.current.get(row.id)?.focus();
                            }
                          }}
                        />
                        {isDup ? (
                          <span className="shrink-0 rounded bg-err/15 px-1.5 py-0.5 text-micro font-bold text-err sm:mr-2">Duplicada</span>
                        ) : status === 'new' ? (
                          <span className="shrink-0 rounded bg-acc/20 px-1.5 py-0.5 text-micro font-semibold text-acc-soft sm:mr-2">Nueva</span>
                        ) : status === 'changed' ? (
                          <span className="shrink-0 rounded bg-warn/15 px-1.5 py-0.5 text-micro font-semibold text-warn sm:mr-2">Cambiada</span>
                        ) : null}
                      </div>

                      {/* Valor + acciones */}
                      <div className="flex min-w-0 flex-1 items-center gap-2 pb-2 pl-3.5 pr-2 pt-1 sm:py-0 sm:pl-0">
                        <span className="eyebrow w-12 shrink-0 text-subtle sm:hidden">Valor</span>
                        <input
                          ref={(el) => {
                            if (el) valueInputRefs.current.set(row.id, el);
                            else valueInputRefs.current.delete(row.id);
                          }}
                          className={cx(
                            'h-9 min-w-0 flex-1 rounded-md bg-transparent px-2 font-mono text-xs outline-none placeholder:text-subtle focus:bg-surface2/60 sm:h-auto sm:rounded-none sm:px-3.5 sm:py-2.5',
                            isRef ? 'font-medium text-info' : isRevealed ? 'text-txt' : 'text-subtle',
                          )}
                          placeholder={isRef ? '${{Servicio.VAR}}' : 'valor'}
                          type={isRevealed || isRef ? 'text' : 'password'}
                          value={row.value}
                          spellCheck={false}
                          autoCapitalize="off"
                          autoCorrect="off"
                          onChange={(e) => handleValueChange(row.id, e.target.value)}
                          onPaste={(e) => handlePaste(row.id, 'value', e)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              if (index === filteredRows.length - 1) {
                                handleAddRow();
                              } else {
                                const nextRow = filteredRows[index + 1];
                                if (nextRow) keyInputRefs.current.get(nextRow.id)?.focus();
                              }
                            }
                          }}
                        />

                        <div className="flex shrink-0 items-center gap-0.5 sm:pr-2">
                          {!isRef && (
                            <button
                              type="button"
                              onClick={() => toggleRowReveal(row.id)}
                              className={cx(
                                'press flex h-8 w-8 items-center justify-center rounded-md text-subtle transition-colors hover:bg-surface2 hover:text-txt sm:h-7 sm:w-7',
                                isRevealed && 'text-acc-soft',
                              )}
                              title={isRevealed ? 'Ocultar valor' : 'Mostrar valor'}
                              aria-label={isRevealed ? 'Ocultar valor' : 'Mostrar valor'}
                            >
                              {isRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
                            </button>
                          )}
                          <CopyButton value={resolved[row.key] ?? row.value} title="Copiar valor resuelto" />
                          <button
                            type="button"
                            onClick={() => handleDeleteRow(row.id)}
                            className="press flex h-8 w-8 items-center justify-center rounded-md text-subtle transition-colors hover:bg-surface2 hover:text-err sm:h-7 sm:w-7"
                            title="Eliminar variable"
                            aria-label="Eliminar variable"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* La pista del pegado ya la da el estado vacío; aquí, permanente,
                era ruido para quien ya tiene variables. Queda en el title. */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={handleAddRow}
                title="Pega un .env en cualquier campo y se reparte en filas"
                className="press flex h-9 items-center gap-1.5 rounded-lg border border-dashed border-line2 px-3 text-xs font-semibold text-sub transition-colors hover:border-acc/50 hover:bg-surface2 hover:text-txt max-sm:flex-1 max-sm:justify-center"
              >
                <Plus size={14} className="text-acc-soft" />
                Añadir variable
              </button>
            </div>
          </div>
        )}

        {/* ── Referencias y sugerencias ── */}
        <div className="flex flex-col gap-3">
          {connectChips.some((c) => c.entries.some((e) => !rows.some((r) => r.key === e.key))) && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-subtle">
              <span className="font-medium text-sub">Conectar a:</span>
              {connectChips
                .filter((c) => c.entries.some((e) => !rows.some((r) => r.key === e.key)))
                .map((c) => {
                  const pending = c.entries.filter((e) => !rows.some((r) => r.key === e.key));
                  const hint = `Añade ${pending.map((e) => e.key).join(', ')} como referencia a ${c.service} por la red interna del proyecto`;
                  return (
                    <button
                      key={c.service}
                      type="button"
                      className="press flex items-center gap-1 rounded-md border border-acc/40 bg-acc/[.06] px-2 py-0.5 text-xs font-medium text-acc-soft transition-colors hover:border-acc hover:bg-acc/10 max-sm:py-1.5"
                      title={hint}
                      aria-label={hint}
                      onClick={() => {
                        setRows((prev) => [...prev, ...pending.map((e) => makeRow(e.key, e.value))]);
                        setDirty(true);
                        toast(`Conectado a ${c.service}: ${pending.map((e) => e.key).join(', ')}`, 'ok');
                      }}
                    >
                      <Plus size={12} /> {c.service}
                    </button>
                  );
                })}
            </div>
          )}

          {suggestions.some((s) => !rows.some((r) => r.key === s.key)) && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-subtle">
              <span className="font-medium text-sub">Habituales:</span>
              {suggestions
                .filter((s) => !rows.some((r) => r.key === s.key))
                .map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    className="press rounded-md border border-line bg-surface2/60 px-2 py-0.5 font-mono text-xs text-sub transition-colors hover:border-acc/40 hover:text-txt max-sm:py-1.5"
                    title={s.hint}
                    aria-label={s.hint}
                    onClick={() => {
                      setRows((prev) => [...prev, makeRow(s.key, s.value)]);
                      setDirty(true);
                    }}
                  >
                    + {s.key}
                  </button>
                ))}
            </div>
          )}

          {references.length > 0 && (
            <div className="rounded-xl border border-line bg-surface p-3.5 text-xs">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-1">
                <span className="font-semibold text-sub">Referencias del proyecto</span>
                <span className="text-xs text-subtle">Clic para copiar en formato {'${{...}}'}</span>
              </div>
              <div className="flex flex-col gap-2.5">
                {references.map((ref) => (
                  <div key={ref.service} className="rounded-lg border border-line/60 bg-surface2/50 p-2">
                    <p className="eyebrow mb-1.5 text-subtle">
                      {ref.service === 'shared' ? 'Variables compartidas' : ref.service}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {/* Las de sistema van detrás y en otro tono: no son
                          variables del servicio, las calcula Skyway de su puerto
                          y su dominio, y cambian con ellos. */}
                      {[...ref.vars.map((v) => ({ v, auto: false })), ...(ref.auto ?? []).map((v) => ({ v, auto: true }))].map(
                        ({ v, auto }) => {
                          const token = `\${{${ref.service}.${v}}}`;
                          const title = auto
                            ? `Copiar ${token} · la calcula Skyway del puerto y el dominio de ${ref.service}`
                            : `Copiar ${token}`;
                          return (
                            <button
                              key={v}
                              type="button"
                              className={cx(
                                'press rounded-md border px-2 py-0.5 font-mono text-xs transition-colors max-sm:py-1.5',
                                auto
                                  ? 'border-dashed border-acc/40 bg-surface text-acc-soft hover:border-acc hover:bg-acc/10'
                                  : 'border-line bg-surface text-info hover:border-info hover:bg-info/10',
                              )}
                              title={title}
                              aria-label={title}
                              onClick={() => {
                                // El «Copiado» solo cuando de verdad se ha copiado.
                                navigator.clipboard
                                  .writeText(token)
                                  .then(() => toast(`Copiado: ${token}`, 'ok'))
                                  .catch(() => toast('No se ha podido copiar al portapapeles', 'err'));
                              }}
                            >
                              {v}
                            </button>
                          );
                        },
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <EditorBar
        dirty={dirty}
        saving={save.isPending}
        onSave={submit}
        onDiscard={discard}
        saveLabel={dirty ? `Guardar (${rows.filter((r) => r.key.trim()).length})` : 'Guardar variables'}
        dirtyLabel={dirtyLabel}
      />
    </div>
  );
}
