import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SetWalletHoldCommand } from '@payhub/contracts';
import { OutboxPublisher } from '@payhub/messaging';
import { Transactional } from '@payhub/persistence';

export interface HoldRequest {
  readonly userId: string;
  readonly currency?: string | undefined;
  readonly frozen: boolean;
  readonly reason: string;
  readonly actorUserId: string;
}

/**
 * Asks the ledger to freeze or release a user's wallets.
 *
 * Through the outbox, like every other write that crosses into the
 * ledger: the decision and the message announcing it commit together,
 * so a freeze cannot be recorded as sent and then lost, nor sent for a
 * decision that rolled back. The gRPC surface stays what it says it
 * is — the read side.
 *
 * Asynchronous, and that is a real property to be honest about rather
 * than hide: the call returns once the command is durable, not once the
 * wallet is frozen. The gap is the relay's poll plus the consumer,
 * normally well under a second. For the case this exists for — a fraud
 * alert — that is the right trade against a synchronous call that can
 * fail halfway and leave nobody sure whether the freeze took.
 */
@Injectable()
export class WalletHoldService {
  private readonly logger = new Logger(WalletHoldService.name);

  constructor(private readonly outbox: OutboxPublisher) {}

  @Transactional()
  async request(input: HoldRequest): Promise<{ commandId: string }> {
    const commandId = randomUUID();

    await this.outbox.publish(SetWalletHoldCommand, {
      userId: input.userId,
      ...(input.currency ? { currency: input.currency } : {}),
      frozen: input.frozen,
      reason: input.reason,
      actorUserId: input.actorUserId,
      requestedAt: new Date().toISOString(),
    }, { aggregateType: 'Wallet', aggregateId: input.userId, messageId: commandId });

    this.logger.log(
      `Requested ${input.frozen ? 'freeze' : 'release'} of ${input.userId}` +
        `${input.currency ? ` (${input.currency})` : ''} by ${input.actorUserId}`,
    );

    return { commandId };
  }
}
