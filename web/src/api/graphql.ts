import { GraphQLClient, gql } from 'graphql-request';
import { tokenStore } from './rest';
import type { PaymentView, WalletView } from './types';

/**
 * `graphql-request` builds a `new URL(endpoint)`, which throws on a
 * relative path — unlike `fetch`, which happily resolves one against the
 * document. So the endpoint is made absolute here, falling back to the
 * current origin so the Vite proxy (and the nginx proxy in production)
 * still keep everything same-origin.
 */
const API_ORIGIN =
  (import.meta.env['VITE_API_URL'] as string | undefined) || window.location.origin;

/**
 * GraphQL client for the dashboard read model.
 *
 * One request fills the whole screen — balances, recent payments, each
 * payment's merchant and the statistics tile. The REST equivalent is four
 * round trips plus an N+1 on merchants, which is exactly the trade-off that
 * justifies having GraphQL here and nowhere else.
 */
export const graphqlClient = new GraphQLClient(`${API_ORIGIN}/graphql`, {
  credentials: 'include',
});

export const DASHBOARD_QUERY = gql`
  query Dashboard($limit: Int!, $currency: String!) {
    wallets {
      id
      currency
      available { minor major currency }
      pending { minor major currency }
      total { minor major currency }
      status
    }
    payments(limit: $limit) {
      items {
        id
        status
        direction
        method
        reference
        createdAt
        capturedAt
        failureReason
        amount { minor major currency }
        fee { minor major currency }
        netAmount { minor major currency }
        merchant { id name status }
      }
      pageInfo { hasMore nextCursor }
    }
    paymentStats(currency: $currency, days: 30) {
      totalCount
      capturedCount
      failedCount
      volume { major currency }
      fees { major currency }
    }
  }
`;

export interface DashboardData {
  wallets: WalletView[];
  payments: {
    items: Array<PaymentView & { merchant: { id: string; name: string; status: string } | null }>;
    pageInfo: { hasMore: boolean; nextCursor: string | null };
  };
  paymentStats: {
    totalCount: number;
    capturedCount: number;
    failedCount: number;
    volume: { major: string; currency: string };
    fees: { major: string; currency: string };
  };
}

/**
 * The bearer token is attached per request rather than through a client
 * middleware: it is rotated every few minutes, and a middleware closure
 * would happily keep serving the token it captured when the client was
 * constructed.
 */
export const fetchDashboard = (limit = 20, currency = 'USD') => {
  const token = tokenStore.get();

  return graphqlClient.request<DashboardData>({
    document: DASHBOARD_QUERY,
    variables: { limit, currency },
    requestHeaders: token ? { authorization: `Bearer ${token}` } : {},
  });
};
