import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Database, GitBranch, Package, TrainFront } from 'lucide-react';
import { api } from '../api';
import { Button, CopyButton, Field, Modal, useToast } from './ui';
import { cx } from '../utils';

interface RailwayProject {
  id: string;
  name: string;
  team: string | null;
}

interface PlannedService {
  railwayName: string;
  kind: 'git' | 'database' | 'image' | 'skipped';
  template?: string;
  version?: string;
  image?: string;
  repoUrl?: string;
  branch?: string;
  port?: number | null;
  domains: string[];
  volumeMounts: string[];
  varCount: number;
  notes: string[];
}

interface Plan {
  railwayProjectId: string;
  projectName: string;
  environment: { id: string; name: string };
  environments: { id: string; name: string }[];
  services: PlannedService[];
  sharedVarCount: number;
  warnings: string[];
}

export interface ImportReport {
  ts: number;
  railwayProject: string;
  environment: string;
  projectId: string;
  projectName: string;
  created: { name: string; kind: string; notes: string[] }[];
  skipped: { name: string; notes: string[] }[];
  warnings: string[];
  dataCopy: { service: string; template: string; command: string | null; note: string }[];
  nextSteps: string[];
}

const KIND_META: Record<string, { label: string; icon: typeof GitBranch; cls: string }> = {
  git: { label: 'Repositorio', icon: GitBranch, cls: 'text-acc' },
  database: { label: 'Base de datos', icon: Database, cls: 'text-info' },
  image: { label: 'Imagen Docker', icon: Package, cls: 'text-warn' },
  skipped: { label: 'Se omite', icon: Package, cls: 'text-sub' },
};

