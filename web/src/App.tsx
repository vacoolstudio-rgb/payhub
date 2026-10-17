import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { LoginPage } from './auth/LoginPage';
import { DashboardPage } from './dashboard/DashboardPage';

/**
 * One query client for the app.
 *
 * `retry: 1` rather than the default 3: a 4xx from this API is a problem
 * detail the user needs to see, not something to hide behind three silent
 * retries. Infrastructure failures are retried by the server side anyway.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: true },
    mutations: { retry: 0 },
  },
});

function Routes(): React.JSX.Element {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="auth-shell">
        <p className="muted">Restoring session…</p>
      </div>
    );
  }

  return user ? <DashboardPage /> : <LoginPage />;
}

export function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Routes />
      </AuthProvider>
    </QueryClientProvider>
  );
}
