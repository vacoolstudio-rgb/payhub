import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Money } from '@payhub/kernel';
import { OutboxPublisher } from '@payhub/messaging';
import { MetricsService } from '@payhub/observability';
import { bindTestTransactions } from '@payhub/testing';
import { JOURNAL_REPOSITORY } from '../../domain/ledger/journal-entry.repository.js';
import { TransferPlanner } from '../../domain/ledger/transfer-planner.service.js';
import { Wallet, WalletId } from '../../domain/wallet/wallet.aggregate.js';
import {
  WALLET_REPOSITORY,
  type WalletIdentity,
  type WalletRepository,
} from '../../domain/wallet/wallet.repository.js';
import { PostTransferService } from './post-transfer.service.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const MERCHANT = '33333333-3333-4333-8333-333333333333';
const PAYMENT = '44444444-4444-4444-8444-444444444444';

/**
 * In-memory wallet store.
 *
 * A stub rather than a mock because the service's correctness depends on
 * the wallets actually changing between steps — asserting on calls would
 * test the implementation instead of the behaviour.
 *
 * `implements WalletRepository` is load-bearing: without it, adding a
 * method to the port leaves this fake silently incomplete and the failure
 * only shows up at runtime, inside a test, as `x is not a function`.
 */
class FakeWalletRepository implements WalletRepository {
  readonly wallets = new Map<string, Wallet>();

  seed(userId: string, currency: string, major: string): Wallet {
    const wallet = Wallet.open({ id: WalletId.create(), userId, currency });
    wallet.credit(Money.fromMajor(major, currency));
    wallet.pullDomainEvents();
    this.wallets.set(wallet.id, wallet);
    return wallet;
  }

  async findByUserAndCurrency(userId: string, currency: string): Promise<Wallet | null> {
    return (
      [...this.wallets.values()].find(
        (wallet) => wallet.userId === userId && wallet.currency === currency,
      ) ?? null
    );
  }

  async findOrOpen(userId: string, currency: string): Promise<Wallet> {
    const existing = await this.findByUserAndCurrency(userId, currency);
    if (existing) {
      return existing;
    }
    const wallet = Wallet.open({ id: WalletId.create(), userId, currency });
    this.wallets.set(wallet.id, wallet);
    return wallet;
  }

  async ensureMany(identities: ReadonlyArray<WalletIdentity>): Promise<Wallet[]> {
    return Promise.all(
      identities.map((identity) => this.findOrOpen(identity.userId, identity.currency)),
    );
  }

  async lockMany(ids: readonly WalletId[]): Promise<Map<WalletId, Wallet>> {
    return new Map(
      ids.filter((id) => this.wallets.has(id)).map((id) => [id, this.wallets.get(id)!] as const),
    );
  }

  async save(): Promise<void> {}
  async findById(id: WalletId): Promise<Wallet | null> {
    return this.wallets.get(id) ?? null;
  }
  async findAllByUser(): Promise<Wallet[]> {
    return [];
  }
  async findByIdForUpdate(id: WalletId): Promise<Wallet | null> {
    return this.findById(id);
  }
  async computeBalanceFromJournal(): Promise<{ available: Money; pending: Money }> {
    return { available: Money.zero('USD'), pending: Money.zero('USD') };
  }
}

