import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { fetchDashboard, type DashboardData } from '../api/graphql';
import { useAuth } from '../auth/AuthContext';
import { useRealtime } from '../realtime/useRealtime';
import { AssistantPanel } from '../assistant/AssistantPanel';
import { NewPaymentForm } from './NewPaymentForm';

const STATUS_TONE: Record<string, string> = {
  CAPTURED: 'ok',
  REFUNDED: 'ok',
  PENDING: 'warn',
  AUTHORIZED: 'warn',
  CAPTURING: 'warn',
  REFUNDING: 'warn',
  FAILED: 'bad',
  CANCELLED: 'bad',
};

export function DashboardPage(): React.JSX.Element {
  const { user, token, logout } = useAuth();
  const queryClient = useQueryClient();
  const [liveEvents, setLiveEvents] = useState<string[]>([]);

  const dashboard = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: () => fetchDashboard(20, 'USD'),
    // No polling: the WebSocket pushes changes. A refetch on focus covers
    // the window where the tab was asleep and missed a push.
    refetchOnWindowFocus: true,
  });

  const record = useCallback((line: string) => {
    setLiveEvents((previous) => [`${new Date().toLocaleTimeString()} — ${line}`, ...previous].slice(0, 8));
  }, []);

  const { connected } = useRealtime(token, {
    onPaymentUpdated: (payment) => {
      record(`payment ${payment.id.slice(0, 8)} → ${payment.status}`);
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onWalletUpdated: (wallet) => {
      record(`balance → ${wallet.available.minor} ${wallet.available.currency} (minor)`);
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const data = dashboard.data;

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <span className="brand">PayHub</span>
          <span className="muted"> · {user?.displayName}</span>
        </div>
        <div className="topbar-right">
          <span className={connected ? 'status ok' : 'status bad'}>
            <span className="dot" /> {connected ? 'live' : 'offline'}
          </span>
          <button className="ghost" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>

      <main className="grid">
        <section className="card">
          <header className="card-head">
            <h2>Balances</h2>
            <span className="pill">GraphQL · gRPC → ledger</span>
          </header>

          {dashboard.isLoading && <p className="muted">Loading…</p>}
          {dashboard.isError && <p className="error">Could not load the dashboard.</p>}

          <div className="wallets">
            {(data?.wallets ?? []).map((wallet) => (
              <article key={wallet.id} className="wallet">
                <span className="currency">{wallet.currency}</span>
                <strong className="amount">{wallet.available.major}</strong>
                {wallet.pending.minor !== '0' && (
                  <span className="muted">{wallet.pending.major} pending</span>
                )}
              </article>
            ))}
            {data?.wallets.length === 0 && <p className="muted">No wallets yet — make a deposit.</p>}
          </div>

          {data?.paymentStats && (
            <div className="stats">
              <div>
                <span className="muted">30-day volume</span>
                <strong>
                  {data.paymentStats.volume.major} {data.paymentStats.volume.currency}
                </strong>
              </div>
              <div>
                <span className="muted">Fees</span>
                <strong>{data.paymentStats.fees.major}</strong>
              </div>
              <div>
                <span className="muted">Captured</span>
                <strong>
                  {data.paymentStats.capturedCount}/{data.paymentStats.totalCount}
                </strong>
              </div>
              <div>
                <span className="muted">Failed</span>
                <strong>{data.paymentStats.failedCount}</strong>
              </div>
            </div>
          )}
        </section>

        <NewPaymentForm />

        <section className="card wide">
          <header className="card-head">
            <h2>Payments</h2>
            <span className="pill">GraphQL · DataLoader</span>
          </header>

          <table className="table">
            <thead>
              <tr>
                <th>Created</th>
                <th>Merchant</th>
                <th>Direction</th>
                <th className="right">Amount</th>
                <th className="right">Fee</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {(data?.payments.items ?? []).map((payment) => (
                <tr key={payment.id}>
                  <td className="muted">{new Date(payment.createdAt).toLocaleString()}</td>
                  <td>{payment.merchant?.name ?? '—'}</td>
                  <td>{payment.direction.toLowerCase()}</td>
                  <td className="right mono">
                    {payment.amount.major} {payment.amount.currency}
                  </td>
                  <td className="right mono muted">{payment.fee.major}</td>
                  <td>
                    <span className={`status ${STATUS_TONE[payment.status] ?? ''}`}>
                      <span className="dot" />
                      {payment.status.toLowerCase()}
                      {payment.failureReason ? ` · ${payment.failureReason}` : ''}
                    </span>
                  </td>
                </tr>
              ))}
              {data?.payments.items.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No payments yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <AssistantPanel />

        <section className="card">
          <header className="card-head">
            <h2>Live feed</h2>
            <span className="pill">WebSocket</span>
          </header>
          <ul className="feed">
            {liveEvents.length === 0 && <li className="muted">Waiting for events…</li>}
            {liveEvents.map((line, index) => (
              <li key={`${line}-${index}`} className="mono">
                {line}
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
