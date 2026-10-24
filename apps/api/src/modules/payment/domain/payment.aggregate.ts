import {
  AggregateRoot,
  type Brand,
  DomainEvent,
  InvalidStateError,
  Money,
  type Result,
  err,
  ok,
  uuidBrand,
} from '@payhub/kernel';

export type PaymentId = Brand<string, 'PaymentId'>;
export const PaymentId = uuidBrand<PaymentId>('PaymentId');

export const PaymentDirection = {
  Deposit: 'deposit',
  Withdrawal: 'withdrawal',
  Transfer: 'transfer',
} as const;

export type PaymentDirection = (typeof PaymentDirection)[keyof typeof PaymentDirection];

export const PaymentStatus = {
  /** Created, nothing has moved yet. */
  Pending: 'pending',
  /** The provider reserved the funds; the ledger has not been touched. */
  Authorized: 'authorized',
  /** Waiting for the ledger to confirm the posting. */
  Capturing: 'capturing',
  /** Money has moved and the journal entry exists. */
  Captured: 'captured',
  Refunding: 'refunding',
  Refunded: 'refunded',
  Cancelled: 'cancelled',
  Failed: 'failed',
} as const;

export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const TERMINAL_STATUSES: ReadonlySet<PaymentStatus> = new Set([
  PaymentStatus.Captured,
  PaymentStatus.Refunded,
  PaymentStatus.Cancelled,
  PaymentStatus.Failed,
]);

/**
 * The state machine, declared as data.
 *
 * Writing the transitions out makes the lifecycle reviewable in one glance
 * and turns "can a refunded payment be captured?" into a lookup rather than
 * a reading of nine `if` statements scattered across a service.
 */
const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  [PaymentStatus.Pending]: [
    PaymentStatus.Authorized,
    PaymentStatus.Capturing,
    PaymentStatus.Cancelled,
    PaymentStatus.Failed,
  ],
  [PaymentStatus.Authorized]: [
    PaymentStatus.Capturing,
    PaymentStatus.Cancelled,
    PaymentStatus.Failed,
  ],
  [PaymentStatus.Capturing]: [PaymentStatus.Captured, PaymentStatus.Failed],
  [PaymentStatus.Captured]: [PaymentStatus.Refunding],
  [PaymentStatus.Refunding]: [PaymentStatus.Refunded, PaymentStatus.Captured],
  [PaymentStatus.Refunded]: [],
  [PaymentStatus.Cancelled]: [],
  [PaymentStatus.Failed]: [],
};

/** Whether `completeCapture` actually moved the payment, or had already. */
export type CaptureOutcome = 'captured' | 'already-captured';

export type PaymentFailureReason =
  | 'insufficient_funds'
  | 'wallet_frozen'
  | 'wallet_not_found'
  | 'currency_mismatch'
  | 'provider_declined'
  | 'provider_unavailable'
  | 'limit_exceeded'
  | 'expired'
  | 'cancelled_by_user'
  | 'internal_error';

interface PaymentProps {
  readonly merchantId: string;
  readonly userId: string;
  /** Destination user for an internal transfer. */
  readonly counterpartyUserId: string | null;
  readonly direction: PaymentDirection;
  readonly amount: Money;
  readonly fee: Money;
  readonly method: string;
  readonly reference: string;
  readonly idempotencyKey: string | null;
  readonly metadata: Record<string, string>;
  status: PaymentStatus;
  providerReference: string | null;
  /** Journal entry that settled this payment. */
  transferId: string | null;
  refundTransferId: string | null;
  refundAmount: Money | null;
  refundedAmount: Money;
  failureReason: PaymentFailureReason | null;
  failureDetail: string | null;
  authorizedAt: Date | null;
  capturedAt: Date | null;
  settledAt: Date | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  updatedAt: Date;
}

/**
 * Payment aggregate — the saga's state holder.
 *
 * It owns *its own* lifecycle and nothing else: the money itself lives in the
 * ledger service, in another database, behind an event contract. This
 * aggregate therefore records intent and outcome, and the saga drives the
 * conversation between the two contexts.
 */
/**
 * The largest single payment, in minor units — ten million major units.
 *
 * `Money` refuses anything a `bigint` column cannot hold, which stops a
 * 500 but is a storage fact, not a rule. Measured with that bound alone
 * in place: a deposit of 92,233,720,368,547,758.07 was accepted, posted
 * and credited, leaving the wallet one more such payment away from
 * overflowing the column its balance lives in. A ledger whose invariants
 * depend on sums staying inside int64 needs a limit well below int64,
 * and a payments platform needs one regardless.
 *
 * A constant rather than configuration on purpose: it is an invariant of
 * the aggregate and every environment must agree on it. A real
 * per-merchant limit is a pricing conversation and belongs on the
 * merchant beside the fee policy, not in an env var.
 */
