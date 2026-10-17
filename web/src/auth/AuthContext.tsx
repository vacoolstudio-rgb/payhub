import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, tokenStore } from '../api/rest';
import type { AuthenticatedUser } from '../api/types';

interface AuthState {
  user: AuthenticatedUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  token: string | null;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Session handling.
 *
 * The access token lives in memory only — never in `localStorage`, which
 * any XSS can read. Persistence comes from the httpOnly refresh cookie the
 * API sets, so a page reload silently re-authenticates through `/refresh`
 * without the token ever being reachable from JavaScript.
 */
export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const refreshTimer = useRef<number | undefined>(undefined);

  const apply = useCallback((response: { accessToken: string; expiresIn: number; user: AuthenticatedUser }) => {
    tokenStore.set(response.accessToken);
    setToken(response.accessToken);
    setUser(response.user);

    // Refresh a minute before expiry so a long-lived tab never shows a
    // spurious 401 mid-interaction.
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(
      () => {
        void api
          .refresh()
          .then(apply)
          .catch(() => {
            tokenStore.set(null);
            setToken(null);
            setUser(null);
          });
      },
      Math.max(5_000, (response.expiresIn - 60) * 1_000),
    );
  }, []);

  useEffect(() => {
    // Rotation means this consumes the stored refresh token and issues a
    // fresh pair; presenting the old one again would trip reuse detection.
    api
      .refresh()
      .then(apply)
      .catch(() => undefined)
      .finally(() => setLoading(false));

    return () => window.clearTimeout(refreshTimer.current);
  }, [apply]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      token,
      loading,
      login: async (email, password) => apply(await api.login(email, password)),
      register: async (email, password, displayName) =>
        apply(await api.register(email, password, displayName)),
      logout: async () => {
        await api.logout().catch(() => undefined);
        window.clearTimeout(refreshTimer.current);
        tokenStore.set(null);
        setToken(null);
        setUser(null);
      },
    }),
    [user, token, loading, apply],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return context;
}
