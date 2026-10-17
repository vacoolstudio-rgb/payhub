import { Injectable, Logger } from '@nestjs/common';
import {
  type PayloadOf,
  PostTransferCommand as PostTransferContract,
  ReverseTransferCommand as ReverseTransferContract,
} from '@payhub/contracts';
import { KafkaHandler, type MessageContext } from '@payhub/messaging';
import { PostTransferService } from '../../application/commands/post-transfer.service.js';
import { ReverseTransferService } from '../../application/commands/reverse-transfer.service.js';
import { WalletQueryService } from '../../application/queries/wallet-query.service.js';

/**
 * Inbound adapter: Kafka commands → application services.
 *
 * The adapter does no business work. It translates the wire contract into a
 * command object and lets the application layer decide — which is what keeps
 * the same use case reachable from gRPC, a CLI or a test without touching
 * Kafka at all.
 */
@Injectable()
export class LedgerCommandConsumer {
  private readonly logger = new Logger(LedgerCommandConsumer.name);

  constructor(
    private readonly postTransfer: PostTransferService,
    private readonly reverseTransfer: ReverseTransferService,
    private readonly walletQueries: WalletQueryService,
  ) {}

  @KafkaHandler(PostTransferContract)
  async onPostTransfer(
    payload: PayloadOf<typeof PostTransferContract>,
    context: MessageContext,
  ): Promise<void> {
    const outcome = await this.postTransfer.execute({
      transferId: payload.transferId,
      paymentId: payload.paymentId,
      userId: payload.userId,
      counterpartyUserId: payload.counterpartyUserId,
      merchantId: payload.merchantId,
      operation: payload.operation,
      amount: payload.amount,
      fee: payload.fee,
      provider: payload.provider,
      description: payload.description,
    });

    // The balance projection cache must not outlive the write that changed it.
    await this.walletQueries.invalidate(payload.userId);

    this.logger.debug(
      `post_transfer ${payload.transferId} → ${outcome.status} (msg ${context.messageId})`,
    );
  }

  @KafkaHandler(ReverseTransferContract)
  async onReverseTransfer(
    payload: PayloadOf<typeof ReverseTransferContract>,
  ): Promise<void> {
    await this.reverseTransfer.execute({
      transferId: payload.transferId,
      reversalId: payload.reversalId,
      paymentId: payload.paymentId,
      reason: payload.reason,
    });
  }
}