export const MAX_PAYMENT_MINOR = 1_000_000_000_00n;

export class Payment extends AggregateRoot<PaymentId> {
  private constructor(
    id: PaymentId,
    private readonly props: PaymentProps,
  ) {
    super(id);
  }

  static initiate(input: {
    id: PaymentId;
    merchantId: string;
    userId: string;
    counterpartyUserId?: string | null;
    direction: PaymentDirection;
    amount: Money;
    fee: Money;
    method: string;
    reference: string;
    idempotencyKey?: string | null;
    metadata?: Record<string, string>;
    expiresInMs?: number;
    now?: Date;
  }): Result<Payment, InvalidStateError> {
    const now = input.now ?? new Date();

    if (!input.amount.isPositive()) {
      return err(
        new InvalidStateError('Payment amount must be positive', 'INVALID_AMOUNT', {
          amount: input.amount.toJSON(),
        }),
      );
    }
    if (input.amount.amount > MAX_PAYMENT_MINOR) {
      return err(
        new InvalidStateError('Payment amount exceeds the per-payment limit', 'AMOUNT_TOO_LARGE', {
          amount: input.amount.toJSON(),
          limitMinor: MAX_PAYMENT_MINOR.toString(),
        }),
      );
    }
    if (input.direction === PaymentDirection.Transfer && !input.counterpartyUserId) {
      return err(
        new InvalidStateError('A transfer needs a counterparty', 'COUNTERPARTY_REQUIRED'),
      );
    }
    if (input.counterpartyUserId === input.userId) {
      return err(new InvalidStateError('Cannot transfer to yourself', 'SELF_TRANSFER'));
    }

    const payment = new Payment(input.id, {
      merchantId: input.merchantId,
      userId: input.userId,
      counterpartyUserId: input.counterpartyUserId ?? null,
      direction: input.direction,
      amount: input.amount,
      fee: input.fee,
      method: input.method,
      reference: input.reference,
      idempotencyKey: input.idempotencyKey ?? null,
      metadata: input.metadata ?? {},
      status: PaymentStatus.Pending,
      providerReference: null,
      transferId: null,
      refundTransferId: null,
      refundAmount: null,
      refundedAmount: Money.zero(input.amount.currency),
      failureReason: null,
      failureDetail: null,
      authorizedAt: null,
      capturedAt: null,
      settledAt: null,
      // An authorisation that nobody captures must not hold funds forever.
      expiresAt: new Date(now.getTime() + (input.expiresInMs ?? 30 * 60 * 1_000)),
      createdAt: now,
      updatedAt: now,
    });

    payment.raise(new PaymentInitiated(payment));
    return ok(payment);
  }

  static rehydrate(id: PaymentId, props: PaymentProps, version: number): Payment {
    const payment = new Payment(id, props);
    payment.setVersion(version);
    return payment;
  }

  // --- transitions --------------------------------------------------------

  authorize(providerReference: string, now = new Date()): Result<void, InvalidStateError> {
    const allowed = this.transitionTo(PaymentStatus.Authorized, now);
    if (allowed.isErr()) {
      return allowed;
    }

    this.props.providerReference = providerReference;
    this.props.authorizedAt = now;
    this.raise(new PaymentAuthorized(this));
    return ok(undefined);
  }

  /** Hands the payment to the ledger; the saga waits for the answer. */
  beginCapture(transferId: string, now = new Date()): Result<void, InvalidStateError> {
    const allowed = this.transitionTo(PaymentStatus.Capturing, now);
    if (allowed.isErr()) {
      return allowed;
    }
    this.props.transferId = transferId;
    return ok(undefined);
  }

  /**
   * Confirmation from the ledger.
   *
   * Idempotent, and it *says so*: the same `transferId` arriving twice
   * (a Kafka redelivery, or the stuck-payment cron re-issuing the command)
   * returns `already-captured` rather than silently succeeding. The caller
   * needs that distinction — publishing `payment.captured` a second time
   * sends the merchant a second webhook for one payment.
   */
  completeCapture(
    transferId: string,
    now = new Date(),
  ): Result<CaptureOutcome, InvalidStateError> {
    if (this.props.status === PaymentStatus.Captured && this.props.transferId === transferId) {
      return ok('already-captured');
    }

    const allowed = this.transitionTo(PaymentStatus.Captured, now);
    if (allowed.isErr()) {
      return err(allowed.unwrapErr());
    }

    this.props.transferId = transferId;
    this.props.capturedAt = now;
    this.props.settledAt = now;
    this.raise(new PaymentCaptured(this));
    return ok('captured');
  }