export function ImportReportView({ report }: { report: ImportReport }) {
  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center gap-2 text-ok">
        <CheckCircle2 size={18} />
        <p className="font-medium">
          "{report.railwayProject}" (entorno {report.environment}) importado como "{report.projectName}"
        </p>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-sub">Servicios creados</h3>
        <ul className="space-y-1.5">
          {report.created.map((c) => (
            <li key={c.name} className="rounded-lg border border-line bg-surface2 px-3 py-2">
              <span className="font-medium">{c.name}</span> <span className="text-xs text-sub">— {c.kind}</span>
              {c.notes.map((n, i) => (
                <p key={i} className="mt-0.5 text-xs text-sub">· {n}</p>
              ))}
            </li>
          ))}
          {report.skipped.map((s) => (
            <li key={s.name} className="rounded-lg border border-line/60 bg-surface2/50 px-3 py-2 text-sub">
              <span>{s.name}</span> <span className="text-xs">— omitido: {s.notes.join(' ')}</span>
            </li>
          ))}
        </ul>
      </div>

      {report.dataCopy.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-sub">Copia de datos</h3>
          <div className="space-y-2">
            {report.dataCopy.map((d) => (
              <div key={d.service} className="rounded-lg border border-line bg-surface2 p-3">
                <p className="text-xs font-medium">{d.service} ({d.template})</p>
                <p className="mt-1 text-xs text-sub">{d.note}</p>
                {d.command && (
                  <div className="mt-2 flex items-start gap-1">
                    <code className="block flex-1 overflow-x-auto whitespace-pre rounded-md bg-term p-2 font-mono text-[10.5px] text-txt/[.88]">
                      {d.command}
                    </code>
                    <CopyButton value={d.command} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {report.warnings.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-sub">Revisa esto</h3>
          <ul className="space-y-1 text-xs text-warn">
            {report.warnings.map((w, i) => (
              <li key={i} className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2">⚠ {w}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-sub">Siguientes pasos</h3>
        <ol className="list-inside list-decimal space-y-1 text-xs text-sub">
          {report.nextSteps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export default function RailwayImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [step, setStep] = useState<'token' | 'pick' | 'preview' | 'done'>('token');
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState('');
  const [projects, setProjects] = useState<RailwayProject[]>([]);
  const [manualId, setManualId] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [envId, setEnvId] = useState<string>('');
  const [projectName, setProjectName] = useState('');
  const [client, setClient] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);

  const reset = () => {
    setStep('token');
    setToken('');
    setProjects([]);
    setManualId('');
    setSelectedId(null);
    setPlan(null);
    setEnvId('');
    setProjectName('');
    setClient('');
    setReport(null);
  };

  const close = () => {
    if (busy) return; // no cerrar con una operación en vuelo: una importación a medias deja el proyecto a medio crear
    reset();
    onClose();
  };

  const connect = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ projects: RailwayProject[] }>('/import/railway/projects', { token });
      setProjects(res.projects);
      setStep('pick');
      if (res.projects.length === 0) toast('El token es válido pero no se encontraron proyectos. Puedes pegar el ID a mano.', 'info');
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const analyze = async (projectId: string, environmentId?: string) => {
    setBusy(true);
    try {
      const res = await api.post<{ plan: Plan }>('/import/railway/analyze', {
        token,
        projectId,
        ...(environmentId ? { environmentId } : {}),
      });
      setPlan(res.plan);
      setSelectedId(projectId);
      setEnvId(res.plan.environment.id);
      setProjectName(res.plan.projectName);
      setStep('preview');
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!selectedId || !envId) return;
    setBusy(true);
    try {
      const res = await api.post<{ project: { id: string }; report: ImportReport }>('/import/railway/run', {
        token,
        projectId: selectedId,
        environmentId: envId,
        projectName,
        ...(client.trim() ? { client } : {}),
      });
      setReport(res.report);
      setStep('done');
      toast('Proyecto importado', 'ok');
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title="Importar desde Railway" wide>
      {step === 'token' && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim().length >= 10 && !busy) void connect();
          }}
        >
          <div className="flex items-start gap-3 rounded-lg border border-line bg-surface2 p-3 text-xs text-sub">
            <TrainFront size={16} className="mt-0.5 shrink-0 text-acc" />
            <p>
              Skyway leerá tus proyectos por la API oficial de Railway y recreará servicios, variables (las referencias{' '}
              <span className="font-mono text-info">{'${{Servicio.VAR}}'}</span> funcionan igual), dominios propios y
              volúmenes. El token se usa solo durante la importación y <strong className="text-txt">no se guarda</strong>.
            </p>
          </div>
          <Field
            label="Token de cuenta de Railway"
            hint="Créalo en railway.com → Account Settings → Tokens (sin seleccionar equipo para ver también los personales)"
          >
            <input
              className="input font-mono"
              type="password"
              placeholder="xxxxxxxx-xxxx-..."
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoFocus
            />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={busy} disabled={token.trim().length < 10}>
              Conectar <ArrowRight size={14} />
            </Button>
          </div>
        </form>
      )}

      {step === 'pick' && (
        <div className="space-y-4">
          {projects.length > 0 && (
            <div className="max-h-72 space-y-2 overflow-y-auto">
              {projects.map((p) => (
                <button
                  key={p.id}
                  disabled={busy}
                  onClick={() => analyze(p.id)}
                  className="card flex w-full items-center justify-between p-3.5 text-left transition-all hover:border-acc/60"
                >
                  <div>
                    <p className="text-sm font-medium">{p.name}</p>
                    <p className="text-xs text-sub">{p.team ? `Equipo: ${p.team}` : 'Personal'} · {p.id}</p>
                  </div>
                  <ArrowRight size={15} className="text-sub" />
                </button>
              ))}
            </div>
          )}
          <details className="text-xs text-sub" open={projects.length === 0}>
            <summary className="cursor-pointer hover:text-txt">¿No aparece tu proyecto? Pega su ID</summary>
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (manualId.trim() && !busy) void analyze(manualId.trim());
              }}
            >
              <input
                className="input flex-1 font-mono text-xs"
                placeholder="ID del proyecto (Settings del proyecto en Railway)"
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
              />
              <Button size="sm" variant="outline" type="submit" disabled={!manualId.trim() || busy}>
                Analizar
              </Button>
            </form>
          </details>
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep('token')}>
              Atrás
            </Button>
          </div>
        </div>
      )}

      {step === 'preview' && plan && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Nombre en Skyway">
              <input className="input" value={projectName} onChange={(e) => setProjectName(e.target.value)} />
            </Field>
            <Field label="Empresa / cliente (opcional)">
              <input className="input" value={client} onChange={(e) => setClient(e.target.value)} placeholder="Acme S.L." />
            </Field>
          </div>
          {plan.environments.length > 1 && (
            <Field label="Entorno de Railway a importar">
              <select
                className="input"
                value={envId}
                onChange={(e) => {
                  setEnvId(e.target.value);
                  analyze(plan.railwayProjectId, e.target.value);
                }}
              >
                {plan.environments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <div className="max-h-64 space-y-2 overflow-y-auto">
            {plan.services.map((s) => {
              const meta = KIND_META[s.kind];
              const Icon = meta.icon;
              return (
                <div key={s.railwayName} className={cx('card p-3', s.kind === 'skipped' && 'opacity-60')}>
                  <div className="flex items-center gap-2">
                    <Icon size={15} className={meta.cls} />
                    <span className="text-sm font-medium">{s.railwayName}</span>
                    <span className="text-xs text-sub">→ {meta.label}</span>
                    <span className="ml-auto text-[11px] text-sub">
                      {s.varCount > 0 && `${s.varCount} vars`}
                      {s.domains.length > 0 && ` · ${s.domains.length} dominio(s)`}
                      {s.volumeMounts.length > 0 && ` · ${s.volumeMounts.length} volumen(es)`}
                    </span>
                  </div>
                  {(s.kind === 'git' ? [`${s.repoUrl} (${s.branch})`] : s.kind === 'image' ? [s.image] : []).map((l) => (
                    <p key={l} className="mt-1 truncate font-mono text-[11px] text-sub">{l}</p>
                  ))}
                  {s.notes.map((n, i) => (
                    <p key={i} className="mt-1 text-[11px] text-sub">· {n}</p>
                  ))}
                </div>
              );
            })}
          </div>

          {plan.sharedVarCount > 0 && (
            <p className="text-xs text-sub">
              + {plan.sharedVarCount} variable(s) compartida(s) del entorno → variables compartidas del proyecto
            </p>
          )}
          {plan.warnings.map((w, i) => (
            <p key={i} className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">⚠ {w}</p>
          ))}

          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep('pick')}>
              Atrás
            </Button>
            <Button onClick={run} loading={busy}>
              Importar {plan.services.filter((s) => s.kind !== 'skipped').length} servicios
            </Button>
          </div>
        </div>
      )}

      {step === 'done' && report && (
        <div className="space-y-4">
          <ImportReportView report={report} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              Cerrar
            </Button>
            <Button
              onClick={() => {
                const id = report.projectId;
                close();
                navigate(`/projects/${id}`);
              }}
            >
              Ir al proyecto <ArrowRight size={14} />
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
