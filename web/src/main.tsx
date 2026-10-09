import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { setUnauthorizedHandler } from './api';
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider } from './components/ui';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
      gcTime: 5 * 60_000,
    },
  },
});

/**
 * Sesión caducada: se vacía el usuario en la caché y App se encarga de mandar
 * al login. Se para el sondeo de fondo antes, para que las consultas en curso
 * no llenen la pantalla de errores mientras se navega.
 */
setUnauthorizedHandler(() => {
  const me = queryClient.getQueryData<{ user: unknown }>(['me']);
  if (me && me.user === null) return; // ya estábamos fuera: nada que hacer
  queryClient.cancelQueries();
  queryClient.setQueryData(['me'], { needsSetup: false, user: null });
});

/*
 * `useTransitions={false}`: React Router 7 envuelve por defecto en
 * `React.startTransition` las actualizaciones del router, y eso cambia la
 * prioridad de esos renders y cuándo aparece el indicador de un `Suspense` que
 * ya estaba visible (se mantiene la pantalla anterior hasta que llega el chunk,
 * p. ej. al cambiar `?s=` en un proyecto). La 6 lo hacía sin transiciones (no se
 * activó `v7_startTransition`); así se conserva ese comportamiento.
 */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter useTransitions={false}>
        <ToastProvider>
          <ErrorBoundary scope="el panel">
            <App />
          </ErrorBoundary>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
