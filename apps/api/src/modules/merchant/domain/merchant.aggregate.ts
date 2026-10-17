import {
  AggregateRoot,
  type Brand,
  DomainEvent,
  InvalidStateError,
  type Result,
  err,
  ok,
  uuidBrand,
} from '@payhub/kernel';
import { FeePolicy } from './fee-policy.vo.js';
import type { WebhookEndpoint } from './webhook-endpoint.vo.js';

export type MerchantId = Brand<string, 'MerchantId'>;
export const MerchantId = uuidBrand<MerchantId>('MerchantId');

export const MerchantStatus = {
  Pending: 'pending',
  Active: 'active',
  Suspended: 'suspended',
} as const;

export type MerchantStatus = (typeof MerchantStatus)[keyof typeof MerchantStatus];

interface MerchantProps {
  readonly ownerUserId: string;
  name: string;
  status: MerchantStatus;
  feePolicy: FeePolicy;
  webhook: WebhookEndpoint | null;
  readonly supportedCurrencies: string[];
  readonly createdAt: Date;
  updatedAt: Date;
}

export class Merchant extends AggregateRoot<MerchantId> {
  private constructor(
    id: MerchantId,
    private readonly props: MerchantProps,
  ) {
    super(id);
  }

  static onboard(input: {
    id: MerchantId;
    ownerUserId: string;
    name: string;
    supportedCurrencies?: string[];
    feePolicy?: FeePolicy;
    now?: Date;
  }): Merchant {
    const now = input.now ?? new Date();

    return new Merchant(input.id, {
      ownerUserId: input.ownerUserId,
      name: input.name.trim(),
      // Onboarding is not activation: a merchant cannot take money until
      // KYC has cleared, which is an explicit state transition.
      status: MerchantStatus.Pending,
      feePolicy: input.feePolicy ?? FeePolicy.default(),
      webhook: null,
      supportedCurrencies: input.supportedCurrencies ?? ['USD', 'EUR'],
      createdAt: now,
      updatedAt: now,
    });
  }

  static rehydrate(id: MerchantId, props: MerchantProps, version: number): Merchant {
    const merchant = new Merchant(id, props);
    merchant.setVersion(version);
    return merchant;
  }

  activate(now = new Date()): Result<void, InvalidStateError> {
    if (this.props.status === MerchantStatus.Suspended) {
      return err(
        new InvalidStateError('A suspended merchant must be reinstated first', 'MERCHANT_SUSPENDED'),
      );
    }
    if (this.props.status === MerchantStatus.Active) {
      return ok(undefined);
    }

    this.props.status = MerchantStatus.Active;
    this.touch(now);
    this.raise(new MerchantActivated(this));
    return ok(undefined);
  }

  suspend(reason: string, now = new Date()): void {
    this.props.status = MerchantStatus.Suspended;
    this.touch(now);
    this.raise(new MerchantSuspended(this, reason));
  }

  assertCanAcceptPayments(currency: string): Result<void, InvalidStateError> {
    if (this.props.status !== MerchantStatus.Active) {
      return err(
        new InvalidStateError(
          `Merchant is ${this.props.status} and cannot accept payments`,
          'MERCHANT_NOT_ACTIVE',
          { merchantId: this.id, status: this.props.status },
        ),
      );
    }
    if (!this.props.supportedCurrencies.includes(currency)) {
      return err(
        new InvalidStateError(
          `Merchant does not support ${currency}`,
          'CURRENCY_NOT_SUPPORTED',
          { merchantId: this.id, currency, supported: this.props.supportedCurrencies },
        ),
      );
    }
    return ok(undefined);
  }

  configureWebhook(endpoint: WebhookEndpoint, now = new Date()): void {
    this.props.webhook = endpoint;
    this.touch(now);
  }

  removeWebhook(now = new Date()): void {
    this.props.webhook = null;
    this.touch(now);
  }

  updateFeePolicy(policy: FeePolicy, now = new Date()): void {
    this.props.feePolicy = policy;
    this.touch(now);
  }

  rename(name: string, now = new Date()): void {
    this.props.name = name.trim();
    this.touch(now);
  }

  get ownerUserId(): string {
    return this.props.ownerUserId;
  }

  get name(): string {
    return this.props.name;
  }

  get status(): MerchantStatus {
    return this.props.status;
  }

  get feePolicy(): FeePolicy {
    return this.props.feePolicy;
  }

  get webhook(): WebhookEndpoint | null {
    return this.props.webhook;
  }

  get supportedCurrencies(): readonly string[] {
    return this.props.supportedCurrencies;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  private touch(now: Date): void {
    this.props.updatedAt = now;
  }
}

export class MerchantActivated extends DomainEvent {
  readonly eventName = 'identity.merchant_activated.v1';
  readonly aggregateType = 'Merchant';

  constructor(private readonly merchant: Merchant) {
    super();
  }

  get aggregateId(): string {
    return this.merchant.id;
  }

  payload(): Record<string, unknown> {
    return {
      merchantId: this.merchant.id,
      ownerUserId: this.merchant.ownerUserId,
      name: this.merchant.name,
      webhookUrl: this.merchant.webhook?.url ?? null,
      activatedAt: this.merchant.updatedAt.toISOString(),
    };
  }
}

export class MerchantSuspended extends DomainEvent {
  readonly eventName = 'identity.merchant_suspended.v1';
  readonly aggregateType = 'Merchant';

  constructor(
    private readonly merchant: Merchant,
    private readonly reason: string,
  ) {
    super();
  }

  get aggregateId(): string {
    return this.merchant.id;
  }

  payload(): Record<string, unknown> {
    return { merchantId: this.merchant.id, reason: this.reason };
  }
}
