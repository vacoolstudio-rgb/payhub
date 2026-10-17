import type { CursorPage, CursorQuery } from '@payhub/kernel';
import type { Payment, PaymentDirection, PaymentId, PaymentStatus } from './payment.aggregate.js';

export const PAYMENT_REPOSITORY = Symbol.for('payhub:PaymentRepository');

export interface PaymentFilter extends CursorQuery {
  readonly userId?: string | undefined;
  readonly merchantId?: string | undefined;
  readonly status?: PaymentStatus | undefined;
  readonly direction?: PaymentDirection | undefined;
  readonly currency?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

export interface PaymentStats {
  readonly totalCount: number;
  readonly capturedCount: number;
  readonly failedCount: number;
  readonly volumeMinor: string;
  readonly feeMinor: string;
  readonly currency: string;
}

export interface PaymentRepository {
  findById(id: PaymentId): Promise<Payment | null>;
  findByIdForUpdate(id: PaymentId): Promise<Payment | null>;
  findByTransferId(transferId: string): Promise<Payment | null>;
  /** DataLoader batch function for the GraphQL layer. */
  findManyByIds(ids: readonly PaymentId[]): Promise<Map<PaymentId, Payment>>;
  list(filter: PaymentFilter): Promise<CursorPage<Payment>>;
  stats(input: { merchantId?: string; userId?: string; currency: string; from: Date; to: Date }): Promise<PaymentStats>;
  /** Authorisations whose window elapsed; the expiry cron compensates them. */
  insert(payment: Payment): Promise<void>;
  save(payment: Payment): Promise<void>;
}
