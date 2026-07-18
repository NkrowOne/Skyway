import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import { Spinner } from './components/ui';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import ProjectPage from './pages/Project';
import SettingsPage from './pages/Settings';
import Setup from './pages/Setup';

interface Me {
  needsSetup: boolean;
  user: { id: string; email: string } | null;
}

export default function App() {
  const location = useLocation();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/auth/me'),
    staleTime: 60_000,
  });

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
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
