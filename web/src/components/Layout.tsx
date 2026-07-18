import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { AlertTriangle, Bell, LogOut, Rocket, Settings, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { Alert, SystemInfo } from '../types';
import { cx, fmtBytes, SEVERITY_STYLE, timeAgo } from '../utils';

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
        className="relative rounded-lg p-2 text-sub transition-colors hover:bg-panel2 hover:text-txt"
        title="Alertas"
      >
        <Bell size={16} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-err px-1 text-[10px] font-semibold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-50 w-96 rounded-xl border border-line bg-panel shadow-2xl shadow-black/50">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-sm font-semibold">Alertas</span>
            <Link to="/alerts" onClick={() => setOpen(false)} className="text-xs text-acc hover:underline">
              Ver todas
            </Link>
          </div>
          <div className="max-h-96 overflow-y-auto p-2">
            {(alerts.data?.alerts ?? []).length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-sub">Sin alertas. Todo tranquilo. ✨</p>
            )}
            {alerts.data?.alerts.map((a) => (
              <Link
                key={a.id}
                to={a.project_id ? `/projects/${a.project_id}${a.service_id ? `?s=${a.service_id}` : ''}` : '/alerts'}
                onClick={() => setOpen(false)}
                className="block rounded-lg px-3 py-2 hover:bg-panel2"
              >
                <div className="flex items-center gap-2">
                  <span className={cx('rounded-full border px-1.5 py-0.5 text-[10px]', SEVERITY_STYLE[a.severity])}>
                    {a.resolved_at ? 'resuelta' : 'activa'}
                  </span>
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

export default function Layout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const system = useQuery({
    queryKey: ['system'],
    queryFn: () => api.get<SystemInfo>('/system'),
    refetchInterval: 30_000,
  });

  const logout = async () => {
    await api.post('/auth/logout');
    queryClient.clear();
    navigate('/login');
  };

  const sys = system.data;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-panel px-4">
        <Link to="/" className="flex items-center gap-2 text-sm font-semibold tracking-wide">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-acc/20 text-acc">
            <Rocket size={15} />
          </span>
          Skyway
        </Link>
        <div className="flex items-center gap-1.5">
          {sys && (
            <div className="mr-2 hidden items-center gap-3 rounded-lg border border-line bg-panel2 px-3 py-1.5 text-xs text-sub sm:flex">
              <span>
                CPU <span className="text-txt">{sys.host.load[0]}</span> / {sys.host.cpus}
              </span>
              <span className="text-line">|</span>
              <span>
                RAM libre <span className="text-txt">{fmtBytes(sys.host.freeMem)}</span>
              </span>
            </div>
          )}
          <AlertBell />
          <Link
            to="/security"
            className="rounded-lg p-2 text-sub transition-colors hover:bg-panel2 hover:text-txt"
            title="Panel de seguridad"
          >
            <ShieldCheck size={16} />
          </Link>
          <Link to="/settings" className="rounded-lg p-2 text-sub transition-colors hover:bg-panel2 hover:text-txt" title="Ajustes">
            <Settings size={16} />
          </Link>
          <button onClick={logout} className="rounded-lg p-2 text-sub transition-colors hover:bg-panel2 hover:text-txt" title="Cerrar sesión">
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
    </div>
  );
}
