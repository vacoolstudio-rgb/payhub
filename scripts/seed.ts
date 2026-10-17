/**
 * Demo data.
 *
 * Idempotent on purpose: running it twice must not create a second merchant
 * or a duplicate user, so it is safe to wire into `docker compose up` or a
 * CI job. Everything goes through the public HTTP API rather than straight
 * into the database — that way the seed exercises the same validation,
 * authorisation and saga the real clients do, and a broken API fails the
 * seed instead of silently producing data no endpoint could have created.
 *
 *   npm run db:seed
 */
import { loadEnv } from '../libs/config/src/index.js';

const env = loadEnv();
const BASE = process.env['SEED_API_URL'] ?? `http://localhost:${env.PORT}/api/v1`;

interface Session {
  accessToken: string;
  user: { id: string; email: string; displayName: string; roles: string[] };
}

class SeedError extends Error {
  constructor(
    message: string,
    readonly detail: unknown,
  ) {
    super(message);
  }
}

async function call<T>(
  path: string,
  init: RequestInit & { token?: string; idempotencyKey?: string } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (init.token) {
    headers.set('authorization', `Bearer ${init.token}`);
  }
  if (init.idempotencyKey) {
    headers.set('idempotency-key', init.idempotencyKey);
  }

  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new SeedError(`${init.method ?? 'GET'} ${path} → ${response.status}`, body);
  }

  return body as T;
}

/** Register, or sign in when the address is already taken. */
async function ensureUser(email: string, password: string, displayName: string): Promise<Session> {
  try {
    return await call<Session>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName }),
    });
  } catch (error) {
    if (error instanceof SeedError && (error.detail as { code?: string })?.code === 'EMAIL_TAKEN') {
      return call<Session>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
    }
    throw error;
  }
}

async function waitForApi(attempts = 30): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${BASE.replace('/api/v1', '')}/health/ready`);
      if (response.ok) {
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`API never became ready at ${BASE}`);
}

async function main(): Promise<void> {
  console.log(`Seeding ${BASE}`);
  await waitForApi();

  const owner = await ensureUser('ada@payhub.dev', 'correct horse battery staple', 'Ada Lovelace');
  const customer = await ensureUser('grace@payhub.dev', 'nine nine nine nine nine', 'Grace Hopper');

  console.log(`  users: ${owner.user.email}, ${customer.user.email}`);

  /**
   * The owner needs the merchant and admin roles. There is deliberately no
   * API for self-promotion — granting a role is an operator action — so the
   * seed reaches into the database for exactly this one step and says so.
   */
  const { DataSource } = await import('typeorm');
  const admin = new DataSource({ type: 'postgres', url: env.DATABASE_URL });
  await admin.initialize();
  await admin.query(
    `UPDATE payhub.users
     SET roles = ARRAY['user','merchant_owner','admin']::text[], version = version + 1
     WHERE email = $1 AND NOT ('admin' = ANY(roles))`,
    [owner.user.email],
  );
  await admin.destroy();

  // The role change invalidates the token's claims, so re-authenticate.
  const operator = await call<Session>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'ada@payhub.dev', password: 'correct horse battery staple' }),
  });

  const existing = await call<Array<{ id: string; name: string; status: string }>>('/merchants', {
    token: operator.accessToken,
  });

  let merchant = existing.find((item) => item.name === 'Acme Payments');

  if (!merchant) {
    merchant = await call('/merchants', {
      method: 'POST',
      token: operator.accessToken,
      body: JSON.stringify({ name: 'Acme Payments', supportedCurrencies: ['USD', 'EUR'] }),
    });
  }

  if (merchant!.status !== 'active') {
    merchant = await call(`/merchants/${merchant!.id}/activate`, {
      method: 'POST',
      token: operator.accessToken,
    });
  }

  console.log(`  merchant: ${merchant!.name} (${merchant!.status})`);

  const apiKey = await call<{ plaintext: string; maskedKey: string }>(
    `/merchants/${merchant!.id}/api-keys`,
    {
      method: 'POST',
      token: operator.accessToken,
      body: JSON.stringify({
        name: `seed-${Date.now()}`,
        scopes: ['payments:read', 'payments:write', 'refunds:write'],
        environment: 'test',
      }),
    },
  );

  console.log(`  api key: ${apiKey.maskedKey}  (plaintext: ${apiKey.plaintext})`);

  // A handful of payments so the dashboard has something to show. Each gets
  // its own idempotency key — reusing one would replay the first response.
  const amounts = ['100.00', '42.50', '19.99', '250.00'];

  for (const amount of amounts) {
    const payment = await call<{ id: string; status: string }>('/payments', {
      method: 'POST',
      token: customer.accessToken,
      idempotencyKey: crypto.randomUUID(),
      body: JSON.stringify({
        merchantId: merchant!.id,
        direction: 'deposit',
        amount,
        currency: 'USD',
        method: 'card',
        reference: `seed-${amount}`,
      }),
    });

    console.log(`  payment ${payment.id.slice(0, 8)} ${amount} USD → ${payment.status}`);
  }

  // One deliberate decline, so the failure path has data too. The fake
  // provider reads `metadata.simulate`.
  const declined = await call<{ id: string; status: string; failureReason: string | null }>(
    '/payments',
    {
      method: 'POST',
      token: customer.accessToken,
      idempotencyKey: crypto.randomUUID(),
      body: JSON.stringify({
        merchantId: merchant!.id,
        direction: 'deposit',
        amount: '77.00',
        currency: 'USD',
        method: 'card',
        reference: 'seed-declined',
        metadata: { simulate: 'decline' },
      }),
    },
  );

  console.log(`  payment ${declined.id.slice(0, 8)} → ${declined.status} (${declined.failureReason})`);
  console.log('\nSeed complete. Sign in at http://localhost:5173 as grace@payhub.dev.');
}

main().catch((error: unknown) => {
  if (error instanceof SeedError) {
    console.error(error.message, JSON.stringify(error.detail, null, 2));
  } else {
    console.error(error);
  }
  process.exit(1);
});
