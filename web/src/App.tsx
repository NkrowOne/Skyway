import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import { Spinner } from './components/ui';
import Layout from './components/Layout';
import { Me } from './types';

// Carga diferida por ruta: el arranque solo trae el marco (Layout) y cada página
// llega en su propio chunk al visitarla. Reduce mucho el bundle inicial.
const AccountPage = lazy(() => import('./pages/Account'));
const AlertsPage = lazy(() => import('./pages/Alerts'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Login = lazy(() => import('./pages/Login'));
const MonitorPage = lazy(() => import('./pages/Monitor'));
const ProjectPage = lazy(() => import('./pages/Project'));
const PublicStatusPage = lazy(() => import('./pages/PublicStatus'));
const SecurityPage = lazy(() => import('./pages/Security'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const Setup = lazy(() => import('./pages/Setup'));
const SitesPage = lazy(() => import('./pages/Sites'));
const UsersPage = lazy(() => import('./pages/Users'));
const WorkspacesPage = lazy(() => import('./pages/Workspaces'));
const WorkspacePage = lazy(() => import('./pages/Workspace'));
const PlansPage = lazy(() => import('./pages/Plans'));
const CatalogPage = lazy(() => import('./pages/Catalog'));
const AccountingPage = lazy(() => import('./pages/Accounting'));

const pageFallback = (
  <div className="flex h-full items-center justify-center">
    <Spinner />
  </div>
);

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
      <Suspense fallback={pageFallback}>
        <Routes>
          <Route path="/status/:token" element={<PublicStatusPage />} />
          {/* /status/ sin token: al panel (que pedirá login si toca). */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
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
    <Suspense fallback={pageFallback}>
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
          {/* Cuentas de cliente: admin (todas) y propietario (la suya). */}
          {(user?.role === 'admin' || user?.role === 'owner') && (
            <>
              <Route path="/workspaces" element={<WorkspacesPage />} />
              <Route path="/workspaces/:id" element={<WorkspacePage />} />
            </>
          )}
          {user?.role === 'admin' && (
            <>
              <Route path="/plans" element={<PlansPage />} />
              <Route path="/catalog" element={<CatalogPage />} />
              <Route path="/accounting" element={<AccountingPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/security" element={<SecurityPage />} />
              <Route path="/users" element={<UsersPage />} />
            </>
          )}
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
