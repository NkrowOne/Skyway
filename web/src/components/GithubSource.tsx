import { useEffect } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Lock, Search } from 'lucide-react';
import { api } from '../api';
import { GithubConnector, GithubInstallation, GithubRepo } from '../types';
import { cx, parseRepoInput } from '../utils';
import { Button, EmptyState, ErrorState, Spinner } from './ui';

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

/**
 * Comprueba si la cuenta elegida ve un repo concreto escrito a mano. El listado
 * solo enseña lo que la cuenta ve por sí misma; un repo ajeno donde solo eres
 * colaborador no aparece, y aquí es donde se sabe si se podrá clonar y, si no,
 * por qué (el servidor lo explica en el error).
 */
export function useRepoLookup(source: GithubSource, projectId?: string) {
  const enc = encodeURIComponent;
  const path =
    source.kind === 'app'
      ? `/github/installations/${source.id}/repos/lookup`
      : source.kind === 'pat'
        ? `/connectors/${source.id}/repos/lookup`
        : projectId
          ? `/projects/${projectId}/github/lookup`
          : null;
  const extra = source.kind === 'app' && projectId ? `&projectId=${enc(projectId)}` : '';
  return useMutation({
    mutationFn: (repo: string) => {
      if (!path) throw new Error('Sin cuenta ni proyecto con los que comprobar el repositorio');
      return api.get<{ repo: GithubRepo; credential?: 'global' | 'public' }>(`${path}?repo=${enc(repo)}${extra}`);
    },
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

/**
 * Lista filtrable de repos de la cuenta elegida. El mismo cuadro admite pegar
 * una URL o escribir `owner/repo`: si no está en la lista se comprueba con la
 * cuenta (un repo ajeno donde eres colaborador no sale en el listado de la App
 * pero puede que sí se pueda clonar, y si no, se explica qué hacer).
 */
export function GithubRepoPicker({
  source,
  selected,
  filter,
  onFilter,
  onPick,
  enabled = true,
  projectId,
}: {
  source: GithubSource;
  /** owner/repo actualmente elegido. */
  selected: string;
  filter: string;
  onFilter: (value: string) => void;
  onPick: (repo: GithubRepo) => void;
  enabled?: boolean;
  /** Proyecto desde el que se usa la cuenta (acota el permiso de una instalación global). */
  projectId?: string;
}) {
  const repos = useGithubRepos(source, enabled);
  const needle = filter.trim().toLowerCase();
  const list = (repos.data?.repos ?? []).filter((r) => r.fullName.toLowerCase().includes(needle));
  const lookup = useRepoLookup(source, projectId);
  const sourceKey = encodeSource(source);

  // Lo escrito es un repo concreto que no está en la lista: se ofrece comprobarlo.
  const typed = parseRepoInput(filter);
  const typedInList = !!typed && (repos.data?.repos ?? []).some((r) => r.fullName.toLowerCase() === typed.toLowerCase());
  const canLookup = !!typed && !typedInList && !repos.isLoading && !lookup.isPending;
  // El repo elegido puede venir de una comprobación y no estar en la lista.
  const selectedOutside = !!selected && !(repos.data?.repos ?? []).some((r) => r.fullName === selected);

  const { mutate: runLookup, reset: resetLookup } = lookup;
  const check = (repo: string) => runLookup(repo, { onSuccess: (res) => onPick(res.repo) });

  // Una URL pegada se comprueba sola (con un respiro para no consultar a mitad
  // de pegado); el atajo owner/repo espera al botón, que a medio escribir
  // «a/b» ya es un repo válido para el analizador.
  useEffect(() => {
    if (!typed || typedInList || !/github\.com\//i.test(filter)) return;
    const t = setTimeout(() => check(typed), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, typed, typedInList, sourceKey]);

  // Al cambiar de cuenta, el resultado de la comprobación anterior ya no vale.
  useEffect(() => {
    resetLookup();
  }, [sourceKey, resetLookup]);

  return (
    <div className="rounded-lg border border-line bg-bg">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Search size={13} className="shrink-0 text-subtle" />
        <input
          className="h-8 w-full bg-transparent text-base outline-none placeholder:text-subtle sm:h-auto sm:text-xs"
          placeholder="Filtrar, o pegar la URL de un repo…"
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canLookup && typed) {
              e.preventDefault();
              check(typed);
            }
          }}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Filtrar repositorios o escribir uno (owner/repo o URL)"
        />
      </div>
      {/* overscroll-contain: la lista vive dentro de un modal que ya scrollea; sin
          esto, llegar al final arrastraba consigo la hoja entera en móvil. */}
      <div className="max-h-44 overflow-y-auto overscroll-contain p-1.5">
        {repos.isLoading && <Spinner label="Cargando repos…" />}
        {repos.isError && (
          <ErrorState
            compact
            title="No se han podido cargar los repositorios"
            error={repos.error}
            onRetry={() => repos.refetch()}
            retrying={repos.isFetching}
          />
        )}
        {selectedOutside && (
          <div className="mb-1 flex items-center gap-2 rounded-md bg-acc/[.14] px-2.5 py-1.5 text-xs shadow-[inset_2px_0_0_var(--color-acc)]">
            <CheckCircle2 size={12} className="shrink-0 text-ok" />
            <span className="min-w-0 flex-1 truncate font-mono">{selected}</span>
            <span className="shrink-0 text-subtle">acceso comprobado</span>
          </div>
        )}
        {repos.data && list.length === 0 && !typed && (
          <EmptyState
            compact
            icon={<Search />}
            title={needle ? 'Ningún repositorio coincide' : 'Esta cuenta no expone ningún repositorio'}
            description={
              needle
                ? `Nada que case con «${filter}». Puedes escribir el repo como owner/repo o pegar su URL.`
                : 'Da acceso a los repos que quieras desplegar desde la configuración de la App en GitHub, o escribe aquí owner/repo.'
            }
          />
        )}
        {typed && !typedInList && (
          <div className="mb-1 rounded-md border border-dashed border-line px-2.5 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate">
                <span className="font-mono">{typed}</span>
                <span className="text-subtle"> no está en la lista de esta cuenta.</span>
              </span>
              <Button type="button" size="sm" variant="secondary" onClick={() => check(typed)} loading={lookup.isPending} disabled={!canLookup && !lookup.isPending}>
                Comprobar acceso
              </Button>
            </div>
            {lookup.isError && (
              <p className="mt-1.5 flex items-start gap-1.5 text-warn">
                <AlertTriangle size={12} className="mt-px shrink-0" />
                <span>{(lookup.error as Error).message}</span>
              </p>
            )}
          </div>
        )}
        {list.map((r) => {
          const active = selected === r.fullName;
          return (
            <button
              key={r.fullName}
              type="button"
              onClick={() => onPick(r)}
              className={cx(
                'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors max-sm:py-2.5',
                active ? 'bg-acc/[.14] shadow-[inset_2px_0_0_var(--color-acc)]' : 'hover:bg-surface2',
              )}
              aria-pressed={active}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.fullName}</span>
              {r.private && (
                <span className="flex shrink-0 items-center gap-1 rounded-md border border-line bg-surface2 px-1.5 py-0.5 text-micro text-sub">
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

/**
 * Aviso bajo un campo de URL de repo: dice ANTES de guardar si la cuenta
 * elegida (o el token global, o nadie) va a poder clonarlo. Se comprueba con un
 * respiro tras dejar de escribir; sin cuenta y sin proyecto no hay con qué mirar.
 */
export function RepoAccessHint({
  source,
  repo,
  projectId,
  enabled = true,
}: {
  source: GithubSource;
  /** Lo que hay escrito en el campo (URL o owner/repo). */
  repo: string;
  projectId?: string;
  enabled?: boolean;
}) {
  const lookup = useRepoLookup(source, projectId);
  const slug = parseRepoInput(repo);
  const sourceKey = encodeSource(source);
  const { mutate, reset } = lookup;
  useEffect(() => {
    reset();
    if (!enabled || !slug) return;
    const t = setTimeout(() => mutate(slug), 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, sourceKey, projectId, enabled]);

  if (!slug || !enabled) return null;
  if (lookup.isPending) return <p className="mt-1 text-xs text-subtle">Comprobando el acceso a {slug}…</p>;
  if (lookup.isError) {
    return (
      <p className="mt-1 flex items-start gap-1.5 text-xs text-warn">
        <AlertTriangle size={12} className="mt-px shrink-0" />
        <span>{(lookup.error as Error).message}</span>
      </p>
    );
  }
  if (lookup.data) {
    const r = lookup.data.repo;
    const como =
      lookup.data.credential === 'public'
        ? 'público: se clona sin cuenta'
        : lookup.data.credential === 'global'
          ? 'visible con el token global del servidor'
          : r.private
            ? 'privado, visible con esta cuenta'
            : 'visible con esta cuenta';
    return (
      <p className="mt-1 flex items-center gap-1.5 text-xs text-sub">
        <CheckCircle2 size={12} className="shrink-0 text-ok" />
        <span>
          <span className="font-mono">{r.fullName}</span> · {como} · rama por defecto <span className="font-mono">{r.defaultBranch}</span>
        </span>
      </p>
    );
  }
  return null;
}
