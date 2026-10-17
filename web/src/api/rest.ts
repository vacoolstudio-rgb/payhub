import type { AuthenticatedUser, PaymentView, ProblemDetails } from './types';

const BASE = (import.meta.env['VITE_API_URL'] as string | undefined) ?? '';

export class ApiError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.detail || problem.title);
    this.name = 'ApiError';
  }
}

let accessToken: string | null = null;

export const tokenStore = {
  get: () => accessToken,
  set: (token: string | null) => {
    accessToken = token;
  },
};

/**
 * Thin REST client.
 *
 * Deliberately not a generated SDK: the surface this UI uses is small, and
 * the one thing worth centralising is error handling — the API answers with
 * RFC 9457 problem details, so every failure arrives in the same shape and
 * the UI can show `detail` plus a correlation id instead of "something went
 * wrong".
 */
async function request<T>(
  path: string,
  init: RequestInit & { idempotencyKey?: string } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');

  if (accessToken) {
    headers.set('authorization', `Bearer ${accessToken}`);
  }
  if (init.idempotencyKey) {
    headers.set('idempotency-key', init.idempotencyKey);
  }

  const response = await fetch(`${BASE}/api/v1${path}`, {
    ...init,
    headers,
    // Required for the httpOnly refresh cookie.
    credentials: 'include',
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(
      (body as ProblemDetails | null) ?? {
        type: 'about:blank',
        title: 'Request failed',
        status: response.status,
        detail: response.statusText,
        code: 'UNKNOWN',
      },
    );
  }

  return body as T;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthenticatedUser;
}

export const api = {
  login: (email: string, password: string) =>
    request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (email: string, password: string, displayName: string) =>
    request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName }),
    }),

  refresh: () => request<AuthResponse>('/auth/refresh', { method: 'POST', body: '{}' }),

  logout: () => request<void>('/auth/logout', { method: 'POST', body: '{}' }),

  me: () => request<AuthenticatedUser>('/auth/me'),

  merchants: () => request<Array<{ id: string; name: string; status: string }>>('/merchants'),

  /**
   * Creating a payment is the one call that *must* carry an idempotency
   * key: a double-submitted form or a retried request would otherwise
   * charge twice. The key is minted per attempt, not per render.
   */
  createPayment: (input: {
    merchantId: string;
    direction: string;
    amount: string;
    currency: string;
    method: string;
    reference?: string;
  }) =>
    request<PaymentView>('/payments', {
      method: 'POST',
      body: JSON.stringify(input),
      idempotencyKey: crypto.randomUUID(),
    }),

  cancelPayment: (id: string) =>
    request<PaymentView>(`/payments/${id}/cancel`, { method: 'POST' }),
};
