import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { AlertTriangle, LogOut, Rocket, Settings } from 'lucide-react';
import { api } from '../api';
import { SystemInfo } from '../types';
import { fmtBytes } from '../utils';

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
        <div className="flex items-center gap-2">
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