describe('PostTransferService', () => {
  let service: PostTransferService;
  let wallets: FakeWalletRepository;
  let journal: { exists: ReturnType<typeof vi.fn>; append: ReturnType<typeof vi.fn> };
  let outbox: { publish: ReturnType<typeof vi.fn> };
  let unbind: () => void;

  beforeEach(async () => {
    unbind = bindTestTransactions();
    wallets = new FakeWalletRepository();
    journal = { exists: vi.fn().mockResolvedValue(false), append: vi.fn().mockResolvedValue(undefined) };
    outbox = { publish: vi.fn().mockResolvedValue('message-id') };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PostTransferService,
        TransferPlanner,
        { provide: WALLET_REPOSITORY, useValue: wallets },
        { provide: JOURNAL_REPOSITORY, useValue: journal },
        { provide: OutboxPublisher, useValue: outbox },
        {
          provide: MetricsService,
          useValue: { ledgerPostings: { inc: vi.fn() } },
        },
      ],
    }).compile();

    service = moduleRef.get(PostTransferService);
  });

  afterEach(() => unbind());

  const command = (overrides: Partial<Parameters<PostTransferService['execute']>[0]> = {}) => ({
    transferId: '55555555-5555-4555-8555-555555555555',
    paymentId: PAYMENT,
    userId: ALICE,
    counterpartyUserId: null,
    merchantId: MERCHANT,
    operation: 'deposit' as const,
    amount: { amount: '10000', currency: 'USD' },
    fee: { amount: '320', currency: 'USD' },
    provider: 'card',
    description: 'deposit order-1',
    ...overrides,
  });

  it('posts a deposit and credits the user net of the fee', async () => {
    const outcome = await service.execute(command());

    expect(outcome.status).toBe('posted');
    expect(journal.append).toHaveBeenCalledOnce();

    const wallet = await wallets.findByUserAndCurrency(ALICE, 'USD');
    expect(wallet?.available.toMajorString()).toBe('96.80');
  });

  it('emits transfer_posted and a balance update through the outbox', async () => {
    await service.execute(command());

    const events = outbox.publish.mock.calls.map(([definition]) => definition.name);
    expect(events).toContain('ledger.transfer_posted.v1');
    expect(events).toContain('ledger.wallet_balance_changed.v1');
  });

  /** Kafka redelivery must not post the entry twice. */
  it('is idempotent on the transfer id', async () => {
    journal.exists.mockResolvedValue(true);

    const outcome = await service.execute(command());

    expect(outcome.status).toBe('duplicate');
    expect(journal.append).not.toHaveBeenCalled();
  });

  it('rejects a withdrawal the user cannot afford, and still emits the rejection', async () => {
    wallets.seed(ALICE, 'USD', '5.00');

    const outcome = await service.execute(
      command({ operation: 'withdrawal', amount: { amount: '10000', currency: 'USD' } }),
    );

    expect(outcome).toMatchObject({ status: 'rejected', reason: 'insufficient_funds' });
    expect(journal.append).not.toHaveBeenCalled();

    // The saga is waiting for an answer; a silent rejection would hang it.
    const events = outbox.publish.mock.calls.map(([definition]) => definition.name);
    expect(events).toEqual(['ledger.transfer_rejected.v1']);
  });

  it('leaves balances untouched when it rejects', async () => {
    wallets.seed(ALICE, 'USD', '5.00');

    await service.execute(
      command({ operation: 'withdrawal', amount: { amount: '10000', currency: 'USD' } }),
    );

    const wallet = await wallets.findByUserAndCurrency(ALICE, 'USD');
    expect(wallet?.available.toMajorString()).toBe('5.00');
  });

  it('moves money between two users on a transfer', async () => {
    wallets.seed(ALICE, 'USD', '100.00');
    wallets.seed(BOB, 'USD', '0.00');

    const outcome = await service.execute(
      command({
        operation: 'transfer',
        counterpartyUserId: BOB,
        amount: { amount: '2500', currency: 'USD' },
        fee: { amount: '0', currency: 'USD' },
      }),
    );

    expect(outcome.status).toBe('posted');
    expect((await wallets.findByUserAndCurrency(ALICE, 'USD'))?.available.toMajorString()).toBe('75.00');
    expect((await wallets.findByUserAndCurrency(BOB, 'USD'))?.available.toMajorString()).toBe('25.00');
  });

  it('rejects a transfer with no counterparty instead of throwing', async () => {
    const outcome = await service.execute(
      command({ operation: 'transfer', counterpartyUserId: null }),
    );

    expect(outcome.status).toBe('rejected');
  });
});
