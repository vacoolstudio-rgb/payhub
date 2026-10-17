import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/rest';
import { useAuth } from './AuthContext';

export function LoginPage(): React.JSX.Element {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('ada@payhub.dev');
  const [password, setPassword] = useState('correct horse battery staple');
  const [displayName, setDisplayName] = useState('Ada Lovelace');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await register(email, password, displayName);
      }
    } catch (caught) {
      // The API speaks problem details, so there is always something
      // specific to show — including the correlation id for support.
      setError(
        caught instanceof ApiError
          ? `${caught.problem.detail}${caught.problem.correlationId ? ` (${caught.problem.correlationId.slice(0, 8)})` : ''}`
          : 'Unexpected error',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <form className="card auth-card" onSubmit={onSubmit}>
        <h1 className="brand">PayHub</h1>
        <p className="muted">Wallets, double-entry ledger and payments.</p>

        <div className="tabs">
          <button
            type="button"
            className={mode === 'login' ? 'tab active' : 'tab'}
            onClick={() => setMode('login')}
          >
            Sign in
          </button>
          <button
            type="button"
            className={mode === 'register' ? 'tab active' : 'tab'}
            onClick={() => setMode('register')}
          >
            Create account
          </button>
        </div>

        {mode === 'register' && (
          <label>
            Name
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
          </label>
        )}

        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={12}
            required
          />
          {mode === 'register' && <small className="muted">At least 12 characters.</small>}
        </label>

        {error && <p className="error">{error}</p>}

        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </form>
    </div>
  );
}
