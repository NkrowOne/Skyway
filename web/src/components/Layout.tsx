import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useMatch, useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Bell,
  BellRing,
  Boxes,
  Building2,
  ChevronRight,
  Globe,
  Keyboard,
  LogOut,
  Rocket,
  Search,
  Settings,
  ShieldCheck,
  UserRound,
  Users2,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { isEditableTarget } from '../hooks';
import { Alert, Me, Project, Service, SystemInfo } from '../types';
import { cx, fmtBytes, SEVERITY_TONE, timeAgo } from '../utils';
import { Kbd, StatusBadge } from './ui';

/** Logo de Skyway: chip con gradiente de marca. */
export function BrandMark({ size = 28, iconSize = 15, radius = 8 }: { size?: number; iconSize?: number; radius?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center text-white shadow-[0_2px_8px_-2px_color-mix(in_oklab,#6e56cf_60%,transparent)]"
      style={{ width: size, height: size, borderRadius: radius, background: 'linear-gradient(135deg, #6e56cf, oklch(42% 0.16 295))' }}
    >
      <Rocket size={iconSize} />
    </span>
  );
}

const PAGE_LABEL: Record<string, string> = {
  '/security': 'Seguridad',
  '/settings': 'Ajustes',
  '/alerts': 'Alertas',
  '/users': 'Usuarios',
  '/account': 'Mi cuenta',
  '/monitor': 'Monitor',
  '/sites': 'Sitios web',
};

// ---------- Paleta de comandos (⌘K) ----------

interface PaletteItem {
  key: string;
  group: 'Proyectos' | 'Acciones rápidas';
  icon: React.ReactNode;
  label: React.ReactNode;
  meta?: React.ReactNode;
  keywords: string;
  to: string;
}

function CommandPalette({ open, onClose, unread, isAdmin }: { open: boolean; onClose: () => void; unread: number; isAdmin: boolean }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: Project[] }>('/projects'),
    enabled: open,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (open) {
      setQuery('');
      setSel(0);
    }
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = (projects.data?.projects ?? []).map((p) => ({
      key: `p-${p.id}`,
      group: 'Proyectos',
      icon: <Boxes size={15} className="text-acc-soft" />,
      label: p.name,
      meta: p.client ?? undefined,
      keywords: `${p.name} ${p.slug} ${p.client ?? ''}`.toLowerCase(),
      to: `/projects/${p.id}`,
    }));
    const actions: PaletteItem[] = [
      {
        key: 'a-monitor',
        group: 'Acciones rápidas',
        icon: <Activity size={15} className="text-subtle" />,
        label: 'Monitor: todos los servicios y buscador de logs',
        keywords: 'monitor debug logs estado cpu ram disco buscar depurar',
        to: '/monitor',
      },
      {
        key: 'a-sites',
        group: 'Acciones rápidas',
        icon: <Globe size={15} className="text-subtle" />,
        label: 'Sitios web desplegados',
        keywords: 'sitios webs dominios paginas tls https',
        to: '/sites',
      },
      {
        key: 'a-alerts',
        group: 'Acciones rápidas',
        icon: <BellRing size={15} className="text-subtle" />,
        label: 'Ver alertas activas',
        meta:
          unread > 0 ? (
            <span className="inline-flex items-center rounded-full bg-err/[.15] px-2 py-0.5 text-[11px] font-semibold text-err">{unread}</span>
          ) : undefined,
        keywords: 'alertas avisos notificaciones',
        to: '/alerts',
      },
      {
        key: 'a-account',
        group: 'Acciones rápidas',
        icon: <UserRound size={15} className="text-subtle" />,
        label: 'Mi cuenta (passkeys y tokens)',
        keywords: 'cuenta passkey token contraseña api',
        to: '/account',
      },
      ...(isAdmin
        ? [
            {
              key: 'a-users',
              group: 'Acciones rápidas' as const,
              icon: <Users2 size={15} className="text-subtle" />,
              label: 'Gestionar usuarios',
              keywords: 'usuarios roles clientes workspaces permisos',
              to: '/users',
            },
            {
              key: 'a-security',
              group: 'Acciones rápidas' as const,
              icon: <ShieldCheck size={15} className="text-subtle" />,
              label: 'Abrir panel de seguridad',
              keywords: 'seguridad auditoria contraseña',
              to: '/security',
            },
            {
              key: 'a-settings',
              group: 'Acciones rápidas' as const,
              icon: <Settings size={15} className="text-subtle" />,
              label: 'Ajustes del servidor',
              keywords: 'ajustes configuracion dominios github telegram',
              to: '/settings',
            },
          ]
        : []),
    ];
    const q = query.trim().toLowerCase();
    const all = [...list, ...actions];
    return q ? all.filter((i) => i.keywords.includes(q)) : all;
  }, [projects.data, query, unread, isAdmin]);

  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, items.length - 1)));
  }, [items.length]);

  useEffect(() => {
    // Mantiene visible la fila seleccionada al navegar con flechas.
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;

  const go = (item: PaletteItem) => {
    onClose();
    navigate(item.to);
  };

  const groups: PaletteItem['group'][] = ['Proyectos', 'Acciones rápidas'];

  return createPortal(
    <div
      className="overlay-in fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-4 pb-4 pt-[15vh] backdrop-blur-[3px]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Paleta de comandos"
        className="panel-in w-full max-w-[580px] overflow-hidden rounded-2xl border border-line bg-surface shadow-lvl3"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3.5">
          <Search size={16} className="shrink-0 text-subtle" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, items.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === 'Enter' && items[sel]) {
                e.preventDefault();
                go(items[sel]);
              }
            }}
            placeholder="Busca proyectos, servicios o acciones…"
            className="flex-1 bg-transparent text-[15px] text-txt outline-none placeholder:text-subtle focus-visible:[outline:none]"
          />
          <Kbd>esc</Kbd>
        </div>
        <div ref={listRef} className="max-h-[380px] overflow-y-auto p-2">
          {items.length === 0 && <p className="px-3 py-8 text-center text-sm text-subtle">Sin resultados para «{query}»</p>}
          {groups.map((g) => {
            const rows = items.filter((i) => i.group === g);
            if (rows.length === 0) return null;
            return (
              <div key={g}>
                <p className="mx-2 mb-1.5 mt-1.5 text-[11px] font-semibold uppercase tracking-[.08em] text-subtle">{g}</p>
                {rows.map((item) => {
                  const idx = items.indexOf(item);
                  const selected = idx === sel;
                  return (
                    <button
                      key={item.key}
                      data-idx={idx}
                      onClick={() => go(item)}
                      onMouseMove={() => setSel(idx)}
                      className={cx(
                        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[9px] text-left',
                        selected && 'bg-acc/[.14] shadow-[inset_2px_0_0_#6e56cf]',
                      )}
                    >
                      {item.icon}
                      <span className="flex-1 truncate text-sm text-txt">{item.label}</span>
                      {item.meta && <span className="shrink-0 text-xs text-subtle">{item.meta}</span>}
                      {selected && <Kbd>↵</Kbd>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3.5 border-t border-line bg-bg px-4 py-2 text-[11px] text-subtle">
          <span className="flex items-center gap-1">
            <Kbd>↑↓</Kbd> navegar
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> abrir
          </span>
          <span className="flex items-center gap-1">
            <Kbd>esc</Kbd> cerrar
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Kbd>?</Kbd> atajos
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------- Ayuda de atajos (?) ----------

function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  const rows: { label: string; keys: string[] }[] = [
    { label: 'Paleta de comandos', keys: ['⌘K'] },
    { label: 'Ir a proyectos', keys: ['g', 'p'] },
    { label: 'Ir al monitor', keys: ['g', 'm'] },
    { label: 'Ir a sitios web', keys: ['g', 'w'] },
    { label: 'Ir a seguridad', keys: ['g', 's'] },
    { label: 'Ir a alertas', keys: ['g', 'a'] },
    { label: 'Cerrar drawer / modales', keys: ['esc'] },
    { label: 'Esta ayuda', keys: ['?'] },
  ];
  return createPortal(
    <div
      className="overlay-in fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[3px]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Atajos de teclado"
        className="panel-in w-full max-w-[420px] rounded-2xl border border-line bg-surface p-5 shadow-lvl3"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-3.5 flex items-center gap-2">
          <Keyboard size={16} className="text-acc" />
          <h2 className="text-[15px] font-semibold">Atajos de teclado</h2>
        </div>
        <div className="flex flex-col gap-2.5 text-[13px]">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between">
              <span className="text-sub">{r.label}</span>
              <span className="flex gap-1">
                {r.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------- Campana de alertas ----------

function AlertBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const alerts = useQuery({
    queryKey: ['alerts', 'bell'],
    queryFn: () => api.get<{ alerts: Alert[]; unread: number }>('/alerts?limit=6'),
    refetchInterval: 15_000,
  });

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, []);

  const unread = alerts.data?.unread ?? 0;

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && unread > 0) {
      await api.post('/alerts/read-all');
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={toggle}
        className="relative rounded-lg p-2 leading-none text-sub transition-colors duration-150 hover:bg-surface2 hover:text-txt"
        title="Alertas"
      >
        <Bell size={16} />
        {unread > 0 && (
          <span className="absolute -right-px -top-px flex h-[15px] min-w-[15px] items-center justify-center rounded-full border-2 border-surface bg-err px-[3px] text-[9px] font-bold leading-none text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-50 w-96 max-w-[calc(100vw-24px)] rounded-xl border border-line bg-surface shadow-lvl3">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-sm font-semibold">Alertas</span>
            <Link to="/alerts" onClick={() => setOpen(false)} className="text-xs font-semibold text-acc-soft hover:underline">
              Ver todas
            </Link>
          </div>
          <div className="max-h-96 overflow-y-auto p-2">
            {(alerts.data?.alerts ?? []).length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-sub">Sin alertas. Todo en orden.</p>
            )}
            {alerts.data?.alerts.map((a) => (
              <Link
                key={a.id}
                to={a.project_id ? `/projects/${a.project_id}${a.service_id ? `?s=${a.service_id}` : ''}` : '/alerts'}
                onClick={() => setOpen(false)}
                className="block rounded-lg px-3 py-2 hover:bg-surface2"
              >
                <div className="flex items-center gap-2">
                  <StatusBadge
                    tone={a.resolved_at ? 'neutral' : SEVERITY_TONE[a.severity]}
                    label={a.resolved_at ? 'resuelta' : 'activa'}
                    dot={false}
                    className="px-2 py-0.5 text-[10px]"
                  />
                  <span className="truncate text-xs font-medium">{a.title}</span>
                </div>
                <p className="mt-0.5 truncate text-[11px] text-sub">
                  {a.message} · {timeAgo(a.ts)}
                </p>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Layout ----------

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [cmdOpen, setCmdOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const pendingG = useRef<number | null>(null);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/auth/me'),
    staleTime: 60_000,
  });
  const isAdmin = me.data?.user?.role === 'admin';

  const system = useQuery({
    queryKey: ['system'],
    queryFn: () => api.get<SystemInfo>('/system'),
    refetchInterval: 30_000,
  });

  const bell = useQuery({
    queryKey: ['alerts', 'bell'],
    queryFn: () => api.get<{ alerts: Alert[]; unread: number }>('/alerts?limit=6'),
    refetchInterval: 15_000,
  });

  const projectMatch = useMatch('/projects/:projectId');
  const projectId = projectMatch?.params.projectId;
  // Se suscribe a la caché que llena la página de proyecto (misma queryKey), sin lanzar otra petición.
  const projectData = useQuery<{ project: Project; services: Service[] }>({
    queryKey: ['project', projectId],
    queryFn: () => api.get(`/projects/${projectId}`),
    enabled: false,
  });

  const pageLabel = PAGE_LABEL[location.pathname] ?? (projectId ? projectData.data?.project.name ?? '…' : null);
  const clientPill = projectId ? projectData.data?.project.client : null;
  const isHome = location.pathname === '/';

  // Atajos globales: ⌘K, ?, esc, g+p/s/a.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((v) => !v);
        setHelpOpen(false);
        return;
      }
      if (e.key === 'Escape') {
        if (cmdOpen || helpOpen) {
          e.preventDefault();
          setCmdOpen(false);
          setHelpOpen(false);
        }
        return;
      }
      if (isEditableTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '?' && !cmdOpen) {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      if (cmdOpen || helpOpen) return;
      if (e.key === 'g') {
        if (pendingG.current) window.clearTimeout(pendingG.current);
        pendingG.current = window.setTimeout(() => (pendingG.current = null), 800);
        return;
      }
      if (pendingG.current) {
        const dest = { p: '/', s: '/security', a: '/alerts', m: '/monitor', w: '/sites' }[
          e.key as 'p' | 's' | 'a' | 'm' | 'w'
        ];
        window.clearTimeout(pendingG.current);
        pendingG.current = null;
        if (dest) {
          e.preventDefault();
          navigate(dest);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cmdOpen, helpOpen, navigate]);

  const logout = async () => {
    await api.post('/auth/logout');
    queryClient.clear();
    navigate('/login');
  };

  const sys = system.data;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Link to="/" className="flex shrink-0 items-center gap-2.5 text-sm font-[650] tracking-[.01em] text-txt">
            <BrandMark />
            <span className={cx(!isHome && 'hidden md:inline')}>Skyway</span>
          </Link>
          {pageLabel && (
            <>
              <ChevronRight size={14} className="shrink-0 text-subtle" />
              <span className="truncate text-sm font-medium">{pageLabel}</span>
              {clientPill && (
                <span className="hidden shrink-0 items-center gap-[5px] rounded-full border border-line bg-bg px-2.5 py-0.5 text-[11px] text-sub sm:flex">
                  <Building2 size={10} /> {clientPill}
                </span>
              )}
            </>
          )}
        </div>

        {isHome && (
          <button
            onClick={() => setCmdOpen(true)}
            className="hidden min-w-0 flex-[0_1_300px] items-center gap-2 rounded-lg border border-line bg-bg py-1.5 pl-3 pr-2 text-[13px] text-subtle transition-colors duration-150 hover:border-[color-mix(in_oklab,#6e56cf_45%,var(--color-line))] hover:text-sub sm:flex"
          >
            <Search size={14} className="shrink-0" />
            <span className="flex-1 truncate text-left">Buscar o saltar a…</span>
            <Kbd>⌘K</Kbd>
          </button>
        )}

        <div className="flex shrink-0 items-center gap-1">
          {!isHome && (
            <button
              onClick={() => setCmdOpen(true)}
              className="mr-1 flex items-center gap-2 rounded-lg border border-line bg-bg px-2.5 py-1.5 text-xs text-subtle transition-colors duration-150 hover:border-[color-mix(in_oklab,#6e56cf_45%,var(--color-line))]"
              title="Buscar (⌘K)"
            >
              <Search size={13} />
              <Kbd className="hidden border-0 bg-transparent p-0 sm:inline">⌘K</Kbd>
            </button>
          )}
          {isHome && (
            <button
              onClick={() => setCmdOpen(true)}
              className="rounded-lg p-2 leading-none text-sub transition-colors duration-150 hover:bg-surface2 hover:text-txt sm:hidden"
              title="Buscar (⌘K)"
            >
              <Search size={16} />
            </button>
          )}
          {sys && (
            <div className="mr-2 hidden items-center gap-2 rounded-full border border-line bg-bg px-3 py-[5px] text-xs text-sub nav:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-ok shadow-[0_0_6px_color-mix(in_oklab,var(--color-ok)_70%,transparent)]" />
              <span>
                CPU <span className="tnum text-txt">{sys.host.load[0]}</span>/{sys.host.cpus}
              </span>
              <span className="text-line">·</span>
              <span>
                RAM <span className="tnum text-txt">{fmtBytes(sys.host.freeMem)}</span> libres
              </span>
            </div>
          )}
          <Link
            to="/monitor"
            className="rounded-lg p-2 leading-none text-sub transition-colors duration-150 hover:bg-surface2 hover:text-txt"
            title="Monitor (g m)"
          >
            <Activity size={16} />
          </Link>
          <Link
            to="/sites"
            className="rounded-lg p-2 leading-none text-sub transition-colors duration-150 hover:bg-surface2 hover:text-txt"
            title="Sitios web (g w)"
          >
            <Globe size={16} />
          </Link>
          <AlertBell />
          {isAdmin && (
            <>
              <Link
                to="/users"
                className="rounded-lg p-2 leading-none text-sub transition-colors duration-150 hover:bg-surface2 hover:text-txt"
                title="Usuarios"
              >
                <Users2 size={16} />
              </Link>
              <Link
                to="/security"
                className="rounded-lg p-2 leading-none text-sub transition-colors duration-150 hover:bg-surface2 hover:text-txt"
                title="Panel de seguridad"
              >
                <ShieldCheck size={16} />
              </Link>
              <Link
                to="/settings"
                className="rounded-lg p-2 leading-none text-sub transition-colors duration-150 hover:bg-surface2 hover:text-txt"
                title="Ajustes"
              >
                <Settings size={16} />
              </Link>
            </>
          )}
          <Link
            to="/account"
            className="rounded-lg p-2 leading-none text-sub transition-colors duration-150 hover:bg-surface2 hover:text-txt"
            title="Mi cuenta"
          >
            <UserRound size={16} />
          </Link>
          <button
            onClick={logout}
            className="rounded-lg p-2 leading-none text-sub transition-colors duration-150 hover:bg-surface2 hover:text-txt"
            title="Cerrar sesión"
          >
            <LogOut size={16} />
          </button>
        </div>
      </header>

      {sys && !sys.docker && (
        <div className="flex items-center gap-2 border-b border-warn/30 bg-warn/10 px-4 py-2 text-xs text-warn">
          <AlertTriangle size={14} />
          Docker no está disponible: los despliegues fallarán hasta que el daemon sea accesible.
        </div>
      )}

      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>

      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} unread={bell.data?.unread ?? 0} isAdmin={isAdmin} />
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