  fail(
    reason: PaymentFailureReason,
    detail: string | null = null,
    now = new Date(),
  ): Result<void, InvalidStateError> {
    if (this.props.status === PaymentStatus.Failed) {
      return ok(undefined);
    }

    const allowed = this.transitionTo(PaymentStatus.Failed, now);
    if (allowed.isErr()) {
      return allowed;
    }

    this.props.failureReason = reason;
    this.props.failureDetail = detail;
    this.props.settledAt = now;
    this.raise(new PaymentFailed(this));
    return ok(undefined);
  }

  cancel(now = new Date()): Result<void, InvalidStateError> {
    const allowed = this.transitionTo(PaymentStatus.Cancelled, now);
    if (allowed.isErr()) {
      return allowed;
    }
    this.props.failureReason = 'cancelled_by_user';
    this.props.settledAt = now;
    this.raise(new PaymentCancelled(this));
    return ok(undefined);
  }

  /**
   * Starts a refund, recording the transfer it will be posted under.
   *
   * The id is stored here, in the same step as the status, for the same
   * reason `beginCapture` does it: a payment in `refunding` whose
   * transfer id is unknown cannot be recovered. It used to be generated
   * later, when the ledger command was published, and never persisted at
   * all — so a process that died between the two left a payment stuck in
   * `refunding` with nothing to retry it by.
   */
  beginRefund(
    amount: Money,
    refundTransferId: string,
    now = new Date(),
  ): Result<void, InvalidStateError> {
    if (amount.greaterThan(this.refundableAmount)) {
      return err(
        new InvalidStateError(
          `Refund of ${amount.toString()} exceeds the refundable ${this.refundableAmount.toString()}`,
          'REFUND_EXCEEDS_AMOUNT',
          {
            requested: amount.toJSON(),
            refundable: this.refundableAmount.toJSON(),
          },
        ),
      );
    }

    const allowed = this.transitionTo(PaymentStatus.Refunding, now);
    if (allowed.isErr()) {
      return allowed;
    }

    // The id and the amount together are what a recovery needs: the
    // ledger deduplicates on the id, but if the transfer never posted it
    // has to be re-sent for the amount originally asked for, not for
    // whatever is outstanding now.
    this.props.refundTransferId = refundTransferId;
    this.props.refundAmount = amount;
    return ok(undefined);
  }

  /**
   * Rolls a refund back to `captured`.
   *
   * Needed because the provider call happens outside the transaction that
   * moved the payment into `refunding`: when the provider declines, the
   * payment must not be left in a state no cron sweeps.
   */
  cancelRefund(now = new Date()): Result<void, InvalidStateError> {
    if (this.props.status !== PaymentStatus.Refunding) {
      return ok(undefined);
    }
    this.props.status = PaymentStatus.Captured;
    this.props.refundTransferId = null;
    this.props.refundAmount = null;
    this.props.updatedAt = now;
    return ok(undefined);
  }

  completeRefund(amount: Money, now = new Date()): Result<void, InvalidStateError> {
    if (this.props.status !== PaymentStatus.Refunding) {
      return err(
        new InvalidStateError(
          `Cannot complete a refund from ${this.props.status}`,
          'INVALID_TRANSITION',
        ),
      );
    }

    this.props.refundedAmount = this.props.refundedAmount.add(amount);

    // A partial refund leaves the payment captured and refundable again;
    // only a full refund is terminal.
    this.props.status = this.props.refundedAmount.greaterThanOrEqual(this.props.amount)
      ? PaymentStatus.Refunded
      : PaymentStatus.Captured;

    this.props.refundTransferId = null;
    this.props.refundAmount = null;
    this.props.updatedAt = now;
    this.raise(new PaymentRefunded(this, amount));
    return ok(undefined);
  }

  expire(now = new Date()): Result<void, InvalidStateError> {
    if (TERMINAL_STATUSES.has(this.props.status)) {
      return ok(undefined);
    }
    return this.fail('expired', 'Authorisation window elapsed', now);
  }

  private transitionTo(next: PaymentStatus, now: Date): Result<void, InvalidStateError> {
    const allowed = TRANSITIONS[this.props.status];

    if (!allowed.includes(next)) {
      return err(
        new InvalidStateError(
          `Cannot move a payment from ${this.props.status} to ${next}`,
          'INVALID_TRANSITION',
          { paymentId: this.id, from: this.props.status, to: next, allowed },
        ),
      );
    }

    this.props.status = next;
    this.props.updatedAt = now;
    return ok(undefined);
  }

  // --- accessors ----------------------------------------------------------

  get merchantId(): string {
    return this.props.merchantId;
  }

  get userId(): string {
    return this.props.userId;
  }

