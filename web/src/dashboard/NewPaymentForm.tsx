import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api/rest';

export function NewPaymentForm(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('25.00');
  const [direction, setDirection] = useState('deposit');
  const [method, setMethod] = useState('card');
  const [merchantId, setMerchantId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const merchants = useQuery({ queryKey: ['merchants'], queryFn: api.merchants });

  const create = useMutation({
    mutationFn: () =>
      api.createPayment({
        merchantId: merchantId || merchants.data?.[0]?.id || '',
        direction,
        amount,
        currency: 'USD',
        method,
      }),
    onSuccess: () => {
      setError(null);
      // The WebSocket will push the terminal state; this refetch just gets
      // the pending row on screen immediately.
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (caught: unknown) =>
      setError(caught instanceof ApiError ? caught.problem.detail : 'Payment failed'),
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    create.mutate();
  }

  const activeMerchants = (merchants.data ?? []).filter((merchant) => merchant.status === 'active');

  return (
    <section className="card">
      <header className="card-head">
        <h2>New payment</h2>
        <span className="pill">REST + Idempotency-Key</span>
      </header>

      <form className="payment-form" onSubmit={onSubmit}>
        <label>
          Merchant
          <select value={merchantId} onChange={(event) => setMerchantId(event.target.value)}>
            {activeMerchants.length === 0 && <option value="">No active merchant</option>}
            {activeMerchants.map((merchant) => (
              <option key={merchant.id} value={merchant.id}>
                {merchant.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Direction
          <select value={direction} onChange={(event) => setDirection(event.target.value)}>
            <option value="deposit">Deposit</option>
            <option value="withdrawal">Withdrawal</option>
          </select>
        </label>

        <label>
          Method
          <select value={method} onChange={(event) => setMethod(event.target.value)}>
            <option value="card">Card</option>
            <option value="bank_transfer">Bank transfer</option>
          </select>
        </label>

        <label>
          Amount (USD)
          {/* A text input, not `type="number"`: the amount travels as a
              decimal string so it never passes through a float. */}
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            pattern="\d+(\.\d{1,2})?"
            required
          />
        </label>

        <button className="primary" type="submit" disabled={create.isPending || activeMerchants.length === 0}>
          {create.isPending ? 'Submitting…' : 'Create payment'}
        </button>
      </form>

      {error && <p className="error">{error}</p>}
    </section>
  );
}
