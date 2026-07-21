import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import { Spinner } from './components/ui';
import Layout from './components/Layout';
import AccountPage from './pages/Account';
import AlertsPage from './pages/Alerts';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import MonitorPage from './pages/Monitor';
import ProjectPage from './pages/Project';
import PublicStatusPage from './pages/PublicStatus';
import SecurityPage from './pages/Security';
import SettingsPage from './pages/Settings';
import Setup from './pages/Setup';
import SitesPage from './pages/Sites';
import UsersPage from './pages/Users';
import { Me } from './types';

export default function App() {
  const location = useLocation();
  // La página de estado pública no requiere sesión (la ven los clientes).
  const isPublic = location.pathname.startsWith('/status/');
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/auth/me'),
    staleTime: 60_000,
    enabled: !isPublic,
  });

  if (isPublic) {
    return (
      <Routes>
        <Route path="/status/:token" element={<PublicStatusPage />} />
        {/* /status/ sin token: al panel (que pedirá login si toca). */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  if (me.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Cargando Skyway..." />
      </div>
    );
  }

  if (me.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-sub">
        <p>No se pudo conectar con el servidor de Skyway.</p>
        <p className="font-mono text-xs">{String((me.error as Error).message)}</p>
      </div>
    );
  }

  const { needsSetup, user } = me.data!;

  if (needsSetup && location.pathname !== '/setup') return <Navigate to="/setup" replace />;
  if (!needsSetup && !user && location.pathname !== '/login') return <Navigate to="/login" replace />;
  if (user && (location.pathname === '/login' || location.pathname === '/setup')) return <Navigate to="/" replace />;

  return (
    <Routes>
      <Route path="/setup" element={<Setup />} />
      <Route path="/login" element={<Login />} />
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/projects/:projectId" element={<ProjectPage />} />
        <Route path="/monitor" element={<MonitorPage />} />
        <Route path="/sites" element={<SitesPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/alerts" element={<AlertsPage />} />
        {user?.role === 'admin' && (
          <>
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/security" element={<SecurityPage />} />
            <Route path="/users" element={<UsersPage />} />
          </>
        )}
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
