export interface MoneyView {
  minor: string;
  major: string;
  currency: string;
}

export interface PaymentView {
  id: string;
  status: string;
  direction: string;
  amount: MoneyView;
  fee: MoneyView;
  netAmount: MoneyView;
  method: string;
  reference: string;
  failureReason: string | null;
  createdAt: string;
  capturedAt: string | null;
  merchantId: string;
}

export interface WalletView {
  id: string;
  currency: string;
  available: MoneyView;
  pending: MoneyView;
  total: MoneyView;
  status: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  roles: readonly string[];
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  correlationId?: string;
}
