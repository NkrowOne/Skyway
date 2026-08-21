import { useQuery } from '@tanstack/react-query';
import { Lock, Search } from 'lucide-react';
import { api } from '../api';
import { GithubConnector, GithubInstallation, GithubRepo } from '../types';
import { cx } from '../utils';
import { Spinner } from './ui';

/**
 * De dónde salen los repos que se pueden desplegar en un proyecto.
 *
 * Conviven dos orígenes y el usuario no tiene por qué distinguirlos al elegir
 * repo: la GitHub App (instalaciones, sin caducidad) y los conectores con token
 * personal (lo anterior). Este módulo los unifica en un solo valor y en un solo
 * selector, para que crear un servicio y editarlo después usen exactamente la
 * misma lista y las mismas rutas.
 */

export type GithubSource =
  | { kind: 'none' }
  | { kind: 'app'; id: string }
  | { kind: 'pat'; id: string };

export const NO_SOURCE: GithubSource = { kind: 'none' };

/** El valor del <select>: '' | 'app:<id>' | 'pat:<id>'. */
export function encodeSource(source: GithubSource): string {
  return source.kind === 'none' ? '' : `${source.kind}:${source.id}`;
}

export function decodeSource(raw: string): GithubSource {
  if (raw.startsWith('app:')) return { kind: 'app', id: raw.slice(4) };
  if (raw.startsWith('pat:')) return { kind: 'pat', id: raw.slice(4) };
  return NO_SOURCE;
}

/** Origen guardado en la configuración del servicio. */
export function sourceFromConfig(cfg: { githubInstallationId?: string | null; connectorId?: string | null }): GithubSource {
  if (cfg.githubInstallationId) return { kind: 'app', id: cfg.githubInstallationId };
  if (cfg.connectorId) return { kind: 'pat', id: cfg.connectorId };
  return NO_SOURCE;
}

/** Los dos campos que van al servidor (siempre ambos: uno elige, el otro limpia). */
export function sourceToConfig(source: GithubSource): { githubInstallationId: string | null; connectorId: string | null } {
  return {
    githubInstallationId: source.kind === 'app' ? source.id : null,
    connectorId: source.kind === 'pat' ? source.id : null,
  };
}

/** ¿La cuenta elegida sigue conectada al proyecto? (para detectar referencias colgantes). */
export function sourceStillConnected(source: GithubSource, sources: GithubSources): boolean {
  if (source.kind === 'none') return true;
  if (source.kind === 'app') return sources.installations.some((i) => i.id === source.id);
  return sources.connectors.some((c) => c.id === source.id);
}

const base = (source: GithubSource): string | null =>
  source.kind === 'app' ? `/github/installations/${source.id}` : source.kind === 'pat' ? `/connectors/${source.id}` : null;

// ---------- datos ----------

export interface GithubSources {
  installations: GithubInstallation[];
  connectors: GithubConnector[];
  appConfigured: boolean;
  hasGlobalToken: boolean;
  isLoading: boolean;
}

/** Cuentas de GitHub disponibles en el proyecto (App + tokens personales). */
export function useGithubSources(projectId: string, enabled = true): GithubSources {
  const installations = useQuery({
    queryKey: ['githubInstallations', projectId],
    queryFn: () =>
      api.get<{ appConfigured: boolean; installations: GithubInstallation[] }>(
        `/projects/${projectId}/github/installations`,
      ),
    enabled,
    staleTime: 30_000,
  });
  const connectors = useQuery({
    queryKey: ['connectors', projectId],
    queryFn: () => api.get<{ connectors: GithubConnector[]; hasGlobalToken: boolean }>(`/projects/${projectId}/connectors`),
    enabled,
    staleTime: 30_000,
  });
  return {
    installations: installations.data?.installations ?? [],
    connectors: connectors.data?.connectors ?? [],
    appConfigured: installations.data?.appConfigured ?? false,
    hasGlobalToken: connectors.data?.hasGlobalToken ?? false,
    isLoading: installations.isLoading || connectors.isLoading,
  };
}

export function useGithubRepos(source: GithubSource, enabled = true) {
  const path = base(source);
  return useQuery({
    queryKey: ['githubRepos', encodeSource(source)],
    queryFn: () => api.get<{ repos: GithubRepo[] }>(`${path}/repos`),
    enabled: enabled && !!path,
    staleTime: 60_000,
    retry: false,
  });
}

