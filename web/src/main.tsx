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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <ErrorBoundary scope="el panel">
            <App />
          </ErrorBoundary>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
