import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ForbiddenError, NotFoundError } from '@payhub/kernel';
import { Transactional } from '@payhub/persistence';
import { OutboxPublisher } from '@payhub/messaging';
import { ResourceVersionService } from '@payhub/redis';
import { TransactionManager } from '@payhub/persistence';
import { MerchantScopes } from './merchant.cache-scopes.js';
import { MerchantActivated as MerchantActivatedContract } from '@payhub/contracts';
import { FeePolicy } from '../domain/fee-policy.vo.js';
import { Merchant, MerchantId } from '../domain/merchant.aggregate.js';
import { MERCHANT_REPOSITORY, type MerchantRepository } from '../domain/merchant.repository.js';
import { WebhookEndpoint } from '../domain/webhook-endpoint.vo.js';

export interface MerchantView {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly ownerUserId: string;
  readonly feeBasisPoints: number;
  readonly feeFixedMinor: string;
  readonly supportedCurrencies: readonly string[];
  readonly webhook: { url: string; events: readonly string[]; active: boolean } | null;
  readonly createdAt: string;
}

@Injectable()
export class MerchantService {
  constructor(
    @Inject(MERCHANT_REPOSITORY) private readonly merchants: MerchantRepository,
    private readonly outbox: OutboxPublisher,
    private readonly versions: ResourceVersionService,
    private readonly transactions: TransactionManager,
  ) {}

  @Transactional()
  async onboard(input: {
    ownerUserId: string;
    name: string;
    supportedCurrencies?: string[];
  }): Promise<MerchantView> {
    const merchant = Merchant.onboard({
      id: MerchantId.create(),
      ownerUserId: input.ownerUserId,
      name: input.name,
      ...(input.supportedCurrencies ? { supportedCurrencies: input.supportedCurrencies } : {}),
    });

    await this.merchants.insert(merchant);
    this.expireCaches(merchant);
    return toView(merchant);
  }

  @Transactional()
  async activate(merchantId: string): Promise<MerchantView> {
    const merchant = await this.require(merchantId);

    const activated = merchant.activate();
    if (activated.isErr()) {
      throw activated.error;
    }

    await this.merchants.save(merchant);

    await this.outbox.publish(
      MerchantActivatedContract,
      {
        merchantId: merchant.id,
        ownerUserId: merchant.ownerUserId,
        name: merchant.name,
        webhookUrl: merchant.webhook?.url ?? null,
        activatedAt: merchant.updatedAt.toISOString(),
      },
      { aggregateType: 'Merchant', aggregateId: merchant.id },
    );

    this.expireCaches(merchant);
    return toView(merchant);
  }

  /**
   * Configures the webhook destination and mints a signing secret.
   *
   * The secret is returned exactly once. Rotating it means calling this
   * again, which is also the "my secret leaked" remediation path.
   */
  @Transactional()
  async configureWebhook(input: {
    merchantId: string;
    actorUserId: string;
    url: string;
    events?: string[];
    allowInsecure?: boolean;
  }): Promise<{ merchant: MerchantView; signingSecret: string }> {
    const merchant = await this.require(input.merchantId);
    this.assertOwnership(merchant, input.actorUserId);

    const signingSecret = `whsec_${randomBytes(32).toString('base64url')}`;

    const endpoint = WebhookEndpoint.create({
      url: input.url,
      secret: signingSecret,
      ...(input.events ? { subscribedEvents: input.events } : {}),
      allowInsecure: input.allowInsecure ?? false,
    });

    if (endpoint.isErr()) {
      throw endpoint.error;
    }

    merchant.configureWebhook(endpoint.value);
    await this.merchants.save(merchant);
    this.expireCaches(merchant);

    return { merchant: toView(merchant), signingSecret };
  }

  @Transactional()
  async updateFeePolicy(input: {
    merchantId: string;
    actorUserId: string;
    basisPoints: number;
    fixedMinor?: string;
    minimumMinor?: string;
    maximumMinor?: string | null;
  }): Promise<MerchantView> {
    const merchant = await this.require(input.merchantId);
    this.assertOwnership(merchant, input.actorUserId);

    const policy = FeePolicy.create({
      basisPoints: input.basisPoints,
      fixedMinor: input.fixedMinor ? BigInt(input.fixedMinor) : 0n,
      minimumMinor: input.minimumMinor ? BigInt(input.minimumMinor) : 0n,
      maximumMinor: input.maximumMinor ? BigInt(input.maximumMinor) : null,
    });

    if (policy.isErr()) {
      throw policy.error;
    }

    merchant.updateFeePolicy(policy.value);
    await this.merchants.save(merchant);
    this.expireCaches(merchant);
    return toView(merchant);
  }

  async get(merchantId: string): Promise<MerchantView> {
    return toView(await this.require(merchantId));
  }

  async listForOwner(ownerUserId: string): Promise<MerchantView[]> {
    const merchants = await this.merchants.findByOwner(ownerUserId);
    return merchants.map(toView);
  }

  /** Used by the payment context through an anti-corruption adapter. */
  async loadAggregate(merchantId: string): Promise<Merchant> {
    return this.require(merchantId);
  }

  /**
   * Expires every validator a merchant change can be observed through,
   * once the change is durable.
   *
   * Four write paths, one invalidation — adding a fifth that forgets to
   * call this is the failure mode, so it is a single private method rather
   * than three lines copied around.
   */
  private expireCaches(merchant: Merchant): void {
    this.transactions.afterCommit(() =>
      this.versions.bump(
        MerchantScopes.one(merchant.id),
        MerchantScopes.ofOwner(merchant.ownerUserId),
      ),
    );
  }

  private async require(merchantId: string): Promise<Merchant> {
    const merchant = await this.merchants.findById(MerchantId.of(merchantId));
    if (!merchant) {
      throw new NotFoundError('Merchant', merchantId);
    }
    return merchant;
  }

  private assertOwnership(merchant: Merchant, actorUserId: string): void {
    if (merchant.ownerUserId !== actorUserId) {
      throw new ForbiddenError('You do not own this merchant', 'MERCHANT_FOREIGN', {
        merchantId: merchant.id,
      });
    }
  }
}

function toView(merchant: Merchant): MerchantView {
  return {
    id: merchant.id,
    name: merchant.name,
    status: merchant.status,
    ownerUserId: merchant.ownerUserId,
    feeBasisPoints: merchant.feePolicy.basisPoints,
    feeFixedMinor: merchant.feePolicy.fixedMinor.toString(),
    supportedCurrencies: merchant.supportedCurrencies,
    webhook: merchant.webhook
      ? {
          url: merchant.webhook.url,
          events: merchant.webhook.subscribedEvents,
          active: merchant.webhook.active,
        }
      : null,
    createdAt: merchant.createdAt.toISOString(),
  };
}