export function useGithubBranches(source: GithubSource, repo: string, enabled = true) {
  const path = base(source);
  return useQuery({
    queryKey: ['githubBranches', encodeSource(source), repo],
    queryFn: () => api.get<{ branches: string[] }>(`${path}/branches?repo=${encodeURIComponent(repo)}`),
    enabled: enabled && !!path && /^[\w.-]+\/[\w.-]+$/.test(repo),
    staleTime: 60_000,
    retry: false,
  });
}

// ---------- interfaz ----------

/** Etiqueta de una instalación: la cuenta y, si es global, de quién es. */
export function installationLabel(inst: GithubInstallation): string {
  const scope = inst.projectId ? '' : ' · del servidor';
  return `@${inst.accountLogin}${scope}`;
}

/**
 * Selector de cuenta. La opción vacía sigue existiendo —pegar una URL suelta es
 * legítimo para repos públicos— pero deja de ser la primera cuando hay cuentas
 * conectadas: lo normal es elegir una.
 */
export function GithubSourceSelect({
  sources,
  value,
  onChange,
  className,
}: {
  sources: GithubSources;
  value: GithubSource;
  onChange: (next: GithubSource) => void;
  className?: string;
}) {
  return (
    <select
      className={cx('input', className)}
      value={encodeSource(value)}
      onChange={(e) => onChange(decodeSource(e.target.value))}
    >
      {sources.installations.map((inst) => (
        <option key={inst.id} value={`app:${inst.id}`} disabled={inst.suspended}>
          {installationLabel(inst)}
          {inst.suspended ? ' (suspendida en GitHub)' : ''}
        </option>
      ))}
      {sources.connectors.map((c) => (
        <option key={c.id} value={`pat:${c.id}`}>
          {c.name} · @{c.gh_login} (token)
        </option>
      ))}
      <option value="">URL manual{sources.hasGlobalToken ? ' (token global)' : ''}</option>
    </select>
  );
}

/** Lista filtrable de repos de la cuenta elegida. */
export function GithubRepoPicker({
  source,
  selected,
  filter,
  onFilter,
  onPick,
  enabled = true,
}: {
  source: GithubSource;
  /** owner/repo actualmente elegido. */
  selected: string;
  filter: string;
  onFilter: (value: string) => void;
  onPick: (repo: GithubRepo) => void;
  enabled?: boolean;
}) {
  const repos = useGithubRepos(source, enabled);
  const needle = filter.trim().toLowerCase();
  const list = (repos.data?.repos ?? []).filter((r) => r.fullName.toLowerCase().includes(needle));

  return (
    <div className="rounded-lg border border-line bg-bg">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Search size={13} className="shrink-0 text-subtle" />
        <input
          className="w-full bg-transparent text-xs outline-none placeholder:text-subtle"
          placeholder="Filtrar repos…"
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
        />
      </div>
      <div className="max-h-44 overflow-y-auto p-1.5">
        {repos.isLoading && <Spinner label="Cargando repos…" />}
        {repos.isError && <p className="px-2.5 py-4 text-center text-xs text-err">{(repos.error as Error).message}</p>}
        {repos.data && list.length === 0 && (
          <p className="px-2.5 py-4 text-center text-xs text-subtle">
            {needle ? `Sin repos que coincidan con «${filter}»` : 'Esta cuenta no expone ningún repo a Skyway.'}
          </p>
        )}
        {list.map((r) => {
          const active = selected === r.fullName;
          return (
            <button
              key={r.fullName}
              type="button"
              onClick={() => onPick(r)}
              className={cx(
                'flex w-full items-center gap-2 rounded-md px-2.5 py-[7px] text-left transition-colors',
                active ? 'bg-acc/[.14] shadow-[inset_2px_0_0_var(--color-acc)]' : 'hover:bg-surface2',
              )}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.fullName}</span>
              {r.private && (
                <span className="flex shrink-0 items-center gap-1 rounded-full bg-surface2 px-1.5 py-0.5 text-[10px] text-sub">
                  <Lock size={9} /> privado
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
