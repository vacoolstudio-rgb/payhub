import { Injectable } from '@nestjs/common';
import { LessThan } from 'typeorm';
import { TypeOrmRepositoryBase } from '../base.repository.js';
import { TransactionManager } from '../transaction.manager.js';
import { normaliseReturning } from '../outbox/outbox.repository.js';
import { ProcessedMessageEntity } from './processed-message.entity.js';

@Injectable()
export class InboxRepository extends TypeOrmRepositoryBase<ProcessedMessageEntity> {
  constructor(transactions: TransactionManager) {
    super(transactions, ProcessedMessageEntity);
  }

  /**
   * Returns `false` when the message was already handled by this consumer
   * group. `ON CONFLICT DO NOTHING` makes the check and the claim a single
   * atomic statement — a plain `SELECT` then `INSERT` would race.
   *
   * The answer comes from `RETURNING`, and only from `RETURNING`.
   *
   * The obvious implementation — `queryBuilder.insert().orIgnore()` and
   * then testing `result.identifiers.length` — is wrong, and wrong in the
   * worst possible way: TypeORM fills `identifiers` from the values it was
   * *given*, not from the rows the database actually inserted, so a
   * conflicting claim reports success. Deduplication then silently does
   * nothing and every Kafka redelivery is processed a second time. With
   * `RETURNING`, a skipped insert returns no rows and says so.
   */
  async tryClaim(input: {
    messageId: string;
    consumerGroup: string;
    eventType: string;
  }): Promise<boolean> {
    const returned = (await this.manager.query(
      `
      INSERT INTO processed_messages (message_id, consumer_group, event_type, processed_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (message_id, consumer_group) DO NOTHING
      RETURNING message_id
      `,
      [input.messageId, input.consumerGroup, input.eventType],
    )) as unknown;

    return normaliseReturning(returned).length > 0;
  }

  async recordResult(
    messageId: string,
    consumerGroup: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.update({ messageId, consumerGroup }, { result } as never);
  }

  async purgeBefore(cutoff: Date): Promise<number> {
    const outcome = await this.repository.delete({ processedAt: LessThan(cutoff) });
    return outcome.affected ?? 0;
  }
}
