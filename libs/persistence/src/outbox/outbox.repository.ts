import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LessThanOrEqual } from 'typeorm';
import type { DomainEvent } from '@payhub/kernel';
import { TypeOrmRepositoryBase } from '../base.repository.js';
import { TransactionManager } from '../transaction.manager.js';
import { OutboxMessageEntity } from './outbox-message.entity.js';

export interface OutboxAppendInput {
  readonly topic: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly partitionKey?: string;
  readonly payload: Record<string, unknown>;
  readonly headers?: Record<string, string>;
  readonly occurredAt?: Date;
  readonly messageId?: string;
}

@Injectable()
export class OutboxRepository extends TypeOrmRepositoryBase<OutboxMessageEntity> {
  constructor(transactions: TransactionManager) {
    super(transactions, OutboxMessageEntity);
  }

  /**
   * MUST be called inside the business transaction.
   *
   * `available_at` is left to the column default — `now()`, evaluated by
   * Postgres — and deliberately not set from here. The relay selects
   * `WHERE available_at <= now()` using the *database* clock, so a row
   * stamped with the *application* clock is compared against a different
   * one. A pod running a few milliseconds ahead writes events that are
   * invisible to the relay until real time catches up, and with several
   * pods each at its own offset the delay is different per writer. This
   * surfaced as an intermittent integration-test failure where two
   * appended rows produced one claimable row.
   *
   * `occurred_at` stays on the application clock on purpose: it records
   * when the domain event happened, which is a fact about the business,
   * not a scheduling decision the database ever evaluates.
   */
  async append(input: OutboxAppendInput): Promise<string> {
    const id = input.messageId ?? randomUUID();

    await this.repository
      .createQueryBuilder()
      .insert()
      .values({
        id,
        topic: input.topic,
        eventType: input.eventType,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        partitionKey: input.partitionKey ?? input.aggregateId,
        payload: input.payload,
        headers: input.headers ?? {},
        status: 'pending',
        attempts: 0,
        availableAt: () => 'now()',
        occurredAt: input.occurredAt ?? new Date(),
        publishedAt: null,
        lastError: null,
      } as never)
      .execute();

    return id;
  }

  /**
   * One statement for the whole batch.
   *
   * An aggregate that raises five events was previously five round trips
   * inside the business transaction — five times the lock hold time for no
   * reason. A multi-row INSERT is a single parse, plan and fsync.
   */
  async appendMany(inputs: readonly OutboxAppendInput[]): Promise<string[]> {
    if (inputs.length === 0) {
      return [];
    }

    const occurredFallback = new Date();
    const rows = inputs.map((input) => ({
      id: input.messageId ?? randomUUID(),
      topic: input.topic,
      eventType: input.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      partitionKey: input.partitionKey ?? input.aggregateId,
      payload: input.payload,
      headers: input.headers ?? {},
      status: 'pending' as const,
      attempts: 0,
      // The database clock, for the same reason as `append`.
      availableAt: () => 'now()',
      occurredAt: input.occurredAt ?? occurredFallback,
      publishedAt: null,
      lastError: null,
    }));

    await this.repository.createQueryBuilder().insert().values(rows as never).execute();

    return rows.map((row) => row.id);
  }

  /**
   * Claims a batch for publishing, with a lease.
   *
   * `FOR UPDATE SKIP LOCKED` lets N relay instances drain the same table
   * concurrently without any coordination: each row is handed to exactly
   * one worker and nobody blocks on a row somebody else already took.
   *
   * The lease is the part that is easy to get wrong. A naive relay flips
   * rows to `publishing` and relies on itself to flip them again — so a
   * crash between the claim and the ack strands those events **forever**,
   * silently, because the next poll only looks at `pending`. Pushing
   * `available_at` into the future on claim turns the table into a proper
   * visibility-timeout queue: an un-acked row simply becomes claimable
   * again once its lease expires.
   */
  async claimBatch(limit: number, leaseMs = 60_000): Promise<OutboxMessageEntity[]> {
    const result = (await this.manager.query(
      `
      WITH claimed AS (
        SELECT id
        FROM outbox_messages
        WHERE status IN ('pending', 'publishing')
          AND available_at <= now()
        ORDER BY available_at, created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_messages AS o
      SET status = 'publishing',
          attempts = o.attempts + 1,
          available_at = now() + ($2::int * interval '1 millisecond')
      FROM claimed
      WHERE o.id = claimed.id
      RETURNING o.id, o.topic, o.event_type AS "eventType", o.aggregate_type AS "aggregateType",
                o.aggregate_id AS "aggregateId", o.partition_key AS "partitionKey",
                o.payload, o.headers, o.attempts, o.occurred_at AS "occurredAt";
      `,
      [limit, leaseMs],
    )) as unknown;

    return normaliseReturning<OutboxMessageEntity>(result);
  }

  async markPublished(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.repository
      .createQueryBuilder()
      .update()
      .set({ status: 'published', publishedAt: () => 'now()', lastError: null })
      .whereInIds([...ids])
      .execute();
  }

  /** Reschedules with backoff, or buries the row once it is hopeless. */
  async markFailed(id: string, error: string, nextAttemptDelayMs: number, maxAttempts: number): Promise<void> {
    await this.manager.query(
      `
      UPDATE outbox_messages
      SET status = CASE WHEN attempts >= $3 THEN 'dead' ELSE 'pending' END,
          available_at = now() + ($2::int * interval '1 millisecond'),
          last_error = $4
      WHERE id = $1
      `,
      [id, nextAttemptDelayMs, maxAttempts, error.slice(0, 2_000)],
    );
  }

  /** Housekeeping: published rows are only kept for auditing/debugging. */
  async purgePublishedBefore(cutoff: Date): Promise<number> {
    const result = await this.repository.delete({
      status: 'published',
      publishedAt: LessThanOrEqual(cutoff),
    });
    return result.affected ?? 0;
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.repository
      .createQueryBuilder('o')
      .select('o.status', 'status')
      .addSelect('count(*)::int', 'count')
      .groupBy('o.status')
      .getRawMany<{ status: string; count: number }>();

    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }
}

/**
 * Normalises a `RETURNING` result.
 *
 * TypeORM's Postgres driver hands back `rows` for a SELECT but
 * `[rows, rowCount]` for an UPDATE/DELETE — an asymmetry that silently
 * produces an array whose first element is itself an array, so every field
 * reads as `undefined`. Worth a helper rather than a comment at each call
 * site, because the failure is invisible until something downstream
 * formats a `null` id.
 */
export function normaliseReturning<T>(result: unknown): T[] {
  if (!Array.isArray(result)) {
    return [];
  }
  const [first] = result;
  return Array.isArray(first) ? (first as T[]) : (result as T[]);
}

/** Maps a domain event onto an outbox row. */
export function outboxInputFromDomainEvent(
  event: DomainEvent,
  topic: string,
  headers: Record<string, string> = {},
): OutboxAppendInput {
  return {
    topic,
    eventType: event.eventName,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    partitionKey: event.aggregateId,
    payload: event.payload(),
    headers,
    occurredAt: event.occurredAt,
    messageId: event.eventId,
  };
}