  get counterpartyUserId(): string | null {
    return this.props.counterpartyUserId;
  }

  get direction(): PaymentDirection {
    return this.props.direction;
  }

  get amount(): Money {
    return this.props.amount;
  }

  get fee(): Money {
    return this.props.fee;
  }

  /** What the user actually receives (deposit) or is charged (withdrawal). */
  get netAmount(): Money {
    return this.props.direction === PaymentDirection.Deposit
      ? this.props.amount.subtract(this.props.fee)
      : this.props.amount.add(this.props.fee);
  }

  get method(): string {
    return this.props.method;
  }

  get reference(): string {
    return this.props.reference;
  }

  get idempotencyKey(): string | null {
    return this.props.idempotencyKey;
  }

  get metadata(): Readonly<Record<string, string>> {
    return this.props.metadata;
  }

  get status(): PaymentStatus {
    return this.props.status;
  }

  get providerReference(): string | null {
    return this.props.providerReference;
  }

  get refundTransferId(): string | null {
    return this.props.refundTransferId;
  }

  /** The amount of the refund currently in flight, if any. */
  get refundAmount(): Money | null {
    return this.props.refundAmount;
  }

  get transferId(): string | null {
    return this.props.transferId;
  }

  get refundedAmount(): Money {
    return this.props.refundedAmount;
  }

  get refundableAmount(): Money {
    return this.props.amount.subtract(this.props.refundedAmount);
  }

  get failureReason(): PaymentFailureReason | null {
    return this.props.failureReason;
  }

  get failureDetail(): string | null {
    return this.props.failureDetail;
  }

  get authorizedAt(): Date | null {
    return this.props.authorizedAt;
  }

  get capturedAt(): Date | null {
    return this.props.capturedAt;
  }

  get settledAt(): Date | null {
    return this.props.settledAt;
  }

  get expiresAt(): Date {
    return this.props.expiresAt;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  get isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this.props.status);
  }
}

// --- domain events --------------------------------------------------------

abstract class PaymentEvent extends DomainEvent {
  readonly aggregateType = 'Payment';

  constructor(protected readonly payment: Payment) {
    super();
  }

  get aggregateId(): string {
    return this.payment.id;
  }

  protected base(): Record<string, unknown> {
    return {
      paymentId: this.payment.id,
      merchantId: this.payment.merchantId,
      userId: this.payment.userId,
      direction: this.payment.direction,
      amount: this.payment.amount.toJSON(),
      fee: this.payment.fee.toJSON(),
      reference: this.payment.reference,
    };
  }
}

export class PaymentInitiated extends PaymentEvent {
  readonly eventName = 'payment.initiated.v1';

  payload(): Record<string, unknown> {
    return {
      ...this.base(),
      sourceWalletId: null,
      destinationWalletId: null,
      method: this.payment.method,
      createdAt: this.payment.createdAt.toISOString(),
    };
  }
}

export class PaymentAuthorized extends PaymentEvent {
  readonly eventName = 'payment.authorized.v1';

  payload(): Record<string, unknown> {
    return {
      ...this.base(),
      providerReference: this.payment.providerReference ?? '',
      authorizedAt: (this.payment.authorizedAt ?? new Date()).toISOString(),
    };
  }
}

export class PaymentCaptured extends PaymentEvent {
  readonly eventName = 'payment.captured.v1';

  payload(): Record<string, unknown> {
    return {
      ...this.base(),
      transferId: this.payment.transferId ?? '',
      capturedAt: (this.payment.capturedAt ?? new Date()).toISOString(),
    };
  }
}

export class PaymentFailed extends PaymentEvent {
  readonly eventName = 'payment.failed.v1';

  payload(): Record<string, unknown> {
    return {
      ...this.base(),
      reason: this.payment.failureReason ?? 'internal_error',
      detail: this.payment.failureDetail,
      failedAt: (this.payment.settledAt ?? new Date()).toISOString(),
    };
  }
}

export class PaymentCancelled extends PaymentEvent {
  readonly eventName = 'payment.failed.v1';

  payload(): Record<string, unknown> {
    return {
      ...this.base(),
      reason: 'cancelled_by_user',
      detail: null,
      failedAt: (this.payment.settledAt ?? new Date()).toISOString(),
    };
  }
}

export class PaymentRefunded extends PaymentEvent {
  readonly eventName = 'payment.refunded.v1';

  constructor(
    payment: Payment,
    private readonly refunded: Money,
  ) {
    super(payment);
  }

  payload(): Record<string, unknown> {
    return {
      ...this.base(),
      refundId: this.eventId,
      refundedAmount: this.refunded.toJSON(),
      refundedAt: new Date().toISOString(),
    };
  }
}
